import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createXhsConnector } from '../lib/xhs-connector.mjs';
import { XhsPublisherClient, XhsPublisherService } from '../lib/xhs-publisher.mjs';
import { randomUUID } from 'node:crypto';

const accountId = 'test_account';
const draftId = 'draft_' + '1'.repeat(32);
const jobId = 'job_' + '2'.repeat(32);
const baseUrl = 'http://publisher.invalid/internal';
const token = 'private-test-token';
const live = { status: 'ok' };
const ready = { database: 'ok', worker_active: true, account_paused: false, publish_enabled: false };

test('draft image preview pins account, version and position and only returns valid raster files', async () => {
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=', 'base64');
  let response, calls = 0;
  const client = new XhsPublisherClient({ baseUrl, token, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, baseUrl + '/v1/drafts/' + draftId + '/images/2?account_id=test_account&content_version=4');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    assert.equal(options.redirect, 'manual');
    return response;
  } });
  await assert.rejects(client.draftImage(accountId, draftId, 0, 4), { status: 400 });
  assert.equal(calls, 0);
  response = new Response(pixel, { headers: { 'content-type': 'image/png' } });
  assert.deepEqual(await client.draftImage(accountId, draftId, 2, 4), { bytes: pixel, mime: 'image/png' });
  response = new Response('<html></html>', { headers: { 'content-type': 'image/png' } });
  await assert.rejects(client.draftImage(accountId, draftId, 2, 4), { status: 502 });
  response = Response.json({ detail: { code: 'DRAFT_NOT_FOUND' } }, { status: 404 });
  await assert.rejects(client.draftImage(accountId, draftId, 2, 4), { status: 404 });
});
const account = { account_id: accountId, paused: false, publish_enabled: false };
const draft = { draft_id: draftId, account_id: accountId, image_count: 2, title: '测试标题', caption: '测试正文',
  updated_at: '2026-11-20T08:02:00Z', phase: 'ready', platform_status: 'draft_verified', platform_result: { privateEvidence: 'NEVER_EXPOSE' },
  jobs: [{ job_id: jobId, draft_id: draftId, account_id: accountId, action: 'create_draft', status: 'succeeded' }] };

async function fixture(t, options = {}, savedRecords = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-publisher-'));
  const responses = new Map([['/health/live', live], ['/health/ready', ready], ['/v1/accounts', { items: [account] }]]);
  const calls = [];
  const service = new XhsPublisherService({
    dir, baseUrl, token, accountId, mediaBaseUrl: 'http://media.invalid', ...options,
    async fetchImpl(url, request) {
      const endpoint = url.replace(baseUrl, '');
      calls.push({ endpoint, request });
      const payload = responses.get(endpoint);
      assert.ok(payload, 'Unexpected upstream request ' + endpoint);
      return payload instanceof Response ? payload : Response.json(payload);
    },
  });
  if (savedRecords.length) {
    await mkdir(service.delivery.directory, { recursive: true });
    await writeFile(service.delivery.file, JSON.stringify(savedRecords));
  }
  await service.init();
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  return { service, responses, calls, dir };
}

