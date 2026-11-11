import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { XhsMediaCache } from '../lib/xhs-media.mjs';
import { XhsAccountService } from '../lib/xhs-account.mjs';

// Browser behaviour is injected. These tests do not open Chrome, visit XHS or
// create anything in a real account.
const A = '5f0000000000000000000001', B = '5f0000000000000000000002';
const NOW = Date.parse('2026-11-09T02:00:00Z');
const user = (id = A) => ({ id, nickname: `MOCK ${id === A ? '工具作者' : '另一个账号'}`, url: `https://www.xiaohongshu.com/user/profile/${id}`, avatar: 'https://avatar.xhscdn.com/mock.jpg', followers: 0, following: 10, likes: null, notesCount: 2 });
const connected = (id = A) => ({ state: 'connected', account: user(id), message: 'MOCK 已识别当前账号', browserOpen: true });
const input = extra => ({ projectId: randomUUID(), title: 'MOCK 已确认的工具', content: 'PRIVATE_DRAFT_BODY_NEVER_RETURN_THIS_TEXT', images: ['/private/tmp/PRIVATE_IMAGE_FOLDER/first.png', '/private/tmp/PRIVATE_IMAGE_FOLDER/second.png'], accountId: A, fingerprint: 'a'.repeat(64), ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function mediaPng(red, green, blue) {
  const chunk = (type, data) => {
    const tag = Buffer.from(type), bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); tag.copy(bytes, 4); data.copy(bytes, 8);
    let crc = 0xffffffff; for (const byte of Buffer.concat([tag, data])) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue]))), chunk('IEND', Buffer.alloc(0))]);
}
const mediaAsset = (bytes, index = 0) => ({ index, mime: 'image/png', base64: bytes.toString('base64') });


