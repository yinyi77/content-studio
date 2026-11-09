import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { XhsDeliveryQueue } from '../lib/xhs-delivery.mjs';

// All storage and browser behavior stays in memory. These tests never open a
// browser, contact any provider, or write a real account's draft.
const A = '5f0000000000000000000001', B = '5f0000000000000000000002';
const fingerprint = 'f'.repeat(64);
const clone = value => structuredClone(value);

function project(extra = {}) {
  return { id: randomUUID(), status: 'completed', chatStatus: 'idle', title: 'MOCK 工具图文', caption: 'MOCK 已确认的帖子正文',
    pages: [{ id: randomUUID(), status: 'done', imageUrl: '/media/mock-image.png' }],
    xhsDelivery: { enabled: true, accountId: A, accountName: 'MOCK 工具作者', status: 'waiting_generation',
      attempted: false, draftId: null, fingerprint: null, message: '等待完成生成', ...extra } };
}

function fixture(initial = project(), overrides = {}) {
  const projects = new Map([[initial.id, clone(initial)]]), calls = [];
  const state = { account: { id: A, nickname: 'MOCK 工具作者' }, connection: { state: 'connected' }, status: { busy: false }, drafts: [] };
  const store = { get: async id => clone(projects.get(id) || null), list: async () => clone([...projects.values()]),
    save: async item => { projects.set(item.id, clone(item)); } };
  const receipt = (payload, status = 'verified') => ({ id: randomUUID(), projectId: payload.projectId, accountId: payload.accountId,
    fingerprint: payload.fingerprint, status, message: `MOCK ${status}`, canRetry: status === 'failed',
    updatedAt: new Date().toISOString(), verifiedAt: status === 'verified' ? new Date().toISOString() : null });
  const xhs = { snapshot: () => clone(state),
    checkLogin: async () => { calls.push({ action: 'check' }); },
    submitDraft: async payload => {
      calls.push({ action: 'submit', payload: clone(payload) }); const draft = receipt(payload); state.drafts.push(draft); return { draft: clone(draft) };
    },
    retryDraft: async id => {
      calls.push({ action: 'retry', id }); const draft = state.drafts.find(item => item.id === id);
      assert.ok(draft); assert.equal(draft.status, 'failed');
      Object.assign(draft, { status: 'verified', canRetry: false, message: 'MOCK 已显式重试核验', verifiedAt: new Date().toISOString() });
      return { draft: clone(draft) };
    },
  };
  const queue = new XhsDeliveryQueue({ store, xhs, modelBusy: () => false,
    prepare: async input => { calls.push({ action: 'prepare', input: clone(input) }); return { projectId: input.projectId,
      accountId: input.accountId, title: initial.title, content: initial.caption, images: ['/mock/no-file-is-read.png'], fingerprint }; },
    ...overrides });
  return { queue, store, xhs, state, calls, receipt, initial, get: () => store.get(initial.id) };
}

test('restart between creative completion and enqueue offers explicit continuation without an automatic send', async () => {
  const f = fixture();
  await f.queue.recover();
  let value = f.queue.view(await f.get());
  assert.equal(value.status, 'completed');
  assert.equal(value.xhsDelivery.status, 'interrupted');
  assert.equal(value.xhsDelivery.attempted, false);
  assert.equal(value.xhsDelivery.canContinue, true);
  assert.deepEqual(f.calls, [], 'Recovery and safe GET-like views may not invoke a browser');
  f.queue.view(await f.get()); await f.queue.recover();
  assert.deepEqual(f.calls, [], 'Repeated recovery cannot restore an external write');
  await f.queue.enqueue(f.initial.id, { manual: true, accountId: A });
  await f.queue.tail;
  value = f.queue.view(await f.get());
  assert.equal(value.xhsDelivery.status, 'verified');
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1);
});

