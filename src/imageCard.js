const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { DATA_DIR } = require('./config');

const W = 1080;
const H = 1080;
const PANEL = '#151a22';
const BG = '#0b0e11';
const LINE = '#2b3139';
const MUTED = '#848e9c';
const TEXT = '#f5f5f5';
const YELLOW = '#f0b90b';
const GREEN = '#0ecb81';
const RED = '#f6465d';

function esc(v = '') {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n) || 0)); }
function pct(v, digits = 2) {
  const n = num(v);
  if (n == null) return '--';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(Math.abs(n) >= 10 ? 1 : digits)}%`;
}
function price(v) {
  const n = num(v);
  if (n == null || n <= 0) return '--';
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 100) return `$${n.toFixed(2)}`;
  if (n >= 10) return `$${n.toFixed(3)}`;
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.01) return `$${n.toFixed(5)}`;
  if (n >= 0.0001) return `$${n.toFixed(7).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${n.toPrecision(4)}`;
}
function usd(v) {
  const n = num(v);
  if (n == null) return '--';
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
function colorByPct(v) { const n = num(v) || 0; return n > 0 ? GREEN : n < 0 ? RED : '#cfd6e4'; }
function svgBase(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <style>text { font-family: "Noto Sans CJK SC", "Noto Sans CJK", "DejaVu Sans", Arial, sans-serif; }</style>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect x="44" y="44" width="992" height="992" rx="34" fill="${PANEL}" stroke="${LINE}" stroke-width="2"/>
  <rect x="44" y="44" width="992" height="8" fill="${YELLOW}"/>
  ${inner}
</svg>`;
}
function header(pack, title, subtitle = '') {
  const lead = pack.trio?.lead || {};
  const time = new Date(pack.generatedAt || Date.now()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return `
  <text x="78" y="114" font-size="26" fill="${YELLOW}" font-weight="900">${esc(title)}</text>
  <text x="78" y="166" font-size="72" fill="${TEXT}" font-weight="900">$${esc(lead.symbol || '--')}</text>
  <text x="78" y="210" font-size="24" fill="${MUTED}" font-weight="700">${esc(subtitle)}</text>
  <text x="750" y="114" font-size="22" fill="${MUTED}" font-weight="700">${esc(time)}</text>
  <text x="750" y="166" font-size="40" fill="${colorByPct(lead.change24h)}" font-weight="900">${esc(pct(lead.change24h))}</text>
  <text x="750" y="207" font-size="23" fill="${MUTED}" font-weight="700">24H · ${esc(price(lead.price))}</text>`;
}
function minmax(values) {
  const arr = values.map(Number).filter(Number.isFinite);
  if (!arr.length) return { min: 0, max: 1 };
  let min = Math.min(...arr); let max = Math.max(...arr);
  if (min === max) { min *= 0.995; max *= 1.005; }
  return { min, max };
}
function xScale(i, n, x, w) { return x + (n <= 1 ? 0 : (i / (n - 1)) * w); }
function yScale(v, min, max, y, h) { return y + h - ((Number(v) - min) / (max - min || 1)) * h; }
function linePath(rows, getY, x, y, w, h) {
  if (!rows.length) return '';
  return rows.map((r, i) => `${i ? 'L' : 'M'}${xScale(i, rows.length, x, w).toFixed(1)},${getY(r).toFixed(1)}`).join(' ');
}
function keyLevel(pack) {
  const tp = pack.tradePlan || {};
  if (tp.trigger) return String(tp.trigger).split('/')[0].trim();
  if (tp.entry) return String(tp.entry).split('-')[0].trim();
  return price(pack.trio?.lead?.price);
}
function metricBox(x, y, w, h, label, value, color = TEXT, sub = '') {
  return `<g transform="translate(${x} ${y})">
    <rect width="${w}" height="${h}" rx="22" fill="#0b0e11" stroke="${LINE}"/>
    <text x="24" y="40" font-size="22" fill="${MUTED}" font-weight="800">${esc(label)}</text>
    <text x="24" y="90" font-size="38" fill="${color}" font-weight="900">${esc(value)}</text>
    ${sub ? `<text x="24" y="124" font-size="20" fill="${MUTED}" font-weight="700">${esc(sub)}</text>` : ''}
  </g>`;
}

function chooseEvidenceType(pack = {}) {
  const lead = pack.trio?.lead || {};
  const intel = pack.marketIntel?.symbols?.[lead.symbol] || {};
  const available = ['kline'];
  if (intel.depth?.available && Number.isFinite(Number(intel.depth.imbalance))) available.push('depth');
  if (Number.isFinite(Number(intel.fundingRate)) || Number.isFinite(Number(intel.openInterestValueChange5m)) || Number.isFinite(Number(intel.takerBuySellRatio))) available.push('derivatives');

  const strongDepth = Math.abs(Number(intel.depth?.imbalance || 0)) >= 18;
  const strongDeriv = Math.abs(Number(intel.openInterestValueChange5m || 0)) >= 0.5 || Math.abs(Number(intel.fundingRate || 0)) >= 0.00025 || Math.abs(Number(intel.takerBuySellRatio || 1) - 1) >= 0.18;
  const weighted = [];
  weighted.push('kline', 'kline', 'kline');
  if (available.includes('depth')) weighted.push('depth', strongDepth ? 'depth' : 'kline');
  if (available.includes('derivatives')) weighted.push('derivatives', strongDeriv ? 'derivatives' : 'kline');
  return weighted[Math.floor(Math.random() * weighted.length)] || 'kline';
}

function buildKlineSvg(pack) {
  const lead = pack.trio?.lead || {};
  const rows = (pack.chart?.klines || []).slice(-64);
  const x = 82, y = 268, w = 916, h = 430;
  const prices = rows.flatMap(k => [k.high, k.low]).filter(Number.isFinite);
  const { min, max } = minmax(prices.length ? prices : [lead.low24h, lead.high24h, lead.price]);
  const candleW = Math.max(5, Math.min(12, w / Math.max(1, rows.length) * 0.62));
  const grid = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const yy = y + t * h;
    const val = max - t * (max - min);
    return `<line x1="${x}" y1="${yy}" x2="${x + w}" y2="${yy}" stroke="${LINE}" opacity="0.7"/><text x="${x + w + 12}" y="${yy + 7}" font-size="18" fill="${MUTED}">${esc(price(val))}</text>`;
  }).join('\n');
  const candles = rows.map((k, i) => {
    const xx = xScale(i, rows.length, x, w);
    const openY = yScale(k.open, min, max, y, h);
    const closeY = yScale(k.close, min, max, y, h);
    const highY = yScale(k.high, min, max, y, h);
    const lowY = yScale(k.low, min, max, y, h);
    const up = Number(k.close) >= Number(k.open);
    const c = up ? GREEN : RED;
    const bodyY = Math.min(openY, closeY);
    const bodyH = Math.max(2, Math.abs(openY - closeY));
    return `<line x1="${xx.toFixed(1)}" y1="${highY.toFixed(1)}" x2="${xx.toFixed(1)}" y2="${lowY.toFixed(1)}" stroke="${c}" stroke-width="2"/><rect x="${(xx - candleW / 2).toFixed(1)}" y="${bodyY.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bodyH.toFixed(1)}" rx="1.5" fill="${c}"/>`;
  }).join('\n');
  const triggerRaw = num(pack.tradePlan?.trigger);
  const triggerY = triggerRaw && triggerRaw > min && triggerRaw < max ? yScale(triggerRaw, min, max, y, h) : null;
  const level = triggerY ? `<line x1="${x}" y1="${triggerY}" x2="${x + w}" y2="${triggerY}" stroke="${YELLOW}" stroke-width="3" stroke-dasharray="10 8"/><text x="${x + 14}" y="${triggerY - 10}" font-size="24" fill="${YELLOW}" font-weight="900">KEY ${esc(price(triggerRaw))}</text>` : '';
  const body = `${header(pack, '15M KLINE SNAPSHOT', `${lead.symbol}USDT · price action evidence`)}
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="#0b0e11" stroke="${LINE}"/>
  ${grid}
  ${candles}
  ${level}
  ${metricBox(82, 742, 270, 132, 'KEY AREA', keyLevel(pack), YELLOW)}
  ${metricBox(386, 742, 270, 132, '24H RANGE', pct(lead.amplitude24h), TEXT, `high ${price(lead.high24h)} / low ${price(lead.low24h)}`)}
  ${metricBox(690, 742, 270, 132, 'VOLUME', usd(lead.volume24h), TEXT, '24h notional')}
  <text x="82" y="945" font-size="25" fill="${MUTED}" font-weight="800">真实15m K线 · 关键位只做位置参考，不是复述正文</text>
  <text x="82" y="985" font-size="26" fill="${MUTED}" font-weight="900">$${esc(lead.symbol || '--')}  $${esc(pack.trio?.peer?.symbol || '--')}  $${esc(pack.trio?.anchor?.symbol || '--')}</text>`;
  return svgBase(body);
}

