const fs = require('fs');
const path = require('path');
const { postJson, request } = require('./httpClient');
const { DATA_DIR } = require('./config');

const BASE_URL_V2 = 'https://www.binance.com/bapi/composite/v2/public/pgc/openApi';
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_RETRIES = 10;
const CONTENT_TYPE_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp'
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function getContentType(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return CONTENT_TYPE_MAP[ext] || 'application/octet-stream';
}

function resolveImagePath(input = '') {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('empty_image_path');
  return path.isAbsolute(raw) ? raw : path.join(DATA_DIR, raw);
}

function assertImagePath(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`image_not_found:${filePath}`);
  const st = fs.statSync(filePath);
  if (!st.isFile()) throw new Error(`image_not_file:${filePath}`);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!CONTENT_TYPE_MAP[ext]) throw new Error(`unsupported_image_type:${ext || 'none'}:${filePath}`);
  return st;
}

function squareHeaders(apiKey) {
  return {
    'X-Square-OpenAPI-Key': apiKey,
    clienttype: 'binanceSkill'
  };
}

async function squareApiV2(endpoint, apiKey, body, timeoutMs = 30000) {
  const data = await postJson(`${BASE_URL_V2}${endpoint}`, body, {
    headers: squareHeaders(apiKey),
    timeoutMs
  });
  if (data.code !== '000000') {
    throw new Error(`binance_${data.code}:${data.message || data.msg || 'unknown_error'}`);
  }
  return data.data;
}

async function uploadToPresignedUrl(presignedUrl, filePath, contentType) {
  const body = fs.readFileSync(filePath);
  const res = await request('PUT', presignedUrl, {
    headers: { 'Content-Type': contentType },
    body,
    timeoutMs: 60000,
    proxy: false
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`image_upload_failed:http_${res.statusCode}:${String(res.body || '').slice(0, 200)}`);
  }
}

async function pollImageStatus(apiKey, fileTicket) {
  for (let i = 0; i < MAX_POLL_RETRIES; i++) {
    const data = await squareApiV2('/image/imageStatus', apiKey, { fileTicket }, 30000);
    if (Number(data?.status) === 1 && data.imageUrl) return data;
    if (Number(data?.status) === 2) throw new Error(`image_processing_failed:${data.failedReason || 'unknown'}`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`image_processing_timeout:${fileTicket}`);
}

async function uploadImage(apiKey, imagePath) {
  const filePath = resolveImagePath(imagePath);
  assertImagePath(filePath);
  const imageName = path.basename(filePath);
  const contentType = getContentType(filePath);
  const ticket = await squareApiV2('/image/presignedUrl', apiKey, { imageName }, 30000);
  if (!ticket?.presignedUrl || !ticket?.fileTicket) throw new Error('image_presigned_missing_fields');
  await uploadToPresignedUrl(ticket.presignedUrl, filePath, contentType);
  const status = await pollImageStatus(apiKey, ticket.fileTicket);
  return { imageUrl: status.imageUrl, fileTicket: ticket.fileTicket, path: filePath };
}

async function uploadImages(apiKey, imagePaths = []) {
  const paths = imagePaths.map(x => String(x || '').trim()).filter(Boolean).slice(0, 4);
  if (paths.length > 4) throw new Error('too_many_images:max_4');
  const uploaded = [];
  for (const p of paths) uploaded.push(await uploadImage(apiKey, p));
  return uploaded;
}

module.exports = {
  getContentType,
  resolveImagePath,
  assertImagePath,
  uploadImage,
  uploadImages
};