test('a local admission failure reattaches the known failed receipt by fingerprint and permits only explicit retry', async () => {
  const f = fixture();
  f.xhs.submitDraft = async payload => {
    f.calls.push({ action: 'submit', payload: clone(payload) });
    f.state.drafts.push(f.receipt(payload, 'failed'));
    throw Object.assign(new Error('MOCK 初次记录持久化失败，未执行浏览器动作'), { status: 503 });
  };
  await f.queue.afterCreative(await f.get()); await f.queue.tail;
  let value = f.queue.view(await f.get());
  assert.equal(value.status, 'completed', 'Delivery failures must preserve completed images');
  assert.equal(value.xhsDelivery.status, 'failed');
  assert.equal(value.xhsDelivery.draftId, f.state.drafts[0].id);
  assert.equal(value.xhsDelivery.fingerprint, fingerprint);
  assert.equal(value.xhsDelivery.canContinue, true);
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1);
  assert.equal(f.calls.filter(item => item.action === 'retry').length, 0);
  await f.queue.recover(); f.queue.view(await f.get());
  assert.equal(f.calls.filter(item => item.action === 'retry').length, 0, 'Readback and recovery never retry a failed external attempt');
  await f.queue.enqueue(f.initial.id, { manual: true, accountId: A }); await f.queue.tail;
  value = f.queue.view(await f.get());
  assert.equal(value.xhsDelivery.status, 'verified');
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1, 'Retry uses the frozen receipt, not a second submission');
  assert.equal(f.calls.filter(item => item.action === 'retry').length, 1);
});

test('a missing draft ID is recovered from a matching frozen fingerprint without resending', async () => {
  const f = fixture(project({ status: 'unknown', attempted: true, fingerprint }));
  const known = f.receipt({ projectId: f.initial.id, accountId: A, fingerprint }, 'failed'); f.state.drafts.push(known);
  await f.queue.recover();
  const value = f.queue.view(await f.get());
  assert.equal(value.xhsDelivery.draftId, known.id);
  assert.equal(value.xhsDelivery.status, 'failed');
  assert.equal(value.xhsDelivery.canContinue, true);
  assert.deepEqual(f.calls, []);
});

test('queue timeout keeps the work frozen while its accepted browser operation is still running', async () => {
  const f = fixture(project(), { maxWaitMs: 0, wait: () => new Promise(resolve => setTimeout(resolve, 2)) });
  f.xhs.submitDraft = async payload => {
    f.calls.push({ action: 'submit', payload: clone(payload) }); const draft = f.receipt(payload, 'running');
    f.state.drafts.push(draft); f.state.status.busy = true; return { draft: clone(draft) };
  };
  await f.queue.afterCreative(await f.get()); await f.queue.tail;
  let saved = await f.get();
  assert.equal(f.queue.active.has(saved.id), false, 'The bounded queue wait has already ended');
  assert.equal(f.state.status.busy, true, 'The browser has not acknowledged an outcome yet');
  assert.equal(f.queue.isProcessing(saved), true, 'Accepted writes must still block project edits and deletion');
  assert.equal(f.queue.view(saved).xhsDelivery.running, true);
  assert.equal(f.queue.view(saved).xhsDelivery.canContinue, false);
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1);
  Object.assign(f.state.drafts[0], { status: 'verified', verifiedAt: new Date().toISOString(), message: 'MOCK 延迟核验完成' });
  f.state.status.busy = false;
  saved = await f.get();
  assert.equal(f.queue.isProcessing(saved), false);
  const completed = f.queue.view(saved);
  assert.equal(completed.xhsDelivery.running, false);
  assert.equal(completed.xhsDelivery.status, 'verified');
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1, 'Late success is readback, never a repeated submission');
});

test('another account receipt cannot rewrite delivery state or authorize retargeting an existing creative work', async () => {
  const initial = project({ status: 'blocked', message: 'MOCK 原账号尚未送稿' });
  const f = fixture(initial); f.state.account = { id: B, nickname: 'MOCK 另一个账号' };
  f.state.drafts.push(f.receipt({ projectId: initial.id, accountId: B, fingerprint }, 'verified'));
  f.state.drafts.push(f.receipt({ projectId: randomUUID(), accountId: B, fingerprint }, 'running'));
  f.state.status.busy = true;
  assert.equal(f.queue.task(initial), null);
  assert.equal(f.queue.view(initial).xhsDelivery.status, 'blocked');
  assert.equal(f.queue.view(initial).xhsDelivery.accountId, A);
  assert.equal(f.queue.isProcessing(initial), false, 'A different work being processed must not create a false delivery lock');
  await assert.rejects(f.queue.enqueue(initial.id, { manual: true, accountId: B }), error => error.status === 409);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.get()).xhsDelivery.accountId, A);
});

