import test from 'node:test';
import assert from 'node:assert/strict';
import { hasValue, mergeQuoteFields, overlayUniverseRow } from '../server/lib/quoteMerge.js';

test('缺测不覆盖：新快照的 null 不会把上一时刻的值抹掉', () => {
  const previous = { code: '510050', mainNet: -114_000_000, activeNet: 6_896_000_000, price: 2.87 };
  // 腾讯那一轮：只有主动净买，主力净额是 null
  const next = mergeQuoteFields(previous, { code: '510050', mainNet: null, activeNet: 6_900_000_000, price: 2.871 });
  assert.equal(next.mainNet, -114_000_000, 'null 不能覆盖已有的主力净额');
  assert.equal(next.activeNet, 6_900_000_000);
  assert.equal(next.price, 2.871);
});

test('缺测不覆盖：东财那一轮不会把主动净买冲掉', () => {
  const previous = { code: '510300', mainNet: null, activeNet: 2_811_000_000 };
  const next = mergeQuoteFields(previous, { code: '510300', mainNet: -421_000_000, activeNet: null });
  assert.equal(next.mainNet, -421_000_000);
  assert.equal(next.activeNet, 2_811_000_000, '主动净买必须保留');
});

test('成交额 0 视为「没给」，不覆盖上一时刻', () => {
  const next = mergeQuoteFields({ code: '510300', turnover: 10_256_000_000 }, { code: '510300', turnover: 0 });
  assert.equal(next.turnover, 10_256_000_000);
});

test('净额 0 是有效结论，必须覆盖（区别于成交额 0）', () => {
  const next = mergeQuoteFields({ code: '510300', mainNet: 500 }, { code: '510300', mainNet: 0 });
  assert.equal(next.mainNet, 0);
});

test('两个口径各带自己的时间戳，互不推进', () => {
  const previous = { code: '510050', mainNet: 1, mainTs: 1000, activeNet: 2, activeTs: 2000 };
  const next = mergeQuoteFields(previous, { code: '510050', activeNet: 3, quoteTs: 3000 });
  assert.equal(next.activeTs, 3000, '这一轮更新了主动净买');
  assert.equal(next.mainTs, 1000, '主力净额这一轮没更新，时间戳不能跟着变新');
});

test('清单刷新不带净额时，已有净额必须原样保留', () => {
  const previous = { code: '510050', name: '上证50ETF华夏', mainNet: -114_000_000, activeNet: 6_896_000_000, mainTs: 111, activeTs: 222 };
  // 新浪清单只有名字/价格/成交额，没有任何净额字段
  const next = overlayUniverseRow(previous, { code: '510050', name: '上证50ETF华夏', price: 2.87, turnover: 10_000_000_000 });
  assert.equal(next.mainNet, -114_000_000);
  assert.equal(next.activeNet, 6_896_000_000);
  assert.equal(next.mainTs, 111);
  assert.equal(next.activeTs, 222);
  assert.equal(next.price, 2.87);
});

test('清单行带来的新净额（东财清单）应当生效', () => {
  const next = overlayUniverseRow({ code: '510300', mainNet: null }, { code: '510300', mainNet: -42_000_000 });
  assert.equal(next.mainNet, -42_000_000);
});

test('hasValue：成交额要求为正，其余只排除 null/undefined', () => {
  assert.equal(hasValue('turnover', 0), false);
  assert.equal(hasValue('turnover', 1), true);
  assert.equal(hasValue('mainNet', 0), true);
  assert.equal(hasValue('mainNet', null), false);
  assert.equal(hasValue('mainNet', undefined), false);
});
