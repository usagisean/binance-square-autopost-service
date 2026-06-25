const { postJson, request } = require('./httpClient');
const { config } = require('./config');
const { getSettings, getActivePrompt, getSecrets, getLlmCandidates, listRuns } = require('./store');
const { ASSET_UNIVERSE, DEFAULT_BANNED_PHRASES } = require('./assetUniverse');

function cashtag(symbol) { return `$${String(symbol || '').replace(/^\$/, '').toUpperCase()}`; }
function compactText(text) {
  return String(text || '').replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').replace(/[“”]/g, '').trim();
}
function numeric(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function seededPick(items, seed = '') {
  if (!items.length) return null;
  let h = 0;
  for (const ch of String(seed || Date.now())) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  return items[Math.abs(h) % items.length];
}
function selectPostAngle(pack = {}) {
  const lead = pack.trio?.lead || {};
  const peer = pack.trio?.peer || {};
  const anchor = pack.trio?.anchor || {};
  const seed = `${pack.generatedAt || ''}:${lead.symbol || ''}:${peer.symbol || ''}:${anchor.symbol || ''}`;
  const lead1h = numeric(lead.change1h);
  const lead24h = numeric(lead.change24h);
  const anchor1h = numeric(anchor.change1h);
  const anchor24h = numeric(anchor.change24h);
  const aiSymbols = new Set(ASSET_UNIVERSE.crypto_ai);
  const stockAiStrongCryptoLag = /美股\s*AI.*(强|热).*币圈.*(弱|没跟|承接弱)|外部情绪.*承接没打开/.test(`${pack.stockTakeaways || ''} ${pack.aiTakeaways || ''}`);
  const options = [];
  if (stockAiStrongCryptoLag) options.push({ id: 'ai_stock_leads_crypto_lags', instruction: '如果写到 AI，只写美股 AI 热但币圈 AI 承接没打开；不要把正文写成美股复盘。' });
  if (aiSymbols.has(String(lead.symbol || '').toUpperCase()) && !/不足|缺失/.test(String(pack.aiTakeaways || ''))) options.push({ id: 'crypto_ai_confirmed', instruction: '主角是 AI 币时，只写它在 AI 币池内的强弱；美股/ETF只作情绪参照，缺数据就不要提。' });
  if (lead1h > 1.2 && (anchor1h < -0.1 || anchor24h < 0)) options.push({ id: 'btc_not_confirming', instruction: '主流币没配合，小币单独冲；第一句直接提示追高容错低，再写触发位或放弃条件。' });
  if (lead24h > 18 || Math.abs(lead1h) > 3) options.push({ id: 'chase_risk', instruction: '重点写追高风险：涨幅或波动已经很大，只给一个关键触发位和一个失效位，不要平均复盘。' });
  if (lead1h > 0.6 && lead24h > 0) options.push({ id: 'pullback_test', instruction: '重点写回踩承接：方向可以偏多，但不要喊买，只说站稳或回踩后的条件。' });
  if (['meme', 'contract-meme'].includes(lead.bucket) && lead1h < 0) options.push({ id: 'meme_heat_cooling', instruction: 'meme 情绪有降温迹象时，写不追或少碰；用 BTC/ETH 说明外部环境是否给空间。' });
  if (lead1h > 1 && numeric(peer.change1h) < 0) options.push({ id: 'beta_rotation', instruction: '写资金在高 beta 里切换，只围绕主角，不要把 peer 和 anchor 写成同等主角。' });
  const fallback = [
    { id: 'single_coin_decision', instruction: '只围绕一个主角写清楚：偏多、偏空或不碰；另外两个币只做一句参照。' },
    { id: 'no_trade_filter', instruction: '如果数据矛盾，第一句直接说这单不碰，再解释是盘口、承接还是主流币没配合。' },
    { id: 'level_trigger', instruction: '只给一个交易触发点和一个失效点；价位写成人能读懂的关键区，不要像程序计算结果。' }
  ];
  return seededPick(options.length ? options : fallback, seed);
}

function selectStyleCard(pack = {}) {
  const lead = pack.trio?.lead || {};
  const peer = pack.trio?.peer || {};
  const anchor = pack.trio?.anchor || {};
  const seed = `style:${pack.generatedAt || ''}:${lead.symbol || ''}:${peer.symbol || ''}:${anchor.symbol || ''}`;
  const lead1h = numeric(lead.change1h);
  const lead24h = numeric(lead.change24h);
  const anchor1h = numeric(anchor.change1h);
  const depthLine = String([...(pack.facts || []), ...(pack.takeaways || [])].join(' '));
  const options = [
    {
      id: 'street_note',
      instruction: '像盘中随手记一条：第一句先抛结论或疑问，不要以“这轮/这笔/现在/偏多/偏空/不追”开头；最多写 2 个数字。'
    },
    {
      id: 'trap_warning',
      instruction: '写成提醒别人别被表面涨跌骗：重点是“哪里容易追错”，不是完整复盘；交易位只写一句，别写成公式。'
    },
    {
      id: 'single_trigger',
      instruction: '只写一个触发位和一个放弃位；不要写“计划偏多/计划偏空/条件计划”，要像真人说“过不去我就不碰”。'
    },
    {
      id: 'relative_strength',
      instruction: '用强弱差讲主角为什么值得/不值得盯：peer 和 anchor 只能做陪衬，不要逐个报数据。'
    },
    {
      id: 'no_trade_has_value',
      instruction: '如果信号一般，就把“不做也是交易”写清楚：少给价位，多写为什么这笔没有赔率。'
    },
    {
      id: 'crowd_positioning',
      instruction: '写成筹码/拥挤视角：盘口、资金费率、OI 或振幅只挑一个关键证据；别写行情流水账。'
    },
    {
      id: 'short_commentary',
      instruction: '压短，像发给交易群的一段判断：结论 + 一个证据 + 一个动作。不要把 1h/4h/24h 都列出来。'
    }
  ];
  if (lead24h > 15 || Math.abs(lead1h) > 2.5) {
    options.unshift({
      id: 'late_move',
      instruction: '主角波动已经大，第一句写“这里最怕的不是错过，是追在别人兑现的位置”这类意思，但不要原句照抄；强调等待回踩或放弃。'
    });
  }
  if (anchor1h < 0 && lead1h > 0) {
    options.unshift({
      id: 'index_not_helping',
      instruction: '主流币没配合时，写小币单独硬拉的缺陷；不要喊单，核心是容错低。'
    });
  }
  if (/盘口|卖压|买盘|资金费率|持仓|OI|主动买卖比/.test(depthLine)) {
    options.unshift({
      id: 'microstructure',
      instruction: '优先写盘口/杠杆的一处异常，别从涨跌幅开头；把价位写成“过不去/跌回去/站不住”这种真人表达。'
    });
  }
  return seededPick(options, seed);
}

function formatTradePlanForPrompt(tradePlan = null) {
  if (!tradePlan) return '';
  const symbol = tradePlan.symbol || '';
  const bias = tradePlan.bias || (tradePlan.direction === 'short' ? '看跌' : tradePlan.direction === 'long' ? '看涨' : '观望');
  const parts = [`${symbol} 方向参考：${bias}`];
  if (tradePlan.direction === 'long') {
    if (tradePlan.trigger) parts.push(`强势触发看 ${tradePlan.trigger}`);
    if (tradePlan.entry) parts.push(`回踩参考 ${tradePlan.entry}`);
    if (tradePlan.invalidation || tradePlan.stopLoss) parts.push(`失效看 ${tradePlan.invalidation || tradePlan.stopLoss}`);
  } else if (tradePlan.direction === 'short') {
    if (tradePlan.trigger) parts.push(`转弱触发看 ${tradePlan.trigger}`);
    if (tradePlan.entry) parts.push(`反抽压力看 ${tradePlan.entry}`);
    if (tradePlan.invalidation || tradePlan.stopLoss) parts.push(`失效看 ${tradePlan.invalidation || tradePlan.stopLoss}`);
  } else {
    if (tradePlan.trigger) parts.push(`区间触发看 ${tradePlan.trigger}`);
    if (tradePlan.invalidation) parts.push(`区间参考 ${tradePlan.invalidation}`);
  }
  return `${parts.filter(Boolean).join('；')}。这是内部参考，正文不要原样照抄，不要写“计划偏多/计划偏空/条件计划”。`;
}

function recentPostBrief(settings = getSettings()) {
  const rows = listRuns(20)
    .filter(r => r.postText && ['published', 'preview'].includes(r.status))
    .slice(0, 8);
  if (!rows.length) return '暂无近期正文。';
  return rows.map((r, idx) => {
    const symbols = [r.lead, r.peer, r.anchor].filter(Boolean).join('/');
    const text = compactText(r.postText).replace(/\s+/g, ' ').slice(0, 110);
    return `${idx + 1}. ${symbols}: ${text}`;
  }).join('\n');
}

function renderTemplate(template, pack, settings = getSettings()) {
  const lead = pack.trio.lead.symbol;
  const peer = pack.trio.peer.symbol;
  const anchor = pack.trio.anchor.symbol;
  const postAngle = selectPostAngle(pack);
  const styleCard = selectStyleCard(pack);
  const voiceAngle = postAngle?.instruction || '只围绕一个主角给出清晰判断，其他币只做参照。';
  const vars = {
    JOB_NAME: settings.jobName || '',
    JOB_DESCRIPTION: settings.jobDescription || '',
    LANGUAGE: settings.language || '',
    STYLE_GUIDE: settings.styleGuide || '',
    CONTENT_SOURCE: settings.contentSource || '',
    POST_TARGET: settings.postTarget || '',
    VOICE_ANGLE: voiceAngle,
    POST_ANGLE: postAngle?.id || '',
    STYLE_CARD: styleCard?.instruction || '',
    STYLE_CARD_ID: styleCard?.id || '',
    MIN_POST_CHARS: String(settings.minPostChars || 180),
    MAX_POST_CHARS: String(settings.maxPostChars || 360),
    LEAD: lead,
    PEER: peer,
    ANCHOR: anchor,
    LEAD_CASHTAG: cashtag(lead),
    PEER_CASHTAG: cashtag(peer),
    ANCHOR_CASHTAG: cashtag(anchor),
    FACTS: (pack.facts || []).join('\n'),
    TAKEAWAYS: (pack.takeaways || []).join('\n'),
    TRADE_PLAN: formatTradePlanForPrompt(pack.tradePlan),
    TRADE_PLAN_JSON: pack.tradePlan ? JSON.stringify(pack.tradePlan, null, 2) : '',
    RECENT_POSTS: recentPostBrief(settings),
    EXTERNAL_INTEL_JSON: pack.externalIntel ? JSON.stringify(pack.externalIntel, null, 2) : '',
    STOCK_CASHTAGS: pack.stockCashtags || '',
    MACRO_CASHTAGS: pack.macroCashtags || '',
    AI_SECTOR_CASHTAGS: pack.aiSectorCashtags || '',
    STOCK_FACTS: pack.stockFacts || '暂无可用美股/ETF行情数据。',
    AI_SECTOR_FACTS: pack.aiSectorFacts || '暂无可用AI板块行情数据。',
    STOCK_TAKEAWAYS: pack.stockTakeaways || '美股参照数据缺失，本轮不使用美股作为判断依据。',
    AI_TAKEAWAYS: pack.aiTakeaways || 'AI板块数据不足，本轮不强行写AI联动。',
    BANNED_PHRASES: (settings.bannedPhrases || []).join('、'),
    MARKET_PACK_JSON: JSON.stringify(pack, null, 2)
  };
  return String(template || '').replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, key) => vars[key] ?? '');
}

