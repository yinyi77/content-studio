import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTrendMatchContext, matchingInstructions, parseTrendMatches, protectBriefSource } from '../lib/trend-matching.mjs';
import { normalizeBriefRequest, briefingMessages, parseBriefingResponse } from '../lib/briefing.mjs';

// Cache, text completion and credentials in this suite are all synthetic.
// Automatic refresh is disabled; no social platform or real model is called.
const root = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-10-29T07:00:00.000Z');
const iso = value => new Date(value).toISOString();
const platforms = ['weibo', 'douyin', 'xiaohongshu'];
const blank = () => ({ style: null, aspect: null, count: null, mode: null });
const topic = '我想创作一组户外运动的防晒小知识。';
const messages = [{ role: 'user', content: topic }];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const idFor = (platform, title) => createHash('sha256').update(`${platform}:${title.normalize('NFKC').replace(/[\s#＃]/g, '').toLowerCase()}`).digest('hex').slice(0, 24);

function item(platform, rank = 1, now = NOW, extra = {}) {
  const title = `MOCK ${platform} 防晒话题 ${rank}`;
  return { id: idFor(platform, title), platform, title, rank, url: `https://example.org/${platform}/${rank}`, heat: '12345',
    fetchedAt: iso(now - 5 * 60_000), sourceUpdatedAt: iso(now - 10 * 60_000), firstSeenAt: iso(now - 20 * 60_000),
    rankChange: null, provider: 'MOCK provider', ...extra };
}
function snapshot(count = 2, now = NOW) {
  return {
    items: platforms.flatMap(platform => Array.from({ length: count }, (_, index) => item(platform, index + 1, now))),
    platforms: platforms.map(id => ({ id, name: id, status: 'ready', freshness: 'fresh',
      lastSuccessAt: iso(now - 5 * 60_000), sourceUpdatedAt: iso(now - 10 * 60_000) })),
    settings: { enabled: true, intervalMinutes: 30, keywords: [] }, refreshing: false,
  };
}
function archivedMeme(platform = 'weibo', now = NOW, extra = {}) {
  const title = `MOCK ${platform} 防晒挑战热梗`;
  return item(platform, 999, now, { id: idFor(platform, title), title, url: `https://example.org/${platform}/archived-meme`,
    kind: 'meme', category: 'meme', firstSeenAt: iso(now - 3 * 86400_000), expiresAt: iso(now + 11 * 86400_000),
    fetchedAt: iso(now - 2 * 86400_000), sourceUpdatedAt: iso(now - 2 * 86400_000 - 5 * 60_000), lastSeenAt: iso(now - 2 * 86400_000),
    inCurrentBoard: false, ...extra });
}
function context(value = snapshot()) { return buildTrendMatchContext(value, { messages, now: NOW }); }
function briefing(extra = {}) {
  return { analysis: '这个主题适合用具体场景帮助读者建立日常防护习惯。', reply: '先梳理知识结构，再确认画面参数。', source: topic,
    preferences: blank(), recommendations: { style: 'notion', aspect: '3:4', count: 5, mode: 'cards' },
    reasons: { style: '线条和注解适合讲解知识。', aspect: '竖版便于手机阅读。', count: '五张可覆盖场景与方法。' }, ...extra };
}

test('fresh hot boards contribute candidates across platforms, capped at ninety', () => {
  const result = context(snapshot(40));
  assert.equal(result.status, 'available');
  assert.ok(result.candidateCount > 0 && result.candidateCount <= 90);
  assert.equal(result.candidateCount, result.candidates.length);
  assert.equal(result.excludedCount, 120 - result.candidateCount);
  assert.equal(result.checkedAt, iso(NOW));
  for (const platform of platforms) {
    const count = result.candidates.filter(candidate => candidate.platform === platform).length;
    assert.ok(count >= 20 && count <= 30, `${platform} should retain a fair candidate share`);
  }
  assert.equal(new Set(result.candidates.map(candidate => candidate.id)).size, result.candidateCount);
});

test('stale, unknown and failed boards are excluded rather than presented as current opportunities', () => {
  const input = snapshot();
  Object.assign(input.platforms[0], { status: 'stale', freshness: 'delayed' });
  Object.assign(input.platforms[1], { freshness: 'unknown', sourceUpdatedAt: null });
  Object.assign(input.platforms[2], { status: 'error' });
  const result = context(input);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.candidateCount, 0);
  assert.equal(result.excludedCount, 6);
  assert.deepEqual(result.candidates, []);
});

