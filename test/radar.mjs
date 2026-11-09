import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RadarService, nextRadarRun, validateRadarSettings } from '../lib/radar.mjs';

// All facts, boards and model responses are synthetic; these tests never
// contact social platforms, model providers or notification providers.
const NOW = Date.parse('2026-11-06T01:00:00Z');
const HOUR = 3600000, DAY = 24 * HOUR;
const iso = value => new Date(value).toISOString();
const profile = () => ({ name: 'MOCK 模型中转站', industry: '开发者工具与模型 API', audience: '独立开发者和 AI coding 用户', description: '提供模型 API 使用入口。', sellingPoints: ['已提供的使用入口'], goal: '用实际 coding 作品展示场景，销售 Token', materials: [
  { id: 'clock', title: 'MOCK 状态栏计时工具', content: '用户提供的案例：状态栏中显示工作计时与小猫动画。', source: '用户提供案例' },
  { id: 'reader', title: 'MOCK 文档阅读工具', content: '用户提供的案例：阅读本地 Markdown 文件。', source: '用户提供案例' },
] });
function board(now = NOW, count = 3) {
  return { items: Array.from({ length: count }, (_, index) => ({ id: `mock-hot-${index}`, platform: 'weibo', title: `MOCK AI coding 工作计时话题 ${index}`, rank: index + 1, url: `https://example.org/hot/${index}`, heat: '100', fetchedAt: iso(now - 5 * 60000), sourceUpdatedAt: iso(now - 10 * 60000), firstSeenAt: iso(now - 20 * 60000), provider: 'MOCK source' })),
    platforms: [{ id: 'weibo', status: 'ready', freshness: 'fresh', lastSuccessAt: iso(now - 5 * 60000), sourceUpdatedAt: iso(now - 10 * 60000) }], memes: [] };
}
function proposal(id = 'mock-hot-0', extra = {}) {
  return { trendId: id, title: 'MOCK 给 AI coding 工作流留一点可见进度', angle: '借工作节奏话题，展示用户提供的状态栏计时案例，并引导了解模型 API。', reason: '关联独立开发者实际工具制作需求，仅引用已有案例。', materialIds: ['clock'], outline: ['真实场景', '已有案例', '了解入口'], style: 'photo', aspect: '3:4', count: 3, mode: 'cards', confidence: 'medium', factNotes: '只掌握标题，未读取原帖。', ...extra };
}
const answer = list => JSON.stringify({ opportunities: list });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-radar-'));
  let now = NOW, currentBoard = board(), calls = 0;
  const clock = () => now;
  const service = new RadarService({ dir, now: clock, getTrends: () => currentBoard,
    complete: async messages => { calls++; return options.complete ? options.complete(messages) : answer([proposal()]); },
    ...options });
  await service.init();
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  return { service, dir, calls: () => calls, clock, setNow: value => { now = value; }, setBoard: value => { currentBoard = value; } };
}

test('blank product and default-disabled schedule never make a model request', async t => {
  const f = await fixture(t);
  assert.equal(f.service.snapshot().profileReady, false);
  assert.equal(f.service.snapshot().settings.enabled, false);
  assert.equal(f.service.snapshot().nextRunAt, null);
  await assert.rejects(f.service.scan(), error => error.status === 400);
  assert.match(f.service.snapshot().status.error, /请先填写/);
  assert.equal(f.calls(), 0);
});

test('profile normalization versions real changes and preserves material provenance', async t => {
  const f = await fixture(t);
  const first = await f.service.updateProfile({ ...profile(), sellingPoints: ' 已确认入口 \n已确认入口\n用于示例' });
  assert.equal(first.profileReady, true);
  assert.equal(first.profile.version, 1);
  assert.deepEqual(first.profile.materials[0].referenceIds, []);
  assert.deepEqual(first.profile.sellingPoints, ['已确认入口', '用于示例']);
  f.setNow(NOW + 60000);
  const same = await f.service.updateProfile({ ...profile(), sellingPoints: ['已确认入口', '用于示例'] });
  assert.equal(same.profile.version, 1);
  assert.equal(same.profile.materials[0].updatedAt, first.profile.materials[0].updatedAt);
  const changed = await f.service.updateProfile({ goal: '让开发者了解已提供的入口' });
  assert.equal(changed.profile.version, 2);
  assert.equal(changed.profile.updatedAt, iso(NOW + 60000));
  for (const input of [{ name: 'a'.repeat(121) }, { materials: [{ title: 'x', content: 'a'.repeat(20001) }] }, { referenceIds: ['bad-id'] }]) {
    await assert.rejects(f.service.updateProfile(input), error => error.status === 400);
  }
  assert.equal(f.service.snapshot().profile.version, 2);
});

