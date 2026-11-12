-- 告警的「方向证据」：该分钟的价格涨跌幅（%）。
--
-- 量能类指标（volume_surge / volume_preburst）的实测值是成交量倍数，
-- 正负号不表示资金进出，光看 value 无法判断这一波是放量拉升还是放量砸盘。
-- 前端要用底色/色条区分「向上 / 向下」，就必须把当时的价格变动一并落库，
-- 否则同一条告警从 SSE 推过来（事件对象里有 tickRet）和从库里读出来
-- （只有 value）会呈现成两种颜色，历史列表也会丢方向。
--
-- 资金类指标这一列留空：它们的方向直接由 value 的正负给出。
ALTER TABLE alert ADD COLUMN price_move_pct REAL;