test('metrics read caches per account and period; a failed refresh keeps the latest complete snapshot', async t => {
  const { service, responses, calls } = await fixture(t);
  const sync = { status:'failed', snapshot_id:jobId, latest_job_id:jobId, last_synced_at:'2026-11-23T08:00:00Z',
    error:{code:'METRICS_PERMISSION_REQUIRED',diagnostic:'private'} };
  responses.set('/v1/accounts', {items:[{...account,metrics_sync:sync},{...account,account_id:'account_b',metrics_sync:{status:'never'}}]});
  const measure = (value, raw_value, unit='count') => ({value,raw_value,unit,value_status:'available',is_approximate:false});
  const snapshot = {account_id:accountId, period:'7d', has_data:true, sync, last_synced_at:sync.last_synced_at,
    totals:{followers:measure(0,'0'), following:measure(10000,'1万'), likes_and_favorites:{value:null,value_status:'not_available'}},
    metrics:{views:measure(25,'25'), cover_click_rate:measure(8.9,'8.9%','percent'), net_followers:{...measure(-3,'-3'),comparison_percent:-25}},
    date_range:{start_date:'2026-11-16',end_date:'2026-11-22'},sources:{diagnostic:'private'} };
  const endpoint='/v1/accounts/'+accountId+'/metrics?period=';
  responses.set(endpoint+'7d', snapshot);
  assert.equal((await service.listAccounts()).accounts[0].metrics.followers, null);
  assert.equal(calls.length,1,'selection and job preflight should not request analytics for every account');
  const [cached, unsynced] = (await service.listAccounts({includeMetrics:true})).accounts;
  assert.deepEqual(cached.metrics,{followers:0,following:10000,likesAndSaves:null,notes:null});
  assert.equal(cached.metricLabels.following,'1万');
  assert.equal(unsynced.metrics.followers,null);
  assert.equal(calls.filter(c=>c.endpoint.includes('/metrics?')).length,1);
  const detail = await service.accountMetrics(accountId,'7d');
  assert.equal(detail.metrics.net_followers.value,-3);
  assert.equal(detail.metrics.cover_click_rate.unit,'percent');
  assert.equal(detail.metrics.impressions.value,null);
  assert.equal(detail.sync.error,'METRICS_PERMISSION_REQUIRED');
  assert.equal(detail.hasData,true);
  assert.doesNotMatch(JSON.stringify(detail),/private/);
  await assert.rejects(service.accountMetrics(accountId,'1d'));
  responses.set(endpoint+'30d',snapshot);
  await assert.rejects(service.accountMetrics(accountId,'30d'), /周期/);
  responses.set(endpoint+'7d',{...snapshot,account_id:'account_b'});
  await assert.rejects(service.accountMetrics(accountId,'7d'), /账号/);
  const partial = await service.listAccounts({includeMetrics:true});
  assert.equal(partial.accounts[0].metricsReadFailed,true);
  assert.equal(partial.accounts.length,2);
  assert.ok(calls.every(c=>c.request.method==='GET'));
});

test('service snapshot is offline, scoped to a single stable provider identity', async t => {
  const { service, calls } = await fixture(t);
  const state = service.snapshot();
  assert.equal(state.provider, 'publisher');
  assert.equal(state.providerKey, 'publisher:' + state.profileId);
  assert.equal(state.capabilities.officialDrafts, false);
  assert.equal(state.capabilities.serviceDrafts, true);
  assert.equal(state.connection.state, 'needs_attention');
  assert.equal(state.configured, true);
  assert.deepEqual(state.deliveryConfiguration, { configured: true, canPreflight: true, message: '' });
  assert.equal(service.getAccountSnapshot(accountId).account.id, accountId);
  assert.equal(service.getAccountSnapshot('different'), null);
  const same = await fixture(t, { baseUrl: baseUrl + '/' });
  const other = await fixture(t, { baseUrl: 'https://another-publisher.invalid' });
  assert.equal(same.service.snapshot().providerKey, state.providerKey);
  assert.notEqual(other.service.snapshot().providerKey, state.providerKey);
  for (const name of ['startLogin', 'addAccount', 'updateAccount', 'removeAccount', 'disconnect', 'openDrafts', 'getNoteDetail', 'startSync']) {
    assert.equal(service[name], undefined);
  }
  assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify(state).includes(token));
});

