import { config } from '../config/index.js';
import { upstream } from '../lib/errors.js';
import { sleep } from '../lib/concurrency.js';
import { beijingTs } from '../lib/time.js';
import { getText } from '../lib/httpClient.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const QUOTE_FIELDS = 'f2,f3,f6,f12,f13,f14,f62,f184,f66,f72,f78,f84,f124';
const FLOW_FIELDS = 'f51,f52,f53,f54,f55,f56';

/**
 * 上游熔断：按主机分组，连续失败 3 次后短路 60 秒，避免在限流期间反复重试放大封禁。
 * 分组很有必要：push2（实时行情）与 push2his（历史/分时）常被分别限流，
 * 一个挂掉不应拖累另一个。
 */
const THRESHOLD = 3;
const COOLDOWN_MS = 60000;
const breakers = new Map();

function scopeOf(url) {
  try {
    return new URL(url).hostname.includes('push2his') ? 'history' : 'quote';
  } catch {
    return 'quote';
  }
}

function breakerFor(scope) {
  if (!breakers.has(scope)) breakers.set(scope, { failures: 0, openUntil: 0 });
  return breakers.get(scope);
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recordSuccess(scope) {
  const breaker = breakerFor(scope);
  breaker.failures = 0;
  breaker.openUntil = 0;
}

function recordFailure(scope) {
  const breaker = breakerFor(scope);
  breaker.failures += 1;
  if (breaker.failures >= THRESHOLD) breaker.openUntil = Date.now() + COOLDOWN_MS;
}

export function isBreakerOpen(scope) {
  return Date.now() < breakerFor(scope).openUntil;
}

export function getBreakerState() {
  const scopes = {};
  let open = false;
  let openUntil = 0;
  let failures = 0;
  for (const scope of ['quote', 'history', 'tencent']) {
    const breaker = breakerFor(scope);
    const isOpen = Date.now() < breaker.openUntil;
    scopes[scope] = { ...breaker, open: isOpen };
    open = open || isOpen;
    openUntil = Math.max(openUntil, breaker.openUntil);
    failures = Math.max(failures, breaker.failures);
  }
  return { open, openUntil, failures, THRESHOLD, COOLDOWN_MS, scopes };
}

async function fetchJson(url, { retries = config.upstreamRetries } = {}) {
  const scope = scopeOf(url);
  const breaker = breakerFor(scope);
  if (Date.now() < breaker.openUntil) {
    throw upstream('数据源暂时不可用（熔断中），请稍后重试', {
      reason: 'circuit_open',
      scope,
      retryAfterMs: breaker.openUntil - Date.now(),
    });
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const text = await getText(url, {
        headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
        timeoutMs: config.requestTimeoutMs,
      });
      const json = JSON.parse(text);
      if (json && json.rc !== undefined && json.rc !== 0) throw new Error(`上游返回 rc=${json.rc}`);
      recordSuccess(scope);
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  recordFailure(scope);
  const timedOut = /超时|timeout|abort/i.test(lastError?.message ?? '');
  throw upstream(`行情数据源请求失败：${lastError?.message ?? '未知错误'}`, {
    reason: timedOut ? 'timeout' : 'network',
    scope,
    retries,
  });
}

function normalizeQuote(row) {
  const quoteTs = num(row.f124) ? Number(row.f124) * 1000 : null;
  return {
    code: String(row.f12 ?? ''),
    market: Number(row.f13 ?? 0),
    name: String(row.f14 ?? ''),
    price: num(row.f2),
    pctChg: num(row.f3),
    turnover: num(row.f6) ?? 0,
    mainNet: num(row.f62) ?? 0,
    mainRatio: num(row.f184),
    superNet: num(row.f66) ?? 0,
    bigNet: num(row.f72) ?? 0,
    midNet: num(row.f78) ?? 0,
    smallNet: num(row.f84) ?? 0,
    quoteTs,
  };
}

function quoteUrl(params) {
  const search = new URLSearchParams(params);
  return `${config.upstream.quoteBase}/api/qt/clist/get?${search.toString()}`;
}

async function fetchUniversePage(page, pageSize) {
  const url = quoteUrl({
    pn: page,
    pz: pageSize,
    po: 1,
    np: 1,
    fltt: 2,
    invt: 2,
    fid: 'f6',
    fs: config.upstream.board,
    fields: QUOTE_FIELDS,
    ut: config.upstream.utQuote,
  });
  const json = await fetchJson(url);
  const data = json?.data;
  if (!data || !Array.isArray(data.diff)) return { total: 0, rows: [] };
  return { total: Number(data.total ?? data.diff.length), rows: data.diff.map(normalizeQuote) };
}

/**
 * 全市场 ETF 清单（含最新资金流快照），按成交额降序分页拉取。
 * 用于：① 建立监控池 ② 计算全市场资金总览。
 */
export async function fetchEtfUniverse({ pageSize = config.upstream.pageSize, maxPages = 20 } = {}) {
  const first = await fetchUniversePage(1, pageSize);
  const totalPages = Math.min(Math.ceil((first.total || first.rows.length) / pageSize) || 1, maxPages);
  const pages = [];
  for (let page = 2; page <= totalPages; page += 1) pages.push(page);

  const rest = [];
  // 上游对突发并发敏感：限制 2 并发并在批次间留间隔，宁可慢一点也不要被限流
  const CONCURRENCY = 2;
  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const slice = pages.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(slice.map((page) => fetchUniversePage(page, pageSize)));
    for (const item of settled) rest.push(...item.rows);
    if (i + CONCURRENCY < pages.length) await sleep(150);
  }

  const seen = new Map();
  for (const row of [...first.rows, ...rest]) {
    if (row.code && /^\d{6}$/.test(row.code)) seen.set(row.code, row);
  }
  return { total: first.total, fetchedAt: Date.now(), rows: [...seen.values()] };
}

/** 批量实时快照（一次最多 40 个 secid，避免 URL 过长） */
export async function fetchQuotes(etfRefs) {
  if (etfRefs.length === 0) return [];
  const secids = etfRefs.map((item) => `${item.market}.${item.code}`).join(',');
  const search = new URLSearchParams({
    fltt: 2,
    invt: 2,
    secids,
    fields: QUOTE_FIELDS,
    ut: config.upstream.utQuote,
  });
  const url = `${config.upstream.quoteBase}/api/qt/ulist.np/get?${search.toString()}`;
  const json = await fetchJson(url);
  const diff = json?.data?.diff;
  if (!Array.isArray(diff)) return [];
  return diff.map(normalizeQuote).filter((row) => row.code);
}

/** 日级资金流历史：主力/小单/中单/大单/超大单（单位：元） */
export async function fetchDailyFlow(code, market, { days = config.historyDays } = {}) {  const search = new URLSearchParams({
    lmt: days,
    klt: 101,
    secid: `${market}.${code}`,
    fields1: 'f1,f2,f3,f7',
    fields2: FLOW_FIELDS,
    ut: config.upstream.utFlow,
  });
  const url = `${config.upstream.historyBase}/api/qt/stock/fflow/kline/get?${search.toString()}`;
  const json = await fetchJson(url);
  const klines = json?.data?.klines;
  if (!Array.isArray(klines)) return [];

  return klines
    .map((line) => {
      const [tradeDate, mainPos, smallPos, midPos, bigPos, superPos] = String(line).split(',');
      const toNumber = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      return {
        tradeDate,
        mainNet: toNumber(mainPos),
        smallNet: toNumber(smallPos),
        midNet: toNumber(midPos),
        bigNet: toNumber(bigPos),
        superNet: toNumber(superPos),
      };
    })
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.tradeDate))
    .sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
}

