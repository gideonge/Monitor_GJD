export function createFlowRepo(db) {
  const insertSnapshot = db.prepare(`
    INSERT OR IGNORE INTO flow_snapshot
      (code, ts, trade_date, main_net, active_net, super_net, big_net, mid_net, small_net, main_ratio, price, pct_chg, turnover, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertDaily = db.prepare(`
    INSERT INTO flow_daily (code, trade_date, main_net, super_net, big_net, mid_net, small_net, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code, trade_date) DO UPDATE SET
      main_net = excluded.main_net,
      super_net = excluded.super_net,
      big_net = excluded.big_net,
      mid_net = excluded.mid_net,
      small_net = excluded.small_net,
      source = excluded.source,
      updated_at = excluded.updated_at
  `);

  const placeholders = (count) => Array.from({ length: count }, () => '?').join(',');

  return {
    insertSnapshots(rows) {
      let inserted = 0;
      for (const row of rows) {
        const result = insertSnapshot.run(
          row.code,
          row.ts,
          row.tradeDate,
          row.mainNet ?? null,
          row.activeNet ?? null,
          row.superNet ?? 0,
          row.bigNet ?? 0,
          row.midNet ?? 0,
          row.smallNet ?? 0,
          row.mainRatio ?? null,
          row.price ?? null,
          row.pctChg ?? null,
          row.turnover ?? null,
          row.source ?? 'live',
        );
        inserted += Number(result.changes ?? 0);
      }
      return inserted;
    },

    latestForCodes(codes, fromTs = 0) {
      if (codes.length === 0) return [];
      return db
        .prepare(`
          SELECT s.* FROM flow_snapshot s
          JOIN (
            SELECT code, MAX(ts) AS mts FROM flow_snapshot
            WHERE ts >= ? AND code IN (${placeholders(codes.length)})
            GROUP BY code
          ) t ON s.code = t.code AND s.ts = t.mts
        `)
        .all(fromTs, ...codes);
    },

    latestForCode(code) {
      return db
        .prepare('SELECT * FROM flow_snapshot WHERE code = ? ORDER BY ts DESC LIMIT 1')
        .get(code) ?? null;
    },

    /**
     * 按「某一口径」取每只标的最近一次非空值。
     *
     * 不能直接用 latestForCodes：那取的是整行最新，而行里可能恰好缺这一列
     * （东财那一轮没有 active_net，腾讯那一轮没有 main_net）。两个口径各自
     * 找自己的最后已知值，才能做到「这一轮没更新就沿用上一时刻」，且互不顶替。
     */
    latestMetricForCodes(codes, column, fromTs = 0) {
      if (codes.length === 0) return [];
      if (column !== 'main_net' && column !== 'active_net') throw new Error(`不支持的字段：${column}`);
      return db
        .prepare(`
          SELECT s.code, s.${column} AS value, s.ts, s.trade_date
          FROM flow_snapshot s
          JOIN (
            SELECT code, MAX(ts) AS mts FROM flow_snapshot
            WHERE ts >= ? AND ${column} IS NOT NULL AND code IN (${placeholders(codes.length)})
            GROUP BY code
          ) t ON s.code = t.code AND s.ts = t.mts
        `)
        .all(fromTs, ...codes);
    },

    seriesInWindow(fromTs, codes = null) {
      if (codes && codes.length === 0) return [];
      const clause = codes ? `AND code IN (${placeholders(codes.length)})` : '';
      const params = codes ? [fromTs, ...codes] : [fromTs];
      return db
        .prepare(`SELECT * FROM flow_snapshot WHERE ts >= ? ${clause} ORDER BY code ASC, ts ASC`)
        .all(...params);
    },

    intradaySeries(code, tradeDate) {
      return db
        .prepare('SELECT ts, main_net, active_net, super_net, big_net, mid_net, small_net, price, pct_chg, main_ratio FROM flow_snapshot WHERE code = ? AND trade_date = ? ORDER BY ts ASC')
        .all(code, tradeDate);
    },

    firstOfDay(code, tradeDate) {
      return db
        .prepare('SELECT * FROM flow_snapshot WHERE code = ? AND trade_date = ? ORDER BY ts ASC LIMIT 1')
        .get(code, tradeDate) ?? null;
    },

    upsertDailyMany(rows, now = Date.now()) {
      let changed = 0;
      for (const row of rows) {
        const result = upsertDaily.run(
          row.code,
          row.tradeDate,
          row.mainNet,
          row.superNet ?? 0,
          row.bigNet ?? 0,
          row.midNet ?? 0,
          row.smallNet ?? 0,
          row.source ?? 'live',
          now,
        );
        changed += Number(result.changes ?? 0);
      }
      return changed;
    },

    dailySeries(code, limit = 60) {
      return db
        .prepare('SELECT * FROM flow_daily WHERE code = ? ORDER BY trade_date DESC LIMIT ?')
        .all(code, limit)
        .reverse();
    },

    dailyByDate(tradeDate) {
      return db
        .prepare('SELECT code, main_net, super_net FROM flow_daily WHERE trade_date = ?')
        .all(tradeDate);
    },

    latestTradeDate() {
      const row = db.prepare('SELECT MAX(trade_date) AS d FROM flow_daily').get();
      return row?.d ?? null;
    },

    latestSnapshotTradeDate() {
      const row = db.prepare('SELECT MAX(trade_date) AS d FROM flow_snapshot').get();
      return row?.d ?? null;
    },

    pruneSnapshots(beforeTs) {
      const result = db.prepare('DELETE FROM flow_snapshot WHERE ts < ?').run(beforeTs);
      return Number(result.changes ?? 0);
    },

    snapshotCount() {
      return db.prepare('SELECT COUNT(*) AS c FROM flow_snapshot').get().c;
    },
  };
}
