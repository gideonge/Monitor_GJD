import { notFound } from '../lib/errors.js';
import { config } from '../config/index.js';
import { marketPhase, tradeDateOf } from '../lib/time.js';
import { computeDailyMetrics } from './metricService.js';

const SORTABLE = new Set(['mainNet', 'activeNet', 'net', 'mainRatio', 'pctChg', 'turnover', 'superNet', 'code']);

/** 与监控池共用同一份排除清单，避免「池子里没有、榜上却有」 */
const EXCLUDED = new Set(config.trackedExcludeCategories);

/**
 * 默认视图剔除非监控分类。
 * 被排除的标的不会进清单轮询：行情、净额都停在上一次抓到的时刻，
 * 摆在榜上只会被当成「数据不更新」。用户主动选中该分类时才给看。
 */
function dropExcluded(rows, category) {
  if (EXCLUDED.size === 0) return rows;
  if (category) return rows;
  return rows.filter((row) => !EXCLUDED.has(row.category));
}

/**
 * 筛选范围内按某口径汇总。
 * 单边 TOP 列表只给一侧，不带合计用户就对不上 KPI 卡：
 * 「列表全是 +2 亿，上面合计却是 −30 亿」这种困惑全是缺这一行造成的。
 */
function summarize(rows, key = 'net') {
  let netSum = 0;
  let inflow = 0;
  let outflow = 0;
  let withValue = 0;
  for (const row of rows) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    withValue += 1;
    netSum += value;
    if (value > 0) inflow += 1;
    else if (value < 0) outflow += 1;
  }
  return { count: rows.length, withValue, netSum, inflow, outflow };
}

function shapeQuote(live, meta) {
  const mainNet = live?.mainNet ?? meta?.main_net ?? null;
  const activeNet = live?.activeNet ?? meta?.active_net ?? null;
  return {
    code: meta?.code ?? live?.code,
    name: live?.name ?? meta?.name ?? '—',
    category: meta?.category ?? '其他',
    market: meta?.market ?? live?.market ?? null,
    price: live?.price ?? meta?.price ?? null,
    pctChg: live?.pctChg ?? meta?.pct_chg ?? null,
    turnover: live?.turnover ?? meta?.turnover ?? 0,
    // 两个口径各存各的，绝不互相顶替：主力净额只认东财，主动净买只认腾讯
    mainNet,
    mainRatio: live?.mainRatio ?? meta?.main_ratio ?? null,
    mainTs: live?.mainTs ?? meta?.main_ts ?? null,
    activeNet,
    activeTs: live?.activeTs ?? meta?.active_ts ?? null,
    /** 当日主序列口径：派生指标与总览都用它，保证源切换不产生假跳变 */
    net: activeNet ?? mainNet ?? null,
    superNet: live?.superNet ?? meta?.super_net ?? null,
    bigNet: live?.bigNet ?? null,
    midNet: live?.midNet ?? null,
    smallNet: live?.smallNet ?? null,
    tracked: Boolean(meta?.tracked),
    quoteTs: live?.quoteTs ?? meta?.quote_ts ?? null,
  };
}

