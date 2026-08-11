const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { renderTemplate, validatePostText, normalizeCashtags, humanPriceLevel, selectPostAngle, selectEmojiStyle, selectHumorStyle, formatTradePlanForPrompt, editorialBrief, optionalContext, evidenceFocus, safeExternalIntel, promptSafeMarketPack } = require('../src/generator');
const { getContentType, resolveImagePath } = require('../src/mediaUploader');
const { selectImagePaths } = require('../src/imageAssets');
const { summarizeCoinglassEvidence, pairSymbol } = require('../src/coinglass');
const { buildSvg, chooseEvidenceType } = require('../src/imageCard');
const { deriveMarketEvent, attachMarketQuality } = require('../src/marketQuality');
const { normalizeHyperliquid } = require('../src/publicDerivatives');
const { parseChart } = require('../src/tradfi');
const { buildTradePlan, rankScore, discoverDynamicRows } = require('../src/marketPack');
const { buildEditorialDecision, setupGrade, explicitSignalPolicy } = require('../src/editorialStrategy');
const { CONTENT_TYPES, buildPublishBody, parsePublishResponse } = require('../src/publisher');

const root = path.join(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'templates', 'default-prompt.md'), 'utf8');

function baseSettings(extra = {}) {
  return {
    jobName: 'Binance Square Market Autopost',
    jobDescription: '基于真实数据写交易员风格帖子。',
    language: 'zh-CN',
    styleGuide: '短句、克制、有交易感。',
    minPostChars: 80,
    maxPostChars: 260,
    bannedPhrases: [],
    requireCashtags: true,
    includeTradePlan: true,
    tradePlanMode: 'opinion',
    similarityThreshold: 0,
    ...extra
  };
}

function basePack(extra = {}) {
  return {
    ok: true,
    source: 'fixture',
    generatedAt: '2026-06-09T00:00:00.000Z',
    trio: {
      lead: { symbol: 'RENDER', bucket: 'ai', price: 7.12, change1h: 2.4, change4h: 4.1, change24h: 9.8, volume24h: 82000000, amplitude24h: 14.2 },
      peer: { symbol: 'FET', bucket: 'ai', price: 1.21, change1h: -0.7, change4h: 0.8, change24h: 3.2, volume24h: 31000000, amplitude24h: 8.1 },
      anchor: { symbol: 'BTC', bucket: 'anchor', price: 68400, change1h: -0.35, change4h: -0.8, change24h: 0.2, volume24h: 28000000000, amplitude24h: 2.8 }
    },
    facts: [
      'RENDER 现价 $7.12，1h +2.40%，4h +4.10%，24h +9.80%',
      'FET 现价 $1.21，1h -0.70%，4h +0.80%，24h +3.20%',
      'BTC 现价 $68,400，1h -0.35%，4h -0.80%，24h +0.20%'
    ],
    takeaways: ['BTC 没有配合，RENDER 单独走强时追高容错低。'],
    tradePlan: {
      symbol: 'RENDER',
      bias: '看涨',
      direction: 'long',
      trigger: 7.25,
      stopLoss: 6.9,
      takeProfit1: 7.67,
      takeProfit2: 8.16,
      summary: 'RENDER 偏多条件：站上 $7.25 再看延续；跌回 $6.90 附近就放弃。'
    },
    externalIntel: {},
    stockCashtags: '$NVDA $AMD $AVGO $TSM $ARM $MU $COIN $MSTR $HOOD',
    macroCashtags: '$QQQ $SOXX $SPY',
    aiSectorCashtags: '$NEAR $ICP $RENDER $FET $TAO $WLD',
    stockFacts: '暂无可用美股/ETF行情数据。',
    aiSectorFacts: 'AI币池短线参照：RENDER 1h +2.40%、4h +4.10%、24h +9.80%；FET 1h -0.70%、4h +0.80%、24h +3.20%。',
    stockTakeaways: '美股参照数据缺失，本轮不使用美股作为判断依据。',
    aiTakeaways: 'AI币池短线偏热，RENDER 如果是正文主角，可以写成板块内强弱选择，但不要借美股数据脑补原因。',
    ...extra
  };
}

(function noStockDataDoesNotInvent() {
  const rendered = renderTemplate(template, basePack(), baseSettings());
  assert(!rendered.includes('暂无可用美股/ETF行情数据。'));
  assert(!rendered.includes('美股参照数据缺失，本轮不使用美股作为判断依据。'));
  assert(rendered.includes('AI币池短线参照'));
  const emptyContextPack = basePack({
    aiSectorFacts: '暂无可用AI板块行情数据。',
    aiTakeaways: 'AI板块数据不足，本轮不强行写AI联动。'
  });
  assert(optionalContext(emptyContextPack).includes('无额外上下文'));
})();

