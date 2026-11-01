import { api } from '../api.js';
import { $, debounce, escapeHtml, fmtAmount, fmtPct, fmtSignedPct, signClass } from '../format.js';

export function createRankingView({ onSelect }) {
  const state = {
    direction: 'inflow',
    keyword: '',
    category: '',
    sort: 'mainNet',
    tracked: false,
    rows: [],
    loading: false,
  };

  const tbody = $('#rank-table tbody');
  const countEl = $('#rank-count');

  function renderRows() {
    if (state.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty">没有匹配的 ETF</div></td></tr>';
      return;
    }
    tbody.innerHTML = state.rows
      .map((row, index) => {
        const mainClass = signClass(row.mainNet);
        const superClass = signClass(row.superNet);
        const pctClass = signClass(row.pctChg);
        return `<tr data-code="${escapeHtml(row.code)}" title="点击查看趋势">
          <td class="mono" style="color:var(--muted)">${index + 1}</td>
          <td class="cell-code">${escapeHtml(row.code)}</td>
          <td><span class="cell-name">${escapeHtml(row.name)}</span></td>
          <td><span class="tag ${row.tracked ? 'in' : ''}">${escapeHtml(row.category ?? '其他')}</span></td>
          <td class="num ${mainClass}">${fmtAmount(row.mainNet)}</td>
          <td class="num ${signClass(row.mainRatio)}">${row.mainRatio === null ? '—' : fmtPct(row.mainRatio)}</td>
          <td class="num ${superClass}">${fmtAmount(row.superNet)}</td>
          <td class="num">${row.turnover ? fmtAmount(row.turnover, { sign: false }) : '—'}</td>
          <td class="num ${pctClass}">${fmtSignedPct(row.pctChg)}</td>
        </tr>`;
      })
      .join('');
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    try {
      const result = await api.listEtfs({
        q: state.keyword || undefined,
        category: state.category || undefined,
        sort: state.sort,
        dir: state.direction === 'inflow' ? 'desc' : 'asc',
        limit: 80,
        tracked: state.tracked,
      });
      state.rows = result.rows;
      renderRows();
      const withData = state.rows.filter((row) => row.mainNet !== null).length;
      countEl.textContent = `共 ${state.rows.length} 条，其中 ${withData} 条含资金流数据`;
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty">加载失败：${escapeHtml(error.message)}</div></td></tr>`;
      countEl.textContent = '加载失败';
    } finally {
      state.loading = false;
    }
  }

  // ---- 事件绑定 ----
  $('#rank-direction').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-dir]');
    if (!button) return;
    state.direction = button.dataset.dir;
    for (const item of $('#rank-direction').querySelectorAll('button')) {
      item.classList.toggle('is-active', item === button);
    }
    // 切换方向时回到「按主力净额」，避免排序字段与方向语义冲突
    if (state.sort !== 'mainNet') {
      state.sort = 'mainNet';
      $('#rank-sort').value = 'mainNet';
    }
    void refresh();
  });

  $('#rank-search').addEventListener(
    'input',
    debounce((event) => {
      state.keyword = event.target.value.trim();
      void refresh();
    }, 280),
  );

  $('#rank-category').addEventListener('change', (event) => {
    state.category = event.target.value;
    void refresh();
  });

  $('#rank-sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    void refresh();
  });

  $('#rank-tracked').addEventListener('change', (event) => {
    state.tracked = event.target.checked;
    void refresh();
  });

  tbody.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-code]');
    if (!row) return;
    onSelect(row.dataset.code);
  });

  return { refresh, state };
}
