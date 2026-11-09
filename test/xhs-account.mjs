import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { XhsAccountService } from '../lib/xhs-account.mjs';

// Browser behaviour is injected. These tests do not open Chrome, visit XHS or
// create anything in a real account.
const A = '5f0000000000000000000001', B = '5f0000000000000000000002';
const NOW = Date.parse('2026-11-09T02:00:00Z');
const user = (id = A) => ({ id, nickname: `MOCK ${id === A ? '工具作者' : '另一个账号'}`, url: `https://www.xiaohongshu.com/user/profile/${id}`, avatar: 'https://avatar.xhscdn.com/mock.jpg', followers: 0, following: 10, likes: null, notesCount: 2 });
const connected = (id = A) => ({ state: 'connected', account: user(id), message: 'MOCK 已识别当前账号', browserOpen: true });
const input = extra => ({ projectId: randomUUID(), title: 'MOCK 已确认的工具', content: 'PRIVATE_DRAFT_BODY_NEVER_RETURN_THIS_TEXT', images: ['/private/tmp/PRIVATE_IMAGE_FOLDER/first.png', '/private/tmp/PRIVATE_IMAGE_FOLDER/second.png'], accountId: A, fingerprint: 'a'.repeat(64), ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-xhs-account-'));
  let now = NOW; const calls = [];
  const defaults = {
    openLogin: async () => connected(), inspectAccount: async () => connected(),
    sync: async () => ({ ...connected(), metrics: [{ id: 'views', label: '观看', value: 0, unit: '次', source: '创作中心数据概览', period: '页面当前范围' }], notes: [{ id: 'note-1', title: 'MOCK 工具笔记', url: 'https://www.xiaohongshu.com/explore/note-1', views: null, likes: 0 }], coverage: { message: '仅当前已加载笔记', hasMore: true, limit: 50 } }),
    saveDraft: async value => ({ state: 'verified', submitted: true, accountId: value.accountId, verifiedAt: new Date(now).toISOString(), message: 'MOCK 已重开核对草稿，未发布' }),
    verifyDraft: async value => ({ state: 'verified', accountId: value.accountId, verifiedAt: new Date(now).toISOString(), message: 'MOCK 已只读核验草稿' }),
    openDrafts: async () => ({ ...connected(), message: 'MOCK 电脑草稿已打开' }), close: async () => {},
  };
  const handlers = { ...defaults, ...overrides };
  const driver = Object.fromEntries(Object.keys(defaults).map(name => [name, async (...args) => { calls.push({ name, args }); return handlers[name](...args); }]));
  const service = new XhsAccountService({ dir, driver, now: () => now }); await service.init();
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const settle = async () => { await service.inFlight; return service.snapshot(); };
  const connect = async () => { await service.startLogin(); const state = await settle(); assert.equal(state.connection.state, 'connected'); return state; };
  return { dir, service, driver, handlers, calls, settle, connect, setNow: value => { now = value; } };
}

test('initialization is inert and no login, analytics or browser state is exposed', async t => {
  const f = await fixture(t);
  const state = f.service.snapshot();
  assert.equal(state.connection.state, 'disconnected');
  assert.equal(state.connection.browserOpen, false);
  assert.equal(state.account, null);
  assert.equal(state.status.busy, false);
  assert.equal(state.sync.coverage.hasMore, null);
  assert.deepEqual(state.metrics, []); assert.deepEqual(state.notes, []); assert.deepEqual(state.drafts, []);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.startSync(), error => error.status === 409);
});

test('login is a bounded asynchronous worker and all other browser actions conflict while it runs', async t => {
  const gate = deferred(); const f = await fixture(t, { openLogin: () => gate.promise });
  const pending = await f.service.startLogin();
  assert.equal(pending.status.busy, true); assert.equal(pending.connection.state, 'connecting');
  await assert.rejects(f.service.checkLogin(), error => error.status === 409);
  await assert.rejects(f.service.disconnect(), error => error.status === 409);
  gate.resolve({ state: 'login_required', browserOpen: true, message: '请本人扫码' });
  const state = await f.settle();
  assert.equal(state.connection.state, 'login_required'); assert.equal(state.status.busy, false);
  assert.equal(f.calls.filter(call => call.name === 'openLogin').length, 1);
  assert.equal((await stat(path.join(f.dir, 'xhs-account.json'))).mode & 0o777, 0o600);
  f.handlers.inspectAccount = async () => connected();
  await f.service.checkLogin(); assert.equal((await f.settle()).account.id, A);
});