function buildDepthSvg(pack) {
  const lead = pack.trio?.lead || {};
  const intel = pack.marketIntel?.symbols?.[lead.symbol] || {};
  const depth = intel.depth || {};
  const bids = (intel.depthLevels?.bids || []).slice(0, 10);
  const asks = (intel.depthLevels?.asks || []).slice(0, 10);
  const maxNotional = Math.max(1, ...bids.map(x => Number(x.notional || 0)), ...asks.map(x => Number(x.notional || 0)));
  const y0 = 300;
  const rowH = 42;
  const bidRows = bids.map((b, i) => {
    const w = Math.max(4, Math.min(330, Number(b.notional || 0) / maxNotional * 330));
    const y = y0 + i * rowH;
    return `<rect x="${454 - w}" y="${y}" width="${w}" height="28" rx="7" fill="${GREEN}" opacity="0.82"/><text x="82" y="${y + 22}" font-size="22" fill="${TEXT}" font-weight="800">${esc(price(b.price))}</text><text x="270" y="${y + 22}" font-size="20" fill="${MUTED}">${esc(usd(b.notional))}</text>`;
  }).join('\n');
  const askRows = asks.map((a, i) => {
    const w = Math.max(4, Math.min(330, Number(a.notional || 0) / maxNotional * 330));
    const y = y0 + i * rowH;
    return `<rect x="626" y="${y}" width="${w}" height="28" rx="7" fill="${RED}" opacity="0.82"/><text x="${970}" y="${y + 22}" font-size="22" fill="${TEXT}" font-weight="800" text-anchor="end">${esc(price(a.price))}</text><text x="${785}" y="${y + 22}" font-size="20" fill="${MUTED}" text-anchor="end">${esc(usd(a.notional))}</text>`;
  }).join('\n');
  const imb = Number(depth.imbalance || 0);
  const body = `${header(pack, 'ORDERBOOK WALL', `${lead.symbol}USDT · top 20 depth / spread ${Number(intel.spreadBps || 0).toFixed(1)}bp`)}
  <text x="82" y="268" font-size="24" fill="${GREEN}" font-weight="900">BIDS</text>
  <text x="998" y="268" font-size="24" fill="${RED}" font-weight="900" text-anchor="end">ASKS</text>
  <line x1="540" y1="282" x2="540" y2="728" stroke="${LINE}" stroke-width="3"/>
  ${bidRows}
  ${askRows}
  ${metricBox(82, 762, 270, 132, 'BID NOTIONAL', usd(depth.bidNotional), GREEN)}
  ${metricBox(386, 762, 270, 132, 'ASK NOTIONAL', usd(depth.askNotional), RED)}
  ${metricBox(690, 762, 270, 132, 'IMBALANCE', `${imb > 0 ? '+' : ''}${imb.toFixed(1)}%`, imb >= 0 ? GREEN : RED, imb >= 0 ? 'bids thicker' : 'asks thicker')}
  <text x="82" y="950" font-size="25" fill="${MUTED}" font-weight="800">盘口图看的是挂单厚度，不是涨跌幅复读。</text>
  <text x="82" y="990" font-size="26" fill="${MUTED}" font-weight="900">$${esc(lead.symbol || '--')}  $${esc(pack.trio?.peer?.symbol || '--')}  $${esc(pack.trio?.anchor?.symbol || '--')}</text>`;
  return svgBase(body);
}

