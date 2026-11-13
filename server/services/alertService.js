import { METRICS, COMPARATOR_LABEL } from '../repositories/ruleRepo.js';
import { formatAmount, formatDateTime, formatHms, formatPct } from '../lib/format.js';
import { tradeDateCloseTs } from '../lib/time.js';
import { computeWindowMetrics, computeDailyMetrics } from './metricService.js';
import { EVENTS } from './events.js';

const TIMEFRAME_PREFIX = {
  window: (rule) => `${Math.round((rule.windowSec ?? rule.window_sec ?? 300) / 60)}分钟窗口期`,
  intraday: () => '当日累计',
  daily: () => '当日',
};

export function formatMetric(metric, value, { signed = true } = {}) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  if (metric === 'main_net_ratio') return `${Number(value).toFixed(2)}%`;
  if (metric === 'main_net_rate') return `${formatAmount(value, { sign: signed })}/分钟`;
  if (metric === 'volume_surge' || metric === 'volume_preburst') return `${Number(value).toFixed(2)}×`;
  return formatAmount(value, { sign: signed });
}

/** 手数单位格式化（分钟成交量口径） */
export function formatHands(hands) {
  if (hands === null || hands === undefined || Number.isNaN(Number(hands))) return '—';
  const value = Number(hands);
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)} 亿手`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(1)} 万手`;
  return `${Math.round(value)} 手`;
}

/**
 * 强度等级 → 告警级别的阶梯。
 * 规则里配的级别是「最强信号」用的级别，中/弱信号自动降档：
 * 这样用户只需要关心「这条规则最严重时算几级」，不必为每个等级各建一条规则。
 */
const LEVEL_SEVERITY = {
  high: { 3: 'high', 2: 'medium', 1: 'low' },
  medium: { 3: 'medium', 2: 'low', 1: 'low' },
  low: { 3: 'low', 2: 'low', 1: 'low' },
};

export function severityForLevel(baseSeverity, level) {
  const ladder = LEVEL_SEVERITY[baseSeverity] ?? LEVEL_SEVERITY.medium;
  return ladder[Math.min(3, Math.max(1, Number(level) || 1))];
}

export function buildConditionText(rule) {
  const metricLabel = METRICS[rule.metric]?.label ?? rule.metric;
  const prefix = TIMEFRAME_PREFIX[rule.timeframe]?.(rule) ?? '';
  const comparator = COMPARATOR_LABEL[rule.comparator] ?? rule.comparator;
  return `${prefix}${metricLabel} ${comparator} ${formatMetric(rule.metric, rule.threshold, { signed: false })}`;
}

