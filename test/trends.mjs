import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrendsService, PLATFORMS, normalizeTrendPayload, validateTrendSettings, safeTrendUrl } from '../lib/trends.mjs';

// Every provider response is synthetic and injected. HTTP tests disable the
// scheduler, use temporary state, and never request an external refresh/model.
const root = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-10-29T06:45:00.000Z');
const iso = value => new Date(value).toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const row = (title, index = 1, extra = {}) => ({ title, index, url: `https://example.org/topic/${index}`, hot_value: `${1234 * index}`, ...extra });
const payload = (platform, updated = iso(NOW - 5 * 60_000), list = [row(`MOCK ${platform} 话题`)]) => ({ type: platform, update_time: updated, list });
function platformOf(url) {
  const parsed = new URL(url);
  return parsed.searchParams.get('type') || (parsed.pathname.endsWith('/rednote') ? 'xiaohongshu' : parsed.pathname.split('/').at(-1));
}
function fakeTimers(clock) {
  let nextId = 0;
  const entries = new Map();
  return {
    entries,
    setTimeoutImpl(callback, delay) {
      const handle = { id: ++nextId, unref() {} };
      entries.set(handle, { callback, due: clock.value + delay, delay });
      return handle;
    },
    clearTimeoutImpl(handle) { entries.delete(handle); },
    fireDue() {
      for (const [handle, entry] of [...entries]) if (entry.due <= clock.value) {
        entries.delete(handle); entry.callback();
      }
    },
  };
}
async function harness(t, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-trends-test-'));
  const clock = { value: NOW }, calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return json(payload(platformOf(url), iso(clock.value - 5 * 60_000)));
  };
  const service = new TrendsService({ dir, now: () => clock.value, fetchImpl, autoRefresh: false, ...overrides });
  t.after(async () => { service.close(); await service.inFlight; await service.persistenceQueue; await rm(dir, { recursive: true, force: true }); });
  await service.init();
  return { service, dir, clock, calls };
}

test('normalization keeps platform ranks and source time, drops unsafe URLs and duplicate titles', () => {
  const list = [
    row(' #MOCK 热梗# ', 2), row('MOCK 热梗', 3),
    row('invalid script', 4, { url: 'javascript:alert(1)' }),
    row('invalid credential', 5, { url: 'https://user:password@example.org/private' }),
    row('', 6), row('MOCK 第二条', 1, { hot_value: '947.5w', description: '用于测试的摘要' }),
  ];
  const normalized = normalizeTrendPayload('xiaohongshu', payload('xiaohongshu', iso(NOW), list), { fetchedAt: iso(NOW + 1000) });
  assert.equal(normalized.items.length, 2);
  assert.deepEqual(normalized.items.map(item => item.rank), [1, 2]);
  assert.equal(normalized.items[0].heat, '947.5w');
  assert.equal(normalized.items[0].description, '用于测试的摘要');
  assert.equal(normalized.sourceUpdatedAt, iso(NOW));
  assert.equal(normalized.items[0].fetchedAt, iso(NOW + 1000));
  assert.ok(normalized.items.every(item => item.platform === 'xiaohongshu' && item.isNew === false));
  assert.equal(safeTrendUrl('file:///etc/passwd'), '');
  assert.equal(safeTrendUrl('//example.org/topic'), '');
});

test('rank changes use stable normalized title IDs and preserve first seen time', () => {
  const first = normalizeTrendPayload('weibo', payload('weibo', iso(NOW), [row('#MOCK 热梗#', 8)]), { fetchedAt: iso(NOW) });
  const second = normalizeTrendPayload('weibo', payload('weibo', iso(NOW + 60_000), [row('MOCK 热梗', 2), row('MOCK 新话题', 3)]), {
    fetchedAt: iso(NOW + 60_000), previousItems: first.items,
  });
  assert.equal(second.items[0].id, first.items[0].id);
  assert.equal(second.items[0].rankChange, 6);
  assert.equal(second.items[0].firstSeenAt, iso(NOW));
  assert.equal(second.items[0].isNew, false);
  assert.equal(second.items[1].isNew, true);
  assert.notEqual(normalizeTrendPayload('douyin', payload('douyin', iso(NOW), [row('MOCK 热梗')])).items[0].id, first.items[0].id);
});

