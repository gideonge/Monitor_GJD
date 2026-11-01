import { config } from '../config/index.js';
import { fetchIntradayTrends, fetchMinuteToday, isBreakerOpen } from '../providers/eastmoney.js';
import { isTradeDateClosed, marketPhase, tradeDateOf, PHASE_LABEL } from '../lib/time.js';
import { sleep } from '../lib/concurrency.js';
import { withTransaction } from '../db/index.js';

/**
 * 分时行情服务（分钟级价格 + 成交量）。
 *
 * 数据源：东方财富 trends2，一次请求可带回近 5 个交易日的逐分钟数据（每日 241 点），
 * 因此按「标的」为单位批量落库，之后切换交易日全部命中本地缓存。
 *
 * 上游对高频请求敏感，这里做了三层保护：
 * 1. 全局串行队列 + 请求间隔，杜绝并发打爆上游；
 * 2. 落库即视为已回填，同一标的同一交易日不再重复请求；
 * 3. 熔断期内直接降级为「读本地缓存」。
 */

const SERIAL_GAP_MS = 1200; // 两次上游请求的最小间隔（上游对高频请求敏感）
const LIVE_GAP_MS = 200; // 盘中实时刷新的间隔：备源对分钟级轮询容忍度更高
const MIN_POINTS = 30; // 少于此点数视为数据不完整，允许重新拉取
const FULL_DAY_POINTS = 200; // 视为完整交易日分时的阈值

/**
 * 推导每个交易日的昨收价：
 * 优先用相邻（更早）已拉取交易日的收盘价，其次用上游返回的 preClose（仅对最新交易日有效）。
 * 这样即使只回填了单个交易日，涨跌幅与红绿判定也有正确基准。
 */
export function assignPreClose(rows, metaPreClose, meta = {}) {
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.tradeDate)) byDate.set(row.tradeDate, []);
    byDate.get(row.tradeDate).push(row);
  }
  const dates = [...byDate.keys()].sort();
  const latestDate = dates[dates.length - 1] ?? null;
  let prevClose = null;
  for (const date of dates) {
    const day = byDate.get(date);
    day.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let base = prevClose;
    if ((!base || base <= 0) && date === latestDate && metaPreClose > 0) base = metaPreClose;
    if (base && base > 0) for (const row of day) row.preClose = base;

    // 当日高低：默认取分钟级极值；最新交易日若数据源给出真实日高日低则优先
    let dayHigh = -Infinity;
    let dayLow = Infinity;
    for (const row of day) {
      if (Number.isFinite(row.high)) dayHigh = Math.max(dayHigh, row.high);
      if (Number.isFinite(row.low)) dayLow = Math.min(dayLow, row.low);
    }
    if (date === latestDate) {
      if (Number.isFinite(meta.dayHigh)) dayHigh = meta.dayHigh;
      if (Number.isFinite(meta.dayLow)) dayLow = meta.dayLow;
    }
    for (const row of day) {
      if (Number.isFinite(dayHigh)) row.dayHigh = dayHigh;
      if (Number.isFinite(dayLow)) row.dayLow = dayLow;
    }

    prevClose = day[day.length - 1].close;
  }
  return rows;
}

export function summarize(code, tradeDate, preClose, rows, extra = {}) {
  if (rows.length === 0) {
    return { code, tradeDate, preClose, summary: null, bars: [] };
  }
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  let amount = 0;
  let prevClose = preClose;
  for (const row of rows) {
    if (row.high !== null && row.high > high) high = row.high;
    if (row.low !== null && row.low < low) low = row.low;
    volume += row.volume ?? 0;
    amount += row.amount ?? 0;
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!prevClose || prevClose <= 0) prevClose = first.open ?? first.close;

  // 数据源直接给出当日真实高低时优先采用（备用源的分钟价无法反映分钟内极值）
  const dayHigh = Number.isFinite(extra.dayHigh) ? extra.dayHigh : high;
  const dayLow = Number.isFinite(extra.dayLow) ? extra.dayLow : low;

  return {
    code,
    tradeDate,
    preClose: prevClose,
    summary: {
      open: first.open ?? first.close,
      close: last.close,
      high: Number.isFinite(dayHigh) ? dayHigh : last.close,
      low: Number.isFinite(dayLow) ? dayLow : last.close,
      avgPrice: last.avg_price ?? null,
      volume,
      amount,
      points: rows.length,
      pctChg: prevClose > 0 ? ((last.close - prevClose) / prevClose) * 100 : null,
      amplitude:
        prevClose > 0 && Number.isFinite(dayHigh) && Number.isFinite(dayLow)
          ? ((dayHigh - dayLow) / prevClose) * 100
          : null,
    },
    bars: rows.map((row) => ({
      minute: row.minute,
      ts: row.ts,
      price: row.close,
      avgPrice: row.avg_price,
      volume: row.volume,
      amount: row.amount,
    })),
  };
}