function mockGenerate(pack) {
  const { lead, peer, anchor } = pack.trio;
  const l = cashtag(lead.symbol), p = cashtag(peer.symbol), a = cashtag(anchor.symbol);
  const leadStronger = Number(lead.change1h || 0) >= Number(peer.change1h || 0);
  const plan = pack.tradePlan?.summary || `${lead.symbol} 条件计划：先观望；等突破前高或跌破近端支撑后再跟，失效位看区间另一侧。`;
  const f = (pack.facts || []).slice(0, 4).join('；');
  if (leadStronger) return `${l} 这单我只围绕主角看，不平均复盘。${p} 和 ${a} 只做参照：${f}。高波动里不硬追，只有回踩还有承接，或者重新站上关键位，我才会考虑。${plan}`;
  return `${l} 波动有了，但短线不如 ${p}，${a} 也没给太多空间。${f}。这种盘先过滤追单，若关键位站不回去，就算有热度我也会放弃。${plan}`;
}

async function callOpenAI(prompt, settings) {
  const secrets = getSecrets();
  const apiKey = secrets.openaiApiKey;
  if (!apiKey) throw new Error('missing_openai_api_key');
  return callOpenAIWithCandidate(prompt, {
    channelId: 'legacy',
    channelName: 'Legacy settings',
    apiKey,
    baseUrl: settings.openaiBaseUrl || config.openaiBaseUrl || 'https://api.openai.com/v1',
    model: settings.openaiModel || config.openaiModel,
    temperature: settings.openaiTemperature ?? config.openaiTemperature ?? 0.8,
    maxTokens: settings.openaiMaxTokens ?? config.openaiMaxTokens,
    timeoutMs: settings.openaiTimeoutMs || config.openaiTimeoutMs || 45000
  });
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) return content.map(textFromContent).join('');
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.value === 'string') return content.value;
    if (typeof content.content === 'string') return content.content;
    if (Array.isArray(content.content)) return textFromContent(content.content);
    if (typeof content.output_text === 'string') return content.output_text;
  }
  return '';
}

