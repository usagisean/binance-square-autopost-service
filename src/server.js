const http = require('http');
const fs = require('fs');
const path = require('path');
const { config, masked } = require('./config');
const { initStore, getSettings, saveSettings, getSecrets, saveSecrets, getLlmConfig, saveLlmConfig, setLlmChannelModels, getIntelConfig, saveIntelConfig, listPrompts, createPrompt, updatePrompt, activatePrompt, getCounter, listRuns } = require('./store');
const { schedulerStatus, startScheduler } = require('./scheduler');
const { runOnce } = require('./workflow');
const { buildMarketPack } = require('./marketPack');
const { publisherStatus } = require('./publisher');
const { getJson } = require('./httpClient');
const { callOpenAIWithCandidate, effectiveMaxTokens } = require('./generator');
const { sendTelegram } = require('./telegram');
const { listImageAssets, saveImageAsset, deleteImageAsset, assetPath, contentTypeFor, MAX_IMAGE_BYTES } = require('./imageAssets');

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
function readRawBody(req, maxBytes = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) return reject(new Error('body_too_large'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function splitBuffer(buffer, separator) {
  const out = [];
  let start = 0;
  let idx = buffer.indexOf(separator, start);
  while (idx !== -1) {
    out.push(buffer.slice(start, idx));
    start = idx + separator.length;
    idx = buffer.indexOf(separator, start);
  }
  out.push(buffer.slice(start));
  return out;
}
function trimCrlf(buffer) {
  let start = 0;
  let end = buffer.length;
  while (buffer[start] === 13 || buffer[start] === 10) start++;
  while (end > start && (buffer[end - 1] === 13 || buffer[end - 1] === 10)) end--;
  return buffer.slice(start, end);
}
function parseMultipartFiles(buffer, contentType = '') {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error('missing_multipart_boundary');
  const boundary = match[1] || match[2];
  const parts = splitBuffer(buffer, Buffer.from(`--${boundary}`));
  const files = [];
  for (let part of parts) {
    part = trimCrlf(part);
    if (!part.length || part.equals(Buffer.from('--'))) continue;
    if (part.slice(0, 2).toString() === '--') continue;
    const sep = Buffer.from('\r\n\r\n');
    const headerEnd = part.indexOf(sep);
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd).toString('utf8');
    const body = trimCrlf(part.slice(headerEnd + sep.length));
    const filename = (headerText.match(/filename="([^"]*)"/i) || [])[1];
    if (!filename) continue;
    files.push({ filename, buffer: body });
  }
  return files;
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

function extractModelIds(modelsPayload) {
  const raw = Array.isArray(modelsPayload?.data) ? modelsPayload.data
    : Array.isArray(modelsPayload?.models) ? modelsPayload.models
    : Array.isArray(modelsPayload) ? modelsPayload
    : [];
  const seen = new Set();
  return raw.map(m => String(typeof m === 'string' ? m : (m?.id || m?.name || m?.model || '')).trim())
    .filter(id => id && !seen.has(id) && seen.add(id))
    .sort((a, b) => a.localeCompare(b));
}

function findLlmChannel(channelId) {
  const cfg = getLlmConfig({ revealKeys: true });
  const channel = cfg.channels.find(ch => ch.id === channelId);
  if (!channel) throw new Error('llm_channel_not_found');
  return { cfg, channel };
}

function maskedSecrets({ reveal = false } = {}) {
  const secrets = getSecrets();
  return {
    openaiApiKey: reveal ? secrets.openaiApiKey : masked(secrets.openaiApiKey),
    binanceSquareOpenApiKey: reveal ? secrets.binanceSquareOpenApiKey : masked(secrets.binanceSquareOpenApiKey),
    telegramBotToken: reveal ? secrets.telegramBotToken : masked(secrets.telegramBotToken),
    telegramChatId: reveal ? secrets.telegramChatId : (secrets.telegramChatId ? 'configured' : ''),
    telegramConfigured: !!(secrets.telegramBotToken && secrets.telegramChatId)
  };
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    if (config.adminToken && !authorized(req)) {
      return sendJson(res, 200, {
        ok: true,
        app: 'binance-square-autopost-service',
        time: new Date().toISOString(),
        authRequired: true,
        authenticated: false
      });
    }
    const llmConfig = getLlmConfig({ revealKeys: false });
    const intelConfig = getIntelConfig({ revealKeys: false });
    const llmConfigured = llmConfig.channels.some(ch => ch.enabled && ch.hasApiKey && (ch.models || []).some(m => m.enabled !== false));
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
        apiKey: masked(getSecrets().openaiApiKey),
        configured: llmConfigured || !!getSecrets().openaiApiKey,
        channels: llmConfig.channels.map(ch => ({
          id: ch.id,
          name: ch.name,
          baseUrl: ch.baseUrl,
          enabled: ch.enabled,
          priority: ch.priority,
          apiMode: ch.apiMode || 'auto',
          reasoning: ch.reasoning === true,
          hasApiKey: ch.hasApiKey,
          apiKeyMasked: ch.apiKeyMasked,
          modelCount: (ch.models || []).length,
          activeModels: (ch.models || []).filter(m => m.enabled !== false).slice(0, 10).map(m => m.id)
        })),
        maxFallbackModels: llmConfig.maxFallbackModels
      },
      intel: {
        enabled: intelConfig.enabled,
        newsCount: (intelConfig.newsRssUrls || []).filter(x => x.enabled !== false).length,
        kolCount: (intelConfig.kolSources || []).filter(x => x.enabled !== false).length,
        hasCoinglassApiKey: !!intelConfig.hasCoinglassApiKey,
        onchainKeyCount: Object.values(intelConfig.onchainApiKeys || {}).filter(Boolean).length,
        hasMacroNotes: !!intelConfig.macroNotes
      },
      secrets: maskedSecrets(),
      authRequired: !!config.adminToken,
      authenticated: true
    });
  }
  if (!requireAuth(req, res)) return;
  if (req.method === 'GET' && url.pathname === '/api/images') {
    return sendJson(res, 200, { ok: true, images: listImageAssets() });
  }
  if (req.method === 'POST' && url.pathname === '/api/images') {
    const raw = await readRawBody(req, 4 * MAX_IMAGE_BYTES + 1024 * 1024);
    const contentType = req.headers['content-type'] || '';
    let files = [];
    if (/multipart\/form-data/i.test(contentType)) {
      files = parseMultipartFiles(raw, contentType);
    } else {
      const body = JSON.parse(raw.toString('utf8') || '{}');
      if (body.filename && body.dataBase64) files = [{ filename: body.filename, buffer: Buffer.from(String(body.dataBase64), 'base64') }];
    }
    if (!files.length) throw new Error('no_image_files');
    const saved = files.slice(0, 8).map(f => saveImageAsset(f.filename, f.buffer));
    return sendJson(res, 200, { ok: true, images: saved, allImages: listImageAssets() });
  }
  const imageFile = url.pathname.match(/^\/api\/images\/([^/]+)\/file$/);
  if (imageFile && req.method === 'GET') {
    const filename = decodeURIComponent(imageFile[1]);
    const file = assetPath(filename);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return notFound(res);
    res.writeHead(200, { 'Content-Type': contentTypeFor(filename), 'Cache-Control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }
  const imageDelete = url.pathname.match(/^\/api\/images\/([^/]+)$/);
  if (imageDelete && req.method === 'DELETE') {
    return sendJson(res, 200, { ok: true, deleted: deleteImageAsset(decodeURIComponent(imageDelete[1])), images: listImageAssets() });
  }
  if (req.method === 'GET' && url.pathname === '/api/settings') return sendJson(res, 200, { ok: true, settings: getSettings() });
  if (req.method === 'PUT' && url.pathname === '/api/settings') return sendJson(res, 200, { ok: true, settings: saveSettings(await readBody(req)) });
  if (req.method === 'GET' && url.pathname === '/api/secrets') return sendJson(res, 200, { ok: true, secrets: maskedSecrets({ reveal: url.searchParams.get('reveal') === '1' }) });
  if (req.method === 'PUT' && url.pathname === '/api/secrets') {
    saveSecrets(await readBody(req));
    return sendJson(res, 200, { ok: true, secrets: maskedSecrets({ reveal: true }) });
  }
  if (req.method === 'POST' && url.pathname === '/api/telegram/test') {
    const result = await sendTelegram(`✅ Binance Square Autopost Telegram 测试成功\n时间：${new Date().toISOString()}`);
    return sendJson(res, 200, { ok: true, telegram: result });
  }
  if (req.method === 'GET' && url.pathname === '/api/llm-config') {
    const revealKeys = url.searchParams.get('reveal') === '1';
    return sendJson(res, 200, { ok: true, llmConfig: getLlmConfig({ revealKeys }) });
  }
  if (req.method === 'PUT' && url.pathname === '/api/llm-config') {
    const body = await readBody(req);
    return sendJson(res, 200, { ok: true, llmConfig: saveLlmConfig(body.llmConfig || body) });
  }
  if (req.method === 'GET' && url.pathname === '/api/intel-config') {
    const revealKeys = url.searchParams.get('reveal') === '1';
    return sendJson(res, 200, { ok: true, intelConfig: getIntelConfig({ revealKeys }) });
  }
  if (req.method === 'PUT' && url.pathname === '/api/intel-config') {
    const body = await readBody(req);
    return sendJson(res, 200, { ok: true, intelConfig: saveIntelConfig(body.intelConfig || body) });
  }
  const llmModelFetch = url.pathname.match(/^\/api\/llm-config\/channels\/([^/]+)\/models\/fetch$/);
  if (llmModelFetch && req.method === 'POST') {
    const channelId = decodeURIComponent(llmModelFetch[1]);
    const { channel } = findLlmChannel(channelId);
    if (!channel.baseUrl) throw new Error('missing_llm_base_url');
    if (!channel.apiKey) throw new Error('missing_llm_api_key');
    const modelsPayload = await getJson(`${channel.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${channel.apiKey}` },
      timeoutMs: Number(channel.timeoutMs || 45000)
    });
    const fetchedIds = extractModelIds(modelsPayload);
    const fetched = new Set(fetchedIds);
    const existingIds = (channel.models || []).map(m => m.id).filter(Boolean);
    const mergedIds = [
      ...existingIds.filter(id => fetched.has(id)),
      ...fetchedIds.filter(id => !existingIds.includes(id))
    ];
    const updated = setLlmChannelModels(channelId, mergedIds.map((modelId, idx) => ({ id: modelId, priority: idx + 1, enabled: true })));
    return sendJson(res, 200, { ok: true, fetchedModels: fetchedIds, llmConfig: updated });
  }
  if (req.method === 'POST' && url.pathname === '/api/llm-config/test') {
    const body = await readBody(req);
    const { channel } = findLlmChannel(String(body.channelId || ''));
    const model = String(body.model || channel.models?.find(m => m.enabled !== false)?.id || '').trim();
    if (!model) throw new Error('missing_llm_model');
    const startedAt = Date.now();
    const fallbackEnabled = body.fallback !== false;
    const modelIds = [model];
    if (fallbackEnabled) {
      for (const m of (channel.models || []).filter(m => m.enabled !== false).sort((a, b) => Number(a.priority || 1) - Number(b.priority || 1))) {
        const id = String(m.id || '').trim();
        if (id && !modelIds.includes(id)) modelIds.push(id);
      }
    }
    const attempts = [];
    for (const modelId of modelIds.slice(0, 10)) {
      const candidate = {
        channelId: channel.id,
        channelName: channel.name,
        apiKey: channel.apiKey,
        baseUrl: channel.baseUrl,
        model: modelId,
        temperature: channel.temperature,
        maxTokens: Number(channel.maxTokens || 512),
        timeoutMs: channel.timeoutMs,
        apiMode: channel.apiMode || 'auto',
        reasoning: channel.reasoning === true
      };
      try {
        const text = await callOpenAIWithCandidate('请只回复“连接正常”四个字。', candidate);
        attempts.push({ model: modelId, ok: true, apiMode: candidate.apiMode, maxTokensUsed: effectiveMaxTokens(candidate) });
        return sendJson(res, 200, { ok: true, channelId: channel.id, channelName: channel.name, apiMode: candidate.apiMode, model: modelId, requestedModel: model, fallbackUsed: modelId !== model, durationMs: Date.now() - startedAt, maxTokensUsed: effectiveMaxTokens(candidate), text, attempts });
      } catch (err) {
        attempts.push({ model: modelId, ok: false, apiMode: candidate.apiMode, maxTokensUsed: effectiveMaxTokens(candidate), error: err.message || String(err) });
      }
    }
    throw new Error(`llm_test_all_models_failed:${attempts.map(a => `${a.model}:${a.error}`).join(' | ')}`);
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
