/**
 * 秒级主动买卖攻势检测（Tick Flow Impulse, TFI）。
 *
 * 目标：在核心池（国家队常买宽基）的秒级流上，尽早识别「一侧主动资金连续扫单」，
 * 而不是等到分钟级量能突变成立（那已经是 1 分钟之后的事）。
 *
 * 为什么不能把分钟级 VSD 直接套到秒级：
 *   1. 秒级量能是「事件驱动」的：没有成交的秒根本不产生快照，15 秒桶里可能只有 3-6 个点。
 *      用「每秒成交量 / 基线每秒成交量」的倍数量，会在地量秒上出现几十倍，
 *      信噪比极差。所以判定单位必须是桶（默认 15 秒）的**累计额**，并设桶内最小样本数。
 *   2. 秒级有方向字段：外盘/内盘是交易所按主动买/主动卖统计的累计量，
 *      netDelta =（Δ外盘 − Δ内盘）× 100 × 现价，直接给出「谁在主动成交」，
 *      不需要像分钟级那样用价格突破去反推方向。
 *      因此价格不是门槛而是加分项——国家队护盘常在下跌中主动承接，硬要求向上突破会漏掉最典型的入场。
 *   3. 单笔大单会造成单桶尖峰。所以要求「连续桶」确认：真正的扫单是连续若干桶同向，
 *      乌龙指/单笔调仓只出现在一桶里。
 *   4. 国家队不会只买一只。同时段多只宽基同向净买（跨族共振）比任何单只金额都更能说明问题，
 *      这一层在分钟级算法里完全没有。
 *
 * 与分钟级 VSD 的分工：
 *   volumeSurge  全池 120 只、分钟粒度、无方向字段、靠价格突破确认，负责「面」。
 *   tickImpulse  核心池 15 只、15 秒粒度、有主动买卖方向，负责「点」——国家队入场的第一现场。
 *
 * 算法全程因果：第 i 桶只使用 i 之前的桶做基线、用 i-1..i-n 做连续性确认，
 * 没有前视，可直接实时运行，也能原样回放到历史数据上评估。
 */

/** 北京时间固定 +8，无夏令时，直接用偏移量换算比 Intl 格式化快两个数量级 */
const BEIJING_OFFSET = 8 * 3600 * 1000;

/**
 * 可判定时段（北京时间的当日秒数）。
 * 开盘 09:30:00 之后已经是连续竞价（集合竞价在 09:25 撮合完成），
 * 收盘 14:57 起进入集合竞价，14:57-15:00 的成交是一次性撮合，与连续竞价不可比。
 */
export const SESSIONS_SEC = [
  { name: 'am', start: 9 * 3600 + 30 * 60, end: 11 * 3600 + 30 * 60 },
  { name: 'pm', start: 13 * 3600, end: 14 * 3600 + 56 * 60 + 59 },
];

export const DEFAULT_PARAMS = Object.freeze({
  /** 判定桶宽（秒）。15 秒 ≈ 单只宽基 ETF 一笔中型扫单的完整成交时间 */
  bucketSec: 15,
  /** 基线桶数：20 桶 × 15 秒 = 近 5 分钟 */
  baselineBuckets: 20,
  /** 基线最少桶数，不足则不判定（开盘前 1.5 分钟没有可用基线） */
  minBaselineBuckets: 6,
  /** 桶内最少有效秒数：无成交的秒不产生快照，地量桶不参与判定 */
  minSamplesPerBucket: 3,
  /**
   * 相对门槛：本桶主动净买入额 / 基线桶成交额中位数。
   * 用成交额而不是净额做分母，是因为净额中位数≈0，无法做基线。
   */
  netRatioThreshold: 0.6,
  /**
   * 绝对门槛（元/桶）：单桶主动净买入不足此值一律不报。
   * 相对门槛对地量标的会同步变小，拦不住「10 万元变 200 万元」这种倍数惊人但无资金含义的变化。
   */
  minNetAmount: 500_000,
  /** 净额占本桶成交额的比例：区分「单边主动扫单」与「双边换手放大」 */
  minBuyShare: 0.2,
  /** 稳健 z 下限（基于前文净额的 MAD） */
  zThreshold: 4,
  /**
   * 连续确认桶数（含当前桶）：3 桶 = 连续 45 秒同向。
   *
   * 这个数字是标定出来的，不是拍的：合成秒级流上，2 桶确认每小时仍会漏进约 0.1 条
   * 无方向放量（3-7 倍量能、随机方向的流动性突发），3 桶把误报压到 0.03 条/小时，
   * 而真实扫单普遍持续 1-5 分钟，45 秒确认不会漏掉它们。详见 reports/tick-impulse-design.md。
   */
  confirmBuckets: 3,
  /** 确认时前序桶只需达到当前门槛的这个比例（避免第二桶略小于第一桶就被否掉） */
  confirmRatioShare: 0.5,
  /** 同一波攻势的合并间隔（秒）：间隔小于此值的事件视为同一波 */
  mergeGapSec: 90,
  /**
   * 单波最长时长（秒）。
   * 没有这个上限时，持续一整天的反复达标会把所有事件串成一波，
   * 一条「8 小时累计净买入 30 亿」的告警既无法解读也无法行动。
   */
  maxEpisodeSec: 600,
  /** 是否检测主动卖出攻势 */
  detectDrain: true,
  /** 价格位移硬门槛（%），0 表示不启用（护盘时价格可能横盘或下跌） */
  minPriceMovePct: 0,
  /** 桶内价格位移达到此值（%）时强度加一级 */
  levelPriceMovePct: 0.12,
});

