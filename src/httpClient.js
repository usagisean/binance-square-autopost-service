const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const { config } = require('./config');

function shouldBypassProxy(hostname) {
  const raw = config.noProxy || '';
  const host = String(hostname || '').toLowerCase();
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).some(rule => {
    if (rule === '*') return true;
    if (rule === host) return true;
    if (rule.startsWith('.') && host.endsWith(rule)) return true;
    return false;
  });
}

function proxyFor(urlObj, explicitProxy) {
  if (explicitProxy === false) return '';
  if (typeof explicitProxy === 'string' && explicitProxy) return explicitProxy;
  if (shouldBypassProxy(urlObj.hostname)) return '';
  if (urlObj.protocol === 'https:') return config.httpsProxy || config.httpProxy || '';
  if (urlObj.protocol === 'http:') return config.httpProxy || '';
  return '';
}

function requestViaHttpConnect(urlObj, bodyBuffer, headers, timeoutMs, proxyUrl) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
    const connectHost = `${urlObj.hostname}:${urlObj.port || 443}`;
    let settled = false;
    let socket;

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (socket) socket.destroy();
      err ? reject(err) : resolve(value);
    };

    socket = net.connect(proxyPort, proxy.hostname);
    socket.setTimeout(timeoutMs, () => done(new Error('proxy_connect_timeout')));
    socket.once('error', done);
    socket.once('connect', () => {
      const proxyHeaders = [`CONNECT ${connectHost} HTTP/1.1`, `Host: ${connectHost}`];
      if (proxy.username || proxy.password) {
        const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
        proxyHeaders.push(`Proxy-Authorization: Basic ${auth}`);
      }
      socket.write(proxyHeaders.join('\r\n') + '\r\n\r\n');
    });

    let connectBuffer = Buffer.alloc(0);
    socket.on('data', function onConnectData(chunk) {
      connectBuffer = Buffer.concat([connectBuffer, chunk]);
      const marker = connectBuffer.indexOf('\r\n\r\n');
      if (marker === -1) return;
      socket.off('data', onConnectData);
      const head = connectBuffer.slice(0, marker).toString('latin1');
      const rest = connectBuffer.slice(marker + 4);
      if (!/^HTTP\/1\.[01] 2\d\d/.test(head)) return done(new Error(`proxy_connect_failed:${head.split('\r\n')[0] || head}`));

      const secure = tls.connect({ socket, servername: urlObj.hostname });
      socket = secure;
      secure.setTimeout(timeoutMs, () => done(new Error('request_timeout')));
      secure.once('error', done);
      secure.once('secureConnect', () => {
        const path = `${urlObj.pathname}${urlObj.search}`;
        const lines = [`POST ${path} HTTP/1.1`, `Host: ${urlObj.host}`];
        for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
        lines.push(`Content-Length: ${bodyBuffer.length}`, 'Connection: close', '', '');
        secure.write(lines.join('\r\n'));
        if (bodyBuffer.length) secure.write(bodyBuffer);
        if (rest.length) secure.unshift(rest);
      });

      collectRawHttpResponse(secure, timeoutMs).then(resolve, reject);
    });
  });
}

function collectRawHttpResponse(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(value);
    };
    stream.setTimeout(timeoutMs, () => done(new Error('request_timeout')));
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', done);
    stream.on('end', () => {
      const raw = Buffer.concat(chunks);
      const marker = raw.indexOf('\r\n\r\n');
      if (marker === -1) return done(new Error('invalid_http_response'));
      const head = raw.slice(0, marker).toString('latin1');
      const body = raw.slice(marker + 4).toString('utf8');
      const statusLine = head.split('\r\n')[0] || '';
      const m = statusLine.match(/HTTP\/1\.[01]\s+(\d+)/);
      if (!m) return done(new Error(`invalid_status:${statusLine}`));
      done(null, { statusCode: Number(m[1]), body, headers: {} });
    });
  });
}

function request(method, url, { headers = {}, body = null, timeoutMs = 20000, proxy = undefined } = {}) {
  const u = new URL(url);
  const bodyBuffer = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const proxyUrl = proxyFor(u, proxy);

  // The built-in CONNECT helper is only needed for HTTPS POSTs with a proxy.
  if (proxyUrl && u.protocol === 'https:' && method.toUpperCase() === 'POST') {
    return requestViaHttpConnect(u, bodyBuffer, headers, timeoutMs, proxyUrl);
  }

  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      method,
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: { ...headers },
      timeout: timeoutMs
    };
    if (bodyBuffer.length) opts.headers['Content-Length'] = bodyBuffer.length;

    const req = lib.request(opts, res => {
      let data = '';
      let ended = false;
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => {
        ended = true;
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
      res.on('aborted', () => reject(new Error(`response_aborted:${url}:${data.length}`)));
      res.on('error', reject);
      res.on('close', () => {
        if (!ended) reject(new Error(`response_closed_before_end:${url}:${data.length}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('request_timeout')));
    req.on('error', reject);
    if (bodyBuffer.length) req.write(bodyBuffer);
    req.end();
  });
}

async function getJson(url, options = {}) {
  const res = await request('GET', url, {
    headers: {
      'User-Agent': 'binance-square-autopost-service/0.2',
      Accept: 'application/json',
      ...(options.headers || {})
    },
    timeoutMs: options.timeoutMs || 20000,
    proxy: options.proxy
  });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`http_${res.statusCode}:${res.body.slice(0, 300)}`);
  return JSON.parse(res.body);
}

async function postJson(url, payload, options = {}) {
  const body = JSON.stringify(payload);
  const res = await request('POST', url, {
    headers: {
      'User-Agent': 'binance-square-autopost-service/0.2',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body,
    timeoutMs: options.timeoutMs || 25000,
    proxy: options.proxy
  });
  let json = null;
  try { json = JSON.parse(res.body); } catch {}
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`http_${res.statusCode}:${json?.message || json?.msg || res.body.slice(0, 300)}`);
  }
  return json ?? JSON.parse(res.body);
}

module.exports = { request, getJson, postJson, shouldBypassProxy };
