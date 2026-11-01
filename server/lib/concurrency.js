/** 并发受限的批量执行，避免瞬间打满上游或数据库连接 */
export async function mapPool(items, limit, worker) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;

  const run = async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(list[index], index);
    }
  };

  const size = Math.max(1, Math.min(limit, list.length));
  await Promise.all(Array.from({ length: size }, run));
  return results;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
