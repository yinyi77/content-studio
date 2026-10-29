import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// All model calls in this suite are served by a local mock. No credentials,
// production data, browser sessions, or external model APIs are used.
const root = fileURLToPath(new URL('..', import.meta.url));
const base = 'http://127.0.0.1:19483';
const secret = 'test-only-secret-must-not-leak';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=', 'base64');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function request(route, options = {}) {
  const { method = 'GET', body, origin = base, headers = {} } = options;
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = null; }
  return { res, raw, json };
}

async function settled(id) {
  for (let i = 0; i < 150; i++) {
    const result = await request(`/api/projects/${id}`);
    assert.equal(result.res.status, 200, result.raw);
    const project = result.json.project;
    if (!['analyzing', 'generating'].includes(project.status)) return project;
    await sleep(50);
  }
  assert.fail(`Project ${id} did not settle`);
}

test('local content studio: mocked end-to-end workflow and isolation', { timeout: 45_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'content-studio-test-'));
  let child, childLog = '', upstreamUrl;
  let imageCalls = 0, textCalls = 0, imageMode = 'base64', imageFails = false, textFails = false, imageDelay = 0;
  let downloadAuth = null;
  const incoming = [];
  const upstream = createServer(async (req, res) => {
    try {
      if (req.url === '/asset.png') {
        downloadAuth = req.headers.authorization || null;
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(png);
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      incoming.push({ path: req.url, body, authorization: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'text-test' }, { id: 'image-test' }] }));
        return;
      }
      if (req.url === '/v1/images/generations' || (req.url === '/v1/chat/completions' && body.model === 'image-test')) {
        imageCalls++;
        if (imageDelay) await sleep(imageDelay);
        if (imageFails) {
          res.statusCode = 429;
          res.end(JSON.stringify({ error: { message: `mock quota reached ${secret}` } }));
          return;
        }
        if (req.url.endsWith('/chat/completions')) {
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `![generated](${upstreamUrl}/asset.png)` } }] }));
          return;
        }
        const image = imageMode === 'url' ? { url: `${upstreamUrl}/asset.png` } : { b64_json: png.toString('base64') };
        res.end(JSON.stringify({ data: [image] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        textCalls++;
        if (textFails) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: { message: `mock invalid credential ${secret}` } }));
          return;
        }
        const user = body.messages?.at(-1)?.content || '';
        const count = Number(user.match(/页数[：:]\s*(\d+)/)?.[1]) || 1;
        const plan = {
          title: '测试作品', caption: '这是一段由测试上游返回的发布文案。',
          pages: Array.from({ length: count }, (_, i) => ({ title: `第 ${i + 1} 页`, content: `准确中文内容 ${i + 1}`, prompt: `制作中文图文，展示第 ${i + 1} 页与准确中文内容 ${i + 1}。` })),
        };
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(plan) } }] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `Unexpected mock endpoint: ${req.url}` } }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  async function start() {
    childLog = '';
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: root, env: { ...process.env, PORT: '19483', DATA_DIR: dataDir, TRENDS_AUTO_REFRESH: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', b => { childLog += b; });
    child.stderr.on('data', b => { childLog += b; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) assert.fail(`Server exited early: ${childLog}`);
      try { if ((await request('/api/config')).res.ok) return; } catch { /* waiting for bind */ }
      await sleep(40);
    }
    assert.fail(`Server failed to start: ${childLog}`);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await stopped;
  }
  t.after(async () => {
    await stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  await start();

  let projectId;
  await t.test('configuration persists but never returns API keys; model discovery works', async () => {
    const config = {
      text: { baseUrl: `${upstreamUrl}/v1`, model: 'text-test', apiKey: secret },
      image: { baseUrl: `${upstreamUrl}/v1`, model: 'image-test', apiKey: secret, mode: 'images', size: '1024x1536' },
    };
    const saved = await request('/api/config', { method: 'PUT', body: config });
    assert.equal(saved.res.status, 200, saved.raw);
    assert.ok(!saved.raw.includes(secret));
    const read = await request('/api/config');
    assert.equal(read.json.text.hasKey, true);
    assert.equal(read.json.image.hasKey, true);
    assert.equal(read.json.configured, true);
    assert.ok(!read.raw.includes(secret));
    const models = await request('/api/models?kind=text');
    assert.equal(models.res.status, 200, models.raw);
    assert.ok(models.json.models.includes('text-test'));
  });

  await t.test('cross-site writes and invalid inputs are rejected', async () => {
    const cross = await request('/api/config', { method: 'PUT', origin: 'https://untrusted.example', body: {} });
    assert.equal(cross.res.status, 403, cross.raw);
    const empty = await request('/api/projects', { method: 'POST', body: { source: '', mode: 'cards', style: 'notion', aspect: '3:4', count: 3 } });
    assert.ok(empty.res.status >= 400 && empty.res.status < 500, empty.raw);
    const secretFile = await request('/data/config.json');
    assert.ok(!secretFile.raw.includes(secret));
    const config = (await request('/api/config')).json;
    const replaced = await request('/api/config', { method: 'PUT', body: {
      text: { ...config.text, baseUrl: 'https://another-proxy.example/v1' }, image: config.image,
    } });
    assert.equal(replaced.res.status, 400, replaced.raw);
    assert.match(replaced.json.error, /重新输入.*API Key/);
    assert.equal((await request('/api/config')).json.text.baseUrl, `${upstreamUrl}/v1`);
  });

  await t.test('new project plans asynchronously; edited text remains authoritative', async () => {
    const created = await request('/api/projects', { method: 'POST', body: { source: '为产品经理介绍 AI 员工如何辅助内容创作。', mode: 'cards', style: 'notion', aspect: '3:4', count: 2 } });
    assert.ok(created.res.ok, created.raw);
    projectId = created.json.project.id;
    const project = await settled(projectId);
    assert.equal(project.status, 'draft', JSON.stringify(project));
    assert.equal(project.pages.length, 2);
    assert.ok(textCalls > 0);
    project.pages[0].content = '用户编辑后的唯一权威文案';
    const changed = await request(`/api/projects/${projectId}`, { method: 'PATCH', body: { title: '编辑后的作品', caption: '人工确认后的发布文案', pages: project.pages } });
    assert.equal(changed.res.status, 200, changed.raw);
    assert.equal(changed.json.project.pages[0].content, '用户编辑后的唯一权威文案');
  });

  await t.test('base64 images are saved; completed pages do not regenerate in bulk; ZIP is valid', async () => {
    const started = await request(`/api/projects/${projectId}/generate`, { method: 'POST', body: {} });
    assert.ok(started.res.ok, started.raw);
    const project = await settled(projectId);
    assert.equal(project.status, 'completed', JSON.stringify(project));
    assert.equal(project.pages.filter(p => p.status === 'done').length, 2);
    const call = incoming.find(c => c.path === '/v1/images/generations');
    assert.ok(call.body.prompt.includes('用户编辑后的唯一权威文案'));
    const imageRes = await fetch(`${base}${project.pages[0].imageUrl}`);
    assert.equal(imageRes.status, 200);
    assert.deepEqual(Buffer.from(await imageRes.arrayBuffer()), png);
    const before = imageCalls;
    await request(`/api/projects/${projectId}/generate`, { method: 'POST', body: {} });
    await settled(projectId);
    assert.equal(imageCalls, before, 'Completed images were regenerated without requesting it');
    const archiveRes = await fetch(`${base}/api/projects/${projectId}/export.zip`);
    assert.equal(archiveRes.status, 200);
    const archive = Buffer.from(await archiveRes.arrayBuffer());
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
    assert.ok(archive.includes(png));
    assert.ok(!archive.includes(Buffer.from(secret)));
  });

  await t.test('single-page retry accepts remote images without forwarding credentials', async () => {
    imageMode = 'url';
    const project = (await request(`/api/projects/${projectId}`)).json.project;
    const before = imageCalls;
    const retried = await request(`/api/projects/${projectId}/generate`, { method: 'POST', body: { pageId: project.pages[1].id } });
    assert.ok(retried.res.ok, retried.raw);
    const result = await settled(projectId);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(imageCalls, before + 1);
    assert.equal(downloadAuth, null, 'API key was forwarded to an image download URL');
  });

  await t.test('provider errors are visible, secret-free, and recoverable', async () => {
    imageFails = true;
    const project = (await request(`/api/projects/${projectId}`)).json.project;
    await request(`/api/projects/${projectId}/generate`, { method: 'POST', body: { pageId: project.pages[1].id } });
    const failed = await settled(projectId);
    assert.ok(['partial', 'error'].includes(failed.status), JSON.stringify(failed));
    assert.ok(failed.pages.some(p => p.status === 'error'));
    assert.ok(!JSON.stringify(failed).includes(secret), 'Provider error leaked an API key');
    imageFails = false;
    await request(`/api/projects/${projectId}/generate`, { method: 'POST', body: {} });
    assert.equal((await settled(projectId)).status, 'completed');
  });

  await t.test('failed content analysis can be retried without exposing credentials', async () => {
    textFails = true;
    const created = await request('/api/projects', { method: 'POST', body: { source: '这是一份用于验证分析失败恢复的信息图内容。', mode: 'infographic', style: 'minimal', aspect: '1:1', count: 1 } });
    assert.ok(created.res.ok, created.raw);
    const id = created.json.project.id;
    const failed = await settled(id);
    assert.equal(failed.status, 'error');
    assert.ok(!JSON.stringify(failed).includes(secret));
    textFails = false;
    const retry = await request(`/api/projects/${id}/analyze`, { method: 'POST', body: {} });
    assert.ok(retry.res.ok, retry.raw);
    const recovered = await settled(id);
    assert.equal(recovered.status, 'draft');
    assert.equal(recovered.pages.length, 1);
    await request(`/api/projects/${id}`, { method: 'DELETE' });
  });

  await t.test('chat image endpoint is supported independently of text generation', async () => {
    const config = (await request('/api/config')).json;
    const saved = await request('/api/config', { method: 'PUT', body: { text: config.text, image: { ...config.image, mode: 'chat' } } });
    assert.equal(saved.res.status, 200, saved.raw);
    const project = (await request(`/api/projects/${projectId}`)).json.project;
    const before = imageCalls;
    await request(`/api/projects/${projectId}/generate`, { method: 'POST', body: { pageId: project.pages[0].id } });
    assert.equal((await settled(projectId)).status, 'completed');
    assert.equal(imageCalls, before + 1);
    assert.ok(incoming.some(c => c.path === '/v1/chat/completions' && c.body.model === 'image-test'));
  });

  await t.test('editing a completed page invalidates its old image while preserving untouched pages', async () => {
    const project = (await request(`/api/projects/${projectId}`)).json.project;
    const untouchedUrl = project.pages[1].imageUrl;
    project.pages[0].content = '生成后再次编辑的中文文案';
    const changed = await request(`/api/projects/${projectId}`, { method: 'PATCH', body: { pages: project.pages } });
    assert.equal(changed.res.status, 200, changed.raw);
    assert.equal(changed.json.project.status, 'draft');
    assert.equal(changed.json.project.pages[0].status, 'pending');
    assert.equal(changed.json.project.pages[0].imageUrl, null);
    assert.equal(changed.json.project.pages[1].imageUrl, untouchedUrl);
    const before = imageCalls;
    await request(`/api/projects/${projectId}/generate`, { method: 'POST', body: {} });
    assert.equal((await settled(projectId)).status, 'completed');
    assert.equal(imageCalls, before + 1);
  });

  await t.test('overlapping generation requests do not issue duplicate billed calls', async () => {
    const project = (await request(`/api/projects/${projectId}`)).json.project;
    const before = imageCalls;
    imageDelay = 120;
    const results = await Promise.all([1, 2].map(() => request(`/api/projects/${projectId}/generate`, { method: 'POST', body: { pageId: project.pages[0].id } })));
    assert.deepEqual(results.map(r => r.res.status).sort(), [202, 409], 'Overlapping requests should accept one job and reject the other');
    assert.equal((await settled(projectId)).status, 'completed');
    imageDelay = 0;
    assert.equal(imageCalls, before + 1);
  });

  await t.test('restart restores work and marks interrupted jobs without repeating paid calls', async () => {
    await stop();
    const file = path.join(dataDir, 'projects', projectId, 'project.json');
    const project = JSON.parse(await readFile(file, 'utf8'));
    project.status = 'generating';
    project.pages[1].status = 'generating';
    await writeFile(file, JSON.stringify(project));
    const beforeImages = imageCalls, beforeText = textCalls;
    await start();
    const restored = (await request(`/api/projects/${projectId}`)).json.project;
    assert.equal(restored.status, 'interrupted', JSON.stringify(restored));
    assert.notEqual(restored.pages[1].status, 'generating');
    assert.equal(imageCalls, beforeImages);
    assert.equal(textCalls, beforeText);
    const config = await request('/api/config');
    assert.equal(config.json.text.hasKey, true);
    assert.ok(!config.raw.includes(secret));
  });

  await t.test('delete removes history and artifacts', async () => {
    const deleted = await request(`/api/projects/${projectId}`, { method: 'DELETE' });
    assert.equal(deleted.res.status, 200, deleted.raw);
    const history = await request('/api/projects');
    assert.ok(!history.json.projects.some(p => p.id === projectId));
    assert.equal((await request(`/api/projects/${projectId}`)).res.status, 404);
  });
});
