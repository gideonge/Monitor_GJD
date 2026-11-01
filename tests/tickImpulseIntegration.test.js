import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations } from '../server/db/index.js';
import { createEtfRepo } from '../server/repositories/etfRepo.js';
import { createAlertRepo } from '../server/repositories/alertRepo.js';
import { createRuleRepo } from '../server/repositories/ruleRepo.js';
import { createEventBus } from '../server/services/events.js';
import { createTickImpulseService } from '../server/services/tickImpulseService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 2026-10-30 09:30:00 北京，正对齐 15 秒桶 */
const AM_OPEN = Date.UTC(2026, 9, 30, 1, 30, 0);
const TRADE_DATE = '2026-10-30';
const BUCKET_MS = 15_000;

const silentLogger = { child: () => silentLogger, info() {}, warn() {}, error() {}, debug() {} };

const BASE = { amt: 9_000_000, net: 180_000, price: 4 };
const WAVE = { amt: 27_000_000, net: 11_000_000, price: 4.004 };

/** 生成一只标的的秒级点：桶内均分到 15 秒；waves 支持多波 [[起桶, 止桶, 覆盖值]] */
function buildPoints({ buckets = 40, waveFrom = 30, waveTo = 32, base = BASE, wave = WAVE, waves } = {}) {
  const plan = waves ?? [[waveFrom, waveTo, wave]];
  const points = [];
  for (let index = 0; index < buckets; index += 1) {
    const hit = plan.find(([from, to]) => index >= from && index <= to);
    const spec = hit ? hit[2] : base;
    for (let s = 0; s < 15; s += 1) {
      points.push({
        ts: AM_OPEN + (index * 15 + s) * 1000,
        price: spec.price,
        amtDelta: spec.amt / 15,
        netDelta: spec.net / 15,
        imba: spec.net > 0 ? 0.35 : -0.35,
      });
    }
  }
  return points;
}

function setup({ byCode, rule = {}, options = {}, etfs, rules, phase = () => 'trading' } = {}) {
  const db = openDatabase(':memory:');
  runMigrations(db, path.join(here, '..', 'server', 'db', 'migrations'), null);

  const repos = {
    etfRepo: createEtfRepo(db),
    alertRepo: createAlertRepo(db),
    ruleRepo: createRuleRepo(db),
  };
  db.exec('DELETE FROM alert_rule');

  const now = Date.now();
  const insertEtf = db.prepare(
    'INSERT INTO etf (code, name, market, category, turnover, tracked, pinned, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)',
  );
  for (const etf of etfs ?? [{ code: '510300', name: '沪深300ETF', market: 1, category: '宽基指数' }]) {
    insertEtf.run(etf.code, etf.name, etf.market, etf.category, 1e9, now, now);
  }

  const declared = rules ?? [
    {
      name: '秒级主动买入攻势',
      metric: 'tick_impulse',
      timeframe: 'intraday',
      comparator: 'gt',
      threshold: 30_000_000,
      windowSec: 300,
      severity: 'high',
      cooldownSec: 240,
      scope: 'all',
    },
  ];
  for (const item of declared) repos.ruleRepo.create({ ...item, ...rule });

  const fastTickService = {
    memorySeries: (code) => byCode[code] ?? [],
    series: (code) => byCode[code] ?? [],
    poolCodes: () => Object.keys(byCode),
  };

  const service = createTickImpulseService({
    repos,
    events: createEventBus(),
    logger: silentLogger,
    fastTickService,
    options: {
      marketPhase: phase,
      tickImpulse: {
        enabled: true,
        bucketSec: 15,
        baselineBuckets: 20,
        minBaselineBuckets: 6,
        minSamplesPerBucket: 3,
        netRatioThreshold: 0.6,
        minNetAmount: 500_000,
        minBuyShare: 0.2,
        zThreshold: 4,
        confirmBuckets: 3,
        mergeGapSec: 90,
        detectDrain: true,
        levelPriceMovePct: 0.12,
        minAlertLevel: 2,
        backfillMinLevel: 3,
        liveWindowSec: 300,
        resonanceWindowSec: 120,
        resonanceMinFamilies: 2,
        ...options,
      },
    },
  });

  return { db, repos, service };
}

const alertsOf = (repos) => repos.alertRepo.list({ limit: 100 }).rows;
/** 波次结束时刻（第 32 桶结束）之后 30 秒 */
const afterWave = (bucketIndex = 32) => AM_OPEN + (bucketIndex + 1) * BUCKET_MS + 30_000;

test('秒级攻势落库：一波一条，带累计净额与波次起点', async () => {
  const { repos, service } = setup({ byCode: { 510300: buildPoints() } });

  const result = await service.scan({ now: afterWave() });
  assert.equal(result.ok, true);
  assert.equal(result.episodes, 1);
  assert.equal(result.alerts, 1);

  const [alert] = alertsOf(repos);
  assert.equal(alert.metric, 'tick_impulse');
  assert.equal(alert.code, '510300');
  assert.equal(alert.severity, 'high');
  assert.equal(alert.source, 'live');
  assert.equal(alert.value, 33_000_000, '累计净额 = 3 桶 × 1100 万');
  assert.equal(alert.trade_date, TRADE_DATE);
  assert.equal(alert.dedupe_key, `t:${TRADE_DATE}:${Math.floor((AM_OPEN + 30 * BUCKET_MS) / 1000)}`);
  assert.match(alert.message, /主动买入攻势/);
  assert.match(alert.condition_text, /15 秒桶/);
  assert.match(alert.condition_text, /连续 3 桶/);
});

