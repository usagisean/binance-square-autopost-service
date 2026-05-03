const http = require('http');
const fs = require('fs');
const path = require('path');
const { config, masked } = require('./config');
const { initStore, getSettings, saveSettings, getSecrets, saveSecrets, listPrompts, createPrompt, updatePrompt, activatePrompt, getCounter, listRuns } = require('./store');
const { schedulerStatus, startScheduler } = require('./scheduler');
const { runOnce } = require('./workflow');
const { buildMarketPack } = require('./marketPack');
const { publisherStatus } = require('./publisher');

initStore();

function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function sendJson(res, status, payload) { send(res, status, payload, { 'Content-Type': 'application/json; charset=utf-8' }); }
function notFound(res) { sendJson(res, 404, { ok: false, error: 'not_found' }); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 2 * 1024 * 1024) reject(new Error('body_too_large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}
function authorized(req) {
  if (!config.adminToken) return true;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-admin-token'] || '');
  return token === config.adminToken;
}
function requireAuth(req, res) {
  if (authorized(req)) return true;
  sendJson(res, 401, { ok: false, error: 'unauthorized' });
  return false;
}

async function handleApi(req, res, url) {
  if (url.pathname !== '/api/status' && !requireAuth(req, res)) return;
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, {
      ok: true,
      app: 'binance-square-autopost-service',
      time: new Date().toISOString(),
      settings: getSettings(),
      counter: getCounter(getSettings()),
      scheduler: schedulerStatus(),
      publisher: publisherStatus(),
      llm: {
        provider: getSettings().llmProvider || config.llmProvider,
        baseUrl: getSettings().openaiBaseUrl || config.openaiBaseUrl,
        model: getSettings().openaiModel || config.openaiModel,
        temperature: getSettings().openaiTemperature ?? config.openaiTemperature,
        maxTokens: getSettings().openaiMaxTokens ?? config.openaiMaxTokens,
        timeoutMs: getSettings().openaiTimeoutMs ?? config.openaiTimeoutMs,
        apiKey: masked(getSecrets().openaiApiKey)
      },
      authRequired: !!config.adminToken
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/settings') return sendJson(res, 200, { ok: true, settings: getSettings() });
  if (req.method === 'PUT' && url.pathname === '/api/settings') return sendJson(res, 200, { ok: true, settings: saveSettings(await readBody(req)) });
  if (req.method === 'PUT' && url.pathname === '/api/secrets') {
    const secrets = saveSecrets(await readBody(req));
    return sendJson(res, 200, {
      ok: true,
      secrets: {
        openaiApiKey: masked(secrets.openaiApiKey),
        binanceSquareOpenApiKey: masked(secrets.binanceSquareOpenApiKey),
        telegramBotToken: masked(secrets.telegramBotToken),
        telegramChatId: secrets.telegramChatId ? 'configured' : ''
      }
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/prompts') return sendJson(res, 200, { ok: true, prompts: listPrompts() });
  if (req.method === 'POST' && url.pathname === '/api/prompts') return sendJson(res, 200, { ok: true, prompt: createPrompt(await readBody(req)) });
  const promptUpdate = url.pathname.match(/^\/api\/prompts\/([^/]+)$/);
  if (promptUpdate && req.method === 'PUT') return sendJson(res, 200, { ok: true, prompt: updatePrompt(promptUpdate[1], await readBody(req)) });
  const promptActivate = url.pathname.match(/^\/api\/prompts\/([^/]+)\/activate$/);
  if (promptActivate && req.method === 'POST') return sendJson(res, 200, { ok: true, prompt: activatePrompt(promptActivate[1]) });
  if (req.method === 'GET' && url.pathname === '/api/runs') return sendJson(res, 200, { ok: true, runs: listRuns(Number(url.searchParams.get('limit') || 50)) });
  if (req.method === 'POST' && url.pathname === '/api/run') {
    const body = await readBody(req);
    const mode = body.mode === 'publish' ? 'publish' : 'dry-run';
    return sendJson(res, 200, { ok: true, run: await runOnce(mode, { trigger: 'web' }) });
  }
  if (req.method === 'POST' && url.pathname === '/api/market-pack') return sendJson(res, 200, { ok: true, pack: await buildMarketPack() });
  notFound(res);
}

function serveStatic(req, res, url) {
  let file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  if (file.includes('..')) return notFound(res);
  const full = path.join(config.root, 'web', file);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return notFound(res);
  const ext = path.extname(full).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error('[request]', req.method, url.pathname, err);
    sendJson(res, 500, { ok: false, error: err.message || String(err) });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[server] http://${config.host}:${config.port}`);
  console.log(`[server] auth ${config.adminToken ? 'enabled' : 'disabled'}`);
});
startScheduler();
