import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { NotFoundError, ValidationError } from './errors.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 同源静态资源服务：路径穿越防护 + 明确 MIME + no-cache（便于迭代）。
 */
export function createStaticHandler(rootDir) {
  const root = path.resolve(rootDir);

  return async function serveStatic(req, res, pathname) {
    let relative = decodeURIComponent(pathname);
    if (relative === '/' || relative === '') relative = '/index.html';
    if (relative.includes('\0')) throw new ValidationError('非法路径');

    const target = path.resolve(root, `.${relative}`);
    if (!target.startsWith(root)) throw new NotFoundError('资源不存在');

    let stat;
    try {
      stat = await fsp.stat(target);
    } catch {
      throw new NotFoundError('资源不存在');
    }
    if (stat.isDirectory()) throw new NotFoundError('资源不存在');

    const ext = path.extname(target).toLowerCase();
    const type = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(target).pipe(res);
  };
}