test('connected requires a stable account ID; a nickname alone never authorizes a draft', async t => {
  const f = await fixture(t, { openLogin: async () => ({ state: 'connected', account: { nickname: 'MOCK 不足以定位账号' } }) });
  await f.service.startLogin(); const state = await f.settle();
  assert.equal(state.connection.state, 'needs_attention'); assert.equal(state.account, null);
  await assert.rejects(f.service.submitDraft(input()), error => error.status === 409);
  assert.equal(f.calls.filter(call => call.name === 'saveDraft').length, 0);
});

test('sync preserves genuine zeroes and unknown metrics, bounds visible data, and excludes raw browser fields', async t => {
  const f = await fixture(t, { sync: async () => ({ ...connected(), cookie: 'SECRET_COOKIE', rawHtml: '<private>', metrics: [
    { id: 'views', label: '观看', value: 0, unit: '次', source: '创作中心', period: '7天' },
    { id: 'fans', label: '涨粉', value: undefined, rawValue: 'PRIVATE_RAW_VALUE' },
    { id: 'negative', value: -1 }, { id: '<script>', value: 999 },
  ], notes: Array.from({ length: 70 }, (_, index) => ({ id: `note-${index}`, title: `MOCK 笔记 ${index}`, url: `https://www.xiaohongshu.com/explore/${index}?xsec_token=SECRET_COOKIE`, imageUrl: 'javascript:alert(1)', likes: index === 0 ? 0 : undefined, collects: NaN, content: 'PRIVATE_NOTE_CONTENT' })), coverage: { message: '首屏数据', limit: 999, hasMore: true } }) });
  await f.connect(); await f.service.startSync(); const state = await f.settle();
  assert.equal(state.metrics[0].value, 0); assert.equal(state.metrics[1].value, null); assert.equal(state.metrics[2].value, null);
  assert.equal(state.metrics.length, 3); assert.equal(state.notes.length, 50);
  assert.equal(state.notes[0].likes, 0); assert.equal(state.notes[1].likes, null); assert.equal(state.notes[0].collects, null);
  assert.equal(state.notes[0].imageUrl, ''); assert.equal(state.sync.coverage.limit, 50); assert.equal(state.sync.coverage.hasMore, true);
  assert.equal(state.sync.lastSyncAt, new Date(NOW).toISOString());
  assert.doesNotMatch(JSON.stringify(state), /SECRET_COOKIE|rawHtml|PRIVATE_RAW_VALUE|PRIVATE_NOTE_CONTENT|javascript:/);
});

test('a different browser account blocks syncing and writing until an explicit disconnection', async t => {
  const f = await fixture(t); await f.connect(); await f.service.startSync(); await f.settle();
  const first = input(); await f.service.submitDraft(first); await f.settle();
  f.handlers.sync = async () => ({ ...connected(B), metrics: [{ id: 'views', value: 999999 }], notes: [] });
  await f.service.startSync(); const mismatch = await f.settle();
  assert.equal(mismatch.account.id, A); assert.equal(mismatch.connection.state, 'needs_attention');
  assert.deepEqual(mismatch.metrics, []); assert.deepEqual(mismatch.notes, []);
  await assert.rejects(f.service.submitDraft(input()), error => error.status === 409);
  await f.service.disconnect(); const disconnected = await f.settle(); assert.equal(disconnected.account, null); assert.deepEqual(disconnected.drafts, []);
  f.handlers.openLogin = async () => connected(B); await f.service.startLogin(); const second = await f.settle();
  assert.equal(second.account.id, B); assert.deepEqual(second.drafts, []);
  await assert.rejects(f.service.submitDraft(input({ accountId: A })), error => error.status === 409);
  assert.equal(f.calls.filter(call => call.name === 'saveDraft').length, 1);
});

