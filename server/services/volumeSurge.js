/**
 * 日内量能突变检测（Volume Surge Detector, VSD）。
 *
 * 目标：在单日分钟序列上识别「成交量突然暴增/骤减」的时刻，作为大资金异动预警。
 *
 * 为什么不能直接用固定阈值或全天均值倍数：
 *   1. 分钟量能呈强 U 型（开盘、尾盘高，午间低）。本样本 510300 的午后中位量
 *      只有上午后段的 1.8 倍、尾盘段是午后的 3.4 倍，全天均值倍数法在开盘与
 *      尾盘会成片误报，在午间又会漏报。
 *   2. 分钟量分布右偏严重（最大值 ≈ 中位数的数十倍），均值与标准差被极值绑架，
 *      因此基线用中位数、离散度用 MAD（稳健统计量）。
 *   3. 午休跨 90 分钟，基线窗口不能跨 11:30 → 13:01 取数，否则午后开盘天然
 *      放量会被判为突变。故按交易时段分段独立计算。
 *
 * 算法完全因果：第 i 分钟的判定只使用 i 之前的样本，可直接用于实时预警，
 * 也能原样回放到历史数据上做回测，不存在前视偏差。
 */

/** 可判定时段：剔除集合竞价与零成交分钟 */
export const SESSIONS = [
  { name: 'am', start: '09:31', end: '11:30' },
  { name: 'pm', start: '13:01', end: '14:56' },
];

/**
 * 不参与判定的分钟：
 * 09:30 含开盘集合竞价；13:00 为午休结束的过渡点（多数标的成交为 0）；
 * 14:57 起进入收盘集合竞价，14:58/14:59 常为 0、15:00 一次性撮合巨量，
 * 这三分钟的量级与连续竞价不可比，纳入会造成必然误报。
 */
export const EXCLUDED_MINUTES = new Set(['09:30', '13:00', '14:57', '14:58', '14:59', '15:00']);