async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-xhs-account-'));
  let now = NOW; const calls = [];
  const defaults = {
    openLogin: async () => connected(), inspectAccount: async () => connected(),
    sync: async () => ({ ...connected(), metrics: [{ id: 'views', label: '观看', value: 0, unit: '次', source: '创作中心数据概览', period: '页面当前范围' }], notes: [{ id: 'note-1', title: 'MOCK 工具笔记', url: 'https://www.xiaohongshu.com/explore/note-1', views: null, likes: 0 }], coverage: { message: '仅当前已加载笔记', hasMore: true, limit: 50 } }),
    saveDraft: async value => ({ state: 'verified', submitted: true, accountId: value.accountId, verifiedAt: new Date(now).toISOString(), message: 'MOCK 已重开核对草稿，未发布' }),
    verifyDraft: async value => ({ state: 'verified', accountId: value.accountId, verifiedAt: new Date(now).toISOString(), message: 'MOCK 已只读核验草稿' }),
    readNote: async ({ noteId }) => ({ ...connected(), detail: { id: noteId, title: 'MOCK 官方笔记', content: 'PRIVATE_OFFICIAL_NOTE_BODY', images: ['https://ci.xhscdn.com/mock.webp?token=SECRET_TOKEN'], tags: ['效率'], source: 'official', isComplete: true } }),
    listDrafts: async () => ({ ...connected(), officialDrafts: [], coverage: { message: 'MOCK 官方草稿列表', hasMore: false, limit: 100 } }),
    readDraft: async ({ key }) => ({ ...connected(), detail: { id: key, title: 'MOCK 官方草稿', content: 'PRIVATE_OFFICIAL_DRAFT_BODY', images: ['https://ci.xhscdn.com/mock-draft.webp'], tags: [], source: 'official', isComplete: true } }),
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


test('analytics samples keep genuine values and source periods, replace the same day, and honor the requested note bound', async t => {
  const f = await fixture(t); await f.connect();
  f.handlers.sync = async () => ({ ...connected(), metrics: [{ id: 'views', value: 3, period: '近7天', source: '官方创作中心' }], notes: Array.from({ length: 230 }, (_, index) => ({ id: `note-${index}`, title: `笔记 ${index}` })), coverage: { limit: 999, hasMore: true } });
  await f.service.startSync({ noteLimit: 200 }); let state = await f.settle();
  assert.equal(state.notes.length, 200); assert.equal(state.sync.coverage.limit, 200); assert.deepEqual(f.calls.find(call => call.name === 'sync').args, [{ noteLimit: 200 }]);
  assert.equal(state.analyticsHistory.length, 1); assert.equal(state.analyticsHistory[0].accountId, A); assert.equal(state.analyticsHistory[0].account.followers, 0); assert.equal(state.analyticsHistory[0].account.likes, null); assert.equal(state.analyticsHistory[0].metrics[0].period, '近7天');
  f.setNow(NOW + 10000); await f.service.startSync(); state = await f.settle();
  assert.equal(state.notes.length, 50); assert.equal(state.analyticsHistory.length, 1); assert.equal(state.analyticsHistory[0].at, new Date(NOW + 10000).toISOString());
  f.setNow(NOW + 86400000); await f.service.startSync(); assert.equal((await f.settle()).analyticsHistory.length, 2);
  for (const noteLimit of [0, 49, 201, 50.5, '100']) await assert.rejects(f.service.startSync({ noteLimit }), error => error.status === 400);
  const cache = f.service.data.accountCaches[A]; cache.analyticsHistory = Array.from({ length: 365 }, (_, index) => ({ ...state.analyticsHistory[0], at: new Date(NOW - (365 - index) * 86400000).toISOString() }));
  f.setNow(NOW + 2 * 86400000); await f.service.startSync(); assert.equal((await f.settle()).analyticsHistory.length, 365);
});

test('daily analytics use Beijing midnight rather than UTC midnight', async t => {
  const f = await fixture(t); await f.connect();
  f.setNow(Date.parse('2026-11-09T15:59:59Z')); await f.service.startSync(); await f.settle();
  f.setNow(Date.parse('2026-11-09T16:00:01Z')); await f.service.startSync(); let state = await f.settle();
  assert.equal(state.analyticsHistory.length, 2);
  f.setNow(Date.parse('2026-11-10T01:00:00Z')); await f.service.startSync(); state = await f.settle();
  assert.equal(state.analyticsHistory.length, 2);
  assert.equal(state.analyticsHistory[1].at, '2026-11-10T01:00:00.000Z');
});

test('identity checks and content reads retain prior same-account counters when HOME omits them', async t => {
  const f = await fixture(t); await f.connect(); await f.service.startSync(); await f.settle();
  f.handlers.inspectAccount = async () => ({ ...connected(), account: { ...user(), followers: null, following: null, likes: null, notesCount: null } });
  await f.service.checkLogin(); let state = await f.settle();
  assert.equal(state.account.followers, 0); assert.equal(state.account.following, 10); assert.equal(state.account.notesCount, 2);
  f.handlers.inspectAccount = async () => ({ ...connected(), account: { ...user(), notesCount: 0 } });
  await f.service.checkLogin(); state = await f.settle(); assert.equal(state.account.notesCount, 0);
  f.handlers.sync = async () => ({ ...connected(), account: { ...user(), followers: null }, metrics: [], notes: [], coverage: {} });
  await f.service.startSync(); state = await f.settle();
  assert.equal(state.account.followers, null, 'a new sync must show actual missing data instead of a cached counter');
  assert.equal(state.analyticsHistory.at(-1).account.followers, null, 'a missing fresh value must not fabricate a historical sample');
});

test('note content is explicit, cached, account scoped, exclusive, and absent from common snapshots', async t => {
  const gate = deferred(); const f = await fixture(t, { readNote: () => gate.promise }); await f.connect(); await f.service.startSync(); await f.settle();
  const before = f.calls.length, cached = f.service.getNoteDetail('note-1', { accountId: A });
  assert.equal(cached.detail, null); assert.equal(cached.contentStatus.state, 'not_loaded'); assert.equal(f.calls.length, before);
  const pending = await f.service.startNoteDetail('note-1', { accountId: A }); assert.equal(pending.status.action, 'note_detail'); assert.equal(pending.notes[0].contentStatus.running, true);
  await assert.rejects(f.service.startSync(), error => error.status === 409); await assert.rejects(f.service.startNoteDetail('note-1', { accountId: B }), error => error.status === 409);
  gate.resolve({ ...connected(), detail: { id: 'note-1', title: '真实正文', content: 'PRIVATE_OFFICIAL_NOTE_BODY', images: ['https://ci.xhscdn.com/note.webp?token=SECRET_TOKEN&width=200'], tags: ['效率'], isComplete: true, message: 'PRIVATE_OFFICIAL_NOTE_BODY' } });
  let state = await f.settle(), detail = f.service.getNoteDetail('note-1', { accountId: A });
  assert.equal(detail.detail.content, 'PRIVATE_OFFICIAL_NOTE_BODY'); assert.equal(detail.detail.images[0], 'https://ci.xhscdn.com/note.webp?width=200'); assert.deepEqual(detail.detail.tags, ['效率']); assert.equal(detail.contentStatus.isComplete, true);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_OFFICIAL_NOTE_BODY|SECRET_TOKEN/);
  f.handlers.sync = async () => ({ ...connected(), metrics: [], notes: [{ id: 'note-1' }], coverage: {} }); await f.service.startSync(); state = await f.settle();
  assert.equal(state.notes[0].title, '真实正文'); assert.equal(state.notes[0].imageUrl, detail.detail.images[0]); assert.equal(state.notes[0].contentStatus.isComplete, true);
  f.handlers.readNote = async () => { throw new Error('SECRET_TOKEN /Users/mock/profile'); };
  f.setNow(NOW + 10000); await f.service.startNoteDetail('note-1'); state = await f.settle(); detail = f.service.getNoteDetail('note-1');
  assert.equal(detail.detail.content, 'PRIVATE_OFFICIAL_NOTE_BODY'); assert.equal(detail.contentStatus.lastSyncAt, new Date(NOW).toISOString()); assert.equal(detail.contentStatus.state, 'error'); assert.doesNotMatch(JSON.stringify(state), /SECRET_TOKEN|mock\/profile|PRIVATE_OFFICIAL_NOTE_BODY/);
  assert.throws(() => f.service.getNoteDetail('note-1', { accountId: B }), error => error.status === 409);
});

