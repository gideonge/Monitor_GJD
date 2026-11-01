/**
 * 类型化错误体系。对外只暴露 code / message / details，
 * 绝不把堆栈或上游内部信息返回给客户端。
 */
export class AppError extends Error {
  constructor(message, { code = 'internal_error', status = 500, details, expose = status < 500, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
    this.expose = expose;
    this.isOperational = true;
  }
}

export class ValidationError extends AppError {
  constructor(message = '请求参数不合法', details) {
    super(message, { code: 'validation_error', status: 400, details, expose: true });
  }
}

export class NotFoundError extends AppError {
  constructor(message = '资源不存在', details) {
    super(message, { code: 'not_found', status: 404, details, expose: true });
  }
}

export class ConflictError extends AppError {
  constructor(message = '资源冲突', details) {
    super(message, { code: 'conflict', status: 409, details, expose: true });
  }
}

export class UpstreamError extends AppError {
  constructor(message = '上游数据源不可用', details) {
    super(message, { code: 'upstream_unavailable', status: 502, details, expose: true });
  }
}

export class RateLimitError extends AppError {
  constructor(message = '请求过于频繁', details) {
    super(message, { code: 'rate_limited', status: 429, details, expose: true });
  }
}

export const badRequest = (message, details) => new ValidationError(message, details);
export const notFound = (message, details) => new NotFoundError(message, details);
export const conflict = (message, details) => new ConflictError(message, details);
export const upstream = (message, details) => new UpstreamError(message, details);