/** 当日秒数 → 时段名；不在可判定区间返回 null */
export function sessionOfTs(ts) {
  const date = new Date(ts + BEIJING_OFFSET);
  const second = date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
  for (const session of SESSIONS_SEC) {
    if (second >= session.start && second <= session.end) return session.name;
  }
  return null;
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mad(values, center) {
  if (!values.length) return 0;
  return median(values.map((value) => Math.abs(value - center)));
}

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * 把秒级点聚成判定桶。
 *
 * 只累计「有增量」的秒：首点、跨日点、上游时间戳未前进的点 netDelta/amtDelta 为 null，
 * 计成 0 会稀释桶成交额，计成缺失又会丢样本，因此单独统计 samples。
 */
export function bucketize(points, { bucketSec = 15 } = {}) {
  const span = Math.max(1, bucketSec) * 1000;
  const buckets = new Map();

  for (const point of Array.isArray(points) ? points : []) {
    const ts = Number(point?.ts);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const session = sessionOfTs(ts);
    if (!session) continue;

    const index = Math.floor(ts / span);
    let bucket = buckets.get(index);
    if (!bucket) {
      bucket = {
        index,
        startTs: index * span,
        session,
        samples: 0,
        amt: 0,
        net: 0,
        buySec: 0,
        sellSec: 0,
        open: null,
        close: null,
        high: null,
        low: null,
        imbaSum: 0,
        imbaN: 0,
      };
      buckets.set(index, bucket);
    }

    const price = Number(point.price);
    if (Number.isFinite(price) && price > 0) {
      if (bucket.open === null) bucket.open = price;
      bucket.close = price;
      bucket.high = bucket.high === null ? price : Math.max(bucket.high, price);
      bucket.low = bucket.low === null ? price : Math.min(bucket.low, price);
    }

    const amtDelta = Number(point.amtDelta ?? point.amt_delta);
    const netDelta = Number(point.netDelta ?? point.net_delta);
    const hasAmt = isNum(amtDelta) && amtDelta >= 0;
    const hasNet = isNum(netDelta);

    if (!hasAmt && !hasNet) continue;

    bucket.samples += 1;
    if (hasAmt) bucket.amt += amtDelta;
    if (hasNet) {
      bucket.net += netDelta;
      if (netDelta > 0) bucket.buySec += 1;
      else if (netDelta < 0) bucket.sellSec += 1;
    }

    const imba = Number(point.imba);
    if (isNum(imba)) {
      bucket.imbaSum += imba;
      bucket.imbaN += 1;
    }
  }

  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      endTs: bucket.startTs + span,
      imba: bucket.imbaN > 0 ? bucket.imbaSum / bucket.imbaN : null,
      priceMove: bucket.open && bucket.close ? ((bucket.close - bucket.open) / bucket.open) * 100 : null,
    }))
    .sort((a, b) => a.index - b.index);
}

/**
 * 强度分级。
 *
 * 与分钟级 gradeIntensity 的差异：秒级多一个「连续性」维度。
 * 单桶 2000 万可能是调仓，连续 4 桶各 1500 万只能是有人在持续扫，
 * 后者才是国家队入场的形态，所以连续性占 20% 权重。
 */