test('a fallback timestamp inferred from an identical previous list cannot qualify as current evidence', () => {
  const input = snapshot();
  input.platforms[0].sourceTimeBasis = 'previous-identical-list';
  const result = context(input);
  assert.equal(result.candidateCount, 4);
  assert.equal(result.excludedCount, 2);
  assert.ok(result.candidates.every(candidate => candidate.platform !== 'weibo'));
});

test('an active archived meme stays eligible after two days and after leaving a failed current board', () => {
  const input = snapshot(1);
  input.platforms.forEach(platform => { platform.status = 'error'; platform.freshness = 'delayed'; });
  input.memes = [archivedMeme()];
  const result = context(input);
  assert.equal(result.status, 'available');
  assert.equal(result.candidateCount, 1);
  assert.equal(result.candidates[0].id, input.memes[0].id);
  assert.equal(result.candidates[0].kind, 'meme');
  assert.equal(result.candidates[0].expiresAt, input.memes[0].expiresAt);
  assert.equal(result.candidates[0].inCurrentBoard, false);
});

test('expired, unknown-time and ancient-source archives are excluded while ordinary news keeps strict freshness', () => {
  const input = snapshot(1);
  input.items[0].sourceUpdatedAt = iso(NOW - 2 * 86400_000);
  input.items[1].fetchedAt = iso(NOW - 2 * 86400_000);
  input.platforms[2].freshness = 'unknown';
  input.memes = [archivedMeme('weibo', NOW, { firstSeenAt: iso(NOW - 14 * 86400_000), expiresAt: iso(NOW) }),
    archivedMeme('douyin', NOW, { sourceUpdatedAt: null }),
    archivedMeme('xiaohongshu', NOW, { firstSeenAt: iso(NOW - 86400_000), expiresAt: iso(NOW + 13 * 86400_000), sourceUpdatedAt: iso(NOW - 16 * 86400_000) })];
  const result = context(input);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.candidateCount, 0);
  assert.deepEqual(result.candidates, []);
});

test('a full current board cannot crowd valid archived memes out of the ninety-candidate budget', () => {
  const input = snapshot(40);
  input.memes = platforms.map(platform => archivedMeme(platform));
  const result = context(input);
  assert.ok(result.candidateCount <= 90);
  for (const meme of input.memes) assert.ok(result.candidates.some(candidate => candidate.id === meme.id && candidate.kind === 'meme'));
  assert.equal(new Set(result.candidates.map(candidate => candidate.id)).size, result.candidateCount);
});

test('meme matches preserve canonical fourteen-day metadata rather than model-supplied dates', () => {
  const input = snapshot(1); input.memes = [archivedMeme()];
  const matchContext = context(input);
  const meme = matchContext.candidates.find(candidate => candidate.kind === 'meme');
  const result = parseTrendMatches({ trendMatches: { matches: [{ id: meme.id, reason: '与户外防护受众相关。', angle: '以运动场景作知识引子。', kind: 'hot', expiresAt: '2099-01-01', firstSeenAt: '2098-12-18' }] } }, matchContext);
  assert.equal(result.status, 'matched');
  for (const field of ['kind', 'firstSeenAt', 'expiresAt', 'lastSeenAt', 'inCurrentBoard']) assert.equal(result.matches[0][field], meme[field]);
  assert.equal(result.matches[0].kind, 'meme');
  assert.ok(matchContext.candidates.filter(candidate => candidate.id !== meme.id).every(candidate => candidate.kind === 'hot'));
});

test('old per-item capture time and unsafe URLs cannot enter a fresh-looking board context', () => {
  const input = snapshot(3);
  input.items[0].fetchedAt = iso(NOW - 61 * 60_000);
  input.items[1].url = 'javascript:alert(1)';
  input.items[2].url = 'https://name:password@example.org/private';
  const result = context(input);
  assert.equal(result.candidateCount, 6);
  assert.equal(result.excludedCount, 3);
  assert.ok(result.candidates.every(candidate => ![input.items[0].id, input.items[1].id, input.items[2].id].includes(candidate.id)));
});

test('disabled matching does not inspect hotspot data', () => {
  const inaccessible = new Proxy({}, { get() { throw new Error('Disabled matching must not load candidate data'); } });
  const result = buildTrendMatchContext(inaccessible, { messages, now: NOW, enabled: false });
  assert.equal(result.status, 'disabled');
  assert.equal(result.candidateCount, 0);
  assert.equal(result.excludedCount, 0);
  assert.equal(parseTrendMatches('not JSON', result).status, 'disabled');
});