function versionFixture(initial = project(), overrides = {}) {
  const f = fixture(initial, overrides);
  f.queue.prepare = async input => {
    f.calls.push({ action: 'prepare', input: clone(input) });
    const current = await f.store.get(input.projectId);
    return { ...input, title: current.title, content: current.caption, images: ['/mock/no-file-is-read.png'],
      fingerprint: createHash('sha256').update(JSON.stringify([input.accountId, input.projectId, current.title, current.caption, current.pages.map(page => page.imageUrl)])).digest('hex') };
  };
  return f;
}

async function firstVersion(f) {
  await f.queue.afterCreative(await f.get()); await f.queue.tail;
  const value = f.queue.view(await f.get());
  assert.equal(value.xhsDelivery.status, 'verified');
  return value.xhsDelivery;
}

test('explicitly saving an unchanged version reuses its receipt without a second upload or history entry', async () => {
  const f = versionFixture(), first = await firstVersion(f);
  assert.equal(first.versionChanged, false);
  await f.queue.enqueueVersion(f.initial.id, { accountId: A }); await f.queue.tail;
  const current = f.queue.view(await f.get()).xhsDelivery;
  assert.equal(current.draftId, first.draftId);
  assert.equal(current.version, 1);
  assert.deepEqual(current.history, []);
  assert.equal(current.pendingVersion, false);
  assert.equal(current.versionChanged, false);
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1);
});

test('a changed post is saved as a separate version and retains the first verified receipt', async () => {
  const f = versionFixture(), first = await firstVersion(f);
  const changed = await f.get(); changed.caption += '\nMOCK 用户明确要求的新卖点'; await f.store.save(changed);
  assert.equal(f.queue.view(changed).xhsDelivery.versionChanged, true);
  assert.equal(f.queue.view(changed).xhsDelivery.canSaveVersion, true);
  await f.queue.afterCreative(changed); await f.queue.tail;
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1, 'Ordinary chat changes never trigger another external write');
  await f.queue.enqueueVersion(changed.id, { accountId: A }); await f.queue.tail;
  const current = f.queue.view(await f.get()).xhsDelivery;
  assert.equal(current.status, 'verified');
  assert.equal(current.version, 2);
  assert.notEqual(current.draftId, first.draftId);
  assert.equal(current.history.length, 1);
  assert.equal(current.history[0].draftId, first.draftId);
  assert.equal(current.history[0].status, 'verified');
  assert.equal(current.versionChanged, false);
  assert.equal(f.state.drafts.length, 2);
  assert.equal(f.state.drafts[0].fingerprint, first.fingerprint, 'The original draft is never overwritten');
  await f.queue.enqueueVersion(changed.id, { accountId: A }); await f.queue.tail;
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 2);
  assert.equal(f.queue.view(await f.get()).xhsDelivery.history.length, 1);
});

test('returning to a previous version reuses its original receipt and keeps the newer receipt in history', async () => {
  const f = versionFixture(), first = await firstVersion(f);
  const changed = await f.get(); changed.caption = 'MOCK 第二版文案'; await f.store.save(changed);
  await f.queue.enqueueVersion(changed.id, { accountId: A }); await f.queue.tail;
  const second = f.queue.view(await f.get()).xhsDelivery;
  const reverted = await f.get(); reverted.caption = f.initial.caption; await f.store.save(reverted);
  await f.queue.enqueueVersion(reverted.id, { accountId: A }); await f.queue.tail;
  const current = f.queue.view(await f.get()).xhsDelivery;
  assert.equal(current.draftId, first.draftId);
  assert.equal(current.version, 1);
  assert.equal(current.history.length, 1);
  assert.equal(current.history[0].draftId, second.draftId);
  assert.equal(current.history[0].version, 2);
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 2);
});

