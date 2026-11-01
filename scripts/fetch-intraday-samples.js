/**
 * 采集「同一交易日」的分钟级成交量样本，供日内量能突变算法回测使用。
 *
 * 为什么单独采集：本地 intraday_bar 只缓存了少量标的的分时（点开详情才回填），
 * 而回测需要横截面样本量。东财分时接口对出口 IP 限流，改走腾讯分钟接口
 * （返回当日逐分钟「累计」成交量/额，需差分还原为每分钟增量）。
 *
 * 注意：这里刻意只取单个交易日，不取多日——回测目标就是「日内量能骤变」，
 * 跨日样本会引入隔夜跳空、日间量能水平漂移，反而干扰对算法的评估。
 *
 * 用法：node scripts/fetch-intraday-samples.js [--limit=60] [--out=...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config/index.js';
import { getText } from '../server/lib/httpClient.js';
import { sleep } from '../server/lib/concurrency.js';
import { SESSIONS } from '../server/services/volumeSurge.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const TRADABLE = new Set();
for (const session of SESSIONS) {
  // 生成可判定分钟集合，用于过滤盘后与集合竞价
  const [sh, sm] = session.start.split(':').map(Number);
  const [eh, em] = session.end.split(':').map(Number);
  for (let t = sh * 60 + sm; t <= eh * 60 + em; t += 1) {
    TRADABLE.add(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
}

function argValue(name, fallback) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** 解析腾讯分钟行：`0930 4.059 108844 44179780.00` → 分钟 / 价 / 累计量 / 累计额 */
function parseMinuteLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const raw = parts[0];
  if (!/^\d{4}$/.test(raw)) return null;
  const minute = `${raw.slice(0, 2)}:${raw.slice(2, 4)}`;
  return {
    minute,
    price: Number(parts[1]),
    cumVolume: Number(parts[2]),
    cumAmount: Number(parts[3] ?? 0),
  };
}

async function fetchOne(code, market) {
  const symbol = `${market === 1 ? 'sh' : 'sz'}${code}`;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`;
  const text = await getText(url, { headers: { 'User-Agent': UA }, timeoutMs: 12000 });
  const payload = JSON.parse(text);
  const node = payload?.data?.[symbol];
  const rows = node?.data?.data;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('返回空');

  const tradeDate = String(node.data.date ?? '');
  const parsed = rows.map(parseMinuteLine).filter(Boolean);

  // 累计量差分成每分钟增量；首行（09:30）含开盘集合竞价，按规则会被算法剔除
  const bars = [];
  let prevVolume = 0;
  let prevAmount = 0;
  for (const row of parsed) {
    const volume = Math.max(0, row.cumVolume - prevVolume);
    const amount = Math.max(0, row.cumAmount - prevAmount);
    prevVolume = row.cumVolume;
    prevAmount = row.cumAmount;
    if (!TRADABLE.has(row.minute)) continue;
    bars.push({ minute: row.minute, close: row.price, volume, amount });
  }

  return {
    code,
    market,
    tradeDate: `${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`,
    bars,
    totalVolume: prevVolume,
  };
}

async function main() {
  const limit = Number(argValue('limit', '60'));
  const concurrency = Number(argValue('concurrency', '4'));

  const db = new DatabaseSync(config.dbFile, { readOnly: true });
  const pool = db
    .prepare('SELECT code, name, market, category FROM etf ORDER BY tracked DESC, turnover DESC LIMIT ?')
    .all(limit);
  db.close();

  const samples = [];
  const failures = [];
  const started = Date.now();

  for (let i = 0; i < pool.length; i += concurrency) {
    const batch = pool.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((etf) => fetchOne(etf.code, etf.market)));
    settled.forEach((result, index) => {
      const etf = batch[index];
      if (result.status === 'fulfilled') {
        samples.push({ ...result.value, name: etf.name, category: etf.category });
      } else {
        failures.push({ code: etf.code, name: etf.name, error: String(result.reason?.message ?? result.reason) });
      }
    });
    process.stderr.write(`\r已采集 ${Math.min(i + concurrency, pool.length)}/${pool.length}`);
    await sleep(250);
  }
  process.stderr.write('\n');

  const dates = [...new Set(samples.map((sample) => sample.tradeDate))].sort();
  if (dates.length !== 1) {
    throw new Error(`样本跨多个交易日（${dates.join(',')}），与「仅日内回测」的前提冲突`);
  }

  const outPath = argValue('out', path.join(config.dataDir, 'samples', `intraday-${dates[0]}.json`));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const payload = {
    tradeDate: dates[0],
    collectedAt: Date.now(),
    count: samples.length,
    samples: samples.sort((a, b) => a.code.localeCompare(b.code)),
    failures,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload));

  const bars = samples.reduce((sum, sample) => sum + sample.bars.length, 0);
  console.log(
    JSON.stringify(
      {
        tradeDate: dates[0],
        codes: samples.length,
        bars,
        failed: failures.length,
        elapsedMs: Date.now() - started,
        out: outPath,
      },
      null,
      1,
    ),
  );
}

main().catch((error) => {
  console.error('采集失败：', error.message);
  process.exit(1);
});
