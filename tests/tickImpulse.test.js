import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectTickImpulse,
  bucketize,
  mergeEpisodes,
  aggregateResonance,
  sessionOfTs,
  gradeImpulse,
} from '../server/services/tickImpulse.js';

/** 2026-10-30 09:30:00 北京时间 = 01:30:00 UTC，且正好对齐 15 秒桶边界 */
const AM_OPEN = Date.UTC(2026, 9, 30, 1, 30, 0);
const PM_OPEN = Date.UTC(2026, 9, 30, 5, 0, 0);

const PARAMS = {
  bucketSec: 15,
  baselineBuckets: 20,
  minBaselineBuckets: 6,
  minSamplesPerBucket: 3,
  netRatioThreshold: 0.6,
  minNetAmount: 500_000,
  minBuyShare: 0.2,
  zThreshold: 4,
  confirmBuckets: 3,
  mergeGapSec: 90,
  maxEpisodeSec: 600,
  detectDrain: true,
  levelPriceMovePct: 0.12,
};

/** 生成秒级点：每桶金额均分到 15 秒，模拟上游 1 秒一次快照 */
function gen({ startTs = AM_OPEN, count, bucketSec = 15, fill }) {
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const spec = fill(index);
    if (!spec) continue;
    const { amt = 0, net = 0, price = 4 } = spec;
    const seconds = bucketSec;
    for (let s = 0; s < seconds; s += 1) {
      points.push({
        ts: startTs + (index * bucketSec + s) * 1000,
        price,
        amtDelta: amt / seconds,
        netDelta: net / seconds,
        imba: net > 0 ? 0.35 : -0.35,
      });
    }
  }
  return points;
}

const base = (index) => ({ amt: 10_000_000, net: 200_000, price: 4 });
const wave = (index) => ({ amt: 30_000_000, net: 12_000_000, price: 4.004 });

test('分桶：金额按桶累计，无增量秒不计数，价格保留开高低收', () => {
  const points = [
    { ts: AM_OPEN, price: 4.0, amtDelta: null, netDelta: null },
    { ts: AM_OPEN + 1000, price: 4.01, amtDelta: 1_000_000, netDelta: 300_000 },
    { ts: AM_OPEN + 2000, price: 3.99, amtDelta: 0, netDelta: -100_000 },
    { ts: AM_OPEN + 3000, price: 4.02, amtDelta: 500_000, netDelta: 100_000 },
  ];
  const buckets = bucketize(points, { bucketSec: 15 });
  assert.equal(buckets.length, 1);
  const [bucket] = buckets;
  assert.equal(bucket.samples, 3, '首点两个增量都为 null，不能计入样本');
  assert.equal(bucket.amt, 1_500_000);
  assert.equal(bucket.net, 300_000);
  assert.equal(bucket.open, 4.0);
  assert.equal(bucket.close, 4.02);
  assert.equal(bucket.high, 4.02);
  assert.equal(bucket.low, 3.99);
});

test('时段边界：集合竞价与收盘竞价不参与判定', () => {
  const at = (hour, minute, second) => Date.UTC(2026, 9, 30, hour - 8, minute, second);
  assert.equal(sessionOfTs(at(9, 29, 59)), null);
  assert.equal(sessionOfTs(at(9, 30, 0)), 'am');
  assert.equal(sessionOfTs(at(11, 30, 0)), 'am');
  assert.equal(sessionOfTs(at(11, 30, 1)), null);
  assert.equal(sessionOfTs(at(13, 0, 0)), 'pm');
  assert.equal(sessionOfTs(at(14, 56, 59)), 'pm');
  assert.equal(sessionOfTs(at(14, 57, 0)), null);
});

test('连续扫单：连续 3 桶同向大额主动买 → 合成一波', () => {
  const points = gen({ count: 33, fill: (index) => (index >= 30 ? wave(index) : base(index)) });
  const result = detectTickImpulse(points, PARAMS);
  assert.equal(result.episodes.length, 1);
  const [episode] = result.episodes;
  assert.equal(episode.direction, 'surge');
  assert.equal(episode.buckets, 3);
  assert.equal(episode.durationSec, 45);
  assert.equal(episode.sumNet, 36_000_000);
  assert.equal(episode.peakNet, 12_000_000);
  assert.equal(episode.level, 3);
});

test('单桶尖峰不成立：没有相邻同向桶时判为噪声', () => {
  const points = gen({ count: 33, fill: (index) => (index === 31 ? wave(index) : base(index)) });
  const result = detectTickImpulse(points, PARAMS);
  assert.equal(result.episodes.length, 0);
  assert.ok(result.stats.skipped.streak > 0);
});

test('双边放量不算攻势：成交额翻倍但净额占比过低', () => {
  const points = gen({
    count: 40,
    fill: (index) => (index >= 30 ? { amt: 200_000_000, net: 4_000_000, price: 4 } : base(index)),
  });
  const result = detectTickImpulse(points, PARAMS);
  assert.equal(result.episodes.length, 0);
});

