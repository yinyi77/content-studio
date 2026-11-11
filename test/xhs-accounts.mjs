import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { XhsAccountsService } from '../lib/xhs-accounts.mjs';
import { XhsAccountService } from '../lib/xhs-account.mjs';

const A = '5f0000000000000000000001', B = '5f0000000000000000000002', C = '5f0000000000000000000003';
const key = randomUUID();
const identity = id => ({ state: 'connected', browserOpen: true, account: { id, nickname: id === A ? 'MOCK 作者A' : 'MOCK 作者B', followers: 10, following: 2, likes: 0, notesCount: 1 } });
const draftInput = accountId => ({ accountId, projectId: randomUUID(), title: 'MOCK 测试稿', content: 'PRIVATE_SENT_BODY', images: ['/private/tmp/PRIVATE_SOURCE.png'], fingerprint: 'a'.repeat(64) });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, { dir: existingDir, factory } = {}) {
  const dir = existingDir || await mkdtemp(path.join(tmpdir(), 'content-studio-xhs-accounts-')), drivers = new Map(), calls = [];
  const driverFactory = config => {
    const state = { id: config.legacy ? A : B, config, handlers: {} };
    const defaults = {
      openLogin: async () => identity(state.id), inspectAccount: async () => identity(state.id),
      sync: async () => ({ ...identity(state.id), notes: [{ id: `note-${state.id}`, title: `MOCK ${state.id}` }], metrics: [{ id: 'views', value: state.id === A ? 2 : 9 }], coverage: { limit: 50, hasMore: false } }),
      readNote: async ({ noteId }) => ({ ...identity(state.id), detail: { id: noteId, title: 'MOCK 官方正文', content: state.id === A ? 'PRIVATE_A_NOTE_BODY' : 'PRIVATE_B_NOTE_BODY', images: ['https://ci.xhscdn.com/mock.png'], isComplete: true } }),
      listDrafts: async () => ({ ...identity(state.id), officialDrafts: [{ key, title: 'MOCK 官方草稿', canRead: true }], coverage: { limit: 100, hasMore: false } }),
      readDraft: async () => ({ ...identity(state.id), detail: { title: 'MOCK 官方草稿', content: 'PRIVATE_OFFICIAL_DRAFT', images: ['https://ci.xhscdn.com/mock.png'], isComplete: true } }),
      saveDraft: async input => ({ state: 'verified', accountId: input.accountId, submitted: true, verifiedAt: new Date().toISOString() }),
      verifyDraft: async input => ({ state: 'verified', accountId: input.accountId, verifiedAt: new Date().toISOString() }),
      openDrafts: async () => identity(state.id), close: async () => {},
    };
    const driver = Object.fromEntries(Object.keys(defaults).map(name => [name, async (...args) => { calls.push({ profileId: config.profileId, name, args }); return (state.handlers[name] || defaults[name])(...args); }]));
    state.driver = driver; drivers.set(config.profileId, state); return factory ? factory(config, state, driver) : driver;
  };
  const fleet = new XhsAccountsService({ dir, driverFactory }); await fleet.init();
  t.after(async () => { await fleet.close(); if (!existingDir) await rm(dir, { recursive: true, force: true }); });
  const settle = async () => { await fleet.inFlight; return fleet.snapshot(); };
  const connect = async options => { await fleet.startLogin(options); await settle(); };
  return { dir, fleet, drivers, calls, settle, connect, driverFactory };
}

