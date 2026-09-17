const { finite } = require('./contentEvidence');

function publicationPolicy(pack = {}, settings = {}, history = [], now = Date.now()) {
  // This is an optional publication gate, never a quota target or an error.
  if (settings.enableQualityGate === false) return { allowed: true, reason: 'quality_gate_disabled' };
  if (pack.cacheFallback) return { allowed: false, reason: 'cached_market_snapshot' };
  const event = pack.marketEvent || {};
  const configured = Number(settings.minPublishScore ?? 58);
  const threshold = Number.isFinite(configured) ? Math.max(0, Math.min(100, configured)) : 58;
  const score = Number(pack.publishScore ?? event.score);
  if (!Number.isFinite(score)) return { allowed: false, reason: 'missing_quality_score', threshold };
  if (event.type === 'low_signal' || score < threshold) {
    return { allowed: false, reason: `low_signal:${event.type || 'unknown'}:${score}/${threshold}`, threshold };
  }
  const previous = history.find(run => run.status === 'published'
    && run.lead === pack.trio?.lead?.symbol && run.marketEvent?.type === event.type
    && now - Date.parse(run.createdAt) >= 0 && now - Date.parse(run.createdAt) < 2 * 60 * 60 * 1000);
  if (previous) {
    const oldPrice = Number(previous.marketSnapshot?.price), price = Number(pack.trio?.lead?.price);
    const oldChange = Number(previous.marketSnapshot?.change1h), change = Number(pack.trio?.lead?.change1h);
    const priceChanged = Number.isFinite(oldPrice) && oldPrice > 0 && Number.isFinite(price)
      && Math.abs(price / oldPrice - 1) >= 0.02;
    const momentumChanged = finite(previous.marketSnapshot?.change1h) && finite(pack.trio?.lead?.change1h)
      && Math.abs(change - oldChange) >= 1.5;
    if (!priceChanged && !momentumChanged) return { allowed: false, reason: 'same_subject_event_within_2h', previousRunId: previous.id };
  }
  return { allowed: true, reason: 'quality_gate_passed', threshold };
}

module.exports = { publicationPolicy };