test('account directory reads live service accounts and never switches the delivery target', async t => {
  const { service, calls, responses } = await fixture(t, { deliveryConfigurationError: '测试环境仅读取。' });
  const checkedAt = '2026-11-23T02:10:00.000Z';
  const other = { account_id: 'second_account', paused: true, publish_enabled: true,
    nickname: '远山手记', platform_account_id: '001238', login_status: 'verified', identity_checked_at: checkedAt,
    enabled: false, executing: true, daily_limit: 0, queued_jobs: 2, needs_attention: 1,
    metrics: { followers: 0, following: 23, likes_and_saves: 1058, notes: 9, private_key: token },
    browser_environment: 'private-browser-profile', private_key: token };
  responses.set('/v1/accounts', { items: [other, account] });
  const { accounts } = await service.listAccounts();
  assert.deepEqual(accounts, [
    { accountId: other.account_id, paused: true, publishEnabled: true, isDeliveryAccount: false,
      nickname: '远山手记', platformAccountId: '001238', loginStatus: 'verified', identityCheckedAt: checkedAt,
      enabled: false, executing: true, dailyLimit: 0, queuedJobs: 2, needsAttention: 1,
      metrics: { followers: 0, following: 23, likesAndSaves: 1058, notes: 9 } },
    { accountId, paused: false, publishEnabled: false, isDeliveryAccount: true,
      nickname: null, platformAccountId: null, loginStatus: null, identityCheckedAt: null,
      enabled: null, executing: null, dailyLimit: null, queuedJobs: null, needsAttention: null,
      metrics: { followers: null, following: null, likesAndSaves: null, notes: null } },
  ]);
  assert.equal(service.getAccountSnapshot(other.account_id), null);
  await assert.rejects(service.startOfficialDraftSync({ accountId: other.account_id }), { status: 409 });
  responses.set('/v1/accounts', { items: [] });
  assert.deepEqual((await service.listAccounts()).accounts, []);
  for (const items of [[other, other], [{ ...other, paused: 'false' }], [{ ...other, account_id: null }]]) {
    responses.set('/v1/accounts', { items });
    await assert.rejects(service.listAccounts(), { status: 502 });
  }
  assert.ok(calls.every(call => call.endpoint === '/v1/accounts' && call.request.method === 'GET'));
});

test('malformed optional account fields do not hide the row or become counts', async t => {
  const { service, responses } = await fixture(t);
  responses.set('/v1/accounts', { items: [{ ...account, nickname: { text: '错误类型' }, platform_account_id: false,
    enabled: 0, executing: 'false', daily_limit: -1, queued_jobs: '0', needs_attention: Number.MAX_SAFE_INTEGER + 1,
    login_status: [], identity_checked_at: {}, metrics: { followers: '未知', following: true, likes_and_saves: -1, notes: 1.5 } }] });
  const { accounts: [row] } = await service.listAccounts();
  assert.equal(row.accountId, accountId);
  assert.equal(row.nickname, null);
  assert.equal(row.platformAccountId, null);
  assert.equal(row.loginStatus, null);
  assert.equal(row.identityCheckedAt, null);
  for (const field of ['enabled', 'executing', 'dailyLimit', 'queuedJobs', 'needsAttention']) {
    assert.equal(row[field], null, field);
  }
  assert.deepEqual(row.metrics, { followers: null, following: null, likesAndSaves: null, notes: null });
});

