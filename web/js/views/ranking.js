import { api } from '../api.js';
import { $, debounce, escapeHtml, fmtAmount, fmtPct, fmtSignedPct, signClass } from '../format.js';

export function createRankingView({ onSelect }) {
  const state = {
    direction: 'inflow',
    keyword: '',
    category: '',
    // 默认按「主动净买」排：这条序列来自腾讯源、连续可用，不会因为东财间歇熔断而整体重排
    sort: 'activeNet',
    tracked: false,
    rows: [],
    loading: false,
  };

  const tbody = $('#rank-table tbody');
  const countEl = $('#rank-count');
  let defaultApplied = false;
  let userTouchedSort = false;

  /**
   * 某一口径的数值是否已经陈旧。
   * 主力净额来自东财，机房 IP 被拒时会停更；这时不该假装它是实时的，
   * 也不该拿另一种口径顶上，而是如实显示「几分钟前的值」。
   */
  function ageMinutes(ts) {
    if (!ts) return null;
    return Math.max(0, Math.round((Date.now() - ts) / 60000));
  }

  /**
   * 一个口径的单元格：值 + 是否已停更。
   * 停更的数值仍然显示（这是「上一时刻的值」，比空白有用），但必须标出来，
   * 否则会被当成当前值读——510050 那天就是这样被误判成「净流出 1.14 亿」的。
   */
  function metricCell(value, ts) {
    if (value === null || value === undefined) return { html: '—', stale: false, empty: true, age: null };
    const age = ageMinutes(ts);
    const stale = age !== null && age >= 3;
    return { html: `${fmtAmount(value)}${stale ? '<sup class="stale-mark">*</sup>' : ''}`, stale, empty: false, age };
  }

  function ageText(minutes) {
    if (minutes === null) return '—';
    if (minutes < 60) return `${minutes} 分钟`;
    if (minutes < 1440) return `${Math.round(minutes / 60)} 小时`;
    return `${Math.round(minutes / 1440)} 天`;
  }

  function renderRows() {
    if (state.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10"><div class="empty">没有匹配的 ETF</div></td></tr>';
      return { staleMain: 0, staleActive: 0 };
    }
    let staleMain = 0;
    let staleActive = 0;
    tbody.innerHTML = state.rows
      .map((row, index) => {
        const main = metricCell(row.mainNet, row.mainTs);
        const active = metricCell(row.activeNet, row.activeTs);
        if (main.stale) staleMain += 1;
        if (active.stale) staleActive += 1;
        const mainCell = `<td class="num ${main.stale ? 'is-stale' : signClass(row.mainNet)}" title="${main.stale ? `主力净额来自东财，已 ${ageText(main.age)}未更新；显示的是最近一次成功取到的值` : '主力净额（东财：超大单+大单净额）'}">${main.html}</td>`;
        const activeCell = `<td class="num ${active.stale ? 'is-stale' : signClass(row.activeNet)}" title="${active.stale ? `主动净买已 ${ageText(active.age)}未更新；显示的是最近一次成功取到的值` : '主动净买（腾讯：外盘−内盘，含中小单）'}">${active.html}</td>`;
        const superClass = signClass(row.superNet);
        const pctClass = signClass(row.pctChg);
        return `<tr data-code="${escapeHtml(row.code)}" title="点击查看趋势">
          <td class="mono" style="color:var(--muted)">${index + 1}</td>
          <td class="cell-code">${escapeHtml(row.code)}</td>
          <td><span class="cell-name">${escapeHtml(row.name)}</span></td>
          <td><span class="tag ${row.tracked ? 'in' : ''}">${escapeHtml(row.category ?? '其他')}</span></td>
          ${mainCell}
          ${activeCell}
          <td class="num ${row.mainRatio === null ? 'is-stale' : signClass(row.mainRatio)}">${row.mainRatio === null ? '—' : fmtPct(row.mainRatio)}</td>
          <td class="num ${row.superNet === null ? 'is-stale' : superClass}">${row.superNet === null ? '—' : fmtAmount(row.superNet)}</td>
          <td class="num">${row.turnover ? fmtAmount(row.turnover, { sign: false }) : '—'}</td>
          <td class="num ${pctClass}">${fmtSignedPct(row.pctChg)}</td>
        </tr>`;
      })
      .join('');
    return { staleMain, staleActive };
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
      const stats = renderRows();
      const withData = state.rows.filter((row) => row.net !== null && row.net !== undefined).length;
      const notes = [`共 ${state.rows.length} 条，其中 ${withData} 条含资金流数据`];
      // 「80 条全部停更」和「零星几条停更」是两件不同的事：
      // 前者是整条源不可用（东财被拒时主力净额全体冻结），后者是单只标的没跟上。
      // 统一写成「N 条停更」会让前者看起来像一堆脏数据，改为如实说「整体停更」。
      const staleNote = (name, count, total) => {
        if (!count) return null;
        return count >= total ? `${name}整体停更（*）` : `${name} ${count} 条停更（*）`;
      };
      const total = state.rows.length;
      const mainNote = staleNote('主力净额', stats.staleMain, total);
      const activeNote = staleNote('主动净买', stats.staleActive, total);
      if (mainNote) notes.push(mainNote);
      if (activeNote) notes.push(activeNote);
      countEl.textContent = notes.join(' · ');
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="10"><div class="empty">加载失败：${escapeHtml(error.message)}</div></td></tr>`;
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
    // 切换方向时回到「按主动净买」（默认口径），避免排序字段与方向语义冲突
    if (state.sort !== 'activeNet') {
      state.sort = 'activeNet';
      $('#rank-sort').value = 'activeNet';
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
    userTouchedSort = true;
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

  /**
   * 首次拿到运行状态后，把默认排序切到「当前真正在实时更新的那个口径」。
   * 服务器降级到腾讯时，主力净额会停在几分钟前，按它排序等于拿旧数据排名。
   */
  function applyDefaultMetric(metric) {
    if (defaultApplied) return;
    defaultApplied = true;
    if (userTouchedSort || !metric) return;
    if (state.sort === metric) return;
    state.sort = metric;
    const el = $('#rank-sort');
    if (el) el.value = metric;
    void refresh();
  }

  return { refresh, state, applyDefaultMetric };
}