test('empty, malformed, and provider-error results are not accepted as a valid hot board', () => {
  for (const value of [null, {}, { list: [] }, { list: [null, row('unsafe', 1, { url: 'data:text/html,no' })] }, { code: 401, list: [row('MOCK')] }]) {
    assert.throws(() => normalizeTrendPayload('weibo', value));
  }
});

test('settings accept only supported intervals and bounded nonempty keywords', () => {
  assert.deepEqual(validateTrendSettings({ enabled: false, intervalMinutes: 15, keywords: [' 闪身步 ', 'AI', 'ai'] }), {
    enabled: false, intervalMinutes: 15, keywords: ['闪身步', 'ai'],
  });
  for (const bad of [null, [], { enabled: 'true' }, { intervalMinutes: '30' }, { intervalMinutes: 1 }, { keywords: [''] }, { keywords: [42] }, { keywords: ['a'.repeat(41)] }, { keywords: Array(21).fill('词') }]) {
    assert.throws(() => validateTrendSettings(bad), error => error.status === 400);
  }
});

test('disabled auto refresh creates neither network requests nor scheduled work', async t => {
  const clock = { value: NOW }, timers = fakeTimers(clock);
  const { service, calls } = await harness(t, timers);
  assert.equal(calls.length, 0);
  assert.equal(timers.entries.size, 0);
  assert.equal(service.snapshot().schedulerActive, false);
  assert.equal(service.snapshot().nextRefreshAt, null);
  assert.deepEqual(service.snapshot().settings, { enabled: true, intervalMinutes: 30, keywords: [] });
  assert.ok(service.snapshot().platforms.every(platform => platform.status === 'empty' && platform.itemCount === 0));
  await service.updateSettings({ intervalMinutes: 15, keywords: ['闪身步'] });
  assert.equal(calls.length, 0);
  assert.equal(timers.entries.size, 0);
});

test('fresh source boards retain timestamps and requests contain no auth or cookies', async t => {
  const { service, calls, dir } = await harness(t);
  const result = await service.refresh();
  assert.equal(result.items.length, 3);
  assert.equal(calls.length, 3);
  assert.ok(result.platforms.every(platform => platform.status === 'ready' && platform.freshness === 'fresh'));
  for (const call of calls) {
    assert.equal(new URL(call.url).hostname, 'uapis.cn');
    assert.deepEqual(Object.keys(call.options.headers), ['Accept']);
    assert.equal(call.options.redirect, 'error');
  }
  const cache = JSON.parse(await readFile(path.join(dir, 'trends.json'), 'utf8'));
  assert.equal(cache.version, 1);
  assert.equal(cache.platforms.length, 3);
  assert.equal(cache.lastAttemptAt, iso(NOW));
  const mutated = service.snapshot(); mutated.items[0].title = 'client changed'; mutated.settings.keywords.push('client changed');
  assert.notEqual(service.snapshot().items[0].title, 'client changed');
  assert.deepEqual(service.snapshot().settings.keywords, []);
});

test('a newly fetched two-day-old source board is delayed, not fresh', async t => {
  const { service } = await harness(t, { fetchImpl: async url => json(payload(platformOf(url), iso(NOW - 2 * 86400_000))) });
  const result = await service.refresh();
  for (const platform of result.platforms) {
    assert.equal(platform.lastSuccessAt, iso(NOW));
    assert.equal(platform.sourceUpdatedAt, iso(NOW - 2 * 86400_000));
    assert.equal(platform.status, 'stale');
    assert.equal(platform.freshness, 'delayed');
    assert.match(platform.freshnessReason, /来源榜单/);
  }
});

test('fallback uses the rednote route and does not mistake event time for source time', async t => {
  const calls = [];
  const { service } = await harness(t, { fetchImpl: async url => {
    calls.push(url);
    if (new URL(url).hostname === 'uapis.cn') return new Response('{}', { status: 503 });
    const platform = platformOf(url);
    return json({ code: 200, data: [{ title: `MOCK ${platform}`, rank: 1, link: 'https://example.org/mock',
      hot_value: 123, score: '947.5w', event_time_at: iso(NOW), active_time_at: iso(NOW) }] });
  } });
  const result = await service.refresh();
  assert.equal(calls.length, 6);
  assert.ok(calls.some(url => url.endsWith('/v2/rednote')));
  assert.ok(!calls.some(url => url.endsWith('/v2/xiaohongshu')));
  assert.ok(result.platforms.every(platform => platform.provider === '60s API' && platform.freshness === 'unknown' && platform.sourceUpdatedAt === null));
});

