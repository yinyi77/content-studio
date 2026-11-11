import path from 'node:path';
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { imageInfo } from './reference-images.mjs';

const ACCOUNT_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const FILENAME = /^[a-f0-9]{64}\.(?:png|jpg|webp)$/;
const MAX_IMAGES = 18;
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function account(value) { if (typeof value !== 'string' || !ACCOUNT_ID.test(value)) fail('小红书图片账号无效'); return value; }
function filename(value) { if (typeof value !== 'string' || !FILENAME.test(value)) fail('小红书缓存图片编号无效'); return value; }
const localUrl = (id, file) => `/media/xhs/${id}/${file}`;

/** Safe to persist: no blob/data URLs, foreign hosts, credentials, or other accounts. */
export function normalizeXhsImageUrl(value, { accountId } = {}) {
  if (typeof value !== 'string' || !value || value.length > 8192 || value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value)) return '';
  const local = value.match(/^\/media\/xhs\/([a-zA-Z0-9_-]{1,120})\/([a-f0-9]{64}\.(?:png|jpg|webp))$/);
  if (local) return ACCOUNT_ID.test(accountId || '') && local[1] === accountId ? value : '';
  try {
    const parsed = new URL(value), host = parsed.hostname;
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) return '';
    if (!['xhscdn.com', 'xiaohongshu.com'].some(domain => host === domain || host.endsWith(`.${domain}`))) return '';
    parsed.protocol = 'https:'; parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) if (/cookie|token|auth|secret|key|password|session|sign|credential|policy|expires|xsec|^x-[st]$/i.test(key)) parsed.searchParams.delete(key);
    return parsed.href;
  } catch { return ''; }
}

function decodeAsset(asset, count, seen) {
  if (!object(asset) || !Number.isInteger(asset.index) || asset.index < 0 || asset.index >= count || seen.has(asset.index)) fail('小红书缓存图片槽位无效或重复');
  seen.add(asset.index);
  if (!Object.hasOwn(EXTENSIONS, asset.mime) || typeof asset.base64 !== 'string') fail('小红书缓存图片类型无效');
  if (asset.base64.length > Math.ceil(MAX_BYTES / 3) * 4) fail('单张小红书图片不能超过 15 MB', 413);
  if (!asset.base64.length || asset.base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.base64)) fail('小红书缓存图片数据无效');
  const bytes = Buffer.from(asset.base64, 'base64');
  if (!bytes.length || bytes.toString('base64') !== asset.base64) fail('小红书缓存图片数据无效');
  if (bytes.length > MAX_BYTES) fail('单张小红书图片不能超过 15 MB', 413);
  let info;
  try { info = imageInfo(bytes); } catch (error) { fail('小红书缓存图片不是有效的静态 PNG、JPEG 或 WebP', error.status === 413 ? 413 : 400); }
  if (info.mime !== asset.mime) fail('小红书缓存图片类型与实际内容不一致');
  return { index: asset.index, bytes, file: `${sha(bytes)}.${EXTENSIONS[info.mime]}` };
}

