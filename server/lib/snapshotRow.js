import { tradeDateOf } from './time.js';

/**
 * 快照行的时间戳：行情自带的时间优先，但超过 4 天就说明是上游给的脏数据
 * （停牌复牌、缓存回放），退回采集时刻。
 */
export function snapshotTsOf(quote, now = Date.now()) {
  if (quote?.quoteTs && Math.abs(now - quote.quoteTs) < 4 * 86400 * 1000) return quote.quoteTs;
  return now;
}

/**
 * 把采集到的行情转成 flow_snapshot 的一行。
 *
 * 单独抽出来是因为这里曾经漏过 `activeNet`：repo 的 INSERT 早就有这一列，
 * 但调用方构造行时没给，结果腾讯源（只有主动净买）的净额一条都没落库——
 * 盘中累计曲线只剩东财偶尔成功的那几个点，看起来就是大片空白。
 * 具体字段的完整性交给单测兜住，不要靠「记得改」。
 */
export function buildSnapshotRows(quotes, source, { now = Date.now() } = {}) {
  return (Array.isArray(quotes) ? quotes : []).map((quote) => {
    const ts = snapshotTsOf(quote, now);
    return {
      code: quote.code,
      ts,
      tradeDate: tradeDateOf(ts),
      // 两个口径各存各的：东财只给主力净额、腾讯只给主动净买，缺的那列留 null
      mainNet: quote.mainNet ?? null,
      activeNet: quote.activeNet ?? null,
      superNet: quote.superNet ?? null,
      bigNet: quote.bigNet ?? null,
      midNet: quote.midNet ?? null,
      smallNet: quote.smallNet ?? null,
      mainRatio: quote.mainRatio ?? null,
      price: quote.price ?? null,
      pctChg: quote.pctChg ?? null,
      turnover: quote.turnover ?? null,
      source,
    };
  });
}
