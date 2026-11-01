#!/usr/bin/env node
/**
 * 秒级攻势检测的参数标定 / 回放工具。
 *
 * 为什么需要合成数据：
 *   秒级行情没有公开的历史接口，免费源只给「当前快照」，分笔历史要买。
 *   本项目首个交易日之前，库里只有收盘那一次快照（15 行），无法回测。
 *   所以这里用统计特征可控的合成秒级流来回答两个问题：
 *     1. 在没有国家队入场的纯噪声日，算法每小时会误报几次？（误报率）
 *     2. 注入一段真实的扫单形态，算法多久能抓到？（检出率与延迟）
 *   合成模型不是要「证明算法有效」，而是要把参数从「拍脑袋」变成「有数字支撑的取舍」。
 *   真实数据进来后，用 --replay 直接回放当天秒级库重算，届时以真实误报率为准。
 *
 * 噪声模型的三个关键假设（都来自秒级数据的已知性质）：
 *   - 成交稀疏且重尾：每秒成交额服从对数正态，中位数量级由当日均额反推，偶发大单造成长尾；
 *   - 主动买卖序贯相关：真实订单流有强自相关（连续几秒偏买），用 AR(1) 模拟，
 *     这一点决定了「连续桶」确认到底有多大价值——如果噪声独立，2 桶确认毫无必要；
 *   - 日内 U 型量能：开盘与尾盘放量、午间缩量，用来验证基线是否能自适应而不误报。
 *
 * 用法：
 *   node scripts/backtest-tick-impulse.js                 # 参数扫描（默认 3 组 × 4 小时 × 5 个随机种子）
 *   node scripts/backtest-tick-impulse.js --seeds=10      # 更多随机种子，误报率更稳
 *   node scripts/backtest-tick-impulse.js --replay        # 回放库内真实秒级数据
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectTickImpulse } from '../server/services/tickImpulse.js';
import { config } from '../server/config/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find((item) => item.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const SEEDS = argOf('seeds', 5);
const REPLAY = args.includes('--replay');

/** 可复现的均匀随机数（mulberry32） */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(random) {
  const u = Math.max(random(), 1e-9);
  const v = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 日内量能 U 型曲线：开盘 1.6 倍、11:30 前后 1.1 倍、13:00 后 0.85 倍、尾盘 1.4 倍。
 * 用连续函数而不是阶跃，是为了让基线平滑滚动，不给算法制造人为台阶。
 */
function intradayShape(secondOfSession) {
  const hours = secondOfSession / 3600;
  return 1 + 0.6 * Math.exp(-hours * 2.2) + 0.4 * Math.exp((hours - 4) * 1.8);
}

/**
 * 生成一个交易日的秒级流。
 *
 * @param {object} opts
 * @param {number} opts.seed        随机种子
 * @param {number} opts.baseBucketAmt 15 秒桶的基准成交额（元），默认按 510300 的日成交 86 亿反推
 * @param {Array}  opts.waves       注入的攻势 [{ startSec, durationSec, volumeMult, buyRatio }]
 */
function simulateDay({ seed, baseBucketAmt = 9_000_000, waves = [], sessionLenSec = 5.5 * 3600 }) {
  const random = rng(seed);
  const points = [];
  // 09:30:00 北京 = 01:30:00 UTC
  const startTs = Date.UTC(2026, 9, 30, 1, 30, 0);

  // 订单流方向的自相关：ρ=0.72，稳态标准差约 0.1。真实 ETF 的主动买占比大致在 0.4-0.6 之间游走
  const rho = 0.72;
  let bias = 0;
  let price = 4.0;
  /** 流动性突发：指数再平衡、新闻、大额调仓造成的无方向放量，是误报的主要来源 */
  let burstLeft = 0;
  let burstMult = 1;
  let burstBias = 0;

  const waveOf = (sec) => waves.find((wave) => sec >= wave.startSec && sec < wave.startSec + wave.durationSec) ?? null;

  for (let sec = 0; sec < sessionLenSec; sec += 1) {
    // 午休 11:30-13:00 不产生数据
    const clock = 9 * 3600 + 30 * 60 + sec;
    if (clock >= 11 * 3600 + 30 * 60 && clock < 13 * 3600) continue;

    // 每 8 小时约 30 次无方向放量，持续 5-25 秒，量能 3-7 倍
    if (burstLeft <= 0 && random() < 0.0009) {
      burstLeft = 5 + Math.floor(random() * 20);
      burstMult = 3 + random() * 4;
      burstBias = (random() - 0.5) * 0.25;
    }
    const burst = burstLeft > 0 ? burstMult : 1;
    const burstDirection = burstLeft > 0 ? burstBias : 0;
    if (burstLeft > 0) burstLeft -= 1;

    const wave = waveOf(sec);
    const shape = intradayShape(sec);
    const mult = (wave ? wave.volumeMult : 1) * burst;

    // 每秒成交额：对数正态，中位数按桶均额折算；偶发大单形成长尾
    const medianSec = (baseBucketAmt / 15) * shape * mult;
    const amt = medianSec * Math.exp(gauss(random) * 1.05);
    if (amt <= 0) continue;

    // 主动买占比：AR(1) 噪声 + 攻势期间的定向偏移
    bias = rho * bias + gauss(random) * 0.075;
    const raw = 0.5 + bias + burstDirection + (wave ? wave.buyRatio - 0.5 : 0);
    const pBuy = Math.min(0.97, Math.max(0.03, raw));
    const net = amt * (2 * pBuy - 1);

    // 价格：净买入推动价格，叠加噪声
    price += net / 1e9 * 0.02 + gauss(random) * 0.00015;

    points.push({
      ts: startTs + sec * 1000,
      price: Number(price.toFixed(4)),
      amtDelta: amt,
      netDelta: net,
      imba: Number((pBuy * 2 - 1).toFixed(3)),
    });
  }

  return points;
}

/**
 * 注入的攻势：按真实交易时钟排布，避开午休。
 * 第 4 波刻意做弱（2.5 倍量能、68% 主动买），用来标出算法的灵敏度下限。
 */
function defaultWaves() {
  const at = (hhmm) => {
    const [hour, minute] = hhmm.split(':').map(Number);
    return hour * 3600 + minute * 60 - (9 * 3600 + 30 * 60);
  };
  return [
    { startSec: at('09:55'), durationSec: 90, volumeMult: 6, buyRatio: 0.82 },
    { startSec: at('10:40'), durationSec: 60, volumeMult: 4, buyRatio: 0.76 },
    { startSec: at('13:15'), durationSec: 120, volumeMult: 8, buyRatio: 0.85 },
    { startSec: at('14:30'), durationSec: 45, volumeMult: 2.5, buyRatio: 0.68 },
  ];
}

/** 判定某波是否被检出，并返回「波次起点与真实起点的偏差」（秒，0 表示起点对齐） */
function matchWave(episodes, wave, startTs) {
  const from = startTs + wave.startSec * 1000 - 20_000;
  const to = startTs + (wave.startSec + wave.durationSec) * 1000 + 20_000;
  const hits = episodes.filter(
    (episode) => episode.direction === 'surge' && episode.startTs >= from && episode.startTs <= to,
  );
  if (!hits.length) return null;
  const first = hits.sort((a, b) => a.startTs - b.startTs)[0];
  return Math.round((first.startTs - (startTs + wave.startSec * 1000)) / 1000);
}

/** 放大镜下看噪声：把门槛放到最低，统计纯噪声日的净额/基线分布 */
const PROBE = {
  bucketSec: 15,
  baselineBuckets: 20,
  minBaselineBuckets: 6,
  minSamplesPerBucket: 3,
  netRatioThreshold: 0.05,
  minNetAmount: 0,
  minBuyShare: 0,
  zThreshold: 0,
  confirmBuckets: 1,
  mergeGapSec: 15,
  maxEpisodeSec: 600,
  detectDrain: false,
  levelPriceMovePct: 0,
};

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function runConfig(params, { seeds = SEEDS } = {}) {
  let noiseHours = 0;
  let noiseEpisodes = 0;
  let noiseAlerts = 0;
  let surgeEpisodes = 0;
  let matched = 0;
  let waveCount = 0;
  const latencies = [];
  const waveHits = [];
  const ratios = [];

  for (let seed = 1; seed <= seeds; seed += 1) {
    // 纯噪声日：不加任何攻势
    const noise = simulateDay({ seed });
    const noiseResult = detectTickImpulse(noise, params);
    noiseHours += noise.length / 3600;
    noiseEpisodes += noiseResult.episodes.length;
    surgeEpisodes += noiseResult.episodes.filter((episode) => episode.direction === 'surge').length;
    // 只有越过规则规模门槛（默认 3000 万累计）的噪声事件才真的会出现在告警页
    noiseAlerts += noiseResult.episodes.filter(
      (episode) => episode.direction === 'surge' && Math.abs(episode.sumNet) >= RULE_THRESHOLD,
    ).length;

    // 同一份噪声数据用「放大镜」参数再跑一次，只为了看净额/基线的分布
    const probe = detectTickImpulse(noise, PROBE);
    for (const event of probe.events) ratios.push(Math.abs(event.ratio));

    // 注入攻势日
    const waves = defaultWaves();
    const withWaves = simulateDay({ seed: seed + 1000, waves });
    const waveResult = detectTickImpulse(withWaves, params);
    const startTs = Math.min(...withWaves.map((point) => point.ts));
    for (const wave of waves) {
      waveCount += 1;
      const latency = matchWave(waveResult.episodes, wave, startTs);
      if (latency !== null) {
        matched += 1;
        latencies.push(latency);
        waveHits.push({ volumeMult: wave.volumeMult, buyRatio: wave.buyRatio, latency });
      } else {
        waveHits.push({ volumeMult: wave.volumeMult, buyRatio: wave.buyRatio, latency: null });
      }
    }
  }

  latencies.sort((a, b) => a - b);
  return {
    noisePerHour: noiseHours > 0 ? noiseEpisodes / noiseHours : 0,
    surgePerHour: noiseHours > 0 ? surgeEpisodes / noiseHours : 0,
    alertPerHour: noiseHours > 0 ? noiseAlerts / noiseHours : 0,
    recall: waveCount > 0 ? matched / waveCount : 0,
    latencyMedian: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    waveHits,
    ratioP99: percentile(ratios, 0.99),
    ratioP999: percentile(ratios, 0.999),
    ratioMax: ratios.length ? Math.max(...ratios) : 0,
    noiseHours,
  };
}

function fmt(value, digits = 2) {
  return Number(value).toFixed(digits);
}

/** 回放库内真实秒级数据（需先有盘中采样） */
function replayFromDb() {
  const dbFile = config.dbFile;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const days = db.prepare('SELECT trade_date, COUNT(*) AS c FROM fast_tick GROUP BY trade_date ORDER BY trade_date DESC').all();
  if (days.length === 0) {
    console.log('库内没有秒级数据，回放跳过。');
    return;
  }

  for (const day of days) {
    console.log(`\n=== ${day.trade_date}（${day.c} 行）===`);
    const codes = db
      .prepare('SELECT code, COUNT(*) AS c FROM fast_tick WHERE trade_date = ? GROUP BY code ORDER BY c DESC')
      .all(day.trade_date);
    for (const row of codes) {
      const points = db
        .prepare(
          'SELECT ts, price, amt_delta AS amtDelta, net_delta AS netDelta, imba FROM fast_tick WHERE code = ? AND trade_date = ? ORDER BY ts ASC',
        )
        .all(row.code, day.trade_date);
      const result = detectTickImpulse(points, {
        bucketSec: config.tickImpulse.bucketSec,
        baselineBuckets: config.tickImpulse.baselineBuckets,
        minBaselineBuckets: config.tickImpulse.minBaselineBuckets,
        minSamplesPerBucket: config.tickImpulse.minSamplesPerBucket,
        netRatioThreshold: config.tickImpulse.netRatioThreshold,
        minNetAmount: config.tickImpulse.minNetAmount,
        minBuyShare: config.tickImpulse.minBuyShare,
        zThreshold: config.tickImpulse.zThreshold,
        confirmBuckets: config.tickImpulse.confirmBuckets,
        mergeGapSec: config.tickImpulse.mergeGapSec,
        maxEpisodeSec: 600,
      });
      const stats = result.stats;
      console.log(
        `${row.code}  点 ${String(stats.rawPoints).padStart(5)}  桶 ${String(stats.usableBuckets).padStart(4)}  事件 ${String(stats.events).padStart(3)}  波次 ${String(stats.episodes).padStart(2)}  跳过(基线/形态/连续性)=${stats.skipped.baseline}/${stats.skipped.shape}/${stats.skipped.streak}`,
      );
      for (const episode of result.episodes) {
        const clock = new Date(episode.startTs).toISOString().slice(11, 19);
        console.log(
          `   ${clock}Z  ${episode.direction === 'surge' ? '主动买' : '主动卖'}  ${fmt(episode.durationSec, 0)}s  ${episode.buckets} 桶  累计 ${(episode.sumNet / 1e4).toFixed(0)}万  L${episode.level}`,
        );
      }
    }
  }
}

const grid = [
  { label: '默认(0.6/3桶/z4)', patch: {} },
  { label: '2桶(0.6/2桶/z4)', patch: { confirmBuckets: 2 } },
  { label: '0.8/3桶/z4', patch: { netRatioThreshold: 0.8 } },
  { label: '0.4/3桶/z4', patch: { netRatioThreshold: 0.4 } },
  { label: '0.6/4桶/z4', patch: { confirmBuckets: 4 } },
  { label: '0.6/3桶/z3', patch: { zThreshold: 3 } },
  { label: '0.6/3桶/100万', patch: { minNetAmount: 1_000_000 } },
  { label: '0.6/3桶/z5', patch: { zThreshold: 5 } },
];

/** 默认规则的规模门槛：一波累计主动净额 3000 万 */
const RULE_THRESHOLD = 30_000_000;

const base = {
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

console.log('秒级攻势检测 · 参数标定');
console.log(`合成秒级流：${SEEDS} 个随机种子 × 每个种子 4 小时噪声日 + 4 小时注入日（4 波攻势）`);
console.log('基准桶额 900 万元/15 秒（按 510300 单日 86 亿反推）\n');

const rows = [];
for (const entry of grid) {
  const result = runConfig({ ...base, ...entry.patch });
  rows.push({ label: entry.label, ...result });
  console.log(
    `${entry.label.padEnd(22)} 检出事件 ${fmt(result.surgePerHour).padStart(5)} 次/小时   告警 ${fmt(
      result.alertPerHour,
    ).padStart(5)} 次/小时   检出 ${(result.recall * 100).toFixed(0).padStart(3)}%   起点偏差 ${
      result.latencyMedian === null ? '—' : `${result.latencyMedian}s`
    }`,
  );
}

const probeRow = rows[0];
console.log(
  `\n纯噪声日的净额/基线分布（${fmt(rows[0].noiseHours, 1)} 小时样本）：p99 ${fmt(probeRow.ratioP99)}  p99.9 ${fmt(
    probeRow.ratioP999,
  )}  最大 ${fmt(probeRow.ratioMax)}`,
);
console.log('→ 相对门槛低于 p99.9 时，噪声会被成片误判；这是 netRatioThreshold 的下界依据。');

console.log('\n各波次检出情况（起点偏差 / 漏报）：');
console.log(`  ${'参数组'.padEnd(22)}${defaultWaves().map((wave, i) => `  第${i + 1}波×${wave.volumeMult}`).join('')}`);
for (const row of rows) {
  const cells = defaultWaves().map((_, i) => {
    const hit = row.waveHits.slice(i, i + 1)[0];
    return hit ? (hit.latency === null ? '漏报'.padStart(6) : `${hit.latency}s`.padStart(6)) : ''.padStart(6);
  });
  console.log(`  ${row.label.padEnd(22)}${cells.map((cell) => cell.padEnd(10)).join('')}`);
}

console.log('\n注：起点偏差为 0 说明波头被回溯补齐，事件时间与真实起点对齐；');
console.log(
  `    实时告警的实际推送时刻还会晚 confirmBuckets×bucketSec（默认 ${base.confirmBuckets * base.bucketSec} 秒）用于确认。`,
);

const best = rows.reduce((a, b) => (b.recall >= a.recall && b.surgePerHour <= a.surgePerHour ? b : a), rows[0]);
console.log(`\n推荐：${best.label}（误报 ${fmt(best.surgePerHour)} 次/小时，检出 ${(best.recall * 100).toFixed(0)}%）`);

if (REPLAY) replayFromDb();
