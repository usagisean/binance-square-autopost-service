const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateVolumeRatioText } = require('../src/contentEvidence');
const { shouldReferenceTradfi, renderGenerationPrompt, validatePostText, selectHumorStyle } = require('../src/generator');
const { buildSvg, chooseEvidenceType, generateMarketCard } = require('../src/imageCard');

const settings = { minPostChars: 1, maxPostChars: 600, requireCashtags: true,
  requireTrioCashtags: false, includeTradePlan: false, tradePlanMode: 'off',
  bannedPhrases: [], similarityThreshold: 0.99 };
function packFor(extra = {}) {
  return { generatedAt: '2026-11-10T08:00:00Z', source: 'offline-fixture',
    trio: { lead: { symbol: 'TEST', price: 10, change1h: 2, change24h: 4 },
      peer: { symbol: 'BTC' }, anchor: { symbol: 'ETH' } },
    marketEvent: { type: 'late_momentum', score: 55, stance: 'bullish', claim: 'TEST 短线走强' },
    editorialDecision: { version: 6, requiresTradeCard: false, setupGrade: 'B' },
    facts: ['TEST 最近1h上涨2%'], takeaways: [], ...extra };
}

const evidence = { available: true, volumeRatio: 0.24, volumeTrend: 'contracting' };
const ratioText = value => `$TEST 最近已收盘1h成交量仅为前4h每小时均值的${value}，短线偏多但量能收缩。`;
for (const value of ['0.24倍', '24%', '24％']) {
  assert.deepEqual(validateVolumeRatioText(ratioText(value), evidence), [], value);
  assert.equal(validatePostText(ratioText(value), packFor({ contentEvidence: evidence }), settings).ok, true);
}
for (const value of ['0.24%', '0.24％', '24倍', '2.4倍']) {
  assert(validatePostText(ratioText(value), packFor({ contentEvidence: evidence }), settings)
    .errors.includes('volume_ratio_value_or_unit_mismatch'), value);
}
assert.deepEqual(validateVolumeRatioText('量比为0.5倍', { available: true, volumeRatio: 0.5 }), []);
assert.deepEqual(validateVolumeRatioText('成交量约为均值的0倍', { available: true, volumeRatio: 0 }), []);
assert.deepEqual(validateVolumeRatioText('BTC上涨0.24%，成交量为均值的24%', evidence), []);
assert.deepEqual(validateVolumeRatioText(ratioText('0.24%'), null), []);

const stocks = { usable: true, relevant: [{ symbol: 'MSTR', name: 'Strategy', change24h: -2, timestamp: '2026-11-09T20:00:00Z' }] };
const ordinary = packFor({ tradfiSignal: stocks });
assert.equal(shouldReferenceTradfi(ordinary), false);
assert(!validatePostText('$TEST 短线偏多，价格和成交的矛盾值得留意。', ordinary, settings).errors.includes('missing_tradfi_reference'));
const cross = packFor({ tradfiSignal: stocks, marketEvent: { type: 'cross_market_confirmation' } });
assert.equal(shouldReferenceTradfi(cross), true);
assert(validatePostText('$TEST 短线偏多，价格和成交的矛盾值得留意。', cross, settings).errors.includes('missing_tradfi_reference'));
assert(!shouldReferenceTradfi(packFor({ tradfiSignal: { usable: false, relevant: stocks.relevant } })));
assert.equal(selectHumorStyle(packFor()).id, 'none');

const legacy = { content: '本轮交易卡（最高优先级）：{{TRADE_CARD}}\n首句硬规则：每次必须以做多开头。' };
const original = legacy.content;
const normalized = renderGenerationPrompt(legacy, packFor(), settings);
assert(!normalized.includes('每次必须以做多开头'));
assert(normalized.includes('本轮不是交易卡'));
assert(!/\{\{[A-Z_]+\}\}/.test(normalized));
assert.equal(legacy.content, original, 'stored prompt must not be mutated');
assert(renderGenerationPrompt({ content: '我的独立自定义模板 {{LEAD}}' }, packFor(), settings).includes('我的独立自定义模板 TEST'));

