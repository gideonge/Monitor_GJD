import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 极简 .env 加载器：不覆盖已存在的环境变量，不引入第三方依赖。
 * 仅支持 KEY=VALUE 与 # 注释。
 */
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT_DIR, '.env'));

const problems = [];

function readString(name, fallback, { required = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (required) problems.push(`${name} 为必填项`);
    return fallback;
  }
  return raw;
}

function readInt(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    problems.push(`${name} 必须是整数，当前值 "${raw}"`);
    return fallback;
  }
  if (value < min || value > max) {
    problems.push(`${name} 必须介于 ${min} 与 ${max} 之间，当前值 ${value}`);
    return fallback;
  }
  return value;
}

function readFloat(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    problems.push(`${name} 必须是数字，当前值 "${raw}"`);
    return fallback;
  }
  if (value < min || value > max) {
    problems.push(`${name} 必须介于 ${min} 与 ${max} 之间，当前值 ${value}`);
    return fallback;
  }
  return value;
}

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  problems.push(`${name} 必须是布尔值（true/false），当前值 "${raw}"`);
  return fallback;
}

function readList(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(ROOT_DIR, value);
}

const nodeEnv = readString('NODE_ENV', 'development');

/**
 * 秒级通道的默认标的池：国家队（中央汇金 / 国新 / 诚通）入场基本走宽基 ETF，
 * 集中在这几只沪深300 / 上证50 / 中证500 / 中证1000 / 科创50 / 创业板 / 中证A500 上。
 * 这是经验清单，不是官方披露名单；可用 FAST_TICK_CODES 覆盖。
 */
const DEFAULT_FAST_CODES = [
  '510300', // 沪深300ETF 华泰柏瑞
  '510310', // 沪深300ETF 易方达
  '510330', // 沪深300ETF 华夏
  '159919', // 沪深300ETF 嘉实
  '510050', // 上证50ETF 华夏
  '510500', // 中证500ETF 南方
  '159922', // 中证500ETF 嘉实
  '512500', // 中证500ETF 华夏
  '512100', // 中证1000ETF 南方
  '159845', // 中证1000ETF 华夏
  '588000', // 科创50ETF 华夏
  '588080', // 科创50ETF 易方达
  '159915', // 创业板ETF 易方达
  '512050', // A500ETF 华夏
  '159338', // 中证A500ETF 国泰
];

/**
 * 核心池标的所属的宽基族。
 *
 * 用途：跨标的共振判定。同一分钟里沪深300、中证500、科创50 三族同时出现主动净买，
 * 才是一揽子买入（国家队托底的典型形态）；只在一族内同向，更可能是套利资金在 ETF 间平移。
 */
export const FAST_FAMILY_OF = {
  510300: '沪深300',
  510310: '沪深300',
  510330: '沪深300',
  159919: '沪深300',
  510050: '上证50',
  510500: '中证500',
  159922: '中证500',
  512500: '中证500',
  512100: '中证1000',
  159845: '中证1000',
  588000: '科创50',
  588080: '科创50',
  159915: '创业板',
  512050: '中证A500',
  159338: '中证A500',
};

