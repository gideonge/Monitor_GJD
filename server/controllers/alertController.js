import { sendJson } from '../lib/http.js';
import { mapAlertRow } from '../lib/serialize.js';
import { notFound } from '../lib/errors.js';
import { optionalInt, optionalEnum, optionalString, requireInt } from '../lib/validate.js';
import { SEVERITIES, METRICS } from '../repositories/ruleRepo.js';

export function createAlertController({ services }) {
  const { repos } = services;

  return {
    list(ctx) {
      const query = ctx.url.searchParams;
      const limit = optionalInt(query.get('limit'), 'limit', { min: 1, max: 500 }) ?? 50;
      const offset = optionalInt(query.get('offset'), 'offset', { min: 0, max: 100000 }) ?? 0;
      const severity = optionalEnum(query.get('severity'), 'severity', SEVERITIES);
      const metric = optionalEnum(query.get('metric'), 'metric', Object.keys(METRICS));
      const code = optionalString(query.get('code'), 'code', { max: 12 });
      const ackParam = query.get('acknowledged');
      const acknowledged =
        ackParam === 'true' || ackParam === '1' ? true : ackParam === 'false' || ackParam === '0' ? false : undefined;
      const sinceHours = optionalInt(query.get('sinceHours'), 'sinceHours', { min: 1, max: 8760 });
      const since = sinceHours ? Date.now() - sinceHours * 3600 * 1000 : undefined;

      const { rows, total } = repos.alertRepo.list({
        limit,
        offset,
        code,
        severity,
        metric,
        acknowledged,
        since,
      });

      sendJson(ctx.res, 200, {
        rows: rows.map(mapAlertRow),
        total,
        limit,
        offset,
        generatedAt: Date.now(),
      });
    },

    summary(ctx) {
      const query = ctx.url.searchParams;
      const sinceHours = optionalInt(query.get('sinceHours'), 'sinceHours', { min: 1, max: 8760 });
      const since = sinceHours ? Date.now() - sinceHours * 3600 * 1000 : undefined;
      const summary = repos.alertRepo.summarize({ since });
      sendJson(ctx.res, 200, {
        ...summary,
        today: repos.alertRepo.summarize({ since: ctx.todayStart }),
        topCodes: repos.alertRepo.topCodes({ since, limit: 6 }),
        recent: repos.alertRepo.recent(8).map(mapAlertRow),
        generatedAt: Date.now(),
      });
    },

    ack(ctx) {
      const id = requireInt(ctx.params.id, 'id', { min: 1 });
      const ok = repos.alertRepo.acknowledge(id);
      if (!ok) {
        const existing = repos.alertRepo.getById(id);
        if (!existing) throw notFound(`告警不存在：${id}`);
        sendJson(ctx.res, 200, { ok: true, alreadyAcknowledged: true, alert: mapAlertRow(existing) });
        return;
      }
      sendJson(ctx.res, 200, { ok: true, alert: mapAlertRow(repos.alertRepo.getById(id)) });
    },
  };
}