test('unchanged fallback data cannot erase the known age of an older board', async t => {
  let fallback = false;
  const { service, clock } = await harness(t, { fetchImpl: async url => {
    const platform = platformOf(url);
    if (!fallback) return json(payload(platform, iso(NOW - 2 * 86400_000)));
    if (new URL(url).hostname === 'uapis.cn') return json({ list: [] });
    return json({ code: 200, data: [{ title: `MOCK ${platform} 话题`, link: 'https://example.org/topic/1', hot_value: 1234 }] });
  } });
  await service.refresh(); fallback = true; clock.value += 30 * 60_000;
  const result = await service.refresh();
  assert.ok(result.platforms.every(platform => platform.provider === '60s API' && platform.status === 'stale' && platform.freshness === 'delayed'));
  assert.ok(result.items.every(item => item.sourceUpdatedAt === iso(NOW - 2 * 86400_000)));
});

test('failed refresh retains cached items and last success while reporting the new attempt', async t => {
  let fail = false;
  const { service, clock } = await harness(t, { fetchImpl: async url => fail ? new Response('unavailable', { status: 503 }) : json(payload(platformOf(url))) });
  const original = await service.refresh(); fail = true; clock.value += 30 * 60_000;
  const result = await service.refresh();
  assert.deepEqual(result.items, original.items);
  assert.ok(result.platforms.every(platform => platform.status === 'stale' && platform.lastSuccessAt === iso(NOW) && platform.lastAttemptAt === iso(clock.value)));
  assert.ok(result.platforms.every(platform => /UAPI.*503.*60s API.*503/.test(platform.error)));
  assert.equal(result.refreshing, false);
});

test('initial provider failure yields an empty error state without invented topics', async t => {
  const { service } = await harness(t, { fetchImpl: async () => { throw new Error('mock offline'); } });
  const result = await service.refresh();
  assert.deepEqual(result.items, []);
  assert.ok(result.platforms.every(platform => platform.status === 'error' && platform.lastSuccessAt === null && platform.itemCount === 0));
});

test('cache aging is computed again when snapshot is read', async t => {
  const { service, clock } = await harness(t, { fetchImpl: async url => json({ ...payload(platformOf(url)), update_time: undefined }) });
  await service.refresh();
  assert.ok(service.snapshot().platforms.every(platform => platform.status === 'ready' && platform.freshness === 'unknown'));
  clock.value += 61 * 60_000;
  assert.ok(service.snapshot().platforms.every(platform => platform.status === 'stale' && platform.freshness === 'delayed'));
});

test('concurrent refreshes share one provider pass and manual cooldown exposes retry delay', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const { service, clock } = await harness(t, { fetchImpl: async url => { requests++; await gate; return json(payload(platformOf(url))); } });
  const first = service.refresh({ manual: true });
  const immediate = service.startRefresh({ manual: true });
  const second = service.refresh({ manual: true });
  assert.equal(immediate.refreshing, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 3);
  release(); await Promise.all([first, second]);
  assert.equal(requests, 3);
  assert.throws(() => service.startRefresh({ manual: true }), error => error.status === 429 && error.retryAfterMs > 0 && error.retryAfterMs <= 60_000);
  clock.value += 60_000;
  await service.refresh({ manual: true });
  assert.equal(requests, 6);
});

test('scheduler runs a due refresh, reschedules the selected interval, pauses and restores', async t => {
  const clock = { value: NOW }, timers = fakeTimers(clock);
  const { service } = await harness(t, { now: () => clock.value, ...timers, autoRefresh: true });
  assert.equal(service.snapshot().nextRefreshAt, iso(NOW));
  assert.equal(timers.entries.size, 1);
  timers.fireDue(); await service.inFlight;
  assert.equal(service.snapshot().nextRefreshAt, iso(NOW + 30 * 60_000));
  assert.equal(timers.entries.size, 1);
  await service.updateSettings({ intervalMinutes: 15 });
  assert.equal(service.snapshot().nextRefreshAt, iso(NOW + 15 * 60_000));
  await service.updateSettings({ enabled: false });
  assert.equal(service.snapshot().schedulerActive, false);
  assert.equal(service.snapshot().nextRefreshAt, null);
  assert.equal(timers.entries.size, 0);
  clock.value += 20 * 60_000;
  await service.updateSettings({ enabled: true });
  assert.equal(service.snapshot().nextRefreshAt, iso(clock.value));
  timers.fireDue(); await service.inFlight;
  assert.equal(service.snapshot().nextRefreshAt, iso(clock.value + 15 * 60_000));
  service.close();
  assert.equal(timers.entries.size, 0);
  assert.throws(() => service.startRefresh(), error => error.status === 503);
});

