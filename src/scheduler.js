const { getSettings, getSchedulerState, saveSchedulerState } = require('./store');
const { runOnce } = require('./workflow');

let timer = null;
let running = false;

function computeNextRunAt(lastRunAt, settings) {
  const intervalMs = Math.max(1, Number(settings.intervalMinutes || 20)) * 60 * 1000;
  if (!lastRunAt) return Date.now() + intervalMs;
  return Number(lastRunAt) + intervalMs;
}

async function tick() {
  const settings = getSettings();
  const state = getSchedulerState();
  if (!settings.enabled) {
    saveSchedulerState({ running: false, nextRunAt: computeNextRunAt(state.lastRunAt, settings) });
    return;
  }
  if (running) return;
  const nextRunAt = state.nextRunAt || computeNextRunAt(state.lastRunAt, settings);
  if (Date.now() < Number(nextRunAt)) return;
  running = true;
  saveSchedulerState({ running: true, nextRunAt: null });
  try {
    await runOnce(settings.publishMode === 'live' ? 'publish' : 'dry-run', { trigger: 'scheduler' });
  } finally {
    const lastRunAt = Date.now();
    saveSchedulerState({ running: false, lastRunAt, nextRunAt: computeNextRunAt(lastRunAt, getSettings()) });
    running = false;
  }
}

function startScheduler() {
  if (timer) return;
  const settings = getSettings();
  const state = getSchedulerState();
  if (!state.nextRunAt) saveSchedulerState({ nextRunAt: computeNextRunAt(state.lastRunAt, settings) });
  timer = setInterval(() => tick().catch(err => console.error('[scheduler]', err)), 30 * 1000);
  tick().catch(err => console.error('[scheduler]', err));
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

function schedulerStatus() {
  const settings = getSettings();
  const state = getSchedulerState();
  return { enabled: !!settings.enabled, running, intervalMinutes: settings.intervalMinutes, ...state };
}

module.exports = { startScheduler, stopScheduler, schedulerStatus, tick, computeNextRunAt };