test('drafts freeze one version, reuse all replayed submissions, and never disclose body or file paths', async t => {
  const gate = deferred(), started = deferred(); const f = await fixture(t, { saveDraft: value => { started.resolve(); return gate.promise; } }); await f.connect();
  const source = input(); const first = await f.service.submitDraft(source); source.images.reverse(); source.content = '外部调用方后改的内容';
  assert.equal(first.snapshot.status.busy, true);
  const replay = await f.service.submitDraft({ ...source, content: '其他文字', images: ['/private/tmp/other.png'] });
  assert.equal(replay.duplicate, true); assert.equal(replay.draft.id, first.draft.id);
  await assert.rejects(f.service.submitDraft(input({ fingerprint: 'b'.repeat(64) })), error => error.status === 409);
  await started.promise;
  assert.deepEqual(f.calls.find(call => call.name === 'saveDraft').args[0].images, ['/private/tmp/PRIVATE_IMAGE_FOLDER/first.png', '/private/tmp/PRIVATE_IMAGE_FOLDER/second.png']);
  gate.resolve({ state: 'verified', submitted: true, accountId: A, verifiedAt: new Date(NOW).toISOString(), message: 'MOCK 已验证' });
  const saved = await f.settle(); assert.equal(saved.drafts[0].status, 'verified'); assert.equal(saved.drafts[0].canRetry, false);
  assert.equal((await f.service.submitDraft(source)).draft.id, first.draft.id);
  assert.equal(f.calls.filter(call => call.name === 'saveDraft').length, 1);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_DRAFT_BODY|PRIVATE_IMAGE_FOLDER|\.png|外部调用方后改/);
  const stored = JSON.parse(await readFile(path.join(f.dir, 'xhs-account.json'), 'utf8'));
  assert.equal(stored.drafts[0].content, 'PRIVATE_DRAFT_BODY_NEVER_RETURN_THIS_TEXT');
});

test('a genuine pre-submit failure requires explicit retry and reuses its frozen payload', async t => {
  const f = await fixture(t, { saveDraft: async () => ({ state: 'failed', submitted: false, message: '未找到可用图片上传区' }) }); await f.connect();
  const source = input(); const first = await f.service.submitDraft(source); let state = await f.settle();
  assert.equal(state.drafts[0].status, 'failed'); assert.equal(state.drafts[0].canRetry, true);
  assert.equal((await f.service.submitDraft(source)).duplicate, true);
  assert.equal(f.calls.filter(call => call.name === 'saveDraft').length, 1);
  f.handlers.saveDraft = async payload => ({ state: 'verified', submitted: true, accountId: payload.accountId, verifiedAt: new Date(NOW).toISOString() });
  await f.service.retryDraft(first.draft.id); state = await f.settle();
  assert.equal(state.drafts[0].status, 'verified'); assert.equal(state.drafts[0].attempts, 2);
  assert.equal(f.calls.filter(call => call.name === 'saveDraft').length, 2);
  await assert.rejects(f.service.retryDraft(first.draft.id), error => error.status === 409);
});

test('filled editors, ambiguous failures and incomplete verification are never retried as a fresh save', async t => {
  const f = await fixture(t); await f.connect();
  for (const result of [
    { state: 'filled', submitted: false, message: '发布页已填入，未点击暂存' },
    { state: 'failed', submitted: true, message: '点击后连接断开' },
    { state: 'verified', submitted: true, verifiedAt: new Date(NOW).toISOString() },
    { state: 'verified', submitted: true, accountId: A },
  ]) {
    f.handlers.saveDraft = async () => result;
    const source = input({ fingerprint: randomUUID().replaceAll('-', '').repeat(2) });
    const created = await f.service.submitDraft(source); const state = await f.settle();
    assert.ok(['filled', 'unknown'].includes(state.drafts[0].status)); assert.equal(state.drafts[0].canRetry, false);
    await assert.rejects(f.service.retryDraft(created.draft.id), error => error.status === 409);
    assert.equal((await f.service.submitDraft(source)).duplicate, true);
  }
});

test('a browser exception becomes an unknown draft without echoing browser secrets or paths', async t => {
  const f = await fixture(t, { saveDraft: async () => { throw new Error('Cookie: SESSION=SECRET_TOKEN /Users/private/ChromeProfile PRIVATE_DRAFT_BODY_NEVER_RETURN_THIS_TEXT'); } }); await f.connect();
  const created = await f.service.submitDraft(input()); const state = await f.settle();
  assert.equal(state.drafts[0].status, 'unknown'); assert.equal(state.drafts[0].canRetry, false);
  assert.doesNotMatch(JSON.stringify(state), /SECRET_TOKEN|ChromeProfile|PRIVATE_DRAFT_BODY/);
  await assert.rejects(f.service.retryDraft(created.draft.id), error => error.status === 409);
});

