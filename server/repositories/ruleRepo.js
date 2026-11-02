export const METRICS = {
  main_net: { label: '主力净流入额', unit: '元', timeframes: ['intraday', 'daily'] },
  main_net_delta: { label: '净流入变动额', unit: '元', timeframes: ['window'] },
  main_net_rate: { label: '净流入速率', unit: '元/分钟', timeframes: ['window'] },
  main_net_ratio: { label: '主力净占比', unit: '%', timeframes: ['intraday'] },
  super_net: { label: '超大单净流入额', unit: '元', timeframes: ['intraday', 'daily'] },
  main_net_vs_avg: { label: '较近5日均值差额', unit: '元', timeframes: ['daily'] },
  /**
   * 分钟成交量相对「同标的、同交易时段近 20 分钟中位量」的倍数。
   * 只在盘中分钟序列上有定义，因此时间框架固定为 intraday。
   * 检测逻辑在 services/volumeSurgeService.js，回测结论见 reports/volume-surge-backtest.md。
   */
  volume_surge: { label: '分钟成交量突变', unit: '倍', timeframes: ['intraday'] },
  /**
   * 分钟进行中的成交量折算倍数。
   * 与 volume_surge 同口径但不同时点：K 线还没收盘就给出折算结论，
   * 用于抢在价格走完之前看到「第一手爆量」。检测逻辑在 services/intraMinuteSurge.js。
   */
  volume_preburst: { label: '分钟内实时爆量', unit: '倍', timeframes: ['intraday'] },
  /**
   * 单波秒级攻势的累计主动净买入额（元）。
   * 只对核心池（秒级通道）有定义，因此时间框架同样是 intraday。
   * 检测逻辑在 services/tickImpulse.js，设计取舍见 reports/tick-impulse-design.md。
   */
  tick_impulse: { label: '秒级主动净买入', unit: '元', timeframes: ['intraday'] },
};

export const TIMEFRAMES = ['window', 'intraday', 'daily'];
export const COMPARATORS = ['gt', 'lt'];
export const SEVERITIES = ['high', 'medium', 'low'];
export const SCOPES = ['all', 'category', 'codes'];

export const SEVERITY_LABEL = { high: '高', medium: '中', low: '低' };
export const COMPARATOR_LABEL = { gt: '大于', lt: '小于' };
export const TIMEFRAME_LABEL = { window: '窗口期', intraday: '当日盘中', daily: '日度对比' };

export const DEFAULT_RULES = [
  {
    name: '5分钟主力急速流入',
    metric: 'main_net_delta',
    timeframe: 'window',
    comparator: 'gt',
    threshold: 30_000_000,
    windowSec: 300,
    severity: 'high',
    scope: 'all',
    cooldownSec: 900,
  },
  {
    name: '5分钟主力急速流出',
    metric: 'main_net_delta',
    timeframe: 'window',
    comparator: 'lt',
    threshold: -30_000_000,
    windowSec: 300,
    severity: 'high',
    scope: 'all',
    cooldownSec: 900,
  },
  {
    name: '当日主力净流入超 2 亿',
    metric: 'main_net',
    timeframe: 'intraday',
    comparator: 'gt',
    threshold: 200_000_000,
    windowSec: 300,
    severity: 'medium',
    scope: 'all',
    cooldownSec: 3600,
  },
  {
    name: '当日主力净流出超 2 亿',
    metric: 'main_net',
    timeframe: 'intraday',
    comparator: 'lt',
    threshold: -200_000_000,
    windowSec: 300,
    severity: 'medium',
    scope: 'all',
    cooldownSec: 3600,
  },
  {
    name: '主力净占比大幅异动',
    metric: 'main_net_ratio',
    timeframe: 'intraday',
    comparator: 'gt',
    threshold: 15,
    windowSec: 300,
    severity: 'low',
    scope: 'all',
    cooldownSec: 3600,
  },
  {
    name: '日度资金流入显著放大',
    metric: 'main_net_vs_avg',
    timeframe: 'daily',
    comparator: 'gt',
    threshold: 300_000_000,
    windowSec: 300,
    severity: 'medium',
    scope: 'all',
    cooldownSec: 86400,
  },
  {
    name: '日度资金流出显著放大',
    metric: 'main_net_vs_avg',
    timeframe: 'daily',
    comparator: 'lt',
    threshold: -300_000_000,
    windowSec: 300,
    severity: 'medium',
    scope: 'all',
    cooldownSec: 86400,
  },
  {
    // 阈值 3× 来自回测：叠加区间突破确认后，方向命中 70.2%、事件密度约每标的每日 2.9 条
    name: '分钟量能突变（带突破确认）',
    metric: 'volume_surge',
    timeframe: 'intraday',
    comparator: 'gt',
    threshold: 3,
    windowSec: 300,
    severity: 'high',
    scope: 'all',
    cooldownSec: 300,
  },
  {
    // 门槛 2.5× 比分钟级的 3× 低一档：这是预警不是定稿，分钟收盘后 volumeSurge 会再判一次。
    // 冷却 180 秒对齐「一波行情」的典型长度（回放实测：120→309 条/日，180→252，240→217）。
    name: '分钟内实时爆量',
    metric: 'volume_preburst',
    timeframe: 'intraday',
    comparator: 'gt',
    threshold: 2.5,
    windowSec: 1200,
    severity: 'high',
    scope: 'all',
    cooldownSec: 180,
  },
  {
    // 门槛是「一波攻势的累计主动净买入」，不是单桶峰值：单桶 800 万连续 4 桶的扫单，
    // 累计 3200 万，和单桶 3200 万的调仓是两件完全不同的事，用户关心的是前者。
    name: '秒级主动买入攻势',
    metric: 'tick_impulse',
    timeframe: 'intraday',
    comparator: 'gt',
    threshold: 30_000_000,
    windowSec: 300,
    severity: 'high',
    scope: 'all',
    cooldownSec: 240,
  },
  {
    name: '秒级主动卖出攻势',
    metric: 'tick_impulse',
    timeframe: 'intraday',
    comparator: 'lt',
    threshold: -30_000_000,
    windowSec: 300,
    severity: 'high',
    scope: 'all',
    cooldownSec: 240,
  },
];