export const DEFAULT_PARAMS = Object.freeze({
  /** 局部基线窗口（分钟），不含当前分钟 */
  baselineWindow: 20,
  /** 基线最少样本数，不足则不做判定（开盘头几分钟天然无基线） */
  minBaseline: 8,
  /** 骤增：量能倍数下限 */
  upRatio: 3,
  /** 骤增：稳健 z 下限 */
  upZ: 4,
  /** 骤减：量能倍数上限（当前量 / 基线量） */
  downRatio: 1 / 3,
  /** 骤减：稳健 z 上限（取负向） */
  downZ: 4,
  /** 绝对量门槛系数：门槛 = 当日分钟中位量 × 该系数，过滤地量噪声 */
  absFloorRatio: 0.6,
  /**
   * 绝对成交额下限（元）：单分钟成交额不足此值一律不告警。
   * 相对门槛（absFloorRatio）对地量标的会同步变小，拦不住「10 手变 200 手」这种
   * 倍数惊人但金额无意义的变化，因此必须另设一个与标的无关的绝对下限。
   */
  minAmount: 0,
  /** 连续确认根数：需连续 n 根均越线才成立，抑制单点毛刺 */
  persistBars: 1,
  /**
   * 同波合并间隔（分钟）：相邻两个异动分钟间隔不超过该值即视为同一波行情，
   * 合并为一处标注、一条告警，累计成交额参与强度分级。
   * 0 表示不合并（每个异动分钟各自成条）。
   */
  mergeGapBars: 5,
  /**
   * 短期基线窗口（分钟）与一致性系数。
   *
   * 解决的问题：局部中位数基线在「台阶式」量能变化后会长时间停留在旧水平。
   * 例如开盘 15 分钟放量 8000 手、之后回落到 1000 手，基线要等 8000 的样本
   * 滚出窗口（约 10 分钟）才会更新，这段时间里每一分钟都满足「骤减」条件，
   * 冷却一过就重复告警。
   *
   * 判据：当前量相对「最近 shortWindow 分钟的基线」也必须显著偏离。
   * 若量能已在新水平上平稳运行，短窗与当前量一致，即不再告警——
   * 只保留台阶转折那一根。
   */
  shortWindow: 5,
  shortRatioFloor: 0.5,
  /** 是否检测量能骤减（枯竭） */
  detectDrain: true,
  /**
   * 价格位移确认（%）：该分钟涨跌幅绝对值下限，0 表示不启用。
   * 用途：量能放大但价格纹丝不动的分钟，多为 ETF 申赎、期现对冲或算法拆单，
   * 属于「被动放量」，对判断资金方向没有信息量，回测中这类事件的方向命中率接近随机。
   *
   * 注意：位移只是「确认证据」之一，不是独立否决条件。三条证据（区间突破 /
   * 价格位移 / 收在当分钟极值侧）任一成立即视为有方向，见 requireConfirm。
   */
  minTickPct: 0.1,
  /**
   * 极值收盘确认：收盘价即当分钟最高价（买方吃穿全部卖盘）或最低价，
   * 是「整分钟单向扫单」的直接形态证据，必须带 high/low 才有意义。
   */
  edgeConfirm: true,
  /**
   * 是否丢弃「无任何价格确认」的事件。
   *
   * 默认 false：不丢，只降级为观察级（L1）并在图上标注。
   * 这是 2026-11-02 修订的核心——旧版把区间突破当准入条件，静默丢掉了 57% 的
   * 原始事件，其中包含全天成交额最大的那几分钟（尾盘抢筹、半日收盘封在最高价，
   * 价格根本没离开区间），用户看到「最明显的柱子没有任何标记」。
   * 对资金监控来说「有没有动」比「动得是否漂亮」更重要，宁可弱级标注也不该静默。
   */
  requireConfirm: false,
  /**
   * 兼容开关：true 时退回旧行为——只认「区间突破」，其余一律丢弃。
   * 仅用于复现历史回测，线上用 confirmMode 控制。
   */
  requireRangeBreak: false,
  /**
   * 当日成交额峰值加成：整波累计成交额超过当日此前任何一分钟时，作为独立分档依据。
   *
   *   - 未确认 + 峰值 → 中等级（推送，标注「方向待确认」）
   *   - 已确认 + 峰值 + 强度不弱 → 强等级
   *
   * 为什么需要它：倍数与 z 都是相对量，尾盘连续放量时基线被自己抬高，全天成交额
   * 最大的那一分钟可能只有 4 倍、被判「弱」。而人眼在分时图上看到的就是「最大那根
   * 柱子」。用「当日至今最大」做判据是无标度偏差的：货币 ETF 的申赎巨量在它自己
   * 的序列里同样只是平常的一分钟，不会因此虚升。
   *
   * 因果可用：只用该分钟之前的序列比较，实时判定无需未来信息。
   */
  peakBoost: true,
});

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mad(values, center) {
  if (!values.length) return 0;
  return median(values.map((value) => Math.abs(value - center)));
}

/** 判定某分钟属于哪个可判定时段，不在任何时段内则返回 null */
export function sessionOf(minute) {
  if (EXCLUDED_MINUTES.has(minute)) return null;
  for (const session of SESSIONS) {
    if (minute >= session.start && minute <= session.end) return session.name;
  }
  return null;
}

/**
 * 强度分级：把倍数与稳健 z 归一后加权，输出 1..3 级。
 * 倍数反映「相对自身近期的放量程度」，z 反映「相对波动率的异常程度」，
 * 两者互补：地量时段倍数容易虚高，但 z 不会；持续放量倍数不高，z 会累积。
 */
export function gradeIntensity({ ratio, z }) {
  const strength = Math.abs(Math.log2(Math.max(ratio, 1e-9)));
  const score = (0.6 * Math.min(strength, 5)) / 5 + (0.4 * Math.min(Math.abs(z), 12)) / 12;
  if (score >= 0.8) return { level: 3, label: '强', score };
  if (score >= 0.55) return { level: 2, label: '中', score };
  return { level: 1, label: '弱', score };
}

const LEVEL_LABELS = { 1: '弱', 2: '中', 3: '强' };

/** 确认证据的强弱排序：break > touch > move > edge，none 视为无方向 */
function strongestConfirm(evidence) {
  for (const key of ['break', 'touch', 'move', 'edge']) {
    if (evidence.includes(key)) return key;
  }
  return 'none';
}

/**
 * 主检测函数。
 * @param {Array<{minute:string, close:number, volume:number}>} bars 按分钟升序
 * @returns {{events:Array, stats:object}} events 为按时间升序的突变事件
 */