test('settings and daily time validation bound cost and choose a strictly future Beijing run', () => {
  assert.equal(nextRadarRun(NOW, '09:00'), NOW + DAY);
  assert.equal(nextRadarRun(NOW - 60000, '09:00'), NOW);
  assert.equal(nextRadarRun(Date.parse('2026-11-06T16:00:00Z'), '00:01'), Date.parse('2026-11-06T16:01:00Z'));
  assert.equal(validateRadarSettings({ mode: 'cover', count: 8 }).count, 1);
  for (const input of [{ dailyTime: '9:00' }, { dailyTime: '24:00' }, { enabled: 'true' }, { maxPerDay: 4 }, { style: 'invented' }, { count: 0 }]) assert.throws(() => validateRadarSettings(input), error => error.status === 400);
});

test('fresh scan preserves canonical evidence, exact selected case, decision request and bounded immutable brief', async t => {
  let received;
  const f = await fixture(t, { complete: async messages => { received = messages; return answer([proposal('mock-hot-0', { trend: { title: 'FORGED title' } })]); } });
  await f.service.updateProfile(profile());
  const result = await f.service.scan();
  assert.equal(result.status.running, false);
  assert.equal(result.status.lastRun.state, 'completed');
  assert.equal(result.status.lastRun.added, 1);
  const op = result.opportunities[0];
  assert.equal(op.trend.title, board().items[0].title);
  assert.equal(op.trend.url, board().items[0].url);
  assert.equal(op.expiresAt, iso(NOW + 55 * 60000));
  assert.deepEqual(op.materialTitles, ['MOCK 状态栏计时工具']);
  assert.equal(op.audience, profile().audience);
  assert.ok(op.requestId && op.requestId !== op.id);
  assert.equal(op.source.length <= 24000, true);
  assert.match(op.source, /模型 API|模型中转站/);
  assert.match(op.source, /状态栏中显示工作计时/);
  assert.doesNotMatch(op.source, /阅读本地 Markdown/);
  assert.doesNotMatch(JSON.stringify(op), /FORGED/);
  assert.equal(op.notification.status, 'pending');
  const sentData = JSON.parse(received[1].content);
  assert.equal(sentData.product.materials.length, 2);
  assert.match(received[0].content, /不能保证爆款/);
  assert.match(received[0].content, /Token/);
  op.productSnapshot.name = 'MUTATED'; op.trend.title = 'MUTATED';
  assert.equal(f.service.getOpportunity(op.id).productSnapshot.name, profile().name);
  await f.service.updateProfile({ description: '更新后的用户事实' });
  assert.equal(f.service.getOpportunity(op.id).productSnapshot.description, profile().description);
  assert.equal(f.service.snapshot().opportunities[0].state, 'expired');
  await assert.rejects(f.service.validateOpportunity(op.id), error => error.status === 409);
});

test('stale ordinary boards never trigger a paid model request', async t => {
  const f = await fixture(t);
  await f.service.updateProfile(profile());
  const stale = board(NOW - 3 * HOUR); f.setBoard(stale);
  const result = await f.service.scan();
  assert.equal(f.calls(), 0);
  assert.equal(result.opportunities.length, 0);
  assert.match(result.status.lastRun.message, /未调用模型/);
});

