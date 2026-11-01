import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations } from '../server/db/index.js';
import { createAlertRepo } from '../server/repositories/alertRepo.js';
import { createRuleRepo } from '../server/repositories/ruleRepo.js';
import {
  evaluateRules,
  persistAlerts,
  buildConditionText,
  matchesScope,
  compare,
} from '../server/services/alertService.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function setup() {
  const db = openDatabase(':memory:');
  runMigrations(db, path.join(here, '..', 'server', 'db', 'migrations'), null);
  const alertRepo = createAlertRepo(db);
  const ruleRepo = createRuleRepo(db);
  return { db, alertRepo, ruleRepo };
}

const etfA = { code: '510300', name: '沪深300ETF', category: '宽基指数', market: 1, tracked: 1 };
const etfB = { code: '512690', name: '酒ETF', category: '消费', market: 1, tracked: 1 };

function baseRule(overrides = {}) {
  return {
    id: 1,
    name: '当日主力净流入超 1 亿',
    metric: 'main_net',
    timeframe: 'intraday',
    comparator: 'gt',
    threshold: 100_000_000,
    windowSec: 300,
    scope: 'all',
    scopeValue: null,
    severity: 'medium',
    cooldownSec: 1800,
    enabled: 1,
    ...overrides,
  };
}

test('比较符与适用范围判定', () => {
  assert.equal(compare(5, 'gt', 3), true);
  assert.equal(compare(-5, 'lt', -3), true);
  assert.equal(compare(1, 'gt', 3), false);

  assert.equal(matchesScope(baseRule({ scope: 'all' }), etfA), true);
  assert.equal(matchesScope(baseRule({ scope: 'category', scopeValue: JSON.stringify(['消费']) }), etfA), false);
  assert.equal(matchesScope(baseRule({ scope: 'category', scopeValue: JSON.stringify(['消费']) }), etfB), true);
  assert.equal(matchesScope(baseRule({ scope: 'codes', scopeValue: JSON.stringify(['510300']) }), etfB), false);
});

test('触发条件文案包含时间框架、指标、比较符与换算后的阈值', () => {
  assert.equal(
    buildConditionText(baseRule({ timeframe: 'window', metric: 'main_net_delta', threshold: 30_000_000 })),
    '5分钟窗口期净流入变动额 大于 3000.0万',
  );
  assert.equal(buildConditionText(baseRule()), '当日累计主力净流入额 大于 1.00亿');
});

test('规则引擎：命中阈值产生候选，未命中不产生', () => {
  const now = 1_700_000_000_000;
  const entries = [
    {
      etf: etfA,
      tradeDate: '2026-10-30',
      points: [
        { ts: now - 60_000, main_net: 120_000_000, super_net: 0 },
        { ts: now, main_net: 150_000_000, super_net: 0 },
      ],
    },
    {
      etf: etfB,
      tradeDate: '2026-10-30',
      points: [
        { ts: now - 60_000, main_net: 5_000_000, super_net: 0 },
        { ts: now, main_net: 8_000_000, super_net: 0 },
      ],
    },
  ];

  const candidates = evaluateRules({ rules: [baseRule()], entries, now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].entry.etf.code, '510300');
  assert.equal(candidates[0].value, 150_000_000);
});

test('规则引擎：窗口样本不足时跳过，避免单点误报', () => {
  const now = 1_700_000_000_000;
  const entries = [
    {
      etf: etfA,
      tradeDate: '2026-10-30',
      points: [{ ts: now, main_net: 900_000_000, super_net: 0 }],
    },
  ];
  const rule = baseRule({ timeframe: 'window', metric: 'main_net_delta', windowSec: 300 });
  assert.equal(evaluateRules({ rules: [rule], entries, now }).length, 0);
});

test('规则引擎：停用规则不参与判定', () => {
  const now = 1_700_000_000_000;
  const entries = [
    {
      etf: etfA,
      tradeDate: '2026-10-30',
      points: [{ ts: now, main_net: 999_000_000, super_net: 0 }],
    },
  ];
  assert.equal(evaluateRules({ rules: [baseRule({ enabled: 0 })], entries, now }).length, 0);
});

