/**
 * 监控池选标的的规则（纯函数，便于单测）。
 *
 * 池子 = 手工置顶 + 按成交额从高到低递补，直到 universeSize。
 * 债券/货币类 ETF 默认不参与递补：它们的成交额主要来自申赎套利与质押回购，
 * 净买额动辄几十亿却几乎不影响价格，与股票型 ETF 的资金流不同源。
 * 混在一张榜里，长期结果是「净流入第 1」被短融、国债 ETF 占住。
 *
 * 手工置顶的标的始终保留——显式操作优先于默认规则，否则用户钉了也白钉。
 */
export function pickTrackedCodes(rows, { pinned = [], size = 120, excludeCategories = [] } = {}) {
  const excluded = new Set(excludeCategories);
  const eligible = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.code && !excluded.has(row.category))
    .map((row) => row.code);

  const limit = Math.max(size, pinned.length);
  return [...new Set([...pinned, ...eligible])].slice(0, limit);
}

/** 该分类是否允许进入监控池（供日志 / 前端提示复用同一份判断） */
export function isTrackableCategory(category, excludeCategories = []) {
  return !excludeCategories.includes(category);
}