test('fresh initialization and account CRUD are inert, metadata-only, and use immutable MatrixMedia identity keys', async t => {
  const f = await fixture(t), original = f.fleet.snapshot().selectedProfileId;
  assert.equal(f.calls.length, 0); assert.equal(f.fleet.snapshot().accounts.length, 1); assert.equal(f.fleet.snapshot().accounts[0].legacy, true);
  const added = await f.fleet.addAccount({ accountName: '副号-作品', group: '开发者' }), second = added.selectedProfileId;
  assert.notEqual(second, original); assert.equal(f.calls.length, 0); assert.equal(added.accounts.length, 2); assert.equal(added.account, null);
  const before = JSON.parse(await readFile(f.fleet.file, 'utf8')).accounts.find(item => item.profileId === second);
  assert.match(before.partition, /^persist:[a-f0-9]{32}小红书$/);
  await f.fleet.updateAccount(second, { accountName: '完全换名', group: '另一个分组' });
  const after = JSON.parse(await readFile(f.fleet.file, 'utf8')).accounts.find(item => item.profileId === second);
  assert.equal(before.partition, after.partition); assert.equal(before.accountKey, after.accountKey);
  assert.equal(after.group, '另一个分组'); assert.equal(after.accountName, '完全换名');
  await f.fleet.selectAccount(original); assert.equal(f.calls.length, 0);
  const metadata = f.fleet.snapshot().accounts;
  assert.doesNotMatch(JSON.stringify(metadata), /partition|accountKey|Cookie|PRIVATE|\/private\/|state\.json/);
  assert.equal((await stat(f.fleet.file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(f.dir, 'xhs-accounts', second))).mode & 0o777, 0o700);
  await assert.rejects(f.fleet.selectAccount(randomUUID()), error => error.status === 404);
  await assert.rejects(f.fleet.updateAccount(second, { group: '不能部分写入', accountName: 9 }), error => error.status === 400);
  assert.equal(f.fleet.snapshot().accounts.find(item => item.profileId === second).group, '另一个分组');
  assert.throws(() => f.fleet.snapshotForProfile(randomUUID()), error => error.status === 404);
  assert.equal(f.fleet.getAccountSnapshot(C), null);
});

test('account overview exposes isolated cached counters and sanitized avatars without browser actions or private content', async t => {
  const f = await fixture(t), first = f.fleet.snapshot().selectedProfileId;
  const empty = { followers: null, following: null, likes: null, notesCount: null };
  assert.deepEqual(f.fleet.snapshot().accounts[0].summary, empty);
  assert.equal(f.fleet.snapshot().accounts[0].avatarUrl, '');
  f.drivers.get(first).handlers.openLogin = async () => ({ ...identity(A), account: { ...identity(A).account,
    followers: 0, following: 8, likes: 320, notesCount: 12,
    avatar: 'https://ci.xhscdn.com/avatar.png?token=PRIVATE_AVATAR_TOKEN&width=80', cookie: 'PRIVATE_COOKIE' } });
  await f.connect();
  const second = (await f.fleet.addAccount({ accountName: '备用号' })).selectedProfileId;
  let overview = f.fleet.snapshot().accounts;
  assert.deepEqual(overview.find(item => item.profileId === first).summary, { followers: 0, following: 8, likes: 320, notesCount: 12 });
  assert.deepEqual(overview.find(item => item.profileId === second).summary, empty);
  assert.equal(overview.find(item => item.profileId === first).avatarUrl, 'https://ci.xhscdn.com/avatar.png?width=80');
  f.drivers.get(second).handlers.openLogin = async () => ({ ...identity(B), account: { ...identity(B).account,
    followers: 27, following: null, likes: Number.NaN, notesCount: -3 } });
  await f.connect();
  const callCount = f.calls.length;
  overview = f.fleet.snapshot().accounts;
  assert.deepEqual(overview.find(item => item.profileId === second).summary, { followers: 27, following: null, likes: null, notesCount: null });
  assert.deepEqual(overview.find(item => item.profileId === first).summary, { followers: 0, following: 8, likes: 320, notesCount: 12 });
  assert.doesNotMatch(JSON.stringify(overview), /PRIVATE|partition|accountKey|Cookie|cookie|\/private\/|state\.json/);
  overview.find(item => item.profileId === first).summary.followers = 999;
  assert.equal(f.fleet.snapshot().accounts.find(item => item.profileId === first).summary.followers, 0, 'response counters must not mutate the cached account');
  await f.fleet.selectAccount(first);
  assert.deepEqual(f.fleet.snapshot().accounts.find(item => item.profileId === second).summary, { followers: 27, following: null, likes: null, notesCount: null });
  assert.equal(f.calls.length, callCount, 'reading summaries and switching presentation never start a browser action');
});

