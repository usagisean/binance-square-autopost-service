const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, ROOT, config } = require('./config');

const paths = {
  settings: path.join(DATA_DIR, 'settings.json'),
  prompts: path.join(DATA_DIR, 'prompts.json'),
  runs: path.join(DATA_DIR, 'runs.jsonl'),
  counter: path.join(DATA_DIR, 'daily_counter.json'),
  cache: path.join(DATA_DIR, 'market_pack_cache.json'),
  scheduler: path.join(DATA_DIR, 'scheduler_state.json'),
  secrets: path.join(DATA_DIR, 'secrets.json'),
  llmConfig: path.join(DATA_DIR, 'llm_config.json'),
  intelConfig: path.join(DATA_DIR, 'intel_config.json')
};

const defaultSettings = {
  jobName: process.env.JOB_NAME || 'Binance Square Market Autopost',
  jobDescription: process.env.JOB_DESCRIPTION || '基于真实 Binance 行情，生成有交易员视角的中文短帖。',
  language: process.env.POST_LANGUAGE || 'zh-CN',
  styleGuide: process.env.STYLE_GUIDE || '短句、克制、有交易感；不要报告腔、模板腔、喊单腔。',
  contentSource: process.env.CONTENT_SOURCE || 'binance-market-pack',
  postTarget: process.env.POST_TARGET || 'binance-square',
  enabled: false,
  publishMode: config.publishMode === 'live' ? 'live' : 'preview',
  intervalMinutes: 20,
  maxDailyPosts: 100,
  timezone: 'Asia/Shanghai',
  minPostChars: 180,
  maxPostChars: 360,
  bannedSymbols: ['MON'],
  minSpotQuoteVolume: 5000000,
  marketCacheMaxAgeMinutes: 360,
  requireCashtags: true,
  notifyTelegram: true,
  leadCooldownRuns: 3,
  leadCooldownMinutes: 180,
  maxConsecutiveFailures: 3,
  similarityThreshold: 0.72,
  bannedPhrases: ['主动腿', '拧巴', '玄学', '抽象', '离谱', '绷不住', '上头', '杀疯了', '起飞', '爆拉', '闭眼', '梭哈', '铁子', '兄弟们'],
  includeTradePlan: true,
  tradePlanMode: 'conditional',
  preferSquareTagSymbols: true,
  squareTagSymbols: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'PEPE', 'WIF', 'BONK', 'PENGU', 'BABY', 'SUI', 'ENA', 'LINK', 'AAVE', 'AVAX', 'ADA', 'ZEC'],
  llmProvider: config.llmProvider,
  openaiBaseUrl: config.openaiBaseUrl,
  openaiModel: config.openaiModel,
  openaiTemperature: config.openaiTemperature,
  openaiMaxTokens: config.openaiMaxTokens,
  openaiTimeoutMs: config.openaiTimeoutMs
};

