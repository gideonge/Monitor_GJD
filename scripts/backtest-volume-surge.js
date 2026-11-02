/**
 * 日内量能突变算法回测。
 *
 * 回测口径刻意限定在「单个交易日内部」：
 *   样本 = 2026-10-30 一个交易日内、60 只 ETF 的逐分钟成交量（14160 个分钟点）。
 *   不跨日，因为隔夜跳空与日间量能水平漂移会污染对「日内骤变」的评估。
 *
 * 评估方法：事件研究 + 同标的配对对照。
 *   对每个告警事件，测量其后 15 分钟的价格变动幅度 / 方向一致性 / 量能延续度；
 *   再从同一标的、同一交易日的非事件分钟里配对抽一个对照点，算同样的指标。
 *   配对抽样重复 1000 次得到对照均值分布，据此给出单侧 p 值。
 *
 *   为什么要对照：日内任意时点的价格本来就在波动。若只看「告警后平均涨了多少」，
 *   在没有单边行情的日子会得出「算法无效」的错误结论；与随机时点对照才能回答
 *   「告警时刻是否真的比平常更有可能出现异动」。
 *
 * 用法：
 *   node scripts/backtest-volume-surge.js [--samples=<path>] [--w=15] [--bootstrap=1000]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config/index.js';
import { detectVolumeSurge, sessionOf, median, DEFAULT_PARAMS } from '../server/services/volumeSurge.js';

const W = 15; // 前向观察窗口（分钟）
const PRE = 10; // 事件前量能参照窗口（分钟）

function argValue(name, fallback) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// ---------------------------------------------------------------- 统计工具

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] === undefined) return sorted[base];
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function stdev(values) {
  if (values.length < 2) return null;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** 简单可复现的伪随机数（mulberry32），保证回测结果稳定可比 */
function makeRandom(seed = 20261030) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 数据装载

function loadSamples() {
  // --db-date=YYYY-MM-DD：直接从本地库读某一交易日的分时（含 high/low，确认逻辑需要）。
  // 本地库是唯一同时覆盖两天的来源，跨日对比必须走这条路。
  const dbDate = argValue('db-date', null);
  if (dbDate) {
    const db = new DatabaseSync(config.dbFile, { readOnly: true });
    const codes = db.prepare('SELECT DISTINCT code FROM intraday_bar WHERE trade_date = ?').all(dbDate);
    const series = [];
    for (const { code } of codes) {
      const bars = db
        .prepare(
          'SELECT minute, open, close, high, low, volume, amount FROM intraday_bar WHERE code = ? AND trade_date = ? ORDER BY minute ASC',
        )
        .all(code, dbDate);
      if (bars.length < 30) continue;
      const meta = db.prepare('SELECT name, category FROM etf WHERE code = ?').get(code);
      series.push({
        code,
        name: meta?.name ?? code,
        category: meta?.category ?? '其他',
        tradeDate: dbDate,
        bars,
      });
    }
    db.close();
    return { tradeDate: dbDate, series: series.sort((a, b) => a.code.localeCompare(b.code)) };
  }

  const samplePath =
    argValue('samples', null) ??
    path.join(config.dataDir, 'samples', 'intraday-2026-10-30.json');
  if (!fs.existsSync(samplePath)) {
    throw new Error(`样本文件不存在：${samplePath}，请先运行 scripts/fetch-intraday-samples.js`);
  }
  const payload = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  const byCode = new Map();
  for (const sample of payload.samples) {
    byCode.set(sample.code, {
      code: sample.code,
      name: sample.name,
      category: sample.category,
      tradeDate: sample.tradeDate,
      bars: sample.bars,
    });
  }

  // 本地库里可能有样本文件没覆盖到的标的（详情页回填过的），合并进来补齐横截面。
  // 必须锁定样本文件那一天：库里同时存着多个交易日，混进来会让日内口径失效。
  const sampleDate = payload.samples[0]?.tradeDate;
  if (fs.existsSync(config.dbFile) && sampleDate) {
    const db = new DatabaseSync(config.dbFile, { readOnly: true });
    const rows = db.prepare('SELECT DISTINCT code FROM intraday_bar WHERE trade_date = ?').all(sampleDate);
    for (const row of rows) {
      if (byCode.has(row.code)) continue;
      const bars = db
        .prepare(
          'SELECT minute, open, close, high, low, volume, amount FROM intraday_bar WHERE code = ? AND trade_date = ? ORDER BY minute ASC',
        )
        .all(row.code, sampleDate);
      const meta = db.prepare('SELECT name, category FROM etf WHERE code = ?').get(row.code);
      byCode.set(row.code, {
        code: row.code,
        name: meta?.name ?? row.code,
        category: meta?.category ?? '其他',
        tradeDate: sampleDate,
        bars,
      });
    }
    db.close();
  }

  const dates = new Set([...byCode.values()].map((item) => item.tradeDate));
  if (dates.size !== 1) {
    throw new Error(`样本含有多个交易日：${[...dates].join(',')}，与日内回测口径冲突`);
  }
  return { tradeDate: [...dates][0], series: [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code)) };
}

