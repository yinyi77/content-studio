import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const projectIdPattern = new RegExp(`^${uuid}$`);
const filenamePattern = new RegExp(`^${uuid}-${uuid}\\.(png|jpg|webp)$`);
const digestPattern = /^[a-f0-9]{64}$/;
const mediaPath = /^\/xhs-media\/([a-f0-9]{64})\/([1-9]|1[0-8])\.(png|jpg|webp)$/;
const types = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const maxBytes = 30 * 1024 * 1024;
const dayMs = 24 * 60 * 60 * 1000;
const imageError = '原稿图片已移除、变更或无法安全读取，请检查作品。';
const batchError = '临时图片链接与原送稿记录不一致，请检查原记录。';

function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
function privateIp(ip) {
  return isIPv4(ip) && (ip === '127.0.0.1' || ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
}
function route(token, index, name) {
  return `/xhs-media/${token}/${index + 1}${path.extname(name)}`;
}
function parseOrigin(origin) {
  const match = typeof origin === 'string' && /^http:\/\/(\d+\.\d+\.\d+\.\d+)(?::(0|[1-9]\d{0,4}))?\/?$/.exec(origin);
  if (!match || !privateIp(match[1]) || Number(match[2]) > 65535 || (match[2] === '0' && match[1] !== '127.0.0.1')) {
    fail('请配置本机明确的内网 IPv4 图片服务地址及有效 HTTP 端口。', 400);
  }
  return new URL(origin);
}

export class XhsLanMedia {
  constructor({ dir, origin, workerIp, now = Date.now, ttlMs = dayMs }) {
    this.address = parseOrigin(origin);
    if (typeof workerIp !== 'string' || !privateIp(workerIp)) fail('请配置图片下载 worker 的内网 IPv4 地址。', 400);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || typeof now !== 'function') fail('临时图片链接有效期配置无效。', 400);
    this.dir = path.resolve(dir);
    this.workerIp = workerIp;
    this.origin = this.address.origin;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  async openStore() {
    if (this.address.hostname !== '127.0.0.1' && !Object.values(networkInterfaces()).flat().some(entry => entry?.address === this.address.hostname)) {
      fail('图片服务地址未绑定到本机网卡。', 503);
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const root = await realpath(this.dir);
    const manifests = path.join(root, 'xhs-lan-media');
    await mkdir(manifests, { recursive: true, mode: 0o700 });
    if (await realpath(manifests) !== manifests) fail('临时图片记录目录无效。', 503);
    this.root = root;
    this.manifests = manifests;
  }

  async init() {
    if (this.server?.listening) return this;
    try {
      await this.openStore();
      this.server = createServer((req, res) => {
        this.serve(req, res).catch(() => { res.writeHead(404); res.end(); });
      });
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(Number(this.address.port || 80), this.address.hostname, () => {
          this.server.off('error', reject);
          resolve();
        });
      });
      this.origin = new URL(`http://${this.address.hostname}:${this.server.address().port}`).origin;
      this.host = new URL(this.origin).host;
      return this;
    } catch (error) {
      await this.close();
      if (error.status) throw error;
      fail('内网图片服务启动失败，请检查本机地址、端口与数据目录。', 503);
    }
  }

  async close() {
    const server = this.server;
    this.server = null;
    if (server?.listening) await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }

  // Hash and send bytes from the same open file. Check its identity and the
  // entire resolved path after opening to reject replaced files and symlinks.
  async readImage(projectId, name, expectedHash) {
    let handle;
    try {
      if (!projectIdPattern.test(projectId) || !filenamePattern.test(name)) fail(imageError);
      const file = path.join(this.root, 'projects', projectId, 'images', name);
      if (await realpath(file) !== file) fail(imageError);
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) fail(imageError);
      const bytes = await handle.readFile();
      const current = await lstat(file);
      if (bytes.length !== stat.size || !current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || await realpath(file) !== file) fail(imageError);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (expectedHash !== undefined && expectedHash !== sha256) fail(imageError);
      return { bytes, sha256 };
    } catch { fail(imageError); }
    finally { await handle?.close(); }
  }

  async storeBatch(token, batch) {
    const target = path.join(this.manifests, token + '.json');
    const temp = target + '.' + randomUUID() + '.tmp';
    try {
      if (await realpath(this.manifests) !== this.manifests) fail(batchError);
      await writeFile(temp, JSON.stringify(batch), { mode: 0o600, flag: 'wx' });
      await rename(temp, target);
    } catch { fail('无法保存临时图片记录。', 503); }
    finally { await rm(temp, { force: true }).catch(() => {}); }
  }

  async loadBatch(token) {
    let handle;
    try {
      const file = path.join(this.manifests, token + '.json');
      if (await realpath(file) !== file) fail(batchError);
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 8192) fail(batchError);
      const batch = JSON.parse(await handle.readFile('utf8'));
      if (batch.origin !== this.origin || batch.workerIp !== this.workerIp || !projectIdPattern.test(batch.projectId)
        || !Number.isSafeInteger(batch.expiresAt) || !Array.isArray(batch.images) || batch.images.length < 1 || batch.images.length > 18
        || batch.images.some(image => !filenamePattern.test(image.name) || !digestPattern.test(image.sha256))) fail(batchError);
      return batch;
    } catch { fail(batchError); }
    finally { await handle?.close(); }
  }

  async createUrls(prepared) {
    if (!this.server?.listening) fail('内网图片服务尚未就绪。', 503);
    return this.exportUrls(prepared);
  }

  // A local export shares the running gateway's on-disk grants. The gateway
  // still checks the reader address, origin, expiry and bytes on every read.
  async exportUrls(prepared) {
    if (new URL(this.origin).port === '0') fail('导出链接需要使用图片服务实际监听的端口。', 503);
    if (!this.manifests) await this.openStore();
    const { projectId, images, imageHashes } = prepared || {};
    if (typeof projectId !== 'string' || !projectIdPattern.test(projectId) || !Array.isArray(images) || images.length < 1 || images.length > 18) fail(imageError);
    if (imageHashes !== undefined && (!Array.isArray(imageHashes) || imageHashes.length !== images.length
      || Array.from(imageHashes).some(value => typeof value !== 'string' || !digestPattern.test(value)))) fail(imageError);
    const batchImages = [];
    let total = 0;
    for (const [index, file] of images.entries()) {
      if (typeof file !== 'string' || !path.isAbsolute(file)) fail(imageError);
      const name = path.basename(file);
      const relative = path.join('projects', projectId, 'images', name);
      if (file !== path.join(this.root, relative) && file !== path.join(this.dir, relative)) fail(imageError);
      const { bytes, sha256 } = await this.readImage(projectId, name, imageHashes?.[index]);
      total += bytes.length;
      if (total > 128 * 1024 * 1024) fail('单次送稿图片超过 128 MiB。');
      batchImages.push({ name, sha256 });
    }
    const token = randomBytes(32).toString('hex');
    await this.storeBatch(token, { origin: this.origin, workerIp: this.workerIp, projectId, images: batchImages, expiresAt: Number(this.now()) + this.ttlMs });
    return batchImages.map((image, i) => this.origin + route(token, i, image.name));
  }

  async renewUrls(urls) {
    if (!this.server?.listening) fail('内网图片服务尚未就绪。', 503);
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > 18) fail(batchError);
    const parsed = Array.from(urls, value => {
      let url;
      try { url = new URL(value); } catch { fail(batchError); }
      if (typeof value !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail(batchError);
      return url;
    });
    // Legacy submissions can point to a separately managed media origin.
    if (parsed.every(url => url.origin !== this.origin && !mediaPath.test(url.pathname))) return urls;
    const token = mediaPath.exec(parsed[0].pathname)?.[1];
    if (!token || parsed.some(url => url.origin !== this.origin)) fail(batchError);
    const batch = await this.loadBatch(token);
    if (urls.length !== batch.images.length || batch.images.some((image, i) => urls[i] !== this.origin + route(token, i, image.name))) fail(batchError);
    for (const image of batch.images) await this.readImage(batch.projectId, image.name, image.sha256);
    await this.storeBatch(token, { ...batch, expiresAt: Number(this.now()) + this.ttlMs });
    return urls;
  }

  async serve(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const source = req.socket.remoteAddress?.replace(/^::ffff:/i, '');
    const allowedSource = source === this.address.hostname || source === this.workerIp;
    if (!allowedSource || req.headersDistinct.host?.length !== 1 || req.headers.host !== this.host) {
      res.writeHead(403); return res.end();
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    const match = mediaPath.exec(req.url);
    if (!match) { res.writeHead(404); return res.end(); }
    const [, token, ordinal, ext] = match;
    const batch = await this.loadBatch(token);
    const image = batch.images[Number(ordinal) - 1];
    if (this.now() >= batch.expiresAt || !image || path.extname(image.name) !== '.' + ext) { res.writeHead(404); return res.end(); }
    const { bytes } = await this.readImage(batch.projectId, image.name, image.sha256);
    if (this.now() >= batch.expiresAt) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[ext], 'Content-Length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }
}