export function gradeImpulse({ ratio, z, buyShare, streak }) {
  const ratioPart = (Math.min(Math.abs(ratio), 4) / 4) * 0.4;
  const zPart = (Math.min(Math.abs(z), 12) / 12) * 0.25;
  const sharePart = (Math.min(Math.abs(buyShare), 0.6) / 0.6) * 0.15;
  const streakPart = (Math.min(streak, 4) / 4) * 0.2;
  const score = ratioPart + zPart + sharePart + streakPart;
  if (score >= 0.62) return { level: 3, label: '强', score };
  if (score >= 0.42) return { level: 2, label: '中', score };
  return { level: 1, label: '弱', score };
}

/**
 * 主检测：秒级点序列 → 攻势事件 → 合并成波（episode）。
 *
 * @param {Array<{ts:number, price:number, amtDelta:number, netDelta:number, imba:number}>} points 按 ts 升序
 * @returns {{episodes:Array, events:Array, buckets:Array, stats:object}}
 */
export function detectTickImpulse(points, options = {}) {
  const params = { ...DEFAULT_PARAMS, ...options };
  const buckets = bucketize(points, { bucketSec: params.bucketSec });
  const usable = buckets.filter((bucket) => bucket.samples >= params.minSamplesPerBucket && bucket.amt > 0);
  const dayMedianAmt = median(usable.map((bucket) => bucket.amt));

  const skipped = { baseline: 0, thin: 0, shape: 0, price: 0, streak: 0 };
  /** 每个桶的判定结果：direction 为「完整达标」，weakDirection 只用于数连续性 */
  const evaluated = new Array(buckets.length).fill(null);

  // 第一遍：算基线、相对强度与形态资格（不判连续性）
  for (let i = 0; i < buckets.length; i += 1) {
    const bucket = buckets[i];
    if (bucket.samples < params.minSamplesPerBucket || !(bucket.amt > 0)) {
      skipped.thin += 1;
      continue;
    }

    // 基线：同交易时段、向前取，绝不跨午休
    const window = [];
    const netWindow = [];
    for (let j = i - 1; j >= 0 && window.length < params.baselineBuckets; j -= 1) {
      const prev = buckets[j];
      if (prev.session !== bucket.session) break;
      if (prev.samples < params.minSamplesPerBucket || !(prev.amt > 0)) continue;
      window.push(prev.amt);
      netWindow.push(prev.net);
    }
    if (window.length < params.minBaselineBuckets) {
      skipped.baseline += 1;
      continue;
    }

    const baselineAmt = median(window);
    if (!(baselineAmt > 0)) {
      skipped.baseline += 1;
      continue;
    }

    const netMedian = median(netWindow);
    // 净额的自然波动远小于成交额，用成交额的一个固定比例兜底，避免 MAD=0 时 z 爆表
    const spread = Math.max(mad(netWindow, netMedian) * 1.4826, baselineAmt * 0.08, 1);
    const ratio = bucket.net / baselineAmt;
    const z = (bucket.net - netMedian) / spread;
    const buyShare = bucket.net / Math.max(bucket.amt, 1);

    const surgeFull =
      bucket.net >= params.minNetAmount &&
      ratio >= params.netRatioThreshold &&
      buyShare >= params.minBuyShare &&
      z >= params.zThreshold;
    const drainFull =
      params.detectDrain &&
      bucket.net <= -params.minNetAmount &&
      ratio <= -params.netRatioThreshold &&
      buyShare <= -params.minBuyShare &&
      z <= -params.zThreshold;

    const weak = params.confirmRatioShare;
    const surgeWeak = bucket.net >= params.minNetAmount * weak && ratio >= params.netRatioThreshold * weak;
    const drainWeak = params.detectDrain && bucket.net <= -params.minNetAmount * weak && ratio <= -params.netRatioThreshold * weak;

    let direction = surgeFull ? 'surge' : drainFull ? 'drain' : null;
    const weakDirection = surgeWeak ? 'surge' : drainWeak ? 'drain' : null;

    if (direction && params.minPriceMovePct > 0) {
      const aligned = direction === 'surge' ? bucket.priceMove > 0 : bucket.priceMove < 0;
      if (bucket.priceMove === null || Math.abs(bucket.priceMove) < params.minPriceMovePct || !aligned) {
        skipped.price += 1;
        direction = null;
      }
    }
    if (!direction) skipped.shape += 1;

    evaluated[i] = {
      bucket,
      direction,
      weakDirection,
      baselineAmt,
      ratio,
      z,
      buyShare,
    };
  }

  // 第二遍：连续性确认。确认成立时把这一波的头几个桶一并补进来。
  //
  // 为什么补波头：确认要求「连续 N 桶」，若只从第 N 桶开始算事件，
  // 每波都会丢掉开头 N-1 桶的净额与真实的起始时刻——而「这一波从几点开始、买了多少」
  // 恰好是判断国家队入场最关键的两个数字。
  // 补的动作发生在第 N 桶成立之后，因此仍然是因果的（代价是该桶延迟 1 个桶才确认）。
  const events = [];
  const emitted = new Set();

  for (let i = 0; i < buckets.length; i += 1) {
    const current = evaluated[i];
    if (!current || !current.direction) continue;

    let streak = 1;
    for (let j = i - 1; j >= 0 && streak < 60; j -= 1) {
      const prev = evaluated[j];
      if (!prev || prev.bucket.session !== current.bucket.session) break;
      if (prev.weakDirection !== current.direction) break;
      streak += 1;
    }
    if (streak < params.confirmBuckets) {
      skipped.streak += 1;
      continue;
    }

    for (let j = i - streak + 1; j <= i; j += 1) {
      const item = evaluated[j];
      if (!item || item.direction !== current.direction || emitted.has(j)) continue;
      emitted.add(j);

      const bucket = item.bucket;
      const positionStreak = j - (i - streak + 1) + 1;
      const { level: baseLevel, label, score } = gradeImpulse({
        ratio: item.ratio,
        z: item.z,
        buyShare: item.buyShare,
        streak: positionStreak,
      });
      let level = baseLevel;
      if (params.levelPriceMovePct > 0 && bucket.priceMove !== null) {
        const aligned = current.direction === 'surge' ? bucket.priceMove > 0 : bucket.priceMove < 0;
        if (aligned && Math.abs(bucket.priceMove) >= params.levelPriceMovePct) level = Math.min(3, level + 1);
      }

      events.push({
        index: j,
        startTs: bucket.startTs,
        endTs: bucket.endTs,
        session: bucket.session,
        direction: current.direction,
        net: bucket.net,
        amt: bucket.amt,
        buyShare: item.buyShare,
        baselineAmt: item.baselineAmt,
        ratio: item.ratio,
        z: item.z,
        score,
        level,
        levelLabel: label,
        streak: positionStreak,
        samples: bucket.samples,
        price: bucket.close,
        priceMove: bucket.priceMove,
        imba: bucket.imba,
      });
    }
  }

  const episodes = mergeEpisodes(events, params);

  return {
    episodes,
    events,
    buckets,
    stats: {
      rawPoints: Array.isArray(points) ? points.length : 0,
      buckets: buckets.length,
      usableBuckets: usable.length,
      dayMedianAmt,
      events: events.length,
      episodes: episodes.length,
      surge: events.filter((event) => event.direction === 'surge').length,
      drain: events.filter((event) => event.direction === 'drain').length,
      skipped,
    },
  };
}

