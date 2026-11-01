import { api } from '../api.js';
import {
  $,
  debounce,
  downloadCsv,
  escapeHtml,
  fmtDateTime,
  fmtMetricValue,
} from '../format.js';

const SEVERITY_TEXT = { high: '高', medium: '中', low: '低' };

export function createAlertsView({ toast, onOpenCode }) {
  const state = {
    page: 0,
    pageSize: 50,
    severity: '',
    metric: '',
    acknowledged: '',
    sinceHours: '',
    code: '',
    rows: [],
    total: 0,
    loading: false,
  };

  const tbody = $('#alert-table tbody');

  function renderRows() {
    if (state.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty">暂无告警记录</div></td></tr>';
    } else {
      tbody.innerHTML = state.rows
        .map((row) => {
          const valueText = fmtMetricValue(row.metric, row.value);
          // 量能突变的数值是倍数，红绿会误导成资金方向，统一用中性色
          const valueColor =
            row.metric === 'volume_surge'
              ? 'var(--ink)'
              : row.value > 0
                ? 'var(--in)'
                : row.value < 0
                  ? 'var(--out)'
                  : 'var(--muted)';
          return `<tr data-id="${row.id}" data-code="${escapeHtml(row.code)}">
            <td class="mono" style="color:var(--ink-2)">${escapeHtml(row.triggeredAtText ?? fmtDateTime(row.triggeredAt))}</td>
            <td><span class="tag ${row.severity}">${SEVERITY_TEXT[row.severity] ?? row.severity}</span></td>
            <td>
              <span class="cell-name">${escapeHtml(row.etfName)}</span>
              <span class="cell-code">${escapeHtml(row.code)}</span>
            </td>
            <td class="num" style="color:${valueColor}">${valueText}</td>
            <td class="wrap" style="color:var(--ink-2)">${escapeHtml(row.conditionText)}</td>
            <td style="color:var(--muted)">${escapeHtml(row.ruleName)}</td>
            <td>${row.acknowledged ? '<span class="tag">已确认</span>' : '<span class="tag medium">未确认</span>'}</td>
            <td>${row.acknowledged ? '' : `<button class="btn btn-sm btn-ghost" data-ack="${row.id}">确认</button>`}</td>
          </tr>`;
        })
        .join('');
    }

    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    $('#alert-count').textContent = `共 ${state.total} 条告警`;
    $('#alert-page').textContent = `第 ${state.page + 1} / ${totalPages} 页`;
    $('#alert-prev').disabled = state.page === 0;
    $('#alert-next').disabled = state.page + 1 >= totalPages;
    $('#alert-tab-badge').textContent = String(state.total);
  }

  let metricsLoaded = false;

  /** 指标下拉来自后端枚举：新增指标（如 volume_surge）不需要改前端 */
  async function ensureMetricOptions() {
    if (metricsLoaded) return;
    try {
      const options = await api.options();
      const select = $('#alert-metric');
      if (select) {
        select.innerHTML = `<option value="">全部指标</option>${options.metrics
          .map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`)
          .join('')}`;
      }
      metricsLoaded = true;
    } catch {
      // 枚举拉取失败不影响主列表：筛选留空即可
    }
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    await ensureMetricOptions();
    try {
      const result = await api.alerts({
        limit: state.pageSize,
        offset: state.page * state.pageSize,
        severity: state.severity || undefined,
        metric: state.metric || undefined,
        acknowledged: state.acknowledged || undefined,
        sinceHours: state.sinceHours || undefined,
        code: state.code || undefined,
      });
      state.rows = result.rows;
      state.total = result.total;
      renderRows();
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty">加载失败：${escapeHtml(error.message)}</div></td></tr>`;
    } finally {
      state.loading = false;
    }
  }

  tbody.addEventListener('click', async (event) => {
    const ackButton = event.target.closest('button[data-ack]');
    if (ackButton) {
      event.stopPropagation();
      try {
        await api.ackAlert(ackButton.dataset.ack);
        await refresh();
        toast('已确认该告警');
      } catch (error) {
        toast(error.message, true);
      }
      return;
    }
    const row = event.target.closest('tr[data-code]');
    if (row) onOpenCode(row.dataset.code);
  });

  $('#alert-severity').addEventListener('change', (event) => {
    state.severity = event.target.value;
    state.page = 0;
    void refresh();
  });
  $('#alert-metric').addEventListener('change', (event) => {
    state.metric = event.target.value;
    state.page = 0;
    void refresh();
  });
  $('#alert-ack').addEventListener('change', (event) => {
    state.acknowledged = event.target.value;
    state.page = 0;
    void refresh();
  });
  $('#alert-range').addEventListener('change', (event) => {
    state.sinceHours = event.target.value;
    state.page = 0;
    void refresh();
  });
  $('#alert-code').addEventListener(
    'input',
    debounce((event) => {
      state.code = event.target.value.trim();
      state.page = 0;
      void refresh();
    }, 300),
  );
  $('#alert-prev').addEventListener('click', () => {
    if (state.page > 0) {
      state.page -= 1;
      void refresh();
    }
  });
  $('#alert-next').addEventListener('click', () => {
    if ((state.page + 1) * state.pageSize < state.total) {
      state.page += 1;
      void refresh();
    }
  });

  $('#alert-export').addEventListener('click', async () => {
    try {
      const result = await api.alerts({
        limit: 500,
        severity: state.severity || undefined,
        metric: state.metric || undefined,
        acknowledged: state.acknowledged || undefined,
        sinceHours: state.sinceHours || undefined,
        code: state.code || undefined,
      });
      if (result.rows.length === 0) {
        toast('没有可导出的告警');
        return;
      }
      const rows = [
        ['触发时间', '级别', 'ETF名称', 'ETF代码', '分类', '规则', '触发条件', '实测值', '状态'],
        ...result.rows.map((row) => [
          row.triggeredAtText ?? fmtDateTime(row.triggeredAt),
          SEVERITY_TEXT[row.severity] ?? row.severity,
          row.etfName,
          row.code,
          row.category ?? '',
          row.ruleName,
          row.conditionText,
          row.metric === 'main_net_ratio' || row.metric === 'volume_surge'
            ? fmtMetricValue(row.metric, row.value)
            : String(row.value),
          row.acknowledged ? '已确认' : '未确认',
        ]),
      ];
      downloadCsv(`etf-alerts-${new Date().toISOString().slice(0, 10)}.csv`, rows);
      toast(`已导出 ${result.rows.length} 条告警`);
    } catch (error) {
      toast(error.message, true);
    }
  });

  return { refresh };
}