test('a scan actively refreshes once, approval only rechecks, and failed stale refresh never pays for a model', async t => {
  let refreshes = 0, current = { items: [], platforms: [] };
  const f = await fixture(t, { getTrends: () => current, refreshTrends: async () => {
    refreshes++;
    current = refreshes === 1 ? board() : board(NOW - 3 * HOUR);
    if (refreshes > 1) current.platforms[0].status = 'error';
  } });
  await f.service.updateProfile(profile());
  assert.equal(refreshes, 0);
  const op = (await f.service.scan()).opportunities[0];
  assert.equal(refreshes, 1);
  assert.equal(f.calls(), 1);
  await f.service.validateOpportunity(op.id);
  await f.service.markApproved(op.id, randomUUID());
  assert.equal(refreshes, 1);
  f.setNow(NOW + 61000);
  const result = await f.service.scan();
  assert.equal(refreshes, 2);
  assert.equal(f.calls(), 1);
  assert.equal(result.status.lastRun.state, 'completed');
  assert.match(result.status.lastRun.message, /未调用模型/);
});

test('model can choose no opportunity without inventing a recommendation', async t => {
  const f = await fixture(t, { complete: async () => answer([]) });
  await f.service.updateProfile(profile());
  const result = await f.service.scan();
  assert.equal(result.status.lastRun.state, 'completed');
  assert.equal(result.status.lastRun.added, 0);
  assert.equal(result.opportunities.length, 0);
});

test('malformed, invented-source and invalid-spec proposals are rejected atomically', async t => {
  for (const response of [answer([proposal('unknown')]), answer([proposal(), proposal('mock-hot-1', { style: 'imaginary' })]), answer([proposal('mock-hot-0', { materialIds: ['unknown-material'] })]), answer([proposal('mock-hot-0', { outline: ['one'] })]), 'not JSON']) {
    const f = await fixture(t, { complete: async () => response });
    await f.service.updateProfile(profile());
    await assert.rejects(f.service.scan(), error => error.status === 502);
    assert.equal(f.service.snapshot().opportunities.length, 0);
    assert.equal(f.service.snapshot().status.lastRun.state, 'error');
    const saved = JSON.parse(await readFile(path.join(f.dir, 'radar.json'), 'utf8'));
    assert.equal(saved.opportunities.length, 0);
  }
});

test('simultaneous scans share a single model request and profile edits invalidate a late response', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { complete: async () => { entered(); await gate; return answer([proposal()]); } });
  await f.service.updateProfile(profile());
  const a = f.service.scan();
  assert.equal(a, f.service.scan());
  await started;
  assert.equal(f.service.snapshot().status.running, true);
  const runningRecord = JSON.parse(await readFile(path.join(f.dir, 'radar.json'), 'utf8')).runHistory.at(-1);
  assert.equal(runningRecord.state, 'running');
  assert.equal(runningRecord.manual, true);
  await f.service.updateProfile({ goal: '新的用户目标' });
  release();
  await assert.rejects(a, error => error.status === 409);
  assert.equal(f.service.snapshot().opportunities.length, 0);
});

test('manual cooldown and per-day proposal cap prevent repeated paid scans, including skipped proposals', async t => {
  let calls = 0;
  const f = await fixture(t, { complete: async () => { calls++; return answer([proposal('mock-hot-0'), proposal('mock-hot-1'), proposal('mock-hot-2')]); } });
  await f.service.updateProfile(profile());
  const result = await f.service.scan();
  assert.equal(calls, 1);
  await assert.rejects(f.service.scan(), error => error.status === 429 && error.retryAfterMs === 60000);
  assert.match(f.service.snapshot().status.error, /一分钟/);
  await f.service.skipOpportunity(result.opportunities[0].id);
  f.setNow(NOW + 61000); f.setBoard(board(NOW + 61000, 5));
  const next = await f.service.scan();
  assert.equal(calls, 1);
  assert.equal(next.opportunities.length, 3);
  assert.match(next.status.lastRun.message, /上限/);
});

test('same topic on another platform is not re-notified within a day', async t => {
  let calls = 0;
  const f = await fixture(t, { complete: async () => { calls++; return answer([proposal()]); } });
  await f.service.updateProfile(profile()); await f.service.scan();
  f.setNow(NOW + 61000);
  const same = board(NOW + 61000, 1);
  same.items[0].id = 'other-platform-id'; same.items[0].platform = 'douyin';
  same.platforms[0].id = 'douyin'; f.setBoard(same);
  const result = await f.service.scan();
  assert.equal(calls, 1);
  assert.equal(result.opportunities.length, 1);
});