export function createQueryService({ repos, marketService, intradayService, volumeSurgeService, fastTickService }) {
  const { etfRepo, flowRepo, alertRepo } = repos;

  function allRows() {
    const quotes = marketService.getQuotes();
    const metas = etfRepo.listVisible({ limit: 3000 });
    const metric = marketService.primaryMetric?.() ?? 'activeNet';
    return metas.map((meta) => {
      const row = shapeQuote(quotes.get(meta.code) ?? null, meta);
      // 主口径跟随「当前在实时更新的源」：东财可用用主力净额，降级用主动净买。
      // 缺了就回落到另一列，但绝不把两者相加或互相顶替。
      if (marketService.primaryNet) row.net = marketService.primaryNet(row) ?? row.net;
      // netTs 必须跟着 net 的来源走：主力净额来自东财、主动净买来自腾讯，
      // 两个时间戳互不推进，取错就会把「三天前的净额」当成今天的成交量看。
      const hasPrimary = row[metric] !== null && row[metric] !== undefined;
      if (hasPrimary) {
        row.netTs = metric === 'mainNet' ? row.mainTs : row.activeTs;
      } else if (row.activeNet !== null && row.activeNet !== undefined) {
        row.netTs = row.activeTs;
      } else {
        row.netTs = row.mainTs;
      }
      return row;
    });
  }

  /**
   * 全市场最新一批净额所属的交易日：非交易日时它就是上一交易日。
   * 取 90% 分位而不是最大值——个别标的时间戳异常（未来时间、时区错乱）
   * 会把整个市场判成「陈旧」，导致首页合计突然清零。
   */
  function latestBookDate(rows) {
    const stamps = rows
      .map((row) => row.netTs ?? 0)
      .filter((ts) => ts > 0)
      .sort((a, b) => a - b);
    if (stamps.length === 0) return null;
    const index = Math.min(stamps.length - 1, Math.floor(stamps.length * 0.9));
    return tradeDateOf(stamps[index]);
  }

  function sortRows(rows, sort, dir) {
    const key = SORTABLE.has(sort) ? sort : 'mainNet';
    const factor = dir === 'asc' ? 1 : -1;
    return rows.sort((a, b) => {
      const left = a[key];
      const right = b[key];
      if (left === null || left === undefined) return 1;
      if (right === null || right === undefined) return -1;
      if (typeof left === 'string') return left.localeCompare(right) * factor;
      return (left - right) * factor;
    });
  }

  function listEtfs({ keyword, category, sort = 'mainNet', dir = 'desc', limit = 100, onlyTracked = false } = {}) {
    let rows = dropExcluded(allRows(), category);
    if (onlyTracked) rows = rows.filter((row) => row.tracked);
    if (category) rows = rows.filter((row) => row.category === category);
    if (keyword) {
      const text = keyword.trim().toLowerCase();
      rows = rows.filter(
        (row) => row.code.includes(text) || String(row.name).toLowerCase().includes(text),
      );
    }
    // 合计跟着「当前排序那一列」走：用户按主动净买排，页脚就该是主动净买的合计，
    // 否则又会变成「列里全是正数、合计却是另一口径的负数」。
    // 按涨跌幅、成交额这类非净额字段排序时，合计退回主口径 net。
    const summaryKey = ['mainNet', 'activeNet', 'net', 'superNet'].includes(sort) ? sort : 'net';
    const summary = { ...summarize(rows, summaryKey), metric: summaryKey };
    return { rows: sortRows(rows, sort, dir).slice(0, limit), summary };
  }

  function ranking({ direction = 'inflow', limit = 20, category, onlyTracked = false, metric = 'net' } = {}) {
    const key = SORTABLE.has(metric) ? metric : 'net';
    // 缺测的不参与该口径的排序（但不会因为缺测就从列表里消失，另一个口径还在）
    let rows = dropExcluded(allRows(), category).filter((row) => row[key] !== null && row[key] !== undefined);
    if (onlyTracked) rows = rows.filter((row) => row.tracked);
    if (category) rows = rows.filter((row) => row.category === category);
    // 合计先算：榜上只给单边 TOP，用户看不到另一侧，
    // 不给合计就会出现「列表全是 +2 亿，上面合计却是 −30 亿」的困惑
    const summary = { ...summarize(rows, key), metric: key };
    rows.sort((a, b) => (direction === 'inflow' ? b[key] - a[key] : a[key] - b[key]));
    return { rows: rows.slice(0, limit), summary };
  }

  function categoryBreakdown() {
    const buckets = new Map();
    for (const row of dropExcluded(allRows())) {
      const key = row.category ?? '其他';
      const bucket = buckets.get(key) ?? { category: key, mainNet: 0, count: 0, inflow: 0, outflow: 0, turnover: 0 };
      const net = row.net ?? 0;
      bucket.mainNet += net;
      bucket.count += 1;
      bucket.turnover += row.turnover ?? 0;
      if (net > 0) bucket.inflow += 1;
      else if (net < 0) bucket.outflow += 1;
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort((a, b) => Math.abs(b.mainNet) - Math.abs(a.mainNet));
  }

  function overview() {
    const rows = dropExcluded(allRows());
    // 只统计真正拿到资金流数值的标的，避免把「无数据」当作 0 计入合计
    const quoted = rows.filter((row) => typeof row.net === 'number');
    // 「库里有个数」不等于「今天有数据」：每分钟只轮询监控池，
    // 清单外标的的净额会一直挂着上一次抓到的值。全算进合计，
    // 就会出现「全市场净流出 30 亿」，其实只有监控池那 120 只在流出。
    const bookDate = latestBookDate(quoted);
    const scoped = bookDate ? quoted.filter((row) => tradeDateOf(row.netTs ?? 0) === bookDate) : quoted;
    const staleCount = quoted.length - scoped.length;
    const tracked = scoped.filter((row) => row.tracked);
    const sum = (list, key) => list.reduce((total, row) => total + (row[key] ?? 0), 0);
    const count = (list, predicate) => list.filter(predicate).length;

    return {
      market: {
        totalMainNet: sum(scoped, 'net'),
        totalTurnover: sum(scoped, 'turnover'),
        inflow: count(scoped, (row) => (row.net ?? 0) > 0),
        outflow: count(scoped, (row) => (row.net ?? 0) < 0),
        sampleSize: scoped.length,
        /** 有净额但属于更早交易日、没算进合计的标的数 */
        staleCount,
        bookDate,
        universeSize: rows.length,
      },
      tracked: {
        // 与 market 同一口径：row.net 已由 allRows() 按当前生效源抹平，
        // 这里若继续用 mainNet，会出现「标题写主动净买、监控池却算主力净额」。
        totalMainNet: sum(tracked, 'net'),
        totalTurnover: sum(tracked, 'turnover'),
        inflow: count(tracked, (row) => (row.net ?? 0) > 0),
        outflow: count(tracked, (row) => (row.net ?? 0) < 0),
        sampleSize: tracked.length,
      },
      topInflow: ranking({ direction: 'inflow', limit: 6 }).rows,
      topOutflow: ranking({ direction: 'outflow', limit: 6 }).rows,
      categories: categoryBreakdown(),
      snapshotAt: Math.max(0, ...rows.map((row) => row.quoteTs ?? 0)),
      coverage: count(rows, (row) => row.quoteTs !== null && row.quoteTs !== undefined),
    };
  }

  function detail(code) {
    const meta = etfRepo.get(code);
    const quote = marketService.getQuotes().get(code) ?? null;
    // 被排除监控的分类（债券/货币）连详情都不再提供：
    // 它们不在清单轮询里，分时与净额都停在很久以前，点进去只会看到一个静止的页面
    if (meta && EXCLUDED.has(meta.category)) {
      throw notFound(`未监控 ${code}：${meta.category} 已不在监控范围`);
    }
    if (!meta && !quote) throw notFound(`未找到 ETF：${code}`);

    const daily = flowRepo.dailySeries(code, 60);
    const latestDaily = daily[daily.length - 1] ?? null;
    const previous = daily.slice(0, -1);
    const dailyMetrics = latestDaily ? computeDailyMetrics(latestDaily, previous) : null;

    // 分时口径的交易日：取「日线最新」「分时最新」「快照最新」三者中最新的一天；
    // 仅在盘中（含集合竞价/收盘竞价）才把今天纳入候选，避免周末/节假日取到没有数据的今天。
    const localIntraday = intradayService.readIntraday(code);
    const phase = marketPhase();
    const inSession = phase === 'pre_open' || phase === 'trading' || phase === 'lunch_break' || phase === 'closing';
    const candidates = [latestDaily?.trade_date, localIntraday.tradeDate, flowRepo.latestSnapshotTradeDate()].filter(
      Boolean,
    );
    if (inSession) candidates.push(tradeDateOf());
    const tradeDate = candidates.sort().at(-1) ?? tradeDateOf();

    const intraday = localIntraday.tradeDate === tradeDate ? localIntraday : intradayService.readIntraday(code, { date: tradeDate });
    // 量能突变标注：与告警计数无关，弱信号也返回，点开即可看到当日所有异动分钟
    const surge = volumeSurgeService?.explain(code, intraday.tradeDate) ?? null;
    const flowPoints = flowRepo.intradaySeries(code, tradeDate);

    /**
     * 同一条累计曲线不能两种口径混着接。
     * 一天里东财偶尔恢复几分钟、又断开，`active_net ?? main_net` 的写法
     * 会让曲线在切换的那一分钟凭空跳一次，看起来像资金突然暴动。
     * 折中做法：按当天哪种口径的采样点更多选定一种，另一种留空；
     * 宁可曲线短一截，也不要在中途跳变。
     */
    const countOf = (key) => flowPoints.filter((row) => row[key] !== null && row[key] !== undefined).length;
    // 口径跟页面其它部分一致：当前实时源是腾讯就用主动净买，是东财就用主力净额。
    // 之前按「哪种点更多」选，会出现「页面说主动净买、曲线画的却是东财那几分钟」的错位；
    // 只有该口径当天一条都没有时，才退回另一种。
    const preferred = marketService.primaryMetric?.() === 'mainNet' ? 'mainNet' : 'activeNet';
    const fallback = preferred === 'activeNet' ? 'mainNet' : 'activeNet';
    const countOfMetric = (metric) => countOf(metric === 'activeNet' ? 'active_net' : 'main_net');
    const flowMetric = countOfMetric(preferred) > 0 ? preferred : fallback;

    const { rows: alerts } = alertRepo.list({ code, limit: 20 });

    return {
      etf: {
        code,
        name: meta?.name ?? quote?.name ?? code,
        category: meta?.category ?? '其他',
        market: meta?.market ?? quote?.market ?? null,
        tracked: Boolean(meta?.tracked),
      },
      quote: quote ? shapeQuote(quote, meta) : null,
      daily: daily.map((row) => ({
        tradeDate: row.trade_date,
        mainNet: row.main_net,
        superNet: row.super_net,
        bigNet: row.big_net,
        midNet: row.mid_net,
        smallNet: row.small_net,
      })),
      dailyMetrics: dailyMetrics
        ? {
            mainNet: dailyMetrics.main_net,
            avg5: dailyMetrics.baselineAvg,
            vsAvg: dailyMetrics.main_net_vs_avg,
            baselineDays: dailyMetrics.baselineDays,
          }
        : null,
      /** 秒级通道归属：决定详情页是否展示秒级盘口块（数据单独按需拉取） */
      fast: fastTickService?.describe(code) ?? null,
      /** 分时行情（价格 + 成交量）：点开 ETF 即回看最后交易日整日走势 */
      intraday: { ...intraday, surge },
      /** 盘中轮询累积的净流入分时（仅当天平台运行过才有值） */
      intradayFlow: flowPoints.map((row) => ({
        ts: row.ts,
        // 主序列按 flowMetric 单口径取，缺失即留空，不与另一口径拼接
        net: flowMetric === 'activeNet' ? row.active_net ?? null : row.main_net ?? null,
        mainNet: row.main_net,
        activeNet: row.active_net,
        superNet: row.super_net,
        price: row.price,
        pctChg: row.pct_chg,
        mainRatio: row.main_ratio,
      })),
      /** 上面那条曲线用的是哪个口径，前端据此改标题 */
      intradayFlowMetric: flowMetric,
      tradeDate,
      alerts,
    };
  }

  return { listEtfs, ranking, overview, categoryBreakdown, detail, allRows };
}