test('matching prompt supplies semantic candidates as data and requires explicit adoption before changing the source', () => {
  const input = snapshot(1);
  input.items[0].title = 'MOCK 正午跑步如何保护皮肤';
  const matchContext = context(input);
  const instructions = matchingInstructions(matchContext);
  const normalized = normalizeBriefRequest({ messages });
  const prompt = briefingMessages(normalized, matchContext).map(message => message.content).join('\n');
  assert.ok(instructions.includes(input.items[0].title), 'Related titles without exact topic words must reach the model');
  assert.ok(prompt.includes(input.items[0].id));
  assert.match(instructions, /source/);
  assert.match(instructions, /确认|采纳/);
  assert.match(instructions, /候选|数据|不可信/);
  assert.match(instructions, /reason/);
  assert.match(instructions, /angle/);
  assert.equal(normalized.matchTrends, true);
});

test('request toggle accepts only booleans and preserves explicit opt-out', () => {
  assert.equal(normalizeBriefRequest({ messages, matchTrends: false }).matchTrends, false);
  assert.equal(normalizeBriefRequest({ messages, matchTrends: true }).matchTrends, true);
  for (const matchTrends of ['true', 0, null, [], {}]) {
    assert.throws(() => normalizeBriefRequest({ messages, matchTrends }), error => error.status === 400);
  }
});

test('accepted matches use canonical metadata, ignoring model-supplied title, link, platform and times', () => {
  const matchContext = context();
  const canonical = matchContext.candidates[0];
  const response = parseTrendMatches({ trendMatches: { matches: [{ id: canonical.id, reason: '运动场景和皮肤防护知识有关。', angle: '从跑步场景切入，再解释适用的防护方法。',
    title: 'FORGED TITLE', url: 'javascript:alert(1)', platform: 'forged', fetchedAt: '2099-01-01', sourceUpdatedAt: '2099-01-01' }] } }, matchContext);
  assert.equal(response.status, 'matched');
  assert.equal(response.matches.length, 1);
  for (const field of ['id', 'title', 'url', 'platform', 'fetchedAt', 'sourceUpdatedAt']) assert.equal(response.matches[0][field], canonical[field]);
  assert.equal(response.matches[0].reason, '运动场景和皮肤防护知识有关。');
  assert.equal(response.matches[0].angle, '从跑步场景切入，再解释适用的防护方法。');
  assert.ok(!JSON.stringify(response).includes('FORGED'));
});

test('at most three valid unique known matches are accepted', () => {
  const matchContext = context();
  const match = candidate => ({ id: candidate.id, reason: '有关联的选择理由。', angle: '一个具体的创作切入角度。' });
  const good = parseTrendMatches(JSON.stringify({ trendMatches: { matches: matchContext.candidates.slice(0, 3).map(match) } }), matchContext);
  assert.equal(good.status, 'matched');
  assert.equal(good.matches.length, 3);
  for (const list of [matchContext.candidates.slice(0, 4).map(match), [match(matchContext.candidates[0]), match(matchContext.candidates[0])], [{ ...match(matchContext.candidates[0]), id: 'unknown-model-created-id' }]]) {
    const bad = parseTrendMatches({ trendMatches: { matches: list } }, matchContext);
    assert.equal(bad.status, 'error');
    assert.deepEqual(bad.matches, []);
  }
});

test('empty recommendations are an explicit no-match outcome, not an error', () => {
  const matchContext = context();
  const response = parseTrendMatches({ trendMatches: { matches: [] } }, matchContext);
  assert.equal(response.status, 'none');
  assert.deepEqual(response.matches, []);
  assert.equal(response.candidateCount, matchContext.candidateCount);
});

test('malformed recommendation output degrades safely without corrupting the main creative analysis', () => {
  const matchContext = context();
  const valid = { id: matchContext.candidates[0].id, reason: '有效理由', angle: '有效角度' };
  for (const raw of ['not JSON', {}, { trendMatches: [] }, { trendMatches: {} }, { trendMatches: { matches: 'invalid' } }, { trendMatches: { matches: [{ ...valid, reason: '' }] } }, { trendMatches: { matches: [{ ...valid, angle: 42 }] } }]) {
    const result = parseTrendMatches(raw, matchContext);
    assert.equal(result.status, 'error');
    assert.deepEqual(result.matches, []);
  }
  const parsed = parseBriefingResponse(JSON.stringify(briefing({ trendMatches: { matches: [{ id: 'unknown', reason: 'bad id', angle: 'bad id' }] } })), blank(), matchContext);
  assert.equal(parsed.source, topic);
  assert.equal(parsed.analysis, briefing().analysis);
  assert.equal(parsed.trendMatches.status, 'error');
});

