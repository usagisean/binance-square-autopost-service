const { getJson, request } = require('./httpClient');
const { getSettings, saveMarketCache, loadMarketCache, getCounter, getIntelConfig } = require('./store');
const { fetchCoinglassForPack, buildCoinglassPromptLines } = require('./coinglass');
const { attachMarketQuality } = require('./marketQuality');
const { fetchPublicDerivatives, appendPublicDerivativesFacts } = require('./publicDerivatives');
const { fetchTradfiReferences, attachTradfi } = require('./tradfi');
const {
  ASSET_UNIVERSE,
  CONTRACT_META,
  PRIORITY_SYMBOLS,
  EXCLUDED_BASES,
  MEME_SYMBOL_PATTERN,
  cashtagList,
  allTrackedCryptoSymbols,
  unique
} = require('./assetUniverse');

function fmt(n, digits = 2) {
  if (!Number.isFinite(Number(n))) return null;
  const v = Number(n);
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}
function usd(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
function signed(n, digits = 2) {
  n = Number(n);
  if (!Number.isFinite(n)) return null;
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
}
function fundingPct(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return null;
  return `${n > 0 ? '+' : ''}${(n * 100).toFixed(4)}%`;
}
function price(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return null;
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (n >= 1) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`;
}
function normalizeBaseSymbol(symbol) { return String(symbol || '').replace(/USDT$/, '').replace(/^1000/, '').toUpperCase(); }
function bannedBaseSet(settings = {}) {
  return new Set((settings.bannedSymbols || []).map(s => String(s || '').trim().toUpperCase()).filter(Boolean));
}
function isBannedBase(base, settings = {}) {
  return bannedBaseSet(settings).has(String(base || '').toUpperCase());
}
function packHasBannedSymbol(pack, settings = {}) {
  const banned = bannedBaseSet(settings);
  return [pack?.trio?.lead?.symbol, pack?.trio?.peer?.symbol, pack?.trio?.anchor?.symbol]
    .filter(Boolean)
    .some(symbol => banned.has(String(symbol).toUpperCase()));
}
function inferBucket(base) {
  if (CONTRACT_META[base]?.bucket) return CONTRACT_META[base].bucket;
  if (MEME_SYMBOL_PATTERN.test(base)) return 'contract-meme';
  return 'contract-beta';
}
function inferName(base) { return CONTRACT_META[base]?.name || base; }
function priorityBonus(base) {
  const idx = PRIORITY_SYMBOLS.indexOf(base);
  return idx === -1 ? 0 : Math.max(0, 8 - idx * 0.2);
}
function isAudienceRelevant(symbol, settings = {}) {
  const base = String(symbol || '').toUpperCase();
  const configured = new Set((settings.squareTagSymbols || []).map(s => String(s || '').toUpperCase()));
  return Boolean(CONTRACT_META[base]) || configured.has(base);
}
function buildRecentBias(settings) {
  const posts = getCounter(settings).posts || [];
  const symbolCounts = new Map();
  const recentSymbols = [];
  const cooldownSymbols = new Set();
  const cooldownRuns = Math.max(0, Number(settings.leadCooldownRuns || 0));
  const cooldownMs = Math.max(0, Number(settings.leadCooldownMinutes || 0)) * 60 * 1000;
  const now = Date.now();
  for (const post of posts.slice(0, 32)) {
    const symbol = String(post?.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    recentSymbols.push(symbol);
    symbolCounts.set(symbol, (symbolCounts.get(symbol) || 0) + 1);
    const byRun = recentSymbols.length <= cooldownRuns;
    const ts = post?.ts ? Date.parse(post.ts) : 0;
    const byTime = cooldownMs > 0 && Number.isFinite(ts) && ts > 0 && now - ts <= cooldownMs;
    if (byRun || byTime) cooldownSymbols.add(symbol);
  }
  return { recentSymbols, symbolCounts, cooldownSymbols, last1: recentSymbols[0] || null, last2: recentSymbols.slice(0, 2), last5: recentSymbols.slice(0, 5) };
}
function rankScore(asset, anchors, recentBias, settings = {}) {
  const abs1h = Math.abs(Number(asset.change1h || 0));
  const abs24h = Math.abs(Number(asset.change24h || 0));
  const quoteVol = Math.max(1, Number(asset.volume24h || 0));
  const logVolume = Math.log10(quoteVol);
  // A post about a liquid market is generally more useful (and more clickable)
  // than an equally volatile micro market. Movement still matters, but volume
  // gets enough weight to keep the feed from becoming an obscure-token ticker.
  const volumeBoost = clamp((logVolume - 6) * 7, 0, 26);
  const relBtc = Number(asset.change1h || 0) - Number(anchors.BTC?.change1h || 0);
  const relEth = Number(asset.change1h || 0) - Number(anchors.ETH?.change1h || 0);
  const rel = Math.max(Math.abs(relBtc), Math.abs(relEth));
  const amplitude = Number(asset.amplitude24h || 0);
  const dynamic = settings.dynamicUniverse !== false;
  const configuredBucketBonus = asset.bucket === 'contract-meme' ? 4.5 : asset.bucket === 'bnb-beta' ? 3.5 : asset.bucket === 'meme' ? 2.5 : asset.bucket === 'contract-beta' ? 2.0 : asset.bucket === 'high-vol' ? 4.0 : asset.bucket === 'anchor' ? -8 : 0.8;
  // Dynamic discovery must be driven by live attention, not membership in a
  // hand-maintained symbol list. Buckets remain useful only in legacy pool mode.
  const bucketBonus = dynamic ? (asset.bucket === 'anchor' ? -8 : 0) : configuredBucketBonus;
  const activityScore = clamp(abs1h * 2.8, 0, 16) + clamp(abs24h * 0.5, 0, 11) + clamp(amplitude * 0.2, 0, 9) + clamp(rel * 1.8, 0, 10);
  const thinMarketPenalty = quoteVol < 10000000 ? 7 : quoteVol < 20000000 ? 2 : 0;
  const noisyTailPenalty = quoteVol < 25000000 && amplitude > 45 ? 7 : 0;
  const squareTagSet = new Set((settings.squareTagSymbols || []).map(s => String(s).toUpperCase()));
  const squareTagBonus = !dynamic && settings.preferSquareTagSymbols !== false && squareTagSet.has(asset.symbol) ? 6 : 0;
  // Dynamic discovery remains market-wide. This is only a soft editorial
  // preference: unknown symbols can still win when their live signal is strong.
  const audienceRelevant = isAudienceRelevant(asset.symbol, settings);
  const audienceBonus = dynamic && audienceRelevant ? 6 : 0;
  const unknownSymbolPenalty = dynamic && !audienceRelevant ? 4 : 0;
  const deepLiquidityBonus = dynamic ? (quoteVol >= 100000000 ? 2.5 : quoteVol >= 40000000 ? 1 : 0) : 0;
  const cooldownPenalty = recentBias.cooldownSymbols?.has(asset.symbol) ? 1000 : 0;
  const freqPenalty = (recentBias.symbolCounts.get(asset.symbol) || 0) * 5.5;
  const last1Penalty = recentBias.last1 === asset.symbol ? 16 : 0;
  const last2Penalty = recentBias.last2.includes(asset.symbol) ? 7 : 0;
  const last5Penalty = recentBias.last5.includes(asset.symbol) ? 3 : 0;
  return activityScore + volumeBoost + bucketBonus + squareTagBonus + audienceBonus + deepLiquidityBonus
    + (dynamic ? 0 : priorityBonus(asset.symbol)) - unknownSymbolPenalty - thinMarketPenalty
    - noisyTailPenalty - cooldownPenalty - freqPenalty - last1Penalty - last2Penalty - last5Penalty;
}
async function getIntervalChange(baseUrl, symbol, interval = '1h', options = {}) {
  const rows = await getJson(`${baseUrl}/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=2`, options);
  if (!Array.isArray(rows) || rows.length < 2) return 0;
  const prevClose = Number(rows[0][4]);
  const lastClose = Number(rows[1][4]);
  if (!Number.isFinite(prevClose) || !Number.isFinite(lastClose) || prevClose === 0) return 0;
  return ((lastClose - prevClose) / prevClose) * 100;
}
async function get1hChange(baseUrl, symbol, options = {}) {
  return getIntervalChange(baseUrl, symbol, '1h', options);
}
async function get4hChange(baseUrl, symbol, options = {}) {
  return getIntervalChange(baseUrl, symbol, '4h', options);
}
function amplitude24h(row) {
  const high = Number(row.highPrice || 0);
  const low = Number(row.lowPrice || 0);
  const last = Number(row.lastPrice || 0);
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(last) || high <= 0 || low <= 0 || last <= 0) return 0;
  return ((high - low) / last) * 100;
}
function metric(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}
function rowToAsset(row, oneHourMap = {}, fourHourMap = {}, isFutures = false) {
  const base = normalizeBaseSymbol(row.symbol);
  return {
    id: row.symbol, symbol: base, name: inferName(base), bucket: inferBucket(base),
    price: Number(row.lastPrice || 0), change1h: Number(oneHourMap[row.symbol] || 0), change4h: Number(fourHourMap[row.symbol] || 0), change24h: Number(row.priceChangePercent || 0),
    high24h: Number(row.highPrice || 0), low24h: Number(row.lowPrice || 0), amplitude24h: amplitude24h(row),
    volume24h: Number(row.quoteVolume || 0), volumeChange: null, marketCap: null,
    url: isFutures ? `https://www.binance.com/en/futures/${row.symbol}` : `https://www.binance.com/en/trade/${base}_USDT?type=spot`
  };
}
function buildFacts(lead, peer, anchor, isFutures) {
  const tag = isFutures ? '合约' : '';
  return [
    `${lead.symbol} ${tag}现价 ${price(lead.price)}，1h ${fmt(lead.change1h)}，4h ${fmt(lead.change4h)}，24h ${fmt(lead.change24h)}`,
    `${peer.symbol} ${tag}现价 ${price(peer.price)}，1h ${fmt(peer.change1h)}，4h ${fmt(peer.change4h)}，24h ${fmt(peer.change24h)}`,
    `${anchor.symbol} 现价 ${price(anchor.price)}，1h ${fmt(anchor.change1h)}，4h ${fmt(anchor.change4h)}，24h ${fmt(anchor.change24h)}`,
    `${lead.symbol} 24h ${tag}成交额 ${usd(lead.volume24h)}，${peer.symbol} 24h ${tag}成交额 ${usd(peer.volume24h)}`,
    `${lead.symbol} 24h振幅 ${fmt(lead.amplitude24h)}，${peer.symbol} 24h振幅 ${fmt(peer.amplitude24h)}，${anchor.symbol} 24h振幅 ${fmt(anchor.amplitude24h)}`
  ].map(s => s.replace(/\s+/g, ' '));
}
function buildTakeaways(lead, peer, anchor) {
  const relPeer = Number(lead.change1h || 0) - Number(peer.change1h || 0);
  const relAnchor = Number(lead.change1h || 0) - Number(anchor.change1h || 0);
  const lines = [`${lead.symbol} 对 ${peer.symbol} 的1h相对强弱为 ${relPeer >= 0 ? '+' : '-'}${Math.abs(relPeer).toFixed(2)}%，对 ${anchor.symbol} 为 ${relAnchor >= 0 ? '+' : '-'}${Math.abs(relAnchor).toFixed(2)}%。`];
  const lead1h = Number(lead.change1h || 0);
  const lead24h = Number(lead.change24h || 0);
  const anchor1h = Number(anchor.change1h || 0);
  const peer1h = Number(peer.change1h || 0);
  if (lead24h > 18 && lead1h < 0) {
    lines.push(`${lead.symbol} 24h 涨幅仍高，但最近 1h 已回落；正文应判断热度是在换手还是退潮，不写追单建议。`);
  } else if (lead1h > 1.2 && anchor1h <= 0) {
    lines.push(`${anchor.symbol} 同期偏弱，${lead.symbol} 属于局部走强；正文要说清这种独立强势是否有成交或板块支持。`);
  } else if (lead1h > 1.2 && peer1h < 0) {
    lines.push(`${lead.symbol} 短线强于同组标的，${peer.symbol} 偏弱，适合写注意力迁移而不是平均复盘。`);
  } else if (lead.bucket === 'ai') {
    lines.push(`${lead.symbol} 属于 AI 币池，若 AI 板块数据不足，不要强行写美股联动。`);
  } else {
    lines.push(`${lead.symbol} 是本轮正文主角，${peer.symbol} 和 ${anchor.symbol} 只作为强弱参照。`);
  }
  return lines;
}
function chooseTrio(rows, oneHourMap, fourHourMap, recentBias, source, isFutures, settings = {}) {
  const assets = rows.map(row => rowToAsset(row, oneHourMap, fourHourMap, isFutures)).filter(a => a.symbol);
  const anchors = {
    BTC: anchorFromRows(rows, oneHourMap, fourHourMap, 'BTCUSDT', 'BTC', isFutures),
    ETH: anchorFromRows(rows, oneHourMap, fourHourMap, 'ETHUSDT', 'ETH', isFutures)
  };
  if (!anchors.BTC.price || !anchors.ETH.price) throw new Error('missing_anchor_assets');
  const anchor = Math.abs(anchors.BTC.change1h) >= Math.abs(anchors.ETH.change1h) ? anchors.BTC : anchors.ETH;
  const squareTagSet = new Set((settings.squareTagSymbols || []).map(s => String(s).toUpperCase()));
  const scored = assets.filter(a => a.symbol !== anchor.symbol).map(a => ({
    ...a,
    score: rankScore(a, anchors, recentBias, settings),
    squareTagPreferred: squareTagSet.has(a.symbol),
    audienceRelevant: isAudienceRelevant(a.symbol, settings)
  })).sort((a, b) => b.score - a.score);
  const preferTagged = settings.dynamicUniverse === false && settings.preferSquareTagSymbols !== false;
  const taggedLead = scored.slice(0, 15).find(a => a.symbol !== 'BTC' && a.symbol !== 'ETH' && a.squareTagPreferred && !recentBias.cooldownSymbols?.has(a.symbol));
  const lead = (preferTagged ? taggedLead : null) || scored.find(a => a.symbol !== 'BTC' && a.symbol !== 'ETH' && !recentBias.cooldownSymbols?.has(a.symbol)) || scored.find(a => a.symbol !== 'BTC' && a.symbol !== 'ETH' && a.symbol !== recentBias.last1) || scored.find(a => a.symbol !== 'BTC' && a.symbol !== 'ETH' && !recentBias.last2.includes(a.symbol)) || scored[0];
  if (!lead) throw new Error('no_lead_asset');
  const peerBuckets = ['contract-meme', 'bnb-beta', 'meme', 'beta', 'major-beta', 'ai', 'high-vol', 'defi', 'infra', lead.bucket];
  const peerCandidates = scored.filter(a => a.symbol !== lead.symbol && !recentBias.last2.includes(a.symbol));
  const peer = peerCandidates.find(a => a.audienceRelevant && peerBuckets.includes(a.bucket))
    || peerCandidates.find(a => a.audienceRelevant)
    || peerCandidates.find(a => peerBuckets.includes(a.bucket))
    || scored.find(a => a.symbol !== lead.symbol)
    || anchor;
  if (!peer) throw new Error('no_peer_asset');
  return {
    ok: true, source, generatedAt: new Date().toISOString(),
    trio: { lead, peer, anchor },
    allAssets: assets,
    facts: buildFacts(lead, peer, anchor, isFutures),
    takeaways: buildTakeaways(lead, peer, anchor, isFutures),
    candidates: scored.slice(0, 12).map(a => ({ symbol: a.symbol, bucket: a.bucket, audienceRelevant: a.audienceRelevant, score: Number(a.score.toFixed(2)), price: a.price, change1h: a.change1h, change4h: a.change4h, change24h: a.change24h, amplitude24h: a.amplitude24h, volume24h: a.volume24h }))
  };
}
function anchorFromRows(rows, oneHourMap, fourHourMap, id, symbol, isFutures) {
  const row = rows.find(r => r.symbol === id) || {};
  return { symbol, name: inferName(symbol), bucket: 'anchor', price: Number(row.lastPrice || 0), change1h: Number(oneHourMap[id] || 0), change4h: Number(fourHourMap[id] || 0), change24h: Number(row.priceChangePercent || 0), high24h: Number(row.highPrice || 0), low24h: Number(row.lowPrice || 0), amplitude24h: amplitude24h(row), volume24h: Number(row.quoteVolume || 0), volumeChange: null, url: isFutures ? `https://www.binance.com/en/futures/${id}` : `https://www.binance.com/en/trade/${symbol}_USDT?type=spot` };
}
async function hydrateInterval(symbols, baseUrl, interval, options) {
  const entries = await Promise.all([...symbols].map(async symbol => {
    try { return [symbol, await getIntervalChange(baseUrl, symbol, interval, options)]; }
    catch { return [symbol, 0]; }
  }));
  return Object.fromEntries(entries);
}
async function hydrate1h(symbols, baseUrl, options) {
  return hydrateInterval(symbols, baseUrl, '1h', options);
}
async function hydrate4h(symbols, baseUrl, options) {
  return hydrateInterval(symbols, baseUrl, '4h', options);
}

