const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { DATA_DIR } = require('./config');

function esc(v = '') {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(v) {
  const n = num(v);
  if (n == null) return '--';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(Math.abs(n) >= 10 ? 1 : 2)}%`;
}

function price(v) {
  const n = num(v);
  if (n == null || n <= 0) return '--';
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 10) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(3)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toPrecision(4)}`;
}

function usd(v) {
  const n = num(v);
  if (n == null) return '--';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function colorByPct(v) {
  const n = num(v) || 0;
  if (n > 0) return '#16c784';
  if (n < 0) return '#ea3943';
  return '#cfd6e4';
}

function wrapText(input = '', maxUnits = 44, maxLines = 2) {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const lines = [];
  let current = '';
  let units = 0;
  const unitOf = ch => (/[\x00-\x7F]/.test(ch) ? 0.58 : 1);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const u = unitOf(ch);
    if (units + u > maxUnits && current) {
      lines.push(current.trim());
      current = ch;
      units = u;
      if (lines.length >= maxLines) break;
    } else {
      current += ch;
      units += u;
    }
  }
  if (lines.length < maxLines && current.trim()) lines.push(current.trim());
  if (lines.length === maxLines && lines.join('').length < text.length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[，。；、,. ]*$/, '') + '…';
  }
  return lines;
}

function tspans(lines, x, y, size, lineHeight, fill, weight = 700) {
  return lines.map((line, i) => (
    `<text x="${x}" y="${y + i * lineHeight}" font-size="${size}" fill="${fill}" font-weight="${weight}">${esc(line)}</text>`
  )).join('\n');
}

function miniMetric(asset, x, y, label) {
  const c = colorByPct(asset?.change24h);
  return `
    <g transform="translate(${x} ${y})">
      <text x="0" y="0" font-size="24" fill="#848e9c" font-weight="700">${esc(label)}</text>
      <text x="0" y="48" font-size="46" fill="#f5f5f5" font-weight="900">$${esc(asset?.symbol || '--')}</text>
      <text x="0" y="90" font-size="26" fill="${c}" font-weight="900">${esc(pct(asset?.change24h))}</text>
      <text x="120" y="90" font-size="24" fill="#848e9c">${esc(price(asset?.price))}</text>
    </g>`;
}

function keyLevel(pack) {
  const tp = pack.tradePlan || {};
  if (tp.trigger) return String(tp.trigger).split('/')[0].trim();
  if (tp.entry) return String(tp.entry).split('-')[0].trim();
  return price(pack.trio?.lead?.price);
}

function buildSvg(pack, postText = '') {
  const lead = pack.trio?.lead || {};
  const peer = pack.trio?.peer || {};
  const anchor = pack.trio?.anchor || {};
  const generatedAt = new Date(pack.generatedAt || Date.now());
  const time = generatedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const noteLines = wrapText(postText || `$${lead.symbol} / $${peer.symbol} / $${anchor.symbol}`, 34, 3);
  const leadColor = colorByPct(lead.change24h);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <style>
    text { font-family: "Noto Sans CJK SC", "Noto Sans CJK", "DejaVu Sans", Arial, sans-serif; }
  </style>
  <rect width="1080" height="1080" fill="#0b0e11"/>
  <rect x="56" y="56" width="968" height="968" rx="38" fill="#151a22" stroke="#2b3139" stroke-width="2"/>
  <rect x="56" y="56" width="968" height="10" fill="#f0b90b"/>

  <text x="92" y="126" font-size="26" fill="#f0b90b" font-weight="900">BINANCE SQUARE</text>
  <text x="760" y="126" font-size="22" fill="#848e9c" font-weight="700">${esc(time)}</text>

  <text x="92" y="258" font-size="104" fill="#f5f5f5" font-weight="900">$${esc(lead.symbol || '--')}</text>
  <text x="92" y="314" font-size="30" fill="#848e9c" font-weight="800">KEY AREA</text>
  <text x="270" y="316" font-size="38" fill="#f0b90b" font-weight="900">${esc(keyLevel(pack))}</text>

  <g transform="translate(92 380)">
    <rect width="410" height="128" rx="24" fill="#0b0e11" stroke="#2b3139"/>
    <text x="28" y="44" font-size="24" fill="#848e9c" font-weight="800">24H</text>
    <text x="28" y="98" font-size="52" fill="${leadColor}" font-weight="900">${esc(pct(lead.change24h))}</text>
  </g>
  <g transform="translate(550 380)">
    <rect width="410" height="128" rx="24" fill="#0b0e11" stroke="#2b3139"/>
    <text x="28" y="44" font-size="24" fill="#848e9c" font-weight="800">VOLUME</text>
    <text x="28" y="98" font-size="48" fill="#f5f5f5" font-weight="900">${esc(usd(lead.volume24h))}</text>
  </g>

  <line x1="92" y1="566" x2="988" y2="566" stroke="#2b3139" stroke-width="2"/>
  ${miniMetric(peer, 92, 636, 'PEER')}
  ${miniMetric(anchor, 560, 636, 'ANCHOR')}

  <rect x="92" y="780" width="896" height="152" rx="24" fill="#0b0e11" stroke="#2b3139"/>
  <text x="124" y="830" font-size="24" fill="#848e9c" font-weight="800">MARKET NOTE</text>
  ${tspans(noteLines, 124, 874, 28, 36, '#f5f5f5', 700)}

  <text x="92" y="982" font-size="26" fill="#848e9c" font-weight="800">$${esc(lead.symbol || '--')}  $${esc(peer.symbol || '--')}  $${esc(anchor.symbol || '--')}</text>
  <text x="770" y="982" font-size="22" fill="#58606d" font-weight="700">market snapshot</text>
</svg>`;
}

async function generateMarketCard(pack, postText = '', options = {}) {
  const dir = options.dir || path.join(DATA_DIR, 'generated-images');
  fs.mkdirSync(dir, { recursive: true });
  const lead = pack.trio?.lead?.symbol || 'MARKET';
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const file = path.join(dir, `${ts}-${lead}.png`);
  const svg = buildSvg(pack, postText);
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(file);
  return file;
}

module.exports = { buildSvg, generateMarketCard, pct, price, usd };
