import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createXhsConnector } from '../lib/xhs-connector.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const accountId = 'xhs_account_001';
const token = 'test-only-bearer';
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function fixture(dir, delivery) {
  const id = randomUUID(), pageId = randomUUID(), filename = pageId + '-' + randomUUID() + '.png';
  const images = path.join(dir, 'projects', id, 'images');
  await mkdir(images, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(images, filename), png);
  const page = { id: pageId, imageUrl: '/media/' + id + '/' + filename, status: 'done' };
  const project = { id, title: '本地联调作品', caption: '测试草稿正文', createdAt: new Date().toISOString(), status: 'completed', chatStatus: 'idle',
    pages: [page], ...(delivery ? { xhsDelivery: delivery } : {}) };
  await writeFile(path.join(images, '..', 'project.json'), JSON.stringify(project));
  return { project, png };
}

test('publisher configuration supports a private file, overrides, and query-only access without usable cross-host media', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'studio-publisher-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { dir, root: dir, port: 4300, env: {} };
  const empty = await createXhsConnector(options);
  await empty.init();
  assert.equal(empty.snapshot().configured, false);
  assert.equal(empty.snapshot().connection.state, 'unconfigured');
  assert.equal(empty.snapshot().account, null);
  await empty.close();
  const retired = await createXhsConnector({ ...options, env: { XHS_PROVIDER: 'local' } });
  assert.equal(retired.snapshot().provider, 'publisher');
  assert.equal(retired.snapshot().configured, false);
  await assert.rejects(retired.checkLogin(), { status: 503 });
  await retired.close();
  await writeFile(path.join(dir, '.env.xhs-publisher'), 'XHS_PUBLISHER_BASE_URL=https://publisher.example.test/service\n');
  const missingToken = await createXhsConnector(options);
  assert.equal(missingToken.snapshot().configured, false);
  assert.match(missingToken.snapshot().connection.message, /XHS_PUBLISHER_TOKEN/);
  await missingToken.close();
  for (const mediaUrl of ['', 'http://127.0.0.2', 'http://[::1]', 'http://localhost.', 'http://[::ffff:127.0.0.1]', 'invalid']) {
    const readOnly = await createXhsConnector({ ...options, env: { XHS_PUBLISHER_TOKEN: token, XHS_PUBLISHER_MEDIA_BASE_URL: mediaUrl } });
    const state = readOnly.snapshot();
    assert.equal(state.configured, true);
    assert.equal(state.account.id, accountId);
    assert.equal(state.deliveryConfiguration.configured, false);
    assert.match(state.deliveryConfiguration.message, /XHS_PUBLISHER_MEDIA_BASE_URL/);
    await assert.rejects(readOnly.submitDraft({ accountId }), { status: 503, code: 'PUBLISHER_MEDIA_CONFIG', submissionNotAttempted: true });
    await readOnly.close();
  }
  for (const settings of [
    { XHS_PUBLISHER_LAN_MEDIA_ORIGIN: 'http://127.0.0.1:8766' },
    { XHS_PUBLISHER_LAN_MEDIA_ORIGIN: 'http://0.0.0.0:8766' },
    { XHS_PUBLISHER_LAN_MEDIA_ORIGIN: 'http://192.168.1.20:8766', XHS_PUBLISHER_WORKER_IP: '0.0.0.0' },
    { XHS_PUBLISHER_LAN_MEDIA_ORIGIN: 'http://192.168.1.20:8766', XHS_PUBLISHER_MEDIA_BASE_URL: 'https://media.example.test' },
  ]) {
    const service = await createXhsConnector({ ...options, env: { ...settings, XHS_PUBLISHER_TOKEN: token } });
    assert.equal(service.snapshot().configured, true);
    assert.equal(service.snapshot().deliveryConfiguration.configured, false);
    assert.equal(service.lanMedia, undefined);
    await service.close();
  }
  const service = await createXhsConnector({ ...options, env: { XHS_PUBLISHER_TOKEN: token, XHS_PUBLISHER_MEDIA_BASE_URL: 'https://media.example.test' } });
  assert.equal(service.snapshot().configured, true);
  assert.equal(service.snapshot().deliveryConfiguration.configured, true);
  await service.close();
});

