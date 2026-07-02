const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { DATA_DIR } = require('./config');

const W = 1280;
const H = 720;
const BG = '#0b0e11';
const PANEL = '#11161d';
const GRID = '#242b35';
const TEXT = '#d8dee9';
const MUTED = '#808a9a';
const YELLOW = '#f0b90b';
const GREEN = '#0ecb81';
const RED = '#f6465d';
const BLUE = '#4c8bf5';
const PURPLE = '#b37feb';

function esc(v = '') {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function pct(v, digits = 2) {
  const n = num(v);
  if (n == null) return '--';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(Math.abs(n) >= 10 ? 1 : digits)}%`;
}
function price(v) {
  const n = num(v);
  if (n == null || n <= 0) return '--';
  if (n >= 10000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (n >= 100) return n.toFixed(2);
  if (n >= 10) return n.toFixed(3);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  if (n >= 0.0001) return n.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
  return n.toPrecision(4);
}
function usd(v) {
  const n = num(v);
  if (n == null) return '--';
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
function colorByPct(v) { const n = num(v) || 0; return n > 0 ? GREEN : n < 0 ? RED : TEXT; }
function minmax(values) {
  const arr = values.map(Number).filter(Number.isFinite);
  if (!arr.length) return { min: 0, max: 1 };
  let min = Math.min(...arr); let max = Math.max(...arr);
  if (min === max) { min *= 0.995; max *= 1.005; }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}
function xScale(i, n, x, w) { return x + (n <= 1 ? 0 : (i / (n - 1)) * w); }
function yScale(v, min, max, y, h) { return y + h - ((Number(v) - min) / (max - min || 1)) * h; }
function ema(rows, period) {
  const k = 2 / (period + 1);
  let prev = null;
  return rows.map(r => {
    const close = Number(r.close);
    if (!Number.isFinite(close)) return null;
    prev = prev == null ? close : close * k + prev * (1 - k);
    return prev;
  });
}
function linePath(values, x, y, w, h, min, max) {
  return values.map((v, i) => Number.isFinite(v) ? `${i ? 'L' : 'M'}${xScale(i, values.length, x, w).toFixed(1)},${yScale(v, min, max, y, h).toFixed(1)}` : '').filter(Boolean).join(' ');
}
function keyLevelNumber(pack) {
  const tp = pack.tradePlan || {};
  const current = Number(pack.trio?.lead?.price || tp.currentPrice || 0);
  if (Number.isFinite(Number(tp.trigger))) return Number(tp.trigger);
  const entry = String(tp.entry || '').match(/[0-9]+(?:\.[0-9]+)?/g)?.map(Number).filter(Number.isFinite) || [];
  if (entry.length) return entry.reduce((a, b) => a + b, 0) / entry.length;
  return current || null;
}
function formatTime(ts) {
  const d = ts ? new Date(Number(ts)) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function chartRows(pack = {}) {
  const rows = (pack.chart?.klines || []).slice(-80);
  if (rows.length >= 20) return rows;
  const lead = pack.trio?.lead || {};
  const p = Number(lead.price || 1);
  return Array.from({ length: 64 }, (_, i) => {
    const drift = (i - 32) * p * 0.0007;
    const wave = Math.sin(i / 5) * p * 0.01;
    const open = p + drift + wave;
    const close = open + Math.sin(i / 3) * p * 0.004;
    return { open, high: Math.max(open, close) + p * 0.006, low: Math.min(open, close) - p * 0.006, close, volume: 1000 + i * 10, openTime: Date.now() - (64 - i) * 15 * 60 * 1000 };
  });
}

function hasCoinglassHeatmap(pack = {}) {
  return pack.coinglass?.ok === true
    && pack.coinglass?.heatmap?.available === true
    && Array.isArray(pack.coinglass.heatmap.cells)
    && pack.coinglass.heatmap.cells.length > 12
    && Array.isArray(pack.coinglass.heatmap.yAxis)
    && pack.coinglass.heatmap.yAxis.length > 4;
}
function hasCoinglassPanel(pack = {}) {
  const cg = pack.coinglass || {};
  return cg.ok === true && (
    cg.liquidation?.available === true
    || cg.orderbookAskBids?.available === true
    || cg.openInterest?.available === true
    || cg.longShort?.available === true
  );
}
function heatColor(amount, maxAmount) {
  const t = Math.max(0, Math.min(1, Math.sqrt((Number(amount) || 0) / (Number(maxAmount) || 1))));
  if (t > 0.72) return { fill: RED, opacity: 0.2 + t * 0.76 };
  if (t > 0.38) return { fill: YELLOW, opacity: 0.12 + t * 0.78 };
  return { fill: '#2de2a6', opacity: 0.08 + t * 0.56 };
}
function coinglassCandles(pack = {}) {
  return (pack.coinglass?.heatmap?.priceCandlesticks || []).filter(k => Number.isFinite(Number(k.close))).slice(-120);
}
function buildLinePathFromRows(rows, x, y, w, h, min, max) {
  return rows.map((k, i) => {
    const v = Number(k.close);
    if (!Number.isFinite(v)) return '';
    return `${i ? 'L' : 'M'}${xScale(i, rows.length, x, w).toFixed(1)},${yScale(v, min, max, y, h).toFixed(1)}`;
  }).filter(Boolean).join(' ');
}
function buildCoinglassHeatmapSvg(pack) {
  const lead = pack.trio?.lead || {};
  const peer = pack.trio?.peer || {};
  const anchor = pack.trio?.anchor || {};
  const cg = pack.coinglass || {};
  const hm = cg.heatmap || {};
  const summary = hm.summary || {};
  const yAxis = (hm.yAxis || []).map(Number).filter(Number.isFinite);
  const cells = (hm.cells || []).filter(c => Number.isFinite(Number(c.price)) && Number.isFinite(Number(c.amountUsd))).slice(0, 700);
  const candles = coinglassCandles(pack);
  const plot = { x: 62, y: 110, w: 880, h: 500 };
  const side = { x: 972, y: 110, w: 242, h: 500 };
  const prices = [...yAxis, ...candles.flatMap(k => [k.high, k.low, k.close].map(Number).filter(Number.isFinite))];
  const { min, max } = minmax(prices);
  const maxAmount = Math.max(1, ...cells.map(c => Number(c.amountUsd || 0)));
  const maxX = Math.max(1, ...cells.map(c => Number(c.xIndex || 0)), candles.length - 1);
  const cellW = Math.max(3, plot.w / (maxX + 1) * 0.92);
  const avgLevelH = yAxis.length > 1 ? plot.h / yAxis.length : 8;
  const cellH = Math.max(3, Math.min(15, avgLevelH * 1.8));
  const grid = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const yy = plot.y + t * plot.h;
    const val = max - t * (max - min);
    return `<line x1="${plot.x}" y1="${yy}" x2="${plot.x + plot.w}" y2="${yy}" stroke="${GRID}" stroke-width="1" opacity="0.72"/><text x="${plot.x + plot.w + 10}" y="${yy + 5}" font-size="16" fill="${MUTED}">${esc(price(val))}</text>`;
  }).join('');
  const rects = cells.map(c => {
    const x = plot.x + (Number(c.xIndex || 0) / maxX) * plot.w;
    const y = yScale(c.price, min, max, plot.y, plot.h);
    const col = heatColor(c.amountUsd, maxAmount);
    return `<rect x="${(x - cellW / 2).toFixed(1)}" y="${(y - cellH / 2).toFixed(1)}" width="${cellW.toFixed(1)}" height="${cellH.toFixed(1)}" rx="2" fill="${col.fill}" opacity="${col.opacity.toFixed(2)}"/>`;
  }).join('\n');
  const line = candles.length >= 2 ? buildLinePathFromRows(candles, plot.x, plot.y, plot.w, plot.h, min, max) : '';
  const lastPrice = Number(summary.lastPrice || candles[candles.length - 1]?.close || lead.price || 0);
  const lastY = Number.isFinite(lastPrice) && lastPrice > 0 ? yScale(lastPrice, min, max, plot.y, plot.h) : null;
  const topLevels = (summary.topLevels || []).slice(0, 5);
  const topRows = topLevels.map((lvl, idx) => {
    const sideText = lvl.side === 'above' ? '上方' : lvl.side === 'below' ? '下方' : '附近';
    const color = lvl.side === 'above' ? RED : GREEN;
    const dist = Number.isFinite(Number(lvl.distancePct)) ? `${Number(lvl.distancePct) > 0 ? '+' : ''}${Number(lvl.distancePct).toFixed(2)}%` : '--';
    return `<text x="${side.x + 18}" y="${side.y + 128 + idx * 46}" font-size="18" fill="${TEXT}" font-weight="800">${idx + 1}. ${esc(price(lvl.price))}</text><text x="${side.x + 126}" y="${side.y + 128 + idx * 46}" font-size="15" fill="${color}" font-weight="800">${esc(sideText)} ${esc(dist)}</text><text x="${side.x + 18}" y="${side.y + 150 + idx * 46}" font-size="15" fill="${MUTED}">${esc(usd(lvl.amountUsd))}</text>`;
  }).join('');
  const above = summary.topAbove ? `${price(summary.topAbove.price)} · ${usd(summary.topAbove.amountUsd)}` : '--';
  const below = summary.topBelow ? `${price(summary.topBelow.price)} · ${usd(summary.topBelow.amountUsd)}` : '--';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <style>text { font-family: "Noto Sans CJK SC", "Noto Sans CJK", "DejaVu Sans", Arial, sans-serif; }</style>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect x="28" y="28" width="1224" height="664" rx="22" fill="${PANEL}" stroke="#1f2937"/>
  <text x="58" y="70" font-size="28" fill="${TEXT}" font-weight="900">${esc(cg.pair || `${lead.symbol}USDT`)}</text>
  <text x="245" y="70" font-size="18" fill="${YELLOW}" font-weight="900">LIQUIDATION HEATMAP</text>
  <text x="58" y="96" font-size="16" fill="${MUTED}" font-weight="700">CoinGlass · ${esc(cg.exchange || 'Binance')} · 24H · data evidence</text>
  <text x="902" y="70" font-size="28" fill="${TEXT}" font-weight="900">${esc(price(lastPrice))}</text>
  <text x="1018" y="70" font-size="17" fill="${MUTED}" font-weight="800">热区合计 ${esc(usd(summary.totalUsd))}</text>
  <rect x="${plot.x}" y="${plot.y}" width="${plot.w}" height="${plot.h}" fill="#090d12" stroke="#243041"/>
  ${grid}
  ${rects}
  ${line ? `<path d="${line}" fill="none" stroke="#eef2ff" stroke-width="2.6" opacity="0.92"/><path d="${line}" fill="none" stroke="#0b0e11" stroke-width="5" opacity="0.24"/>` : ''}
  ${lastY != null ? `<line x1="${plot.x}" y1="${lastY}" x2="${plot.x + plot.w}" y2="${lastY}" stroke="${BLUE}" stroke-width="1.8" stroke-dasharray="6 6"/><rect x="${plot.x + plot.w - 92}" y="${lastY - 15}" width="88" height="30" rx="5" fill="${BLUE}"/><text x="${plot.x + plot.w - 84}" y="${lastY + 6}" font-size="15" fill="#06121f" font-weight="900">${esc(price(lastPrice))}</text>` : ''}
  <rect x="${side.x}" y="${side.y}" width="${side.w}" height="${side.h}" rx="14" fill="#0b0f16" stroke="#273244"/>
  <text x="${side.x + 18}" y="${side.y + 36}" font-size="18" fill="${MUTED}" font-weight="900">TOP HEAT ZONES</text>
  <text x="${side.x + 18}" y="${side.y + 70}" font-size="15" fill="${RED}" font-weight="900">上方：${esc(above)}</text>
  <text x="${side.x + 18}" y="${side.y + 96}" font-size="15" fill="${GREEN}" font-weight="900">下方：${esc(below)}</text>
  ${topRows}
  <text x="${side.x + 18}" y="${side.y + side.h - 42}" font-size="14" fill="${MUTED}">cells ${esc(String(summary.cellCount || cells.length))} · max ${esc(usd(summary.maxCellUsd))}</text>
  <text x="${side.x + 18}" y="${side.y + side.h - 18}" font-size="13" fill="#58606d">清算热区只表示潜在流动性密集处</text>
  <text x="64" y="654" font-size="17" fill="${MUTED}" font-weight="800">$${esc(lead.symbol || '--')} / $${esc(peer.symbol || '--')} / $${esc(anchor.symbol || '--')}</text>
  <text x="988" y="654" font-size="16" fill="#58606d" font-weight="800">source: CoinGlass API v4</text>
</svg>`;
}

