/**
 * 分钟内实时爆量（「第一手」预警）回放验证。
 *
 * 数据源就是线上采集的逐秒快照（fast_tick），不是合成的：这样验证的是
 * 「假如当时就跑这套算法，会在第几秒报出来」，而不是「在理想数据上能跑多好」。
 *
 * 因果性保证：
 *   - 基线只用「本根之前」的完整分钟
 *   - 到达曲线只用「本根之前」的完整分钟（不足 30 根时用内置先验，并标注 curveSource）
 *   - 逐点回放：第 k 个采样点之后能看到的信息，只用前 k 个点
 *
 * 判定口径：
 *   应报 = 该分钟最终成交额 / 基线 ≥ ratioThreshold
 *   捕获 = 应报且在第 59 秒前触发了
 *   误报 = 触发了但最终没到门槛
 *
 * 用法：
 *   node scripts/backtest-intra-minute.js --date=2026-11-02
 *   node scripts/backtest-intra-minute.js --codes=510300,588000 --ratio=2,2.5,3 --quantile=0.6,0.75,0.85
 */

import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config/index.js';
import {
  DEFAULT_PARAMS,
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
const ratios = (args.ratio ?? '2,2.5,3').split(',').map(Number);
const quantiles = (args.quantile ?? '0.6,0.75,0.85').split(',').map(Number);
const minAmounts = (args['min-amount'] ?? String(DEFAULT_PARAMS.minAmount)).split(',').map(Number);
const cooldownSec = Number.isFinite(Number(args.cooldown)) ? Number(args.cooldown) : 180;
const alertMinProjected = Number(args['alert-amount'] ?? 30_000_000);
const levels = (args.level ?? '2').split(',').map(Number);
const dbFile = args.db ?? config.dbFile;

const db = new DatabaseSync(dbFile, { readOnly: true });

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values, p) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

