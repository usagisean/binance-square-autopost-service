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
  const lead1h = n(lead.change1h);
  const lead24h = n(lead.change24h);
  const leadVolume24h = n(lead.volume24h);
  const leadAmplitude24h = n(lead.amplitude24h);
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

  const momentumShift = Math.abs(lead24h) >= 8 && Math.abs(lead1h) >= 1.2 && lead1h * lead24h < 0;
  const momentumActive = Math.abs(lead1h) >= 2.5 || (Math.abs(lead1h) >= 1.2 && Math.abs(lead24h) >= 12);
  const relativeActive = Math.abs(relPeer) >= 2 || Math.abs(relAnchor) >= 1.5;
  const liquidMomentum = leadVolume24h >= 50000000 && Math.abs(lead1h) >= 0.8 && Math.max(Math.abs(relPeer), Math.abs(relAnchor)) >= 0.6;
  const volumeWithoutDirection = leadVolume24h >= 50000000 && Math.abs(lead1h) <= 0.5 && leadAmplitude24h >= 5;
  const depthActive = available.depth && Math.abs(depth) >= 35;

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
  } else if (momentumShift) {
    type = 'momentum_shift';
    claim = `${lead.symbol} 的 24h 方向与最近 1h 已经反向，短线动量正在换挡`;
  } else if (liquidMomentum) {
    type = 'liquid_momentum';
    claim = lead1h > 0
      ? `${lead.symbol} 的短线走强有成交规模支撑，不只是小额拉动`
      : `${lead.symbol} 的短线走弱发生在活跃成交中，不只是盘口噪声`;
  } else if (momentumActive) {
    type = 'late_momentum';
    claim = lead1h > 0
      ? `${lead.symbol} 的短线动量仍在扩张，关键是成交和相对强弱能否同步`
      : `${lead.symbol} 的短线弱势仍在扩张，关键是抛压是否继续放大`;
  } else if (relativeActive) {
    type = 'relative_strength';
    claim = relAnchor >= 0
      ? `${lead.symbol} 最近 1h 明显强于大盘参照`
      : `${lead.symbol} 最近 1h 明显弱于大盘参照`;
  } else if (volumeWithoutDirection) {
    type = 'volume_without_direction';
    claim = `${lead.symbol} 的成交仍活跃，但短线价格没有给出同等强度的方向`;
  } else if (lead.bucket === 'ai' && pack.sector?.crypto_ai_follow?.available) {
    type = 'sector_rotation';
    claim = `${lead.symbol} 在 AI 币内部是否获得独立关注，可以用板块强弱验证`;
  } else if (depthActive) {
    type = 'orderbook_imbalance';
    claim = depth > 0 ? `${lead.symbol} 下方挂单明显更厚` : `${lead.symbol} 上方抛压明显更重`;
  } else {
    type = 'low_signal';
    claim = `${lead.symbol} 有波动，但暂时没有形成足够独立的方向`;
  }

  if (!imageType) {
    if (type === 'orderbook_imbalance' && available.depth) imageType = 'binance_orderbook_depth';
    else if (type === 'cross_market_confirmation' && available.tradfi) imageType = 'cross_market_panel';
    else if (available.depth && score >= 42) imageType = 'binance_orderbook_depth';
  }

  const confidence = score >= 70 ? 'high' : score >= 48 ? 'medium' : 'low';
  const stanceScore = lead1h + relAnchor * 0.45 + clamp(depth / 30, -1.5, 1.5);
  const stance = stanceScore >= 0.8 ? 'bullish' : stanceScore <= -0.8 ? 'bearish' : 'mixed';
  const qualityGatePassed = score >= 42 && type !== 'low_signal';
  return {
    type,
    subject: lead.symbol,
    claim,
    score,
    confidence,
    stance,
    // Every valid market pack remains publishable. qualityGatePassed is kept as
    // a non-blocking signal for editorial choices, observability and images.
    publishable: true,
    qualityGatePassed,
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
  pack.publishDecision = {
    publishable: true,
    reason: 'valid_market_pack',
    qualityGatePassed: event.qualityGatePassed,
    qualityNote: event.qualityGatePassed ? 'quality_reference_passed' : `quality_reference_low:${event.type}:${event.score}`
  };
  return pack;
}

module.exports = { deriveMarketEvent, attachMarketQuality, evidenceAvailable };