test('approval rechecks expiry and fresh canonical source, and binds the generated project idempotently', async t => {
  const f = await fixture(t);
  await f.service.updateProfile(profile());
  const op = (await f.service.scan()).opportunities[0];
  const checked = await f.service.validateOpportunity(op.id);
  assert.equal(checked.id, op.id);
  const stale = board(); stale.platforms[0].freshness = 'delayed'; f.setBoard(stale);
  await assert.rejects(f.service.validateOpportunity(op.id), error => error.status === 409);
  f.setBoard(board());
  const projectId = randomUUID();
  assert.equal((await f.service.markApproved(op.id, projectId)).state, 'approved');
  assert.equal((await f.service.markApproved(op.id, projectId)).projectId, projectId);
  await assert.rejects(f.service.markApproved(op.id, randomUUID()), error => error.status === 409);
  await assert.rejects(f.service.skipOpportunity(op.id), error => error.status === 409);
  f.setNow(NOW + DAY);
  assert.equal((await f.service.validateOpportunity(op.id)).projectId, projectId);
});

test('expired proposals cannot approve a new generation but can recover an already authorized project binding', async t => {
  const f = await fixture(t);
  await f.service.updateProfile(profile());
  const op = (await f.service.scan()).opportunities[0];
  f.setNow(NOW + HOUR);
  await assert.rejects(f.service.validateOpportunity(op.id), error => error.status === 409);
  const projectId = randomUUID();
  assert.equal((await f.service.markApproved(op.id, projectId, { recovery: true })).projectId, projectId);
});

test('archived memes keep the fixed fourteen-day source lifetime and at most a day to decide', async t => {
  const f = await fixture(t, { complete: async () => answer([proposal('meme-last-hour')]) });
  await f.service.updateProfile(profile());
  const input = board(NOW - DAY, 0);
  input.memes = [{ ...board().items[0], id: 'meme-last-hour', title: 'MOCK AI coding 闪身步热梗', kind: 'meme', category: 'meme', firstSeenAt: iso(NOW - 14 * DAY + HOUR), expiresAt: iso(NOW + HOUR), fetchedAt: iso(NOW - DAY), lastSeenAt: iso(NOW - DAY), sourceUpdatedAt: iso(NOW - DAY), inCurrentBoard: false }];
  f.setBoard(input);
  const op = (await f.service.scan()).opportunities[0];
  assert.equal(op.trend.kind, 'meme');
  assert.equal(op.expiresAt, iso(NOW + HOUR));
  assert.match(op.source, /不表示持续火爆/);
  f.setNow(NOW + HOUR);
  await assert.rejects(f.service.validateOpportunity(op.id), error => error.status === 409);
});

test('notification sees durable proposals and delivery state remains explicit rather than inferred', async t => {
  let service, file, persistedAtNotification = false;
  const f = await fixture(t, { onNotify: async opportunities => {
    persistedAtNotification = JSON.parse(await readFile(file, 'utf8')).opportunities.some(item => item.id === opportunities[0].id);
    assert.equal(service.getOpportunity(opportunities[0].id).notification.status, 'pending');
    // A provider can skip or have uncertain delivery; only the server records
    // the actual result through setNotification.
    return { status: 'skipped' };
  } });
  service = f.service; file = path.join(f.dir, 'radar.json');
  await service.updateProfile(profile());
  const op = (await service.scan()).opportunities[0];
  assert.equal(persistedAtNotification, true);
  assert.equal(op.notification.status, 'pending');
  await service.setNotification(op.id, { status: 'unknown', error: 'MOCK transport timeout' });
  assert.equal(service.getOpportunity(op.id).notification.status, 'unknown');
  assert.equal(service.getOpportunity(op.id).notification.sentAt, undefined);
  await service.setNotification(op.id, { status: 'accepted' });
  assert.equal(service.getOpportunity(op.id).notification.status, 'accepted');
  assert.equal(service.getOpportunity(op.id).notification.sentAt, undefined);
});

