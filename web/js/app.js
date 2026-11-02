import { api } from './api.js';
import {
  $,
  $$,
  debounce,
  escapeHtml,
  fmtAmount,
  fmtClock,
  fmtDateTime,
  fmtInt,
  fmtMetricValue,
  fmtSignedPct,
  signClass,
} from './format.js';
import { createRankingView } from './views/ranking.js';
import { createTrendView } from './views/trend.js';
import { createAlertsView } from './views/alerts.js';
import { createRulesView } from './views/rules.js';

const SEVERITY_TEXT = { high: '高', medium: '中', low: '低' };

let toastTimer = null;
function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('is-error', Boolean(isError));
  element.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('is-on'), 3200);
}

// ---------------- 标签页 ----------------

let activeTab = 'ranking';

function activateTab(name) {
  activeTab = name;
  $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.tab === name));
  $$('.view').forEach((view) => view.classList.toggle('is-active', view.dataset.view === name));

  if (name === 'trend' && !trend.currentCode) {
    const first = $('#trend-quick button');
    const code = first?.dataset.code ?? $('#trend-code').value;
    if (code) void trend.load(code);
  }
  if (name === 'alerts') void alerts.refresh();
  if (name === 'rules') void rules.refresh();
  if (name === 'ranking') void ranking.refresh();
}

// ---------------- 视图实例 ----------------

const trend = createTrendView({ toast });

const ranking = createRankingView({
  onSelect: (code) => {
    activateTab('trend');
    void trend.load(code);
  },
});

const alerts = createAlertsView({
  toast,
  onOpenCode: (code) => {
    activateTab('trend');
    void trend.load(code);
  },
});

const rules = createRulesView({ toast });

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
});

// ---------------- KPI / 状态渲染 ----------------

function renderKpis(data) {
  const { market, tracked, alerts: alertStats, coverage } = data;

  const label = $('#kpi-market-label');
  if (label) {
    const sampled = market.sampleSize ?? 0;
    const universe = market.universeSize ?? 0;
    label.textContent = universe > 0 && sampled < universe ? `全市场主力净流入（采样 ${sampled} 只）` : '全市场主力净流入';
  }

  $('#kpi-market-net').innerHTML = `<span class="${signClass(market.totalMainNet)}">${fmtAmount(market.totalMainNet)}</span>`;
  $('#kpi-market-sub').innerHTML = `流入 <b>${fmtInt(market.inflow)}</b> 家 · 流出 <b>${fmtInt(
    market.outflow,
  )}</b> 家 · 采样 <b>${fmtInt(market.sampleSize)}</b> / ${fmtInt(market.universeSize)} 只`;

  $('#kpi-tracked-net').innerHTML = `<span class="${signClass(tracked.totalMainNet)}">${fmtAmount(
    tracked.totalMainNet,
  )}</span>`;
  $('#kpi-tracked-sub').innerHTML = `监控池 <b>${fmtInt(tracked.sampleSize)}</b> 只 · 成交额 <b>${fmtAmount(
    tracked.totalTurnover,
    { sign: false },
  )}</b>`;

  $('#kpi-breadth').innerHTML = `<span class="num-in">${fmtInt(market.inflow)}</span> <span style="color:var(--muted)">/</span> <span class="num-out">${fmtInt(
    market.outflow,
  )}</span>`;
  const ratio = market.sampleSize > 0 ? (market.inflow / market.sampleSize) * 100 : 0;
  $('#kpi-breadth-sub').innerHTML = `流入占比 <b>${ratio.toFixed(1)}%</b> · 全市场 ETF`;

  const highCount = (alertStats.bySeverity ?? []).find((item) => item.severity === 'high')?.count ?? 0;
  $('#kpi-alerts').textContent = fmtInt(alertStats.total ?? 0);
  $('#kpi-alerts-sub').innerHTML = `未确认 <b>${fmtInt(alertStats.unacknowledged ?? 0)}</b> · 高级别 <b>${fmtInt(
    highCount,
  )}</b>`;
  $('#alert-tab-badge').textContent = String(alertStats.total ?? 0);

  $('#kpi-coverage').textContent = `${fmtInt(coverage ?? 0)} / ${fmtInt(market.universeSize ?? 0)}`;
  $('#kpi-coverage-sub').innerHTML = `监控池 <b>${fmtInt(data.status?.trackedCount ?? 0)}</b> · 生效规则 <b>${fmtInt(
    data.status?.activeRules ?? 0,
  )}</b>`;
}

