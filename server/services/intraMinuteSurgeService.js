import { config } from '../config/index.js';
import { marketPhase, tradeDateOf } from '../lib/time.js';
import { detectIntraMinuteBurst, DEFAULT_PARAMS } from './intraMinuteSurge.js';
import { matchesScope, persistPreburstAlerts, severityForLevel } from './alertService.js';

/**
 * 分钟内实时爆量服务：把 intraMinuteSurge 接到秒级通道与告警链路上。
 *
 * 三个通道现在是这样分工的：
 *   volumeSurgeService   全池 / 分钟 K 线收盘后 / 60 秒一轮        —— 定稿
 *   intraMinuteSurge     核心池 / 分钟进行中 / 2 秒一轮            —— 预警（本文件）
 *   tickImpulseService   核心池 / 15 秒桶主动净额 / 5 秒一轮        —— 方向
 *
 * 为什么不合并到 volumeSurge：取数方式完全不同（逐秒增量 vs 分钟 K 线），
 * 而且分钟 K 线在盘中本来就滞后一轮刷新，用它做「进行中」判定等于自欺欺人。
 *
 * 为什么判定频率是 2 秒而不是 1 秒：上游快照约 3 秒一次，1 秒扫只会读到重复点；
 * 2 秒既能在新点出现后立刻跟上，也避免每轮 15 只 × 600 点的重复分桶。
 */

const LIVE_PHASES = new Set(['trading', 'closing']);

/** 秒级点太少时不做判定（服务刚启动、缓冲还没攒起来） */
const MIN_POINTS = 60;

/** 判定窗口：内存环形缓冲默认 30 分钟，足够 20 分钟基线 + 余量 */
const WINDOW_SEC = 1800;

