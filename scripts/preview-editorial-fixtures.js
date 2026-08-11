const { mockGenerate, validatePostText } = require('../src/generator');
const { buildEditorialDecision } = require('../src/editorialStrategy');

const settings = {
  language: 'zh-CN',
  styleGuide: '像资深交易员盘中给熟人讲机会，结论清楚，不喊口号。',
  minPostChars: 140,
  maxPostChars: 300,
  bannedPhrases: [],
  requireCashtags: true,
  includeTradePlan: true,
  tradePlanMode: 'adaptive',
  maxActionablePostsDaily: 3,
  explicitSignalCooldownRuns: 8,
  similarityThreshold: 0,
  timezone: 'Asia/Shanghai'
};

function packFor({ lead, peer, anchor, event, direction = 'long', trigger, stopLoss, takeProfit1, planScore = 1.8 }) {
  const pack = {
    ok: true,
    source: 'local-editorial-fixture',
    generatedAt: new Date().toISOString(),
    trio: { lead, peer, anchor },
    marketEvent: event,
    tradePlan: {
      symbol: lead.symbol,
      direction,
      trigger,
      stopLoss,
      takeProfit1,
      basis: { score: planScore }
    },
    chart: {
      klines: Array.from({ length: 32 }, (_, i) => ({
        open: lead.price * (0.97 + i * 0.001),
        high: lead.price * (0.975 + i * 0.001),
        low: lead.price * (0.965 + i * 0.001),
        close: lead.price * (0.971 + i * 0.001)
      }))
    },
    marketIntel: {
      source: 'fixture',
      symbols: {
        [lead.symbol]: {
          fundingRate: 0.0001,
          openInterestValueChange5m: 1.2,
          takerBuySellRatio: direction === 'short' ? 0.82 : 1.18,
          depth: { available: true, imbalance: direction === 'short' ? -28 : 24 }
        }
      }
    },
    facts: [],
    takeaways: []
  };
  return pack;
}

const scenarios = [
  {
    name: '普通强机会：不出现做多/做空',
    pack: packFor({
      lead: { symbol: 'RENDER', price: 7.12, change1h: 2.4, change4h: 4.1, change24h: 9.8, volume24h: 82000000, amplitude24h: 14.2 },
      peer: { symbol: 'FET', price: 1.21, change1h: -0.7, change4h: 0.8, change24h: 3.2, volume24h: 31000000, amplitude24h: 8.1 },
      anchor: { symbol: 'BTC', price: 68400, change1h: -0.35, change4h: -0.8, change24h: 0.2, volume24h: 28000000000, amplitude24h: 2.8 },
      event: { type: 'liquid_momentum', score: 82, stance: 'bullish', claim: 'RENDER 的走强有成交与结构共同参与' },
      trigger: 7.25,
      stopLoss: 6.9,
      takeProfit1: 7.67
    }),
    history: [{ status: 'published', createdAt: new Date().toISOString(), editorial: { requiresTradeCard: true } }]
  },
  {
    name: '相对选择：突出为什么更值得交易',
    pack: packFor({
      lead: { symbol: 'SOL', price: 182.4, change1h: 1.65, change4h: 2.8, change24h: 5.4, volume24h: 2400000000, amplitude24h: 7.1 },
      peer: { symbol: 'DOGE', price: 0.194, change1h: 0.35, change4h: 1.1, change24h: 3.2, volume24h: 940000000, amplitude24h: 6.4 },
      anchor: { symbol: 'ETH', price: 3650, change1h: 0.22, change4h: 0.9, change24h: 1.4, volume24h: 8200000000, amplitude24h: 3.5 },
      event: { type: 'relative_strength', score: 55, stance: 'bullish', claim: 'SOL 的短线强弱差正在扩大' },
      trigger: 184.2,
      stopLoss: 177.8,
      takeProfit1: 191.9,
      planScore: 0.7
    }),
    history: []
  },
  {
    name: '弱信号：仍然给读者一个重新评估开关',
    pack: packFor({
      lead: { symbol: 'PEPE', price: 0.0000124, change1h: -0.25, change4h: 0.18, change24h: 1.1, volume24h: 460000000, amplitude24h: 4.8 },
      peer: { symbol: 'BONK', price: 0.000028, change1h: 0.42, change4h: 0.6, change24h: 2.3, volume24h: 180000000, amplitude24h: 6.1 },
      anchor: { symbol: 'BTC', price: 68400, change1h: 0.31, change4h: 0.5, change24h: 0.8, volume24h: 28000000000, amplitude24h: 2.8 },
      event: { type: 'low_signal', score: 28, stance: 'neutral', claim: 'PEPE 的成交还没有形成独立方向' },
      direction: 'watch',
      trigger: 0.0000128,
      stopLoss: null,
      takeProfit1: null,
      planScore: 0.1
    }),
    history: []
  },
  {
    name: '少量明确方向帖：满足强证据与频率限制时才出现',
    pack: packFor({
      lead: { symbol: 'AAVE', price: 98.6, change1h: 3.1, change4h: 5.4, change24h: 11.2, volume24h: 190000000, amplitude24h: 13.5 },
      peer: { symbol: 'LINK', price: 16.8, change1h: 0.7, change4h: 1.5, change24h: 4.2, volume24h: 420000000, amplitude24h: 7.2 },
      anchor: { symbol: 'ETH', price: 3650, change1h: 0.4, change4h: 1.1, change24h: 2.0, volume24h: 8200000000, amplitude24h: 3.5 },
      event: { type: 'liquid_momentum', score: 88, stance: 'bullish', claim: 'AAVE 的价格、成交与结构方向一致' },
      trigger: 99.4,
      stopLoss: 95.8,
      takeProfit1: 103.7,
      planScore: 2.4
    }),
    history: []
  }
];

let failed = false;
for (const scenario of scenarios) {
  scenario.pack.editorialDecision = buildEditorialDecision(scenario.pack, settings, scenario.history);
  const draft = mockGenerate(scenario.pack);
  const validation = validatePostText(draft, scenario.pack, settings);
  if (!validation.ok) failed = true;
  console.log(`\n=== ${scenario.name} ===`);
  console.log(`grade=${scenario.pack.editorialDecision.setupGrade} explicit=${scenario.pack.editorialDecision.requiresTradeCard} archetype=${scenario.pack.editorialDecision.archetype}`);
  console.log(validation.text);
  console.log(`chars=${validation.length} validation=${validation.ok ? 'OK' : validation.errors.join(',')}`);
}

if (failed) process.exitCode = 1;
