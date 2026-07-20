const { postJson, request } = require('./httpClient');
const { config } = require('./config');
const { getSettings, getActivePrompt, getSecrets, getLlmCandidates, listRuns } = require('./store');
const { ASSET_UNIVERSE, CONTRACT_META, DEFAULT_BANNED_PHRASES } = require('./assetUniverse');

function cashtag(symbol) { return `$${String(symbol || '').replace(/^\$/, '').toUpperCase()}`; }
function compactText(text) {
  return String(text || '').replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').replace(/[“”]/g, '').trim();
}
function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function collectCashtagSymbols(pack = {}, settings = getSettings()) {
  const symbols = new Set();
  const add = value => {
    const symbol = String(value || '').replace(/^\$/, '').trim().toUpperCase();
    if (/^[A-Z0-9]{1,24}$/.test(symbol)) symbols.add(symbol);
  };
  const addKeys = value => {
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.keys(value).forEach(add);
  };

  Object.values(ASSET_UNIVERSE).flat().forEach(add);
  Object.keys(CONTRACT_META).forEach(add);
  (settings.squareTagSymbols || []).forEach(add);
  [pack.trio?.lead?.symbol, pack.trio?.peer?.symbol, pack.trio?.anchor?.symbol, pack.tradePlan?.symbol, pack.marketEvent?.subject].forEach(add);
  addKeys(pack.marketIntel?.symbols);
  addKeys(pack.publicDerivatives?.symbols);
  addKeys(pack.crypto_core);
  addKeys(pack.crypto_ai);
  addKeys(pack.tradfi?.assets);
  addKeys(pack.stocks?.ai);
  addKeys(pack.stocks?.crypto_beta);
  addKeys(pack.stocks?.etf_macro);

  return [...symbols].sort((a, b) => b.length - a.length || a.localeCompare(b));
}
function normalizeCashtags(text, pack = {}, settings = getSettings()) {
  let normalized = String(text || '');
  const trioSymbols = new Set([
    pack.trio?.lead?.symbol,
    pack.trio?.peer?.symbol,
    pack.trio?.anchor?.symbol
  ].map(s => String(s || '').toUpperCase()).filter(Boolean));

  for (const symbol of collectCashtagSymbols(pack, settings)) {
    // “AI” is commonly used as a category name. Only treat it as the Sleepless
    // AI ticker when it is one of this run's selected assets; otherwise phrases
    // such as “AI 板块” must remain normal prose.
    if (symbol !== 'AI' || trioSymbols.has(symbol)) {
      const pattern = new RegExp(`(^|[^$A-Z0-9])(${escapeRegExp(symbol)})(?=$|[^A-Z0-9])`, 'gi');
      normalized = normalized.replace(pattern, (_match, prefix) => `${prefix}$${symbol}`);
    }

    // Binance Square parses $coin server-side, but its mobile renderer only
    // turns the token yellow/clickable when the ticker has an ASCII whitespace
    // (or end-of-text) boundary after it. "$BTC走强" and "$BTC、$ETH" remain
    // plain text, while "$BTC 走强" and "$BTC $ETH" become trade links.
    const explicitTag = new RegExp(`\\$${escapeRegExp(symbol)}(?=$|[^A-Z0-9])`, 'gi');
    normalized = normalized.replace(explicitTag, (match, offset, source) => {
      const next = source[offset + match.length] || '';
      return `$${symbol}${next && !/\s/.test(next) ? ' ' : ''}`;
    });
  }
  return normalized;
}
function numeric(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function signedPct(value, digits = 2) {
  const n = numeric(value);
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}
function shortUsd(value) {
  const n = numeric(value);
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function humanPriceLevel(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(value || '');
  const magnitude = Math.floor(Math.log10(Math.abs(n)));
  const decimals = Math.max(0, Math.min(12, 3 - magnitude));
  return n.toFixed(decimals).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}
function evidenceFocus(pack = {}) {
  const event = pack.marketEvent || {};
  const lead = pack.trio?.lead || {};
  const peer = pack.trio?.peer || {};
  const anchor = pack.trio?.anchor || {};
  const relAnchor = numeric(lead.change1h) - numeric(anchor.change1h);
  const depth = numeric(pack.marketIntel?.symbols?.[lead.symbol]?.depth?.imbalance);
  const publicDerivatives = pack.publicDerivatives?.symbols?.[lead.symbol] || {};
  const oiToVolume = numeric(publicDerivatives.openInterestUsd) / Math.max(1, numeric(publicDerivatives.volume24hUsd));
  if (event.type === 'momentum_shift') return `${lead.symbol} 24h ${signedPct(lead.change24h)}，最近 1h ${signedPct(lead.change1h)}，两个周期方向相反。`;
  if (event.type === 'liquid_momentum') return `${lead.symbol} 最近 1h ${signedPct(lead.change1h)}，24h 成交额 ${shortUsd(lead.volume24h)}，相对 ${anchor.symbol} 多出 ${signedPct(relAnchor)}。`;
  if (event.type === 'volume_without_direction') return `${lead.symbol} 24h 成交额 ${shortUsd(lead.volume24h)}，但最近 1h 只有 ${signedPct(lead.change1h)}。`;
  if (event.type === 'relative_strength') return `${lead.symbol} 最近 1h ${signedPct(lead.change1h)}；${peer.symbol} ${signedPct(peer.change1h)}，${anchor.symbol} ${signedPct(anchor.change1h)}。`;
  if (event.type === 'orderbook_imbalance') return `${lead.symbol} 最近 1h ${signedPct(lead.change1h)}，前 20 档深度差 ${signedPct(depth, 1)}；盘口只能作旁证。`;
  if (event.type === 'positioning_without_price') return `${lead.symbol} 跨所永续持仓约为 24h 成交额的 ${oiToVolume.toFixed(1)} 倍，最近 1h 价格仅 ${signedPct(lead.change1h)}。`;
  if (event.type === 'late_momentum') return `${lead.symbol} 最近 1h ${signedPct(lead.change1h)}，24h ${signedPct(lead.change24h)}，成交额 ${shortUsd(lead.volume24h)}。`;
  return `${lead.symbol} 最近 1h ${signedPct(lead.change1h)}、24h ${signedPct(lead.change24h)}，相对 ${anchor.symbol} 的 1h 差值为 ${signedPct(relAnchor)}。`;
}
function optionalContext(pack = {}) {
  const unavailable = /暂无可用|数据缺失|数据不足|本轮不使用|不强行写/;
  const lines = [];
  for (const value of [pack.stockFacts, pack.stockTakeaways, pack.aiSectorFacts, pack.aiTakeaways]) {
    const text = String(value || '').trim();
    if (text && !unavailable.test(text)) lines.push(text);
  }
  const news = Array.isArray(pack.externalIntel?.newsItems) ? pack.externalIntel.newsItems.slice(0, 2) : [];
  if (news.length) lines.push(`可核对新闻：${news.map(x => `${x.source}: ${x.title}`).join('；')}`);
  const macro = String(pack.externalIntel?.macroNotes || '').trim();
  if (macro) lines.push(`人工备注：${macro.slice(0, 400)}`);
  return lines.join('\n') || '无额外上下文；不得补写新闻、KOL、链上或宏观原因。';
}
const FACTUAL_LABEL_EXEMPTIONS = new Set(['现价', '1h', '4h', '24h']);
function effectiveBannedPhrases(settings = getSettings(), extras = []) {
  return [...new Set([...extras, ...DEFAULT_BANNED_PHRASES, ...(settings.bannedPhrases || [])]
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .filter(s => !FACTUAL_LABEL_EXEMPTIONS.has(s)))];
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
    positioning_without_price: { id: 'positioning_without_price', instruction: '围绕“永续持仓不低、价格却没走远”写，说明杠杆仓位在等待方向；不猜多空比例，不把它写成必涨或必跌。注明是跨所公共数据。' },
    cross_market_confirmation: { id: 'cross_market_confirmation', instruction: '围绕币圈与传统市场的同向验证写，但主角仍是加密货币；传统资产只引用一到两个，不写成美股复盘，也不要把相关性说成因果。' },
    momentum_shift: { id: 'momentum_shift', instruction: '直接说清 24h 方向与最近 1h 为什么反向：是加速结束、资金换手还是短线转弱；只选一个解释，不罗列全部指标。' },
    liquid_momentum: { id: 'liquid_momentum', instruction: '重点说这次短线变化有真实成交规模，不是小额异动；只比较一次大盘，不罗列盘口。' },
    volume_without_direction: { id: 'volume_without_direction', instruction: '重点写“成交活跃却没有形成方向”这层矛盾，解释它意味着分歧而不是趋势；不要硬写成看多或看空。' },
    orderbook_imbalance: { id: 'orderbook_imbalance', instruction: '盘口最多占一句，只作辅助证据；主旨必须来自价格行为、成交或相对强弱，不能再写成“挂单是否与走势一致”的固定分析。' },
    late_momentum: { id: 'late_momentum', instruction: '波动已经发生，正文判断增量资金是否还在，不要用“热闹、追高、拿不回”这些套话。' },
    sector_rotation: { id: 'sector_rotation', instruction: '只写板块内部注意力如何迁移，以及主角为何胜出或掉队；不要平均介绍三个币。' },
    relative_strength: { id: 'relative_strength', instruction: '用一个相对强弱差提出清晰结论，另外两个币只用一句作参照；不要逐项复盘。' }
  };
  if (eventAngles[event.type]) return eventAngles[event.type];
  const options = [];
  if (stockAiStrongCryptoLag) options.push({ id: 'ai_stock_hot_crypto_cold', instruction: '如果提 AI，只写外面热、币圈这边没跟上；不要写成美股复盘，也不要写“承接没打开”。' });
  if (aiSymbols.has(String(lead.symbol || '').toUpperCase()) && !/不足|缺失/.test(String(pack.aiTakeaways || ''))) options.push({ id: 'ai_coin_attention', instruction: '主角是 AI 币时，写它在同板块里的成交和相对强弱是否占优；不要写技术计划。' });
  if (lead1h > 1.2 && (anchor1h < -0.1 || anchor24h < 0)) options.push({ id: 'btc_eth_not_lifting', instruction: 'BTC/ETH 没同步走强时，说清小币独立上涨的局限，不用“半路、顺风、容错”这类套话。' });
  if (lead24h > 18 || Math.abs(lead1h) > 3) options.push({ id: 'move_already_loud', instruction: '波动已经很显眼，判断后续成交是否还能匹配，不用“热闹已经在价格里”之类比喻。' });
  if (lead1h > 0.6 && lead24h > 0) options.push({ id: 'needs_follow_through', instruction: '判断短线强度是否有成交规模支持，直接说结论，不写回踩、承接、止损。' });
  if (['meme', 'contract-meme'].includes(lead.bucket) && lead1h < 0) options.push({ id: 'meme_attention_fading', instruction: 'meme 降温时，用成交和相对强弱说明资金是否转移，不写交易计划。' });
  if (lead1h > 1 && numeric(peer.change1h) < 0) options.push({ id: 'attention_rotation', instruction: '写同组币之间的资金偏好变化；peer 和 anchor 只用一句陪衬。' });
  const fallback = [
    { id: 'one_human_point', instruction: '只写一个具体主旨：这段价格变化说明了什么，不能用换币名也成立的泛话。' },
    { id: 'price_vs_participation', instruction: '围绕价格变化与成交参与是否匹配来写，不要像策略单。' },
    { id: 'one_level_only', instruction: '最多写一个关键位置，说明位置上下对应的市场含义；不要写触发、失效、止损。' }
  ];
  return seededPick(options.length ? options : fallback, seed);
}

function selectStyleCard(pack = {}) {
  const lead = pack.trio?.lead || {};
  const peer = pack.trio?.peer || {};
  const anchor = pack.trio?.anchor || {};
  const seed = `style:${pack.generatedAt || ''}:${lead.symbol || ''}:${peer.symbol || ''}:${anchor.symbol || ''}`;
  const event = pack.marketEvent || {};
  if (event.type === 'low_signal') {
    return seededPick([
      { id: 'quiet_plain_note', instruction: '把“为什么眼下没有优势”说透：先指出最容易误判的现象，再用成交或相对强弱解释。结尾给出哪项变化会让你重新评估，不要只写观望。' },
      { id: 'quiet_relative_note', instruction: '从主角与同组、大盘的差异切入，说明它暂时缺的是成交、强弱还是价格突破。参照币压缩到一句，不能用横盘当作全文结论。' },
      { id: 'quiet_position_note', instruction: '如果存在持仓或成交证据，解释为什么“有人参与”还没有变成方向优势，并指出下一处需要看到的真实变化。' }
    ], seed);
  }
  const options = [
    {
      id: 'desk_decision',
      instruction: '像给熟悉市场的朋友发盘中语音：第一段直接说现在偏向哪边和理由；第二段给证据；最后用一个价位或数据说明什么情况下会改口。'
    },
    {
      id: 'headline_vs_tape',
      instruction: '利用“表面涨跌幅”和“短线真实表现”的反差写，但不要用“多数人看错/真正该看”开头。先点破反差，再说明对参与时机有什么影响。'
    },
    {
      id: 'flow_change',
      instruction: '把资金行为说清楚：成交、持仓或费率发生了什么，价格为什么没有同步。结尾给一个能验证这套解释的观察点。'
    },
    {
      id: 'one_level_decision',
      instruction: '围绕一个关键位置写清选择：站在上方意味着什么，回到下方又意味着什么。不要罗列指标，也不要写成进场单。'
    },
    {
      id: 'relative_choice',
      instruction: '假设三者只能选一个，说明主角为何比 peer/anchor 更有优势或更不值得参与。比较只出现一次，重点落回主角。'
    },
    {
      id: 'positioning_pressure',
      instruction: '从杠杆仓位或盘口压力切入，回答哪一边更着急、价格是否已经给出验证。不能把一个快照夸大成确定趋势。'
    },
    {
      id: 'tradeoff_note',
      instruction: '把机会和代价放在一起讲：参与的理由是什么，最大的反证是什么。两者必须来自本轮数据，不能用万能风险提示。'
    }
  ];
  if (event.confidence === 'high') {
    options.push({
      id: 'specific_debate',
      instruction: '先完整给出自己的判断，最后可以留一个具体分歧点让交易者讨论，例如“这一处是换手还是派发”；不能用泛问句骗互动。'
    });
  }
  if (event.type === 'positioning_without_price') {
    options.push({ id: 'positioning_wait', instruction: '把持仓与价格不匹配写清楚：仓位已经增加，但价格没有给出同等反应。不能猜哪一侧更挤，结尾说明哪种价格变化才算验证。' });
  } else if (['funding_dislocation', 'price_oi_divergence', 'crowded_positioning', 'liquidation_map'].includes(event.type)) {
    options.push({ id: 'positioning_story', instruction: '把仓位、费率或清算写成哪一边正在付出成本、哪一边可能被迫撤退；只引用一到两个核心数字，不写指标流水账。' });
  }
  if (event.type === 'momentum_shift') {
    options.push({ id: 'turning_point', instruction: '围绕旧方向为什么失去力量写，明确短线是否已经改变倾向；结尾给一处让旧判断重新成立的位置。' });
  }
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
  const mode = seededPick(['one', 'one', 'one', 'none', 'none'], seed);
  if (mode === 'none') {
    return { id: 'none', emojis: [], instruction: '本轮不强行使用表情符号，让连续发帖保留真人式变化。' };
  }

  const first = seededPick(pool, `${seed}:first`) || '👀';
  return {
    id: 'one',
    emojis: [first],
    instruction: `正文自然使用 1 个 ${first}；放在最值得停顿的位置，不要固定跟在币种名后面。`
  };
}

function formatTradePlanForPrompt(tradePlan = null) {
  if (!tradePlan) return '';
  const symbol = tradePlan.symbol || '';
  const parts = [`${symbol} 当前方向参考：${tradePlan.bias || '观望'}`];
  if (tradePlan.direction === 'long') {
    if (tradePlan.trigger) parts.push(`站稳 ${humanPriceLevel(tradePlan.trigger)} 才能证明强势还在`);
    if (tradePlan.stopLoss) parts.push(`回到 ${humanPriceLevel(tradePlan.stopLoss)} 下方则原判断不成立`);
  } else if (tradePlan.direction === 'short') {
    if (tradePlan.trigger) parts.push(`跌破 ${humanPriceLevel(tradePlan.trigger)} 才能证明弱势延续`);
    if (tradePlan.stopLoss) parts.push(`重新站上 ${humanPriceLevel(tradePlan.stopLoss)} 则原判断不成立`);
  } else {
    if (tradePlan.trigger) parts.push(`区间边界参考 ${humanPriceLevel(tradePlan.trigger)}`);
  }
  return `${parts.filter(Boolean).join('；')}。这是盘中决策素材，不是委托单；正文最多使用两个位置，用自然语言说明何时值得参与、何时需要改口，不要写“开多/开空/进场/止损/失效”。`;
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

const TRACKED_CLICHES = [
  '热闹', '拿不回', '点开', '容易', '看点', '慢慢挪', '留得住', '卡在半路', '多看一眼', '值得看',
  '这一截', '同场', '相对差', '撑在那里', '撑在场内', '没被顺手拆', '只是一条证据', '快照本身',
  '小时', '日内振幅', '挂单与价格', '挂单和价格', '后面就看', '注意力', '谁先拿下', '才谈得上',
  '更像在', '这边短线', '有人愿意', '关键位置', '暂时还没', '真正跟上'
];
function recentOverusedPhrases(limit = 40) {
  const rows = listRuns(Math.max(60, limit)).filter(r => r.postText && r.status === 'published').slice(0, limit);
  if (rows.length < 8) return [];
  return TRACKED_CLICHES.map(phrase => ({ phrase, count: rows.filter(r => r.postText.includes(phrase)).length }))
    .filter(x => x.count >= Math.max(3, Math.ceil(rows.length * 0.18)))
    .sort((a, b) => b.count - a.count);
}

function editorialBrief(pack = {}, settings = getSettings()) {
  const event = pack.marketEvent || {};
  const reasons = (event.reasons || []).map(x => x.reason).join('、');
  const emojiStyle = selectEmojiStyle(pack);
  const styleCard = selectStyleCard(pack);
  const postAngle = selectPostAngle(pack);
  const lead = pack.trio?.lead || {};
  const seed = `payoff:${pack.generatedAt || ''}:${lead.symbol || ''}:${event.type || ''}`;
  const readerPayoff = seededPick([
    '回答这个位置现在是否值得参与，以及为什么',
    '指出表面涨跌幅掩盖了哪一个交易信号',
    '说明主角相对同组和大盘到底有没有优势',
    '给出一处会让当前判断改变的价位或数据'
  ], seed);
  const stanceInstruction = event.stance === 'bullish'
    ? '立场偏强：说清更适合直接参与、等待回落，还是等待站稳关键位；三者只能选一个。'
    : event.stance === 'bearish'
      ? '立场偏弱：说清弱势延续需要什么条件，以及出现什么变化后你会停止看弱。'
      : '多空证据冲突：不要只说观望，必须指出决定下一步方向的唯一变量。';
  return [
    `本轮唯一论点：${event.claim || `${pack.trio?.lead?.symbol} 当前的价格行为值得核对`}`,
    `事件：${event.type || 'relative_strength'}；倾向：${event.stance || 'mixed'}；置信度：${event.confidence || 'unknown'}`,
    `读者收获：${readerPayoff}`,
    `立场任务：${stanceInstruction}`,
    `最强证据：${evidenceFocus(pack)}`,
    `备选证据：${reasons || '仅使用 facts 中最相关的一项'}`,
    `事件写法：${postAngle?.instruction || '只围绕主角写清一个变化。'}`,
    `表达变化：${styleCard.instruction}`,
    `首屏要求：前 90 个字完成结论和证据；前 35 个字内自然出现 ${cashtag(lead.symbol)}。`,
    event.type === 'low_signal'
      ? '弱信号处理：解释眼下缺少哪一种优势，以及什么变化会让你重新评估；不能只写观望。'
      : '明确信号处理：把事件、证据和参与/反证条件连成一条逻辑，不扩写成全市场复盘。',
    `表情：${emojiStyle.instruction} 全文最多 1 个。`
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
    MIN_POST_CHARS: String(settings.minPostChars || 160),
    MAX_POST_CHARS: String(settings.maxPostChars || 260),
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
    EVIDENCE_FOCUS: evidenceFocus(pack),
    EDITORIAL_BRIEF: editorialBrief(pack, settings),
    RECENT_OVERUSED_PHRASES: overused.length ? overused.map(x => `${x.phrase}（近期出现 ${x.count} 次）`).join('、') : '无',
    EXTERNAL_INTEL_JSON: pack.externalIntel ? JSON.stringify(pack.externalIntel, null, 2) : '',
    OPTIONAL_CONTEXT: optionalContext(pack),
    STOCK_CASHTAGS: pack.stockCashtags || '',
    MACRO_CASHTAGS: pack.macroCashtags || '',
    AI_SECTOR_CASHTAGS: pack.aiSectorCashtags || '',
    STOCK_FACTS: pack.stockFacts || '暂无可用美股/ETF行情数据。',
    AI_SECTOR_FACTS: pack.aiSectorFacts || '暂无可用AI板块行情数据。',
    STOCK_TAKEAWAYS: pack.stockTakeaways || '美股参照数据缺失，本轮不使用美股作为判断依据。',
    AI_TAKEAWAYS: pack.aiTakeaways || 'AI板块数据不足，本轮不强行写AI联动。',
    BANNED_PHRASES: effectiveBannedPhrases(settings).join('、'),
    MARKET_PACK_JSON: JSON.stringify(pack, null, 2)
  };
  return String(template || '').replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, key) => vars[key] ?? '');
}