(function stockAiStrongCryptoWeakPrompt() {
  const pack = basePack({
    stockFacts: '$NVDA 1h +2.10%，$QQQ 1h +0.80%，$SOXX 1h +1.40%。',
    aiSectorFacts: 'AI币池短线参照：RENDER 1h -1.20%；FET 1h -0.90%；NEAR 1h -0.60%。',
    stockTakeaways: '美股 AI 强但币圈 AI 承接弱，有外部情绪，但币圈承接没打开。',
    aiTakeaways: '美股 AI 强但币圈承接弱，本轮不追 AI 币高位。'
  });
  const rendered = renderTemplate(template, pack, baseSettings());
  assert(rendered.includes('美股 AI 强但币圈 AI 承接弱'));
  assert(rendered.includes('有外部情绪，但币圈承接没打开'));
})();

(function btcWeakSmallCoinStrongAngle() {
  const pack = basePack();
  const angle = selectPostAngle(pack);
  const rendered = renderTemplate(template, pack, baseSettings());
  assert(['btc_eth_not_lifting', 'move_already_loud', 'ai_coin_attention'].includes(angle.id));
  assert(rendered.includes('人话') || rendered.includes('盘中'));
})();

(function emojiStyleIsVariedButBounded() {
  const pack = basePack();
  const style = selectEmojiStyle(pack);
  assert(['none', 'one'].includes(style.id));
  assert(style.emojis.length <= 1);
  assert(editorialBrief(pack).includes('全文最多 1 个'));
  const rendered = renderTemplate(template, pack, baseSettings());
  assert(rendered.includes('表情：'));
})();

(function humorStyleIsOptionalAndBounded() {
  const style = selectHumorStyle(basePack());
  assert(['none', 'dry_discipline', 'data_deadpan', 'desk_banter'].includes(style.id));
  assert(style.instruction);
  const rendered = renderTemplate('{{HUMOR_STYLE}}', basePack(), baseSettings());
  assert(rendered.includes(style.instruction));
})();

(function directionalTradePlanBuildsAuditableTargets() {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    high: 100 + i * 0.12,
    low: 98.5 + i * 0.08,
    close: 99.4 + i * 0.1
  }));
  const longPack = {
    trio: {
      lead: { symbol: 'TEST', price: 101.2, change1h: 4.2, change24h: 12, amplitude24h: 10 },
      peer: { symbol: 'PEER', change1h: 0.5 },
      anchor: { symbol: 'BTC', change1h: 0.1 }
    }
  };
  const longPlan = buildTradePlan(longPack, {
    symbols: { TEST: { depth: { imbalance: 25 }, takerBuySellRatio: 1.2, openInterestValueChange5m: 0.8, fundingRate: 0.0001 } }
  }, rows, true, { tradePlanMode: 'trade_card' });
  assert.strictEqual(longPlan.direction, 'long');
  assert(longPlan.stopLoss < longPlan.trigger);
  assert(longPlan.takeProfit1 > longPlan.trigger);
  assert(longPlan.takeProfit2 > longPlan.takeProfit1);
  assert.strictEqual(longPlan.targetMethod, 'risk_multiple_1.2R_2R');

  const shortPack = {
    trio: {
      lead: { symbol: 'TEST', price: 99.2, change1h: -4.2, change24h: -12, amplitude24h: 10 },
      peer: { symbol: 'PEER', change1h: 0.2 },
      anchor: { symbol: 'BTC', change1h: 0.1 }
    }
  };
  const shortPlan = buildTradePlan(shortPack, {
    symbols: { TEST: { depth: { imbalance: -25 }, takerBuySellRatio: 0.8, openInterestValueChange5m: -0.8, fundingRate: 0.0001 } }
  }, rows, true, { tradePlanMode: 'trade_card' });
  assert.strictEqual(shortPlan.direction, 'short');
  assert(shortPlan.stopLoss > shortPlan.trigger);
  assert(shortPlan.takeProfit1 < shortPlan.trigger);
  assert(shortPlan.takeProfit2 < shortPlan.takeProfit1);
})();

(function tradeCardPromptAndValidationAreActionable() {
  const pack = basePack({
    chart: { klines: Array.from({ length: 24 }, (_, i) => ({ high: 7 + i * 0.02, low: 6.9 + i * 0.02, close: 6.95 + i * 0.02 })) },
    marketEvent: {
      type: 'liquid_momentum',
      score: 82,
      stance: 'bullish',
      claim: 'RENDER 的上行得到成交与短周期结构共同验证',
      reasons: [{ reason: '成交与价格方向一致' }]
    },
    tradePlan: {
      ...basePack().tradePlan,
      basis: { score: 2.1 }
    }
  });
  const settings = baseSettings({ tradePlanMode: 'adaptive', maxActionablePostsDaily: 3, minPostChars: 1, maxPostChars: 300 });
  const decision = buildEditorialDecision(pack, settings, []);
  assert.strictEqual(decision.setupGrade, 'A');
  assert.strictEqual(decision.requiresTradeCard, true);
  pack.editorialDecision = decision;
  const planText = formatTradePlanForPrompt(pack.tradePlan);
  assert(planText.includes('做多 $RENDER '));
  assert(planText.includes('止损 6.9'));
  assert(planText.includes('止盈先看 7.67，再看 8.16'));

  const text = '做多 $RENDER ：站稳7.25再参与，止损6.9，止盈先看7.67、再看8.16。成交放大后，最近一小时的强弱差也在扩大；$FET 和 $BTC 同期没有跟上。涨幅会讲故事，成交至少得签字，这里两者暂时同向。';
  const valid = validatePostText(text, pack, settings);
  assert.deepStrictEqual(valid.errors, []);

  const oneTarget = validatePostText(text.replace('、再看8.16', ''), pack, settings);
  assert.deepStrictEqual(oneTarget.errors, [], 'A 级方案只强制第一目标，第二目标可省略');

  const missingRiskPlan = validatePostText(text.replace('，止损6.9，止盈先看7.67、再看8.16', ''), pack, settings);
  assert(missingRiskPlan.errors.includes('missing_stop_loss_in_opening'));
  assert(missingRiskPlan.errors.includes('missing_take_profit_in_opening'));

  const wrongDirection = validatePostText(text.replace('做多', '做空'), pack, settings);
  assert(wrongDirection.errors.includes('trade_direction_mismatch:long'));

  const fourthTag = validatePostText(`${text} $NVDA 只作额外参照。`, pack, settings);
  assert(fourthTag.errors.includes('too_many_distinct_cashtags:4'));
})();

