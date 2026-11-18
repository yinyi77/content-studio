import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyContentEdits, contentFingerprint, parseContentReview, reviewAndImproveContent } from '../lib/content-quality.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const passing = () => ({ scores: { grounding: 28, information: 22, naturalness: 22, audience: 9, purpose: 9 }, issues: [], summary: '内容具体，素材一致，表达清楚。' });
const issue = (quote, severity = 'warning') => ({ field: 'caption', severity, quote, reason: '这句只有泛泛赞美，没有说明具体能力。', suggestion: '使用已有的代码片段搜索功能说明用途。' });
const sample = () => ({ source: '给开发者介绍代码片段搜索工具，支持搜索保存的代码片段，未提供性能测试。', title: '查找保存的代码片段', caption: '全方位赋能开发效率。', mode: 'cards', style: 'notion', aspect: '3:4',
  pages: [{ id: 'first-page', title: '先找到那段代码', content: '搜索保存的代码片段。', prompt: '清晰排版。', imageUrl: '/existing.png', status: 'done' }] });

test('editorial scores are computed from dimensions and blockers prevent a high score from passing', () => {
  const project = sample(), value = { ...passing(), score: 999, pass: true, issues: [issue(project.caption, 'blocker')] };
  const parsed = parseContentReview(JSON.stringify(value), project, ['caption']);
  assert.equal(parsed.score, 90);
  assert.equal(parsed.issues[0].severity, 'blocker');
  assert.throws(() => parseContentReview(JSON.stringify({ ...passing(), issues: [issue('不存在的引文')] }), project, ['caption']));
  assert.throws(() => parseContentReview(JSON.stringify({ ...passing(), scores: { ...passing().scores, grounding: 31 } }), project, ['caption']));
  assert.throws(() => parseContentReview(JSON.stringify({ ...passing(), issues: [{ ...issue(project.title), field: 'title' }] }), project, ['caption']));
});

test('editorial patches preserve images, page identity, prompt and unselected text', () => {
  const project = sample();
  const next = applyContentEdits(JSON.stringify({ edits: [{ field: 'caption', text: '用关键词查找保存的代码片段。' }] }), project, ['caption']);
  assert.equal(next.caption, '用关键词查找保存的代码片段。');
  assert.deepEqual(next.pages, project.pages);
  assert.equal(next.title, project.title);
  assert.throws(() => applyContentEdits(JSON.stringify({ edits: [{ field: 'title', text: '越界修改' }] }), project, ['caption']));
  assert.throws(() => applyContentEdits(JSON.stringify({ edits: [{ field: 'caption', text: '文案', imageUrl: 'https://invalid.example/img' }] }), project, ['caption']));
  assert.equal(project.caption, '全方位赋能开发效率。');
});

test('a low score triggers a bounded repair followed by an independent review', async () => {
  const project = sample(), calls = [], progress = [];
  const result = await reviewAndImproveContent({ project, fields: ['caption'], config: {},
    onProgress: async report => progress.push(report.status),
    complete: async (config, messages) => {
      calls.push(messages);
      if (messages[0].content.startsWith('CONTENT_QUALITY_REWRITE')) return JSON.stringify({ edits: [{ field: 'caption', text: '输入关键词，查找自己保存的代码片段。' }] });
      return JSON.stringify(calls.length === 1 ? { ...passing(), scores: { grounding: 28, information: 15, naturalness: 15, audience: 8, purpose: 8 }, issues: [issue(project.caption)] } : passing());
    } });
  assert.equal(calls.length, 3);
  assert.equal(result.report.status, 'passed');
  assert.equal(result.report.rewriteCount, 1);
  assert.equal(result.report.score, 90);
  assert.deepEqual(progress, ['reviewing', 'rewriting', 'reviewing']);
  assert.deepEqual(result.draft.pages, project.pages);
  assert.equal(result.report.fingerprint, contentFingerprint(result.draft));
  assert.ok(calls[2][1].content.includes('输入关键词'));
});

test('critical claims remain blocked after two rewrites even with a score of 100', async () => {
  let calls = 0;
  const result = await reviewAndImproveContent({ project: sample(), fields: ['caption'], config: {}, complete: async (config, messages) => {
    calls++;
    const body = JSON.parse(messages[1].content);
    if (messages[0].content.startsWith('CONTENT_QUALITY_REWRITE')) return JSON.stringify({ edits: [{ field: 'caption', text: body.context.draft.caption + '仍待核实。' }] });
    return JSON.stringify({ scores: { grounding: 30, information: 25, naturalness: 25, audience: 10, purpose: 10 }, issues: [issue(body.draft.caption, 'blocker')], summary: '存在缺乏素材支持的主张。' });
  } });
  assert.equal(result.report.status, 'needs_revision');
  assert.equal(result.report.rewriteCount, 2);
  assert.equal(result.report.rounds.length, 3);
  assert.equal(calls, 5);
});