test('notification failure retains proposal and is never automatically resent on restart', async t => {
  let attempts = 0;
  const f = await fixture(t, { onNotify: async () => { attempts++; throw Error('MOCK delivery unavailable'); } });
  await f.service.updateProfile(profile());
  const op = (await f.service.scan()).opportunities[0];
  assert.equal(op.state, 'pending');
  assert.match(f.service.snapshot().status.notificationError, /MOCK delivery/);
  f.service.close();
  const restored = new RadarService({ dir: f.dir, now: f.clock, getTrends: () => board(), complete: async () => { throw Error('must not call'); }, onNotify: async () => { attempts++; } });
  t.after(() => restored.close());
  await restored.init();
  assert.equal(restored.getOpportunity(op.id).requestId, op.requestId);
  assert.equal(restored.snapshot().profile.version, 1);
  assert.equal(attempts, 1);
});

test('enabled scheduling uses future local time, persists daily attempt and never catches up on restart', async t => {
  const timers = [];
  const f = await fixture(t, { setTimeoutImpl: (callback, delay) => { const timer = { callback, delay, canceled: false }; timers.push(timer); return timer; }, clearTimeoutImpl: timer => { timer.canceled = true; } });
  await f.service.updateProfile(profile());
  await f.service.updateSettings({ enabled: true, dailyTime: '09:01' });
  assert.equal(f.service.snapshot().nextRunAt, iso(NOW + 60000));
  assert.equal(timers.at(-1).delay, 60000);
  f.setNow(NOW + 60000); f.setBoard(board(NOW + 60000));
  await f.service.scan({ manual: false });
  assert.equal(f.calls(), 1);
  assert.equal(f.service.snapshot().status.lastScheduledDay, '2026-11-06');
  await f.service.scan({ manual: false });
  assert.equal(f.calls(), 1);
  f.service.close();
  const savedPath = path.join(f.dir, 'radar.json');
  const saved = JSON.parse(await readFile(savedPath, 'utf8'));
  saved.status.lastRun.state = 'running'; await writeFile(savedPath, JSON.stringify(saved));
  let calls = 0;
  const restarted = new RadarService({ dir: f.dir, now: () => NOW + 2 * HOUR, getTrends: () => board(), complete: async () => { calls++; return answer([]); }, setTimeoutImpl: (_, delay) => ({ delay }), clearTimeoutImpl: () => {} });
  t.after(() => restarted.close());
  const restored = await restarted.init();
  assert.equal(calls, 0);
  assert.equal(restored.status.lastRun.state, 'interrupted');
  assert.equal(restored.runHistory[0].state, 'interrupted');
  assert.equal(JSON.parse(await readFile(savedPath, 'utf8')).runHistory.at(-1).state, 'interrupted');
  assert.equal(restored.nextRunAt, '2026-11-07T01:01:00.000Z');
});

test('retrieval bounds large case collections before sending them to the text model', async t => {
  let data;
  const f = await fixture(t, { complete: async messages => { data = JSON.parse(messages[1].content); return answer([]); } });
  const materials = Array.from({ length: 10 }, (_, index) => ({ id: `doc-${index}`, title: `MOCK 案例 ${index}`, content: `${index === 9 ? 'AI coding 工作计时' : '其他行业'}\n${'资料原文'.repeat(2400)}` }));
  await f.service.updateProfile({ ...profile(), materials });
  await f.service.scan();
  assert.ok(data.product.materials.length <= 12);
  assert.ok(data.product.materials.reduce((sum, item) => sum + item.content.length, 0) <= 12000);
  assert.equal(data.product.materials[0].id, 'doc-9');
});

test('only selected case screenshots are attached, with stable case-first deduplication and a four-image cap', async t => {
  const [clockImage, sharedImage, unusedCaseImage, brandImage1, brandImage2, brandImage3] = Array.from({ length: 6 }, () => randomUUID());
  const input = profile();
  input.referenceIds = [sharedImage, brandImage1, brandImage2, brandImage3];
  input.materials[0].referenceIds = [clockImage, sharedImage];
  input.materials[1].referenceIds = [unusedCaseImage];
  const f = await fixture(t);
  await f.service.updateProfile(input);
  const op = (await f.service.scan()).opportunities[0];
  assert.deepEqual(op.referenceIds, [clockImage, sharedImage, brandImage1, brandImage2]);
  assert.deepEqual(op.productSnapshot.referenceIds, op.referenceIds);
  assert.deepEqual(op.productSnapshot.globalReferenceIds, input.referenceIds);
  assert.deepEqual(op.productSnapshot.materials[0].referenceIds, input.materials[0].referenceIds);
  assert.equal(op.referenceIds.includes(unusedCaseImage), false);
  assert.equal(op.source.includes(unusedCaseImage), false);
  assert.doesNotMatch(op.source, /MOCK 文档阅读工具|阅读本地 Markdown/);
  const bad = structuredClone(input.materials);
  bad[0].referenceIds = Array.from({ length: 5 }, () => randomUUID());
  await assert.rejects(f.service.updateProfile({ materials: bad }), error => error.status === 400);
});