(function editorialGradesControlExecutionPrecision() {
  const settings = baseSettings({ tradePlanMode: 'adaptive', maxActionablePostsDaily: 3 });
  const strong = basePack({
    chart: { klines: Array.from({ length: 24 }, (_, i) => ({ high: 7 + i * 0.02, low: 6.9 + i * 0.02, close: 6.95 + i * 0.02 })) },
    marketEvent: { type: 'liquid_momentum', score: 78, stance: 'bullish', claim: '成交参与验证了短线突破' },
    tradePlan: { ...basePack().tradePlan, basis: { score: 1.8 } }
  });
  const gradeA = buildEditorialDecision(strong, settings, []);
  assert.strictEqual(setupGrade(strong, settings, []), 'A');
  assert.strictEqual(gradeA.requiresTradeCard, true);
  assert(gradeA.executionInstruction.includes('触发位'));

  const mixed = basePack({
    marketEvent: { type: 'volume_without_direction', score: 49, stance: 'neutral', claim: '成交活跃但方向没有拉开' },
    tradePlan: { ...basePack().tradePlan, direction: 'watch', basis: { score: 0.2 } }
  });
  const gradeB = buildEditorialDecision(mixed, settings, []);
  assert.strictEqual(gradeB.setupGrade, 'B');
  assert.strictEqual(gradeB.requiresTradeCard, false);
  assert(gradeB.executionInstruction.includes('只给一个关键'));

  const weak = basePack({
    marketEvent: { type: 'low_signal', score: 18, stance: 'neutral', claim: '量价与结构都没有形成优势' },
    tradePlan: { ...basePack().tradePlan, direction: 'watch', basis: { score: 0 } }
  });
  const gradeC = buildEditorialDecision(weak, settings, []);
  assert.strictEqual(gradeC.setupGrade, 'C');
  assert.strictEqual(gradeC.requiresTradeCard, false);
  const rendered = renderTemplate(template, weak, settings);
  assert(rendered.includes('senior-trader-v3'));
  assert(rendered.includes('不提供伪精确交易指令'));
})();

(function explicitDirectionPostsAreRareAndCooldownBounded() {
  const settings = baseSettings({
    tradePlanMode: 'adaptive',
    includeTradePlan: true,
    maxActionablePostsDaily: 3,
    explicitSignalCooldownRuns: 8,
    minPostChars: 1,
    maxPostChars: 320
  });
  const strong = basePack({
    chart: { klines: Array.from({ length: 24 }, (_, i) => ({ high: 7 + i * 0.02, low: 6.9 + i * 0.02, close: 6.95 + i * 0.02 })) },
    marketEvent: { type: 'liquid_momentum', score: 82, stance: 'bullish', claim: '成交与结构共同支持 RENDER' },
    tradePlan: { ...basePack().tradePlan, basis: { score: 2.1 } }
  });
  const allowed = explicitSignalPolicy(strong, settings, [], 'A');
  assert.strictEqual(allowed.allowed, true);

  const recentSignal = [{
    status: 'published',
    createdAt: new Date().toISOString(),
    editorial: { requiresTradeCard: true }
  }];
  const throttled = buildEditorialDecision(strong, settings, recentSignal);
  assert.strictEqual(throttled.setupGrade, 'A', '证据等级不应因为方向帖限流而被降级');
  assert.strictEqual(throttled.requiresTradeCard, false);
  assert.strictEqual(throttled.signalPolicy.blockedReason, 'cooldown_active');
  assert(throttled.executionInstruction.includes('禁止出现'));

  strong.editorialDecision = throttled;
  const forbidden = validatePostText(
    '做多 $RENDER ：站稳7.25再参与，止损6.9，止盈7.67。$FET 和 $BTC 只作参照，成交与结构仍支持主角。',
    strong,
    settings
  );
  assert(forbidden.errors.includes('explicit_direction_not_allowed:A'));
  assert(forbidden.errors.includes('explicit_risk_card_not_allowed:A'));
})();

(function marketPackJsonSerializable() {
  assert.doesNotThrow(() => JSON.stringify(basePack()));
})();

