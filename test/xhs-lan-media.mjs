import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { XhsLanMedia } from '../lib/xhs-lan-media.mjs';

const loopback = 'http://127.0.0.1:0';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function get(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, res => {
      const chunks = [];
      res.on('error', reject);
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xhs-lan-'));
  const projectId = randomUUID();
  const imageDir = path.join(dir, 'projects', projectId, 'images');
  const images = ['jpg', 'png', 'webp'].map(ext => path.join(imageDir, `${randomUUID()}-${randomUUID()}.${ext}`));
  const contents = ['one', 'two', 'three'].map(text => Buffer.from(text));
  const services = [];
  t.after(async () => {
    for (const service of services) await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(imageDir, { recursive: true });
  await Promise.all(images.map((file, i) => writeFile(file, contents[i])));
  const start = async (origin = loopback) => {
    const service = new XhsLanMedia({ dir, origin, workerIp: '127.0.0.1', ...options });
    services.push(service);
    return service.init();
  };
  return { gateway: await start(), start, dir, imageDir, contents, prepared: { projectId, images, imageHashes: contents.map(sha256) } };
}

test('configuration requires a literal private IPv4 HTTP origin and a single worker address', () => {
  const create = (origin, workerIp = '192.168.1.30') => new XhsLanMedia({ dir: os.tmpdir(), origin, workerIp });
  for (const origin of ['http://0.0.0.0:3000', 'http://localhost:3000', 'http://8.8.8.8:3000', 'http://[::1]:3000',
    'https://192.168.2.1:3000', 'http://192.168.2.1:0', 'http://192.168.2.1:65536', 'http://192.168.2.1:3000/extra',
    'http://user@192.168.2.1:3000', 'http://192.168.2.1:3000/?q=', 'http://192.168.2.1:3000/#x']) {
    assert.throws(() => create(origin), /内网 IPv4/);
  }
  for (const ip of ['0.0.0.0', 'localhost', '10.0.0.0/8', '1.1.1.1']) assert.throws(() => create(loopback, ip), /worker/);
  assert.doesNotThrow(() => create('http://192.168.2.1:3000'));
});

test('a batch exposes just the ordered images, with private URLs and the original bytes and MIME types', async t => {
  const { gateway, prepared, contents } = await fixture(t);
  const urls = await gateway.createUrls(prepared);
  const second = await gateway.createUrls({ projectId: prepared.projectId, images: prepared.images });
  assert.notEqual(second[0], urls[0]);
  const types = ['image/jpeg', 'image/png', 'image/webp'];
  for (const [i, url] of urls.entries()) {
    assert.equal(new URL(url).origin, gateway.origin);
    assert(!url.includes(prepared.projectId));
    assert(!url.includes(path.basename(prepared.images[i])));
    const full = await get(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers['content-type'], types[i]);
    assert.equal(full.headers['cache-control'], 'no-store');
    assert.deepEqual(full.bytes, contents[i]);
    const head = await get(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(contents[i].length));
    assert.equal(head.bytes.length, 0);
  }
  for (const suffix of ['/', '/api/xhs', '/media/', new URL(urls[0]).pathname.replace('1.jpg', ''), new URL(urls[0]).pathname + '?cache=1']) {
    assert.equal((await get(gateway.origin + suffix)).status, 404);
  }
  assert.equal((await get(urls[0].replace('1.jpg', '1.png'))).status, 404);
  assert.equal((await get(urls[0], { method: 'POST' })).status, 405);
  assert.equal((await get(urls[0], { headers: { Host: 'other.example' } })).status, 403);
});

test('only the workstation and configured worker can read the same signed URL', async t => {
  const workerIp = '192.168.1.30';
  const { gateway, prepared, contents } = await fixture(t, { workerIp });
  const [url] = await gateway.createUrls(prepared);
  const local = await get(url);
  assert.equal(local.status, 200);
  assert.deepEqual(local.bytes, contents[0]);

  // Exercise off-host identities without requiring another network interface.
  async function servePeer(remoteAddress, headers = {}) {
    const { host, pathname } = new URL(url);
    const response = { setHeader() {}, writeHead(status) { this.status = status; }, end(bytes) { this.bytes = bytes; } };
    await gateway.serve({
      method: 'GET', url: pathname, socket: { remoteAddress }, headers: { host, ...headers }, headersDistinct: { host: [host] },
    }, response);
    return response;
  }
  for (const address of [workerIp, '::ffff:' + workerIp]) {
    const worker = await servePeer(address);
    assert.equal(worker.status, 200);
    assert.deepEqual(worker.bytes, contents[0]);
  }
  const denied = await servePeer('192.168.1.31', { 'x-forwarded-for': workerIp, 'x-real-ip': '127.0.0.1' });
  assert.equal(denied.status, 403);
  assert.equal(denied.bytes, undefined);
});

test('a local JSON export creates links on the running gateway without another listener', async t => {
  const { dir, gateway, prepared, contents } = await fixture(t);
  const writer = new XhsLanMedia({ dir, origin: gateway.origin, workerIp: '127.0.0.1' });
  const urls = await writer.exportUrls(prepared);
  assert.equal(writer.server, undefined);
  for (const [i, url] of urls.entries()) {
    const response = await get(url);
    assert.equal(response.status, 200);
    assert.deepEqual(response.bytes, contents[i]);
  }
});

test('the exact batch survives restart and expires after 24 hours until explicitly renewed', async t => {
  let time = 1_000_000;
  const { gateway, prepared, start } = await fixture(t, { now: () => time });
  const urls = await gateway.createUrls(prepared);
  const also = await gateway.createUrls(prepared);
  time += 24 * 60 * 60 * 1000 - 1;
  assert.equal((await get(urls[0])).status, 200);
  await gateway.close();
  const restart = await start(gateway.origin);
  assert.equal((await get(urls[0])).status, 200);
  time++;
  assert.equal((await get(urls[0])).status, 404);
  const external = ['https://old.example/xhs-media/archive/media/1.png'];
  assert.deepEqual(await restart.renewUrls(external), external);
  for (const invalid of [[urls[0]], urls.toReversed(), [urls[0], also[1], urls[2]], [urls[0], external[0], urls[2]],
    [urls[0] + '?renew'], [urls[0].replace('1.jpg', 'other')], urls.map(url => url.replace(restart.origin, 'https://old.example')), ['file:///example.png']]) {
    await assert.rejects(restart.renewUrls(invalid), /记录/);
  }
  assert.equal((await get(urls[0])).status, 404);
  assert.deepEqual(await restart.renewUrls(urls), urls);
  for (const url of urls) assert.equal((await get(url)).status, 200);
  assert.equal((await get(also[0])).status, 404);
  await restart.close();
  await restart.close();
  await assert.rejects(get(urls[0]));
});

test('requires versioned regular files inside this project, and binds to their original hashes', async t => {
  let time = 10;
  const { gateway, prepared, imageDir, dir, contents } = await fixture(t, { now: () => time, ttlMs: 2 });
  const urls = await gateway.createUrls(prepared);
  await assert.rejects(gateway.createUrls({ ...prepared, imageHashes: [] }), /原稿/);
  await assert.rejects(gateway.createUrls({ ...prepared, imageHashes: prepared.imageHashes.toReversed() }), /原稿/);
  const outside = path.join(dir, path.basename(prepared.images[0]));
  await writeFile(outside, contents[0]);
  const plain = path.join(imageDir, 'cover.jpg');
  await writeFile(plain, contents[0]);
  const folder = path.join(imageDir, randomUUID() + '-' + randomUUID() + '.jpg');
  await mkdir(folder);
  for (const image of [outside, plain, folder]) await assert.rejects(gateway.createUrls({ projectId: prepared.projectId, images: [image] }), /原稿/);
  await assert.rejects(gateway.createUrls({ ...prepared, projectId: randomUUID() }), /原稿/);
  await writeFile(prepared.images[0], 'new bytes');
  assert.equal((await get(urls[0])).status, 404);
  assert.equal((await get(urls[1])).status, 200);
  time += 2;
  await assert.rejects(gateway.renewUrls(urls), /原稿/);
  assert.equal((await get(urls[1])).status, 404);
  await rm(prepared.images[0]);
  await assert.rejects(gateway.renewUrls(urls), /原稿/);
  await symlink(outside, prepared.images[0]);
  await assert.rejects(gateway.createUrls(prepared), /原稿/);
  await assert.rejects(gateway.renewUrls(urls), /原稿/);
  await rm(prepared.images[0]);
  await writeFile(prepared.images[0], contents[0]);
  await gateway.renewUrls(urls);
  const relocated = path.join(dir, 'relocated-images');
  await rename(imageDir, relocated);
  await symlink(relocated, imageDir);
  await assert.rejects(gateway.createUrls(prepared), /原稿/);
  assert.equal((await get(urls[0])).status, 404);
});
