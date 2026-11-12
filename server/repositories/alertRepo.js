export function createAlertRepo(db) {
  const insert = db.prepare(`
    INSERT INTO alert
      (rule_id, rule_name, code, etf_name, category, metric, timeframe, comparator, threshold,
       value, delta, baseline, window_sec, severity, condition_text, message, dedupe_key,
       source, trade_date, triggered_at, price_move_pct, net_flow, acknowledged, acknowledged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
    ON CONFLICT(rule_id, code, dedupe_key) DO NOTHING
  `);

  return {
    /** 返回新插入的告警 id；重复（命中 dedupe 索引）返回 null */
    insert(alert) {
      const result = insert.run(
        alert.ruleId ?? null,
        alert.ruleName,
        alert.code,
        alert.etfName,
        alert.category ?? null,
        alert.metric,
        alert.timeframe,
        alert.comparator,
        alert.threshold,
        alert.value,
        alert.delta ?? null,
        alert.baseline ?? null,
        alert.windowSec ?? null,
        alert.severity,
        alert.conditionText,
        alert.message,
        alert.dedupeKey,
        alert.source ?? 'live',
        alert.tradeDate ?? null,
        alert.triggeredAt,
        alert.priceMovePct ?? null,
        alert.netFlow ?? null,
      );
      if (Number(result.changes ?? 0) === 0) return null;
      return Number(result.lastInsertRowid);
    },

    getById(id) {
      return db.prepare('SELECT * FROM alert WHERE id = ?').get(id) ?? null;
    },

    lastTriggeredAt(ruleId, code) {
      const row = db
        .prepare('SELECT MAX(triggered_at) AS ts FROM alert WHERE rule_id = ? AND code = ?')
        .get(ruleId, code);
      return row?.ts ?? null;
    },

    list({ limit = 50, offset = 0, code, severity, acknowledged, metric, since } = {}) {
      const clauses = [];
      const params = [];
      if (code) {
        clauses.push('code = ?');
        params.push(code);
      }
      if (severity) {
        clauses.push('severity = ?');
        params.push(severity);
      }
      if (acknowledged === true || acknowledged === false) {
        clauses.push('acknowledged = ?');
        params.push(acknowledged ? 1 : 0);
      }
      if (metric) {
        clauses.push('metric = ?');
        params.push(metric);
      }
      if (since) {
        clauses.push('triggered_at >= ?');
        params.push(since);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM alert ${where} ORDER BY triggered_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
      const total = db.prepare(`SELECT COUNT(*) AS c FROM alert ${where}`).get(...params).c;
      return { rows, total };
    },

    recent(limit = 8) {
      return db
        .prepare('SELECT * FROM alert ORDER BY triggered_at DESC, id DESC LIMIT ?')
        .all(limit);
    },

    acknowledge(id) {
      const result = db
        .prepare('UPDATE alert SET acknowledged = 1, acknowledged_at = ? WHERE id = ? AND acknowledged = 0')
        .run(Date.now(), id);
      return Number(result.changes ?? 0) > 0;
    },

    summarize({ since } = {}) {
      const scope = since ? 'WHERE triggered_at >= ?' : '';
      const params = since ? [since] : [];
      const bySeverity = db
        .prepare(`SELECT severity, COUNT(*) AS count FROM alert ${scope} GROUP BY severity`)
        .all(...params);
      const total = db.prepare(`SELECT COUNT(*) AS c FROM alert ${scope}`).get(...params).c;
      const unacknowledged = db
        .prepare(`SELECT COUNT(*) AS c FROM alert ${scope ? `${scope} AND` : 'WHERE'} acknowledged = 0`)
        .get(...params).c;
      return { total, unacknowledged, bySeverity };
    },

    topCodes({ limit = 5, since } = {}) {
      const scope = since ? 'WHERE triggered_at >= ? AND acknowledged = 0' : 'WHERE acknowledged = 0';
      const params = since ? [since] : [];
      return db
        .prepare(`SELECT code, etf_name, COUNT(*) AS count FROM alert ${scope} GROUP BY code ORDER BY count DESC LIMIT ?`)
        .all(...params, limit);
    },
  };
}