function buildDerivativesSvg(pack) {
  const lead = pack.trio?.lead || {};
  const intel = pack.marketIntel?.symbols?.[lead.symbol] || {};
  const history = (intel.openInterestHistory || []).slice(-24);
  const x = 82, y = 308, w = 916, h = 290;
  const values = history.map(r => Number(r.sumOpenInterestValue || r.value)).filter(Number.isFinite);
  const { min, max } = minmax(values);
  const path = history.length ? linePath(history, r => yScale(Number(r.sumOpenInterestValue || r.value), min, max, y, h), x, y, w) : '';
  const oiChange = Number(intel.openInterestValueChange5m);
  const funding = Number(intel.fundingRate);
  const taker = Number(intel.takerBuySellRatio);
  const topLs = Number(intel.topLongShortPositionRatio);
  const globalLs = Number(intel.globalLongShortRatio);
  const bar = (label, value, yy, color) => {
    const vv = Number(value);
    const pctWidth = Number.isFinite(vv) ? clamp(Math.abs(vv - 1) * 280, 8, 340) : 8;
    const left = vv >= 1;
    return `<text x="82" y="${yy}" font-size="24" fill="${MUTED}" font-weight="800">${esc(label)}</text>
      <line x1="390" y1="${yy - 8}" x2="730" y2="${yy - 8}" stroke="${LINE}" stroke-width="18" stroke-linecap="round"/>
      <line x1="560" y1="${yy - 8}" x2="${left ? 560 + pctWidth : 560 - pctWidth}" y2="${yy - 8}" stroke="${color}" stroke-width="18" stroke-linecap="round"/>
      <text x="780" y="${yy}" font-size="30" fill="${color}" font-weight="900">${Number.isFinite(vv) ? vv.toFixed(2) : '--'}</text>`;
  };
  const body = `${header(pack, 'DERIVATIVES PRESSURE', `${lead.symbol}USDT · OI / funding / long-short evidence`)}
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="#0b0e11" stroke="${LINE}"/>
  <text x="${x + 24}" y="${y + 44}" font-size="23" fill="${MUTED}" font-weight="800">OPEN INTEREST VALUE</text>
  ${path ? `<path d="${path}" fill="none" stroke="${YELLOW}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` : `<text x="${x + 24}" y="${y + 160}" font-size="30" fill="${MUTED}">OI history unavailable</text>`}
  <text x="${x + 24}" y="${y + h - 26}" font-size="22" fill="${MUTED}" font-weight="700">${esc(values.length ? `${usd(min)} → ${usd(max)}` : 'no OI line')}</text>
  ${metricBox(82, 642, 270, 128, '5M OI', Number.isFinite(oiChange) ? pct(oiChange) : '--', Number.isFinite(oiChange) ? colorByPct(oiChange) : TEXT)}
  ${metricBox(386, 642, 270, 128, 'FUNDING', Number.isFinite(funding) ? pct(funding * 100, 4) : '--', Number.isFinite(funding) ? colorByPct(funding) : TEXT)}
  ${metricBox(690, 642, 270, 128, 'TAKER B/S', Number.isFinite(taker) ? taker.toFixed(2) : '--', Number.isFinite(taker) ? (taker >= 1 ? GREEN : RED) : TEXT)}
  ${bar('GLOBAL L/S', globalLs, 842, Number.isFinite(globalLs) && globalLs >= 1 ? GREEN : RED)}
  ${bar('TOP POSITION L/S', topLs, 914, Number.isFinite(topLs) && topLs >= 1 ? GREEN : RED)}
  <text x="82" y="992" font-size="26" fill="${MUTED}" font-weight="900">$${esc(lead.symbol || '--')}  $${esc(pack.trio?.peer?.symbol || '--')}  $${esc(pack.trio?.anchor?.symbol || '--')}</text>`;
  return svgBase(body);
}

function buildSvg(pack, postText = '', options = {}) {
  const type = options.type || chooseEvidenceType(pack);
  if (type === 'depth') return buildDepthSvg(pack);
  if (type === 'derivatives') return buildDerivativesSvg(pack);
  return buildKlineSvg(pack);
}

async function generateMarketCard(pack, postText = '', options = {}) {
  const dir = options.dir || path.join(DATA_DIR, 'generated-images');
  fs.mkdirSync(dir, { recursive: true });
  const lead = pack.trio?.lead?.symbol || 'MARKET';
  const type = options.type || chooseEvidenceType(pack);
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const file = path.join(dir, `${ts}-${lead}-${type}.png`);
  const svg = buildSvg(pack, postText, { type });
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(file);
  return file;
}

module.exports = { buildSvg, generateMarketCard, chooseEvidenceType, pct, price, usd };
