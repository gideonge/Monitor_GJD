import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 8000');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

/**
 * 迁移：按文件名顺序执行，记录校验和。已应用的迁移被篡改会立即失败，
 * 保证 schema 变更可追溯、可回滚（回滚依赖备份 + 反向脚本）。
 */
export function runMigrations(db, migrationsDir, logger) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const applied = new Map(
    db.prepare('SELECT version, checksum FROM schema_migrations').all().map((row) => [row.version, row.checksum]),
  );

  for (const file of files) {
    const raw = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // 行尾归一后再算校验和。库最初是在 Windows 检出（CRLF）上建起来的、服务器上是 LF，
    // 同一个文件在两条链路上哈希不同，会误报「迁移文件在应用后被修改」（2026-11-02 踩到）。
    // 因此 LF / CRLF 两种形态都认，新应用的迁移一律写入 LF 哈希。
    const sql = raw.replace(/\r\n/g, '\n');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
    const crlfChecksum = crypto
      .createHash('sha256')
      .update(sql.replace(/\n/g, '\r\n'))
      .digest('hex')
      .slice(0, 16);
    if (applied.has(file)) {
      const recorded = applied.get(file);
      if (recorded !== checksum && recorded !== crlfChecksum) {
        throw new Error(`迁移文件 ${file} 在应用后被修改，请新增迁移而不是改写历史迁移`);
      }
      continue;
    }
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)').run(
        file,
        checksum,
        Date.now(),
      );
      db.exec('COMMIT');
      logger?.info('已应用数据库迁移', { migration: file });
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

/**
 * 事务包装。约定：仓储层方法内部不开事务，由服务层组合调用时统一包裹，
 * 避免 SQLite 不支持嵌套 BEGIN 的问题。
 */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败不掩盖原始错误 */
    }
    throw error;
  }
}

export { DatabaseSync };
