const { getJson } = require('./httpClient');

const REFERENCES = [
  { symbol: 'QQQ', group: 'macro', label: 'Nasdaq 100 ETF' },
  { symbol: 'SPY', group: 'macro', label: 'S&P 500 ETF' },
  { symbol: 'SOXX', group: 'ai', label: 'Semiconductor ETF' },
  { symbol: 'IWM', group: 'macro', label: 'Russell 2000 ETF' },
  { symbol: 'NVDA', group: 'ai', label: 'NVIDIA' },
  { symbol: 'AMD', group: 'ai', label: 'AMD' },
  { symbol: 'COIN', group: 'crypto_beta', label: 'Coinbase' },
  { symbol: 'MSTR', group: 'crypto_beta', label: 'Strategy' },
  { symbol: '^VIX', group: 'macro', label: 'VIX' },
  { symbol: 'DX-Y.NYB', group: 'macro', label: 'US Dollar Index' },
  { symbol: '^TNX', group: 'macro', label: 'US 10Y Yield' },
  { symbol: 'GC=F', group: 'macro', label: 'Gold Futures' },
  { symbol: 'CL=F', group: 'macro', label: 'WTI Crude' }
];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function pct(v) { const n = num(v); return n == null ? '--' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }

function parseChart(ref, json) {
  const result = json?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta || {};
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = timestamps.map((time, i) => ({ time: Number(time) * 1000, close: num(closes[i]) })).filter(x => x.close != null && x.close > 0);
  if (!points.length) return null;
  const last = points[points.length - 1];
  const prior = points[points.length - 2] || last;
  const previousCloseRaw = num(meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPreviousClose);
  const previousClose = previousCloseRaw != null && previousCloseRaw > 0 ? previousCloseRaw : null;
  const change24hRaw = previousClose ? ((last.close - previousClose) / previousClose) * 100 : null;
  const change24h = change24hRaw != null && Math.abs(change24hRaw) <= 35 ? change24hRaw : null;
  return {
    symbol: ref.symbol, label: ref.label, group: ref.group, price: last.close,
    change1h: prior.close ? ((last.close - prior.close) / prior.close) * 100 : null,
    change24h,
    previousClose, marketState: meta.marketState || null, exchange: meta.exchangeName || null,
    currency: meta.currency || 'USD', timestamp: new Date(last.time).toISOString(), source: 'Yahoo Finance public chart'
  };
}

async function fetchTradfiReferences() {
  const rows = await Promise.all(REFERENCES.map(async ref => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ref.symbol)}?interval=1h&range=5d`;
      return parseChart(ref, await getJson(url, { timeoutMs: 7000, proxy: false, headers: { 'User-Agent': 'Mozilla/5.0' } }));
    } catch { return null; }
  }));
  const available = rows.filter(Boolean);
  return { ok: available.length >= 3, source: 'Yahoo Finance public chart', fetchedAt: new Date().toISOString(), assets: Object.fromEntries(available.map(x => [x.symbol, x])) };
}

function attachTradfi(pack, data) {
  pack.tradfi = data;
  if (!data?.ok) return pack;
  const assets = Object.values(data.assets || {});
  const group = name => Object.fromEntries(assets.filter(x => x.group === name).map(x => [x.symbol, x]));
  pack.stocks = { ai: group('ai'), crypto_beta: group('crypto_beta'), etf_macro: group('macro') };
  const ranked = assets.filter(x => x.change24h != null).sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
  pack.stockFacts = `传统市场公开行情参照：${ranked.slice(0, 5).map(x => `${x.symbol} ${pct(x.change24h)}`).join('；')}。（Yahoo Finance 公共图表，可能延迟）`;
  const qqq = data.assets.QQQ, soxx = data.assets.SOXX, coin = data.assets.COIN, mstr = data.assets.MSTR, vix = data.assets['^VIX'];
  const growth = [qqq, soxx].filter(Boolean).reduce((s, x) => s + Number(x.change24h || 0), 0) / Math.max(1, [qqq, soxx].filter(Boolean).length);
  const cryptoBeta = [coin, mstr].filter(Boolean).reduce((s, x) => s + Number(x.change24h || 0), 0) / Math.max(1, [coin, mstr].filter(Boolean).length);
  if (growth > 0.7 && cryptoBeta > 1) pack.stockTakeaways = '纳指/半导体与 crypto beta 同向偏强，外部风险偏好对币圈不是拖累，但不能替代币圈自身确认。';
  else if (growth > 0.7 && cryptoBeta <= 0) pack.stockTakeaways = '科技股偏强，但 COIN/MSTR 没有同步，传统市场的风险偏好尚未传导到 crypto beta。';
  else if (growth < -0.7 || Number(vix?.change24h || 0) > 5) pack.stockTakeaways = '传统风险资产偏弱或波动率抬升，小币独立走强时更需要真实成交与合约仓位支持。';
  else pack.stockTakeaways = '传统市场方向不集中，本轮只把它作为背景，不据此推导币价。';
  return pack;
}

module.exports = { REFERENCES, fetchTradfiReferences, attachTradfi, parseChart };
