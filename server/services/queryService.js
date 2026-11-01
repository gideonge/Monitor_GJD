import { notFound } from '../lib/errors.js';
import { marketPhase, tradeDateOf } from '../lib/time.js';
import { computeDailyMetrics } from './metricService.js';

const SORTABLE = new Set(['mainNet', 'mainRatio', 'pctChg', 'turnover', 'superNet', 'code']);

function shapeQuote(live, meta) {
  return {
    code: meta?.code ?? live?.code,
    name: live?.name ?? meta?.name ?? '—',
    category: meta?.category ?? '其他',
    market: meta?.market ?? live?.market ?? null,
    price: live?.price ?? meta?.price ?? null,
    pctChg: live?.pctChg ?? meta?.pct_chg ?? null,
    turnover: live?.turnover ?? meta?.turnover ?? 0,
    mainNet: live?.mainNet ?? meta?.main_net ?? null,
    mainRatio: live?.mainRatio ?? meta?.main_ratio ?? null,
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
    return metas.map((meta) => shapeQuote(quotes.get(meta.code) ?? null, meta));
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
    let rows = allRows();
    if (onlyTracked) rows = rows.filter((row) => row.tracked);
    if (category) rows = rows.filter((row) => row.category === category);
    if (keyword) {
      const text = keyword.trim().toLowerCase();
      rows = rows.filter(
        (row) => row.code.includes(text) || String(row.name).toLowerCase().includes(text),
      );
    }
    return sortRows(rows, sort, dir).slice(0, limit);
  }

  function ranking({ direction = 'inflow', limit = 20, category, onlyTracked = false } = {}) {
    let rows = allRows().filter((row) => row.mainNet !== null);
    if (onlyTracked) rows = rows.filter((row) => row.tracked);
    if (category) rows = rows.filter((row) => row.category === category);
    rows.sort((a, b) => (direction === 'inflow' ? b.mainNet - a.mainNet : a.mainNet - b.mainNet));
    return rows.slice(0, limit);
  }

  function categoryBreakdown() {
    const buckets = new Map();
    for (const row of allRows()) {
      const key = row.category ?? '其他';
      const bucket = buckets.get(key) ?? { category: key, mainNet: 0, count: 0, inflow: 0, outflow: 0, turnover: 0 };
      const net = row.mainNet ?? 0;
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
    const rows = allRows();
    // 只统计真正拿到资金流数值的标的，避免把「无数据」当作 0 计入合计
    const scoped = rows.filter((row) => typeof row.mainNet === 'number');
    const tracked = scoped.filter((row) => row.tracked);
    const sum = (list, key) => list.reduce((total, row) => total + (row[key] ?? 0), 0);
    const count = (list, predicate) => list.filter(predicate).length;

    return {
      market: {
        totalMainNet: sum(scoped, 'mainNet'),
        totalTurnover: sum(scoped, 'turnover'),
        inflow: count(scoped, (row) => (row.mainNet ?? 0) > 0),
        outflow: count(scoped, (row) => (row.mainNet ?? 0) < 0),
        sampleSize: scoped.length,
        universeSize: rows.length,
      },
      tracked: {
        totalMainNet: sum(tracked, 'mainNet'),
        totalTurnover: sum(tracked, 'turnover'),
        inflow: count(tracked, (row) => (row.mainNet ?? 0) > 0),
        outflow: count(tracked, (row) => (row.mainNet ?? 0) < 0),
        sampleSize: tracked.length,
      },
      topInflow: ranking({ direction: 'inflow', limit: 6 }),
      topOutflow: ranking({ direction: 'outflow', limit: 6 }),
      categories: categoryBreakdown(),
      snapshotAt: Math.max(0, ...rows.map((row) => row.quoteTs ?? 0)),
      coverage: count(rows, (row) => row.quoteTs !== null && row.quoteTs !== undefined),
    };
  }

  function detail(code) {
    const meta = etfRepo.get(code);
    const quote = marketService.getQuotes().get(code) ?? null;
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
      /** 盘中轮询累积的主力净流入分时（仅当天平台运行过才有值） */
      intradayFlow: flowPoints.map((row) => ({
        ts: row.ts,
        mainNet: row.main_net,
        superNet: row.super_net,
        price: row.price,
        pctChg: row.pct_chg,
        mainRatio: row.main_ratio,
      })),
      tradeDate,
      alerts,
    };
  }

  return { listEtfs, ranking, overview, categoryBreakdown, detail, allRows };
}