(function marketQualityProducesOneThesis() {
  const pack = basePack({
    marketIntel: { symbols: { RENDER: { depth: { available: true, imbalance: -31 } } } },
    chart: { klines: Array.from({ length: 32 }, (_, i) => ({ open: 7 + i * 0.01, high: 7.1 + i * 0.01, low: 6.9 + i * 0.01, close: 7.02 + i * 0.01 })) }
  });
  const event = deriveMarketEvent(pack);
  assert(event.score > 0);
  assert(event.subject === 'RENDER');
  assert(event.claim);
  assert(['orderbook_imbalance', 'late_momentum', 'liquid_momentum', 'volume_without_direction', 'relative_strength', 'momentum_shift'].includes(event.type));
  attachMarketQuality(pack);
  assert.strictEqual(pack.publishScore, pack.marketEvent.score);
  assert.doesNotThrow(() => JSON.stringify(pack.marketEvent));
})();

(function configuredNewsItemsBecomeEvidence() {
  const pack = basePack({
    externalIntel: {
      newsItems: [{ source: 'official-feed', title: 'RENDER protocol update' }]
    }
  });
  const event = deriveMarketEvent(pack);
  assert.strictEqual(event.evidenceAvailable.news, true);
  assert(event.reasons.some(x => x.reason === '存在可验证事件信息'));
})();

(function lowSignalStillPublishesText() {
  const quiet = {
    symbol: 'QUIET', bucket: 'other', price: 1, change1h: 0, change4h: 0,
    change24h: 0, volume24h: 0, amplitude24h: 0
  };
  const pack = basePack({
    trio: {
      lead: quiet,
      peer: { ...quiet, symbol: 'PEER' },
      anchor: { ...quiet, symbol: 'BTC', bucket: 'anchor' }
    },
    marketIntel: { symbols: {} },
    chart: { klines: [] }
  });
  attachMarketQuality(pack);
  assert.strictEqual(pack.marketEvent.qualityGatePassed, false);
  assert.strictEqual(pack.marketEvent.publishable, true);
  assert.strictEqual(pack.publishDecision.publishable, true);
  assert.strictEqual(pack.publishDecision.reason, 'valid_market_pack');
})();

(function freePublicDerivativesAreStructured() {
  const rows = normalizeHyperliquid({ universe: [{ name: 'RENDER', maxLeverage: 10 }] }, [{ markPx: '7.2', oraclePx: '7.19', openInterest: '100000', funding: '0.00005', premium: '0.0002', dayNtlVlm: '9000000' }]);
  assert.strictEqual(rows.RENDER.openInterestUsd, 720000);
  assert.strictEqual(rows.RENDER.fundingRateHourly, 0.00005);
  const pack = basePack({ publicDerivatives: { ok: true, symbols: rows } });
  const event = deriveMarketEvent(pack);
  assert.strictEqual(event.evidenceAvailable.publicDerivatives, true);
  assert.strictEqual(event.imageType, 'public_derivatives_panel');
  pack.marketEvent = event; pack.publishScore = event.score;
  assert.strictEqual(chooseEvidenceType(pack), 'public_derivatives_panel');
  assert(buildSvg(pack).includes('DERIVATIVES SNAPSHOT'));
})();

(function positioningWithoutPriceIsAUsefulEvent() {
  const pack = basePack({
    trio: {
      ...basePack().trio,
      lead: { ...basePack().trio.lead, change1h: 0.2, change24h: 1.1, amplitude24h: 4 }
    },
    publicDerivatives: {
      ok: true,
      symbols: {
        RENDER: { openInterestUsd: 180000000, volume24hUsd: 90000000, fundingRateHourly: 0.000001 }
      }
    }
  });
  const event = deriveMarketEvent(pack);
  assert.strictEqual(event.type, 'positioning_without_price');
  assert(evidenceFocus({ ...pack, marketEvent: event }).includes('2.0 倍'));
})();

(function tradfiChartRejectsBrokenZeroTicks() {
  const row = parseChart({ symbol: 'QQQ', group: 'macro', label: 'Nasdaq ETF' }, { chart: { result: [{ meta: { chartPreviousClose: 500, currency: 'USD' }, timestamp: [1, 2, 3], indicators: { quote: [{ close: [501, 0, 505] }] } }] } });
  assert.strictEqual(row.price, 505);
  assert.strictEqual(Number(row.change24h.toFixed(2)), 1);
})();

(function tradfiCanConfirmCryptoAiWithoutBecomingLead() {
  const pack = basePack({ tradfi: { ok: true, assets: { QQQ: { change24h: 1.2 }, SOXX: { change24h: 1.8 }, NVDA: { change24h: 2.4 }, COIN: { change24h: 0.5 }, MSTR: { change24h: 0.7 } } } });
  const event = deriveMarketEvent(pack);
  assert.strictEqual(event.subject, 'RENDER');
  assert.strictEqual(event.evidenceAvailable.tradfi, true);
  assert(event.reasons.some(x => x.reason === '传统市场与币圈方向互相验证'));
})();

