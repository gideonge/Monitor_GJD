import { ValidationError } from './errors.js';

const fail = (message, field) => {
  throw new ValidationError(message, field ? { field } : undefined);
};

export function asObject(value, field = 'body') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} 必须是 JSON 对象`, field);
  }
  return value;
}

export function requireString(value, field, { min = 1, max = 200, trim = true } = {}) {
  if (typeof value !== 'string') fail(`${field} 必须是字符串`, field);
  const text = trim ? value.trim() : value;
  if (text.length < min) fail(`${field} 不能为空`, field);
  if (text.length > max) fail(`${field} 长度不能超过 ${max} 个字符`, field);
  return text;
}

export function optionalString(value, field, opts = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, field, opts);
}

export function requireNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) fail(`${field} 必须是数字`, field);
  if (num < min || num > max) fail(`${field} 必须介于 ${min} 与 ${max} 之间`, field);
  return num;
}

export function requireInt(value, field, { min = -2147483648, max = 2147483647 } = {}) {
  const num = requireNumber(value, field, { min, max });
  if (!Number.isInteger(num)) fail(`${field} 必须是整数`, field);
  return num;
}

export function optionalInt(value, field, opts = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireInt(value, field, opts);
}

export function requireEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    fail(`${field} 必须是以下之一：${allowed.join(' / ')}`, field);
  }
  return value;
}

export function optionalEnum(value, field, allowed) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireEnum(value, field, allowed);
}

export function requireBoolean(value, field) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(`${field} 必须是布尔值`, field);
}

export function optionalBoolean(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireBoolean(value, field);
}

export function optionalStringArray(value, field, { max = 200 } = {}) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail(`${field} 必须是数组`, field);
  if (value.length > max) fail(`${field} 元素数量不能超过 ${max}`, field);
  return value.map((item, index) => requireString(item, `${field}[${index}]`, { max: 40 }));
}

/** 用于路径参数 / 查询参数的 ETF 代码校验（6 位数字） */
export function requireEtfCode(value, field = 'code') {
  const text = requireString(value, field, { max: 12 });
  if (!/^\d{6}$/.test(text)) fail(`${field} 必须是 6 位数字代码`, field);
  return text;
}

export function queryObject(searchParams) {
  const out = {};
  for (const [key, value] of searchParams.entries()) out[key] = value;
  return out;
}
