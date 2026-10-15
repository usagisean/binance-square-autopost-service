function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildTradeConfidence(pack = {}) {
  const event = pack.marketEvent || {};
  const plan = pack.tradePlan || {};
  const supports = [];
  const contradictions = [];
  if (Math.abs(n(pack.trio?.lead?.change1h)) >= 0.8) supports.push('短周期价格有明确方向');
  if (pack.contentEvidence?.available && pack.contentEvidence.volumeTrend === 'expanding') supports.push('已收盘短周期量能扩张');
  if (event.evidenceAvailable?.openInterest || event.evidenceAvailable?.publicDerivatives || event.evidenceAvailable?.liquidation || event.evidenceAvailable?.heatmap) supports.push('合约仓位或清算数据可交叉验证');
  if (pack.tradfiSignal?.relation === 'confirming') supports.push('美股相关资产同向验证');
  if (Math.abs(n(event.comparisons?.relative1hVsAnchor)) >= 1) supports.push('相对大盘的强弱差足够明显');
  if (pack.tradfiSignal?.relation === 'diverging') contradictions.push('美股相关资产与币圈主角背离');
  if (pack.contentEvidence?.available && pack.contentEvidence.volumeTrend === 'contracting') contradictions.push('已收盘短周期量能收缩');
  if (['long', 'short'].includes(plan.direction) && ['bullish', 'bearish'].includes(event.stance)) {
    const aligned = (plan.direction === 'long' && event.stance === 'bullish') || (plan.direction === 'short' && event.stance === 'bearish');
    if (!aligned) contradictions.push('结构化计划与市场事件方向不一致');
  }
  const score = n(event.score);
  const level = score >= 70 && supports.length >= 3 && contradictions.length === 0 ? 'high'
    : score >= 45 && supports.length >= 2 && contradictions.length <= 1 ? 'medium' : 'tactical';
  const direction = event.stance === 'bullish' ? '偏多' : event.stance === 'bearish' ? '偏空' : '中性';
  const label = level === 'high' ? '证据较强' : level === 'medium' ? '证据中等' : '仅战术观察';
  return {
    level, direction, label, score,
    supports: supports.slice(0, 4), contradictions: contradictions.slice(0, 3),
    writingInstruction: level === 'high'
      ? '第一句直接给偏多/偏空结论，接着给两类独立证据，最后只写一个推翻条件。'
      : level === 'medium'
        ? '第一句明确表达战术偏向，不用“可能、或许”反复稀释；同时保留一个具体反证。'
        : '给出“不追/等哪项数据改变”的明确结论，不制造伪确定性。'
  };
}

function confidenceBrief(confidence = {}) {
  if (!confidence.level) return '';
  const support = confidence.supports?.length ? confidence.supports.join('、') : '暂无独立确认';
  const contradiction = confidence.contradictions?.length ? confidence.contradictions.join('、') : '未见重大冲突';
  return `结论力度：${confidence.direction}，${confidence.label}。支持：${support}。反证：${contradiction}。${confidence.writingInstruction}`;
}

module.exports = { buildTradeConfidence, confidenceBrief };