// ---------------------------------------------------------------- 前向指标

/**
 * 计算某分钟点之后的前向表现。
 * 要求 i+1..i+W 全部落在同一可判定时段内，否则返回 null（不参与统计），
 * 避免跨午休、跨收盘集合竞价造成口径失真。
 */
function forwardStats(bars, i, window = W) {
  const start = bars[i];
  const session = sessionOf(start.minute);
  if (!session) return null;
  if (i + window >= bars.length) return null;

  const end = bars[i + window];
  if (sessionOf(end.minute) !== session) return null;

  const basePrice = Number(start.close);
  if (!(basePrice > 0)) return null;

  let maxPrice = -Infinity;
  let minPrice = Infinity;
  const volumes = [];
  for (let k = 1; k <= window; k += 1) {
    const bar = bars[i + k];
    if (sessionOf(bar.minute) !== session) return null;
    const price = Number(bar.close);
    if (price > maxPrice) maxPrice = price;
    if (price < minPrice) minPrice = price;
    if (k <= PRE) volumes.push(Number(bar.volume));
  }

  return {
    ret: ((Number(end.close) - basePrice) / basePrice) * 100,
    mfe: ((maxPrice - basePrice) / basePrice) * 100,
    mae: ((minPrice - basePrice) / basePrice) * 100,
    afterVolume: median(volumes),
  };
}

/** 事件当分钟的价格方向：用于检验「量能突变后的价格是否延续该方向」 */
function tickDirection(bars, i) {
  const prev = Number(bars[i - 1]?.close);
  const now = Number(bars[i]?.close);
  if (!Number.isFinite(prev) || !Number.isFinite(now) || prev <= 0) return 0;
  const delta = now - prev;
  if (delta === 0) return 0;
  return delta > 0 ? 1 : -1;
}

function summarizeEvents(events, barsByCode) {
  const rows = [];
  for (const event of events) {
    const bars = barsByCode.get(event.code);
    const fwd = forwardStats(bars, event.index);
    if (!fwd) continue;
    const dir = tickDirection(bars, event.index);
    const sameDir = dir === 0 ? null : Math.sign(fwd.ret) === dir;
    rows.push({
      ...event,
      ...fwd,
      dir,
      sameDir,
      /** 方向调整后收益：按事件当时的价格方向持有的 15 分钟收益。
       *  这是唯一能回答「顺着信号做是否有正期望」的指标，
       *  绝对值波动再大，方向错了也是负期望。 */
      signedRet: dir === 0 ? null : dir * fwd.ret,
      volPersist: event.baseline > 0 ? fwd.afterVolume / event.baseline : null,
    });
  }
  return rows;
}

/**
 * 对照组构造。两种口径缺一不可：
 *
 *   adjacent（时段匹配）：从事件点前后 radius 分钟内的非事件分钟里抽。
 *     → 剥离「开盘/尾盘本来波动就大」的时段效应，测的是「量能突变本身」的增量信息。
 *     → 这是判断算法有没有用的主口径。
 *
 *   global（全天随机）：从当日全部可判定分钟里抽。
 *     → 会把时段效应一并算进去。朴素阈值法在这种口径下表现很好，
 *       恰恰因为它的选点等价于「挑出开盘和尾盘」，并不代表它识别了量能异常。
 *
 * 两种口径并列展示，才能区分「算法的真实增益」与「时段红利」。
 */