test('passing drafts receive concrete edits and survive an optional polish failure', async () => {
  const original = sample();
  let calls = 0;
  const complete = async (config, messages) => {
    calls++;
    if (messages[0].content.startsWith('CONTENT_QUALITY_REWRITE')) return JSON.stringify({ edits: [{ field: 'caption', text: '输入关键词查找保存的代码片段。' }] });
    return JSON.stringify({ ...passing(), issues: calls === 1 ? [issue(original.caption)] : [] });
  };
  const polished = await reviewAndImproveContent({ project: original, fields: ['caption'], config: {}, complete });
  assert.equal(polished.report.status, 'passed');
  assert.equal(polished.report.rewriteCount, 1);
  assert.equal(calls, 3);
  const fallback = await reviewAndImproveContent({ project: original, fields: ['caption'], config: {}, complete: async (config, messages) => {
    if (messages[0].content.startsWith('CONTENT_QUALITY_REWRITE')) throw new Error('optional polish unavailable');
    return JSON.stringify({ ...passing(), issues: [issue(original.caption)] });
  } });
  assert.equal(fallback.report.status, 'passed');
  assert.equal(fallback.draft.caption, original.caption);
  assert.match(fallback.report.summary, /此前已通过/);
});

test('local platform limits override a passing model review and invalid reviews never pass', async () => {
  const project = { ...sample(), title: '字'.repeat(21), xhsDelivery: { enabled: true } };
  const limited = await reviewAndImproveContent({ project, fields: ['title'], config: {}, complete: async (config, messages) =>
    JSON.stringify(messages[0].content.startsWith('CONTENT_QUALITY_REWRITE') ? { edits: [{ field: 'title', text: '查找代码片段' }] } : passing()) });
  assert.equal(limited.draft.title, '查找代码片段');
  assert.equal(limited.report.rewriteCount, 1);
  const invalid = await reviewAndImproveContent({ project: sample(), config: {}, complete: async () => '{"score":100,"pass":true}' });
  assert.equal(invalid.report.status, 'error');
  assert.match(invalid.report.error, /评分无效/);
});

test('low naturalness cannot pass on a high total and image-only checks never rewrite text', async () => {
  let calls = 0;
  const original = sample();
  const result = await reviewAndImproveContent({ project: original, config: {}, allowRewrite: false,
    complete: async () => {
      calls++;
      return JSON.stringify({ ...passing(), scores: { grounding: 30, information: 25, naturalness: 15, audience: 10, purpose: 10 } });
    } });
  assert.equal(result.report.score, 90);
  assert.equal(result.report.status, 'needs_revision');
  assert.ok(result.report.issues.some(issue => issue.reason.includes('自然表达')));
  assert.deepEqual(result.draft, original);
  assert.equal(calls, 1);
  assert.equal(result.report.rewriteCount, 0);
});