/**
 * 把相邻事件合并成「一波攻势」。
 *
 * 为什么需要：一次国家队入场往往持续 1-5 分钟，中间会有几个桶因为等待成交而不达标。
 * 如果逐桶告警，一次入场会炸出 5-10 条告警，把真正重要的信息淹掉。
 * 合并后一波只出一条，带上延续时长与累计净额——这两个数字才是判断「是不是国家队」的关键。
 */
export function mergeEpisodes(events, params = DEFAULT_PARAMS) {
  const gapBuckets = Math.max(1, Math.ceil(params.mergeGapSec / params.bucketSec));
  const maxEpisodeMs = Math.max(params.bucketSec * 2, params.maxEpisodeSec ?? DEFAULT_PARAMS.maxEpisodeSec) * 1000;
  const episodes = [];

  for (const event of events) {
    const last = episodes[episodes.length - 1];
    if (
      last &&
      last.direction === event.direction &&
      event.index - last.lastIndex <= gapBuckets &&
      event.endTs - last.startTs <= maxEpisodeMs
    ) {
      last.endTs = event.endTs;
      last.lastIndex = event.index;
      last.buckets += 1;
      last.sumNet += event.net;
      last.sumAmt += event.amt;
      last.peakNet = Math.abs(event.net) > Math.abs(last.peakNet) ? event.net : last.peakNet;
      last.maxStreak = Math.max(last.maxStreak, event.streak);
      last.maxRatio = Math.max(last.maxRatio, Math.abs(event.ratio));
      last.maxZ = Math.max(last.maxZ, Math.abs(event.z));
      last.level = Math.max(last.level, event.level);
      last.priceClose = event.price;
      last.priceMove = event.priceMove;
      continue;
    }

    episodes.push({
      startTs: event.startTs,
      endTs: event.endTs,
      lastIndex: event.index,
      session: event.session,
      direction: event.direction,
      buckets: 1,
      sumNet: event.net,
      sumAmt: event.amt,
      peakNet: event.net,
      maxStreak: event.streak,
      maxRatio: Math.abs(event.ratio),
      maxZ: Math.abs(event.z),
      level: event.level,
      levelLabel: event.levelLabel,
      priceOpen: event.price,
      priceClose: event.price,
      priceMove: event.priceMove,
      peakEvent: event,
    });
  }

  for (const episode of episodes) {
    episode.durationSec = Math.round((episode.endTs - episode.startTs) / 1000);
    episode.buyShare = episode.sumAmt > 0 ? episode.sumNet / episode.sumAmt : null;
    episode.priceMove =
      episode.priceOpen && episode.priceClose
        ? ((episode.priceClose - episode.priceOpen) / episode.priceOpen) * 100
        : null;
    // 净额速率（元/秒）：跨标的可比，用于共振排序
    episode.netRate = episode.durationSec > 0 ? episode.sumNet / episode.durationSec : episode.sumNet;
  }

  return episodes;
}

