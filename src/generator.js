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
  const event = pack.marketEvent || {};
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
  const eventAngles = {
    liquidation_map: { id: 'liquidation_map', instruction: '只讲一个清算地图结论：哪一侧的流动性密集区更近，以及价格靠近那里可能引发什么；不要把热区说成必然目标。' },
    price_oi_divergence: { id: 'price_oi_divergence', instruction: '围绕价格与持仓量背离写：明确这是新增仓位推动、减仓推动还是暂时无法确认；不要把涨跌幅重新报一遍。' },
    crowded_positioning: { id: 'crowded_positioning', instruction: '围绕多空拥挤写：说清哪一侧更挤、哪里可能发生反向挤压；只给一个反证条件。' },
    funding_dislocation: { id: 'funding_dislocation', instruction: '围绕永续资金成本写：说清是哪一侧在付费、仓位是否拥挤，以及价格需要怎样变化才会验证判断。注明这是跨交易所参照，不要冒充 Binance 数据。' },
    cross_market_confirmation: { id: 'cross_market_confirmation', instruction: '围绕币圈与传统市场的同向验证写，但主角仍是加密货币；传统资产只引用一到两个，不写成美股复盘，也不要把相关性说成因果。' },
    orderbook_imbalance: { id: 'orderbook_imbalance', instruction: '盘口只能作为一条证据，不能把前20档快照当成趋势结论；重点说明挂单是否与价格行为一致。' },
    late_momentum: { id: 'late_momentum', instruction: '波动已经发生，正文判断增量资金是否还在，不要用“热闹、追高、拿不回”这些套话。' },
    sector_rotation: { id: 'sector_rotation', instruction: '只写板块内部注意力如何迁移，以及主角为何胜出或掉队；不要平均介绍三个币。' },
    relative_strength: { id: 'relative_strength', instruction: '用一个相对强弱差提出清晰结论，另外两个币只用一句作参照；不要逐项复盘。' }
  };
  if (eventAngles[event.type]) return eventAngles[event.type];
  const options = [];
  if (stockAiStrongCryptoLag) options.push({ id: 'ai_stock_hot_crypto_cold', instruction: '如果提 AI，只写外面热、币圈这边没跟上；不要写成美股复盘，也不要写“承接没打开”。' });
  if (aiSymbols.has(String(lead.symbol || '').toUpperCase()) && !/不足|缺失/.test(String(pack.aiTakeaways || ''))) options.push({ id: 'ai_coin_attention', instruction: '主角是 AI 币时，写它在 AI 币里有没有被人多看一眼；不要写技术计划。' });
  if (lead1h > 1.2 && (anchor1h < -0.1 || anchor24h < 0)) options.push({ id: 'btc_eth_not_lifting', instruction: 'BTC/ETH 没把气氛托起来，小币自己动时只写“这波容易被晾在半路”的意思，不要用风控术语。' });
  if (lead24h > 18 || Math.abs(lead1h) > 3) options.push({ id: 'move_already_loud', instruction: '主角波动已经很显眼，重点写“热闹已经在价格里”，别给开仓计划。' });
  if (lead1h > 0.6 && lead24h > 0) options.push({ id: 'needs_follow_through', instruction: '写它看起来有点意思，但真正要看后面有没有人继续抬，不要写回踩、承接、止损。' });
  if (['meme', 'contract-meme'].includes(lead.bucket) && lead1h < 0) options.push({ id: 'meme_attention_fading', instruction: 'meme 热度变淡时，写注意力被别的票抢走；不要写交易计划。' });
  if (lead1h > 1 && numeric(peer.change1h) < 0) options.push({ id: 'attention_rotation', instruction: '写市场注意力从一个币挪到另一个币；peer 和 anchor 只做陪衬。' });
  const fallback = [
    { id: 'one_human_point', instruction: '只写一个人话主旨：为什么这个币此刻值得点开，或者为什么只是看着热闹。' },
    { id: 'attention_vs_price', instruction: '围绕“价格动了，但注意力/买盘/情绪有没有跟上”写，不要像策略单。' },
    { id: 'one_level_only', instruction: '最多写一个关键位置，表达成“拿不回来/过不去/站上才有意思”，不要写触发、失效、止损。' }
  ];
  return seededPick(options.length ? options : fallback, seed);
}

