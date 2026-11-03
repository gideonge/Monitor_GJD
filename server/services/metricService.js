/**
 * 指标计算：纯函数，无副作用，便于单测。
 * 输入均为按时间升序排列的资金流快照。
 */

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 当日主序列口径：主动净买优先，缺了回落主力净额。
 * 与 marketService.effectiveNet 保持一致——派生指标必须锁定一个口径，
 * 否则源一换，序列上就出现几十亿的假跳变，急流告警全是假的。
 */
const netOf = (point) => point?.active_net ?? point?.main_net ?? null;

/**
 * 盘中指标：以窗口起点为基线，计算窗口内净流入的变动额与速率。
 * 若窗口内只有 1 个采样点，变动额退化为 0（无法判定急流），
 * 避免用「当日累计值」冒充「窗口变动」造成误报。
 */
export function computeWindowMetrics(points, { windowSec = 300, now = Date.now() } = {}) {
  // 只保留该口径有值的采样点：东财那一轮没有 active_net、腾讯那一轮没有 main_net，
  // 混在一起减会得到 NaN 或凭空跳变
  const series = (Array.isArray(points) ? points : []).filter((point) => netOf(point) !== null);
  if (series.length === 0) return null;
  const latest = series[series.length - 1];
  const cutoff = (latest.ts ?? now) - windowSec * 1000;
  const baseline = series.find((point) => point.ts >= cutoff) ?? series[0];

  const delta = netOf(latest) - netOf(baseline);
  const spanSec = Math.max((latest.ts - baseline.ts) / 1000, 0);
  const spanMinutes = spanSec / 60;
  const rate = spanSec > 0 ? delta / spanMinutes : 0;

  return {
    main_net: netOf(latest),
    main_net_delta: series.length > 1 ? delta : 0,
    main_net_rate: series.length > 1 ? rate : 0,
    main_net_ratio: latest.main_ratio ?? null,
    super_net: latest.super_net ?? 0,
    latest,
    baseline,
    spanSec,
    windowSec,
    coverage: windowSec > 0 ? Math.min(1, spanSec / windowSec) : 0,
  };
}

/**
 * 日度指标：当日主力净流入与近 N 日均值的差额。
 * 基准取「不含当日」的前 N 个交易日，避免自我稀释。
 */
export function computeDailyMetrics(today, previousDays, { baselineDays = 5 } = {}) {
  if (!today) return null;
  const history = (previousDays ?? [])
    .filter((row) => row.trade_date !== today.trade_date)
    .slice(-baselineDays);
  const avg = mean(history.map((row) => row.main_net));
  return {
    main_net: today.main_net,
    super_net: today.super_net ?? 0,
    main_net_ratio: null,
    baselineAvg: avg,
    baselineDays: history.length,
    main_net_vs_avg: avg === null ? null : today.main_net - avg,
  };
}

export function computeSurgeTimes(today, previousDays, { baselineDays = 5 } = {}) {
  const metrics = computeDailyMetrics(today, previousDays, { baselineDays });
  if (!metrics || metrics.baselineAvg === null || metrics.baselineAvg === 0) return null;
  return today.main_net / Math.abs(metrics.baselineAvg);
}
