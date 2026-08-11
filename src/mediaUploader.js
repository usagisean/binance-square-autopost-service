const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
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
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  webm: 'video/webm'
};
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'webm']);

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

function resolveMediaPath(input = '') {
  return resolveImagePath(input);
}

function assertImagePath(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`image_not_found:${filePath}`);
  const st = fs.statSync(filePath);
  if (!st.isFile()) throw new Error(`image_not_file:${filePath}`);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) throw new Error(`unsupported_image_type:${ext || 'none'}:${filePath}`);
  return st;
}

function assertVideoPath(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`video_not_found:${filePath}`);
  const st = fs.statSync(filePath);
  if (!st.isFile()) throw new Error(`video_not_file:${filePath}`);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) throw new Error(`unsupported_video_type:${ext || 'none'}:${filePath}`);
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

async function pollImageStatus(apiKey, fileTicket, { requireImageUrl = true } = {}) {
  for (let i = 0; i < MAX_POLL_RETRIES; i++) {
    const data = await squareApiV2('/image/imageStatus', apiKey, { fileTicket }, 30000);
    if (Number(data?.status) === 1) {
      if (!requireImageUrl || data.imageUrl) return data;
      throw new Error(`image_processing_missing_url:${fileTicket}`);
    }
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
  const paths = imagePaths.map(x => String(x || '').trim()).filter(Boolean);
  if (paths.length > 4) throw new Error('too_many_images:max_4');
  const uploaded = [];
  for (const p of paths) uploaded.push(await uploadImage(apiKey, p));
  return uploaded;
}

function extractVideoCover(videoPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-video-cover-'));
  const coverPath = path.join(tempDir, `${path.parse(videoPath).name}-cover.png`);
  const result = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', videoPath,
    '-frames:v', '1', '-q:v', '2', coverPath
  ], { encoding: 'utf8' });
  if (result.error) throw new Error(`ffmpeg_unavailable:${result.error.message}`);
  if (result.status !== 0) throw new Error(`video_cover_extract_failed:${String(result.stderr || '').slice(0, 300)}`);
  if (!fs.existsSync(coverPath) || fs.statSync(coverPath).size <= 0) throw new Error('video_cover_empty');
  return { coverPath, tempDir };
}

function cleanupVideoCover(coverPath, tempDir) {
  try { if (coverPath && fs.existsSync(coverPath)) fs.unlinkSync(coverPath); } catch {}
  try { if (tempDir && fs.existsSync(tempDir)) fs.rmdirSync(tempDir); } catch {}
}

function probeVideoDuration(videoPath) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath
  ], { encoding: 'utf8' });
  if (result.error) throw new Error(`ffprobe_unavailable:${result.error.message}`);
  if (result.status !== 0) throw new Error(`video_duration_probe_failed:${String(result.stderr || '').slice(0, 300)}`);
  const duration = Number(String(result.stdout || '').trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('invalid_video_duration');
  return Number(duration.toFixed(3));
}

async function uploadVideo(apiKey, videoPath) {
  const filePath = resolveMediaPath(videoPath);
  const st = assertVideoPath(filePath);
  const fileName = path.basename(filePath);
  const ticket = await squareApiV2('/video/preSign', apiKey, { fileName, size: st.size }, 30000);
  if (!ticket?.presignedUrl || !ticket?.fileTicket) throw new Error('video_presigned_missing_fields');
  await uploadToPresignedUrl(ticket.presignedUrl, filePath, getContentType(filePath));
  // The same status endpoint is used for videos, but a completed video does not
  // necessarily return imageUrl. Only the uploaded cover needs that field.
  await pollImageStatus(apiKey, ticket.fileTicket, { requireImageUrl: false });
  return { fileTicket: ticket.fileTicket, path: filePath, size: st.size };
}

async function uploadVideoWithCover(apiKey, videoPath, coverPath = '', durationSeconds = null) {
  const video = await uploadVideo(apiKey, videoPath);
  const suppliedDuration = Number(durationSeconds);
  const duration = Number.isFinite(suppliedDuration) && suppliedDuration > 0
    ? suppliedDuration
    : probeVideoDuration(video.path);
  let generated = null;
  try {
    const resolvedCover = coverPath
      ? resolveImagePath(coverPath)
      : (generated = extractVideoCover(video.path)).coverPath;
    const cover = await uploadImage(apiKey, resolvedCover);
    return { ...video, cover, durationSeconds: duration, autoGeneratedCover: !coverPath, uploadCount: 2 };
  } finally {
    if (generated) cleanupVideoCover(generated.coverPath, generated.tempDir);
  }
}

module.exports = {
  getContentType,
  resolveImagePath,
  resolveMediaPath,
  assertImagePath,
  assertVideoPath,
  uploadImage,
  uploadImages,
  uploadVideo,
  uploadVideoWithCover,
  probeVideoDuration,
  extractVideoCover,
  cleanupVideoCover
};
