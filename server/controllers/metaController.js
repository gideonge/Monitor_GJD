import { sendJson } from '../lib/http.js';
import { METRICS, TIMEFRAMES, COMPARATORS, SEVERITIES, SCOPES, DEFAULT_RULES } from '../repositories/ruleRepo.js';
import { CATEGORIES } from '../lib/classify.js';

const VERSION = '1.0.0';

export function createMetaController({ services }) {
  return {
    health(ctx) {
      sendJson(ctx.res, 200, {
        status: 'ok',
        version: VERSION,
        uptimeSec: Math.round(process.uptime()),
        now: Date.now(),
      });
    },

    ready(ctx) {
      const status = services.marketService.getStatus();
      const dbOk = (() => {
        try {
          services.repos.etfRepo.count();
          return true;
        } catch {
          return false;
        }
      })();
      const ready = dbOk && status.lastUniverseAt > 0;
      sendJson(ctx.res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'warming',
        checks: {
          database: dbOk ? 'ok' : 'fail',
          universe: status.lastUniverseAt > 0 ? 'ok' : 'pending',
          snapshots: status.lastTickAt > 0 ? 'ok' : 'pending',
          history: status.lastDailyAt > 0 ? 'ok' : 'pending',
        },
        status,
      });
    },

    meta(ctx) {
      sendJson(ctx.res, 200, {
        version: VERSION,
        status: {
          ...services.marketService.getStatus(),
          surge: services.volumeSurgeService?.getStatus() ?? null,
          fast: services.fastTickService?.getStatus() ?? null,
        },
        config: {
          pollIntervalMs: services.config.pollIntervalMs,
          universeSize: services.config.universeSize,
          historyDays: services.config.historyDays,
          retentionDays: services.config.retentionDays,
          alertCooldownSec: services.config.alertCooldownSec,
          volumeSurge: services.config.volumeSurge,
          fastTick: {
            enabled: services.config.fastTick.enabled,
            intervalMs: services.config.fastTick.intervalMs,
            poolSize: services.config.fastTick.codes.length,
            retentionDays: services.config.fastTick.retentionDays,
          },
        },
      });
    },

    options(ctx) {
      sendJson(ctx.res, 200, {
        metrics: Object.entries(METRICS).map(([value, meta]) => ({
          value,
          label: meta.label,
          unit: meta.unit,
          timeframes: meta.timeframes,
        })),
        timeframes: TIMEFRAMES,
        comparators: COMPARATORS,
        severities: SEVERITIES,
        scopes: SCOPES,
        categories: CATEGORIES,
        defaultRules: DEFAULT_RULES,
      });
    },
  };
}