function extractChoiceText(json) {
  const candidates = [];
  if (typeof json?.output_text === 'string') candidates.push(json.output_text);
  if (Array.isArray(json?.choices)) {
    for (const choice of json.choices) {
      candidates.push(textFromContent(choice?.message?.content));
      candidates.push(textFromContent(choice?.delta?.content));
      candidates.push(textFromContent(choice?.text));
    }
  }
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      candidates.push(textFromContent(item?.content));
      candidates.push(textFromContent(item?.text));
      candidates.push(textFromContent(item?.output_text));
    }
  }
  candidates.push(textFromContent(json?.content));
  return candidates.map(x => String(x || '').trim()).find(Boolean) || '';
}

function isReasoningLikeModel(candidateOrModel = '') {
  if (typeof candidateOrModel === 'object' && candidateOrModel) return candidateOrModel.reasoning === true;
  return false;
}

function effectiveMaxTokens(candidate = {}) {
  const requested = Number(candidate.maxTokens ?? config.openaiMaxTokens);
  const base = Number.isFinite(requested) && requested > 0 ? requested : Number(config.openaiMaxTokens || 180);
  // GPT-5 / o-series compatible relays may spend part of max_tokens on hidden reasoning.
  // Keep visible output short via post validation, but avoid content=null caused by too-small budgets.
  if (isReasoningLikeModel(candidate)) return Math.max(base, 800);
  return base;
}

