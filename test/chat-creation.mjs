import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The complete chat-only workflow runs against synthetic local providers and a
// temporary data directory. No social platform or real model is contacted.
const root = fileURLToPath(new URL('..', import.meta.url));
const base = 'http://127.0.0.1:19491';
const secret = 'chat-creation-mock-secret-never-expose';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const active = project => ['analyzing', 'generating'].includes(project.status) || ['thinking', 'analyzing', 'generating'].includes(project.chatStatus);
const createBody = extra => ({ requestId: randomUUID(), source: 'MOCK 给跑步新手制作一组户外防护知识图文。', style: 'notion', aspect: '3:4', count: 3, mode: 'cards', ...extra });

async function request(route, { method = 'GET', body, origin = base } = {}) {
  const response = await fetch(base + route, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch {}
  return { response, raw, value };
}
async function waitProject(id, predicate, label) {
  for (let i = 0; i < 250; i++) {
    const result = await request(`/api/projects/${id}`);
    assert.equal(result.response.status, 200, result.raw);
    if (predicate(result.value.project)) return result.value.project;
    await sleep(20);
  }
  assert.fail(`Project did not settle: ${label}`);
}
const settledCreation = id => waitProject(id, project => !active(project), 'creation');
const settledChat = (id, requestId) => waitProject(id, project => project.chatRequests?.some(entry => entry.requestId === requestId && entry.status !== 'running'), `chat ${requestId}`);

test('chat-only creation and follow-up use local mocked models, persisted idempotency and bounded changes', { timeout: 45_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-chat-creation-'));
  let child, log = '', upstreamBase;
  let textCalls = 0, imageCalls = 0, planCalls = 0, chatCalls = 0;
  let chatMode = false, chatOutput = { action: 'reply', reply: 'MOCK 请补充具体修改要求。' };
  let planBad = false, textFails = false, imageFailures = 0, textDelay = 0, imageDelay = 0;
  const incoming = [];
  const upstream = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      incoming.push({ url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/images/generations') {
        imageCalls++;
        if (imageDelay) await sleep(imageDelay);
        if (imageFailures > 0) { imageFailures--; res.statusCode = 429; return res.end(JSON.stringify({ error: { message: `MOCK image quota ${secret}` } })); }
        return res.end(JSON.stringify({ data: [{ b64_json: png }] }));
      }
      if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('{}'); }
      const isChat = chatMode && !body.messages?.some(message => message.role === 'system' && message.content.includes('中文图文内容策划与视觉导演'));
      textCalls++; if (isChat) chatCalls++; else planCalls++;
      if (textDelay) await sleep(textDelay);
      if (textFails) { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: `MOCK text credential ${secret}` } })); }
      let content;
      if (isChat) { const output = Array.isArray(chatOutput) ? chatOutput.shift() : chatOutput; content = typeof output === 'string' ? output : JSON.stringify(output); }
      else {
        const task = body.messages?.map(message => message.content).join('\n') || '';
        const count = Number(task.match(/页数[：:]\s*(\d+)/)?.[1]) || 1;
        content = planBad ? 'MOCK invalid plan JSON' : JSON.stringify({ title: 'MOCK 跑步新手防护指南', caption: 'MOCK 帖子正文，帮助跑步新手理解户外防护。',
          pages: Array.from({ length: count }, (_, index) => ({ title: `MOCK 页面 ${index + 1}`, content: `MOCK 图中文字 ${index + 1}`, prompt: `MOCK 为第 ${index + 1} 页设计清晰简洁的画面。` })) });
      }
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    } catch { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'MOCK provider handler failure' } })); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`;
  async function start() {
    log = '';
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: '19491', DATA_DIR: dir, TRENDS_AUTO_REFRESH: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) assert.fail(`Server exited: ${log}`);
      try { if ((await request('/api/config')).response.ok) return; } catch {}
      await sleep(30);
    }
    assert.fail(`Server failed to start: ${log}`);
  }
  async function stop() {
    if (child?.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await stopped; }
  }
  async function config(imageReady = true) {
    const result = await request('/api/config', { method: 'PUT', body: {
      text: { baseUrl: upstreamBase, model: 'mock-text', apiKey: secret },
      image: { baseUrl: upstreamBase, model: 'mock-image', apiKey: imageReady ? secret : '', clearKey: !imageReady, mode: 'images', size: 'auto' },
    } });
    assert.equal(result.response.status, 200, result.raw);
  }
  async function create(input = createBody()) {
    const result = await request('/api/brief/create', { method: 'POST', body: input });
    assert.equal(result.response.status, 202, result.raw);
    return { input, initial: result.value.project, project: await settledCreation(result.value.project.id) };
  }
  async function chat(id, message, output, requestId = randomUUID()) {
    chatMode = true; chatOutput = output;
    const result = await request(`/api/projects/${id}/chat`, { method: 'POST', body: { requestId, message } });
    assert.equal(result.response.status, 202, result.raw);
    return { requestId, project: await settledChat(id, requestId) };
  }
  t.after(async () => { await stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await start();
  let current, originalInput;

  await t.test('checks both models before creating a project or making a billed request', async () => {
    const missingBoth = await request('/api/brief/create', { method: 'POST', body: createBody() });
    assert.equal(missingBoth.response.status, 400);
    await config(false);
    const missingImage = await request('/api/brief/create', { method: 'POST', body: createBody() });
    assert.equal(missingImage.response.status, 400);
    assert.equal(textCalls, 0); assert.equal(imageCalls, 0);
    assert.deepEqual((await request('/api/projects')).value.projects, []);
    await config(true);
  });

  await t.test('rejects cross-site creation and invalid UUID or preferences without model calls', async () => {
    const before = textCalls;
    assert.equal((await request('/api/brief/create', { method: 'POST', origin: 'https://evil.example', body: createBody() })).response.status, 403);
    for (const input of [createBody({ requestId: 'not-a-uuid' }), createBody({ source: '' }), createBody({ style: 'unknown' }), createBody({ count: 11 })]) {
      assert.equal((await request('/api/brief/create', { method: 'POST', body: input })).response.status, 400);
    }
    assert.equal(textCalls, before);
    assert.deepEqual((await request('/api/projects')).value.projects, []);
  });

  await t.test('one creation request plans and renders every page in the background', async () => {
    const beforeText = textCalls, beforeImage = imageCalls;
    const created = await create(); current = created.project; originalInput = created.input;
    assert.equal(created.initial.creationRequestId, originalInput.requestId);
    assert.equal(current.status, 'completed');
    assert.equal(current.pages.length, 3);
    assert.ok(current.pages.every(page => page.status === 'done' && page.imageUrl));
    assert.equal(textCalls, beforeText + 1); assert.equal(imageCalls, beforeImage + 3);
    assert.equal(current.style, 'notion'); assert.equal(current.aspect, '3:4');
    assert.ok(!JSON.stringify(current).includes(secret));
  });

  await t.test('creation replay returns the same persisted project without paying again', async () => {
    const beforeText = textCalls, beforeImage = imageCalls;
    const duplicate = await request('/api/brief/create', { method: 'POST', body: originalInput });
    assert.ok([200, 202].includes(duplicate.response.status), duplicate.raw);
    assert.equal(duplicate.value.project.id, current.id);
    assert.equal(textCalls, beforeText); assert.equal(imageCalls, beforeImage);
  });

  await t.test('concurrent identical creation requests produce only one work and one rendering pass', async () => {
    const input = createBody(), beforeText = textCalls, beforeImage = imageCalls;
    const beforeCount = (await request('/api/projects')).value.projects.length;
    chatMode = false; textDelay = 120;
    const responses = await Promise.all([request('/api/brief/create', { method: 'POST', body: input }), request('/api/brief/create', { method: 'POST', body: input })]);
    const accepted = responses.find(result => [200, 202].includes(result.response.status));
    assert.ok(accepted, responses.map(result => result.raw).join('\n'));
    assert.ok(responses.every(result => [200, 202, 409].includes(result.response.status)));
    const completed = await settledCreation(accepted.value.project.id); textDelay = 0;
    assert.equal(completed.status, 'completed');
    assert.equal(textCalls, beforeText + 1); assert.equal(imageCalls, beforeImage + input.count);
    assert.equal((await request('/api/projects')).value.projects.length, beforeCount + 1);
    const replay = await request('/api/brief/create', { method: 'POST', body: input });
    assert.ok([200, 202].includes(replay.response.status)); assert.equal(replay.value.project.id, completed.id);
  });

  const appendOutput = count => ({ action: 'append_pages', reply: 'MOCK 新增图片方案', pages: Array.from({ length: count }, (_, i) => ({ title: `MOCK 追加图${i+1}`, content: `MOCK 新的真实场景${i+1}`, prompt: `MOCK 保持同组风格，展示新场景${i+1}` })) });
  await t.test('local creation and chat edits need no social login and append preserves all existing images', async () => {
    const made = await create(createBody({count:1,mode:'cover'})), old = structuredClone(made.project.pages[0]), before = imageCalls;
    assert.equal(made.project.xhsAutoDelivery,false); assert.equal(made.project.xhsDelivery,undefined);
    assert.equal((await request('/api/xhs')).value.connection.state,'disconnected');
    const result = await chat(made.project.id,'再给我4张配图，一张太少了',appendOutput(4));
    assert.equal(result.project.status,'completed'); assert.equal(result.project.pages.length,5); assert.equal(result.project.count,5); assert.equal(result.project.mode,'cards');
    assert.deepEqual(result.project.pages[0],old); assert.equal(imageCalls,before+4); assert.equal(result.project.xhsDelivery,undefined);
    const after=imageCalls,replay=await request(`/api/projects/${made.project.id}/chat`,{method:'POST',body:{requestId:result.requestId,message:'再给我4张配图，一张太少了'}});
    assert.equal(replay.response.status,202); assert.equal(imageCalls,after); assert.equal(replay.value.project.pages.length,5);
  });

  await t.test('a model promise is repaired once into an executable append plan before generating images',async()=>{
    const made=await create(createBody({count:1})),old=structuredClone(made.project.pages),before={textCalls,imageCalls};
    const result=await chat(made.project.id,'再补2张配图',[{action:'reply',reply:'MOCK 已经补好了两张图片'},appendOutput(2)]);
    assert.equal(result.project.pages.length,3);assert.equal(textCalls,before.textCalls+2);assert.equal(imageCalls,before.imageCalls+2);assert.deepEqual(result.project.pages.slice(0,1),old);
    const second=await chat(made.project.id,'再补1张配图',[{action:'reply',reply:'MOCK 马上生成'},{action:'reply',reply:'MOCK 已完成'}]);
    assert.equal(second.project.pages.length,3);assert.equal(imageCalls,before.imageCalls+2);assert.match(second.project.chatMessages.at(-1).content,/未.*方案|没有调用生图/);
  });

  await t.test('confirmation can resume a legacy unexecuted append request instead of promising again',async()=>{
    const made=await create(createBody({count:1})),p=made.project,old=structuredClone(p.pages[0]),historicalRequest=randomUUID(),now=new Date().toISOString();
    p.chatMessages.push({role:'user',content:'在给我4张配图，一张太少了',requestId:historicalRequest},{role:'assistant',content:'方案A：保留原图，追加4张配图，共5张\n方案B：替换原图，仅制作4张',requestId:historicalRequest},{role:'user',content:'A'},{role:'assistant',content:'MOCK 请确认'});
    p.chatRequests.push({requestId:historicalRequest,action:'reply',status:'completed',createdAt:now,completedAt:now});
    await writeFile(path.join(dir,'projects',p.id,'project.json'),JSON.stringify(p));
    const before=imageCalls,result=await chat(p.id,'确定',appendOutput(4));
    assert.equal(result.project.pages.length,5);assert.equal(imageCalls,before+4);assert.deepEqual(result.project.pages[0],old);
  });

  await t.test('failed added pages are retained and retry never regenerates the original image',async()=>{
    const made=await create(createBody({count:1})),old=structuredClone(made.project.pages[0]);imageFailures=1;
    let result=await chat(made.project.id,'再加2张配图',appendOutput(2));
    assert.equal(result.project.status,'partial');assert.equal(result.project.pages.length,3);assert.deepEqual(result.project.pages[0],old);
    const failed=result.project.pages.find(page=>page.status==='error'),before=imageCalls;
    result=await chat(made.project.id,'重试失败图片',{action:'regenerate',reply:'MOCK 补齐新增页',pageIds:[failed.id]});
    assert.equal(result.project.status,'completed');assert.equal(imageCalls,before+1);assert.deepEqual(result.project.pages[0],old);
  });

  await t.test('natural-language post title and caption edits preserve every generated image', async () => {
    const oldPages = structuredClone(current.pages), beforeText = textCalls, beforeImage = imageCalls;
    const completedAt = current.completedAt;
    assert.ok(Number.isFinite(Date.parse(completedAt)));
    const message = '把帖子标题改得更温暖，发布正文缩短一些，图片不用动。';
    const result = await chat(current.id, message, { action: 'update_post', reply: 'MOCK 已修改帖子标题和正文。', title: 'MOCK 更温暖的跑步防护', caption: 'MOCK 缩短后的帖子正文。' });
    current = result.project;
    assert.equal(current.title, 'MOCK 更温暖的跑步防护'); assert.equal(current.caption, 'MOCK 缩短后的帖子正文。');
    assert.deepEqual(current.pages, oldPages);
    assert.equal(current.completedAt, completedAt, 'Copy edits must not be counted as a new image completion');
    assert.equal(textCalls, beforeText + 1); assert.equal(imageCalls, beforeImage);
    assert.ok(current.chatMessages.some(entry => entry.role === 'user' && entry.content === message));
    assert.ok(current.chatMessages.some(entry => entry.role === 'assistant' && entry.requestId === result.requestId && entry.content.includes('已修改')));
    const prompt = incoming.filter(entry => entry.url === '/v1/chat/completions').at(-1).body.messages.map(entry => entry.content).join('\n');
    assert.ok(prompt.includes(message)); assert.ok(prompt.includes(current.pages[0].id));
  });

  await t.test('post edits need only text credentials and missing image credentials never invalidate existing pictures', async () => {
    const oldPages = structuredClone(current.pages), beforeImage = imageCalls;
    await config(false);
    current = (await chat(current.id, '只修改帖子正文，不用改图片。', { action: 'update_post', reply: 'MOCK 已更新正文。', caption: 'MOCK 只有文字模型时仍可修改帖子正文。' })).project;
    assert.equal(current.caption, 'MOCK 只有文字模型时仍可修改帖子正文。');
    assert.deepEqual(current.pages, oldPages); assert.equal(imageCalls, beforeImage);
    const failed = await chat(current.id, '把第2张图片正文改得更短，并重新生成第2张。', {
      action: 'revise_pages', reply: 'MOCK 需要图片资源。', pages: [{ id: current.pages[1].id, content: 'MOCK 不应写入的未生成新文案。' }],
    });
    current = failed.project;
    assert.equal(current.chatRequests.find(entry => entry.requestId === failed.requestId).status, 'error');
    assert.deepEqual(current.pages, oldPages);
    assert.equal(imageCalls, beforeImage);
    await config(true);
  });

  await t.test('a title-only request ignores an unrequested caption returned by the model', async () => {
    const oldCaption = current.caption, oldPages = structuredClone(current.pages), beforeImage = imageCalls;
    const result = await chat(current.id, '把帖子标题改成「MOCK 轻松跑步指南」。', {
      action: 'update_post', reply: 'MOCK 已修改帖子标题和发布文案。', title: 'MOCK 轻松跑步指南', caption: 'MOCK 模型额外返回但用户没有要求修改的正文。',
    });
    current = result.project;
    assert.equal(current.title, 'MOCK 轻松跑步指南');
    assert.equal(current.caption, oldCaption);
    assert.deepEqual(current.pages, oldPages);
    assert.equal(imageCalls, beforeImage);
    const reply = current.chatMessages.find(entry => entry.role === 'assistant' && entry.requestId === result.requestId).content;
    assert.ok(reply.includes('标题'));
    assert.ok(!reply.includes('已修改帖子标题和发布文案'));
  });

  await t.test('an explicit instruction not to redraw overrides a mistaken model regeneration action', async () => {
    const oldPages = structuredClone(current.pages), beforeImage = imageCalls;
    for (const message of ['不要重画第2张图片。', '第2张不要重画。']) {
      const result = await chat(current.id, message, { action: 'regenerate', reply: 'MOCK 已重新生成第二张。', pageIds: [current.pages[1].id] });
      current = result.project;
      assert.equal(current.chatRequests.find(entry => entry.requestId === result.requestId).action, 'reply');
      assert.deepEqual(current.pages, oldPages);
      assert.equal(imageCalls, beforeImage);
    }
  });

  await t.test('changing page two redraws only that page and leaves all other content and images intact', async () => {
    const oldPages = structuredClone(current.pages), beforeImage = imageCalls;
    const target = oldPages[1];
    const result = await chat(current.id, '把第2张图的正文改成更简洁的提示，然后重新画这张。', {
      action: 'revise_pages', reply: 'MOCK 已更新第二页。', pages: [{ id: target.id, content: 'MOCK 第二页更简洁的新正文。' }],
    });
    current = result.project;
    assert.equal(imageCalls, beforeImage + 1);
    assert.equal(current.pages[1].id, target.id);
    assert.equal(current.pages[1].content, 'MOCK 第二页更简洁的新正文。');
    assert.notEqual(current.pages[1].imageUrl, target.imageUrl);
    assert.deepEqual(current.pages[0], oldPages[0]); assert.deepEqual(current.pages[2], oldPages[2]);
    assert.equal(current.status, 'completed');
  });

  await t.test('an unclear request returns a clarification without editing content or generating images', async () => {
    const previous = { title: current.title, caption: current.caption, pages: structuredClone(current.pages) }, beforeImage = imageCalls;
    current = (await chat(current.id, '能再好一点吗？', { action: 'reply', reply: 'MOCK 你想修改帖子文案、哪一张图片，还是整体风格？' })).project;
    assert.deepEqual({ title: current.title, caption: current.caption, pages: current.pages }, previous);
    assert.equal(imageCalls, beforeImage);
  });

  await t.test('invalid or mixed model actions fail atomically and preserve previous pages', async () => {
    const old = { title: current.title, caption: current.caption, pages: structuredClone(current.pages) }, beforeImage = imageCalls;
    for (const [output, message, shouldError] of [
      [{ action: 'delete_all', reply: 'MOCK unsupported' }, 'MOCK 修改作品。', false],
      [{ action: 'revise_pages', reply: 'MOCK missing target' }, '修改第1张图片的正文。', true],
      [{ action: 'regenerate', reply: 'MOCK unknown target', pageIds: [randomUUID()] }, '重新生成第1张图片。', true],
      [{ action: 'revise_pages', reply: 'MOCK mixed valid and unknown', pages: [{ id: current.pages[0].id, content: 'must not apply' }, { id: randomUUID(), title: 'unknown' }] }, '修改第1张和第2张的正文。', true],
      [{ action: 'update_post', reply: 'MOCK bad mixed action', caption: 'must not apply', pages: [{ id: current.pages[0].id, content: 'must not apply' }] }, '修改帖子正文。', true],
      ['MOCK not valid action JSON', '修改帖子正文。', true],
    ]) {
      const result = await chat(current.id, message, output);
      current = result.project;
      const record = current.chatRequests.find(entry => entry.requestId === result.requestId);
      assert.equal(record.status, shouldError ? 'error' : 'completed');
      if (!shouldError) assert.equal(record.action, 'reply');
      assert.deepEqual({ title: current.title, caption: current.caption, pages: current.pages }, old);
    }
    assert.equal(imageCalls, beforeImage);
  });

  await t.test('chat input UUID, length and cross-site checks happen before model calls', async () => {
    const beforeText = textCalls;
    const route = `/api/projects/${current.id}/chat`;
    for (const body of [{ requestId: 'bad', message: '修改正文' }, { requestId: randomUUID(), message: '' }, { requestId: randomUUID(), message: 'a'.repeat(6001) }]) {
      assert.equal((await request(route, { method: 'POST', body })).response.status, 400);
    }
    assert.equal((await request(route, { method: 'POST', origin: 'https://evil.example', body: { requestId: randomUUID(), message: '修改正文' } })).response.status, 403);
    assert.equal(textCalls, beforeText);
  });

  await t.test('reusing a request ID with different content is rejected without another billed call', async () => {
    const beforeText = textCalls, beforeImage = imageCalls;
    assert.equal((await request('/api/brief/create', { method: 'POST', body: { ...originalInput, source: 'MOCK 使用相同请求编号提交另一份创作。' } })).response.status, 409);
    const previous = current.chatMessages.find(entry => entry.role === 'user' && entry.requestId !== current.creationRequestId);
    assert.equal((await request(`/api/projects/${current.id}/chat`, { method: 'POST', body: { requestId: previous.requestId, message: 'MOCK 完全不同的第二次修改请求。' } })).response.status, 409);
    assert.equal(textCalls, beforeText); assert.equal(imageCalls, beforeImage);
  });

  await t.test('concurrent duplicate chat requests share one text action and one target redraw', async () => {
    const requestId = randomUUID(), message = '第1张再画一次。', target = current.pages[0], beforeText = textCalls, beforeImage = imageCalls;
    chatMode = true; textDelay = 150; chatOutput = { action: 'regenerate', reply: 'MOCK 已重新生成第一页。', pageIds: [target.id] };
    const route = `/api/projects/${current.id}/chat`, body = { requestId, message };
    const responses = await Promise.all([request(route, { method: 'POST', body }), request(route, { method: 'POST', body })]);
    assert.ok(responses.some(result => [200, 202].includes(result.response.status)));
    assert.ok(responses.every(result => [200, 202, 409].includes(result.response.status)), responses.map(result => result.raw).join('\n'));
    current = await settledChat(current.id, requestId); textDelay = 0;
    assert.equal(textCalls, beforeText + 1); assert.equal(imageCalls, beforeImage + 1);
    const replay = await request(route, { method: 'POST', body });
    assert.ok([200, 202].includes(replay.response.status));
    assert.equal(textCalls, beforeText + 1); assert.equal(imageCalls, beforeImage + 1);
    assert.equal(current.chatMessages.filter(entry => entry.role === 'user' && entry.requestId === requestId).length, 1);
  });

  await t.test('a failed chat request is secret-free and only a new request ID retries the model', async () => {
    const beforeText = textCalls, beforeImage = imageCalls, requestId = randomUUID(), message = '帖子正文再简短一点。';
    textFails = true;
    current = (await chat(current.id, message, { action: 'update_post', reply: 'MOCK retry', caption: 'MOCK 重试后的帖子正文。' }, requestId)).project;
    assert.equal(current.chatRequests.find(entry => entry.requestId === requestId).status, 'error');
    assert.ok(!JSON.stringify(current).includes(secret));
    textFails = false;
    const duplicate = await request(`/api/projects/${current.id}/chat`, { method: 'POST', body: { requestId, message } });
    assert.ok([200, 202].includes(duplicate.response.status));
    assert.equal(textCalls, beforeText + 1);
    current = (await chat(current.id, message, { action: 'update_post', reply: 'MOCK retry', caption: 'MOCK 重试后的帖子正文。' })).project;
    assert.equal(current.caption, 'MOCK 重试后的帖子正文。');
    assert.equal(textCalls, beforeText + 2); assert.equal(imageCalls, beforeImage);
  });

  await t.test('partial creation retains successful images and a chat retry redraws only the failed page', async () => {
    chatMode = false; imageFailures = 1;
    const created = await create();
    assert.equal(created.project.status, 'partial');
    assert.equal(created.project.completedAt, undefined);
    assert.equal(created.project.pages.filter(page => page.status === 'done').length, 2);
    assert.ok(!JSON.stringify(created.project).includes(secret));
    const bad = created.project.pages.find(page => page.status === 'error'), good = created.project.pages.filter(page => page.status === 'done');
    const beforeImage = imageCalls;
    const retried = (await chat(created.project.id, '只重试失败的那张图片。', { action: 'regenerate', reply: 'MOCK 已重试失败页。', pageIds: [bad.id] })).project;
    assert.equal(retried.status, 'completed'); assert.equal(imageCalls, beforeImage + 1);
    assert.ok(Date.parse(retried.completedAt) >= Date.parse(created.project.createdAt), 'Successful retries record their actual completion date');
    for (const previous of good) assert.deepEqual(retried.pages.find(page => page.id === previous.id), previous);
  });

  await t.test('a generic continue request cannot redraw pages already completed', async () => {
    chatMode = false; imageFailures = 1;
    const created = await create(), good = created.project.pages.filter(page => page.status === 'done');
    const beforeImage = imageCalls;
    const retried = (await chat(created.project.id, '继续生成，帮我补完剩下的图片。', { action: 'regenerate', reply: 'MOCK 补齐未完成图片。', pageIds: created.project.pages.map(page => page.id) })).project;
    assert.equal(retried.status, 'completed'); assert.equal(imageCalls, beforeImage + 1);
    for (const previous of good) assert.deepEqual(retried.pages.find(page => page.id === previous.id), previous);
    const afterImage = imageCalls;
    const completeReply = await chat(retried.id, '继续生成。', { action: 'regenerate', reply: 'MOCK 所有图片已经完成。', pageIds: retried.pages.map(page => page.id) });
    assert.equal(imageCalls, afterImage);
    assert.deepEqual(completeReply.project.pages, retried.pages);
  });

  await t.test('a malformed creation plan fails before images and replay never restarts it', async () => {
    chatMode = false; planBad = true;
    const beforeImage = imageCalls;
    const created = await create();
    assert.equal(created.project.status, 'error'); assert.equal(created.project.pages.length, 0);
    assert.equal(imageCalls, beforeImage);
    const beforeText = textCalls;
    const replay = await request('/api/brief/create', { method: 'POST', body: created.input });
    assert.ok([200, 202].includes(replay.response.status)); assert.equal(replay.value.project.id, created.project.id);
    assert.equal(textCalls, beforeText); planBad = false;
    const beforeRetryImage = imageCalls;
    const resumed = await chat(created.project.id, '重试这次创作，继续生成。', { action: 'regenerate', reply: 'MOCK 重新策划并生成。', pageIds: [] });
    assert.equal(resumed.project.status, 'completed');
    assert.equal(resumed.project.pages.length, 3);
    assert.equal(imageCalls, beforeRetryImage + 3);
  });

  await t.test('creation and successful chat request IDs survive a clean restart without repeated billed calls', async () => {
    const completedChat = current.chatRequests.find(entry => entry.status === 'completed' && entry.action !== 'create');
    const completedMessage = current.chatMessages.find(entry => entry.requestId === completedChat.requestId && entry.role === 'user').content;
    const beforeText = textCalls, beforeImage = imageCalls;
    await stop(); await start();
    const createReplay = await request('/api/brief/create', { method: 'POST', body: originalInput });
    assert.ok([200, 202].includes(createReplay.response.status)); assert.equal(createReplay.value.project.id, current.id);
    const chatReplay = await request(`/api/projects/${current.id}/chat`, { method: 'POST', body: { requestId: completedChat.requestId, message: completedMessage } });
    assert.ok([200, 202].includes(chatReplay.response.status), chatReplay.raw);
    assert.equal(textCalls, beforeText); assert.equal(imageCalls, beforeImage);
    const persisted = JSON.parse(await readFile(path.join(dir, 'projects', current.id, 'project.json'), 'utf8'));
    assert.equal(persisted.creationRequestId, originalInput.requestId);
    assert.ok(persisted.chatRequests.some(entry => entry.requestId === completedChat.requestId));
  });

  await t.test('restarting an interrupted creation preserves finished pages and does not resume paid work', async () => {
    chatMode = false; imageDelay = 120;
    const input = createBody(), started = await request('/api/brief/create', { method: 'POST', body: input });
    assert.equal(started.response.status, 202, started.raw);
    const id = started.value.project.id;
    const underway = await waitProject(id, project => project.pages.some(page => page.status === 'done') && project.pages.some(page => page.status === 'generating'), 'one finished and another generating');
    const finished = underway.pages.filter(page => page.status === 'done');
    await stop(); const beforeText = textCalls, beforeImage = imageCalls; imageDelay = 0;
    await start();
    const restored = (await request(`/api/projects/${id}`)).value.project;
    assert.equal(restored.status, 'interrupted');
    for (const previous of finished) assert.deepEqual(restored.pages.find(page => page.id === previous.id), previous);
    await sleep(100);
    const replay = await request('/api/brief/create', { method: 'POST', body: input });
    assert.ok([200, 202].includes(replay.response.status)); assert.equal(replay.value.project.id, id);
    assert.equal(textCalls, beforeText); assert.equal(imageCalls, beforeImage);
  });

  await t.test('interrupted chat actions are marked on restart and never silently retried', async () => {
    chatMode = true; textDelay = 300;
    chatOutput = { action: 'update_post', reply: 'MOCK 新正文已整理。', caption: 'MOCK 不应在服务重启后自动写入的正文。' };
    const id = current.id, requestId = randomUUID(), message = '把帖子正文再写得简短一点。';
    const oldPages = structuredClone(current.pages), oldCaption = current.caption, beforeText = textCalls;
    const started = await request(`/api/projects/${id}/chat`, { method: 'POST', body: { requestId, message } });
    assert.equal(started.response.status, 202, started.raw);
    for (let i = 0; i < 100 && textCalls === beforeText; i++) await sleep(5);
    assert.equal(textCalls, beforeText + 1);
    await stop(); const stoppedText = textCalls, stoppedImage = imageCalls; textDelay = 0;
    await start();
    const restored = (await request(`/api/projects/${id}`)).value.project;
    assert.equal(restored.chatRequests.find(entry => entry.requestId === requestId).status, 'interrupted');
    assert.equal(restored.caption, oldCaption); assert.deepEqual(restored.pages, oldPages);
    const replay = await request(`/api/projects/${id}/chat`, { method: 'POST', body: { requestId, message } });
    assert.ok([200, 202].includes(replay.response.status));
    assert.equal(textCalls, stoppedText); assert.equal(imageCalls, stoppedImage);
  });
});
