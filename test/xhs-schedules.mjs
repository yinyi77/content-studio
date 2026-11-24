import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Storage } from '../lib/storage.mjs';
import { XhsSchedules } from '../lib/xhs-schedules.mjs';

const accountId = 'account_b';
const key = { accountId, receiptId: 'fbfcc64e-833c-463e-b595-f05e46abaf30' };
const draftId = 'draft_' + '1'.repeat(32);
const createJobId = 'job_' + '2'.repeat(32);
const jobId = 'job_' + '3'.repeat(32);
const contentHash = 'a'.repeat(64);
const title = '核对好的稿件';
const minutesFromNow = minutes => new Date((Math.floor(Date.now() / 60_000) + minutes) * 60_000).toISOString();

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'content-studio-schedules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Storage(root);
  await store.init();
  const receipt = {
    id: key.receiptId, accountId, title, status: 'verified', contentVersion: 2, contentHash, remoteDraftId: draftId,
    platformAccountId: 'platform_b', remoteJobId: createJobId, projectId: '97e0466f-c8f5-409a-a138-991799c079ae',
  };
  const input = { ...key, confirmed: true, expectedContentVersion: 2, expectedContentHash: contentHash, scheduledAt: minutesFromNow(1440) };
  const row = { accountId, platformAccountId: 'platform_b', enabled: true, paused: false, publishEnabled: true };
  const draft = {
    draft_id: draftId, account_id: accountId, title, content_version: 2, content_hash: contentHash, jobs: [],
    phase: 'ready', platform_status: 'draft_verified', active_job_id: createJobId,
  };
  const job = {
    job_id: jobId, draft_id: draftId, account_id: accountId, action: 'schedule_publish', status: 'queued',
    content_version: 2, content_hash: contentHash, publish_at: input.scheduledAt,
  };
  const writes = [];
  const target = {
    accountId, delivery: { directory: root, listSubmissions: () => [receipt] },
    getSubmissionReceipt(id, scope) {
      return id === key.receiptId && scope.accountId === accountId ? receipt : null;
    },
    client: { async request(endpoint, options = {}) {
      if (endpoint === '/v1/drafts/' + draftId && (options.method ?? 'GET') === 'GET') return structuredClone(draft);
      if (endpoint === '/v1/jobs/' + jobId && (options.method ?? 'GET') === 'GET') return structuredClone(job);
      assert.equal(endpoint, '/v1/jobs');
      assert.equal(options.method, 'POST');
      writes.push(structuredClone(options));
      if (target.timeoutNext) {
        target.timeoutNext = false;
        throw Object.assign(new Error('模拟回执超时'), { code: 'PUBLISHER_TIMEOUT', status: 504 });
      }
      return structuredClone(job);
    } },
  };
  const xhs = {
    listAccounts: async () => ({ accounts: [row] }),
    forAccount: async id => { assert.equal(id, accountId); return target; },
  };
  const open = () => new XhsSchedules({ store, xhs });
  function finish(at = input.scheduledAt) {
    job.status = 'succeeded';
    job.publish_at = at;
    Object.assign(draft, {
      phase: 'scheduled', platform_status: 'scheduled', active_job_id: jobId, jobs: [structuredClone(job)], publish_at: at,
      platform_result: { management_verification: { publish_at: at, scheduled_verified: true, title } },
    });
  }
  return { open, service: open(), row, receipt, draft, job, target, input, writes, finish };
}

test('scheduling requires confirmation for the exact verified content, the selected account and a future time', async t => {
  const { service, input, receipt, draft, row, writes } = await setup(t);
  for (const changes of [
    { confirmed: false }, { confirmed: 'true' }, { expectedContentVersion: 1 }, { expectedContentHash: 'b'.repeat(64) },
    { expectedPlatformAccountId: 'previous_binding' },
    { scheduledAt: minutesFromNow(-5) }, { scheduledAt: minutesFromNow(15 * 1440) },
    { scheduledAt: input.scheduledAt.replace(':00.000Z', ':37.000Z') },
  ]) await assert.rejects(service.submit({ ...input, ...changes }));
  for (const [object, property, invalid] of [
    [row, 'publishEnabled', false], [row, 'paused', true], [row, 'enabled', false], [row, 'platformAccountId', 'new_binding'],
    [receipt, 'status', 'running'], [receipt, 'accountId', 'another_account'],
    [draft, 'account_id', 'another_account'], [draft, 'content_version', 3], [draft, 'content_hash', 'c'.repeat(64)],
    [draft, 'phase', 'needs_attention'],
  ]) {
    const before = object[property];
    object[property] = invalid;
    await assert.rejects(service.submit(input), undefined, property);
    object[property] = before;
  }
  assert.equal(writes.length, 0);
});

