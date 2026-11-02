import { config } from '../config/index.js';
import { upstream } from '../lib/errors.js';
import { getText } from '../lib/httpClient.js';

/**
 * 腾讯行情快照源，专门服务「秒级通道」。
 *
 * 为什么不是东财：东财 ulist 每轮要拼 40 个 secid、返回带资金流明细，单次 ~30KB，
 * 全市场分钟级轮询已经把它压得很紧；秒级再用它会把两条链路一起拖垮。
 * 腾讯这个接口一次可带 15+ 标的，返回约 2KB，且自带外盘/内盘（主动买卖的近似口径）
 * 与一档盘口，正好是秒级判断「是不是有人在扫单」需要的字段。
 *
 * 注意：接口返回 GBK 编码，中文名称经 UTF-8 解码后是乱码。
 * 本项目一律以本地库里的名称为准，因此只解析数字字段，不依赖名称。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const FAST_BASE = 'https://qt.gtimg.cn/q=';

/** 独立熔断：秒级链路失败不应影响到分钟级与分时回填 */
const THRESHOLD = 3;
const COOLDOWN_MS = 60000;
const breaker = { failures: 0, openUntil: 0, lastError: null, lastSuccessAt: 0 };

export function isFastBreakerOpen() {
  return Date.now() < breaker.openUntil;
}

export function getFastBreakerState() {
  return {
    open: Date.now() < breaker.openUntil,
    openUntil: breaker.openUntil,
    failures: breaker.failures,
    threshold: THRESHOLD,
    cooldownMs: COOLDOWN_MS,
    lastError: breaker.lastError,
    lastSuccessAt: breaker.lastSuccessAt,
  };
}

function recordSuccess() {
  breaker.failures = 0;
  breaker.openUntil = 0;
  breaker.lastError = null;
  breaker.lastSuccessAt = Date.now();
}

function recordFailure(error) {
  breaker.failures += 1;
  breaker.lastError = error?.message ?? 'unknown';
  if (breaker.failures >= THRESHOLD) breaker.openUntil = Date.now() + COOLDOWN_MS;
}

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

/** 上游时间戳 20261030161447 → 毫秒（北京时间） */
export function parseQuoteTime(text) {
  if (!/^\d{14}$/.test(String(text ?? ''))) return null;
  const raw = String(text);
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(8, 10));
  const minute = Number(raw.slice(10, 12));
  const second = Number(raw.slice(12, 14));
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 3600 * 1000;
}

/**
 * 解析单行 `v_sh510300="1~名称~510300~4.065~4.111~...";`
 * 字段定义（0 基）：
 *   2 代码 / 3 现价 / 4 昨收 / 5 今开 / 6 累计成交量(手) / 7 外盘 / 8 内盘
 *   9 买一价 / 10 买一量 / 19 卖一价 / 20 卖一量
 *   30 快照时间 / 32 涨跌幅 / 33 最高 / 34 最低
 *   35 "现价/成交量/成交额(元)" / 37 成交额(万元)
 */