/**
 * 跨标的共振聚合。
 *
 * 这是「抓国家队」最有效的一层：单只 ETF 上出现 5000 万主动净买，
 * 可能是一家机构调仓、也可能是做市商对冲；但同一分钟内沪深300、中证500、科创50
 * 三族同时出现同向攻势，只可能是一揽子买入——这是国家队托底的典型指纹。
 *
 * @param {Array<{code:string, name?:string, family?:string, episode:object}>} entries
 */
export function aggregateResonance(entries, options = {}) {
  const params = {
    windowSec: 120,
    minCodes: 2,
    minFamilies: 2,
    requireCrossFamily: true,
    ...options,
  };
  const windowMs = Math.max(1, params.windowSec) * 1000;
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.episode);
  const results = [];

  for (const direction of ['surge', 'drain']) {
    const sameDir = list
      .filter((entry) => entry.episode.direction === direction)
      .sort((a, b) => a.episode.startTs - b.episode.startTs);

    for (let i = 0; i < sameDir.length; i += 1) {
      const anchor = sameDir[i].episode;
      // 以「窗口内最强的一波」作为锚：只从锚向前看，保证因果且不重复
      const inWindow = sameDir.filter(
        (entry) => entry.episode.startTs <= anchor.startTs && anchor.startTs - entry.episode.startTs < windowMs,
      );
      const byCode = new Map();
      for (const entry of inWindow) {
        const current = byCode.get(entry.code);
        if (!current || Math.abs(entry.episode.sumNet) > Math.abs(current.episode.sumNet)) byCode.set(entry.code, entry);
      }

      const picked = [...byCode.values()];
      if (picked.length < params.minCodes) continue;
      const families = [...new Set(picked.map((entry) => entry.family ?? 'other'))];
      if (params.requireCrossFamily && families.length < params.minFamilies) continue;

      const sumNet = picked.reduce((sum, entry) => sum + entry.episode.sumNet, 0);
      const level = families.length >= 3 ? 3 : families.length >= 2 ? 2 : 1;
      const last = results[results.length - 1];
      const codes = picked.map((entry) => entry.code).sort();
      const sameEpisode =
        last &&
        last.direction === direction &&
        anchor.startTs - last.ts < windowMs &&
        codes.join(',') === last.codes.join(',');

      if (sameEpisode) continue;

      results.push({
        ts: anchor.startTs,
        endTs: Math.max(...picked.map((entry) => entry.episode.endTs)),
        direction,
        codes,
        names: picked.map((entry) => entry.name ?? entry.code),
        families,
        sumNet,
        maxLevel: Math.max(...picked.map((entry) => entry.episode.level)),
        level,
        windowSec: params.windowSec,
      });
    }
  }

  return results.sort((a, b) => a.ts - b.ts);
}

export { mad };
