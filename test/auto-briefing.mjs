import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBriefRequest, briefingMessages, parseBriefingResponse, localBriefingResponse } from '../lib/briefing.mjs';

// All model calls in this file go to a synthetic provider on localhost. State is
// isolated in a temporary directory; production credentials and works are never read.
const root = fileURLToPath(new URL('..', import.meta.url));
const topic = '帮我给一款便携手冲咖啡壶做图文宣传。';
const answer = '面向办公室上班族，真实卖点是便携、小巧，风格你定，竖版4张。不写容量、功效或使用经历。';
const blank = () => ({ style: null, aspect: null, count: null, mode: null });
const spec = () => ({ style: 'photo', aspect: '3:4', count: 4, mode: 'cards' });
const withoutMode = ({ mode, ...value }) => value;
const questions = () => [
  { id: 'audience', question: '这款咖啡壶主要想介绍给谁？' },
  { id: 'facts', question: '最想强调的真实卖点是什么？没有具体参数可以不写。' },
  { id: 'visual', question: '风格、比例和张数有偏好吗？也可以一起交给我安排。' },
];
const fixture = (action = 'ask', overrides = {}) => ({
  analysis: '围绕便携手冲咖啡壶组织一组日常场景宣传内容。',
  reply: action === 'ask' ? '把下面几项一起补充给我，回答后我就直接制作。' : '采用商业摄影、3:4竖版、4张图，直接开始制作。',
  source: topic,
  preferences: blank(),
  recommendations: spec(),
  reasons: { style: '商业摄影适合展示产品与使用场景。', aspect: '竖版适合移动端阅读。', count: '四张图能展示主要卖点。' },
  decision: { action, questions: action === 'ask' ? questions() : [], summary: '便携咖啡壶宣传图文' },
  ...overrides,
});
const initial = (extra = {}) => ({ messages: [{ role: 'user', content: topic }], preferences: blank(), matchTrends: false, ...extra });
const answered = (content = answer) => initial({ clarificationAsked: true, messages: [
  { role: 'user', content: topic },
  { role: 'assistant', content: `请一次补充：\n${questions().map((q, i) => `${i + 1}. ${q.question}`).join('\n')}` },
  { role: 'user', content },
] });
const parsed = (output, context = initial(), preferences = {}) => parseBriefingResponse(JSON.stringify(output), preferences, null, context);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('pure greetings produce a complete local hold without consuming the clarification round', () => {
  for (const greeting of ['你好', '您好！', 'Hi 👋', 'HELLO', '早上好', '你好呀']) {
    const input = normalizeBriefRequest(initial({ messages: [{ role: 'user', content: greeting }] }));
    const response = localBriefingResponse(input);
    assert.equal(response.decision.action, 'hold');
    assert.deepEqual(response.decision.questions, []);
    assert.equal(response.source, greeting);
    assert.deepEqual(response.preferences, blank());
    assert.match(response.reply, /主题|对象/);
    assert.doesNotMatch(response.reply, /什么风格|什么比例|几张/);
    assert.equal(parsed(response, input).decision.action, 'hold');
  }
  const input = normalizeBriefRequest(initial({ preferences: { style: 'watercolor', aspect: '1:1', count: 3, mode: 'cards' }, messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好，告诉我主题即可。' }, { role: 'user', content: 'hello!' }] }));
  const before = structuredClone(input), response = localBriefingResponse(input);
  assert.deepEqual(response.preferences, input.preferences);
  assert.deepEqual(response.decision.resolvedSpec, input.preferences);
  assert.deepEqual(input, before);
});

test('greeting shortcuts never intercept substantive or previously established creative topics', () => {
  for (const content of ['你好，给新手做一组养猫准备清单', 'hello海报设计', topic, '我想创作', '风格你定，做四张']) {
    assert.equal(localBriefingResponse(normalizeBriefRequest(initial({ messages: [{ role: 'user', content }] }))), null);
  }
  assert.equal(localBriefingResponse(normalizeBriefRequest(initial({ messages: [{ role: 'user', content: topic }, { role: 'assistant', content: '请补充真实卖点。' }, { role: 'user', content: '你好' }] }))), null);
  assert.equal(localBriefingResponse({ messages: [] }), null);
});

test('a later greeting cannot authorize generation or spend the existing topic clarification round', () => {
  const context = initial({ messages: [{ role: 'user', content: topic }, { role: 'assistant', content: '请补充产品真实卖点。' }, { role: 'user', content: '你好' }] });
  for (const action of ['ask', 'generate', 'hold']) {
    const response = parsed(fixture(action, { source: topic }), context);
    assert.equal(response.decision.action, 'hold');
    assert.deepEqual(response.decision.questions, []);
    assert.equal(response.source, topic);
    assert.match(response.reply, /前面的创作内容还在/);
  }
});

test('ask and hold can recover absent sources only from original user messages', () => {
  const context = initial({ messages: [
    { role: 'user', content: topic },
    { role: 'assistant', content: 'UNCONFIRMED_ASSISTANT_PRODUCT_FACTS_AND_TREND' },
    { role: 'user', content: answer },
  ] });
  for (const action of ['ask', 'hold']) for (const source of ['', '   ', null, undefined]) {
    const response = parsed(fixture(action, { source }), context);
    assert.equal(response.decision.action, action);
    assert.equal(response.source, `${topic}\n\n${answer}`);
    assert.doesNotMatch(response.source, /UNCONFIRMED|商业摄影|推荐/);
    assert.deepEqual(response.preferences, blank());
  }
  const legacy = fixture('hold', { source: null }); delete legacy.decision;
  assert.equal(parsed(legacy, context).decision.action, 'hold');
});

test('long non-generating fallback keeps the newest complete user message and full conversation intact', () => {
  const context = normalizeBriefRequest(initial({ messages: [
    { role: 'user', content: topic + '甲'.repeat(11900) },
    { role: 'assistant', content: 'UNCONFIRMED_SUGGESTION' },
    { role: 'user', content: answer + '乙'.repeat(13000) },
  ] }));
  const before = structuredClone(context), response = parsed(fixture('hold', { source: '' }), context);
  assert.equal(response.source, context.messages.at(-1).content);
  assert.ok(response.source.length <= 24000);
  assert.deepEqual(context, before);
});

test('source recovery never weakens executable generation or invalid field validation', () => {
  for (const source of ['', '  ', null, undefined]) {
    assert.throws(() => parsed(fixture('generate', { source }), answered()), error => error.status === 502 && /创作要求/.test(error.message));
  }
  for (const action of ['ask', 'hold', 'generate']) for (const source of [123, false, [], {}, '字'.repeat(24001), ' '.repeat(24001)]) {
    assert.throws(() => parsed(fixture(action, { source }), initial()), error => error.status === 502);
  }
  const held = parsed(fixture('generate', { source: '' }), answered('先别生成，只讨论一下方向。'));
  assert.equal(held.decision.action, 'hold');
  assert.ok(held.source.includes(topic));
  assert.ok(held.source.includes('先别生成'));
});

test('briefing tracks whether the one clarification round has been asked', () => {
  assert.equal(normalizeBriefRequest(initial()).clarificationAsked, false);
  assert.equal(normalizeBriefRequest(answered()).clarificationAsked, true);
  for (const clarificationAsked of ['true', 1, null, {}]) {
    assert.throws(() => normalizeBriefRequest(initial({ clarificationAsked })), error => error.status === 400);
  }
  const system = briefingMessages(normalizeBriefRequest(answered()))[0].content;
  assert.ok(system.includes('decision') && system.includes('questions'));
  assert.ok(system.includes('clarificationAsked') || system.includes('追问'));
  assert.ok(system.includes('不编造') || system.includes('不能编造'));
});

test('briefing returns all missing questions in one bounded batch and preserves explicit choices', () => {
  const output = fixture();
  const first = parsed(output);
  assert.equal(first.decision.action, 'ask');
  assert.deepEqual(first.decision.questions, questions());
  assert.deepEqual(first.preferences, blank(), 'a recommendation must not become an explicit user preference');
  assert.deepEqual(first.decision.resolvedSpec, spec());
  const previous = { style: 'watercolor', aspect: '1:1', count: 3, mode: 'cards' };
  const ready = parsed(fixture('generate'), answered(), previous);
  assert.equal(ready.decision.action, 'generate');
  assert.deepEqual(ready.decision.resolvedSpec, previous, 'confirmed choices lead defaults before an automatic creation');
  assert.deepEqual(ready.decision.questions, []);
});

test('complete requests and a useful one-round answer may generate without confirmation', () => {
  for (const context of [initial({ messages: [{ role: 'user', content: `${topic}${answer}` }] }), answered(), answered('你定，其他按适合主题的方式来。')]) {
    const ready = parsed(fixture('generate', { source: `${topic}\n${answer}` }), context);
    assert.equal(ready.decision.action, 'generate');
    assert.equal(ready.decision.resolvedSpec.count, 4);
    assert.equal(ready.decision.resolvedSpec.style, 'photo');
  }
});

test('an omitted or null recommended mode defaults to cards without changing the creation decision', () => {
  for (const recommendations of [withoutMode(spec()), { ...spec(), mode: null }]) {
    for (const action of ['ask', 'generate', 'hold']) {
      const result = parsed(fixture(action, { recommendations }), action === 'ask' ? initial() : answered());
      assert.equal(result.decision.action, action);
      assert.equal(result.preferences.mode, null, 'a repaired recommendation is not a user-confirmed choice');
      assert.deepEqual(result.recommendations, spec());
      assert.deepEqual(result.decision.resolvedSpec, spec());
    }
    const legacy = fixture('generate', { recommendations }); delete legacy.decision;
    assert.equal(parsed(legacy, answered()).decision.action, 'hold', 'repairing mode must not authorize a legacy response');
  }
});

test('missing recommended modes retain current or previously confirmed single-image formats', () => {
  for (const mode of ['cover', 'infographic']) {
    for (const recommendations of [withoutMode(spec()), { ...spec(), mode: null }]) {
      for (const fromPrevious of [false, true]) {
        const confirmed = { ...blank(), mode, count: 4 };
        const result = parsed(fixture('generate', { recommendations, preferences: fromPrevious ? blank() : confirmed }), answered(), fromPrevious ? confirmed : {});
        assert.equal(result.decision.action, 'generate');
        for (const params of [result.preferences, result.recommendations, result.decision.resolvedSpec]) {
          assert.equal(params.mode, mode);
          assert.equal(params.count, 1, `${mode} must never become a multi-image job when recommendations omit mode`);
        }
      }
    }
  }
});

test('an omitted duplicate execution mode is repaired while its values cannot override the real spec', () => {
  for (const mode of [undefined, null]) {
    const duplicate = { style: 'watercolor', aspect: '1:1', count: 9, ...(mode === undefined ? {} : { mode }) };
    const output = fixture('generate', { recommendations: withoutMode(spec()), decision: { action: 'generate', questions: [], resolvedSpec: duplicate } });
    assert.deepEqual(parsed(output, answered()).decision.resolvedSpec, spec());
    for (const confirmedMode of ['cover', 'infographic']) {
      assert.deepEqual(parsed(output, answered(), { ...blank(), mode: confirmedMode }).decision.resolvedSpec, { ...spec(), mode: confirmedMode, count: 1 });
    }
  }
});

test('mode compatibility still rejects invalid modes and missing visual parameters', () => {
  for (const mode of ['video', 'unknown', 123]) {
    assert.throws(() => parsed(fixture('generate', { recommendations: { ...spec(), mode } }), answered(), { ...blank(), mode: 'cover' }), error => error.status === 502);
    assert.throws(() => parsed(fixture('generate', { decision: { action: 'generate', questions: [], resolvedSpec: { ...spec(), mode } } }), answered()), error => error.status === 502);
  }
  for (const field of ['style', 'aspect', 'count']) {
    for (const missing of [undefined, null]) {
      const recommendations = withoutMode(spec());
      if (missing === undefined) delete recommendations[field]; else recommendations[field] = missing;
      assert.throws(() => parsed(fixture('generate', { recommendations }), answered(), spec()), error => error.status === 502, `${field} must remain required`);
    }
  }
});

test('legacy responses, empty acknowledgements and a second clarification never silently charge', () => {
  const legacy = fixture(); delete legacy.decision;
  assert.equal(parsed(legacy).decision.action, 'hold');
  for (const content of ['好的', '嗯', '收到']) {
    assert.equal(parsed(fixture('generate'), answered(content)).decision.action, 'hold', content);
  }
  const repeated = parsed(fixture('ask'), answered());
  assert.equal(repeated.decision.action, 'hold');
  assert.deepEqual(repeated.decision.questions, [], 'the UI must not enter another parameter questionnaire');
});

test('an explicit pause overrides model readiness until the user actually releases it', () => {
  for (const content of [
    '先别生成，先帮我分析一下。', '只分析需求，不要生成图片。', '先聊聊方向，暂时不制作。',
    '先不生成', '暂不生成', '暂时不要出图', '先别急着生成', '先聊聊想法',
  ]) {
    assert.equal(parsed(fixture('generate'), answered(content)).decision.action, 'hold', content);
  }
  const paused = answered();
  paused.messages.splice(0, 1, { role: 'user', content: `${topic}先别生成。` });
  assert.equal(parsed(fixture('generate'), paused).decision.action, 'hold', 'a detailed answer does not automatically revoke an earlier pause');
  paused.messages.push({ role: 'assistant', content: '好的，先只讨论。' }, { role: 'user', content: '现在开始生成吧。' });
  assert.equal(parsed(fixture('generate'), paused).decision.action, 'generate');
  const continueCreation = answered('先不生成');
  continueCreation.messages.push({ role: 'assistant', content: '我会先分析，不调用图片模型。' }, { role: 'user', content: '继续创作' });
  assert.equal(parsed(fixture('generate'), continueCreation).decision.action, 'generate', 'the settings recovery instruction must release the earlier hold');
});

test('invalid decisions cannot authorize an automatic model job', () => {
  const bad = [
    null,
    { action: 'delete_all', questions: [] },
    { action: 'generate', questions: questions() },
    { action: 'ask', questions: [] },
    { action: 'ask', questions: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, question: `问题${i}` })) },
    { action: 'ask', questions: [{ id: 'duplicate', question: '问题一' }, { id: 'duplicate', question: '问题二' }] },
    { action: 'ask', questions: [{ id: '../invalid', question: '问题' }] },
    { action: 'ask', questions: [{ id: 'empty', question: ' ' }] },
    { action: 'ask', questions: [{ id: 'large', question: '字'.repeat(801) }] },
    { action: 'generate', questions: [], summary: '字'.repeat(1001) },
    { action: 'generate', questions: [], resolvedSpec: { ...spec(), count: 99 } },
    { action: 'generate', questions: [], resolvedSpec: { ...spec(), style: '../../server' } },
  ];
  for (const decision of bad) {
    assert.throws(() => parsed(fixture('generate', { decision }), answered()), error => error.status === 502, JSON.stringify(decision));
  }
  const cover = parsed(fixture('generate', { preferences: { ...blank(), mode: 'cover' } }), answered());
  assert.equal(cover.decision.resolvedSpec.mode, 'cover');
  assert.equal(cover.decision.resolvedSpec.count, 1);
});

