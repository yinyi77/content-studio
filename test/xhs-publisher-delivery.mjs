import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { XhsPublisherDelivery } from '../lib/xhs-publisher-delivery.mjs';

const job = { job_id: 'job_' + 'b'.repeat(32), draft_id: 'draft_' + 'a'.repeat(32), action: 'create_draft',
  status: 'queued', content_version: 1, account_id: 'xhs_account_001' };
const input = { accountId: job.account_id, projectId: randomUUID(), title: '接猫前准备清单', content: '准备食碗与猫砂盆。', fingerprint: '1'.repeat(64),
  images: [1, 2].map(() => '/local/project/images/' + randomUUID() + '-' + randomUUID() + '.png') };
const ready = { account_id: job.account_id, draft_id: job.draft_id, active_job_id: job.job_id, phase: 'ready', platform_status: 'draft_verified',
  title: input.title, caption: input.content, image_count: 2, content_version: 1, content_hash: 'e'.repeat(64) };

async function fixture(t, request, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'publisher-delivery-'));
  const imageDir = path.join(dir, 'projects', input.projectId, 'images');
  await mkdir(imageDir, { recursive: true });
  for (const image of input.images) await writeFile(path.join(imageDir, path.basename(image)), 'original');
  const services = [];
  t.after(async () => {
    await Promise.all(services.map(service => service.close()));
    await rm(dir, { recursive: true, force: true });
  });
  const start = async (handler = request, options = {}) => {
    const service = new XhsPublisherDelivery({ dir, accountId: input.accountId, client: { request: handler }, serviceUrl: 'https://publisher.example',
      mediaBaseUrl: 'https://images.example/workspace/', pollMs: 5, maxPollMs: 1500, ...options });
    services.push(service);
    return service.init();
  };
  return { service: await start(request, options), start, imageDir };
}

async function result(service, id, expected) {
  for (let i = 0; i < 200; i++) {
    const item = service.getSubmission(id);
    if (item?.status === expected) return item;
    await delay(5);
  }
  assert.fail('Expected ' + expected + ', got ' + JSON.stringify(service.getSubmission(id)));
}

test('submits an ordered, frozen create request once and verifies the matching draft before completion', async t => {
  const calls = [];
  let status = 'running';
  const { service, imageDir } = await fixture(t, async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === 'POST') return job;
    if (url === '/v1/jobs/' + job.job_id) return { ...job, status };
    if (url === '/v1/drafts/' + job.draft_id) return ready;
    assert.fail('Unexpected URL');
  });
  const [first, same] = await Promise.all([service.submitDraft(input), service.submitDraft(input)]);
  assert(!first.duplicate && same.duplicate);
  assert.equal(first.draft.id, same.draft.id);
  await result(service, first.draft.id, 'running');
  assert.equal(service.getSubmission(first.draft.id).verifiedAt, null);
  await assert.rejects(service.submitDraft({ ...input, fingerprint: '2'.repeat(64) }), /此前版本/);
  const post = calls.find(c => c.method === 'POST');
  assert.deepEqual(post.body.content.image_urls, input.images.map(image => 'https://images.example/workspace/media/' + input.projectId + '/' + path.basename(image)));
  assert.equal(post.body.action, 'create_draft');
  status = 'succeeded';
  const item = await result(service, first.draft.id, 'verified');
  assert.equal(item.remoteJobId, job.job_id);
  assert.equal(item.contentHash, ready.content_hash);
  assert.equal(item.contentVersion, 1);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  assert.equal((await service.getSubmissionDetail(item.id)).images.length, 2);
  await assert.rejects(service.getSubmissionDetail(item.id, { accountId: 'other' }), /不存在/);
  await rm(path.join(imageDir, path.basename(input.images[0])));
  const partial = await service.getSubmissionDetail(item.id);
  assert(!partial.isComplete);
  assert.equal(partial.images.length, 1);
  assert.equal(partial.content, input.content);
  assert.equal(service.getSubmission(item.id).status, 'verified');
});

test('a lost acceptance is explicitly recovered with the durable identical request and key', async t => {
  const posts = [];
  const { service, start } = await fixture(t, async (url, options) => {
    posts.push(structuredClone(options));
    throw Object.assign(new Error('lost receipt'), { status: 503 });
  });
  const { draft } = await service.submitDraft(input);
  const pending = await result(service, draft.id, 'unknown');
  assert(pending.canRetry && !pending.canRecheck);
  await service.close();
  let calls = 0;
  const restart = await start(async (url, options) => {
    calls++;
    if (options.method === 'POST') { posts.push(structuredClone(options)); return job; }
    return url.includes('/jobs/') ? { ...job, status: 'succeeded' } : ready;
  }, { mediaBaseUrl: 'https://changed.example' });
  assert.equal(calls, 0);
  assert((await restart.submitDraft(input)).duplicate);
  await restart.retryDraft(draft.id, { accountId: input.accountId });
  await result(restart, draft.id, 'verified');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], posts[1]);
});

