-- 005_intraday_day_range.sql：分时数据补「当日最高/最低价」
-- 与 pre_close 同理：分钟级高低只覆盖「该分钟收盘价」的近似，
-- 备用数据源（腾讯）无法给出分钟内极值，改用其提供的真实日高日低并随分时一并落库。

ALTER TABLE intraday_bar ADD COLUMN day_high REAL;
ALTER TABLE intraday_bar ADD COLUMN day_low REAL;
