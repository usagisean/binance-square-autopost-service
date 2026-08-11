const { postJson, request } = require('./httpClient');
const { config } = require('./config');
const { getSettings, getActivePrompt, getSecrets, getLlmCandidates, listRuns } = require('./store');
const { ASSET_UNIVERSE, CONTRACT_META, DEFAULT_BANNED_PHRASES } = require('./assetUniverse');
const { buildEditorialDecision, STRATEGY_VERSION } = require('./editorialStrategy');

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

function safeExternalIntel(pack = {}) {
  const intel = pack.externalIntel && typeof pack.externalIntel === 'object' ? pack.externalIntel : {};
  const { onchainApiKeys, ...safe } = intel;
  return {
    ...safe,
    // The model only needs to know which sources are configured. Never place
    // stored provider credentials inside a prompt or an LLM relay request.
    onchainProviders: Object.entries(onchainApiKeys || {}).filter(([, value]) => Boolean(value)).map(([name]) => name)
  };
}

function promptSafeMarketPack(pack = {}) {
  const symbols = [pack.trio?.lead?.symbol, pack.trio?.peer?.symbol, pack.trio?.anchor?.symbol].filter(Boolean);
  const intel = Object.fromEntries(symbols.map(symbol => {
    const row = pack.marketIntel?.symbols?.[symbol] || {};
    const depth = row.depth || {};
    return [symbol, {
      markPrice: row.markPrice ?? null,
      indexPrice: row.indexPrice ?? null,
      fundingRate: row.fundingRate ?? null,
      openInterest: row.openInterest ?? null,
      openInterestValueChange5m: row.openInterestValueChange5m ?? null,
      globalLongShortAccountRatio: row.globalLongShortAccountRatio ?? null,
      topLongShortPositionRatio: row.topLongShortPositionRatio ?? null,
      takerBuySellRatio: row.takerBuySellRatio ?? null,
      spreadBps: row.spreadBps ?? null,
      depth: {
        available: depth.available === true,
        imbalance: depth.imbalance ?? null,
        bidNotional: depth.bidNotional ?? null,
        askNotional: depth.askNotional ?? null
      }
    }];
  }));
  const derivatives = Object.fromEntries(symbols
    .filter(symbol => pack.publicDerivatives?.symbols?.[symbol])
    .map(symbol => [symbol, pack.publicDerivatives.symbols[symbol]]));
  const compactCoinglass = {};
  for (const key of ['heatmap', 'liquidation', 'openInterest', 'longShort', 'orderbookAskBids']) {
    const row = pack.coinglass?.[key];
    if (!row || typeof row !== 'object') continue;
    compactCoinglass[key] = {
      available: row.available === true,
      summary: row.summary || null,
      changePct: row.changePct ?? null,
      longPercent: row.longPercent ?? null,
      shortPercent: row.shortPercent ?? null,
      topAbove: row.topAbove ?? null,
      topBelow: row.topBelow ?? null
    };
  }
  return {
    timestamp: pack.generatedAt || null,
    source: pack.source || null,
    trio: pack.trio || null,
    marketEvent: pack.marketEvent || null,
    tradePlan: pack.tradePlan || null,
    marketIntel: { source: pack.marketIntel?.source || null, symbols: intel },
    publicDerivatives: { ok: pack.publicDerivatives?.ok === true, source: pack.publicDerivatives?.source || null, symbols: derivatives },
    coinglass: { ok: pack.coinglass?.ok === true, source: pack.coinglass?.source || null, pair: pack.coinglass?.pair || null, ...compactCoinglass },
    tradfi: pack.tradfi?.ok === true ? { ok: true, source: pack.tradfi.source, assets: pack.tradfi.assets } : { ok: false },
    sector: pack.sector || {},
    externalIntel: safeExternalIntel(pack)
  };
}
// Old installations persisted the then-default banned phrase list into
// settings.json. “止损” used to be banned there, so merely removing it from the
// source default would not unlock the new trade-card mode on an upgraded VPS.
const BANNED_PHRASE_EXEMPTIONS = new Set(['现价', '1h', '4h', '24h', '止损', '止盈', '做多', '做空']);
function effectiveBannedPhrases(settings = getSettings(), extras = []) {
  return [...new Set([...extras, ...DEFAULT_BANNED_PHRASES, ...(settings.bannedPhrases || [])]
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .filter(s => !BANNED_PHRASE_EXEMPTIONS.has(s)))];
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
  if (aiSymbols.has(String(lead.symbol || '').toUpperCase()) && !/不足|缺失/.test(String(pack.aiTakeaways || ''))) options.push({ id: 'ai_coin_attention', instruction: '主角是 AI 币时，原因段写它在同板块里的成交和相对强弱是否占优；不要重复首行交易卡。' });
  if (lead1h > 1.2 && (anchor1h < -0.1 || anchor24h < 0)) options.push({ id: 'btc_eth_not_lifting', instruction: 'BTC/ETH 没同步走强时，说清小币独立上涨的局限，不用“半路、顺风、容错”这类套话。' });
  if (lead24h > 18 || Math.abs(lead1h) > 3) options.push({ id: 'move_already_loud', instruction: '波动已经很显眼，判断后续成交是否还能匹配，不用“热闹已经在价格里”之类比喻。' });
  if (lead1h > 0.6 && lead24h > 0) options.push({ id: 'needs_follow_through', instruction: '判断短线强度是否有成交规模支持，直接说结论；分析段不要再重复首行的交易价位。' });
  if (['meme', 'contract-meme'].includes(lead.bucket) && lead1h < 0) options.push({ id: 'meme_attention_fading', instruction: 'meme 降温时，原因段用成交和相对强弱说明资金是否转移，不重复首行交易卡。' });
  if (lead1h > 1 && numeric(peer.change1h) < 0) options.push({ id: 'attention_rotation', instruction: '写同组币之间的资金偏好变化；peer 和 anchor 只用一句陪衬。' });
  const fallback = [
    { id: 'one_human_point', instruction: '只写一个具体主旨：这段价格变化说明了什么，不能用换币名也成立的泛话。' },
    { id: 'price_vs_participation', instruction: '围绕价格变化与成交参与是否匹配来写，不要像策略单。' },
    { id: 'one_level_only', instruction: '分析段只解释一个最关键的位置，其他执行价位留在首行交易卡，不要重复。' }
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
      instruction: '像给熟悉市场的朋友发一条语音：先直接说偏向哪边和理由，再给证据，最后用一个价位或数据说明什么情况下会改口。'
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
      instruction: '分析段围绕最关键的位置解释市场含义，不罗列指标，也不重复首行的止损止盈。'
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
  const tag = `${cashtag(symbol)} `;
  const trigger = humanPriceLevel(tradePlan.trigger);
  const stop = humanPriceLevel(tradePlan.stopLoss);
  const tp1 = humanPriceLevel(tradePlan.takeProfit1);
  const tp2 = humanPriceLevel(tradePlan.takeProfit2);
  if (tradePlan.direction === 'long') {
    return `做多 ${tag}：站稳 ${trigger} 后才生效；止损 ${stop}；止盈先看 ${tp1}${tp2 ? `，再看 ${tp2}` : ''}。止盈位是按本轮结构风险的 1.2R / 2R 计算，不代表价格必然到达。`;
  }
  if (tradePlan.direction === 'short') {
    return `做空 ${tag}：跌破 ${trigger} 后才生效；止损 ${stop}；止盈先看 ${tp1}${tp2 ? `，再看 ${tp2}` : ''}。止盈位是按本轮结构风险的 1.2R / 2R 计算，不代表价格必然到达。`;
  }
  return `观望 ${tag}：区间边界参考 ${humanPriceLevel(tradePlan.trigger)}；证据冲突时不编造止损或止盈。`;
}

function tradeCardInstruction(tradePlan = null, pack = {}) {
  if (!tradePlan) return '本轮没有可靠交易计划，正文不得自行编造方向、止损或止盈。';
  const seed = `trade-card:${pack.generatedAt || ''}:${tradePlan.symbol || ''}:${tradePlan.direction || ''}`;
  const tag = `${cashtag(tradePlan.symbol)} `;
  const trigger = humanPriceLevel(tradePlan.trigger);
  const stop = humanPriceLevel(tradePlan.stopLoss);
  const tp1 = humanPriceLevel(tradePlan.takeProfit1);
  const tp2 = humanPriceLevel(tradePlan.takeProfit2);
  if (tradePlan.direction === 'long') {
    const card = seededPick([
      `做多 ${tag}：站稳 ${trigger} 再参与，止损 ${stop}，止盈先看 ${tp1}、再看 ${tp2}。`,
      `做多 ${tag}：${trigger} 上方生效；止损 ${stop}，两档止盈 ${tp1} / ${tp2}。`,
      `做多 ${tag}：等 ${trigger} 站稳，止损放 ${stop}；止盈看 ${tp1}，强则看 ${tp2}。`,
      `做多 ${tag}：触发看 ${trigger}，止损 ${stop}；先在 ${tp1} 止盈，余仓看 ${tp2}。`
    ], seed);
    return `${card}\n首句可按这个语序写，四个数字必须原样使用；两档止盈来自 1.2R / 2R 风险倍数，不得写成必达目标。`;
  }
  if (tradePlan.direction === 'short') {
    const card = seededPick([
      `做空 ${tag}：跌破 ${trigger} 再参与，止损 ${stop}，止盈先看 ${tp1}、再看 ${tp2}。`,
      `做空 ${tag}：${trigger} 下方生效；止损 ${stop}，两档止盈 ${tp1} / ${tp2}。`,
      `做空 ${tag}：等 ${trigger} 跌破，止损放 ${stop}；止盈看 ${tp1}，弱则看 ${tp2}。`,
      `做空 ${tag}：触发看 ${trigger}，止损 ${stop}；先在 ${tp1} 止盈，余仓看 ${tp2}。`
    ], seed);
    return `${card}\n首句可按这个语序写，四个数字必须原样使用；两档止盈来自 1.2R / 2R 风险倍数，不得写成必达目标。`;
  }
  return `观望 ${tag}：${humanPriceLevel(tradePlan.trigger)} 区间尚未给出单边优势。证据冲突时不编造止损或止盈。`;
}

function executionGuide(decision = {}, tradePlan = null, pack = {}) {
  if (!tradePlan) return '没有可核对的结构价位。本轮只写市场判断，不得自行编造入场、止损或止盈。';
  const tag = `${cashtag(tradePlan.symbol || pack.trio?.lead?.symbol || '')} `;
  const trigger = humanPriceLevel(tradePlan.trigger);
  const stop = humanPriceLevel(tradePlan.stopLoss);
  const tp1 = humanPriceLevel(tradePlan.takeProfit1);
  const tp2 = humanPriceLevel(tradePlan.takeProfit2);
  if (decision.requiresTradeCard && tradePlan.direction === 'long') {
    return `A 级偏多方案：${tag} 只有站稳 ${trigger} 才考虑参与，防守放在 ${stop}，第一目标 ${tp1}${tp2 ? `；若走势干净，余仓再参考 ${tp2}` : ''}。必须写成条件方案，不能暗示现价立刻买入。`;
  }
  if (decision.requiresTradeCard && tradePlan.direction === 'short') {
    return `A 级偏空方案：${tag} 只有跌破 ${trigger} 才考虑参与，防守放在 ${stop}，第一目标 ${tp1}${tp2 ? `；若弱势延续，余仓再参考 ${tp2}` : ''}。必须写成条件方案，不能暗示现价立刻卖出。`;
  }
  const basis = tradePlan.basis || {};
  const reference = tradePlan.direction === 'watch'
    ? `${humanPriceLevel(basis.tacticalLow || basis.recentLow)}—${humanPriceLevel(basis.tacticalHigh || basis.recentHigh)}`
    : trigger;
  return `${decision.setupGrade || 'B'} 级内容：只能引用一个改变赔率的位置（${reference || '无可靠位置'}）；用它说明什么时候交易价值会明显上升，不要写“做多/做空/止损/止盈”。`;
}

function selectHumorStyle(pack = {}) {
  const lead = pack.trio?.lead || {};
  const event = pack.marketEvent || {};
  const seed = `humor:${pack.generatedAt || ''}:${lead.symbol || ''}:${event.type || ''}`;
  return seededPick([
    {
      id: 'none',
      instruction: '本轮不强行搞笑，保持干净直接；连续发帖需要有些帖子完全不带笑点。'
    },
    {
      id: 'dry_discipline',
      instruction: '原因段允许半句克制冷幽默，笑点来自“行情很会诱惑人，但仓位纪律更重要”的反差；不要复用固定金句。'
    },
    {
      id: 'data_deadpan',
      instruction: '原因段允许一句淡淡吐槽，让涨幅表象与成交/盘口事实形成反差；不能把币或市场过度拟人化。'
    },
    {
      id: 'desk_banter',
      instruction: '像交易员和熟人聊天那样轻松一句，可以自嘲判断会错，但不能用网络烂梗、夸张比喻或喊单腔。'
    },
    {
      id: 'none',
      instruction: '本轮不强行搞笑，信息密度优先。'
    }
  ], seed);
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
  '更像在', '这边短线', '有人愿意', '关键位置', '暂时还没', '真正跟上', '盘中', '我的选择是'
];
function recentOverusedPhrases(limit = 40) {
  const rows = listRuns(Math.max(60, limit)).filter(r => r.postText && r.status === 'published').slice(0, limit);
  if (rows.length < 8) return [];
  return TRACKED_CLICHES.map(phrase => ({ phrase, count: rows.filter(r => r.postText.includes(phrase)).length }))
    .filter(x => x.count >= Math.max(3, Math.ceil(rows.length * 0.18)))
    .sort((a, b) => b.count - a.count);
}

function resolveEditorialDecision(pack = {}, settings = getSettings()) {
  if (Number(pack.editorialDecision?.version) === STRATEGY_VERSION) return pack.editorialDecision;
  // Read enough history to cover a full high-volume day even when the user has
  // raised the local quota to Binance's 100-post ceiling.
  const historyLimit = Math.max(160, Number(settings.maxDailyPosts || 50) * 2);
  const decision = buildEditorialDecision(pack, settings, listRuns(historyLimit));
  pack.editorialDecision = decision;
  return decision;
}

function editorialBrief(pack = {}, settings = getSettings()) {
  const event = pack.marketEvent || {};
  const decision = resolveEditorialDecision(pack, settings);
  const reasons = (event.reasons || []).map(x => x.reason).join('、');
  const emojiStyle = selectEmojiStyle(pack);
  const humorStyle = selectHumorStyle(pack);
  return [
    '策略版本：senior-trader-v3。它优先于旧 Prompt 中要求每帖都写“做多/做空+止损止盈”的规则。',
    `本轮等级：${decision.setupGrade}；类型：${decision.archetype}；倾向：${decision.stance}`,
    `唯一论点：${decision.thesis}`,
    `读者收获：${decision.readerPromise}`,
    `点击价值：${decision.conversionInstruction}`,
    `事件处理：${decision.archetypeInstruction}`,
    `开场方式：${decision.openingInstruction}`,
    `执行尺度：${decision.executionInstruction}`,
    `可用执行参考：${executionGuide(decision, pack.tradePlan, pack)}`,
    `结构：${decision.structureInstruction}`,
    `最强证据：${evidenceFocus(pack)}`,
    `备选证据：${reasons || '仅使用 facts 中最相关的一项'}`,
    '证据顺序：真实事件/合约仓位与清算 > 价格成交与结构 > 相对强弱 > 单次盘口快照。低等级证据不能包装成高确信度结论。',
    `首屏要求：前 90 个字必须完成“主角为什么比参照币更值得打开交易页 + 最强证据”；${decision.requiresTradeCard ? '本轮允许一次明确方向方案。' : '本轮禁止出现做多、做空、止损、止盈。'}`,
    `幽默：${humorStyle.instruction} 全文最多一处；没有自然笑点就完全不写。`,
    '标签限制：正文只能出现 lead、peer、anchor 这 3 个不同 Cashtag；Square 超过 3 个交易标签会拒绝发布。',
    `表情：${emojiStyle.instruction} 全文最多 1 个。`
  ].join('\n');
}

function renderTemplate(template, pack, settings = getSettings()) {
  const lead = pack.trio.lead.symbol;
  const peer = pack.trio.peer.symbol;
  const anchor = pack.trio.anchor.symbol;
  const decision = resolveEditorialDecision(pack, settings);
  const postAngle = selectPostAngle(pack);
  const styleCard = selectStyleCard(pack);
  const emojiStyle = selectEmojiStyle(pack);
  const humorStyle = selectHumorStyle(pack);
  const voiceAngle = `${decision.archetypeInstruction} ${decision.openingInstruction}`;
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
    HUMOR_STYLE: humorStyle?.instruction || '',
    HUMOR_STYLE_ID: humorStyle?.id || '',
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
    TRADE_PLAN: executionGuide(decision, pack.tradePlan, pack),
    TRADE_CARD: executionGuide(decision, pack.tradePlan, pack),
    EXECUTION_GUIDE: executionGuide(decision, pack.tradePlan, pack),
    TRADE_PLAN_JSON: pack.tradePlan ? JSON.stringify(pack.tradePlan, null, 2) : '',
    EDITORIAL_DECISION_JSON: JSON.stringify(decision, null, 2),
    SETUP_GRADE: decision.setupGrade,
    CONTENT_ARCHETYPE: decision.archetype,
    RECENT_POSTS: recentPostBrief(settings),
    MARKET_EVENT_JSON: JSON.stringify(pack.marketEvent || {}, null, 2),
    EVIDENCE_FOCUS: evidenceFocus(pack),
    EDITORIAL_BRIEF: editorialBrief(pack, settings),
    RECENT_OVERUSED_PHRASES: overused.length ? overused.map(x => `${x.phrase}（近期出现 ${x.count} 次）`).join('、') : '无',
    EXTERNAL_INTEL_JSON: JSON.stringify(safeExternalIntel(pack), null, 2),
    OPTIONAL_CONTEXT: optionalContext(pack),
    STOCK_CASHTAGS: pack.stockCashtags || '',
    MACRO_CASHTAGS: pack.macroCashtags || '',
    AI_SECTOR_CASHTAGS: pack.aiSectorCashtags || '',
    STOCK_FACTS: pack.stockFacts || '暂无可用美股/ETF行情数据。',
    AI_SECTOR_FACTS: pack.aiSectorFacts || '暂无可用AI板块行情数据。',
    STOCK_TAKEAWAYS: pack.stockTakeaways || '美股参照数据缺失，本轮不使用美股作为判断依据。',
    AI_TAKEAWAYS: pack.aiTakeaways || 'AI板块数据不足，本轮不强行写AI联动。',
    BANNED_PHRASES: effectiveBannedPhrases(settings).join('、'),
    MARKET_PACK_JSON: JSON.stringify(promptSafeMarketPack(pack), null, 2)
  };
  return String(template || '').replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, key) => vars[key] ?? '');
}

