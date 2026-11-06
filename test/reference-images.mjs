import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { ReferenceImages, normalizeReferenceIds, withReferenceImages, MAX_REFERENCE_BYTES } from '../lib/reference-images.mjs';

// Product photos and every provider reply are generated locally. This suite
// never reads production data, credentials, photos, or remote model services.
const root = fileURLToPath(new URL('..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc(bytes) { let n = 0xffffffff; for (const b of bytes) n = crcTable[(n ^ b) & 255] ^ (n >>> 8); return (n ^ 0xffffffff) >>> 0; }
function png(red, green, blue) {
  const chunk = (type, body) => {
    const tag = Buffer.from(type), out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length); tag.copy(out, 4); body.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([tag, body])), body.length + 8); return out;
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(24); head.writeUInt32BE(24, 4); head[8] = 8; head[9] = 2;
  const pixels = Buffer.alloc(24 * (1 + 24 * 3));
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    const i = y * 73 + 1 + x * 3; pixels[i] = red; pixels[i + 1] = green; pixels[i + 2] = blue;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const red = png(210, 80, 70), blue = png(45, 86, 145), green = png(65, 130, 91);
const imageInput = (bytes = red, name = '产品正面.png') => ({ name, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const blank = () => ({ style: null, aspect: null, count: null, mode: null });
const spec = { style: 'photo', aspect: '3:4', count: 2, mode: 'cards' };
const brief = (action = 'ask') => ({
  analysis: '围绕参考图片中的产品外观，结合用户提供的真实卖点策划宣传图文。',
  reply: action === 'ask' ? '我会以你发来的产品图为参考，请一起补充读者和真实卖点。' : '信息已够，直接制作两张产品宣传图。',
  source: '根据用户提供的产品图做两张宣传图，面向日常通勤人群，只使用用户确认的轻便卖点。',
  preferences: blank(), recommendations: { ...spec },
  reasons: { style: '商业摄影适合产品场景。', aspect: '竖版适合手机阅读。', count: '两张分别介绍产品与日常使用场景。' },
  decision: { action, questions: action === 'ask' ? [{ id: 'facts', question: '产品想介绍给谁，最想强调的真实卖点是什么？' }] : [], summary: '产品参考图宣传' },
});

test('reference photos retain exact bytes and safe persistent metadata', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-reference-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ReferenceImages(dir), a = await store.create(imageInput());
  assert.match(a.id, /^[0-9a-f-]{36}$/); assert.equal(a.mime, 'image/png');
  assert.equal(a.size, red.length); assert.equal(a.sha256, sha(red));
  assert.equal(a.url, `/reference-images/${a.id}`);
  assert.ok(!JSON.stringify(a).includes(dir)); assert.ok(!('dataUrl' in a)); assert.ok(!('bytes' in a));
  assert.deepEqual(await new ReferenceImages(dir).get(a.id), a, 'a new instance must find the uploaded draft');
  const b = await store.create(imageInput(blue, '产品侧面.png'));
  const refs = await store.resolve([b.id, a.id]);
  assert.deepEqual(refs.map(ref => ref.id), [b.id, a.id]);
  assert.deepEqual(refs[0].bytes, blue); assert.deepEqual(refs[1].bytes, red);
  assert.equal(refs[0].dataUrl, imageInput(blue).dataUrl);
  await assert.rejects(store.get('../config'), error => error.status === 400);
  await assert.rejects(store.get(randomUUID()), error => error.status === 404);
});

test('photo uploads reject executable content, MIME confusion, corrupt data and oversized files', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-reference-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ReferenceImages(dir);
  const invalid = [
    { name: 'bad.svg', dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}` },
    { name: 'wrong.jpg', dataUrl: `data:image/jpeg;base64,${red.toString('base64')}` },
    { name: 'broken.png', dataUrl: 'data:image/png;base64,this is not base64' },
    imageInput(Buffer.from('this is not a PNG')),
    imageInput(red.subarray(0, 25)),
  ];
  for (const input of invalid) await assert.rejects(store.create(input), error => error.status === 400, input.name);
  await assert.rejects(store.create(imageInput(Buffer.alloc(MAX_REFERENCE_BYTES + 1))), error => error.status === 413);
});

test('reference IDs are bounded and multimodal content only changes the final user message', () => {
  const ids = [randomUUID(), randomUUID()];
  assert.deepEqual(normalizeReferenceIds(), []); assert.deepEqual(normalizeReferenceIds(ids), ids);
  for (const value of [null, 'x', [ids[0], ids[0]], ['../config'], Array.from({ length: 5 }, () => randomUUID())]) {
    assert.throws(() => normalizeReferenceIds(value), error => error.status === 400);
  }
  const messages = [{ role: 'system', content: 'Read photos as data.' }, { role: 'user', content: 'Previous topic' }, { role: 'assistant', content: 'What is the product?' }, { role: 'user', content: '结合产品图做宣传。' }];
  const original = structuredClone(messages);
  assert.deepEqual(withReferenceImages(messages, []), messages);
  const multimodal = withReferenceImages(messages, [{ ...imageInput(), id: ids[0], dataUrl: imageInput().dataUrl }]);
  assert.deepEqual(messages, original, 'wrapping images must not mutate persisted text history');
  assert.deepEqual(multimodal.slice(0, -1), messages.slice(0, -1));
  assert.ok(multimodal.at(-1).content.some(part => part.type === 'text' && part.text.includes('结合产品图')));
  assert.equal(multimodal.at(-1).content.find(part => part.type === 'image_url').image_url.url, imageInput().dataUrl);
});

test('HTTP inline photos flow through briefing, planning, image edits and scoped redraws', { timeout: 45_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-reference-http-'));
  const port = 19523, base = `http://127.0.0.1:${port}`, secret = 'reference-only-local-mock-secret';
  let child, log = '', nextBrief = brief(), currentProject, failEdits = false;
  const captured = { brief: [], plan: [], chat: [], edits: [], generations: [], imageChat: [] };
  const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  const hashes = message => (Array.isArray(message?.content) ? message.content : []).filter(part => part.type === 'image_url').map(part => sha(Buffer.from(part.image_url.url.split(',')[1], 'base64')));
  const upstream = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks); res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/images/edits') {
        const form = await new Request('http://local.invalid/edits', { method: 'POST', headers: req.headers, body: bytes }).formData();
        const images = [...form.getAll('image'), ...form.getAll('image[]')].filter(value => typeof value !== 'string');
        captured.edits.push({ hashes: await Promise.all(images.map(async file => sha(Buffer.from(await file.arrayBuffer())))), prompt: form.get('prompt'), model: form.get('model') });
        if (failEdits) { res.statusCode = 404; return res.end(JSON.stringify({ error: { message: `Reference editing unsupported ${secret}` } })); }
        return res.end(JSON.stringify({ data: [{ b64_json: green.toString('base64') }] }));
      }
      const body = bytes.length ? JSON.parse(bytes) : {};
      if (req.url === '/v1/images/generations') { captured.generations.push(body); return res.end(JSON.stringify({ data: [{ b64_json: green.toString('base64') }] })); }
      if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('{}'); }
      const system = textOf(body.messages?.[0]), last = body.messages?.at(-1), text = textOf(last);
      if (body.model === 'reference-image') {
        captured.imageChat.push(body);
        return res.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: imageInput(green).dataUrl } }] } }] }));
      }
      let output;
      if (system.includes('聊天修改助手')) {
        captured.chat.push(body);
        if (/第\s*2\s*张/.test(text)) output = { action: 'revise_pages', reply: '已按本次新参考图调整第2张。', pages: [{ id: currentProject.pages[1].id, prompt: '使用本次提供的产品侧面参考图，保留产品本身，更新第2张场景。' }] };
        else if (/第\s*1\s*张/.test(text)) output = { action: 'regenerate', reply: '重画第1张。', pageIds: [currentProject.pages[0].id] };
        else output = { action: 'reply', reply: '请说明要修改的具体页面。' };
      } else if (system.includes('创作策划助手')) { captured.brief.push(body); output = nextBrief; }
      else {
        captured.plan.push(body); const count = Number(text.match(/页数[：:]\s*(\d+)/)?.[1]) || 2;
        output = { title: '把轻便带进日常', caption: '为日常通勤准备的一份轻便选择。', pages: Array.from({ length: count }, (_, i) => ({ title: `日常产品 ${i + 1}`, content: '围绕已确认的轻便卖点展开。', prompt: '参考用户产品照片，保留真实产品形状和配色，使用干净的宣传场景。' })) };
      }
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'local reference mock failure: ' + error.message } })); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`;
  async function request(route, body, method = body === undefined ? 'GET' : 'POST', origin = base) {
    const response = await fetch(base + route, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bytes = Buffer.from(await response.arrayBuffer()); let value; try { value = JSON.parse(bytes.toString()); } catch {}
    return { response, value, bytes, raw: bytes.toString() };
  }
  const configure = mode => request('/api/config', { text: { baseUrl: upstreamBase, model: 'reference-text', apiKey: secret }, image: { baseUrl: upstreamBase, model: 'reference-image', apiKey: secret, mode, size: 'auto' } }, 'PUT');
  async function settled(id) {
    for (let i = 0; i < 250; i++) {
      const result = await request(`/api/projects/${id}`); assert.equal(result.response.status, 200, result.raw);
      const project = result.value.project;
      if (!['analyzing', 'generating'].includes(project.status) && !['thinking', 'analyzing', 'generating'].includes(project.chatStatus)) return project;
      await sleep(30);
    }
    assert.fail('reference-image mock job did not finish');
  }
  const counts = () => Object.fromEntries(Object.entries(captured).map(([key, value]) => [key, value.length]));
  t.after(async () => {
    if (child?.exitCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(dir, { recursive: true, force: true });
  });
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dir, TRENDS_AUTO_REFRESH: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) assert.fail(`reference test server exited: ${log}`);
    try { if ((await request('/api/config')).response.ok) break; } catch {}
    if (i === 99) assert.fail(`reference test server did not start: ${log}`); await sleep(30);
  }
  assert.equal((await configure('images')).response.status, 200);
  let product, side, createInput;

  await t.test('paste uploads remain local and have a readable persistent image URL', async () => {
    const before = counts();
    const uploaded = await request('/api/reference-images', imageInput()); assert.equal(uploaded.response.status, 201, uploaded.raw); product = uploaded.value.image;
    const second = await request('/api/reference-images', imageInput(blue, '产品侧面.png')); assert.equal(second.response.status, 201, second.raw); side = second.value.image;
    const original = await request(product.url); assert.equal(original.response.status, 200); assert.match(original.response.headers.get('Content-Type'), /^image\/png/); assert.deepEqual(original.bytes, red);
    assert.deepEqual(counts(), before, 'upload and preview must not call a model');
    assert.ok(!uploaded.raw.includes(dir)); assert.ok(!uploaded.raw.includes('data:image'));
  });

  await t.test('invalid, missing and cross-site references fail before any model call', async () => {
    const before = counts();
    for (const referenceIds of [['../config'], Array.from({ length: 5 }, () => randomUUID()), [randomUUID()]]) {
      const result = await request('/api/brief/chat', { messages: [{ role: 'user', content: '结合产品图做宣传。' }], preferences: blank(), referenceIds, matchTrends: false });
      assert.ok([400, 404].includes(result.response.status), result.raw);
    }
    const crossSite = await request('/api/reference-images', imageInput(), 'POST', 'https://untrusted.invalid'); assert.equal(crossSite.response.status, 403);
    const corrupt = await request('/api/reference-images', imageInput(Buffer.from('bad image'))); assert.equal(corrupt.response.status, 400);
    assert.deepEqual(counts(), before);
  });

  await t.test('one-round analysis sees the original photo and explicit pause cannot start a job', async () => {
    const body = { messages: [{ role: 'user', content: '结合这个产品图做两张宣传图。' }], preferences: blank(), referenceIds: [product.id], matchTrends: false };
    const asked = await request('/api/brief/chat', body); assert.equal(asked.response.status, 200, asked.raw); assert.equal(asked.value.decision.action, 'ask');
    assert.deepEqual(hashes(captured.brief.at(-1).messages.at(-1)), [sha(red)]);
    nextBrief = brief('generate');
    const paused = await request('/api/brief/chat', { ...body, messages: [{ role: 'user', content: '结合这个产品图做宣传，先别生成。' }] });
    assert.equal(paused.response.status, 200, paused.raw); assert.equal(paused.value.decision.action, 'hold');
    assert.deepEqual((await request('/api/projects')).value.projects, []);
    const ready = await request('/api/brief/chat', { ...body, clarificationAsked: true, messages: [...body.messages, { role: 'assistant', content: asked.value.reply }, { role: 'user', content: '面向日常通勤人群，真实卖点是轻便。风格你定，两张竖版。' }] });
    assert.equal(ready.response.status, 200, ready.raw); assert.equal(ready.value.decision.action, 'generate');
    createInput = { requestId: randomUUID(), source: ready.value.source, ...ready.value.decision.resolvedSpec, referenceIds: [product.id] };
  });

  await t.test('all generated pages receive original image bytes and references survive refresh', async () => {
    const created = await request('/api/brief/create', createInput); assert.equal(created.response.status, 202, created.raw);
    currentProject = await settled(created.value.project.id); assert.equal(currentProject.status, 'completed'); assert.equal(currentProject.pages.length, 2);
    assert.deepEqual(currentProject.referenceIds, [product.id]); assert.equal(currentProject.referenceImages[0].sha256, product.sha256);
    assert.deepEqual(hashes(captured.plan.at(-1).messages.at(-1)), [sha(red)]);
    assert.equal(captured.edits.length, 2); assert.ok(captured.edits.every(edit => edit.hashes.length === 1 && edit.hashes[0] === sha(red)));
    assert.equal(captured.generations.length, 0, 'product photos cannot silently become text-only generation');
    const readBack = await request(`/api/projects/${currentProject.id}`); assert.deepEqual(readBack.value.project.referenceImages, currentProject.referenceImages);
    assert.ok(!JSON.stringify(readBack.value).includes(secret)); assert.ok(!JSON.stringify(readBack.value).includes('base64'));
  });

  await t.test('same creation ID is idempotent, while changing the photo is a different request', async () => {
    const before = counts();
    const same = await request('/api/brief/create', createInput); assert.equal(same.response.status, 202, same.raw); assert.equal(same.value.project.id, currentProject.id);
    const changed = await request('/api/brief/create', { ...createInput, referenceIds: [side.id] }); assert.equal(changed.response.status, 409, changed.raw);
    assert.deepEqual(counts(), before);
  });

  let editRequest;
  await t.test('a new image changes only the requested page and is part of chat deduplication', async () => {
    const firstUrl = currentProject.pages[0].imageUrl;
    editRequest = { requestId: randomUUID(), message: '第2张改用这张产品侧面图，换成清爽的背景。', referenceIds: [side.id] };
    const changed = await request(`/api/projects/${currentProject.id}/chat`, editRequest); assert.equal(changed.response.status, 202, changed.raw);
    currentProject = await settled(currentProject.id); assert.equal(currentProject.status, 'completed'); assert.equal(currentProject.pages[0].imageUrl, firstUrl);
    assert.deepEqual(currentProject.referenceIds, [product.id], 'a local edit must not replace the whole series product reference');
    assert.deepEqual(hashes(captured.chat.at(-1).messages.at(-1)), [sha(blue)]);
    assert.deepEqual(captured.edits.at(-1).hashes, [sha(blue)]);
    const before = counts();
    assert.equal((await request(`/api/projects/${currentProject.id}/chat`, editRequest)).response.status, 202);
    assert.equal((await request(`/api/projects/${currentProject.id}/chat`, { ...editRequest, referenceIds: [product.id] })).response.status, 409);
    assert.deepEqual(counts(), before);
    assert.ok(currentProject.chatMessages.some(message => message.role === 'user' && message.referenceImages?.some(image => image.id === side.id)), 'the sent photo must remain visible with its chat message');
  });

  await t.test('later redraws inherit the page reference without reattaching photos', async () => {
    const editedSecond = currentProject.pages[1].imageUrl;
    const redraw = await request(`/api/projects/${currentProject.id}/chat`, { requestId: randomUUID(), message: '重画第1张，保留产品。' }); assert.equal(redraw.response.status, 202, redraw.raw);
    currentProject = await settled(currentProject.id); assert.deepEqual(captured.edits.at(-1).hashes, [sha(red)]); assert.equal(currentProject.pages[1].imageUrl, editedSecond);
    const repeatSecond = await request(`/api/projects/${currentProject.id}/generate`, { pageId: currentProject.pages[1].id }); assert.equal(repeatSecond.response.status, 202, repeatSecond.raw);
    currentProject = await settled(currentProject.id); assert.deepEqual(captured.edits.at(-1).hashes, [sha(blue)]);
  });

  await t.test('Images editing keeps the original order and bytes of multiple references', async () => {
    const created = await request('/api/brief/create', { ...createInput, requestId: randomUUID(), count: 1, referenceIds: [side.id, product.id] });
    assert.equal(created.response.status, 202, created.raw);
    const project = await settled(created.value.project.id); assert.equal(project.status, 'completed');
    assert.deepEqual(captured.edits.at(-1).hashes, [sha(blue), sha(red)]);
    assert.deepEqual(project.referenceIds, [side.id, product.id]);
  });

  await t.test('unsupported editing preserves existing artwork and never falls back to text-only generation', async () => {
    const keep = currentProject.pages[0].imageUrl, before = captured.generations.length;
    failEdits = true;
    assert.equal((await request(`/api/projects/${currentProject.id}/chat`, { requestId: randomUUID(), message: '重画第1张，保留产品。' })).response.status, 202);
    currentProject = await settled(currentProject.id);
    assert.equal(currentProject.pages[0].imageUrl, keep); assert.equal(currentProject.pages[0].status, 'error');
    assert.deepEqual(currentProject.referenceIds, [product.id]); assert.equal(captured.generations.length, before);
    assert.match(currentProject.pages[0].error, /参考|图片编辑|图生图/); assert.ok(!JSON.stringify(currentProject).includes(secret));
    failEdits = false;
  });

  await t.test('Chat image protocol also receives reference pixels and multiple input images remain ordered', async () => {
    assert.equal((await configure('chat')).response.status, 200);
    const body = { ...createInput, requestId: randomUUID(), count: 1, referenceIds: [side.id, product.id] };
    const created = await request('/api/brief/create', body); assert.equal(created.response.status, 202, created.raw);
    const project = await settled(created.value.project.id); assert.equal(project.status, 'completed');
    assert.deepEqual(hashes(captured.imageChat.at(-1).messages.at(-1)), [sha(blue), sha(red)]);
    assert.deepEqual(project.referenceIds, [side.id, product.id]);
  });

  await t.test('legacy text-only creation requests keep their historical fingerprint', async () => {
    const source = '旧版没有参考图的创作要求', id = randomUUID(), requestId = randomUUID();
    const input = { source, ...spec };
    const fingerprint = sha(Buffer.from(JSON.stringify({ source, style: spec.style, aspect: spec.aspect, count: spec.count, mode: spec.mode })));
    await mkdir(path.join(dir, 'projects', id), { recursive: true });
    await writeFile(path.join(dir, 'projects', id, 'project.json'), JSON.stringify({ id, ...input, creationRequestId: requestId, creationRequestFingerprint: fingerprint, status: 'error', pages: [], logs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    const before = counts();
    const duplicate = await request('/api/brief/create', { ...input, requestId, referenceIds: [] }); assert.equal(duplicate.response.status, 202, duplicate.raw); assert.equal(duplicate.value.project.id, id);
    assert.deepEqual(counts(), before);
  });
});
