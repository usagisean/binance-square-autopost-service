const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, config } = require('./config');

const paths = {
  settings: path.join(DATA_DIR, 'settings.json'),
  prompts: path.join(DATA_DIR, 'prompts.json'),
  runs: path.join(DATA_DIR, 'runs.jsonl'),
  counter: path.join(DATA_DIR, 'daily_counter.json'),
  cache: path.join(DATA_DIR, 'market_pack_cache.json'),
  scheduler: path.join(DATA_DIR, 'scheduler_state.json'),
  secrets: path.join(DATA_DIR, 'secrets.json')
};

const defaultSettings = {
  enabled: false,
  intervalMinutes: 20,
  maxDailyPosts: 100,
  timezone: 'Asia/Shanghai',
  minPostChars: 55,
  maxPostChars: 110,
  bannedSymbols: ['MON'],
  minSpotQuoteVolume: 5000000,
  marketCacheMaxAgeMinutes: 360,
  requireCashtags: true,
  notifyTelegram: true,
  llmProvider: config.llmProvider,
  openaiBaseUrl: config.openaiBaseUrl,
  openaiModel: config.openaiModel,
  openaiTemperature: config.openaiTemperature,
  openaiMaxTokens: config.openaiMaxTokens,
  openaiTimeoutMs: config.openaiTimeoutMs
};

const defaultPrompt = `你是一位长期盯盘的中文加密货币交易员。请基于真实行情数据写一条 Binance Square 短帖。\n\n要求：\n- 必须自然提到 {{LEAD}}, {{PEER}}, {{ANCHOR}} 三个币种，并使用 Cashtag：${'{{LEAD_CASHTAG}}'} ${'{{PEER_CASHTAG}}'} ${'{{ANCHOR_CASHTAG}}'}\n- 55 到 110 个中文字符，短句，有交易员视角。\n- 不要标题，不要项目符号，不要“不是投资建议”。\n- 不要编造 facts 之外的信息。\n- 写出谁更强、谁只是跟随、谁是情绪锚，但要像真人盘中表达。\n\n行情 facts：\n{{FACTS}}\n\n交易解读：\n{{TAKEAWAYS}}`;

function nowIso() { return new Date().toISOString(); }
function id(prefix = '') { return `${prefix}${crypto.randomUUID()}`; }

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function initStore() {
  if (!fs.existsSync(paths.settings)) writeJson(paths.settings, defaultSettings);
  if (!fs.existsSync(paths.prompts)) {
    const p = { id: id('prompt_'), name: '默认短帖 Prompt', content: defaultPrompt, active: true, createdAt: nowIso(), updatedAt: nowIso() };
    writeJson(paths.prompts, [p]);
  }
  if (!fs.existsSync(paths.runs)) fs.writeFileSync(paths.runs, '');
}

function getSettings() {
  return { ...defaultSettings, ...readJson(paths.settings, {}) };
}

