import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_STYLES, STYLE_CATEGORIES } from '../public/style-catalog.js';
import { STYLE_PRESETS } from '../lib/style-presets.mjs';
import { styles, styleReference, planningMessages, renderingPrompt } from '../lib/prompts.mjs';
import { normalizeBriefRequest, briefingMessages, parseBriefingResponse } from '../lib/briefing.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const legacy = {
  notion: '手绘知识', editorial: '杂志编辑', warm: '温暖生活',
  bold: '醒目海报', blueprint: '工程蓝图', minimal: '极简留白',
};
const added = ['photo', 'cinematic', 'watercolor', 'ink', 'retro', 'collage', 'papercut', 'flat', 'comic', 'anime', 'clay3d', 'isometric', 'cyberpunk', 'pixel'];
const expectedIds = [...Object.keys(legacy), ...added].sort();
const blank = () => ({ style: null, aspect: null, count: null, mode: null });
const topic = '根据真实资料制作一组城市散步指南。';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = style => ({
  analysis: '用出发、慢走和停留组织这组内容。', reply: '采用你明确选择的风格。', source: topic,
  preferences: { ...blank(), style },
  recommendations: { style: 'notion', aspect: '3:4', count: 3, mode: 'cards' },
  reasons: { style: '遵循用户明确的视觉偏好。', aspect: '竖版适合手机阅读。', count: '用三张图展示内容。' },
});

function visualBlock(prompt) {
  const match = prompt.match(/<series-visual-system>\s*([\s\S]*?)\s*<\/series-visual-system>/);
  assert.ok(match, 'the model must receive an explicit shared visual system');
  return JSON.parse(match[1]);
}
function presetVisual(id) {
  const preset = STYLE_PRESETS[id];
  return Object.fromEntries(['palette', 'typography', 'illustration', 'layout'].map(key => [key, preset[key]]));
}

test('the shared style catalog adds distinct media while preserving all existing style IDs', () => {
  assert.equal(IMAGE_STYLES.length, 20);
  assert.deepEqual(IMAGE_STYLES.map(item => item.id).sort(), expectedIds);
  assert.equal(new Set(IMAGE_STYLES.map(item => item.id)).size, 20);
  assert.deepEqual(styles, IMAGE_STYLES, 'server and browser style names must come from one shared catalog');
  assert.equal(STYLE_CATEGORIES.length, 5);
  assert.equal(new Set(STYLE_CATEGORIES).size, 5);
  assert.deepEqual([...new Set(IMAGE_STYLES.map(item => item.category))].sort(), [...STYLE_CATEGORIES].sort());
  for (const [id, name] of Object.entries(legacy)) assert.equal(IMAGE_STYLES.find(item => item.id === id)?.name, name);
  for (const item of IMAGE_STYLES) {
    assert.match(item.id, /^[a-z][a-z0-9]*$/);
    assert.ok(typeof item.name === 'string' && item.name.trim());
    assert.ok(typeof item.description === 'string' && item.description.trim());
    assert.ok(STYLE_CATEGORIES.includes(item.category));
    if (added.includes(item.id)) assert.ok(Array.isArray(item.aliases) && item.aliases.length > 0, `${item.id} needs searchable natural-language aliases`);
    if (item.aliases) assert.ok(item.aliases.every(alias => typeof alias === 'string' && alias.trim()));
  }
});

