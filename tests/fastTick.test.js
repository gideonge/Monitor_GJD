import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations } from '../server/db/index.js';
import { createEtfRepo } from '../server/repositories/etfRepo.js';
import { createFastTickRepo } from '../server/repositories/fastTickRepo.js';
import { createFastTickService } from '../server/services/fastTickService.js';
import { parseFastQuoteLine, parseFastQuoteText, parseQuoteTime } from '../server/providers/tencent.js';
import { tradeDateOf } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const silentLogger = {
  child: () => silentLogger,
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/**
 * 构造腾讯快照报文行：只填关键字段，其余留空。
 * 字段索引来自真实报文（2026-10-30 收盘快照）。
 */
function sampleLine(overrides = {}) {
  const f = new Array(88).fill('');
  const value = {
    name: '沪深300ETF华泰柏瑞',
    code: '510300',
    price: '4.065',
    preClose: '4.111',
    open: '4.059',
    volume: '21130014',
    outer: '12952931',
    inner: '8177083',
    bid1: '4.065',
    bid1Vol: '7784',
    ask1: '4.066',
    ask1Vol: '2572',
    time: '20261030161447',
    pct: '-1.12',
    high: '4.126',
    low: '4.046',
    amount: '8613930896',
    amountWan: '861393',
    ...overrides,
  };
  f[1] = value.name;
  f[2] = value.code;
  f[3] = value.price;
  f[4] = value.preClose;
  f[5] = value.open;
  f[6] = value.volume;
  f[7] = value.outer;
  f[8] = value.inner;
  f[9] = value.bid1;
  f[10] = value.bid1Vol;
  f[19] = value.ask1;
  f[20] = value.ask1Vol;
  f[30] = value.time;
  f[32] = value.pct;
  f[33] = value.high;
  f[34] = value.low;
  f[35] = `${value.price}/${value.volume}/${value.amount}`;
  f[37] = value.amountWan;
  return `v_${value.code}="${f.join('~')}";`;
}

function setupService({ codes = ['510300', '159919'], poll, options = {}, phase = 'trading' } = {}) {
  const db = openDatabase(':memory:');
  runMigrations(db, path.join(here, '..', 'server', 'db', 'migrations'), null);

  const now = Date.now();
  const insertEtf = db.prepare(
    'INSERT INTO etf (code, name, market, category, turnover, tracked, pinned, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)',
  );
  for (const item of [
    { code: '510300', name: '沪深300ETF华泰柏瑞', market: 1 },
    { code: '159919', name: '沪深300ETF嘉实', market: 0 },
    { code: '512690', name: '酒ETF鹏华', market: 1 },
  ]) {
    insertEtf.run(item.code, item.name, item.market, '宽基指数', 1e9, now, now);
  }

  const repos = {
    etfRepo: createEtfRepo(db),
    fastTickRepo: createFastTickRepo(db),
  };

  let current = poll ?? (async () => ({ rows: [], latencyMs: 5 }));
  const service = createFastTickService({
    db,
    repos,
    logger: silentLogger,
    options: {
      fastTick: { codes, intervalMs: 1000, flushMs: 0, retentionDays: 2, memorySec: 1800, ...options },
      fetchQuotes: async (refs) => current(refs),
      marketPhase: () => phase,
      isBreakerOpen: () => false,
    },
  });

  return {
    db,
    repos,
    service,
    setPoll: (fn) => {
      current = fn;
    },
  };
}

/** 逐秒构造快照：累计成交额/外盘/内盘按秒递增 */
function stepQuote({ code = '510300', ts, price = 4.0, amount, outer, inner, volume = 1000 }) {
  return {
    code,
    ts,
    price,
    pctChg: 0.1,
    volume,
    amount,
    outer,
    inner,
    bid1: price - 0.001,
    ask1: price + 0.001,
    bid1Vol: 500,
    ask1Vol: 300,
    imba: 0.25,
    preClose: 3.99,
    source: 'tencent',
  };
}

test('解析腾讯快照：价格、外盘内盘、成交额、盘口', () => {
  const parsed = parseFastQuoteLine(sampleLine());
  assert.equal(parsed.code, '510300');
  assert.equal(parsed.price, 4.065);
  assert.equal(parsed.preClose, 4.111);
  assert.equal(parsed.volume, 21130014);
  assert.equal(parsed.outer, 12952931);
  assert.equal(parsed.inner, 8177083);
  // 成交额取三元组里的元值，不是万元
  assert.equal(parsed.amount, 8613930896);
  assert.equal(parsed.bid1, 4.065);
  assert.equal(parsed.ask1, 4.066);
  assert.equal(parsed.imba, (7784 - 2572) / (7784 + 2572));
});

test('解析腾讯快照：多条报文按行拆开', () => {
  const text = `${sampleLine()}\n${sampleLine({ code: '159919', price: '4.500', amount: '1000000' })}`;
  const rows = parseFastQuoteText(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.code),
    ['510300', '159919'],
  );
});

