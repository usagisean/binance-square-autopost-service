const { postJson } = require('./httpClient');

const HYPERLIQUID_INFO = 'https://api.hyperliquid.xyz/info';
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

function normalizeHyperliquid(meta = {}, contexts = []) {
  const out = {};
  for (let i = 0; i < (meta.universe || []).length; i++) {
    const symbol = String(meta.universe[i]?.name || '').toUpperCase();
    const c = contexts[i] || {};
    const mark = n(c.markPx);
    const oiBase = n(c.openInterest);
    if (!symbol || !mark) continue;
    out[symbol] = {
      symbol, source: 'Hyperliquid public API', markPrice: mark, oraclePrice: n(c.oraclePx),
      openInterestBase: oiBase, openInterestUsd: oiBase == null ? null : oiBase * mark,
      fundingRateHourly: n(c.funding), premium: n(c.premium), volume24hUsd: n(c.dayNtlVlm),
      previousDayPrice: n(c.prevDayPx), maxLeverage: n(meta.universe[i]?.maxLeverage)
    };
  }
  return out;
}

async function fetchPublicDerivatives(pack = {}) {
  try {
    const data = await postJson(HYPERLIQUID_INFO, { type: 'metaAndAssetCtxs' }, { timeoutMs: 9000 });
    if (!Array.isArray(data) || data.length < 2) throw new Error('invalid_hyperliquid_response');
    const all = normalizeHyperliquid(data[0], data[1]);
    const symbols = [pack.trio?.lead?.symbol, pack.trio?.peer?.symbol, pack.trio?.anchor?.symbol].filter(Boolean);
    const selected = Object.fromEntries(symbols.filter(s => all[s]).map(s => [s, all[s]]));
    if (!Object.keys(selected).length) return { ok: false, status: 'unsupported_symbols', source: 'Hyperliquid public API', symbols: {} };
    return { ok: true, status: 'available', source: 'Hyperliquid public API', fetchedAt: new Date().toISOString(), symbols: selected };
  } catch (err) {
    return { ok: false, status: 'unavailable', source: 'Hyperliquid public API', reason: err.message || String(err), symbols: {} };
  }
}

function appendPublicDerivativesFacts(pack = {}) {
  const d = pack.publicDerivatives;
  const lead = d?.symbols?.[pack.trio?.lead?.symbol];
  if (!d?.ok || !lead) return;
  const fundingPct = lead.fundingRateHourly == null ? null : lead.fundingRateHourly * 100;
  const premiumPct = lead.premium == null ? null : lead.premium * 100;
  const parts = [`${lead.symbol} 永续合约持仓名义价值 $${(lead.openInterestUsd / 1e6).toFixed(2)}M`];
  if (fundingPct != null) parts.push(`小时资金费率 ${fundingPct >= 0 ? '+' : ''}${fundingPct.toFixed(4)}%`);
  if (premiumPct != null) parts.push(`标记溢价 ${premiumPct >= 0 ? '+' : ''}${premiumPct.toFixed(4)}%`);
  pack.facts.push(`${parts.join('，')}（Hyperliquid 公共数据）`);
  pack.takeaways.push('永续合约数据来自 Hyperliquid 公共 API，只用于交叉验证仓位和杠杆情绪，不代表 Binance 全市场。');
}

module.exports = { fetchPublicDerivatives, appendPublicDerivativesFacts, normalizeHyperliquid };