test('observed account changes retain each cache without mixing details, analytics, or histories', async t => {
  const f = await fixture(t); await f.connect(); await f.service.startSync(); await f.settle(); await f.service.startNoteDetail('note-1'); await f.settle();
  f.handlers.sync = async () => ({ ...connected(B), metrics: [{ id: 'views', value: 999 }], notes: [] });
  await f.service.startSync(); await f.settle(); await f.service.checkLogin(); let state = await f.settle(); // A is safely restored after checking A again.
  assert.equal(state.metrics[0].value, 0); assert.equal(f.service.getNoteDetail('note-1').detail.content, 'PRIVATE_OFFICIAL_NOTE_BODY');
  await f.service.disconnect(); await f.settle(); f.handlers.openLogin = async () => connected(B); await f.service.startLogin(); state = await f.settle();
  assert.deepEqual(state.notes, []); assert.deepEqual(state.analyticsHistory, []); assert.deepEqual(state.officialDrafts, []); assert.equal(f.service.getNoteDetail('note-1', { accountId: B }).detail, null); assert.ok(state.history.every(item => item.accountId === B));
  assert.throws(() => f.service.getNoteDetail('note-1', { accountId: A }), error => error.status === 409);
  await f.service.disconnect(); await f.settle(); f.handlers.openLogin = async () => connected(); await f.service.startLogin(); state = await f.settle();
  assert.equal(state.notes.length, 1); assert.equal(state.analyticsHistory.length, 1); assert.equal(f.service.getNoteDetail('note-1').detail.content, 'PRIVATE_OFFICIAL_NOTE_BODY'); assert.ok(state.history.every(item => item.accountId === A));
});

test('legacy v1 data migrates without losing metrics, notes, frozen versions or account history', async t => {
  const f = await fixture(t); await f.connect(); await f.service.startSync(); await f.settle(); await f.service.submitDraft(input()); await f.settle();
  const file = path.join(f.dir, 'xhs-account.json'), saved = JSON.parse(await readFile(file, 'utf8')); delete saved.accountCaches; await writeFile(file, JSON.stringify(saved));
  const restored = new XhsAccountService({ dir: f.dir, driver: f.driver, now: () => NOW }); await restored.init(); const state = restored.snapshot(), persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(state.connection.state, 'needs_attention'); assert.equal(state.metrics[0].value, 0); assert.equal(state.notes[0].id, 'note-1'); assert.equal(state.drafts[0].fingerprint, 'a'.repeat(64)); assert.ok(state.history.length >= 3);
  assert.equal(persisted.version, 1); assert.equal(persisted.accountCaches[A].notes[0].id, 'note-1'); assert.equal(persisted.drafts[0].content, 'PRIVATE_DRAFT_BODY_NEVER_RETURN_THIS_TEXT'); await restored.close();
});