function loadDefaultPrompt() {
  const promptPath = process.env.DEFAULT_PROMPT_FILE || path.join(ROOT, 'templates', 'default-prompt.md');
  try {
    return fs.readFileSync(promptPath, 'utf8').trim();
  } catch {
    return `你正在执行「{{JOB_NAME}}」这个自动发帖任务。请基于 {{FACTS}} 和 {{TAKEAWAYS}} 写一条包含 {{LEAD_CASHTAG}} {{PEER_CASHTAG}} {{ANCHOR_CASHTAG}} 的短帖。`;
  }
}
const defaultPrompt = loadDefaultPrompt();

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
  next.publishMode = String(next.publishMode || 'preview').toLowerCase() === 'live' ? 'live' : 'preview';
  next.jobName = String(next.jobName || defaultSettings.jobName).trim();
  next.jobDescription = String(next.jobDescription || defaultSettings.jobDescription).trim();
  next.language = String(next.language || defaultSettings.language).trim();
  next.styleGuide = String(next.styleGuide || defaultSettings.styleGuide).trim();
  next.contentSource = String(next.contentSource || defaultSettings.contentSource).trim();
  next.postTarget = String(next.postTarget || defaultSettings.postTarget).trim();
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
  } else {
    next.bannedSymbols = next.bannedSymbols.map(s => String(s).trim().toUpperCase()).filter(Boolean);
  }
  next.leadCooldownRuns = Math.max(0, Number(next.leadCooldownRuns ?? defaultSettings.leadCooldownRuns));
  next.leadCooldownMinutes = Math.max(0, Number(next.leadCooldownMinutes ?? defaultSettings.leadCooldownMinutes));
  next.maxConsecutiveFailures = Math.max(0, Number(next.maxConsecutiveFailures ?? defaultSettings.maxConsecutiveFailures));
  next.similarityThreshold = Math.max(0, Math.min(1, Number(next.similarityThreshold ?? defaultSettings.similarityThreshold)));
  next.includeTradePlan = next.includeTradePlan !== false;
  next.tradePlanMode = ['conditional', 'levels', 'off'].includes(String(next.tradePlanMode || '').toLowerCase()) ? String(next.tradePlanMode).toLowerCase() : defaultSettings.tradePlanMode;
  next.preferSquareTagSymbols = next.preferSquareTagSymbols !== false;
  if (!Array.isArray(next.bannedPhrases)) {
    next.bannedPhrases = String(next.bannedPhrases || '').split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
  } else {
    next.bannedPhrases = next.bannedPhrases.map(s => String(s).trim()).filter(Boolean);
  }
  if (!Array.isArray(next.squareTagSymbols)) {
    next.squareTagSymbols = String(next.squareTagSymbols || '').split(/\r?\n|,/).map(s => s.trim().toUpperCase()).filter(Boolean);
  } else {
    next.squareTagSymbols = next.squareTagSymbols.map(s => String(s).trim().toUpperCase()).filter(Boolean);
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


function normalizeModelId(value = '') {
  return String(value || '').trim().replace(/[‐‑‒–—―−]/g, '-');
}

function normalizeApiMode(value = 'auto') {
  const v = String(value || 'auto').trim().toLowerCase().replace(/_/g, '-');
  if (['auto', 'chat', 'completions', 'responses'].includes(v)) return v;
  if (['chat-completions', 'openai-completions', 'openai-chat-completions'].includes(v)) return 'chat';
  if (['legacy', 'legacy-completions', 'text-completions', 'openai-legacy-completions'].includes(v)) return 'completions';
  return 'auto';
}

function normalizeModelList(models = []) {
  const seen = new Set();
  return (Array.isArray(models) ? models : String(models || '').split(/\r?\n|,/))
    .map((m, idx) => typeof m === 'string' ? { id: m, priority: idx + 1, enabled: true } : m)
    .map((m, idx) => ({
      id: normalizeModelId(m?.id || m?.name || ''),
      priority: Math.max(1, Number(m?.priority || idx + 1)),
      enabled: m?.enabled !== false
    }))
    .filter(m => m.id && !seen.has(m.id) && seen.add(m.id))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 50);
}

function defaultLlmConfig() {
  const secrets = getSecrets();
  return {
    channels: [{
      id: 'primary',
      name: 'Primary OpenAI-compatible',
      baseUrl: config.openaiBaseUrl,
      apiKey: secrets.openaiApiKey || config.openaiApiKey || '',
      enabled: true,
      priority: 1,
      apiMode: 'auto',
      reasoning: false,
      temperature: config.openaiTemperature,
      maxTokens: config.openaiMaxTokens,
      timeoutMs: config.openaiTimeoutMs,
      models: normalizeModelList([{ id: config.openaiModel, priority: 1, enabled: true }]),
      updatedAt: nowIso()
    }],
    maxFallbackModels: 10,
    updatedAt: nowIso()
  };
}

