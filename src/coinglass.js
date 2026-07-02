const { getJson } = require('./httpClient');
const { getIntelConfig } = require('./store');

const COINGLASS_BASE_URL = String(process.env.COINGLASS_BASE_URL || 'https://open-api-v4.coinglass.com').replace(/\/+$/, '');
const DEFAULT_EXCHANGE = process.env.COINGLASS_EXCHANGE || 'Binance';
const REQUEST_TIMEOUT_MS = Math.max(3000, Number(process.env.COINGLASS_TIMEOUT_MS || 9000));

// CoinGlass futures endpoints use contract pair symbols. Some Binance USDT-M
// contracts are listed as 1000* even though Square cashtags use the base coin.
const PAIR_OVERRIDES = {
  PEPE: '1000PEPEUSDT',
  BONK: '1000BONKUSDT',
  FLOKI: '1000FLOKIUSDT',
  SHIB: '1000SHIBUSDT',
  SATS: '1000SATSUSDT',
  '1000SATS': '1000SATSUSDT'
};

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function sum(values = []) {
  return values.reduce((acc, v) => acc + (toNumber(v) || 0), 0);
}
function pctChange(first, last) {
  first = toNumber(first);
  last = toNumber(last);
  if (first == null || last == null || first === 0) return null;
  return ((last - first) / first) * 100;
}
function last(rows = []) {
  return Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null;
}
function trimRows(rows = [], limit = 48) {
  return (Array.isArray(rows) ? rows : []).slice(-Math.max(1, Number(limit || 48)));
}
function baseSymbol(symbol = '') {
  return String(symbol || '').replace(/^\$/, '').replace(/USDT$/i, '').toUpperCase();
}
function pairSymbol(symbol = '') {
  const base = baseSymbol(symbol);
  if (!base) return '';
  return PAIR_OVERRIDES[base] || `${base}USDT`;
}
function priceLabel(value) {
  const n = toNumber(value);
  if (n == null) return '--';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (n >= 1) return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (n >= 0.01) return n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}
