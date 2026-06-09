const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { renderTemplate, validatePostText, selectPostAngle } = require('../src/generator');

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
    tradePlanMode: 'conditional',
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
  assert(['btc_not_confirming', 'chase_risk', 'crypto_ai_confirmed'].includes(angle.id));
  assert(rendered.includes('追高容错低'));
})();

(function marketPackJsonSerializable() {
  assert.doesNotThrow(() => JSON.stringify(basePack()));
})();

(function bannedPhraseValidation() {
  const text = '$RENDER 这波就是主线，$FET 只是参照，$BTC 没拖后腿；站上 $7.25 再看，跌回 $6.90 就放弃。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 300 }));
  assert(validation.errors.some(e => e.includes('banned_phrase:主线')));
})();

(function lengthValidation() {
  const text = '$RENDER $FET $BTC 太短';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 80, maxPostChars: 120 }));
  assert(validation.errors.some(e => e.startsWith('too_short:')));
})();

(function unavailablePlaceholderValidation() {
  const text = '$RENDER 先不追，$FET 和 $BTC 只做参照；暂无可用美股/ETF行情数据，本轮不使用美股作为判断依据，站上 $7.25 再看。';
  const validation = validatePostText(text, basePack(), baseSettings({ minPostChars: 1, maxPostChars: 260 }));
  assert(validation.errors.some(e => e.includes('banned_phrase:暂无可用美股/ETF行情数据')));
})();

console.log('prompt fixture tests passed');
