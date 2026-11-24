import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createXhsConnector } from '../lib/xhs-connector.mjs';

const accountId = 'test_lan_account';
const token = 'test-only-lan-bearer';
// Distinct 1×1 red and green PNGs make dropped or reordered pages observable.
const pages = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC',
].map(encoded => Buffer.from(encoded, 'base64'));

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('LAN worker reads ordered draft images and repeated delivery reuses the verified record after restart', { timeout: 20_000 }, async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-xhs-lan-')));
  const projectId = randomUUID();
  const imageDir = path.join(dir, 'projects', projectId, 'images');
  const images = pages.map(() => path.join(imageDir, randomUUID() + '-' + randomUUID() + '.png'));
  const input = { projectId, accountId, fingerprint: 'a'.repeat(64), title: '局域网草稿', content: '两页图片按原顺序交付。', images };
  const job = { job_id: 'job_' + '1'.repeat(32), draft_id: 'draft_' + '2'.repeat(32),
    account_id: accountId, action: 'create_draft', content_version: 1, content_hash: 'b'.repeat(64) };

  let mediaOrigin;
  let allowedHosts = ['media.example.test'];
  let creates = 0;
  let connector;
  let workerFailure;
  const downloaded = [];
  const worker = http.createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.url === '/health/live') return json(200, { status: 'ok' });
      assert.equal(req.headers.authorization, 'Bearer ' + token);
      if (req.url === '/health/ready') return json(200, { database: 'ok', worker_active: true, account_paused: false, image_allowed_hosts: allowedHosts });
      if (req.url === '/v1/accounts') return json(200, { items: [{ account_id: accountId, paused: false, publish_enabled: false }] });
      if (req.method === 'POST' && req.url === '/v1/jobs') {
        creates++;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        assert.equal(body.action, 'create_draft');
        assert.equal(body.account_id, accountId);
        assert.ok(req.headers['idempotency-key']);
        assert.equal(body.content.image_urls.length, pages.length);
        for (const imageUrl of body.content.image_urls) {
          assert.equal(new URL(imageUrl).origin, mediaOrigin);
          const response = await fetch(imageUrl, { redirect: 'error' });
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('content-type'), 'image/png');
          downloaded.push(Buffer.from(await response.arrayBuffer()));
        }
        assert.deepEqual(downloaded, pages);
        return json(202, { ...job, status: 'queued' });
      }
      if (req.method === 'GET' && req.url === '/v1/jobs/' + job.job_id) return json(200, { ...job, status: 'succeeded' });
      if (req.method === 'GET' && req.url === '/v1/drafts/' + job.draft_id) {
        return json(200, { ...job, active_job_id: job.job_id, title: input.title, caption: input.content,
          image_count: pages.length, phase: 'ready', platform_status: 'draft_verified' });
      }
      assert.fail('Unexpected service request ' + req.method + ' ' + req.url);
    } catch (error) {
      workerFailure = error;
      json(500, {});
    }
  });
  t.after(async () => {
    try { await connector?.close(); }
    finally {
      if (worker.listening) await close(worker);
      await rm(dir, { recursive: true, force: true });
    }
  });

  await mkdir(imageDir, { recursive: true });
  await Promise.all(images.map((file, index) => writeFile(file, pages[index])));
  const workerPort = await listen(worker);
  const reserve = http.createServer();
  const mediaPort = await listen(reserve);
  mediaOrigin = 'http://127.0.0.1:' + mediaPort;
  await close(reserve);
  const options = { root: dir, dir, port: 0, env: { XHS_PUBLISHER_BASE_URL: 'http://127.0.0.1:' + workerPort,
    XHS_PUBLISHER_TOKEN: token, XHS_PUBLISHER_ACCOUNT_ID: accountId,
    XHS_PUBLISHER_LAN_MEDIA_ORIGIN: mediaOrigin, XHS_PUBLISHER_WORKER_IP: '127.0.0.1' } };
  connector = await createXhsConnector(options);
  await connector.init();
  const blocked = await connector.checkLogin();
  assert.equal(blocked.connection.state, 'connected');
  assert.equal(blocked.deliveryConfiguration.configured, false);
  await assert.rejects(connector.submitDraft(input), { submissionNotAttempted: true });
  assert.deepEqual(connector.snapshot().drafts, []);
  assert.equal(creates, 0);

  allowedHosts = ['127.0.0.1'];
  assert.equal((await connector.checkLogin()).deliveryConfiguration.configured, true);
  for (const route of ['/api/xhs', '/api/projects', '/media/' + projectId + '/' + path.basename(images[0])]) {
    const response = await fetch(mediaOrigin + route, { redirect: 'manual' });
    assert.ok(response.status >= 400 && response.status < 500, route + ' HTTP ' + response.status);
    await response.arrayBuffer();
  }
  const { draft, duplicate } = await connector.submitDraft(input);
  assert.equal(duplicate, false);
  let observed;
  for (let i = 0; i < 150; i++) {
    if (workerFailure) throw workerFailure;
    observed = connector.snapshot().drafts.find(row => row.id === draft.id);
    if (observed && !['queued', 'running'].includes(observed.status)) break;
    await sleep(25);
  }
  if (workerFailure) throw workerFailure;
  assert.equal(observed?.status, 'verified', observed?.message);
  assert.deepEqual(downloaded, pages);
  await connector.close();
  connector = undefined;
  await assert.rejects(fetch(mediaOrigin + '/api/xhs'));

  connector = await createXhsConnector(options);
  await connector.init();
  const existing = await connector.submitDraft(input);
  assert.equal(existing.duplicate, true);
  assert.equal(existing.draft.id, draft.id);
  assert.equal(existing.draft.status, 'verified');
  assert.equal(creates, 1);
});