test('LAN tickets are issued once and an explicit recovery renews the original URLs before replaying the frozen request', async t => {
  const urls = ['first', 'second'].map(token => 'http://192.168.2.17:4319/xhs-media/' + token);
  const posts = [], renewals = [];
  let issued = 0, mayRenew = false;
  const lanMedia = {
    async createUrls(prepared) { issued++; assert.equal(prepared, input); return [...urls]; },
    async renewUrls(original) {
      renewals.push([...original]);
      if (!mayRenew) throw new Error('原图片无法续期。');
    },
  };
  const { service, start } = await fixture(t, async (url, request) => {
    assert.equal(url, '/v1/jobs');
    posts.push(structuredClone(request));
    throw new Error('lost receipt');
  }, { lanMedia });
  const [first, same] = await Promise.all([service.submitDraft(input), service.submitDraft(input)]);
  const id = first.draft.id;
  assert.equal(same.draft.id, id);
  assert.equal(same.duplicate, true);
  await result(service, id, 'unknown');
  await assert.rejects(service.submitDraft({ ...input, fingerprint: '2'.repeat(64) }), /此前版本/);
  assert.deepEqual(posts[0].body.content.image_urls, urls);
  assert.equal(issued, 1);
  assert.deepEqual(renewals, []);
  await service.close();

  const withoutLan = await start(async () => assert.fail('LAN retry dispatched without a gateway'));
  await assert.rejects(withoutLan.retryDraft(id), /请恢复原局域网图片服务/);
  assert.equal(withoutLan.getSubmission(id).retryMode, 'recover_receipt');
  await withoutLan.close();

  const restart = await start(async (url, request) => {
    if (request.method === 'POST') { posts.push(structuredClone(request)); return job; }
    return url.includes('/jobs/') ? { ...job, status: 'succeeded' } : ready;
  }, { lanMedia });
  assert.ok((await restart.submitDraft(input)).duplicate);
  const detail = await restart.getSubmissionDetail(id);
  assert.equal(detail.images.length, 2);
  assert.ok(!JSON.stringify([detail, restart.listSubmissions()]).includes('/xhs-media/'));
  await assert.rejects(restart.recheckDraft(id));
  assert.deepEqual(renewals, []);
  await assert.rejects(restart.retryDraft(id), { submissionNotAttempted: true });
  assert.equal(posts.length, 1);
  assert.equal(restart.getSubmission(id).retryMode, 'recover_receipt');
  assert.equal(restart.getSubmission(id).attempts, 1);
  mayRenew = true;
  await restart.retryDraft(id);
  await result(restart, id, 'verified');
  assert.ok((await restart.retryDraft(id)).duplicate);
  assert.deepEqual(renewals, [urls, urls]);
  assert.equal(issued, 1);
  assert.deepEqual(posts, [posts[0], posts[0]]);
});

test('a failed LAN issue leaves the submission unattempted and eligible for a later submit', async t => {
  let available = false;
  const lanMedia = {
    async createUrls() {
      if (!available) throw new Error('无法核对原图。');
      return ['http://192.168.2.17/a', 'http://192.168.2.17/b'];
    },
  };
  const calls = [];
  const { service } = await fixture(t, async (url, request) => {
    calls.push(request);
    return request.method === 'POST' ? job : { ...job, status: 'needs_attention' };
  }, { lanMedia });
  await assert.rejects(service.submitDraft(input), { submissionNotAttempted: true });
  assert.deepEqual(service.listSubmissions(), []);
  assert.deepEqual(calls, []);
  available = true;
  const { draft } = await service.submitDraft(input);
  await result(service, draft.id, 'unknown');
  await service.recheckDraft(draft.id);
  await result(service, draft.id, 'unknown');
  assert.equal(calls.filter(request => request.method === 'POST').length, 1);
});