export function parseFastQuoteLine(line) {
  const text = String(line ?? '');
  const eq = text.indexOf('="');
  if (eq === -1) return null;
  const body = text.slice(eq + 2).replace(/"?;?\s*$/, '');
  const f = body.split('~');
  if (f.length < 40) return null;

  const code = f[2];
  if (!/^\d{6}$/.test(code ?? '')) return null;

  const price = toNumber(f[3]);
  if (!price || price <= 0) return null; // 停牌或无效快照

  const ts = parseQuoteTime(f[30]);
  const volume = toNumber(f[6]);
  const outer = toNumber(f[7]);
  const inner = toNumber(f[8]);
  const bid1Vol = toNumber(f[10]);
  const ask1Vol = toNumber(f[20]);

  // 成交额优先取「现价/量/额」三元组的第三段（元，精度最高），退化为 f[37]（万元）
  let amount = null;
  const triple = String(f[35] ?? '').split('/');
  if (triple.length >= 3) amount = toNumber(triple[2]);
  if (!Number.isFinite(amount) || amount === null) {
    const wan = toNumber(f[37]);
    amount = wan === null ? null : wan * 10_000;
  }

  const imba =
    Number.isFinite(bid1Vol) && Number.isFinite(ask1Vol) && bid1Vol + ask1Vol > 0
      ? (bid1Vol - ask1Vol) / (bid1Vol + ask1Vol)
      : null;

  return {
    code,
    ts,
    price,
    preClose: toNumber(f[4]),
    open: toNumber(f[5]),
    high: toNumber(f[33]),
    low: toNumber(f[34]),
    pctChg: toNumber(f[32]),
    volume,
    amount,
    outer,
    inner,
    bid1: toNumber(f[9]),
    ask1: toNumber(f[19]),
    bid1Vol,
    ask1Vol,
    imba,
    source: 'tencent',
  };
}

export function parseFastQuoteText(text) {
  const rows = [];
  for (const line of String(text ?? '').split(';')) {
    const parsed = parseFastQuoteLine(line);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

/**
 * 批量秒级快照。
 * @param {Array<{code: string, market: number}>} refs
 */
export async function fetchFastQuotes(refs) {
  const valid = (refs ?? []).filter((item) => /^\d{6}$/.test(item.code ?? ''));
  if (valid.length === 0) return { rows: [], latencyMs: 0 };

  if (isFastBreakerOpen()) {
    throw upstream('秒级行情源熔断中', {
      reason: 'circuit_open',
      scope: 'fast',
      retryAfterMs: breaker.openUntil - Date.now(),
    });
  }

  const symbols = valid.map((item) => `${item.market === 1 ? 'sh' : 'sz'}${item.code}`).join(',');
  const url = `${FAST_BASE}${symbols}`;
  const startedAt = Date.now();

  try {
    const text = await getText(url, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      timeoutMs: config.fastTick.requestTimeoutMs,
    });
    const rows = valid.length === 1 ? [parseFastQuoteLine(text)].filter(Boolean) : parseFastQuoteText(text);
    if (rows.length === 0) {
      throw upstream('秒级行情返回空数据', { reason: 'empty', scope: 'fast' });
    }
    recordSuccess();
    return { rows, latencyMs: Date.now() - startedAt };
  } catch (error) {
    recordFailure(error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 分钟级快照备源
// ---------------------------------------------------------------------------

/**
 * 分钟级备源用它自己的熔断档。
 *
 * 复用 'fast' 那一个会让两件事耦合：分钟级被限流熔断后，秒级通道会跟着停摆，
 * 反之亦然。两条链路的上游压力完全不同，必须分开计失败次数。
 */
const minuteBreaker = { failures: 0, openUntil: 0, lastError: null, lastSuccessAt: 0 };

export function isMinuteBreakerOpen() {
  return Date.now() < minuteBreaker.openUntil;
}

export function getMinuteBreakerState() {
  return {
    open: Date.now() < minuteBreaker.openUntil,
    openUntil: minuteBreaker.openUntil,
    failures: minuteBreaker.failures,
    threshold: THRESHOLD,
    cooldownMs: COOLDOWN_MS,
    lastError: minuteBreaker.lastError,
    lastSuccessAt: minuteBreaker.lastSuccessAt,
  };
}

function minuteRecordSuccess() {
  minuteBreaker.failures = 0;
  minuteBreaker.openUntil = 0;
  minuteBreaker.lastError = null;
  minuteBreaker.lastSuccessAt = Date.now();
}

function minuteRecordFailure(error) {
  minuteBreaker.failures += 1;
  minuteBreaker.lastError = error?.message ?? 'unknown';
  if (minuteBreaker.failures >= THRESHOLD) minuteBreaker.openUntil = Date.now() + COOLDOWN_MS;
}

/**
 * 把腾讯逐笔快照折算成「与东财同构」的行情行。
 *
 * 关键换算：`(外盘 − 内盘) × 100 × 现价`。
 * 外盘/内盘是当日累计的主动买/卖手数，因此这个差值天然就是**当日累计主动净买入额**，
 * 与东财 f62（当日累计主力净流入）在形态与量纲上一致，可以直接顶到 mainNet 字段上，
 * 下游全部指标（窗口净额、连续流入、量比…）不需要改。
 *
 * 口径差异必须说清楚：东财的「主力」= 大单 + 超大单；这里的「主动净买」= 全部主动买 − 全部主动卖。
 * 后者包含中小单，数值通常比主力口径略大，方向一致。数据源标识会带出去，前端据此标注。
 */
export function toMinuteQuoteRow(parsed, market) {
  if (!parsed || !/^\d{6}$/.test(parsed.code ?? '')) return null;
  const { price } = parsed;
  if (!(price > 0)) return null;

  const hasFlow = Number.isFinite(parsed.outer) && Number.isFinite(parsed.inner);
  const net = hasFlow ? (parsed.outer - parsed.inner) * 100 * price : null;

  return {
    code: parsed.code,
    market,
    name: null, // 腾讯返回 GBK 名称，解码后是乱码；名称一律沿用库内既有值
    price,
    pctChg: parsed.pctChg ?? 0,
    turnover: parsed.amount ?? 0,
    mainNet: net,
    mainRatio: null,
    superNet: null,
    bigNet: null,
    midNet: null,
    smallNet: null,
    quoteTs: parsed.ts ?? null,
    outer: parsed.outer,
    inner: parsed.inner,
  };
}

const MINUTE_BATCH_SIZE = 50;

/**
 * 批量分钟级快照（备源）。
 *
 * 一次最多 50 个代码，URL 约 500 字符；超过就分批，避免请求行过长被网关拒绝。
 * @param {Array<{code: string, market: number}>} refs
 */
export async function fetchMinuteQuotes(refs) {
  const valid = (refs ?? []).filter((item) => /^\d{6}$/.test(item.code ?? ''));
  if (valid.length === 0) return [];

  if (isMinuteBreakerOpen()) {
    throw upstream('分钟级备源熔断中', {
      reason: 'circuit_open',
      scope: 'tencent-minute',
      retryAfterMs: minuteBreaker.openUntil - Date.now(),
    });
  }

  const rows = [];
  for (let start = 0; start < valid.length; start += MINUTE_BATCH_SIZE) {
    const batch = valid.slice(start, start + MINUTE_BATCH_SIZE);
    const symbols = batch.map((item) => `${item.market === 1 ? 'sh' : 'sz'}${item.code}`).join(',');
    try {
      const text = await getText(`${FAST_BASE}${symbols}`, {
        headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
        timeoutMs: config.requestTimeoutMs,
      });
      const parsedRows = batch.length === 1 ? [parseFastQuoteLine(text)].filter(Boolean) : parseFastQuoteText(text);
      const marketByCode = new Map(batch.map((item) => [item.code, item.market]));
      for (const parsed of parsedRows) {
        const row = toMinuteQuoteRow(parsed, marketByCode.get(parsed.code) ?? 0);
        if (row) rows.push(row);
      }
    } catch (error) {
      minuteRecordFailure(error);
      throw error;
    }
  }

  if (rows.length === 0) {
    const empty = upstream('分钟级备源返回空数据', { reason: 'empty', scope: 'tencent-minute' });
    minuteRecordFailure(empty);
    throw empty;
  }
  minuteRecordSuccess();
  return rows;
}