test('overview counters fail closed when a profile identity is absent, mismatched or duplicated', async t => {
  const f = await fixture(t); await f.connect(); const first = f.fleet.snapshot().selectedProfileId;
  const second = (await f.fleet.addAccount()).selectedProfileId; await f.connect();
  const service = f.fleet.services.get(second), original = service.snapshot.bind(service), empty = { followers: null, following: null, likes: null, notesCount: null };
  // A cached worker result must never place another account's values on this row.
  service.snapshot = () => ({ ...original(), account: { id: A, followers: 999, following: 999, likes: 999, notesCount: 999, avatar: 'https://ci.xhscdn.com/other.png' } });
  assert.deepEqual(f.fleet.metadata(f.fleet.record(second)).summary, empty);
  assert.equal(f.fleet.metadata(f.fleet.record(second)).avatarUrl, '');
  service.snapshot = () => ({ ...original(), account: { followers: 999, following: 999, likes: 999, notesCount: 999 } });
  assert.deepEqual(f.fleet.metadata(f.fleet.record(second)).summary, empty);
  service.snapshot = original;
  const record = f.fleet.record(second); record.accountId = A;
  assert.deepEqual(f.fleet.metadata(f.fleet.record(first)).summary, empty, 'ambiguous duplicate binding cannot contribute overview values');
  assert.deepEqual(f.fleet.metadata(record).summary, empty);
  record.accountId = B;
  assert.equal(f.fleet.metadata(f.fleet.record(first)).summary.followers, 10);
});

test('removing an account preserves an official editor until its contents are handled', async t => {
  let pending = true;
  const f = await fixture(t, { factory: (_config, _state, driver) => { driver.hasPendingEdits = async () => pending; return driver; } });
  await f.connect(); const profileId = f.fleet.snapshot().selectedProfileId;
  await assert.rejects(f.fleet.removeAccount(profileId), error => error.status === 409 && /编辑/.test(error.message));
  assert.equal(f.fleet.getAccountSnapshot(A).account.id, A); assert.equal(f.fleet.services.get(profileId).closed, false);
  assert.equal(f.calls.filter(call => call.name === 'close').length, 0);
  await f.fleet.checkLogin({ accountId: A }); await f.settle();
  pending = false; await f.fleet.removeAccount(profileId);
  assert.equal(f.fleet.getAccountSnapshot(A), null); assert.equal(f.calls.filter(call => call.name === 'close').length, 1);
});

test('existing single-account state and full browser directory stay at the original locations', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-xhs-fleet-legacy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const oldDriver = { openLogin: async () => identity(A), close: async () => {} };
  const old = new XhsAccountService({ dir, driver: oldDriver }); await old.init(); await old.startLogin(); await old.inFlight; await old.close();
  await mkdir(path.join(dir, 'xhs-browser'), { recursive: true }); const marker = path.join(dir, 'xhs-browser', 'PRIVATE_INDEXED_DB_MARKER'); await writeFile(marker, 'KEEP_EXISTING_DRAFT_STORAGE');
  const f = await fixture(t, { dir }); const state = f.fleet.snapshot();
  assert.equal(state.account.id, A); assert.equal(state.accounts.length, 1); assert.equal(state.accounts[0].accountId, A);
  assert.equal(state.connection.state, 'needs_attention'); assert.equal(f.calls.length, 0); assert.equal(f.drivers.get(state.selectedProfileId).config.legacy, true);
  assert.equal(await readFile(marker, 'utf8'), 'KEEP_EXISTING_DRAFT_STORAGE');
  assert.equal(f.fleet.services.get(state.selectedProfileId).file, path.join(dir, 'xhs-account.json'));
  await f.fleet.addAccount({ accountName: '另一个账号' }); const added = f.fleet.snapshot().selectedProfileId;
  assert.equal(f.fleet.services.get(added).dir, dir, 'shared project/media root must not move into a profile');
  assert.equal(f.fleet.services.get(added).file, path.join(dir, 'xhs-accounts', added, 'state.json'));
});