test('cache and settings restore after restart without a provider call', async t => {
  const { service, dir } = await harness(t);
  await service.updateSettings({ enabled: false, intervalMinutes: 60, keywords: ['闪身步', 'AI'] });
  const original = await service.refresh(); service.close();
  let unexpected = 0;
  const restored = new TrendsService({ dir, now: () => NOW, autoRefresh: false, fetchImpl: async () => { unexpected++; throw new Error('unexpected provider request'); } });
  t.after(() => restored.close());
  const result = await restored.init();
  assert.deepEqual(result.items, original.items);
  assert.deepEqual(result.settings, original.settings);
  assert.equal(unexpected, 0);
  assert.equal(result.persistenceError, '');
});

test('corrupt cache is reported and recovered after a successful refresh', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-trends-corrupt-'));
  await writeFile(path.join(dir, 'trends.json'), '{broken JSON');
  const service = new TrendsService({ dir, autoRefresh: false, now: () => NOW, fetchImpl: async url => json(payload(platformOf(url))) });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  assert.match((await service.init()).persistenceError, /缓存读取失败/);
  const result = await service.refresh();
  assert.equal(result.items.length, 3);
  assert.equal(result.persistenceError, '');
  assert.equal(JSON.parse(await readFile(path.join(dir, 'trends.json'), 'utf8')).version, 1);
});

test('oversized and invalid JSON provider responses fail safely', async t => {
  for (const kind of ['oversized', 'invalid-json']) {
    const { service } = await harness(t, { fetchImpl: async () => kind === 'oversized'
      ? new Response('{}', { headers: { 'Content-Length': `${2 * 1024 * 1024}` } })
      : new Response('<html>not JSON</html>') });
    const result = await service.refresh();
    assert.deepEqual(result.items, []);
    assert.ok(result.platforms.every(platform => platform.status === 'error'));
    assert.match(result.platforms[0].error, kind === 'oversized' ? /响应过大/ : /有效 JSON/);
  }
});

test('provider timeout aborts requests and completes with explicit platform errors', async t => {
  const signals = [];
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const { service } = await harness(t, { timeoutMs: 15, fetchImpl: async (url, options) => {
    signals.push(options.signal); return new Promise(() => {});
  } });
  const result = await service.refresh();
  assert.equal(signals.length, PLATFORMS.length * 2);
  assert.ok(signals.every(signal => signal.aborted));
  assert.ok(result.platforms.every(platform => platform.status === 'error' && /超时/.test(platform.error)));
});

