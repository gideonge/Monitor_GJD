import { api } from '../api.js';
import {
  $,
  debounce,
  downloadCsv,
  escapeHtml,
  fmtDateTime,
  fmtInt,
  fmtMetricValue,
} from '../format.js';

const SEVERITY_TEXT = { high: '高', medium: '中', low: '低' };

/** 时间范围的中文标签，与 #alert-range 的取值一一对应 */
const RANGE_TEXT = { today: '最近交易日', '': '全部时间', 24: '最近 24 小时', 72: '最近 3 天', 168: '最近 7 天' };

export function createAlertsView({ toast, onOpenCode }) {
  const state = {
    page: 0,
    pageSize: 50,
    severity: '',
    metric: '',
    acknowledged: '',
    // 时间范围直接存控件的原始取值：'today' / '' / '24' / '72' / '168'
    // 默认「最近交易日」：与顶部徽标、KPI 卡同一个口径，避免「徽标 204 / 列表 5680」这种对不上的情况
    range: 'today',
    code: '',
    rows: [],
    total: 0,
    sessionTotal: 0,
    loading: false,
  };

  const tbody = $('#alert-table tbody');

  /** 除时间范围外，是否还叠加了别的筛选 */
  function hasExtraFilters() {
    return Boolean(state.severity || state.metric || state.acknowledged || state.code);
  }

  /** 时间范围 → 请求参数：range=today 由服务端按「最近交易日」换算，其余走滚动小时数 */
  function timeQuery() {
    if (state.range === 'today') return { range: 'today' };
    if (!state.range) return {};
    return { sinceHours: state.range };
  }

  function scopeText() {
    const range = state.range === 'today' ? RANGE_TEXT.today : RANGE_TEXT[state.range] ?? RANGE_TEXT[''];
    return hasExtraFilters() ? `${range} · 已筛选` : range;
  }

  function renderRows() {
    if (state.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty">暂无告警记录</div></td></tr>';
    } else {
      tbody.innerHTML = state.rows
        .map((row) => {
          const valueText = fmtMetricValue(row.metric, row.value);
          // 量能突变的数值是倍数，红绿会误导成资金方向，统一用中性色
          const valueColor =
            row.metric === 'volume_surge' || row.metric === 'volume_preburst'
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
    // 列表条数只说明「当前筛选下有多少」，必须把范围写在旁边：
    // 只写「共 N 条」，读者会把筛选后的数与徽标（最近交易日）当成同一个统计口径
    $('#alert-count').textContent = `共 ${fmtInt(state.total)} 条 · ${scopeText()}`;
    $('#alert-page').textContent = `第 ${state.page + 1} / ${totalPages} 页`;
    $('#alert-prev').disabled = state.page === 0;
    $('#alert-next').disabled = state.page + 1 >= totalPages;
    // 徽标的数由服务端的 summary.today 给出（今日 0 点与最近交易日 0 点的较早者），
    // 与总览 KPI、列表默认范围同源，不再用 state.total 覆盖
    $('#alert-tab-badge').textContent = String(state.sessionTotal);
    $('#alert-tab-badge').title = `最近交易日告警 ${fmtInt(state.sessionTotal)} 条（当前列表：${fmtInt(state.total)} 条 · ${scopeText()}）`;
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
      // 列表与徽标并行取：徽标要的是「最近交易日总数」，与当前筛选无关，
      // 用列表的 total 充当徽标就会出现「徽标随筛选变化」的错觉
      const [result, summary] = await Promise.all([
        api.alerts({
          limit: state.pageSize,
          offset: state.page * state.pageSize,
          severity: state.severity || undefined,
          metric: state.metric || undefined,
          acknowledged: state.acknowledged || undefined,
          ...timeQuery(),
          code: state.code || undefined,
        }),
        api.alertSummary().catch(() => null),
      ]);
      state.rows = result.rows;
      state.total = result.total;
      state.sessionTotal = summary?.today?.total ?? state.sessionTotal;
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
    state.range = event.target.value;
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
        ...timeQuery(),
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
          row.metric === 'main_net_ratio' ||
          row.metric === 'volume_surge' ||
          row.metric === 'volume_preburst'
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