function mockGenerate(pack) {
  const { lead, peer, anchor } = pack.trio;
  const l = cashtag(lead.symbol), p = cashtag(peer.symbol), a = cashtag(anchor.symbol);
  const leadStronger = Number(lead.change1h || 0) >= Number(peer.change1h || 0);
  const facts = (pack.facts || []).slice(0, 3).join('；');
  const plan = formatTradePlanForPrompt(pack.tradePlan);
  if (leadStronger) return `成交和短线强弱同时指向 ${l} ，这次不是只靠涨幅榜吸引注意。${facts}。\n\n${p} 和 ${a} 只用来确认它确实领先。${plan} 真要参与，先看关键位置能否站稳，再决定这段强势是否值得继续跟。`;
  return `短线掉队最明显的是 ${l} ，问题不只是跌幅，而是成交没有换来相对优势。${facts}。\n\n${p} 和 ${a} 同期表现更稳。${plan} 在价格重新证明自己以前，把这段当成弱势处理比猜反转更有依据。`;
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
  // Cashtags are a publishing feature on Binance Square, not merely a writing
  // preference. Normalize every known market symbol before any validation and
  // return this exact normalized text to the publisher.
  const clean = normalizeCashtags(compactText(text), pack, settings);
  const len = [...clean].length;
  const configuredMin = Number(settings.minPostChars || 160);
  // Treat the configured minimum as an editorial target, with only a narrow
  // 10-character tolerance. This keeps 150+ character drafts that already make
  // the point, without restoring the old 110-character loophole that produced
  // thin posts and unnecessary multi-model repair loops.
  const hardMin = configuredMin >= 150 ? configuredMin - 10 : configuredMin;
  if (len < hardMin) errors.push(`too_short:${len}`);
  if (len > Number(settings.maxPostChars || 260)) errors.push(`too_long:${len}`);
  const fixedBanned = ['不构成投资建议', '以上仅供参考', '公开信息显示', '简短原因', '简要原因', '可能原因', '需注意风险', '暂无可用美股/ETF行情数据', '美股参照数据缺失', '本轮不使用美股作为判断依据', '暂无可用AI板块行情数据', 'AI板块数据不足'];
  const banned = effectiveBannedPhrases(settings, fixedBanned);
  for (const phrase of banned) {
    if (clean.includes(phrase)) errors.push(`banned_phrase:${phrase}`);
  }
  // Repetition history is editorial guidance, not a hard publish gate. Making
  // every recently frequent word a validation error caused long repair loops
  // and reduced post volume during otherwise valid market runs.
  if (settings.requireCashtags) {
    for (const symbol of [pack.trio.lead.symbol, pack.trio.peer.symbol, pack.trio.anchor.symbol]) {
      if (!clean.includes(cashtag(symbol))) errors.push(`missing_cashtag:${symbol}`);
      const clickable = new RegExp(`\\$${escapeRegExp(String(symbol || '').toUpperCase())}(?=\\s|$)`);
      if (!clickable.test(clean)) errors.push(`unclickable_cashtag_boundary:${symbol}`);
    }
    const [leadSymbolRaw, peerSymbolRaw, anchorSymbolRaw] = [pack.trio.lead.symbol, pack.trio.peer.symbol, pack.trio.anchor.symbol].map(s => String(s || '').toUpperCase());
    for (const [symbol, max] of [[leadSymbolRaw, 2], [peerSymbolRaw, 1], [anchorSymbolRaw, 1]]) {
      const count = (clean.match(new RegExp(`\\$${escapeRegExp(symbol)}(?=\\s|$)`, 'g')) || []).length;
      if (count > max) errors.push(`cashtag_repeated:${symbol}:${count}`);
    }
  }
  const tradeMode = String(settings.tradePlanMode || '').toLowerCase().replace(/-/g, '_');
  if (!['off', 'opinion', 'soft_opinion'].includes(tradeMode) && settings.includeTradePlan !== false && pack.tradePlan) {
    if (!/(偏多|偏空|看多|看空|观望|不追|不碰|回踩|突破|跌破|放弃|等|空仓|少碰|过滤)/.test(clean)) errors.push('missing_trade_stance');
  }
  const metricHits = new Set(clean.match(/现价|1h|4h|24h|成交额|振幅|前20档|点差|买盘厚|卖压厚|资金费率|持仓|OI|主动买卖比/g) || []);
  if (metricHits.size > 4) errors.push(`too_many_metrics:${metricHits.size}`);
  for (const word of ['价格', '节奏', '方向', '波动', '注意力', '挂单', '热度', '晃']) {
    const count = clean.split(word).length - 1;
    if (count >= 3) errors.push(`repeated_word:${word}:${count}`);
  }
  const firstSentence = clean.split(/[。！？]/)[0] || '';
  const leadSymbol = String(pack.trio?.lead?.symbol || '').toUpperCase();
  if (leadSymbol && !firstSentence.toUpperCase().includes(leadSymbol)) errors.push('lead_missing_from_opening');
  if (/^\s*\$[A-Z0-9]{1,16}\b/.test(clean) || /^\s*(这轮|这笔|这单|现在|偏空|偏多|我这边只盯|追高|不追|别被|多数人|别只|真正该看的是)/.test(clean)) errors.push('formulaic_opening');
  const sim = maxRecentSimilarity(clean, settings);
  if (sim >= Number(settings.similarityThreshold || 0.72)) errors.push(`too_similar:${sim.toFixed(2)}`);
  return { ok: errors.length === 0, errors, text: clean, length: len };
}

