import { config } from '../config/index.js';
import { fetchEtfUniverse, fetchQuotes, fetchDailyFlow, getBreakerState, isBreakerOpen } from '../providers/eastmoney.js';
import { fetchEtfUniverseFromSina } from '../providers/sina.js';
import { fetchMinuteQuotes } from '../providers/tencent.js';
import { classifyEtf } from '../lib/classify.js';
import { tradeDateOf, marketPhase, PHASE_LABEL } from '../lib/time.js';
import { mapPool, chunk } from '../lib/concurrency.js';
import { withTransaction } from '../db/index.js';
import { evaluateRules, persistAlerts } from './alertService.js';
import { EVENTS } from './events.js';

/**
 * 数据采集与状态中枢：
 * - syncUniverse：全市场 ETF 清单 + 监控池选样
 * - tick：监控池实时快照 → 落库 → 盘中阈值判定
 * - backfillDaily：日级资金流历史回填 → 日度阈值判定
 */
export function createMarketService({ db, repos, events, logger }) {
  const { etfRepo, flowRepo, ruleRepo, alertRepo, stateRepo } = repos;

  const state = {
    lastUniverseAt: stateRepo.getState('lastUniverseAt') ?? 0,
    lastTickAt: stateRepo.getState('lastTickAt') ?? 0,
    lastDailyAt: stateRepo.getState('lastDailyAt') ?? 0,
    lastTradeDate: stateRepo.getState('lastTradeDate') ?? null,
    lastError: stateRepo.getState('lastError') ?? null,
    universeTotal: stateRepo.getState('universeTotal') ?? 0,
    trackedCount: stateRepo.getState('trackedCount') ?? 0,
    aggregate: stateRepo.getState('marketAggregate') ?? null,
    quotes: new Map(),
    universeRows: [],
    // 实际生效的数据源。东财 push2 对机房 IP 常直接 reset，不能假设它一定可用，
    // 所以这里记录「这一轮到底是谁提供的」，由前端如实展示，不写死成东方财富。
    universeSource: stateRepo.getState('universeSource') ?? 'eastmoney',
    quoteSource: stateRepo.getState('quoteSource') ?? 'eastmoney',
    busy: { universe: false, tick: false, daily: false },
  };

  const log = logger.child({ module: 'market' });

  function computeAggregate(rows) {
    let totalMainNet = 0;
    let inflow = 0;
    let outflow = 0;
    let turnover = 0;
    for (const row of rows) {
      totalMainNet += row.mainNet ?? 0;
      turnover += row.turnover ?? 0;
      if ((row.mainNet ?? 0) > 0) inflow += 1;
      else if ((row.mainNet ?? 0) < 0) outflow += 1;
    }
    return { totalMainNet, inflow, outflow, flat: rows.length - inflow - outflow, turnover, sampleSize: rows.length, at: Date.now() };
  }

  /** 启动时用库内「最近已知快照」填充内存，保证上游不可用时前端仍有数据 */
  function hydrate() {
    const tracked = etfRepo.listTracked();
    if (tracked.length > 0) {
      const cached = flowRepo.latestForCodes(tracked.map((row) => row.code), 0);
      if (cached.length > 0) {
        withTransaction(db, () =>
          etfRepo.updateQuotes(
            cached.map((row) => ({
              code: row.code,
              price: row.price,
              pctChg: row.pct_chg,
              turnover: row.turnover,
              mainNet: row.main_net,
              mainRatio: row.main_ratio,
              superNet: row.super_net,
              quoteTs: row.ts,
            })),
          ),
        );
      }
    }

    const metas = etfRepo.listVisible({ limit: 3000 });
    let count = 0;
    for (const meta of metas) {
      if (meta.main_net === null || meta.main_net === undefined) continue;
      state.quotes.set(meta.code, {
        code: meta.code,
        market: meta.market,
        name: meta.name,
        price: meta.price,
        pctChg: meta.pct_chg,
        turnover: meta.turnover ?? 0,
        mainNet: meta.main_net,
        mainRatio: meta.main_ratio,
        superNet: meta.super_net ?? 0,
        bigNet: null,
        midNet: null,
        smallNet: null,
        quoteTs: meta.quote_ts,
      });
      count += 1;
    }
    if (count > 0) log.info('已从本地缓存恢复行情快照', { count });
    return count;
  }

  /**
   * 拉清单：东财优先，失败即切新浪。
   *
   * 东财 push2 一旦被拦，不管重试多少次都是 UND_ERR_SOCKET，所以这里不在同一轮里等它
   * 慢慢重试——直接降级。清单的作用只是「有哪些 ETF」，新浪给的信息足够；
   * 缺的主力净流入由后续快照补。
   */
  async function loadUniverse() {
    const problems = [];
    if (!isBreakerOpen('quote')) {
      try {
        const result = await fetchEtfUniverse();
        if (result.rows.length > 0) return { universe: result, source: 'eastmoney' };
        problems.push('东财返回空');
      } catch (error) {
        problems.push(`东财 ${error.message}`);
      }
    } else {
      problems.push('东财熔断中');
    }

    const fallback = await fetchEtfUniverseFromSina({
      pageSize: config.upstream.pageSize,
      maxPages: 20,
    });
    return { universe: fallback, source: 'sina', degraded: problems.join('；') };
  }

  async function syncUniverse() {
    if (state.busy.universe) return { ok: false, reason: 'busy' };
    state.busy.universe = true;
    try {
      const started = Date.now();
      const { universe, source, degraded } = await loadUniverse();
      const now = Date.now();
      const rows = universe.rows.map((row) => ({ ...row, category: classifyEtf(row.name) }));

      withTransaction(db, () => etfRepo.upsertMany(rows, now));

      const pinned = etfRepo.listPinned();
      const topCodes = etfRepo.topByTurnover(config.universeSize).map((row) => row.code);
      const trackedCodes = [...new Set([...pinned, ...topCodes])].slice(0, Math.max(config.universeSize, pinned.length));
      etfRepo.setTracked(trackedCodes);

      state.quotes = new Map(rows.map((row) => [row.code, row]));
      state.universeRows = rows;
      state.universeTotal = rows.length;
      state.trackedCount = trackedCodes.length;
      state.aggregate = computeAggregate(rows);
      state.lastUniverseAt = now;
      state.universeSource = source;

      stateRepo.setState('lastUniverseAt', now, now);
      stateRepo.setState('universeTotal', rows.length, now);
      stateRepo.setState('trackedCount', trackedCodes.length, now);
      stateRepo.setState('marketAggregate', state.aggregate, now);
      stateRepo.setState('universeSource', source, now);

      if (degraded) log.warn('清单主源不可用，已降级', { source, detail: degraded });

      log.info('全市场 ETF 清单同步完成', {
        total: rows.length,
        tracked: trackedCodes.length,
        source,
        durationMs: Date.now() - started,
      });
      events.publish(EVENTS.STATUS, {
        type: 'universe',
        at: now,
        total: rows.length,
        tracked: trackedCodes.length,
        source,
      });
      return { ok: true, total: rows.length, tracked: trackedCodes.length, source };
    } catch (error) {
      state.lastError = { at: Date.now(), scope: 'universe', message: error.message };
      stateRepo.setState('lastError', state.lastError);
      log.error('全市场清单同步失败', { code: error.code, message: error.message });
      return { ok: false, error };
    } finally {
      state.busy.universe = false;
    }
  }

  function snapshotTsOf(quote) {
    const now = Date.now();
    if (quote.quoteTs && Math.abs(now - quote.quoteTs) < 4 * 86400 * 1000) return quote.quoteTs;
    return now;
  }

  /**
   * 拉快照：东财优先，失败即切腾讯批量快照。
   *
   * 两家返回的字段口径不同（东财给主力/超大单/大单分档，腾讯只有外盘/内盘），
   * 转换在 providers/tencent.js 的 toMinuteQuoteRow 里做，折算成当日累计主动净买入额后
   * 顶到同一个 mainNet 字段上，因此下游指标与规则完全不用改。
   */
  async function collectQuotes(tracked) {
    const refs = tracked.map((row) => ({ code: row.code, market: row.market }));
    const problems = [];

    if (!isBreakerOpen('quote')) {
      try {
        const batches = chunk(refs, config.upstream.batchSize);
        const quotes = [];
        await mapPool(batches, 2, async (batch) => {
          const result = await fetchQuotes(batch);
          quotes.push(...result);
        });
        if (quotes.length > 0) return { quotes, source: 'eastmoney' };
        problems.push('东财返回空');
      } catch (error) {
        problems.push(`东财 ${error.message}`);
      }
    } else {
      problems.push('东财熔断中');
    }

    const fallback = await fetchMinuteQuotes(refs);
    return { quotes: fallback, source: 'tencent', degraded: problems.join('；') };
  }

  async function tick() {
    if (state.busy.tick) return { ok: false, reason: 'busy' };
    state.busy.tick = true;
    try {
      const tracked = etfRepo.listTracked();
      if (tracked.length === 0) return { ok: true, inserted: 0, skipped: 'empty-universe' };

      const { quotes, source: quoteSource, degraded } = await collectQuotes(tracked);
      // 腾讯快照不带可用名称（GBK），统一沿用库内名称，避免详情页标题变空白
      const nameByCode = new Map(tracked.map((row) => [row.code, row.name]));
      for (const quote of quotes) {
        if (!quote.name) quote.name = nameByCode.get(quote.code) ?? null;
      }

      const now = Date.now();
      const rows = quotes.map((quote) => {
        const ts = snapshotTsOf(quote);
        return {
          code: quote.code,
          ts,
          tradeDate: tradeDateOf(ts),
          mainNet: quote.mainNet,
          superNet: quote.superNet,
          bigNet: quote.bigNet,
          midNet: quote.midNet,
          smallNet: quote.smallNet,
          mainRatio: quote.mainRatio,
          price: quote.price,
          pctChg: quote.pctChg,
          turnover: quote.turnover,
          source: quoteSource === 'eastmoney' ? 'live' : `live-${quoteSource}`,
        };
      });

      const inserted = withTransaction(db, () => {
        const count = flowRepo.insertSnapshots(rows);
        etfRepo.updateQuotes(quotes, now);
        return count;
      });
      for (const quote of quotes) state.quotes.set(quote.code, quote);

      state.lastTickAt = now;
      state.quoteSource = quoteSource;
      stateRepo.setState('lastTickAt', now, now);
      stateRepo.setState('quoteSource', quoteSource, now);
      if (degraded) log.warn('快照主源不可用，已降级', { source: quoteSource, detail: degraded });

      // 只在交易时段做盘中阈值判定，避免用陈旧快照误判「急流」
      const phase = marketPhase(now);
      const shouldEvaluate = phase === 'trading' || phase === 'closing' || phase === 'pre_open';
      let alerts = [];
      if (shouldEvaluate && inserted > 0) {
        alerts = evaluateIntraday(now);
      }

      events.publish(EVENTS.TICK, {
        at: now,
        phase,
        inserted,
        quotes: tracked.length,
        alerts: alerts.length,
        source: quoteSource,
      });

      log.info('快照采集完成', { quotes: quotes.length, inserted, phase, alerts: alerts.length, source: quoteSource });
      return { ok: true, inserted, alerts: alerts.length, phase, source: quoteSource };
    } catch (error) {
      state.lastError = { at: Date.now(), scope: 'tick', message: error.message };
      stateRepo.setState('lastError', state.lastError);
      log.error('快照采集失败', { code: error.code, message: error.message });
      return { ok: false, error };
    } finally {
      state.busy.tick = false;
    }
  }

  function evaluateIntraday(now = Date.now()) {
    const rules = ruleRepo.list({ enabledOnly: true }).filter((rule) => rule.timeframe !== 'daily');
    if (rules.length === 0) return [];

    const tracked = etfRepo.listTracked();
    const metaByCode = new Map(tracked.map((row) => [row.code, row]));
    const codes = tracked.map((row) => row.code);
    const maxWindowSec = Math.max(300, ...rules.map((rule) => rule.windowSec ?? rule.window_sec ?? 300));
    const fromTs = now - maxWindowSec * 1000 - 60_000;

    const series = flowRepo.seriesInWindow(fromTs, codes);
    const grouped = new Map();
    for (const point of series) {
      if (!grouped.has(point.code)) grouped.set(point.code, []);
      grouped.get(point.code).push(point);
    }

    const entries = [];
    for (const code of codes) {
      const points = grouped.get(code);
      if (!points || points.length === 0) continue;
      const etf = metaByCode.get(code);
      entries.push({ etf, points, tradeDate: points[points.length - 1].trade_date });
    }

    const candidates = evaluateRules({
      rules,
      entries,
      now,
      maxPerRule: config.alertMaxPerRulePerCycle,
    });
    return persistAlerts({ candidates, alertRepo, events, logger: log, source: 'live', now });
  }

  async function backfillDaily({ evaluate = true, force = false } = {}) {
    if (state.busy.daily) return { ok: false, reason: 'busy' };
    state.busy.daily = true;
    try {
      // 6 小时内已回填过则跳过网络请求，只重算告警：避免频繁重启反复打上游
      if (!force && state.lastDailyAt && Date.now() - state.lastDailyAt < 6 * 3600 * 1000) {
        const latest = flowRepo.latestTradeDate();
        if (latest) {
          state.lastTradeDate = latest;
          const alerts = evaluate ? evaluateDaily(latest) : [];
          return { ok: true, skipped: 'fresh-cache', tradeDate: latest, alerts: alerts.length };
        }
      }

      const started = Date.now();
      const tracked = etfRepo.listTracked();
      const now = Date.now();
      let failed = 0;

      const results = await mapPool(tracked, 3, async (etf) => {
        // 熔断期间直接短路，避免对已被限流的上游连续重试 120 次
        if (isBreakerOpen('history')) {
          failed += 1;
          return [];
        }
        try {
          const rows = await fetchDailyFlow(etf.code, etf.market, { days: config.historyDays });
          return rows.map((row) => ({ ...row, code: etf.code, source: 'live' }));
        } catch {
          failed += 1;
          return [];
        }
      });

      const rows = results.flat();
      if (rows.length > 0) {
        const changed = withTransaction(db, () => flowRepo.upsertDailyMany(rows, now));
        state.lastDailyAt = now;
        stateRepo.setState('lastDailyAt', now, now);
        log.info('日级资金流回填完成', {
          codes: tracked.length - failed,
          rows: rows.length,
          changed,
          durationMs: Date.now() - started,
        });
      }
      if (failed > 0) {
        log.warn('部分标的日级回填失败，已跳过', { failed, total: tracked.length, upstream: isBreakerOpen('history') });
      }

      // 无论网络是否成功，都用库内已有数据重算日度告警，保证离线可用
      const latest = flowRepo.latestTradeDate();
      let alerts = [];
      if (latest) {
        state.lastTradeDate = latest;
        stateRepo.setState('lastTradeDate', latest, now);
        if (evaluate) alerts = evaluateDaily(latest);
      }

      events.publish(EVENTS.STATUS, { type: 'daily', at: now, tradeDate: latest, rows: rows.length });
      return { ok: true, rows: rows.length, tradeDate: latest, alerts: alerts.length, failed };
    } catch (error) {
      state.lastError = { at: Date.now(), scope: 'daily', message: error.message };
      stateRepo.setState('lastError', state.lastError);
      log.error('日级资金流回填失败', { code: error.code, message: error.message });
      return { ok: false, error };
    } finally {
      state.busy.daily = false;
    }
  }

  /** 仅用库内已有日线数据重算日度告警（离线/限流场景的兜底） */
  function refreshDailyAlerts() {
    const latest = flowRepo.latestTradeDate();
    if (!latest) return [];
    state.lastTradeDate = latest;
    stateRepo.setState('lastTradeDate', latest);
    return evaluateDaily(latest);
  }

  function evaluateDaily(tradeDate) {
    const rules = ruleRepo.list({ enabledOnly: true }).filter((rule) => rule.timeframe === 'daily');
    if (rules.length === 0) return [];

    const tracked = etfRepo.listTracked();
    const entries = [];
    for (const etf of tracked) {
      const history = flowRepo.dailySeries(etf.code, 12);
      const today = history.find((row) => row.trade_date === tradeDate);
      if (!today) continue;
      const prevDaily = history.filter((row) => row.trade_date < tradeDate);
      entries.push({ etf, points: [], daily: today, prevDaily, tradeDate });
    }

    const candidates = evaluateRules({ rules, entries, now: Date.now(), maxPerRule: config.alertMaxPerRulePerCycle });
    return persistAlerts({ candidates, alertRepo, events, logger: log, source: 'live' });
  }

  function pruneSnapshots() {
    if (!config.retentionDays) return 0;
    const before = Date.now() - config.retentionDays * 86400 * 1000;
    const removed = flowRepo.pruneSnapshots(before);
    if (removed > 0) log.info('清理过期快照', { removed, retentionDays: config.retentionDays });
    return removed;
  }

  const SOURCE_LABEL = { eastmoney: '东方财富', sina: '新浪', tencent: '腾讯' };

  /**
   * 数据源描述：必须是「实际生效的」，不能写死。
   * 前端顶部那颗来源芯片直接读它，用户一眼能看出当前是不是降级状态。
   */
  function describeSource() {
    const { universeSource, quoteSource } = state;
    const degraded = universeSource !== 'eastmoney' || quoteSource !== 'eastmoney';
    if (!degraded) {
      return {
        name: '东方财富',
        provider: 'eastmoney',
        mode: 'live',
        universeSource,
        quoteSource,
        fields: ['主力净流入', '超大单', '大单', '中单', '小单', '成交额'],
        note: null,
      };
    }
    const parts = [SOURCE_LABEL[universeSource] ?? universeSource];
    if (quoteSource !== universeSource) parts.push(SOURCE_LABEL[quoteSource] ?? quoteSource);
    return {
      name: `${parts.join(' / ')} · 主动净买额口径`,
      provider: quoteSource,
      mode: 'degraded',
      universeSource,
      quoteSource,
      fields: quoteSource === 'eastmoney' ? ['主力净流入', '成交额'] : ['主动净买额', '成交额'],
      note: '主力净流入不可用（东财实时行情拒绝当前出口 IP），净额字段改为（外盘−内盘）×100×现价的当日累计值',
    };
  }

  function getStatus() {
    const phase = marketPhase();
    const quoteTsList = [...state.quotes.values()].map((row) => row.quoteTs ?? 0);
    const latestQuoteTs = quoteTsList.length > 0 ? Math.max(...quoteTsList) : 0;
    return {
      phase,
      phaseLabel: PHASE_LABEL[phase],
      tradeDate: tradeDateOf(),
      lastTradeDate: state.lastTradeDate,
      lastUniverseAt: state.lastUniverseAt,
      lastTickAt: state.lastTickAt,
      lastDailyAt: state.lastDailyAt,
      universeTotal: state.universeTotal,
      trackedCount: state.trackedCount,
      activeRules: ruleRepo.countEnabled(),
      lastError: state.lastError,
      pollIntervalMs: config.pollIntervalMs,
      latestQuoteTs,
      quoteAgeMs: latestQuoteTs > 0 ? Date.now() - latestQuoteTs : null,
      breaker: getBreakerState(),
      dataSource: describeSource(),
      busy: { ...state.busy },
    };
  }

  return {
    state,
    hydrate,
    syncUniverse,
    tick,
    backfillDaily,
    refreshDailyAlerts,
    evaluateIntraday,
    evaluateDaily,
    pruneSnapshots,
    getStatus,
    getQuotes: () => state.quotes,
    getAggregate: () => state.aggregate ?? { totalMainNet: 0, inflow: 0, outflow: 0, flat: 0, turnover: 0, sampleSize: 0 },
    getUniverseRows: () => state.universeRows,
  };
}
