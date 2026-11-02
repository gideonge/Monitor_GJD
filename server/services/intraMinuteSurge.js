/**
 * 分钟内量能实时判定（「第一手爆量」）。
 *
 * 问题：分钟级检测（volumeSurge）必须等这根 K 线走完才能算，判定时点是
 * 收盘后 0~60 秒，再叠加每秒采集与 60 秒轮询，最快也要 65 秒、最慢约 2 分钟。
 * 而爆量的「第一手」信息——大单在某一分钟内连续扫掉卖盘——在 10~20 秒内
 * 就已经能从累计成交额上看出来了。等分钟收盘，价格往往已经走了。
 *
 * 所以这里换一个观测口径：**不判定「已完成的分钟」，判定「正在形成的分钟」**。
 * 已知量是该分钟已经成交的金额 R(s)（s 为已过的秒数），未知量是这一分钟的
 * 最终成交额 F。要用 R(s) 推断 F，必须知道成交在分钟内怎么分布。
 *
 * 关键设计：用「到达曲线的分位数」而不是线性折算。
 *
 *   线性折算（R(s) × 60/s）等价于假设成交在分钟内均匀到达，早段极度高估：
 *   第 3 秒刚成交 100 万，线推就是 2000 万/分钟，任何地量标的都会瞬间「爆量」。
 *
 *   实测（2026-11-02，510300/588000/510050 共 645 个完整分钟，3 秒采样）：
 *   到第 10 秒时中位数只走完 25% 的成交额，第 30 秒走完 65%，第 50 秒走完 94%。
 *   到达曲线把这条形态固化下来，逐秒给出「到第 s 秒为止走完了多少」。
 *
 *   取 0.75 分位（而不是中位数）作为折算基准，是刻意偏向保守：假设这根分钟
 *   「走得比 75% 的分钟都快」，如果连这样折算出来都还超过门槛，那它几乎必然是真的。
 *   用中位数会有一半的分钟因为「跑得慢」被推迟到临近收盘才报出来。
 *
 * 时间口径：所有时间都取**最后一个采样点的时刻**，不用系统时钟。上游快照约 3 秒
 * 一次，用 now 会把「上游滞后」算成「已经过了很多秒」，导致折算偏低、漏报。
 */

const TZ_MS = 8 * 3600 * 1000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export const DEFAULT_PARAMS = Object.freeze({
  /** 基线窗口（分钟）：与分钟级检测保持一致，便于对账 */
  baselineMinutes: 20,
  /** 基线最少分钟数，不足则不判定（开盘后约 10 分钟内不会给结论） */
  minBaselineMinutes: 8,
  /** 到达曲线分位数：0.8 表示「比 80% 的分钟走得快」这一保守假设 */
  curveQuantile: 0.8,
  /** 自建曲线所需的最少完整分钟数；不足时回落到内置先验曲线 */
  minCurveMinutes: 30,
  /** 曲线占比上限：第 59 秒不给到 1，避免除数趋零把折算放大 */
  curveMaxShare: 0.98,
  /** 触发门槛（折算倍数）。比分钟级的 3× 低一档：这是预警，收盘后还有一次定稿 */
  ratioThreshold: 2.5,
  /** 折算倍数达到该值直接给强级 */
  level3Ratio: 5,
  /**
   * 「钱已经足够多」的绝对档（元）：该分钟内已成交额达到此值也给强级。
   * 只有相对倍数是不够的——第 10 秒折算出的 5 倍可能只是 300 万，
   * 而第 30 秒已经实打实成交 4000 万的，不需要再靠折算去证明什么。
   */
  strongAmount: 30_000_000,
  /** 最少已过秒数：3 秒采样下 9 秒刚好 3 个点，再少就是单笔毛刺 */
  minElapsedSec: 9,
  /** 该分钟内最少采样点数 */
  minSamples: 3,
  /** 该分钟累计成交额下限（元）：防止地量标的的「几万块放大二十倍」 */
  minAmount: 3_000_000,
  /** 观察档位：折算倍数达到门槛的这个比例时先亮灯但不告警 */
  watchRatio: 0.7,
  /** 判定为完整分钟的条件：首点不晚于第 4 秒、末点不早于第 54 秒 */
  completeFirstSec: 4,
  completeLastSec: 54,
});