const fmtAmount = (value) => {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(0)} 万`;
  return `${Math.round(value)}`;
};

const codes = args.codes
  ? args.codes.split(',')
  : db
      .prepare('SELECT DISTINCT code FROM fast_tick WHERE ts BETWEEN ? AND ? ORDER BY code')
      .all(Date.parse(`${date}T00:00:00+08:00`), Date.parse(`${date}T23:59:59+08:00`))
      .map((row) => row.code);

if (codes.length === 0) {
  console.error(`${date} 没有秒级数据，先在交易时段跑起服务再回放`);
  process.exit(1);
}

const fromTs = Date.parse(`${date}T00:00:00+08:00`);
const toTs = Date.parse(`${date}T23:59:59+08:00`);
const nameOf = new Map(db.prepare('SELECT code, name FROM etf').all().map((row) => [row.code, row.name]));

/**
 * 回放一只标的。
 * @returns {Array<{code,minute,actualRatio,triggered,triggerSec,...}>} 逐分钟结论
 */
function replayCode(code, params) {
  const ticks = db
    .prepare(
      'SELECT ts, amt_delta, net_delta, price FROM fast_tick WHERE code = ? AND ts BETWEEN ? AND ? ORDER BY ts',
    )
    .all(code, fromTs, toTs);

  const usable = splitMinuteTicks(ticks).filter((bucket) => bucket.session && bucket.samples >= 3);
  const rows = [];
  const curveEvery = Number(args['curve-refresh'] ?? 5);
  let curve = null;

  for (let i = 0; i < usable.length; i += 1) {
    const bucket = usable[i];
    // 缓冲头部可能被窗口截断，样本明显偏少的不算「应报」
    if (bucket.samples < 15) continue;

    const history = usable
      .slice(Math.max(0, i - params.baselineMinutes), i)
      .filter((item) => item.complete && item.amount > 0);
    if (history.length < params.minBaselineMinutes) continue;

    // 到达曲线每 N 分钟重算一次：只用「本根之前」的完整分钟，因果性不变，
    // 但省掉逐分钟 60×N 次分位数排序（回放 15 只标的 × 9 组参数时会差一个数量级）。
    if (curve === null || i % curveEvery === 0) {
      const curveBuckets = usable.slice(0, i).filter((item) => item.complete && item.amount > 0);
      curve = buildArrivalCurve(curveBuckets, params) ?? priorArrivalCurve(params);
    }
    const baseline = median(history.map((item) => item.amount));
    if (!(baseline > 0)) continue;

    let hit = null;
    for (let k = 1; k <= bucket.ticks.length; k += 1) {
      const partial = sliceBucket(bucket, k);
      if (!partial) continue;
      const evaluation = evaluateFormingBucket(partial, history, curve, params);
      if (evaluation.triggered) {
        hit = evaluation;
        break;
      }
    }

    rows.push({
      code,
      minute: bucket.minute,
      startTs: bucket.startTs,
      finalAmount: bucket.amount,
      baseline,
      actualRatio: bucket.amount / baseline,
      triggered: Boolean(hit),
      triggerSec: hit?.elapsedSec ?? null,
      triggerAmount: hit?.amount ?? null,
      triggerProjected: hit?.projectedAmount ?? null,
      triggerRatio: hit?.projectedRatio ?? null,
      level: hit?.level ?? 0,
      direction: bucket.net >= 0 ? 'surge' : 'drain',
      priceMovePct: bucket.open > 0 ? ((bucket.close - bucket.open) / bucket.open) * 100 : null,
      curveSource: curve.source,
    });
  }

  return rows;
}

/**
 * 冷却模拟：线上告警层按「同规则 + 同标的 + 冷却秒数」抑制，
 * 否则一波持续 6 分钟的放量会连着报 6 条。这里按同样的规则数一遍，
 * 得到的才是「用户实际会看到多少条」。
 */
function countAfterCooldown(rows, minLevel, alertMinProjected) {
  const byCode = new Map();
  for (const row of rows) {
    if (!row.triggered) continue;
    if (row.level < minLevel) continue;
    // 告警金额门槛：折算整分钟不到这个数的，只在前端亮灯，不进告警流
    if (!(row.triggerProjected >= alertMinProjected)) continue;
    const list = byCode.get(row.code) ?? [];
    list.push(row);
    byCode.set(row.code, list);
  }
  let kept = 0;
  for (const list of byCode.values()) {
    list.sort((a, b) => a.startTs - b.startTs);
    let last = -Infinity;
    for (const row of list) {
      if (row.startTs - last < cooldownSec * 1000) continue;
      last = row.startTs;
      kept += 1;
    }
  }
  return kept;
}

/** 汇总一组逐分钟结论 */
function summarize(rows, ratioThreshold, minAmount, alertMinProjected) {
  // 「应报」同时要求倍数和金额：地量标的放 2.5 倍也只有一百多万的分钟，
  // 不值得在 15 只宽基的告警流里占一条，线上也被 minAmount 挡掉了。
  const should = rows.filter((row) => row.actualRatio >= ratioThreshold && row.finalAmount >= minAmount);
  const caught = should.filter((row) => row.triggered);
  const missed = should.filter((row) => !row.triggered);
  const falseAlarms = rows.filter((row) => row.triggered && row.actualRatio < ratioThreshold);

  const secs = caught.map((row) => row.triggerSec);
  const leadShares = caught.map((row) => (row.triggerAmount ?? 0) / row.finalAmount);

  return {
    alertsAfterCooldown: countAfterCooldown(rows, 2, alertMinProjected),
    alertsL3: rows.filter((row) => row.triggered && row.level >= 3).length,
    total: rows.length,
    should: should.length,
    caught: caught.length,
    recall: should.length > 0 ? caught.length / should.length : null,
    missed: missed.length,
    falseAlarms: falseAlarms.length,
    falseAlarmRate: caught.length + falseAlarms.length > 0 ? falseAlarms.length / (caught.length + falseAlarms.length) : null,
    falseAlarmRatioMedian: falseAlarms.length > 0 ? median(falseAlarms.map((row) => row.actualRatio)) : null,
    medianSec: percentile(secs, 0.5),
    p90Sec: percentile(secs, 0.9),
    medianLead: leadShares.length > 0 ? 1 - median(leadShares) : null,
    missedRatioMedian: missed.length > 0 ? median(missed.map((row) => row.actualRatio)) : null,
  };
}

console.log(`\n回放标的 ${codes.length} 只，交易日 ${date}`);
console.log('口径：应报 = 该分钟最终成交额 / 前 20 分钟基线 ≥ 门槛；捕获 = 触发且应报；误报 = 触发但最终未到门槛\n');

const results = [];
for (const ratioThreshold of ratios) {
  for (const curveQuantile of quantiles) {
    for (const minAmount of minAmounts) {
      const params = {
        ...DEFAULT_PARAMS,
        ratioThreshold,
        curveQuantile,
        minAmount,
        level3Ratio: Math.max(4, ratioThreshold * 2),
      };
      const allRows = [];
      for (const code of codes) allRows.push(...replayCode(code, params));
      const summary = summarize(allRows, ratioThreshold, minAmount, alertMinProjected);
      results.push({ ratioThreshold, curveQuantile, minAmount, summary, rows: allRows });
    }
  }
}

const header = ['门槛', '分位', '额下限', '可判定', '应报', '捕获', '捕获率', '中位秒', 'p90', '提前量', '误报', '误报率', '强级条数', '冷却后条数', '每标的每日'];
console.log(header.map((text) => text.padEnd(text.length + (text.length > 4 ? 3 : 2))).join(''));
for (const item of results) {
  const { summary } = item;
  const perCodePerDay = summary.alertsAfterCooldown / codes.length;
  const line = [
    `${item.ratioThreshold.toFixed(1)}×`,
    item.curveQuantile.toFixed(2),
    `${Math.round(item.minAmount / 1e4)}万`,
    String(summary.total),
    String(summary.should),
    String(summary.caught),
    summary.recall === null ? '—' : `${(summary.recall * 100).toFixed(0)}%`,
    summary.medianSec === null ? '—' : `${summary.medianSec}s`,
    summary.p90Sec === null ? '—' : `${summary.p90Sec}s`,
    summary.medianLead === null ? '—' : `${(summary.medianLead * 100).toFixed(0)}%`,
    String(summary.falseAlarms),
    summary.falseAlarmRate === null ? '—' : `${(summary.falseAlarmRate * 100).toFixed(0)}%`,
    String(summary.alertsL3),
    String(summary.alertsAfterCooldown),
    perCodePerDay.toFixed(1),
  ];
  console.log(line.map((text, index) => text.padEnd(header[index].length + (header[index].length > 4 ? 3 : 2))).join(''));
}

// 选中口径（最后一个组合，或 --pick）的逐条明细
const pick = results.find(
  (item) =>
    item.ratioThreshold === Number(args.pickRatio ?? 2) &&
    item.curveQuantile === Number(args.pickQuantile ?? 0.75) &&
    item.minAmount === Number(args.pickAmount ?? minAmounts[0]),
) ?? results[0];

console.log(`\n== 明细：${pick.ratioThreshold}× / 分位 ${pick.curveQuantile} ==`);
const detail = pick.rows
  .filter((row) => row.actualRatio >= pick.ratioThreshold || row.triggered)
  .sort((a, b) => b.actualRatio - a.actualRatio)
  .slice(0, Number(args.top ?? 25));

console.log(
  `误报的最终倍数中位 ${pick.summary.falseAlarmRatioMedian?.toFixed(2) ?? '—'}×（越接近门槛越像「差一点」，而不是「完全看错」）` +
    `；漏报的最终倍数中位 ${pick.summary.missedRatioMedian?.toFixed(2) ?? '—'}×`,
);
for (const row of detail) {
  const tag = row.triggered ? (row.actualRatio >= pick.ratioThreshold ? '捕获' : '误报') : '漏报';
  console.log(
    `${row.code}${(nameOf.get(row.code) ?? '').slice(0, 8).padEnd(9)} ${row.minute} ${tag} ` +
      `实际 ${row.actualRatio.toFixed(2)}×（${fmtAmount(row.finalAmount)} / 基线 ${fmtAmount(row.baseline)}）` +
      (row.triggered
        ? ` · 第 ${row.triggerSec} 秒触发 ${fmtAmount(row.triggerAmount)}（预测 ${(row.triggerRatio ?? 0).toFixed(2)}×，L${row.level}，已走完 ${((row.triggerAmount / row.finalAmount) * 100).toFixed(0)}%）`
        : ' · 未触发'),
  );
}

const curveStat = pick.rows.reduce(
  (acc, row) => {
    acc[row.curveSource] = (acc[row.curveSource] ?? 0) + 1;
    return acc;
  },
  {},
);
console.log('\n曲线来源分布：', JSON.stringify(curveStat));
