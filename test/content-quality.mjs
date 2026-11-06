import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlan } from '../lib/providers.mjs';
import { planningMessages, renderingPrompt, styles } from '../lib/prompts.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const visualSystem = {
  palette: ['#FAF7F0', '#173C36', '#B94D35'],
  typography: '系列标题使用同一款粗体中文无衬线字，正文使用同款常规字重。',
  illustration: '同一套简洁铅笔线条插画，轮廓粗细与材质一致。',
  layout: '统一安全边距和基线；封面突出主题，内页采用对齐的双栏信息。',
};
const caption = '先给任务一个清楚的目标，再补上必要背景。\n\n从整理一段材料开始，把检查结果也放进流程。\n\n#办公提效';
const notes = '策划说明：QUALITY_ONLY_NOTE，素材不足的细节没有写入发布正文。';
const missingFacts = ['QUALITY_ONLY_FACT：若需要具体产品推广，请补充真实型号。'];

function planInput(extra = {}, count = 2) {
  return {
    title: '把重复的小事，交给更清楚的流程', caption,
    pages: Array.from({ length: count }, (_, index) => ({
      title: `做好眼前这一步 ${index + 1}`,
      content: `先说明目标，再提供背景。\n完成后核对结果 ${index + 1}。`,
      prompt: `用清晰网格展示第 ${index + 1} 页的任务关系，保留充分留白。`,
    })),
    ...extra,
  };
}