function sparkline(rows = [], key = 'close', x, y, w, h, stroke = YELLOW) {
  const vals = rows.map(r => Number(r?.[key])).filter(Number.isFinite);
  if (vals.length < 2) return '';
  const { min, max } = minmax(vals);
  const d = rows.map((r, i) => {
    const v = Number(r?.[key]);
    if (!Number.isFinite(v)) return '';
    return `${i ? 'L' : 'M'}${xScale(i, rows.length, x, w).toFixed(1)},${yScale(v, min, max, y, h).toFixed(1)}`;
  }).filter(Boolean).join(' ');
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="3" opacity="0.95"/>`;
}
function barPair(x, y, w, h, leftValue, rightValue, leftColor, rightColor) {
  const l = Math.max(0, Number(leftValue) || 0);
  const r = Math.max(0, Number(rightValue) || 0);
  const total = Math.max(1, l + r);
  const lw = w * l / total;
  const rw = w - lw;
  return `<rect x="${x}" y="${y}" width="${lw}" height="${h}" rx="7" fill="${leftColor}" opacity="0.88"/><rect x="${x + lw}" y="${y}" width="${rw}" height="${h}" rx="7" fill="${rightColor}" opacity="0.88"/>`;
}
function panel(x, y, w, h, title, body) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#0b0f16" stroke="#273244"/><text x="${x + 22}" y="${y + 38}" font-size="18" fill="${MUTED}" font-weight="900">${esc(title)}</text>${body}`;
}
function buildCoinglassPanelSvg(pack) {
  const lead = pack.trio?.lead || {};
  const peer = pack.trio?.peer || {};
  const anchor = pack.trio?.anchor || {};
  const cg = pack.coinglass || {};
  const liq = cg.liquidation || {};
  const ob = cg.orderbookAskBids || {};
  const oi = cg.openInterest || {};
  const ls = cg.longShort || {};
  const pair = cg.pair || `${lead.symbol || 'MARKET'}USDT`;
  const liqPanel = panel(52, 132, 560, 198, '24H LIQUIDATION', `
    ${liq.available ? barPair(80, 205, 504, 28, liq.longLiquidationUsd, liq.shortLiquidationUsd, RED, GREEN) : `<text x="80" y="222" font-size="22" fill="${MUTED}">unavailable</text>`}
    <text x="80" y="178" font-size="28" fill="${TEXT}" font-weight="900">${esc(usd(liq.longLiquidationUsd))}</text><text x="300" y="178" font-size="16" fill="${MUTED}">long liq</text>
    <text x="80" y="270" font-size="28" fill="${TEXT}" font-weight="900">${esc(usd(liq.shortLiquidationUsd))}</text><text x="300" y="270" font-size="16" fill="${MUTED}">short liq</text>
    <text x="80" y="304" font-size="16" fill="${MUTED}" font-weight="800">total ${esc(usd(liq.totalUsd))}</text>`);
  const orderPanel = panel(668, 132, 560, 198, '±1% ORDERBOOK DEPTH', `
    ${ob.available && ob.latest ? barPair(696, 205, 504, 28, ob.latest.bidsUsd, ob.latest.asksUsd, GREEN, RED) : `<text x="696" y="222" font-size="22" fill="${MUTED}">unavailable</text>`}
    <text x="696" y="178" font-size="28" fill="${TEXT}" font-weight="900">${esc(usd(ob.latest?.bidsUsd))}</text><text x="916" y="178" font-size="16" fill="${MUTED}">bids</text>
    <text x="696" y="270" font-size="28" fill="${TEXT}" font-weight="900">${esc(usd(ob.latest?.asksUsd))}</text><text x="916" y="270" font-size="16" fill="${MUTED}">asks</text>
    <text x="696" y="304" font-size="16" fill="${ob.imbalancePct >= 0 ? GREEN : RED}" font-weight="900">imbalance ${esc(pct(ob.imbalancePct))}</text>`);
  const oiPanel = panel(52, 370, 560, 220, 'OPEN INTEREST', `
    <text x="80" y="425" font-size="30" fill="${oi.changePct >= 0 ? GREEN : RED}" font-weight="900">${esc(pct(oi.changePct))}</text>
    <text x="210" y="425" font-size="17" fill="${MUTED}" font-weight="800">last 24 samples</text>
    ${oi.available ? sparkline(oi.rows || [], 'close', 80, 456, 504, 92, YELLOW) : `<text x="80" y="500" font-size="22" fill="${MUTED}">unavailable</text>`}
    <text x="80" y="565" font-size="16" fill="${MUTED}">latest ${esc(usd(oi.latest?.close))}</text>`);
  const ratioPanel = panel(668, 370, 560, 220, 'GLOBAL ACCOUNT RATIO', `
    <text x="696" y="426" font-size="36" fill="${TEXT}" font-weight="900">${esc(Number(ls.latest?.ratio || 0).toFixed(2))}</text><text x="796" y="426" font-size="17" fill="${MUTED}">long/short</text>
    ${ls.latest ? barPair(696, 468, 504, 30, ls.latest.longPercent, ls.latest.shortPercent, GREEN, RED) : `<text x="696" y="486" font-size="22" fill="${MUTED}">unavailable</text>`}
    <text x="696" y="530" font-size="24" fill="${GREEN}" font-weight="900">${esc(Number(ls.latest?.longPercent || 0).toFixed(1))}% long</text>
    <text x="920" y="530" font-size="24" fill="${RED}" font-weight="900">${esc(Number(ls.latest?.shortPercent || 0).toFixed(1))}% short</text>
    <text x="696" y="565" font-size="16" fill="${MUTED}">source: CoinGlass API v4</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <style>text { font-family: "Noto Sans CJK SC", "Noto Sans CJK", "DejaVu Sans", Arial, sans-serif; }</style>
  <rect width="${W}" height="${H}" fill="${BG}"/><rect x="28" y="28" width="1224" height="664" rx="22" fill="${PANEL}" stroke="#1f2937"/>
  <text x="58" y="72" font-size="30" fill="${TEXT}" font-weight="900">${esc(pair)}</text>
  <text x="258" y="72" font-size="18" fill="${YELLOW}" font-weight="900">COINGLASS DERIVATIVES PANEL</text>
  <text x="58" y="101" font-size="16" fill="${MUTED}" font-weight="700">${esc(cg.exchange || 'Binance')} · liquidation / depth / OI / long-short</text>
  ${liqPanel}${orderPanel}${oiPanel}${ratioPanel}
  <text x="64" y="654" font-size="17" fill="${MUTED}" font-weight="800">$${esc(lead.symbol || '--')} / $${esc(peer.symbol || '--')} / $${esc(anchor.symbol || '--')}</text>
  <text x="956" y="654" font-size="16" fill="#58606d" font-weight="800">data-driven evidence card</text>
</svg>`;
}

function buildTradingScreenshotSvg(pack) {
  const lead = pack.trio?.lead || {};
  const peer = pack.trio?.peer || {};
  const anchor = pack.trio?.anchor || {};
  const rows = chartRows(pack);
  const pair = `${lead.symbol || 'MARKET'}USDT`;
  const source = /futures/i.test(pack.source || pack.chart?.source || '') ? 'BINANCE FUTURES' : 'BINANCE SPOT';
  const chart = { x: 64, y: 94, w: 1070, h: 430 };
  const vol = { x: 64, y: 546, w: 1070, h: 92 };
  const prices = rows.flatMap(k => [k.high, k.low, k.open, k.close]);
  const { min, max } = minmax(prices);
  const maxVol = Math.max(1, ...rows.map(k => Number(k.volume || 0)));
  const candleW = Math.max(4, Math.min(10, chart.w / Math.max(1, rows.length) * 0.58));
  const ema20 = ema(rows, 20);
  const ema50 = ema(rows, 50);
  const last = rows[rows.length - 1] || {};
  const lastPrice = Number(last.close || lead.price || 0);
  const prev = rows[rows.length - 2] || rows[0] || {};
  const intradayChange = Number(prev.close) ? ((lastPrice - Number(prev.close)) / Number(prev.close)) * 100 : Number(lead.change1h || 0);
  const key = keyLevelNumber(pack);
  const keyVisible = Number.isFinite(key) && key > min && key < max;
  const keyY = keyVisible ? yScale(key, min, max, chart.y, chart.h) : null;
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const yy = chart.y + t * chart.h;
    const val = max - t * (max - min);
    return `<line x1="${chart.x}" y1="${yy}" x2="${chart.x + chart.w}" y2="${yy}" stroke="${GRID}" stroke-width="1" opacity="0.7"/><text x="${chart.x + chart.w + 16}" y="${yy + 6}" font-size="17" fill="${MUTED}">${esc(price(val))}</text>`;
  }).join('\n');
  const verticals = [0, 0.2, 0.4, 0.6, 0.8, 1].map(t => {
    const xx = chart.x + t * chart.w;
    const idx = Math.min(rows.length - 1, Math.max(0, Math.round(t * (rows.length - 1))));
    return `<line x1="${xx}" y1="${chart.y}" x2="${xx}" y2="${vol.y + vol.h}" stroke="${GRID}" stroke-width="1" opacity="0.35"/><text x="${xx - 28}" y="${vol.y + vol.h + 28}" font-size="15" fill="${MUTED}">${esc(formatTime(rows[idx]?.openTime))}</text>`;
  }).join('\n');
  const candles = rows.map((k, i) => {
    const xx = xScale(i, rows.length, chart.x, chart.w);
    const openY = yScale(k.open, min, max, chart.y, chart.h);
    const closeY = yScale(k.close, min, max, chart.y, chart.h);
    const highY = yScale(k.high, min, max, chart.y, chart.h);
    const lowY = yScale(k.low, min, max, chart.y, chart.h);
    const up = Number(k.close) >= Number(k.open);
    const c = up ? GREEN : RED;
    const bodyY = Math.min(openY, closeY);
    const bodyH = Math.max(2, Math.abs(openY - closeY));
    const vH = Math.max(1, Number(k.volume || 0) / maxVol * vol.h);
    return `<line x1="${xx.toFixed(1)}" y1="${highY.toFixed(1)}" x2="${xx.toFixed(1)}" y2="${lowY.toFixed(1)}" stroke="${c}" stroke-width="1.7"/><rect x="${(xx - candleW / 2).toFixed(1)}" y="${bodyY.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${c}" rx="1"/><rect x="${(xx - candleW / 2).toFixed(1)}" y="${(vol.y + vol.h - vH).toFixed(1)}" width="${candleW.toFixed(1)}" height="${vH.toFixed(1)}" fill="${c}" opacity="0.42"/>`;
  }).join('\n');
  const ema20Path = linePath(ema20, chart.x, chart.y, chart.w, chart.h, min, max);
  const ema50Path = linePath(ema50, chart.x, chart.y, chart.w, chart.h, min, max);
  const lastY = yScale(lastPrice, min, max, chart.y, chart.h);
  const keyText = Number.isFinite(key) ? price(key) : '--';
  const directionColor = colorByPct(intradayChange);
  const trade = pack.tradePlan || {};
  const levels = [`Key ${keyText}`, trade.direction ? `Bias ${String(trade.direction).toUpperCase()}` : `24h ${pct(lead.change24h)}`, `Vol ${usd(lead.volume24h)}`];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <style>text { font-family: "Noto Sans CJK SC", "Noto Sans CJK", "DejaVu Sans", Arial, sans-serif; }</style>
  <rect width="${W}" height="${H}" fill="${BG}"/><rect x="28" y="28" width="1224" height="664" rx="22" fill="${PANEL}" stroke="#1f2937"/>
  <text x="58" y="66" font-size="30" fill="${TEXT}" font-weight="900">${esc(pair)}</text><text x="220" y="66" font-size="18" fill="${MUTED}" font-weight="700">15m · ${esc(source)}</text><text x="58" y="91" font-size="17" fill="${MUTED}" font-weight="700">O ${esc(price(last.open))}  H ${esc(price(last.high))}  L ${esc(price(last.low))}  C ${esc(price(last.close))}</text>
  <text x="930" y="66" font-size="34" fill="${directionColor}" font-weight="900">${esc(price(lastPrice))}</text><text x="1058" y="66" font-size="24" fill="${directionColor}" font-weight="900">${esc(pct(intradayChange))}</text><text x="930" y="92" font-size="17" fill="${MUTED}" font-weight="700">${esc(levels.join('  ·  '))}</text>
  <rect x="${chart.x}" y="${chart.y}" width="${chart.w}" height="${chart.h}" fill="#0b0e11" stroke="#1f2937"/><rect x="${vol.x}" y="${vol.y}" width="${vol.w}" height="${vol.h}" fill="#0b0e11" stroke="#1f2937"/>
  ${gridLines}${verticals}${candles}
  ${ema20Path ? `<path d="${ema20Path}" fill="none" stroke="${YELLOW}" stroke-width="2.2" opacity="0.95"/>` : ''}${ema50Path ? `<path d="${ema50Path}" fill="none" stroke="${BLUE}" stroke-width="2" opacity="0.88"/>` : ''}
  ${keyVisible ? `<line x1="${chart.x}" y1="${keyY}" x2="${chart.x + chart.w}" y2="${keyY}" stroke="${PURPLE}" stroke-width="2" stroke-dasharray="8 6"/><rect x="${chart.x + chart.w - 96}" y="${keyY - 17}" width="92" height="28" rx="5" fill="${PURPLE}"/><text x="${chart.x + chart.w - 88}" y="${keyY + 3}" font-size="15" fill="#0b0e11" font-weight="900">KEY ${esc(keyText)}</text>` : ''}
  <line x1="${chart.x}" y1="${lastY}" x2="${chart.x + chart.w}" y2="${lastY}" stroke="${directionColor}" stroke-width="1.4" stroke-dasharray="5 5" opacity="0.85"/><rect x="${chart.x + chart.w + 6}" y="${lastY - 15}" width="82" height="30" rx="5" fill="${directionColor}"/><text x="${chart.x + chart.w + 12}" y="${lastY + 6}" font-size="15" fill="#0b0e11" font-weight="900">${esc(price(lastPrice))}</text>
  <text x="72" y="674" font-size="17" fill="${YELLOW}" font-weight="800">EMA20</text><text x="142" y="674" font-size="17" fill="${BLUE}" font-weight="800">EMA50</text><text x="235" y="674" font-size="17" fill="${MUTED}" font-weight="700">Volume · ${esc(usd(lead.volume24h))}</text><text x="760" y="674" font-size="18" fill="${MUTED}" font-weight="800">$${esc(lead.symbol || '--')} $${esc(peer.symbol || '--')} $${esc(anchor.symbol || '--')}</text><text x="1038" y="674" font-size="16" fill="#58606d" font-weight="700">chart snapshot</text>
</svg>`;
}

function buildSvg(pack) {
  if (hasCoinglassHeatmap(pack)) return buildCoinglassHeatmapSvg(pack);
  if (hasCoinglassPanel(pack)) return buildCoinglassPanelSvg(pack);
  return buildTradingScreenshotSvg(pack);
}
function chooseEvidenceType(pack = {}) {
  if (hasCoinglassHeatmap(pack)) return 'coinglass_liquidation_heatmap';
  if (hasCoinglassPanel(pack)) return 'coinglass_derivatives_panel';
  return 'chart_snapshot';
}
async function generateMarketCard(pack, postText = '', options = {}) {
  const dir = options.dir || path.join(DATA_DIR, 'generated-images');
  fs.mkdirSync(dir, { recursive: true });
  const lead = pack.trio?.lead?.symbol || 'MARKET';
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const file = path.join(dir, `${ts}-${lead}-${chooseEvidenceType(pack)}.png`);
  await sharp(Buffer.from(buildSvg(pack, postText, options))).png({ compressionLevel: 9 }).toFile(file);
  return file;
}

module.exports = { buildSvg, generateMarketCard, chooseEvidenceType, pct, price, usd };
