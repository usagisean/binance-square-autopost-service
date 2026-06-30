const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { renderTemplate, validatePostText, selectPostAngle } = require('../src/generator');
const { getContentType, resolveImagePath } = require('../src/mediaUploader');

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
})();

console.log('prompt fixture tests passed');