test('new styles survive briefing validation, confirmed-choice merging and model-visible discovery', () => {
  for (const item of IMAGE_STYLES) {
    const request = normalizeBriefRequest({ messages: [{ role: 'user', content: topic }], preferences: { ...blank(), style: item.id } });
    assert.equal(request.preferences.style, item.id);
    const parsed = parseBriefingResponse(JSON.stringify(fixture(item.id)), {});
    assert.equal(parsed.preferences.style, item.id);
    assert.equal(parsed.recommendations.style, item.id, 'a generic model recommendation must not override the chosen new style');
    const nullDelta = fixture(null);
    assert.equal(parseBriefingResponse(JSON.stringify(nullDelta), { ...blank(), style: item.id }).preferences.style, item.id);
  }
  const messages = briefingMessages(normalizeBriefRequest({ messages: [{ role: 'user', content: topic }], preferences: blank() }));
  const instructions = messages[0].content;
  for (const item of IMAGE_STYLES) {
    assert.ok(instructions.includes(item.id) && instructions.includes(item.name), `${item.id} is discoverable by the text model`);
    assert.ok(instructions.includes(item.category), `${item.id} category reaches the text model`);
    if (added.includes(item.id)) assert.ok(instructions.includes(item.aliases[0]), `${item.id} aliases reach the text model`);
  }
});

test('every style loads real design guidance and renders the corresponding stable preset across pages', async () => {
  for (const item of IMAGE_STYLES) {
    const preset = STYLE_PRESETS[item.id];
    assert.ok(preset, `missing preset for ${item.id}`);
    assert.ok(Array.isArray(preset.palette) && preset.palette.length >= 1 && preset.palette.length <= 6);
    assert.ok(preset.palette.every(color => typeof color === 'string' && color.trim() && color.length <= 100));
    for (const key of ['typography', 'illustration', 'layout']) assert.ok(typeof preset[key] === 'string' && preset[key].trim() && preset[key].length <= 600, `${item.id}.${key}`);
    const reference = await styleReference(item.id);
    assert.ok(typeof reference === 'string' && reference.trim().length > 100, `${item.id} must have usable visual rules`);
    if (added.includes(item.id)) {
      assert.equal(reference, preset.reference);
      assert.notDeepEqual(presetVisual(item.id), presetVisual('notion'), `${item.id} must not silently fall back to a hand-drawn preset`);
    }
    const pages = [1, 2].map(index => ({ id: `page-${index}`, title: `真实内容 ${index}`, content: `清晰易读的图上文字 ${index}。`, prompt: `为第 ${index} 页保留独立文字区和清楚构图。` }));
    const project = { mode: 'cards', style: item.id, aspect: '3:4', count: 2, pages, source: topic };
    const first = await renderingPrompt(project, pages[0]), second = await renderingPrompt(project, pages[1]);
    assert.deepEqual(visualBlock(first), presetVisual(item.id));
    assert.deepEqual(visualBlock(second), presetVisual(item.id));
    assert.ok(first.includes(reference) && second.includes(reference));
    const plan = await planningMessages(project);
    assert.ok(plan[0].content.includes(reference), `${item.id} guidance must reach the planner as well as the renderer`);
  }
  assert.notDeepEqual(presetVisual('photo'), presetVisual('comic'));
  assert.notEqual(await styleReference('photo'), await styleReference('comic'));
});

test('unknown or path-like style IDs fail validation instead of becoming filesystem paths', async () => {
  for (const style of ['unknown-style', '../README', '../../server', '/etc/passwd', 'toString', '__proto__', '']) {
    await assert.rejects(() => styleReference(style), error => error.status === 400, String(style));
    assert.throws(() => normalizeBriefRequest({ messages: [{ role: 'user', content: topic }], preferences: { ...blank(), style } }), error => error.status === 400);
  }
  await assert.rejects(() => styleReference(null), error => error.status === 400);
  assert.equal(normalizeBriefRequest({ messages: [{ role: 'user', content: topic }], preferences: blank() }).preferences.style, null, 'an unchosen preference remains valid in a briefing');
  const badModel = fixture('../../server');
  assert.throws(() => parseBriefingResponse(JSON.stringify(badModel), {}), error => error.status === 502);
});

