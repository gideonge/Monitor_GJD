/**
 * 分钟级分时行情仓储。
 * 一行 = 某只 ETF 在某交易日某分钟的行情切片，主键 (code, trade_date, minute)，
 * 因此重复回填同一天是幂等 upsert，不会产生重复点。
 */
export function createIntradayRepo(db) {
  const upsert = db.prepare(`
    INSERT INTO intraday_bar
      (code, trade_date, minute, ts, open, close, high, low, avg_price, volume, amount, pre_close, day_high, day_low, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code, trade_date, minute) DO UPDATE SET
      ts = excluded.ts,
      open = excluded.open,
      close = excluded.close,
      high = excluded.high,
      low = excluded.low,
      avg_price = excluded.avg_price,
      volume = excluded.volume,
      amount = excluded.amount,
      pre_close = COALESCE(excluded.pre_close, intraday_bar.pre_close),
      day_high = COALESCE(excluded.day_high, intraday_bar.day_high),
      day_low = COALESCE(excluded.day_low, intraday_bar.day_low),
      source = excluded.source,
      updated_at = excluded.updated_at
  `);

  return {
    upsertMany(rows, now = Date.now()) {
      let changed = 0;
      for (const row of rows) {
        if (!row.code) throw new Error('intraday_bar 写入缺少 code 字段');
        const result = upsert.run(
          row.code,
          row.tradeDate,
          row.minute,
          row.ts,
          row.open ?? null,
          row.close ?? null,
          row.high ?? null,
          row.low ?? null,
          row.avgPrice ?? null,
          row.volume ?? 0,
          row.amount ?? 0,
          row.preClose ?? null,
          row.dayHigh ?? null,
          row.dayLow ?? null,
          row.source ?? 'eastmoney',
          now,
        );
        changed += Number(result.changes ?? 0);
      }
      return changed;
    },

    series(code, tradeDate) {
      return db
        .prepare(
          'SELECT minute, ts, open, close, high, low, avg_price, volume, amount, pre_close, day_high, day_low FROM intraday_bar WHERE code = ? AND trade_date = ? ORDER BY minute ASC',
        )
        .all(code, tradeDate);
    },

    /** 该标的已落库的交易日（降序），用于前端切换 */
    dates(code, limit = 5) {
      return db
        .prepare('SELECT DISTINCT trade_date AS d FROM intraday_bar WHERE code = ? ORDER BY d DESC LIMIT ?')
        .all(code, limit)
        .map((row) => row.d);
    },

    latestDate(code) {
      return db.prepare('SELECT MAX(trade_date) AS d FROM intraday_bar WHERE code = ?').get(code)?.d ?? null;
    },

    countOf(code, tradeDate) {
      return db.prepare('SELECT COUNT(*) AS c FROM intraday_bar WHERE code = ? AND trade_date = ?').get(code, tradeDate).c;
    },

    /** 已落库的最后一个分钟（HH:MM），用于盘中增量写入，避免整日重复 upsert */
    lastMinute(code, tradeDate) {
      return (
        db
          .prepare('SELECT MAX(minute) AS m FROM intraday_bar WHERE code = ? AND trade_date = ?')
          .get(code, tradeDate)?.m ?? null
      );
    },

    /** 已完整落库的标的中，某交易日覆盖数量（用于判断是否需要回填） */
    coveredCount(tradeDate) {
      return db.prepare('SELECT COUNT(DISTINCT code) AS c FROM intraday_bar WHERE trade_date = ?').get(tradeDate).c;
    },

    pruneBefore(tradeDate) {
      const result = db.prepare('DELETE FROM intraday_bar WHERE trade_date < ?').run(tradeDate);
      return Number(result.changes ?? 0);
    },
  };
}
