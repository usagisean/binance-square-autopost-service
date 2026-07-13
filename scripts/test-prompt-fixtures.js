const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { renderTemplate, validatePostText, selectPostAngle } = require('../src/generator');
const { getContentType, resolveImagePath } = require('../src/mediaUploader');
const { selectImagePaths } = require('../src/imageAssets');
const { summarizeCoinglassEvidence, pairSymbol } = require('../src/coinglass');
const { buildSvg, chooseEvidenceType } = require('../src/imageCard');
const { deriveMarketEvent, attachMarketQuality } = require('../src/marketQuality');
const { normalizeHyperliquid } = require('../src/publicDerivatives');
const { parseChart } = require('../src/tradfi');

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
  assert(rendered.includes('暂无可用美股/ETF行情数据。'));
  assert(rendered.includes('美股参照数据缺失，本轮不使用美股作为判断依据。'));
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
  assert(['orderbook_imbalance', 'late_momentum', 'relative_strength'].includes(event.type));
  attachMarketQuality(pack);
  assert.strictEqual(pack.publishScore, pack.marketEvent.score);
  assert.doesNotThrow(() => JSON.stringify(pack.marketEvent));
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
  const pack = basePack({ marketIntel: { symbols: { RENDER: { depth: { available: true, imbalance: -31 }, spreadBps: 1.4, depthLevels: { bids: levels, asks: levels.map(x => ({ ...x, price: x.price + 0.2 })) } } } } });
  attachMarketQuality(pack);
  assert.strictEqual(pack.marketEvent.type, 'orderbook_imbalance');
  assert.strictEqual(pack.marketEvent.imageType, 'binance_orderbook_depth');
  assert.strictEqual(chooseEvidenceType(pack), 'binance_orderbook_depth');
  assert(buildSvg(pack).includes('ORDERBOOK DEPTH'));
})();

(function bannedPhraseValidation() {
  const text = '$RENDER 这波就是主线，$FET 只是参照，$BTC 没拖后腿；站上 $7.25 再看，跌回 $6.90 就放弃。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 300 }));
  assert(validation.errors.some(e => e.includes('banned_phrase:主线')));
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
  assert(validation.errors.includes('formulaic_opening'));
})();

(function lengthValidation() {
  const text = '$RENDER $FET $BTC 太短';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 80, maxPostChars: 120 }));
  assert(validation.errors.some(e => e.startsWith('too_short:')));
})();

(function configuredMinHasSafetyFloor() {
  const text = '$RENDER 这波别只看它涨，AI币池里真正有人多看一眼的票不多；$FET 比它弱，$BTC 又没把气氛托起来。它要是连 $7.25 都拿不回来，热度很容易被别的票抢走。真想看，也得等它先把上面那层卖盘吃掉一点，不然就是白热闹。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 140, maxPostChars: 260 }));
  assert(!validation.errors.some(e => e.startsWith('too_short:')));
})();

(function unavailablePlaceholderValidation() {
  const text = '$RENDER 先不追，$FET 和 $BTC 只做参照；暂无可用美股/ETF行情数据，本轮不使用美股作为判断依据，站上 $7.25 再看。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 260 }));
  assert(validation.errors.some(e => e.includes('banned_phrase:暂无可用美股/ETF行情数据')));
})();

(function mediaHelpers() {
  assert.strictEqual(getContentType('/tmp/a.png'), 'image/png');
  assert.strictEqual(getContentType('/tmp/a.jpg'), 'image/jpeg');
  assert(resolveImagePath('images/test.png').endsWith('/data/images/test.png'));
  assert.deepStrictEqual(selectImagePaths({ enableImagePosts: false, imagePaths: ['images/a.png'] }), []);
  assert.deepStrictEqual(selectImagePaths({ enableImagePosts: true, imagePostMode: 'static', imagePathCount: 1, imagePaths: ['images/a.png', 'images/b.png'] }), ['images/a.png']);
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
