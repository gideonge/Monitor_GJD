const TZ = 'Asia/Shanghai';

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

/** 返回北京时间（UTC+8）的日期时间分量 */
export function shanghaiParts(timestamp = Date.now()) {
  const parts = partsFormatter.formatToParts(new Date(timestamp));
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
    second: Number(pick('second')),
    weekday: pick('weekday'),
  };
}

const pad = (value) => String(value).padStart(2, '0');

/** 北京时间交易日字符串 YYYY-MM-DD */
export function tradeDateOf(timestamp = Date.now()) {
  const { year, month, day } = shanghaiParts(timestamp);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** 交易日内分钟序号（0-1440） */
function minuteOfDay(timestamp) {
  const { hour, minute } = shanghaiParts(timestamp);
  return hour * 60 + minute;
}

const WEEKEND = new Set(['Sat', 'Sun']);

/**
 * 市场阶段：
 * pre_open 集合竞价 | trading 连续竞价 | lunch_break 午间休市
 * closing 收盘集合竞价 | closed 非交易时段 | weekend 周末
 */
export function marketPhase(timestamp = Date.now()) {
  const { weekday } = shanghaiParts(timestamp);
  if (WEEKEND.has(weekday)) return 'weekend';
  const minutes = minuteOfDay(timestamp);
  if (minutes < 555) return 'closed';
  if (minutes < 570) return 'pre_open';
  if (minutes < 690) return 'trading';
  if (minutes < 780) return 'lunch_break';
  if (minutes < 900) return 'trading';
  if (minutes < 930) return 'closing';
  return 'closed';
}

export function isTradingTime(timestamp = Date.now()) {
  return marketPhase(timestamp) === 'trading';
}

export const PHASE_LABEL = {
  pre_open: '集合竞价',
  trading: '交易中',
  lunch_break: '午间休市',
  closing: '收盘竞价',
  closed: '已收盘',
  weekend: '休市（周末）',
};

/** 将交易日 + 收盘时间（15:00）转换为时间戳，用于把日度告警落到真实触发时刻 */
export function tradeDateCloseTs(tradeDate) {
  const [year, month, day] = tradeDate.split('-').map(Number);
  // 北京时间 15:00 = UTC 07:00
  return Date.UTC(year, month - 1, day, 7, 0, 0, 0);
}

export function toIso(timestamp) {
  return new Date(timestamp).toISOString();
}

/** 交易日 00:00（北京时间）对应的时间戳 */
export function tradeDateStartTs(tradeDate) {
  const [year, month, day] = tradeDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0) - 8 * 3600 * 1000;
}

/** 今日 00:00（北京时间） */
export function todayStartTs(timestamp = Date.now()) {
  return tradeDateStartTs(tradeDateOf(timestamp));
}

/**
 * 「当前这批数据」的统计窗口起点：今日 0 点与最近交易日 0 点的较早者。
 *
 * 日度告警的 triggeredAt 落在交易日 15:00，所以第二天开盘前如果只取今日 0 点，
 * 昨天收盘那批日度告警会整批从「告警数」里消失。这个口径原先写死在
 * etfController.overview 里，告警历史页另算一套，导致同一屏出现两个数（徽标 204、
 * 列表 5680）。收敛到这里，谁要统计「当日」都调它，不再各算各的。
 */
export function recentSessionStart({ todayStart, lastTradeDate } = {}) {
  if (!lastTradeDate) return todayStart;
  return Math.min(todayStart, tradeDateStartTs(lastTradeDate));
}

/** 交易日 + 北京时间 HH:MM → 毫秒时间戳 */
export function beijingTs(tradeDate, hhmm) {
  const [year, month, day] = tradeDate.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0) - 8 * 3600 * 1000;
}

/** 该交易日是否已经收盘（交易日早于今天，或今天已过 15:00 且不是周末） */
export function isTradeDateClosed(tradeDate, timestamp = Date.now()) {
  const today = tradeDateOf(timestamp);
  if (tradeDate < today) return true;
  if (tradeDate > today) return false;
  const { weekday } = shanghaiParts(timestamp);
  if (WEEKEND.has(weekday)) return true;
  return minuteOfDay(timestamp) >= 900;
}