test('no usable candidates returns unavailable even when the model invents a match', () => {
  const matchContext = context({ items: [], platforms: [] });
  const response = parseTrendMatches({ trendMatches: { matches: [{ id: 'invented', reason: 'fake', angle: 'fake' }] } }, matchContext);
  assert.equal(response.status, 'unavailable');
  assert.equal(response.candidateCount, 0);
  assert.deepEqual(response.matches, []);
});

test('an unselected candidate copied into the creative brief falls back to the user topic and supplements', () => {
  const conversation = [...messages, { role: 'assistant', content: '请确认参数。' }, { role: 'user', content: '面向跑步新手，采用温暖生活风格。' }];
  const matchContext = buildTrendMatchContext(snapshot(), { messages: conversation, now: NOW });
  const copiedTitle = matchContext.candidates[0].title;
  const raw = briefing({ source: `请结合「${copiedTitle}」制作运动科普图文。`, preferences: { style: 'warm', aspect: null, count: null, mode: null }, trendMatches: { matches: [] } });
  const result = parseBriefingResponse(JSON.stringify(raw), blank(), matchContext);
  assert.equal(result.source, `${topic}\n\n面向跑步新手，采用温暖生活风格。`);
  assert.equal(result.preferences.style, 'warm');
  assert.equal(result.analysis, raw.analysis);
  assert.match(result.trendMatches.message, /未选热点/);
  assert.ok(!result.source.includes(copiedTitle));
});

test('explicitly adopted topics and uncontaminated summaries remain intact', () => {
  const matchContext = context();
  const canonical = matchContext.candidates[0];
  const plainSummary = '为跑步新手制作一组户外防护知识图文。';
  assert.deepEqual(protectBriefSource(plainSummary, matchContext), { source: plainSummary, replaced: false, limited: false });
  const adopted = buildTrendMatchContext(snapshot(), { now: NOW, messages: [...messages, { role: 'user', content: `我选择结合热点「${canonical.title}」，保留原来的受众。` }] });
  const summary = `保留跑步新手受众，结合 ${canonical.title} 解释户外防护。`;
  assert.deepEqual(protectBriefSource(summary, adopted), { source: summary, replaced: false, limited: false });
});

test('long conversation fallback preserves the first topic and latest complete supplement within the source limit', () => {
  const first = '原始主题：' + '甲'.repeat(9900), middle = '中间补充：' + '乙'.repeat(9900), latest = '最新补充：' + '丙'.repeat(9900);
  const matchContext = buildTrendMatchContext(snapshot(), { now: NOW, messages: [{ role: 'user', content: first }, { role: 'user', content: middle }, { role: 'user', content: latest }] });
  const result = parseBriefingResponse(JSON.stringify(briefing({ source: `以 ${matchContext.candidates[0].title} 为创作方向。`, trendMatches: { matches: [] } })), blank(), matchContext);
  assert.ok(result.source.length <= 24000);
  assert.ok(result.source.startsWith(first));
  assert.ok(result.source.endsWith(latest));
  assert.ok(!result.source.includes(middle));
  assert.match(result.trendMatches.message, /需求较长|首条原文|核对/);
});