function usd(value) {
  const n = toNumber(value);
  if (n == null) return '--';
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
function signedPct(value, digits = 2) {
  const n = toNumber(value);
  if (n == null) return '--';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

async function coinglassGet(endpoint, params = {}, apiKey) {
  const url = new URL(`${COINGLASS_BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const json = await getJson(url.toString(), {
    headers: {
      'CG-API-KEY': apiKey,
      accept: 'application/json'
    },
    timeoutMs: REQUEST_TIMEOUT_MS
  });
  const code = String(json?.code ?? '');
  if (code && code !== '0') throw new Error(`coinglass_${code}:${json?.msg || json?.message || 'unknown_error'}`);
  return json?.data;
}

async function safeEndpoint(name, endpoint, params, apiKey) {
  try {
    const data = await coinglassGet(endpoint, params, apiKey);
    return { name, ok: true, endpoint, params, data };
  } catch (err) {
    return { name, ok: false, endpoint, params, error: err.message || String(err) };
  }
}

function normalizeHeatmapCandles(rows = []) {
  return trimRows(rows, 96).map(row => {
    if (!Array.isArray(row)) return null;
    const rawTime = toNumber(row[0]);
    return {
      time: rawTime == null ? null : (rawTime < 1e12 ? rawTime * 1000 : rawTime),
      open: toNumber(row[1]),
      high: toNumber(row[2]),
      low: toNumber(row[3]),
      close: toNumber(row[4]),
      volumeUsd: toNumber(row[5])
    };
  }).filter(k => k && k.close != null && k.high != null && k.low != null);
}

function normalizeHeatmap(data = null) {
  if (!data || !Array.isArray(data.y_axis) || !Array.isArray(data.liquidation_leverage_data)) return null;
  const yAxis = data.y_axis.map(toNumber).filter(v => v != null);
  const priceCandlesticks = normalizeHeatmapCandles(data.price_candlesticks || []);
  const lastPrice = last(priceCandlesticks)?.close || null;
  const cells = data.liquidation_leverage_data.map(row => {
    if (!Array.isArray(row) || row.length < 3) return null;
    const xIndex = Number(row[0]);
    const yIndex = Number(row[1]);
    const amountUsd = toNumber(row[2]);
    const levelPrice = yAxis[yIndex];
    if (!Number.isFinite(xIndex) || !Number.isFinite(yIndex) || amountUsd == null || amountUsd <= 0 || levelPrice == null) return null;
    return {
      xIndex,
      yIndex,
      price: levelPrice,
      amountUsd,
      side: lastPrice == null ? 'unknown' : (levelPrice >= lastPrice ? 'above' : 'below'),
      distancePct: lastPrice ? ((levelPrice - lastPrice) / lastPrice) * 100 : null
    };
  }).filter(Boolean);
  if (!cells.length || !yAxis.length) return null;
  const byPrice = new Map();
  for (const cell of cells) byPrice.set(cell.price, (byPrice.get(cell.price) || 0) + cell.amountUsd);
  const levels = [...byPrice.entries()]
    .map(([p, amountUsd]) => ({ price: Number(p), amountUsd, side: lastPrice == null ? 'unknown' : (Number(p) >= lastPrice ? 'above' : 'below'), distancePct: lastPrice ? ((Number(p) - lastPrice) / lastPrice) * 100 : null }))
    .sort((a, b) => b.amountUsd - a.amountUsd);
  const topAbove = levels.find(x => x.side === 'above') || null;
  const topBelow = levels.find(x => x.side === 'below') || null;
  const maxAmount = Math.max(...cells.map(c => c.amountUsd));
  const topCells = cells.sort((a, b) => b.amountUsd - a.amountUsd).slice(0, 420);
  const storedYAxis = [...new Set(topCells.map(c => c.price))].sort((a, b) => a - b);
  return {
    available: true,
    // Keep only the most informative cells in market_pack. The prompt receives
    // MARKET_PACK_JSON, so storing the full heatmap would waste tokens; the
    // image still has enough real cells to look like a data terminal.
    yAxis: storedYAxis,
    cells: topCells,
    priceCandlesticks,
    summary: {
      totalUsd: sum(cells.map(c => c.amountUsd)),
      maxCellUsd: maxAmount,
      cellCount: cells.length,
      lastPrice,
      topLevels: levels.slice(0, 10),
      topAbove,
      topBelow
    }
  };
}

function summarizeLiquidation(rows = []) {
  const list = trimRows(rows, 48).map(r => ({
    time: toNumber(r?.time),
    longLiquidationUsd: toNumber(r?.long_liquidation_usd),
    shortLiquidationUsd: toNumber(r?.short_liquidation_usd)
  })).filter(r => r.longLiquidationUsd != null || r.shortLiquidationUsd != null);
  if (!list.length) return null;
  const longUsd = sum(list.map(r => r.longLiquidationUsd));
  const shortUsd = sum(list.map(r => r.shortLiquidationUsd));
  const totalUsd = longUsd + shortUsd;
  return {
    available: true,
    rows: list,
    longLiquidationUsd: longUsd,
    shortLiquidationUsd: shortUsd,
    totalUsd,
    dominant: longUsd > shortUsd * 1.15 ? 'long_liquidations' : shortUsd > longUsd * 1.15 ? 'short_liquidations' : 'balanced',
    shortToLongRatio: longUsd > 0 ? shortUsd / longUsd : null
  };
}

function summarizeOrderbookAskBids(rows = []) {
  const list = trimRows(rows, 48).map(r => ({
    time: toNumber(r?.time),
    bidsUsd: toNumber(r?.bids_usd),
    bidsQuantity: toNumber(r?.bids_quantity),
    asksUsd: toNumber(r?.asks_usd),
    asksQuantity: toNumber(r?.asks_quantity)
  })).filter(r => r.bidsUsd != null || r.asksUsd != null);
  if (!list.length) return null;
  const latest = last(list);
  const total = (latest.bidsUsd || 0) + (latest.asksUsd || 0);
  const imbalancePct = total > 0 ? (((latest.bidsUsd || 0) - (latest.asksUsd || 0)) / total) * 100 : null;
  return {
    available: true,
    rows: list,
    latest,
    imbalancePct,
    dominant: imbalancePct == null ? 'unknown' : imbalancePct > 5 ? 'bid_heavy' : imbalancePct < -5 ? 'ask_heavy' : 'balanced'
  };
}

function summarizeOpenInterest(rows = []) {
  const list = trimRows(rows, 48).map(r => ({
    time: toNumber(r?.time),
    open: toNumber(r?.open),
    high: toNumber(r?.high),
    low: toNumber(r?.low),
    close: toNumber(r?.close)
  })).filter(r => r.close != null);
  if (list.length < 2) return null;
  const first = list[0];
  const latest = last(list);
  const changePct = pctChange(first.close, latest.close);
  return { available: true, rows: list, latest, changePct, trend: changePct == null ? 'unknown' : changePct > 1 ? 'rising' : changePct < -1 ? 'falling' : 'flat' };
}

function summarizeLongShort(rows = []) {
  const list = trimRows(rows, 48).map(r => ({
    time: toNumber(r?.time),
    longPercent: toNumber(r?.global_account_long_percent),
    shortPercent: toNumber(r?.global_account_short_percent),
    ratio: toNumber(r?.global_account_long_short_ratio)
  })).filter(r => r.ratio != null || r.longPercent != null || r.shortPercent != null);
  if (!list.length) return null;
  return { available: true, rows: list, latest: last(list) };
}

function summarizeCoinglassEvidence({ base, pair, results }) {
  const byName = Object.fromEntries((results || []).map(r => [r.name, r]));
  const heatmap = byName.heatmap?.ok ? normalizeHeatmap(byName.heatmap.data) : null;
  const liquidation = byName.liquidation?.ok ? summarizeLiquidation(byName.liquidation.data) : null;
  const orderbook = byName.orderbookAskBids?.ok ? summarizeOrderbookAskBids(byName.orderbookAskBids.data) : null;
  const openInterest = byName.openInterest?.ok ? summarizeOpenInterest(byName.openInterest.data) : null;
  const longShort = byName.longShort?.ok ? summarizeLongShort(byName.longShort.data) : null;
  const endpointStatus = Object.fromEntries((results || []).map(r => [r.name, r.ok ? { ok: true } : { ok: false, error: r.error }]));
  const ok = !!(heatmap || liquidation || orderbook || openInterest || longShort);
  return {
    ok,
    source: 'coinglass-v4',
    exchange: DEFAULT_EXCHANGE,
    base,
    pair,
    fetchedAt: new Date().toISOString(),
    endpoints: endpointStatus,
    heatmap: heatmap || { available: false },
    liquidation: liquidation || { available: false },
    orderbookAskBids: orderbook || { available: false },
    openInterest: openInterest || { available: false },
    longShort: longShort || { available: false }
  };
}

async function fetchCoinglassForSymbol(symbol) {
  const cfg = getIntelConfig({ revealKeys: true });
  if (!cfg.enabled) return { ok: false, status: 'disabled', reason: 'intel_config_disabled' };
  if (!cfg.coinglassApiKey) return { ok: false, status: 'missing_key', reason: 'missing_coinglass_api_key' };
  const base = baseSymbol(symbol);
  const pair = pairSymbol(base);
  if (!base || !pair) return { ok: false, status: 'invalid_symbol', reason: 'invalid_symbol' };
  const common = { exchange: DEFAULT_EXCHANGE, symbol: pair };
  const results = await Promise.all([
    safeEndpoint('heatmap', '/api/futures/liquidation/heatmap/model1', { ...common, range: '24h' }, cfg.coinglassApiKey),
    safeEndpoint('liquidation', '/api/futures/liquidation/history', { ...common, interval: '1h', limit: 24 }, cfg.coinglassApiKey),
    safeEndpoint('orderbookAskBids', '/api/futures/orderbook/ask-bids-history', { ...common, interval: '1h', limit: 24, range: 1 }, cfg.coinglassApiKey),
    safeEndpoint('openInterest', '/api/futures/open-interest/history', { ...common, interval: '1h', limit: 24, unit: 'usd' }, cfg.coinglassApiKey),
    safeEndpoint('longShort', '/api/futures/global-long-short-account-ratio/history', { ...common, interval: '1h', limit: 24 }, cfg.coinglassApiKey)
  ]);
  const evidence = summarizeCoinglassEvidence({ base, pair, results });
  if (!evidence.ok) {
    return {
      ...evidence,
      status: 'unavailable',
      reason: Object.entries(evidence.endpoints || {}).map(([k, v]) => `${k}:${v.error || 'empty'}`).join(' | ').slice(0, 700)
    };
  }
  return { ...evidence, status: 'ok' };
}

async function fetchCoinglassForPack(pack = {}) {
  const lead = pack?.trio?.lead?.symbol || pack?.lead?.symbol || '';
  return fetchCoinglassForSymbol(lead);
}

function buildCoinglassPromptLines(evidence = {}) {
  if (!evidence?.ok) return { facts: [], takeaways: [] };
  const facts = [];
  const takeaways = [];
  const s = evidence.base || evidence.pair || '';
  const hm = evidence.heatmap?.summary;
  if (hm?.topLevels?.length) {
    const topAbove = hm.topAbove ? `${priceLabel(hm.topAbove.price)} 附近 ${usd(hm.topAbove.amountUsd)}` : '无明显上方热区';
    const topBelow = hm.topBelow ? `${priceLabel(hm.topBelow.price)} 附近 ${usd(hm.topBelow.amountUsd)}` : '无明显下方热区';
    facts.push(`${s} Coinglass 24h清算热区：上方 ${topAbove}，下方 ${topBelow}，热区合计约 ${usd(hm.totalUsd)}。`);
    takeaways.push(`${s} 有 Coinglass 清算热力图可作配图证据；正文最多取一个价位热区做人话判断，不要照抄全部数字。`);
  }
  const liq = evidence.liquidation;
  if (liq?.available) {
    const side = liq.dominant === 'long_liquidations' ? '多单爆仓更多' : liq.dominant === 'short_liquidations' ? '空单爆仓更多' : '多空爆仓接近';
    facts.push(`${s} Coinglass 近24h爆仓：多单 ${usd(liq.longLiquidationUsd)}，空单 ${usd(liq.shortLiquidationUsd)}，${side}。`);
  }
  const ob = evidence.orderbookAskBids;
  if (ob?.available && ob.latest) {
    const side = ob.dominant === 'bid_heavy' ? '买盘更厚' : ob.dominant === 'ask_heavy' ? '卖盘更厚' : '买卖盘接近';
    facts.push(`${s} Coinglass ±1%深度：买盘 ${usd(ob.latest.bidsUsd)}，卖盘 ${usd(ob.latest.asksUsd)}，${side}${ob.imbalancePct == null ? '' : ` ${Math.abs(ob.imbalancePct).toFixed(1)}%`}。`);
  }
  const oi = evidence.openInterest;
  const ls = evidence.longShort;
  if (oi?.available || ls?.available) {
    const parts = [];
    if (oi?.available) parts.push(`OI 近24h ${signedPct(oi.changePct)}`);
    if (ls?.latest) parts.push(`账户多空比 ${Number(ls.latest.ratio || 0).toFixed(2)}，多头 ${Number(ls.latest.longPercent || 0).toFixed(1)}%`);
    facts.push(`${s} Coinglass 合约情绪：${parts.join('；')}。`);
  }
  return { facts, takeaways };
}

module.exports = {
  COINGLASS_BASE_URL,
  pairSymbol,
  fetchCoinglassForSymbol,
  fetchCoinglassForPack,
  summarizeCoinglassEvidence,
  buildCoinglassPromptLines,
  priceLabel,
  usd
};