test('driver account mismatch never verifies or retries a draft sent with uncertain account identity', async t => {
  const f = await fixture(t, { saveDraft: async () => ({ state: 'verified', submitted: true, accountMismatch: true, accountId: B, verifiedAt: new Date(NOW).toISOString() }) }); await f.connect();
  const first = await f.service.submitDraft(input()); const state = await f.settle();
  assert.equal(state.connection.state, 'needs_attention'); assert.equal(state.account.id, A); assert.equal(state.drafts[0].status, 'unknown');
  await assert.rejects(f.service.retryDraft(first.draft.id), error => error.status === 409);
});

test('a login or verification interruption invalidates connected state before any manual retry', async t => {
  const f = await fixture(t, { saveDraft: async () => ({ state: 'failed', submitted: false, needsAttention: true, message: '请在专用浏览器完成登录验证' }) }); await f.connect();
  const first = await f.service.submitDraft(input()); const state = await f.settle();
  assert.equal(state.connection.state, 'needs_attention'); assert.equal(state.drafts[0].status, 'failed');
  await assert.rejects(f.service.retryDraft(first.draft.id), error => error.status === 409);
  assert.equal(f.calls.filter(call => call.name === 'saveDraft').length, 1);
});

test('restart retains safe records and needs a login check without opening a browser or retrying an unknown draft', async t => {
  const f = await fixture(t); await f.connect();
  const created = await f.service.submitDraft(input()); await f.settle();
  const file = path.join(f.dir, 'xhs-account.json'), saved = JSON.parse(await readFile(file, 'utf8'));
  saved.drafts[0].status = 'running'; saved.status.busy = true; await writeFile(file, JSON.stringify(saved));
  const before = f.calls.length;
  const restarted = new XhsAccountService({ dir: f.dir, driver: f.driver, now: () => NOW + 10000 }); await restarted.init();
  assert.equal(f.calls.length, before);
  const state = restarted.snapshot(); assert.equal(state.connection.state, 'needs_attention'); assert.equal(state.status.busy, false);
  assert.equal(state.drafts[0].status, 'unknown'); assert.equal(state.drafts[0].canRetry, false);
  await assert.rejects(restarted.retryDraft(created.draft.id), error => error.status === 409);
  const persisted = JSON.parse(await readFile(file, 'utf8')); assert.equal(persisted.drafts[0].status, 'unknown');
  await restarted.close();
});

test('closing an active worker leaves an unknown record and a late browser success cannot overwrite it', async t => {
  const gate = deferred(); const f = await fixture(t, { saveDraft: () => gate.promise }); await f.connect();
  await f.service.submitDraft(input()); await f.service.close();
  gate.resolve({ state: 'verified', submitted: true, accountId: A, verifiedAt: new Date(NOW).toISOString() }); await f.settle();
  assert.equal(f.service.snapshot().drafts[0].status, 'unknown');
  await assert.rejects(f.service.startLogin(), error => error.status === 503);
});

test('input and manual retry limits reject unsafe or unbounded payloads before browser execution', async t => {
  const f = await fixture(t, { saveDraft: async () => ({ state: 'failed', submitted: false }) }); await f.connect();
  for (const extra of [{ projectId: '../bad' }, { title: '字'.repeat(21) }, { content: '字'.repeat(1001) }, { images: ['relative.png'] }, { images: [] }, { images: Array(19).fill('/private/tmp/a.png') }, { fingerprint: 'not-a-hash' }, { accountId: B }]) await assert.rejects(f.service.submitDraft(input(extra)));
  assert.equal(f.calls.filter(call => call.name === 'saveDraft').length, 0);
  const created = await f.service.submitDraft(input()); await f.settle();
  for (let index = 0; index < 4; index++) { await f.service.retryDraft(created.draft.id); await f.settle(); }
  await assert.rejects(f.service.retryDraft(created.draft.id), error => error.status === 429);
  assert.equal(f.service.snapshot().drafts[0].attempts, 5); assert.equal(f.service.snapshot().drafts[0].canRetry, false);
});