function validationError(validation) {
  return `post_validation_failed:${validation.errors.join(',')}`;
}

function repairPromptForPost(text, validation, pack, settings = getSettings()) {
  const min = Number(settings.minPostChars || 160);
  const max = Number(settings.maxPostChars || 260);
  const symbols = [pack.trio.lead.symbol, pack.trio.peer.symbol, pack.trio.anchor.symbol];
  const tags = symbols.map(cashtag).join(' ');
  return `下面这条 Binance Square 正文已经生成，但没有通过本地校验：${validation.errors.join(',')}。

请只输出改写后的最终正文，不解释过程。

硬性要求：
1. 字数必须在 ${min} 到 ${max} 个中文字符之间，不能超过 ${max}。
2. 根据内容选择 1 个紧凑段落或 2 个短段落，不要每篇固定同一种结构；若分段，每段必须提供新信息。
3. 必须保留并自然提到这 3 个 Cashtag：${tags}；每个 Cashtag 后必须有半角空格，例如“$BTC 走强”“$SOL 和 $ETH 同步”。其他市场代码也必须写成 $SYMBOL。
4. 正文只围绕一个明确判断：眼下偏强、偏弱，还是证据冲突；必须解释原因，不能只贴“真强/真弱/分歧”标签。
5. 只能使用 facts / takeaways / market pack 里的真实数据，禁止编造。
6. 前 90 个字内完成“明确结论 + 最强证据”，让用户不展开全文也能看懂主旨。
7. 最多写 3 个关键数字；从成交、持仓、费率、盘口、关键位中只选最有用的两类。
8. 可以使用一个参与条件和一个反证条件，但要像真人说话；不要写开多、开空、进场、止损、失效或“这单我不碰”。
9. peer 和 anchor 只能各出现一次，必须合在同一个短句里；主角 Cashtag 最多两次。
10. 不得以 Cashtag、价格、涨跌幅、“这轮/这笔/这单/现在/偏多/偏空/不追/追高/多数人”开头。
11. 不要写“反抽/承接/压住手/容错低/我的处理是/计划偏多/计划偏空/条件计划/只做条件”。
12. 不要标题、项目符号、Markdown、免责声明或报告腔。
13. 如果美股/ETF或AI板块参照缺失，正文直接忽略缺失部分。
14. 禁止出现这些表达：${effectiveBannedPhrases(settings).join('、')}。
15. ${selectEmojiStyle(pack).instruction} 全文最多 1 个；不要使用 🚀、🤑、💯。
16. “价格、节奏、方向、波动、注意力、挂单、热度”等实词各自最多出现 2 次。
17. 第一句前 35 个字内自然出现主角 ${cashtag(pack.trio?.lead?.symbol || '')}，但不能以 Cashtag 开头。

原文：
${text}

facts：
${(pack.facts || []).join('\n')}

交易解读：
${(pack.takeaways || []).join('\n')}

条件计划：
${formatTradePlanForPrompt(pack.tradePlan)}

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
  const basePrompt = renderTemplate(prompt.content, pack, settings);
  const hasEditorialPlaceholder = /\{\{\s*EDITORIAL_BRIEF\s*\}\}/.test(prompt.content || '');
  const runtimeBrief = hasEditorialPlaceholder ? '' : `\n\n【本轮编辑指令】\n${editorialBrief(pack, settings)}`;
  const renderedPrompt = `${basePrompt}${runtimeBrief}\n\n【运行时事实，不得照抄 JSON】\n近期过度使用、这次必须避开的词：${recentOverusedPhrases().map(x => x.phrase).join('、') || '无'}。\n结构化事件：\n${JSON.stringify(pack.marketEvent || {}, null, 2)}`;
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
          console.warn(`[llm] validation failed: ${label}: ${validationError(validation)}`);
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
            console.warn(`[llm] repair validation failed: ${label}: ${validationError(repaired.validation)}`);
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

module.exports = { generatePost, validatePostText, renderTemplate, cashtag, normalizeCashtags, humanPriceLevel, callOpenAIWithCandidate, effectiveMaxTokens, selectPostAngle, selectStyleCard, selectEmojiStyle, effectiveBannedPhrases, recentOverusedPhrases, editorialBrief, evidenceFocus, optionalContext };
