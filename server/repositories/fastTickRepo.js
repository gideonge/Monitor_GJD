export function createFastTickRepo(db) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO fast_tick
      (code, ts, trade_date, price, pct_chg, volume, amount, outer_vol, inner_vol,
       amt_delta, net_delta, bid1, ask1, bid1_vol, ask1_vol, imba, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    insertMany(rows) {
      let inserted = 0;
      for (const row of rows) {
        const result = insert.run(
          row.code,
          row.ts,
          row.tradeDate,
          row.price,
          row.pctChg ?? null,
          row.volume ?? null,
          row.amount ?? null,
          row.outer ?? null,
          row.inner ?? null,
          row.amtDelta ?? null,
          row.netDelta ?? null,
          row.bid1 ?? null,
          row.ask1 ?? null,
          row.bid1Vol ?? null,
          row.ask1Vol ?? null,
          row.imba ?? null,
          row.source ?? 'tencent',
        );
        inserted += Number(result.changes ?? 0);
      }
      return inserted;
    },

    /** 按时间升序取窗口内的秒级点（前端绘图直接使用） */
    series(code, fromTs, { limit = 3600 } = {}) {
      return db
        .prepare(
          `SELECT ts, price, pct_chg, volume, amount, amt_delta, net_delta, imba,
                  bid1, ask1, bid1_vol, ask1_vol
             FROM fast_tick
            WHERE code = ? AND ts >= ?
            ORDER BY ts ASC
            LIMIT ?`,
        )
        .all(code, fromTs, limit);
    },

    summarize(code, fromTs) {
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS points,
                    COALESCE(SUM(amt_delta), 0) AS amt,
                    COALESCE(SUM(net_delta), 0) AS net,
                    COALESCE(SUM(CASE WHEN net_delta > 0 THEN net_delta ELSE 0 END), 0) AS inflow,
                    COALESCE(SUM(CASE WHEN net_delta < 0 THEN net_delta ELSE 0 END), 0) AS outflow,
                    MIN(ts) AS firstTs,
                    MAX(ts) AS lastTs
               FROM fast_tick
              WHERE code = ? AND ts >= ?`,
          )
          .get(code, fromTs) ?? null
      );
    },

    latestTs(code) {
      return db.prepare('SELECT MAX(ts) AS ts FROM fast_tick WHERE code = ?').get(code)?.ts ?? null;
    },

    countForDate(tradeDate) {
      return db.prepare('SELECT COUNT(*) AS c FROM fast_tick WHERE trade_date = ?').get(tradeDate).c;
    },

    countAll() {
      return db.prepare('SELECT COUNT(*) AS c FROM fast_tick').get().c;
    },

    pruneBefore(ts) {
      const result = db.prepare('DELETE FROM fast_tick WHERE ts < ?').run(ts);
      return Number(result.changes ?? 0);
    },
  };
}