function selectStyleCard(pack = {}) {
  const lead = pack.trio?.lead || {};
  const peer = pack.trio?.peer || {};
  const anchor = pack.trio?.anchor || {};
  const seed = `style:${pack.generatedAt || ''}:${lead.symbol || ''}:${peer.symbol || ''}:${anchor.symbol || ''}`;
  const options = [
    {
      id: 'claim_evidence_falsifier',
      instruction: '三步但不分段：一句明确结论，一条决定性证据，一个会推翻结论的条件。最多两个数字。'
    },
    {
      id: 'contrarian_observation',
      instruction: '从一个反直觉细节开头，随后解释它为何比表面涨跌更重要；不要故作惊讶。'
    },
    {
      id: 'evidence_first',
      instruction: '先抛出最稀缺的证据，再用一句话落到方向判断；其余数据全部舍弃。'
    },
    {
      id: 'comparison_in_one_sentence',
      instruction: '只用一句比较句交代 peer 与 anchor，正文其余部分全部留给主角和核心论点。'
    },
    {
      id: 'question_then_answer',
      instruction: '用一个具体市场问题开头，下一句直接回答；问题不能是空泛的“还能涨吗”。'
    },
    {
      id: 'compact_desk_note',
      instruction: '像交易台内部短评：不用自称，不评价自己是否交易，只记录异常、解释含义、给出验证点。'
    },
    {
      id: 'two_sentence_note',
      instruction: '全文尽量两句：第一句判断，第二句证据和反证条件；禁止三币逐个介绍。'
    }
  ];
  return seededPick(options, seed);
}

function selectEmojiStyle(pack = {}) {
  const lead = pack.trio?.lead || {};
  const event = pack.marketEvent || {};
  const seed = `emoji:${pack.generatedAt || ''}:${lead.symbol || ''}:${event.type || ''}`;
  const candidates = ['👀'];

  if (String(lead.bucket || '').toLowerCase() === 'ai') candidates.push('🤖');
  if (['liquidation_map', 'crowded_positioning', 'funding_dislocation'].includes(event.type)) candidates.push('⚠️');
  if (event.type === 'orderbook_imbalance') candidates.push('🧱');
  if (event.type === 'cross_market_confirmation') candidates.push('🌐');
  if (Math.abs(numeric(lead.amplitude24h)) >= 12) candidates.push('🌊');
  if (numeric(lead.change1h) >= 0.7) candidates.push('📈', '🟢');
  if (numeric(lead.change1h) <= -0.7) candidates.push('📉', '🔻');

  const pool = [...new Set(candidates)];
  const mode = seededPick(['one', 'one', 'one', 'one', 'two', 'none'], seed);
  if (mode === 'none') {
    return { id: 'none', emojis: [], instruction: '本轮不强行使用表情符号，让连续发帖保留真人式变化。' };
  }

  const first = seededPick(pool, `${seed}:first`) || '👀';
  if (mode === 'two') {
    const secondPool = pool.filter(x => x !== first);
    const second = seededPick(secondPool.length ? secondPool : ['👀'], `${seed}:second`);
    return {
      id: 'two',
      emojis: [first, second],
      instruction: `正文自然使用 2 个表情符号，可用 ${first} ${second}；放在判断或关键转折附近，不要都堆在开头。`
    };
  }
  return {
    id: 'one',
    emojis: [first],
    instruction: `正文自然使用 1 个 ${first}；放在最值得停顿的位置，不要固定跟在币种名后面。`
  };
}