test('official drafts use ephemeral opaque keys, keep successful details on failed reads, and invalidate navigation after restart', async t => {
  const key = randomUUID(); const f = await fixture(t, { listDrafts: async () => ({ ...connected(), officialDrafts: [{ key, officialDraftId: 'official-123', title: '官方草稿', imageUrl: 'https://ci.xhscdn.com/mock.webp', kind: 'image', canRead: true }], coverage: { message: '首屏官方草稿', hasMore: true, limit: 100 } }) }); await f.connect();
  let pending = await f.service.startOfficialDraftSync({ accountId: A }); assert.equal(pending.officialDraftSync.running, true); let state = await f.settle();
  assert.equal(state.officialDrafts[0].key, key); assert.equal(state.officialDrafts[0].officialDraftId, 'official-123'); assert.equal(state.officialDrafts[0].canRead, true);
  await f.service.startOfficialDraftDetail(key, { accountId: A, foreground: true }); state = await f.settle();
  assert.deepEqual(f.calls.find(call => call.name === 'readDraft').args[0], { accountId: A, key, foreground: true }); assert.equal(f.service.getOfficialDraftDetail(key).detail.content, 'PRIVATE_OFFICIAL_DRAFT_BODY'); assert.doesNotMatch(JSON.stringify(state), /PRIVATE_OFFICIAL_DRAFT_BODY/);
  f.handlers.readDraft = async () => ({ ...connected(), detail: { id: key, content: '仅部分正文', isComplete: false } }); await f.service.startOfficialDraftDetail(key); await f.settle();
  assert.equal(f.service.getOfficialDraftDetail(key).detail.content, 'PRIVATE_OFFICIAL_DRAFT_BODY'); assert.equal(f.service.getOfficialDraftDetail(key).contentStatus.state, 'error');
  f.handlers.listDrafts = async () => { throw new Error('SECRET_TOKEN'); }; await f.service.startOfficialDraftSync(); state = await f.settle();
  assert.equal(state.officialDrafts[0].key, key); assert.equal(state.officialDraftSync.lastSyncAt, new Date(NOW).toISOString()); assert.ok(state.officialDraftSync.error);
  const restored = new XhsAccountService({ dir: f.dir, driver: f.driver, now: () => NOW }); await restored.init(); assert.equal(restored.snapshot().officialDrafts[0].canRead, false); assert.equal(restored.getOfficialDraftDetail(key).detail.content, 'PRIVATE_OFFICIAL_DRAFT_BODY');
  await restored.checkLogin(); await restored.inFlight; await assert.rejects(restored.startOfficialDraftDetail(key), error => error.status === 409); await restored.close();
});

test('partial official reads expose actual retrieved content without claiming completeness or erasing it on error', async t => {
  const f = await fixture(t, { readNote: async () => ({ ...connected(), detail: { id: 'note-1', content: '部分正文', images: ['https://ci.xhscdn.com/a.webp'], isComplete: false, message: '剩余图片不可见' } }) }); await f.connect(); await f.service.startSync(); await f.settle(); await f.service.startNoteDetail('note-1'); await f.settle();
  let detail = f.service.getNoteDetail('note-1'); assert.equal(detail.detail.content, '部分正文'); assert.equal(detail.contentStatus.state, 'partial'); assert.equal(detail.contentStatus.isComplete, false);
  f.handlers.readNote = async () => ({ ...connected(), detail: { id: 'different-note', content: '不属于这篇笔记', isComplete: true } }); await f.service.startNoteDetail('note-1'); await f.settle(); detail = f.service.getNoteDetail('note-1');
  assert.equal(detail.detail.content, '部分正文'); assert.equal(detail.contentStatus.state, 'error');
});

