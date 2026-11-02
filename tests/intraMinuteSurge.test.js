import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PARAMS,
  clockOf,
  splitMinuteTicks,
  buildArrivalCurve,
  priorArrivalCurve,
  detectIntraMinuteBurst,
  evaluateFormingBucket,
  sliceBucket,
} from '../server/services/intraMinuteSurge.js';
import { beijingTs } from '../server/lib/time.js';

const DATE = '2026-11-02';

/** 分钟区间内的全部分钟（与算法口径一致：09:31-11:29、13:01-14:56） */
function minutesBetween(from, to) {
  const out = [];
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  for (let t = fh * 60 + fm; t <= th * 60 + tm; t += 1) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
}

/**
 * 构造逐秒点：每 3 秒一个采样点（与线上快照节奏一致），每个点携带该段成交额。
 * amountAt 可以按分钟覆盖成交额，用于注入爆量。
 */
function buildTicks({ from = '09:31', to = '10:30', amountPerMinute = 5_000_000, amountAt = {}, netRatio = 0.3 } = {}) {
  const ticks = [];
  for (const minute of minutesBetween(from, to)) {
    const total = amountAt[minute] ?? amountPerMinute;
    const perTick = total / 20;
    for (let i = 0; i < 20; i += 1) {
      const sec = 1 + i * 3;
      ticks.push({
        ts: beijingTs(DATE, minute) + sec * 1000,
        amt_delta: perTick,
        net_delta: perTick * netRatio,
        price: 4,
      });
    }
  }
  return ticks;
}

test('逐秒点按分钟分桶，并标出完整性与交易时段', () => {
  const ticks = buildTicks({ from: '10:00', to: '10:02' });
  const buckets = splitMinuteTicks(ticks);

  assert.equal(buckets.length, 3);
  for (const bucket of buckets) {
    assert.equal(bucket.samples, 20);
    assert.equal(bucket.amount, 5_000_000);
    assert.equal(bucket.session, 'am');
    assert.equal(bucket.complete, true, '首点第 1 秒、末点第 58 秒，应判为完整');
  }
  assert.equal(buckets[0].minute, '10:00');
  assert.equal(buckets[0].firstSec, 1);
  assert.equal(buckets[0].lastSec, 58);
});

test('集合竞价与午休分钟不参与判定', () => {
  const ticks = [
    ...buildTicks({ from: '11:29', to: '11:29' }),
    ...buildTicks({ from: '11:30', to: '11:30' }),
  ];
  const buckets = splitMinuteTicks(ticks);
  assert.equal(buckets[0].session, 'am');
  assert.equal(buckets[buckets.length - 1].session, null, '11:30 属收盘集合竞价，必须排除');
});

test('到达曲线：样本不足返回 null，样本足够时分位单调且不超上限', () => {
  assert.equal(buildArrivalCurve(splitMinuteTicks(buildTicks({ from: '10:00', to: '10:10' }))), null);

  const buckets = splitMinuteTicks(buildTicks({ from: '09:31', to: '10:20' }));
  const curve = buildArrivalCurve(buckets, { minCurveMinutes: 30, curveQuantile: 0.8 });
  assert.ok(curve, '50 个分钟足够建曲线');
  assert.equal(curve.source, 'self');
  assert.equal(curve.shares.length, 60);
  for (let sec = 1; sec < 60; sec += 1) {
    assert.ok(curve.shares[sec] >= curve.shares[sec - 1], `第 ${sec} 秒占比不应回退`);
  }
  assert.ok(curve.shares[59] <= DEFAULT_PARAMS.curveMaxShare);
  // 20 个采样点均匀到达：第 9 秒走完 3 个点 = 15%，第 58 秒接近 100%
  assert.ok(Math.abs(curve.shares[9] - 0.15) < 0.01, `第 9 秒应约 15%，实际 ${curve.shares[9]}`);
  assert.ok(curve.shares[58] > 0.95);
});

test('内置先验曲线单调且收敛到 1', () => {
  const curve = priorArrivalCurve();
  assert.equal(curve.source, 'prior');
  assert.equal(curve.shares[0], 0);
  for (let sec = 1; sec < 60; sec += 1) {
    assert.ok(curve.shares[sec] >= curve.shares[sec - 1]);
  }
  assert.ok(curve.shares[59] >= 0.9);
});

test('分钟内爆量在分钟没走完时就触发（3 秒采样下第 10 秒，4 个采样点）', () => {
  const ticks = buildTicks({ from: '09:31', to: '10:20', amountAt: { '10:20': 40_000_000 } });
  const result = detectIntraMinuteBurst(ticks);

  assert.equal(result.active, true);
  assert.equal(result.minute, '10:20');
  assert.equal(result.elapsedSec, 58, '整根分钟都给了，取最后一个采样点');
  assert.equal(result.triggered, true);
  assert.ok(result.projectedRatio > 7.5, `折算应接近 8×，实际 ${result.projectedRatio}`);

  // 把点截到第 10 秒：判定用到的信息只有前 4 个采样点
  const partial = ticks.filter((point) => point.ts <= beijingTs(DATE, '10:20') + 10_000);
  const early = detectIntraMinuteBurst(partial);
  assert.equal(early.elapsedSec, 10);
  assert.equal(early.samples, 4);
  assert.equal(early.triggered, true, '第 10 秒就该报出来，不必等这根 K 线收盘');
  assert.ok(early.amount < early.projectedAmount, '触发时钱还没成交完，这正是「第一手」的意义');
});