function formatTradePlanForPrompt(tradePlan = null) {
  if (!tradePlan) return '';
  const symbol = tradePlan.symbol || '';
  const parts = [`${symbol} 盘中位置参考`];
  if (tradePlan.direction === 'long') {
    if (tradePlan.trigger) parts.push(`上方先看 ${tradePlan.trigger}`);
    if (tradePlan.entry) parts.push(`下面留意 ${tradePlan.entry}`);
  } else if (tradePlan.direction === 'short') {
    if (tradePlan.entry) parts.push(`上方留意 ${tradePlan.entry}`);
    if (tradePlan.trigger) parts.push(`下方先看 ${tradePlan.trigger}`);
  } else {
    if (tradePlan.trigger) parts.push(`上下沿参考 ${tradePlan.trigger}`);
  }
  return `${parts.filter(Boolean).join('；')}。这是位置素材，不是交易计划；正文最多借一个位置做人话表达，不要写开多、开空、进场、止损、失效、放弃。`;
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

const TRACKED_CLICHES = ['热闹', '拿不回', '点开', '容易', '看点', '前20档', '买盘', '慢慢挪', '留得住', '卡在半路', '多看一眼', '值得看'];
function recentOverusedPhrases(limit = 40) {
  const rows = listRuns(Math.max(60, limit)).filter(r => r.postText && r.status === 'published').slice(0, limit);
  if (rows.length < 8) return [];
  return TRACKED_CLICHES.map(phrase => ({ phrase, count: rows.filter(r => r.postText.includes(phrase)).length }))
    .filter(x => x.count >= Math.max(3, Math.ceil(rows.length * 0.18)))
    .sort((a, b) => b.count - a.count);
}

function editorialBrief(pack = {}) {
  const event = pack.marketEvent || {};
  const reasons = (event.reasons || []).map(x => x.reason).join('、');
  const emojiStyle = selectEmojiStyle(pack);
  return [
    `本轮唯一论点：${event.claim || `${pack.trio?.lead?.symbol} 当前的价格行为值得核对`}`,
    `事件类型：${event.type || 'relative_strength'}；发布价值分：${event.score ?? '--'}/100；置信度：${event.confidence || 'unknown'}`,
    `最强证据：${reasons || '仅使用给定 facts 中最相关的一项'}`,
    '写作顺序：先给结论，再给一条决定性证据，最后给反证条件或下一项观察。不要以固定口头禅连接三段。',
    '三个 Cashtag 必须出现，但 peer/anchor 合计最多占一句，不能分别展开。',
    `表情符号策略：${emojiStyle.instruction} 全文最多 2 个；禁用 🚀、🤑、💯，不要连续堆叠。`
  ].join('\n');
}

function renderTemplate(template, pack, settings = getSettings()) {
  const lead = pack.trio.lead.symbol;
  const peer = pack.trio.peer.symbol;
  const anchor = pack.trio.anchor.symbol;
  const postAngle = selectPostAngle(pack);
  const styleCard = selectStyleCard(pack);
  const emojiStyle = selectEmojiStyle(pack);
  const voiceAngle = postAngle?.instruction || '只围绕一个主角给出清晰判断，其他币只做参照。';
  const overused = recentOverusedPhrases();
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
    EMOJI_STYLE: emojiStyle?.instruction || '',
    EMOJI_STYLE_ID: emojiStyle?.id || '',
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
    MARKET_EVENT_JSON: JSON.stringify(pack.marketEvent || {}, null, 2),
    EDITORIAL_BRIEF: editorialBrief(pack),
    RECENT_OVERUSED_PHRASES: overused.length ? overused.map(x => `${x.phrase}（近期开了${x.count}次）`).join('、') : '无',
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
  const configuredMin = Number(settings.minPostChars || 180);
  // The prompt can ask for a richer post, but live publishing should not fail
  // just because a natural short trading note lands around 110-130 chars.
  const hardMin = configuredMin > 120 ? 110 : configuredMin;
  if (len < hardMin) errors.push(`too_short:${len}`);
  if (len > Number(settings.maxPostChars || 360)) errors.push(`too_long:${len}`);
  const fixedBanned = ['不构成投资建议', '以上仅供参考', '公开信息显示', '简短原因', '简要原因', '可能原因', '需注意风险', '暂无可用美股/ETF行情数据', '美股参照数据缺失', '本轮不使用美股作为判断依据', '暂无可用AI板块行情数据', 'AI板块数据不足', ...DEFAULT_BANNED_PHRASES];
  const banned = [...new Set([...fixedBanned, ...(settings.bannedPhrases || [])].map(s => String(s || '').trim()).filter(Boolean))];
  for (const phrase of banned) {
    if (clean.includes(phrase)) errors.push(`banned_phrase:${phrase}`);
  }
  for (const item of recentOverusedPhrases()) {
    if (clean.includes(item.phrase)) errors.push(`overused_phrase:${item.phrase}:${item.count}`);
  }
  if (settings.requireCashtags) {
    for (const symbol of [pack.trio.lead.symbol, pack.trio.peer.symbol, pack.trio.anchor.symbol]) {
      if (!clean.includes(cashtag(symbol))) errors.push(`missing_cashtag:${symbol}`);
    }
  }
  const tradeMode = String(settings.tradePlanMode || '').toLowerCase().replace(/-/g, '_');
  if (!['off', 'opinion', 'soft_opinion'].includes(tradeMode) && settings.includeTradePlan !== false && pack.tradePlan) {
    if (!/(偏多|偏空|看多|看空|观望|不追|不碰|回踩|突破|跌破|放弃|等|空仓|少碰|过滤)/.test(clean)) errors.push('missing_trade_stance');
  }
  const metricHits = (clean.match(/现价|1h|4h|24h|成交额|振幅|前20档|点差|买盘厚|卖压厚|资金费率|持仓|OI|主动买卖比/g) || []).length;
  if (metricHits > 4) errors.push(`too_many_metrics:${metricHits}`);
  if (/^\s*\$[A-Z0-9]{2,12}\s*(现价|这单|这根|这里|现在|我)/.test(clean) || /^\s*(这轮|这笔|这单|现在|偏空|偏多|我这边只盯|追高|不追|别被)/.test(clean)) errors.push('formulaic_opening');
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
3. 正文只写一个盘中观点：这个币为什么此刻值得点开，或者为什么只是看着热闹。
4. 只能使用 facts / takeaways / market pack 里的真实数据，禁止编造。
5. 不要写交易计划，不要写开多/开空/进场/止损/失效/这单我不碰。
6. 最多写 1 到 2 个关键数据；不要把现价、1h、4h、24h、成交额、盘口全部列一遍。
7. 不要以“$币种 现价...”“这轮...”“这笔...”“这单...”“现在...”“偏多/偏空/不追/追高...”开头，换成人话开头。
8. 不要写“反抽/承接/压住手/容错低/失效/我的处理是/计划偏多/计划偏空/条件计划/只做条件”。
9. 只可以轻轻带一个位置，比如“拿不回 0.084 就没太多看点”，不要写成策略单。
10. 不要标题、不要项目符号、不要免责声明、不要报告腔。
11. 如果美股/ETF或AI板块参照缺失，正文不要写“暂无数据/数据缺失/本轮不使用”，直接忽略缺失部分。
12. 禁止出现这些表达：${[...new Set([...DEFAULT_BANNED_PHRASES, ...(settings.bannedPhrases || [])])].join('、')}。
13. ${selectEmojiStyle(pack).instruction} 全文最多 2 个；不要使用 🚀、🤑、💯，不要连续堆叠。

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
  const renderedPrompt = `${renderTemplate(prompt.content, pack, settings)}\n\n【本轮编辑指令（优先于旧模板中的写法建议）】\n${editorialBrief(pack)}\n近期过度使用、这次必须避开的词：${recentOverusedPhrases().map(x => x.phrase).join('、') || '无'}。\n结构化事件：\n${JSON.stringify(pack.marketEvent || {}, null, 2)}`;
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

module.exports = { generatePost, validatePostText, renderTemplate, cashtag, callOpenAIWithCandidate, effectiveMaxTokens, selectPostAngle, selectEmojiStyle, recentOverusedPhrases, editorialBrief };
