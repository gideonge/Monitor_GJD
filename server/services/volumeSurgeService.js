import { config } from '../config/index.js';
import { beijingTs, marketPhase, tradeDateOf } from '../lib/time.js';
import { detectVolumeSurge } from './volumeSurge.js';
import { matchesScope, persistSurgeAlerts, severityForLevel } from './alertService.js';

/**
 * 量能突变预警服务：把纯检测函数接到告警链路上。
 *
 * 分工：
 *   volumeSurge.js        纯算法，输入分钟序列输出事件（无副作用，可回测）
 *   volumeSurgeService.js 取数、按规则过滤、分级、去重落库、状态上报
 *
 * 为什么不复用资金流的 evaluateRules：
 *   资金流指标是「某时刻某个值越过阈值」，而量能突变是「一段序列里的一个形态」，
 *   指标值本身不独立存在（倍数依赖当时的局部基线）。硬塞进指标框架会让
 *   metricsFor 需要额外拿整日分钟序列，反而把规则引擎的纯函数性质破坏掉。
 *   因此这里单独取数，但复用同一套告警落库、去重、冷却与 SSE 广播。
 */

/** 允许「实时」判定的市场阶段：连续竞价与收盘竞价 */
const LIVE_PHASES = new Set(['trading', 'closing']);

/** 分钟点数少于此值的标的直接跳过：开盘头 20 分钟没有可用基线 */
const MIN_BARS = 30;

/** 超过这个时长的事件不再补录，避免换设备/重建库时倒灌几天历史 */
const MAX_BACKFILL_AGE_MS = 3 * 86400 * 1000;