test('emoji code-point limits and an empty caption survive a restart without changing the frozen draft', async t => {
  const f = await fixture(t); await f.connect();
  const title = '🚀'.repeat(20), content = '🧑'.repeat(1000);
  await f.service.submitDraft(input({ title, content })); await f.settle();
  await f.service.submitDraft(input({ content: '', fingerprint: 'b'.repeat(64) })); await f.settle();
  const restored = new XhsAccountService({ dir: f.dir, driver: f.driver }); await restored.init();
  const persisted = JSON.parse(await readFile(path.join(f.dir, 'xhs-account.json'), 'utf8'));
  assert.equal(persisted.drafts[0].title, title); assert.equal(persisted.drafts[0].content, content); assert.equal(persisted.drafts[1].content, '');
  assert.equal(restored.snapshot().drafts.find(draft => draft.fingerprint === 'a'.repeat(64)).title, title);
  await restored.close();
});

test('an initial persistence failure does not open the browser or strand a replay as queued', async t => {
  const f = await fixture(t); await f.connect();
  const persist = f.service.persist.bind(f.service); let failOnce = true;
  f.service.persist = async () => { if (failOnce) { failOnce = false; throw new Error('MOCK disk unavailable'); } return persist(); };
  const source = input();
  await assert.rejects(f.service.submitDraft(source), error => error.status === 503);
  let state = f.service.snapshot(); assert.equal(state.status.busy, false); assert.equal(state.drafts[0].status, 'failed'); assert.equal(state.drafts[0].canRetry, true);
  assert.equal(f.calls.filter(call => call.name === 'saveDraft').length, 0);
  const duplicate = await f.service.submitDraft(source); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.draft.status, 'failed');
  await f.service.retryDraft(duplicate.draft.id); state = await f.settle();
  assert.equal(state.drafts[0].status, 'verified'); assert.equal(f.calls.filter(call => call.name === 'saveDraft').length, 1);
});

test('recheck uses the frozen version in an exclusive read-only worker and completes a filled receipt', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, { saveDraft: async () => ({ state: 'filled', submitted: false }), verifyDraft: async payload => { started.resolve(payload); return gate.promise; } }); await f.connect();
  const source = input(), created = await f.service.submitDraft(source); await f.settle();
  source.title = '后来修改的标题'; source.content = '后来修改的正文'; source.images = [];
  assert.equal(f.service.snapshot().drafts[0].canRecheck, true);
  const accepted = await f.service.recheckDraft(created.draft.id, { accountId: A });
  assert.equal(accepted.snapshot.status.action, 'verify_draft'); assert.equal(accepted.snapshot.status.busy, true);
  assert.equal(accepted.draft.operation, 'recheck'); assert.equal(accepted.draft.rechecking, true);
  assert.ok(['queued', 'running'].includes(accepted.draft.status));
  const frozen = await started.promise;
  assert.equal(frozen.title, 'MOCK 已确认的工具'); assert.equal(frozen.content, 'PRIVATE_DRAFT_BODY_NEVER_RETURN_THIS_TEXT'); assert.equal(frozen.count, 2);
  assert.equal(frozen.fingerprint, 'a'.repeat(64)); assert.ok(!('images' in frozen));
  await assert.rejects(f.service.recheckDraft(created.draft.id, { accountId: A }), error => error.status === 409);
  await assert.rejects(f.service.startSync(), error => error.status === 409);
  await assert.rejects(f.service.submitDraft(input({ fingerprint: 'b'.repeat(64) })), error => error.status === 409);
  gate.resolve({ state: 'verified', accountId: A, verifiedAt: new Date(NOW).toISOString() });
  const state = await f.settle();
  assert.equal(state.drafts[0].status, 'verified'); assert.equal(state.drafts[0].attempts, 1); assert.equal(state.drafts[0].rechecking, false); assert.equal(state.drafts[0].canRecheck, false);
  assert.equal(f.calls.filter(call => call.name === 'saveDraft').length, 1);
  assert.equal((await f.service.recheckDraft(created.draft.id, { accountId: A })).duplicate, true);
  assert.equal(f.calls.filter(call => call.name === 'verifyDraft').length, 1);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_DRAFT_BODY|PRIVATE_IMAGE_FOLDER|后来修改/);
});

