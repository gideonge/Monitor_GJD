-- 002_quote_cache.sql：在 ETF 表冗余"最近已知资金流快照"
-- 目的：上游数据源抖动或被限流时，平台仍可基于最后一次成功采集的数据服务，
-- 避免整站空白；同时减少页面加载时的跨表关联。

ALTER TABLE etf ADD COLUMN main_net REAL;
ALTER TABLE etf ADD COLUMN main_ratio REAL;
ALTER TABLE etf ADD COLUMN super_net REAL;
ALTER TABLE etf ADD COLUMN quote_ts INTEGER;

CREATE INDEX IF NOT EXISTS ix_etf_main_net ON etf (main_net DESC);
