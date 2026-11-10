#!/usr/bin/env node
/**
 * 清理「不监控分类」的历史数据（默认：债券货币）。
 *
 * 为什么需要单独清理：
 *   东财清单接口不返回货币 / 债券 ETF，这批标的只能靠历史清单留在库里，
 *   行情、净额、分时全部停在最后一次抓到的时刻。它们已经不参与轮询，
 *   留在库里只会在各种查询里被当成「不更新的数据」，也让「覆盖标的」虚高。
 *
 * 删除是安全的：清单里还有的标的，下一轮 syncUniverse 会自动 upsert 回来；
 * 真正删掉的只是那些永远不会再被采集的行。
 *
 * 用法：
 *   node scripts/purge-excluded.js --dry-run   # 只统计，不改库
 *   node scripts/purge-excluded.js             # 执行删除（先自动备份）
 */

import fs from 'node:fs';
import config from '../server/config/index.js';
import { openDatabase } from '../server/db/index.js';

const dryRun = process.argv.includes('--dry-run');
const categories = config.trackedExcludeCategories;

if (categories.length === 0) {
  console.log('TRACKED_EXCLUDE_CATEGORIES 为空：没有需要清理的分类。');
  process.exit(0);
}

console.log(`待清理分类：${categories.join('、')}`);
console.log(`数据库：${config.dbFile}`);

const db = openDatabase(config.dbFile);
const marks = categories.map(() => '?').join(',');
const targets = db
  .prepare(`SELECT code, name, category, turnover FROM etf WHERE category IN (${marks}) ORDER BY turnover DESC`)
  .all(...categories);

if (targets.length === 0) {
  console.log('没有匹配的标的，无需清理。');
  process.exit(0);
}

console.log(`\n命中 ${targets.length} 只：`);
for (const row of targets.slice(0, 15)) {
  console.log(`  ${row.code} ${row.name} [${row.category}] ${(row.turnover / 1e8).toFixed(1)} 亿`);
}
if (targets.length > 15) console.log(`  … 其余 ${targets.length - 15} 只`);

const codes = targets.map((row) => row.code);
const inMarks = codes.map(() => '?').join(',');

/** 只有真正存在 code 列的表才处理，避免迁移差异导致脚本中断 */
const tables = ['flow_snapshot', 'flow_daily', 'intraday_bar', 'fast_tick', 'alert'];
const hasCodeColumn = (table) => {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === 'code');
  } catch {
    return false;
  }
};

const counts = {};
for (const table of tables) {
  if (!hasCodeColumn(table)) continue;
  counts[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE code IN (${inMarks})`).get(...codes).c;
}

console.log('\n关联数据：');
for (const [table, count] of Object.entries(counts)) {
  console.log(`  ${table}: ${count} 行`);
}

if (dryRun) {
  console.log('\n--dry-run：未修改数据库。');
  process.exit(0);
}

// 先备份再删：删库不可逆，留一个可回退的副本。
// 用 VACUUM INTO 而不是 copyFileSync：WAL 模式下直接拷主文件会漏掉还没 checkpoint 的数据。
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = `${config.dbFile}.bak-purge-${stamp}`;
try {
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
} catch (error) {
  console.warn(`VACUUM INTO 失败（${error.message}），退回文件拷贝`);
  fs.copyFileSync(config.dbFile, backup);
}
console.log(`\n已备份：${backup}`);

db.exec('BEGIN IMMEDIATE');
try {
  for (const table of tables) {
    if (!counts[table]) continue;
    db.prepare(`DELETE FROM ${table} WHERE code IN (${inMarks})`).run(...codes);
  }
  db.prepare(`DELETE FROM etf WHERE category IN (${marks})`).run(...categories);
  db.exec('COMMIT');
  console.log('删除完成。');
} catch (error) {
  db.exec('ROLLBACK');
  console.error('删除失败，已回滚：', error.message);
  process.exit(1);
}

const left = db.prepare(`SELECT COUNT(*) AS c FROM etf WHERE category IN (${marks})`).get(...categories).c;
const total = db.prepare('SELECT COUNT(*) AS c FROM etf').get().c;
console.log(`剩余同分类行：${left}；表内总计 ${total} 行。`);
