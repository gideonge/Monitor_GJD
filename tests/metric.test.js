import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWindowMetrics,
  computeDailyMetrics,
  computeSurgeTimes,
  resolveSeriesMetric,
} from '../server/services/metricService.js';
import { classifyEtf } from '../server/lib/classify.js';
import { formatAmount } from '../server/lib/format.js';

test('窗口指标：两点之间计算变动额与速率', () => {
  const now = 1_700_000_000_000;
  const points = [
    { ts: now - 300_000, main_net: 10_000_000, super_net: 3_000_000, main_ratio: 2 },
    { ts: now - 150_000, main_net: 40_000_000, super_net: 5_000_000, main_ratio: 5 },
    { ts: now, main_net: 70_000_000, super_net: 9_000_000, main_ratio: 7 },
  ];
  const metrics = computeWindowMetrics(points, { windowSec: 300, now });
  assert.equal(metrics.main_net, 70_000_000);
  assert.equal(metrics.main_net_delta, 60_000_000);
  assert.equal(metrics.spanSec, 300);
  assert.equal(metrics.main_net_rate, 12_000_000); // 6000万 / 5分钟
  assert.equal(metrics.coverage, 1);
});

test('窗口指标：单点数据不产生虚假急流', () => {
  const now = 1_700_000_000_000;
  const metrics = computeWindowMetrics([{ ts: now, main_net: 500_000_000, super_net: 0 }], { windowSec: 300, now });
  assert.equal(metrics.main_net_delta, 0);
  assert.equal(metrics.main_net_rate, 0);
  assert.equal(metrics.spanSec, 0);
});

test('窗口指标：超出窗口的历史点被排除在基线之外', () => {
  const now = 1_700_000_000_000;
  const points = [
    { ts: now - 900_000, main_net: -1_000_000_000 },
    { ts: now - 200_000, main_net: 20_000_000 },
    { ts: now, main_net: 50_000_000 },
  ];
  const metrics = computeWindowMetrics(points, { windowSec: 300, now });
  assert.equal(metrics.main_net_delta, 30_000_000);
});

test('日度指标：基准取不含当日的前 5 个交易日', () => {
  const today = { trade_date: '2026-10-30', main_net: -400_000_000, super_net: -300_000_000 };
  const previous = [
    { trade_date: '2026-10-23', main_net: 10_000_000 },
    { trade_date: '2026-10-24', main_net: -10_000_000 },
    { trade_date: '2026-10-27', main_net: 30_000_000 },
    { trade_date: '2026-10-28', main_net: -30_000_000 },
    { trade_date: '2026-10-29', main_net: 20_000_000 },
  ];
  const metrics = computeDailyMetrics(today, previous);
  assert.equal(metrics.baselineAvg, 4_000_000);
  assert.equal(metrics.main_net_vs_avg, -404_000_000);
  assert.equal(metrics.baselineDays, 5);
  assert.equal(computeSurgeTimes(today, previous), -100);
});

test('日度指标：无历史数据时不臆造基准', () => {
  const metrics = computeDailyMetrics({ trade_date: '2026-10-30', main_net: 1 }, []);
  assert.equal(metrics.baselineAvg, null);
  assert.equal(metrics.main_net_vs_avg, null);
});

test('ETF 分类：关键词优先级符合预期', () => {
  assert.equal(classifyEtf('酒ETF鹏华'), '消费');
  assert.equal(classifyEtf('沪深300ETF华泰柏瑞'), '宽基指数');
  assert.equal(classifyEtf('科创50ETF华夏'), '宽基指数');
  assert.equal(classifyEtf('恒生科技ETF易方达'), '跨境');
  assert.equal(classifyEtf('黄金ETF华安'), '商品');
  assert.equal(classifyEtf('政金债券ETF'), '债券货币');
  assert.equal(classifyEtf('半导体ETF国联安'), '科技成长');
  assert.equal(classifyEtf('证券ETF华宝'), '金融地产');
  assert.equal(classifyEtf('军工ETF'), '军工制造');
  assert.equal(classifyEtf('新能源车ETF'), '新能源');
  assert.equal(classifyEtf('未知名称基金'), '其他');
});

test('金额格式化覆盖 亿 / 万 / 元 与负值', () => {
  assert.equal(formatAmount(123_000_000), '+1.23亿');
  assert.equal(formatAmount(-4_560_000), '-456.0万');
  assert.equal(formatAmount(0), '0元');
  assert.equal(formatAmount(12_300), '+1.2万');
  assert.equal(formatAmount(880), '+880元');
  assert.equal(formatAmount(880, { sign: false }), '880元');
  assert.equal(formatAmount(null), '—');
});

// ---------------- 单口径锁定：两种净额不能混在一条序列里相减 ----------------

test('序列口径：最新点是腾讯就整条取主动净买，东财点被剔除', () => {
  const now = 1_700_000_000_000;
  const points = [
    // 东财那几分钟只写 main_net（主力净额 −10 亿）
    { ts: now - 300_000, main_net: -1_000_000_000, active_net: null },
    { ts: now - 240_000, main_net: -1_000_000_000, active_net: null },
    // 腾讯那几分钟只写 active_net（主动净买 +70 亿）
    { ts: now - 120_000, main_net: null, active_net: 6_900_000_000 },
    { ts: now, main_net: null, active_net: 7_000_000_000 },
  ];
  assert.equal(resolveSeriesMetric(points), 'active_net');
  const metrics = computeWindowMetrics(points, { windowSec: 300, now });
  // 只有两个腾讯点参与，变动 = 1 亿；若混算会得到 80 亿的假急流
  assert.equal(metrics.net_metric, 'active_net');
  assert.equal(metrics.main_net, 7_000_000_000);
  assert.equal(metrics.main_net_delta, 100_000_000);
});

test('序列口径：最新点是东财就只取主力净额，腾讯点被剔除', () => {
  const now = 1_700_000_000_000;
  const points = [
    { ts: now - 240_000, main_net: null, active_net: 6_900_000_000 },
    { ts: now - 120_000, main_net: -900_000_000, active_net: null },
    { ts: now, main_net: -1_000_000_000, active_net: null },
  ];
  assert.equal(resolveSeriesMetric(points), 'main_net');
  const metrics = computeWindowMetrics(points, { windowSec: 300, now });
  assert.equal(metrics.net_metric, 'main_net');
  assert.equal(metrics.main_net, -1_000_000_000);
  assert.equal(metrics.main_net_delta, -100_000_000);
});

test('序列口径：整条都缺净额时返回 null，不伪造 0', () => {
  const now = 1_700_000_000_000;
  const points = [
    { ts: now - 60_000, main_net: null, active_net: null },
    { ts: now, main_net: null, active_net: null },
  ];
  assert.equal(resolveSeriesMetric(points), null);
  assert.equal(computeWindowMetrics(points, { windowSec: 300, now }), null);
  assert.equal(computeWindowMetrics([], { windowSec: 300, now }), null);
});