test('meme candidates get a fixed fourteen-day lifetime from first collection', async t => {
  let env;
  env = await harness(t, { fetchImpl: async url => {
    const platform = platformOf(url);
    return json(payload(platform, iso(env.clock.value - 2 * 86400_000), [row(platform === 'weibo' ? 'MOCK 闪身步热梗' : `MOCK ${platform} 普通新闻`)]));
  } });
  const result = await env.service.refresh();
  assert.equal(result.memes.length, 1);
  const meme = result.memes[0];
  assert.equal(meme.kind, 'meme');
  assert.equal(meme.category, 'meme');
  assert.equal(meme.firstSeenAt, iso(NOW));
  assert.equal(meme.expiresAt, iso(NOW + 14 * 86400_000));
  assert.equal(meme.lastSeenAt, iso(NOW));
  assert.equal(meme.inCurrentBoard, true);
  assert.equal(meme.sourceUpdatedAt, iso(NOW - 2 * 86400_000));
  assert.equal(result.platforms.find(platform => platform.id === 'weibo').status, 'stale');
  const saved = JSON.parse(await readFile(path.join(env.dir, 'trends.json'), 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.memes[0].expiresAt, meme.expiresAt);
});

test('repeated sightings update last seen and metadata without extending meme expiry', async t => {
  let env, rank = 8;
  env = await harness(t, { fetchImpl: async url => {
    const platform = platformOf(url);
    return json(payload(platform, iso(env.clock.value - 5 * 60_000), [row(platform === 'weibo' ? 'MOCK 闪身步热梗' : `MOCK ${platform} 普通新闻`, rank)]));
  } });
  const first = (await env.service.refresh()).memes[0];
  env.clock.value += 3 * 86400_000; rank = 2;
  const current = (await env.service.refresh()).memes[0];
  assert.equal(current.id, first.id);
  assert.equal(current.firstSeenAt, first.firstSeenAt);
  assert.equal(current.expiresAt, first.expiresAt);
  assert.equal(current.lastSeenAt, iso(env.clock.value));
  assert.equal(current.rank, 2);
});

test('meme archive survives leaving the current board and restarting the service', async t => {
  let env, showMeme = true;
  env = await harness(t, { fetchImpl: async url => {
    const platform = platformOf(url);
    const title = platform === 'weibo' && showMeme ? 'MOCK 闪身步热梗' : `MOCK ${platform} 普通新闻`;
    return json(payload(platform, iso(env.clock.value - 5 * 60_000), [row(title)]));
  } });
  const original = (await env.service.refresh()).memes[0];
  env.clock.value += 4 * 86400_000; showMeme = false;
  const dropped = await env.service.refresh();
  assert.ok(!dropped.items.some(entry => entry.id === original.id));
  assert.equal(dropped.memes.length, 1);
  assert.equal(dropped.memes[0].inCurrentBoard, false);
  assert.equal(dropped.memes[0].lastSeenAt, original.lastSeenAt);
  env.service.close();
  const restored = new TrendsService({ dir: env.dir, now: () => env.clock.value, autoRefresh: false, fetchImpl: async () => { throw new Error('Restart must use cache only'); } });
  t.after(() => restored.close());
  const result = await restored.init();
  assert.equal(result.memes.length, 1);
  assert.equal(result.memes[0].expiresAt, original.expiresAt);
  assert.equal(result.memes[0].firstSeenAt, original.firstSeenAt);
  assert.equal(result.memes[0].inCurrentBoard, false);
});

test('expired memes are hidden and cannot restart their lifetime on continuous or returning sightings', async t => {
  let env, showMeme = true;
  const mock = async url => {
    const platform = platformOf(url);
    return json(payload(platform, iso(env.clock.value - 5 * 60_000), [row(platform === 'weibo' && showMeme ? 'MOCK 闪身步热梗' : `MOCK ${platform} 普通新闻`)]));
  };
  env = await harness(t, { fetchImpl: mock });
  const original = (await env.service.refresh()).memes[0];
  env.clock.value = Date.parse(original.expiresAt);
  assert.deepEqual(env.service.snapshot().memes, []);
  assert.deepEqual((await env.service.refresh()).memes, []);
  showMeme = false; env.clock.value += 86400_000;
  await env.service.refresh(); env.service.close();
  showMeme = true; env.clock.value += 86400_000;
  const restored = new TrendsService({ dir: env.dir, now: () => env.clock.value, autoRefresh: false, fetchImpl: mock });
  t.after(() => restored.close());
  await restored.init();
  assert.deepEqual((await restored.refresh()).memes, []);
});

test('unknown or more-than-fourteen-day-old source data cannot seed a new meme archive', async t => {
  for (const sourceTime of [null, iso(NOW - 15 * 86400_000)]) {
    const { service } = await harness(t, { fetchImpl: async url => json(payload(platformOf(url), sourceTime, [row('MOCK 闪身步热梗')])) });
    const result = await service.refresh();
    assert.equal(result.items.length, 3);
    assert.deepEqual(result.memes, []);
  }
});

test('meme archive storage is bounded at five hundred records', async t => {
  let env, batch = 0;
  env = await harness(t, { fetchImpl: async url => {
    const platform = platformOf(url);
    const list = platform === 'weibo' ? Array.from({ length: 100 }, (_, index) => row(`MOCK 热梗 闪身步 ${batch}-${index}`, index + 1)) : [row(`MOCK ${platform} 普通新闻`)];
    return json(payload(platform, iso(env.clock.value - 5 * 60_000), list));
  } });
  for (batch = 0; batch < 6; batch++) { env.clock.value += 60_000; await env.service.refresh(); }
  const result = env.service.snapshot();
  assert.ok(result.memes.length > 0 && result.memes.length <= 500);
  const persisted = JSON.parse(await readFile(path.join(env.dir, 'trends.json'), 'utf8'));
  assert.ok(persisted.memes.length <= 500);
  assert.equal(new Set(result.memes.map(entry => entry.id)).size, result.memes.length);
});

test('trends HTTP routes preserve local isolation and persist settings without models', { timeout: 15_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-trends-http-'));
  const base = 'http://127.0.0.1:19488';
  const preload = path.join(dir, 'mock-provider.mjs');
  await writeFile(preload, `
import { appendFile } from 'node:fs/promises';
const log = new URL('./provider-requests.jsonl', import.meta.url);
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.hostname !== 'uapis.cn' || url.pathname !== '/api/v1/misc/hotboard') throw new Error('Unexpected network request in isolated HTTP test');
  await appendFile(log, JSON.stringify({url: url.href, headers: options.headers}) + '\\n');
  await new Promise(resolve => setTimeout(resolve, 150));
  const platform = url.searchParams.get('type');
  return new Response(JSON.stringify({type: platform, update_time: new Date().toISOString(), list: [{index: 1, title: 'MOCK ' + platform, url: 'https://example.org/mock', hot_value: '123'}]}));
};
`);
  let log = '';
  const child = spawn(process.execPath, ['--import', preload, 'server.mjs'], {
    cwd: root, env: { ...process.env, PORT: '19488', DATA_DIR: dir, TRENDS_AUTO_REFRESH: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', value => { log += value; });
  child.stderr.on('data', value => { log += value; });
  t.after(async () => {
    if (child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await stopped; }
    await rm(dir, { recursive: true, force: true });
  });
  async function request(route, { method = 'GET', body, origin = base } = {}) {
    const response = await fetch(base + route, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, value: await response.json() };
  }
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) assert.fail(`Server exited: ${log}`);
    try { if ((await request('/api/trends')).response.ok) break; } catch {}
    if (i === 99) assert.fail(`Server failed to start: ${log}`);
    await sleep(30);
  }
  const initial = await request('/api/trends');
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.value.items, []);
  assert.equal(initial.value.refreshing, false);
  assert.equal(initial.value.schedulerActive, false);
  const saved = await request('/api/trends/settings', { method: 'PUT', body: { enabled: false, intervalMinutes: 15, keywords: ['闪身步'] } });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.value.settings, { enabled: false, intervalMinutes: 15, keywords: ['闪身步'] });
  assert.deepEqual((await request('/api/trends')).value.settings, saved.value.settings);
  assert.equal((await request('/api/trends/settings', { method: 'PUT', body: { intervalMinutes: 5 } })).response.status, 400);
  assert.equal((await request('/api/trends/settings', { method: 'PUT', origin: 'https://evil.example', body: { enabled: true } })).response.status, 403);
  assert.equal((await request('/api/trends/refresh', { method: 'POST', origin: 'https://evil.example', body: {} })).response.status, 403);
  assert.equal((await request('/api/trends', { origin: 'https://evil.example' })).response.status, 403);
  assert.deepEqual((await request('/api/projects')).value.projects, []);
  assert.equal((await request('/api/config')).value.configured, false);
  assert.equal((await request('/api/trends')).value.lastAttemptAt, null);
  const started = await request('/api/trends/refresh', { method: 'POST', body: {} });
  assert.equal(started.response.status, 202);
  assert.equal(started.value.refreshing, true);
  const duplicate = await request('/api/trends/refresh', { method: 'POST', body: {} });
  assert.equal(duplicate.response.status, 202);
  let settled;
  for (let i = 0; i < 100; i++) {
    settled = (await request('/api/trends')).value;
    if (!settled.refreshing) break;
    await sleep(20);
  }
  assert.equal(settled.refreshing, false);
  assert.equal(settled.items.length, 3);
  const providerCalls = (await readFile(path.join(dir, 'provider-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(providerCalls.length, 3, 'HTTP duplicate refresh must share one provider pass');
  assert.ok(providerCalls.every(call => Object.keys(call.headers).join(',') === 'Accept'));
  const cooldown = await request('/api/trends/refresh', { method: 'POST', body: {} });
  assert.equal(cooldown.response.status, 429);
  assert.ok(Number(cooldown.response.headers.get('Retry-After')) > 0);
  assert.ok(cooldown.value.retryAfterMs > 0 && cooldown.value.retryAfterMs <= 60_000);
  assert.deepEqual((await request('/api/projects')).value.projects, []);
});
