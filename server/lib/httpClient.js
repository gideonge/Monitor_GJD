import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

/**
 * 上游 HTTP 客户端：支持 HTTPS_PROXY / HTTP_PROXY 环境变量。
 *
 * 为什么需要自己实现：Node 内置 fetch（undici）不读取代理环境变量，
 * 而 curl / 浏览器都读。在企业网络或代理上网环境下，直连会表现为
 * ECONNRESET / UND_ERR_CONNECT_TIMEOUT，看起来像「接口被限流」。
 * 这里用 CONNECT 隧道 + TLS 复用，零第三方依赖。
 *
 * 未配置代理时退化为直连（内置 fetch），保持便携性。
 */

function readProxy() {
  const raw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const auth =
      url.username || url.password
        ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
        : null;
    return { host: url.hostname, port: Number(url.port || 8080), auth };
  } catch {
    return null;
  }
}

export function getProxyInfo() {
  const proxy = readProxy();
  return proxy ? { enabled: true, host: proxy.host, port: proxy.port } : { enabled: false };
}

/** 通过 CONNECT 隧道请求 https 资源，返回响应体文本 */
function requestThroughProxy(targetUrl, proxy, { headers = {}, timeoutMs = 9000 } = {}) {
  const target = new URL(targetUrl);
  const port = Number(target.port || 443);

  return new Promise((resolve, reject) => {
    const connectHeaders = { Host: `${target.hostname}:${port}` };
    if (proxy.auth) {
      connectHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(proxy.auth).toString('base64')}`;
    }

    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: connectHeaders,
    });

    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      connectReq.destroy();
      reject(error);
    };

    connectReq.setTimeout(timeoutMs, () => fail(new Error('代理连接超时')));
    connectReq.on('error', (error) => fail(new Error(`代理连接失败：${error.code ?? error.message}`)));
    connectReq.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`代理 CONNECT 返回 ${response.statusCode}`));
        return;
      }

      const request = https.request(
        {
          host: target.hostname,
          servername: target.hostname,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: { ...headers, Host: target.hostname },
          agent: false,
          createConnection: () => tls.connect({ socket, servername: target.hostname }),
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('error', (error) => fail(error));
          res.on('end', () => {
            if (settled) return;
            settled = true;
            const body = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            resolve(body);
          });
        },
      );

      request.setTimeout(timeoutMs, () => request.destroy(new Error('响应超时')));
      request.on('error', fail);
      request.end();
    });

    connectReq.end();
  });
}

/** 统一的文本 GET：有代理走隧道，无代理走内置 fetch */
export async function getText(url, { headers = {}, timeoutMs = 9000 } = {}) {
  const proxy = readProxy();
  if (proxy) return requestThroughProxy(url, proxy, { headers, timeoutMs });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}
