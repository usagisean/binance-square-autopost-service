// Code-rendered evidence cards: no invented candles, screenshots or AI artwork.
const { finite } = require('./contentEvidence');
const W = 1080, H = 1080;
const C = { bg: '#0b1118', panel: '#121d29', ink: '#edf3fa', muted: '#9baabd', line: '#293646', accent: '#c6ee78', red: '#ff8f9b', green: '#7cdbc0' };
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]); }
function txt(x, y, value, size = 28, color = C.ink, extra = '') { return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${extra}>${esc(value)}</text>`; }
function lines(value, width = 29, max = 2) {
  const out = []; let row = '', units = 0;
  for (const ch of String(value || '')) {
    const n = /[\x00-\x7f]/.test(ch) ? 0.55 : 1;
    if (units + n > width && /[，。；：！？、）】》]/.test(ch)) { row += ch; units += n; continue; }
    if (units + n > width) { out.push(row); row = ''; units = 0; }
    if (out.length >= max) { out[max - 1] = out[max - 1].slice(0, -1) + '…'; return out; }
    row += ch; units += n;
  }
  if (row) out.push(row);
  return out;
}
function percent(value, digits = 2) { return finite(value) ? `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(digits)}%` : '暂无数据'; }
function dollars(value) {
  if (!finite(value)) return '暂无数据';
  const n = Number(value);
  return n >= 1e8 ? `${(n / 1e8).toFixed(2)} 亿美元` : n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万美元` : `${n.toFixed(0)} 美元`;
}
function dateLabel(value) {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '采集时间未提供';
}
function realChartRows(pack) {
  const asOf = Date.parse(pack.generatedAt || '');
  const interval = String(pack.chart?.interval || '').match(/^(\d+)(m|h|d)$/);
  if (!interval) return [];
  const step = Number(interval[1]) * ({ m: 60000, h: 3600000, d: 86400000 }[interval[2]]);
  return (pack.chart?.klines || []).filter(row =>
    finite(row.openTime) && Number(row.openTime) > 0
    && Number.isFinite(asOf)
    && (finite(row.closeTime) ? Number(row.closeTime) : Number(row.openTime) + step - 1) <= asOf
    && [row.open, row.high, row.low, row.close].every(v => finite(v) && Number(v) > 0)
    && Number(row.high) >= Math.max(Number(row.open), Number(row.close))
    && Number(row.low) <= Math.min(Number(row.open), Number(row.close))
  ).slice(-48);
}
function frame(pack, postText, { title, kind, source, observedAt, chart, note }) {
  const lead = pack.trio?.lead?.symbol || 'MARKET';
  const excerpt = String(postText || pack.marketEvent?.claim || '').replace(/\$([A-Z0-9]+)/g, '$1').replace(/\s+/g, ' ').trim();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <style>text{font-family:"Noto Sans CJK SC","PingFang SC","Heiti SC",Arial,sans-serif;font-weight:500}</style>
    <rect width="1080" height="1080" fill="${C.bg}"/>
    <rect x="56" y="54" width="5" height="34" rx="2" fill="${C.accent}"/>
    ${txt(76, 81, `${lead} / USDT`, 30, C.ink, 'font-weight="800"')}
    ${txt(1008, 81, '行情笔记 · 单一证据', 23, C.muted, 'text-anchor="end"')}
    ${lines(title, 17, 2).map((s, i) => txt(72, 170 + i * 72, s, 56, C.ink, 'font-weight="800"')).join('')}
    ${txt(74, 290, kind, 25, C.accent)}
    <rect x="48" y="324" width="984" height="458" rx="28" fill="${C.panel}" stroke="${C.line}"/>
    ${chart}
    ${txt(74, 831, note, 24, C.muted)}
    ${txt(74, 886, '本帖观察', 23, C.accent)}
    ${lines(excerpt, 31, 2).map((s, i) => txt(74, 931 + i * 39, s, 28)).join('')}
    <line x1="72" y1="1000" x2="1008" y2="1000" stroke="${C.line}"/>
    ${txt(72, 1038, source, 21, C.muted)}
    ${txt(1008, 1038, dateLabel(observedAt || pack.generatedAt), 19, C.muted, 'text-anchor="end"')}
  </svg>`;
}
function buildEvidenceStory(pack, postText, type) {
  if (pack.cacheFallback) return null;
  const lead = pack.trio?.lead || {};
  const d = pack.publicDerivatives?.symbols?.[lead.symbol] || {};
  if (type === 'binance_orderbook_depth') {
    const levels = pack.marketIntel?.symbols?.[lead.symbol]?.depthLevels || {};
    const n = Math.min(10, levels.bids?.length || 0, levels.asks?.length || 0);
    const bids = (levels.bids || []).slice(0, n), asks = (levels.asks || []).slice(0, n);
    if (n < 5 || ![...bids, ...asks].every(r => finite(r.notional) && Number(r.notional) >= 0)) return null;
    const sums = [bids, asks].map(rows => rows.reduce((sum, row) => sum + Number(row.notional), 0));
    const max = Math.max(...sums); if (max <= 0) return null;
    const chart = txt(80, 382, `前 ${n} 档可见挂单名义金额`, 26, C.muted)
      + sums.map((v, i) => {
        const y = 454 + i * 146, color = i ? C.red : C.green;
        return txt(82, y, i ? '卖单' : '买单', 30, color)
          + txt(992, y, dollars(v), 42, C.ink, 'text-anchor="end" font-weight="800"')
          + `<rect x="82" y="${y + 25}" width="910" height="32" rx="8" fill="${C.line}"/><rect x="82" y="${y + 25}" width="${(910 * v / max).toFixed(1)}" height="32" rx="8" fill="${color}"/>`;
      }).join('') + txt(82, 742, `可见买单占比 ${(sums[0] / (sums[0] + sums[1]) * 100).toFixed(1)}% · 仅限前 ${n} 档`, 25, C.muted);
    return frame(pack, postText, { title: sums[0] > sums[1] ? '买单更厚，就能接住下跌？' : '卖单更厚，就一定会跌？', kind: '盘口快照 / 不是成交记录', source: '数据：Binance 公开盘口', chart, note: '挂单随时能撤，下一步还要看实际成交。' });
  }
  if (type === 'public_derivatives_panel') {
    if (![d.fundingRateHourly, d.openInterestUsd, d.volume24hUsd].some(finite)) return null;
    const funding = finite(d.fundingRateHourly) ? Number(d.fundingRateHourly) * 100 : null;
    const title = funding === null ? '仓位很重，价格走开了吗？' : funding < 0 ? '空头付费，不等于马上上涨' : funding > 0 ? '多头在付费，价格跟上了吗？' : '费率持平，方向还看价格';
    const chart = txt(82, 386, '资金费率 · 每小时', 28, C.muted)
      + txt(82, 504, percent(funding, 4), 88, C.accent, 'font-weight="800"')
      + txt(82, 564, funding === null ? '该指标未提供' : funding < 0 ? '负费率：空头向多头支付持仓费用' : funding > 0 ? '正费率：多头向空头支付持仓费用' : '当前费率为零', 27, C.muted)
      + `<line x1="82" y1="608" x2="992" y2="608" stroke="${C.line}"/>`
      + txt(82, 658, '永续持仓名义价值', 25, C.muted) + txt(82, 720, dollars(d.openInterestUsd), 38)
      + txt(602, 658, '24h 永续成交额', 25, C.muted) + txt(602, 720, dollars(d.volume24hUsd), 38);
    return frame(pack, postText, { title, kind: '持仓成本 / 不等于入场信号', source: '数据：Hyperliquid 公共 API', observedAt: pack.publicDerivatives?.fetchedAt, chart, note: '这是单一交易所数据，不代表 Binance 全市场。' });
  }
  if (type === 'cross_market_panel') {
    const reference = pack.tradfiSignal?.relevant?.find(r => finite(r.change24h));
    if (!reference || !finite(lead.change1h)) return null;
    const chart = txt(82, 388, `${lead.symbol} · 最近 1h`, 28, C.muted)
      + txt(82, 493, percent(lead.change1h), 82, C.green, 'font-weight="800"')
      + `<line x1="82" y1="538" x2="992" y2="538" stroke="${C.line}"/>`
      + txt(82, 600, `${reference.name || reference.symbol} (${reference.symbol}) · 最近美股时段`, 28, C.muted)
      + txt(82, 702, percent(reference.change24h), 82, C.accent, 'font-weight="800"');
    return frame(pack, postText, { title: '币股的方向，一致还是背离？', kind: '跨市场观察 / 时间窗口不同', source: '数据：Binance / Yahoo Finance', observedAt: reference.timestamp, chart, note: '不同时间窗仅作背景对照，不证明币价涨跌原因。' });
  }
  if (type === 'chart_snapshot') {
    const rows = realChartRows(pack); if (rows.length < 20) return null;
    const values = rows.map(r => Number(r.close)), min = Math.min(...values), max = Math.max(...values);
    const span = max - min || Math.max(max * 0.01, 1e-9);
    const points = values.map((v, i) => `${i ? 'L' : 'M'}${(84 + i / (values.length - 1) * 910).toFixed(1)},${(650 - (v - min) / span * 210).toFixed(1)}`).join(' ');
    const evidence = pack.contentEvidence || {};
    const priceLabel = value => Number(value).toPrecision(5).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    const chart = txt(82, 386, `${pack.chart.interval || 'K线'} 收盘价格 · ${rows.length} 根真实记录`, 27, C.muted)
      + txt(992, 423, priceLabel(max), 23, C.muted, 'text-anchor="end"')
      + [440, 545, 650].map(y => `<line x1="82" y1="${y}" x2="994" y2="${y}" stroke="${C.line}"/>`).join('')
      + `<path d="${points}" fill="none" stroke="${C.green}" stroke-width="5" stroke-linejoin="round"/>`
      + txt(992, 686, priceLabel(min), 23, C.muted, 'text-anchor="end"')
      + txt(82, 700, `${dateLabel(Number(rows[0].openTime))} 起`, 21, C.muted)
      + txt(82, 746, evidence.available && finite(evidence.volumeRatio) ? `上一收盘小时成交 / 此前四小时均量：${evidence.volumeRatio} 倍` : `区间末端收盘价 ${priceLabel(values.at(-1))}`, 27, C.muted);
    return frame(pack, postText, { title: '涨跌之外，看清这一段变化', kind: '真实行情 / 已收盘价格轨迹', source: `数据：Binance ${/futures/.test(pack.source || '') ? '合约' : '现货'}`, observedAt: finite(rows.at(-1).closeTime) ? Number(rows.at(-1).closeTime) : pack.generatedAt, chart, note: '尚未收盘的 K 线未计入图中。' });
  }
  return null;
}
module.exports = { buildEvidenceStory, realChartRows };
