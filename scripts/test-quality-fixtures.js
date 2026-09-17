const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { buildContentEvidence, contentEvidenceInstruction } = require('../src/contentEvidence');
const { publicationPolicy } = require('../src/publicationPolicy');
const { evidenceFamilies } = require('../src/editorialStrategy');
const { validatePostText, renderTemplate, maxRecentTemplateSimilarity, evidenceFocus } = require('../src/generator');

const now = Date.parse('2026-09-17T08:00:00Z');
const step = 15 * 60 * 1000;
function packFor(extra = {}) {
  return {
    ok: true, source: 'offline-fixture', publishScore: 68,
    marketEvent: { type: 'late_momentum', score: 68, stance: 'bullish' },
    trio: {
      lead: { symbol: 'ONE', price: 0.0014, change1h: 7.64, change24h: 105.8, volume24h: 14100000 },
      peer: { symbol: 'SOL', change1h: 0.2 }, anchor: { symbol: 'ETH', change1h: 0.1 }
    },
    chart: { interval: '15m', source: 'fixture', klines: Array.from({ length: 20 }, (_, i) => ({
      high: 0.00145, low: 0.0013, close: 0.0014, volume: i >= 16 ? 200 : 100,
      quoteVolume: i >= 16 ? 20 : 10, closeTime: now - (19 - i) * step - 1
    })) },
    ...extra
  };
}

const valid = buildContentEvidence(packFor(), now);
assert.equal(valid.available, true);
assert.equal(valid.volumeRatio, 2);
assert.equal(valid.volumeUnit, 'quote_asset');
assert.equal(valid.volumeTrend, 'expanding');
assert.equal(valid.recentHigh, 0.00145);
assert.equal(valid.closedThrough, '2026-09-17T07:59:59.999Z');

const partial = packFor();
partial.chart.klines.push({ ...partial.chart.klines.at(-1), closeTime: now + step - 1, quoteVolume: 9999999 });
assert.equal(buildContentEvidence(partial, now).volumeRatio, 2, 'forming candle must not inflate volume');
const baseVolume = packFor();
baseVolume.chart.klines.forEach(row => { row.quoteVolume = null; });
assert.equal(buildContentEvidence(baseVolume, now).volumeUnit, 'base_asset');
assert.equal(buildContentEvidence(baseVolume, now).volumeRatio, 2);
const missing = packFor(); missing.chart.klines[2].volume = null; missing.chart.klines[2].quoteVolume = null;
assert.equal(buildContentEvidence(missing, now).available, false);
const gaps = packFor(); gaps.chart.klines[5].closeTime -= 1;
assert.equal(buildContentEvidence(gaps, now).reason, 'non_contiguous_candles');
assert.equal(buildContentEvidence(packFor(), now + 2 * step).reason, 'stale_candles');
assert.equal(buildContentEvidence(packFor({ cacheFallback: true }), now).reason, 'cached_market_snapshot');
const zeroBaseline = packFor(); zeroBaseline.chart.klines.slice(0, 16).forEach(row => { row.quoteVolume = 0; });
assert.equal(buildContentEvidence(zeroBaseline, now).volumeRatio, null);
assert.equal(buildContentEvidence(zeroBaseline, now).volumeTrend, 'unknown');
assert(contentEvidenceInstruction(packFor({ contentEvidence: valid })).includes('最近已收盘 1h / 前 4h 每小时均值'));
assert(!evidenceFamilies(packFor({ marketIntel: { symbols: { ONE: { fundingRate: null, takerBuySellRatio: '', openInterestValueChange5m: null } } } })).includes('binance_derivatives'));
assert(evidenceFocus(packFor({ marketEvent: { type: 'funding_dislocation' }, publicDerivatives: { symbols: { ONE: { fundingRateHourly: 0.00004 } } } })).includes('+0.0040%'));
assert(evidenceFocus(packFor({ marketEvent: { type: 'crowded_positioning' }, coinglass: { longShort: { longPercent: 65, shortPercent: 35 } } })).includes('多头 65.0%'));

const settings = { enableQualityGate: true, minPublishScore: 58 };
assert.equal(publicationPolicy(packFor(), settings, [], now).allowed, true);
assert.equal(publicationPolicy(packFor({ publishScore: 47 }), settings, [], now).allowed, false);
assert.equal(publicationPolicy(packFor({ marketEvent: { type: 'low_signal' } }), settings, [], now).allowed, false);
assert.equal(publicationPolicy(packFor({ cacheFallback: true }), settings, [], now).allowed, false);
assert.equal(publicationPolicy(packFor({ cacheFallback: true }), { enableQualityGate: false }, [], now).allowed, true);
const history = [{ id: 'prior', status: 'published', createdAt: new Date(now - step).toISOString(),
  lead: 'ONE', marketEvent: { type: 'late_momentum' }, marketSnapshot: { price: 0.0014, change1h: 7.64 } }];