test('submission preview returns only frozen values and validated project image URLs', async t => {
  const f = await fixture(t); await f.connect(); const projectId = randomUUID(), filename = `${randomUUID()}-${randomUUID()}.png`, escapedName = `${randomUUID()}-${randomUUID()}.png`;
  const images = path.join(f.dir, 'projects', projectId, 'images'); await mkdir(images, { recursive: true }); const valid = path.join(images, filename); await writeFile(valid, 'MOCK');
  const outside = path.join(f.dir, 'outside.png'); await writeFile(outside, 'MOCK'); await symlink(outside, path.join(images, escapedName));
  const created = await f.service.submitDraft(input({ projectId, images: [valid, outside, path.join(images, escapedName)] })); await f.settle(); const preview = await f.service.getSubmissionDetail(created.draft.id, { accountId: A });
  assert.equal(preview.content, 'PRIVATE_DRAFT_BODY_NEVER_RETURN_THIS_TEXT'); assert.deepEqual(preview.images, [`/media/${projectId}/${filename}`]); assert.deepEqual(preview.imageURLs, preview.images); assert.doesNotMatch(JSON.stringify(preview), /outside\.png|\/private|content-studio-xhs-account/);
  await assert.rejects(f.service.getSubmissionDetail(created.draft.id, { accountId: B }), error => error.status === 409); await assert.rejects(f.service.getSubmissionDetail(randomUUID(), { accountId: A }), error => error.status === 404);
  assert.doesNotMatch(JSON.stringify(f.service.snapshot()), /PRIVATE_DRAFT_BODY|outside\.png/);
});


test('cache identifiers cannot inherit JavaScript object properties', async t => {
  const f = await fixture(t, { openLogin: async () => connected('constructor'), sync: async () => ({ ...connected('constructor'), metrics: [], notes: [{ id: '__proto__', title: '有效记录' }], coverage: {} }), readNote: async ({ noteId }) => ({ ...connected('constructor'), detail: { id: noteId, content: '原型键仍是普通缓存键', isComplete: true } }) });
  await f.connect(); await f.service.startSync(); await f.settle(); await f.service.startNoteDetail('__proto__', { accountId: 'constructor' }); await f.settle();
  assert.equal(f.service.getNoteDetail('__proto__', { accountId: 'constructor' }).detail.content, '原型键仍是普通缓存键'); assert.equal(f.service.snapshot().analyticsHistory[0].accountId, 'constructor');
});


test('official blob image slots become scoped cached PNGs while snapshots expose only a safe cover and restart retains bytes', async t => {
  const key = randomUUID(), first = mediaPng(35, 70, 120), second = mediaPng(210, 80, 70);
  const f = await fixture(t, {
    listDrafts: async () => ({ ...connected(), officialDrafts: [{ key, officialDraftId: 'blob-draft', title: '官方图片草稿', canRead: true }] }),
    readDraft: async () => ({ ...connected(), detail: { id: key, title: '官方图片草稿', content: 'PRIVATE_OFFICIAL_BLOB_DRAFT_BODY', images: ['blob:https://creator.xiaohongshu.com/first', null], imageAssets: [mediaAsset(first), mediaAsset(second, 1)], isComplete: true } }),
  });
  await f.connect(); await f.service.startOfficialDraftSync({ accountId: A }); await f.settle();
  await f.service.startOfficialDraftDetail(key, { accountId: A }); const snapshot = await f.settle(), { detail, contentStatus } = f.service.getOfficialDraftDetail(key, { accountId: A });
  assert.equal(detail.content, 'PRIVATE_OFFICIAL_BLOB_DRAFT_BODY'); assert.equal(detail.images.length, 2); assert.equal(contentStatus.state, 'ready'); assert.equal(detail.isComplete, true);
  for (const url of detail.images) assert.match(url, new RegExp(`^/media/xhs/${A}/[a-f0-9]{64}\\.png$`));
  assert.notEqual(detail.images[0], detail.images[1]); assert.equal(snapshot.officialDrafts[0].imageUrl, detail.images[0]);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_OFFICIAL_BLOB_DRAFT_BODY|imageAssets|base64|blob:/); assert.ok(!JSON.stringify(snapshot).includes(f.dir));
  assert.ok(!Object.hasOwn(detail, 'imageAssets')); assert.ok(!JSON.stringify(detail).includes(first.toString('base64')));
  const primary = detail.images[0].split('/').at(-1), secondary = detail.images[1].split('/').at(-1);
  assert.deepEqual(await f.service.getCachedImage(A, primary), { bytes: first, mime: 'image/png' });
  assert.deepEqual(await f.service.getCachedImage(A, secondary), { bytes: second, mime: 'image/png' }, 'a detail-only image is authorized without being the list cover');
  await assert.rejects(f.service.getCachedImage(B, primary), error => error.status === 409);
  const persisted = JSON.parse(await readFile(path.join(f.dir, 'xhs-account.json'), 'utf8'));
  assert.deepEqual(persisted.accountCaches[A].officialDraftDetails[key].images, detail.images); assert.doesNotMatch(JSON.stringify(persisted), /imageAssets|base64|blob:/);
  await f.service.close(); const before = f.calls.length;
  const restarted = new XhsAccountService({ dir: f.dir, driver: f.driver, now: () => NOW + 10000 });
  try {
    await restarted.init(); assert.equal(f.calls.length, before, 'restart must not ask the browser to reload assets'); assert.equal(restarted.snapshot().connection.state, 'needs_attention');
    assert.deepEqual(restarted.getOfficialDraftDetail(key, { accountId: A }).detail.images, detail.images);
    assert.deepEqual(await restarted.getCachedImage(A, primary), { bytes: first, mime: 'image/png' }); assert.deepEqual(await restarted.getCachedImage(A, secondary), { bytes: second, mime: 'image/png' });
    await restarted.disconnect(); await restarted.inFlight; f.handlers.openLogin = async () => connected(B); await restarted.startLogin(); await restarted.inFlight;
    assert.equal(restarted.snapshot().account.id, B); await assert.rejects(restarted.getCachedImage(A, primary), error => error.status === 409); await assert.rejects(restarted.getCachedImage(B, primary), error => error.status === 404);
    await restarted.disconnect(); await restarted.inFlight; f.handlers.openLogin = async () => connected(); await restarted.startLogin(); await restarted.inFlight;
    assert.deepEqual(await restarted.getCachedImage(A, secondary), { bytes: second, mime: 'image/png' }, 'returning to the original account restores its own referenced assets');
  } finally { await restarted.close(); }
});

