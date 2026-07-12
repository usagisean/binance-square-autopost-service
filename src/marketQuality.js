function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function evidenceAvailable(pack = {}) {
  const cg = pack.coinglass || {};
  return {
    heatmap: cg.heatmap?.available === true,
    liquidation: cg.liquidation?.available === true,
    openInterest: cg.openInterest?.available === true,
    longShort: cg.longShort?.available === true,
    orderbook: cg.orderbookAskBids?.available === true,
    depth: pack.marketIntel?.symbols?.[pack.trio?.lead?.symbol]?.depth?.available === true,
    chart: Array.isArray(pack.chart?.klines) && pack.chart.klines.length >= 20,
    news: Array.isArray(pack.externalIntel?.news) && pack.externalIntel.news.length > 0,
    publicDerivatives: pack.publicDerivatives?.ok === true && Boolean(pack.publicDerivatives?.symbols?.[pack.trio?.lead?.symbol]),
    tradfi: pack.tradfi?.ok === true
  };
}

function deriveMarketEvent(pack = {}) {
  const lead = pack.trio?.lead || {};
  const peer = pack.trio?.peer || {};
  const anchor = pack.trio?.anchor || {};
  const intel = pack.marketIntel?.symbols?.[lead.symbol] || {};
  const cg = pack.coinglass || {};
  const available = evidenceAvailable(pack);
  const relPeer = n(lead.change1h) - n(peer.change1h);
  const relAnchor = n(lead.change1h) - n(anchor.change1h);
  const depth = n(intel.depth?.imbalance);
  const oiChange = n(cg.openInterest?.changePct ?? intel.openInterestValueChange5m);
  const longRatio = n(cg.longShort?.longPercent);
  const shortRatio = n(cg.longShort?.shortPercent);
  const publicDerivatives = pack.publicDerivatives?.symbols?.[lead.symbol] || {};
  const fundingHourlyPct = n(publicDerivatives.fundingRateHourly) * 100;
  const oiToVolume = n(publicDerivatives.openInterestUsd) / Math.max(1, n(publicDerivatives.volume24hUsd));
  const tradfiAssets = pack.tradfi?.assets || {};
  const growthMove = [tradfiAssets.QQQ, tradfiAssets.SOXX, tradfiAssets.NVDA].filter(Boolean).reduce((s, x) => s + n(x.change24h), 0) / Math.max(1, [tradfiAssets.QQQ, tradfiAssets.SOXX, tradfiAssets.NVDA].filter(Boolean).length);
  const cryptoBetaMove = [tradfiAssets.COIN, tradfiAssets.MSTR].filter(Boolean).reduce((s, x) => s + n(x.change24h), 0) / Math.max(1, [tradfiAssets.COIN, tradfiAssets.MSTR].filter(Boolean).length);

  let score = 0;
  const reasons = [];
  const add = (points, reason) => { if (points > 0) { score += points; reasons.push({ points: Math.round(points), reason }); } };
  add(clamp(Math.abs(n(lead.change1h)) * 4, 0, 16), '短线价格异动');
  add(clamp(Math.abs(n(lead.change24h)) * 0.45, 0, 12), '日内波动');
  add(clamp(n(lead.amplitude24h) * 0.5, 0, 12), '振幅活跃');
  add(clamp((Math.log10(Math.max(1, n(lead.volume24h))) - 6) * 5, 0, 12), '成交额达到可讨论规模');
  add(clamp(Math.max(Math.abs(relPeer), Math.abs(relAnchor)) * 2.2, 0, 12), '相对强弱明显');
  if (Math.abs(depth) >= 15) add(clamp(Math.abs(depth) / 4, 4, 10), '盘口明显失衡');
  if (available.openInterest && Math.abs(oiChange) >= 1) add(clamp(Math.abs(oiChange) * 2, 5, 12), '持仓变化异常');
  if (available.longShort && Math.max(longRatio, shortRatio) >= 60) add(8, '多空账户明显拥挤');
  if (available.liquidation) add(8, '存在清算证据');
  if (available.heatmap) add(12, '存在清算热力图');
  if (available.news) add(8, '存在可验证事件信息');
  if (available.publicDerivatives) add(6, '存在免费永续合约仓位证据');
  if (available.publicDerivatives && Math.abs(fundingHourlyPct) >= 0.003) add(clamp(Math.abs(fundingHourlyPct) * 1200, 4, 10), '资金费率偏离中性');
  if (available.publicDerivatives && oiToVolume >= 1.2) add(clamp(oiToVolume * 3, 4, 10), '持仓相对成交量偏高');
  const crossMarketAligned = lead.bucket === 'ai'
    ? Math.abs(growthMove) >= 0.7 && n(lead.change1h) * growthMove > 0
    : ['BTC', 'ETH', 'SOL', 'BNB', 'COIN', 'MSTR'].includes(lead.symbol) && Math.abs(cryptoBetaMove) >= 1 && n(lead.change1h) * cryptoBetaMove > 0;
  if (available.tradfi && crossMarketAligned) add(7, '传统市场与币圈方向互相验证');
  score = Math.round(clamp(score, 0, 100));

  let type = 'relative_strength';
  let claim = `${lead.symbol} 的短线强弱差值得跟踪`;
  let imageType = available.heatmap ? 'coinglass_liquidation_heatmap' : available.openInterest || available.longShort || available.liquidation ? 'coinglass_derivatives_panel' : available.publicDerivatives ? 'public_derivatives_panel' : null;
  if (available.heatmap) {
    type = 'liquidation_map';
    claim = `${lead.symbol} 附近的清算密集区比单根K线更值得看`;
  } else if (available.openInterest && n(lead.change1h) * oiChange < 0) {
    type = 'price_oi_divergence';
    claim = n(lead.change1h) > 0 ? `${lead.symbol} 上涨但持仓没有同步增加` : `${lead.symbol} 下跌但持仓结构没有同步释放`;
  } else if (available.longShort && Math.max(longRatio, shortRatio) >= 60) {
    type = 'crowded_positioning';
    claim = `${lead.symbol} 的合约仓位已经出现单边拥挤`;
  } else if (available.publicDerivatives && Math.abs(fundingHourlyPct) >= 0.003) {
    type = 'funding_dislocation';
    claim = fundingHourlyPct > 0 ? `${lead.symbol} 永续多头正在支付更高的持仓成本` : `${lead.symbol} 永续空头正在支付更高的持仓成本`;
  } else if (crossMarketAligned) {
    type = 'cross_market_confirmation';
    claim = lead.bucket === 'ai' ? `${lead.symbol} 与纳指/半导体情绪出现同向验证` : `${lead.symbol} 与美股 crypto beta 出现同向验证`;
  } else if (Math.abs(depth) >= 18) {
    type = 'orderbook_imbalance';
    claim = depth > 0 ? `${lead.symbol} 下方挂单明显更厚` : `${lead.symbol} 上方抛压明显更重`;
  } else if (Math.abs(n(lead.change1h)) >= 2.5 && Math.abs(n(lead.change24h)) >= 12) {
    type = 'late_momentum';
    claim = `${lead.symbol} 已经走出大波动，重点是增量资金还能不能跟上`;
  } else if (Math.abs(relPeer) >= 2 || Math.abs(relAnchor) >= 1.5) {
    type = 'relative_strength';
    claim = `${lead.symbol} 与参照币的短线强弱已经拉开`;
  } else if (lead.bucket === 'ai' && pack.sector?.crypto_ai_follow?.available) {
    type = 'sector_rotation';
    claim = `${lead.symbol} 在 AI 币内部的辨识度需要用板块强弱验证`;
  } else {
    type = 'low_signal';
    claim = `${lead.symbol} 当前没有形成足够独立的交易事件`;
  }

  if (!imageType) {
    if (type === 'orderbook_imbalance' && available.depth) imageType = 'binance_orderbook_depth';
    else if (type === 'cross_market_confirmation' && available.tradfi) imageType = 'cross_market_panel';
    else if (available.depth && score >= 42) imageType = 'binance_orderbook_depth';
  }

  const confidence = score >= 70 ? 'high' : score >= 48 ? 'medium' : 'low';
  return {
    type,
    subject: lead.symbol,
    claim,
    score,
    confidence,
    publishable: score >= 42 && type !== 'low_signal',
    imageEligible: Boolean(imageType) && score >= 42,
    imageType,
    reasons: reasons.sort((a, b) => b.points - a.points).slice(0, 5),
    evidenceAvailable: available,
    comparisons: { peer: peer.symbol, anchor: anchor.symbol, relative1hVsPeer: Number(relPeer.toFixed(2)), relative1hVsAnchor: Number(relAnchor.toFixed(2)) }
  };
}

function attachMarketQuality(pack = {}) {
  const event = deriveMarketEvent(pack);
  pack.marketEvent = event;
  pack.publishScore = event.score;
  pack.publishDecision = { publishable: event.publishable, reason: event.publishable ? 'quality_gate_passed' : `quality_gate_rejected:${event.type}:${event.score}` };
  return pack;
}

module.exports = { deriveMarketEvent, attachMarketQuality, evidenceAvailable };
