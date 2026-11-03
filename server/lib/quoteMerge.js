/**
 * 快照合并：把新到的一条快照叠到上一条已知值上。
 *
 * 为什么不能直接覆盖：行情来自两个源，字段互不重叠——东财有主力净额（mainNet）、
 * 没有主动净买（activeNet）；腾讯反过来。谁后到谁把对方冲成 null，标的就会从
 * 排行里凭空消失，或者上一时刻还好的数被抹成空白。
 *
 * 三条规则：
 *   1. null / undefined 一律不覆盖（缺测就是缺测，沿用上一时刻）
 *   2. 成交额 0 视为「没给」，不覆盖（0 元成交在盘中几乎不存在）
 *   3. 两个口径各带自己的时间戳，因为它们的更新频率来自不同源
 */

/** 这个值算不算「有数据」 */
export function hasValue(key, value) {
  if (value === null || value === undefined) return false;
  if (key === 'turnover') return Number(value) > 0;
  return true;
}

export function mergeQuoteFields(previous, incoming) {
  if (!incoming?.code) return previous ?? null;
  const next = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (!hasValue(key, value)) continue;
    next[key] = value;
  }
  next.code = incoming.code;
  next.mainTs = hasValue('mainNet', incoming.mainNet)
    ? incoming.mainTs ?? incoming.quoteTs ?? Date.now()
    : previous?.mainTs ?? null;
  next.activeTs = hasValue('activeNet', incoming.activeNet)
    ? incoming.activeTs ?? incoming.quoteTs ?? Date.now()
    : previous?.activeTs ?? null;
  return next;
}

/**
 * 清单行叠加：清单只负责「有哪些标的、叫什么、属于哪类」。
 * 它不提供净额，因此绝不能用来替换已有快照——否则每次清单刷新
 * （默认 10 分钟）都会把所有净额清空一次。
 */
export function overlayUniverseRow(previous, row) {
  const next = { ...(previous ?? {}), ...row };
  if (!hasValue('mainNet', row.mainNet)) next.mainNet = previous?.mainNet ?? null;
  if (!hasValue('activeNet', row.activeNet)) next.activeNet = previous?.activeNet ?? null;
  next.mainTs = previous?.mainTs ?? row.mainTs ?? null;
  next.activeTs = previous?.activeTs ?? row.activeTs ?? null;
  return next;
}
