export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

const pad = (value) => String(value).padStart(2, '0');

/** 金额缩写：亿 / 万 / 元，带正负号 */
export function fmtAmount(yuan, { sign = true, digits } = {}) {
  if (yuan === null || yuan === undefined || Number.isNaN(Number(yuan))) return '—';
  const value = Number(yuan);
  const abs = Math.abs(value);
  const prefix = value > 0 ? (sign ? '+' : '') : value < 0 ? '-' : '';
  const precision = digits ?? (abs >= 1e8 ? 2 : 1);
  if (abs >= 1e8) return `${prefix}${(abs / 1e8).toFixed(precision)}亿`;
  if (abs >= 1e4) return `${prefix}${(abs / 1e4).toFixed(precision)}万`;
  return `${prefix}${abs.toFixed(0)}元`;
}

export function fmtSignedPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num.toFixed(digits)}%`;
}

export function fmtPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${Number(value).toFixed(digits)}%`;
}

export function fmtInt(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('zh-CN');
}

/**
 * 告警实测值格式化：不同指标单位差异很大（元 / % / 倍），
 * 统一走这里，避免各处 if-else 判断指标名。
 */
export function fmtMetricValue(metric, value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  if (metric === 'main_net_ratio') return `${Number(value).toFixed(digits)}%`;
  if (metric === 'volume_surge') return `${Number(value).toFixed(digits)}×`;
  if (metric === 'main_net_rate') return `${fmtAmount(value, { sign: false })}/分钟`;
  return fmtAmount(value);
}

export function fmtClock(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function fmtMinute(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fmtDate(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function fmtDateTime(timestamp) {
  if (!timestamp) return '—';
  return `${fmtDate(timestamp)} ${fmtClock(timestamp)}`;
}

/** 数值正负对应的样式类（中国习惯：红涨绿跌） */
export function signClass(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'num-flat';
  const num = Number(value);
  if (num > 0) return 'num-in';
  if (num < 0) return 'num-out';
  return 'num-flat';
}

export function debounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