function normalizeLlmConfig(raw = {}) {
  const fallback = defaultLlmConfig();
  const seenChannelIds = new Set();
  const channels = (Array.isArray(raw.channels) && raw.channels.length ? raw.channels : fallback.channels).map((ch, idx) => {
    let channelId = String(ch.id || `channel_${idx + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, '_') || `channel_${idx + 1}`;
    if (seenChannelIds.has(channelId)) channelId = `${channelId}_${idx + 1}`;
    seenChannelIds.add(channelId);
    return {
      id: channelId,
      name: String(ch.name || ch.id || `Channel ${idx + 1}`).trim(),
      baseUrl: String(ch.baseUrl || config.openaiBaseUrl).trim().replace(/\/+$/, ''),
      apiKey: String(ch.apiKey || '').trim(),
      enabled: ch.enabled !== false,
      priority: Math.max(1, Number(ch.priority || idx + 1)),
      apiMode: normalizeApiMode(ch.apiMode || ch.api || 'auto'),
      reasoning: ch.reasoning === true,
      temperature: Math.max(0, Math.min(2, Number(ch.temperature ?? config.openaiTemperature))),
      maxTokens: Math.max(1, Number(ch.maxTokens || config.openaiMaxTokens)),
      timeoutMs: Math.max(5000, Number(ch.timeoutMs || config.openaiTimeoutMs)),
      models: normalizeModelList(ch.models),
      updatedAt: ch.updatedAt || nowIso()
    };
  }).sort((a, b) => a.priority - b.priority);
  return {
    channels,
    maxFallbackModels: Math.max(1, Math.min(10, Number(raw.maxFallbackModels || 10))),
    updatedAt: raw.updatedAt || nowIso()
  };
}

function getLlmConfig({ revealKeys = false } = {}) {
  const cfg = normalizeLlmConfig(readJson(paths.llmConfig, null) || defaultLlmConfig());
  return {
    ...cfg,
    channels: cfg.channels.map(ch => ({
      ...ch,
      apiKey: revealKeys ? ch.apiKey : '',
      apiKeyMasked: ch.apiKey ? (ch.apiKey.length <= 10 ? `${ch.apiKey.slice(0, 2)}...${ch.apiKey.slice(-2)}` : `${ch.apiKey.slice(0, 5)}...${ch.apiKey.slice(-4)}`) : '',
      hasApiKey: !!ch.apiKey
    }))
  };
}

function saveLlmConfig(next = {}) {
  const current = normalizeLlmConfig(readJson(paths.llmConfig, null) || defaultLlmConfig());
  const currentById = new Map(current.channels.map(ch => [ch.id, ch]));
  const incoming = Array.isArray(next.channels) ? next.channels.map((ch, idx) => {
    const rawId = String(ch?.id || `channel_${idx + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, '_') || `channel_${idx + 1}`;
    const previous = currentById.get(rawId);
    const hasNewKey = Object.prototype.hasOwnProperty.call(ch || {}, 'apiKey') && String(ch.apiKey || '').trim();
    const clearKey = ch?.clearApiKey === true;
    return {
      ...ch,
      id: rawId,
      apiKey: clearKey ? '' : (hasNewKey ? String(ch.apiKey || '').trim() : (previous?.apiKey || ''))
    };
  }) : current.channels;
  const cfg = normalizeLlmConfig({ ...next, channels: incoming, updatedAt: nowIso() });
  writeJson(paths.llmConfig, cfg);
  return getLlmConfig({ revealKeys: true });
}

function setLlmChannelModels(channelId, models = []) {
  const cfg = normalizeLlmConfig(readJson(paths.llmConfig, null) || defaultLlmConfig());
  const idx = cfg.channels.findIndex(ch => ch.id === channelId);
  if (idx === -1) throw new Error('llm_channel_not_found');
  cfg.channels[idx].models = normalizeModelList(models);
  cfg.channels[idx].updatedAt = nowIso();
  cfg.updatedAt = nowIso();
  writeJson(paths.llmConfig, cfg);
  return getLlmConfig({ revealKeys: true });
}

function getLlmCandidates() {
  const cfg = normalizeLlmConfig(readJson(paths.llmConfig, null) || defaultLlmConfig());
  const candidates = [];
  for (const channel of cfg.channels.filter(ch => ch.enabled).sort((a, b) => a.priority - b.priority)) {
    for (const model of normalizeModelList(channel.models).filter(m => m.enabled).sort((a, b) => a.priority - b.priority)) {
      if (!channel.apiKey || !channel.baseUrl || !model.id) continue;
      candidates.push({
        channelId: channel.id,
        channelName: channel.name,
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        model: model.id,
        temperature: channel.temperature,
        maxTokens: channel.maxTokens,
        timeoutMs: channel.timeoutMs,
        apiMode: channel.apiMode || 'auto',
        reasoning: channel.reasoning === true,
        channelPriority: channel.priority,
        modelPriority: model.priority
      });
      if (candidates.length >= cfg.maxFallbackModels) return candidates;
    }
  }
  return candidates;
}


function normalizeLines(value = []) {
  return (Array.isArray(value) ? value : String(value || '').split(/\r?\n/))
    .map(x => String(x || '').trim())
    .filter(Boolean);
}

function normalizeKeyedSources(value = []) {
  return (Array.isArray(value) ? value : []).map((item, idx) => ({
    id: String(item?.id || `source_${idx + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, '_') || `source_${idx + 1}`,
    name: String(item?.name || item?.id || `Source ${idx + 1}`).trim(),
    value: String(item?.value || item?.url || item?.handle || '').trim(),
    enabled: item?.enabled !== false,
    priority: Math.max(1, Number(item?.priority || idx + 1))
  })).filter(x => x.value).sort((a, b) => a.priority - b.priority).slice(0, 50);
}

function defaultIntelConfig() {
  return {
    enabled: false,
    newsRssUrls: [],
    kolSources: [],
    coinglassApiKey: '',
    onchainApiKeys: {},
    macroNotes: '',
    maxNewsItems: 8,
    maxKolItems: 8,
    updatedAt: nowIso()
  };
}

function normalizeIntelConfig(raw = {}) {
  const current = { ...defaultIntelConfig(), ...(raw || {}) };
  return {
    enabled: current.enabled === true,
    newsRssUrls: normalizeKeyedSources(current.newsRssUrls),
    kolSources: normalizeKeyedSources(current.kolSources),
    coinglassApiKey: String(current.coinglassApiKey || '').trim(),
    onchainApiKeys: typeof current.onchainApiKeys === 'object' && current.onchainApiKeys ? current.onchainApiKeys : {},
    macroNotes: String(current.macroNotes || '').trim(),
    maxNewsItems: Math.max(0, Math.min(30, Number(current.maxNewsItems || 8))),
    maxKolItems: Math.max(0, Math.min(30, Number(current.maxKolItems || 8))),
    updatedAt: current.updatedAt || nowIso()
  };
}

function getIntelConfig({ revealKeys = false } = {}) {
  const cfg = normalizeIntelConfig(readJson(paths.intelConfig, null) || defaultIntelConfig());
  return {
    ...cfg,
    coinglassApiKey: revealKeys ? cfg.coinglassApiKey : '',
    coinglassApiKeyMasked: cfg.coinglassApiKey ? (cfg.coinglassApiKey.length <= 10 ? `${cfg.coinglassApiKey.slice(0, 2)}...${cfg.coinglassApiKey.slice(-2)}` : `${cfg.coinglassApiKey.slice(0, 5)}...${cfg.coinglassApiKey.slice(-4)}`) : '',
    hasCoinglassApiKey: !!cfg.coinglassApiKey,
    onchainApiKeys: revealKeys ? cfg.onchainApiKeys : Object.fromEntries(Object.entries(cfg.onchainApiKeys || {}).map(([k, v]) => [k, v ? 'configured' : '']))
  };
}

function saveIntelConfig(next = {}) {
  const current = normalizeIntelConfig(readJson(paths.intelConfig, null) || defaultIntelConfig());
  const hasNewCoinglass = Object.prototype.hasOwnProperty.call(next || {}, 'coinglassApiKey') && String(next.coinglassApiKey || '').trim();
  const clearCoinglass = next?.clearCoinglassApiKey === true;
  const cfg = normalizeIntelConfig({
    ...current,
    ...next,
    coinglassApiKey: clearCoinglass ? '' : (hasNewCoinglass ? String(next.coinglassApiKey || '').trim() : current.coinglassApiKey),
    updatedAt: nowIso()
  });
  writeJson(paths.intelConfig, cfg);
  return getIntelConfig({ revealKeys: true });
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
  getLlmConfig,
  saveLlmConfig,
  setLlmChannelModels,
  getLlmCandidates,
  getIntelConfig,
  saveIntelConfig,
  normalizeModelId,
  normalizeApiMode,
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
