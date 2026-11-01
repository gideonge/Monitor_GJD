import { config, FAST_FAMILY_OF } from '../config/index.js';
import { marketPhase, tradeDateOf } from '../lib/time.js';
import { detectTickImpulse, aggregateResonance } from './tickImpulse.js';
import { matchesScope, persistTickImpulseAlerts, severityForLevel } from './alertService.js';

/**
 * 秒级攻势预警服务：把 tickImpulse 纯算法接到告警链路上。
 *
 * 与 volumeSurgeService 的分工：
 *   volumeSurgeService   全池 120 只 / 分钟粒度 / 每 60 秒扫一次
 *   tickImpulseService   核心池 15 只 / 15 秒桶 / 每 5 秒扫一次
 *
 * 之所以不复用同一个服务：两者的取数方式（分钟线 vs 秒级流）、判定形态
 * （单根 K 线越线 vs 连续桶 + 跨标的共振）、去重粒度（分钟 vs 波次起点）都不同，
 * 合并会让两边的参数互相污染。共用的只有落库、冷却、SSE 广播这三段。
 */

/** 允许实时判定的市场阶段 */
const LIVE_PHASES = new Set(['trading', 'closing']);

/** 补录上限：超过这个时长的事件不再入库，避免换设备时倒灌几天历史 */
const MAX_BACKFILL_AGE_MS = 3 * 86400 * 1000;

/** 内存点太少（服务刚启动、缓冲还没攒起来）时的回落阈值 */
const MIN_MEMORY_POINTS = 40;