export function createIntradayService({ db, repos, logger }) {
  const { etfRepo, intradayRepo, flowRepo } = repos;
  const log = logger.child({ module: 'intraday' });

  const state = {
    lastBackfillAt: 0,
    lastBackfillDate: null,
    lastError: null,
    fetchedCodes: 0,
    busy: false,
    lastFetchByCode: new Map(),
    // 盘中实时刷新（供量能突变扫描使用）
    lastLiveAt: 0,
    liveFetched: 0,
    liveFailed: 0,
    liveCursor: 0,
    busyLive: false,
  };

  /** 全局串行队列：所有上游分时请求排队执行，并保证最小间隔 */
  let chain = Promise.resolve();
  let lastRequestAt = 0;

  function serial(task) {
    const run = chain.then(async () => {
      const wait = SERIAL_GAP_MS - (Date.now() - lastRequestAt);
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      return task();
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 盘中实时刷新用的独立队列：与「按需/回填」队列分开，
   * 避免用户点开详情时排在几十只标的的轮询后面等上一分钟。
   */
  let liveChain = Promise.resolve();
  let lastLiveRequestAt = 0;

  function serialLive(task) {
    const run = liveChain.then(async () => {
      const wait = LIVE_GAP_MS - (Date.now() - lastLiveRequestAt);
      if (wait > 0) await sleep(wait);
      lastLiveRequestAt = Date.now();
      return task();
    });
    liveChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function resolveMarket(code, fallback) {
    if (fallback === 0 || fallback === 1) return fallback;
    const meta = etfRepo.get(code);
    if (meta && (meta.market === 0 || meta.market === 1)) return meta.market;
    // 沪市 ETF 以 5 开头（51/56/58…），其余归深市
    return code.startsWith('5') ? 1 : 0;
  }

  /** 纯本地读取，不触网：供详情页首屏快速渲染 */
  function readIntraday(code, { date } = {}) {
    const dates = intradayRepo.dates(code, config.intradayDays);
    const target = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : dates[0] ?? null;
    if (!target) {
      return {
        code,
        tradeDate: null,
        dates,
        isClosed: true,
        phase: marketPhase(),
        phaseLabel: PHASE_LABEL[marketPhase()],
        preClose: null,
        summary: null,
        bars: [],
        available: false,
        cached: true,
        note: '暂无分时数据',
      };
    }

    const rows = intradayRepo.series(code, target);
    const prevDate = dates.find((item) => item < target) ?? null;
    const prevRows = prevDate ? intradayRepo.series(code, prevDate) : [];
    // 优先用落库时记录的昨收，其次用前一交易日收盘价
    const preClose = rows[0]?.pre_close ?? (prevRows.length > 0 ? prevRows[prevRows.length - 1].close : null);
    const shaped = summarize(code, target, preClose, rows, {
      dayHigh: rows[0]?.day_high ?? null,
      dayLow: rows[0]?.day_low ?? null,
    });
    const isClosed = isTradeDateClosed(target);

    return {
      ...shaped,
      dates,
      isClosed,
      phase: marketPhase(),
      phaseLabel: PHASE_LABEL[marketPhase()],
      available: rows.length > 0,
      cached: true,
      note:
        rows.length === 0
          ? `${target} 分时数据尚未加载`
          : isClosed
            ? `${target} 已收盘 · ${rows.length} 个分钟点`
            : `${target} 盘中截至 ${rows[rows.length - 1].minute} · ${rows.length} 个分钟点`,
    };
  }

  /**
   * 按需拉取：本地缺失（或指定日期不在缓存中）时请求上游并落库。
   * 同一标的 60 秒内只允许一次网络请求，防止用户连续点击造成请求风暴。
   */
  async function getIntraday(code, { date, force = false, market } = {}) {
    const local = readIntraday(code, { date });
    const target = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : local.tradeDate;
    const needed =
      force ||
      !local.available ||
      (target && !local.dates.includes(target)) ||
      (target === tradeDateOf() && !local.isClosed && local.bars.length < FULL_DAY_POINTS);

    if (!needed) return local;

    const recent = state.lastFetchByCode.get(code) ?? 0;
    if (!force && Date.now() - recent < 60_000) return local;

    const resolvedMarket = resolveMarket(code, market);
    try {
      const fetched = await serial(() => fetchIntradayTrends(code, resolvedMarket, { days: config.intradayDays }));
      if (fetched.rows.length === 0) {
        return { ...local, note: `${local.note}（上游暂无该标的分钟数据）` };
      }
      const now = Date.now();
      // 数据源返回的是纯行情行，落库前补上标的代码
      const prepared = assignPreClose(fetched.rows, fetched.preClose, {
        dayHigh: fetched.dayHigh,
        dayLow: fetched.dayLow,
      }).map((row) => ({ ...row, code }));
      const changed = withTransaction(db, () => intradayRepo.upsertMany(prepared, now));
      state.lastFetchByCode.set(code, now);
      state.fetchedCodes += 1;
      log.info('分时行情已回填', {
        code,
        days: [...new Set(fetched.rows.map((row) => row.tradeDate))].length,
        points: fetched.rows.length,
        changed,
      });
      return { ...readIntraday(code, { date }), cached: false, fetchedAt: now };
    } catch (error) {
      state.lastError = { at: Date.now(), code, message: error.message };
      // 失败也进入节流窗口，避免用户连续点击放大上游压力
      state.lastFetchByCode.set(code, Date.now());
      log.warn('分时行情拉取失败', { code, message: error.message });
      return {
        ...local,
        cached: true,
        note: error instanceof Error && error.code === 'upstream_unavailable' ? `${local.note}（上游暂不可用）` : local.note,
      };
    }
  }

  /**
   * 盘中实时刷新：轮转拉取监控池的当日分钟数据并增量落库，供量能突变扫描使用。
   *
   * 三个约束：
   * 1. 只在连续竞价/收盘竞价阶段执行——其余时段上游返回的仍是上一交易日的完整数据；
   * 2. 单轮限量 + 游标轮转：标的数多于单轮上限时按轮次覆盖，不会拖住调度循环；
   * 3. 只写「已落库最后一分钟 - 1」之后的行：分钟量由累计量差分得到，
   *    重取最近一分钟可拿到该分钟的最终值（首次取到时该分钟往往还没走完）。
   */
  async function refreshLive({ limit = 40 } = {}) {
    const phase = marketPhase();
    if (phase !== 'trading' && phase !== 'closing') return { ok: false, reason: 'not-trading', phase };
    if (state.busyLive) return { ok: false, reason: 'busy' };
    if (limit <= 0) return { ok: false, reason: 'disabled' };
    if (isBreakerOpen('tencent')) return { ok: false, reason: 'circuit_open' };

    state.busyLive = true;
    const started = Date.now();
    let fetched = 0;
    let failed = 0;
    let points = 0;

    try {
      const pool = etfRepo.listTracked();
      if (pool.length === 0) return { ok: true, fetched: 0, failed: 0, points: 0, phase };

      const start = state.liveCursor % pool.length;
      const ordered = [...pool.slice(start), ...pool.slice(0, start)].slice(0, Math.min(limit, pool.length));

      for (const etf of ordered) {
        if (isBreakerOpen('tencent')) break;
        try {
          const market = resolveMarket(etf.code, etf.market);
          const quote = await serialLive(() => fetchMinuteToday(etf.code, market));
          if (quote.rows.length === 0) {
            failed += 1;
            continue;
          }

          const prepared = assignPreClose(quote.rows, quote.preClose, {
            dayHigh: quote.dayHigh,
            dayLow: quote.dayLow,
          }).map((row) => ({ ...row, code: etf.code }));

          const tradeDate = prepared[0].tradeDate;
          const lastMinute = intradayRepo.lastMinute(etf.code, tradeDate);
          let rows = prepared;
          if (lastMinute) {
            const index = prepared.findIndex((row) => row.minute === lastMinute);
            // 找不到说明本地最后分钟已不在上游序列里（跨日/缺口），整段重写更安全
            if (index > 1) rows = prepared.slice(index - 1);
          }

          withTransaction(db, () => intradayRepo.upsertMany(rows, Date.now()));
          state.lastFetchByCode.set(etf.code, Date.now());
          points += rows.length;
          fetched += 1;
        } catch (error) {
          failed += 1;
          state.lastError = { at: Date.now(), code: etf.code, message: error.message };
        }
      }

      state.liveCursor = (start + ordered.length) % pool.length;
      state.lastLiveAt = Date.now();
      state.liveFetched += fetched;
      state.liveFailed += failed;

      if (fetched > 0) {
        log.info('盘中分时刷新完成', {
          fetched,
          failed,
          points,
          cursor: state.liveCursor,
          durationMs: Date.now() - started,
        });
      }
      return { ok: true, fetched, failed, points, phase, cursor: state.liveCursor };
    } finally {
      state.busyLive = false;
    }
  }

  /**
   * 收盘后批量回填监控池的最后交易日分时。
   * 只补「还没有最新交易日数据」的标的，因此重复调用是廉价的。
   */
  async function backfillTracked({ limit = config.intradayBackfillLimit, force = false } = {}) {
    if (state.busy) return { ok: false, reason: 'busy' };
    state.busy = true;
    const started = Date.now();
    try {
      const tradeDate = flowRepo.latestTradeDate() ?? tradeDateOf();
      const tracked = etfRepo.listTracked();
      // 主源熔断时改用备源（腾讯只提供最后交易日），否则分时回填会完全停摆 ——
      // 而分时是量能突变预警的唯一输入，停摆意味着整个预警功能失效。
      if (isBreakerOpen('history') && isBreakerOpen('tencent')) {
        log.warn('分时主备源均不可用，跳过本轮回填', { tradeDate });
        return { ok: false, reason: 'circuit_open', tradeDate };
      }
      let done = 0;
      let skipped = 0;
      let failed = 0;
      let points = 0;
      let attempts = 0;

      for (const etf of tracked) {
        if (done >= limit || attempts >= limit * 2) break;
        if (isBreakerOpen('history') && isBreakerOpen('tencent')) break;
        const existing = intradayRepo.countOf(etf.code, tradeDate);
        if (!force && existing >= FULL_DAY_POINTS) {
          skipped += 1;
          continue;
        }
        try {
          attempts += 1;
          const market = resolveMarket(etf.code, etf.market);
          const viaFallback = isBreakerOpen('history');
          const fetched = viaFallback
            ? await serialLive(() => fetchMinuteToday(etf.code, market))
            : await serial(() => fetchIntradayTrends(etf.code, market, { days: config.intradayDays }));
          if (fetched.rows.length > 0) {
            // 备源只有最后交易日：拿不到目标交易日就跳过，避免把今天的数据写进昨天的日期
            if (viaFallback && fetched.rows[0].tradeDate !== tradeDate) {
              skipped += 1;
              continue;
            }
            const prepared = assignPreClose(fetched.rows, fetched.preClose, {
              dayHigh: fetched.dayHigh,
              dayLow: fetched.dayLow,
            }).map((row) => ({ ...row, code: etf.code }));
            withTransaction(db, () => intradayRepo.upsertMany(prepared, Date.now()));
            points += fetched.rows.length;
            done += 1;
            state.lastFetchByCode.set(etf.code, Date.now());
          } else {
            skipped += 1;
          }
        } catch (error) {
          failed += 1;
          state.lastError = { at: Date.now(), code: etf.code, message: error.message };
          if (isBreakerOpen('history') && isBreakerOpen('tencent')) break;
        }
      }

      state.lastBackfillAt = Date.now();
      state.lastBackfillDate = tradeDate;
      log.info('分时行情批量回填完成', {
        tradeDate,
        fetched: done,
        skipped,
        failed,
        points,
        durationMs: Date.now() - started,
      });
      return { ok: true, tradeDate, fetched: done, skipped, failed, points, durationMs: Date.now() - started };
    } catch (error) {
      state.lastError = { at: Date.now(), message: error.message };
      log.error('分时行情批量回填失败', { message: error.message });
      return { ok: false, error };
    } finally {
      state.busy = false;
    }
  }

  function prune() {
    const keepDays = Math.max(3, config.intradayDays + 2);
    const cutoff = new Date(Date.now() - keepDays * 86400 * 1000).toISOString().slice(0, 10);
    const removed = intradayRepo.pruneBefore(cutoff);
    if (removed > 0) log.info('清理过期分时数据', { removed, cutoff });
    return removed;
  }

  function getStatus() {
    return {
      lastBackfillAt: state.lastBackfillAt,
      lastBackfillDate: state.lastBackfillDate,
      busy: state.busy,
      lastError: state.lastError,
      fetchedCodes: state.fetchedCodes,
      live: {
        lastAt: state.lastLiveAt,
        fetched: state.liveFetched,
        failed: state.liveFailed,
        busy: state.busyLive,
      },
    };
  }

  return { getIntraday, readIntraday, refreshLive, backfillTracked, prune, getStatus, resolveMarket };
}