test('concurrent confirmations of the same minute produce one version-bound request and need platform verification', async t => {
  const { service, open, input, writes, finish } = await setup(t);
  assert.equal(await service.get(key), null);
  const beijingMinute = new Date(Date.parse(input.scheduledAt) + 8 * 3600_000).toISOString().slice(0, 16) + ':00+08:00';
  const results = await Promise.allSettled([service.submit({ ...input, scheduledAt: beijingMinute }), service.submit(input)]);
  const accepted = results.find(result => result.status === 'fulfilled');
  assert.ok(accepted, 'an explicit confirmation must be accepted');
  assert.notEqual(accepted.value.status, 'scheduled');
  assert.equal(writes.length, 1);
  const { body, idempotencyKey } = writes[0];
  assert.ok(idempotencyKey);
  assert.equal(body.action, 'schedule_publish');
  assert.equal(body.account_id, accountId);
  assert.equal(body.draft_id, draftId);
  assert.equal(body.content_version, 2);
  assert.equal(Date.parse(body.publish_at), Date.parse(input.scheduledAt));
  assert.equal(body.approval.content_hash, contentHash);
  assert.equal(body.approval.approved, true);
  assert.ok(body.approval.approved_by.trim());
  assert.ok(Number.isFinite(Date.parse(body.approval.approved_at)));
  const restarted = open();
  assert.notEqual((await restarted.get(key)).status, 'scheduled');
  finish();
  assert.equal((await restarted.get(key)).status, 'scheduled');
  assert.equal((await restarted.get(key)).status, 'scheduled');
  assert.equal(writes.length, 1);
});

test('after an edit only the latest verified draft can be approved, and both entry points share its reservation', async t => {
  const { service, open, input, draft, job, writes } = await setup(t);
  const latest = { ...input, draftId, expectedContentVersion: 3, expectedContentHash: 'c'.repeat(64) };
  delete latest.receiptId;
  Object.assign(draft, { title: '修改后的帖子', content_hash: latest.expectedContentHash, content_version: 3 });
  Object.assign(job, { content_hash: draft.content_hash, content_version: 3 });
  await assert.rejects(service.submit(input));
  await assert.rejects(service.submit({ ...latest, expectedContentHash: input.expectedContentHash }));
  draft.pending_update = { base_version: 3 };
  await assert.rejects(service.submit(latest));
  draft.pending_update = null;
  assert.equal(writes.length, 0);
  const accepted = await service.submit(latest);
  assert.equal(accepted.status, 'queued');
  assert.equal(accepted.title, draft.title);
  assert.equal(accepted.draftId, draftId);
  assert.equal(accepted.receiptId, key.receiptId);
  assert.deepEqual(await open().get(key), await open().get({ accountId, draftId }));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.approval.content_hash, draft.content_hash);
});

test('succeeded schedule job without the approved platform time never reports a confirmed reservation', async t => {
  const { service, input, writes, finish, draft, job } = await setup(t);
  await service.submit(input);
  finish(minutesFromNow(1445));
  assert.notEqual((await service.get(key)).status, 'scheduled');
  job.publish_at = input.scheduledAt;
  assert.notEqual((await service.get(key)).status, 'scheduled', 'the platform verification also needs the approved time');
  finish();
  draft.account_id = 'another_account';
  assert.notEqual((await service.get(key)).status, 'scheduled', 'never confirm another account’s draft');
  assert.equal(writes.length, 1);
});

test('lost receipt survives restart without reposting; explicit recovery reuses the exact approval and idempotency key', async t => {
  const { service, open, input, writes, target } = await setup(t);
  target.timeoutNext = true;
  await Promise.allSettled([service.submit(input)]);
  assert.equal(writes.length, 1);
  const restarted = open();
  const pending = await restarted.get(key);
  assert.ok(pending, 'the unresolved attempt must survive loss of the response');
  assert.notEqual(pending.status, 'scheduled');
  assert.equal(writes.length, 1, 'read-only recovery must not send a reservation');
  await restarted.submit(input);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].body, writes[1].body);
  assert.equal(writes[0].idempotencyKey, writes[1].idempotencyKey);
});
