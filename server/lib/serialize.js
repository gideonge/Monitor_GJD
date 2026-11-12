import { formatDateTime } from './format.js';

/** 数据库行 → API 响应（统一 camelCase，前端无需感知 schema） */
export function mapAlertRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    code: row.code,
    etfName: row.etf_name,
    category: row.category,
    metric: row.metric,
    timeframe: row.timeframe,
    comparator: row.comparator,
    threshold: row.threshold,
    value: row.value,
    delta: row.delta,
    baseline: row.baseline,
    windowSec: row.window_sec,
    severity: row.severity,
    conditionText: row.condition_text,
    message: row.message,
    source: row.source,
    tradeDate: row.trade_date,
    /**
     * 量能类告警的方向证据：该分钟涨跌幅（%）与主动净买额（元）。
     * 资金类指标为空，方向看 value 正负。前端据此决定告警卡底色与色条，
     * SSE 事件与列表读库必须给出同一套字段。
     */
    priceMovePct: row.price_move_pct ?? null,
    netFlow: row.net_flow ?? null,
    triggeredAt: row.triggered_at,
    triggeredAtText: formatDateTime(row.triggered_at),
    acknowledged: Boolean(row.acknowledged),
    acknowledgedAt: row.acknowledged_at,
  };
}

export function mapRuleRow(row) {
  if (!row) return null;
  let scopeValue = null;
  if (row.scope_value) {
    try {
      scopeValue = JSON.parse(row.scope_value);
    } catch {
      scopeValue = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    metric: row.metric,
    timeframe: row.timeframe,
    comparator: row.comparator,
    threshold: row.threshold,
    windowSec: row.window_sec,
    scope: row.scope,
    scopeValue,
    severity: row.severity,
    cooldownSec: row.cooldown_sec,
    enabled: Boolean(row.enabled),
    isSystem: Boolean(row.is_system),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
