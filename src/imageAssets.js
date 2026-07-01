const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const IMAGE_DIR = path.join(DATA_DIR, 'images');
const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function ensureImageDir() {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function normalizeAssetFilename(filename = '') {
  const raw = path.basename(String(filename || '').trim());
  if (!raw || raw === '.' || raw === '..') throw new Error('invalid_image_filename');
  const ext = path.extname(raw).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) throw new Error(`unsupported_image_type:${ext || 'none'}`);
  return raw;
}

function assetPath(filename = '') {
  ensureImageDir();
  return path.join(IMAGE_DIR, normalizeAssetFilename(filename));
}

function safeStoredName(originalName = '') {
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) throw new Error(`unsupported_image_type:${ext || 'none'}`);
  const stem = path.basename(originalName, ext)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'image';
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return `${ts}-${crypto.randomBytes(3).toString('hex')}-${stem}${ext}`;
}

function listImageAssets() {
  ensureImageDir();
  return fs.readdirSync(IMAGE_DIR)
    .filter(name => {
      try { normalizeAssetFilename(name); return true; } catch { return false; }
    })
    .map(name => {
      const file = path.join(IMAGE_DIR, name);
      const st = fs.statSync(file);
      return {
        filename: name,
        relativePath: `images/${name}`,
        size: st.size,
        mtime: st.mtime.toISOString(),
        contentType: contentTypeFor(name)
      };
    })
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
}

function saveImageAsset(originalName, buffer) {
  ensureImageDir();
  if (!Buffer.isBuffer(buffer)) throw new Error('invalid_image_buffer');
  if (buffer.length <= 0) throw new Error('empty_image');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`image_too_large:max_${MAX_IMAGE_BYTES}`);
  const filename = safeStoredName(originalName);
  const file = path.join(IMAGE_DIR, filename);
  fs.writeFileSync(file, buffer);
  const st = fs.statSync(file);
  return {
    filename,
    relativePath: `images/${filename}`,
    size: st.size,
    mtime: st.mtime.toISOString(),
    contentType: contentTypeFor(filename)
  };
}

function deleteImageAsset(filename) {
  const file = assetPath(filename);
  if (!fs.existsSync(file)) throw new Error('image_not_found');
  fs.unlinkSync(file);
  return { ok: true, filename: path.basename(file) };
}

function selectImagePaths(settings = {}, seed = 0) {
  if (settings.enableImagePosts !== true) return [];
  const mode = String(settings.imagePostMode || (settings.imagePaths?.length ? 'static' : 'off')).toLowerCase();
  const count = Math.max(1, Math.min(4, Number(settings.imagePathCount || 1)));
  const staticPaths = (settings.imagePaths || []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 4);
  if (mode === 'off') return [];
  if (mode === 'static') return staticPaths.slice(0, count);
  const assets = listImageAssets();
  if (!assets.length) return staticPaths.slice(0, count);
  if (mode === 'rotate') {
    const start = Math.abs(Number(seed || 0)) % assets.length;
    return Array.from({ length: Math.min(count, assets.length) }, (_, i) => assets[(start + i) % assets.length].relativePath);
  }
  if (mode === 'random') {
    const pool = [...assets];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count).map(x => x.relativePath);
  }
  return staticPaths.slice(0, count);
}

module.exports = {
  IMAGE_DIR,
  ALLOWED_EXTS,
  MAX_IMAGE_BYTES,
  contentTypeFor,
  normalizeAssetFilename,
  assetPath,
  listImageAssets,
  saveImageAsset,
  deleteImageAsset,
  selectImagePaths
};
