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

function symbolCard(asset, x, y, w, h, label) {
  const c = colorByPct(asset?.change24h);
  return `
    <g transform="translate(${x} ${y})">
      <rect width="${w}" height="${h}" rx="28" fill="#111827" stroke="#263142" stroke-width="2"/>
      <text x="28" y="40" font-size="22" fill="#8792a2" font-weight="700">${esc(label)}</text>
      <text x="28" y="88" font-size="44" fill="#f5f7fb" font-weight="900">$${esc(asset?.symbol || '--')}</text>
      <text x="28" y="128" font-size="22" fill="#8792a2">PRICE</text>
      <text x="112" y="128" font-size="27" fill="#f5f7fb" font-weight="800">${esc(price(asset?.price))}</text>
      <text x="${w - 168}" y="128" font-size="22" fill="#8792a2">24H</text>
      <text x="${w - 98}" y="128" font-size="27" fill="${c}" font-weight="900">${esc(pct(asset?.change24h))}</text>
    </g>`;
}

function bars(pack) {
  const items = [pack.trio?.lead, pack.trio?.peer, pack.trio?.anchor].filter(Boolean);
  const maxAbs = Math.max(1, ...items.map(x => Math.abs(num(x.change24h) || 0)));
  return items.map((a, i) => {
    const n = num(a.change24h) || 0;
    const width = Math.max(8, Math.min(520, Math.abs(n) / maxAbs * 520));
    const x = 280;
    const y = 690 + i * 66;
    const fill = colorByPct(n);
    return `
      <text x="78" y="${y + 31}" font-size="32" fill="#f5f7fb" font-weight="900">$${esc(a.symbol)}</text>
      <rect x="${x}" y="${y}" width="540" height="34" rx="17" fill="#151d29"/>
      <rect x="${x}" y="${y}" width="${width}" height="34" rx="17" fill="${fill}" opacity="0.92"/>
      <text x="850" y="${y + 29}" font-size="30" fill="${fill}" font-weight="900">${esc(pct(n))}</text>`;
  }).join('\n');
}

function keyLevel(pack) {
  const tp = pack.tradePlan || {};
  if (tp.direction === 'long' && tp.trigger) return String(tp.trigger);
  if (tp.direction === 'short' && tp.entry) return String(tp.entry);
  if (tp.trigger) return String(tp.trigger).split('/')[0].trim();
  return price(pack.trio?.lead?.price);
}

function buildSvg(pack, postText = '') {
  const lead = pack.trio?.lead || {};
  const peer = pack.trio?.peer || {};
  const anchor = pack.trio?.anchor || {};
  const generatedAt = new Date(pack.generatedAt || Date.now());
  const time = generatedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const heat = Math.min(100, Math.round(Math.abs(num(lead.change24h) || 0) * 2.5 + Math.abs(num(lead.change1h) || 0) * 8 + Math.min(30, (num(lead.amplitude24h) || 0))));
  const hot = heat >= 70 ? 'HOT' : heat >= 40 ? 'WATCH' : 'WAIT';
  const noteLines = wrapText(postText || `$${lead.symbol} / $${peer.symbol} / $${anchor.symbol}`, 32, 2);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1020"/>
      <stop offset="0.55" stop-color="#111827"/>
      <stop offset="1" stop-color="#06080f"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="30%" r="70%">
      <stop offset="0" stop-color="#f0b90b" stop-opacity="0.20"/>
      <stop offset="1" stop-color="#f0b90b" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1080" height="1080" fill="url(#bg)"/>
  <rect width="1080" height="1080" fill="url(#glow)"/>
  <circle cx="930" cy="140" r="210" fill="#f0b90b" opacity="0.06"/>
  <circle cx="95" cy="960" r="260" fill="#1e90ff" opacity="0.06"/>

  <text x="72" y="88" font-size="28" fill="#8792a2" font-weight="800" letter-spacing="5">BINANCE SQUARE AUTOPOST</text>
  <rect x="72" y="118" width="180" height="54" rx="27" fill="#f0b90b"/>
  <text x="102" y="155" font-size="30" fill="#0b1020" font-weight="900">${esc(hot)}</text>
  <text x="280" y="156" font-size="30" fill="#8792a2" font-weight="700">${esc(time)}</text>

  <text x="72" y="278" font-size="96" fill="#f5f7fb" font-weight="900">$${esc(lead.symbol || '--')}</text>
  <text x="74" y="337" font-size="34" fill="#8792a2" font-weight="700">KEY AREA</text>
  <text x="286" y="338" font-size="42" fill="#f0b90b" font-weight="900">${esc(keyLevel(pack))}</text>
  <text x="74" y="408" font-size="34" fill="#8792a2" font-weight="700">24H</text>
  <text x="165" y="410" font-size="54" fill="${colorByPct(lead.change24h)}" font-weight="900">${esc(pct(lead.change24h))}</text>
  <text x="400" y="408" font-size="34" fill="#8792a2" font-weight="700">VOL</text>
  <text x="482" y="410" font-size="48" fill="#f5f7fb" font-weight="900">${esc(usd(lead.volume24h))}</text>

  ${symbolCard(peer, 72, 456, 440, 154, 'PEER')}
  ${symbolCard(anchor, 568, 456, 440, 154, 'ANCHOR')}

  <text x="72" y="655" font-size="28" fill="#8792a2" font-weight="800" letter-spacing="4">RELATIVE HEAT</text>
  ${bars(pack)}

  <rect x="72" y="875" width="936" height="132" rx="28" fill="#0b1220" stroke="#263142" stroke-width="2"/>
  <text x="104" y="925" font-size="26" fill="#8792a2" font-weight="800">MARKET NOTE</text>
  ${tspans(noteLines, 104, 958, 27, 32, '#f5f7fb', 700)}

  <text x="72" y="1042" font-size="26" fill="#8792a2" font-weight="700">$${esc(lead.symbol || '--')}  $${esc(peer.symbol || '--')}  $${esc(anchor.symbol || '--')}</text>
  <text x="782" y="1042" font-size="24" fill="#526071" font-weight="700">Square market card</text>
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