test('a restart queries a durable task ID with GET, isolates service/account scopes, and never reposts', async t => {
  const { service, start } = await fixture(t, async (url, options) => options.method === 'POST' ? job : { ...job, status: 'running' });
  const { draft } = await service.submitDraft(input);
  await result(service, draft.id, 'running');
  await service.close();
  const saved = JSON.parse(await readFile(service.file, 'utf8'))[0];
  assert.equal(saved.remoteDraftId, job.draft_id);
  assert.equal(saved.idempotencyKey, 'content-studio:create:' + input.fingerprint);
  const other = await start(undefined, { serviceUrl: 'https://another.example' });
  assert.equal(other.listSubmissions().length, 0);
  const restart = await start(async (url, options) => {
    assert.equal(options.method, 'GET');
    return url.includes('/jobs/') ? { ...job, status: 'succeeded' } : ready;
  });
  await result(restart, draft.id, 'verified');
});

test('ambiguous browser results only permit read-only reconciliation, including mismatch and incomplete responses', async t => {
  let remote = { ...job, status: 'needs_attention' };
  let doc = { ...ready, account_id: 'wrong' };
  const posts = [];
  const { service } = await fixture(t, async (url, options) => {
    if (options.method === 'POST') { posts.push(url); return job; }
    return url.includes('/jobs/') ? remote : doc;
  });
  const { draft } = await service.submitDraft(input);
  assert((await result(service, draft.id, 'unknown')).canRecheck);
  await assert.rejects(service.retryDraft(draft.id), /不能安全重试/);
  remote = { ...job, status: 'succeeded' };
  await service.recheckDraft(draft.id);
  assert.equal((await result(service, draft.id, 'unknown')).verifiedAt, null);
  doc = { ...ready, platform_status: 'pending' };
  await service.recheckDraft(draft.id);
  await result(service, draft.id, 'unknown');
  doc = ready;
  await service.recheckDraft(draft.id);
  await result(service, draft.id, 'verified');
  assert.deepEqual(posts, ['/v1/jobs']);
});

test('retries only the original job download after a confirmed pre-browser failure', async t => {
  let retried = false;
  const calls = [];
  const urls = ['http://192.168.2.17/first', 'http://192.168.2.17/second'];
  const lanMedia = { async createUrls() { calls.push('issue'); return urls; },
    async renewUrls(original) { assert.deepEqual(original, urls); calls.push('renew'); } };
  const { service } = await fixture(t, async (url, options) => {
    if (options.method === 'POST') {
      calls.push(url);
      if (url.endsWith('/retry-download')) retried = true;
      return job;
    }
    if (url.includes('/drafts/')) return ready;
    return retried ? { ...job, status: 'succeeded' } : { ...job, status: 'failed', phase: 'create_failed' };
  }, { lanMedia });
  const { draft } = await service.submitDraft(input);
  assert.equal((await result(service, draft.id, 'failed')).retryMode, 'download');
  await service.retryDraft(draft.id);
  await result(service, draft.id, 'verified');
  assert.deepEqual(calls, ['issue', '/v1/jobs', 'renew', '/v1/jobs/' + job.job_id + '/retry-download']);
});

test('a pre-acceptance rejection can reuse the original request, but a duplicate conflict cannot be replayed', async t => {
  const posts = [];
  const { service } = await fixture(t, async (url, options) => {
    posts.push(options);
    throw Object.assign(new Error('sensitive upstream detail'), { status: posts.length === 1 ? 422 : 409,
      code: posts.length === 1 ? 'IMAGE_URL_NOT_ALLOWED' : 'DUPLICATE_CONTENT' });
  });
  const { draft } = await service.submitDraft(input);
  const rejected = await result(service, draft.id, 'failed');
  assert.equal(rejected.retryMode, 'resubmit');
  assert(!rejected.message.includes('sensitive'));
  await service.retryDraft(draft.id);
  const conflict = await result(service, draft.id, 'unknown');
  assert(!conflict.canRetry && !conflict.canRecheck);
  assert((await service.submitDraft(input)).duplicate);
  await assert.rejects(service.retryDraft(draft.id), /不能安全重试/);
  assert.deepEqual(posts[0], posts[1]);
});

test('a crash after journal admission but before receipt persistence never replays a create at startup', async t => {
  const { service, start } = await fixture(t, async () => { throw new Error('receipt lost'); });
  const { draft } = await service.submitDraft(input);
  await result(service, draft.id, 'unknown');
  await service.close();
  const rows = JSON.parse(await readFile(service.file, 'utf8'));
  rows[0].status = 'queued';
  rows[0].retryMode = null;
  await writeFile(service.file, JSON.stringify(rows));
  const calls = [];
  const fresh = await start(async (...args) => { calls.push(args); throw new Error(); });
  const recovered = fresh.getSubmission(draft.id);
  assert.equal(recovered.retryMode, 'recover_receipt');
  assert.equal(recovered.status, 'unknown');
  assert.deepEqual(calls, []);
});