test('重复扫描幂等：同一波在后续扫描里不再出条', async () => {
  const { repos, service } = setup({ byCode: { 510300: buildPoints() } });

  assert.equal((await service.scan({ now: afterWave() })).alerts, 1);
  assert.equal((await service.scan({ now: afterWave() + 30_000 })).alerts, 0);
  assert.equal((await service.scan({ now: afterWave() + 60_000 })).alerts, 0);
  assert.equal(alertsOf(repos).length, 1);
});

test('规则规模门槛：累计净额不足时不告警', async () => {
  const { repos, service } = setup({
    byCode: { 510300: buildPoints({ wave: { amt: 27_000_000, net: 5_000_000, price: 4.004 } }) },
  });
  assert.equal((await service.scan({ now: afterWave() })).alerts, 0);
  assert.equal(alertsOf(repos).length, 0);
});

test('跨族共振抬级并在文案里点明同向标的', async () => {
  const byCode = {
    510300: buildPoints(),
    510500: buildPoints(),
    588000: buildPoints(),
  };
  const { repos, service } = setup({
    byCode,
    etfs: [
      { code: '510300', name: '沪深300ETF', market: 1, category: '宽基指数' },
      { code: '510500', name: '中证500ETF', market: 1, category: '宽基指数' },
      { code: '588000', name: '科创50ETF', market: 1, category: '宽基指数' },
    ],
  });

  const result = await service.scan({ now: afterWave() });
  assert.equal(result.resonances, 1);
  assert.equal(result.alerts, 3);

  const rows = alertsOf(repos);
  for (const row of rows) {
    assert.equal(row.severity, 'high');
    assert.match(row.message, /共振/);
  }
  const main = rows.find((row) => row.code === '510300');
  assert.match(main.message, /沪深300/);
  assert.match(main.message, /中证500/);
});

test('同族两只不算共振：更可能是套利资金在 ETF 间平移', async () => {
  const byCode = { 510300: buildPoints(), 510310: buildPoints() };
  const { repos, service } = setup({
    byCode,
    etfs: [
      { code: '510300', name: '沪深300ETF华泰柏瑞', market: 1, category: '宽基指数' },
      { code: '510310', name: '沪深300ETF易方达', market: 1, category: '宽基指数' },
    ],
  });

  const result = await service.scan({ now: afterWave() });
  assert.equal(result.resonances, 0);
  for (const row of alertsOf(repos)) assert.doesNotMatch(row.message, /共振/);
});

test('非交易时段不扫描，force 可强制回放', async () => {
  const { service } = setup({ byCode: { 510300: buildPoints() }, phase: () => 'closed' });

  const skipped = await service.scan({ now: afterWave() });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, 'phase');

  const forced = await service.scan({ now: afterWave(), force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.alerts, 1);
});

test('冷却期内同标的的第二波不再出条', async () => {
  // 两波分别在第 30-32 桶与第 60-62 桶，间隔 450 秒：超过合并间隔（90 秒）但仍在 600 秒冷却之内
  const points = buildPoints({
    buckets: 80,
    waves: [
      [30, 32, WAVE],
      [60, 62, WAVE],
    ],
  });
  const { repos, service } = setup({ byCode: { 510300: points }, rule: { cooldownSec: 600 } });

  const result = await service.scan({ now: AM_OPEN + 64 * BUCKET_MS });
  assert.equal(result.episodes, 2);
  assert.equal(result.alerts, 1);
  assert.equal(alertsOf(repos)[0].dedupe_key, `t:${TRADE_DATE}:${Math.floor((AM_OPEN + 30 * BUCKET_MS) / 1000)}`);
});

test('收盘回放只留强信号：中等级不补录', async () => {
  const weak = { amt: 27_000_000, net: 8_000_000, price: 4.002 };
  const live = setup({
    byCode: { 510300: buildPoints({ wave: weak }) },
    rule: { threshold: 20_000_000 },
  });
  const liveResult = await live.service.scan({ now: afterWave() });
  assert.equal(liveResult.alerts, 1);
  assert.equal(alertsOf(live.repos)[0].severity, 'medium');
  assert.equal(alertsOf(live.repos)[0].source, 'live');

  const replay = setup({
    byCode: { 510300: buildPoints({ wave: weak }) },
    rule: { threshold: 20_000_000 },
  });
  const replayResult = await replay.service.scan({ now: afterWave() + 3600_000 });
  assert.equal(replayResult.alerts, 0, '中等级信号在回放时不应写入告警表');
});

test('主动卖出规则不会被买方攻势误收', async () => {
  const { repos, service } = setup({
    byCode: { 510300: buildPoints() },
    rules: [
      {
        name: '秒级主动卖出攻势',
        metric: 'tick_impulse',
        timeframe: 'intraday',
        comparator: 'lt',
        threshold: -30_000_000,
        windowSec: 300,
        severity: 'high',
        cooldownSec: 240,
        scope: 'all',
      },
    ],
  });

  assert.equal((await service.scan({ now: afterWave() })).alerts, 0);
  assert.equal(alertsOf(repos).length, 0);
});

test('explain 返回波次与参数，供图上前端标注', () => {
  const { service } = setup({ byCode: { 510300: buildPoints() } });
  const explained = service.explain('510300');
  assert.equal(explained.episodes.length, 1);
  assert.equal(explained.episodes[0].direction, 'surge');
  assert.equal(explained.episodes[0].buckets, 3);
  assert.equal(explained.episodes[0].sumNet, 33_000_000);
  assert.equal(explained.params.confirmBuckets, 3);
});
