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
  <text x="72" y="674" font-size="17" fill="${YELLOW}" font-weight="800">EMA20</text><text x="142" y="674" font-size="17" fill="${BLUE}" font-weight="800">EMA50</text><text x="235" y="674" font-size="17" fill="${MUTED}" font-weight="700">Volume · ${esc(usd(lead.volume24h))}</text><text x="760" y="674" font-size="18" fill="${MUTED}" font-weight="800">$${esc(lead.symbol || '--')} $${esc(peer.symbol || '--')} $${esc(anchor.symbol || '--')}</text><text x="1038" y="674" font-size="16" fill="#58606d" font-weight="700">auto snapshot</text>
</svg>`;
}

function buildSvg(pack) { return buildTradingScreenshotSvg(pack); }
function chooseEvidenceType() { return 'chart_snapshot'; }
async function generateMarketCard(pack, postText = '', options = {}) {
  const dir = options.dir || path.join(DATA_DIR, 'generated-images');
  fs.mkdirSync(dir, { recursive: true });
  const lead = pack.trio?.lead?.symbol || 'MARKET';
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const file = path.join(dir, `${ts}-${lead}-chart.png`);
  await sharp(Buffer.from(buildSvg(pack, postText, options))).png({ compressionLevel: 9 }).toFile(file);
  return file;
}

module.exports = { buildSvg, generateMarketCard, chooseEvidenceType, pct, price, usd };