assert.equal(publicationPolicy(packFor(), settings, history, now).reason, 'same_subject_event_within_2h');
assert.equal(publicationPolicy(packFor({ trio: { ...packFor().trio, lead: { ...packFor().trio.lead, change1h: 9.2 } } }), settings, history, now).allowed, true);
assert.equal(publicationPolicy(packFor({ trio: { ...packFor().trio, lead: { ...packFor().trio.lead, price: 0.00145 } } }), settings, history, now).allowed, true);
assert.equal(publicationPolicy(packFor(), settings, [{ ...history[0], status: 'preview' }], now).allowed, true);
assert.equal(publicationPolicy(packFor(), settings, [{ ...history[0], createdAt: new Date(now - 3 * 60 * 60 * 1000).toISOString() }], now).allowed, true);

const writingSettings = { minPostChars: 1, maxPostChars: 350, requireCashtags: true, requireTrioCashtags: false,
  includeTradePlan: false, tradePlanMode: 'off', similarityThreshold: 0, bannedPhrases: [] };
const focused = '$ONE 最近一小时上涨 7.64%，日内涨幅已超一倍。两者同向，但不能由此确认趋势会延续。';
assert.equal(validatePostText(focused, packFor(), writingSettings).ok, true);
assert(validatePostText(focused, packFor(), { ...writingSettings, requireTrioCashtags: true }).errors.includes('missing_cashtag:SOL'));
assert(validatePostText(focused.replace('$ONE', '$SOL'), packFor(), writingSettings).errors.includes('missing_cashtag:ONE'));
assert(validatePostText(`${focused} $BTC 只是额外参照。`, packFor(), writingSettings).errors.includes('unexpected_cashtag:BTC'));
const volumeClaim = '$ONE 短线成交正在放大，说明价格上涨得到了量能配合。';
assert(validatePostText(volumeClaim, packFor(), writingSettings).errors.includes('unsupported_short_window_volume_claim'));
assert(!validatePostText(volumeClaim, packFor({ contentEvidence: valid }), writingSettings).errors.includes('unsupported_short_window_volume_claim'));
assert(!validatePostText('$ONE 如果短线成交放大，才有进一步验证的依据。', packFor(), writingSettings).errors.includes('unsupported_short_window_volume_claim'));
assert(!validatePostText('$ONE 不能把 24h 成交规模当成短线放量。', packFor(), writingSettings).errors.includes('unsupported_short_window_volume_claim'));
assert(validatePostText(`${focused} 0.001448 是赔率开关。`, packFor(), writingSettings).errors.includes('banned_phrase:赔率开关'));
const original = '$ONE 最近1h +7.64%，24h +105.80%。重点不是涨幅，而是相对优势是否持续。若短线差异消失，就不能再把这项变化当作趋势延续。';
const swapped = original.replace('$ONE', '$HEI').replace('7.64', '5.41').replace('105.80', '15.68');
assert.equal(maxRecentTemplateSimilarity(swapped, [{ status: 'published', postText: original }]), 1);
assert.equal(maxRecentTemplateSimilarity(swapped, [{ status: 'preview', postText: original }]), 0);
const template = fs.readFileSync(path.join(__dirname, '../templates/default-prompt.md'), 'utf8');
const rendered = renderTemplate(template, packFor({ contentEvidence: valid }), writingSettings);
assert(!/\{\{[A-Z_]+\}\}/.test(rendered));
assert(rendered.includes('可不出现'));
assert(rendered.includes('last_closed_1h_vs_previous_4h_hourly_average'));

