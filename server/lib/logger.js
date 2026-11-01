const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const SENSITIVE_KEY = /^(password|passwd|secret|token|authorization|cookie|api[-_]?key|accesstoken|refreshtoken)$/i;

function normalizeValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code, stack: value.stack };
  }
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return depth > 3 ? '[array]' : value.map((item) => normalizeValue(item, depth + 1));
  if (typeof value === 'object') {
    if (depth > 3) return '[object]';
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : normalizeValue(val, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level, threshold, bindings, message, fields) {
  if (LEVELS[level] < threshold) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...normalizeValue(bindings),
    ...normalizeValue(fields),
  };
  const line = JSON.stringify(payload);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger({ level = 'info', bindings = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const logger = {
    level,
    child(extra) {
      return createLogger({ level, bindings: { ...bindings, ...extra } });
    },
    debug: (msg, fields) => write('debug', threshold, bindings, msg, fields),
    info: (msg, fields) => write('info', threshold, bindings, msg, fields),
    warn: (msg, fields) => write('warn', threshold, bindings, msg, fields),
    error: (msg, fields) => write('error', threshold, bindings, msg, fields),
  };
  return logger;
}

export default createLogger;