export function createTickImpulseService({ repos, events, logger, fastTickService, options = {} }) {
  const { etfRepo, ruleRepo, alertRepo } = repos;
  const log = logger.child({ module: 'impulse' });
  const ti = { ...config.tickImpulse, ...(options.tickImpulse ?? {}) };
  const families = options.families ?? FAST_FAMILY_OF;
  const phaseOf = options.marketPhase ?? marketPhase;

  const state = {
    lastScanAt: 0,
    lastAlertAt: 0,
    scans: 0,
    scannedCodes: 0,
    episodes: 0,
    resonances: 0,
    alerted: 0,
    busy: false,
    lastError: null,
    lastResult: null,
  };

  /** 已告警波次：`${ruleId}:${code}` → { startTs, endTs, direction }，用于识别「同一波在长」 */
  const alertedWaves = new Map();

  const detectorParams = Object.freeze({
    bucketSec: ti.bucketSec,
    baselineBuckets: ti.baselineBuckets,
    minBaselineBuckets: ti.minBaselineBuckets,
    minSamplesPerBucket: ti.minSamplesPerBucket,
    netRatioThreshold: ti.netRatioThreshold,
    minNetAmount: ti.minNetAmount,
    minBuyShare: ti.minBuyShare,
    zThreshold: ti.zThreshold,
    confirmBuckets: ti.confirmBuckets,
    mergeGapSec: ti.mergeGapSec,
    detectDrain: ti.detectDrain,
    levelPriceMovePct: ti.levelPriceMovePct,
  });

  function publicParams() {
    return { ...detectorParams, minAlertLevel: ti.minAlertLevel, liveWindowSec: ti.liveWindowSec };
  }

  /**
   * 取某只标的的判定窗口。
   * 盘中优先用内存缓冲（不查库），内存不足时回落到库内序列（服务重启后的首个窗口）。
   */
  function seriesFor(code) {
    if (!fastTickService) return [];
    const memory = fastTickService.memorySeries?.(code, { seconds: ti.windowSec }) ?? [];
    if (memory.length >= MIN_MEMORY_POINTS) return memory;
    const stored = fastTickService.series(code, { seconds: ti.windowSec }) ?? [];
    return stored.length > memory.length ? stored : memory;
  }

  function familyOf(code) {
    return families[code] ?? '其他';
  }

  /** 在共振结果里找到覆盖该波次的条目（同方向、起点在窗口内、包含本标的） */
  function resonanceFor(resonances, code, episode) {
    for (const item of resonances) {
      if (item.direction !== episode.direction) continue;
      if (!item.codes.includes(code)) continue;
      if (Math.abs(item.ts - episode.startTs) > ti.resonanceWindowSec * 1000) continue;
      return item;
    }
    return null;
  }

  /**
   * 扫描核心池并落库告警。
   *
   * @param {{now?:number, force?:boolean}} opts force 用于收盘后回放（忽略交易时段限制）
   */
  async function scan({ now = Date.now(), force = false } = {}) {
    if (!ti.enabled) return { ok: true, skipped: 'disabled' };
    if (state.busy) return { ok: false, reason: 'busy' };
    if (!fastTickService) return { ok: true, skipped: 'no-fast-channel' };

    const phase = phaseOf(now);
    if (!force && !LIVE_PHASES.has(phase)) return { ok: true, skipped: 'phase', phase };

    const pool = fastTickService.poolCodes?.() ?? [];
    if (pool.length === 0) return { ok: true, skipped: 'empty_pool' };

    state.busy = true;
    const started = Date.now();
    try {
      const entries = [];
      let scannedCodes = 0;
      let episodeCount = 0;

      for (const code of pool) {
        const meta = etfRepo.get(code);
        if (!meta) continue;
        const points = seriesFor(code);
        if (points.length === 0) continue;
        const result = detectTickImpulse(points, detectorParams);
        scannedCodes += 1;
        episodeCount += result.episodes.length;
        for (const episode of result.episodes) {
          entries.push({ code, name: meta.name, category: meta.category, family: familyOf(code), episode });
        }
      }

      const resonances = aggregateResonance(entries, {
        windowSec: ti.resonanceWindowSec,
        minCodes: 2,
        minFamilies: ti.resonanceMinFamilies,
        requireCrossFamily: ti.resonanceMinFamilies > 1,
      });

      const rules = ruleRepo.list({ enabledOnly: true }).filter((rule) => rule.metric === 'tick_impulse');
      const candidates = [];

      for (const rule of rules) {
        for (const entry of entries) {
          if (!matchesScope(rule, entry)) continue;
          const { episode } = entry;

          if (rule.comparator === 'gt') {
            if (episode.direction !== 'surge' || !(episode.sumNet >= rule.threshold)) continue;
          } else if (rule.comparator === 'lt') {
            if (episode.direction !== 'drain' || !(episode.sumNet <= rule.threshold)) continue;
          } else {
            continue;
          }

          const ageMs = now - episode.endTs;
          if (ageMs < -120_000 || ageMs > MAX_BACKFILL_AGE_MS) continue;

          const isLive = now - episode.endTs <= ti.liveWindowSec * 1000;
          const minLevel = isLive ? ti.minAlertLevel : ti.backfillMinLevel;

          const resonance = resonanceFor(resonances, entry.code, episode);
          // 共振直接抬等级：跨族 2 族升一级，3 族及以上直接封顶
          const boost = resonance ? Math.max(0, resonance.level - 1) : 0;
          const effectiveLevel = Math.min(3, episode.level + boost);
          if (effectiveLevel < minLevel) continue;

          const waveKey = `${rule.id}:${entry.code}`;
          const prevWave = alertedWaves.get(waveKey);
          const sameWave =
            prevWave &&
            prevWave.direction === episode.direction &&
            episode.startTs <= prevWave.endTs &&
            episode.endTs >= prevWave.startTs;
          if (sameWave) {
            prevWave.endTs = Math.max(prevWave.endTs, episode.endTs);
            continue;
          }

          candidates.push({
            rule,
            etf: entry,
            tradeDate: tradeDateOf(episode.startTs),
            episode: { ...episode, level: effectiveLevel },
            severity: severityForLevel(rule.severity, effectiveLevel),
            source: isLive ? 'live' : 'backfill',
            resonance,
          });
        }
      }

      // 单规则单轮限量：按累计净额降序，配额留给最重的信号
      const grouped = new Map();
      for (const candidate of candidates) {
        const list = grouped.get(candidate.rule.id) ?? [];
        list.push(candidate);
        grouped.set(candidate.rule.id, list);
      }
      const limited = [];
      for (const list of grouped.values()) {
        list.sort((a, b) => Math.abs(b.episode.sumNet) - Math.abs(a.episode.sumNet));
        limited.push(...list.slice(0, config.alertMaxPerRulePerCycle));
      }

      const created = persistTickImpulseAlerts({
        candidates: limited,
        alertRepo,
        events,
        logger: log,
        params: publicParams(),
        now,
      });

      // 记录本波已告警，后续扫描里同波增长不再出条
      for (const candidate of limited) {
        const waveKey = `${candidate.rule.id}:${candidate.etf.code}`;
        alertedWaves.set(waveKey, {
          startTs: candidate.episode.startTs,
          endTs: candidate.episode.endTs,
          direction: candidate.episode.direction,
        });
      }
      if (alertedWaves.size > 200) {
        // 只保留当日的波次记录，避免长期运行后无限增长
        const today = tradeDateOf(now);
        for (const [key, wave] of alertedWaves) {
          if (tradeDateOf(wave.startTs) !== today) alertedWaves.delete(key);
        }
      }

      state.scans += 1;
      state.lastScanAt = Date.now();
      state.scannedCodes = scannedCodes;
      state.episodes = episodeCount;
      state.resonances = resonances.length;
      state.alerted += created.length;
      state.lastError = null;
      if (created.length > 0) state.lastAlertAt = state.lastScanAt;
      state.lastResult = {
        phase,
        codes: scannedCodes,
        episodes: episodeCount,
        resonances: resonances.length,
        alerts: created.length,
        durationMs: Date.now() - started,
        at: state.lastScanAt,
      };

      if (created.length > 0) {
        log.info('秒级攻势扫描完成', {
          phase,
          codes: scannedCodes,
          episodes: episodeCount,
          resonances: resonances.length,
          alerts: created.length,
          durationMs: Date.now() - started,
        });
      }
      return { ok: true, ...state.lastResult };
    } catch (error) {
      state.lastError = { at: Date.now(), message: error.message };
      log.error('秒级攻势扫描失败', { err: error });
      return { ok: false, error: error.message };
    } finally {
      state.busy = false;
    }
  }

  /** 解释某个标的当前窗口的判定结果（不落库、不推送），供接口与回放使用 */
  function explain(code, { seconds = ti.windowSec, points } = {}) {
    const rows = points ?? seriesFor(code);
    if (!Array.isArray(rows) || rows.length === 0) {
      return { code, params: publicParams(), stats: null, episodes: [], events: [] };
    }
    const result = detectTickImpulse(rows, detectorParams);
    return {
      code,
      family: familyOf(code),
      params: publicParams(),
      stats: result.stats,
      episodes: result.episodes.map((episode) => ({
        startTs: episode.startTs,
        endTs: episode.endTs,
        direction: episode.direction,
        durationSec: episode.durationSec,
        buckets: episode.buckets,
        sumNet: episode.sumNet,
        peakNet: episode.peakNet,
        buyShare: episode.buyShare,
        level: episode.level,
        priceMove: episode.priceMove,
      })),
      events: result.events,
    };
  }

  function getStatus() {
    return {
      enabled: ti.enabled,
      scanIntervalMs: ti.scanIntervalMs,
      bucketSec: ti.bucketSec,
      lastScanAt: state.lastScanAt,
      scans: state.scans,
      codes: state.scannedCodes,
      episodes: state.episodes,
      resonances: state.resonances,
      alerted: state.alerted,
      lastAlertAt: state.lastAlertAt,
      busy: state.busy,
      lastError: state.lastError,
      lastResult: state.lastResult,
      params: publicParams(),
    };
  }

  return { scan, explain, getStatus, publicParams };
}