function pairedControl(eventRows, barsByCode, { iterations = 1000, cooldown = 5, radius = 30, seed = 20261030 } = {}) {
  const random = makeRandom(seed);

  const validIdxByCode = new Map();
  for (const [code, bars] of barsByCode) {
    const idx = [];
    for (let i = 0; i < bars.length; i += 1) {
      if (!sessionOf(bars[i].minute)) continue;
      if (!(Number(bars[i].volume) > 0)) continue;
      if (!forwardStats(bars, i)) continue;
      idx.push(i);
    }
    validIdxByCode.set(code, idx);
  }

  const eventIdxByCode = new Map();
  for (const row of eventRows) {
    if (!eventIdxByCode.has(row.code)) eventIdxByCode.set(row.code, new Set());
    eventIdxByCode.get(row.code).add(row.index);
  }

  // 预先算好每个事件的「时段匹配候选池」，避免每轮重复扫描
  const adjacentPool = eventRows.map((row) => {
    const bars = barsByCode.get(row.code);
    const excluded = eventIdxByCode.get(row.code) ?? new Set();
    const pool = [];
    for (let j = row.index - radius; j <= row.index + radius; j += 1) {
      if (j < 0 || j >= bars.length) continue;
      if (Math.abs(j - row.index) <= cooldown) continue;
      if (!sessionOf(bars[j].minute)) continue;
      if (!(Number(bars[j].volume) > 0)) continue;
      if (!forwardStats(bars, j)) continue;
      let blocked = false;
      for (let d = -cooldown; d <= cooldown; d += 1) {
        if (excluded.has(j + d)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) pool.push(j);
    }
    return pool;
  });

  const measure = (bars, picked) => {
    const fwd = forwardStats(bars, picked);
    if (!fwd) return null;
    const baseVol = median(
      bars
        .slice(Math.max(0, picked - PRE), picked)
        .map((bar) => Number(bar.volume))
        .filter((volume) => volume > 0),
    );
    const dir = tickDirection(bars, picked);
    return { fwd, dir, signedRet: dir === 0 ? null : dir * fwd.ret, volPersist: baseVol > 0 ? fwd.afterVolume / baseVol : null };
  };

  const drawOnce = (mode) => {
    const absRets = [];
    const signedRets = [];
    const persists = [];
    let hits = 0;
    let hitBase = 0;

    eventRows.forEach((row, order) => {
      const bars = barsByCode.get(row.code);
      let picked = null;
      if (mode === 'adjacent') {
        const pool = adjacentPool[order];
        if (pool.length > 0) picked = pool[Math.floor(random() * pool.length)];
      }
      if (picked === null) {
        const idx = validIdxByCode.get(row.code) ?? [];
        if (idx.length === 0) return;
        picked = idx[Math.floor(random() * idx.length)];
      }

      const measured = measure(bars, picked);
      if (!measured) return;
      absRets.push(Math.abs(measured.fwd.ret));
      if (measured.signedRet !== null) signedRets.push(measured.signedRet);
      if (measured.volPersist !== null) persists.push(measured.volPersist);
      if (measured.dir !== 0) {
        hitBase += 1;
        if (Math.sign(measured.fwd.ret) === measured.dir) hits += 1;
      }
    });

    return {
      absRet: mean(absRets),
      signedRet: mean(signedRets),
      volPersist: mean(persists),
      dirHit: hitBase > 0 ? hits / hitBase : null,
    };
  };

  const run = (mode) => {
    const samples = [];
    for (let n = 0; n < iterations; n += 1) samples.push(drawOnce(mode));
    const dist = (key) =>
      samples.map((sample) => sample[key]).filter((value) => value !== null && Number.isFinite(value));
    return { absRet: dist('absRet'), signedRet: dist('signedRet'), volPersist: dist('volPersist'), dirHit: dist('dirHit') };
  };

  return { adjacent: run('adjacent'), global: run('global') };
}

function pValue(eventValue, controlDist) {
  if (eventValue === null || controlDist.length === 0) return null;
  const better = controlDist.filter((value) => value >= eventValue).length;
  return (better + 1) / (controlDist.length + 1);
}

/**
 * 按标的整簇重抽样：把同一只 ETF 的全部事件当一个不可分割的样本单位。
 * 目的：修正「同标的同日事件高度相关」导致的方差低估，给区间一个诚实的宽度。
 */
function clusterBootstrap(rows, key, { iterations = 2000, seed = 20261030 } = {}) {
  const byCode = new Map();
  for (const row of rows) {
    const value = row[key];
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    if (!byCode.has(row.code)) byCode.set(row.code, []);
    byCode.get(row.code).push(value);
  }
  const codes = [...byCode.keys()];
  if (codes.length === 0) return { clusters: 0, mean: null, lo: null, hi: null, positive: null };

  const random = makeRandom(seed);
  const means = [];
  for (let n = 0; n < iterations; n += 1) {
    const values = [];
    for (let k = 0; k < codes.length; k += 1) {
      const code = codes[Math.floor(random() * codes.length)];
      values.push(...byCode.get(code));
    }
    const value = mean(values);
    if (Number.isFinite(value)) means.push(value);
  }
  means.sort((a, b) => a - b);
  const at = (q) => means[Math.min(means.length - 1, Math.max(0, Math.floor(q * means.length)))];
  const all = rows.map((row) => row[key]).filter((value) => Number.isFinite(value));
  return {
    clusters: codes.length,
    mean: mean(all),
    lo: at(0.025),
    hi: at(0.975),
    positive: means.filter((value) => value > 0).length / means.length,
  };
}

// ---------------------------------------------------------------- 算法变体

/** 朴素法 A：全天均量倍数。用来暴露「不分时段、不分标的节奏」的缺陷 */
function detectNaiveMean(bars, { multiple = 3 } = {}) {
  const tradable = bars.filter((bar) => sessionOf(bar.minute) && Number(bar.volume) > 0);
  const dayMean = mean(tradable.map((bar) => Number(bar.volume)));
  const events = [];
  let last = -Infinity;
  for (let i = 0; i < bars.length; i += 1) {
    if (!sessionOf(bars[i].minute)) continue;
    const volume = Number(bars[i].volume);
    if (!(volume > dayMean * multiple)) continue;
    if (i - last < 5) continue;
    events.push({ index: i, code: null, minute: bars[i].minute, direction: 'surge', volume, baseline: dayMean, ratio: volume / dayMean, z: null, level: 1 });
    last = i;
  }
  return events;
}

/** 朴素法 B：全天固定分位阈值。不区分时段，开盘与尾盘会被系统性占满 */
function detectNaiveQuantile(bars, { q = 0.95 } = {}) {
  const tradable = bars.filter((bar) => sessionOf(bar.minute) && Number(bar.volume) > 0);
  const threshold = quantile(tradable.map((bar) => Number(bar.volume)), q);
  const events = [];
  let last = -Infinity;
  for (let i = 0; i < bars.length; i += 1) {
    if (!sessionOf(bars[i].minute)) continue;
    const volume = Number(bars[i].volume);
    if (!(volume > threshold)) continue;
    if (i - last < 5) continue;
    events.push({ index: i, code: null, minute: bars[i].minute, direction: 'surge', volume, baseline: threshold, ratio: volume / threshold, z: null, level: 1 });
    last = i;
  }
  return events;
}

function runDetector(name, series, params) {
  const barsByCode = new Map(series.map((item) => [item.code, item.bars]));
  const all = [];
  const perCode = [];
  for (const item of series) {
    let events;
    if (name === 'naive_mean') events = detectNaiveMean(item.bars, params);
    else if (name === 'naive_quantile') events = detectNaiveQuantile(item.bars, params);
    else events = detectVolumeSurge(item.bars, params).events;
    const tagged = events.map((event) => ({ ...event, code: item.code, name: item.name }));
    all.push(...tagged);
    perCode.push({ code: item.code, count: tagged.length });
  }
  return { events: all, perCode, barsByCode };
}

/** 事件时段分布：检验算法是否被 U 型量能结构绑架（集中在开盘/尾盘即为缺陷） */
function sessionBuckets(events) {
  const buckets = { '开盘30分': 0, '上午盘中': 0, '午后盘中': 0, '尾盘30分': 0 };
  for (const event of events) {
    const minute = event.minute;
    if (minute >= '09:31' && minute <= '10:00') buckets['开盘30分'] += 1;
    else if (minute > '10:00' && minute <= '11:30') buckets['上午盘中'] += 1;
    else if (minute >= '13:01' && minute <= '14:26') buckets['午后盘中'] += 1;
    else buckets['尾盘30分'] += 1;
  }
  return buckets;
}

// ---------------------------------------------------------------- 主流程

function evaluate(name, label, series, params, { iterations = 1000 } = {}) {
  const { events, perCode, barsByCode } = runDetector(name, series, params);
  const eventRows = summarizeEvents(events, barsByCode);
  const usable = eventRows.filter((row) => Number.isFinite(row.ret));

  const absRets = usable.map((row) => Math.abs(row.ret));
  const signedRets = usable.map((row) => row.signedRet).filter((value) => value !== null && Number.isFinite(value));
  const persists = usable.map((row) => row.volPersist).filter((value) => value !== null && Number.isFinite(value));
  const hits = usable.filter((row) => row.sameDir !== null);
  const dirHit = hits.length ? hits.filter((row) => row.sameDir).length / hits.length : null;

  const control = pairedControl(usable, barsByCode, { iterations });
  const ctrl = control.adjacent;
  const ctrlAll = control.global;

  const avgAbs = mean(absRets);
  const ctrlAvgAbs = mean(ctrl.absRet);
  const ctrlAllAvgAbs = mean(ctrlAll.absRet);

  return {
    name,
    label,
    params,
    eventCount: events.length,
    usableCount: usable.length,
    perCodeDay: series.length ? events.length / series.length : 0,
    absRet: avgAbs,
    absRetMedian: median(absRets),
    ctrlAbsRet: ctrlAvgAbs,
    lift: ctrlAvgAbs > 0 && avgAbs !== null ? avgAbs / ctrlAvgAbs : null,
    pValue: pValue(avgAbs, ctrl.absRet),
    ctrlAllAbsRet: ctrlAllAvgAbs,
    liftAll: ctrlAllAvgAbs > 0 && avgAbs !== null ? avgAbs / ctrlAllAvgAbs : null,
    volPersist: mean(persists),
    ctrlVolPersist: mean(ctrl.volPersist),
    persistP: pValue(mean(persists), ctrl.volPersist),
    signedRet: mean(signedRets),
    ctrlSignedRet: mean(ctrl.signedRet),
    signedP: pValue(mean(signedRets), ctrl.signedRet),
    dirHit,
    ctrlDirHit: mean(ctrl.dirHit),
    dirP: pValue(dirHit, ctrl.dirHit),
    mfe: mean(usable.map((row) => row.mfe)),
    mae: mean(usable.map((row) => row.mae)),
    buckets: sessionBuckets(events),
    topCodes: eventRows.reduce((acc, row) => {
      acc[row.code] = (acc[row.code] ?? 0) + 1;
      return acc;
    }, {}),
    eventRows: usable,
  };
}

function fmt(value, digits = 2, suffix = '') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}${suffix}`;
}

function main() {
  const iterations = Number(argValue('bootstrap', '1000'));
  const { tradeDate, series } = loadSamples();
  const totalBars = series.reduce((sum, item) => sum + item.bars.length, 0);

  console.log(`样本：${tradeDate} 单日，${series.length} 只 ETF，${totalBars} 个分钟点，前向窗口 ${W} 分钟，对照抽样 ${iterations} 次\n`);

  const results = [];

  // 基线：朴素全天均值倍数法
  for (const multiple of [2, 3, 5]) {
    results.push(evaluate('naive_mean', `全天均值 ×${multiple}`, series, { multiple }, { iterations }));
  }
  // 基线：全天固定分位
  results.push(evaluate('naive_quantile', '全天 P95 分位', series, { q: 0.95 }, { iterations }));

  // 本文算法：默认参数
  results.push(evaluate('vsd', '局部基线（默认）', series, {}, { iterations }));

  const header =
    '| 算法 | 事件数 | 每标的每日 | 15min\\|收益\\| | 时段对照 | lift | p | 全天对照 | lift | 量能延续 | 对照 | 方向命中 | 对照 | p |';
  const divider = '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|';
  console.log(header);
  console.log(divider);
  for (const result of results) {
    console.log(
      `| ${result.label} | ${result.eventCount} | ${fmt(result.perCodeDay, 1)} | ${fmt(result.absRet, 3, '%')} | ${fmt(result.ctrlAbsRet, 3, '%')} | ${fmt(result.lift, 2)} | ${fmt(result.pValue, 3)} | ${fmt(result.ctrlAllAbsRet, 3, '%')} | ${fmt(result.liftAll, 2)} | ${fmt(result.volPersist, 2)} | ${fmt(result.ctrlVolPersist, 2)} | ${fmt(result.dirHit !== null ? result.dirHit * 100 : null, 1, '%')} | ${fmt(result.ctrlDirHit !== null ? result.ctrlDirHit * 100 : null, 1, '%')} | ${fmt(result.dirP, 3)} |`,
    );
  }
  console.log('');

  // 参数敏感性：局部窗口 × 倍数门槛
  console.log('参数敏感性（局部基线法）：');
  console.log('| 基线窗口 | 倍数 | z | 事件数 | 每标的每日 | 15min\\|收益\\| | lift | p 值 | 量能延续 | 方向命中 |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  const grid = [];
  for (const baselineWindow of [10, 20, 30]) {
    for (const upRatio of [2, 3, 4]) {
      for (const upZ of [3, 5]) {
        const params = { baselineWindow, upRatio, upZ };
        const result = evaluate('vsd', `W${baselineWindow}/x${upRatio}/z${upZ}`, series, params, { iterations: Math.min(iterations, 400) });
        grid.push(result);
        console.log(
          `| ${baselineWindow} | ${upRatio} | ${upZ} | ${result.eventCount} | ${fmt(result.perCodeDay, 1)} | ${fmt(result.absRet, 3, '%')} | ${fmt(result.lift, 2)} | ${fmt(result.pValue, 4)} | ${fmt(result.volPersist, 2)} | ${fmt(result.dirHit !== null ? result.dirHit * 100 : null, 1, '%')} |`,
        );
      }
    }
  }
  console.log('');

  const baseline = results.find((result) => result.name === 'vsd');
  console.log('默认参数事件时段分布：', JSON.stringify(baseline.buckets));

  // 确认条件增益：把「有方向的主动放量」从「无方向的被动放量」中分离出来
  console.log('\n确认条件增益（局部基线 W20 / ×3 / z4）：');
  console.log('| 组合 | 事件数 | 每标的每日 | 方向命中 | p | 同向15min收益 | 对照 | p | 量能延续 | 15min\\|收益\\| |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  const confirmations = [
    ['裸信号（无价格确认）', { requireConfirm: false, mergeGapBars: 0 }],
    ['裸信号 + 同波合并', { requireConfirm: false }],
    ['旧线上：严格区间突破', { requireRangeBreak: true, mergeGapBars: 0 }],
    ['旧线上 + 同波合并', { requireRangeBreak: true }],
    ['★ 新线上：分级确认 + 合并', {}],
    ['新口径（不合并）', { mergeGapBars: 0 }],
    ['新口径 + 额≥300万', { minAmount: 3_000_000 }],
    ['新口径 + 额≥300万 + 位移 0.2%', { minAmount: 3_000_000, minTickPct: 0.2 }],
  ];
  const confirmResults = [];
  for (const [label, params] of confirmations) {
    const result = evaluate('vsd', label, series, params, { iterations });
    confirmResults.push(result);
    console.log(
      `| ${label} | ${result.eventCount} | ${fmt(result.perCodeDay, 1)} | ${fmt(result.dirHit !== null ? result.dirHit * 100 : null, 1, '%')} | ${fmt(result.dirP, 3)} | ${fmt(result.signedRet, 3, '%')} | ${fmt(result.ctrlSignedRet, 3, '%')} | ${fmt(result.signedP, 3)} | ${fmt(result.volPersist, 2)} | ${fmt(result.absRet, 3, '%')} |`,
    );
  }
  console.log('');

  // 稳健性：同一只 ETF 在同一天的多个事件高度相关（往往同一波行情），
  // 按「分钟」独立抽样会低估方差、夸大显著性。改为按「标的」整簇重抽样。
  console.log('稳健性检验（按标的整簇重抽样 2000 次，95% 区间）：');
  console.log('| 组合 | 参与标的 | 同向收益均值 | 95% 区间 | >0 概率 | 方向命中 | 95% 区间 |');
  console.log('|---|---:|---:|---|---:|---:|---|');
  for (const label of ['裸信号（无价格确认）', '旧线上：严格区间突破', '★ 新线上：分级确认 + 合并']) {
    const result = confirmResults.find((item) => item.label === label);
    if (!result) continue;
    const signed = clusterBootstrap(result.eventRows, 'signedRet', { seed: 7 });
    const hitRows = result.eventRows
      .filter((row) => row.sameDir !== null)
      .map((row) => ({ ...row, hit: row.sameDir ? 1 : 0 }));
    const hit = clusterBootstrap(hitRows, 'hit', { seed: 11 });
    console.log(
      `| ${label} | ${signed.clusters} | ${fmt(signed.mean, 3, '%')} | [${fmt(signed.lo, 3, '%')}, ${fmt(signed.hi, 3, '%')}] | ${fmt(signed.positive * 100, 1, '%')} | ${fmt(hit.mean * 100, 1, '%')} | [${fmt(hit.lo * 100, 1, '%')}, ${fmt(hit.hi * 100, 1, '%')}] |`,
    );
  }
  console.log('');

  // 强度分层：检验「高等级事件」是否比低等级更值得推送
  console.log('\n默认参数按强度分层：');
  console.log('| 强度 | 事件数 | 15min\\|收益\\| 中位 | 量能延续 | 方向命中 | 单事件平均量能占比 |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const level of [3, 2, 1]) {
    const subset = baseline.eventRows.filter((row) => row.level === level);
    if (subset.length === 0) continue;
    const share = mean(subset.map((row) => row.volumeShare).filter((value) => Number.isFinite(value)));
    const hit = subset.filter((row) => row.sameDir !== null);
    console.log(
      `| L${level} | ${subset.length} | ${fmt(median(subset.map((row) => Math.abs(row.ret))), 3, '%')} | ${fmt(mean(subset.map((row) => row.volPersist).filter((v) => Number.isFinite(v))), 2)} | ${fmt(hit.length ? (hit.filter((row) => row.sameDir).length / hit.length) * 100 : null, 1, '%')} | ${fmt(share !== null ? share * 100 : null, 2, '%')} |`,
    );
  }

  // 骤减告警的检出能力：分钟级量能「骤减」是否是一个可用的信号维度
  const drainTotal = results.reduce(
    (acc, result) => acc + (result.name === 'vsd' ? result.eventRows.filter((row) => row.direction === 'drain').length : 0),
    0,
  );
  console.log(`\n骤减（量能枯竭）事件数：${drainTotal}（阈值为 ratio ≤ 1/3 且 z ≤ -4）`);

  console.log('\n默认参数事件样本（前 20 条）：');
  for (const row of baseline.eventRows.slice(0, 20)) {
    console.log(
      `  ${row.code} ${row.minute} ${row.direction} vol=${row.volume} base=${Math.round(row.baseline)} x${row.ratio.toFixed(1)} z=${row.z.toFixed(1)} L${row.level} ret15=${fmt(row.ret, 2, '%')} persist=${fmt(row.volPersist, 2)}`,
    );
  }

  const outPath = path.join(config.rootDir, 'reports', 'volume-surge-backtest.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        tradeDate,
        window: W,
        series: series.length,
        totalBars,
        iterations,
        results: results.map(({ eventRows, topCodes, ...rest }) => rest),
        grid: grid.map(({ eventRows, topCodes, buckets, ...rest }) => rest),
        baselineEvents: baseline.eventRows.map((row) => ({
          code: row.code,
          minute: row.minute,
          volume: row.volume,
          baseline: row.baseline,
          ratio: row.ratio,
          z: row.z,
          level: row.level,
          ret: row.ret,
          volPersist: row.volPersist,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\n结果已写入 ${outPath}`);
}

main();