function normalizeApiMode(value = 'auto') {
  const v = String(value || 'auto').trim().toLowerCase().replace(/_/g, '-');
  if (['auto', 'chat', 'completions', 'responses'].includes(v)) return v;
  if (['chat-completions', 'openai-completions', 'openai-chat-completions'].includes(v)) return 'chat';
  if (['legacy', 'legacy-completions', 'text-completions', 'openai-legacy-completions'].includes(v)) return 'completions';
  return 'auto';
}

function shortJson(json, max = 240) {
  try { return JSON.stringify(json).slice(0, max); } catch { return String(json).slice(0, max); }
}

function extractSseText(body = '') {
  let text = '';
  const lines = String(body || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let json;
    try { json = JSON.parse(data); } catch { continue; }

    if (typeof json.delta === 'string') text += json.delta;
    if (typeof json.output_text === 'string') text += json.output_text;
    if (typeof json.response?.output_text === 'string') text += json.response.output_text;

    if (Array.isArray(json.choices)) {
      for (const choice of json.choices) {
        text += textFromContent(choice?.delta?.content);
        text += textFromContent(choice?.message?.content);
        text += textFromContent(choice?.text);
      }
    }
    if (Array.isArray(json.output)) {
      for (const item of json.output) {
        text += textFromContent(item?.content);
        text += textFromContent(item?.text);
        text += textFromContent(item?.output_text);
      }
    }
  }
  return text;
}

