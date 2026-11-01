import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations } from '../server/db/index.js';
import { createEtfRepo } from '../server/repositories/etfRepo.js';
import { createFlowRepo } from '../server/repositories/flowRepo.js';
import { createAlertRepo } from '../server/repositories/alertRepo.js';
import { createRuleRepo } from '../server/repositories/ruleRepo.js';
import { createIntradayRepo } from '../server/repositories/intradayRepo.js';
import { createEventBus } from '../server/services/events.js';
import { createVolumeSurgeService } from '../server/services/volumeSurgeService.js';
import { severityForLevel } from '../server/services/alertService.js';
import { beijingTs } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TRADE_DATE = '2026-10-30';
const STRONG = 40_000; // 40× 基线：等级 3
const MEDIUM = 3_200; // 3.2× 基线：等级 2

const silentLogger = {
  child: () => silentLogger,
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/** 连续竞价时段的全部分钟（与算法口径一致，不含集合竞价与 15:00） */
function allMinutes() {
  const minutes = [];
  const push = (from, to) => {
    const [fh, fm] = from.split(':').map(Number);
    const [th, tm] = to.split(':').map(Number);
    for (let t = fh * 60 + fm; t <= th * 60 + tm; t += 1) {
      minutes.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
    }
  };
  push('09:31', '11:30');
  push('13:01', '14:56');
  return minutes;
}

const MINUTES = allMinutes();

/** 构造一只标的的全天分钟序列：默认量 1000 手、价 4.000，按 patch 覆盖个别分钟 */
function buildBars(code, { volumeAt = {}, priceAt = {}, amountAt = {} } = {}) {
  return MINUTES.map((minute) => {
    const price = priceAt[minute] ?? 4;
    const volume = volumeAt[minute] ?? 1000;
    return {
      code,
      tradeDate: TRADE_DATE,
      minute,
      ts: beijingTs(TRADE_DATE, minute),
      open: price,
      close: price,
      high: price,
      low: price,
      avgPrice: price,
      volume,
      amount: amountAt[minute] ?? volume * 100 * price,
      preClose: 4,
      dayHigh: 4.05,
      dayLow: 3.95,
      source: 'test',
    };
  });
}

const tsOf = (minute) => beijingTs(TRADE_DATE, minute);

function setup({ bars, rule = {}, options = {}, etfs } = {}) {
  const db = openDatabase(':memory:');
  runMigrations(db, path.join(here, '..', 'server', 'db', 'migrations'), null);

  const repos = {
    etfRepo: createEtfRepo(db),
    flowRepo: createFlowRepo(db),
    alertRepo: createAlertRepo(db),
    ruleRepo: createRuleRepo(db),
    intradayRepo: createIntradayRepo(db),
  };

  // 清掉系统默认规则，让每条用例只面对自己声明的那条规则
  db.exec('DELETE FROM alert_rule');

  const now = Date.now();
  const insertEtf = db.prepare(
    'INSERT INTO etf (code, name, market, category, turnover, tracked, pinned, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)',
  );
  for (const etf of etfs ?? [{ code: '510300', name: '沪深300ETF', market: 1, category: '宽基指数', turnover: 1e9 }]) {
    insertEtf.run(etf.code, etf.name, etf.market, etf.category, etf.turnover, now, now);
  }

  repos.ruleRepo.create({
    name: '分钟量能突变（带突破确认）',
    metric: 'volume_surge',
    timeframe: 'intraday',
    comparator: 'gt',
    threshold: 3,
    windowSec: 300,
    severity: 'high',
    cooldownSec: 300,
    scope: 'all',
    ...rule,
  });

  const rows = bars ?? buildBars('510300');
  repos.intradayRepo.upsertMany(rows, now);

  const service = createVolumeSurgeService({
    repos,
    events: createEventBus(),
    logger: silentLogger,
    options: {
      volumeSurge: {
        enabled: true,
        requireRangeBreak: true,
        minAmount: 0,
        minAlertLevel: 2,
        backfillMinLevel: 3,
        liveWindowSec: 600,
        ...options,
      },
    },
  });

  return { db, repos, service };
}

function alertsOf(repos) {
  return repos.alertRepo.list({ limit: 100 }).rows;
}

test('强度等级映射到告警级别：高等级规则下的中/弱信号自动降档', () => {
  assert.equal(severityForLevel('high', 3), 'high');
  assert.equal(severityForLevel('high', 2), 'medium');
  assert.equal(severityForLevel('high', 1), 'low');
  assert.equal(severityForLevel('medium', 3), 'medium');
  assert.equal(severityForLevel('medium', 2), 'low');
});

test('量能骤增 + 价格突破：命中规则并按分钟落库一次', async () => {
  const { repos, service } = setup({
    bars: buildBars('510300', { volumeAt: { '10:20': STRONG }, priceAt: { '10:20': 4.03 } }),
  });

  const result = await service.scan({ now: tsOf('10:20') + 30_000 });
  assert.equal(result.ok, true);
  assert.equal(result.alerts, 1);

  const [alert] = alertsOf(repos);
  assert.equal(alert.metric, 'volume_surge');
  assert.equal(alert.code, '510300');
  assert.equal(alert.severity, 'high');
  assert.equal(alert.dedupe_key, `v:${TRADE_DATE}:10:20`);
  assert.equal(alert.source, 'live');
  assert.equal(alert.baseline, 1000);
  assert.equal(alert.value, 40);
  assert.equal(alert.trade_date, TRADE_DATE);
  assert.match(alert.condition_text, /分钟成交量 大于 3\.00× 近 20 分钟基线/);
  assert.match(alert.message, /突破前 20 分钟高点/);
});

test('重复扫描幂等：同一分钟不会重复告警', async () => {
  const { repos, service } = setup({
    bars: buildBars('510300', { volumeAt: { '10:20': STRONG }, priceAt: { '10:20': 4.03 } }),
  });
  const now = tsOf('10:20') + 30_000;

  assert.equal((await service.scan({ now })).alerts, 1);
  assert.equal((await service.scan({ now: now + 20_000 })).alerts, 0);
  assert.equal(alertsOf(repos).length, 1);
});

test('冷却期内同一标的的连续突变只记第一条', async () => {
  const { repos, service } = setup({
    bars: buildBars('510300', {
      volumeAt: { '10:20': STRONG, '10:23': STRONG },
      priceAt: { '10:20': 4.03, '10:23': 4.05 },
    }),
  });

  const result = await service.scan({ now: tsOf('10:23') + 30_000 });
  assert.equal(result.alerts, 1);
  assert.equal(alertsOf(repos)[0].dedupe_key, `v:${TRADE_DATE}:10:20`);
});

test('只放量不突破：默认参数下不告警', async () => {
  const { repos, service } = setup({
    bars: buildBars('510300', { volumeAt: { '10:20': STRONG } }),
  });
  assert.equal((await service.scan({ now: tsOf('10:20') + 30_000 })).alerts, 0);
  assert.equal(alertsOf(repos).length, 0);
});

test('绝对成交额门槛过滤地量放量', async () => {
  const { repos, service } = setup({
    bars: buildBars('510300', { volumeAt: { '10:20': STRONG }, priceAt: { '10:20': 4.03 } }),
    options: { minAmount: 100_000_000 },
  });
  assert.equal((await service.scan({ now: tsOf('10:20') + 30_000 })).alerts, 0);
  assert.equal(alertsOf(repos).length, 0);
});

test('盘中实时按规则等级入库，收盘回放只留强信号', async () => {
  const bars = buildBars('510300', { volumeAt: { '10:20': MEDIUM }, priceAt: { '10:20': 4.03 } });
  const live = setup({ bars });
  const liveResult = await live.service.scan({ now: tsOf('10:20') + 30_000 });
  assert.equal(liveResult.alerts, 1);
  assert.equal(alertsOf(live.repos)[0].severity, 'medium');
  assert.equal(alertsOf(live.repos)[0].source, 'live');

  const replay = setup({ bars });
  const replayResult = await replay.service.scan({ now: tsOf('10:20') + 3600_000 });
  assert.equal(replayResult.alerts, 0, '中等级信号在回放时不应写入告警表');
});

test('适用范围为指定代码时不影响其它标的', async () => {
  const bars = [
    ...buildBars('510300', { volumeAt: { '10:20': STRONG }, priceAt: { '10:20': 4.03 } }),
    ...buildBars('512690', { volumeAt: { '10:20': STRONG }, priceAt: { '10:20': 4.03 } }),
  ];
  const { repos, service } = setup({
    bars,
    etfs: [
      { code: '510300', name: '沪深300ETF', market: 1, category: '宽基指数', turnover: 1e9 },
      { code: '512690', name: '酒ETF', market: 1, category: '消费', turnover: 1e8 },
    ],
    rule: { scope: 'codes', scopeValue: ['512690'] },
  });

  const result = await service.scan({ now: tsOf('10:20') + 30_000 });
  assert.equal(result.alerts, 1);
  assert.equal(alertsOf(repos)[0].code, '512690');
});

test('骤减事件不会被 gt 规则误收', async () => {
  // 10:20 起量能断崖式萎缩：基线仍是放量水平，构成 drain 事件
  const volumeAt = {};
  for (const minute of MINUTES) volumeAt[minute] = minute >= '10:20' && minute <= '10:30' ? 20 : 5000;
  const { repos, service } = setup({ bars: buildBars('510300', { volumeAt }) });

  assert.equal((await service.scan({ now: tsOf('10:21') + 30_000 })).alerts, 0);
  assert.equal(alertsOf(repos).length, 0);
});

test('explain 不受告警等级门槛限制，弱信号也能用于图表标注', () => {
  const { service } = setup({
    bars: buildBars('510300', { volumeAt: { '10:20': MEDIUM }, priceAt: { '10:20': 4.03 } }),
    options: { minAlertLevel: 3 },
  });

  const explained = service.explain('510300', TRADE_DATE);
  assert.equal(explained.events.length, 1);
  assert.equal(explained.events[0].minute, '10:20');
  assert.equal(explained.events[0].level, 2);
  assert.equal(explained.events[0].ts, tsOf('10:20'));
  assert.ok(explained.events[0].ratio > 3);
  assert.equal(explained.params.requireRangeBreak, true);
});

test('无规则或未启用时扫描直接返回，不产生告警', async () => {
  const { repos, service } = setup({
    bars: buildBars('510300', { volumeAt: { '10:20': STRONG }, priceAt: { '10:20': 4.03 } }),
  });
  repos.ruleRepo.list().forEach((rule) => repos.ruleRepo.update(rule.id, { enabled: false }));

  const result = await service.scan({ now: tsOf('10:20') + 30_000 });
  assert.equal(result.skipped, 'no-rule');
  assert.equal(alertsOf(repos).length, 0);
});