test('official list coverAssets are readable by reference and disk presence alone never authorizes a cached image', async t => {
  const key = randomUUID(), cover = mediaPng(65, 130, 91), unused = mediaPng(160, 120, 35), replacement = mediaPng(23, 70, 120);
  const f = await fixture(t, {
    listDrafts: async () => ({ ...connected(), officialDrafts: [{ key, officialDraftId: 'cover-only-draft', title: '封面已读取', imageUrl: 'blob:https://creator.xiaohongshu.com/cover', coverAsset: mediaAsset(cover), canRead: true }] }),
    readDraft: async () => ({ ...connected(), detail: { id: key, title: '官方新版本', content: 'PRIVATE_COVER_DRAFT_BODY', images: [null], imageAssets: [mediaAsset(replacement)], isComplete: true } }),
  });
  await f.connect(); await f.service.startOfficialDraftSync({ accountId: A }); let snapshot = await f.settle(); const coverUrl = snapshot.officialDrafts[0].imageUrl, coverName = coverUrl.split('/').at(-1);
  assert.match(coverUrl, new RegExp(`^/media/xhs/${A}/[a-f0-9]{64}\\.png$`)); assert.equal(f.service.getOfficialDraftDetail(key, { accountId: A }).detail, null);
  assert.deepEqual(await f.service.getCachedImage(A, coverName), { bytes: cover, mime: 'image/png' }, 'the official list cover is an independent authorized reference');
  assert.doesNotMatch(JSON.stringify(snapshot), /coverAsset|imageAssets|base64|blob:|PRIVATE_COVER_DRAFT_BODY/);
  const unreferenced = await new XhsMediaCache({ dir: f.dir }).materialize({ images: [null], imageAssets: [mediaAsset(unused)], isComplete: true }, { accountId: A });
  const unusedName = unreferenced.images[0].split('/').at(-1); assert.deepEqual(await new XhsMediaCache({ dir: f.dir }).read(A, unusedName), { bytes: unused, mime: 'image/png' });
  await assert.rejects(f.service.getCachedImage(A, unusedName), error => error.status === 404, 'an existing content hash is not permission to read unreferenced media');
  await f.service.startOfficialDraftDetail(key, { accountId: A }); snapshot = await f.settle();
  assert.notEqual(snapshot.officialDrafts[0].imageUrl, coverUrl); await assert.rejects(f.service.getCachedImage(A, coverName), error => error.status === 404, 'the old cover loses access after all references are replaced');
  assert.deepEqual(await f.service.getCachedImage(A, snapshot.officialDrafts[0].imageUrl.split('/').at(-1)), { bytes: replacement, mime: 'image/png' });
});
