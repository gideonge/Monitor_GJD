import { config } from '../config/index.js';
import { fetchFastQuotes, isFastBreakerOpen, getFastBreakerState } from '../providers/tencent.js';
import { marketPhase, tradeDateOf } from '../lib/time.js';
import { withTransaction } from '../db/index.js';

/**
 * 秒级通道：只服务核心池（国家队常买宽基）。
 *
 * 分层的理由不是「快一点更好看」，而是数据量与信噪比：
 * 120 只标的按 1 秒采样是 120 倍于分钟级的数据，其中绝大多数标的的秒级波动只是做市报价；
 * 真正需要用秒级判断的是「宽基 ETF 上突然出现的连续大额扫单」，这恰好发生在国家队入场的标的上。
 * 所以这里只对核心池做 1 秒采样，其余标的继续走 60 秒的分钟级轮询。
 *
 * 关键派生量：
 *   amtDelta = 本秒成交额（累计额差分）
 *   netDelta = 本秒主动净买入额 =（外盘增量 − 内盘增量）× 100 份/手 × 现价
 * 外盘/内盘是交易所按「主动买/主动卖」统计的累计量，是免费接口里最接近主动资金方向的口径。
 *
 * 首点不计算增量：盘中启动时累计量是从开盘算起的，直接差分会把一上午的量误记成「这一秒」。
 */

const MAX_POOL = 40;

