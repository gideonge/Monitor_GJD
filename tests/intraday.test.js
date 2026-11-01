import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, assignPreClose } from '../server/services/intradayService.js';
import { beijingTs, isTradeDateClosed } from '../server/lib/time.js';
import { formatAmount } from '../server/lib/format.js';

const bar = (overrides) => ({
  minute: '09:30',
  ts: 0,
  open: 4.06,
  close: 4.06,
  high: 4.06,
  low: 4.06,
  avg_price: 4.06,
  volume: 100,
  amount: 40_600,
  ...overrides,
});

test('分时汇总：开高低收、成交量额与涨跌幅', () => {
  const rows = [
    bar({ ts: 1, minute: '09:30' }),
    bar({ ts: 2, minute: '09:31', close: 4.05, high: 4.07, low: 4.04, avg_price: 4.055, volume: 200, amount: 81_100 }),
    bar({ ts: 3, minute: '09:32', close: 4.08, high: 4.09, low: 4.05, avg_price: 4.062, volume: 300, amount: 121_800 }),
  ];
  const shaped = summarize('510300', '2026-10-30', 4.1, rows);

  assert.equal(shaped.summary.open, 4.06);
  assert.equal(shaped.summary.close, 4.08);
  assert.equal(shaped.summary.high, 4.09);
  assert.equal(shaped.summary.low, 4.04);
  assert.equal(shaped.summary.volume, 600);
  assert.equal(shaped.summary.amount, 243_500);
  assert.equal(shaped.summary.points, 3);
  assert.equal(shaped.summary.avgPrice, 4.062);
  assert.ok(Math.abs(shaped.summary.pctChg - ((4.08 - 4.1) / 4.1) * 100) < 1e-9);
  assert.ok(Math.abs(shaped.summary.amplitude - ((4.09 - 4.04) / 4.1) * 100) < 1e-9);
  assert.equal(shaped.bars.length, 3);
  assert.equal(shaped.bars[2].price, 4.08);
  assert.equal(shaped.bars[2].volume, 300);
});

test('分时汇总：缺少昨收时用当日开盘价兜底', () => {
  const rows = [bar({ ts: 1 }), bar({ ts: 2, close: 4.2 })];
  const shaped = summarize('510300', '2026-10-30', null, rows);
  assert.equal(shaped.preClose, 4.06);
  assert.ok(Math.abs(shaped.summary.pctChg - ((4.2 - 4.06) / 4.06) * 100) < 1e-9);
});

test('分时汇总：空数据返回 null 汇总', () => {
  const shaped = summarize('510300', '2026-10-30', 4.1, []);
  assert.equal(shaped.summary, null);
  assert.deepEqual(shaped.bars, []);
});

test('昨收推导：多日回填时用前一交易日收盘价', () => {
  const rows = [
    bar({ tradeDate: '2026-10-28', ts: 1, close: 4.155 }),
    bar({ tradeDate: '2026-10-28', ts: 2, close: 4.15 }),
    bar({ tradeDate: '2026-10-29', ts: 3, close: 4.145 }),
    bar({ tradeDate: '2026-10-29', ts: 4, close: 4.111 }),
    bar({ tradeDate: '2026-10-30', ts: 5, close: 4.059 }),
    bar({ tradeDate: '2026-10-30', ts: 6, close: 4.065 }),
  ];
  assignPreClose(rows, 4.111);
  const day29 = rows.filter((row) => row.tradeDate === '2026-10-29');
  const day30 = rows.filter((row) => row.tradeDate === '2026-10-30');
  assert.equal(day29[0].preClose, 4.15, '10-29 的昨收取 10-28 收盘');
  assert.equal(day30[0].preClose, 4.111, '10-30 的昨收取 10-29 收盘');
  // 首个交易日无前一日，使用上游 preClose 仅当它是最新交易日；此处 10-28 不应被赋值
  assert.equal(rows[0].preClose, undefined);
});

test('昨收推导：仅单日数据时使用上游 preClose', () => {
  const rows = [bar({ tradeDate: '2026-10-30', ts: 1, close: 4.059 }), bar({ tradeDate: '2026-10-30', ts: 2, close: 4.065 })];
  assignPreClose(rows, 4.111);
  assert.equal(rows[0].preClose, 4.111);
  assert.equal(rows[1].preClose, 4.111);
});

test('分时时间戳：北京时间换算为 UTC 毫秒', () => {
  // 北京 09:30 = UTC 01:30
  assert.equal(beijingTs('2026-10-30', '09:30'), Date.UTC(2026, 9, 30, 1, 30, 0, 0));
  assert.equal(beijingTs('2026-10-30', '15:00'), Date.UTC(2026, 9, 30, 7, 0, 0, 0));
});

test('收盘判定：历史交易日、当日 15 点前后与周末', () => {
  const at = (iso) => new Date(iso).getTime();
  // 2026-10-30 是周五
  assert.equal(isTradeDateClosed('2026-10-29', at('2026-10-30T02:00:00Z')), true);
  assert.equal(isTradeDateClosed('2026-10-30', at('2026-10-30T02:00:00Z')), false); // 北京 10:00 盘中
  assert.equal(isTradeDateClosed('2026-10-30', at('2026-10-30T07:30:00Z')), true); // 北京 15:30 已收盘
  assert.equal(isTradeDateClosed('2026-10-30', at('2026-10-31T02:00:00Z')), true); // 周六
});

test('金额格式与分时成交量口径一致', () => {
  assert.equal(formatAmount(85.87e8, { sign: false }), '85.87亿');
  assert.equal(formatAmount(243_500, { sign: false }), '24.4万');
});