function saveSettings(patch) {
  const next = { ...getSettings(), ...patch, updatedAt: nowIso() };
  next.intervalMinutes = Math.max(1, Number(next.intervalMinutes || defaultSettings.intervalMinutes));
  next.maxDailyPosts = Math.max(1, Number(next.maxDailyPosts || defaultSettings.maxDailyPosts));
  next.minPostChars = Math.max(1, Number(next.minPostChars || defaultSettings.minPostChars));
  next.maxPostChars = Math.max(next.minPostChars, Number(next.maxPostChars || defaultSettings.maxPostChars));
  next.openaiBaseUrl = String(next.openaiBaseUrl || defaultSettings.openaiBaseUrl).replace(/\/+$/, '');
  next.openaiModel = String(next.openaiModel || defaultSettings.openaiModel).trim();
  next.openaiTemperature = Math.max(0, Math.min(2, Number(next.openaiTemperature ?? defaultSettings.openaiTemperature)));
  next.openaiMaxTokens = Math.max(1, Number(next.openaiMaxTokens || defaultSettings.openaiMaxTokens));
  next.openaiTimeoutMs = Math.max(5000, Number(next.openaiTimeoutMs || defaultSettings.openaiTimeoutMs));
  if (!Array.isArray(next.bannedSymbols)) {
    next.bannedSymbols = String(next.bannedSymbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  writeJson(paths.settings, next);
  return next;
}

function getSecrets() {
  const local = readJson(paths.secrets, {});
  return {
    openaiApiKey: local.openaiApiKey || config.openaiApiKey || '',
    binanceSquareOpenApiKey: local.binanceSquareOpenApiKey || config.binanceSquareOpenApiKey || '',
    telegramBotToken: local.telegramBotToken || config.telegramBotToken || '',
    telegramChatId: local.telegramChatId || config.telegramChatId || ''
  };
}

function saveSecrets(patch = {}) {
  const current = readJson(paths.secrets, {});
  const next = { ...current };
  for (const key of ['openaiApiKey', 'binanceSquareOpenApiKey', 'telegramBotToken', 'telegramChatId']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      const value = String(patch[key] || '').trim();
      if (value) next[key] = value;
    }
  }
  next.updatedAt = nowIso();
  writeJson(paths.secrets, next);
  return getSecrets();
}

function listPrompts() {
  return readJson(paths.prompts, []);
}

function getActivePrompt() {
  const prompts = listPrompts();
  return prompts.find(p => p.active) || prompts[0] || null;
}

function createPrompt({ name, content, active = false }) {
  const prompts = listPrompts();
  const p = { id: id('prompt_'), name: name || `Prompt ${prompts.length + 1}`, content: content || defaultPrompt, active: !!active, createdAt: nowIso(), updatedAt: nowIso() };
  if (p.active) prompts.forEach(x => x.active = false);
  prompts.unshift(p);
  writeJson(paths.prompts, prompts);
  return p;
}

function updatePrompt(promptId, patch) {
  const prompts = listPrompts();
  const idx = prompts.findIndex(p => p.id === promptId);
  if (idx === -1) throw new Error('prompt_not_found');
  prompts[idx] = { ...prompts[idx], ...patch, id: prompts[idx].id, updatedAt: nowIso() };
  writeJson(paths.prompts, prompts);
  return prompts[idx];
}

function activatePrompt(promptId) {
  const prompts = listPrompts();
  if (!prompts.some(p => p.id === promptId)) throw new Error('prompt_not_found');
  prompts.forEach(p => { p.active = p.id === promptId; p.updatedAt = p.active ? nowIso() : p.updatedAt; });
  writeJson(paths.prompts, prompts);
  return prompts.find(p => p.id === promptId);
}

function appendRun(run) {
  const row = { id: run.id || id('run_'), createdAt: nowIso(), ...run };
  fs.appendFileSync(paths.runs, JSON.stringify(row) + '\n');
  return row;
}

function listRuns(limit = 50) {
  if (!fs.existsSync(paths.runs)) return [];
  const lines = fs.readFileSync(paths.runs, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).reverse().map(line => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });
}

function shanghaiDateString(d = new Date(), tz = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function getCounter(settings = getSettings()) {
  const today = shanghaiDateString(new Date(), settings.timezone);
  const state = readJson(paths.counter, { date: today, count: 0, posts: [] });
  if (state.date !== today) return { date: today, count: 0, posts: [] };
  return { date: today, count: Number(state.count || 0), posts: Array.isArray(state.posts) ? state.posts : [] };
}

function incrementCounter({ url = '', symbol = '' } = {}, settings = getSettings()) {
  const state = getCounter(settings);
  state.count += 1;
  state.posts.unshift({ ts: nowIso(), url, symbol });
  state.posts = state.posts.slice(0, 50);
  writeJson(paths.counter, state);
  return state;
}

function saveMarketCache(pack) {
  writeJson(paths.cache, { savedAt: Date.now(), pack });
}

function loadMarketCache(maxAgeMinutes = 360) {
  const raw = readJson(paths.cache, null);
  if (!raw?.savedAt || !raw?.pack) return null;
  if (Date.now() - Number(raw.savedAt) > maxAgeMinutes * 60 * 1000) return null;
  return raw;
}

function getSchedulerState() {
  return readJson(paths.scheduler, { lastRunAt: null, nextRunAt: null, running: false });
}

function saveSchedulerState(patch) {
  const next = { ...getSchedulerState(), ...patch, updatedAt: nowIso() };
  writeJson(paths.scheduler, next);
  return next;
}

module.exports = {
  paths,
  initStore,
  getSettings,
  saveSettings,
  getSecrets,
  saveSecrets,
  listPrompts,
  getActivePrompt,
  createPrompt,
  updatePrompt,
  activatePrompt,
  appendRun,
  listRuns,
  shanghaiDateString,
  getCounter,
  incrementCounter,
  saveMarketCache,
  loadMarketCache,
  getSchedulerState,
  saveSchedulerState,
  nowIso
};