export function createFastTickService({ db, repos, logger, options = {} }) {
  const { etfRepo, fastTickRepo } = repos;
  const cfg = { ...config.fastTick, ...(options.fastTick ?? {}) };
  const log = logger.child({ module: 'fast' });
  // 单测注入点：真实运行时全部走默认实现
  const fetchQuotes = options.fetchQuotes ?? fetchFastQuotes;
  const phaseOf = options.marketPhase ?? marketPhase;
  const breakerOpen = options.isBreakerOpen ?? isFastBreakerOpen;

  const state = {
    pool: [],
    poolReadyAt: 0,
    lastPollAt: 0,
    lastLatencyMs: null,
    lastError: null,
    polls: 0,
    failures: 0,
    recordedToday: 0,
    countedDate: null,
    busy: false,
  };

  /** code → 上一个快照（用于差分累计量） */
  const prevByCode = new Map();
  /** code → 内存环形缓冲（最近 memorySec 秒） */
  const memory = new Map();
  /** 待落库队列 */
  let pending = [];
  let lastFlushAt = 0;

  function resolvePool() {
    const codes = [...new Set((cfg.codes ?? []).map((code) => String(code).trim()).filter((code) => /^\d{6}$/.test(code)))];
    const resolved = [];
    const missing = [];
    for (const code of codes) {
      const meta = etfRepo.get(code);
      if (!meta) {
        missing.push(code);
        continue;
      }
      resolved.push({ code, name: meta.name, market: meta.market });
      if (resolved.length >= MAX_POOL) break;
    }
    if (missing.length > 0) {
      log.warn('秒级池中存在 ETF 清单里没有的代码，已跳过', { missing });
    }
    state.pool = resolved;
    state.poolReadyAt = Date.now();
    log.info('秒级通道标的池', { count: resolved.length, codes: resolved.map((item) => item.code).join(',') });
    return resolved;
  }

  function getPool() {
    // 池为空（首次启动、清单还没同步）时每 5 秒重试一次，不要在每秒的轮询里反复查库
    if (state.pool.length === 0 && Date.now() - state.poolReadyAt > 5000) resolvePool();
    return state.pool;
  }

  function poolCodes() {
    return getPool().map((item) => item.code);
  }

  function pushMemory(code, point) {
    let list = memory.get(code);
    if (!list) {
      list = [];
      memory.set(code, list);
    }
    list.push(point);
    const cutoff = point.ts - cfg.memorySec * 1000;
    let drop = 0;
    while (drop < list.length && list[drop].ts < cutoff) drop += 1;
    if (drop > 0) list.splice(0, drop);
  }

  /**
   * 一轮秒级采集。
   * 返回结构统一，便于 /api/sync 与调度器复用。
   */
  async function poll({ force = false } = {}) {
    if (!cfg.enabled) return { ok: true, skipped: 'disabled' };
    if (state.busy) return { ok: false, skipped: 'busy' };
    if (!force) {
      const phase = phaseOf();
      if (phase !== 'trading') return { ok: true, skipped: 'phase', phase };
    }
    if (breakerOpen()) return { ok: true, skipped: 'circuit_open' };

    const pool = getPool();
    if (pool.length === 0) return { ok: true, skipped: 'empty_pool' };

    state.busy = true;
    const startedAt = Date.now();
    try {
      const { rows, latencyMs } = await fetchQuotes(pool);
      const now = Date.now();
      const today = tradeDateOf(now);
      if (state.countedDate !== today) {
        state.countedDate = today;
        state.recordedToday = 0;
      }

      const points = [];
      for (const quote of rows) {
        if (!quote.ts) continue;
        const tradeDate = tradeDateOf(quote.ts);
        const prev = prevByCode.get(quote.code);

        // 上游快照时间没有前进：停牌、非交易时段或同一秒内重复请求，不产生新点
        if (prev && quote.ts <= prev.ts) continue;

        let amtDelta = null;
        let netDelta = null;
        if (prev && prev.tradeDate === tradeDate && Number.isFinite(quote.amount) && Number.isFinite(prev.amount)) {
          amtDelta = Math.max(0, quote.amount - prev.amount);
          if (Number.isFinite(quote.outer) && Number.isFinite(quote.inner) && Number.isFinite(prev.outer)) {
            netDelta = ((quote.outer - prev.outer) - (quote.inner - prev.inner)) * 100 * quote.price;
          }
        }

        prevByCode.set(quote.code, {
          ts: quote.ts,
          tradeDate,
          amount: quote.amount,
          outer: quote.outer,
          inner: quote.inner,
        });

        const point = {
          code: quote.code,
          ts: quote.ts,
          tradeDate,
          price: quote.price,
          pctChg: quote.pctChg,
          volume: quote.volume,
          amount: quote.amount,
          outer: quote.outer,
          inner: quote.inner,
          amtDelta,
          netDelta,
          bid1: quote.bid1,
          ask1: quote.ask1,
          bid1Vol: quote.bid1Vol,
          ask1Vol: quote.ask1Vol,
          imba: quote.imba,
          source: quote.source,
        };
        points.push(point);
        pushMemory(quote.code, point);
      }

      // 缓冲写库：每秒一次事务对 WAL 不划算，攒到 flushMs 或 200 行再落
      if (points.length > 0) {
        pending.push(...points);
        state.recordedToday += points.length;
      }
      if (pending.length >= 200 || now - lastFlushAt >= cfg.flushMs) flushNow();

      state.lastPollAt = now;
      state.lastLatencyMs = latencyMs;
      state.polls += 1;
      state.lastError = null;
      return { ok: true, quotes: rows.length, points: points.length, latencyMs };
    } catch (error) {
      state.failures += 1;
      state.lastError = { at: Date.now(), message: error.message };
      log.warn('秒级采集失败', { message: error.message, failures: state.failures });
      return { ok: false, error: error.message };
    } finally {
      state.busy = false;
    }
  }

  function flushNow() {
    if (pending.length === 0) return 0;
    const rows = pending;
    pending = [];
    lastFlushAt = Date.now();
    try {
      const inserted = withTransaction(db, () => fastTickRepo.insertMany(rows));
      if (inserted > 0 && inserted !== rows.length) {
        log.warn('秒级数据部分重复', { rows: rows.length, inserted });
      }
      return inserted;
    } catch (error) {
      log.error('秒级数据落库失败', { err: error, rows: rows.length });
      return 0;
    }
  }

  /**
   * 合并「库内已落」与「内存未落」，返回最近 N 秒的逐秒点。
   *
   * 窗口锚点取该标的最后一条数据，而不是系统时钟：
   * 收盘后（或周末）打开详情，用户想看的是「收盘前最后 10 分钟」，
   * 用 now 作锚点会得到一个空窗口。
   */
  function series(code, { seconds = 600 } = {}) {
    const span = Math.max(30, seconds) * 1000;
    let anchor = 0;
    try {
      anchor = fastTickRepo.latestTs(code) ?? 0;
    } catch (error) {
      log.warn('读取秒级数据失败', { code, message: error.message });
    }
    const memoryRows = memory.get(code) ?? [];
    const memoryLast = memoryRows.length > 0 ? memoryRows[memoryRows.length - 1].ts : 0;
    anchor = Math.max(anchor, memoryLast);
    if (anchor === 0) return [];

    const from = anchor - span;
    let rows = [];
    try {
      rows = fastTickRepo.series(code, from, { limit: seconds + 120 });
    } catch (error) {
      log.warn('读取秒级数据失败', { code, message: error.message });
    }
    const lastTs = rows.length > 0 ? rows[rows.length - 1].ts : 0;
    for (const point of memoryRows) {
      if (point.ts > lastTs && point.ts >= from) {
        rows.push({
          ts: point.ts,
          price: point.price,
          pct_chg: point.pctChg,
          volume: point.volume,
          amount: point.amount,
          amt_delta: point.amtDelta,
          net_delta: point.netDelta,
          imba: point.imba,
          bid1: point.bid1,
          ask1: point.ask1,
          bid1_vol: point.bid1Vol,
          ask1_vol: point.ask1Vol,
        });
      }
    }
    return rows;
  }

  /**
   * 只读内存缓冲的最近 N 秒序列（不查库）。
   *
   * 秒级检测每 5 秒扫一次核心池，若每次都走 SQLite 查 15 × 900 行，
   * 读放大是整个链路里最贵的一步；而盘中内存缓冲（默认 30 分钟）本来就够覆盖检测窗口。
   */
  function memorySeries(code, { seconds = 900 } = {}) {
    const rows = memory.get(code) ?? [];
    if (rows.length === 0) return [];
    const anchor = rows[rows.length - 1].ts;
    const from = anchor - Math.max(30, seconds) * 1000;
    const out = [];
    for (const point of rows) {
      if (point.ts < from) continue;
      out.push({
        ts: point.ts,
        price: point.price,
        amt_delta: point.amtDelta,
        net_delta: point.netDelta,
        imba: point.imba,
        bid1: point.bid1,
        ask1: point.ask1,
      });
    }
    return out;
  }

  function summarize(code, { seconds = 600 } = {}) {
    const points = series(code, { seconds });
    let amt = 0;
    let net = 0;
    let inflow = 0;
    let outflow = 0;
    let counted = 0;
    for (const point of points) {
      if (!Number.isFinite(point.amt_delta)) continue;
      amt += point.amt_delta;
      counted += 1;
      if (Number.isFinite(point.net_delta)) {
        net += point.net_delta;
        if (point.net_delta > 0) inflow += point.net_delta;
        else outflow += point.net_delta;
      }
    }
    const last = points[points.length - 1] ?? null;
    return {
      windowSec: seconds,
      points: points.length,
      samples: counted,
      amount: amt,
      netAmount: net,
      inflow,
      outflow,
      lastPrice: last?.price ?? null,
      lastTs: last?.ts ?? null,
      imba: last?.imba ?? null,
      bid1: last?.bid1 ?? null,
      ask1: last?.ask1 ?? null,
    };
  }

  /** 详情页用：该标的是否在秒级池里 */
  function describe(code) {
    const inPool = poolCodes().includes(code);
    return {
      tier: inPool ? 'second' : 'minute',
      tierLabel: inPool ? '秒级通道' : '分钟级',
      inPool,
      intervalMs: inPool ? cfg.intervalMs : config.pollIntervalMs,
      poolSize: state.pool.length,
      enabled: cfg.enabled,
      lastPollAt: state.lastPollAt,
    };
  }

  function prune() {
    if (!cfg.retentionDays) return 0;
    const before = Date.now() - cfg.retentionDays * 86400 * 1000;
    const removed = fastTickRepo.pruneBefore(before);
    if (removed > 0) log.info('清理过期秒级数据', { removed, retentionDays: cfg.retentionDays });
    return removed;
  }

  function getStatus() {
    const lastTs = state.lastPollAt;
    return {
      enabled: cfg.enabled,
      intervalMs: cfg.intervalMs,
      poolSize: state.pool.length,
      pool: state.pool.map((item) => ({ code: item.code, name: item.name })),
      phaseAllowed: phaseOf() === 'trading',
      lastPollAt: state.lastPollAt,
      lastPollAgeMs: lastTs > 0 ? Date.now() - lastTs : null,
      lastLatencyMs: state.lastLatencyMs,
      polls: state.polls,
      failures: state.failures,
      todayPoints: state.recordedToday,
      buffered: pending.length,
      memorySec: cfg.memorySec,
      retentionDays: cfg.retentionDays,
      lastError: state.lastError,
      breaker: getFastBreakerState(),
    };
  }

  return {
    poll,
    flushNow,
    series,
    memorySeries,
    summarize,
    describe,
    prune,
    getStatus,
    getPool,
    poolCodes,
    resolvePool,
    /** 单测注入用 */
    _state: state,
  };
}
