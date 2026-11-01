import crypto from 'node:crypto';
import { sendError, applyCors, clientIp, applySecurityHeaders } from './lib/http.js';
import { createStaticHandler } from './lib/static.js';
import { buildRouter } from './routes/index.js';
import { notFound, ValidationError } from './lib/errors.js';
import { todayStartTs } from './lib/time.js';

export function createApp({ services, logger, config }) {
  const router = buildRouter({ services });
  const serveStatic = createStaticHandler(config.webDir);

  return async function handleRequest(req, res) {
    const requestId = crypto.randomUUID();
    const startedAt = process.hrtime.bigint();
    const reqLogger = logger.child({ requestId });

    res.setHeader('X-Request-Id', requestId);
    applySecurityHeaders(res);
    applyCors(req, res, config.corsOrigins);

    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendError(res, new ValidationError('非法请求路径'), { logger, requestId });
      return;
    }

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        const { handler, params } = router.match(req.method, url.pathname);
        await handler({
          req,
          res,
          url,
          params,
          requestId,
          services,
          config,
          logger: reqLogger,
          todayStart: todayStartTs(),
        });
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, url.pathname);
      } else {
        throw notFound('请求方法不被支持');
      }
    } catch (error) {
      if (!res.headersSent) {
        sendError(res, error, { logger, requestId });
      } else {
        reqLogger.error('响应已发送后发生异常', { err: error, path: url.pathname });
        res.end();
      }
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      if (!url.pathname.startsWith('/api/stream')) {
        reqLogger[level]('http', {
          method: req.method,
          path: url.pathname,
          status: res.statusCode,
          durationMs: Number(durationMs.toFixed(1)),
          ip: clientIp(req),
        });
      }
    }
  };
}