test('each account owns its data, details, draft handles and immutable task destination across UI switches', async t => {
  const f = await fixture(t), first = f.fleet.snapshot().selectedProfileId; await f.connect();
  await f.fleet.startSync(); await f.settle(); await f.fleet.startNoteDetail(`note-${A}`, { accountId: A }); await f.settle();
  const second = (await f.fleet.addAccount({ accountName: '账号B' })).selectedProfileId; await f.connect(); await f.fleet.startSync(); await f.settle();
  assert.equal(f.fleet.snapshot().account.id, B); assert.equal(f.fleet.snapshot().metrics[0].value, 9);
  const a = f.fleet.getAccountSnapshot(A); assert.equal(a.account.id, A); assert.equal(a.metrics[0].value, 2);
  assert.doesNotMatch(JSON.stringify(f.fleet.snapshot()), /PRIVATE_A_NOTE_BODY|PRIVATE_B_NOTE_BODY/);
  assert.equal(f.fleet.getNoteDetail(`note-${A}`, { accountId: A }).detail.content, 'PRIVATE_A_NOTE_BODY');
  assert.equal(f.fleet.getNoteDetail(`note-${A}`, { accountId: B }).detail, null);
  const gate = deferred(); f.drivers.get(first).handlers.saveDraft = async input => { await gate.promise; return { state: 'verified', accountId: input.accountId, submitted: true, verifiedAt: new Date().toISOString() }; };
  const result = await f.fleet.submitDraft(draftInput(A));
  assert.equal(result.snapshot.account.id, B); assert.equal(result.targetSnapshot.account.id, A); assert.equal(result.draft.accountId, A);
  await f.fleet.selectAccount(first); await f.fleet.selectAccount(second);
  assert.equal(f.fleet.snapshot().status.busy, false); assert.equal(f.fleet.getAccountSnapshot(A).status.busy, true);
  const call = f.calls.find(call => call.name === 'saveDraft'); assert.equal(call.profileId, first); assert.equal(call.args[0].accountId, A);
  gate.resolve(); await f.settle(); assert.equal(f.fleet.getAccountSnapshot(A).drafts[0].status, 'verified'); assert.equal(f.fleet.snapshot().drafts.length, 0);
  await f.fleet.startOfficialDraftSync({ accountId: A }); await f.settle(); await f.fleet.startOfficialDraftSync({ accountId: B }); await f.settle();
  await f.fleet.startOfficialDraftDetail(key, { accountId: A }); await f.settle();
  assert.equal(f.calls.filter(call => call.name === 'readDraft').at(-1).profileId, first);
  assert.equal(f.fleet.snapshot().selectedProfileId, second); assert.equal(f.fleet.snapshot().officialDrafts[0].contentStatus.isComplete, false);
  await assert.rejects(f.fleet.checkLogin({ accountId: C }), error => error.status === 409);
  await assert.rejects(f.fleet.checkLogin({ profileId: first, accountId: B }), error => error.status === 409);
});

