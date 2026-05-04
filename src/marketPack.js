const { getJson } = require('./httpClient');
const { getSettings, saveMarketCache, loadMarketCache, getCounter } = require('./store');

const CONTRACT_META = {
  BTC: { name: 'Bitcoin', bucket: 'anchor' }, ETH: { name: 'Ethereum', bucket: 'anchor' },
  SOL: { name: 'Solana', bucket: 'major-beta' }, BNB: { name: 'BNB', bucket: 'major-beta' }, XRP: { name: 'XRP', bucket: 'major-beta' },
  DOGE: { name: 'Dogecoin', bucket: 'meme' }, PEPE: { name: 'PEPE', bucket: 'meme' }, WIF: { name: 'dogwifhat', bucket: 'meme' },
  BONK: { name: 'Bonk', bucket: 'meme' }, BOME: { name: 'BOOK OF MEME', bucket: 'meme' }, FLOKI: { name: 'FLOKI', bucket: 'meme' },
  POPCAT: { name: 'Popcat', bucket: 'meme' }, PENGU: { name: 'Pudgy Penguins', bucket: 'meme' }, FARTCOIN: { name: 'Fartcoin', bucket: 'meme' },
  AAVE: { name: 'AAVE', bucket: 'defi' }, LINK: { name: 'Chainlink', bucket: 'infra' }, ARB: { name: 'Arbitrum', bucket: 'beta' },
  ENA: { name: 'Ethena', bucket: 'beta' }, FET: { name: 'Artificial Superintelligence Alliance', bucket: 'ai' }, SUI: { name: 'Sui', bucket: 'beta' },
  AVAX: { name: 'Avalanche', bucket: 'beta' }, ADA: { name: 'Cardano', bucket: 'beta' }, ZEC: { name: 'Zcash', bucket: 'beta' }, POL: { name: 'POL', bucket: 'beta' },
  ALPACA: { name: 'Alpaca Finance', bucket: 'bnb-beta' }, ALPHA: { name: 'Alpha Finance', bucket: 'bnb-beta' }, BAKE: { name: 'BakerySwap', bucket: 'bnb-beta' },
  BSW: { name: 'Biswap', bucket: 'bnb-beta' }, MBOX: { name: 'Mobox', bucket: 'bnb-beta' }, LOKA: { name: 'League of Kingdoms', bucket: 'beta' },
  RAVE: { name: 'RAVE', bucket: 'contract-meme' }, CHIP: { name: 'CHIP', bucket: 'contract-meme' }, BSB: { name: 'BSB', bucket: 'contract-meme' }
};