function renderCategories(categories) {
  const list = $('#cat-list');
  if (!categories || categories.length === 0) {
    list.innerHTML = '<div class="empty">暂无分类数据</div>';
    return;
  }
  const maxAbs = Math.max(...categories.map((item) => Math.abs(item.mainNet)), 1);
  list.innerHTML = categories
    .slice(0, 11)
    .map((item) => {
      const width = (Math.abs(item.mainNet) / maxAbs) * 50;
      const side = item.mainNet >= 0 ? 'in' : 'out';
      return `<div class="cat-row" title="${escapeHtml(item.category)}：${fmtAmount(item.mainNet)} · ${item.count} 只">
        <span class="cat-name">${escapeHtml(item.category)}</span>
        <div class="cat-bar"><span class="${side}" style="width:${width.toFixed(1)}%"></span></div>
        <span class="cat-value ${signClass(item.mainNet)}">${fmtAmount(item.mainNet)}</span>
      </div>`;
    })
    .join('');
}

function renderQuickChips(topInflow) {
  const container = $('#trend-quick');
  if (!topInflow || topInflow.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = topInflow
    .slice(0, 5)
    .map(
      (item) =>
        `<button class="btn btn-sm" type="button" data-code="${escapeHtml(item.code)}" title="${escapeHtml(
          item.name,
        )}">${escapeHtml(item.name.slice(0, 8))}</button>`,
    )
    .join('');
}

$('#trend-quick').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-code]');
  if (button) void trend.load(button.dataset.code);
});

function updateStatus(status) {
  const chip = $('#phase-chip');
  const text = $('#phase-text');
  chip.classList.remove('is-trading', 'is-closed');
  if (status.phase === 'trading') chip.classList.add('is-trading');
  else chip.classList.add('is-closed');
  text.textContent = status.phaseLabel ?? status.phase;

  $('#quote-time').textContent = status.latestQuoteTs ? fmtDateTime(status.latestQuoteTs) : '—';
  $('#update-time').textContent = status.lastTickAt ? fmtClock(status.lastTickAt) : '—';

  const banner = $('#banner');
  const messages = [];
  const failedRecently = status.lastError && Date.now() - status.lastError.at < 10 * 60 * 1000;
  if (failedRecently) {
    messages.push(`数据源异常（${status.lastError.scope}）：${status.lastError.message}；当前展示最近一次成功采集的数据。`);
  } else if (status.quoteAgeMs && status.quoteAgeMs > 15 * 60 * 1000 && status.phase === 'trading') {
    messages.push('行情快照超过 15 分钟未更新，可能处于限流或网络异常状态。');
  }
  if (status.breaker?.open) {
    messages.push('上游接口处于熔断保护中，将在冷却结束后自动恢复。');
  }
  // 降级不提，用户会把「主动净买额」当成「主力净流入」看
  if (status.dataSource?.mode === 'degraded') {
    messages.push(status.dataSource.note ?? '当前为降级数据源，净额口径与主力净流入不同。');
  }
  banner.textContent = messages.join(' ｜ ');
  banner.classList.toggle('is-on', messages.length > 0);

  const sourceChip = $('#source-chip');
  const source = status.dataSource ?? null;
  const degraded = source?.mode === 'degraded';
  const stale = status.quoteAgeMs && status.quoteAgeMs > 24 * 3600 * 1000;
  if (degraded) {
    sourceChip.textContent = `${source.name}${stale ? ' · 收盘缓存' : ''}`;
  } else {
    sourceChip.textContent = stale ? '东方财富 · 收盘缓存' : '东方财富 · 资金流';
  }
  sourceChip.title = source?.note ?? '数据来源';
  sourceChip.classList.toggle('is-warn', Boolean(stale) || degraded);
}

// ---------------- 实时告警流 ----------------

const liveItems = [];

function alertCardHtml(alert, isNew = false) {
  const valueText = fmtMetricValue(alert.metric, alert.value);
  // 量能突变的实测值是倍数，没有资金方向，用中性色而不是红绿
  const valueCls = alert.metric === 'volume_surge' ? '' : signClass(alert.value);
  return `<div class="alert-card sev-${alert.severity}${isNew ? ' is-new' : ''}" data-code="${escapeHtml(
    alert.code,
  )}">
    <div class="alert-top">
      <span class="alert-name">${escapeHtml(alert.etfName)}</span>
      <span class="alert-time">${escapeHtml(alert.triggeredAtText ?? fmtDateTime(alert.triggeredAt))}</span>
    </div>
    <div class="alert-body">
      <span class="${valueCls}">${valueText}</span>
      <span class="tag ${alert.severity}">${SEVERITY_TEXT[alert.severity] ?? alert.severity}</span>
      <span style="color:var(--muted);font-size:11px">${escapeHtml(alert.ruleName)}</span>
    </div>
    <div class="alert-cond">${escapeHtml(alert.conditionText)}</div>
  </div>`;
}