test('project receipt still prevents duplicate uploads if the account service has pruned an older verified record', async () => {
  const f = versionFixture(), first = await firstVersion(f);
  f.state.drafts = [];
  await f.queue.enqueueVersion(f.initial.id, { accountId: A }); await f.queue.tail;
  const current = f.queue.view(await f.get()).xhsDelivery;
  assert.equal(current.status, 'verified');
  assert.equal(current.draftId, first.draftId);
  assert.equal(current.verifiedAt, first.verifiedAt);
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1);
});

test('explicit new-version admission waits for its finishing model job and deduplicates concurrent requests', async () => {
  let busy = false, release;
  const f = versionFixture(project(), { modelBusy: () => busy, wait: () => new Promise(resolve => { release = resolve; }) });
  await firstVersion(f);
  const changed = await f.get(); changed.title = 'MOCK 已修改的帖子标题'; await f.store.save(changed); busy = true;
  const accepted = await f.queue.enqueueVersion(changed.id, { accountId: A });
  assert.equal(accepted.xhsDelivery.running, true);
  assert.equal(accepted.xhsDelivery.pendingVersion, true);
  const sameRequest = await f.queue.enqueueVersion(changed.id, { accountId: A });
  assert.equal(sameRequest.xhsDelivery.version, accepted.xhsDelivery.version);
  await assert.rejects(f.queue.enqueueVersion(changed.id, { accountId: B }), error => error.status === 409);
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1);
  busy = false; release(); await f.queue.tail;
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 2);
  assert.equal(f.queue.view(await f.get()).xhsDelivery.history.length, 1);
});

test('uncertain earlier drafts block new versions, even when a different latest receipt is verified', async () => {
  for (const status of ['filled', 'unknown', 'interrupted']) {
    const f = versionFixture(), first = await firstVersion(f);
    const uncertain = f.receipt({ projectId: f.initial.id, accountId: A, fingerprint: 'a'.repeat(64) }, status);
    f.state.drafts.push(uncertain);
    const changed = await f.get(); changed.caption = 'MOCK 尚不能送出的新版'; await f.store.save(changed);
    assert.equal(f.queue.view(changed).xhsDelivery.canSaveVersion, false);
    await assert.rejects(f.queue.enqueueVersion(changed.id, { accountId: A }), error => error.status === 409);
    assert.equal((await f.get()).xhsDelivery.draftId, first.draftId);
    assert.equal(f.calls.filter(item => item.action === 'submit').length, 1);
  }
});

test('a recheck worker locks all versions of its project and cannot overlap a new draft write', async () => {
  const f = versionFixture(); await firstVersion(f);
  f.state.drafts[0].rechecking = true;
  assert.equal(f.queue.isProcessing(await f.get()), true);
  assert.equal(f.queue.view(await f.get()).xhsDelivery.canSaveVersion, false);
  await assert.rejects(f.queue.enqueueVersion(f.initial.id, { accountId: A }), error => error.status === 409);
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1);
});

test('a failed unsubmitted version uses explicit safe retry rather than creating another version', async () => {
  const f = versionFixture();
  f.xhs.submitDraft = async payload => {
    f.calls.push({ action: 'submit', payload: clone(payload) }); const draft = f.receipt(payload, 'failed');
    f.state.drafts.push(draft); return { draft: clone(draft) };
  };
  await f.queue.afterCreative(await f.get()); await f.queue.tail;
  const failed = f.queue.view(await f.get()).xhsDelivery;
  await f.queue.enqueueVersion(f.initial.id, { accountId: A }); await f.queue.tail;
  const current = f.queue.view(await f.get()).xhsDelivery;
  assert.equal(current.status, 'verified');
  assert.equal(current.version, 1);
  assert.equal(current.draftId, failed.draftId);
  assert.deepEqual(current.history, []);
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1);
  assert.equal(f.calls.filter(item => item.action === 'retry').length, 1);
});