export function createIntraMinuteSurgeService({ repos, events, logger, fastTickService, options = {} }) {
  const { etfRepo, ruleRepo, alertRepo } = repos;
  const log = logger.child({ module: 'preburst' });
  const im = { ...config.intraMinute, ...(options.intraMinute ?? {}) };
  const phaseOf = options.marketPhase ?? marketPhase;

  const state = {
    lastScanAt: 0,
    lastAlertAt: 0,
    scans: 0,
    codes: 0,
    triggered: 0,
    alerted: 0,
    busy: false,
    lastError: null,
    lastResult: null,
  };

  /** code → 最近一次判定（供详情页秒级面板展示「正在放量」） */
  const live = new Map();
  /** 已落库的分钟，避免同一分钟内反复构造候选（dedupe_key 之外的第一道闸） */
  const alertedMinutes = new Set();

  const detectorParams = Object.freeze({
    baselineMinutes: im.baselineMinutes,
    minBaselineMinutes: im.minBaselineMinutes,
    curveQuantile: im.curveQuantile,
    minCurveMinutes: im.minCurveMinutes,
    curveMaxShare: im.curveMaxShare,
    ratioThreshold: im.ratioThreshold,
    level3Ratio: im.level3Ratio,
    strongAmount: im.strongAmount,
    minElapsedSec: im.minElapsedSec,
    minSamples: im.minSamples,
    minAmount: im.minAmount,
    watchRatio: im.watchRatio,
  });

  function publicParams() {
    return {
      ...detectorParams,
      scanIntervalMs: im.scanIntervalMs,
      minAlertLevel: im.minAlertLevel,
      alertMinAmount: im.alertMinAmount,
      liveWindowSec: im.liveWindowSec,
      windowSec: WINDOW_SEC,
    };
  }

  /**
   * 取某只标的的判定窗口。
   *
   * 盘中优先走内存缓冲（不查库）；但内存跨度不够一个完整基线窗口时（服务刚重启），
   * 必须把库内当天已经落盘的点补到前面——否则重启后要干等 20 分钟才能出结论，
   * 而这段时间恰好是用户最想看的时候。
   */
  function seriesFor(code) {
    if (!fastTickService) return [];
    const memory = fastTickService.memorySeries?.(code, { seconds: WINDOW_SEC }) ?? [];
    const needSec = (im.baselineMinutes + 2) * 60;
    const spanSec = memory.length >= 2 ? (memory[memory.length - 1].ts - memory[0].ts) / 1000 : 0;
    if (spanSec >= needSec) return memory;

    const stored = fastTickService.series?.(code, { seconds: WINDOW_SEC }) ?? [];
    if (stored.length === 0) return memory;
    const lastStoredTs = stored[stored.length - 1].ts;
    return [...stored, ...memory.filter((point) => point.ts > lastStoredTs)];
  }

  /** 去掉分桶明细，只保留可以过 JSON 与进 UI 的字段 */
  function slim(evaluation) {
    if (!evaluation) return null;
    const {
      buckets, gates, projectedAmount, projectedRatio, barAmount, progress, curveShare,
      baseline, baselineCount, curveSource, curveSamples, amount, net, netRatio, direction,
      minute, tradeDate, lastTs, startTs, elapsedSec, samples, level, stage, triggered,
      price, minuteOpen, minuteHigh, minuteLow, priceMovePct, reason, active,
    } = evaluation;
    return {
      active,
      stage,
      triggered,
      level,
      reason,
      tradeDate,
      minute,
      startTs,
      lastTs,
      elapsedSec,
      samples,
      amount,
      net,
      netRatio,
      direction,
      price,
      minuteOpen,
      minuteHigh,
      minuteLow,
      priceMovePct,
      baseline,
      baselineCount,
      curveShare,
      curveSource,
      curveSamples,
      projectedAmount,
      projectedRatio,
      barAmount,
      progress,
      gates,
    };
  }

  async function scan({ now = Date.now(), force = false } = {}) {
    if (!im.enabled) return { ok: true, skipped: 'disabled' };
    if (state.busy) return { ok: false, reason: 'busy' };
    if (!fastTickService) return { ok: true, skipped: 'no-fast-channel' };

    const phase = phaseOf(now);
    if (!force && !LIVE_PHASES.has(phase)) return { ok: true, skipped: 'phase', phase };

    const pool = fastTickService.poolCodes?.() ?? [];
    if (pool.length === 0) return { ok: true, skipped: 'empty_pool' };

    state.busy = true;
    const started = Date.now();
    try {
      const rules = ruleRepo.list({ enabledOnly: true }).filter((rule) => rule.metric === 'volume_preburst');
      const today = tradeDateOf(now);
      const candidates = [];
      let codes = 0;
      let triggered = 0;

      for (const code of pool) {
        const meta = etfRepo.get(code);
        if (!meta) continue;
        const points = seriesFor(code);
        if (points.length < MIN_POINTS) {
          live.delete(code);
          continue;
        }

        const evaluation = detectIntraMinuteBurst(points, detectorParams);
        codes += 1;
        const view = slim({ ...evaluation, active: evaluation.active });
        live.set(code, { ...view, capturedAt: Date.now() });

        if (!evaluation.active || !evaluation.triggered) continue;
        // 非当日（窗口跨日、服务刚启动读到昨天的残留）不推送
        if (evaluation.tradeDate !== today) continue;
        triggered += 1;

        const dedupeKey = `n:${evaluation.tradeDate}:${evaluation.minute}`;
        if (alertedMinutes.has(`${code}:${dedupeKey}`)) continue;

        const isLive = now - evaluation.lastTs <= im.liveWindowSec * 1000;
        const minLevel = isLive ? im.minAlertLevel : im.backfillMinLevel;
        if (evaluation.level < minLevel) continue;
        // 告警金额门槛：折算整分钟不到这个数的只亮灯不推送。
        // 判定门槛（minAmount）管的是「算不算在放量」，这里管的是「值不值得打扰」。
        if (!(evaluation.projectedAmount >= im.alertMinAmount)) continue;

        for (const rule of rules) {
          if (rule.comparator !== 'gt') continue; // 缩量口径不在这条通道里
          if (!matchesScope(rule, meta)) continue;
          if (!(evaluation.projectedRatio >= rule.threshold)) continue;

          candidates.push({
            rule,
            etf: meta,
            tradeDate: evaluation.tradeDate,
            evaluation,
            dedupeKey,
            severity: severityForLevel(rule.severity, evaluation.level),
            source: isLive ? 'live' : 'backfill',
          });
        }
      }

      // 单轮限量：折算倍数最高的先报，配额留给最猛的信号
      candidates.sort((a, b) => b.evaluation.projectedRatio - a.evaluation.projectedRatio);
      const limited = candidates.slice(0, im.maxPerCycle);
      const created = persistPreburstAlerts({
        candidates: limited,
        alertRepo,
        events,
        logger: log,
        params: publicParams(),
        now,
      });

      for (const candidate of limited) {
        alertedMinutes.add(`${candidate.etf.code}:${candidate.dedupeKey}`);
      }
      if (alertedMinutes.size > 500) {
        // 每天收盘后清一次，长期运行不会无限增长
        for (const key of alertedMinutes) {
          if (!key.includes(`:${today}:`)) alertedMinutes.delete(key);
        }
      }

      state.scans += 1;
      state.lastScanAt = Date.now();
      state.codes = codes;
      state.triggered = triggered;
      state.alerted += created.length;
      state.lastError = null;
      if (created.length > 0) state.lastAlertAt = state.lastScanAt;
      state.lastResult = {
        phase,
        codes,
        triggered,
        candidates: candidates.length,
        alerts: created.length,
        durationMs: Date.now() - started,
        at: state.lastScanAt,
      };

      if (created.length > 0) {
        log.info('分钟内实时爆量', {
          phase,
          codes,
          triggered,
          alerts: created.length,
          durationMs: Date.now() - started,
        });
      }
      return { ok: true, ...state.lastResult };
    } catch (error) {
      state.lastError = { at: Date.now(), message: error.message };
      log.error('分钟内实时爆量扫描失败', { err: error });
      return { ok: false, error: error.message };
    } finally {
      state.busy = false;
    }
  }

  /** 详情页用：最近一次判定的快照（不落库、不推送） */
  function liveFor(code) {
    return live.get(code) ?? null;
  }

  /** 指定窗口的即时判定：不依赖调度器，供接口按需计算 */
  function explain(code, { points } = {}) {
    const rows = points ?? seriesFor(code);
    if (!Array.isArray(rows) || rows.length === 0) {
      return { code, params: publicParams(), evaluation: null };
    }
    return { code, params: publicParams(), evaluation: slim(detectIntraMinuteBurst(rows, detectorParams)) };
  }

  function getStatus() {
    return {
      enabled: im.enabled,
      scanIntervalMs: im.scanIntervalMs,
      lastScanAt: state.lastScanAt,
      lastAlertAt: state.lastAlertAt,
      scans: state.scans,
      codes: state.codes,
      triggered: state.triggered,
      alerted: state.alerted,
      busy: state.busy,
      lastError: state.lastError,
      lastResult: state.lastResult,
      live: [...live.entries()].map(([code, view]) => ({
        code,
        minute: view.minute,
        stage: view.stage,
        projectedRatio: view.projectedRatio,
        elapsedSec: view.elapsedSec,
        capturedAt: view.capturedAt,
      })),
      params: publicParams(),
    };
  }

  return { scan, explain, liveFor, getStatus, publicParams, DEFAULT_PARAMS };
}