function parseScopeValue(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function matchesScope(rule, etf) {
  if (rule.scope === 'category') {
    return parseScopeValue(rule.scopeValue ?? rule.scope_value).includes(etf.category);
  }
  if (rule.scope === 'codes') {
    return parseScopeValue(rule.scopeValue ?? rule.scope_value).includes(etf.code);
  }
  return true;
}

export function compare(value, comparator, threshold) {
  if (comparator === 'gt') return value > threshold;
  if (comparator === 'lt') return value < threshold;
  return false;
}

function metricsFor(rule, entry, now) {
  if (rule.timeframe === 'daily') {
    return computeDailyMetrics(entry.daily, entry.prevDaily);
  }
  return computeWindowMetrics(entry.points, { windowSec: rule.windowSec ?? rule.window_sec ?? 300, now });
}

function dedupeKeyFor(rule, entry, now) {
  const tradeDate = entry.daily?.trade_date ?? entry.tradeDate ?? 'unknown';
  if (rule.timeframe === 'daily') return `d:${tradeDate}`;
  if (rule.timeframe === 'intraday') return `i:${tradeDate}`;
  const bucket = Math.floor(now / ((rule.windowSec ?? rule.window_sec ?? 300) * 1000));
  return `w:${tradeDate}:${bucket}`;
}

function triggeredAtFor(rule, entry, now) {
  if (rule.timeframe === 'daily' && entry.daily?.trade_date) {
    return tradeDateCloseTs(entry.daily.trade_date);
  }
  return now;
}

/**
 * 阈值判定核心：纯函数式遍历规则 × ETF，产出候选告警后统一排序、
 * 冷却过滤与去重写库。返回值用于测试与统计。
 */
export function evaluateRules({ rules, entries, now = Date.now(), maxPerRule = 60 }) {
  const results = [];

  for (const rule of rules) {
    if (rule.enabled === 0 || rule.enabled === false) continue;
    if (!METRICS[rule.metric]) continue;

    const candidates = [];

    for (const entry of entries) {
      if (!entry.etf) continue;
      if (!matchesScope(rule, entry.etf)) continue;

      const metrics = metricsFor(rule, entry, now);
      if (!metrics) continue;

      const value = metrics[rule.metric];
      if (value === null || value === undefined || Number.isNaN(Number(value))) continue;
      if (!compare(value, rule.comparator, rule.threshold)) continue;

      // 窗口指标样本不足时不做判定，避免单点数据造成误报
      if (rule.timeframe === 'window' && (metrics.spanSec ?? 0) < Math.min(60, (rule.windowSec ?? 300) / 2)) continue;

      candidates.push({ entry, metrics, value, rule });
    }

    candidates.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    for (const candidate of candidates.slice(0, maxPerRule)) {
      results.push({
        rule,
        entry: candidate.entry,
        metrics: candidate.metrics,
        value: candidate.value,
        dedupeKey: dedupeKeyFor(rule, candidate.entry, now),
        triggeredAt: triggeredAtFor(rule, candidate.entry, now),
      });
    }
  }

  return results;
}

/**
 * 落库并广播。冷却期内（同规则同 ETF）不再重复告警；
 * dedupe_key 保证同一交易日/同一窗口内天然幂等。
 */
export function persistAlerts({ candidates, alertRepo, events, logger, source = 'live', now = Date.now() }) {
  const created = [];

  for (const candidate of candidates) {
    const { rule, entry, metrics, value } = candidate;
    const cooldownMs = (rule.cooldownSec ?? rule.cooldown_sec ?? 1800) * 1000;
    const last = alertRepo.lastTriggeredAt(rule.id, entry.etf.code);
    if (last && candidate.triggeredAt - last < cooldownMs && candidate.triggeredAt >= last) continue;

    const conditionText = buildConditionText(rule);
    const valueText = `${METRICS[rule.metric].label} ${formatMetric(rule.metric, value)}`;
    const message = `${entry.etf.name}（${entry.etf.code}）${TIMEFRAME_PREFIX[rule.timeframe]?.(rule) ?? ''}${valueText}，触发条件：${conditionText}`;

    const id = alertRepo.insert({
      ruleId: rule.id,
      ruleName: rule.name,
      code: entry.etf.code,
      etfName: entry.etf.name,
      category: entry.etf.category,
      metric: rule.metric,
      timeframe: rule.timeframe,
      comparator: rule.comparator,
      threshold: rule.threshold,
      value,
      delta: metrics.main_net_delta ?? null,
      baseline: metrics.baselineAvg ?? null,
      windowSec: rule.windowSec ?? rule.window_sec ?? null,
      severity: rule.severity,
      conditionText,
      message,
      dedupeKey: candidate.dedupeKey,
      source,
      tradeDate: entry.daily?.trade_date ?? entry.tradeDate ?? null,
      triggeredAt: candidate.triggeredAt,
    });

    if (id === null) continue;

    const alert = {
      id,
      ruleId: rule.id,
      ruleName: rule.name,
      code: entry.etf.code,
      etfName: entry.etf.name,
      category: entry.etf.category,
      metric: rule.metric,
      timeframe: rule.timeframe,
      comparator: rule.comparator,
      threshold: rule.threshold,
      value,
      conditionText,
      message,
      severity: rule.severity,
      windowSec: rule.windowSec ?? rule.window_sec ?? null,
      triggeredAt: candidate.triggeredAt,
      triggeredAtText: formatDateTime(candidate.triggeredAt),
      source,
    };

    created.push(alert);
    events?.publish(EVENTS.ALERT, alert);
  }

  if (created.length > 0) {
    logger?.info('生成资金流告警', { count: created.length, source });
  }
  return created;
}

/**
 * 量能突变的触发条件文案。
 * 参数直接影响这条文案：关掉突破确认后，同样的阈值意味着完全不同的信噪比，
 * 所以必须在文案里显式写清楚，否则回溯告警时分不清当时用的是什么口径。
 */
export function buildSurgeConditionText(rule, { baselineWindow = 20, confirmMode = 'graded' } = {}) {
  const comparator = COMPARATOR_LABEL[rule.comparator] ?? rule.comparator;
  const suffix =
    confirmMode === 'break'
      ? `，需同向突破前 ${baselineWindow} 分钟极值`
      : confirmMode === 'off'
        ? '，不要求价格确认'
        : '，需价格确认（突破前 20 分钟极值 / 位移 / 收在极值侧）';
  return `分钟成交量 ${comparator} ${Number(rule.threshold).toFixed(2)}× 近 ${baselineWindow} 分钟基线${suffix}`;
}

/** 确认方式的文案：写成「突破前 20 分钟高点」必须是真的突破了，不能拿位移冒名顶替 */
const CONFIRM_TEXT = {
  break: '，突破前 20 分钟极值',
  touch: '，贴前 20 分钟极值报收',
  move: '，价格位移确认',
  edge: '，收在当分钟极值侧',
  none: '，区间内堆量（方向待确认）',
};

function buildSurgeMessage({ etf, event }) {
  const direction = event.direction === 'drain' ? '骤减' : '突变';
  const priceText =
    event.tickRet === null || event.tickRet === undefined
      ? '价格无位移'
      : `价格 ${event.tickRet >= 0 ? '+' : ''}${event.tickRet.toFixed(2)}%`;
  const confirmText = CONFIRM_TEXT[event.confirm] ?? '';
  const peakText = event.dayPeak ? '，当日成交额峰值' : '';
  const waveText =
    event.mergedBars > 1 ? `，本波 ${event.mergedBars} 根连续放量累计 ${formatAmount(event.sumAmount ?? 0)}` : '';
  return `${etf.name}（${etf.code}）${event.spanFrom ?? event.minute} 成交量${direction}至 ${event.ratio.toFixed(
    2,
  )}× 近 20 分钟基线（${formatHands(event.baseline)} → ${formatHands(event.volume)}），${priceText}${confirmText}${peakText}${waveText}`;
}

/**
 * 量能突变告警落库与广播。
 *
 * 与资金流告警的区别：dedupe_key 按「交易日 + 分钟」构造，同一分钟天然幂等，
 * 所以重复扫描（每次刷新分时都会重新检测整日）不会重复入库；
 * 冷却时间按规则的 cooldownSec 控制，避免同一波行情里逐分钟连续轰炸。
 */
export function persistSurgeAlerts({ candidates, alertRepo, events, logger, params = {}, now = Date.now() }) {
  const created = [];

  for (const candidate of candidates) {
    const { rule, etf, tradeDate, event, severity, source } = candidate;
    const cooldownMs = (rule.cooldownSec ?? rule.cooldown_sec ?? 300) * 1000;
    const last = alertRepo.lastTriggeredAt(rule.id, etf.code);
    if (last && event.ts - last < cooldownMs && event.ts >= last) continue;

    const conditionText = buildSurgeConditionText(rule, params);
    const message = buildSurgeMessage({ etf, event });
    // 量能倍数是「多大」，价格涨跌才是「向哪边」；后者落库供前端上色
    const priceMovePct = Number.isFinite(event.tickRet) ? event.tickRet : null;

    const id = alertRepo.insert({
      ruleId: rule.id,
      ruleName: rule.name,
      code: etf.code,
      etfName: etf.name,
      category: etf.category,
      metric: 'volume_surge',
      timeframe: 'intraday',
      comparator: rule.comparator,
      threshold: rule.threshold,
      value: event.ratio,
      delta: event.volume - event.baseline,
      baseline: event.baseline,
      windowSec: (params.baselineWindow ?? 20) * 60,
      severity,
      conditionText,
      message,
      dedupeKey: `v:${tradeDate}:${event.minute}`,
      source,
      tradeDate,
      triggeredAt: event.ts,
      priceMovePct,
    });
    if (id === null) continue;

    const alert = {
      id,
      ruleId: rule.id,
      ruleName: rule.name,
      code: etf.code,
      etfName: etf.name,
      category: etf.category,
      metric: 'volume_surge',
      timeframe: 'intraday',
      comparator: rule.comparator,
      threshold: rule.threshold,
      value: event.ratio,
      delta: event.volume - event.baseline,
      baseline: event.baseline,
      windowSec: (params.baselineWindow ?? 20) * 60,
      conditionText,
      message,
      severity,
      triggeredAt: event.ts,
      triggeredAtText: formatDateTime(event.ts),
      source,
      // 供前端标注分时图使用
      minute: event.minute,
      level: event.level,
      direction: event.direction,
      priceMovePct,
      tradeDate,
    };

    created.push(alert);
    events?.publish(EVENTS.ALERT, alert);
  }

  if (created.length > 0) {
    logger?.info('生成量能突变告警', { count: created.length });
  }
  return created;
}

/**
 * 秒级攻势的触发条件文案。
 * 桶宽、相对门槛、连续确认三项直接决定这条规则的实际严格度，必须写进文案，
 * 否则半年后回看告警，无法判断当时是「15 秒一桶、连续 2 桶」还是别的口径。
 */
export function buildTickImpulseConditionText(rule, params = {}) {
  const comparator = COMPARATOR_LABEL[rule.comparator] ?? rule.comparator;
  const bucketSec = params.bucketSec ?? 15;
  const ratio = params.netRatioThreshold ?? 0.8;
  const confirm = params.confirmBuckets ?? 2;
  return `单波累计主动${rule.comparator === 'lt' ? '净卖出' : '净买入'} ${comparator} ${formatAmount(
    rule.threshold,
    { sign: false },
  )}（${bucketSec} 秒桶，桶净额 ≥ 基线成交额的 ${(ratio * 100).toFixed(0)}%，连续 ${confirm} 桶）`;
}

function buildTickImpulseMessage({ etf, episode, params = {}, resonance = null }) {
  const isBuy = episode.direction === 'surge';
  const duration = Math.max(1, episode.durationSec ?? 0);
  const shareText =
    episode.buyShare === null || episode.buyShare === undefined
      ? ''
      : `，占同期成交额 ${(Math.abs(episode.buyShare) * 100).toFixed(0)}%`;
  const priceText = episode.priceMove === null || episode.priceMove === undefined ? '' : `，价格 ${formatPct(episode.priceMove)}`;
  const resonanceText = resonance
    ? `；同时段 ${resonance.families.join(' / ')} 共 ${resonance.codes.length} 只宽基共振`
    : '';

  return `${etf.name}（${etf.code}）${formatHms(episode.startTs)} 起 ${duration} 秒内主动${
    isBuy ? '买入' : '卖出'
  }攻势，累计净${isBuy ? '买入' : '卖出'} ${formatAmount(Math.abs(episode.sumNet), { sign: false })}（${
    episode.buckets
  } 桶，峰值 ${formatAmount(episode.peakNet, { sign: false })}/桶${shareText}）${priceText}${resonanceText}`;
}

/**
 * 秒级攻势告警落库与广播。
 *
 * 去重键用「一波攻势的起点秒」：同一波在后续每次扫描里都会被重新检出（窗口在滑动），
 * 但起点不变，因此 dedupe_key 天然幂等，一波只落一条。
 * 升级（中→强）不另建告警，避免同一波在告警页刷出多条。
 */
export function persistTickImpulseAlerts({ candidates, alertRepo, events, logger, params = {}, now = Date.now() }) {
  const created = [];

  for (const candidate of candidates) {
    const { rule, etf, tradeDate, episode, severity, source, resonance } = candidate;
    const cooldownMs = (rule.cooldownSec ?? rule.cooldown_sec ?? 240) * 1000;
    const last = alertRepo.lastTriggeredAt(rule.id, etf.code);
    if (last && episode.startTs - last < cooldownMs && episode.startTs >= last) continue;

    const conditionText = buildTickImpulseConditionText(rule, params);
    const message = buildTickImpulseMessage({ etf, episode, params, resonance });
    const buyShare = episode.buyShare ?? 0;

    const id = alertRepo.insert({
      ruleId: rule.id,
      ruleName: rule.name,
      code: etf.code,
      etfName: etf.name,
      category: etf.category,
      metric: 'tick_impulse',
      timeframe: 'intraday',
      comparator: rule.comparator,
      threshold: rule.threshold,
      value: episode.sumNet,
      delta: episode.peakNet,
      baseline: episode.peakEvent?.baselineAmt ?? null,
      windowSec: Math.max(1, episode.durationSec ?? 0),
      severity,
      conditionText,
      message,
      dedupeKey: `t:${tradeDate}:${Math.floor(episode.startTs / 1000)}`,
      source,
      tradeDate,
      triggeredAt: episode.startTs,
    });
    if (id === null) continue;

    const alert = {
      id,
      ruleId: rule.id,
      ruleName: rule.name,
      code: etf.code,
      etfName: etf.name,
      category: etf.category,
      metric: 'tick_impulse',
      timeframe: 'intraday',
      comparator: rule.comparator,
      threshold: rule.threshold,
      value: episode.sumNet,
      delta: episode.peakNet,
      baseline: episode.peakEvent?.baselineAmt ?? null,
      windowSec: Math.max(1, episode.durationSec ?? 0),
      conditionText,
      message,
      severity,
      triggeredAt: episode.startTs,
      triggeredAtText: formatDateTime(episode.startTs),
      source,
      // 供前端标注秒级图与筛选使用
      direction: episode.direction,
      level: episode.level,
      buckets: episode.buckets,
      peakNet: episode.peakNet,
      buyShare,
      resonanceCodes: resonance?.codes ?? [],
      resonanceFamilies: resonance?.families ?? [],
      tradeDate,
    };

    created.push(alert);
    events?.publish(EVENTS.ALERT, alert);
  }

  if (created.length > 0) {
    logger?.info('生成秒级攻势告警', { count: created.length });
  }
  return created;
}

/**
 * 分钟内实时爆量的触发条件文案。
 *
 * 这条规则的口径里，「分位」和「判定秒数」是外行最容易误读的两项：
 * 同样是「2 倍」，第 9 秒折算出来的 2 倍和第 50 秒折算出来的 2 倍，
 * 证据强度完全不同。写进文案，回看时才能分辨当时是按什么标准亮的灯。
 */
export function buildPreburstConditionText(rule, params = {}) {
  const comparator = COMPARATOR_LABEL[rule.comparator] ?? rule.comparator;
  const quantile = Math.round((params.curveQuantile ?? 0.75) * 100);
  const elapsed = params.minElapsedSec ?? 9;
  const minutes = params.baselineMinutes ?? 20;
  return `分钟内累计成交额按 ${quantile}% 分位到达曲线折算 ${comparator} ${Number(rule.threshold).toFixed(
    2,
  )}× 近 ${minutes} 分钟基线（第 ${elapsed} 秒起判定，累计额 ≥ ${formatAmount(params.minAmount ?? 1_000_000, {
    sign: false,
  })}）`;
}

function buildPreburstMessage({ etf, evaluation, params = {} }) {
  const minutes = params.baselineMinutes ?? 20;
  const isDrain = evaluation.direction === 'drain';
  const netText =
    evaluation.net === null || evaluation.net === undefined
      ? ''
      : `，主动净${isDrain ? '卖出' : '买入'} ${formatAmount(Math.abs(evaluation.net), { sign: false })}（占成交额 ${(
          Math.abs(evaluation.netRatio) * 100
        ).toFixed(0)}%）`;
  const priceText =
    evaluation.priceMovePct === null || evaluation.priceMovePct === undefined
      ? ''
      : `，价格 ${formatPct(evaluation.priceMovePct)}`;
  const trendText = isDrain ? '主动卖压' : '主动买盘';
  return `${etf.name}（${etf.code}）${evaluation.minute} 第 ${evaluation.elapsedSec} 秒已成交 ${formatAmount(
    evaluation.amount,
    { sign: false },
  )}，按当前进度折算整分钟 ${formatAmount(evaluation.projectedAmount, { sign: false })}（${Number(
    evaluation.projectedRatio,
  ).toFixed(2)}× 近 ${minutes} 分钟基线 ${formatAmount(evaluation.baseline, { sign: false })}）${netText}${priceText}，${trendText}`;
}

/**
 * 分钟内实时爆量告警落库与广播。
 *
 * 与 volumeSurge 的关系是「预警 + 定稿」，不是替代：
 *   这里在分钟还没走完时先报（第 9~40 秒），价格通常还没走；
 *   分钟收盘后 volumeSurge 用完整 K 线再判一次，那条才是定稿记录。
 * 两条用不同的 dedupe 前缀（n: / v:），因此同一波会有「预警 + 定稿」两条，
 * 这是刻意保留的：预警的价值就在于它比定稿早 1~2 分钟。
 */
export function persistPreburstAlerts({ candidates, alertRepo, events, logger, params = {}, now = Date.now() }) {
  const created = [];

  for (const candidate of candidates) {
    const { rule, etf, tradeDate, evaluation, severity, source } = candidate;
    const cooldownMs = (rule.cooldownSec ?? rule.cooldown_sec ?? 300) * 1000;
    const last = alertRepo.lastTriggeredAt(rule.id, etf.code);
    if (last && evaluation.lastTs - last < cooldownMs && evaluation.lastTs >= last) continue;

    const conditionText = buildPreburstConditionText(rule, params);
    const message = buildPreburstMessage({ etf, evaluation, params });
    // 第 9 秒就判定的预警经常「价格还没走」：此时涨跌幅为 0，用主动净买额兜底方向
    const priceMovePct = Number.isFinite(evaluation.priceMovePct) ? evaluation.priceMovePct : null;
    const netFlow = Number.isFinite(evaluation.net) ? evaluation.net : null;

    const id = alertRepo.insert({
      ruleId: rule.id,
      ruleName: rule.name,
      code: etf.code,
      etfName: etf.name,
      category: etf.category,
      metric: 'volume_preburst',
      timeframe: 'intraday',
      comparator: rule.comparator,
      threshold: rule.threshold,
      value: evaluation.projectedRatio,
      delta: evaluation.amount - (evaluation.barAmount ?? 0),
      baseline: evaluation.baseline,
      windowSec: (params.baselineMinutes ?? 20) * 60,
      severity,
      conditionText,
      message,
      dedupeKey: `n:${tradeDate}:${evaluation.minute}`,
      source,
      tradeDate,
      triggeredAt: evaluation.lastTs,
      priceMovePct,
      netFlow,
    });
    if (id === null) continue;

    const alert = {
      id,
      ruleId: rule.id,
      ruleName: rule.name,
      code: etf.code,
      etfName: etf.name,
      category: etf.category,
      metric: 'volume_preburst',
      timeframe: 'intraday',
      comparator: rule.comparator,
      threshold: rule.threshold,
      value: evaluation.projectedRatio,
      delta: evaluation.amount - (evaluation.barAmount ?? 0),
      baseline: evaluation.baseline,
      windowSec: (params.baselineMinutes ?? 20) * 60,
      conditionText,
      message,
      severity,
      triggeredAt: evaluation.lastTs,
      triggeredAtText: formatDateTime(evaluation.lastTs),
      source,
      // 供前端做「进行中」标注：这条记录对应的是某一分钟的实时推演，不是定稿
      minute: evaluation.minute,
      level: evaluation.level,
      direction: evaluation.direction,
      priceMovePct,
      netFlow,
      early: true,
      elapsedSec: evaluation.elapsedSec,
      projectedAmount: evaluation.projectedAmount,
      amount: evaluation.amount,
      netAmount: evaluation.net,
      tradeDate,
    };

    created.push(alert);
    events?.publish(EVENTS.ALERT, alert);
  }

  if (created.length > 0) {
    logger?.info('生成分钟内实时爆量告警', { count: created.length });
  }
  return created;
}