const config = {
  rootDir: ROOT_DIR,
  nodeEnv,
  isProd: nodeEnv === 'production',
  host: readString('HOST', '127.0.0.1'),
  port: readInt('PORT', 8787, { min: 1, max: 65535 }),

  dataDir: resolvePath(readString('DATA_DIR', './data')),
  dbFile: resolvePath(readString('DB_FILE', './data/etf-monitor.db')),
  webDir: path.join(ROOT_DIR, 'web'),
  retentionDays: readInt('SNAPSHOT_RETENTION_DAYS', 7, { min: 0, max: 3650 }),

  /**
   * 常规标的的轮询粒度：分钟级。
   * 只有核心池（fastTick.codes）走秒级通道，其余标的不需要 1 秒级的量级。
   */
  pollIntervalMs: readInt('POLL_INTERVAL_MS', 60000, { min: 5000, max: 600000 }),
  universeSize: readInt('UNIVERSE_SIZE', 120, { min: 10, max: 1400 }),
  universeRefreshMs: readInt('UNIVERSE_REFRESH_MS', 600000, { min: 60000, max: 86400000 }),
  historyDays: readInt('HISTORY_DAYS', 60, { min: 5, max: 500 }),
  requestTimeoutMs: readInt('REQUEST_TIMEOUT_MS', 9000, { min: 1000, max: 60000 }),
  upstreamRetries: readInt('UPSTREAM_RETRIES', 2, { min: 0, max: 5 }),

  // 分时行情：上游一次最多回带 5 个交易日，缓存天数与批量回填规模都受此约束
  intradayDays: readInt('INTRADAY_DAYS', 5, { min: 1, max: 5 }),
  intradayBackfillLimit: readInt('INTRADAY_BACKFILL_LIMIT', 20, { min: 0, max: 500 }),

  alertCooldownSec: readInt('ALERT_COOLDOWN_SEC', 1800, { min: 0, max: 86400 }),
  alertMaxPerRulePerCycle: readInt('ALERT_MAX_PER_RULE_PER_CYCLE', 60, { min: 1, max: 5000 }),

  /**
   * 日内量能突变预警（VSD）。
   * 参数由 2026-10-30 单日横截面回测确定：必须叠加「价格突破确认」才有方向信息，
   * 详见 reports/volume-surge-backtest.md。
   */
  volumeSurge: Object.freeze({
    enabled: readBool('SURGE_ALERT_ENABLED', true),
    /** 盘中扫描间隔：每分钟一次，与分钟 K 线粒度对齐 */
    scanIntervalMs: readInt('SURGE_SCAN_INTERVAL_MS', 60000, { min: 15000, max: 600000 }),
    /** 每轮盘中刷新的标的数（轮转覆盖监控池），0 表示不主动刷新、只读已有缓存 */
    liveRefreshLimit: readInt('SURGE_LIVE_REFRESH_LIMIT', 40, { min: 0, max: 200 }),
    /** 区间突破确认：回测中该项把方向命中率从 55.8% 提升到 70.2% */
    requireRangeBreak: readBool('SURGE_REQUIRE_BREAK', true),
    /** 单分钟成交额下限（元），过滤「10 手变 200 手」这类无资金含义的地量噪声 */
    minAmount: readInt('SURGE_MIN_AMOUNT', 3_000_000, { min: 0, max: 1_000_000_000 }),
    /** 盘中实时入库的最低强度等级（1 弱 / 2 中 / 3 强）；弱信号只做图表标注 */
    minAlertLevel: readInt('SURGE_MIN_LEVEL', 2, { min: 1, max: 3 }),
    /** 事件被判定为「实时」的时间窗口（秒）：超出窗口的历史事件按回放处理 */
    liveWindowSec: readInt('SURGE_LIVE_WINDOW_SEC', 600, { min: 60, max: 3600 }),
    /** 回放（收盘后补录）入库的最低强度等级：只留强信号，避免历史回放淹没告警页 */
    backfillMinLevel: 3,
  }),

  /**
   * 秒级通道：仅核心池（国家队常买宽基）。
   * 秒级请求只打腾讯批量快照（一次 15 个标的约 2 KB），十年不变的东财 ulist 留给分钟级，
   * 避免两类流量互相挤占同一条限流配额。
   */
  fastTick: Object.freeze({
    enabled: readBool('FAST_TICK_ENABLED', true),
    /** 轮询间隔：秒级。低于 500ms 对免费接口不礼貌，也拿不到更多真实成交 */
    intervalMs: readInt('FAST_INTERVAL_MS', 1000, { min: 500, max: 10000 }),
    /** 核心池代码，逗号分隔；不在 ETF 清单里的代码会被自动忽略 */
    codes: readList('FAST_TICK_CODES', DEFAULT_FAST_CODES),
    /** 内存环形缓冲保留时长（秒），供前端「最近 N 分钟」秒级视图直接读取 */
    memorySec: readInt('FAST_MEMORY_SEC', 1800, { min: 60, max: 7200 }),
    /** 落库批量间隔（毫秒）：秒级数据先攒在内存，按批写库，减少事务次数 */
    flushMs: readInt('FAST_FLUSH_MS', 5000, { min: 1000, max: 60000 }),
    /** 秒级数据保留天数：15 只 × 4 小时 ≈ 21 万行/天，默认只留 2 天 */
    retentionDays: readInt('FAST_RETENTION_DAYS', 2, { min: 0, max: 30 }),
    /** 单次请求超时：秒级通道不能等 9 秒，否则一轮压一轮 */
    requestTimeoutMs: readInt('FAST_TIMEOUT_MS', 3000, { min: 800, max: 10000 }),
  }),

  /**
   * 秒级主动买卖攻势（TFI）：只跑核心池。
   *
   * 门槛标定思路见 reports/tick-impulse-design.md：
   * 秒级成交是稀疏事件流，单秒量能倍数没有统计意义，所以判定单位是 15 秒桶的累计净额；
   * 相对门槛（净额 / 基线桶成交额）+ 绝对门槛（元）双卡，防止地量标的刷倍数。
   */
  tickImpulse: Object.freeze({
    enabled: readBool('TICK_IMPULSE_ENABLED', true),
    /** 扫描间隔：5 秒，比采集间隔（1 秒）粗一档，避免同一批桶被反复判定 */
    scanIntervalMs: readInt('TICK_IMPULSE_SCAN_MS', 5000, { min: 1000, max: 60000 }),
    /** 单次判定读取的秒级窗口（秒）：基线 5 分钟 + 合并间隔 + 余量 */
    windowSec: readInt('TICK_IMPULSE_WINDOW_SEC', 900, { min: 300, max: 3600 }),
    /** 判定桶宽（秒） */
    bucketSec: readInt('TICK_IMPULSE_BUCKET_SEC', 15, { min: 5, max: 60 }),
    /** 基线桶数（向前，不跨午休） */
    baselineBuckets: readInt('TICK_IMPULSE_BASELINE_BUCKETS', 20, { min: 6, max: 60 }),
    /** 基线最少桶数，不足则不判定 */
    minBaselineBuckets: readInt('TICK_IMPULSE_MIN_BASELINE', 6, { min: 3, max: 30 }),
    /** 桶内最少有效秒数 */
    minSamplesPerBucket: readInt('TICK_IMPULSE_MIN_SAMPLES', 3, { min: 1, max: 15 }),
    /** 相对门槛：桶净买入额 / 基线桶成交额中位数 */
    netRatioThreshold: readFloat('TICK_IMPULSE_NET_RATIO', 0.6, { min: 0.1, max: 10 }),
    /** 绝对门槛（元/桶）：低于此值的桶一律不产生事件 */
    minNetAmount: readInt('TICK_IMPULSE_MIN_NET', 500_000, { min: 0, max: 500_000_000 }),
    /** 净额 / 桶成交额下限：单边主动成交才成立 */
    minBuyShare: readFloat('TICK_IMPULSE_BUY_SHARE', 0.2, { min: 0.01, max: 1 }),
    /** 稳健 z 下限 */
    zThreshold: readFloat('TICK_IMPULSE_Z', 4, { min: 1, max: 20 }),
    /** 连续确认桶数（含当前桶） */
    confirmBuckets: readInt('TICK_IMPULSE_CONFIRM_BUCKETS', 3, { min: 1, max: 10 }),
    /** 同一波攻势的事件合并间隔（秒） */
    mergeGapSec: readInt('TICK_IMPULSE_MERGE_GAP_SEC', 90, { min: 15, max: 600 }),
    /** 是否检测主动卖出攻势 */
    detectDrain: readBool('TICK_IMPULSE_DETECT_DRAIN', true),
    /** 桶内价格位移达到此值（%）时强度加一级 */
    levelPriceMovePct: readFloat('TICK_IMPULSE_PRICE_MOVE_PCT', 0.12, { min: 0, max: 5 }),
    /** 实时入库的最低等级 */
    minAlertLevel: readInt('TICK_IMPULSE_MIN_LEVEL', 2, { min: 1, max: 3 }),
    /** 非实时（补录）入库的最低等级 */
    backfillMinLevel: 3,
    /** 事件被判定为「实时」的时间窗口（秒） */
    liveWindowSec: readInt('TICK_IMPULSE_LIVE_WINDOW_SEC', 300, { min: 30, max: 900 }),
    /** 跨标的共振的统计窗口（秒） */
    resonanceWindowSec: readInt('TICK_IMPULSE_RESONANCE_WINDOW_SEC', 120, { min: 30, max: 600 }),
    /** 共振至少涉及的宽基族数 */
    resonanceMinFamilies: readInt('TICK_IMPULSE_RESONANCE_MIN_FAMILIES', 2, { min: 1, max: 6 }),
  }),

  corsOrigins: readList('CORS_ORIGINS', [
    'http://127.0.0.1:8787',
    'http://localhost:8787',
  ]),
  logLevel: readString('LOG_LEVEL', 'info'),

  upstream: Object.freeze({
    quoteBase: 'https://push2.eastmoney.com',
    historyBase: 'https://push2his.eastmoney.com',
    board: 'b:MK0021',
    utQuote: 'fa5fd1943c7b386f172d6893dbfba10b',
    utFlow: 'b2884a393a59ad64002292a3e90d46a5',
    pageSize: 100,
    batchSize: 40,
  }),
};

if (problems.length > 0) {
  throw new Error(`配置校验失败：\n- ${problems.join('\n- ')}`);
}

export { config, DEFAULT_FAST_CODES };
export default config;