function trendFromAsset(asset = {}) {
  const h1 = Number(asset.change1h || 0);
  const h4 = Number(asset.change4h || 0);
  const d1 = Number(asset.change24h || 0);
  if (h1 > 0.8 && h4 >= 0 && d1 >= 0) return 'strength_continuing';
  if (d1 > 8 && h1 < 0) return 'pullback_after_run';
  if (h1 < -0.8 && h4 <= 0) return 'short_term_weak';
  if (Math.abs(h1) < 0.3 && Math.abs(h4) < 0.8) return 'range_bound';
  return 'mixed';
}
function marketObjectFromAsset(asset, symbol = '') {
  const s = String(asset?.symbol || symbol || '').toUpperCase();
  if (!asset) return unavailableMarketObject(s);
  return {
    symbol: s,
    price: metric(asset.price),
    change_1h: metric(asset.change1h),
    change_4h: metric(asset.change4h),
    change_24h: metric(asset.change24h),
    volume_24h: metric(asset.volume24h),
    volume_change: metric(asset.volumeChange),
    trend: trendFromAsset(asset),
    key_level: null,
    support: null,
    resistance: null,
    data_status: metric(asset.price) == null ? 'unavailable' : 'available'
  };
}
function unavailableMarketObject(symbol) {
  return {
    symbol: String(symbol || '').toUpperCase(),
    price: null,
    change_1h: null,
    change_4h: null,
    change_24h: null,
    volume_24h: null,
    volume_change: null,
    trend: null,
    key_level: null,
    support: null,
    resistance: null,
    data_status: 'unavailable'
  };
}
function assetsBySymbol(assets = []) {
  const map = new Map();
  for (const asset of assets) {
    const symbol = String(asset?.symbol || '').toUpperCase();
    if (symbol && !map.has(symbol)) map.set(symbol, asset);
  }
  return map;
}
function buildCryptoGroup(symbols = [], bySymbol = new Map()) {
  return Object.fromEntries(unique(symbols).map(symbol => [symbol, marketObjectFromAsset(bySymbol.get(symbol), symbol)]));
}
function buildUnavailableGroup(symbols = []) {
  // TODO: wire a stock/ETF data provider here. Keep the shape stable and never infer US equity data from crypto moves.
  return Object.fromEntries(unique(symbols).map(symbol => [symbol, unavailableMarketObject(symbol)]));
}
function sectorHeat(symbols = [], bySymbol = new Map()) {
  const assets = unique(symbols).map(s => bySymbol.get(s)).filter(Boolean);
  if (!assets.length) return null;
  const avg1h = assets.reduce((sum, a) => sum + Number(a.change1h || 0), 0) / assets.length;
  const avg24h = assets.reduce((sum, a) => sum + Number(a.change24h || 0), 0) / assets.length;
  const strongest = [...assets].sort((a, b) => Math.abs(Number(b.change1h || 0)) - Math.abs(Number(a.change1h || 0)))[0];
  return {
    available: true,
    avg_change_1h: Number(avg1h.toFixed(2)),
    avg_change_24h: Number(avg24h.toFixed(2)),
    strongest: strongest?.symbol || null,
    mood: avg1h > 0.5 && avg24h > 0 ? 'warm' : avg1h < -0.5 ? 'cooling' : 'mixed'
  };
}
function formatAssetLine(asset) {
  if (!asset) return null;
  return `${asset.symbol} 1h ${fmt(asset.change1h)}、4h ${fmt(asset.change4h)}、24h ${fmt(asset.change24h)}`;
}
function buildAiSectorFacts(bySymbol = new Map()) {
  const assets = ASSET_UNIVERSE.crypto_ai.map(s => bySymbol.get(s)).filter(a => a && metric(a.price) != null);
  if (assets.length < 2) return '暂无可用AI板块行情数据。';
  const ranked = [...assets].sort((a, b) => Math.abs(Number(b.change1h || 0)) - Math.abs(Number(a.change1h || 0))).slice(0, 4);
  return `AI币池短线参照：${ranked.map(formatAssetLine).filter(Boolean).join('；')}。`;
}
function buildAiTakeaways(bySymbol = new Map(), pack = {}) {
  const assets = ASSET_UNIVERSE.crypto_ai.map(s => bySymbol.get(s)).filter(a => a && metric(a.price) != null);
  if (assets.length < 2) return 'AI板块数据不足，本轮不强行写AI联动。';
  const avg1h = assets.reduce((sum, a) => sum + Number(a.change1h || 0), 0) / assets.length;
  const lead = pack.trio?.lead;
  if (lead?.bucket === 'ai' && avg1h > 0.4) return `AI币池短线偏热，${lead.symbol} 如果是正文主角，可以写成板块内强弱选择，但不要借美股数据脑补原因。`;
  if (avg1h > 0.4) return 'AI币池有短线热度，但本轮主角不一定在AI板块，正文不要强行转成AI主题。';
  if (avg1h < -0.4) return 'AI币池短线承接偏弱，若美股AI数据缺失，本轮不写外部联动。';
  return 'AI币池内部强弱不够一致，本轮只把AI币当作相对强弱参照。';
}
function attachStructuredMarketPack(pack) {
  const bySymbol = assetsBySymbol([...(pack.allAssets || []), pack.trio?.lead, pack.trio?.peer, pack.trio?.anchor].filter(Boolean));
  pack.timestamp = pack.generatedAt || new Date().toISOString();
  pack.timeframe = { short: '1h', medium: '4h', daily: '24h' };
  pack.lead = marketObjectFromAsset(pack.trio?.lead, pack.trio?.lead?.symbol);
  pack.peer = marketObjectFromAsset(pack.trio?.peer, pack.trio?.peer?.symbol);
  pack.anchor = marketObjectFromAsset(pack.trio?.anchor, pack.trio?.anchor?.symbol);
  pack.crypto_core = buildCryptoGroup(ASSET_UNIVERSE.crypto_core, bySymbol);
  pack.crypto_ai = buildCryptoGroup(ASSET_UNIVERSE.crypto_ai, bySymbol);
  pack.stocks = {
    ai: buildUnavailableGroup(ASSET_UNIVERSE.stock_ai),
    crypto_beta: buildUnavailableGroup(ASSET_UNIVERSE.stock_crypto_beta),
    etf_macro: buildUnavailableGroup(ASSET_UNIVERSE.etf_macro)
  };
  pack.sector = {
    crypto_beta: sectorHeat(['SOL', 'BNB', 'XRP', 'SUI', 'ENA', 'AVAX', 'ADA', 'ARB'], bySymbol),
    ai_stock_heat: null,
    crypto_ai_follow: sectorHeat(ASSET_UNIVERSE.crypto_ai, bySymbol),
    meme_heat: sectorHeat(['DOGE', 'PEPE', 'WIF', 'BONK', 'PENGU', 'BABY', 'BOME', 'FLOKI', 'POPCAT', 'FARTCOIN', 'TST', 'TRUMP'], bySymbol),
    high_volatility_heat: sectorHeat(ASSET_UNIVERSE.crypto_high_volatility, bySymbol),
    layer1_heat: sectorHeat(['SOL', 'BNB', 'SUI', 'AVAX', 'ADA', 'NEAR', 'ICP'], bySymbol)
  };
  pack.trade_plan = pack.tradePlan || {};
  pack.external_intel = pack.externalIntel || {};
  pack.stockCashtags = cashtagList([...ASSET_UNIVERSE.stock_ai.slice(0, 6), ...ASSET_UNIVERSE.stock_crypto_beta]);
  pack.macroCashtags = cashtagList(ASSET_UNIVERSE.etf_macro);
  pack.aiSectorCashtags = cashtagList(ASSET_UNIVERSE.crypto_ai);
  pack.stockFacts = '暂无可用美股/ETF行情数据。';
  pack.stockTakeaways = '美股参照数据缺失，本轮不使用美股作为判断依据。';
  pack.aiSectorFacts = buildAiSectorFacts(bySymbol);
  pack.aiTakeaways = buildAiTakeaways(bySymbol, pack);
  return pack;
}
function uniqueRows(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const symbol = String(row?.symbol || '');
    if (symbol && !map.has(symbol)) map.set(symbol, row);
  }
  return [...map.values()];
}
function trackedRows(rows = []) {
  const wanted = new Set(allTrackedCryptoSymbols().map(s => `${s}USDT`));
  return rows.filter(row => wanted.has(String(row?.symbol || '')));
}