test('explicit directory selection isolates draft submission, receipts and restart from the default target', async t => {
  const { service, calls, responses, dir } = await fixture(t);
  const otherId = 'account_b';
  const second = { account_id: otherId, platform_account_id: '0023', enabled: true, nickname: '乙', paused: false, publish_enabled: false };
  responses.set('/v1/accounts', { items: [{ ...account, paused: true }, second] });
  responses.set('/health/ready', { ...ready, account_paused: true });
  await assert.rejects(service.forAccount('not-in-directory'), { status: 409 });
  const [b, same] = await Promise.all([service.forAccount(otherId), service.forAccount(otherId)]);
  assert.equal(b, same);
  assert.equal(service.snapshot().account.id, accountId);
  assert.equal(b.snapshot().account.nickname, '乙');
  assert.notEqual(b.profileId, service.profileId);
  assert.notEqual(b.delivery.directory, service.delivery.directory);
  const input = { accountId: otherId, projectId: randomUUID(), fingerprint: 'b'.repeat(64),
    title: '乙的作品', content: '乙的文案', images: ['/local/' + randomUUID() + '-' + randomUUID() + '.png'] };
  const accepted = { job_id: jobId, draft_id: draftId, account_id: otherId, action: 'create_draft', content_version: 1 };
  responses.set('/v1/jobs', accepted);
  responses.set('/v1/jobs/' + jobId, { ...accepted, status: 'succeeded' });
  responses.set('/v1/drafts/' + draftId, { ...draft, account_id: otherId, title: input.title, caption: input.content,
    image_count: 1, active_job_id: jobId, content_version: 1, content_hash: 'e'.repeat(64) });
  await assert.rejects(b.submitDraft({ ...input, expectedPlatformAccountId: 'someone-else' }), { code: 'XHS_ACCOUNT_REBOUND', submissionNotAttempted: true });
  const submitted = await b.submitDraft({ ...input, expectedPlatformAccountId: second.platform_account_id });
  await Promise.all(b.delivery.workers.values());
  const receipt = b.getSubmissionReceipt(submitted.draft.id, { accountId: otherId });
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.accountId, otherId);
  assert.equal(receipt.platformAccountId, second.platform_account_id);
  assert.equal(receipt.projectId, input.projectId);
  assert.equal(receipt.contentHash, 'e'.repeat(64));
  assert.equal(service.getSubmissionReceipt(receipt.id, { accountId }), null);
  assert.equal(service.snapshot().drafts.length, 0);
  assert.equal((await b.submitDraft(input)).duplicate, true);
  assert.equal(calls.filter(call => call.request.method === 'POST').length, 1);
  const request = JSON.parse(calls.find(call => call.request.method === 'POST').request.body);
  assert.equal(request.account_id, otherId);

  responses.set('/v1/accounts', { items: [account, { ...second, platform_account_id: 'new-binding' }] });
  await assert.rejects(b.submitDraft(input), /此前草稿所属的平台账号/);
  await assert.rejects(b.retryDraft(receipt.id, { accountId: otherId }), /原草稿所属的平台账号/);

  // A newly disabled/removed target may not use the earlier scope to admit a write.
  responses.set('/v1/accounts', { items: [account, { ...second, enabled: false }] });
  assert.equal((await service.forAccount(otherId)).getSubmissionReceipt(receipt.id).id, receipt.id);
  await assert.rejects(b.submitDraft(input), { submissionNotAttempted: true });
  responses.set('/v1/accounts', { items: [account] });
  await assert.rejects(b.submitDraft(input), { submissionNotAttempted: true });
  assert.equal(calls.filter(call => call.request.method === 'POST').length, 1);
  await service.close();
  const restored = new XhsPublisherService({ dir, baseUrl, accountId, token, mediaBaseUrl: 'http://media.invalid',
    fetchImpl: () => assert.fail('启动时不应重送已核验草稿') });
  try {
    await restored.init();
    assert.equal(restored.getAccountSnapshot(otherId).drafts[0].id, receipt.id);
    assert.deepEqual(restored.snapshot().drafts, []);
  } finally { await restored.close(); }
});

test('health check verifies readiness and account, sends bearer only to authenticated endpoints', async t => {
  const { service, calls } = await fixture(t);
  const state = await service.checkLogin({ accountId });
  assert.equal(state.connection.state, 'connected');
  assert.ok(state.connection.lastCheckedAt);
  assert.deepEqual(calls.map(item => item.endpoint), ['/health/live', '/health/ready', '/v1/accounts']);
  assert.equal(calls[0].request.headers.Authorization, undefined);
  for (const call of calls.slice(1)) {
    assert.equal(call.request.method, 'GET');
    assert.equal(call.request.redirect, 'manual');
    assert.equal(call.request.headers.Authorization, 'Bearer ' + token);
  }
  assert.ok(!JSON.stringify(state).includes(token));
});