(function realOrderbookCanBecomeEvidenceImage() {
  const levels = Array.from({ length: 10 }, (_, i) => ({ price: 7.1 + i * 0.01, qty: 100 + i * 10, notional: 710 + i * 90 }));
  const pack = basePack({
    trio: {
      lead: { symbol: 'RENDER', bucket: 'ai', price: 7.12, change1h: 0.2, change4h: 0.3, change24h: 1, volume24h: 82000000, amplitude24h: 3 },
      peer: { symbol: 'FET', bucket: 'ai', price: 1.21, change1h: 0.1, change4h: 0.2, change24h: 0.5, volume24h: 31000000, amplitude24h: 2 },
      anchor: { symbol: 'BTC', bucket: 'anchor', price: 68400, change1h: 0, change4h: 0.1, change24h: 0.2, volume24h: 28000000000, amplitude24h: 1 }
    },
    sector: {},
    marketIntel: { symbols: { RENDER: { depth: { available: true, imbalance: -50 }, spreadBps: 1.4, depthLevels: { bids: levels, asks: levels.map(x => ({ ...x, price: x.price + 0.2 })) } } } }
  });
  attachMarketQuality(pack);
  assert.strictEqual(pack.marketEvent.type, 'orderbook_imbalance');
  assert.strictEqual(pack.marketEvent.imageType, 'binance_orderbook_depth');
  assert.strictEqual(chooseEvidenceType(pack), 'binance_orderbook_depth');
  assert(buildSvg(pack).includes('ORDERBOOK DEPTH'));
})();

(function momentumOutranksRoutineOrderbookSnapshot() {
  const pack = basePack({
    trio: {
      ...basePack().trio,
      lead: { ...basePack().trio.lead, change1h: 3.2, change24h: 15 }
    },
    marketIntel: { symbols: { RENDER: { depth: { available: true, imbalance: -60 } } } }
  });
  assert(['late_momentum', 'liquid_momentum'].includes(deriveMarketEvent(pack).type));
})();

(function dynamicRankingBalancesLiquidityAndVolatility() {
  const rows = [
    { symbol: 'LIQUIDUSDT', quoteVolume: '1000000000', priceChangePercent: '6', highPrice: '11', lowPrice: '10', lastPrice: '10.5' },
    { symbol: 'THINUSDT', quoteVolume: '5000000', priceChangePercent: '20', highPrice: '1.4', lowPrice: '1', lastPrice: '1.2' }
  ];
  assert.strictEqual(discoverDynamicRows(rows)[0].symbol, 'LIQUIDUSDT');
  const anchors = { BTC: { change1h: 0 }, ETH: { change1h: 0 } };
  const recent = { symbolCounts: new Map(), cooldownSymbols: new Set(), last1: null, last2: [], last5: [] };
  const liquid = { symbol: 'LIQUID', bucket: 'contract-beta', change1h: 2, change24h: 6, amplitude24h: 10, volume24h: 1000000000 };
  const thin = { symbol: 'THIN', bucket: 'contract-beta', change1h: 2, change24h: 6, amplitude24h: 10, volume24h: 5000000 };
  assert(rankScore(liquid, anchors, recent, { dynamicUniverse: true }) > rankScore(thin, anchors, recent, { dynamicUniverse: true }));
  const known = { symbol: 'ZEC', bucket: 'beta', change1h: 1, change24h: 5, amplitude24h: 8, volume24h: 35000000 };
  const unknown = { ...known, symbol: 'UNKNOWN', bucket: 'contract-beta' };
  assert(rankScore(known, anchors, recent, { dynamicUniverse: true }) > rankScore(unknown, anchors, recent, { dynamicUniverse: true }));
})();

(function focusedPromptOmitsHugeMarketPack() {
  const pack = basePack({
    hiddenMarketPackMarker: 'DO_NOT_SEND_FULL_PACK',
    marketEvent: { type: 'relative_strength', score: 62, claim: 'RENDER 相对强度更高' },
    externalIntel: {
      macroNotes: '只保留这条可公开人工备注。',
      onchainApiKeys: { alchemy: 'secret-key-must-never-enter-llm-prompt' }
    }
  });
  const rendered = renderTemplate('{{MARKET_PACK_JSON}}\n{{EXTERNAL_INTEL_JSON}}', pack, baseSettings());
  assert(!rendered.includes('DO_NOT_SEND_FULL_PACK'));
  assert(!rendered.includes('secret-key-must-never-enter-llm-prompt'));
  assert(rendered.includes('只保留这条可公开人工备注。'));
  assert(rendered.includes('alchemy'));
  assert(rendered.includes('relative_strength'));
  assert(rendered.includes('RENDER'));
  const safeIntel = safeExternalIntel(pack);
  assert.strictEqual(safeIntel.onchainApiKeys, undefined);
  assert.deepStrictEqual(safeIntel.onchainProviders, ['alchemy']);
  const safePack = promptSafeMarketPack(pack);
  assert.strictEqual(safePack.hiddenMarketPackMarker, undefined);
  assert.strictEqual(safePack.externalIntel.onchainApiKeys, undefined);
})();

(function focusedBuiltInPromptKeepsCashtagBoundaryRule() {
  const rendered = renderTemplate(template, basePack(), baseSettings());
  assert(rendered.includes(evidenceFocus(basePack())));
  assert(rendered.includes('每个 Cashtag 后必须留一个半角空格'));
})();

