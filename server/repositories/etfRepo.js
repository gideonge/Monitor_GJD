const placeholders = (count) => Array.from({ length: count }, () => '?').join(',');

export function createEtfRepo(db) {
  const upsert = db.prepare(`
    INSERT INTO etf (code, name, market, category, price, pct_chg, turnover, main_net, main_ratio, super_net, quote_ts, tracked, pinned, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      market = excluded.market,
      category = excluded.category,
      price = COALESCE(excluded.price, etf.price),
      pct_chg = COALESCE(excluded.pct_chg, etf.pct_chg),
      turnover = COALESCE(excluded.turnover, etf.turnover),
      main_net = COALESCE(excluded.main_net, etf.main_net),
      main_ratio = COALESCE(excluded.main_ratio, etf.main_ratio),
      super_net = COALESCE(excluded.super_net, etf.super_net),
      quote_ts = COALESCE(excluded.quote_ts, etf.quote_ts),
      updated_at = excluded.updated_at
  `);

  // 每一列都 COALESCE：清单刷新、降级源、单条缺字段都不许把已有值冲成 NULL。
  // 「这一轮没更新」应当是「沿用上一时刻」，不是「变成空白」。
  const updateQuote = db.prepare(`
    UPDATE etf SET
      price      = COALESCE(?, price),
      pct_chg    = COALESCE(?, pct_chg),
      turnover   = COALESCE(?, turnover),
      main_net   = COALESCE(?, main_net),
      main_ratio = COALESCE(?, main_ratio),
      super_net  = COALESCE(?, super_net),
      main_ts    = COALESCE(?, main_ts),
      active_net = COALESCE(?, active_net),
      active_ts  = COALESCE(?, active_ts),
      quote_ts   = COALESCE(?, quote_ts),
      updated_at = ?
    WHERE code = ?
  `);

  const clearTracked = db.prepare('UPDATE etf SET tracked = 0 WHERE tracked = 1');
  const markTracked = (codes) => {
    if (codes.length === 0) return;
    db.prepare(`UPDATE etf SET tracked = 1 WHERE code IN (${placeholders(codes.length)})`).run(...codes);
  };

  return {
    upsertMany(rows, now = Date.now()) {
      for (const row of rows) {
        upsert.run(
          row.code,
          row.name,
          row.market,
          row.category,
          row.price ?? null,
          row.pctChg ?? null,
          row.turnover ?? 0,
          row.mainNet ?? null,
          row.mainRatio ?? null,
          row.superNet ?? null,
          row.quoteTs ?? null,
          now,
          now,
        );
      }
    },

    /** 更新"最近已知快照"缓存，保证重启或上游不可用时仍有数据可展示 */
    updateQuotes(rows, now = Date.now()) {
      for (const row of rows) {
        const turnover = Number(row.turnover);
        updateQuote.run(
          row.price ?? null,
          row.pctChg ?? null,
          Number.isFinite(turnover) && turnover > 0 ? turnover : null,
          row.mainNet ?? null,
          row.mainRatio ?? null,
          row.superNet ?? null,
          row.mainNet === null || row.mainNet === undefined ? null : row.mainTs ?? row.quoteTs ?? now,
          row.activeNet ?? null,
          row.activeNet === null || row.activeNet === undefined ? null : row.activeTs ?? row.quoteTs ?? now,
          row.quoteTs ?? null,
          now,
          row.code,
        );
      }
    },

    setTracked(codes) {
      clearTracked.run();
      markTracked(codes);
    },

    get(code) {
      return db.prepare('SELECT * FROM etf WHERE code = ?').get(code) ?? null;
    },

    listTracked() {
      return db
        .prepare('SELECT * FROM etf WHERE tracked = 1 ORDER BY turnover DESC')
        .all();
    },

    listPinned() {
      return db.prepare('SELECT code FROM etf WHERE pinned = 1').all().map((row) => row.code);
    },

    setPinned(code, pinned) {
      const result = db.prepare('UPDATE etf SET pinned = ?, tracked = ? WHERE code = ?').run(
        pinned ? 1 : 0,
        pinned ? 1 : 0,
        code,
      );
      return Number(result.changes ?? 0) > 0;
    },

    listVisible({ limit = 200 } = {}) {
      return db
        .prepare('SELECT * FROM etf ORDER BY tracked DESC, turnover DESC LIMIT ?')
        .all(limit);
    },

    topByTurnover(limit) {
      return db.prepare('SELECT * FROM etf ORDER BY turnover DESC LIMIT ?').all(limit);
    },

    count() {
      return db.prepare('SELECT COUNT(*) AS c FROM etf').get().c;
    },

    countTracked() {
      return db.prepare('SELECT COUNT(*) AS c FROM etf WHERE tracked = 1').get().c;
    },

    search({ keyword, category, onlyTracked = false, limit = 200 } = {}) {
      const clauses = [];
      const params = [];
      if (keyword) {
        clauses.push('(code LIKE ? OR name LIKE ?)');
        params.push(`%${keyword}%`, `%${keyword}%`);
      }
      if (category) {
        clauses.push('category = ?');
        params.push(category);
      }
      if (onlyTracked) clauses.push('tracked = 1');
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      params.push(limit);
      return db
        .prepare(`SELECT * FROM etf ${where} ORDER BY tracked DESC, turnover DESC LIMIT ?`)
        .all(...params);
    },

    categoryBreakdown() {
      return db
        .prepare('SELECT category, COUNT(*) AS count FROM etf WHERE tracked = 1 GROUP BY category ORDER BY count DESC')
        .all();
    },
  };
}
