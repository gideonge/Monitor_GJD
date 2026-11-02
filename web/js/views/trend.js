import { api } from '../api.js';
import { drawAreaChart, drawBarChart, drawFastChart, drawIntradayChart } from '../charts.js';
import { $, fmtAmount, fmtPct, fmtSignedPct, signClass } from '../format.js';

let resizeTimer = null;

const fmtHands = (hands) => {
  if (hands === null || hands === undefined || Number.isNaN(Number(hands))) return '—';
  const value = Number(hands);
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)}亿手`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(1)}万手`;
  return `${Math.round(value)}手`;
};

const priceText = (value) =>
  value === null || value === undefined || Number.isNaN(Number(value)) ? '—' : Number(value).toFixed(3);

export function createTrendView({ toast }) {
  const containerDaily = $('#chart-daily');
  const containerIntraday = $('#chart-intraday');
  const containerFlow = $('#chart-flow-intraday');
  const containerFast = $('#chart-fast');

  let latest = null; // 详情接口返回的整包
  let intraday = null; // 分时数据（价格 + 成交量）
  let currentCode = null;
  let currentDate = null;
  let loadingFor = null; // 正在加载分时的标的代码，避免切换标的后误显示加载态
  let lastIntradayRefreshAt = 0;
  let fastData = null; // 秒级盘口（仅核心池）
  let fastSeconds = 600;
  let fastFor = null; // 秒级数据所属标的，避免切标的后残留

  function setStat(id, text, cls = '') {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = `istat-value${cls ? ` ${cls}` : ''}`;
  }

  function renderStats() {
    const summary = intraday?.summary;
    if (!summary) {
      for (const id of ['i-open', 'i-high', 'i-low', 'i-close', 'i-pct', 'i-amplitude', 'i-amount', 'i-volume']) {
        setStat(id, '—');
      }
      return;
    }
    setStat('i-open', priceText(summary.open));
    setStat('i-high', priceText(summary.high));
    setStat('i-low', priceText(summary.low));
    setStat('i-close', priceText(summary.close), signClass(summary.close - (intraday.preClose ?? summary.close)));
    setStat('i-pct', fmtSignedPct(summary.pctChg), signClass(summary.pctChg));
    setStat('i-amplitude', summary.amplitude === null ? '—' : fmtPct(summary.amplitude));
    setStat('i-amount', fmtAmount(summary.amount, { sign: false }));
    setStat('i-volume', fmtHands(summary.volume));
  }

  function syncDateSelect() {
    const select = $('#intraday-date');
    if (!select) return;
    const dates = intraday?.dates ?? [];
    select.innerHTML = dates.length
      ? dates
          .map(
            (date) =>
              `<option value="${date}"${date === currentDate ? ' selected' : ''}>${date}${
                date === dates[0] ? '（最新）' : ''
              }</option>`,
          )
          .join('')
      : '<option value="">—</option>';
    select.disabled = dates.length < 2;
  }

  const surgeSummary = () => {
    const events = intraday?.surge?.events ?? [];
    if (events.length === 0) return '';
    const count = (level) => events.filter((item) => item.level === level).length;
    const strong = count(3);
    const medium = count(2);
    const weak = count(1);
    // 未确认事件照样标注（空心点），这里点明数量，避免把观察信号误读成资金进攻
    const watch = events.filter((item) => item.confirmed === false).length;
    const watchText = watch > 0 ? `，其中 ${watch} 处方向待确认` : '';
    return ` · 量能异动 ${events.length} 处（强 ${strong} / 中 ${medium} / 弱 ${weak}${watchText}）`;
  };

  function renderIntradayHeader() {
    const title = $('#intraday-title');
    const note = $('#intraday-note');
    if (!intraday || !intraday.tradeDate) {
      if (title) title.textContent = '分时走势与成交量';
      if (note) note.textContent = '暂无分时数据';
      return;
    }
    const state = intraday.isClosed ? '已收盘' : '盘中';
    if (title) title.textContent = `分时走势与成交量 · ${intraday.tradeDate} ${state}`;
    if (note) {
      note.textContent =
        loadingFor === currentCode
          ? '正在向上游请求分时数据…'
          : intraday.available
            ? `价格线 + 均价线，下方为逐分钟成交量 · ${intraday.note ?? ''}${surgeSummary()}`
            : intraday.note ?? '暂无分时数据';
    }
  }

  /**
   * 分钟内实时爆量：把「正在形成的那一分钟」折算成整分钟展示。
   *
   * 这条横条的定位与分时图不同：分时图上那根柱子要等分钟收盘才画得出来，
   * 而爆量的第一手信息（大单在几十秒内扫掉卖盘）在分钟内就已经可见。
   * 所以这里给的是「第几秒、已经成交多少、按当前进度折算多少倍」，
   * 以及距离触发线还差多少，而不是一个已经完成的结果。
   */
  function renderPreburst() {
    const strip = $('#preburst-strip');
    if (!strip) return;
    const view = fastData?.preburst ?? null;
    const recap = fastData?.lastPreburst ?? null;
    const hasPoints = (fastData?.points?.length ?? 0) >= 2;
    const live = Boolean(view?.active) && hasPoints;

    if (!live && !recap) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;

    const tag = $('#preburst-tag');
    const text = $('#preburst-text');
    const fill = $('#preburst-fill');
    const glyph = $('#preburst-glyph');
    const bar = (value, total) => `${Math.min(100, (value / Math.max(total || 1, 1)) * 100).toFixed(0)}%`;

    if (live) {
      const classes = ['live-strip'];
      if (view.stage === 'trigger') classes.push('is-trigger');
      else if (view.stage === 'watch') classes.push('is-watch');
      if (view.direction === 'drain') classes.push('is-drain');
      strip.className = classes.join(' ');

      const amount = fmtAmount(view.amount, { sign: false });
      const baseline = fmtAmount(view.baseline, { sign: false });
      const net =
        view.net === null || view.net === undefined
          ? ''
          : `，主动净${view.direction === 'drain' ? '卖出' : '买入'} ${fmtAmount(Math.abs(view.net), { sign: false })}`;
      const move =
        view.priceMovePct === null || view.priceMovePct === undefined
          ? ''
          : `，价格 ${fmtSignedPct(view.priceMovePct)}`;

      if (view.stage === 'trigger') {
        tag.textContent = view.direction === 'drain' ? '分钟内在放量卖出' : '分钟内在爆量';
        text.textContent = `${view.minute} 第 ${view.elapsedSec} 秒已成交 ${amount}，折算整分钟 ${fmtAmount(
          view.projectedAmount,
          { sign: false },
        )}（${Number(view.projectedRatio).toFixed(2)}× 基线 ${baseline}）${net}${move}`;
        fill.style.width = bar(view.amount, view.projectedAmount);
        glyph.textContent = `L${view.level}`;
      } else if (view.stage === 'watch') {
        tag.textContent = '接近放量';
        text.textContent = `${view.minute} 第 ${view.elapsedSec} 秒已成交 ${amount}（折算 ${Number(
          view.projectedRatio,
        ).toFixed(2)}× 基线 ${baseline}），触发线 ${fmtAmount(view.barAmount, { sign: false })}`;
        fill.style.width = bar(view.amount, view.barAmount);
        glyph.textContent = '待确认';
      } else {
        tag.textContent = '分钟实时';
        text.textContent =
          view.reason === 'baseline'
            ? `监控中 · 基线攒集中（已有 ${view.baselineCount} 分钟，需 8 分钟）`
            : `监控中 · ${view.minute} 第 ${view.elapsedSec} 秒 ${amount}${
                view.projectedRatio ? `（折算 ${Number(view.projectedRatio).toFixed(2)}×）` : ''
              } · 触发线 ${fmtAmount(view.barAmount, { sign: false })}`;
        fill.style.width = view.barAmount ? bar(view.amount, view.barAmount) : '0%';
        glyph.textContent = view.curveSource === 'prior' ? '先验曲线' : '自建曲线';
      }
      return;
    }

    // 收盘后：最后一根是 15:00 集合竞价，不判定；这里回放当日该通道真的报过的那一条
    strip.className = 'live-strip is-recap';
    tag.textContent = '今日实时爆量';
    text.textContent = recap.message ?? '';
    fill.style.width = '0%';
    glyph.textContent = `${Number(recap.value).toFixed(2)}×`;
  }

  /**
   * 秒级盘口：只对核心池（国家队常买宽基）展示。
   * 后端已按 1 秒采样，这里只做展示，不做二次聚合——降采样会抹掉「连续大额扫单」的形态。
   */
  function renderFast() {
    const block = $('#block-fast');
    if (!block) return;
    const inPool = Boolean(latest?.fast?.inPool);
    block.hidden = !inPool;
    if (!inPool) return;

    const title = $('#fast-title');
    const note = $('#fast-note');
    const minutes = Math.round(fastSeconds / 60);
    if (title) title.textContent = `秒级盘口 · 主动买卖（近 ${minutes} 分钟）`;

    const points = fastData?.points ?? [];
    const summary = fastData?.summary;
    const impulses = fastData?.impulses ?? [];
    // 只有 1 个点或没有有效增量时，展示空态说明；否则「0 元」这类数字会让人误解为真的没有成交
    const hasData = points.length >= 2 && (summary?.samples ?? 0) > 0;
    if (note) {
      const base = '1 秒采样 · 主动净买 =（外盘 − 内盘）增量 × 现价 · 每 10 秒刷新';
      // 图上阴影与告警同源，命中时在说明里点出波数，避免用户以为阴影是随手画的
      const mark = impulses.length > 0 ? ` · 阴影为检测到的 ${impulses.length} 波主动攻势` : '';
      note.textContent = hasData ? `${base}${mark}` : fastData?.note ?? '等待盘中秒级数据（仅交易时段采集）';
    }

    const setFastStat = (id, text, cls = '') => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      el.className = `istat-value${cls ? ` ${cls}` : ''}`;
    };

    if (!hasData) {
      for (const id of ['f-amt', 'f-net', 'f-ratio', 'f-imba', 'f-price', 'f-high', 'f-low', 'f-points']) {
        setFastStat(id, '—');
      }
    } else {
      const prices = points.map((point) => Number(point.price)).filter((value) => Number.isFinite(value));
      const gross = (summary.inflow ?? 0) + Math.abs(summary.outflow ?? 0);
      const ratio = gross > 0 ? (summary.inflow / gross) * 100 : null;
      setFastStat('f-amt', fmtAmount(summary.amount, { sign: false }));
      setFastStat('f-net', fmtAmount(summary.netAmount), signClass(summary.netAmount));
      setFastStat(
        'f-ratio',
        ratio === null ? '—' : `${ratio.toFixed(1)}%`,
        ratio === null ? '' : signClass(ratio - 50),
      );
      setFastStat(
        'f-imba',
        Number.isFinite(summary.imba) ? `${summary.imba >= 0 ? '+' : ''}${(summary.imba * 100).toFixed(0)}%` : '—',
        Number.isFinite(summary.imba) ? signClass(summary.imba) : '',
      );
      setFastStat('f-price', priceText(summary.lastPrice));
      setFastStat('f-high', priceText(prices.length ? Math.max(...prices) : null));
      setFastStat('f-low', priceText(prices.length ? Math.min(...prices) : null));
      setFastStat('f-points', String(summary.points));
    }

    drawFastChart(containerFast, {
      points,
      impulses,
      height: 210,
      emptyText: fastData?.note ?? '等待盘中秒级数据（仅交易时段采集）',
    });

    renderPreburst();
  }

  async function loadFast(code) {
    if (!code || !latest?.fast?.inPool) return;
    try {
      const data = await api.fast(code, { seconds: fastSeconds });
      if (code !== currentCode) return; // 已切标的，丢弃过期结果
      fastData = data;
      fastFor = code;
      renderFast();
    } catch {
      // 秒级是增强信息，失败不打扰用户，下一轮自动重试
    }
  }

  function renderCharts() {
    if (!latest) return;

    drawBarChart(containerDaily, {
      data: latest.daily.map((row) => ({ label: row.tradeDate, value: row.mainNet })),
      height: 210,
    });

    drawIntradayChart(containerIntraday, {
      bars: intraday?.bars ?? [],
      preClose: intraday?.preClose ?? null,
      height: 296,
      events: intraday?.surge?.events ?? [],
      emptyText: intraday?.note ?? '暂无分时数据',
    });

    renderFast();

    const flow = latest.intradayFlow ?? [];
    const block = $('#block-flow-intraday');
    if (block) block.hidden = flow.length < 2;
    if (flow.length >= 2) {
      drawAreaChart(containerFlow, {
        points: flow.map((row) => ({ ts: row.ts, value: row.mainNet })),
        height: 180,
      });
      $('#chart-intraday-note').textContent = `${flow.length} 个采样点 · ${latest.tradeDate} 盘中轮询累积`;
    }
  }

  function renderIntraday() {
    renderIntradayHeader();
    renderStats();
    syncDateSelect();
    renderCharts();
  }

  function renderDetail(detail) {
    latest = detail;
    currentCode = detail.etf.code;
    $('#trend-name').textContent = detail.etf.name;
    $('#trend-code-label').textContent = detail.etf.code;
    $('#trend-category').textContent = detail.etf.category;
    // 采集分级直接写在交易日旁：核心池是「秒级通道」，其余是「分钟级」
    $('#trend-trade-date').textContent = `交易日 ${detail.tradeDate} · ${detail.fast?.tierLabel ?? '分钟级'}`;

    const quote = detail.quote;
    const priceEl = $('#trend-price');
    if (quote && quote.price !== null) {
      priceEl.innerHTML = `${Number(quote.price).toFixed(3)} <span class="${signClass(
        quote.pctChg,
      )}">${fmtSignedPct(quote.pctChg)}</span>`;
    } else {
      priceEl.textContent = '—';
    }

    const metrics = detail.dailyMetrics;
    $('#m-today').innerHTML = `<span class="${signClass(metrics?.mainNet)}">${fmtAmount(metrics?.mainNet)}</span>`;
    $('#m-avg').textContent = metrics?.avg5 === null || metrics?.avg5 === undefined ? '—' : fmtAmount(metrics.avg5);
    $('#m-vs').innerHTML = `<span class="${signClass(metrics?.vsAvg)}">${fmtAmount(metrics?.vsAvg)}</span>`;

    intraday = detail.intraday ?? null;
    currentDate = intraday?.tradeDate ?? null;
    $('#m-points').textContent = intraday?.summary ? `${intraday.summary.points} 点` : '—';

    renderIntraday();

    // 秒级盘口：切标的后先清空旧数据，避免把上一只标的的逐秒走势挂在新标的名下
    fastData = fastFor === currentCode ? fastData : null;
    if (detail.fast?.inPool) void loadFast(currentCode);

    // 首屏用本地缓存渲染；本地没有该交易日的分时，再按需向上游拉取一次
    if (!intraday?.available && currentCode) void loadIntraday(currentCode, null);
  }

  async function loadIntraday(code, date) {
    if (loadingFor === code) return;
    loadingFor = code;
    renderIntradayHeader();
    try {
      const data = await api.intraday(code, { date: date || undefined });
      if (code !== currentCode) return; // 已切换到其它标的，丢弃过期结果
      intraday = data;
      currentDate = data.tradeDate;
      renderIntraday();
    } catch (error) {
      if (code === currentCode) toast(error.message, true);
    } finally {
      if (loadingFor === code) loadingFor = null;
      if (code === currentCode) renderIntradayHeader();
    }
  }

  async function load(code) {
    const target = String(code ?? '').trim();
    if (!/^\d{6}$/.test(target)) {
      toast('请输入 6 位数字 ETF 代码');
      return;
    }
    try {
      const detail = await api.detail(target);
      renderDetail(detail);
    } catch (error) {
      toast(error.message, true);
    }
  }

  $('#trend-load').addEventListener('click', () => load($('#trend-code').value));
  $('#trend-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      load($('#trend-code').value);
    }
  });

  $('#intraday-date').addEventListener('change', (event) => {
    const date = event.target.value;
    if (!currentCode || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    void loadIntraday(currentCode, date);
  });

  $('#fast-window').addEventListener('change', (event) => {
    fastSeconds = Number(event.target.value) || 600;
    fastData = null;
    if (currentCode) void loadFast(currentCode);
  });

  // 秒级块自刷新：10 秒一轮，仅当前视图可见且页面在前台时执行
  setInterval(() => {
    if (document.hidden) return;
    if (!currentCode || !latest?.fast?.inPool) return;
    if (containerFast && containerFast.offsetParent === null) return; // 当前不在趋势视图
    void loadFast(currentCode);
  }, 10_000);

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCharts, 180);
  });

  return {
    load,
    renderDetail,
    get currentCode() {
      return currentCode;
    },
    refreshIfMatches(code) {
      if (latest && code === currentCode) void load(code);
    },
    /** 盘中由实时推送触发：仅当当前标的当天分时未收盘时刷新，120 秒节流 */
    refreshIntradayIfLive() {
      if (!currentCode || !intraday || intraday.isClosed) return;
      const now = Date.now();
      if (now - lastIntradayRefreshAt < 120_000) return;
      lastIntradayRefreshAt = now;
      void loadIntraday(currentCode, null);
    },
  };
}