// Exercise startup migration and persistence without touching real data/secrets.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'square-quality-test-'));
try {
  const data = path.join(temporary, 'data'); fs.mkdirSync(data);
  fs.mkdirSync(path.join(temporary, 'templates'));
  fs.writeFileSync(path.join(temporary, 'templates/default-prompt.md'), template);
  const custom = { id: 'custom', name: '我的自定义', content: 'custom-content', active: true };
  fs.writeFileSync(path.join(data, 'prompts.json'), JSON.stringify([custom]));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ editorialStrategyVersion: 3, enabled: true, publishMode: 'live', enableQualityGate: false, minPublishScore: 47, maxActionablePostsDaily: 7, tradePlanMode: 'trade_card' }));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/store.js'), 'utf8'), {
    module, exports: module.exports, process,
    require: name => name === './config' ? { DATA_DIR: data, ROOT: temporary, config: {} }
      : name === './assetUniverse' ? require('../src/assetUniverse') : require(name)
  });
  const store = module.exports; store.initStore(); store.initStore();
  assert.equal(store.getActivePrompt().id, 'custom', 'custom prompt remains active');
  assert.equal(store.listPrompts().filter(prompt => prompt.builtinVersion === 4).length, 1);
  assert.equal(store.getSettings().enableQualityGate, true, 'v4 optimized preset enabled once');
  assert.equal(store.getSettings().minPublishScore, 58);
  assert.equal(store.getSettings().requireTrioCashtags, false);
  const originalSettings = JSON.parse(fs.readFileSync(path.join(data, 'backups/editorial-v4/settings.json')));
  assert.equal(originalSettings.enableQualityGate, false, 'pre-upgrade settings backed up');
  assert.equal(originalSettings.minPublishScore, 47);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'backups/editorial-v4/prompts.json')))[0].content, 'custom-content');
  assert.equal(store.getSettings().maxActionablePostsDaily, 7);
  assert.equal(store.getSettings().tradePlanMode, 'trade_card');
  store.saveSettings({ enableQualityGate: true, requireTrioCashtags: false });
  assert.equal(store.getSettings().enableQualityGate, true, 'save must not silently disable gate');
  assert.equal(store.getSettings().enabled, true);
  assert.equal(store.getSettings().publishMode, 'live');
  store.saveSettings({ enableQualityGate: false, minPublishScore: 50 }); store.initStore();
  assert.equal(store.getSettings().enableQualityGate, false, 'later explicit choices survive restart');
  assert.equal(store.getSettings().minPublishScore, 50);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'backups/editorial-v4/settings.json'))).minPublishScore, 47, 'backup not overwritten');
  fs.writeFileSync(path.join(data, 'prompts.json'), JSON.stringify([{ ...custom, name: '默认短帖 Prompt', builtinVersion: 3 }]));
  store.initStore();
  assert.equal(store.getActivePrompt().builtinVersion, 4);
  assert.equal(store.listPrompts().find(prompt => prompt.id === 'custom').content, 'custom-content', 'original prompt backed up');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }

async function workflowTests() {
  const cache = new Map();
  const stubs = {
    '../src/store': null, '../src/marketPack': null, '../src/generator': null,
    '../src/publisher': null, '../src/telegram': { sendTelegram: async () => { throw new Error('unexpected notification'); } }
  };
  let pack = packFor({ publishScore: 47 });
  let settings = { publishMode: 'live', enableQualityGate: true, minPublishScore: 58,
    maxDailyPosts: 50, notifyTelegram: false, enableImagePosts: false };
  let generated = 0, published = 0, incremented = 0, paused = 0, failGeneration = false;
  let rows = [];
  stubs['../src/store'] = {
    getSettings: () => settings, getCounter: () => ({ count: incremented }), listRuns: () => rows,
    appendRun: row => { rows.unshift(row); return row; },
    incrementCounter: () => { incremented++; return { count: incremented }; },
    saveSettings: patch => { assert.equal(patch.enabled, false); paused++; }
  };
  stubs['../src/marketPack'] = { buildMarketPack: async () => pack };
  stubs['../src/generator'] = { generatePost: async () => {
    generated++; if (failGeneration) throw new Error('offline_generation_failure'); return { text: focused };
  } };
  stubs['../src/publisher'] = { SQUARE_UPLOAD_DAILY_LIMIT: 100,
    publishToBinanceSquare: async text => { assert.equal(text, focused); published++; return { id: 'offline' }; } };
  const workflowPath = require.resolve('../src/workflow');
  cache.set(workflowPath, require.cache[workflowPath]); delete require.cache[workflowPath];
  try {
    for (const [name, exports] of Object.entries(stubs)) {
      const id = require.resolve(name); cache.set(id, require.cache[id]); require.cache[id] = { id, filename: id, loaded: true, exports };
    }
    const { runOnce } = require('../src/workflow');
    assert.equal((await runOnce('publish')).status, 'skipped');
    assert.deepEqual([generated, published, incremented], [0, 0, 0]);
    assert.equal((await runOnce('dry-run')).status, 'preview');
    assert.deepEqual([generated, published, incremented], [1, 0, 0]);
    pack = packFor({ cacheFallback: true });
    assert.equal((await runOnce('publish')).skipReason, 'cached_market_snapshot');
    assert.deepEqual([generated, published, incremented], [1, 0, 0]);
    pack = packFor();
    assert.equal((await runOnce('publish')).status, 'published');
    assert.deepEqual([generated, published, incremented], [2, 1, 1]);
    settings = { ...settings, enableQualityGate: false }; pack = packFor({ publishScore: 47 });
    assert.equal((await runOnce('publish')).status, 'published');
    assert.deepEqual([generated, published, incremented], [3, 2, 2]);
    assert.equal(paused, 0, 'skip is not a failure');
    settings = { ...settings, maxConsecutiveFailures: 2 }; failGeneration = true;
    rows = [{ mode: 'publish', status: 'skipped' }, { mode: 'publish', status: 'error' }];
    assert.equal((await runOnce('publish')).status, 'error');
    assert.equal(paused, 1, 'skip must not erase consecutive actual failures');
  } finally {
    for (const [id, original] of cache) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
  }
}

workflowTests().then(() => console.log('quality fixture tests passed (offline; no publish/network/real data writes)'))
  .catch(error => { console.error(error); process.exitCode = 1; });
