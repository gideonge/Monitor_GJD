import { NotFoundError } from './errors.js';

/**
 * 极简路由：支持 GET/POST/PATCH/DELETE 与 :param 占位。
 * 仅为避免引入 express 依赖；职责边界与 express 一致（只做分发，不含业务）。
 */
export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler) => {
    const keys = [];
    const regexSource = pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          keys.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    routes.push({ method, regex: new RegExp(`^${regexSource}/?$`), keys, handler });
  };

  const router = {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    patch: (pattern, handler) => add('PATCH', pattern, handler),
    put: (pattern, handler) => add('PUT', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),
    match(method, pathname) {
      let pathMatched = false;
      for (const route of routes) {
        const result = route.regex.exec(pathname);
        if (!result) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = {};
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(result[index + 1]);
        });
        return { handler: route.handler, params };
      }
      if (pathMatched) throw new NotFoundError('该路径不支持当前请求方法');
      throw new NotFoundError('接口不存在');
    },
  };

  return router;
}