export function detectVolumeSurge(bars, options = {}) {
  const params = { ...DEFAULT_PARAMS, ...options };
  const rows = Array.isArray(bars) ? bars : [];

  // 当日分钟中位量：绝对量门槛的锚。只统计可判定时段，避免集合竞价巨量拉高门槛。
  const tradable = rows.filter((bar) => sessionOf(bar.minute) && Number(bar.volume) > 0);
  const dayMedian = median(tradable.map((bar) => Number(bar.volume)));
  const absFloor = dayMedian * params.absFloorRatio;

  const raw = [];
  const skipped = [];

  // 成交额的「当日至今最大值」（不含当前分钟）：峰值加成用它做判据，天然因果。
  const amountPrefixMax = new Array(rows.length).fill(0);
  let runningMaxAmount = 0;
  for (let i = 0; i < rows.length; i += 1) {
    amountPrefixMax[i] = runningMaxAmount;
    const current = Number(rows[i].amount);
    if (Number.isFinite(current) && current > runningMaxAmount) runningMaxAmount = current;
  }

  for (let i = 0; i < rows.length; i += 1) {
    const bar = rows[i];
    const minute = bar.minute;
    const session = sessionOf(minute);

    if (!session) {
      skipped.push({ minute, reason: '非连续竞价时段' });
      continue;
    }

    const volume = Number(bar.volume);
    if (!Number.isFinite(volume) || volume <= 0) {
      skipped.push({ minute, reason: '无成交' });
      continue;
    }

    if (params.minAmount > 0) {
      const amount = Number(bar.amount);
      if (!(amount >= params.minAmount)) {
        skipped.push({ minute, reason: `成交额不足(${Number.isFinite(amount) ? Math.round(amount) : '—'})` });
        continue;
      }
    }

    // 段内向前取基线，绝不跨午休、不跨出可判定区间
    const window = [];
    for (let j = i - 1; j >= 0 && window.length < params.baselineWindow; j -= 1) {
      const prev = rows[j];
      if (sessionOf(prev.minute) !== session) break;
      const prevVolume = Number(prev.volume);
      if (!Number.isFinite(prevVolume) || prevVolume <= 0) continue;
      window.push(prevVolume);
    }

    if (window.length < params.minBaseline) {
      skipped.push({ minute, reason: `基线样本不足(${window.length})` });
      continue;
    }

    const baseline = median(window);
    const spread = Math.max(mad(window, baseline) * 1.4826, baseline * 0.15, 1e-6);
    const ratio = volume / Math.max(baseline, 1e-6);
    const z = (volume - baseline) / spread;

    let direction = null;
    if (ratio >= params.upRatio && z >= params.upZ && volume >= absFloor) direction = 'surge';
    else if (
      params.detectDrain &&
      ratio <= params.downRatio &&
      z <= -params.downZ &&
      baseline >= absFloor
    ) {
      direction = 'drain';
    }
    if (!direction) continue;

    // 短期一致性：量能已稳定在新水平时不再重复告警，只保留台阶转折点
    if (params.shortWindow > 0 && params.shortRatioFloor > 0) {
      const shortWindow = [];
      for (let j = i - 1; j >= 0 && shortWindow.length < params.shortWindow; j -= 1) {
        if (sessionOf(rows[j].minute) !== session) break;
        const prevVolume = Number(rows[j].volume);
        if (Number.isFinite(prevVolume) && prevVolume > 0) shortWindow.push(prevVolume);
      }
      if (shortWindow.length >= Math.min(3, params.shortWindow)) {
        const shortRatio = volume / Math.max(median(shortWindow), 1e-6);
        if (direction === 'surge' && shortRatio < params.upRatio * params.shortRatioFloor) continue;
        if (direction === 'drain' && shortRatio > Math.min(1, params.downRatio / params.shortRatioFloor)) continue;
      }
    }

    // ---------------- 价格确认：三条证据任一成立即视为「有方向」
    //
    // 旧版把「区间突破」当硬门槛，代价是 57% 的原始事件被静默丢弃。实盘里最典型的
    // 漏报是：尾盘连续放量时基线被自己抬高，价格在区间内贴着上沿反复承接，全天
    // 成交额最大的那几分钟既没有创新高也没有位移，于是全部消失。
    const prevClose = Number(rows[i - 1]?.close);
    const price = Number(bar.close);
    const tickRet = Number.isFinite(prevClose) && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;
    const barHigh = Number(bar.high);
    const barLow = Number(bar.low);

    const priorCloses = [];
    for (let j = i - 1; j >= 0 && priorCloses.length < params.baselineWindow; j -= 1) {
      if (sessionOf(rows[j].minute) !== session) break;
      const prevValue = Number(rows[j].close);
      if (Number.isFinite(prevValue) && prevValue > 0) priorCloses.push(prevValue);
    }

    const evidence = [];
    let priceDir = null;

    // 证据一：区间突破。ETF 最小变动价位 0.001 元，20 分钟区间常常只有 3~7 个跳动，
    // 「收在最高价、与前一高点持平」是一分不破的封板式抢筹，旧版用严格大于把它判成
    // 未突破（159259 的 11:30 就是 close = priorMax = 当日最高 0.921，量能 6.8 倍被丢）。
    // 因此把「等于前极值且报收在该极值」单独记为 touch，强度略低于真正突破。
    if (priorCloses.length >= params.minBaseline) {
      const priorMax = Math.max(...priorCloses);
      const priorMin = Math.min(...priorCloses);
      const atHigh = Number.isFinite(barHigh) && barHigh === price;
      const atLow = Number.isFinite(barLow) && barLow === price;
      if (price > priorMax) {
        evidence.push('break');
        priceDir = 'up';
      } else if (price < priorMin) {
        evidence.push('break');
        priceDir = 'down';
      } else if (price === priorMax && atHigh) {
        evidence.push('touch');
        priceDir = 'up';
      } else if (price === priorMin && atLow) {
        evidence.push('touch');
        priceDir = 'down';
      }
    }

    // 证据二：价格位移。跌 0.33% 的放量下跌同样是有方向的异动（承接被砸），
    // 不该因为「没创区间新低」而丢掉。
    if (priceDir === null && params.minTickPct > 0 && tickRet !== null && Math.abs(tickRet) >= params.minTickPct) {
      evidence.push('move');
      priceDir = tickRet > 0 ? 'up' : 'down';
    }

    // 证据三：收在当分钟极值侧。整分钟单向扫单的直接形态证据：买方吃穿全部卖盘时
    // 收盘价必然等于最高价。缺 high/low 的样本自动跳过这一条。
    if (
      priceDir === null &&
      params.edgeConfirm &&
      Number.isFinite(barHigh) &&
      Number.isFinite(barLow) &&
      barHigh > barLow
    ) {
      if (price === barHigh) {
        evidence.push('edge');
        priceDir = 'up';
      } else if (price === barLow) {
        evidence.push('edge');
        priceDir = 'down';
      }
    }

    // 方向是否与量能同向：放量上涨（攻击）与放量下跌（承接被砸）都值得报，
    // 但只有同向才算「资金进攻」，反向要降级处理。
    const align =
      priceDir === null ? null : direction === 'surge' ? priceDir === 'up' : priceDir === 'down';

    if (params.requireRangeBreak && !evidence.includes('break')) {
      skipped.push({ minute, reason: '未突破前 20 分钟极值（严格模式）' });
      continue;
    }

    if (params.requireConfirm && evidence.length === 0) {
      skipped.push({ minute, reason: `无价格确认（区间内堆量且位移<${params.minTickPct}%）` });
      continue;
    }

    // 连续确认：向前看 persistBars-1 根是否同向越线（回测时这是事后信息，
    // 但实时场景下等价于「延迟 persistBars-1 分钟确认」，故仍属可实盘化逻辑）
    if (params.persistBars > 1) {
      let confirmed = 0;
      for (let k = 1; k < params.persistBars; k += 1) {
        const next = rows[i + k];
        if (!next || sessionOf(next.minute) !== session) break;
        const nextVolume = Number(next.volume) || 0;
        const ok = direction === 'surge' ? nextVolume >= baseline * params.upRatio : nextVolume <= baseline * params.downRatio;
        if (ok) confirmed += 1;
      }
      if (confirmed < params.persistBars - 1) continue;
    }

    // 强度分级：三个维度（相对倍数 / 稳健 z / 绝对成交额）。
    // 单根先不评级——同一波行情里的连续放量会合并成「一件事」后整体重算。
    const confirm = strongestConfirm(evidence);

    raw.push({
      index: i,
      minute,
      session,
      direction,
      volume,
      amount: Number.isFinite(Number(bar.amount)) ? Number(bar.amount) : null,
      baseline,
      ratio,
      z,
      price,
      tickRet,
      priceDir,
      align,
      confirm,
      evidence,
      /** 该分钟量占当日可判定时段总量的比例，用于衡量单分钟冲击的绝对量级 */
      volumeShare: null,
    });
  }

  // ---------------- 合并成波
  //
  // 同一波行情里逐分钟越线，对看盘的人只是一件事：13:26 到 13:36 连续 4 根爆量，
  // 画 4 个标记只会把真正的拐点淹掉。这里按「相邻事件间隔 ≤ mergeGapBars」聚成一波，
  // 波峰根（放量倍数最大者）作为标注位置，整波累计成交额参与强度分级。
  // 这与秒级 tickImpulse 的 episode 合并是同一套思路，两个通道的呈现保持一致。
  const clusters = [];
  for (const item of raw) {
    const prev = clusters[clusters.length - 1];
    const last = prev ? prev[prev.length - 1] : null;
    if (last && item.direction === last.direction && item.index - last.index <= params.mergeGapBars) {
      prev.push(item);
    } else {
      clusters.push([item]);
    }
  }

  const events = [];
  for (const cluster of clusters) {
    const rep = cluster.reduce((best, item) => (item.ratio > best.ratio ? item : best), cluster[0]);
    const sumAmount = cluster.reduce((sum, item) => sum + (item.amount ?? 0), 0);
    const graded = gradeIntensity({ ratio: rep.ratio, z: rep.z });

    // 双轨分级（依据 2026-10-30 / 11-02 两日实测方向命中率，见 reports/volume-surge-backtest.md）：
    //
    //   有突破确认            → 按量能强度 L1~L3       命中 54~59%
    //   无确认但当日成交额峰值 → 固定 L2                 命中 55~59%
    //   无确认且非峰值        → L1，只在图上标注         命中 47%（等同随机）
    //
    // 「当日峰值」这一档是专门为「最大那根柱子」加的：它没有突破区间，但金额规模
    // 本身就是信息（1448 万单分钟、全天之最），误报代价远低于漏报。
    const confirmed = rep.confirm === 'break' || rep.confirm === 'touch';
    // 「当日峰值」按整波累计额判定：这一波成交的钱比今天此前任何一分钟都多。
    // 用单根比较会漏掉「连续 4 根 500 万」这种总量更大、但单根不显眼的波次。
    const dayPeak =
      params.peakBoost &&
      rep.direction === 'surge' &&
      sumAmount > 0 &&
      sumAmount >= amountPrefixMax[cluster[0].index];

    let level;
    if (confirmed) {
      // 突破 + 当日成交额峰值 = 强：两日回测方向命中 64%/65%，是唯一值得即时推送的组合。
      // 旧口径下「强」只靠倍数（57%），倍数高并不等于方向对。
      level = dayPeak ? 3 : graded.level;
    } else {
      level = dayPeak ? 2 : 1;
    }

    // 量能方向与价格方向相反（放量下跌）降一级：那是承接被砸，不是资金进攻
    if (rep.align === false) level = Math.max(1, level - 1);

    events.push({
      ...rep,
      score: graded.score,
      level,
      levelLabel: LEVEL_LABELS[level],
      /** 是否有价格突破确认（break/touch）：决定能否进入强级与即时推送 */
      confirmed,
      /** 该分钟成交额是否创当日至今新高（当日最大那根柱子） */
      dayPeak,
      /** 整波累计成交额（元），仅作展示与回溯，不参与分级 */
      sumAmount: sumAmount || null,
      /** 本波包含的爆量分钟数，1 表示孤立单根 */
      mergedBars: cluster.length,
      spanFrom: cluster[0].minute,
      spanTo: cluster[cluster.length - 1].minute,
    });
  }

  const totalVolume = tradable.reduce((sum, bar) => sum + Number(bar.volume), 0);
  for (const event of events) {
    event.volumeShare = totalVolume > 0 ? event.volume / totalVolume : null;
  }

  const confirmCounts = { break: 0, touch: 0, move: 0, edge: 0, none: 0 };
  const levelCounts = { 1: 0, 2: 0, 3: 0 };
  for (const event of events) {
    confirmCounts[event.confirm] += 1;
    levelCounts[event.level] += 1;
  }

  return {
    events,
    stats: {
      bars: rows.length,
      tradableBars: tradable.length,
      dayMedian,
      absFloor,
      eventCount: events.length,
      surgeCount: events.filter((event) => event.direction === 'surge').length,
      drainCount: events.filter((event) => event.direction === 'drain').length,
      skipped: skipped.length,
      confirmCounts,
      levelCounts,
    },
  };
}

export { median, mad };