const rows = Array.from({ length: 24 }, (_, i) => ({ openTime: 1794268800000 + i * 900000,
  open: 10 + i * 0.01, high: 10.2 + i * 0.01, low: 9.9 + i * 0.01, close: 10.1 + i * 0.01 }));
const chartPack = packFor({ chart: { interval: '15m', klines: rows } });
assert.equal(chooseEvidenceType(chartPack), 'chart_snapshot');
const chartSvg = buildSvg(chartPack, '$TEST 价格变化需要成交证据。');
assert(chartSvg.includes('width="1080" height="1080"'));
assert(chartSvg.includes('真实记录'));
assert.notEqual(chartSvg, buildSvg(chartPack, '$TEST 这是一条不同的观察。'), 'the post must affect the graphic');
assert.equal(chooseEvidenceType(packFor()), null);
assert.equal(buildSvg(packFor({ chart: { klines: [] } })), null, 'never fabricate chart data');
assert.equal(buildSvg({ ...chartPack, cacheFallback: true }), null, 'cached fallback is not a current evidence graphic');
assert.equal(buildSvg(packFor({ chart: { klines: rows.slice(0, 19) } })), null);
assert.equal(buildSvg(packFor({ chart: { klines: rows.map(r => ({ ...r, openTime: null })) } })), null);
const withForming = structuredClone(chartPack);
withForming.chart.klines.push({ ...rows.at(-1), openTime: Date.parse(withForming.generatedAt), closeTime: Date.parse(withForming.generatedAt) + 900000 - 1, close: 10.2 });
assert.equal(buildSvg(withForming), buildSvg(chartPack), 'forming candles must not enter a closed-price chart');
const expensive = structuredClone(chartPack);
expensive.chart.klines = rows.map(row => ({ ...row, open: 10000, high: 10010, low: 9990, close: 10000 }));
assert(buildSvg(expensive).includes('10000'), 'integer price zeros must not be stripped');

const derivativePack = packFor({ marketEvent: { type: 'funding_dislocation', imageType: 'public_derivatives_panel' },
  publicDerivatives: { ok: true, fetchedAt: '2026-11-10T08:00:00Z', symbols: { TEST: {
    fundingRateHourly: -0.00005, openInterestUsd: 10000000, volume24hUsd: 20000000 } } } });
assert(buildSvg(derivativePack).includes('-0.0050%'));
const zero = structuredClone(derivativePack); zero.publicDerivatives.symbols.TEST.fundingRateHourly = 0;
assert(buildSvg(zero).includes('当前费率为零'));
const absent = structuredClone(derivativePack); absent.publicDerivatives.symbols.TEST = {};
assert.equal(buildSvg(absent), null, 'missing is not zero');
const availableButIrrelevant = { ...chartPack, publicDerivatives: derivativePack.publicDerivatives };
assert.equal(chooseEvidenceType(availableButIrrelevant), 'chart_snapshot', 'thesis outranks provider availability');
const escaped = buildSvg({ ...derivativePack, marketEvent: derivativePack.marketEvent }, '<script>alert(1)</script>');
assert(!escaped.includes('<script>'));
assert(escaped.includes('&lt;script&gt;'));

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'square-editorial-refresh-'));
  try {
    const absentDir = path.join(temp, 'missing-data');
    assert.equal(await generateMarketCard(packFor(), 'no data', { dir: absentDir }), null);
    assert(!fs.existsSync(absentDir), 'no output or upload artifact for missing data');
    const file = await generateMarketCard(derivativePack, '$TEST 示例，不是真实行情。', { dir: temp });
    assert(fs.readFileSync(file).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    console.log('editorial refresh tests passed (offline; no LLM, publish or runtime-data writes)');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
