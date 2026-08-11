const STRATEGY_VERSION = 3;

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

  if ([lead.change1h, lead.change4h, lead.change24h].some(value => Number.isFinite(Number(value)))) families.push('price_action');
  if (n(lead.volume24h) > 0) families.push('liquidity');
  if (Array.isArray(pack.chart?.klines) && pack.chart.klines.length >= 20) families.push('structure');
  if (intel.depth?.available === true) families.push('orderbook');
  if ([intel.fundingRate, intel.openInterestValueChange5m, intel.takerBuySellRatio].some(value => Number.isFinite(Number(value)))) families.push('binance_derivatives');
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
    ['tradeable_edge', '第一句直接回答主角为什么比另外两个更有可交易性，随后只保留一个会放大机会的位置。'],
    ['payoff_gap', '从“市场正在低估哪一项变化”切入，让读者先看到潜在空间，再给反证。'],
    ['leader_choice', '像交易员在自选列表里做取舍：先说为什么只把主角留在交易页，再用两条证据证明。']
  ],
  B: [
    ['one_level', '第一句给结论，全文只保留一个真正改变判断的位置；不硬凑止损和止盈。'],
    ['tape_read', '从刚发生的价格或成交变化切入，先说它意味着什么，再用一个参照验证。'],
    ['relative_choice', '直接回答三者里为什么只值得研究主角；另外两个币压缩在一句里。'],
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
    participation_confirmed: '解释这次变化为什么有真实成交参与，而不是只强调涨跌幅。',
    active_but_balanced: '讲清成交活跃却没有方向这层矛盾，结论应是分歧而不是硬猜突破方向。',
    liquidity_test: '盘口只允许作一句旁证，主判断必须来自价格、成交或结构。',
    late_move: '行情已经走了一段，重点判断新增参与是否继续，而不是复述涨幅。',
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
    return '证据质量达到 A 级，但本轮不是明确方向帖：写清机会为何值得打开交易页跟踪，只保留一个决定赔率的位置；禁止出现“做多、做空、止损、止盈”。';
  }
  if (grade === 'B') {
    return '这是 B 级机会：可以明确偏向，但只给一个关键位置，重点回答为什么它比参照币更值得交易者停留；禁止出现“做多、做空、止损、止盈”。';
  }
  return '这是 C 级市场判断：不提供伪精确交易指令；指出最容易误读的地方，并告诉读者哪项变化出现后才会产生可交易性。';
}

function readerPromise(archetype, leadSymbol = '主角') {
  const promises = {
    liquidity_map: `让读者知道 ${leadSymbol} 的真实流动性聚集在哪里，以及价格靠近时哪一侧更可能被迫行动。`,
    positioning_divergence: `揭示 ${leadSymbol} 的价格与仓位为什么不同步，避免只看涨跌幅做错方向。`,
    crowding_risk: `指出 ${leadSymbol} 哪一侧已经拥挤，以及什么价格变化可能触发挤压。`,
    funding_pressure: `说明持仓成本正在压迫哪一侧，并判断价格是否已经开始兑现。`,
    participation_confirmed: `证明 ${leadSymbol} 的变化有真实成交参与，让读者知道它为什么比参照币更值得盯。`,
    sector_rotation: `说明注意力正在从哪里切向 ${leadSymbol}，以及这次轮动有没有延续条件。`,
    relative_choice: `替读者完成一次交易标的筛选：为什么 ${leadSymbol} 比同组与大盘参照更值得留在交易页。`,
    no_clear_edge: `指出 ${leadSymbol} 当前缺少的关键证据，避免把噪声当机会，同时给出重新评估的开关。`
  };
  return promises[archetype] || `让读者在最短时间内明白 ${leadSymbol} 为什么值得或不值得投入交易注意力。`;
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
    conversionInstruction: '目标不是喊单，而是让读者读完后清楚“为什么现在值得打开这个币的交易页、要盯哪项变化、什么情况会推翻判断”。靠信息差和赔率吸引点击，不用空洞号召或收益承诺。',
    evidenceFamilies: evidenceFamilies(pack),
    openingInstruction: opening.instruction,
    archetypeInstruction: archetypeInstruction(archetype),
    executionInstruction: executionInstruction(grade, pack, requiresTradeCard),
    structureInstruction: requiresTradeCard
      ? '采用“方向与条件 → 两条证据 → 反证”结构，但必须写成自然段，不显示小标题。'
      : grade === 'A'
        ? '采用“可交易性判断 → 两条证据 → 一个赔率开关”结构，不能写成完整信号卡。'
      : grade === 'B'
        ? '采用“标的取舍 → 最强证据 → 一个值得继续盯的位置”结构，参照币只出现一次。'
        : '采用“常见误读 → 数据矛盾 → 产生可交易性的开关”结构，不要伪装成信号单。'
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
