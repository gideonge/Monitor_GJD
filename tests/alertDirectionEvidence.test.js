import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations } from '../server/db/index.js';
import { createAlertRepo } from '../server/repositories/alertRepo.js';
import { createRuleRepo } from '../server/repositories/ruleRepo.js';
import { mapAlertRow } from '../server/lib/serialize.js';
import { persistSurgeAlerts, persistPreburstAlerts } from '../server/services/alertService.js';

/**
 * 方向证据必须「推给前端的那条」和「库里读出来的那条」一致。
 *
 * 量能类告警的 value 是成交量倍数，没有方向；前端上色要靠 price_move_pct / net_flow。
 * 这两个字段只要有一条路径漏写，同一波行情在实时流里是红色、刷新后变灰，
 * 用户会以为是数据错了，所以在这里把两条写入路径都钉住。
 */

const here = path.dirname(fileURLToPath(import.meta.url));

function setup() {
  const db = openDatabase(':memory:');
  runMigrations(db, path.join(here, '..', 'server', 'db', 'migrations'), null);
  const alertRepo = createAlertRepo(db);
  // alert.rule_id 有外键，规则必须先真实存在
  const ruleRepo = createRuleRepo(db);
  const surgeRuleId = ruleRepo.create({
    name: '分钟量能突变',
    metric: 'volume_surge',
    timeframe: 'intraday',
    comparator: 'gt',
    threshold: 3,
    windowSec: 1200,
    severity: 'high',
    cooldownSec: 0,
  });
  const preburstRuleId = ruleRepo.create({
    name: '分钟内实时爆量',
    metric: 'volume_preburst',
    timeframe: 'intraday',
    comparator: 'gt',
    threshold: 2.5,
    windowSec: 1200,
    severity: 'high',
    cooldownSec: 0,
  });
  const flowRuleId = ruleRepo.create({
    name: '5分钟主力急速流出',
    metric: 'main_net_delta',
    timeframe: 'window',
    comparator: 'lt',
    threshold: -30_000_000,
    windowSec: 300,
    severity: 'high',
    cooldownSec: 0,
  });
  return { db, alertRepo, surgeRuleId, preburstRuleId, flowRuleId };
}

const etf = { code: '512500', name: '中证500ETF', category: '宽基指数', market: 1, tracked: 1 };

/** 服务层只读取规则上的这几个字段，其余（scope/enabled）与本用例无关 */
function ruleOf(id, overrides = {}) {
  return {
    id,
    name: '规则',
    timeframe: 'intraday',
    comparator: 'gt',
    threshold: 3,
    windowSec: 1200,
    severity: 'high',
    cooldownSec: 0,
    ...overrides,
  };
}

test('分钟量能突变：涨跌幅随告警一起落库，SSE 事件与读库同一口径', () => {
  const { alertRepo, surgeRuleId } = setup();
  const ts = Date.parse('2026-11-12T06:14:00Z');
  const created = persistSurgeAlerts({
    candidates: [
      {
        rule: ruleOf(surgeRuleId, { name: '分钟量能突变', metric: 'volume_surge' }),
        etf,
        tradeDate: '2026-11-12',
        severity: 'high',
        source: 'live',
        event: {
          minute: '14:14',
          ts,
          ratio: 30.45,
          volume: 3_045_000,
          baseline: 100_000,
          tickRet: 0.203,
          direction: 'surge',
          level: 3,
          confirm: 'break',
          evidence: ['break'],
          dayPeak: false,
          mergedBars: 1,
        },
      },
    ],
    alertRepo,
    logger: null,
    params: { baselineWindow: 20 },
    now: ts,
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].priceMovePct, 0.203, 'SSE 推出去的事件要带上方向证据');

  const row = alertRepo.getById(created[0].id);
  assert.equal(row.price_move_pct, 0.203);
  assert.equal(mapAlertRow(row).priceMovePct, 0.203);
});

test('分钟内实时爆量：价格还没走时，主动净买额兜底落库', () => {
  const { alertRepo, preburstRuleId } = setup();
  const ts = Date.parse('2026-11-12T06:03:22Z');
  const created = persistPreburstAlerts({
    candidates: [
      {
        rule: ruleOf(preburstRuleId, { name: '分钟内实时爆量', metric: 'volume_preburst', threshold: 2.5 }),
        etf,
        tradeDate: '2026-11-12',
        severity: 'high',
        source: 'live',
        evaluation: {
          minute: '14:03',
          lastTs: ts,
          elapsedSec: 9,
          level: 3,
          amount: 3_200_000,
          projectedAmount: 21_000_000,
          projectedRatio: 2.54,
          baseline: 8_300_000,
          barAmount: 1_100_000,
          net: -32_000_000,
          netRatio: -0.42,
          direction: 'drain',
          price: 6.12,
          priceMovePct: 0,
        },
      },
    ],
    alertRepo,
    logger: null,
    params: { baselineMinutes: 20, curveQuantile: 0.8, minElapsedSec: 9, minAmount: 3_000_000 },
    now: ts,
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].priceMovePct, 0);
  assert.equal(created[0].netFlow, -32_000_000);

  const mapped = mapAlertRow(alertRepo.getById(created[0].id));
  assert.equal(mapped.priceMovePct, 0);
  assert.equal(mapped.netFlow, -32_000_000, '价格没动时，读库也要能拿到净额这一段的证据');
});

test('资金类告警不需要方向证据字段，读出来是空而不是 0', () => {
  const { alertRepo, flowRuleId } = setup();
  const id = alertRepo.insert({
    ruleId: flowRuleId,
    ruleName: '5分钟主力急速流出',
    code: '512500',
    etfName: '中证500ETF',
    metric: 'main_net_delta',
    timeframe: 'window',
    comparator: 'lt',
    threshold: -30_000_000,
    value: -31_000_000,
    severity: 'high',
    conditionText: '5分钟窗口期净流入变动额 小于 -3000.0万',
    message: '中证500ETF -3100.0万',
    dedupeKey: 'w:2026-11-12:1',
    triggeredAt: Date.parse('2026-11-12T06:10:00Z'),
  });

  const mapped = mapAlertRow(alertRepo.getById(id));
  assert.equal(mapped.priceMovePct, null);
  assert.equal(mapped.netFlow, null, '空值必须是 null，不能是 0（0 会被前端当成「无方向」以外的语义）');
});