async function safeJson(url, options = {}) {
  try { return await getJson(url, { timeoutMs: 6000, ...options }); }
  catch { return null; }
}
async function safeText(url, options = {}) {
  try {
    const res = await request('GET', url, {
      headers: { 'User-Agent': 'binance-square-autopost-service/0.1', Accept: 'application/rss+xml, application/atom+xml, text/xml, */*' },
      timeoutMs: options.timeoutMs || 7000,
      proxy: options.proxy
    });
    if (res.statusCode < 200 || res.statusCode >= 300) return '';
    return String(res.body || '');
  } catch {
    return '';
  }
}
function decodeXml(text = '') {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
function xmlTag(block, tag) {
  const m = String(block || '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? decodeXml(m[1]) : '';
}
function parseRssItems(xml = '', sourceName = '') {
  const blocks = String(xml || '').match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi) || [];
  return blocks.slice(0, 8).map(block => {
    const title = xmlTag(block, 'title');
    const link = xmlTag(block, 'link') || (String(block).match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || '');
    const publishedAt = xmlTag(block, 'pubDate') || xmlTag(block, 'published') || xmlTag(block, 'updated');
    return { source: sourceName, title, link: decodeXml(link), publishedAt: decodeXml(publishedAt) };
  }).filter(x => x.title);
}
async function fetchRssItems(sources = [], limit = 8) {
  const enabled = sources.filter(x => x.enabled !== false && /^https?:\/\//i.test(x.value || '')).slice(0, Math.max(0, limit || 8));
  const rows = await Promise.all(enabled.map(async src => parseRssItems(await safeText(src.value, { timeoutMs: 7000 }), src.name || src.value)));
  return rows.flat().slice(0, Math.max(0, limit || 8));
}
function pairId(symbol) { return `${String(symbol || '').toUpperCase()}USDT`; }
function depthStats(depth) {
  const bids = Array.isArray(depth?.bids) ? depth.bids : [];
  const asks = Array.isArray(depth?.asks) ? depth.asks : [];
  const bidNotional = bids.slice(0, 20).reduce((sum, [p, q]) => sum + Number(p) * Number(q), 0);
  const askNotional = asks.slice(0, 20).reduce((sum, [p, q]) => sum + Number(p) * Number(q), 0);
  const total = bidNotional + askNotional;
  const imbalance = total > 0 ? ((bidNotional - askNotional) / total) * 100 : 0;
  return { available: total > 0, bidNotional, askNotional, imbalance };
}
function compactDepthLevels(depth, limit = 12) {
  const mapSide = rows => (Array.isArray(rows) ? rows : []).slice(0, limit).map(([p, q]) => {
    const price = Number(p);
    const qty = Number(q);
    return { price, qty, notional: Number.isFinite(price) && Number.isFinite(qty) ? price * qty : 0 };
  }).filter(x => Number.isFinite(x.price) && Number.isFinite(x.qty) && x.price > 0 && x.qty > 0);
  return { bids: mapSide(depth?.bids), asks: mapSide(depth?.asks) };
}
function compactOiHistory(rows = []) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    timestamp: Number(row.timestamp || row.time || 0),
    sumOpenInterest: Number(row.sumOpenInterest || 0) || null,
    sumOpenInterestValue: Number(row.sumOpenInterestValue || 0) || null
  })).filter(x => x.sumOpenInterestValue || x.sumOpenInterest).slice(-32);
}
function spreadBps(book) {
  const bid = Number(book?.bidPrice || 0);
  const ask = Number(book?.askPrice || 0);
  const mid = (bid + ask) / 2;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || mid <= 0) return 0;
  return ((ask - bid) / mid) * 10000;
}
function lastRow(rows) { return Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null; }
function prevRow(rows) { return Array.isArray(rows) && rows.length > 1 ? rows[rows.length - 2] : null; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n) || 0)); }
function normalizeKlines(rows = []) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6])
  })).filter(k => Number.isFinite(k.high) && Number.isFinite(k.low) && Number.isFinite(k.close) && k.close > 0);
}
function levelDecimals(ref) {
  ref = Math.abs(Number(ref) || 0);
  if (ref >= 1000) return 1;
  if (ref >= 100) return 2;
  if (ref >= 1) return 3;
  if (ref >= 0.1) return 4;
  if (ref >= 0.01) return 5;
  return 8;
}
function roundLevel(value, ref = value) {
  const d = levelDecimals(ref);
  return Number(Number(value).toFixed(d));
}
function averageRangePct(klines = []) {
  const rows = klines.filter(k => k.close > 0).slice(-32);
  if (!rows.length) return 0;
  return rows.reduce((sum, k) => sum + ((k.high - k.low) / k.close) * 100, 0) / rows.length;
}
async function fetch15mKlines(asset, isFutures) {
  const id = pairId(asset.symbol);
  const base = isFutures ? 'https://fapi.binance.com/fapi/v1' : 'https://www.binance.com/api/v3';
  const options = isFutures ? { timeoutMs: 12000 } : { proxy: false, timeoutMs: 12000 };
  return normalizeKlines(await safeJson(`${base}/klines?symbol=${encodeURIComponent(id)}&interval=15m&limit=96`, options));
}
function buildTradePlan(pack, intel, klines, isFutures, settings = {}) {
  if (settings.includeTradePlan === false || String(settings.tradePlanMode || '').toLowerCase() === 'off') return null;
  const { lead, peer, anchor } = pack.trio;
  const leadIntel = intel?.symbols?.[lead.symbol] || {};
  const current = Number(leadIntel.markPrice || lead.price || 0);
  if (!Number.isFinite(current) || current <= 0) return null;
  const recent = (klines || []).slice(-32);
  const highs = recent.map(k => k.high).filter(Number.isFinite);
  const lows = recent.map(k => k.low).filter(Number.isFinite);
  const recentHigh = highs.length ? Math.max(...highs) : Number(lead.high24h || current);
  const recentLow = lows.length ? Math.min(...lows) : Number(lead.low24h || current);
  const avgRange = averageRangePct(recent) || Math.max(0.4, Math.min(6, Number(lead.amplitude24h || 0) / 8));
  const depthImbalance = Number(leadIntel.depth?.imbalance || 0);
  const taker = Number(leadIntel.takerBuySellRatio || 0);
  const oiChange = Number(leadIntel.openInterestValueChange5m || 0);
  const funding = Number(leadIntel.fundingRate || 0);
  let score = 0;
  score += clamp(Number(lead.change1h || 0) / 2, -2, 2);
  score += clamp(Number(lead.change24h || 0) / 14, -1.5, 1.5);
  score += clamp((Number(lead.change1h || 0) - Number(anchor.change1h || 0)) / 2, -1.2, 1.2);
  score += clamp(depthImbalance / 35, -1, 1);
  if (Number.isFinite(taker) && taker > 0) score += clamp((taker - 1) * 1.3, -1, 1);
  if (Number.isFinite(oiChange)) score += clamp(oiChange / 1.5, -1, 1);
  if (funding > 0.0005) score -= 0.35;
  if (funding < -0.0002) score += 0.2;

  const direction = score >= 0.65 ? 'long' : score <= -0.65 ? 'short' : 'watch';
  const bias = direction === 'long' ? '看涨' : direction === 'short' ? '看跌' : '观望';
  const bufferPct = Math.max(0.12, Math.min(1.2, avgRange * 0.18));
  const pullbackPct = Math.max(0.18, Math.min(2.8, avgRange * 0.42));
  const stopPct = Math.max(0.45, Math.min(4.8, avgRange * 0.9));
  let entry, trigger, stopLoss, invalidation, summary;
  if (direction === 'long') {
    trigger = roundLevel(Math.max(recentHigh, current) * (1 + bufferPct / 100), current);
    const low = roundLevel(Math.max(recentLow, current * (1 - pullbackPct / 100)), current);
    const high = roundLevel(current * (1 - Math.max(0.1, bufferPct) / 100), current);
    entry = high > low ? `${price(low)}-${price(high)}` : `突破 ${price(trigger)}`;
    stopLoss = roundLevel(Math.min(recentLow * (1 - bufferPct / 100), current * (1 - stopPct / 100)), current);
    invalidation = price(stopLoss);
    summary = `${lead.symbol} 条件计划：偏多；突破 ${price(trigger)} 或回踩 ${entry} 有承接才考虑，失效/止损看 ${price(stopLoss)}。`;
  } else if (direction === 'short') {
    trigger = roundLevel(Math.min(recentLow, current) * (1 - bufferPct / 100), current);
    const low = roundLevel(current * (1 + Math.max(0.1, bufferPct) / 100), current);
    const high = roundLevel(Math.min(recentHigh, current * (1 + pullbackPct / 100)), current);
    entry = high > low ? `${price(low)}-${price(high)}` : `跌破 ${price(trigger)}`;
    stopLoss = roundLevel(Math.max(recentHigh * (1 + bufferPct / 100), current * (1 + stopPct / 100)), current);
    invalidation = price(stopLoss);
    summary = `${lead.symbol} 条件计划：偏空；跌破 ${price(trigger)} 或反抽 ${entry} 转弱才考虑，失效/止损看 ${price(stopLoss)}。`;
  } else {
    const upper = roundLevel(Math.max(recentHigh, current) * (1 + bufferPct / 100), current);
    const lower = roundLevel(Math.min(recentLow, current) * (1 - bufferPct / 100), current);
    trigger = `${price(upper)} / ${price(lower)}`;
    entry = '等突破或跌破后再跟';
    stopLoss = null;
    invalidation = `${price(upper)}-${price(lower)} 区间`;
    summary = `${lead.symbol} 条件计划：先观望；上破 ${price(upper)} 才看多延续，跌破 ${price(lower)} 先防回落。`;
  }
  return {
    symbol: lead.symbol,
    pair: `${lead.symbol}USDT`,
    market: isFutures ? 'futures' : 'spot-public',
    bias,
    direction,
    currentPrice: roundLevel(current, current),
    trigger,
    entry,
    stopLoss: stopLoss == null ? null : roundLevel(stopLoss, current),
    invalidation,
    basis: {
      score: Number(score.toFixed(2)),
      avgRangePct: Number(avgRange.toFixed(2)),
      recentHigh: roundLevel(recentHigh, current),
      recentLow: roundLevel(recentLow, current),
      depthImbalance: Number(depthImbalance.toFixed(2)),
      fundingRate: Number.isFinite(funding) ? funding : null,
      openInterestValueChange5m: Number.isFinite(oiChange) ? Number(oiChange.toFixed(2)) : null,
      peer: peer.symbol,
      anchor: anchor.symbol
    },
    summary
  };
}
async function enrichOneFutures(asset) {
  const id = pairId(asset.symbol);
  const [premium, oi, oiHist, globalLs, topLs, takerLs, depth, book] = await Promise.all([
    safeJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(id)}`),
    safeJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(id)}`),
    safeJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${encodeURIComponent(id)}&period=5m&limit=24`),
    safeJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${encodeURIComponent(id)}&period=5m&limit=1`),
    safeJson(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${encodeURIComponent(id)}&period=5m&limit=1`),
    safeJson(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${encodeURIComponent(id)}&period=5m&limit=1`),
    safeJson(`https://fapi.binance.com/fapi/v1/depth?symbol=${encodeURIComponent(id)}&limit=20`),
    safeJson(`https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(id)}`)
  ]);
  const latestOi = lastRow(oiHist);
  const previousOi = prevRow(oiHist);
  const latestOiValue = Number(latestOi?.sumOpenInterestValue || 0);
  const previousOiValue = Number(previousOi?.sumOpenInterestValue || 0);
  const oiValueChange5m = previousOiValue > 0 ? ((latestOiValue - previousOiValue) / previousOiValue) * 100 : null;
  return {
    symbol: asset.symbol,
    futuresSymbol: id,
    fundingRate: Number(premium?.lastFundingRate),
    markPrice: Number(premium?.markPrice),
    indexPrice: Number(premium?.indexPrice),
    openInterest: Number(oi?.openInterest),
    openInterestValue: latestOiValue || null,
    openInterestValueChange5m: oiValueChange5m,
    globalLongShortRatio: Number(lastRow(globalLs)?.longShortRatio),
    topLongShortPositionRatio: Number(lastRow(topLs)?.longShortRatio),
    takerBuySellRatio: Number(lastRow(takerLs)?.buySellRatio),
    openInterestHistory: compactOiHistory(oiHist),
    depth: depthStats(depth),
    depthLevels: compactDepthLevels(depth),
    spreadBps: spreadBps(book)
  };
}
async function enrichOneSpot(asset) {
  const id = pairId(asset.symbol);
  const [depth, book] = await Promise.all([
    safeJson(`https://www.binance.com/api/v3/depth?symbol=${encodeURIComponent(id)}&limit=20`, { proxy: false }),
    safeJson(`https://www.binance.com/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(id)}`, { proxy: false })
  ]);
  return {
    symbol: asset.symbol,
    spotSymbol: id,
    depth: depthStats(depth),
    depthLevels: compactDepthLevels(depth),
    spreadBps: spreadBps(book)
  };
}
function microstructureTakeaway(lead, intel, isFutures) {
  const leadIntel = intel?.symbols?.[lead.symbol];
  if (!leadIntel) return null;
  const parts = [];
  if (isFutures) {
    if (Number.isFinite(leadIntel.fundingRate)) {
      const f = leadIntel.fundingRate;
      if (f > 0.0003) parts.push(`${lead.symbol} 资金费率偏正，追多拥挤度要盯紧`);
      else if (f < -0.0001) parts.push(`${lead.symbol} 资金费率偏负，空头拥挤时容易反抽`);
      else parts.push(`${lead.symbol} 资金费率不算极端，情绪还没到单边拥挤`);
    }
    if (Number.isFinite(leadIntel.openInterestValueChange5m)) {
      const oi = leadIntel.openInterestValueChange5m;
      if (Math.abs(oi) >= 0.5) parts.push(`5m 持仓价值${oi > 0 ? '抬升' : '回落'} ${Math.abs(oi).toFixed(2)}%，杠杆资金在${oi > 0 ? '加速进场' : '降温'}`);
    }
    if (Number.isFinite(leadIntel.takerBuySellRatio) && leadIntel.takerBuySellRatio > 0) {
      parts.push(`主动买卖比 ${leadIntel.takerBuySellRatio.toFixed(2)}`);
    }
  }
  if (leadIntel.depth?.available && Number.isFinite(leadIntel.depth.imbalance) && Math.abs(leadIntel.depth.imbalance) >= 12) {
    parts.push(`盘口前20档${leadIntel.depth.imbalance > 0 ? '买盘更厚' : '卖压更厚'}，不适合只看涨跌幅`);
  }
  if (!parts.length) return null;
  return parts.join('；') + '。';
}
function appendIntelFacts(pack, intel, isFutures) {
  const { lead, peer, anchor } = pack.trio;
  const symbols = [lead, peer, anchor].map(a => a.symbol);
  const futuresLines = [];
  const depthLines = [];
  for (const symbol of symbols) {
    const it = intel.symbols[symbol];
    if (!it) continue;
    if (isFutures && Number.isFinite(it.fundingRate)) {
      const oiText = it.openInterestValue ? `，5m持仓价值 ${usd(it.openInterestValue)}` : '';
      const oiChange = Number.isFinite(it.openInterestValueChange5m) ? `，5m OI ${signed(it.openInterestValueChange5m)}%` : '';
      futuresLines.push(`${symbol} 合约资金费率 ${fundingPct(it.fundingRate)}${oiText}${oiChange}`);
    }
    if (it.depth?.available && Number.isFinite(it.depth.imbalance)) {
      depthLines.push(`${symbol} 前20档盘口 ${it.depth.imbalance >= 0 ? '买盘厚' : '卖压厚'} ${Math.abs(it.depth.imbalance).toFixed(1)}%，点差 ${Number(it.spreadBps || 0).toFixed(1)}bp`);
    }
  }
  if (futuresLines.length) pack.facts.push(futuresLines.join('；'));
  if (depthLines.length) pack.facts.push(depthLines.join('；'));
  const micro = microstructureTakeaway(lead, intel, isFutures);
  if (micro) pack.takeaways.push(micro);
}
async function appendConfiguredIntel(pack) {
  const cfg = getIntelConfig({ revealKeys: false });
  if (!cfg.enabled) return;
  const news = (cfg.newsRssUrls || []).filter(x => x.enabled !== false).slice(0, cfg.maxNewsItems || 8);
  const kol = (cfg.kolSources || []).filter(x => x.enabled !== false).slice(0, cfg.maxKolItems || 8);
  const newsItems = await fetchRssItems(news, cfg.maxNewsItems || 8);
  pack.externalIntel = {
    enabled: true,
    newsRssUrls: news.map(x => ({ name: x.name, value: x.value, priority: x.priority })),
    newsItems,
    kolSources: kol.map(x => ({ name: x.name, value: x.value, priority: x.priority })),
    hasCoinglassApiKey: !!cfg.hasCoinglassApiKey,
    onchainApiKeys: cfg.onchainApiKeys || {},
    macroNotes: cfg.macroNotes || '',
    updatedAt: cfg.updatedAt
  };
  if (cfg.macroNotes) {
    pack.facts.push(`人工情报备注：${String(cfg.macroNotes).slice(0, 600)}`);
  }
  if (newsItems.length) {
    pack.facts.push(`新闻 RSS 摘要：${newsItems.slice(0, 4).map(x => `${x.source}: ${x.title}`).join('；')}`);
  }
}