test('停牌（现价为 0）不产生快照', () => {
  assert.equal(parseFastQuoteLine(sampleLine({ price: '0.000' })), null);
});

test('上游时间为北京时间，可还原到毫秒', () => {
  const ts = parseQuoteTime('20261030161447');
  assert.equal(tradeDateOf(ts), '2026-10-30');
  assert.equal(new Date(ts).toISOString(), '2026-10-30T08:14:47.000Z');
  assert.equal(parseQuoteTime('bad'), null);
});

test('首点只建基线，不把开盘以来的累计量记成「这一秒」', async () => {
  const base = parseQuoteTime('20261030100000');
  const { service, setPoll } = setupService();
  setPoll(async () => ({ rows: [stepQuote({ ts: base, amount: 5e8, outer: 1e6, inner: 8e5 })], latencyMs: 8 }));
  const result = await service.poll({ force: true });
  assert.equal(result.points, 1);

  const [point] = service.series('510300', { seconds: 600 });
  assert.equal(point.amt_delta, null);
  assert.equal(point.net_delta, null);
  assert.equal(point.price, 4);
});

test('第二点起计算本秒成交额与主动净买入额', async () => {
  const t0 = parseQuoteTime('20261030100000');
  const { service, setPoll } = setupService();
  setPoll(async () => ({ rows: [stepQuote({ ts: t0, amount: 1e8, outer: 100000, inner: 80000 })], latencyMs: 8 }));
  await service.poll({ force: true });

  setPoll(async () => ({
    rows: [stepQuote({ ts: t0 + 1000, amount: 1.05e8, outer: 101000, inner: 80000 })],
    latencyMs: 8,
  }));
  await service.poll({ force: true });

  const points = service.series('510300', { seconds: 600 });
  assert.equal(points.length, 2);
  const second = points[1];
  assert.equal(second.amt_delta, 5_000_000);
  // Δ外盘 1000 手 × 100 份/手 × 4 元 = 40 万主动净买入
  assert.equal(second.net_delta, 400_000);
});

test('同一秒重复请求不产生新点', async () => {
  const t0 = parseQuoteTime('20261030100000');
  const { service, setPoll } = setupService();
  const row = stepQuote({ ts: t0, amount: 1e8, outer: 100000, inner: 80000 });
  setPoll(async () => ({ rows: [row], latencyMs: 5 }));
  await service.poll({ force: true });
  const second = await service.poll({ force: true });
  assert.equal(second.points, 0);
  assert.equal(service.series('510300', { seconds: 600 }).length, 1);
});

