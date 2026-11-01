-- 003_intraday_bar.sql：分钟级分时行情（价格 + 成交量 + 成交额）
-- 背景：上游分钟级资金流接口（fflow/kline klt=1）不返回数据，盘中主力净流入只能靠
-- 快照轮询累积；但分时价格与分钟成交量有稳定数据源（trends2），且收盘后仍可取到
-- 最后交易日整日分时。独立成表，用于「点开某只 ETF 后回看最后交易日分时与量能」。

CREATE TABLE IF NOT EXISTS intraday_bar (
  code       TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  minute     TEXT NOT NULL,   -- 北京时间 HH:MM，含 09:30 与 15:00
  ts         INTEGER NOT NULL, -- 该分钟对应的毫秒时间戳
  open       REAL,
  close      REAL,
  high       REAL,
  low        REAL,
  avg_price  REAL,            -- 当日累计均价（VWAP）
  volume     REAL NOT NULL DEFAULT 0,  -- 单位：手（1 手 = 100 份）
  amount     REAL NOT NULL DEFAULT 0,  -- 单位：元
  source     TEXT NOT NULL DEFAULT 'eastmoney',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (code, trade_date, minute)
);

CREATE INDEX IF NOT EXISTS ix_intraday_code_date ON intraday_bar (code, trade_date, minute);
CREATE INDEX IF NOT EXISTS ix_intraday_date ON intraday_bar (trade_date);
