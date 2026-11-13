export class ApiError extends Error {
  constructor(message, status = 0, code = 'unknown') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 统一 API 客户端：
 * - Base URL 走同源相对路径（部署到子路径时只需改 API_BASE）
 * - 4xx 不重试（参数/业务错误重试无意义），5xx 与网络错误最多重试 3 次
 * - 后端规范化的 error.message 直接作为用户可读提示
 */
const API_BASE = '';

async function request(path, { method = 'GET', body, timeout = 15000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new ApiError('响应解析失败', response.status, 'bad_response');
        }
      }
      if (!response.ok) {
        const error = new ApiError(
          payload?.error?.message ?? `请求失败（HTTP ${response.status}）`,
          response.status,
          payload?.error?.code ?? 'http_error',
        );
        if (response.status < 500) throw error;
        lastError = error;
      } else {
        return payload;
      }
    } catch (error) {
      if (error instanceof ApiError && error.status > 0 && error.status < 500) throw error;
      if (error.name === 'AbortError') lastError = new ApiError('请求超时，请稍后重试', 0, 'timeout');
      else if (error instanceof ApiError) lastError = error;
      else lastError = new ApiError('网络异常，无法连接服务', 0, 'network');
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(400 * 2 ** attempt);
  }
  throw lastError ?? new ApiError('请求失败', 0, 'unknown');
}

export const api = {
  meta: () => request('/api/meta'),
  options: () => request('/api/options'),
  overview: () => request('/api/overview'),

  ranking: ({ direction = 'inflow', limit = 20, category, tracked } = {}) =>
    request(`/api/flows/ranking${buildQuery({ direction, limit, category, tracked: tracked ? 1 : undefined })}`),

  listEtfs: ({ q, category, sort, dir, limit, tracked } = {}) =>
    request(`/api/etfs${buildQuery({ q, category, sort, dir, limit, tracked: tracked ? 1 : undefined })}`),

  detail: (code) => request(`/api/etfs/${encodeURIComponent(code)}`),

  intraday: (code, { date, force } = {}) =>
    request(
      `/api/etfs/${encodeURIComponent(code)}/intraday${buildQuery({ date, force: force ? 1 : undefined })}`,
      { timeout: 12000, retries: 0 },
    ),

  /** 秒级盘口：仅核心池可用，非核心池返回空点集 */
  fast: (code, { seconds = 600 } = {}) =>
    request(`/api/etfs/${encodeURIComponent(code)}/fast${buildQuery({ seconds })}`, { timeout: 8000, retries: 0 }),

  alerts: (params) => request(`/api/alerts${buildQuery(params)}`),
  alertSummary: () => request('/api/alerts/summary'),

  rules: () => request('/api/rules'),
  createRule: (payload) => request('/api/rules', { method: 'POST', body: payload }),
  updateRule: (id, payload) => request(`/api/rules/${id}`, { method: 'PATCH', body: payload }),
  toggleRule: (id, enabled) => request(`/api/rules/${id}/toggle`, { method: 'PATCH', body: { enabled } }),
  deleteRule: (id) => request(`/api/rules/${id}`, { method: 'DELETE' }),

  sync: (scope = 'tick') => request('/api/sync', { method: 'POST', body: { scope }, timeout: 30000 }),
};