test('duplicate real account binding is rejected before it can appear in a new profile or hijack delivery routing', async t => {
  const f = await fixture(t); await f.connect(); const first = f.fleet.snapshot().selectedProfileId;
  const second = (await f.fleet.addAccount({ accountName: '误扫同号' })).selectedProfileId; f.drivers.get(second).id = A; await f.connect();
  const state = f.fleet.snapshot(); assert.equal(state.account, null); assert.equal(state.connection.state, 'needs_attention'); assert.match(state.connection.message, /已经添加/);
  assert.equal(state.accounts.filter(item => item.accountId === A).length, 1); assert.equal(f.fleet.getAccountSnapshot(A).profileId, first);
  f.drivers.get(second).id = B; await f.fleet.checkLogin(); await f.settle(); assert.equal(f.fleet.snapshot().account.id, B);
  f.drivers.get(second).id = A; await f.fleet.checkLogin(); await f.settle();
  assert.equal(f.fleet.snapshot().account.id, B); assert.equal(f.fleet.snapshot().connection.state, 'needs_attention');
});

test('disconnect retains account binding and cache; removal closes only its worker and leaves files intact', async t => {
  const f = await fixture(t); await f.connect(); await f.fleet.startSync(); await f.settle(); const first = f.fleet.snapshot().selectedProfileId;
  const service = f.fleet.services.get(first), marker = path.join(f.dir, 'xhs-browser', 'DRAFT_MARKER'); await mkdir(path.dirname(marker), { recursive: true }); await writeFile(marker, 'KEEP');
  await f.fleet.disconnect({ accountId: A }); await f.settle();
  assert.equal(f.fleet.getAccountSnapshot(A).account.id, A); assert.equal(f.fleet.getAccountSnapshot(A).notes.length, 1); assert.equal(f.fleet.snapshot().connection.state, 'needs_attention');
  const second = (await f.fleet.addAccount({ accountName: '账号B' })).selectedProfileId; await f.connect();
  const before = f.calls.filter(x => x.name === 'close' && x.profileId === second).length;
  await f.fleet.removeAccount(first); assert.equal(f.fleet.getAccountSnapshot(A), null); assert.equal(f.fleet.snapshot().account.id, B);
  assert.equal(f.calls.filter(x => x.name === 'close' && x.profileId === second).length, before);
  assert.equal(await readFile(marker, 'utf8'), 'KEEP'); await access(service.file);
  await f.fleet.removeAccount(second); assert.equal(f.fleet.snapshot().accounts.length, 0); assert.equal(f.fleet.snapshot().account, null);
});

test('restart restores all profile bindings and cached data without reopening any browser or replaying tasks', async t => {
  const f = await fixture(t); await f.connect(); await f.fleet.startSync(); await f.settle(); const first = f.fleet.snapshot().selectedProfileId;
  await f.fleet.addAccount({ accountName: '账号B', group: '备用' }); await f.connect(); await f.fleet.startSync(); await f.settle(); await f.fleet.close();
  const before = f.calls.length, restored = new XhsAccountsService({ dir: f.dir, driverFactory: f.driverFactory }); await restored.init(); t.after(() => restored.close());
  assert.equal(f.calls.length, before); assert.equal(restored.snapshot().accounts.length, 2); assert.equal(restored.snapshot().account.id, B); assert.equal(restored.getAccountSnapshot(A).account.id, A);
  assert.equal(restored.getAccountSnapshot(A).notes[0].id, `note-${A}`); assert.equal(restored.snapshotForProfile(first).connection.state, 'needs_attention');
  await restored.selectAccount(first); assert.equal(f.calls.length, before); assert.equal(restored.snapshot().account.id, A);
});

test('per-profile busy locks stop destructive removal but allow other accounts and selection', async t => {
  const f = await fixture(t); await f.connect(); const first = f.fleet.snapshot().selectedProfileId;
  const gate = deferred(); f.drivers.get(first).handlers.sync = async () => { await gate.promise; return { ...identity(A), notes: [], metrics: [], coverage: {} }; };
  await f.fleet.startSync(); await assert.rejects(f.fleet.removeAccount(first), error => error.status === 409);
  const second = (await f.fleet.addAccount({ accountName: '账号B' })).selectedProfileId; await f.fleet.startLogin(); await f.fleet.services.get(second).inFlight;
  assert.equal(f.fleet.snapshot().account.id, B); assert.equal(f.fleet.snapshot().accounts.find(a => a.profileId === first).busy, true);
  await f.fleet.selectAccount(first); await f.fleet.selectAccount(second); gate.resolve(); await f.settle();
});