test('existing project and account routes deliver via publisher and reconcile a verified draft', { timeout: 25_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'studio-publisher-http-'));
  const reserve = http.createServer();
  const port = await listen(reserve);
  await new Promise(resolve => reserve.close(resolve));
  const studio = 'http://127.0.0.1:' + port;
  const { project, png } = await fixture(dir);
  // Same logical account ID across old/new environments must never migrate a pending delivery.
  const legacy = await fixture(dir, { enabled: true, accountId, status: 'queued', attempted: false });
  const jobId = 'job_' + 'a'.repeat(32), draftId = 'draft_' + 'b'.repeat(32), hash = 'e'.repeat(64);
  const writes = [], violations = [];
  let paused = true, receivedImage;
  const accountInfo = { account_id: accountId, publish_enabled: false, nickname: '清晨编辑部',
    enabled: true, executing: false, daily_limit: 3, queued_jobs: 0, needs_attention: 0,
    platform_account_id: '012345', login_status: 'verified', identity_checked_at: '2026-11-22T23:11:12.000Z',
    browser_environment: 'private-browser-directory', metrics: { followers: 168, notes: 0, internal_token: token } };
  const secondId = 'another_account', noteDate = '2026-11-20T05:03:00+00:00';
  const noteAccount = { ...accountInfo, account_id: secondId, metrics: {},
    notes_sync: { status: 'succeeded', last_synced_at: noteDate, coverage: { full_scan: true, tabs: { published: 0 } } } };
  const listed = { account_id: secondId, status: 'published', title: '笔记标题', published_at: noteDate,
    platform_time_text: '2026-11-20 13:03', metrics_raw: [' 1.2万 ', ' ', null, '0', 0], private: '不对外提供' };
  let extraAccounts = [], notesCode = 200;
  const notesJob = 'job_'+'7'.repeat(32), metricsJob = 'job_'+'8'.repeat(32), syncKeys = [];
  let notesPage = { total: 21, offset: 20, limit: 20, items: [listed], last_synced_at: noteDate,
    sync_accounts: [{ account_id: secondId, latest_job_id: notesJob, status: 'failed', error:{code:'BROWSER_BUSY',debug:token} }] };
  const job = { job_id: jobId, draft_id: draftId, account_id: accountId, action: 'create_draft', content_version: 1 };
  const draft = { ...job, active_job_id: jobId, title: project.title, caption: project.caption, image_count: 1, content_hash: hash, phase: 'ready', platform_status: 'draft_verified', jobs: [] };
  const secondJob = { ...job, account_id: secondId, job_id: 'job_'+'c'.repeat(32), draft_id: 'draft_'+'d'.repeat(32) };
  const secondDraft = { ...draft, ...secondJob, active_job_id: secondJob.job_id };
  let scheduledJob;
  const publisher = http.createServer(async (req, res) => {
    const reply = (code, json) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health/live' && !req.headers.authorization) return reply(200, { status: 'ok' });
    if (req.headers.authorization !== 'Bearer ' + token) { violations.push('bearer'); return reply(401, {}); }
    if (url.pathname === '/health/ready') return reply(200, { database: 'ok', worker_active: true, account_paused: paused });
    if (url.pathname === '/v1/accounts') return reply(200, { items: [{ ...accountInfo, paused }, ...extraAccounts] });
    if (url.pathname === '/v1/accounts/'+secondId+'/sync' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const {scope} = JSON.parse(Buffer.concat(chunks));
      assert.ok(['notes','metrics'].includes(scope));
      syncKeys.push(req.headers['idempotency-key']);
      return reply(202,{account_id:secondId, action:'sync_'+scope, job_id:scope==='notes'?notesJob:metricsJob, status:'queued'});
    }
    if ([notesJob,metricsJob].includes(url.pathname.split('/').at(-1)) && req.method==='GET') {
      if (url.searchParams.get('account_id')!==secondId) return reply(404,{});
      const id=url.pathname.split('/').at(-1);
      return reply(200,{account_id:secondId,action:id===notesJob?'sync_notes':'sync_metrics',
        job_id:id,status:'failed',error:{code:'BROWSER_BUSY',debug:token}});
    }
    if (url.pathname === '/v1/notes' && req.method === 'GET' && url.searchParams.get('account_id') === secondId
      && url.searchParams.get('status') === 'published' && url.searchParams.get('limit') === '20' && url.searchParams.get('offset') === '20') {
      return reply(notesCode, notesPage);
    }
    if (req.method === 'POST' && url.pathname === '/v1/jobs') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); writes.push({ key: req.headers['idempotency-key'], body });
      if (body.action === 'schedule_publish' && body.account_id === secondId && body.draft_id === secondJob.draft_id) {
        scheduledJob = { ...secondJob, action: body.action, job_id: 'job_'+'f'.repeat(32), publish_at: body.publish_at, status: 'queued' };
        return reply(202, scheduledJob);
      }
      if (body.action !== 'create_draft') { violations.push('action'); return reply(422, {}); }
      const [imageUrl] = body.content.image_urls;
      if (imageUrl === studio + project.pages[0].imageUrl) receivedImage = Buffer.from(await (await fetch(imageUrl)).arrayBuffer());
      return reply(202, { ...(body.account_id === secondId ? secondJob : job), status: 'queued' });
    }
    if (url.pathname === '/v1/jobs/' + secondJob.job_id) return reply(200, { ...secondJob, status: 'succeeded', content_hash: hash });
    if (url.pathname === '/v1/drafts/' + secondJob.draft_id) return reply(200, secondDraft);
    if (scheduledJob && url.pathname === '/v1/jobs/' + scheduledJob.job_id) return reply(200, scheduledJob);
    if (url.pathname === '/v1/jobs/' + jobId) return reply(200, { ...job, status: 'succeeded', content_hash: hash });
    if (url.pathname === '/v1/drafts/' + draftId) return reply(200, draft);
    if (url.pathname === '/v1/drafts' && url.searchParams.get('limit') === '5') return reply(200, { items: [draft] });
    violations.push(req.method + ' ' + url.pathname); reply(404, {});
  });
  const publisherPort = await listen(publisher);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dir,
    TRENDS_AUTO_REFRESH: '0', XHS_PUBLISHER_BASE_URL: 'http://127.0.0.1:' + publisherPort,
    XHS_PUBLISHER_LAN_MEDIA_ORIGIN: '', XHS_PUBLISHER_MEDIA_BASE_URL: studio,
    XHS_PUBLISHER_TOKEN: token, XHS_PUBLISHER_ACCOUNT_ID: accountId }, stdio: ['ignore','pipe','pipe'] });
  let log = '';
  child.stdout.on('data', c => { log += c; }); child.stderr.on('data', c => { log += c; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
    await new Promise(resolve => publisher.close(resolve)); await rm(dir, { recursive: true, force: true });
  });
  async function api(route, body) {
    const response = await fetch(studio + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  let snapshot;
  for (let i = 0; i < 100 && !snapshot; i++) {
    if (child.exitCode !== null) assert.fail(log);
    try { snapshot = (await api('/api/xhs')).body; } catch { await sleep(30); }
  }
  assert.equal(snapshot?.provider, 'publisher', log);
  assert.equal(snapshot.capabilities.accountAnalytics, false);
  for (const route of ['sync', 'login', 'disconnect', 'open-drafts', 'accounts', 'accounts/' + randomUUID() + '/select',
    'notes/legacy-note', 'official-drafts/' + draftId + '/open']) {
    assert.equal((await api('/api/xhs/' + route, { accountId })).status, 410, route);
  }
  const directory = await api('/api/xhs/accounts');
  assert.equal(directory.status, 200);
  assert.deepEqual(directory.body.accounts, [{
    accountId, paused: true, publishEnabled: false, isDeliveryAccount: true,
    enabled: true, executing: false, dailyLimit: 3, queuedJobs: 0, needsAttention: 0,
    nickname: accountInfo.nickname, platformAccountId: accountInfo.platform_account_id,
    loginStatus: 'verified', identityCheckedAt: accountInfo.identity_checked_at,
    metrics: { followers: 168, following: null, likesAndSaves: null, notes: 0 },
  }]);
  assert.ok(!JSON.stringify(directory.body).includes(token));
  assert.ok(Date.parse(directory.body.fetchedAt));
  extraAccounts = [{ ...noteAccount, paused: true }];
  const secondCount = async () => (await api('/api/xhs/accounts')).body.accounts[1].metrics.notes;
  assert.equal(await secondCount(), 0, 'a complete empty published tab is a real zero');
  noteAccount.notes_sync.coverage.tabs.published = 3;
  assert.equal(await secondCount(), 3);
  noteAccount.notes_sync.coverage.full_scan = false;
  assert.equal(await secondCount(), null);
  noteAccount.notes_sync.coverage.full_scan = true;
  noteAccount.notes_sync.status = 'failed';
  assert.equal(await secondCount(), 3, 'last complete snapshot survives a failed refresh');
  const notesPath = '/api/xhs/accounts/' + secondId + '/notes?offset=20';
  const page = await api(notesPath);
  assert.equal(page.status, 200, 'the second account has read access while paused and separate from the delivery target');
  assert.deepEqual(page.body, {items: [{ title: listed.title, publishedAt: noteDate, publishedTimeText: listed.platform_time_text,
    visibility: 'unknown', rawCounts: ['1.2万', null, null, '0', '0'] }], total: 21, offset: 20, limit: 20, lastSyncedAt: noteDate,
    sync:{jobId:notesJob,status:'failed',error:'BROWSER_BUSY'}});
  assert.deepEqual(syncKeys, [], 'reading a cached page must not submit a sync');
  const requestId = randomUUID();
  for (const [scope,id] of [['notes',notesJob],['metrics',metricsJob]]) {
    const syncRoute = '/api/xhs/accounts/'+secondId+'/'+scope+'/sync';
    assert.equal((await api(syncRoute)).status,405);
    assert.equal((await api(syncRoute,{requestId:'bad'})).status,400);
    const accepted=await api(syncRoute,{requestId});
    assert.equal(accepted.status,202);
    assert.equal(accepted.body.job.jobId,id);
    assert.equal(accepted.body.job.status,'queued');
    assert.equal((await api(syncRoute,{requestId})).body.job.jobId,id);
    assert.equal(syncKeys.at(-1),syncKeys.at(-2));
    const progress=await api(syncRoute+'/'+id);
    assert.equal(progress.body.job.accountId,secondId);
    assert.equal(progress.body.job.error,'BROWSER_BUSY');
    assert.ok(!JSON.stringify(progress.body).includes(token));
    assert.equal((await api(syncRoute+'/'+(id===notesJob?metricsJob:notesJob))).status,502);
    assert.equal((await api('/api/xhs/accounts/'+accountId+'/'+scope+'/sync/'+id)).status,404);
  }
  assert.notEqual(syncKeys[0],syncKeys.at(-1),'notes and metrics have independent idempotency keys');
  assert.equal((await api(notesPath, {})).status, 405);
  assert.equal((await api('/api/xhs/accounts/unknown/notes')).status, 404);
  assert.equal((await api('/api/xhs/accounts/' + secondId + '/notes?offset=-1')).status, 400);
  notesPage.items = [{ ...listed, account_id: accountId }];
  assert.equal((await api(notesPath)).status, 502);
  notesPage.items = [{ ...listed, status: 'scheduled' }];
  assert.equal((await api(notesPath)).status, 502);
  notesPage.items = [listed];
  notesPage.offset = 0;
  assert.equal((await api(notesPath)).status, 502);
  notesPage.offset = 20;
  notesPage.sync_accounts = [{account_id: accountId}];
  assert.equal((await api(notesPath)).status, 502);
  notesPage = {total: 0, offset: 20, limit: 20, last_synced_at: null, items: []};
  assert.equal((await api(notesPath)).body.lastSyncedAt, null);
  notesCode = 404;
  assert.match((await api(notesPath)).body.error, /尚未提供已发布笔记接口/);
  const input = { accountId, projectId: project.id };
  assert.equal((await api('/api/xhs/drafts', input)).status, 409, 'account pause checked before submitting');
  assert.equal((await api('/api/projects/' + legacy.project.id + '/xhs-delivery', { accountId })).status, 409);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'projects', legacy.project.id, 'project.json'), 'utf8')).xhsDelivery.status, 'queued');
  assert.equal(writes.length, 0);
  paused = false;
  assert.equal((await api('/api/projects/' + project.id + '/xhs-delivery', { accountId, newVersion: true })).status, 202);
  let saved;
  for (let i = 0; i < 200; i++) {
    saved = (await api('/api/projects/' + project.id)).body.project.xhsDelivery;
    if (saved.status === 'verified') break;
    await sleep(50);
  }
  assert.equal(saved.status, 'verified', saved.message);
  assert.deepEqual(receivedImage, png);
  assert.equal((await api('/api/xhs/drafts', input)).body.duplicate, true);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].key);
  assert.deepEqual(writes[0].body.content.image_urls, [studio + project.pages[0].imageUrl]);
  const list = await api('/api/xhs/official-drafts/sync', { accountId, limit: 5, offset: 0 });
  assert.equal(list.body.officialDrafts[0].key, draftId);
  const detail = await api('/api/xhs/official-drafts/' + draftId + '?accountId=' + accountId);
  assert.equal(detail.body.detail.content, project.caption);
  extraAccounts = [{ ...noteAccount, paused: false, publish_enabled: true }];
  const savedSecond = await api('/api/xhs/drafts', { projectId: project.id, accountId: secondId });
  assert.equal(savedSecond.status, 202);
  const receiptId = savedSecond.body.draft.id;
  let receipt;
  for (let i = 0; i < 100; i++) {
    receipt = (await api('/api/xhs?accountId=' + secondId)).body.drafts.find(d => d.id === receiptId);
    if (receipt?.status === 'verified') break;
    await sleep(25);
  }
  assert.equal(receipt?.status, 'verified');
  assert.equal(receipt.remoteDraftId, secondDraft.draft_id);
  assert.equal((await api('/api/xhs/submissions/' + receiptId + '?accountId=' + accountId)).status, 404);
  const request = { accountId: secondId, receiptId, expectedContentHash: receipt.contentHash, expectedContentVersion: receipt.contentVersion,
    scheduledAt: new Date((Math.floor(Date.now()/60_000)+1440)*60_000).toISOString(), confirmed: true };
  assert.equal((await api('/api/xhs/schedules', { ...request, confirmed: false })).status, 400);
  assert.equal((await api('/api/xhs/schedules', { ...request, accountId })).status, 404);
  const scheduled = await api('/api/xhs/schedules', request);
  assert.equal(scheduled.status, 202);
  assert.equal(scheduled.body.schedule.status, 'queued');
  await api('/api/xhs/schedules', request);
  assert.equal(writes.filter(w => w.body.action === 'schedule_publish').length, 1);
  scheduledJob.status = 'succeeded';
  Object.assign(secondDraft, { phase: 'scheduled', platform_status: 'scheduled', active_job_id: scheduledJob.job_id });
  const finalSchedule = await api('/api/xhs/schedules?accountId='+secondId+'&receiptId='+receiptId);
  assert.equal(finalSchedule.body.schedule.status, 'scheduled');
  assert.equal(finalSchedule.body.schedule.scheduledAt, request.scheduledAt);
  assert.deepEqual(violations, []);
  assert.ok(!(await readdir(dir)).includes('xhs-accounts.json'));
  assert.ok(!JSON.stringify((await api('/api/xhs')).body).includes(token));
});
