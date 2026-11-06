import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSinaRow, parseSinaList, parseSinaMinuteKline } from '../server/providers/sina.js';
import { toMinuteQuoteRow } from '../server/providers/tencent.js';

/**
 * 备源链路的核心风险不在网络，而在「字段折算错了却看起来像正常数据」。
 * 所以这里只测纯函数：新浪行 → 本项目行情行，腾讯逐笔 → 累计主动净买额。
 */

test('新浪行：沪市代码映射到 market=1，并带上现价与成交额', () => {
  const row = normalizeSinaRow({
    symbol: 'sh510300',
    code: '510300',
    name: '沪深300ETF华泰柏瑞',
    trade: '4.065',
    changepercent: '0.918',
    amount: '8614000000',
  });
  assert.equal(row.code, '510300');
  assert.equal(row.market, 1);
  assert.equal(row.name, '沪深300ETF华泰柏瑞');
  assert.equal(row.price, 4.065);
  assert.equal(row.pctChg, 0.918);
  assert.equal(row.turnover, 8614000000);
});

test('新浪行：深市代码映射到 market=0', () => {
  const row = normalizeSinaRow({ symbol: 'sz159919', code: '159919', trade: '4.111', amount: '1' });
  assert.equal(row.market, 0);
});

test('新浪行：没有主力净流入字段时必须给 null 而不是 0', () => {
  // 给 0 会被聚合当成「今天主力净额为 0」计入样本，把均值稀释掉；
  // 给 null 才会被 typeof 判断排除，这是 queryService 的分母口径。
  const row = normalizeSinaRow({ symbol: 'sh510300', code: '510300', trade: '4.065' });
  assert.equal(row.mainNet, null);
  assert.equal(row.mainRatio, null);
  assert.equal(row.superNet, null);
});

test('新浪行：停牌（价格为 0）与非法代码都要丢弃', () => {
  assert.equal(normalizeSinaRow({ symbol: 'sh510300', code: '510300', trade: '0' }), null);
  assert.equal(normalizeSinaRow({ symbol: 'sh510300', code: '510300', trade: '--' }), null);
  assert.equal(normalizeSinaRow({ symbol: 'bj430047', code: '430047', trade: '1.2' }), null);
  assert.equal(normalizeSinaRow({ symbol: 'sh5103', code: '5103', trade: '1.2' }), null);
});

test('新浪清单：空响应与 null 字面量都当成空数组，不抛错', () => {
  assert.deepEqual(parseSinaList(''), []);
  assert.deepEqual(parseSinaList('null'), []);
  assert.deepEqual(parseSinaList('[]'), []);
});

test('新浪清单：剥掉括号包裹与结尾分号', () => {
  const rows = parseSinaList('([{"code":"510300","symbol":"sh510300","trade":"4"}])');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, '510300');
});

test('新浪清单：非法 JSON 要抛出可识别的上游错误', () => {
  assert.throws(() => parseSinaList('<html>502 Bad Gateway</html>'), /不是合法 JSON/);
});

test('腾讯折算：主动净买额 =（外盘 − 内盘）× 100 × 现价，且绝不写进 mainNet', () => {
  // 外盘 120000 手、内盘 100000 手、现价 4 元 → 净买 20000 手 = 200 万份 × 4 = 800 万元
  const row = toMinuteQuoteRow(
    { code: '510300', price: 4, pctChg: 1.2, amount: 5_000_000_000, outer: 120000, inner: 100000, ts: 1 },
    1,
  );
  assert.equal(row.activeNet, 20_000 * 100 * 4);
  // 口径红线：腾讯只有主动净买，主力净额必须留空，交给东财那一轮填
  assert.equal(row.mainNet, null);
  assert.equal(row.turnover, 5_000_000_000);
  assert.equal(row.quoteTs, 1);
  assert.equal(row.name, null); // 名称由上层用库内值补
});

test('腾讯折算：主动卖出为负值，不能被截断', () => {
  const row = toMinuteQuoteRow({ code: '510300', price: 2, outer: 1000, inner: 3000, amount: 1 }, 1);
  assert.equal(row.activeNet, -2000 * 100 * 2);
  assert.equal(row.mainNet, null);
});

test('腾讯折算：缺外盘/内盘时净额给 null，不能当 0', () => {
  const row = toMinuteQuoteRow({ code: '510300', price: 4, amount: 100, outer: null, inner: null }, 1);
  assert.equal(row.activeNet, null);
  assert.equal(row.mainNet, null);
});

test('腾讯折算：无效价格返回 null，避免把停牌快照写进库', () => {
  assert.equal(toMinuteQuoteRow({ code: '510300', price: 0, outer: 1, inner: 1 }, 1), null);
  assert.equal(toMinuteQuoteRow({ code: '51030', price: 4 }, 1), null);
  assert.equal(toMinuteQuoteRow(null, 1), null);
});

// ---------------- 新浪分钟 K 线：分时的第三个源 ----------------

test('新浪分钟线：成交量从「股」换成「手」，均价按当日累计还原', () => {
  const text = JSON.stringify([
    { day: '2026-11-06 09:31:00', open: '2.500', high: '2.505', low: '2.495', close: '2.500', volume: '1000000', amount: '2500000' },
    { day: '2026-11-06 09:32:00', open: '2.500', high: '2.510', low: '2.498', close: '2.505', volume: '2000000', amount: '5010000' },
  ]);
  const rows = parseSinaMinuteKline(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].volume, 10000); // 100 万股 → 1 万手
  assert.equal(rows[1].volume, 20000);
  assert.equal(rows[0].amount, 2500000);
  assert.equal(rows[0].avgPrice, 2.5); // 250万 / 100万股
  // 第二根要用两天累计的额除以累计的量，不是单根的额/量
  assert.equal(rows[1].avgPrice, (2500000 + 5010000) / (1000000 + 2000000));
  assert.equal(rows[1].high, 2.51);
  assert.equal(rows[1].minute, '09:32');
  assert.equal(rows[1].tradeDate, '2026-11-06');
  assert.equal(rows[1].source, 'sina');
});

test('新浪分钟线：午休、盘后与非法行一律剔除', () => {
  const text = JSON.stringify([
    { day: '2026-11-06 09:25:00', close: '2.49', volume: '100', amount: '24900' },
    { day: '2026-11-06 11:30:00', close: '2.49', volume: '100', amount: '24900' },
    { day: '2026-11-06 12:15:00', close: '2.49', volume: '100', amount: '24900' },
    { day: '2026-11-06 15:00:00', close: '2.49', volume: '100', amount: '24900' },
    { day: '2026-11-06 15:30:00', close: '2.49', volume: '100', amount: '24900' },
    { day: 'bad-stamp', close: '2.49' },
    { day: '2026-11-06 13:05:00', close: '0' },
  ]);
  const minutes = parseSinaMinuteKline(text).map((row) => row.minute);
  assert.deepEqual(minutes, ['11:30', '15:00']);
});

test('新浪分钟线：空响应返回空数组，不是合法 JSON 时报错', () => {
  assert.deepEqual(parseSinaMinuteKline('null'), []);
  assert.deepEqual(parseSinaMinuteKline(''), []);
  assert.deepEqual(parseSinaMinuteKline('[]'), []);
  assert.throws(() => parseSinaMinuteKline('<html>waf</html>'), /不是合法 JSON/);
});