async function postJsonSse(url, payload, { headers = {}, timeoutMs = 45000 } = {}) {
  const res = await request('POST', url, {
    headers: {
      'User-Agent': 'binance-square-autopost-service/0.1',
      Accept: 'text/event-stream, application/json',
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(payload),
    timeoutMs
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`http_${res.statusCode}:${String(res.body || '').slice(0, 300)}`);
  }
  return res.body;
}

async function callOpenAIWithCandidate(prompt, candidate) {
  if (!candidate?.apiKey) throw new Error('missing_openai_api_key');
  const baseUrl = String(candidate.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const chatUrl = `${baseUrl}/chat/completions`;
  const completionsUrl = `${baseUrl}/completions`;
  const responsesUrl = `${baseUrl}/responses`;
  const apiMode = normalizeApiMode(candidate.apiMode || 'auto');
  const reasoningLike = isReasoningLikeModel(candidate);
  const timeoutMs = Number(candidate.timeoutMs || config.openaiTimeoutMs || 45000);
  const headers = { Authorization: `Bearer ${candidate.apiKey}` };
  const systemText = '你只输出最终可发布的纯文本短帖，不解释过程。';
  const maybeTemperature = () => {
    // Several GPT-5/o-series relays either reject or silently mishandle non-default temperature.
    if (reasoningLike) return {};
    return { temperature: Number(candidate.temperature ?? config.openaiTemperature ?? 0.8) };
  };
  const model = candidate.model || config.openaiModel;
  const runChat = async (maxTokens, tokenParam = reasoningLike ? 'max_completion_tokens' : 'max_tokens') => {
    const payload = {
      model,
      ...maybeTemperature(),
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: prompt }
      ]
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload[tokenParam] = maxTokens;
    let json;
    try {
      json = await postJson(chatUrl, payload, { headers, timeoutMs });
    } catch (err) {
      // Some OpenAI-compatible relays do not support max_completion_tokens yet.
      if (tokenParam === 'max_completion_tokens' && /http_400|unsupported|unknown|max_completion_tokens/i.test(err.message || '')) {
        return runChat(maxTokens, 'max_tokens');
      }
      throw err;
    }
    return { label: `chat/completions:${tokenParam}:${maxTokens || 'none'}`, json, text: compactText(extractChoiceText(json)) };
  };
  const runChatStream = async (maxTokens, tokenParam = reasoningLike ? 'max_completion_tokens' : 'max_tokens') => {
    const payload = {
      model,
      ...maybeTemperature(),
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: prompt }
      ]
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload[tokenParam] = maxTokens;
    let body;
    try {
      body = await postJsonSse(chatUrl, payload, { headers, timeoutMs });
    } catch (err) {
      if (tokenParam === 'max_completion_tokens' && /http_400|unsupported|unknown|max_completion_tokens/i.test(err.message || '')) {
        return runChatStream(maxTokens, 'max_tokens');
      }
      throw err;
    }
    return { label: `chat/completions:stream:${tokenParam}:${maxTokens || 'none'}`, json: { stream: true, sample: String(body || '').slice(0, 240) }, text: compactText(extractSseText(body)) };
  };
  const runCompletions = async (maxTokens) => {
    const payload = {
      model,
      prompt: `${systemText}\n\n${prompt}\n`,
      ...maybeTemperature()
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_tokens = maxTokens;
    const json = await postJson(completionsUrl, payload, { headers, timeoutMs });
    return { label: `completions:max_tokens:${maxTokens || 'none'}`, json, text: compactText(extractChoiceText(json)) };
  };
  const runResponses = async (maxTokens) => {
    const payload = {
      model,
      instructions: systemText,
      input: prompt,
      ...maybeTemperature()
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_output_tokens = maxTokens;
    const json = await postJson(responsesUrl, payload, { headers, timeoutMs });
    return { label: `responses:max_output_tokens:${maxTokens || 'none'}`, json, text: compactText(extractChoiceText(json)) };
  };

  const runResponsesStream = async (maxTokens) => {
    const payload = {
      model,
      instructions: systemText,
      input: prompt,
      stream: true,
      ...maybeTemperature()
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_output_tokens = maxTokens;
    const body = await postJsonSse(responsesUrl, payload, { headers, timeoutMs });
    return { label: `responses:stream:max_output_tokens:${maxTokens || 'none'}`, json: { stream: true, sample: String(body || '').slice(0, 240) }, text: compactText(extractSseText(body)) };
  };

  const firstMaxTokens = effectiveMaxTokens(candidate);
  let attempts = [];
  if (apiMode === 'chat') {
    attempts = reasoningLike
      ? [
          () => runChat(firstMaxTokens, 'max_completion_tokens'),
          () => runChatStream(firstMaxTokens, 'max_completion_tokens'),
          () => runChat(Math.max(firstMaxTokens, 1200), 'max_tokens'),
          () => runChatStream(Math.max(firstMaxTokens, 1200), 'max_tokens')
        ]
      : [
          () => runChat(firstMaxTokens, 'max_tokens'),
          () => runChatStream(firstMaxTokens, 'max_tokens')
        ];
  } else if (apiMode === 'completions') {
    attempts = [() => runCompletions(firstMaxTokens)];
  } else if (apiMode === 'responses') {
    attempts = [() => runResponses(firstMaxTokens), () => runResponsesStream(firstMaxTokens)];
  } else if (reasoningLike) {
    attempts = [
      () => runChat(firstMaxTokens, 'max_completion_tokens'),
      () => runChatStream(firstMaxTokens, 'max_completion_tokens'),
      () => runChat(Math.max(firstMaxTokens, 1200), 'max_tokens'),
      () => runChatStream(Math.max(firstMaxTokens, 1200), 'max_tokens'),
      () => runResponses(Math.max(firstMaxTokens, 1200)),
      () => runResponsesStream(Math.max(firstMaxTokens, 1200)),
      () => runCompletions(Math.max(firstMaxTokens, 1200)),
      () => runChat(4096, 'max_tokens'),
      () => runChatStream(4096, 'max_tokens'),
      () => runResponses(4096),
      () => runResponsesStream(4096),
      () => runCompletions(4096)
    ];
  } else {
    attempts = [
      () => runChat(firstMaxTokens, 'max_tokens'),
      () => runChatStream(firstMaxTokens, 'max_tokens'),
      () => runCompletions(firstMaxTokens),
      () => runResponses(firstMaxTokens),
      () => runResponsesStream(firstMaxTokens)
    ];
  }

  const errors = [];
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result.text) return result.text;
      errors.push(`${result.label}:empty:${shortJson(result.json)}`);
    } catch (err) {
      errors.push(`${err.message || String(err)}`);
    }
  }
  throw new Error(`llm_no_text_output:${errors.join(' | ')}`);
}