(function everyMarketSymbolBecomesClickableCashtag() {
  const raw = '真正有变化的是 RENDER，FET 与 BTC 只作参照；美股 COIN、MSTR 和 QQQ 同时走强，AI 板块只能作背景。已有 $NVDA 不应重复加符号，价格 $7.25 也不能被改写。';
  const normalized = normalizeCashtags(raw, basePack(), baseSettings());
  for (const symbol of ['RENDER', 'FET', 'BTC', 'COIN', 'MSTR', 'QQQ', 'NVDA']) {
    assert(new RegExp(`\\$${symbol}(?=\\s|$)`).test(normalized), `${symbol} should have a clickable cashtag boundary`);
  }
  assert(normalized.includes('AI 板块'));
  assert(!normalized.includes('$AI 板块'));
  assert(!normalized.includes('$$'));
  assert(normalized.includes('价格 $7.25'));
  assert.strictEqual(normalizeCashtags(normalized, basePack(), baseSettings()), normalized, 'cashtag normalization must be idempotent');
})();

(function squareMobileCashtagBoundaryRegression() {
  const pack = basePack({
    trio: {
      lead: { ...basePack().trio.lead, symbol: 'TLM' },
      peer: { ...basePack().trio.peer, symbol: 'SOL' },
      anchor: { ...basePack().trio.anchor, symbol: 'ETH' }
    }
  });
  const settings = baseSettings({ squareTagSymbols: ['TLM', 'SOL', 'ETH', 'PEPE', 'XRP', 'BTC', 'RE'] });
  const raw = '大涨后短线回落的$TLM这次掉速。和$SOL、$ETH比，$PEPE相对$XRP、$BTC只多出一点；但 $RE 1h 更强。';
  const normalized = normalizeCashtags(raw, pack, settings);
  for (const symbol of ['TLM', 'SOL', 'ETH', 'PEPE', 'XRP', 'BTC', 'RE']) {
    assert(new RegExp(`\\$${symbol}(?=\\s|$)`).test(normalized), `${symbol} should be yellow/clickable on Square`);
  }
  assert(normalized.includes('$TLM 这次'));
  assert(normalized.includes('$SOL 、$ETH 比'));
  assert.strictEqual(normalizeCashtags(normalized, pack, settings), normalized);
})();

(function validationReturnsNormalizedTextForPublisher() {
  const raw = '成交重新集中到 RENDER，FET 与 BTC 都没有同步放量；美股 COIN 和 QQQ 只作情绪参照，这次变化更像主角自己的量价选择。';
  const validation = validatePostText(raw, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 300 }));
  for (const symbol of ['RENDER', 'FET', 'BTC', 'COIN', 'QQQ']) assert(new RegExp(`\\$${symbol}(?=\\s|$)`).test(validation.text));
  assert(!/(^|[^$A-Z0-9])(RENDER|FET|BTC|COIN|QQQ)(?=$|[^A-Z0-9])/.test(validation.text));
})();

(function dynamicallySelectedSymbolAlsoBecomesCashtag() {
  const pack = basePack({
    trio: {
      lead: { ...basePack().trio.lead, symbol: 'NEWCOIN' },
      peer: basePack().trio.peer,
      anchor: basePack().trio.anchor
    }
  });
  assert(normalizeCashtags('真正有变化的是 NEWCOIN，FET 与 BTC 只作参照。', pack, baseSettings()).includes('$NEWCOIN'));
})();

(function bannedPhraseValidation() {
  const text = '$RENDER 这波就是主线，$FET 只是参照，$BTC 没拖后腿；站上 $7.25 再看，跌回 $6.90 就放弃。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 300 }));
  assert(validation.errors.some(e => e.includes('banned_phrase:主线')));
})();

(function aiLikeMetaphorValidation() {
  const text = '成交还在，$RENDER 却没有继续接戏；$FET 与 $BTC 只作参照，这里更像多空在争。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 300 }));
  assert(validation.errors.some(e => e.includes('banned_phrase:接戏')));
  assert(validation.errors.some(e => e.includes('banned_phrase:多空在争')));
})();

(function repeatedWordsAndGenericOpeningAreRejected() {
  const text = 'RENDER价格没走远，价格仍在区间，价格也没有脱离大盘；$RENDER 与 $FET、$BTC 强弱接近。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 300 }));
  assert(validation.errors.some(e => e.startsWith('repeated_word:价格:')));
  const generic = '大盘没有给出清晰信号。$RENDER 与 $FET、$BTC 仍然同步，暂时看不出独立变化。';
  const genericValidation = validatePostText(generic, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 300 }));
  assert(genericValidation.errors.includes('lead_missing_from_opening'));
})();

(function formulaicTradePlanValidation() {
  const text = '$RENDER 计划偏多，$FET 和 $BTC 参照看；条件计划是突破 $7.25 再看，跌回 $6.90 就放弃。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 300 }));
  assert(validation.errors.some(e => e.includes('banned_phrase:计划偏多')));
  assert(validation.errors.some(e => e.includes('banned_phrase:条件计划')));
})();

