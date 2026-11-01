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
  /** 同一标的冷却分钟数 */
  cooldownBars: 5,
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
   */
  minTickPct: 0,
  /**
   * 区间突破确认：要求该分钟收盘价同向突破前 baselineWindow 分钟的极值。
   * 用途：区分「主动扫单打穿盘口」与「区间内堆量」。前者意味着承接被吃穿，
   * 后续更容易延续；后者往往只是换手放大。
   */
  requireRangeBreak: false,
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
  const score = 0.6 * Math.min(strength, 5) / 5 + 0.4 * Math.min(Math.abs(z), 12) / 12;
  if (score >= 0.8) return { level: 3, label: '强', score };
  if (score >= 0.55) return { level: 2, label: '中', score };
  return { level: 1, label: '弱', score };
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

  const events = [];
  const skipped = [];
  let lastEventIndex = -Infinity;

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

    // 价格确认：把「有方向的主动放量」从「无方向的被动放量」里分出来
    const prevClose = Number(rows[i - 1]?.close);
    const price = Number(bar.close);
    const tickRet = Number.isFinite(prevClose) && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;

    if (params.minTickPct > 0) {
      if (tickRet === null || Math.abs(tickRet) < params.minTickPct) {
        skipped.push({ minute, reason: `价格位移不足(${tickRet === null ? '—' : tickRet.toFixed(3)}%)` });
        continue;
      }
    }

    if (params.requireRangeBreak) {
      if (tickRet === null || tickRet === 0) {
        skipped.push({ minute, reason: '价格无方向' });
        continue;
      }
      const priorCloses = [];
      for (let j = i - 1; j >= 0 && priorCloses.length < params.baselineWindow; j -= 1) {
        if (sessionOf(rows[j].minute) !== session) break;
        const value = Number(rows[j].close);
        if (Number.isFinite(value) && value > 0) priorCloses.push(value);
      }
      if (priorCloses.length < params.minBaseline) {
        skipped.push({ minute, reason: '区间样本不足' });
        continue;
      }
      const breaks = tickRet > 0 ? price > Math.max(...priorCloses) : price < Math.min(...priorCloses);
      if (!breaks) {
        skipped.push({ minute, reason: '区间内堆量未突破' });
        continue;
      }
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

    if (i - lastEventIndex < params.cooldownBars) {
      skipped.push({ minute, reason: '冷却期内' });
      continue;
    }

    const { level, label, score } = gradeIntensity({ ratio, z });

    events.push({
      index: i,
      minute,
      session,
      direction,
      volume,
      baseline,
      ratio,
      z,
      score,
      level,
      levelLabel: label,
      price,
      tickRet,
      /** 该分钟量占当日可判定时段总量的比例，用于衡量单分钟冲击的绝对量级 */
      volumeShare: null,
    });

    lastEventIndex = i;
  }

  const totalVolume = tradable.reduce((sum, bar) => sum + Number(bar.volume), 0);
  for (const event of events) {
    event.volumeShare = totalVolume > 0 ? event.volume / totalVolume : null;
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
    },
  };
}

export { median, mad };