test('several selected cases still cannot exceed four attached images or displace them with global brand images', async t => {
  const input = profile();
  input.referenceIds = [randomUUID()];
  input.materials[0].referenceIds = [randomUUID(), randomUUID(), randomUUID()];
  input.materials[1].referenceIds = [randomUUID(), randomUUID()];
  const f = await fixture(t, { complete: async () => answer([proposal('mock-hot-0', { materialIds: ['reader', 'clock'] })]) });
  await f.service.updateProfile(input);
  const op = (await f.service.scan()).opportunities[0];
  assert.deepEqual(op.referenceIds, [...input.materials[1].referenceIds, ...input.materials[0].referenceIds].slice(0, 4));
  assert.equal(op.referenceIds.includes(input.referenceIds[0]), false);
  assert.equal(op.referenceIds.length, 4);
});

test('editing case screenshots versions the product and expires old proposals while retaining their image snapshot', async t => {
  const originalImage = randomUUID(), replacementImage = randomUUID();
  const input = profile(); input.materials[0].referenceIds = [originalImage];
  const f = await fixture(t);
  const first = await f.service.updateProfile(input);
  const op = (await f.service.scan()).opportunities[0];
  f.setNow(NOW + 61000);
  input.materials[0].referenceIds = [replacementImage];
  const changed = await f.service.updateProfile({ materials: input.materials });
  assert.equal(changed.profile.version, first.profile.version + 1);
  assert.notEqual(changed.profile.materials[0].hash, first.profile.materials[0].hash);
  assert.equal(changed.opportunities[0].state, 'expired');
  await assert.rejects(f.service.validateOpportunity(op.id), error => error.status === 409);
  assert.deepEqual(f.service.getOpportunity(op.id).referenceIds, [originalImage]);
  assert.deepEqual(f.service.getOpportunity(op.id).productSnapshot.materials[0].referenceIds, [originalImage]);
  f.service.close();
  const restored = new RadarService({ dir: f.dir, now: f.clock, getTrends: () => board(), complete: async () => answer([]) });
  t.after(() => restored.close());
  const saved = await restored.init();
  assert.deepEqual(saved.profile.materials[0].referenceIds, [replacementImage]);
  assert.equal(saved.profile.version, changed.profile.version);
  assert.deepEqual(restored.getOpportunity(op.id).referenceIds, [originalImage]);
});

test('explicit skip feedback is validated, summarized and used with approval preferences in the next prompt', async t => {
  let calls = 0, nextMessages;
  const f = await fixture(t, { complete: async messages => {
    calls++;
    if (calls === 1) return answer([proposal('mock-hot-0'), proposal('mock-hot-1')]);
    nextMessages = messages; return answer([]);
  } });
  await f.service.updateProfile(profile());
  const ops = (await f.service.scan()).opportunities;
  const skippedId = ops[0].id, approvedId = ops[1].id;
  for (const input of [{ reason: 'invented' }, { reason: 1 }, { note: 'a'.repeat(301) }, null]) await assert.rejects(f.service.skipOpportunity(skippedId, input), error => error.status === 400);
  assert.equal(f.service.getOpportunity(skippedId).state, 'pending');
  const skipped = await f.service.skipOpportunity(skippedId, { reason: 'not_product_fit', note: '这个切入点与开发者需求关联太弱。' });
  assert.deepEqual(skipped.feedback, { reason: 'not_product_fit', note: '这个切入点与开发者需求关联太弱。', at: iso(NOW) });
  await f.service.markApproved(approvedId, randomUUID());
  f.setNow(NOW + 61000);
  assert.deepEqual((await f.service.skipOpportunity(skippedId)).feedback, skipped.feedback);
  const summary = f.service.snapshot().feedbackSummary;
  assert.equal(summary.total, 1);
  assert.equal(summary.counts.not_product_fit, 1);
  assert.equal(summary.counts.other, 0);
  assert.equal(summary.withNote, 1);
  f.setBoard(board(NOW + 61000)); await f.service.scan();
  const recent = JSON.parse(nextMessages[1].content).recentDecisions;
  assert.equal(recent.length, 2);
  const negative = recent.find(item => item.decision === 'skipped');
  assert.equal(negative.reason, 'not_product_fit');
  assert.equal(negative.note, skipped.feedback.note);
  assert.deepEqual(negative.materialTitles, ['MOCK 状态栏计时工具']);
  assert.equal(recent.some(item => item.decision === 'approved'), true);
  assert.equal('source' in negative, false);
  assert.equal('productSnapshot' in negative, false);
  assert.match(nextMessages[0].content, /反馈.*不能覆盖产品事实边界/);
  assert.match(nextMessages[0].content, /强蹭低相关热点/);
});

