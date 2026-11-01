import { EventEmitter } from 'node:events';

/**
 * 进程内事件总线：采集任务发布，SSE 端点订阅。
 * 单实例部署不引入 Redis；多实例时替换为外部消息通道即可。
 */
export function createEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  return {
    on: (event, handler) => {
      emitter.on(event, handler);
      return () => emitter.off(event, handler);
    },
    publish(event, payload) {
      emitter.emit(event, payload);
    },
    close() {
      emitter.removeAllListeners();
    },
  };
}

export const EVENTS = {
  ALERT: 'alert',
  TICK: 'tick',
  STATUS: 'status',
};