function mockGenerate(pack) {
  const { lead, peer, anchor } = pack.trio;
  const l = cashtag(lead.symbol), p = cashtag(peer.symbol), a = cashtag(anchor.symbol);
  const decision = pack.editorialDecision || buildEditorialDecision(pack, getSettings(), []);
  const leadStronger = Number(lead.change1h || 0) >= Number(peer.change1h || 0);
  const trigger = humanPriceLevel(pack.tradePlan?.trigger);
  const stop = humanPriceLevel(pack.tradePlan?.stopLoss);
  const tp1 = humanPriceLevel(pack.tradePlan?.takeProfit1);
  if (decision.requiresTradeCard && pack.tradePlan?.direction === 'long') {
    return `${l} 放量站稳 ${trigger}，我才会考虑做多；止损放 ${stop}，第一目标看 ${tp1}。它近 1h ${signedPct(lead.change1h)}，24h 成交额 ${shortUsd(lead.volume24h)}，价格和参与度暂时同向；${p} 和 ${a} 同期都没有给出更强的变化。条件没到就没有订单，到了以后成交若迅速缩回，防守位照常执行。`;
  }
  if (decision.requiresTradeCard && pack.tradePlan?.direction === 'short') {
    return `${l} 放量跌破 ${trigger}，我才会考虑做空；止损放 ${stop}，第一目标看 ${tp1}。它近 1h ${signedPct(lead.change1h)}，24h 成交额 ${shortUsd(lead.volume24h)}，弱势不是一笔小单造成；${p} 和 ${a} 同期都更稳。条件没到就没有订单，触发后若价格很快收回，防守位照常执行。`;
  }
  if (decision.setupGrade === 'A') {
    return `这三个币里，我会先把 ${l} 留在交易页。它近 1h ${signedPct(lead.change1h)}，24h 成交额已有 ${shortUsd(lead.volume24h)}，相对强弱和真实参与度同时改善；${p} 和 ${a} 没有出现同样的变化。${trigger || '上一轮高点'} 是赔率开关：量价一起越过去，资金可能继续往主角集中；价格过去、成交没跟，说明这份优势只是暂借的。`;
  }
  if (decision.setupGrade === 'B' || leadStronger) {
    return `${l} 的优势不在涨得最多，而在最近 1h ${signedPct(lead.change1h)} 时，成交规模仍有 ${shortUsd(lead.volume24h)}，说明它不是靠几笔小单刷存在感。${p} 和 ${a} 的短线变化都更平，三者放在一起，主角更像资金正在筛选的方向。${trigger || '区间上沿'} 附近如果量能再抬一档，交易价值会明显增加；只有价格过去而成交掉队，这个判断才需要收回。`;
  }
  return `${l} 眼下最容易被当作机会：波动出现了，成交却没有换来相对优势。${p} 和 ${a} 同期更稳，说明资金还没把主角当成优先选择。真正能让交易价值上升的，不是再来一根随机 K 线，而是 ${trigger || '区间边界'} 附近出现放量并把强弱差拉开；在那之前，把它留在自选里比匆忙下单更合理。`;
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
      'User-Agent': 'binance-square-autopost-service/0.2',
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

function openingFingerprint(text) {
  const first = String(text || '').split(/[。！？\n]/)[0] || '';
  return [...first
    .replace(/\$[A-Z][A-Z0-9]{0,23}/g, '$COIN')
    .replace(/\d+(?:[.,]\d+)?/g, '#')
    .replace(/\s+/g, '')]
    .slice(0, 72)
    .join('');
}

function maxRecentOpeningSimilarity(text) {
  const current = openingFingerprint(text);
  if ([...current].length < 16) return 0;
  const base = textBigrams(current);
  let max = 0;
  for (const run of listRuns(40).filter(r => r.postText && r.status === 'published').slice(0, 16)) {
    const other = openingFingerprint(run.postText);
    if ([...other].length >= 16) max = Math.max(max, jaccard(base, textBigrams(other)));
  }
  return max;
}

function textHasLevel(text, value) {
  const expected = humanPriceLevel(value).replace(/,/g, '');
  if (!expected) return false;
  return String(text || '').replace(/,/g, '').includes(expected);
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
    const distinctTags = [...clean.matchAll(/\$([A-Z][A-Z0-9]{0,23})(?=\s|$)/g)].map(match => match[1]);
    const distinctCount = new Set(distinctTags).size;
    if (distinctCount > 3) errors.push(`too_many_distinct_cashtags:${distinctCount}`);
  }
  const decision = resolveEditorialDecision(pack, settings);
  const tradeCardMode = decision.requiresTradeCard === true && settings.includeTradePlan !== false;
  if (tradeCardMode && pack.tradePlan) {
    const plan = pack.tradePlan;
    const opening = [...clean].slice(0, 140).join('');
    if (plan.direction === 'long' || plan.direction === 'short') {
      const directionWord = plan.direction === 'long' ? '做多' : '做空';
      if (!opening.includes(directionWord)) errors.push(`trade_direction_mismatch:${plan.direction}`);
      if (!opening.includes('止损')) errors.push('missing_stop_loss_in_opening');
      if (!/(止盈|目标)/.test(opening)) errors.push('missing_take_profit_in_opening');
      if (!textHasLevel(opening, plan.trigger)) errors.push('missing_trigger_level_in_opening');
      if (!textHasLevel(opening, plan.stopLoss)) errors.push('missing_stop_level_in_opening');
      if (!textHasLevel(opening, plan.takeProfit1)) errors.push('missing_take_profit_1_in_opening');
    }
  } else {
    const opening = [...clean].slice(0, 140).join('');
    if (/(做多|做空)/.test(clean)) errors.push(`explicit_direction_not_allowed:${decision.setupGrade}`);
    if (/(止损|止盈)/.test(clean)) errors.push(`explicit_risk_card_not_allowed:${decision.setupGrade}`);
    if (/(做多|做空)/.test(opening) && /止损/.test(opening) && /(止盈|目标)/.test(opening)) errors.push(`overstated_execution_for_grade:${decision.setupGrade}`);
  }
  // Count evidence families rather than raw labels. A single order-book sentence
  // may naturally contain “前20档/点差/卖压厚”, and “OI/持仓” are synonyms;
  // treating each word as a separate metric caused useful drafts to be rejected.
  const metricFamilies = [
    /现价/, /1h/i, /4h/i, /24h/i, /成交额|振幅/,
    /前20档|点差|买盘厚|卖压厚/, /资金费率/, /持仓|\bOI\b/i, /主动买卖比/
  ];
  const metricCount = metricFamilies.filter(pattern => pattern.test(clean)).length;
  if (metricCount > 5) errors.push(`too_many_metrics:${metricCount}`);
  for (const word of ['价格', '节奏', '方向', '波动', '注意力', '挂单', '热度', '晃']) {
    const count = clean.split(word).length - 1;
    if (count >= 3) errors.push(`repeated_word:${word}:${count}`);
  }
  const firstSentence = clean.split(/[。！？]/)[0] || '';
  const leadSymbol = String(pack.trio?.lead?.symbol || '').toUpperCase();
  if (leadSymbol && !firstSentence.toUpperCase().includes(leadSymbol)) errors.push('lead_missing_from_opening');
  if (!tradeCardMode && (/^\s*(这轮|这笔|这单|现在|盘中|我这边只盯|多数人|真正该看的是)/.test(clean))) errors.push('formulaic_opening');
  const sim = maxRecentSimilarity(clean, settings);
  if (sim >= Number(settings.similarityThreshold || 0.72)) errors.push(`too_similar:${sim.toFixed(2)}`);
  const openingSimilarity = maxRecentOpeningSimilarity(clean);
  if (openingSimilarity >= 0.76) errors.push(`opening_too_similar:${openingSimilarity.toFixed(2)}`);
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
  const decision = resolveEditorialDecision(pack, settings);
  const tradeCardMode = decision.requiresTradeCard === true;
  const openingRule = tradeCardMode
    ? `前 140 个字内自然写清方向、触发、防守和第一目标，不要求用固定句式开头：${executionGuide(decision, pack.tradePlan, pack)}`
    : `${decision.executionInstruction} 全文禁止出现“做多、做空、止损、止盈”，只写偏向、可交易性和一个赔率开关。`;
  return `下面这条 Binance Square 正文已经生成，但没有通过本地校验：${validation.errors.join(',')}。

请只输出改写后的最终正文，不解释过程。

硬性要求：
1. 字数必须在 ${min} 到 ${max} 个中文字符之间，不能超过 ${max}。
2. 本轮属于 ${decision.setupGrade} 级 ${decision.archetype}；结构要求：${decision.structureInstruction}
3. 必须保留并自然提到这 3 个 Cashtag：${tags}；每个 Cashtag 后必须有半角空格，例如“$BTC 走强”“$SOL 和 $ETH 同步”。全文只能出现这 3 个不同 Cashtag，不得加入第 4 个币、股票或 ETF 标签。
4. ${openingRule}
5. 只能使用 facts / takeaways / market pack 里的真实数据，禁止编造。
6. ${tradeCardMode ? '前 140 个字内写完方向、触发、防守和第一目标；第二目标可以省略。' : '前 90 个字内说清主角为什么比参照币更值得打开交易页，并给出最强证据；不要写做多、做空、止损或止盈。'}
7. 交易卡数字不计入证据数量；原因段最多再写 3 个关键数字，只选最有用的两类证据。
8. 原因段必须围绕主角解释这一方向，不得再复述交易卡全部数字，也不能同时给相反方向。
9. peer 和 anchor 只能各出现一次，必须合在同一个短句里；主角 Cashtag 最多两次。正文要让读者获得一次明确的标的取舍，而不是三币播报。
10. 开场方式：${decision.openingInstruction} 不得复用原文开头。
11. 不要写“反抽/承接/压住手/容错低/我的处理是/计划偏多/计划偏空/条件计划/只做条件”。
12. 不要标题、项目符号、Markdown、免责声明或报告腔；不要直接号召“点击、下单、上车”，靠真实信息差和赔率让人愿意打开交易页。
13. 如果美股/ETF或AI板块参照缺失，正文直接忽略缺失部分。
14. 禁止出现这些表达：${effectiveBannedPhrases(settings).join('、')}。
15. ${selectEmojiStyle(pack).instruction} 全文最多 1 个；不要使用 🚀、🤑、💯。
16. ${selectHumorStyle(pack).instruction} 全文最多一处轻幽默，不能拿止损止盈数字开玩笑。
17. 第一段必须出现主角 ${cashtag(pack.trio?.lead?.symbol || '')}，且该 Cashtag 后保留半角空格。

原文：
${text}

facts：
${(pack.facts || []).join('\n')}

交易解读：
${(pack.takeaways || []).join('\n')}

执行参考：
${executionGuide(decision, pack.tradePlan, pack)}

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
  const editorial = resolveEditorialDecision(pack, settings);
  const basePrompt = renderTemplate(prompt.content, pack, settings);
  const hasEditorialBrief = /\{\{\s*EDITORIAL_BRIEF\s*\}\}/.test(prompt.content || '');
  const runtimeEditorial = hasEditorialBrief
    ? '上方已经包含本轮 senior-trader-v3 编辑决策，不要重复解读或另起一套结构。'
    : editorialBrief(pack, settings);
  const renderedPrompt = `${basePrompt}\n\n【当前运行策略：优先级最高】\n如果上方旧 Prompt 要求每一帖都以“做多/做空/观望”开头，或每帖都写止损和两档止盈，以这里的 senior-trader-v3 决策为准。只有 editorial.requiresTradeCard=true 才允许出现“做多、做空、止损、止盈”。\n${runtimeEditorial}\n\n【运行时事实，不得照抄 JSON】\n近期过度使用、这次必须避开的词：${recentOverusedPhrases().map(x => x.phrase).join('、') || '无'}。\n结构化事件：\n${JSON.stringify(pack.marketEvent || {}, null, 2)}\n编辑决策：\n${JSON.stringify(editorial, null, 2)}`;
  const provider = String(settings.llmProvider || config.llmProvider || 'mock').toLowerCase();
  if (provider === 'mock') {
    const text = mockGenerate(pack);
    const validation = validatePostText(text, pack, settings);
    if (!validation.ok) throw new Error(`${validationError(validation)}:text=${validation.text}`);
    return { text: validation.text, promptId: prompt.id, promptName: prompt.name, provider, model: 'mock', renderedPrompt, editorial, attempts: [{ provider, model: 'mock', ok: true }] };
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
                editorial,
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
          editorial,
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
  return { text: finalText, promptId: prompt.id, promptName: prompt.name, provider, channelId: 'legacy', channelName: 'Legacy settings', model: settings.openaiModel || config.openaiModel, renderedPrompt, editorial, attempts: attemptsLegacy };
}

module.exports = { generatePost, mockGenerate, validatePostText, renderTemplate, cashtag, normalizeCashtags, humanPriceLevel, callOpenAIWithCandidate, effectiveMaxTokens, selectPostAngle, selectStyleCard, selectEmojiStyle, selectHumorStyle, formatTradePlanForPrompt, tradeCardInstruction, executionGuide, effectiveBannedPhrases, recentOverusedPhrases, editorialBrief, evidenceFocus, optionalContext, safeExternalIntel, promptSafeMarketPack, openingFingerprint, maxRecentOpeningSimilarity, resolveEditorialDecision };