(function formulaicMetricsValidation() {
  const text = '$RENDER 现价7.12，1h +2.4%、4h +4.1%、24h +9.8%，成交额8200万，前20档买盘厚，点差很小；$FET 和 $BTC 只做参照，突破 $7.25 再看。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 300 }));
  assert(validation.errors.some(e => e.startsWith('too_many_metrics:')));
})();

(function repeatedMetricNameDoesNotCountAsNewMetrics() {
  const text = 'RENDER 的跨所持仓不低，但持仓本身没有推动短线脱离大盘；24h成交额可以参考，$RENDER 与 $FET、$BTC 仍接近。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 300 }));
  assert(!validation.errors.some(e => e.startsWith('too_many_metrics:')));
})();

(function factualLabelsAreNotStyleBans() {
  const text = '最容易被忽略的是量价没有同步，$RENDER 1h 仍强于 $FET，$BTC 只是横盘；24h 涨幅可以参考，但不是唯一结论。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 300, bannedPhrases: ['现价', '1h', '4h', '24h'] }));
  assert(!validation.errors.some(e => /banned_phrase:(现价|1h|4h|24h)/.test(e)));
})();

(function cashtagOpeningIsAllowedWhenTheSentenceHasAThesis() {
  const text = '$RENDER 的真正变化在成交结构，$FET 和 $BTC 都没有同步放量，注意力明显偏向一边。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 300 }));
  assert(!validation.errors.includes('formulaic_opening'));
})();

(function repeatedPanZhongOpeningIsRejected() {
  const text = '盘中看到 $RENDER 成交开始放大，$FET 和 $BTC 只作参照；主角若能继续放量，当前判断才有延续依据。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 300 }));
  assert(validation.errors.includes('formulaic_opening'));
})();

(function lengthValidation() {
  const text = '$RENDER $FET $BTC 太短';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 80, maxPostChars: 120 }));
  assert(validation.errors.some(e => e.startsWith('too_short:')));
})();

(function configuredMinimumIsEnforcedExactly() {
  const text = '成交没有跟着涨幅一起放大，$RENDER 看起来强，实际还缺一轮主动成交；$FET 和 $BTC 同期更平，主角若继续放量，才有理由提高评价。';
  const length = [...normalizeCashtags(text, basePack(), baseSettings())].length;
  const tooShort = validatePostText(text, basePack(), baseSettings({ minPostChars: length + 1, maxPostChars: 300 }));
  assert(tooShort.errors.some(e => e === `too_short:${length}`));
  const exact = validatePostText(text, basePack(), baseSettings({ minPostChars: length, maxPostChars: 300 }));
  assert(!exact.errors.some(e => e.startsWith('too_short:')));
})();

(function richDraftGetsOnlyTenCharacterTolerance() {
  const text = `成交开始集中到 $RENDER ，但还需要说明资金为什么愿意留下；$FET 和 $BTC 只作一次参照。${'这句话补充的是新的成交证据，不是重复结论。'.repeat(6)}`;
  const length = [...normalizeCashtags(text, basePack(), baseSettings())].length;
  const withinTolerance = validatePostText(text, basePack(), baseSettings({ minPostChars: length + 10, maxPostChars: 500 }));
  assert(!withinTolerance.errors.some(e => e.startsWith('too_short:')));
  const outsideTolerance = validatePostText(text, basePack(), baseSettings({ minPostChars: length + 11, maxPostChars: 500 }));
  assert(outsideTolerance.errors.includes(`too_short:${length}`));
})();

(function tinyPriceLevelsStayHumanReadable() {
  assert.strictEqual(humanPriceLevel(0.00246642), '0.002466');
  assert.strictEqual(humanPriceLevel(1.94321), '1.943');
  assert.strictEqual(humanPriceLevel(88.1234), '88.12');
  const pack = basePack({ tradePlan: { symbol: 'TLM', bias: '偏空', direction: 'short', trigger: 0.00192731, stopLoss: 0.00246642 } });
  const rendered = formatTradePlanForPrompt(pack.tradePlan);
  assert(rendered.includes('0.001927'));
  assert(rendered.includes('0.002466'));
  assert(!rendered.includes('0.00246642'));
})();

(function paragraphLayoutRemainsEditorialNotAPublishGate() {
  const sentence = '成交没有跟着涨幅一起放大，$RENDER 的优势仍需要真实买盘验证；$FET 和 $BTC 同期偏平。';
  const oneLine = `${sentence}${'这段证据只说明主角暂时领先，但还不能把短线变化直接外推。'.repeat(4)}`;
  const oneLineValidation = validatePostText(oneLine, basePack(), baseSettings({ minPostChars: 180, maxPostChars: 500 }));
  assert(!oneLineValidation.errors.includes('missing_paragraph_break'));
  const twoParagraphs = oneLine.replace('。这段证据', '。\n\n这段证据');
  const twoParagraphValidation = validatePostText(twoParagraphs, basePack(), baseSettings({ minPostChars: 180, maxPostChars: 500 }));
  assert(!twoParagraphValidation.errors.includes('missing_paragraph_break'));
})();

