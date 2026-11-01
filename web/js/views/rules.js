import { api } from '../api.js';
import { $, $$, escapeHtml, fmtAmount } from '../format.js';

const TIMEFRAME_TEXT = { window: '窗口期', intraday: '当日盘中', daily: '日度对比' };
const SEVERITY_TEXT = { high: '高', medium: '中', low: '低' };
const COMPARATOR_TEXT = { gt: '大于', lt: '小于' };

function metricValue(metric, value) {
  if (value === null || value === undefined) return '—';
  if (metric === 'main_net_ratio') return `${Number(value).toFixed(2)}%`;
  if (metric === 'main_net_rate') return `${fmtAmount(value, { sign: false })}/分钟`;
  if (metric === 'volume_surge') return `${Number(value).toFixed(2)}×`;
  return fmtAmount(value, { sign: false });
}

export function createRulesView({ toast }) {
  const state = { options: null, rules: [], editingId: null };

  const tbody = $('#rule-table tbody');
  const form = $('#rule-form');

  function conditionText(rule) {
    const prefix =
      rule.timeframe === 'window'
        ? `${Math.round(rule.windowSec / 60)}分钟窗口期`
        : rule.timeframe === 'intraday'
          ? '当日累计'
          : '当日';
    const label = state.options?.metrics.find((item) => item.value === rule.metric)?.label ?? rule.metric;
    return `${prefix}${label} ${COMPARATOR_TEXT[rule.comparator]} ${metricValue(rule.metric, rule.threshold)}`;
  }

  function renderRows() {
    if (state.rules.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty">暂无规则，点击右上角「新增规则」创建</div></td></tr>';
      return;
    }
    tbody.innerHTML = state.rules
      .map(
        (rule) => `<tr data-id="${rule.id}">
          <td><span class="switch ${rule.enabled ? 'is-on' : ''}" data-toggle="${rule.id}" title="启用 / 停用"></span></td>
          <td>
            <span class="cell-name">${escapeHtml(rule.name)}</span>
            ${rule.isSystem ? '<span class="tag">系统默认</span>' : ''}
          </td>
          <td style="color:var(--ink-2)">${escapeHtml(conditionText(rule))}</td>
          <td style="color:var(--muted)">${TIMEFRAME_TEXT[rule.timeframe] ?? rule.timeframe}</td>
          <td><span class="tag ${rule.severity}">${SEVERITY_TEXT[rule.severity] ?? rule.severity}</span></td>
          <td class="num">${Math.round(rule.cooldownSec / 60)} 分钟</td>
          <td>
            <button class="btn btn-sm btn-ghost" data-edit="${rule.id}">编辑</button>
            <button class="btn btn-sm btn-ghost" data-delete="${rule.id}" style="color:var(--out)">删除</button>
          </td>
        </tr>`,
      )
      .join('');
  }

  async function refresh() {
    try {
      const result = await api.rules();
      state.rules = result.rows;
      if (!state.options) {
        state.options = await api.options();
        fillOptions();
      }
      renderRows();
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty">加载失败：${escapeHtml(error.message)}</div></td></tr>`;
    }
  }

  function fillOptions() {
    const metricSelect = $('#rf-metric');
    metricSelect.innerHTML = state.options.metrics
      .map((item) => `<option value="${item.value}">${escapeHtml(item.label)}（${escapeHtml(item.unit)}）</option>`)
      .join('');

    const categoryBox = $('#rf-categories');
    categoryBox.innerHTML = state.options.categories
      .map(
        (category) =>
          `<label><input type="checkbox" value="${escapeHtml(category)}" /> ${escapeHtml(category)}</label>`,
      )
      .join('');

    const categoryFilter = $('#rank-category');
    if (categoryFilter) {
      categoryFilter.innerHTML = `<option value="">全部分类</option>${state.options.categories
        .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
        .join('')}`;
    }
  }

  function syncTimeframes() {
    const metric = state.options.metrics.find((item) => item.value === $('#rf-metric').value);
    const allowed = metric?.timeframes ?? ['window'];
    const select = $('#rf-timeframe');
    const current = select.value;
    select.innerHTML = allowed
      .map((tf) => `<option value="${tf}">${TIMEFRAME_TEXT[tf] ?? tf}</option>`)
      .join('');
    if (allowed.includes(current)) select.value = current;
    const hint = $('#rf-threshold-hint');
    hint.textContent =
      metric?.unit === '%'
        ? '百分比数值，如 15 表示 15%'
        : metric?.unit === '倍'
          ? '倍数，如 3 表示达到近 20 分钟中位量的 3 倍（需同向突破前 20 分钟极值）'
          : `金额单位：元（1 亿 = 100000000）· ${metric?.label ?? ''}`;
    $('#rf-window').disabled = select.value !== 'window';
  }

  function syncScope() {
    const scope = $('#rf-scope').value;
    $('#rf-scope-category-wrap').style.display = scope === 'category' ? '' : 'none';
    $('#rf-scope-codes-wrap').style.display = scope === 'codes' ? '' : 'none';
  }

  function openForm(rule = null) {
    state.editingId = rule?.id ?? null;
    $('#rf-mode-hint').textContent = rule ? `正在编辑：${rule.name}` : '新建规则';
    form.classList.add('is-open');

    if (!state.options) {
      void refresh().then(() => openForm(rule));
      return;
    }

    $('#rf-name').value = rule?.name ?? '';
    $('#rf-metric').value = rule?.metric ?? 'main_net_delta';
    syncTimeframes();
    if (rule) $('#rf-timeframe').value = rule.timeframe;
    $('#rf-comparator').value = rule?.comparator ?? 'gt';
    $('#rf-threshold').value = rule?.threshold ?? 30000000;
    $('#rf-window').value = rule?.windowSec ?? 300;
    $('#rf-severity').value = rule?.severity ?? 'medium';
    $('#rf-cooldown').value = rule?.cooldownSec ?? 1800;
    $('#rf-scope').value = rule?.scope ?? 'all';
    syncScope();

    $$('#rf-categories input').forEach((input) => {
      input.checked = Boolean(rule?.scopeValue?.includes(input.value));
    });
    $('#rf-codes').value = rule?.scope === 'codes' ? (rule.scopeValue ?? []).join(', ') : '';
    $('#rf-window').disabled = ($('#rf-timeframe').value || 'window') !== 'window';
  }

  function closeForm() {
    form.classList.remove('is-open');
    state.editingId = null;
    $('#rf-mode-hint').textContent = '';
  }

  // ---- 事件 ----
  $('#rule-new').addEventListener('click', () => {
    if (form.classList.contains('is-open') && state.editingId === null) {
      closeForm();
      return;
    }
    openForm(null);
  });

  $('#rf-cancel').addEventListener('click', closeForm);
  $('#rf-metric').addEventListener('change', syncTimeframes);
  $('#rf-scope').addEventListener('change', syncScope);
  $('#rf-timeframe').addEventListener('change', () => {
    $('#rf-window').disabled = $('#rf-timeframe').value !== 'window';
  });

  tbody.addEventListener('click', async (event) => {
    const toggle = event.target.closest('[data-toggle]');
    if (toggle) {
      const rule = state.rules.find((item) => String(item.id) === toggle.dataset.toggle);
      if (!rule) return;
      try {
        await api.toggleRule(rule.id, !rule.enabled);
        await refresh();
        toast(`规则「${rule.name}」已${rule.enabled ? '停用' : '启用'}`);
      } catch (error) {
        toast(error.message, true);
      }
      return;
    }

    const editButton = event.target.closest('[data-edit]');
    if (editButton) {
      const rule = state.rules.find((item) => String(item.id) === editButton.dataset.edit);
      if (rule) openForm(rule);
      return;
    }

    const deleteButton = event.target.closest('[data-delete]');
    if (deleteButton) {
      const rule = state.rules.find((item) => String(item.id) === deleteButton.dataset.delete);
      if (!rule) return;
      if (!window.confirm(`确定删除规则「${rule.name}」？该操作不会删除已生成的告警。`)) return;
      try {
        await api.deleteRule(rule.id);
        await refresh();
        toast('规则已删除');
      } catch (error) {
        toast(error.message, true);
      }
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const metric = $('#rf-metric').value;
    const timeframe = $('#rf-timeframe').value;
    const scope = $('#rf-scope').value;
    const payload = {
      name: $('#rf-name').value.trim(),
      metric,
      timeframe,
      comparator: $('#rf-comparator').value,
      threshold: Number($('#rf-threshold').value),
      windowSec: Number($('#rf-window').value) || 300,
      severity: $('#rf-severity').value,
      cooldownSec: Number($('#rf-cooldown').value) || 0,
      scope,
      enabled: true,
    };

    if (scope === 'category') {
      payload.scopeValue = $$('#rf-categories input:checked').map((input) => input.value);
      if (payload.scopeValue.length === 0) {
        toast('请至少选择一个分类', true);
        return;
      }
    } else if (scope === 'codes') {
      payload.scopeValue = $('#rf-codes')
        .value.split(/[,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      if (payload.scopeValue.length === 0 || payload.scopeValue.some((code) => !/^\d{6}$/.test(code))) {
        toast('请输入合法的 6 位 ETF 代码', true);
        return;
      }
    } else {
      payload.scopeValue = null;
    }

    if (!payload.name || payload.name.length < 2) {
      toast('规则名称至少 2 个字符', true);
      return;
    }
    if (!Number.isFinite(payload.threshold)) {
      toast('请输入有效的阈值', true);
      return;
    }

    const submitButton = $('#rf-submit');
    submitButton.disabled = true;
    try {
      if (state.editingId) {
        await api.updateRule(state.editingId, payload);
        toast('规则已更新');
      } else {
        await api.createRule(payload);
        toast('规则已创建');
      }
      closeForm();
      await refresh();
    } catch (error) {
      toast(error.message, true);
    } finally {
      submitButton.disabled = false;
    }
  });

  return { refresh };
}
