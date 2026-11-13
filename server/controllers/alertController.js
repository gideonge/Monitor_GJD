import { sendJson } from '../lib/http.js';
import { mapAlertRow } from '../lib/serialize.js';
import { optionalInt, optionalEnum, optionalString } from '../lib/validate.js';
import { SEVERITIES, METRICS } from '../repositories/ruleRepo.js';
import { recentSessionStart } from '../lib/time.js';

/** 列表时间范围：「最近交易日」与总览的告警数同口径，其余按小时回溯 */
const RANGES = ['today', '24', '72', '168'];

export function createAlertController({ services }) {
  const { repos, marketService } = services;

  /** 「当日」的唯一定义：今日 0 点与最近交易日 0 点的较早者（与总览同源） */
  function sessionStart(ctx) {
    return recentSessionStart({
      todayStart: ctx.todayStart,
      lastTradeDate: marketService?.getStatus?.().lastTradeDate,
    });
  }

  return {
    list(ctx) {
      const query = ctx.url.searchParams;
      const limit = optionalInt(query.get('limit'), 'limit', { min: 1, max: 500 }) ?? 50;
      const offset = optionalInt(query.get('offset'), 'offset', { min: 0, max: 100000 }) ?? 0;
      const severity = optionalEnum(query.get('severity'), 'severity', SEVERITIES);
      const metric = optionalEnum(query.get('metric'), 'metric', Object.keys(METRICS));
      const code = optionalString(query.get('code'), 'code', { max: 12 });
      const sinceHours = optionalInt(query.get('sinceHours'), 'sinceHours', { min: 1, max: 8760 });
      const range = optionalEnum(query.get('range'), 'range', RANGES);
      // 两条时间条件互斥：range 走「当日」口径，sinceHours 走滚动窗口
      const since = range === 'today' ? sessionStart(ctx) : sinceHours ? Date.now() - sinceHours * 3600 * 1000 : undefined;

      const { rows, total } = repos.alertRepo.list({ limit, offset, code, severity, metric, since });

      sendJson(ctx.res, 200, {
        rows: rows.map(mapAlertRow),
        total,
        since: since ?? null,
        range: range ?? null,
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
      // today 一律是「最近交易日窗口」：页面上的徽标、KPI 卡、列表默认范围共用这一个数
      const todaySince = sessionStart(ctx);
      sendJson(ctx.res, 200, {
        ...summary,
        today: { ...repos.alertRepo.summarize({ since: todaySince }), since: todaySince },
        topCodes: repos.alertRepo.topCodes({ since, limit: 6 }),
        recent: repos.alertRepo.recent(8).map(mapAlertRow),
        generatedAt: Date.now(),
      });
    },
  };
}
