-- 001_init.sql：ETF 资金流监控平台初始 schema

CREATE TABLE IF NOT EXISTS etf (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  market        INTEGER NOT NULL,                 -- 0 深市 / 1 沪市
  category      TEXT NOT NULL DEFAULT '其他',
  price         REAL,
  pct_chg       REAL,
  turnover      REAL NOT NULL DEFAULT 0,
  tracked       INTEGER NOT NULL DEFAULT 0,       -- 是否纳入盘中监控池
  pinned        INTEGER NOT NULL DEFAULT 0,       -- 用户手动固定，不受监控池规模裁剪
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_etf_turnover ON etf (turnover DESC);
CREATE INDEX IF NOT EXISTS ix_etf_category ON etf (category);
CREATE INDEX IF NOT EXISTS ix_etf_tracked ON etf (tracked);

-- 盘中轮询累积的资金流快照（分时序列）
CREATE TABLE IF NOT EXISTS flow_snapshot (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  trade_date TEXT NOT NULL,
  main_net   REAL NOT NULL,
  super_net  REAL NOT NULL DEFAULT 0,
  big_net    REAL NOT NULL DEFAULT 0,
  mid_net    REAL NOT NULL DEFAULT 0,
  small_net  REAL NOT NULL DEFAULT 0,
  main_ratio REAL,
  price      REAL,
  pct_chg    REAL,
  turnover   REAL,
  source     TEXT NOT NULL DEFAULT 'live'
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_snapshot_code_ts ON flow_snapshot (code, ts);
CREATE INDEX IF NOT EXISTS ix_snapshot_code_ts ON flow_snapshot (code, ts DESC);
CREATE INDEX IF NOT EXISTS ix_snapshot_ts ON flow_snapshot (ts);

-- 日级资金流历史（用于趋势与基准）
CREATE TABLE IF NOT EXISTS flow_daily (
  code       TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  main_net   REAL NOT NULL,
  super_net  REAL NOT NULL DEFAULT 0,
  big_net    REAL NOT NULL DEFAULT 0,
  mid_net    REAL NOT NULL DEFAULT 0,
  small_net  REAL NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'live',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (code, trade_date)
);
CREATE INDEX IF NOT EXISTS ix_daily_date ON flow_daily (trade_date);

-- 阈值规则
CREATE TABLE IF NOT EXISTS alert_rule (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  metric       TEXT NOT NULL,
  timeframe    TEXT NOT NULL,
  comparator   TEXT NOT NULL,
  threshold    REAL NOT NULL,
  window_sec   INTEGER NOT NULL DEFAULT 300,
  scope        TEXT NOT NULL DEFAULT 'all',
  scope_value  TEXT,
  severity     TEXT NOT NULL DEFAULT 'medium',
  cooldown_sec INTEGER NOT NULL DEFAULT 1800,
  enabled      INTEGER NOT NULL DEFAULT 1,
  is_system    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- 告警记录
CREATE TABLE IF NOT EXISTS alert (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id        INTEGER,
  rule_name      TEXT NOT NULL,
  code           TEXT NOT NULL,
  etf_name       TEXT NOT NULL,
  category       TEXT,
  metric         TEXT NOT NULL,
  timeframe      TEXT NOT NULL,
  comparator     TEXT NOT NULL,
  threshold      REAL NOT NULL,
  value          REAL NOT NULL,
  delta          REAL,
  baseline       REAL,
  window_sec     INTEGER,
  severity       TEXT NOT NULL,
  condition_text TEXT NOT NULL,
  message        TEXT NOT NULL,
  dedupe_key     TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'live',
  trade_date     TEXT,
  triggered_at   INTEGER NOT NULL,
  acknowledged   INTEGER NOT NULL DEFAULT 0,
  acknowledged_at INTEGER,
  FOREIGN KEY (rule_id) REFERENCES alert_rule (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_alert_dedupe ON alert (rule_id, code, dedupe_key);
CREATE INDEX IF NOT EXISTS ix_alert_triggered ON alert (triggered_at DESC);
CREATE INDEX IF NOT EXISTS ix_alert_code ON alert (code);
CREATE INDEX IF NOT EXISTS ix_alert_severity ON alert (severity);

-- 运行时状态（最后同步时间、数据源健康度等）
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 平台设置（可覆盖默认阈值等）
CREATE TABLE IF NOT EXISTS app_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