const PRIORITY_SYMBOLS = [
  'CHIP', 'RAVE', 'BSB', 'ALPACA', 'ALPHA', 'BAKE', 'BSW', 'MBOX', 'LOKA',
  'DOGE', 'PEPE', 'WIF', 'BONK', 'BOME', 'FLOKI', 'POPCAT', 'PENGU', 'FARTCOIN',
  'ENA', 'FET', 'SUI', 'ARB', 'AAVE', 'LINK', 'AVAX', 'SOL', 'BNB', 'XRP', 'ZEC'
];
const EXCLUDED_BASES = new Set(['USDC', 'FDUSD', 'TUSD', 'BUSD', 'USDP', 'EUR', 'GBP', 'TRY', 'UAH', 'RUB', 'AUD', 'BRL']);

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
function inferBucket(base) {
  if (CONTRACT_META[base]?.bucket) return CONTRACT_META[base].bucket;
  if (/DOGE|PEPE|WIF|BONK|BOME|FLOKI|POPCAT|PENGU|FART|SHIB|MEME|CHILL|MOODENG|MOG|NEIRO|ACT|TST|TURBO|BRETT|MEW|RAVE|CHIP|BSB/i.test(base)) return 'contract-meme';
  return 'contract-beta';
}
function inferName(base) { return CONTRACT_META[base]?.name || base; }
function priorityBonus(base) {
  const idx = PRIORITY_SYMBOLS.indexOf(base);
  return idx === -1 ? 0 : Math.max(0, 8 - idx * 0.2);
}
function buildRecentBias(settings) {
  const posts = getCounter(settings).posts || [];
  const symbolCounts = new Map();
  const recentSymbols = [];
  for (const post of posts.slice(0, 16)) {
    const symbol = String(post?.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    recentSymbols.push(symbol);
    symbolCounts.set(symbol, (symbolCounts.get(symbol) || 0) + 1);
  }
  return { recentSymbols, symbolCounts, last1: recentSymbols[0] || null, last2: recentSymbols.slice(0, 2), last5: recentSymbols.slice(0, 5) };
}
function rankScore(asset, anchors, recentBias) {
  const abs1h = Math.abs(Number(asset.change1h || 0));
  const abs24h = Math.abs(Number(asset.change24h || 0));
  const quoteVol = Math.max(1, Number(asset.volume24h || 0));
  const volumeBoost = Math.log10(quoteVol);
  const relBtc = Number(asset.change1h || 0) - Number(anchors.BTC?.change1h || 0);
  const relEth = Number(asset.change1h || 0) - Number(anchors.ETH?.change1h || 0);
  const rel = Math.max(Math.abs(relBtc), Math.abs(relEth));
  const amplitude = Number(asset.amplitude24h || 0);
  const bucketBonus = asset.bucket === 'contract-meme' ? 4.5 : asset.bucket === 'bnb-beta' ? 3.5 : asset.bucket === 'meme' ? 2.5 : asset.bucket === 'contract-beta' ? 2.0 : asset.bucket === 'anchor' ? -8 : 0.8;
  const freqPenalty = (recentBias.symbolCounts.get(asset.symbol) || 0) * 5.5;
  const last1Penalty = recentBias.last1 === asset.symbol ? 16 : 0;
  const last2Penalty = recentBias.last2.includes(asset.symbol) ? 7 : 0;
  const last5Penalty = recentBias.last5.includes(asset.symbol) ? 3 : 0;
  return abs1h * 3.3 + abs24h * 0.9 + amplitude * 0.45 + rel * 2.2 + volumeBoost + bucketBonus + priorityBonus(asset.symbol) - freqPenalty - last1Penalty - last2Penalty - last5Penalty;
}
async function get1hChange(baseUrl, symbol, options = {}) {
  const rows = await getJson(`${baseUrl}/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=2`, options);
  if (!Array.isArray(rows) || rows.length < 2) return 0;
  const prevClose = Number(rows[0][4]);
  const lastClose = Number(rows[1][4]);
  if (!Number.isFinite(prevClose) || !Number.isFinite(lastClose) || prevClose === 0) return 0;
  return ((lastClose - prevClose) / prevClose) * 100;
}
function amplitude24h(row) {
  const high = Number(row.highPrice || 0);
  const low = Number(row.lowPrice || 0);
  const last = Number(row.lastPrice || 0);
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(last) || high <= 0 || low <= 0 || last <= 0) return 0;
  return ((high - low) / last) * 100;
}
function buildFacts(lead, peer, anchor, isFutures) {
  const tag = isFutures ? '合约' : '';
  return [
    `${lead.symbol} ${tag}现价 ${price(lead.price)}，1h ${fmt(lead.change1h)}，24h ${fmt(lead.change24h)}`,
    `${peer.symbol} ${tag}现价 ${price(peer.price)}，1h ${fmt(peer.change1h)}，24h ${fmt(peer.change24h)}`,
    `${anchor.symbol} 现价 ${price(anchor.price)}，1h ${fmt(anchor.change1h)}，24h ${fmt(anchor.change24h)}`,
    `${lead.symbol} 24h ${tag}成交额 ${usd(lead.volume24h)}，${peer.symbol} 24h ${tag}成交额 ${usd(peer.volume24h)}`,
    `${lead.symbol} 24h振幅 ${fmt(lead.amplitude24h)}，${peer.symbol} 24h振幅 ${fmt(peer.amplitude24h)}，${anchor.symbol} 24h振幅 ${fmt(anchor.amplitude24h)}`
  ].map(s => s.replace(/\s+/g, ' '));
}
function buildTakeaways(lead, peer, anchor, isFutures) {
  const relPeer = Number(lead.change1h || 0) - Number(peer.change1h || 0);
  const relAnchor = Number(lead.change1h || 0) - Number(anchor.change1h || 0);
  const lines = [`${lead.symbol} 相对 ${peer.symbol} 1h ${relPeer >= 0 ? '领先' : '落后'} ${Math.abs(relPeer).toFixed(2)}%，相对 ${anchor.symbol} ${relAnchor >= 0 ? '强出' : '弱于'} ${Math.abs(relAnchor).toFixed(2)}%。`];
  if (lead.bucket === 'contract-meme' || lead.bucket === 'meme') {
    lines.push(`这更像情绪${isFutures ? '和合约资金一起点火' : '盘在抢流动性'}，${lead.symbol} 负责带节奏，${peer.symbol} 更像跟随补涨，${anchor.symbol} 是大盘情绪锚。`);
  } else if (lead.bucket === 'bnb-beta') {
    lines.push(`BNB 生态小币弹性放大，${lead.symbol} 更像主动抢流动性，${peer.symbol} 在陪跑，短线情绪通常比主流币先过热。`);
  } else {
    lines.push(`现在更像板块内部强弱分化，${lead.symbol} 是主动腿，${peer.symbol} 是对照腿，${anchor.symbol} 负责确认风险偏好。`);
  }
  return lines;
}
function chooseTrio(rows, oneHourMap, recentBias, source, isFutures) {
  const assets = rows.map(row => {
    const base = normalizeBaseSymbol(row.symbol);
    return {
      id: row.symbol, symbol: base, name: inferName(base), bucket: inferBucket(base),
      price: Number(row.lastPrice || 0), change1h: Number(oneHourMap[row.symbol] || 0), change24h: Number(row.priceChangePercent || 0),
      high24h: Number(row.highPrice || 0), low24h: Number(row.lowPrice || 0), amplitude24h: amplitude24h(row),
      volume24h: Number(row.quoteVolume || 0), marketCap: null,
      url: isFutures ? `https://www.binance.com/en/futures/${row.symbol}` : `https://www.binance.com/en/trade/${base}_USDT?type=spot`
    };
  });
  const anchors = {
    BTC: anchorFromRows(rows, oneHourMap, 'BTCUSDT', 'BTC', isFutures),
    ETH: anchorFromRows(rows, oneHourMap, 'ETHUSDT', 'ETH', isFutures)
  };
  if (!anchors.BTC.price || !anchors.ETH.price) throw new Error('missing_anchor_assets');
  const anchor = Math.abs(anchors.BTC.change1h) >= Math.abs(anchors.ETH.change1h) ? anchors.BTC : anchors.ETH;
  const scored = assets.filter(a => a.symbol !== anchor.symbol).map(a => ({ ...a, score: rankScore(a, anchors, recentBias) })).sort((a, b) => b.score - a.score);
  const lead = scored.find(a => a.symbol !== 'BTC' && a.symbol !== 'ETH' && a.symbol !== recentBias.last1) || scored.find(a => a.symbol !== 'BTC' && a.symbol !== 'ETH' && !recentBias.last2.includes(a.symbol)) || scored[0];
  if (!lead) throw new Error('no_lead_asset');
  const peer = scored.find(a => a.symbol !== lead.symbol && !recentBias.last2.includes(a.symbol) && ['contract-meme', 'bnb-beta', 'meme', 'beta', 'major-beta', lead.bucket].includes(a.bucket)) || scored.find(a => a.symbol !== lead.symbol) || anchor;
  if (!peer) throw new Error('no_peer_asset');
  return {
    ok: true, source, generatedAt: new Date().toISOString(),
    trio: { lead, peer, anchor },
    facts: buildFacts(lead, peer, anchor, isFutures),
    takeaways: buildTakeaways(lead, peer, anchor, isFutures),
    candidates: scored.slice(0, 12).map(a => ({ symbol: a.symbol, bucket: a.bucket, score: Number(a.score.toFixed(2)), price: a.price, change1h: a.change1h, change24h: a.change24h, amplitude24h: a.amplitude24h, volume24h: a.volume24h }))
  };
}
function anchorFromRows(rows, oneHourMap, id, symbol, isFutures) {
  const row = rows.find(r => r.symbol === id) || {};
  return { symbol, name: inferName(symbol), bucket: 'anchor', price: Number(row.lastPrice || 0), change1h: Number(oneHourMap[id] || 0), change24h: Number(row.priceChangePercent || 0), high24h: Number(row.highPrice || 0), low24h: Number(row.lowPrice || 0), amplitude24h: amplitude24h(row), volume24h: Number(row.quoteVolume || 0), url: isFutures ? `https://www.binance.com/en/futures/${id}` : `https://www.binance.com/en/trade/${symbol}_USDT?type=spot` };
}
async function hydrate1h(symbols, baseUrl, options) {
  const entries = await Promise.all([...symbols].map(async symbol => {
    try { return [symbol, await get1hChange(baseUrl, symbol, options)]; }
    catch { return [symbol, 0]; }
  }));
  return Object.fromEntries(entries);
}

