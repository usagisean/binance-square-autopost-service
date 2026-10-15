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

const PLAIN_SYMBOLS = new Set(REFERENCES
  .map(x => x.symbol)
  .filter(symbol => /^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)));

const DISPLAY_NAMES = {
  QQQ: '纳指100 ETF', SPY: '标普500 ETF', SOXX: '半导体ETF', IWM: '罗素2000 ETF',
  NVDA: '英伟达', AMD: 'AMD', COIN: 'Coinbase', MSTR: 'Strategy', '^VIX': 'VIX波动率',
  'DX-Y.NYB': '美元指数', '^TNX': '美债10年期收益率', 'GC=F': '黄金期货', 'CL=F': 'WTI原油'
};

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function pct(v) { const n = num(v); return n == null ? '--' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }

function parseChart(ref, json, now = Date.now()) {
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
  const ageMinutes = Math.max(0, (Number(now) - last.time) / 60000);
  return {
    symbol: ref.symbol, label: ref.label, group: ref.group, price: last.close,
    change1h: prior.close ? ((last.close - prior.close) / prior.close) * 100 : null,
    change24h,
    previousClose, marketState: meta.marketState || null, exchange: meta.exchangeName || null,
    currency: meta.currency || 'USD', timestamp: new Date(last.time).toISOString(), ageMinutes: Number(ageMinutes.toFixed(1)),
    source: 'Yahoo Finance public chart'
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

function avg(rows = [], key = 'change24h') {
  const values = rows.map(x => num(x?.[key])).filter(x => x != null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function relevantSymbols(pack = {}) {
  const lead = pack.trio?.lead || {};
  if (lead.bucket === 'ai') return ['QQQ', 'SOXX', 'NVDA', 'AMD'];
  if (['BTC', 'ETH', 'SOL', 'BNB', 'XRP'].includes(String(lead.symbol || '').toUpperCase())) return ['COIN', 'MSTR', 'QQQ'];
  return ['QQQ', 'IWM', 'COIN', 'MSTR'];
}

function buildTradfiSignal(pack = {}, data = pack.tradfi || {}) {
  const assets = data?.assets || {};
  const selected = relevantSymbols(pack).map(symbol => assets[symbol]).filter(Boolean);
  const latestMs = Math.max(0, ...selected.map(x => Date.parse(x.timestamp || '') || 0));
  const ageHours = latestMs ? Math.max(0, (Date.now() - latestMs) / 3600000) : null;
  const sessionStates = [...new Set(selected.map(x => String(x.marketState || 'UNKNOWN').toUpperCase()))];
  const liveSession = selected.some(x => ['REGULAR', 'PRE', 'POST', 'PREPRE', 'POSTPOST'].includes(String(x.marketState || '').toUpperCase()) && num(x.ageMinutes) <= 180);
  const usable = data?.ok === true && selected.length >= 2 && (ageHours == null || ageHours <= 120);
  const move = avg(selected);
  const leadMove = num(pack.trio?.lead?.change1h);
  const threshold = pack.trio?.lead?.bucket === 'ai' ? 0.6 : 0.8;
  let relation = 'neutral';
  if (usable && move != null && leadMove != null && Math.abs(move) >= threshold && Math.abs(leadMove) >= 0.4) {
    relation = move * leadMove > 0 ? 'confirming' : 'diverging';
  }
  const riskRows = ['QQQ', 'SPY', 'IWM'].map(symbol => assets[symbol]).filter(Boolean);
  const riskMove = avg(riskRows);
  const vixMove = num(assets['^VIX']?.change24h);
  const riskRegime = riskMove != null && riskMove >= 0.5 && (vixMove == null || vixMove < 3)
    ? 'risk_on'
    : (riskMove != null && riskMove <= -0.5) || (vixMove != null && vixMove >= 5)
      ? 'risk_off'
      : 'mixed';
  const relevant = selected
    .filter(x => x.change24h != null)
    .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
    .slice(0, 3)
    .map(x => ({ symbol: x.symbol, name: DISPLAY_NAMES[x.symbol] || x.label || x.symbol, change24h: x.change24h, change1h: x.change1h, marketState: x.marketState, timestamp: x.timestamp }));
  return {
    usable, liveSession, relation, riskRegime, relevant,
    averageRelevantMove24h: move == null ? null : Number(move.toFixed(2)),
    ageHours: ageHours == null ? null : Number(ageHours.toFixed(1)),
    sessionStates,
    source: data?.source || 'Yahoo Finance public chart',
    boundary: liveSession ? '盘中公开行情，可能延迟' : '最近一个美股交易时段的公开行情，不是实时触发信号'
  };
}

function formatTradfiSignal(signal = {}) {
  if (!signal.usable || !signal.relevant?.length) return '';
  const relation = signal.relation === 'confirming' ? '与币圈主角同向'
    : signal.relation === 'diverging' ? '与币圈主角背离' : '方向不集中';
  const rows = signal.relevant.map(x => `${x.name}(${x.symbol}) 24h ${pct(x.change24h)}`).join('；');
  return `美股交叉验证：${rows}；${relation}。${signal.boundary}。`;
}

function attachTradfi(pack, data) {
  pack.tradfi = data;
  if (!data?.ok) return pack;
  const assets = Object.values(data.assets || {});
  const group = name => Object.fromEntries(assets.filter(x => x.group === name).map(x => [x.symbol, x]));
  pack.stocks = { ai: group('ai'), crypto_beta: group('crypto_beta'), etf_macro: group('macro') };
  pack.tradfiSignal = buildTradfiSignal(pack, data);
  pack.stockFacts = formatTradfiSignal(pack.tradfiSignal) || '美股参照数据时效或覆盖不足，本轮不作方向证据。';
  const qqq = data.assets.QQQ, soxx = data.assets.SOXX, coin = data.assets.COIN, mstr = data.assets.MSTR, vix = data.assets['^VIX'];
  const growth = [qqq, soxx].filter(Boolean).reduce((s, x) => s + Number(x.change24h || 0), 0) / Math.max(1, [qqq, soxx].filter(Boolean).length);
  const cryptoBeta = [coin, mstr].filter(Boolean).reduce((s, x) => s + Number(x.change24h || 0), 0) / Math.max(1, [coin, mstr].filter(Boolean).length);
  if (pack.tradfiSignal.relation === 'confirming') pack.stockTakeaways = '美股相关资产与币圈主角同向，可作为一条独立旁证，但不得写成因果或涨跌承诺。';
  else if (pack.tradfiSignal.relation === 'diverging') pack.stockTakeaways = '美股相关资产与币圈主角背离，这是必须写出的反证，不能只挑有利数据。';
  else if (growth > 0.7 && cryptoBeta > 1) pack.stockTakeaways = '纳指/半导体与 crypto beta 同向偏强，外部风险偏好对币圈不是拖累，但不能替代币圈自身确认。';
  else if (growth > 0.7 && cryptoBeta <= 0) pack.stockTakeaways = '科技股偏强，但 COIN/MSTR 没有同步，传统市场的风险偏好尚未传导到 crypto beta。';
  else if (growth < -0.7 || Number(vix?.change24h || 0) > 5) pack.stockTakeaways = '传统风险资产偏弱或波动率抬升，小币独立走强时更需要真实成交与合约仓位支持。';
  else pack.stockTakeaways = '传统市场方向不集中，本轮只把它作为背景，不据此推导币价。';
  return pack;
}

module.exports = { REFERENCES, PLAIN_SYMBOLS, fetchTradfiReferences, attachTradfi, parseChart, buildTradfiSignal, formatTradfiSignal };
