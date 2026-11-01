-- 秒级行情快照：只对「国家队常买」核心池采集，1 秒粒度。
-- 与分钟级 intraday_bar / flow_snapshot 分开存放，避免高频数据抬高常规查询的扫描成本。
CREATE TABLE IF NOT EXISTS fast_tick (
  code TEXT NOT NULL,
  ts INTEGER NOT NULL,
  trade_date TEXT NOT NULL,
  price REAL,
  pct_chg REAL,
  -- 累计成交量（手）、累计成交额（元）
  volume INTEGER,
  amount REAL,
  -- 累计外盘/内盘（手）：主动买、主动卖的近似口径
  outer_vol INTEGER,
  inner_vol INTEGER,
  -- 本秒增量：成交额、主动净买入额（元，负数为主动净卖出）
  amt_delta REAL,
  net_delta REAL,
  -- 一档盘口
  bid1 REAL,
  ask1 REAL,
  bid1_vol INTEGER,
  ask1_vol INTEGER,
  imba REAL,
  source TEXT NOT NULL DEFAULT 'tencent',
  PRIMARY KEY (code, ts)
);

CREATE INDEX IF NOT EXISTS idx_fast_tick_code_date ON fast_tick(code, trade_date);
CREATE INDEX IF NOT EXISTS idx_fast_tick_date ON fast_tick(trade_date);
