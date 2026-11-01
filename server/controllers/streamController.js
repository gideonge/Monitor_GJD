import { EVENTS } from '../services/events.js';
import { mapAlertRow } from '../lib/serialize.js';

const HEARTBEAT_MS = 20000;

/**
 * SSE 实时推送：告警、采集心跳、状态变更。
 * 断线由浏览器 EventSource 自动重连；服务端只做单向上推。
 */
export function createStreamController({ services }) {
  return {
    stream(ctx) {
      const { req, res } = ctx;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      req.socket?.setNoDelay?.(true);

      const send = (event, data) => {
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          /* 连接已断开，由 close 事件清理 */
        }
      };

      send('hello', {
        at: Date.now(),
        status: services.marketService.getStatus(),
        recentAlerts: services.repos.alertRepo.recent(6).map(mapAlertRow),
      });

      const offAlert = services.events.on(EVENTS.ALERT, (alert) => send('alert', alert));
      const offTick = services.events.on(EVENTS.TICK, (payload) => send('tick', payload));
      const offStatus = services.events.on(EVENTS.STATUS, (payload) => send('status', payload));

      const heartbeat = setInterval(() => {
        try {
          res.write(': heartbeat\n\n');
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      const cleanup = () => {
        clearInterval(heartbeat);
        offAlert();
        offTick();
        offStatus();
        try {
          res.end();
        } catch {
          /* ignore */
        }
      };

      req.on('close', cleanup);
      req.on('error', cleanup);
    },
  };
}
