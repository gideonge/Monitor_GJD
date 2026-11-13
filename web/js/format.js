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
  if (metric === 'volume_surge' || metric === 'volume_preburst') return `${Number(value).toFixed(digits)}×`;
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

/**
 * 实测值没有方向的指标：它们是「倍数」，正负不代表资金进出。
 * 与服务端 METRICS 中 volume_surge / volume_preburst 的取值口径对应。
 */
const DIRECTIONLESS_METRICS = new Set(['volume_surge', 'volume_preburst']);

/**
 * 涨跌幅低于这个值就当「没动」。
 * 卡片上的涨跌幅按 2 位小数展示，0.004% 会显示成 +0.00%：
 * 用这种精度以下的数去决定红绿，等于让一个看不见的数字决定颜色。
 */
const FLAT_MOVE_PCT = 0.005;

/**
 * 告警卡片底色与左侧色条的方向判定，返回 { dir, evidence }。
 *
 * 红 = 正向（净流入 / 价格向上），绿 = 负向（净流出 / 价格向下）。
 * 颜色只承接方向、不承接级别：级别一旦压在颜色上，「高」级别的流出
 * 就会被画成红色系，方向被读反。
 *
 * 证据优先级：
 *   资金类指标 → value 的正负；
 *   量能类指标 → 该分钟涨跌幅；没动（含低于显示精度）时退到主动净买额；
 *   两者都拿不到 → 无方向，保持中性。
 * evidence 用于卡片上标注颜色依据（+0.35% / 净买 3200万），
 * 避免出现「卡片变红了但看不出为什么」。
 */
export function alertDirection({ metric, value, priceMovePct = null, netFlow = null }) {
  if (!DIRECTIONLESS_METRICS.has(metric)) {
    const num = Number(value);
    if (!Number.isFinite(num) || num === 0) return { dir: 'dir-none', evidence: null };
    return { dir: num > 0 ? 'dir-in' : 'dir-out', evidence: 'flow' };
  }

  const move = Number(priceMovePct);
  if (Number.isFinite(move) && Math.abs(move) >= FLAT_MOVE_PCT) {
    return { dir: move > 0 ? 'dir-in' : 'dir-out', evidence: 'price' };
  }

  const net = Number(netFlow);
  if (Number.isFinite(net) && net !== 0) {
    return { dir: net > 0 ? 'dir-in' : 'dir-out', evidence: 'net' };
  }

  return { dir: 'dir-none', evidence: null };
}

/** 只取方向类名的简写，列表/图表等处不必关心证据类型 */
export function flowDirectionClass(metric, value, priceMovePct = null, netFlow = null) {
  return alertDirection({ metric, value, priceMovePct, netFlow }).dir;
}

/**
 * 告警流的排序：触发时间倒序，同一时刻按 id 倒序。
 *
 * 不能按「到达顺序」排：量能类告警是整分钟 K 线收完后批量扫描出来的，
 * 14:57 扫描时才产出 14:55 那条，到达顺序与触发时间天然不一致。
 * 直接往前插就会出现「14:47 在 14:55 上面」这种看着像乱序的列表。
 */
export function compareAlertsDesc(a, b) {
  const ta = Number(a.triggeredAt) || 0;
  const tb = Number(b.triggeredAt) || 0;
  if (ta !== tb) return tb - ta;
  return (Number(b.id) || 0) - (Number(a.id) || 0);
}

/**
 * 把一条告警插进已按触发时间倒序的列表，返回新列表与插入位置。
 *
 * - 同一 id 重复推送（SSE 的 hello 快照与后续事件可能重叠）直接忽略，index 返回 -1
 * - 超出 limit 时丢弃列表末尾最旧的一条，避免长跑后无限增长
 */
export function insertAlertSorted(items, alert, limit = 30) {
  if (items.some((item) => item.id === alert.id)) return { items, index: -1 };
  const found = items.findIndex((item) => compareAlertsDesc(alert, item) < 0);
  const index = found === -1 ? items.length : found;
  const next = [...items.slice(0, index), alert, ...items.slice(index)].slice(0, limit);
  return { items: next, index: index < limit ? index : -1 };
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
