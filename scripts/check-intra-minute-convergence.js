/**
 * 分钟内爆量：折算收敛性核验（离线，直接读库，不需要起服务）。
 *
 * 回答的问题：早段折算到底有多准？会不会把「刚好放量」放大成「爆量」？
 *
 *   node scripts/check-intra-minute-convergence.js
 *   node scripts/check-intra-minute-convergence.js --date=2026-11-02 --cut=5,10,20,30
 *
 * 口径：以该分钟最后一个采样点（约第 59 秒，curveShare≈0.98）的折算值为基准 ——
 * 此时折算值等价于定稿成交额 —— 看各切点折算完成度的分布。
 * 完成度系统性 <100% = 早段低估；>100% = 早段高估（误报的来源）。
 *
 * 因果性：到达曲线只用「本根之前」的完整分钟，每 20 根重算一次（与回测脚本同法），
 * 因此这里的结果与线上逐点滚动曲线基本一致，差别只在曲线刷新粒度。
 */
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config/index.js';
import {
  splitMinuteTicks,
  buildArrivalCurve,
  priorArrivalCurve,
  evaluateFormingBucket,
  sliceBucket,
} from '../server/services/intraMinuteSurge.js';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((item) => item.startsWith('--'))
    .map((item) => {
      const [key, value = 'true'] = item.replace(/^--/, '').split('=');
      return [key, value];
    }),
);

const date = args.date ?? '2026-11-02';
const cuts = (args.cut ?? '10,15,20,30,40,50').split(',').map(Number);
const minFinalAmount = Number(args['min-amount'] ?? 20_000_000);
const quantile = Number(args.quantile ?? config.intraMinute.curveQuantile);
const refreshEvery = Number(args['curve-refresh'] ?? 20);

const db = new DatabaseSync(config.dbFile, { readOnly: true });
const codes = db
  .prepare('SELECT DISTINCT code FROM fast_tick WHERE trade_date = ? ORDER BY code')
  .all(date)
  .map((row) => row.code);

const byCode = new Map();
for (const code of codes) {
  const rows = db
    .prepare(
      'SELECT ts, amount, amt_delta, net_delta, price FROM fast_tick WHERE code = ? AND trade_date = ? ORDER BY ts',
    )
    .all(code, date);
  byCode.set(code, splitMinuteTicks(rows));
}
db.close();

/** 折算值只看「已成交额 / 曲线占比」，与基线无关，故 history 留空 */
const projectedAt = (bucket, tickCount, curve) => {
  const sliced = sliceBucket(bucket, tickCount);
  if (!sliced) return null;
  const result = evaluateFormingBucket(sliced, [], curve);
  return result?.projectedAmount ?? null;
};

const rows = [];
let completeCount = 0;

for (const [code, buckets] of byCode) {
  const complete = buckets.filter((bucket) => bucket.complete && bucket.amount > 0);
  completeCount += complete.length;

  let curve = priorArrivalCurve({ curveQuantile: quantile });
  for (let i = 0; i < complete.length; i += 1) {
    // 曲线只用本根之前的完整分钟
    if (i % refreshEvery === 0) {
      const built = buildArrivalCurve(complete.slice(0, i), { curveQuantile: quantile });
      if (built) curve = built;
    }
    const bucket = complete[i];
    const final = projectedAt(bucket, bucket.ticks.length, curve);
    if (!final || final < minFinalAmount) continue;

    const rec = { code, minute: bucket.minute, final, at: {} };
    for (const cut of cuts) {
      let index = -1;
      for (let k = 0; k < bucket.ticks.length; k += 1) {
        if (bucket.ticks[k].sec <= cut) index = k;
        else break;
      }
      if (index < 0) {
        rec.at[cut] = null;
        continue;
      }
      const value = projectedAt(bucket, index + 1, curve);
      rec.at[cut] = value === null ? null : value / final;
    }
    rows.push(rec);
  }
}

const quantileOf = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const pct = (value) => (value === null ? '  —' : `${(value * 100).toFixed(0).padStart(3)}%`);

console.log(
  `\n交易日 ${date} · ${codes.length} 只标的 · 完整分钟 ${completeCount} · 样本 ${rows.length}（定稿额 ≥ ${(minFinalAmount / 1e4).toFixed(0)} 万）`,
);
console.log(`曲线 ${quantile} 分位 · 每 ${refreshEvery} 根重算一次（只用本根之前的分钟）\n`);
console.log('切点   中位   p10   p90   超定稿1.5倍      超3倍');
for (const cut of cuts) {
  const values = rows.map((r) => r.at[cut]).filter((v) => v !== null);
  if (!values.length) continue;
  const over15 = values.filter((v) => v > 1.5).length;
  const over3 = values.filter((v) => v > 3).length;
  console.log(
    `${String(cut).padStart(3)}s  ${pct(quantileOf(values, 0.5))}  ${pct(quantileOf(values, 0.1))}  ${pct(quantileOf(values, 0.9))}   ${String(over15).padStart(4)} (${((over15 / values.length) * 100).toFixed(1)}%)   ${String(over3).padStart(4)}`,
  );
}
console.log(
  '\n解读：完成度系统性 <100% = 早段低估（报得晚一点，可接受）；>100% = 早段高估（会把「刚好放量」放大成「爆量」，是误报的来源）。\n',
);
