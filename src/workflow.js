const { buildMarketPack } = require('./marketPack');
const { generatePost } = require('./generator');
const { publishToBinanceSquare } = require('./publisher');
const { sendTelegram } = require('./telegram');
const { appendRun, getSettings, getCounter, incrementCounter, shanghaiDateString } = require('./store');

function hasBannedSymbol(pack, settings) {
  const banned = new Set((settings.bannedSymbols || []).map(s => String(s).toUpperCase()));
  return [pack.trio?.lead?.symbol, pack.trio?.peer?.symbol, pack.trio?.anchor?.symbol].filter(Boolean).find(s => banned.has(String(s).toUpperCase()));
}

function formatTime(tz = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
}

async function runOnce(mode = 'dry-run', meta = {}) {
  const startedAt = Date.now();
  const settings = getSettings();
  let pack = null;
  let generated = null;
  try {
    const counter = getCounter(settings);
    if (counter.count >= Number(settings.maxDailyPosts || 100)) throw new Error(`daily_limit_reached:${counter.count}/${settings.maxDailyPosts}`);

    pack = await buildMarketPack();
    if (!pack?.ok || !pack?.trio?.lead || !pack?.trio?.peer || !pack?.trio?.anchor) throw new Error('invalid_market_pack');
    const banned = hasBannedSymbol(pack, settings);
    if (banned) throw new Error(`banned_symbol_in_trio:${banned}`);

    generated = await generatePost(pack);

    const livePublish = mode === 'publish' && settings.publishMode === 'live';
    if (!livePublish) {
      return appendRun({
        mode: mode === 'publish' ? 'preview' : mode,
        requestedMode: mode,
        publishMode: settings.publishMode,
        status: 'preview',
        durationMs: Date.now() - startedAt,
        source: pack.source,
        lead: pack.trio.lead.symbol, peer: pack.trio.peer.symbol, anchor: pack.trio.anchor.symbol,
        postText: generated.text, promptId: generated.promptId, promptName: generated.promptName,
        facts: pack.facts, takeaways: pack.takeaways, meta
      });
    }

    const published = await publishToBinanceSquare(generated.text);
    const nextCounter = incrementCounter({ url: published.url, symbol: pack.trio.lead.symbol }, settings);
    const row = appendRun({
      mode, status: 'published', durationMs: Date.now() - startedAt, source: pack.source,
      lead: pack.trio.lead.symbol, peer: pack.trio.peer.symbol, anchor: pack.trio.anchor.symbol,
      postText: generated.text, url: published.url, postId: published.id,
      promptId: generated.promptId, promptName: generated.promptName,
      counter: { date: nextCounter.date, count: nextCounter.count, remaining: Math.max(0, Number(settings.maxDailyPosts || 100) - nextCounter.count) },
      facts: pack.facts, takeaways: pack.takeaways, meta
    });
    if (settings.notifyTelegram) {
      await sendTelegram(`✅ 币安广场发帖成功！\n⏰ 时间：${formatTime(settings.timezone)}\n🪙 币种：${pack.trio.lead.symbol}\n📊 消耗额度：${nextCounter.count}/${settings.maxDailyPosts}\n🔗 帖子链接：${published.url}`).catch(() => null);
    }
    return row;
  } catch (err) {
    const row = appendRun({
      mode, status: 'error', durationMs: Date.now() - startedAt,
      source: pack?.source, lead: pack?.trio?.lead?.symbol, peer: pack?.trio?.peer?.symbol, anchor: pack?.trio?.anchor?.symbol,
      postText: generated?.text, error: err.message || String(err), meta
    });
    if (settings.notifyTelegram && mode !== 'dry-run') {
      await sendTelegram(`❌ 币安广场发帖失败\n原因：${err.message || String(err)}`).catch(() => null);
    }
    return row;
  }
}

module.exports = { runOnce, formatTime, hasBannedSymbol };