/**
 * 先验到达曲线（秒 → 累计成交额占比），来自 2026-11-02 十五只标的共 3124 个
 * 完整分钟实测的 0.8 分位。只在一个交易日开盘后、自建曲线还没攒够 30 个分钟时
 * 使用，攒够之后立刻换成当日自己的曲线（不同标的的到达节奏差别很大）。
 *
 * 注意：这段先验只在 09:31–10:01 生效，而开盘时段实测的 0.8 分位比全天更前置
 * （第 10 秒 42% vs 全天 35%）。这里仍取全天的稳健估计，等于在开盘阶段稍微激进
 * 一点——宁可早报，不要因为先验偏保守而漏掉开盘的第一波。
 */
const PRIOR_CURVE = Object.freeze([
  [0, 0],
  [5, 0.21],
  [10, 0.35],
  [15, 0.48],
  [20, 0.59],
  [25, 0.67],
  [30, 0.77],
  [35, 0.83],
  [40, 0.89],
  [45, 0.95],
  [50, 0.98],
  [55, 1],
  [59, 1],
]);

const pad2 = (value) => String(value).padStart(2, '0');

/**
 * 合并参数时忽略 undefined。
 * 直接用 {...DEFAULT_PARAMS, ...options} 会有一个隐蔽陷阱：调用方（服务层）把配置项
 * 逐个列出时，只要漏了某个字段，它就会以 undefined 覆盖掉默认值，
 * 于是 Math.min(x, undefined) = NaN，折算倍数变成 NaN 而整条链路不报错。
 */
function withDefaults(options) {
  const params = { ...DEFAULT_PARAMS };
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined && value !== null) params[key] = value;
  }
  return params;
}

/** 毫秒时间戳 → 北京时间钟点（纯算术，不用 Intl，逐点调用也不心疼） */
export function clockOf(ts) {
  const shifted = ts + TZ_MS;
  const dayIndex = Math.floor(shifted / DAY_MS);
  const secondOfDay = Math.floor(shifted / 1000) % 86400;
  const minuteOfDay = Math.floor(secondOfDay / 60);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return {
    dayIndex,
    secondOfDay,
    minuteOfDay,
    hour,
    minute,
    second: secondOfDay % 60,
    text: `${pad2(hour)}:${pad2(minute)}`,
    tradeDate: new Date(shifted).toISOString().slice(0, 10),
  };
}

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function quantileOf(values, q) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[pos];
}

/** 上午/下午交易时段之外的分钟（集合竞价、午休、收盘后）不参与判定 */
const SESSION_RANGES = [
  { name: 'am', start: 9 * 60 + 31, end: 11 * 60 + 29 },
  { name: 'pm', start: 13 * 60 + 1, end: 14 * 60 + 56 },
];

export function sessionOfMinuteOfDay(minuteOfDay) {
  for (const range of SESSION_RANGES) {
    if (minuteOfDay >= range.start && minuteOfDay <= range.end) return range.name;
  }
  return null;
}

/**
 * 把逐秒点按「分钟」分桶。
 *
 * 只认 amt_delta（本段成交额增量）：它是差分出来的，天然对齐采样间隔；
 * 累计量 amount 只能用来做总体校验，不能用来分桶。
 */