function block(prompt, name) {
  const match = prompt.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`));
  assert.ok(match, `render prompt must include the ${name} data block`);
  return JSON.parse(match[1]);
}

test('legacy plans keep their content and normalize absent or null quality metadata', () => {
  for (const extra of [{}, { visualSystem: null, planningNotes: null, missingFacts: null }]) {
    const input = planInput(extra);
    const parsed = parsePlan(JSON.stringify(input), 2);
    assert.equal(parsed.title, input.title);
    assert.equal(parsed.caption, caption);
    assert.deepEqual(parsed.pages, input.pages);
    assert.equal(parsed.planningNotes, '');
    assert.deepEqual(parsed.missingFacts, []);
    assert.equal(parsed.visualSystem, undefined);
  }
});

test('the plan parser separates quality metadata and only retains supported data', () => {
  const input = planInput({
    title: '  正式帖子标题  ', caption: `  ${caption}  `,
    visualSystem: { ...visualSystem, palette: [' #FAF7F0 ', '#173C36'], typography: '  中文字阶  ', unexpected: 'do not persist' },
    planningNotes: `  ${notes}  `, missingFacts: ['  需要真实型号  ', '需要真实型号'],
    imageUrl: 'https://example.invalid/untrusted.png', apiKey: 'do-not-retain',
  });
  input.pages[0] = { ...input.pages[0], title: '  图内标题  ', content: '  图内正文  ', prompt: '  视觉描述  ', imageUrl: 'https://example.invalid/ignored.png' };
  const parsed = parsePlan(JSON.stringify(input), 2);
  assert.deepEqual(Object.keys(parsed).sort(), ['title', 'caption', 'pages', 'visualSystem', 'planningNotes', 'missingFacts'].sort());
  assert.equal(parsed.title, '正式帖子标题'); assert.equal(parsed.caption, caption);
  assert.deepEqual(parsed.pages[0], { title: '图内标题', content: '图内正文', prompt: '视觉描述' });
  assert.deepEqual(parsed.visualSystem, { palette: ['#FAF7F0', '#173C36'], typography: '中文字阶', illustration: visualSystem.illustration, layout: visualSystem.layout });
  assert.equal(parsed.planningNotes, notes);
  assert.deepEqual(parsed.missingFacts, ['需要真实型号']);
});

test('quality metadata accepts the documented boundaries and rejects malformed or oversized values', () => {
  const boundary = planInput({
    visualSystem: { palette: Array(6).fill('色'.repeat(100)), typography: '字'.repeat(600), illustration: '画'.repeat(600), layout: '格'.repeat(600) },
    planningNotes: '注'.repeat(2000), missingFacts: Array.from({ length: 5 }, (_, index) => `${index}${'缺'.repeat(199)}`),
  });
  const parsed = parsePlan(JSON.stringify(boundary), 2);
  assert.equal(parsed.planningNotes.length, 2000); assert.equal(parsed.visualSystem.palette.length, 6);
  assert.equal(parsed.missingFacts[4].length, 200);
  const malformed = [
    { visualSystem: [] }, { visualSystem: 'not a structured visual system' },
    { visualSystem: { ...visualSystem, palette: [] } },
    { visualSystem: { ...visualSystem, palette: Array(7).fill('#FFFFFF') } },
    { visualSystem: { ...visualSystem, palette: [''] } },
    { visualSystem: { ...visualSystem, palette: ['色'.repeat(101)] } },
    { visualSystem: { ...visualSystem, typography: '字'.repeat(601) } },
    { visualSystem: { ...visualSystem, illustration: null } },
    { visualSystem: { ...visualSystem, layout: '' } },
    { planningNotes: '注'.repeat(2001) }, { planningNotes: [] },
    { missingFacts: 'not an array' }, { missingFacts: Array(6).fill('缺资料') },
    { missingFacts: ['缺'.repeat(201)] }, { missingFacts: [''] }, { missingFacts: [1] },
  ];
  for (const value of malformed) assert.throws(() => parsePlan(JSON.stringify(planInput(value)), 2), JSON.stringify(value).slice(0, 120));
  assert.throws(() => parsePlan(' '.repeat(300001), 2));
});

test('page rendering shares one visual system while using only each page current authoritative text', async () => {
  const input = planInput({ visualSystem, planningNotes: notes, missingFacts });
  const project = { ...input, mode: 'cards', style: 'warm', aspect: '3:4', count: 2,
    pages: input.pages.map((page, index) => ({ ...page, id: `page-${index + 1}` })) };
  project.pages[1] = { ...project.pages[1], title: '修改后的图内标题', content: '这段文字已经更新。', prompt: '旧视觉草稿写着：旧标题、旧正文。使用右侧留白构图。' };
  for (const page of project.pages) {
    const prompt = await renderingPrompt(project, page);
    assert.deepEqual(block(prompt, 'series-visual-system'), visualSystem);
    assert.deepEqual(block(prompt, 'authoritative-text'), { title: page.title, body: page.content });
    assert.ok(!prompt.includes('QUALITY_ONLY_NOTE'));
    assert.ok(!prompt.includes('QUALITY_ONLY_FACT'));
    assert.ok(!prompt.includes(caption));
  }
  const edited = await renderingPrompt(project, project.pages[1]);
  assert.equal(block(edited, 'authoritative-text').title, '修改后的图内标题');
  assert.equal(block(edited, 'authoritative-text').body, '这段文字已经更新。');
});

test('legacy works have deterministic shared style fallback and distinct single-page modes', async () => {
  for (const style of styles) {
    const pages = planInput().pages.map((page, index) => ({ ...page, id: `page-${index + 1}` }));
    const project = { mode: 'cards', style: style.id, aspect: '3:4', count: 2, pages };
    const first = await renderingPrompt(project, pages[0]), second = await renderingPrompt(project, pages[1]);
    const shared = block(first, 'series-visual-system');
    assert.ok(Array.isArray(shared.palette) && shared.palette.length > 0);
    assert.deepEqual(block(second, 'series-visual-system'), shared);
    assert.deepEqual(block(first, 'authoritative-text'), { title: pages[0].title, body: pages[0].content });
  }
  const page = { ...planInput().pages[0], id: 'single' };
  const common = { style: 'notion', aspect: '1:1', count: 1, pages: [page] };
  const cover = await renderingPrompt({ ...common, mode: 'cover' }, page);
  const infographic = await renderingPrompt({ ...common, mode: 'infographic' }, page);
  assert.notEqual(cover, infographic);
  assert.deepEqual(block(cover, 'authoritative-text'), block(infographic, 'authoritative-text'));
  for (const mode of ['cover', 'infographic', 'cards']) {
    const messages = await planningMessages({ ...common, mode, source: '把同一份真实材料整理成图文。' });
    assert.equal(messages[0].role, 'system');
    assert.ok(messages[0].content.includes('visualSystem') && messages[0].content.includes('missingFacts') && messages[0].content.includes('planningNotes'));
    assert.match(messages.at(-1).content, /页数[：:]\s*1/);
  }
});

test('creation and page-only edits persist the visual system without leaking planning notes into publishable output', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-quality-test-'));
  const port = 19511, base = `http://127.0.0.1:${port}`;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=';
  const secret = 'quality-test-local-mock-key';
  let child, log = '', badPlan = false, chatOutput, textCalls = 0, planCalls = 0, imageCalls = 0;
  const imagePrompts = [], editRequests = [];
  const upstream = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/images/generations') {
        imageCalls++; imagePrompts.push(body.prompt);
        return res.end(JSON.stringify({ data: [{ b64_json: png }] }));
      }
      if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('{}'); }
      textCalls++;
      const system = body.messages?.[0]?.content || '';
      let result;
      if (system.includes('聊天修改助手')) { editRequests.push(body.messages); result = chatOutput; }
      else {
        assert.ok(system.includes('中文图文内容策划与视觉导演'));
        planCalls++;
        const count = Number(body.messages.at(-1)?.content.match(/页数[：:]\s*(\d+)/)?.[1]);
        assert.ok(Number.isInteger(count) && count > 0);
        result = planInput({ visualSystem, planningNotes: badPlan ? '注'.repeat(2001) : notes, missingFacts }, count);
      }
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    } catch { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'local quality mock error' } })); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`;
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    return { response, value };
  }
  async function waitProject(id) {
    for (let i = 0; i < 300; i++) {
      const { response, value } = await request(`/api/projects/${id}`);
      assert.equal(response.status, 200);
      if (!['analyzing', 'generating'].includes(value.project.status) && !['thinking', 'analyzing', 'generating'].includes(value.project.chatStatus)) return value.project;
      await sleep(20);
    }
    assert.fail('mock quality task did not settle');
  }
  async function chat(project, message, output, requestId = randomUUID()) {
    chatOutput = output;
    const result = await request(`/api/projects/${project.id}/chat`, { requestId, message });
    assert.equal(result.response.status, 202);
    return waitProject(project.id);
  }
  t.after(async () => {
    if (child?.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await stopped; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dir, TRENDS_AUTO_REFRESH: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) assert.fail(log);
    try { if ((await request('/api/config')).response.ok) break; } catch {}
    if (i === 99) assert.fail(`mock service did not start: ${log}`);
    await sleep(30);
  }
  const configured = await request('/api/config', {
    text: { baseUrl: upstreamBase, model: 'quality-text', apiKey: secret },
    image: { baseUrl: upstreamBase, model: 'quality-image', apiKey: secret, mode: 'images', size: 'auto' },
  }, 'PUT');
  assert.equal(configured.response.status, 200);
  const input = { requestId: randomUUID(), source: '根据真实工作场景，给职场新人做三张办公提效知识图文。', mode: 'cards', style: 'warm', aspect: '3:4', count: 3 };
  const created = await request('/api/brief/create', input);
  assert.equal(created.response.status, 202);
  let project = await waitProject(created.value.project.id);
  assert.equal(project.status, 'completed'); assert.equal(project.caption, caption);
  assert.equal(textCalls, 1); assert.equal(planCalls, 1); assert.equal(imageCalls, 3);
  assert.deepEqual(project.visualSystem, visualSystem); assert.equal(project.planningNotes, notes); assert.deepEqual(project.missingFacts, missingFacts);
  const stored = JSON.parse(await readFile(path.join(dir, 'projects', project.id, 'project.json'), 'utf8'));
  assert.deepEqual(stored.visualSystem, visualSystem);
  assert.equal(stored.caption, caption);
  const assistant = project.chatMessages.filter(item => item.role === 'assistant').map(item => item.content).join('\n');
  assert.ok(assistant.includes('QUALITY_ONLY_NOTE') && assistant.includes('QUALITY_ONLY_FACT'));
  for (const prompt of imagePrompts) {
    assert.deepEqual(block(prompt, 'series-visual-system'), visualSystem);
    assert.ok(!prompt.includes('QUALITY_ONLY_NOTE') && !prompt.includes('QUALITY_ONLY_FACT'));
    assert.ok(!prompt.includes(caption));
  }
  const replay = await request('/api/brief/create', input);
  assert.equal(replay.value.project.id, project.id);
  assert.equal(textCalls, 1); assert.equal(imageCalls, 3);

  const originalUrls = project.pages.map(page => page.imageUrl);
  project = await chat(project, '优化帖子正文，保持标题和图片不变。', { action: 'update_post', reply: '已整理为可直接发布的正文。', caption: '先做好一件小事，再把结果检查一遍。' });
  assert.equal(project.caption, '先做好一件小事，再把结果检查一遍。');
  assert.deepEqual(project.pages.map(page => page.imageUrl), originalUrls);
  assert.equal(textCalls, 2); assert.equal(imageCalls, 3); assert.equal(planCalls, 1);
  assert.ok(editRequests[0][0].content.includes(visualSystem.typography));

  const page = project.pages[1];
  project = await chat(project, '优化第2张的图片提示词，保持标题和图上文字不变。', { action: 'revise_pages', reply: '已调整第2张的画面描述。', pages: [{ id: page.id, prompt: '将主图放在右侧，左侧使用对齐文字区和充分留白。' }] });
  assert.equal(textCalls, 3); assert.equal(imageCalls, 4); assert.equal(planCalls, 1);
  assert.deepEqual(project.visualSystem, visualSystem);
  assert.equal(project.pages[0].imageUrl, originalUrls[0]); assert.equal(project.pages[2].imageUrl, originalUrls[2]);
  assert.notEqual(project.pages[1].imageUrl, originalUrls[1]);
  assert.deepEqual(block(imagePrompts.at(-1), 'series-visual-system'), visualSystem);
  assert.deepEqual(block(imagePrompts.at(-1), 'authoritative-text'), { title: page.title, body: page.content });
  assert.equal(project.chatMessages.at(-1).role, 'assistant');
  assert.ok(!project.chatMessages.at(-1).content.includes('QUALITY_ONLY_NOTE') && !project.chatMessages.at(-1).content.includes('QUALITY_ONLY_FACT'), 'ordinary page redraws must not repeat planning explanations');

  badPlan = true;
  const failed = await request('/api/brief/create', { ...input, source: '给职场新人做两张办公提效知识图文。', count: 2, requestId: randomUUID() });
  assert.equal(failed.response.status, 202);
  const rejected = await waitProject(failed.value.project.id);
  assert.equal(rejected.status, 'error');
  assert.equal(imageCalls, 4, 'invalid metadata must stop before any image generation');
  assert.equal(textCalls, 4, 'schema rejection must not automatically repeat billed text requests');

  badPlan = false;
  const retryRequestId = randomUUID(), beforeRetry = { textCalls, planCalls, imageCalls };
  const retried = await chat(rejected, '重试这次创作', { action: 'regenerate', reply: '重新完成内容策划并生成两张图片。', pageIds: [] }, retryRequestId);
  assert.equal(retried.status, 'completed');
  assert.equal(retried.pages.length, 2);
  assert.equal(retried.caption, caption, 'retry planning must still store only publishable text in caption');
  assert.equal(imageCalls, beforeRetry.imageCalls + 2, 'an explicit replan renders exactly the requested two pages');
  assert.equal(textCalls, beforeRetry.textCalls + 2, 'retry uses one intent request and one planning request');
  assert.equal(planCalls, beforeRetry.planCalls + 1, 'only the explicit retry launches a new plan');
  const retryReplies = retried.chatMessages.filter(item => item.role === 'assistant' && item.requestId === retryRequestId);
  assert.equal(retryReplies.length, 1);
  assert.ok(retryReplies[0].content.includes('QUALITY_ONLY_NOTE') && retryReplies[0].content.includes('QUALITY_ONLY_FACT'), 'the successful retry reply must expose planning notes and missing facts');
  assert.ok(!retried.caption.includes('QUALITY_ONLY_NOTE') && !retried.caption.includes('QUALITY_ONLY_FACT'));
  for (const prompt of imagePrompts.slice(-2)) {
    assert.deepEqual(block(prompt, 'series-visual-system'), visualSystem);
    assert.ok(!prompt.includes('QUALITY_ONLY_NOTE') && !prompt.includes('QUALITY_ONLY_FACT'));
  }
});
