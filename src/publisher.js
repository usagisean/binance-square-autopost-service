const { postJson } = require('./httpClient');
const { config, masked } = require('./config');
const { getSecrets } = require('./store');
const { uploadImages } = require('./mediaUploader');

const ENDPOINT = 'https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add';

async function publishToBinanceSquare(text, options = {}) {
  const key = getSecrets().binanceSquareOpenApiKey;
  if (!key || key === 'your_api_key') throw new Error('missing_binance_square_openapi_key');
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths.map(x => String(x || '').trim()).filter(Boolean).slice(0, 4) : [];
  const uploadedImages = imagePaths.length ? await uploadImages(key, imagePaths) : [];
  const body = uploadedImages.length
    ? { contentType: 1, bodyTextOnly: text, imageList: uploadedImages.map(x => x.imageUrl) }
    : { bodyTextOnly: text };
  const data = await postJson(ENDPOINT, body, {
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
  const shareLink = data?.data?.shareLink;
  if (!postId && !shareLink) throw new Error('success_without_post_id');
  return {
    ok: true,
    id: postId || null,
    url: shareLink || `https://www.binance.com/square/post/${postId}`,
    shareLink: shareLink || null,
    images: uploadedImages
  };
}

function publisherStatus() {
  const key = getSecrets().binanceSquareOpenApiKey;
  return { configured: !!key, key: masked(key) };
}

module.exports = { publishToBinanceSquare, publisherStatus };
