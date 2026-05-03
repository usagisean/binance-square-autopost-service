const { postJson } = require('./httpClient');
const { getSecrets } = require('./store');

async function sendTelegram(message) {
  const secrets = getSecrets();
  if (!secrets.telegramBotToken || !secrets.telegramChatId) return { skipped: true, reason: 'telegram_not_configured' };
  const url = `https://api.telegram.org/bot${secrets.telegramBotToken}/sendMessage`;
  return postJson(url, { chat_id: secrets.telegramChatId, text: message, disable_web_page_preview: false }, { timeoutMs: 15000 });
}

module.exports = { sendTelegram };
