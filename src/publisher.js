const { request } = require('./httpClient');
const { masked } = require('./config');
const { getSecrets } = require('./store');
const { uploadImages, uploadImage, uploadVideoWithCover } = require('./mediaUploader');

const ENDPOINT = 'https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add';
const SQUARE_UPLOAD_DAILY_LIMIT = 400;
const CONTENT_TYPES = Object.freeze({ short: 1, article: 2, video: 3 });
const API_ERRORS = {
  '220003': 'api_key_not_found',
  '220004': 'api_key_expired',
  '220009': 'daily_post_limit_exceeded',
  '220014': 'daily_upload_limit_exceeded',
  '20002': 'sensitive_words_detected',
  '20022': 'sensitive_words_detected',
  '20013': 'content_length_limited',
  '20020': 'content_body_empty',
  '220011': 'content_body_empty',
  '30008': 'account_or_device_restricted',
  '2000001': 'account_or_device_restricted',
  '2000002': 'account_or_device_restricted'
};

function squareHeaders(key) {
  return {
    'User-Agent': 'binance-square-autopost-service/0.2',
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Square-OpenAPI-Key': key,
    clienttype: 'binanceSkill'
  };
}

function normalizeFormat(options = {}) {
  const requested = String(options.format || '').toLowerCase();
  // Square treats text-only and 1-4 image posts as the same contentType=1.
  // Accept the UI-friendly "image" alias while preserving the official body.
  if (requested === 'image') return 'short';
  if (requested && CONTENT_TYPES[requested]) return requested;
  if (options.videoPath || options.fileTicket) return 'video';
  if (options.title || options.articleTitle) return 'article';
  return 'short';
}

function buildPublishBody(text, options = {}) {
  const format = normalizeFormat(options);
  const bodyText = String(text || '').trim();
  if (format !== 'video' && !bodyText) throw new Error('empty_square_post_text');

  if (format === 'short') {
    const imageUrls = Array.isArray(options.imageUrls) ? options.imageUrls.filter(Boolean) : [];
    if (imageUrls.length > 4) throw new Error('too_many_images:max_4');
    return {
      contentType: CONTENT_TYPES.short,
      bodyTextOnly: bodyText,
      ...(imageUrls.length ? { imageList: imageUrls } : {})
    };
  }

  if (format === 'article') {
    const title = String(options.title || options.articleTitle || '').trim();
    if (!title) throw new Error('missing_article_title');
    return {
      contentType: CONTENT_TYPES.article,
      bodyTextOnly: bodyText,
      title,
      ...(options.coverUrl ? { cover: options.coverUrl } : {})
    };
  }

  const duration = Number(options.videoTimeSeconds ?? options.durationSeconds);
  if (!options.fileTicket) throw new Error('missing_video_file_ticket');
  if (!options.coverUrl) throw new Error('missing_video_cover');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('invalid_video_duration');
  return {
    contentType: CONTENT_TYPES.video,
    fileTicket: options.fileTicket,
    cover: options.coverUrl,
    videoTimeSeconds: duration,
    isPublish: true,
    ...(bodyText ? { bodyTextOnly: bodyText } : {})
  };
}

function parsePublishResponse(statusCode, rawBody = '') {
  // Binance's official skill treats /content/add HTTP 504 as submitted. Retrying
  // here can create a duplicate post, so preserve the successful-but-unconfirmed
  // state and let the operator verify it later.
  if (Number(statusCode) === 504) {
    return {
      id: null,
      shareLink: null,
      publishStatus: 'success_without_post_id',
      confirmation: 'gateway_timeout_after_submission'
    };
  }

  let json;
  try { json = JSON.parse(String(rawBody || '')); }
  catch { throw new Error(`binance_non_json_response:http_${statusCode}:${String(rawBody || '').slice(0, 240)}`); }

  if (Number(statusCode) < 200 || Number(statusCode) >= 300) {
    throw new Error(`binance_http_${statusCode}:${json?.message || json?.msg || 'unknown_error'}`);
  }
  const code = String(json?.code ?? '');
  if (code !== '000000') {
    const label = API_ERRORS[code] || 'unknown_error';
    throw new Error(`binance_${code}:${label}:${json?.message || json?.msg || 'unknown_error'}`);
  }
  return { ...(json.data || {}), publishStatus: 'success', confirmation: 'confirmed' };
}

