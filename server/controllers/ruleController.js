import { sendJson, readJsonBody } from '../lib/http.js';
import { mapRuleRow } from '../lib/serialize.js';
import { notFound, ValidationError } from '../lib/errors.js';
import { requireInt, requireString, requireNumber, requireEnum } from '../lib/validate.js';
import { METRICS, SEVERITIES, COMPARATORS, SCOPES, TIMEFRAMES } from '../repositories/ruleRepo.js';
import { CATEGORIES, visibleCategories } from '../lib/classify.js';
import config from '../config/index.js';

/** 规则入参校验：所有字段在边界处收敛，服务层不再做防御性判断 */
function validateRuleInput(body, { partial = false } = {}) {
  const out = {};

  if (!partial || body.name !== undefined) {
    out.name = requireString(body.name, 'name', { min: 2, max: 40 });
  }
  if (!partial || body.metric !== undefined) {
    out.metric = requireEnum(body.metric, 'metric', Object.keys(METRICS));
  }
  if (!partial || body.timeframe !== undefined) {
    const allowed = out.metric ? METRICS[out.metric].timeframes : TIMEFRAMES;
    out.timeframe = requireEnum(body.timeframe, 'timeframe', allowed);
  }
  if (!partial || body.comparator !== undefined) {
    out.comparator = requireEnum(body.comparator, 'comparator', COMPARATORS);
  }
  if (!partial || body.threshold !== undefined) {
    out.threshold = requireNumber(body.threshold, 'threshold', { min: -1e13, max: 1e13 });
  }
  if (body.windowSec !== undefined) {
    out.windowSec = requireInt(body.windowSec, 'windowSec', { min: 30, max: 3600 });
  } else if (!partial) {
    out.windowSec = 300;
  }
  if (body.scope !== undefined || !partial) {
    out.scope = requireEnum(body.scope ?? 'all', 'scope', SCOPES);
  }
  if (body.severity !== undefined || !partial) {
    out.severity = requireEnum(body.severity ?? 'medium', 'severity', SEVERITIES);
  }
  if (body.cooldownSec !== undefined) {
    out.cooldownSec = requireInt(body.cooldownSec, 'cooldownSec', { min: 0, max: 86400 });
  } else if (!partial) {
    out.cooldownSec = 1800;
  }
  if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);

  if (out.scope === 'category') {
    const list = body.scopeValue;
    if (!Array.isArray(list) || list.length === 0) {
      throw new ValidationError('适用范围为分类时，scopeValue 必须是非空分类数组', { field: 'scopeValue' });
    }
    out.scopeValue = list.map((item, index) => requireEnum(item, `scopeValue[${index}]`, CATEGORIES));
  } else if (out.scope === 'codes') {
    const list = body.scopeValue;
    if (!Array.isArray(list) || list.length === 0) {
      throw new ValidationError('适用范围为指定代码时，scopeValue 必须是非空代码数组', { field: 'scopeValue' });
    }
    out.scopeValue = list.map((item, index) => {
      const code = requireString(item, `scopeValue[${index}]`, { max: 12 });
      if (!/^\d{6}$/.test(code)) throw new ValidationError(`scopeValue[${index}] 必须是 6 位数字代码`);
      return code;
    });
  } else if (body.scopeValue !== undefined) {
    out.scopeValue = null;
  }

  // timeframe 与 metric 的兼容性在值都确定后再校验一次，避免 partial 更新时漏检
  if (out.metric && out.timeframe) {
    const allowed = METRICS[out.metric].timeframes;
    if (!allowed.includes(out.timeframe)) {
      throw new ValidationError(
        `指标「${METRICS[out.metric].label}」仅支持时间框架：${allowed.join(' / ')}`,
        { field: 'timeframe' },
      );
    }
  }

  return out;
}

export function createRuleController({ services }) {
  const { repos } = services;

  return {
    list(ctx) {
      const rows = repos.ruleRepo.list({});
      sendJson(ctx.res, 200, {
        rows: rows.map(mapRuleRow),
        metrics: METRICS,
        // 校验仍用 CATEGORIES（存量规则可能引用已屏蔽分类），但下拉只给可见的
        categories: visibleCategories(config.trackedExcludeCategories),
      });
    },

    create(ctx) {
      return readJsonBody(ctx.req).then((body) => {
        const input = validateRuleInput(body);
        const id = repos.ruleRepo.create({ ...input, isSystem: false });
        sendJson(ctx.res, 201, { rule: mapRuleRow(repos.ruleRepo.get(id)) });
      });
    },

    async update(ctx) {
      const id = requireInt(ctx.params.id, 'id', { min: 1 });
      const existing = repos.ruleRepo.get(id);
      if (!existing) throw notFound(`规则不存在：${id}`);
      const body = await readJsonBody(ctx.req);
      const patch = validateRuleInput(body, { partial: true });
      if (Object.keys(patch).length === 0) throw new ValidationError('没有可更新的字段');
      repos.ruleRepo.update(id, patch);
      sendJson(ctx.res, 200, { rule: mapRuleRow(repos.ruleRepo.get(id)) });
    },

    async remove(ctx) {
      const id = requireInt(ctx.params.id, 'id', { min: 1 });
      const existing = repos.ruleRepo.get(id);
      if (!existing) throw notFound(`规则不存在：${id}`);
      repos.ruleRepo.remove(id);
      sendJson(ctx.res, 200, { ok: true, id });
    },

    async toggle(ctx) {
      const id = requireInt(ctx.params.id, 'id', { min: 1 });
      const existing = repos.ruleRepo.get(id);
      if (!existing) throw notFound(`规则不存在：${id}`);
      const body = await readJsonBody(ctx.req);
      const enabled = Boolean(body.enabled);
      repos.ruleRepo.update(id, { enabled });
      sendJson(ctx.res, 200, { rule: mapRuleRow(repos.ruleRepo.get(id)) });
    },
  };
}
