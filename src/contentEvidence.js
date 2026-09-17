// Only completed, contiguous candles can support a short-window volume claim.
function finite(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function buildContentEvidence(pack = {}, now = Date.now()) {
  const empty = { available: false, reason: 'missing_closed_15m_candles' };
  if (pack.cacheFallback) return { ...empty, reason: 'cached_market_snapshot' };
  if (pack.chart?.interval !== '15m') return empty;
  const step = 15 * 60 * 1000;
  const rows = (pack.chart.klines || [])
    .filter(row => finite(row.closeTime) && Number(row.closeTime) < now)
    .sort((a, b) => Number(a.closeTime) - Number(b.closeTime)).slice(-20);
  if (rows.length < 20) return empty;
  if (now - Number(rows.at(-1).closeTime) > step) return { ...empty, reason: 'stale_candles' };
  if (rows.some((row, i) => i > 0 && Number(row.closeTime) - Number(rows[i - 1].closeTime) !== step)) {
    return { ...empty, reason: 'non_contiguous_candles' };
  }
  const volumeField = rows.every(row => finite(row.quoteVolume) && Number(row.quoteVolume) >= 0)
    ? 'quoteVolume' : 'volume';
  if (!rows.every(row => finite(row[volumeField]) && Number(row[volumeField]) >= 0
    && finite(row.high) && finite(row.low) && finite(row.close)
    && Number(row.low) > 0 && Number(row.high) >= Number(row.low) && Number(row.close) > 0)) return empty;
  const recent = rows.slice(-4), baseline = rows.slice(0, -4);
  const sum = data => data.reduce((total, row) => total + Number(row[volumeField]), 0);
  const baselineHourly = sum(baseline) / 4;
  const ratio = baselineHourly > 0 ? sum(recent) / baselineHourly : null;
  return {
    available: true,
    source: pack.chart.source || pack.source,
    window: 'last_closed_1h_vs_previous_4h_hourly_average',
    closedThrough: new Date(Number(rows.at(-1).closeTime)).toISOString(),
    volumeUnit: volumeField === 'quoteVolume' ? 'quote_asset' : 'base_asset',
    volumeRatio: ratio === null ? null : Number(ratio.toFixed(2)),
    volumeTrend: ratio === null ? 'unknown' : ratio >= 1.3 ? 'expanding' : ratio <= 0.7 ? 'contracting' : 'normal',
    recentHigh: Math.max(...recent.map(row => Number(row.high))),
    recentLow: Math.min(...recent.map(row => Number(row.low))),
    lastClose: Number(recent.at(-1).close),
    limitations: '成交量不等于资金净流入；24h 成交额不能证明最近 1h 放量；区间高低不是确定支撑阻力。'
  };
}

function contentEvidenceInstruction(pack = {}) {
  const evidence = pack.contentEvidence || buildContentEvidence(pack);
  const lines = [
    '事实边界：价格涨跌是观察，原因只是解释。没有数据不得写主力吸筹、资金净流入、抛压持续放大或机构进场。',
    '24h 成交额只表示过去一天交易规模，不证明最近 1h 成交增加；单次盘口挂单不等于实际成交。',
    '不同周期涨跌反向只证明短周期与日内分歧，不证明趋势已经反转。'
  ];
  if (!evidence.available) lines.push('本轮缺少可靠的已收盘短周期量能证据：不得断言已经放量或缩量；可以说明仍需验证，但不要每篇都以等待放量收尾。');
  else {
    lines.push(`已收盘量能与区间：${JSON.stringify(evidence)}`);
    lines.push('引用量比时必须说清“最近已收盘 1h / 前 4h 每小时均值”；不要与正在形成的 1h 涨跌混为同一时间窗。');
  }
  lines.push('非方向卡可省略价位。若引用价位，优先使用已收盘区间高低并说明时间窗；计算触发价只是模型参考，不得称为市场已验证的关键支撑、阻力或赔率开关。');
  return lines.join('\n');
}

module.exports = { buildContentEvidence, contentEvidenceInstruction, finite };