function renderLiveStream(items) {
  liveItems.length = 0;
  liveItems.push(...items);
  const container = $('#live-stream');
  if (liveItems.length === 0) {
    container.innerHTML = '<div class="empty">暂无告警。命中阈值规则后将在这里实时推送。</div>';
  } else {
    container.innerHTML = liveItems.map((item) => alertCardHtml(item)).join('');
  }
  $('#live-count').textContent = String(liveItems.length);
}

function prependAlert(alert) {
  liveItems.unshift(alert);
  if (liveItems.length > 30) liveItems.length = 30;
  const container = $('#live-stream');
  if (liveItems.length === 1) container.innerHTML = '';
  container.insertAdjacentHTML('afterbegin', alertCardHtml(alert, true));
  while (container.children.length > 30) container.lastElementChild.remove();
  $('#live-count').textContent = String(liveItems.length);
  // 量能突变的中/弱信号一天有上百条，逐条弹提示会变成骚扰：只弹强信号。
  // 其它指标维持原有行为（命中即弹），避免改动既有使用习惯。
  const quiet = alert.metric === 'volume_surge' && alert.severity !== 'high';
  if (!quiet) toast(`告警：${alert.etfName} ${alert.conditionText}`);
}

$('#live-stream').addEventListener('click', (event) => {
  const card = event.target.closest('[data-code]');
  if (!card) return;
  activateTab('trend');
  void trend.load(card.dataset.code);
});

// ---------------- 数据刷新 ----------------

async function refreshOverview() {
  try {
    const data = await api.overview();
    renderKpis(data);
    renderCategories(data.categories);
    renderQuickChips(data.topInflow);
    updateStatus({ ...data.status, latestQuoteTs: data.snapshotAt || data.status.latestQuoteTs });
  } catch (error) {
    $('#banner').textContent = `总览加载失败：${error.message}`;
    $('#banner').classList.add('is-on');
  }
}

async function refreshLive() {
  try {
    const summary = await api.alertSummary();
    renderLiveStream(summary.recent ?? []);
  } catch {
    /* 实时流失败不阻塞主流程 */
  }
}

const scheduleOverview = debounce(() => void refreshOverview(), 1200);

$('#refresh-btn').addEventListener('click', async () => {
  const button = $('#refresh-btn');
  button.disabled = true;
  button.textContent = '采集中…';
  try {
    const result = await api.sync('tick');
    const inserted = result?.result?.inserted ?? 0;
    toast(result?.ok ? `采集完成，新增 ${inserted} 个快照点` : '采集失败，请查看顶部提示', !result?.ok);
    await refreshOverview();
    if (activeTab === 'ranking') await ranking.refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '立即采集';
  }
});

// ---------------- SSE ----------------

let eventSource = null;
let streamRetry = 0;

function setLiveHint(text, isError = false) {
  const hint = $('#live-hint');
  hint.textContent = text;
  hint.style.color = isError ? 'var(--in)' : '';
}

function connectStream() {
  if (!('EventSource' in window)) {
    setLiveHint('浏览器不支持 SSE，已降级为轮询', true);
    return;
  }
  if (eventSource) eventSource.close();

  eventSource = new EventSource('/api/stream');

  eventSource.addEventListener('hello', (event) => {
    streamRetry = 0;
    const payload = JSON.parse(event.data);
    setLiveHint('实时推送已连接');
    if (Array.isArray(payload.recentAlerts) && liveItems.length === 0) {
      renderLiveStream(payload.recentAlerts);
    }
  });

  eventSource.addEventListener('alert', (event) => {
    const alert = JSON.parse(event.data);
    prependAlert(alert);
    scheduleOverview();
  });

  eventSource.addEventListener('tick', () => {
    scheduleOverview();
    // 盘中停留在趋势页时，按节流刷新当前标的的分时走势
    if (document.querySelector('.view[data-view="trend"]')?.classList.contains('is-active')) {
      trend.refreshIntradayIfLive();
    }
  });

  eventSource.addEventListener('status', () => {
    scheduleOverview();
  });

  eventSource.onerror = () => {
    streamRetry += 1;
    setLiveHint(streamRetry > 3 ? '实时连接中断，等待重连' : '实时连接波动，正在重连', true);
  };
}

// ---------------- 启动 ----------------

async function bootstrap() {
  await refreshOverview();
  await ranking.refresh();
  await refreshLive();
  connectStream();

  // 兜底轮询：即使 SSE 断开，KPI 与排行也能保持更新
  setInterval(() => {
    if (document.hidden) return;
    void refreshOverview();
  }, 60000);

  setInterval(() => {
    if (document.hidden) return;
    if (activeTab === 'ranking') void ranking.refresh();
  }, 45000);
}

void bootstrap();
