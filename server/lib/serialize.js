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
