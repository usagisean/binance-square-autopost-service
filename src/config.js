const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();
fs.mkdirSync(DATA_DIR, { recursive: true });

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  host: env('HOST', '127.0.0.1'),
  port: envNumber('PORT', 8787),
  publicBaseUrl: env('PUBLIC_BASE_URL', 'http://127.0.0.1:8787'),
  adminToken: env('ADMIN_TOKEN', ''),
  llmProvider: env('LLM_PROVIDER', 'mock').toLowerCase(),
  openaiBaseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
  openaiApiKey: env('OPENAI_API_KEY', ''),
  openaiModel: env('OPENAI_MODEL', 'gpt-4.1-mini'),
  openaiTemperature: envNumber('OPENAI_TEMPERATURE', 0.8),
  openaiMaxTokens: envNumber('OPENAI_MAX_TOKENS', 180),
  openaiTimeoutMs: envNumber('OPENAI_TIMEOUT_MS', 45000),
  binanceSquareOpenApiKey: env('BINANCE_SQUARE_OPENAPI_KEY', ''),
  telegramBotToken: env('TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: env('TELEGRAM_CHAT_ID', ''),
  httpsProxy: env('HTTPS_PROXY', env('https_proxy', '')),
  httpProxy: env('HTTP_PROXY', env('http_proxy', '')),
  noProxy: env('NO_PROXY', env('no_proxy', 'localhost,127.0.0.1,::1'))
};

function masked(value) {
  if (!value) return '';
  if (value.length <= 10) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

module.exports = { config, ROOT, DATA_DIR, masked, loadDotEnv };