test('LAN submissions require the current ready response to allow the image host, without blocking draft queries', async t => {
  const host = '192.168.2.17';
  let started = false;
  const lanMedia = { origin: 'http://' + host + ':4319', async init() { started = true; }, async close() {} };
  const { service, calls, responses } = await fixture(t, { lanMedia, mediaBaseUrl: lanMedia.origin });
  assert.equal(started, true);
  assert.equal(calls.length, 0);
  assert.equal(service.snapshot().deliveryConfiguration.configured, false);
  assert.equal(service.snapshot().deliveryConfiguration.canPreflight, true);
  responses.set('/v1/drafts?account_id=test_account&limit=50&offset=0', { items: [draft] });
  for (const hosts of [undefined, [host + '.invalid'], host, ['127.0.0.1']]) {
    responses.set('/health/ready', { ...ready, image_allowed_hosts: hosts });
    const snapshot = await service.checkLogin({ accountId });
    assert.equal(snapshot.connection.state, 'connected');
    assert.equal(snapshot.deliveryConfiguration.configured, false);
    assert.equal(snapshot.deliveryConfiguration.canPreflight, false);
    assert.ok(snapshot.deliveryConfiguration.message.includes(host));
    assert.match(snapshot.deliveryConfiguration.message, /XHS_IMAGE_ALLOWED_HOSTS.*XHS_IMAGE_ALLOW_PRIVATE=true.*API 和 worker/);
    const blocked = { code: 'PUBLISHER_MEDIA_CONFIG', submissionNotAttempted: true };
    await assert.rejects(service.submitDraft({ accountId }), blocked);
    await assert.rejects(service.retryDraft('pending', { accountId }), blocked);
  }
  assert.equal((await service.startOfficialDraftSync({ accountId })).officialDrafts[0].key, draftId);
  responses.set('/health/ready', { ...ready, image_allowed_hosts: [host] });
  assert.equal((await service.checkLogin({ accountId })).deliveryConfiguration.configured, true);
  responses.set('/health/ready', { ...ready, image_allowed_hosts: [] });
  await assert.rejects(service.submitDraft({ accountId }), { code: 'PUBLISHER_MEDIA_CONFIG', submissionNotAttempted: true });
  assert.equal(service.snapshot().deliveryConfiguration.configured, false);
  assert.ok(calls.every(call => call.request.method === 'GET'));
});

test('LAN listener startup failure releases resources and leaves account and draft reads available', async t => {
  let released = false;
  const lanMedia = { origin: 'http://192.168.2.17:4319', async init() { throw new Error('监听端口已被占用。'); }, async close() { released = true; } };
  const { service, calls, responses } = await fixture(t, { lanMedia });
  assert.equal(released, true);
  responses.set('/v1/drafts/' + draftId + '?account_id=' + accountId, draft);
  const snapshot = await service.checkLogin({ accountId });
  assert.equal(snapshot.connection.state, 'connected');
  assert.equal(snapshot.account.id, accountId);
  assert.equal(snapshot.deliveryConfiguration.configured, false);
  assert.match(snapshot.deliveryConfiguration.message, /局域网图片服务启动失败.*端口/);
  assert.equal(snapshot.deliveryConfiguration.canPreflight, false);
  assert.equal((await service.getOfficialDraftDetail(draftId, { accountId })).detail.content, draft.caption);
  const count = calls.length;
  await assert.rejects(service.submitDraft({ accountId }), { submissionNotAttempted: true });
  assert.equal(calls.length, count);
});

test('a paused account, inactive worker, malformed ready flag or wrong account blocks every submission', async t => {
  const { service, calls, responses } = await fixture(t);
  await service.checkLogin({ accountId });
  for (const [readyState, accountState] of [
    [{ ...ready, worker_active: false }, account], [{ ...ready, database: 'error' }, account], [{ ...ready, account_paused: true }, account],
    [{ ...ready, account_paused: null }, account], [ready, { ...account, paused: true }], [ready, { ...account, account_id: 'other' }],
  ]) {
    responses.set('/health/ready', readyState);
    responses.set('/v1/accounts', { items: [accountState] });
    await assert.rejects(service.submitDraft({ accountId }), { submissionNotAttempted: true });
    assert.equal(service.snapshot().connection.state, 'needs_attention');
  }
  await assert.rejects(service.retryDraft(jobId, { accountId }), { submissionNotAttempted: true });
  const count = calls.length;
  await assert.rejects(service.submitDraft({ accountId: 'other' }), { status: 409, submissionNotAttempted: true });
  assert.equal(calls.length, count);
  assert.ok(calls.every(call => call.request.method === 'GET'));
});