(function referenceCashtagsCannotBeRepeated() {
  const text = '成交开始集中到 $RENDER ，它的相对表现先于同组转强。\n\n$FET 和 $BTC 只作一次参照，但 $FET 再次出现就会让正文退化成三币复盘。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 500 }));
  assert(validation.errors.includes('cashtag_repeated:FET:2'));
})();

(function unavailablePlaceholderValidation() {
  const text = '$RENDER 先不追，$FET 和 $BTC 只做参照；暂无可用美股/ETF行情数据，本轮不使用美股作为判断依据，站上 $7.25 再看。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 260 }));
  assert(validation.errors.some(e => e.includes('banned_phrase:暂无可用美股/ETF行情数据')));
})();

(function mediaHelpers() {
  assert.strictEqual(getContentType('/tmp/a.png'), 'image/png');
  assert.strictEqual(getContentType('/tmp/a.jpg'), 'image/jpeg');
  assert.strictEqual(getContentType('/tmp/a.mp4'), 'video/mp4');
  assert(resolveImagePath('images/test.png').endsWith('/data/images/test.png'));
  assert.deepStrictEqual(selectImagePaths({ enableImagePosts: false, imagePaths: ['images/a.png'] }), []);
  assert.deepStrictEqual(selectImagePaths({ enableImagePosts: true, imagePostMode: 'static', imagePathCount: 1, imagePaths: ['images/a.png', 'images/b.png'] }), ['images/a.png']);
})();

(function squareSkillV2PublishBodiesAndGatewayTimeout() {
  assert.strictEqual(CONTENT_TYPES.short, 1);
  assert.strictEqual(CONTENT_TYPES.article, 2);
  assert.strictEqual(CONTENT_TYPES.video, 3);
  assert.deepStrictEqual(buildPublishBody('短帖正文'), {
    contentType: 1,
    bodyTextOnly: '短帖正文'
  });
  assert.deepStrictEqual(buildPublishBody('图文正文', { format: 'short', imageUrls: ['https://img/1.png', 'https://img/2.png'] }), {
    contentType: 1,
    bodyTextOnly: '图文正文',
    imageList: ['https://img/1.png', 'https://img/2.png']
  });
  assert.deepStrictEqual(buildPublishBody('长文正文', { format: 'article', title: '行情拆解', coverUrl: 'https://img/cover.png' }), {
    contentType: 2,
    bodyTextOnly: '长文正文',
    title: '行情拆解',
    cover: 'https://img/cover.png'
  });
  assert.deepStrictEqual(buildPublishBody('视频说明', {
    format: 'video', fileTicket: 'ticket-1', coverUrl: 'https://img/cover.png', durationSeconds: 8.5
  }), {
    contentType: 3,
    fileTicket: 'ticket-1',
    cover: 'https://img/cover.png',
    videoTimeSeconds: 8.5,
    isPublish: true,
    bodyTextOnly: '视频说明'
  });
  assert.throws(() => buildPublishBody('超量', { imageUrls: ['1', '2', '3', '4', '5'] }), /too_many_images/);
  assert.deepStrictEqual(parsePublishResponse(504, '<html>gateway timeout</html>'), {
    id: null,
    shareLink: null,
    publishStatus: 'success_without_post_id',
    confirmation: 'gateway_timeout_after_submission'
  });
  assert.throws(
    () => parsePublishResponse(200, JSON.stringify({ code: '220014', message: 'upload limit' })),
    /daily_upload_limit_exceeded/
  );
})();

(function coinglassEvidenceSummariesAndImageMode() {
  assert.strictEqual(pairSymbol('PEPE'), '1000PEPEUSDT');
  const evidence = summarizeCoinglassEvidence({
    base: 'BTC',
    pair: 'BTCUSDT',
    results: [
      {
        name: 'heatmap',
        ok: true,
        data: {
          y_axis: [99, 100, 101, 102, 103],
          liquidation_leverage_data: Array.from({ length: 18 }, (_, i) => [i % 6, i % 5, 80000 + i * 25000]),
          price_candlesticks: [
            [1722676500, '100', '101', '99', '100.5', '1000000'],
            [1722677400, '100.5', '102', '100', '101.2', '1200000'],
            [1722678300, '101.2', '102.4', '100.7', '101.8', '900000']
          ]
        }
      },
      { name: 'liquidation', ok: true, data: [{ time: 1, long_liquidation_usd: '10', short_liquidation_usd: '20' }] },
      { name: 'orderbookAskBids', ok: true, data: [{ time: 1, bids_usd: 100, asks_usd: 80 }] },
      { name: 'openInterest', ok: true, data: [{ time: 1, close: 100 }, { time: 2, close: 110 }] },
      { name: 'longShort', ok: true, data: [{ time: 1, global_account_long_percent: 55, global_account_short_percent: 45, global_account_long_short_ratio: 1.22 }] }
    ]
  });
  assert.strictEqual(evidence.ok, true);
  assert.strictEqual(evidence.heatmap.available, true);
  assert(evidence.heatmap.summary.topAbove);
  const pack = basePack({ coinglass: evidence });
  assert.strictEqual(chooseEvidenceType(pack), 'coinglass_liquidation_heatmap');
  assert(buildSvg(pack).includes('LIQUIDATION HEATMAP'));
})();

console.log('prompt fixture tests passed');