test('HTTP creation and scoped edits are reviewed before images and preserve old results on rejection', { timeout: 40000 }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-editorial-'));
  const port = 19611, base = `http://127.0.0.1:${port}`;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=';
  let child, log = '', phase = 'repair', reviews = 0, rewrites = 0, images = 0, plans = 0, current, phaseReviews = 0;
  const events = [], scopes = [];
  const upstream = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), system = body.messages?.[0]?.content || '';
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/images/generations') {
        images++; events.push({ type: 'image', prompt: body.prompt });
        return res.end(JSON.stringify({ data: [{ b64_json: png }] }));
      }
      let result;
      if (system.startsWith('CONTENT_QUALITY_REVIEW_V1')) {
        reviews++; phaseReviews++;
        if (phase === 'repair' && phaseReviews === 1) await sleep(60);
        const context = JSON.parse(body.messages.at(-1).content);
        scopes.push(context.editableFields);
        events.push({ type: 'review', copy: context.draft });
        if (phase === 'invalid') result = { score: 100, pass: true };
        else if (phase === 'blocked' || phase === 'chat-blocked') result = { ...passing(), issues: [issue(context.draft.caption, 'blocker')] };
        else if (phaseReviews === 1) result = { ...passing(), scores: { grounding: 28, information: 14, naturalness: 14, audience: 8, purpose: 8 }, issues: [{ ...issue(context.draft[context.editableFields[0]]), field: context.editableFields[0] }] };
        else result = passing();
      } else if (system.startsWith('CONTENT_QUALITY_REWRITE_V1')) {
        rewrites++;
        const { context } = JSON.parse(body.messages.at(-1).content);
        const field = context.editableFields.includes('caption') ? 'caption' : context.editableFields[0];
        result = { edits: [{ field, text: phase.includes('blocked') ? context.draft[field] + '进一步说明。' : '输入关键词，查找自己保存的代码片段。' }] };
        events.push({ type: 'rewrite' });
      } else if (system.includes('聊天修改助手')) {
        result = phase === 'page'
          ? { action: 'revise_pages', reply: '调整第二张图的文字。', pages: [{ id: current.pages[1].id, content: '全方位赋能开发效率。' }] }
          : { action: 'update_post', reply: '调整帖子正文。', caption: phase === 'chat-blocked' ? '效率提升300%。' : '全方位赋能开发效率。' };
      } else {
        plans++;
        result = { title: '查找代码片段', caption: '全方位赋能开发效率。', pages: [1, 2].map(index => ({ title: `代码片段 ${index}`, content: `用关键词查找已保存的片段 ${index}。`, prompt: '保持准确文字，使用清晰网格。' })) };
      }
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, headers: { Origin: base, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { response, value: await response.json() };
  }
  async function settled(id) {
    for (let attempt = 0; attempt < 250; attempt++) {
      const { value } = await request(`/api/projects/${id}`);
      if (!['analyzing', 'generating'].includes(value.project.status) && !['thinking', 'analyzing', 'generating'].includes(value.project.chatStatus)) return value.project;
      await sleep(20);
    }
    assert.fail('editorial task did not settle');
  }
  const input = () => ({ requestId: randomUUID(), source: sample().source, mode: 'cards', style: 'notion', aspect: '3:4', count: 2 });
  t.after(async () => {
    if (child?.exitCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dir, TRENDS_AUTO_REFRESH: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { log += bytes; }); child.stderr.on('data', bytes => { log += bytes; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) assert.fail(log);
    try { if ((await request('/api/config')).response.ok) break; } catch {}
    if (attempt === 99) assert.fail(log || 'server did not start');
    await sleep(30);
  }
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  await request('/api/config', { text: { baseUrl: upstreamUrl, model: 'editorial-text', apiKey: 'local-editorial-test' }, image: { baseUrl: upstreamUrl, model: 'editorial-image', apiKey: 'local-editorial-test', mode: 'images', size: 'auto' } }, 'PUT');

  const creationInput = input();
  const created = await request('/api/brief/create', creationInput);
  assert.equal(created.response.status, 202);
  current = await settled(created.value.project.id);
  assert.equal(current.status, 'completed');
  assert.equal(current.caption, '输入关键词，查找自己保存的代码片段。');
  assert.equal(current.contentQuality.status, 'passed');
  assert.equal(current.contentQuality.applied, true);
  assert.equal(current.contentQuality.rewriteCount, 1);
  assert.deepEqual(events.map(event => event.type), ['review', 'rewrite', 'review', 'image', 'image']);
  const counts = { reviews, rewrites, images, plans };
  await request('/api/brief/create', creationInput);
  await request(`/api/projects/${current.id}`);
  assert.deepEqual({ reviews, rewrites, images, plans }, counts);

  const original = structuredClone(current);
  phase = 'chat-blocked'; phaseReviews = 0;
  await request(`/api/projects/${current.id}/chat`, { requestId: randomUUID(), message: '调整帖子正文，图片和标题保持。' });
  current = await settled(current.id);
  assert.equal(current.status, 'completed');
  assert.equal(current.chatStatus, 'error');
  assert.equal(current.caption, original.caption);
  assert.deepEqual(current.pages, original.pages);
  assert.equal(current.contentQuality.applied, false);
  assert.equal(current.contentQuality.rewriteCount, 2);
  assert.ok(current.contentQuality.draft.caption.includes('300%'));
  assert.equal(images, 2);

  phase = 'chat-repair'; phaseReviews = 0;
  await request(`/api/projects/${current.id}/chat`, { requestId: randomUUID(), message: '优化帖子正文，写得具体一些，标题和图片不变。' });
  current = await settled(current.id);
  assert.equal(current.chatStatus, 'idle');
  assert.equal(current.contentQuality.status, 'passed');
  assert.equal(current.contentQuality.applied, true);
  assert.equal(current.title, original.title);
  assert.deepEqual(current.pages, original.pages);
  assert.deepEqual(scopes.at(-1), ['caption']);

  phase = 'page'; phaseReviews = 0;
  await request(`/api/projects/${current.id}/chat`, { requestId: randomUUID(), message: '优化第2张的文字，写得具体，其他不动。' });
  current = await settled(current.id);
  assert.equal(current.status, 'completed');
  assert.equal(current.chatStatus, 'idle', current.chatMessages.at(-1)?.content);
  assert.equal(current.caption, original.caption);
  assert.equal(current.pages[0].imageUrl, original.pages[0].imageUrl);
  assert.notEqual(current.pages[1].imageUrl, original.pages[1].imageUrl);
  assert.equal(images, 3);
  assert.deepEqual(scopes.at(-1), ['pages[1].content']);

  for (const nextPhase of ['blocked', 'invalid']) {
    phase = nextPhase; phaseReviews = 0;
    const result = await request('/api/brief/create', input());
    const rejected = await settled(result.value.project.id);
    assert.equal(rejected.status, 'error');
    assert.equal(rejected.contentQuality.applied, false);
    assert.ok(rejected.contentQuality.draft.caption);
    assert.equal(images, 3, 'rejected text must never start image generation');
    assert.equal(phaseReviews, phase === 'blocked' ? 3 : 1);
  }
});