test('invalid index fails closed and CRUD failures never overwrite original bindings', async t => {
  const f = await fixture(t); await f.connect(); const first = f.fleet.snapshot().selectedProfileId, before = await readFile(f.fleet.file, 'utf8');
  const persist = f.fleet.persist.bind(f.fleet); f.fleet.persist = async () => { throw Error('MOCK storage'); };
  await assert.rejects(f.fleet.updateAccount(first, { group: 'new' })); assert.equal(f.fleet.record(first).group, '默认分组');
  await assert.rejects(f.fleet.addAccount({ accountName: '临时' })); assert.equal(f.fleet.snapshot().accounts.length, 1); assert.equal(f.fleet.snapshot().selectedProfileId, first);
  await assert.rejects(f.fleet.removeAccount(first)); assert.equal(f.fleet.getAccountSnapshot(A).account.id, A); assert.equal(f.fleet.services.get(first).closed, false);
  assert.equal(await readFile(f.fleet.file, 'utf8'), before); f.fleet.persist = persist;
  await writeFile(f.fleet.file, '{bad-json');
  const restored = new XhsAccountsService({ dir: f.dir, driverFactory: f.driverFactory }); await restored.init();
  assert.match(restored.snapshot().status.error, /账号列表读取失败/); assert.equal(restored.snapshot().accounts.length, 0);
  await assert.rejects(restored.addAccount(), error => error.status === 503); assert.equal(await readFile(f.fleet.file, 'utf8'), '{bad-json'); await restored.close();
});

test('draft retry and recheck resolve the original record owner instead of the current selection', async t => {
  const f = await fixture(t); await f.connect(); const first = f.fleet.snapshot().selectedProfileId;
  f.drivers.get(first).handlers.saveDraft = async input => ({ state: 'failed', accountId: input.accountId, submitted: false, message: 'MOCK 暂存前失败' });
  const failed = await f.fleet.submitDraft(draftInput(A)); await f.settle();
  const second = (await f.fleet.addAccount({ accountName: '账号B' })).selectedProfileId; await f.connect();
  f.drivers.get(first).handlers.saveDraft = async () => ({ state: 'filled', submitted: false });
  await f.fleet.retryDraft(failed.draft.id, { accountId: A }); await f.settle();
  assert.equal(f.calls.filter(x => x.name === 'saveDraft').at(-1).profileId, first);
  await f.fleet.recheckDraft(failed.draft.id, { accountId: A }); await f.settle();
  assert.equal(f.calls.filter(x => x.name === 'verifyDraft').at(-1).profileId, first);
  assert.equal(f.fleet.getAccountSnapshot(A).drafts[0].status, 'verified'); assert.equal(f.fleet.snapshot().selectedProfileId, second);
  await assert.rejects(f.fleet.recheckDraft(failed.draft.id, { accountId: B }), error => error.status === 409);
  await assert.rejects(f.fleet.retryDraft(failed.draft.id, { profileId: second }), error => error.status === 409);
});

test('closing does not wait for an unresponsive driver or let a late identity overwrite the saved registry', async t => {
  const f = await fixture(t), gate = deferred(), started = deferred(), profileId = f.fleet.snapshot().selectedProfileId;
  f.drivers.get(profileId).handlers.openLogin = async () => { started.resolve(); return gate.promise; };
  await f.fleet.startLogin(); await started.promise;
  await f.fleet.close(); const before = await readFile(f.fleet.file, 'utf8');
  gate.resolve(identity(A)); await f.fleet.inFlight;
  assert.equal(await readFile(f.fleet.file, 'utf8'), before); assert.equal(f.fleet.snapshot().account, null);
});