test('告警落库：去重键保证同一交易日同一规则幂等', () => {
  const { db, alertRepo, ruleRepo } = setup();
  const ruleId = ruleRepo.create({
    name: '当日主力净流入超 1 亿',
    metric: 'main_net',
    timeframe: 'intraday',
    comparator: 'gt',
    threshold: 100_000_000,
    severity: 'medium',
    cooldownSec: 0,
    isSystem: false,
  });
  const rule = ruleRepo.get(ruleId);
  const now = 1_700_000_000_000;
  const entries = [
    {
      etf: etfA,
      tradeDate: '2026-10-30',
      points: [{ ts: now, main_net: 200_000_000, super_net: 0 }],
    },
  ];

  const first = persistAlerts({ candidates: evaluateRules({ rules: [rule], entries, now }), alertRepo, now });
  assert.equal(first.length, 1);

  const again = persistAlerts({ candidates: evaluateRules({ rules: [rule], entries, now }), alertRepo, now });
  assert.equal(again.length, 0, '同一 dedupe_key 不应重复写入');

  const { rows, total } = alertRepo.list({});
  assert.equal(total, 1);
  assert.equal(rows[0].condition_text, '当日累计主力净流入额 大于 1.00亿');
  db.close();
});

test('告警落库：冷却窗口内不再重复告警', () => {
  const { db, alertRepo, ruleRepo } = setup();
  const ruleId = ruleRepo.create({
    name: '5分钟急流入',
    metric: 'main_net_delta',
    timeframe: 'window',
    comparator: 'gt',
    threshold: 10_000_000,
    windowSec: 300,
    severity: 'high',
    cooldownSec: 1800,
    isSystem: false,
  });
  const rule = ruleRepo.get(ruleId);
  const t0 = 1_700_000_000_000;

  const makeEntries = (now) => [
    {
      etf: etfA,
      tradeDate: '2026-10-30',
      points: [
        { ts: now - 120_000, main_net: 0, super_net: 0 },
        { ts: now, main_net: 90_000_000, super_net: 0 },
      ],
    },
  ];

  const first = persistAlerts({
    candidates: evaluateRules({ rules: [rule], entries: makeEntries(t0), now: t0 }),
    alertRepo,
    now: t0,
  });
  assert.equal(first.length, 1);

  // 60 秒后（冷却期内，窗口桶也不同）不应再次告警
  const t1 = t0 + 60_000;
  const second = persistAlerts({
    candidates: evaluateRules({ rules: [rule], entries: makeEntries(t1), now: t1 }),
    alertRepo,
    now: t1,
  });
  assert.equal(second.length, 0);

  // 冷却结束后允许再次告警
  const t2 = t0 + 1800_000 + 60_000;
  const third = persistAlerts({
    candidates: evaluateRules({ rules: [rule], entries: makeEntries(t2), now: t2 }),
    alertRepo,
    now: t2,
  });
  assert.equal(third.length, 1);
  db.close();
});

test('单轮评估的告警上限按资金绝对量优先截断', () => {
  const now = 1_700_000_000_000;
  const entries = [
    { etf: { ...etfA, code: '510300' }, tradeDate: '2026-10-30', points: [{ ts: now, main_net: 150_000_000, super_net: 0 }] },
    { etf: { ...etfA, code: '510500' }, tradeDate: '2026-10-30', points: [{ ts: now, main_net: 900_000_000, super_net: 0 }] },
    { etf: { ...etfA, code: '159915' }, tradeDate: '2026-10-30', points: [{ ts: now, main_net: 300_000_000, super_net: 0 }] },
  ];
  const candidates = evaluateRules({ rules: [baseRule()], entries, now, maxPerRule: 2 });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].entry.etf.code, '510500');
  assert.equal(candidates[1].entry.etf.code, '159915');
});
