const { finite } = require('./contentEvidence');
const STRATEGY_VERSION = 4;

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function seededPick(items = [], seed = '') {
  if (!items.length) return null;
  let hash = 0;
  for (const char of String(seed || 'seed')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return items[Math.abs(hash) % items.length];
}

function evidenceFamilies(pack = {}) {
  const lead = pack.trio?.lead || {};
  const intel = pack.marketIntel?.symbols?.[lead.symbol] || {};
  const coinglass = pack.coinglass || {};
  const families = [];

  if ([lead.change1h, lead.change4h, lead.change24h].some(finite)) families.push('price_action');
  if (n(lead.volume24h) > 0) families.push('liquidity');
  if (Array.isArray(pack.chart?.klines) && pack.chart.klines.length >= 20) families.push('structure');
  if (intel.depth?.available === true) families.push('orderbook');
  if ([intel.fundingRate, intel.openInterestValueChange5m, intel.takerBuySellRatio].some(finite)) families.push('binance_derivatives');
  if ([coinglass.heatmap, coinglass.liquidation, coinglass.openInterest, coinglass.longShort, coinglass.orderbookAskBids].some(value => value?.available === true)) families.push('coinglass');
  if (pack.publicDerivatives?.ok === true && pack.publicDerivatives?.symbols?.[lead.symbol]) families.push('public_derivatives');
  if (pack.tradfi?.ok === true) families.push('cross_market');
  if (Array.isArray(pack.externalIntel?.newsItems) && pack.externalIntel.newsItems.length) families.push('verified_news');

  return [...new Set(families)];
}

function directionalAlignment(pack = {}) {
  const event = pack.marketEvent || {};
  const plan = pack.tradePlan || {};
  if (!['long', 'short'].includes(plan.direction)) return false;
  if (!['bullish', 'bearish'].includes(event.stance)) return false;
  return (plan.direction === 'long' && event.stance === 'bullish') || (plan.direction === 'short' && event.stance === 'bearish');
}

function localDayKey(value = new Date(), timeZone = 'Asia/Shanghai') {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function setupGrade(pack = {}, settings = {}, recentRuns = []) {
  const event = pack.marketEvent || {};
  const plan = pack.tradePlan || {};
  const families = evidenceFamilies(pack);
  const hasIndependentConfirmation = families.some(x => [
    'structure', 'binance_derivatives', 'coinglass', 'public_derivatives', 'verified_news'
  ].includes(x));
  const score = n(event.score);
  const planScore = Math.abs(n(plan.basis?.score));
  const actionable = directionalAlignment(pack)
    && event.type !== 'low_signal'
    && score >= 60
    && planScore >= 0.95
    && families.filter(x => !['orderbook', 'cross_market'].includes(x)).length >= 2
    && hasIndependentConfirmation;

  if (actionable) return 'A';
  if (score >= 42 && event.type !== 'low_signal' && families.length >= 2) return 'B';
  return 'C';
}

const EVENT_ARCHETYPE = {
  liquidation_map: 'liquidity_map',
  price_oi_divergence: 'positioning_divergence',
  crowded_positioning: 'crowding_risk',
  funding_dislocation: 'funding_pressure',
  positioning_without_price: 'positioning_wait',
  cross_market_confirmation: 'cross_market_check',
  momentum_shift: 'momentum_change',
  liquid_momentum: 'participation_confirmed',
  volume_without_direction: 'active_but_balanced',
  orderbook_imbalance: 'liquidity_test',
  late_momentum: 'late_move',
  sector_rotation: 'sector_rotation',
  relative_strength: 'relative_choice',
  low_signal: 'no_clear_edge'
};

const OPENING_MODES = {
  A_SIGNAL: [
    ['signal_plain', '用一句自然盘中口吻给出方向、触发和风险边界，不要像复制交易所订单。'],
    ['signal_risk_first', '先说这笔机会最容易错在哪里，再落到方向、触发、防守和第一目标。'],
    ['signal_payoff_first', '先说清这笔机会的赔率来自哪里，再给条件方案；禁止用夸张收益承诺。']
  ],
  A: [
    ['tradeable_edge', '第一句解释主角最异常的变化及其含义；有相关参照才比较，不要强行判定谁更值得交易。'],
    ['payoff_gap', '从“市场正在低估哪一项变化”切入，让读者先看到潜在空间，再给反证。'],
    ['leader_choice', '先指出一个容易被涨跌幅掩盖的矛盾，再用两条事实说明；不写自选列表或交易页套话。']
  ],
  B: [
    ['one_level', '第一句给结论；有可靠区间才引用一个位置并解释来源，没有就只说明可验证的变化。'],
    ['tape_read', '从刚发生的价格或成交变化切入，先说它意味着什么，再用一个参照验证。'],
    ['relative_choice', '有明显强弱差才用一个相关参照解释主角；不强制三币比较，不写参照价值低。'],
    ['evidence_first', '用最反常的一条证据开场，第二句再落到偏向；不要先报完整涨跌幅。']
  ],
  C: [
    ['misread_to_avoid', '开头指出这段行情最容易被误读的地方，再解释缺少哪项证据；不要用“观望”当空洞结论。'],
    ['what_would_change', '先说目前没有优势的具体原因，再给一项会让你重新评估的数据或价位。'],
    ['plain_market_note', '像交易员复盘便签：只讲一个矛盾和它对仓位的影响，不写完整交易方案。']
  ]
};

function recentValueSet(recentRuns = [], key, limit = 3) {
  return new Set(recentRuns
    .filter(run => run?.editorial?.[key])
    .slice(0, limit)
    .map(run => run.editorial[key]));
}

function pickOpeningMode(grade, pack, recentRuns = []) {
  const options = OPENING_MODES[grade] || OPENING_MODES.C;
  const recentlyUsed = recentValueSet(recentRuns, 'openingMode', 2);
  const available = options.filter(([id]) => !recentlyUsed.has(id));
  const seed = `${pack.generatedAt || ''}:${pack.trio?.lead?.symbol || ''}:${pack.marketEvent?.type || ''}:${grade}`;
  const selected = seededPick(available.length ? available : options, seed) || options[0];
  return { id: selected[0], instruction: selected[1] };
}

function explicitSignalPolicy(pack = {}, settings = {}, recentRuns = [], grade = 'C') {
  const plan = pack.tradePlan || {};
  const event = pack.marketEvent || {};
  const timeZone = settings.timezone || 'Asia/Shanghai';
  const today = localDayKey(new Date(), timeZone);
  const maxDaily = Math.max(0, Math.min(20, n(settings.maxActionablePostsDaily, 3)));
  const cooldownRuns = Math.max(0, Math.min(50, n(settings.explicitSignalCooldownRuns, 8)));
  const published = recentRuns.filter(run => run?.status === 'published');
  const usedToday = published.filter(run =>
    run.createdAt
    && localDayKey(run.createdAt, timeZone) === today
    && run.editorial?.requiresTradeCard === true
  ).length;
  const recentSignal = cooldownRuns > 0
    && published.slice(0, cooldownRuns).some(run => run.editorial?.requiresTradeCard === true);
  const mode = String(settings.tradePlanMode || 'adaptive').toLowerCase();
  const enabled = settings.includeTradePlan !== false && !['off', 'opinion', 'soft_opinion'].includes(mode);
  const evidenceStrongEnough = n(event.score) >= 70 && Math.abs(n(plan.basis?.score)) >= 1.25;
  const eligible = enabled
    && grade === 'A'
    && ['long', 'short'].includes(plan.direction)
    && evidenceStrongEnough;
  const allowed = eligible && usedToday < maxDaily && !recentSignal;
  return {
    eligible,
    allowed,
    usedToday,
    maxDaily,
    cooldownRuns,
    blockedReason: !eligible
      ? 'not_strong_enough'
      : usedToday >= maxDaily
        ? 'daily_cap_reached'
        : recentSignal
          ? 'cooldown_active'
          : null
  };
}

function archetypeInstruction(archetype) {
  const instructions = {
    liquidity_map: '只解释最近的真实清算密集区如何影响短线博弈；热区是潜在流动性，不是必然目标。',
    positioning_divergence: '把价格和持仓的背离说成人话：到底是新增仓位不足，还是下跌时仓位没有释放。',
    crowding_risk: '说明哪一侧更拥挤、价格怎样才会触发挤压；不要把多空比当成单独入场信号。',
    funding_pressure: '说明哪一侧在持续付资金成本，以及价格是否验证这份拥挤。',
    positioning_wait: '说明杠杆仓位已经在场、价格却没走开意味着什么；不要猜没有数据支持的方向。',
    cross_market_check: '传统市场只作一条交叉验证，主角始终是加密货币；相关性不能写成因果。',
    momentum_change: '聚焦旧方向为什么掉速，以及短周期是否已经改变交易倾向。',
    participation_confirmed: '区分过去一天的成交规模和最近已收盘短周期量能；只有量比证据才允许说成交正在增加。',
    active_but_balanced: '讲清成交活跃却没有方向这层矛盾，结论应是分歧而不是硬猜突破方向。',
    liquidity_test: '盘口只允许作一句旁证，主判断必须来自价格、成交或结构。',
    late_move: '行情已经走了一段，聚焦日内与短周期的差异；没有短周期量比，不推断新增资金。',
    sector_rotation: '说明同板块注意力如何迁移以及主角为何胜出或掉队，不平均介绍三个币。',
    relative_choice: '只使用一次相对强弱比较，回答主角是否真的优于同组和大盘。',
    no_clear_edge: '没有清晰优势也要提供价值：明确缺的是成交、结构还是方向一致性，并说什么变化值得重新看。'
  };
  return instructions[archetype] || instructions.relative_choice;
}

function executionInstruction(grade, pack = {}, requiresTradeCard = false) {
  const plan = pack.tradePlan || {};
  if (requiresTradeCard && ['long', 'short'].includes(plan.direction)) {
    return [
      `这是少量保留的明确方向帖，方向为${plan.direction === 'long' ? '偏多' : '偏空'}。`,
      '正文需要给触发位、防守位和第一目标；第二目标可以省略，避免每篇都像复制的信号卡。',
      '不得写成现价立即成交，也不得把计算目标描述成必然到达。'
    ].join('');
  }
  if (grade === 'A') {
    return '证据质量达到 A 级，但本轮不是明确方向帖：解释两类证据为何支持同一判断，给出具体反证；价位可省略，禁止出现“做多、做空、止损、止盈”。';
  }
  if (grade === 'B') {
    return '这是 B 级判断：可以明确偏向，但只给一个关键事实及其局限；不强制价位或三币比较，禁止出现“做多、做空、止损、止盈”。';
  }
  return '这是 C 级市场判断：不提供伪精确交易指令；指出最容易误读的地方，并告诉读者哪项变化出现后才会产生可交易性。';
}

function readerPromise(archetype, leadSymbol = '主角') {
  const promises = {
    liquidity_map: `让读者知道 ${leadSymbol} 的真实流动性聚集在哪里，以及价格靠近时哪一侧更可能被迫行动。`,
    positioning_divergence: `揭示 ${leadSymbol} 的价格与仓位为什么不同步，避免只看涨跌幅做错方向。`,
    crowding_risk: `指出 ${leadSymbol} 哪一侧已经拥挤，以及什么价格变化可能触发挤压。`,
    funding_pressure: `说明持仓成本正在压迫哪一侧，并判断价格是否已经开始兑现。`,
    participation_confirmed: `让读者区分 ${leadSymbol} 的日内成交规模与已收盘短周期量能，避免错误归因。`,
    sector_rotation: `说明注意力正在从哪里切向 ${leadSymbol}，以及这次轮动有没有延续条件。`,
    relative_choice: `说明 ${leadSymbol} 与相关参照的强弱差，并明确差异是否足够显著。`,
    no_clear_edge: `指出 ${leadSymbol} 当前缺少的关键证据，避免把噪声当机会，同时给出重新评估的开关。`
  };
  return promises[archetype] || `让读者理解 ${leadSymbol} 最异常的一项变化、证据局限和具体反证。`;
}

function buildEditorialDecision(pack = {}, settings = {}, recentRuns = []) {
  const event = pack.marketEvent || {};
  const grade = setupGrade(pack, settings, recentRuns);
  const archetype = EVENT_ARCHETYPE[event.type] || 'relative_choice';
  const plan = pack.tradePlan || {};
  const strictMode = ['trade_card', 'directional'].includes(String(settings.tradePlanMode || '').toLowerCase());
  const signalPolicy = explicitSignalPolicy(pack, settings, recentRuns, grade);
  const requiresTradeCard = signalPolicy.allowed;
  const opening = pickOpeningMode(requiresTradeCard ? 'A_SIGNAL' : grade, pack, recentRuns);
  const stance = requiresTradeCard
    ? plan.direction
    : event.stance === 'bullish' ? 'lean_long' : event.stance === 'bearish' ? 'lean_short' : 'neutral';

  return {
    version: STRATEGY_VERSION,
    setupGrade: grade,
    archetype,
    openingMode: opening.id,
    stance,
    requiresTradeCard,
    signalPolicy,
    strictMode,
    thesis: event.claim || `${pack.trio?.lead?.symbol || '主角'} 当前只有一项值得讨论的变化`,
    readerPromise: readerPromise(archetype, pack.trio?.lead?.symbol || '主角'),
    conversionInstruction: '目标是提供可核对、与前帖不同的信息：发生了什么、哪些证据支持解释、什么事实会推翻解释。不把打开交易页或交易价值上升写进正文，不用收益承诺。',
    evidenceFamilies: evidenceFamilies(pack),
    openingInstruction: opening.instruction,
    archetypeInstruction: archetypeInstruction(archetype),
    executionInstruction: executionInstruction(grade, pack, requiresTradeCard),
    structureInstruction: requiresTradeCard
      ? '采用“方向与条件 → 两条证据 → 反证”结构，但必须写成自然段，不显示小标题。'
      : grade === 'A'
        ? '解释一个变化和两条证据，最后说明一项具体反证；不强制固定语序或价位。'
      : grade === 'B'
        ? '从最强事实解释一个矛盾，给出有信息量的结论；参照和价位均按需使用。'
        : '说明一个常见误读和证据局限，不要硬凑机会、价位或信号单。'
  };
}

module.exports = {
  STRATEGY_VERSION,
  evidenceFamilies,
  directionalAlignment,
  setupGrade,
  localDayKey,
  explicitSignalPolicy,
  buildEditorialDecision
};