/** Private content-addressed assets. Permission to reference an image stays with the account service. */
export class XhsMediaCache {
  constructor({ dir } = {}) {
    if (typeof dir !== 'string' || !dir) fail('小红书图片缓存缺少数据目录');
    this.dir = path.resolve(dir);
  }
  async #directory(accountId, { create = false } = {}) {
    const id = account(accountId);
    try {
      if (create) await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const baseStat = await lstat(this.dir);
      if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) fail('小红书图片缓存目录不安全', 409);
      const base = await realpath(this.dir), root = path.join(base, 'xhs-media'), folder = path.join(root, id);
      for (const dir of [root, folder]) {
        if (create) { try { await mkdir(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
        const stat = await lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(dir) !== dir) fail('小红书图片缓存目录不安全', 409);
      }
      return folder;
    } catch (error) {
      if (error.status) throw error;
      fail(error.code === 'ENOENT' ? '小红书缓存图片不存在' : '小红书图片缓存目录暂不可用', error.code === 'ENOENT' ? 404 : 500);
    }
  }
  async read(accountId, name) {
    const id = account(accountId), file = filename(name), folder = await this.#directory(id);
    let handle;
    try {
      const target = path.join(folder, file);
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_BYTES) fail('小红书缓存图片记录无效', 409);
      // Both the named file and its enclosing directories must still resolve
      // inside this account after opening; the final component never follows links.
      if (await this.#directory(id) !== folder || await realpath(target) !== target) fail('小红书图片缓存路径不安全', 409);
      const named = await lstat(target);
      if (named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino) fail('小红书图片缓存路径不安全', 409);
      // Bound allocation even if another process grows the file during a read.
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || sha(bytes) !== file.slice(0, 64)) fail('小红书缓存图片内容已变化', 409);
      let info;
      try { info = imageInfo(bytes); } catch { fail('小红书缓存图片内容无效', 409); }
      if (info.mime !== MIME[file.split('.').at(-1)]) fail('小红书缓存图片类型不一致', 409);
      return { bytes, mime: info.mime };
    } catch (error) {
      if (error.status) throw error;
      fail(error.code === 'ENOENT' ? '小红书缓存图片不存在' : '小红书缓存图片不可读取', error.code === 'ENOENT' ? 404 : ['ELOOP', 'EMLINK'].includes(error.code) ? 409 : 500);
    } finally { await handle?.close(); }
  }
  async #store(accountId, asset) {
    const folder = await this.#directory(accountId, { create: true }), target = path.join(folder, asset.file);
    let handle;
    try {
      handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      if (await this.#directory(accountId) !== folder || await realpath(target) !== target) fail('小红书图片缓存路径不安全', 409);
      await handle.writeFile(asset.bytes); await handle.sync();
    } catch (error) {
      if (error.status) throw error;
      if (error.code !== 'EEXIST') fail('小红书图片暂时无法缓存', 500);
      // Existing content is never overwritten, including files whose contents
      // no longer agree with their name. read() verifies the actual bytes below.
    } finally { await handle?.close(); }
    await this.read(accountId, asset.file);
    return localUrl(accountId, asset.file);
  }
  async materialize(detail, { accountId } = {}) {
    const id = account(accountId);
    if (!object(detail)) fail('小红书图片详情无效');
    const { imageAssets, ...result } = detail;
    const slots = Array.isArray(detail.images) ? detail.images : [];
    if (slots.length > MAX_IMAGES || Array.isArray(imageAssets) && imageAssets.length > MAX_IMAGES) fail('小红书图片不能超过 18 张', 413);
    if (imageAssets !== undefined && !Array.isArray(imageAssets)) fail('小红书缓存图片列表无效');
    const seen = new Set(), assets = new Map(); let total = 0;
    for (const raw of imageAssets || []) {
      const asset = decodeAsset(raw, slots.length, seen); total += asset.bytes.length;
      if (total > MAX_TOTAL_BYTES) fail('小红书图片总大小不能超过 64 MB', 413);
      assets.set(asset.index, asset);
    }
    const images = []; let complete = slots.length > 0 && Array.isArray(detail.images);
    for (let index = 0; index < slots.length; index++) {
      const asset = assets.get(index);
      if (asset) { images.push(await this.#store(id, asset)); continue; }
      const normalized = normalizeXhsImageUrl(slots[index], { accountId: id });
      if (!normalized) { complete = false; continue; }
      if (normalized.startsWith('/media/xhs/')) {
        try {
          const stored = await this.read(id, normalized.split('/').at(-1)); total += stored.bytes.length;
          if (total > MAX_TOTAL_BYTES) fail('小红书图片总大小不能超过 64 MB', 413);
        } catch (error) { if (error.status === 413) throw error; complete = false; continue; }
      }
      images.push(normalized);
    }
    return { ...result, images, isComplete: detail.isComplete === true && complete };
  }
}