test('地量倍数不算攻势：倍数高但绝对净额不足', () => {
  const points = gen({
    count: 40,
    fill: (index) =>
      index < 30 ? { amt: 300_000, net: 20_000, price: 4 } : { amt: 1_200_000, net: 500_000, price: 4 },
  });
  const result = detectTickImpulse(points, PARAMS);
  assert.equal(result.episodes.length, 0);
});

test('主动卖出攻势：方向对称识别', () => {
  const points = gen({
    count: 33,
    fill: (index) =>
      index >= 30 ? { amt: 30_000_000, net: -12_000_000, price: 3.996 } : { amt: 10_000_000, net: -200_000, price: 4 },
  });
  const result = detectTickImpulse(points, PARAMS);
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0].direction, 'drain');
  assert.equal(result.episodes[0].sumNet, -36_000_000);
});

test('基线不足：开盘头几分钟不做判定', () => {
  const points = gen({ count: 6, fill: (index) => (index >= 2 ? wave(index) : base(index)) });
  const result = detectTickImpulse(points, PARAMS);
  assert.equal(result.episodes.length, 0);
  assert.ok(result.stats.skipped.baseline > 0);
});

test('基线不跨午休：午后第一波没有午后基线，不判定', () => {
  const morning = gen({ startTs: AM_OPEN + 110 * 60 * 1000, count: 12, fill: base });
  const afternoon = gen({ startTs: PM_OPEN, count: 6, fill: wave });
  const result = detectTickImpulse([...morning, ...afternoon], PARAMS);
  assert.equal(result.episodes.length, 0);
});

test('波次合并：间隔小于合并窗口算同一波，大于则分开', () => {
  const near = gen({
    count: 40,
    fill: (index) => (index >= 30 && index <= 32 ? wave(index) : index >= 34 && index <= 36 ? wave(index) : base(index)),
  });
  const nearResult = detectTickImpulse(near, PARAMS);
  assert.equal(nearResult.episodes.length, 1);
  assert.equal(nearResult.episodes[0].buckets, 6);

  const far = gen({
    count: 80,
    fill: (index) => (index >= 30 && index <= 32 ? wave(index) : index >= 60 && index <= 62 ? wave(index) : base(index)),
  });
  const farResult = detectTickImpulse(far, PARAMS);
  assert.equal(farResult.episodes.length, 2);
});

test('波次时长上限：超长持续不合成一条无法解读的告警', () => {
  const events = Array.from({ length: 40 }, (_, i) => ({
    index: 100 + i * 3,
    startTs: AM_OPEN + (100 + i * 3) * 15_000,
    endTs: AM_OPEN + (101 + i * 3) * 15_000,
    direction: 'surge',
    net: 12_000_000,
    amt: 30_000_000,
    ratio: 1.2,
    z: 10,
    streak: 2,
    level: 3,
    price: 4,
    priceMove: 0.1,
    baselineAmt: 10_000_000,
  }));
  const episodes = mergeEpisodes(events, { ...PARAMS, maxEpisodeSec: 60 });
  assert.ok(episodes.length > 1);
  for (const episode of episodes) assert.ok(episode.durationSec <= 75);
});

test('跨标的共振：三族同时净买封顶，同族两只不算共振', () => {
  const at = AM_OPEN;
  const make = (code, family, sumNet) => ({
    code,
    name: code,
    family,
    episode: { direction: 'surge', startTs: at, endTs: at + 45_000, sumNet, level: 2, code },
  });

  const three = aggregateResonance([make('510300', '沪深300', 30_000_000), make('510500', '中证500', 20_000_000), make('588000', '科创50', 15_000_000)], {
    windowSec: 120,
  });
  assert.equal(three.length, 1);
  assert.equal(three[0].level, 3);
  assert.equal(three[0].codes.length, 3);

  const sameFamily = aggregateResonance([make('510300', '沪深300', 30_000_000), make('510310', '沪深300', 20_000_000)], {
    windowSec: 120,
  });
  assert.equal(sameFamily.length, 0, '同族两只更可能是 ETF 间的套利平移');

  const twoFamilies = aggregateResonance([make('510300', '沪深300', 30_000_000), make('510500', '中证500', 20_000_000)], {
    windowSec: 120,
  });
  assert.equal(twoFamilies.length, 1);
  assert.equal(twoFamilies[0].level, 2);

  const single = aggregateResonance([make('510300', '沪深300', 30_000_000)], { windowSec: 120 });
  assert.equal(single.length, 0);
});

test('强度分级单调：倍数、z、连续性同时提高时等级不下降', () => {
  const weak = gradeImpulse({ ratio: 0.9, z: 4, buyShare: 0.21, streak: 2 });
  const mid = gradeImpulse({ ratio: 1.6, z: 7, buyShare: 0.35, streak: 3 });
  const strong = gradeImpulse({ ratio: 3.2, z: 12, buyShare: 0.55, streak: 5 });
  assert.equal(weak.level, 1);
  assert.equal(mid.level, 2);
  assert.equal(strong.level, 3);
  assert.ok(weak.score < mid.score && mid.score < strong.score);
});