export function splitMinuteTicks(points) {
  const buckets = new Map();

  for (const point of points ?? []) {
    const ts = Number(point.ts);
    if (!Number.isFinite(ts)) continue;
    const amt = point.amt_delta === null || point.amt_delta === undefined ? null : Number(point.amt_delta);
    const net = point.net_delta === null || point.net_delta === undefined ? null : Number(point.net_delta);
    const price = Number(point.price);

    const clock = clockOf(ts);
    const key = `${clock.dayIndex}:${clock.text}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        tradeDate: clock.tradeDate,
        dayIndex: clock.dayIndex,
        minute: clock.text,
        minuteOfDay: clock.minuteOfDay,
        session: sessionOfMinuteOfDay(clock.minuteOfDay),
        startTs: (clock.dayIndex * 1440 + clock.minuteOfDay) * MINUTE_MS - TZ_MS,
        samples: 0,
        amount: 0,
        net: 0,
        netCounted: 0,
        firstSec: null,
        lastSec: null,
        firstTs: ts,
        lastTs: ts,
        open: Number.isFinite(price) ? price : null,
        close: Number.isFinite(price) ? price : null,
        high: Number.isFinite(price) ? price : null,
        low: Number.isFinite(price) ? price : null,
        ticks: [],
        _profile: null,
      };
      buckets.set(key, bucket);
    }

    if (Number.isFinite(price)) {
      bucket.close = price;
      if (bucket.high === null || price > bucket.high) bucket.high = price;
      if (bucket.low === null || price < bucket.low) bucket.low = price;
    }
    bucket.lastTs = ts;
    bucket.lastSec = clock.second;
    if (bucket.firstSec === null) bucket.firstSec = clock.second;

    if (amt === null || !Number.isFinite(amt)) continue;
    bucket.samples += 1;
    bucket.amount += amt;
    if (net !== null && Number.isFinite(net)) {
      bucket.net += net;
      bucket.netCounted += 1;
    }
    bucket.ticks.push({ sec: clock.second, amt, net, price });
  }

  const list = [...buckets.values()].sort((a, b) => a.startTs - b.startTs);
  for (const bucket of list) {
    bucket.complete =
      bucket.firstSec !== null &&
      bucket.firstSec <= DEFAULT_PARAMS.completeFirstSec &&
      bucket.lastSec >= DEFAULT_PARAMS.completeLastSec;
  }
  return list;
}

/**
 * 单个分钟的累计占比曲线（60 个元素，下标为已过秒数）。
 * 用「最后一个不晚于该秒的采样点」取值，与实时判定时的取法完全一致，
 * 否则曲线和实盘会错开一个采样间隔，折算系统性偏低。
 */
function shareProfile(bucket) {
  if (bucket._profile) return bucket._profile;
  const profile = new Float64Array(60);
  if (!(bucket.amount > 0)) {
    bucket._profile = profile;
    return profile;
  }
  let index = 0;
  let cumulative = 0;
  for (let sec = 0; sec < 60; sec += 1) {
    while (index < bucket.ticks.length && bucket.ticks[index].sec <= sec) {
      cumulative += bucket.ticks[index].amt;
      index += 1;
    }
    profile[sec] = Math.min(1, cumulative / bucket.amount);
  }
  // 单调化：采样抖动可能让占比回退，回退对折算没有意义
  for (let sec = 1; sec < 60; sec += 1) {
    if (profile[sec] < profile[sec - 1]) profile[sec] = profile[sec - 1];
  }
  bucket._profile = profile;
  return profile;
}

/** 由当日已完成分钟自建到达曲线；样本不足返回 null */
export function buildArrivalCurve(buckets, options = {}) {
  const params = withDefaults(options);
  const usable = (buckets ?? []).filter((bucket) => bucket.complete && bucket.amount > 0);
  if (usable.length < params.minCurveMinutes) return null;

  const shares = new Float64Array(60);
  for (let sec = 0; sec < 60; sec += 1) {
    const values = usable.map((bucket) => shareProfile(bucket)[sec]);
    shares[sec] = Math.min(quantileOf(values, params.curveQuantile), params.curveMaxShare);
  }
  return { shares, source: 'self', samples: usable.length, quantile: params.curveQuantile };
}

/** 内置先验曲线（自建曲线攒够之前的兜底），返回与 buildArrivalCurve 同结构 */
export function priorArrivalCurve(options = {}) {
  const params = withDefaults(options);
  const shares = new Float64Array(60);
  for (let sec = 0; sec < 60; sec += 1) {
    let value = PRIOR_CURVE[PRIOR_CURVE.length - 1][1];
    for (let i = 1; i < PRIOR_CURVE.length; i += 1) {
      const [s1, v1] = PRIOR_CURVE[i];
      const [s0, v0] = PRIOR_CURVE[i - 1];
      if (sec <= s1) {
        value = s1 === s0 ? v1 : v0 + ((v1 - v0) * (sec - s0)) / (s1 - s0);
        break;
      }
    }
    shares[sec] = Math.min(value, params.curveMaxShare);
  }
  return { shares, source: 'prior', samples: 0, quantile: params.curveQuantile };
}

/**
 * 主判定：把「正在形成的这根分钟」折算成整分钟成交额，与基线比较。
 *
 * @param {Array<{ts:number, amt_delta:number, net_delta:number, price:number}>} points 升序逐秒点
 * @param {object} options 覆盖 DEFAULT_PARAMS
 * @param {{shares:Float64Array, source:string}} [options.curve] 外部传入的到达曲线（服务层缓存用）
 */
export function detectIntraMinuteBurst(points, options = {}) {
  const params = withDefaults(options);
  const buckets = splitMinuteTicks(points);
  const last = buckets[buckets.length - 1];

  if (!last) return { active: false, reason: 'no-data', buckets };
  if (!last.session) {
    return { active: false, reason: 'auction', minute: last.minute, tradeDate: last.tradeDate, buckets };
  }
  if (last.samples === 0) {
    return { active: false, reason: 'no-volume-in-minute', minute: last.minute, tradeDate: last.tradeDate, buckets };
  }

  // 基线：同一交易时段、同一交易日、本根之前的完整分钟。
  // 用中位数而不是均值：尾盘一波放量会把均值拉高，反过来压掉后续的判定。
  const history = buckets
    .slice(0, -1)
    .filter(
      (bucket) =>
        bucket.complete &&
        bucket.amount > 0 &&
        bucket.dayIndex === last.dayIndex &&
        bucket.session === last.session &&
        bucket.minuteOfDay < last.minuteOfDay,
    )
    .slice(-params.baselineMinutes);

  const curveBuckets = buckets.filter(
    (bucket) => bucket !== last && bucket.complete && bucket.amount > 0 && bucket.dayIndex === last.dayIndex,
  );
  const curve = options.curve ?? buildArrivalCurve(curveBuckets, params) ?? priorArrivalCurve(params);
  return { ...evaluateFormingBucket(last, history, curve, params), buckets };
}

/**
 * 判定内核：给定「正在形成的这一分钟」+「已完成的基线分钟」+「到达曲线」，
 * 算出折算结果。
 *
 * 与 detectIntraMinuteBurst 拆开，是为了让回放脚本能用同一套逻辑逐点重放，
 * 而不必为每个切点重建整个窗口——回测如果另写一份判定，结论就不可信了。
 *
 * @param {object} last 正在形成的分钟（可能只包含前 k 个采样点）
 * @param {Array} history 已完成分钟（同交易日、同交易时段、本根之前）
 * @param {{shares:Float64Array, source:string}} curve 到达曲线
 */
export function evaluateFormingBucket(last, history, curve, options = {}) {
  const params = withDefaults(options);
  const baseline = median((history ?? []).map((bucket) => bucket.amount));
  const baselineCount = history?.length ?? 0;

  const elapsedSec = Math.min(59, last.lastSec ?? 0);
  const curveShare = Math.max(curve.shares[elapsedSec] ?? 0, 0.02);
  const projectedAmount = last.amount / curveShare;
  const projectedRatio = baseline > 0 ? projectedAmount / baseline : null;
  // 触发门槛：这一分钟按当前进度至少要成交这么多钱，才认它是爆量。
  // 等价于 projectedRatio >= ratioThreshold，但直接给出金额便于前端展示「还差多少」。
  const barAmount = baseline > 0 ? params.ratioThreshold * baseline * curveShare : null;

  const netRatio = last.amount > 0 ? last.net / last.amount : 0;
  const direction = netRatio >= 0.1 ? 'surge' : netRatio <= -0.1 ? 'drain' : 'unknown';

  const gates = {
    elapsed: elapsedSec >= params.minElapsedSec,
    samples: last.samples >= params.minSamples,
    amount: last.amount >= params.minAmount,
    baseline: baselineCount >= params.minBaselineMinutes,
    ratio: projectedRatio !== null && projectedRatio >= params.ratioThreshold,
  };
  const triggered = gates.elapsed && gates.samples && gates.amount && gates.baseline && gates.ratio;

  let stage = 'idle';
  if (triggered) stage = 'trigger';
  else if (projectedRatio !== null && gates.baseline && projectedRatio >= params.ratioThreshold * params.watchRatio) {
    stage = 'watch';
  }

  // 强级：折算倍数极高，或已经真金白银成交了足够大的金额
  const level = !triggered
    ? 0
    : projectedRatio >= params.level3Ratio || last.amount >= params.strongAmount
      ? 3
      : 2;

  return {
    active: true,
    stage,
    triggered,
    level,
    tradeDate: last.tradeDate,
    minute: last.minute,
    startTs: last.startTs,
    lastTs: last.lastTs,
    elapsedSec,
    samples: last.samples,
    amount: last.amount,
    net: last.net,
    netRatio,
    direction,
    price: last.close,
    minuteOpen: last.open,
    minuteHigh: last.high,
    minuteLow: last.low,
    priceMovePct:
      Number.isFinite(last.open) && last.open > 0 && Number.isFinite(last.close)
        ? ((last.close - last.open) / last.open) * 100
        : null,
    baseline,
    baselineCount,
    curveShare,
    curveSource: curve.source,
    curveSamples: curve.samples ?? 0,
    projectedAmount,
    projectedRatio,
    barAmount,
    progress: projectedAmount > 0 ? Math.min(1, last.amount / projectedAmount) : 0,
    gates,
    reason: triggered ? 'triggered' : firstFailedGate(gates),
  };
}

/** 把一根完整分钟裁剪成「只包含前 k 个采样点」的形成中分钟（回放用） */
export function sliceBucket(bucket, tickCount) {
  const ticks = bucket.ticks.slice(0, Math.max(0, tickCount));
  if (ticks.length === 0) return null;
  let amount = 0;
  let net = 0;
  let high = null;
  let low = null;
  let close = null;
  for (const tick of ticks) {
    amount += tick.amt;
    net += tick.net ?? 0;
    if (Number.isFinite(tick.price)) {
      close = tick.price;
      if (high === null || tick.price > high) high = tick.price;
      if (low === null || tick.price < low) low = tick.price;
    }
  }
  return {
    ...bucket,
    ticks,
    samples: ticks.length,
    amount,
    net,
    firstSec: ticks[0].sec,
    lastSec: ticks[ticks.length - 1].sec,
    lastTs: bucket.startTs + ticks[ticks.length - 1].sec * 1000,
    close,
    high,
    low,
    _profile: null,
  };
}

function firstFailedGate(gates) {
  for (const key of ['baseline', 'elapsed', 'samples', 'amount', 'ratio']) {
    if (!gates[key]) return key;
  }
  return 'none';
}

/**
 * 事件等级 → 告警档位。与 volumeSurge 的分级口径保持一致：
 * 只有「折算倍数 ≥4 且主动净买同向」才算强信号。
 */
export function gradePreburst(evaluation) {
  if (!evaluation?.triggered) return 0;
  if (evaluation.level >= 3 && evaluation.direction === 'surge') return 3;
  return Math.max(2, Math.min(3, evaluation.level));
}
