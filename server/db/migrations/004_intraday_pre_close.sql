-- 004_intraday_pre_close.sql：分时数据补「昨收价」
-- 用途：分时图需要昨收作为涨跌幅基准与红绿判断依据。若只回填了单个交易日，
-- 无法从相邻日推导昨收，因此随分钟数据一并落库，保证单日数据也能正确渲染。

ALTER TABLE intraday_bar ADD COLUMN pre_close REAL;
