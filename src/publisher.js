const { postJson } = require('./httpClient');
const { config, masked } = require('./config');
const { getSecrets } = require('./store');

const ENDPOINT = 'https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add';

async function publishToBinanceSquare(text) {
  const key = getSecrets().binanceSquareOpenApiKey;
  if (!key || key === 'your_api_key') throw new Error('missing_binance_square_openapi_key');
  const data = await postJson(ENDPOINT, { bodyTextOnly: text }, {
    headers: {
      'X-Square-OpenAPI-Key': key,
      clienttype: 'binanceSkill'
    },
    timeoutMs: 30000
  });
  if (data.code !== '000000') {
    throw new Error(`binance_${data.code}:${data.message || data.msg || 'unknown_error'}`);
  }
  const postId = data?.data?.id;
  if (!postId) throw new Error('success_without_post_id');
  return { ok: true, id: postId, url: `https://www.binance.com/square/post/${postId}` };
}

function publisherStatus() {
  const key = getSecrets().binanceSquareOpenApiKey;
  return { configured: !!key, key: masked(key) };
}

module.exports = { publishToBinanceSquare, publisherStatus };