async function appendCoinglassIntel(pack) {
  let evidence;
  try {
    evidence = await fetchCoinglassForPack(pack);
  } catch (err) {
    evidence = { ok: false, status: 'error', reason: err.message || String(err) };
  }
  pack.coinglass = evidence;
  pack.externalIntel = {
    ...(pack.externalIntel || {}),
    coinglass: {
      ok: !!evidence?.ok,
      status: evidence?.status || 'unknown',
      source: evidence?.source || 'coinglass-v4',
      exchange: evidence?.exchange,
      pair: evidence?.pair,
      hasHeatmap: !!evidence?.heatmap?.available,
      hasLiquidation: !!evidence?.liquidation?.available,
      hasOrderbook: !!evidence?.orderbookAskBids?.available,
      hasOpenInterest: !!evidence?.openInterest?.available,
      hasLongShort: !!evidence?.longShort?.available,
      reason: evidence?.reason || ''
    }
  };
  if (!evidence?.ok) return;
  const lines = buildCoinglassPromptLines(evidence);
  if (lines.facts.length) pack.facts.push(...lines.facts);
  if (lines.takeaways.length) pack.takeaways.push(...lines.takeaways);
}

async function enrichMarketIntel(pack, isFutures) {
  const assets = [pack.trio.lead, pack.trio.peer, pack.trio.anchor];
  const [results, leadKlines] = await Promise.all([
    Promise.all(assets.map(async asset => {
    const data = isFutures ? await enrichOneFutures(asset) : await enrichOneSpot(asset);
    return [asset.symbol, data];
    })),
    fetch15mKlines(pack.trio.lead, isFutures)
  ]);
  const intel = { source: isFutures ? 'binance-futures-public' : 'binance-spot-public', generatedAt: new Date().toISOString(), symbols: Object.fromEntries(results) };
  pack.marketIntel = intel;
  pack.chart = {
    symbol: pairId(pack.trio.lead.symbol),
    interval: '15m',
    source: isFutures ? 'binance-futures-public' : 'binance-spot-public',
    klines: leadKlines.slice(-64)
  };
  appendIntelFacts(pack, intel, isFutures);
  const tradePlan = buildTradePlan(pack, intel, leadKlines, isFutures, getSettings());
  if (tradePlan) {
    pack.tradePlan = tradePlan;
    // Keep trade levels in a dedicated field instead of mixing the templated
    // summary into facts/takeaways. When the summary lived in facts, the LLM
    // kept copying "条件计划/计划偏多/失效" phrasing into every post.
  }
  await appendConfiguredIntel(pack);
  await appendCoinglassIntel(pack);
  if (!pack.coinglass?.ok) {
    pack.publicDerivatives = await fetchPublicDerivatives(pack);
    appendPublicDerivativesFacts(pack);
  }
  return pack;
}