async function safeJson(url, options = {}) {
  try { return await getJson(url, { timeoutMs: 6000, ...options }); }
  catch { return null; }
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
function spreadBps(book) {
  const bid = Number(book?.bidPrice || 0);
  const ask = Number(book?.askPrice || 0);
  const mid = (bid + ask) / 2;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || mid <= 0) return 0;
  return ((ask - bid) / mid) * 10000;
}
function lastRow(rows) { return Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null; }
function prevRow(rows) { return Array.isArray(rows) && rows.length > 1 ? rows[rows.length - 2] : null; }
async function enrichOneFutures(asset) {
  const id = pairId(asset.symbol);
  const [premium, oi, oiHist, globalLs, topLs, takerLs, depth, book] = await Promise.all([
    safeJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(id)}`),
    safeJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(id)}`),
    safeJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${encodeURIComponent(id)}&period=5m&limit=2`),
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
    depth: depthStats(depth),
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
async function enrichMarketIntel(pack, isFutures) {
  const assets = [pack.trio.lead, pack.trio.peer, pack.trio.anchor];
  const results = await Promise.all(assets.map(async asset => {
    const data = isFutures ? await enrichOneFutures(asset) : await enrichOneSpot(asset);
    return [asset.symbol, data];
  }));
  const intel = { source: isFutures ? 'binance-futures-public' : 'binance-spot-public', generatedAt: new Date().toISOString(), symbols: Object.fromEntries(results) };
  pack.marketIntel = intel;
  appendIntelFacts(pack, intel, isFutures);
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
    if (!base || EXCLUDED_BASES.has(base)) return false;
    const quoteVol = Number(row.quoteVolume || 0);
    return Number.isFinite(quoteVol) && quoteVol >= 50000;
  });
  const topMovers = pickTopMovers(rows).slice(0, 30);
  const symbols = new Set(['BTCUSDT', 'ETHUSDT', ...topMovers.map(r => r.symbol)]);
  const oneHourMap = await hydrate1h(symbols, 'https://fapi.binance.com/fapi/v1');
  const pack = chooseTrio(topMovers.concat(rows.filter(r => r.symbol === 'BTCUSDT' || r.symbol === 'ETHUSDT')), oneHourMap, recentBias, 'binance-futures-priority', true);
  return enrichMarketIntel(pack, true);
}
function pickTopMovers(rows) {
  return rows.filter(row => {
    const base = normalizeBaseSymbol(row.symbol);
    const abs24h = Math.abs(Number(row.priceChangePercent || 0));
    const quoteVol = Number(row.quoteVolume || 0);
    return abs24h >= 4 || quoteVol >= 15000000 || PRIORITY_SYMBOLS.includes(base);
  }).sort((a, b) => Math.abs(Number(b.priceChangePercent || 0)) - Math.abs(Number(a.priceChangePercent || 0)));
}
async function buildSpotPack(settings, futuresErr) {
  const recentBias = buildRecentBias(settings);
  const tickers = await getJson('https://www.binance.com/api/v3/ticker/24hr', { proxy: false, timeoutMs: 25000 });
  const minVol = Number(settings.minSpotQuoteVolume || 5000000);
  const rows = (Array.isArray(tickers) ? tickers : []).filter(row => {
    const symbol = String(row?.symbol || '');
    if (!symbol.endsWith('USDT')) return false;
    const base = normalizeBaseSymbol(symbol);
    if (!base || EXCLUDED_BASES.has(base) || /(UP|DOWN|BULL|BEAR)$/.test(base)) return false;
    const quoteVol = Number(row.quoteVolume || 0);
    return Number.isFinite(quoteVol) && quoteVol >= minVol;
  });
  if (!rows.length) throw new Error('empty_spot_rows');
  const topMovers = pickTopMovers(rows).slice(0, 30);
  const symbols = new Set(['BTCUSDT', 'ETHUSDT', ...topMovers.map(r => r.symbol)]);
  const oneHourMap = await hydrate1h(symbols, 'https://www.binance.com/api/v3', { proxy: false, timeoutMs: 15000 });
  const pack = await enrichMarketIntel(chooseTrio(topMovers.concat(rows.filter(r => r.symbol === 'BTCUSDT' || r.symbol === 'ETHUSDT')), oneHourMap, recentBias, 'binance-spot-www-fallback', false), false);
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
      if (cache) return { ...cache.pack, generatedAt: new Date().toISOString(), cacheFallback: true, cacheSavedAt: new Date(cache.savedAt).toISOString(), fallbackReason: spotErr.message || String(spotErr) };
      throw new Error(`market_pack_failed:futures=${futuresErr.message || futuresErr};spot=${spotErr.message || spotErr}`);
    }
  }
}
module.exports = { buildMarketPack, fmt, usd, price };
