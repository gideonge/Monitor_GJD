export function createStateRepo(db) {
  const upsertState = db.prepare(`
    INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const upsertSetting = db.prepare(`
    INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  return {
    getState(key) {
      const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return row.value;
      }
    },

    setState(key, value, now = Date.now()) {
      upsertState.run(key, JSON.stringify(value), now);
    },

    getSetting(key, fallback = null) {
      const row = db.prepare('SELECT value FROM app_setting WHERE key = ?').get(key);
      if (!row) return fallback;
      try {
        return JSON.parse(row.value);
      } catch {
        return row.value;
      }
    },

    setSetting(key, value, now = Date.now()) {
      upsertSetting.run(key, JSON.stringify(value), now);
    },

    listSettings() {
      const rows = db.prepare('SELECT key, value FROM app_setting').all();
      const out = {};
      for (const row of rows) {
        try {
          out[row.key] = JSON.parse(row.value);
        } catch {
          out[row.key] = row.value;
        }
      }
      return out;
    },
  };
}