test('HTTP creation accepts a new photographic style and sends its rules to the image model', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'content-studio-style-test-'));
  const port = 19512, base = `http://127.0.0.1:${port}`;
  const key = 'style-test-local-key-never-expose';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=';
  let child, log = '', textCalls = 0, imageCalls = 0;
  const receivedPrompts = [];
  const upstream = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/images/generations') {
        imageCalls++; receivedPrompts.push(body.prompt);
        return res.end(JSON.stringify({ data: [{ b64_json: png }] }));
      }
      if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('{}'); }
      textCalls++;
      const count = Number(body.messages?.at(-1)?.content.match(/页数[：:]\s*(\d+)/)?.[1]);
      assert.ok(Number.isInteger(count) && count > 0);
      const output = { title: '在城市里慢慢走', caption: '沿着熟悉的街道走一段，留意身边的光与生活。', pages: Array.from({ length: count }, (_, index) => ({ title: `散步片段 ${index + 1}`, content: '给自己留一点慢下来的时间。', prompt: '自然日光下的真实城市街景摄影，为中文文字保留干净区域。' })) };
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
    } catch { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'local style mock failed' } })); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`;
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch {}
    return { response, raw, value };
  }
  async function settled(id) {
    for (let index = 0; index < 250; index++) {
      const result = await request(`/api/projects/${id}`);
      assert.equal(result.response.status, 200, result.raw);
      const project = result.value.project;
      if (!['analyzing', 'generating'].includes(project.status) && !['thinking', 'analyzing', 'generating'].includes(project.chatStatus)) return project;
      await sleep(20);
    }
    assert.fail('the local photographic style job did not finish');
  }
  t.after(async () => {
    if (child?.exitCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, TRENDS_AUTO_REFRESH: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { log += bytes; }); child.stderr.on('data', bytes => { log += bytes; });
  for (let index = 0; index < 100; index++) {
    if (child.exitCode !== null) assert.fail(`Local test server exited: ${log}`);
    try { if ((await request('/api/config')).response.ok) break; } catch {}
    if (index === 99) assert.fail(`Local test server failed to start: ${log}`);
    await sleep(30);
  }
  const config = await request('/api/config');
  assert.deepEqual(config.value.styles.map(item => item.id).sort(), expectedIds);
  const module = await request('/style-catalog.js');
  assert.equal(module.response.status, 200);
  assert.match(module.response.headers.get('content-type'), /javascript/);
  assert.ok(module.raw.includes('IMAGE_STYLES') && module.raw.includes('photo'));
  const configured = await request('/api/config', { text: { baseUrl: upstreamBase, model: 'style-text', apiKey: key }, image: { baseUrl: upstreamBase, model: 'style-image', apiKey: key, mode: 'images', size: 'auto' } }, 'PUT');
  assert.equal(configured.response.status, 200, configured.raw);
  assert.ok(!configured.raw.includes(key));
  const input = { requestId: randomUUID(), source: topic, style: 'photo', mode: 'cards', aspect: '3:4', count: 2 };
  const created = await request('/api/brief/create', input);
  assert.equal(created.response.status, 202, created.raw);
  const project = await settled(created.value.project.id);
  assert.equal(project.style, 'photo'); assert.equal(project.status, 'completed'); assert.equal(project.pages.length, 2);
  assert.equal(textCalls, 1); assert.equal(imageCalls, 2);
  assert.ok(project.pages.every(page => page.imageUrl && page.status === 'done'));
  for (const prompt of receivedPrompts) {
    assert.ok(prompt.includes(STYLE_PRESETS.photo.reference));
    assert.deepEqual(visualBlock(prompt), presetVisual('photo'));
  }
  const replay = await request('/api/brief/create', input);
  assert.equal(replay.response.status, 202); assert.equal(replay.value.project.id, project.id);
  assert.equal(textCalls, 1); assert.equal(imageCalls, 2);
  const invalid = await request('/api/brief/create', { ...input, requestId: randomUUID(), style: '../../README' });
  assert.equal(invalid.response.status, 400);
  assert.equal(textCalls, 1); assert.equal(imageCalls, 2);
});