async function postSquareContent(key, body) {
  const res = await request('POST', ENDPOINT, {
    headers: squareHeaders(key),
    body: JSON.stringify(body),
    timeoutMs: 30000
  });
  return parsePublishResponse(res.statusCode, res.body);
}

async function prepareMedia(key, format, options = {}) {
  if (format === 'short') {
    const imagePaths = Array.isArray(options.imagePaths)
      ? options.imagePaths.map(x => String(x || '').trim()).filter(Boolean)
      : [];
    if (imagePaths.length > 4) throw new Error('too_many_images:max_4');
    const images = imagePaths.length ? await uploadImages(key, imagePaths) : [];
    return { imageUrls: images.map(x => x.imageUrl), images, uploadCount: images.length };
  }

  if (format === 'article') {
    const coverPath = String(options.coverPath || '').trim();
    if (!coverPath) return { coverUrl: '', images: [], uploadCount: 0 };
    const cover = await uploadImage(key, coverPath);
    return { coverUrl: cover.imageUrl, images: [cover], cover, uploadCount: 1 };
  }

  const videoPath = String(options.videoPath || '').trim();
  if (!videoPath) throw new Error('missing_video_path');
  const video = await uploadVideoWithCover(
    key,
    videoPath,
    String(options.coverPath || '').trim(),
    options.videoTimeSeconds ?? options.durationSeconds
  );
  return {
    fileTicket: video.fileTicket,
    coverUrl: video.cover.imageUrl,
    videoTimeSeconds: video.durationSeconds,
    video,
    images: [video.cover],
    uploadCount: video.uploadCount || 2
  };
}

async function publishToBinanceSquare(text, options = {}) {
  const key = getSecrets().binanceSquareOpenApiKey;
  if (!key || key === 'your_api_key') throw new Error('missing_binance_square_openapi_key');
  const format = normalizeFormat(options);
  const media = await prepareMedia(key, format, options);
  const body = buildPublishBody(text, {
    ...options,
    ...media,
    format
  });
  const result = await postSquareContent(key, body);
  const postId = result.id || null;
  const shareLink = result.shareLink || null;
  if (result.publishStatus !== 'success_without_post_id' && !postId && !shareLink) {
    throw new Error('success_without_post_id_or_504');
  }
  return {
    ok: true,
    id: postId,
    url: shareLink || (postId ? `https://www.binance.com/square/post/${postId}` : null),
    shareLink,
    publishStatus: result.publishStatus,
    confirmation: result.confirmation,
    contentType: body.contentType,
    format,
    images: media.images || [],
    media,
    uploadCount: media.uploadCount || 0
  };
}

function publisherStatus() {
  const key = getSecrets().binanceSquareOpenApiKey;
  return {
    configured: !!key,
    key: masked(key),
    apiProfile: 'binance-square-skill-v2.0.0',
    publishEndpoint: 'v1/content/add',
    mediaEndpoint: 'v2/openApi',
    supportedFormats: ['short', 'image', 'article', 'video'],
    maxImagesPerPost: 4,
    dailyPostLimit: 100,
    dailyUploadLimit: SQUARE_UPLOAD_DAILY_LIMIT
  };
}

module.exports = {
  CONTENT_TYPES,
  SQUARE_UPLOAD_DAILY_LIMIT,
  buildPublishBody,
  parsePublishResponse,
  postSquareContent,
  prepareMedia,
  publishToBinanceSquare,
  publisherStatus
};
