import { sendJson, readJsonBody } from '../lib/http.js';
import { optionalInt, requireEnum, optionalString, requireEtfCode } from '../lib/validate.js';
import { tradeDateStartTs, tradeDateOf, shanghaiParts } from '../lib/time.js';
import { badRequest } from '../lib/errors.js';

export function createEtfController({ services }) {
  const { queryService, marketService, intradayService } = services;

  return {
    overview(ctx) {
      const overview = queryService.overview();
      const status = marketService.getStatus();
      // 日度告警的触发时间落在交易日 15:00，因此统计窗口取「今日 0 点」与「最近交易日 0 点」的较早者
      const since = status.lastTradeDate
        ? Math.min(ctx.todayStart, tradeDateStartTs(status.lastTradeDate))
        : ctx.todayStart;
      const summary = services.repos.alertRepo.summarize({ since });
      sendJson(ctx.res, 200, {
        ...overview,
        alerts: {
          since,
          total: summary.total,
          unacknowledged: summary.unacknowledged,
          bySeverity: summary.bySeverity,
        },
        status: {
          ...status,
          intraday: intradayService.getStatus(),
          surge: services.volumeSurgeService?.getStatus() ?? null,
          impulse: services.tickImpulseService?.getStatus() ?? null,
          preburst: services.intraMinuteSurgeService?.getStatus() ?? null,
          fast: services.fastTickService?.getStatus() ?? null,
        },
      });
    },

    list(ctx) {
      const query = ctx.url.searchParams;
      const limit = optionalInt(query.get('limit'), 'limit', { min: 1, max: 600 }) ?? 120;
      const sort = optionalString(query.get('sort'), 'sort', { max: 20 }) ?? 'mainNet';
      const dir = requireEnum(query.get('dir') ?? 'desc', 'dir', ['asc', 'desc']);
      const keyword = optionalString(query.get('q'), 'q', { max: 40 });
      const category = optionalString(query.get('category'), 'category', { max: 20 });
      const onlyTracked = query.get('tracked') === '1' || query.get('tracked') === 'true';

      const rows = queryService.listEtfs({ keyword, category, sort, dir, limit, onlyTracked });
      sendJson(ctx.res, 200, { rows, total: rows.length, generatedAt: Date.now() });
    },

    ranking(ctx) {
      const query = ctx.url.searchParams;
      const direction = requireEnum(query.get('direction') ?? 'inflow', 'direction', ['inflow', 'outflow']);
      const limit = optionalInt(query.get('limit'), 'limit', { min: 1, max: 200 }) ?? 20;
      const category = optionalString(query.get('category'), 'category', { max: 20 });
      const onlyTracked = query.get('tracked') === '1' || query.get('tracked') === 'true';
      // metric 决定按哪个口径排序：net（主序列）/ mainNet（主力净额）/ activeNet（主动净买）
      const metric = requireEnum(query.get('metric') ?? 'net', 'metric', ['net', 'mainNet', 'activeNet']);
      sendJson(ctx.res, 200, {
        direction,
        metric,
        rows: queryService.ranking({ direction, limit, category, onlyTracked, metric }),
        generatedAt: Date.now(),
      });
    },

    categories(ctx) {
      sendJson(ctx.res, 200, { rows: queryService.categoryBreakdown(), generatedAt: Date.now() });
    },

    detail(ctx) {
      const code = requireEtfCode(ctx.params.code);
      sendJson(ctx.res, 200, queryService.detail(code));
    },

    /**
     * 分时行情：默认返回最后交易日整日分时（价格 + 成交量），可指定历史交易日。
     * 本地无缓存时按需向上游拉取，采用全局串行队列，避免请求风暴。
     */
    async intraday(ctx) {
      const code = requireEtfCode(ctx.params.code);
      const rawDate = optionalString(ctx.url.searchParams.get('date'), 'date', { max: 10 });
      if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        throw badRequest('date 需为 YYYY-MM-DD 格式', { field: 'date', value: rawDate });
      }
      const force = ['1', 'true'].includes(ctx.url.searchParams.get('force') ?? '');
      const detail = queryService.detail(code);

      const result = await intradayService.getIntraday(code, {
        date: rawDate,
        force,
        market: detail.etf.market,
      });
      sendJson(ctx.res, 200, {
        ...result,
        etf: detail.etf,
        // 分时图上的量能突变标注（含弱信号，仅用于展示，不代表已产生告警）
        surge: services.volumeSurgeService?.explain(code, result.tradeDate) ?? null,
      });
    },

    /**
     * 秒级通道数据：只对核心池（国家队常买宽基）可用。
     * 返回最近 N 秒的逐秒价格与主动净买入额，供前端画秒级盘口。
     */
    fast(ctx) {
      const code = requireEtfCode(ctx.params.code);
      const seconds = optionalInt(ctx.url.searchParams.get('seconds'), 'seconds', { min: 30, max: 1800 }) ?? 600;
      const service = services.fastTickService;
      const meta = services.repos.etfRepo.get(code);
      if (!meta) throw badRequest(`未找到 ETF：${code}`, { field: 'code', value: code });

      const descriptor = service.describe(code);
      if (!descriptor.inPool) {
        sendJson(ctx.res, 200, {
          code,
          name: meta.name,
          ...descriptor,
          tradeDate: null,
          points: [],
          summary: null,
          note: '该标的走分钟级通道，秒级数据仅覆盖核心宽基池',
        });
        return;
      }

      const points = service.series(code, { seconds });
      const summary = service.summarize(code, { seconds });
      const tradeDate = points.length > 0 ? tradeDateOf(points[points.length - 1].ts) : null;
      // 秒级攻势标注：与告警同源（同一套检测参数），因此图上的标记和告警栏能对得上
      const impulse = services.tickImpulseService?.explain(code, { points }) ?? null;
      // 分钟内实时判定：同一批逐秒点，算的是「正在形成的这一分钟」折算到整分钟有多少。
      // preburstAt=HH:MM[:SS] 可以把窗口截到过去某一刻，回放「假如当时就在跑，会判成什么」——
      // 收盘后想核对某根柱子当时到底有没有报出来，用这个参数即可。
      const atParam = optionalString(ctx.url.searchParams.get('preburstAt'), 'preburstAt', { max: 8 });
      let preburstPoints = points;
      if (atParam) {
        // 回放不受画图窗口（默认 10 分钟）限制：按需读当日更长的秒级序列，
        // 但不把它塞进响应体，避免为一根柱子回传几千个点。
        const wide = service.series(code, { seconds: 6 * 3600 });
        const target = replayCutoff(wide, atParam);
        preburstPoints = wide.filter((point) => point.ts <= target);
      }
      const preburst = services.intraMinuteSurgeService?.explain(code, { points: preburstPoints }) ?? null;
      // 收盘后最后一根是 15:00 集合竞价，不判定；这时改为回放当日该通道真的报过什么，
      // 既让「第一手爆量」在盘后仍然看得见，也便于核对这条链路当天有没有白跑
      let lastPreburst = null;
      if (preburst && !preburst.evaluation?.active && tradeDate && !atParam) {
        const hit = services.repos.alertRepo.list({
          metric: 'volume_preburst',
          code,
          since: tradeDateStartTs(tradeDate),
          limit: 1,
        });
        const row = hit?.rows?.[0];
        if (row) {
          lastPreburst = {
            value: row.value,
            severity: row.severity,
            triggeredAt: row.triggered_at,
            message: row.message,
          };
        }
      }
      sendJson(ctx.res, 200, {
        code,
        name: meta.name,
        ...descriptor,
        tradeDate,
        points: points.map((row) => ({
          ts: row.ts,
          minute: clockText(row.ts),
          price: row.price,
          amt: row.amt_delta,
          net: row.net_delta,
          imba: row.imba,
          bid1: row.bid1,
          ask1: row.ask1,
          pctChg: row.pct_chg,
        })),
        summary,
        impulses: impulse?.episodes ?? [],
        preburst: preburst?.evaluation ?? null,
        lastPreburst,
        preburstReplayAt: atParam ?? null,
        note: points.length === 0 ? '等待盘中秒级数据（仅在交易时段采集）' : null,
      });
    },

    async sync(ctx) {
      const body = await readJsonBody(ctx.req);
      const scope = requireEnum(body.scope ?? 'tick', 'scope', [
        'tick',
        'universe',
        'daily',
        'intraday',
        'surge',
        'fast',
        'impulse',
        'preburst',
      ]);
      let result;
      if (scope === 'universe') result = await marketService.syncUniverse();
      else if (scope === 'daily') result = await marketService.backfillDaily({ force: true });
      else if (scope === 'intraday') result = await intradayService.backfillTracked({ force: Boolean(body.force) });
      else if (scope === 'impulse') {
        // 手动触发一轮秒级攻势扫描：非交易时段需要 force，用于验证链路与参数
        result = (await services.tickImpulseService?.scan({ force: Boolean(body.force) })) ?? {
          ok: false,
          reason: 'unavailable',
        };
      } else if (scope === 'preburst') {
        // 手动触发一轮分钟内实时判定（同样需要 force 才能越过交易时段限制）
        result = (await services.intraMinuteSurgeService?.scan({ force: Boolean(body.force) })) ?? {
          ok: false,
          reason: 'unavailable',
        };
      } else if (scope === 'fast') {
        // 手动触发一次秒级采样：非交易时段上游快照时间不前进，只会验证链路连通性
        const polled = await services.fastTickService.poll({ force: true });
        const flushed = services.fastTickService.flushNow();
        result = { ...polled, flushed };
      } else if (scope === 'surge') {
        const live = await intradayService.refreshLive({ limit: services.config.volumeSurge.liveRefreshLimit });
        const scan = (await services.volumeSurgeService?.scan()) ?? { ok: false, reason: 'unavailable' };
        result = { ok: live.ok !== false || scan.ok !== false, live, scan };
      } else result = await marketService.tick();
      sendJson(ctx.res, result.ok === false ? 503 : 200, {
        scope,
        ok: result.ok !== false,
        result,
        status: marketService.getStatus(),
      });
    },
  };
}

/**
 * 把 `HH:MM` / `HH:MM:SS` 解析成该交易日内的截止时间戳。
 * 只接受落入当前分钟窗口内的时间：给出一个当天的任意时刻会让回放静默返回空结果，
 * 那种「看起来没报」比「参数错了」更难排查，所以直接报错。
 */
function replayCutoff(points, text) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text ?? '').trim());
  if (!match || points.length === 0) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] ? Number(match[3]) : 59;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const dayStart = tradeDateStartTs(tradeDateOf(points[points.length - 1].ts));
  const target = dayStart + (hour * 3600 + minute * 60 + second) * 1000;
  const first = points[0].ts;
  const last = points[points.length - 1].ts;
  if (target < first || target > last) {
    throw badRequest(`preburstAt 需落在已有秒级数据的时间范围内（${clockText(first)}~${clockText(last)}）`, {
      field: 'preburstAt',
      value: text,
    });
  }
  return target;
}

/** 毫秒时间戳 → 北京时间 HH:MM:SS（秒级图 x 轴与浮层用） */
function clockText(ts) {
  const { hour, minute, second } = shanghaiParts(ts);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}