test('unsuccessful or incomplete rechecks keep the original filled/unknown receipt and never allow save retries', async t => {
  const f = await fixture(t); await f.connect();
  for (const status of ['filled', 'unknown']) {
    f.handlers.saveDraft = async () => ({ state: status, submitted: status === 'unknown' });
    const created = await f.service.submitDraft(input({ fingerprint: randomUUID().replaceAll('-', '').repeat(2) })); await f.settle();
    for (const result of [
      { state: 'unknown', message: '同名草稿无法唯一定位' },
      { state: 'verified', accountId: A },
      { state: 'verified', verifiedAt: new Date(NOW).toISOString() },
    ]) {
      f.handlers.verifyDraft = async () => result;
      await f.service.recheckDraft(created.draft.id, { accountId: A }); const state = await f.settle();
      const draft = state.drafts.find(item => item.id === created.draft.id);
      assert.equal(draft.status, status); assert.equal(draft.attempts, 1); assert.equal(draft.canRetry, false); assert.equal(draft.canRecheck, true);
    }
    f.handlers.verifyDraft = async () => { throw new Error('Cookie: SESSION=SECRET_TOKEN /Users/private/ChromeProfile'); };
    await f.service.recheckDraft(created.draft.id, { accountId: A }); const state = await f.settle();
    assert.equal(state.drafts.find(item => item.id === created.draft.id).status, status);
    assert.doesNotMatch(JSON.stringify(state), /SECRET_TOKEN|ChromeProfile/);
    await assert.rejects(f.service.retryDraft(created.draft.id), error => error.status === 409);
  }
  assert.equal(f.calls.filter(call => call.name === 'saveDraft').length, 2);
});

test('recheck enforces the record account and invalidates connection on observed account changes', async t => {
  const f = await fixture(t, { saveDraft: async () => ({ state: 'filled', submitted: false }), verifyDraft: async () => ({ state: 'verified', accountId: B, verifiedAt: new Date(NOW).toISOString() }) }); await f.connect();
  const created = await f.service.submitDraft(input()); await f.settle();
  await assert.rejects(f.service.recheckDraft(created.draft.id, { accountId: B }), error => error.status === 409);
  await assert.rejects(f.service.recheckDraft(randomUUID(), { accountId: A }), error => error.status === 404);
  assert.equal(f.calls.filter(call => call.name === 'verifyDraft').length, 0);
  await f.service.recheckDraft(created.draft.id, { accountId: A }); const state = await f.settle();
  assert.equal(state.account.id, A); assert.equal(state.connection.state, 'needs_attention'); assert.equal(state.drafts[0].status, 'filled');
  await assert.rejects(f.service.recheckDraft(created.draft.id, { accountId: A }), error => error.status === 409);
});

test('recheck persistence failures do not execute the browser and preserve the old receipt', async t => {
  const f = await fixture(t, { saveDraft: async () => ({ state: 'filled', submitted: false }) }); await f.connect();
  const created = await f.service.submitDraft(input()); await f.settle();
  const persist = f.service.persist.bind(f.service); let failOnce = true;
  f.service.persist = async () => { if (failOnce) { failOnce = false; throw new Error('MOCK disk unavailable'); } return persist(); };
  await assert.rejects(f.service.recheckDraft(created.draft.id, { accountId: A }), error => error.status === 503);
  const state = f.service.snapshot(); assert.equal(state.drafts[0].status, 'filled'); assert.equal(state.drafts[0].operation, 'save'); assert.equal(state.status.busy, false);
  assert.equal(f.calls.filter(call => call.name === 'verifyDraft').length, 0);
});

test('an interrupted read-only recheck is retained as unknown on restart without uploading or automatically reading', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, { saveDraft: async () => ({ state: 'filled', submitted: false }), verifyDraft: () => { started.resolve(); return gate.promise; } }); await f.connect();
  const created = await f.service.submitDraft(input()); await f.settle();
  await f.service.recheckDraft(created.draft.id, { accountId: A }); await started.promise;
  const before = f.calls.length, restored = new XhsAccountService({ dir: f.dir, driver: f.driver }); await restored.init();
  assert.equal(f.calls.length, before); assert.equal(restored.snapshot().drafts[0].status, 'unknown'); assert.equal(restored.snapshot().drafts[0].canRetry, false);
  assert.match(restored.snapshot().drafts[0].message, /核验被中断/);
  await restored.close(); await f.service.close();
  gate.resolve({ state: 'verified', accountId: A, verifiedAt: new Date(NOW).toISOString() }); await f.settle();
  assert.equal(f.service.snapshot().drafts[0].status, 'unknown');
});
