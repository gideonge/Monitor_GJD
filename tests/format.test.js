import test from 'node:test';
import assert from 'node:assert/strict';

import { flowDirectionClass } from '../web/js/format.js';

/**
 * 告警卡片左侧色条只表示资金方向，不表示级别。
 * 这条语义一旦回退（例如色条重新按 severity 着色），
 * 「高」级别的流出会被画成红条，方向直接读反，所以用测试锁住。
 */

test('资金类指标：正数走红条、负数走绿条', () => {
  assert.equal(flowDirectionClass('main_net_delta', 30_000_000), 'dir-in');
  assert.equal(flowDirectionClass('main_net_delta', -30_000_000), 'dir-out');
  assert.equal(flowDirectionClass('main_net', 1), 'dir-in');
  assert.equal(flowDirectionClass('main_net_rate', -1), 'dir-out');
  assert.equal(flowDirectionClass('main_net_vs_avg', -385_000_000), 'dir-out');
});

test('金额字段即使来自字符串也按数值判方向', () => {
  assert.equal(flowDirectionClass('main_net', '25000000'), 'dir-in');
  assert.equal(flowDirectionClass('main_net', '-25000000'), 'dir-out');
});

test('零值与缺失值不冒充方向', () => {
  assert.equal(flowDirectionClass('main_net', 0), 'dir-none');
  assert.equal(flowDirectionClass('main_net', null), 'dir-none');
  assert.equal(flowDirectionClass('main_net', undefined), 'dir-none');
  assert.equal(flowDirectionClass('main_net', Number.NaN), 'dir-none');
});

test('量能类指标是倍数，没有资金方向，一律中性', () => {
  assert.equal(flowDirectionClass('volume_surge', 5.54), 'dir-none');
  assert.equal(flowDirectionClass('volume_surge', -5.54), 'dir-none');
  assert.equal(flowDirectionClass('volume_preburst', 2.78), 'dir-none');
});

test('级别不参与色条判定：同一正数不论级别都得到同一方向类', () => {
  const value = 30_000_000;
  assert.equal(flowDirectionClass('main_net_delta', value), 'dir-in');
  assert.equal(flowDirectionClass('main_net_delta', -value), 'dir-out');
});
