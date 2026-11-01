import { AppError, ValidationError } from './errors.js';

const MAX_BODY_BYTES = 1_000_000;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function applySecurityHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  applySecurityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * 全局错误出口：客户端只看到规范化结构，堆栈仅进日志。
 */
export function sendError(res, error, { logger, requestId } = {}) {
  const isAppError = error instanceof AppError;
  const status = isAppError ? error.status : 500;
  const body = {
    error: {
      code: isAppError ? error.code : 'internal_error',
      message: isAppError && error.expose ? error.message : '服务器内部错误',
      ...(isAppError && error.details ? { details: error.details } : {}),
      requestId,
    },
  };
  if (!isAppError || status >= 500) {
    logger?.error('请求处理失败', { requestId, err: error, status });
  }
  sendJson(res, status, body);
}

export async function readJsonBody(req, { limit = MAX_BODY_BYTES } = {}) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ValidationError('请求体过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('请求体不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('请求体必须是 JSON 对象');
  }
  return parsed;
}

export function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (!allowedOrigins.includes(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}
