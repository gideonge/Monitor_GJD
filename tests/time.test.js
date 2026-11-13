import test from 'node:test';
import assert from 'node:assert/strict';

import { recentSessionStart, tradeDateStartTs, todayStartTs } from '../server/lib/time.js';

/**
 * 「当日」的统计窗口只能有一个定义。
 *
 * 曾经总览用「今日 0 点与最近交易日 0 点的较早者」，告警历史页用「列表 total」，
 * 于是同一屏出现徽标 204 / 列表 5680 两个数。这个函数就是那个唯一定义，
 * 总览、告警徽标、列表默认范围都调它。
 */

test('有最近交易日时取「今日 0 点」与「交易日 0 点」的较早者', () => {
  const now = Date.parse('2026-11-13T03:00:00Z'); // 北京 11:00
  const today = todayStartTs(now);
  const todayStr = '2026-11-13';

  // 同一交易日：两者相等
  assert.equal(recentSessionStart({ todayStart: today, lastTradeDate: todayStr }), tradeDateStartTs(todayStr));

  // 开盘前（最近交易日还是昨天）：取昨天 0 点，否则昨天 15:00 那批日度告警会整批消失
  assert.equal(
    recentSessionStart({ todayStart: today, lastTradeDate: '2026-11-12' }),
    tradeDateStartTs('2026-11-12'),
  );
  assert.ok(recentSessionStart({ todayStart: today, lastTradeDate: '2026-11-12' }) < today);
});

test('没有最近交易日时退回今日 0 点', () => {
  const today = todayStartTs(Date.parse('2026-11-13T03:00:00Z'));
  assert.equal(recentSessionStart({ todayStart: today, lastTradeDate: null }), today);
  assert.equal(recentSessionStart({ todayStart: today }), today);
});
