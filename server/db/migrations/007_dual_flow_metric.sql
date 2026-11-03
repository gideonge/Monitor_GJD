-- 007_dual_flow_metric.sql：把「主力净额」与「主动净买」拆成两套互不覆盖的口径。
--
-- 背景：东财 push2 对机房 IP 间歇拒绝，降级到腾讯时，(外盘−内盘)×100×现价 被写进了
-- 同一个 main_net 字段。这两者量的不是一件事——东财按单笔金额分档（超大单+大单的净额，
-- 四档相加恒为 0），腾讯是全部主动买−全部主动卖。实测 259 只标的，两者方向一致率仅 49%，
-- 混写的结果是同一只基金在相邻两轮之间从 −1.14 亿跳到 +68.96 亿，排行整体重排。
--
-- 本次改动：
--   1. flow_snapshot.main_net 允许为 NULL（缺测就是缺测，不再拿另一种口径顶替，也不写 0）
--   2. 新增 active_net 列，腾讯源只写这一列
--   3. 历史行按 source 就地纠正：source='live-tencent' 的行原本存的是主动净买，
--      搬到 active_net，main_net 置空，避免把污染的历史序列继续当成主力净额用
--   4. etf 缓存表同步增加 active_net，并给两个口径各自记录时间戳

CREATE TABLE flow_snapshot_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  trade_date TEXT NOT NULL,
  main_net   REAL,
  active_net REAL,
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

INSERT INTO flow_snapshot_new
  (id, code, ts, trade_date, main_net, active_net, super_net, big_net, mid_net, small_net, main_ratio, price, pct_chg, turnover, source)
SELECT
  id, code, ts, trade_date,
  CASE WHEN source = 'live-tencent' THEN NULL ELSE main_net END,
  CASE WHEN source = 'live-tencent' THEN main_net ELSE NULL END,
  super_net, big_net, mid_net, small_net,
  CASE WHEN source = 'live-tencent' THEN NULL ELSE main_ratio END,
  price, pct_chg, turnover, source
FROM flow_snapshot;

DROP TABLE flow_snapshot;
ALTER TABLE flow_snapshot_new RENAME TO flow_snapshot;

CREATE UNIQUE INDEX IF NOT EXISTS ux_snapshot_code_ts ON flow_snapshot (code, ts);
CREATE INDEX IF NOT EXISTS ix_snapshot_code_ts ON flow_snapshot (code, ts DESC);
CREATE INDEX IF NOT EXISTS ix_snapshot_ts ON flow_snapshot (ts);
CREATE INDEX IF NOT EXISTS ix_snapshot_code_date ON flow_snapshot (code, trade_date);

ALTER TABLE etf ADD COLUMN active_net REAL;
ALTER TABLE etf ADD COLUMN main_ts INTEGER;
ALTER TABLE etf ADD COLUMN active_ts INTEGER;
CREATE INDEX IF NOT EXISTS ix_etf_active_net ON etf (active_net DESC);

-- 缓存列里的 main_net 同样是混写出来的，无法按行区分来源，一律清空，
-- 由启动时的 hydrate() 从已纠正的 flow_snapshot 重新灌入。
UPDATE etf SET main_net = NULL, main_ratio = NULL, super_net = NULL, main_ts = NULL;