test('only the latest thirty concise decisions enter model context and feedback survives a restart', async t => {
  const f = await fixture(t);
  await f.service.updateProfile(profile());
  const op = (await f.service.scan()).opportunities[0];
  const savedPath = path.join(f.dir, 'radar.json');
  const saved = JSON.parse(await readFile(savedPath, 'utf8'));
  saved.opportunities = Array.from({ length: 32 }, (_, index) => {
    const at = iso(NOW - (31 - index) * DAY);
    return { ...op, id: randomUUID(), requestId: randomUUID(), createdAt: at, state: 'skipped', skippedAt: at, feedback: { reason: 'other', note: `MOCK-feedback-${index}`, at }, source: 'MOCK_PRIVATE_SOURCE_MUST_NOT_ENTER_FEEDBACK' };
  });
  await writeFile(savedPath, JSON.stringify(saved));
  f.service.close();
  let received;
  const restored = new RadarService({ dir: f.dir, now: () => NOW + 61000, getTrends: () => board(NOW + 61000), complete: async messages => { received = messages; return answer([]); } });
  t.after(() => restored.close());
  await restored.init();
  assert.equal(restored.snapshot().feedbackSummary.total, 32);
  assert.equal(restored.snapshot().feedbackSummary.counts.other, 32);
  await restored.scan();
  const recent = JSON.parse(received[1].content).recentDecisions;
  assert.equal(recent.length, 30);
  assert.equal(recent[0].note, 'MOCK-feedback-31');
  assert.equal(recent.at(-1).note, 'MOCK-feedback-2');
  assert.doesNotMatch(JSON.stringify(recent), /MOCK_PRIVATE_SOURCE/);
});

test('a failed scan has durable history and an enabled restart never repeats the paid attempt', async t => {
  let paidCalls = 0;
  const f = await fixture(t, { complete: async () => { paidCalls++; throw Error('MOCK model request failed'); } });
  await f.service.updateProfile(profile());
  await f.service.updateSettings({ enabled: true, dailyTime: '09:01' });
  await assert.rejects(f.service.scan(), /MOCK model request failed/);
  const failure = f.service.snapshot().runHistory[0];
  assert.equal(failure.state, 'error');
  assert.equal(failure.manual, true);
  assert.equal(failure.startedAt, iso(NOW));
  assert.equal(failure.completedAt, iso(NOW));
  assert.equal(failure.added, 0);
  assert.match(failure.message, /MOCK model request failed/);
  const saved = JSON.parse(await readFile(path.join(f.dir, 'radar.json'), 'utf8'));
  assert.equal(saved.runHistory[0].id, saved.status.lastRun.id);
  assert.equal(saved.runHistory[0].state, 'error');
  f.service.close();
  let refreshes = 0;
  const restored = new RadarService({ dir: f.dir, now: () => NOW + 120000, getTrends: () => board(), refreshTrends: async () => { refreshes++; }, complete: async () => { paidCalls++; return answer([]); } });
  t.after(() => restored.close());
  const result = await restored.init();
  assert.equal(paidCalls, 1);
  assert.equal(refreshes, 0);
  assert.equal(result.runHistory.length, 1);
  assert.equal(result.runHistory[0].id, failure.id);
  assert.equal(result.runHistory[0].state, 'error');
  assert.equal(result.nextRunAt, '2026-11-07T01:01:00.000Z');
});

