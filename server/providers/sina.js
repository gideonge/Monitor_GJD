import { config } from '../config/index.js';
import { upstream } from '../lib/errors.js';
import { sleep } from '../lib/concurrency.js';
import { getText } from '../lib/httpClient.js';

/**
 * 新浪行情源：作为「全市场 ETF 清单」的备源。
 *
 * 为什么需要它：东财 push2 集群对机房 IP 有严格的门槛，表现为 TCP 建连后立刻被
 * reset（Node 侧报 UND_ERR_SOCKET，curl 返回 000）。实测带完整浏览器 UA / Referer
 * 也绕不过去，是 IP 级拦截。一旦 push2 不可用，东财就没有任何接口能给出 ETF 清单，
 * 监控池会被清空、整个应用变成空壳。
 *
 * 新浪这个列表接口在同样的网络环境下稳定返回（实测 200 / 约 200 ms），
 * 提供代码、名称、现价、涨跌幅、成交额，足够建立监控池。
 *
 * 明确的能力缺口：**没有「主力净流入」**。新浪的这个接口只有行情，没有资金流分档。
 * 因此本模块返回的 mainNet 一律为 null —— 上层聚合会按「无数据」处理而不是当 0 计入，
 * 真实的主力净额由腾讯快照补（见 providers/tencent.js 的 fetchMinuteQuotes）。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const LIST_BASE =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeDataSimple';

/** ETF 板块节点：全市场 ETF（不含 LOF / 分级） */
const NODE = 'etf_hq_fund';

const THRESHOLD = 3;
const COOLDOWN_MS = 60000;
const breaker = { failures: 0, openUntil: 0, lastError: null };

export function isSinaBreakerOpen() {
  return Date.now() < breaker.openUntil;
}

export function getSinaBreakerState() {
  return {
    open: Date.now() < breaker.openUntil,
    openUntil: breaker.openUntil,
    failures: breaker.failures,
    threshold: THRESHOLD,
    cooldownMs: COOLDOWN_MS,
    lastError: breaker.lastError,
  };
}

function recordSuccess() {
  breaker.failures = 0;
  breaker.openUntil = 0;
  breaker.lastError = null;
}

function recordFailure(error) {
  breaker.failures += 1;
  breaker.lastError = error?.message ?? 'unknown';
  if (breaker.failures >= THRESHOLD) breaker.openUntil = Date.now() + COOLDOWN_MS;
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 解析单条新浪列表记录 → 与东财 normalizeQuote 同构的行情行。
 *
 * 字段对照（新浪 → 本项目）：
 *   symbol  sh510300 → market 1 / sz159919 → market 0
 *   trade   现价 / changepercent 涨跌幅(%) / amount 成交额(元)
 * 缺失：mainNet / mainRatio / superNet / bigNet / midNet / smallNet 全部为 null。
 */
export function normalizeSinaRow(row) {
  const symbol = String(row?.symbol ?? '');
  const code = String(row?.code ?? symbol.slice(2));
  if (!/^\d{6}$/.test(code)) return null;

  const market = symbol.startsWith('sh') ? 1 : symbol.startsWith('sz') ? 0 : null;
  if (market === null) return null;

  const price = num(row?.trade);
  if (!(price > 0)) return null; // 停牌 / 无有效报价

  return {
    code,
    market,
    name: String(row?.name ?? '').trim(),
    price,
    pctChg: num(row?.changepercent) ?? 0,
    turnover: num(row?.amount) ?? 0,
    mainNet: null,
    mainRatio: null,
    superNet: null,
    bigNet: null,
    midNet: null,
    smallNet: null,
    quoteTs: null,
  };
}

/** 上游偶尔返回 `null` 或包裹在括号里，统一剥成数组 */
export function parseSinaList(text) {
  const raw = String(text ?? '').trim();
  if (raw === '' || raw === 'null') return [];
  const body = raw.replace(/^\(+/, '').replace(/\)+;?$/, '').replace(/;$/, '');
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw upstream('新浪清单返回不是合法 JSON', { reason: 'parse' });
  }
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) throw upstream('新浪清单返回结构异常', { reason: 'parse' });
  return parsed;
}

async function fetchPage(page, pageSize) {
  const url = `${LIST_BASE}?page=${page}&num=${pageSize}&sort=amount&asc=0&node=${NODE}`;
  const text = await getText(url, {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
    timeoutMs: config.requestTimeoutMs,
  });
  return parseSinaList(text);
}

/**
 * 拉取全市场 ETF 清单（按成交额降序）。
 *
 * 分页顺序执行而不是并发：这个接口对突发的并行请求并不友好，而清单刷新本身
 * 只需要十分钟一次，多花两三秒换稳定性是划算的。
 */
export async function fetchEtfUniverseFromSina({
  pageSize = 100,
  maxPages = 20,
  retries = config.upstreamRetries,
} = {}) {
  if (isSinaBreakerOpen()) {
    throw upstream('新浪清单源熔断中', {
      reason: 'circuit_open',
      scope: 'sina',
      retryAfterMs: breaker.openUntil - Date.now(),
    });
  }

  const collected = new Map();
  let lastError;
  try {
    for (let page = 1; page <= maxPages; page += 1) {
      let rows;
      let attempt = 0;
      for (;;) {
        try {
          rows = await fetchPage(page, pageSize);
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= retries) throw error;
          attempt += 1;
          await sleep(300 * attempt);
        }
      }
      if (rows.length === 0) break;
      for (const row of rows) {
        const normalized = normalizeSinaRow(row);
        if (normalized) collected.set(normalized.code, normalized);
      }
      // 不足一页说明已到末尾，不必再多打一次空请求
      if (rows.length < pageSize) break;
      await sleep(120);
    }

    if (collected.size === 0) {
      throw upstream('新浪清单返回空数据', { reason: 'empty', scope: 'sina' });
    }
    recordSuccess();
    return { total: collected.size, fetchedAt: Date.now(), rows: [...collected.values()], source: 'sina' };
  } catch (error) {
    recordFailure(lastError ?? error);
    throw error;
  }
}
