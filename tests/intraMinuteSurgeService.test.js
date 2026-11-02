import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations } from '../server/db/index.js';
import { createEtfRepo } from '../server/repositories/etfRepo.js';
import { createAlertRepo } from '../server/repositories/alertRepo.js';
import { createRuleRepo } from '../server/repositories/ruleRepo.js';
import { createEventBus } from '../server/services/events.js';
import { createIntraMinuteSurgeService } from '../server/services/intraMinuteSurgeService.js';
import { beijingTs } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATE = '2026-11-02';

const silentLogger = {
  child: () => silentLogger,
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function minutesBetween(from, to) {
  const out = [];
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  for (let t = fh * 60 + fm; t <= th * 60 + tm; t += 1) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
}

/** 每 3 秒一个采样点，20 点/分钟；amountAt 按分钟覆盖成交额 */
function buildTicks({ to = '10:20', amountPerMinute = 5_000_000, amountAt = {}, netRatio = 0.3, from = '09:31' } = {}) {
  const ticks = [];
  for (const minute of minutesBetween(from, to)) {
    const total = amountAt[minute] ?? amountPerMinute;
    for (let i = 0; i < 20; i += 1) {
      const sec = 1 + i * 3;
      ticks.push({
        ts: beijingTs(DATE, minute) + sec * 1000,
        amt_delta: total / 20,
        net_delta: (total / 20) * netRatio,
        price: 4,
      });
    }
  }
  return ticks;
}

const tsOf = (minute, sec = 58) => beijingTs(DATE, minute) + sec * 1000;

function setup({ ticks, rule = {}, options = {}, phase = 'trading' } = {}) {
  const db = openDatabase(':memory:');
  runMigrations(db, path.join(here, '..', 'server', 'db', 'migrations'), null);

  const repos = {
    etfRepo: createEtfRepo(db),
    alertRepo: createAlertRepo(db),
    ruleRepo: createRuleRepo(db),
  };
  db.exec('DELETE FROM alert_rule');

  const now = Date.now();
  db.prepare(
    'INSERT INTO etf (code, name, market, category, turnover, tracked, pinned, first_seen_at, updated_at) VALUES (?, ?, 1, ?, ?, 1, 0, ?, ?)',
  ).run('510300', '沪深300ETF', '宽基指数', 1e9, now, now);

  repos.ruleRepo.create({
    name: '分钟内实时爆量',
    metric: 'volume_preburst',
    timeframe: 'intraday',
    comparator: 'gt',
    threshold: 2.5,
    windowSec: 1200,
    severity: 'high',
    cooldownSec: 180,
    scope: 'all',
    ...rule,
  });

  const data = ticks ?? buildTicks();
  const fastTickService = {
    poolCodes: () => ['510300'],
    memorySeries: () => data,
    series: () => data,
  };

  const service = createIntraMinuteSurgeService({
    repos,
    events: createEventBus(),
    logger: silentLogger,
    fastTickService,
    options: {
      marketPhase: () => phase,
      intraMinute: {
        minElapsedSec: 9,
        minSamples: 3,
        minAmount: 3_000_000,
        alertMinAmount: 0,
        minAlertLevel: 2,
        liveWindowSec: 180,
        ratioThreshold: 2.5,
        ...options,
      },
    },
  });

  return { db, repos, service, data };
}

const alertsOf = (repos) => repos.alertRepo.list({ limit: 50 }).rows ?? repos.alertRepo.list({ limit: 50 });

test('分钟内的爆量在收盘前就落库，去重键按分钟', async () => {
  const { repos, service } = setup({ ticks: buildTicks({ amountAt: { '10:20': 40_000_000 } }) });

  const result = await service.scan({ now: tsOf('10:20') + 2000 });
  assert.equal(result.ok, true);
  assert.equal(result.triggered, 1);
  assert.equal(result.alerts, 1);

  const alerts = alertsOf(repos);
  assert.equal(alerts.length, 1);
  const [alert] = alerts;
  assert.equal(alert.metric, 'volume_preburst');
  assert.equal(alert.code, '510300');
  assert.equal(alert.source, 'live');
  assert.equal(alert.dedupe_key, `n:${DATE}:10:20`);
  assert.equal(alert.trade_date, DATE);
  assert.ok(alert.value >= 2.5, `value 应为折算倍数，实际 ${alert.value}`);
  assert.match(alert.message, /10:20/);
  assert.match(alert.message, /折算整分钟/);
  assert.match(alert.condition_text, /80% 分位到达曲线/);
  assert.ok(alert.triggered_at >= beijingTs(DATE, '10:20') + 10_000, '触发时刻应在分钟之内，而不是收盘后');
});

test('同一分钟重复扫描不会重复入库', async () => {
  const { repos, service } = setup({ ticks: buildTicks({ amountAt: { '10:20': 40_000_000 } }) });

  await service.scan({ now: tsOf('10:20') + 2000 });
  const again = await service.scan({ now: tsOf('10:20') + 5000 });
  assert.equal(again.alerts, 0);
  assert.equal(alertsOf(repos).length, 1);
});

test('冷却期内下一分钟的同一波放量不再打扰', async () => {
  const { repos, service } = setup({
    ticks: buildTicks({ amountAt: { '10:20': 40_000_000, '10:21': 40_000_000 } }),
  });

  await service.scan({ now: tsOf('10:20') + 2000 });
  const next = await service.scan({ now: tsOf('10:21') + 2000 });
  assert.equal(next.triggered, 1, '第二分钟仍然被判定为爆量');
  assert.equal(next.alerts, 0, '但同一波在冷却期内不再出一条');
  assert.equal(alertsOf(repos).length, 1);
});

test('折算金额不到告警门槛时只亮灯不推送', async () => {
  // 成交额 800 万、基线 500 万 → 折算约 1.7×，够不上 2.5×；这里换成 1200 万让它超过门槛、
  // 但又低于 alertMinAmount，验证「判定」和「是否打扰」是两道独立的闸
  const { repos, service } = setup({
    ticks: buildTicks({ amountAt: { '10:20': 14_000_000 } }),
    options: { alertMinAmount: 50_000_000 },
  });

  const result = await service.scan({ now: tsOf('10:20') + 2000 });
  assert.equal(result.triggered, 1);
  assert.equal(result.alerts, 0);
  assert.equal(alertsOf(repos).length, 0);

  const live = service.liveFor('510300');
  assert.equal(live.triggered, true, '详情页的「正在放量」仍然应该是亮的');
  assert.ok(live.projectedAmount < 50_000_000);
});

test('主动净卖出的爆量同样上报，方向写在事件里', async () => {
  const { repos, service } = setup({
    ticks: buildTicks({ amountAt: { '10:20': 40_000_000 }, netRatio: -0.4 }),
  });

  await service.scan({ now: tsOf('10:20') + 2000 });
  const [alert] = alertsOf(repos);
  assert.ok(alert);
  assert.match(alert.message, /主动净卖出/);
  assert.match(alert.message, /主动卖压/);
});

test('非交易时段不扫描', async () => {
  const { service } = setup({ ticks: buildTicks({ amountAt: { '10:20': 40_000_000 } }), phase: 'closed' });
  const result = await service.scan({ now: tsOf('10:20') + 2000 });
  assert.equal(result.skipped, 'phase');
});

test('explain 不落库，返回可展示的判定（不含分桶明细）', async () => {
  const { repos, service, data } = setup({ ticks: buildTicks({ amountAt: { '10:20': 40_000_000 } }) });

  const { evaluation } = service.explain('510300', { points: data });
  assert.equal(evaluation.triggered, true);
  assert.equal(evaluation.active, true);
  assert.equal(evaluation.minute, '10:20');
  assert.equal(evaluation.buckets, undefined, '接口不应携带分桶明细');
  assert.equal(evaluation.gates.ratio, true);
  assert.equal(alertsOf(repos).length, 0);
});

test('状态里能看到每只标的的实时判定快照', async () => {
  const { service } = setup({ ticks: buildTicks({ amountAt: { '10:20': 40_000_000 } }) });
  await service.scan({ now: tsOf('10:20') + 2000 });

  const status = service.getStatus();
  assert.equal(status.codes, 1);
  assert.equal(status.live.length, 1);
  assert.equal(status.live[0].code, '510300');
  assert.equal(status.live[0].minute, '10:20');
  assert.equal(status.live[0].stage, 'trigger');
  assert.equal(status.params.alertMinAmount, 0);
});
