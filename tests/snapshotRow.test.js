import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshotRows, snapshotTsOf } from '../server/lib/snapshotRow.js';

test('快照行必须同时带上两个净额口径', () => {
  // 回归用例：repo 的 INSERT 有 active_net 列，但调用方曾经漏传 quote.activeNet，
  // 结果腾讯源（只有主动净买）的净额一条都没落库，盘中累计曲线只剩零星几点。
  const rows = buildSnapshotRows(
    [
      // 腾讯那一轮：只有主动净买
      { code: '510300', mainNet: null, activeNet: 6_900_000_000, price: 4.1 },
      // 东财那一轮：只有主力净额
      { code: '510050', mainNet: -114_000_000, activeNet: null, price: 2.87 },
    ],
    'live-tencent',
    { now: 1_700_000_000_000 },
  );

  assert.equal(rows[0].activeNet, 6_900_000_000);
  assert.equal(rows[0].mainNet, null);
  assert.equal(rows[1].mainNet, -114_000_000);
  assert.equal(rows[1].activeNet, null);
  // 缺测不能变成 0：0 是「净额为零」这个具体结论
  assert.equal(rows[0].superNet, null);
  assert.equal(rows[0].turnover, null);
});

test('快照行：口径来源写进 source，时间戳跟随行情时间', () => {
  const now = 1_700_000_000_000;
  const rows = buildSnapshotRows(
    [{ code: '510300', quoteTs: now - 30_000, mainNet: 1, activeNet: null }],
    'live',
    { now },
  );
  assert.equal(rows[0].source, 'live');
  assert.equal(rows[0].ts, now - 30_000);
  assert.equal(rows[0].tradeDate.length, 10);
});

test('时间戳：超过 4 天的行情时间视为脏数据，退回采集时刻', () => {
  const now = 1_700_000_000_000;
  assert.equal(snapshotTsOf({ quoteTs: now - 1000 }, now), now - 1000);
  // 5 天前的时间戳不采信
  assert.equal(snapshotTsOf({ quoteTs: now - 5 * 86400 * 1000 }, now), now);
  assert.equal(snapshotTsOf({}, now), now);
  assert.equal(snapshotTsOf(null, now), now);
});

test('空输入返回空数组，不抛错', () => {
  assert.deepEqual(buildSnapshotRows(null, 'live'), []);
  assert.deepEqual(buildSnapshotRows([], 'live'), []);
});