test('creative briefing matches real cached IDs in one local model call without generating or creating work', { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-trend-match-http-'));
  const base = 'http://127.0.0.1:19490';
  const secret = 'trend-match-mock-secret-never-expose';
  let child, log = '', calls = 0, imageCalls = 0, providerError = false, result = briefing();
  const incoming = [];
  const now = Date.now(), freshItems = [item('weibo', 1, now), item('weibo', 2, now), item('weibo', 3, now)];
  const cachedMeme = archivedMeme('weibo', now);
  const cachedPlatforms = platforms.map(platform => ({ id: platform, name: platform, provider: 'MOCK provider', sourceUrl: 'https://example.org/api',
    lastSuccessAt: iso(now - 5 * 60_000), lastAttemptAt: iso(now - 5 * 60_000), sourceUpdatedAt: platform === 'weibo' ? iso(now - 10 * 60_000) : platform === 'douyin' ? iso(now - 2 * 86400_000) : null,
    error: '', items: platform === 'weibo' ? freshItems : [item(platform, 1, now), item(platform, 2, now)] }));
  await writeFile(path.join(dir, 'trends.json'), JSON.stringify({ version: 1, settings: { enabled: true, intervalMinutes: 30, keywords: [] }, platforms: cachedPlatforms, memes: [cachedMeme], lastAttemptAt: iso(now - 5 * 60_000) }));
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url !== '/v1/chat/completions') { imageCalls++; res.statusCode = 500; return res.end(JSON.stringify({ error: { message: 'Unexpected image call' } })); }
    calls++; incoming.push(body);
    if (providerError) { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: `Mock credential rejected ${secret}` } })); }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (child?.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await stopped; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`;
  async function request(route, { method = 'GET', body, origin = base } = {}) {
    const response = await fetch(base + route, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch {}
    return { response, raw, value };
  }
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: '19490', DATA_DIR: dir, TRENDS_AUTO_REFRESH: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) assert.fail(`Server exited: ${log}`);
    try { if ((await request('/api/config')).response.ok) break; } catch {}
    if (i === 99) assert.fail(`Server failed to start: ${log}`);
    await sleep(30);
  }
  const config = { text: { baseUrl: upstreamBase, model: 'mock-text', apiKey: secret }, image: { baseUrl: upstreamBase, model: 'mock-image', apiKey: '', mode: 'images', size: 'auto' } };
  assert.equal((await request('/api/config', { method: 'PUT', body: config })).response.status, 200);
  const originalCache = await readFile(path.join(dir, 'trends.json'), 'utf8');
  result = briefing({ trendMatches: { matches: [{ id: freshItems[0].id, reason: '场景与内容方向相近。', angle: '先说明运动场景，再给可实践的方法。', url: 'https://forged.example/path', title: 'FORGED TITLE' }] } });
  const matched = await request('/api/brief/chat', { method: 'POST', body: { messages, preferences: blank() } });
  assert.equal(matched.response.status, 200, matched.raw);
  assert.equal(calls, 1);
  assert.equal(matched.value.trendMatches.status, 'matched');
  assert.equal(matched.value.trendMatches.candidateCount, 4);
  assert.equal(matched.value.trendMatches.excludedCount, 4);
  assert.equal(matched.value.trendMatches.matches[0].title, freshItems[0].title);
  assert.equal(matched.value.trendMatches.matches[0].url, freshItems[0].url);
  assert.equal(matched.value.source, topic);
  assert.ok(!matched.raw.includes(secret) && !matched.raw.includes('forged.example'));
  const sent = incoming[0].messages.map(message => message.content).join('\n');
  assert.ok(sent.includes(freshItems[0].id));
  assert.ok(sent.includes(cachedMeme.id));
  assert.ok(!sent.includes(cachedPlatforms[1].items[0].id) && !sent.includes(cachedPlatforms[2].items[0].id));
  result = briefing({ trendMatches: { matches: [{ id: cachedMeme.id, reason: '归档热梗与运动受众有关。', angle: '借用场景引入防护常识。', expiresAt: '2099-01-01' }] } });
  const beforeMeme = calls;
  const memeMatched = await request('/api/brief/chat', { method: 'POST', body: { messages } });
  assert.equal(calls, beforeMeme + 1, 'Archived meme matching must share the same text analysis call');
  assert.equal(memeMatched.value.trendMatches.status, 'matched');
  assert.equal(memeMatched.value.trendMatches.matches[0].kind, 'meme');
  assert.equal(memeMatched.value.trendMatches.matches[0].expiresAt, cachedMeme.expiresAt);
  assert.equal(memeMatched.value.trendMatches.matches[0].inCurrentBoard, false);
  result = briefing();
  const disabled = await request('/api/brief/chat', { method: 'POST', body: { messages, matchTrends: false } });
  assert.equal(disabled.response.status, 200, disabled.raw);
  assert.equal(disabled.value.trendMatches.status, 'disabled');
  assert.ok(!incoming.at(-1).messages.some(message => message.content.includes(freshItems[0].id)));
  const beforeInvalid = calls;
  assert.equal((await request('/api/brief/chat', { method: 'POST', body: { messages, matchTrends: 'yes' } })).response.status, 400);
  assert.equal(calls, beforeInvalid);
  const malformed = await request('/api/brief/chat', { method: 'POST', body: { messages, matchTrends: true } });
  assert.equal(malformed.response.status, 200, malformed.raw);
  assert.equal(malformed.value.trendMatches.status, 'error');
  assert.equal(malformed.value.analysis, result.analysis);
  result = briefing({ trendMatches: { matches: [] } });
  const none = await request('/api/brief/chat', { method: 'POST', body: { messages } });
  assert.equal(none.value.trendMatches.status, 'none');
  providerError = true;
  const rejected = await request('/api/brief/chat', { method: 'POST', body: { messages } });
  assert.ok(rejected.response.status >= 400);
  assert.ok(!rejected.raw.includes(secret));
  assert.equal(imageCalls, 0);
  assert.deepEqual((await request('/api/projects')).value.projects, []);
  assert.equal(await readFile(path.join(dir, 'trends.json'), 'utf8'), originalCache);
});