async function buildFuturesPack(settings) {
  const recentBias = buildRecentBias(settings);
  const [exchangeInfo, tickers] = await Promise.all([
    getJson('https://fapi.binance.com/fapi/v1/exchangeInfo'),
    getJson('https://fapi.binance.com/fapi/v1/ticker/24hr')
  ]);
  const tradable = new Set((exchangeInfo?.symbols || []).filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT').map(s => s.symbol));
  const rows = (Array.isArray(tickers) ? tickers : []).filter(row => {
    const symbol = String(row?.symbol || '');
    if (!symbol.endsWith('USDT') || !tradable.has(symbol)) return false;
    const base = normalizeBaseSymbol(symbol);
    if (!base || EXCLUDED_BASES.has(base) || isBannedBase(base, settings)) return false;
    const quoteVol = Number(row.quoteVolume || 0);
    return Number.isFinite(quoteVol) && quoteVol >= 50000;
  });
  const topMovers = (settings.dynamicUniverse === false ? pickTopMovers(rows) : discoverDynamicRows(rows, 5000000)).slice(0, settings.dynamicUniverse === false ? 30 : 80);
  const candidateRows = uniqueRows([...topMovers, ...(settings.dynamicUniverse === false ? trackedRows(rows) : []), ...rows.filter(r => r.symbol === 'BTCUSDT' || r.symbol === 'ETHUSDT')]);
  const symbols = new Set(candidateRows.map(r => r.symbol));
  const [oneHourMap, fourHourMap] = await Promise.all([
    hydrate1h(symbols, 'https://fapi.binance.com/fapi/v1'),
    hydrate4h(symbols, 'https://fapi.binance.com/fapi/v1')
  ]);
  const pack = chooseTrio(candidateRows, oneHourMap, fourHourMap, recentBias, 'binance-futures-priority', true, settings);
  return finalizePack(await enrichMarketIntel(pack, true));
}
function pickTopMovers(rows) {
  return rows.filter(row => {
    const base = normalizeBaseSymbol(row.symbol);
    const abs24h = Math.abs(Number(row.priceChangePercent || 0));
    const quoteVol = Number(row.quoteVolume || 0);
    return abs24h >= 4 || quoteVol >= 15000000 || PRIORITY_SYMBOLS.includes(base);
  }).sort((a, b) => Math.abs(Number(b.priceChangePercent || 0)) - Math.abs(Number(a.priceChangePercent || 0)));
}
function discoverDynamicRows(rows = [], minQuoteVolume = 5000000) {
  return rows.filter(row => Number(row.quoteVolume || 0) >= minQuoteVolume).map(row => {
    const quoteVolume = Math.max(1, Number(row.quoteVolume || 0));
    const score = clamp((Math.log10(quoteVolume) - 6) * 7, 0, 26)
      + clamp(Math.abs(Number(row.priceChangePercent || 0)) * 0.6, 0, 12)
      + clamp(amplitude24h(row) * 0.25, 0, 10);
    return { row, score };
  }).sort((a, b) => b.score - a.score).map(x => x.row);
}
async function buildSpotPack(settings, futuresErr) {
  const recentBias = buildRecentBias(settings);
  const tickers = await getJson('https://www.binance.com/api/v3/ticker/24hr', { proxy: false, timeoutMs: 25000 });
  const minVol = Number(settings.minSpotQuoteVolume || 5000000);
  const rows = (Array.isArray(tickers) ? tickers : []).filter(row => {
    const symbol = String(row?.symbol || '');
    if (!symbol.endsWith('USDT')) return false;
    const base = normalizeBaseSymbol(symbol);
    if (!base || EXCLUDED_BASES.has(base) || isBannedBase(base, settings) || /(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
    const quoteVol = Number(row.quoteVolume || 0);
    return Number.isFinite(quoteVol) && quoteVol >= minVol;
  });
  if (!rows.length) throw new Error('empty_spot_rows');
  const topMovers = (settings.dynamicUniverse === false ? pickTopMovers(rows) : discoverDynamicRows(rows, 5000000)).slice(0, settings.dynamicUniverse === false ? 30 : 80);
  const candidateRows = uniqueRows([...topMovers, ...(settings.dynamicUniverse === false ? trackedRows(rows) : []), ...rows.filter(r => r.symbol === 'BTCUSDT' || r.symbol === 'ETHUSDT')]);
  const symbols = new Set(candidateRows.map(r => r.symbol));
  const [oneHourMap, fourHourMap] = await Promise.all([
    hydrate1h(symbols, 'https://www.binance.com/api/v3', { proxy: false, timeoutMs: 15000 }),
    hydrate4h(symbols, 'https://www.binance.com/api/v3', { proxy: false, timeoutMs: 15000 })
  ]);
  const pack = await finalizePack(await enrichMarketIntel(chooseTrio(candidateRows, oneHourMap, fourHourMap, recentBias, 'binance-spot-www-fallback', false, settings), false));
  pack.futuresFallbackReason = futuresErr?.message || String(futuresErr || '');
  return pack;
}
async function buildMarketPack() {
  const settings = getSettings();
  try {
    const pack = await buildFuturesPack(settings);
    saveMarketCache(pack);
    return pack;
  } catch (futuresErr) {
    try {
      const pack = await buildSpotPack(settings, futuresErr);
      saveMarketCache(pack);
      return pack;
    } catch (spotErr) {
      const cache = loadMarketCache(settings.marketCacheMaxAgeMinutes);
      if (cache && !packHasBannedSymbol(cache.pack, settings)) return finalizePack({ ...cache.pack, generatedAt: new Date().toISOString(), cacheFallback: true, cacheSavedAt: new Date(cache.savedAt).toISOString(), fallbackReason: spotErr.message || String(spotErr) });
      throw new Error(`market_pack_failed:futures=${futuresErr.message || futuresErr};spot=${spotErr.message || spotErr}`);
    }
  }
}
async function finalizePack(pack) {
  const structured = attachStructuredMarketPack(pack);
  attachTradfi(structured, await fetchTradfiReferences());
  return attachMarketQuality(structured);
}
module.exports = { buildMarketPack, fmt, usd, price, rankScore, discoverDynamicRows };