test('跨交易日重置基线，不产生跨日的虚假增量', async () => {
  const t0 = parseQuoteTime('20261030145959');
  const t1 = parseQuoteTime('20261102093001');
  const { service, setPoll } = setupService();
  setPoll(async () => ({ rows: [stepQuote({ ts: t0, amount: 1e8, outer: 100000, inner: 80000 })], latencyMs: 5 }));
  await service.poll({ force: true });
  setPoll(async () => ({ rows: [stepQuote({ ts: t1, amount: 2e7, outer: 20000, inner: 10000 })], latencyMs: 5 }));
  await service.poll({ force: true });

  // 跨了两天，窗口要放宽到能同时覆盖两个交易日
  const points = service.series('510300', { seconds: 3 * 86400 });
  assert.equal(points.length, 2);
  assert.equal(points[1].amt_delta, null);
  assert.equal(points[1].net_delta, null);
});

test('非交易时段不请求上游', async () => {
  let called = 0;
  const { service } = setupService({
    phase: 'weekend',
    poll: async () => {
      called += 1;
      return { rows: [], latencyMs: 1 };
    },
  });
  // 非交易时段：连上游请求都不该发出
  const result = await service.poll();
  assert.equal(result.skipped, 'phase');
  assert.equal(called, 0);
});

test('秒级池只包含清单里存在的代码；池外标的走分钟级', () => {
  const { service } = setupService({ codes: ['510300', '999999', '512690'] });
  const pool = service.getPool().map((item) => item.code);
  assert.deepEqual(pool, ['510300', '512690']);
  assert.equal(service.describe('510300').tier, 'second');
  assert.equal(service.describe('510300').intervalMs, 1000);
  assert.equal(service.describe('159919').tier, 'minute');
  assert.equal(service.describe('159919').inPool, false);
});

test('落库与窗口汇总：成交额、主动净额、买盘占比', async () => {
  const t0 = parseQuoteTime('20261030100000');
  const { service, setPoll, db } = setupService();
  setPoll(async () => ({ rows: [stepQuote({ ts: t0, amount: 1e8, outer: 100000, inner: 80000 })], latencyMs: 5 }));
  await service.poll({ force: true });
  setPoll(async () => ({
    rows: [stepQuote({ ts: t0 + 1000, amount: 1.1e8, outer: 103000, inner: 80000 })],
    latencyMs: 5,
  }));
  await service.poll({ force: true });
  setPoll(async () => ({
    rows: [stepQuote({ ts: t0 + 2000, amount: 1.15e8, outer: 103000, inner: 80500 })],
    latencyMs: 5,
  }));
  await service.poll({ force: true });
  service.flushNow();

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fast_tick').get().c, 3);

  const summary = service.summarize('510300', { seconds: 600 });
  assert.equal(summary.points, 3);
  assert.equal(summary.samples, 2); // 首点无增量，不参与汇总
  assert.equal(summary.amount, 10_000_000 + 5_000_000);
  // 前 1 秒：外盘 +3000，内盘 0 → 净买 120 万；后 1 秒：外盘 0，内盘 +500 → 净卖 20 万
  assert.equal(summary.netAmount, 1_200_000 - 200_000);
  assert.equal(summary.inflow, 1_200_000);
  assert.equal(summary.outflow, -200_000);
});

test('窗口锚定最后一条数据，收盘后仍能看到收盘前 N 分钟', async () => {
  const t0 = parseQuoteTime('20261030145500');
  const { service, setPoll } = setupService();
  setPoll(async () => ({ rows: [stepQuote({ ts: t0, amount: 1e8, outer: 100000, inner: 80000 })], latencyMs: 5 }));
  await service.poll({ force: true });
  setPoll(async () => ({
    rows: [stepQuote({ ts: t0 + 1000, amount: 1.01e8, outer: 100500, inner: 80000 })],
    latencyMs: 5,
  }));
  await service.poll({ force: true });

  // 系统时间早已远离该交易日，但窗口仍应以「数据最后时刻」为准
  const points = service.series('510300', { seconds: 300 });
  assert.equal(points.length, 2);
});

test('采集失败只记状态，不抛错打断调度', async () => {
  const { service, setPoll } = setupService();
  setPoll(async () => {
    throw new Error('connect ETIMEDOUT');
  });
  const result = await service.poll({ force: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /ETIMEDOUT/);
  assert.equal(service.getStatus().failures, 1);
});