test('a missing media base permits reading drafts and existing jobs while blocking create and retry', async t => {
  const saved = { accountId, body: { content: { title: draft.title } }, remoteJobId: jobId, remoteDraftId: draftId };
  const { service, calls, responses } = await fixture(t, { mediaBaseUrl: undefined }, [
    { ...saved, id: 'uncertain', status: 'unknown', attempts: 1 },
    { ...saved, id: 'failed-download', status: 'failed', retryMode: 'download', attempts: 1 },
  ]);
  responses.set('/v1/drafts?account_id=test_account&limit=50&offset=0', { items: [draft] });
  responses.set('/v1/drafts/' + draftId + '?account_id=' + accountId, draft);
  responses.set('/v1/jobs/' + jobId, { ...draft.jobs[0], status: 'needs_attention' });
  const state = await service.checkLogin({ accountId });
  assert.equal(state.configured, true);
  assert.equal(state.connection.state, 'connected');
  assert.match(state.connection.message, /查询/);
  assert.equal(state.deliveryConfiguration.configured, false);
  assert.match(state.deliveryConfiguration.message, /XHS_PUBLISHER_MEDIA_BASE_URL/);
  const list = await service.startOfficialDraftSync({ accountId });
  assert.equal(list.officialDrafts[0].key, draftId);
  assert.equal((await service.getOfficialDraftDetail(draftId, { accountId })).detail.jobs[0].id, jobId);
  await service.recheckDraft('uncertain', { accountId });
  assert.ok(calls.some(call => call.endpoint === '/v1/jobs/' + jobId));
  const previousCount = calls.length;
  const blocked = { status: 503, code: 'PUBLISHER_MEDIA_CONFIG', submissionNotAttempted: true };
  await assert.rejects(service.submitDraft({ accountId }), blocked);
  await assert.rejects(service.retryDraft('failed-download', { accountId }), blocked);
  assert.equal(calls.length, previousCount);
  assert.ok(calls.every(call => call.request.method === 'GET'));
});

test('unconfigured token leaves snapshots available and prevents requests', async t => {
  const { service, calls } = await fixture(t, { token: '' });
  assert.equal(service.snapshot().account, null);
  assert.deepEqual(service.snapshot().accounts, []);
  assert.equal(service.snapshot().configured, false);
  assert.equal(service.snapshot().deliveryConfiguration.configured, false);
  assert.equal(service.snapshot().connection.state, 'unconfigured');
  await assert.rejects(service.checkLogin({ accountId }), { status: 503, code: 'PUBLISHER_CONFIG' });
  await assert.rejects(service.startOfficialDraftSync({ accountId }), { status: 503 });
  assert.equal(calls.length, 0);
});

test('a clean install and a former local deployment only expose the unconfigured publisher', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'publisher-only-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacyFile = 'xhs-accounts.json';
  await writeFile(path.join(root, legacyFile), 'unused legacy browser data');
  for (const env of [{}, { XHS_PROVIDER: 'local', XHS_PUBLISHER_TOKEN: 'mock' }, { XHS_PUBLISHER_BASE_URL: 'invalid' }]) {
    const service = await createXhsConnector({ root, dir: root, port: 4318, env });
    const snapshot = await service.init();
    assert.equal(snapshot.provider, 'publisher');
    assert.equal(snapshot.connection.state, 'unconfigured'); assert.equal(snapshot.account, null);
    await assert.rejects(service.submitDraft({ accountId }), { status: 503, submissionNotAttempted: true });
    await service.close();
  }
  assert.deepEqual(await readdir(root), [legacyFile]);
});