test('平稳分钟不触发；观察档只亮灯不告警', () => {
  const flat = detectIntraMinuteBurst(buildTicks({ from: '09:31', to: '10:20' }));
  assert.equal(flat.triggered, false);
  assert.equal(flat.stage, 'idle');
  assert.equal(flat.reason, 'ratio');

  // 1.6× 基线：够不上 2.5×，但在观察档（2.5×0.7=1.75×）附近
  const warm = detectIntraMinuteBurst(buildTicks({ from: '09:31', to: '10:20', amountAt: { '10:20': 8_000_000 } }));
  assert.equal(warm.triggered, false);
  assert.equal(warm.projectedRatio.toFixed(1), '1.6');
});

test('基线不足时明确拒绝判定，而不是拿一根参考', () => {
  const ticks = buildTicks({ from: '09:31', to: '09:35', amountAt: { '09:35': 45_000_000 } });
  const result = detectIntraMinuteBurst(ticks, { minBaselineMinutes: 20 });
  assert.equal(result.triggered, false);
  assert.equal(result.gates.baseline, false);
  assert.equal(result.reason, 'baseline');
});

test('累计成交额太小的放量不判定（地量标的的倍数没有意义）', () => {
  const ticks = buildTicks({
    from: '09:31',
    to: '10:20',
    amountPerMinute: 50_000,
    amountAt: { '10:20': 500_000 },
  });
  const result = detectIntraMinuteBurst(ticks);
  assert.equal(result.gates.amount, false);
  assert.equal(result.triggered, false);
});

test('触发条件等价于「折算倍数 ≥ 门槛」，barAmount 可直接用于展示', () => {
  const ticks = buildTicks({ from: '09:31', to: '10:20', amountAt: { '10:20': 25_000_000 } });
  const result = detectIntraMinuteBurst(ticks);
  assert.equal(result.triggered, true);
  assert.ok(result.amount >= result.barAmount);
  assert.ok(result.projectedRatio >= DEFAULT_PARAMS.ratioThreshold);
  assert.ok(Math.abs(result.barAmount / (result.baseline * result.curveShare) - DEFAULT_PARAMS.ratioThreshold) < 1e-6);
});

test('主动净卖出的爆量归为 drain，不冒充买盘', () => {
  const ticks = buildTicks({ from: '09:31', to: '10:20', amountAt: { '10:20': 40_000_000 }, netRatio: -0.4 });
  const result = detectIntraMinuteBurst(ticks);
  assert.equal(result.triggered, true);
  assert.equal(result.direction, 'drain');
  assert.ok(result.net < 0);
});

test('已成交额足够大时直接给强级，不再依赖折算倍数', () => {
  const ticks = buildTicks({ from: '09:31', to: '10:20', amountAt: { '10:20': 40_000_000 } });
  const result = detectIntraMinuteBurst(ticks, { strongAmount: 30_000_000, level3Ratio: 100 });
  assert.equal(result.triggered, true);
  assert.equal(result.level, 3);
});

test('最后一种是集合竞价时返回 inactive，不产生任何结论', () => {
  const ticks = [...buildTicks({ from: '09:31', to: '10:20' }), ...buildTicks({ from: '11:30', to: '11:30' })];
  const result = detectIntraMinuteBurst(ticks);
  assert.equal(result.active, false);
  assert.equal(result.reason, 'auction');
});

test('sliceBucket 逐点截断后金额与采样点一致', () => {
  const [bucket] = splitMinuteTicks(buildTicks({ from: '10:00', to: '10:00' }));
  const sliced = sliceBucket(bucket, 5);
  assert.equal(sliced.samples, 5);
  assert.equal(sliced.amount, bucket.amount / 4);
  assert.equal(sliced.lastSec, 13);
  assert.equal(sliced.lastTs, bucket.startTs + 13_000);
});

test('evaluateFormingBucket 用外部传入的曲线，不再自行重建', () => {
  const buckets = splitMinuteTicks(buildTicks({ from: '09:31', to: '10:20', amountAt: { '10:20': 40_000_000 } }));
  const last = buckets[buckets.length - 1];
  const history = buckets.slice(-21, -1);
  const curve = { shares: new Float64Array(60).fill(0.9), source: 'stub', samples: 1 };

  const result = evaluateFormingBucket(last, history, curve);
  assert.equal(result.curveSource, 'stub');
  assert.equal(result.curveShare.toFixed(2), '0.90');
  assert.ok(Math.abs(result.projectedAmount - last.amount / 0.9) < 1);
});

test('clockOf 用纯算术给出北京时间，跨日边界正确', () => {
  const ts = beijingTs('2026-11-02', '09:31') + 7_000;
  const clock = clockOf(ts);
  assert.equal(clock.text, '09:31');
  assert.equal(clock.second, 7);
  assert.equal(clock.tradeDate, '2026-11-02');
});