const TREND_FIELDS = 'f51,f52,f53,f54,f55,f56,f57,f58';

/**
 * 主源：东方财富 trends2，逐分钟 开/收/高/低 + 成交量（手）+ 成交额（元）+ 累计均价。
 * 一次可回带近 5 个交易日（每日 241 点），收盘后依然可回看最后交易日完整分时。
 */
async function fetchIntradayFromEastmoney(code, market, { days = 5 } = {}) {
  const search = new URLSearchParams({
    secid: `${market}.${code}`,
    fields1: 'f1,f2,f3,f4,f5,f6,f7,f8',
    fields2: TREND_FIELDS,
    iscr: 0,
    ndays: String(Math.min(Math.max(days, 1), 5)),
  });
  const url = `${config.upstream.historyBase}/api/qt/stock/trends2/get?${search.toString()}`;
  // 分时属于交互式按需加载，重试一次即可，避免页面等待过久
  const json = await fetchJson(url, { retries: 1 });
  const data = json?.data;
  const meta = {
    name: data?.name ?? null,
    preClose: num(data?.preClose),
    decimal: num(data?.decimal) ?? 3,
    source: 'eastmoney',
  };
  const lines = data?.trends;
  if (!Array.isArray(lines) || lines.length === 0) return { ...meta, rows: [] };

  const rows = [];
  for (const line of lines) {
    const parts = String(line).split(',');
    if (parts.length < 8) continue;
    const [stamp, openRaw, closeRaw, highRaw, lowRaw, volumeRaw, amountRaw, avgRaw] = parts;
    const [tradeDate, hhmm] = String(stamp).split(' ');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate ?? '') || !/^\d{2}:\d{2}$/.test(hhmm ?? '')) continue;
    const close = num(Number(closeRaw));
    if (!close || close <= 0) continue;
    rows.push({
      tradeDate,
      minute: hhmm,
      ts: beijingTs(tradeDate, hhmm),
      // 集合竞价首根没有开盘价（返回 0.000），用收盘价兜底
      open: num(Number(openRaw)) || close,
      close,
      high: num(Number(highRaw)) || close,
      low: num(Number(lowRaw)) || close,
      avgPrice: num(Number(avgRaw)),
      volume: Number(volumeRaw) || 0, // 手
      amount: Number(amountRaw) || 0, // 元
      source: 'eastmoney',
    });
  }
  rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const dayHigh = rows.reduce((max, row) => Math.max(max, row.high ?? row.close), -Infinity);
  const dayLow = rows.reduce((min, row) => Math.min(min, row.low ?? row.close), Infinity);
  return {
    ...meta,
    dayHigh: Number.isFinite(dayHigh) ? dayHigh : null,
    dayLow: Number.isFinite(dayLow) ? dayLow : null,
    rows,
  };
}