test('HTTP batch clarification hands a complete spec to one all-images job with persisted deduplication', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-auto-briefing-'));
  const port = 19513, base = `http://127.0.0.1:${port}`;
  const secret = 'auto-briefing-local-mock-key';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=';
  let child, log = '', nextBrief = fixture(), briefCalls = 0, planCalls = 0, imageCalls = 0;
  const prompts = [];
  const upstream = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/images/generations') {
        imageCalls++; prompts.push(body.prompt);
        return res.end(JSON.stringify({ data: [{ b64_json: png }] }));
      }
      if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('{}'); }
      let output;
      if (body.messages?.some(message => message.role === 'system' && message.content.includes('中文图文内容策划与视觉导演'))) {
        planCalls++;
        const count = Number(body.messages.at(-1).content.match(/页数[：:]\s*(\d+)/)?.[1]);
        assert.ok(Number.isInteger(count) && count >= 1 && count <= 10);
        output = { title: '把手冲咖啡带进日常', caption: '一款便携、小巧的手冲咖啡壶，让工作间隙多一点自己的节奏。', pages: Array.from({ length: count }, (_, index) => ({ title: `咖啡片刻 ${index + 1}`, content: '小巧随行，为日常留一点咖啡时间。', prompt: '干净自然光下的产品商业摄影，保留清晰中文文字区域。' })) };
      } else { briefCalls++; output = nextBrief; }
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
    } catch { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'local auto briefing mock failure' } })); }
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
    assert.fail('the local automatic creation did not finish');
  }
  t.after(async () => {
    if (child?.exitCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dir, TRENDS_AUTO_REFRESH: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { log += bytes; }); child.stderr.on('data', bytes => { log += bytes; });
  for (let index = 0; index < 100; index++) {
    if (child.exitCode !== null) assert.fail(`Local server exited: ${log}`);
    try { if ((await request('/api/config')).response.ok) break; } catch {}
    if (index === 99) assert.fail(`Local server did not start: ${log}`);
    await sleep(30);
  }
  await t.test('greetings work before model setup and do not contact the provider or create a work', async () => {
    const greeting = await request('/api/brief/chat', initial({ messages: [{ role: 'user', content: '你好' }] }));
    assert.equal(greeting.response.status, 200, greeting.raw);
    assert.equal(greeting.value.decision.action, 'hold');
    assert.deepEqual(greeting.value.decision.questions, []);
    assert.equal(greeting.value.source, '你好');
    assert.equal(briefCalls, 0); assert.equal(planCalls, 0); assert.equal(imageCalls, 0);
    assert.deepEqual((await request('/api/projects')).value.projects, []);
  });
  const configured = await request('/api/config', { text: { baseUrl: upstreamBase, model: 'auto-brief-text', apiKey: secret }, image: { baseUrl: upstreamBase, model: 'auto-brief-image', apiKey: secret, mode: 'images', size: 'auto' } }, 'PUT');
  assert.equal(configured.response.status, 200, configured.raw);

  await t.test('first message asks all questions together, without planning or rendering', async () => {
    const result = await request('/api/brief/chat', initial());
    assert.equal(result.response.status, 200, result.raw);
    assert.equal(result.value.decision.action, 'ask');
    assert.equal(result.value.decision.questions.length, 3);
    assert.equal(briefCalls, 1); assert.equal(planCalls, 0); assert.equal(imageCalls, 0);
    assert.deepEqual((await request('/api/projects')).value.projects, []);
  });

  let input, completed;
  await t.test('one answer yields a full valid spec, and one create request renders every image', async () => {
    nextBrief = fixture('generate', { source: `${topic}\n${answer}`, preferences: { ...blank(), aspect: '3:4', count: 4 } });
    const result = await request('/api/brief/chat', answered());
    assert.equal(result.response.status, 200, result.raw);
    assert.equal(result.value.decision.action, 'generate');
    assert.deepEqual(result.value.decision.resolvedSpec, spec());
    assert.deepEqual(result.value.decision.questions, []);
    assert.equal(planCalls, 0); assert.equal(imageCalls, 0, 'briefing only returns the validated handoff; the client owns its one transition');
    input = { requestId: randomUUID(), source: result.value.source, ...result.value.decision.resolvedSpec };
    const create = await request('/api/brief/create', input);
    assert.equal(create.response.status, 202, create.raw);
    completed = await settled(create.value.project.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.pages.length, 4);
    assert.ok(completed.pages.every(page => page.status === 'done' && page.imageUrl));
    assert.equal(briefCalls, 2); assert.equal(planCalls, 1); assert.equal(imageCalls, 4);
    assert.ok(prompts.every(prompt => prompt.includes('商业摄影')));
    assert.ok(!JSON.stringify(completed).includes(secret));
  });

  await t.test('reloading a read or repeating the same creation ID never reruns paid work', async () => {
    await request(`/api/projects/${completed.id}`);
    const duplicate = await request('/api/brief/create', input);
    assert.ok([200, 202].includes(duplicate.response.status), duplicate.raw);
    assert.equal(duplicate.value.project.id, completed.id);
    assert.equal(briefCalls, 2); assert.equal(planCalls, 1); assert.equal(imageCalls, 4);
  });

  await t.test('explicit pause and legacy JSON cannot return a billable decision', async () => {
    nextBrief = fixture('generate');
    for (const content of ['先别生成，只分析一下。', '先不生成', '暂不生成', '暂时不要出图', '先别急着生成', '先聊聊想法']) {
      const pause = await request('/api/brief/chat', answered(content));
      assert.equal(pause.response.status, 200, pause.raw);
      assert.equal(pause.value.decision.action, 'hold', content);
    }
    nextBrief = fixture(); delete nextBrief.decision;
    const legacy = await request('/api/brief/chat', initial());
    assert.equal(legacy.response.status, 200, legacy.raw);
    assert.equal(legacy.value.decision.action, 'hold');
    assert.equal(planCalls, 1); assert.equal(imageCalls, 4);
    assert.equal((await request('/api/projects')).value.projects.length, 1);
  });

  await t.test('malformed decisions fail recoverably before planning or rendering', async () => {
    nextBrief = fixture('generate', { decision: { action: 'generate', questions: [], resolvedSpec: { ...spec(), count: 99 } } });
    const bad = await request('/api/brief/chat', answered());
    assert.equal(bad.response.status, 502, bad.raw);
    assert.ok(typeof bad.value.error === 'string' && bad.value.error.length);
    assert.ok(!bad.raw.includes(secret));
    assert.equal(planCalls, 1); assert.equal(imageCalls, 4);
  });

  await t.test('HTTP analysis accepts missing modes but only a valid generate decision can hand off to rendering', async () => {
    const beforePlan = planCalls, beforeImages = imageCalls;
    for (const recommendations of [withoutMode(spec()), { ...spec(), mode: null }]) {
      for (const action of ['ask', 'hold', 'generate']) {
        nextBrief = fixture(action, { recommendations });
        const result = await request('/api/brief/chat', action === 'ask' ? initial() : answered());
        assert.equal(result.response.status, 200, result.raw);
        assert.equal(result.value.decision.action, action);
        assert.deepEqual(result.value.decision.resolvedSpec, spec());
      }
      nextBrief = fixture('generate', { recommendations }); delete nextBrief.decision;
      const legacy = await request('/api/brief/chat', answered());
      assert.equal(legacy.response.status, 200, legacy.raw);
      assert.equal(legacy.value.decision.action, 'hold');
    }
    assert.equal(planCalls, beforePlan); assert.equal(imageCalls, beforeImages);
    assert.equal((await request('/api/projects')).value.projects.length, 1);
  });

  await t.test('HTTP handoff preserves a confirmed single-image format when both model mode fields are missing', async () => {
    const beforePlan = planCalls, beforeImages = imageCalls;
    for (const [index, mode] of ['cover', 'infographic'].entries()) {
      const recommendations = index === 0 ? withoutMode(spec()) : { ...spec(), mode: null };
      nextBrief = fixture('generate', { recommendations, decision: { action: 'generate', questions: [], resolvedSpec: withoutMode(spec()) } });
      const result = await request('/api/brief/chat', { ...answered(`只做一张${mode === 'cover' ? '封面' : '信息图'}，其他你定。`), preferences: { ...blank(), mode } });
      assert.equal(result.response.status, 200, result.raw);
      assert.equal(result.value.decision.action, 'generate');
      assert.equal(result.value.recommendations.mode, mode);
      assert.equal(result.value.decision.resolvedSpec.mode, mode);
      assert.equal(result.value.decision.resolvedSpec.count, 1);
      const create = await request('/api/brief/create', { requestId: randomUUID(), source: result.value.source, ...result.value.decision.resolvedSpec });
      assert.equal(create.response.status, 202, create.raw);
      const project = await settled(create.value.project.id);
      assert.equal(project.status, 'completed');
      assert.equal(project.mode, mode); assert.equal(project.count, 1);
      assert.equal(project.pages.length, 1);
      assert.equal(project.pages[0].status, 'done');
    }
    assert.equal(planCalls, beforePlan + 2); assert.equal(imageCalls, beforeImages + 2);
  });

  await t.test('HTTP invalid modes still fail before any image job, even with a valid confirmed mode', async () => {
    const beforePlan = planCalls, beforeImages = imageCalls;
    for (const output of [
      fixture('generate', { recommendations: { ...spec(), mode: 'video' } }),
      fixture('generate', { recommendations: withoutMode(spec()), decision: { action: 'generate', questions: [], resolvedSpec: { ...spec(), mode: 'video' } } }),
    ]) {
      nextBrief = output;
      const result = await request('/api/brief/chat', { ...answered(), preferences: { ...blank(), mode: 'cover' } });
      assert.equal(result.response.status, 502, result.raw);
      assert.ok(!result.raw.includes(secret));
    }
    assert.equal(planCalls, beforePlan); assert.equal(imageCalls, beforeImages);
  });

  await t.test('HTTP source repair preserves user text only while ask and hold stay non-generating', async () => {
    const beforePlan = planCalls, beforeImages = imageCalls;
    for (const action of ['ask', 'hold']) for (const source of [null, '', undefined]) {
      nextBrief = fixture(action, { source });
      const response = await request('/api/brief/chat', initial());
      assert.equal(response.response.status, 200, response.raw);
      assert.equal(response.value.decision.action, action);
      assert.equal(response.value.source, topic);
    }
    for (const source of [null, '', undefined]) {
      nextBrief = fixture('generate', { source });
      const response = await request('/api/brief/chat', answered());
      assert.equal(response.response.status, 502, response.raw);
    }
    assert.equal(planCalls, beforePlan); assert.equal(imageCalls, beforeImages);
  });
});