test('historical completed projects can explicitly bind and deliver once, without an automatic send', async () => {
  const initial = project(); delete initial.xhsDelivery;
  const f = versionFixture(initial);
  await f.queue.afterCreative(await f.get());
  assert.deepEqual(f.calls, []);
  await f.queue.enqueueVersion(initial.id, { accountId: A }); await f.queue.tail;
  const current = f.queue.view(await f.get()).xhsDelivery;
  assert.equal(current.accountId, A);
  assert.equal(current.version, 1);
  assert.deepEqual(current.history, []);
  assert.equal(current.status, 'verified');
  await assert.rejects(f.queue.enqueueVersion(initial.id, { accountId: B }), error => error.status === 409);
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1);
});

test('a new-version preparation failure retains the prior receipt and restart never repeats the queued write', async () => {
  const f = versionFixture(), first = await firstVersion(f);
  const changed = await f.get(); changed.caption = 'MOCK 新版正文'; await f.store.save(changed);
  const prepare = f.queue.prepare;
  f.queue.prepare = async () => { throw new Error('MOCK 图片文件尚未就绪'); };
  await f.queue.enqueueVersion(changed.id, { accountId: A }); await f.queue.tail;
  let current = f.queue.view(await f.get()).xhsDelivery;
  assert.equal(current.status, 'blocked');
  assert.equal(current.attempted, false);
  assert.equal(current.history[0].draftId, first.draftId);
  assert.equal(current.canContinue, true);
  await f.queue.recover(); f.queue.view(await f.get());
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1);
  f.queue.prepare = prepare;
  await f.queue.enqueue(changed.id, { manual: true, accountId: A }); await f.queue.tail;
  current = f.queue.view(await f.get()).xhsDelivery;
  assert.equal(current.status, 'verified');
  assert.equal(current.version, 2);
  assert.equal(current.history[0].draftId, first.draftId);
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 2);
});

test('view keeps polling through the completed-chat to explicit-delivery handoff without adding a write lock', async () => {
  let busy = false;
  const f = versionFixture(project(), { modelBusy: () => busy }); await firstVersion(f);
  const finishedChat = await f.get();
  finishedChat.chatRequests = [{ requestId: randomUUID(), status: 'completed', saveVersionRequested: true }];
  await f.store.save(finishedChat); busy = true;
  assert.equal(f.queue.view(finishedChat).xhsDelivery.running, true);
  assert.equal(f.queue.view(finishedChat).xhsDelivery.canSaveVersion, false);
  assert.equal(f.queue.isProcessing(finishedChat), false, 'The finishing model job must not deadlock its own delivery preparation');
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1);
  busy = false;
  assert.equal(f.queue.view(finishedChat).xhsDelivery.running, false);
});

test('restart preserves the previous receipt while leaving a pending new version interrupted until explicit continuation', async () => {
  const f = versionFixture(), first = await firstVersion(f);
  const changed = await f.get(); changed.caption = 'MOCK 重启前的第二版';
  changed.xhsDelivery = { ...changed.xhsDelivery, history: [{ ...changed.xhsDelivery }], status: 'queued', draftId: null,
    fingerprint: null, attempted: false, version: 2, pendingVersion: true, contentSignature: null };
  await f.store.save(changed);
  await f.queue.recover();
  const restored = f.queue.view(await f.get()).xhsDelivery;
  assert.equal(restored.status, 'interrupted');
  assert.equal(restored.canContinue, true);
  assert.equal(restored.history[0].draftId, first.draftId);
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 1);
  await f.queue.enqueue(changed.id, { manual: true, accountId: A }); await f.queue.tail;
  const current = f.queue.view(await f.get()).xhsDelivery;
  assert.equal(current.version, 2);
  assert.equal(current.status, 'verified');
  assert.equal(current.history[0].draftId, first.draftId);
  assert.equal(f.calls.filter(item => item.action === 'submit').length, 2);
});
