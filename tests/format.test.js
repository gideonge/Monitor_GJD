import test from 'node:test';
import assert from 'node:assert/strict';

import { alertDirection, flowDirectionClass } from '../web/js/format.js';

/**
 * 告警卡片的基础色（底色 + 左侧色条）只表示方向，不表示级别。
 * 这条语义一旦回退（例如按 severity 着色），「高」级别的流出会被画成红色系，
 * 方向直接读反，所以用测试锁住。
 *
 * 量能类指标没有自带方向，方向靠「该分钟涨跌幅 → 主动净买额」两段证据给出。
 */

test('资金类指标：正数走红、负数走绿，证据就是数值本身', () => {
  assert.deepEqual(alertDirection({ metric: 'main_net_delta', value: 30_000_000 }), {
    dir: 'dir-in',
    evidence: 'flow',
  });
  assert.deepEqual(alertDirection({ metric: 'main_net_delta', value: -30_000_000 }), {
    dir: 'dir-out',
    evidence: 'flow',
  });
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

test('量能类指标：倍数不判方向，先看该分钟涨跌幅', () => {
  assert.deepEqual(alertDirection({ metric: 'volume_surge', value: 5.54, priceMovePct: 0.35 }), {
    dir: 'dir-in',
    evidence: 'price',
  });
  assert.deepEqual(alertDirection({ metric: 'volume_surge', value: 5.54, priceMovePct: -0.42 }), {
    dir: 'dir-out',
    evidence: 'price',
  });
  // 倍数本身是正的，但价格向下 → 绿，不能被倍数符号带偏
  assert.equal(flowDirectionClass('volume_preburst', 8.9, -0.31), 'dir-out');
});

test('量能类指标：涨跌幅低于展示精度时，退到主动净买额', () => {
  // 0.004% 在卡片上显示成 +0.00%，不能拿它决定红绿
  assert.deepEqual(
    alertDirection({ metric: 'volume_preburst', value: 2.6, priceMovePct: 0.004, netFlow: -32_000_000 }),
    { dir: 'dir-out', evidence: 'net' },
  );
  assert.deepEqual(
    alertDirection({ metric: 'volume_preburst', value: 2.6, priceMovePct: 0, netFlow: 88_000_000 }),
    { dir: 'dir-in', evidence: 'net' },
  );
  assert.equal(flowDirectionClass('volume_preburst', 2.6, null, 5_000_000), 'dir-in');
});

test('量能类指标：两段证据都没有才是无方向', () => {
  assert.deepEqual(alertDirection({ metric: 'volume_preburst', value: 2.78 }), { dir: 'dir-none', evidence: null });
  assert.deepEqual(
    alertDirection({ metric: 'volume_preburst', value: 2.78, priceMovePct: null, netFlow: null }),
    { dir: 'dir-none', evidence: null },
  );
  assert.deepEqual(
    alertDirection({ metric: 'volume_surge', value: 5.54, priceMovePct: 0, netFlow: 0 }),
    { dir: 'dir-none', evidence: null },
  );
});

test('资金类指标不受价格 / 净额参数影响，方向仍只看 value', () => {
  assert.equal(flowDirectionClass('main_net', -100, 0.5, 50_000_000), 'dir-out');
});

test('级别不参与方向判定：同一正数不论级别都得到同一方向', () => {
  assert.equal(flowDirectionClass('main_net_delta', 30_000_000), 'dir-in');
  assert.equal(flowDirectionClass('main_net_delta', -30_000_000), 'dir-out');
});