function textBigrams(text) {
  const chars = String(text || '').replace(/\s+/g, '').split('');
  const grams = new Set();
  for (let i = 0; i < chars.length - 1; i++) grams.add(chars[i] + chars[i + 1]);
  return grams;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
function maxRecentSimilarity(text, settings = getSettings()) {
  const threshold = Number(settings.similarityThreshold || 0);
  if (!Number.isFinite(threshold) || threshold <= 0) return 0;
  const base = textBigrams(text);
  let max = 0;
  for (const run of listRuns(30).filter(r => r.postText && ['published', 'preview'].includes(r.status)).slice(0, 12)) {
    max = Math.max(max, jaccard(base, textBigrams(run.postText)));
  }
  return max;
}

function validatePostText(text, pack, settings = getSettings()) {
  const errors = [];
  const clean = compactText(text);
  const len = [...clean].length;
  if (len < Number(settings.minPostChars || 180)) errors.push(`too_short:${len}`);
  if (len > Number(settings.maxPostChars || 360)) errors.push(`too_long:${len}`);
  const fixedBanned = ['不构成投资建议', '以上仅供参考', '公开信息显示', '简短原因', '简要原因', '可能原因', '需注意风险', '暂无可用美股/ETF行情数据', '美股参照数据缺失', '本轮不使用美股作为判断依据', '暂无可用AI板块行情数据', 'AI板块数据不足', ...DEFAULT_BANNED_PHRASES];
  const banned = [...new Set([...fixedBanned, ...(settings.bannedPhrases || [])].map(s => String(s || '').trim()).filter(Boolean))];
  for (const phrase of banned) {
    if (clean.includes(phrase)) errors.push(`banned_phrase:${phrase}`);
  }
  if (settings.requireCashtags) {
    for (const symbol of [pack.trio.lead.symbol, pack.trio.peer.symbol, pack.trio.anchor.symbol]) {
      if (!clean.includes(cashtag(symbol))) errors.push(`missing_cashtag:${symbol}`);
    }
  }
  if (settings.includeTradePlan !== false && String(settings.tradePlanMode || '').toLowerCase() !== 'off' && pack.tradePlan) {
    if (!/(止损|失效|突破|跌破|回踩|反抽|偏多|偏空|看多|看空|观望)/.test(clean)) errors.push('missing_trade_plan');
  }
  const sim = maxRecentSimilarity(clean, settings);
  if (sim >= Number(settings.similarityThreshold || 0.72)) errors.push(`too_similar:${sim.toFixed(2)}`);
  return { ok: errors.length === 0, errors, text: clean, length: len };
}

function validationError(validation) {
  return `post_validation_failed:${validation.errors.join(',')}`;
}

function repairPromptForPost(text, validation, pack, settings = getSettings()) {
  const min = Number(settings.minPostChars || 180);
  const max = Number(settings.maxPostChars || 360);
  const symbols = [pack.trio.lead.symbol, pack.trio.peer.symbol, pack.trio.anchor.symbol];
  const tags = symbols.map(cashtag).join(' ');
  return `下面这条 Binance Square 正文已经生成，但没有通过本地校验：${validation.errors.join(',')}。

请只输出改写后的最终正文，不解释过程。

硬性要求：
1. 字数必须在 ${min} 到 ${max} 个中文字符之间，不能超过 ${max}。
2. 必须保留并自然提到这 3 个 Cashtag：${tags}。
3. 正文只围绕一个主角给判断；另外两个币只做参照，不能平均写成行情总结。
4. 只能使用 facts / takeaways / trade plan / market pack 里的真实数据，禁止编造。
5. 如果 facts 里有条件计划，必须自然写出方向、触发点、失效/止损；如果信号矛盾，可以直接写不碰。
6. 不要标题、不要项目符号、不要免责声明、不要报告腔。
7. 如果美股/ETF或AI板块参照缺失，正文不要写“暂无数据/数据缺失/本轮不使用”，直接忽略缺失部分。
8. 禁止出现这些表达：${[...new Set([...DEFAULT_BANNED_PHRASES, ...(settings.bannedPhrases || [])])].join('、')}。

原文：
${text}

facts：
${(pack.facts || []).join('\n')}

交易解读：
${(pack.takeaways || []).join('\n')}

条件计划：
${pack.tradePlan?.summary || ''}

美股/ETF参照：
${pack.stockFacts || '暂无可用美股/ETF行情数据。'}
${pack.stockTakeaways || '美股参照数据缺失，本轮不使用美股作为判断依据。'}

AI板块参照：
${pack.aiSectorFacts || '暂无可用AI板块行情数据。'}
${pack.aiTakeaways || 'AI板块数据不足，本轮不强行写AI联动。'}`;
}

async function repairPostText(text, validation, pack, settings, candidate) {
  const repairCandidate = { ...candidate };
  const requested = Number(repairCandidate.maxTokens || config.openaiMaxTokens || 1024);
  repairCandidate.maxTokens = Math.max(512, Math.min(requested || 1024, 2048));
  const repairedText = await callOpenAIWithCandidate(repairPromptForPost(text, validation, pack, settings), repairCandidate);
  const repairedValidation = validatePostText(repairedText, pack, settings);
  return { text: repairedText, validation: repairedValidation };
}

async function generatePost(pack) {
  const settings = getSettings();
  const prompt = getActivePrompt();
  if (!prompt) throw new Error('no_active_prompt');
  const renderedPrompt = renderTemplate(prompt.content, pack, settings);
  const provider = String(settings.llmProvider || config.llmProvider || 'mock').toLowerCase();
  if (provider === 'mock') {
    const text = mockGenerate(pack);
    const validation = validatePostText(text, pack, settings);
    if (!validation.ok) throw new Error(`${validationError(validation)}:text=${validation.text}`);
    return { text: validation.text, promptId: prompt.id, promptName: prompt.name, provider, model: 'mock', renderedPrompt, attempts: [{ provider, model: 'mock', ok: true }] };
  }

  const candidates = getLlmCandidates();
  const attempts = [];
  if (candidates.length) {
    for (const candidate of candidates) {
      const label = `${candidate.channelName || candidate.channelId}/${candidate.model}`;
      try {
        const text = await callOpenAIWithCandidate(renderedPrompt, candidate);
        const validation = validatePostText(text, pack, settings);
        if (!validation.ok) {
          try {
            const repaired = await repairPostText(text, validation, pack, settings, candidate);
            if (repaired.validation.ok) {
              attempts.push({ channelId: candidate.channelId, channelName: candidate.channelName, model: candidate.model, ok: true, repaired: true, originalError: validationError(validation), originalLength: validation.length, repairedLength: repaired.validation.length });
              return {
                text: repaired.validation.text,
                promptId: prompt.id,
                promptName: prompt.name,
                provider,
                channelId: candidate.channelId,
                channelName: candidate.channelName,
                model: candidate.model,
                renderedPrompt,
                attempts
              };
            }
            attempts.push({ channelId: candidate.channelId, channelName: candidate.channelName, model: candidate.model, ok: false, error: `${validationError(validation)}; repair_failed:${validationError(repaired.validation)}`, text: validation.text, repairedText: repaired.validation.text });
          } catch (repairErr) {
            attempts.push({ channelId: candidate.channelId, channelName: candidate.channelName, model: candidate.model, ok: false, error: `${validationError(validation)}; repair_error:${repairErr.message || String(repairErr)}`, text: validation.text });
          }
          continue;
        }
        attempts.push({ channelId: candidate.channelId, channelName: candidate.channelName, model: candidate.model, ok: true });
        return {
          text: validation.text,
          promptId: prompt.id,
          promptName: prompt.name,
          provider,
          channelId: candidate.channelId,
          channelName: candidate.channelName,
          model: candidate.model,
          renderedPrompt,
          attempts
        };
      } catch (err) {
        attempts.push({ channelId: candidate.channelId, channelName: candidate.channelName, model: candidate.model, ok: false, error: err.message || String(err) });
        console.warn(`[llm] candidate failed: ${label}: ${err.message || err}`);
      }
    }
    throw new Error(`llm_all_candidates_failed:${attempts.map(a => `${a.channelName || a.channelId}/${a.model}:${a.error}`).join(' | ')}`);
  }

  const text = await callOpenAI(renderedPrompt, settings);
  let validation = validatePostText(text, pack, settings);
  let finalText = validation.text;
  const legacyCandidate = {
    channelId: 'legacy',
    channelName: 'Legacy settings',
    apiKey: getSecrets().openaiApiKey,
    baseUrl: settings.openaiBaseUrl || config.openaiBaseUrl || 'https://api.openai.com/v1',
    model: settings.openaiModel || config.openaiModel,
    temperature: settings.openaiTemperature ?? config.openaiTemperature ?? 0.8,
    maxTokens: settings.openaiMaxTokens ?? config.openaiMaxTokens,
    timeoutMs: settings.openaiTimeoutMs || config.openaiTimeoutMs || 45000
  };
  const attemptsLegacy = [{ channelId: 'legacy', channelName: 'Legacy settings', model: settings.openaiModel || config.openaiModel, ok: validation.ok }];
  if (!validation.ok) {
    const repaired = await repairPostText(text, validation, pack, settings, legacyCandidate);
    validation = repaired.validation;
    finalText = validation.text;
    attemptsLegacy.push({ channelId: 'legacy', channelName: 'Legacy settings', model: settings.openaiModel || config.openaiModel, ok: validation.ok, repaired: true, length: validation.length });
  }
  if (!validation.ok) throw new Error(`${validationError(validation)}:text=${finalText}`);
  return { text: finalText, promptId: prompt.id, promptName: prompt.name, provider, channelId: 'legacy', channelName: 'Legacy settings', model: settings.openaiModel || config.openaiModel, renderedPrompt, attempts: attemptsLegacy };
}

module.exports = { generatePost, validatePostText, renderTemplate, cashtag, callOpenAIWithCandidate, effectiveMaxTokens, selectPostAngle };