test('service list filters by account before paging, checks each owner and preserves the last good page', async t => {
  const { service, calls, responses } = await fixture(t);
  const firstPage = '/v1/drafts?account_id=test_account&limit=1&offset=0';
  responses.set(firstPage, { items: [draft] });
  responses.set('/v1/drafts?account_id=test_account&limit=1&offset=1', { items: [] });
  responses.set('/v1/drafts/' + draftId + '?account_id=' + accountId, draft);
  const page = await service.startOfficialDraftSync({ accountId, limit: 1, offset: 0 });
  assert.deepEqual(page.officialDrafts.map(row => row.key), [draftId]);
  assert.equal(page.officialDraftSync.coverage.hasMore, true);
  assert.equal(page.officialDrafts[0].phase, 'ready');
  assert.ok(!JSON.stringify(page).includes(draft.caption));
  responses.set(firstPage, { items: [draft], total: 1 });
  assert.equal((await service.startOfficialDraftSync({ accountId, limit: 1 })).officialDraftSync.coverage.hasMore, false);
  responses.set(firstPage, { items: [{ ...draft, account_id: 'other' }] });
  await assert.rejects(service.startOfficialDraftSync({ accountId, limit: 1 }), { status: 502 });
  assert.equal(service.snapshot().officialDrafts[0].key, draftId);
  const detail = await service.getOfficialDraftDetail(draftId, { accountId });
  assert.equal(detail.detail.content, draft.caption);
  assert.equal(detail.detail.source, 'publisher_draft');
  assert.equal(detail.detail.jobs[0].id, jobId);
  assert.deepEqual(detail.detail.images, []);
  assert.equal(detail.detail.imageCount, 2);
  assert.ok(!JSON.stringify(detail).includes('NEVER_EXPOSE'));
  responses.set('/v1/drafts/' + draftId + '?account_id=' + accountId, { ...draft, account_id: 'other' });
  await assert.rejects(service.getOfficialDraftDetail(draftId, { accountId }), { status: 502 });
  const next = await service.startOfficialDraftSync({ accountId, limit: 1, offset: 1 });
  assert.deepEqual(next.officialDrafts, []);
  assert.equal(next.officialDraftSync.coverage.offset, 1);
  assert.equal(next.officialDraftSync.coverage.hasMore, false);
  const count = calls.length;
  await assert.rejects(service.getOfficialDraftDetail('../jobs', { accountId }), { status: 404 });
  await assert.rejects(service.startOfficialDraftSync({ accountId, limit: 101 }), { status: 400 });
  assert.equal(calls.length, count);
  assert.ok(calls.every(call => call.request.method === 'GET'));
});

test('HTTP client preserves error codes, strips private responses and rejects redirects', async () => {
  const replies = [
    Response.json({ detail: { code: 'IMAGE_URL_NOT_ALLOWED', message: token } }, { status: 422 }),
    Response.json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: token } }, { status: 409 }),
    new Response(null, { status: 307, headers: { Location: 'https://other.invalid' } }),
    new Response('<html>not JSON</html>'),
  ];
  const methods = [];
  const client = new XhsPublisherClient({ baseUrl, token, fetchImpl: async (url, request) => {
    methods.push(request);
    assert.equal(url, baseUrl + '/v1/jobs');
    return replies.shift();
  } });
  for (const [status, code] of [[422, 'IMAGE_URL_NOT_ALLOWED'], [409, 'IDEMPOTENCY_CONFLICT'], [502, 'HTTP_307'], [502, 'PUBLISHER_ERROR']]) {
    await assert.rejects(client.request('/v1/jobs', { method: 'POST', body: { action: 'create_draft' }, idempotencyKey: 'fake-test' }),
      error => error.status === status && error.code === code && !error.message.includes(token));
  }
  assert.ok(methods.every(request => request.redirect === 'manual' && request.headers['Idempotency-Key'] === 'fake-test'));
  await assert.rejects(client.request('https://other.invalid/v1/jobs'), { status: 400 });
  assert.throws(() => new XhsPublisherClient({ baseUrl: 'https://private:secret@publisher.invalid', token }), { status: 503 });
});