export function createVolumeSurgeService({ repos, events, logger, options = {} }) {
  const { etfRepo, intradayRepo, flowRepo, ruleRepo, alertRepo } = repos;
  const log = logger.child({ module: 'surge' });
  // 允许注入参数覆盖：单测与回放需要固定门槛，线上仍用 config（环境变量可调）
  const vs = { ...config.volumeSurge, ...(options.volumeSurge ?? {}) };

  const state = {
    lastScanAt: 0,
    lastAlertAt: 0,
    scanned: 0,
    detected: 0,
    alerted: 0,
    lastError: null,
    busy: false,
    lastResult: null,
  };

  /** 只把真正影响检测结果的参数暴露给前端，附在事件里便于回溯当时的判定口径 */
  function publicParams() {
    return {
      baselineWindow: 20,
      requireRangeBreak: vs.requireRangeBreak,
      minAmount: vs.minAmount,
      minAlertLevel: vs.minAlertLevel,
      backfillMinLevel: vs.backfillMinLevel,
      liveWindowSec: vs.liveWindowSec,
    };
  }

  function detectorParams() {
    return { requireRangeBreak: vs.requireRangeBreak, minAmount: vs.minAmount };
  }

  /**
   * 对某只标的某交易日做解释性检测：供分时图标注与历史回溯使用。
   * 与告警无关（不落库、不推送），因此不受告警等级门槛限制，弱信号也会返回。
   */
  function explain(code, tradeDate, rows) {
    const bars = rows ?? (tradeDate ? intradayRepo.series(code, tradeDate) : []);
    if (!Array.isArray(bars) || bars.length === 0) {
      return { tradeDate: tradeDate ?? null, params: publicParams(), stats: null, events: [] };
    }

    const { events: found, stats } = detectVolumeSurge(bars, detectorParams());
    return {
      tradeDate,
      params: publicParams(),
      stats: {
        tradableBars: stats.tradableBars,
        dayMedian: stats.dayMedian,
        eventCount: stats.eventCount,
        surgeCount: stats.surgeCount,
        drainCount: stats.drainCount,
      },
      events: found.map((event) => ({
        minute: event.minute,
        ts: Number(bars[event.index]?.ts) || beijingTs(tradeDate, event.minute),
        direction: event.direction,
        level: event.level,
        levelLabel: event.levelLabel,
        ratio: event.ratio,
        baseline: event.baseline,
        volume: event.volume,
        price: event.price,
        tickRet: event.tickRet,
        volumeShare: event.volumeShare,
      })),
    };
  }

  function resolveTradeDate(etf, { liveSession, today, latestTradeDate }) {
    const preferred = liveSession ? today : latestTradeDate ?? today;
    if (intradayRepo.countOf(etf.code, preferred) >= MIN_BARS) {
      return { tradeDate: preferred, bars: intradayRepo.series(etf.code, preferred) };
    }
    // 盘中新标的可能还没有今日分时（首次覆盖），回落到它自己最近有数据的那天
    const fallbackDate = intradayRepo.latestDate(etf.code);
    if (!fallbackDate || fallbackDate === preferred) return null;
    const bars = intradayRepo.series(etf.code, fallbackDate);
    if (bars.length < MIN_BARS) return null;
    return { tradeDate: fallbackDate, bars };
  }

  /**
   * 扫描监控池并落库告警。
   *
   * 入库门槛按「事件是否新鲜」分两档：
   *   - 事件发生在 liveWindowSec 内 → 视为实时，按规则等级入库（默认中等级以上）
   *   - 其余（收盘后回放、盘中启动时补历史）→ 只留强信号
   * 这样做是因为一天 120 只标的会产生约 300 条原始事件，全量入库会把告警页淹没；
   * 弱信号仍然可以在分时图上看到（explain 不受门槛限制）。
   */
  async function scan({ now = Date.now() } = {}) {
    if (!vs.enabled) return { ok: true, skipped: 'disabled' };
    if (state.busy) return { ok: false, reason: 'busy' };

    const rules = ruleRepo.list({ enabledOnly: true }).filter((rule) => rule.metric === 'volume_surge');
    if (rules.length === 0) return { ok: true, skipped: 'no-rule' };

    state.busy = true;
    const started = Date.now();
    const phase = marketPhase(now);
    const liveSession = LIVE_PHASES.has(phase);
    const today = tradeDateOf(now);
    const latestTradeDate = flowRepo.latestTradeDate();
    const detector = detectorParams();

    let scanned = 0;
    let detected = 0;

    try {
      const tracked = etfRepo.listTracked();

      // 每只标的只检测一次，多条规则共用同一批事件，避免重复跑算法
      const perCode = [];
      for (const etf of tracked) {
        const resolved = resolveTradeDate(etf, { liveSession, today, latestTradeDate });
        if (!resolved) continue;
        const result = detectVolumeSurge(resolved.bars, detector);
        scanned += 1;
        detected += result.events.length;
        if (result.events.length === 0) continue;
        perCode.push({ etf, ...resolved, events: result.events });
      }

      const candidates = [];
      for (const rule of rules) {
        const ruleCandidates = [];
        for (const entry of perCode) {
          if (!matchesScope(rule, entry.etf)) continue;
          for (const event of entry.events) {
            const isSurge = rule.comparator === 'gt';
            if (isSurge) {
              if (event.direction !== 'surge' || event.ratio < rule.threshold) continue;
            } else if (rule.comparator === 'lt') {
              if (event.direction !== 'drain' || event.ratio > rule.threshold) continue;
            } else {
              continue;
            }

            const ts = Number(entry.bars[event.index]?.ts) || beijingTs(entry.tradeDate, event.minute);
            const ageMs = now - ts;
            if (ageMs < -60_000 || ageMs > MAX_BACKFILL_AGE_MS) continue;

            // 「实时」只按事件新鲜度判定：盘中重启补昨天的事件，同样不该即时推送
            const isLive = ageMs <= vs.liveWindowSec * 1000;
            const minLevel = isLive ? vs.minAlertLevel : vs.backfillMinLevel;
            if (event.level < minLevel) continue;

            ruleCandidates.push({
              rule,
              etf: entry.etf,
              tradeDate: entry.tradeDate,
              event: { ...event, ts },
              severity: severityForLevel(rule.severity, event.level),
              source: isLive ? 'live' : 'backfill',
            });
          }
        }

        // 同一规则单轮限量：按倍数降序，保证配额留给最强的信号
        ruleCandidates.sort((a, b) => b.event.ratio - a.event.ratio);
        candidates.push(...ruleCandidates.slice(0, config.alertMaxPerRulePerCycle));
      }

      const created = persistSurgeAlerts({
        candidates,
        alertRepo,
        events,
        logger: log,
        params: { baselineWindow: 20, requireRangeBreak: vs.requireRangeBreak },
        now,
      });

      state.lastScanAt = Date.now();
      state.scanned = scanned;
      state.detected = detected;
      state.alerted += created.length;
      if (created.length > 0) state.lastAlertAt = Date.now();
      state.lastResult = {
        phase,
        scanned,
        detected,
        alerts: created.length,
        durationMs: Date.now() - started,
        at: state.lastScanAt,
      };

      if (created.length > 0) {
        log.info('量能突变扫描完成', {
          phase,
          scanned,
          detected,
          alerts: created.length,
          durationMs: Date.now() - started,
        });
      }
      return { ok: true, ...state.lastResult };
    } catch (error) {
      state.lastError = { at: Date.now(), message: error.message };
      log.error('量能突变扫描失败', { err: error });
      return { ok: false, error };
    } finally {
      state.busy = false;
    }
  }

  function getStatus() {
    return {
      enabled: vs.enabled,
      lastScanAt: state.lastScanAt,
      lastAlertAt: state.lastAlertAt,
      scanned: state.scanned,
      detected: state.detected,
      alerted: state.alerted,
      busy: state.busy,
      lastError: state.lastError,
      lastResult: state.lastResult,
      params: publicParams(),
    };
  }

  return { scan, explain, getStatus };
}