/**
 * 备源：腾讯分时接口。返回最后交易日的逐分钟价格与「累计」成交量/额，
 * 这里差分成每分钟增量。与东财口径一致（同一只 ETF 的分钟量额可对齐）。
 * 仅提供当日，不支持历史多日，用作主源被限流时的降级。
 */
async function fetchIntradayFromTencent(code, market) {
  const symbol = `${market === 1 ? 'sh' : 'sz'}${code}`;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`;
  const text = await getText(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeoutMs: config.requestTimeoutMs,
  });
  const json = JSON.parse(text);
  const node = json?.data?.[symbol];
  const list = node?.data?.data;
  const rawDate = String(node?.data?.date ?? '');
  if (!Array.isArray(list) || list.length === 0 || !/^\d{8}$/.test(rawDate)) {
    return { rows: [], preClose: null, name: node?.qt?.[symbol]?.[1] ?? null, source: 'tencent' };
  }

  const tradeDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
  const qt = node?.qt?.[symbol] ?? [];
  const preClose = num(Number(qt[4]));
  const dayHigh = num(Number(qt[33]));
  const dayLow = num(Number(qt[34]));

  const rows = [];
  let prevVolume = 0;
  let prevAmount = 0;
  for (const line of list) {
    const [hhmm, priceRaw, volumeRaw, amountRaw] = String(line).split(' ');
    if (!/^\d{4}$/.test(hhmm ?? '')) continue;
    const minute = `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
    // 只保留连续竞价时段（09:30-11:30、13:00-15:00），剔除盘后成交点
    if (minute < '09:30' || minute > '15:00' || (minute > '11:30' && minute < '13:00')) continue;
    const close = num(Number(priceRaw));
    if (!close || close <= 0) continue;
    const cumVolume = Number(volumeRaw) || 0;
    const cumAmount = Number(amountRaw) || 0;
    const volume = Math.max(0, cumVolume - prevVolume);
    const amount = Math.max(0, cumAmount - prevAmount);
    prevVolume = cumVolume;
    prevAmount = cumAmount;
    const prevPrice = rows.length > 0 ? rows[rows.length - 1].close : close;
    rows.push({
      tradeDate,
      minute,
      ts: beijingTs(tradeDate, minute),
      open: prevPrice,
      close,
      high: Math.max(prevPrice, close),
      low: Math.min(prevPrice, close),
      avgPrice: cumVolume > 0 ? cumAmount / (cumVolume * 100) : null,
      volume,
      amount,
      source: 'tencent',
    });
  }

  return {
    name: qt[1] ?? null,
    preClose,
    dayHigh,
    dayLow,
    decimal: 3,
    source: 'tencent',
    rows,
  };
}

/**
 * 备源（腾讯分钟接口）的独立入口：盘中实时刷新走这里，不再先试主源。
 *
 * 主源在东财限流期每次都要先等一次失败，40 只标的的轮转会被拖成分钟级；
 * 腾讯接口对分钟级轮询的容忍度明显更高，实时刷新直接走备源更稳。
 * 单独用一个 'tencent' 熔断档，避免污染 quote / history 的状态。
 */
export async function fetchMinuteToday(code, market) {
  if (isBreakerOpen('tencent')) {
    throw upstream('分时备源暂时不可用（熔断中），请稍后重试', { reason: 'circuit_open', scope: 'tencent' });
  }
  try {
    const result = await fetchIntradayFromTencent(code, market);
    recordSuccess('tencent');
    return result;
  } catch (error) {
    recordFailure('tencent');
    throw error;
  }
}

/**
 * 分时行情统一入口：主源失败或被熔断时自动切备源。
 * 这样即使行情主源被限流，用户点开详情仍能看到最后交易日的分时与量能。
 */
export async function fetchIntradayTrends(code, market, { days = 5 } = {}) {
  const problems = [];

  if (!isBreakerOpen('history')) {
    try {
      const primary = await fetchIntradayFromEastmoney(code, market, { days });
      if (primary.rows.length > 0) return primary;
      problems.push('主源返回空');
    } catch (error) {
      problems.push(`主源 ${error.message}`);
    }
  } else {
    problems.push('主源熔断中');
  }

  try {
    const fallback = await fetchIntradayFromTencent(code, market);
    if (fallback.rows.length > 0) return { ...fallback, degraded: problems.join('；') };
    problems.push('备源返回空');
  } catch (error) {
    problems.push(`备源 ${error.message}`);
  }

  throw upstream(`分时数据获取失败：${problems.join(' / ')}`, { reason: 'network', source: 'all' });
}