/**
 * 系统默认规则的版本号。
 *
 * 老库里已经写死了 7 条默认规则，直接改 DEFAULT_RULES 不会生效；
 * 而「表里没有规则才写入」的守卫又会让新增的系统规则永远进不去。
 * 这里用 app_state 记一个版本号做一次性增量播种，既不覆盖用户调参，
 * 也不会在用户删掉某条系统规则后每次重启又加回来。
 */
const SYSTEM_RULES_VERSION = 4;

export function createRuleRepo(db) {
  const insert = db.prepare(`
    INSERT INTO alert_rule
      (name, metric, timeframe, comparator, threshold, window_sec, scope, scope_value,
       severity, cooldown_sec, enabled, is_system, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    list({ enabledOnly = false } = {}) {
      const where = enabledOnly ? 'WHERE enabled = 1' : '';
      return db.prepare(`SELECT * FROM alert_rule ${where} ORDER BY is_system DESC, id ASC`).all();
    },

    get(id) {
      return db.prepare('SELECT * FROM alert_rule WHERE id = ?').get(id) ?? null;
    },

    countEnabled() {
      return db.prepare('SELECT COUNT(*) AS c FROM alert_rule WHERE enabled = 1').get().c;
    },

    create(data, now = Date.now()) {
      const result = insert.run(
        data.name,
        data.metric,
        data.timeframe,
        data.comparator,
        data.threshold,
        data.windowSec ?? 300,
        data.scope ?? 'all',
        data.scopeValue ? JSON.stringify(data.scopeValue) : null,
        data.severity ?? 'medium',
        data.cooldownSec ?? 1800,
        data.enabled === false ? 0 : 1,
        data.isSystem ? 1 : 0,
        now,
        now,
      );
      return Number(result.lastInsertRowid);
    },

    update(id, patch, now = Date.now()) {
      const fields = [];
      const params = [];
      const map = {
        name: 'name',
        metric: 'metric',
        timeframe: 'timeframe',
        comparator: 'comparator',
        threshold: 'threshold',
        windowSec: 'window_sec',
        scope: 'scope',
        severity: 'severity',
        cooldownSec: 'cooldown_sec',
      };
      for (const [key, column] of Object.entries(map)) {
        if (patch[key] !== undefined) {
          fields.push(`${column} = ?`);
          params.push(patch[key]);
        }
      }
      if (patch.scopeValue !== undefined) {
        fields.push('scope_value = ?');
        params.push(patch.scopeValue === null ? null : JSON.stringify(patch.scopeValue));
      }
      if (patch.enabled !== undefined) {
        fields.push('enabled = ?');
        params.push(patch.enabled ? 1 : 0);
      }
      if (fields.length === 0) return false;
      fields.push('updated_at = ?');
      params.push(now, id);
      const result = db.prepare(`UPDATE alert_rule SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      return Number(result.changes ?? 0) > 0;
    },

    remove(id) {
      const result = db.prepare('DELETE FROM alert_rule WHERE id = ?').run(id);
      return Number(result.changes ?? 0) > 0;
    },

    /** 写入缺少的系统默认规则；已存在（同名）则跳过，避免覆盖用户调参 */
    seedDefaults(now = Date.now()) {
      const versionRow = db.prepare("SELECT value FROM app_state WHERE key = 'systemRulesVersion'").get();
      const appliedVersion = versionRow ? Number(versionRow.value) : 0;
      if (Number.isFinite(appliedVersion) && appliedVersion >= SYSTEM_RULES_VERSION) return 0;

      const existing = new Set(db.prepare('SELECT name FROM alert_rule').all().map((row) => row.name));
      let inserted = 0;
      for (const rule of DEFAULT_RULES) {
        if (existing.has(rule.name)) continue;
        insert.run(
          rule.name,
          rule.metric,
          rule.timeframe,
          rule.comparator,
          rule.threshold,
          rule.windowSec,
          rule.scope,
          null,
          rule.severity,
          rule.cooldownSec,
          1,
          1,
          now,
          now,
        );
        inserted += 1;
      }

      db.prepare(
        `INSERT INTO app_state (key, value, updated_at) VALUES ('systemRulesVersion', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(String(SYSTEM_RULES_VERSION), now);

      return inserted;
    },
  };
}