test('legacy lastRun migrates to history, interrupted state persists and history retains only sixty runs', async t => {
  const f = await fixture(t, { complete: async () => answer([]) });
  await f.service.updateProfile(profile()); await f.service.scan();
  const savedPath = path.join(f.dir, 'radar.json');
  const saved = JSON.parse(await readFile(savedPath, 'utf8'));
  delete saved.runHistory; delete saved.status.lastRun.manual;
  saved.status.lastRun.state = 'running';
  await writeFile(savedPath, JSON.stringify(saved)); f.service.close();
  let calls = 0;
  const restored = new RadarService({ dir: f.dir, now: f.clock, getTrends: () => board(), complete: async () => { calls++; return answer([]); } });
  const result = await restored.init(); restored.close();
  assert.equal(calls, 0);
  assert.equal(result.runHistory.length, 1);
  assert.equal(result.runHistory[0].state, 'interrupted');
  assert.equal(result.runHistory[0].manual, null);
  const migrated = JSON.parse(await readFile(savedPath, 'utf8'));
  assert.equal(migrated.runHistory[0].state, 'interrupted');
  migrated.runHistory = Array.from({ length: 65 }, (_, index) => ({ ...result.runHistory[0], id: randomUUID(), startedAt: iso(NOW - (64 - index) * HOUR), completedAt: iso(NOW - (64 - index) * HOUR), state: 'completed', manual: true }));
  migrated.status.lastRun = migrated.runHistory.at(-1);
  await writeFile(savedPath, JSON.stringify(migrated));
  const bounded = new RadarService({ dir: f.dir, now: f.clock, getTrends: () => board(), complete: async () => { calls++; return answer([]); } });
  t.after(() => bounded.close());
  const latest = await bounded.init();
  assert.equal(latest.runHistory.length, 60);
  assert.equal(latest.runHistory[0].id, migrated.runHistory[64].id);
  assert.equal(latest.runHistory.at(-1).id, migrated.runHistory[5].id);
  assert.equal(calls, 0);
});

test('an explicit unselected case name in any proposal field is rejected before it can contaminate the approved brief', async t => {
  const otherName = 'ｍｏｃｋ · 文档 阅读工具';
  const mixed = [
    { title: `用 ${otherName} 展示场景` },
    { angle: `借助 ${otherName} 介绍另一个案例` },
    { reason: `推荐用 ${otherName} 做宣传` },
    { outline: ['真实场景', `展示 ${otherName}`, '了解入口'] },
    { factNotes: `还要使用 ${otherName} 的界面` },
  ];
  for (const extra of mixed) {
    const f = await fixture(t, { complete: async () => answer([proposal('mock-hot-0', { materialIds: ['clock'], ...extra })]) });
    await f.service.updateProfile(profile());
    await assert.rejects(f.service.scan(), error => error.status === 502 && /所选案例不一致/.test(error.message));
    assert.equal(f.service.snapshot().opportunities.length, 0);
    assert.match(f.service.snapshot().status.error, /所选案例不一致/);
  }
});

test('a selected full case title, a shared document title and short generic names do not trigger case-name rejection', async t => {
  const inputs = [
    { profile: profile(), name: 'MOCK 状态栏计时工具' },
    { profile: { ...profile(), materials: profile().materials.map(material => ({ ...material, title: 'MOCK 共用案例介绍' })) }, name: 'MOCK 共用案例介绍' },
    { profile: { ...profile(), materials: profile().materials.map(material => material.id === 'reader' ? { ...material, title: '模型 API' } : material) }, name: '模型 API' },
  ];
  for (const input of inputs) {
    const f = await fixture(t, { complete: async () => answer([proposal('mock-hot-0', { materialIds: ['clock'], angle: `通过 ${input.name} 展示用户提供的实际使用场景` })]) });
    await f.service.updateProfile(input.profile);
    const result = await f.service.scan();
    assert.equal(result.opportunities.length, 1);
    assert.match(result.opportunities[0].angle, /实际使用场景/);
    assert.equal(result.status.lastRun.state, 'completed');
  }
});
