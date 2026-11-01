import { shanghaiParts } from './time.js';

const pad = (value) => String(value).padStart(2, '0');

/** 金额格式化：自动切换 亿 / 万 / 元，带正负号 */
export function formatAmount(yuan, { sign = true } = {}) {
  if (yuan === null || yuan === undefined || Number.isNaN(Number(yuan))) return '—';
  const value = Number(yuan);
  const abs = Math.abs(value);
  const prefix = sign ? (value > 0 ? '+' : value < 0 ? '-' : '') : value < 0 ? '-' : '';
  if (abs >= 1e8) return `${prefix}${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${prefix}${(abs / 1e4).toFixed(1)}万`;
  return `${prefix}${abs.toFixed(0)}元`;
}

export function formatPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num.toFixed(digits)}%`;
}

/** 北京时间 YYYY-MM-DD HH:mm:ss */
export function formatDateTime(timestamp) {
  const { year, month, day, hour, minute, second } = shanghaiParts(timestamp);
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

export function formatClock(timestamp) {
  const { hour, minute } = shanghaiParts(timestamp);
  return `${pad(hour)}:${pad(minute)}`;
}

/** 北京时间的时分秒，秒级告警需要精确到秒 */
export function formatHms(timestamp) {
  const { hour, minute, second } = shanghaiParts(timestamp);
  return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
}
