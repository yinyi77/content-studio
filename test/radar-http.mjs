import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

// Isolated temp data, synthetic products and provider mocks. The child process
// explicitly refuses every external fetch and replaces SMTP with a local stub.
const root = fileURLToPath(new URL('..', import.meta.url));
const port = 19497, base = `http://127.0.0.1:${port}`;
const secret = 'MOCK_HTTP_MODEL_SECRET', smtpSecret = 'MOCK_HTTP_SMTP_SECRET';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function solidPng(red, green, blue) {
  const crc = bytes => {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const tag = Buffer.from(type), result = Buffer.alloc(body.length + 12);
    result.writeUInt32BE(body.length); tag.copy(result, 4); body.copy(result, 8);
    result.writeUInt32BE(crc(Buffer.concat([tag, body])), body.length + 8); return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(24); header.writeUInt32BE(24, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(24 * 73);
  for (let row = 0; row < 24; row++) for (let column = 0; column < 24; column++) {
    const offset = row * 73 + 1 + column * 3; pixels[offset] = red; pixels[offset + 1] = green; pixels[offset + 2] = blue;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

test('radar HTTP: proposal-only scan, private settings, signed decisions and exactly-once paid generation', { timeout: 35000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-radar-http-'));
  let child, childLog = '', textCalls = 0, imageCalls = 0, scanCalls = 0;
  const upstream = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = raw ? JSON.parse(raw) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/images/generations') {
        imageCalls++;
        await sleep(60);
        res.end(JSON.stringify({ data: [{ b64_json: png }] })); return;
      }
      if (req.url === '/v1/chat/completions') {
        textCalls++;
        let content;
        if (input.messages[0].content.includes('主动选题编辑')) {
          scanCalls++;
          const candidates = JSON.parse(input.messages.at(-1).content).candidates;
          content = JSON.stringify({ opportunities: candidates.slice(0, 3).map((candidate, index) => ({ trendId: candidate.id, title: `MOCK 宣传选题 ${index + 1}`, angle: `MOCK 用实际工作流案例切入 ${index + 1}`, reason: '已提供资料的实际使用场景', outline: ['展示已确认的使用场景'], materialIds: [], count: 1, style: 'photo', aspect: '3:4', mode: 'cards', confidence: 'medium', factNotes: '只使用标题，未阅读原帖。' })) });
        } else {
          content = JSON.stringify({ title: 'MOCK 宣传作品', caption: 'MOCK 发布文案。', pages: [{ title: 'MOCK 封面', content: '已确认的产品资料', prompt: '使用已确认的产品资料制作宣传图片。' }] });
        }
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] })); return;
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'Unexpected local mock path' } }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const now = new Date().toISOString();
  await writeFile(path.join(dir, 'trends.json'), JSON.stringify({ version: 1, settings: { enabled: true, intervalMinutes: 30, keywords: [] }, platforms: [{ id: 'weibo', lastSuccessAt: now, sourceUpdatedAt: now, provider: 'MOCK', items: [1, 2, 3].map(index => ({ title: `MOCK weibo AI 工作流话题 ${index}`, url: `https://example.org/weibo/${index}`, rank: index })) }], memes: [] }));

  async function request(route, { method = 'GET', body, form, origin = base, host, headers = {} } = {}) {
    const response = await fetch(base + route, { method, headers: { ...(origin ? { Origin: origin } : {}), ...(host ? { Host: host } : {}), ...(form !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: form !== undefined ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    let json; try { json = JSON.parse(raw); } catch { json = null; }
    return { response, raw, json };
  }
  async function start() {
    childLog = '';
    const preload = `import nodemailer from 'nodemailer';
      nodemailer.createTransport = () => ({ sendMail: async mail => ({ accepted: [mail.to], messageId: '<MOCK-notification@example.org>' }), close() {} });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, options) => {
        const url = new URL(String(input));
        if (url.origin === ${JSON.stringify(upstreamUrl)}) return originalFetch(input, options);
        if (url.hostname === 'uapis.cn' && url.pathname === '/api/v1/misc/hotboard') {
          const platform = url.searchParams.get('type');
          return new Response(JSON.stringify({ code: 200, type: platform, update_time: new Date().toISOString(), list: [1,2,3].map(index => ({ title: 'MOCK ' + platform + ' AI 工作流话题 ' + index, url: 'https://example.org/' + platform + '/' + index, index })) }), { headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error('External network disabled by radar HTTP test');
      };
      await import('./server.mjs');`;
    child = spawn(process.execPath, ['--input-type=module', '-e', preload], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dir, TRENDS_AUTO_REFRESH: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { childLog += chunk; }); child.stderr.on('data', chunk => { childLog += chunk; });
    for (let index = 0; index < 100; index++) {
      if (child.exitCode !== null) assert.fail(`Isolated server exited: ${childLog}`);
      try { if ((await request('/api/config')).response.ok) return; } catch { /* waiting for local bind */ }
      await sleep(40);
    }
    assert.fail(`Isolated server did not start: ${childLog}`);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended;
  }
  t.after(async () => { await stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await start();

  const modelConfig = { text: { baseUrl: `${upstreamUrl}/v1`, apiKey: secret, model: 'MOCK-text' }, image: { baseUrl: `${upstreamUrl}/v1`, apiKey: secret, model: 'MOCK-image', mode: 'images', size: 'auto' } };
  assert.equal((await request('/api/config', { method: 'PUT', body: modelConfig })).response.status, 200);
  assert.equal((await request('/api/radar/profile', { method: 'PUT', body: { name: 'MOCK 模型服务', industry: '开发者工具', audience: '开发者', description: '已提供的模型调用入口。', sellingPoints: ['已确认的模型 API 使用入口'], goal: '以实际使用场景介绍服务' } })).response.status, 200);
  assert.equal((await request('/api/radar/settings', { method: 'PUT', body: { count: 1, maxPerDay: 3, enabled: false } })).response.status, 200);
  const savedNotification = await request('/api/radar/notifications', { method: 'PUT', body: { channel: 'email', email: { host: 'smtp.example.org', port: 465, secure: true, user: 'sender@example.org', password: smtpSecret, from: 'sender@example.org', to: 'owner@example.org' }, publicBaseUrl: 'https://studio.example.org' } });
  assert.equal(savedNotification.response.status, 200, savedNotification.raw);
  assert.doesNotMatch(savedNotification.raw, /MOCK_HTTP_SMTP_SECRET|MOCK_HTTP_MODEL_SECRET/);
  assert.equal(savedNotification.json.notificationConfig.email.hasPassword, true);

  assert.equal((await request('/api/radar/scan', { method: 'POST', body: {} })).response.status, 202);
  let snapshot;
  for (let index = 0; index < 150; index++) {
    snapshot = (await request('/api/radar')).json;
    if (!snapshot.status.running && snapshot.opportunities.length === 3 && snapshot.opportunities.every(op => op.notification.status === 'accepted')) break;
    await sleep(30);
  }
  assert.equal(snapshot.opportunities.length, 3, JSON.stringify(snapshot.status));
  assert.ok(snapshot.opportunities.every(op => op.notification.status === 'accepted'), JSON.stringify(snapshot.opportunities.map(op => op.notification)));
  assert.equal(scanCalls, 1);
  assert.equal(textCalls, 1);
  assert.equal(imageCalls, 0);
  assert.equal((await request('/api/projects')).json.projects.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /MOCK_HTTP_SMTP_SECRET|MOCK_HTTP_MODEL_SECRET/);
  const [first, expired, outdated] = snapshot.opportunities;
  const laterDecisions = new Map();
  for (const op of [expired, outdated]) {
    const issued = await request(`/api/radar/opportunities/${op.id}/link`, { method: 'POST', body: {} });
    const route = new URL(issued.json.url).pathname;
    const view = await request(route);
    laterDecisions.set(op.id, { route, csrf: view.raw.match(/name="csrf" value="([^"]+)"/)?.[1] });
  }
  const link = await request(`/api/radar/opportunities/${first.id}/link`, { method: 'POST', body: {} });
  assert.equal(link.response.status, 200, link.raw);
  assert.equal(new URL(link.json.url).origin, 'https://studio.example.org');
  const decisionPath = new URL(link.json.url).pathname;
  const decision = await request(decisionPath);
  assert.equal(decision.response.status, 200, decision.raw);
  const csrf = decision.raw.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);
  assert.equal(imageCalls, 0);
  assert.equal(textCalls, 1);
  assert.equal((await request('/api/projects')).json.projects.length, 0);
  const publicView = await request(decisionPath, { host: 'studio.example.org', origin: 'https://studio.example.org' });
  assert.equal(publicView.response.status, 200, publicView.raw);
  assert.equal((await request('/api/config', { host: 'studio.example.org', origin: 'https://studio.example.org' })).response.status, 403);
  assert.equal((await request('/', { host: 'studio.example.org', origin: 'https://studio.example.org' })).response.status, 403);
  assert.equal((await request('/api/config')).response.status, 200);
  assert.equal((await request('/api/config', { host: `localhost:${port}`, origin: `http://localhost:${port}` })).response.status, 200);
  const tampered = decisionPath.slice(0, -1) + (decisionPath.endsWith('a') ? 'b' : 'a');
  assert.equal((await request(tampered)).response.status, 403);
  assert.equal((await request(decisionPath + '/approve', { method: 'POST', form: { csrf: 'wrong-csrf' } })).response.status, 403);
  assert.equal((await request(decisionPath + '/approve')).response.status, 405);
  assert.equal(imageCalls, 0);

  const approvals = await Promise.all([
    request(decisionPath + '/approve', { method: 'POST', form: { csrf } }),
    request(decisionPath + '/approve', { method: 'POST', form: { csrf } }),
    request(`/api/radar/opportunities/${first.id}/approve`, { method: 'POST', body: {} }),
  ]);
  for (const result of approvals) assert.ok([200, 202].includes(result.response.status), result.raw);
  let project;
  for (let index = 0; index < 150; index++) {
    const projects = (await request('/api/projects')).json.projects;
    assert.equal(projects.length, 1);
    project = projects[0];
    if (project.status === 'completed' && project.chatStatus === 'idle') break;
    await sleep(30);
  }
  assert.equal(project.status, 'completed', JSON.stringify(project));
  assert.equal(project.radarOpportunityId, first.id);
  assert.equal(imageCalls, 1);
  assert.equal(textCalls, 2);
  const repeated = await request(`/api/radar/opportunities/${first.id}/approve`, { method: 'POST', body: {} });
  assert.equal(repeated.json.project.id, project.id);
  const rendered = await request(decisionPath);
  assert.match(rendered.raw, /MOCK 发布文案/);
  const mediaPath = rendered.raw.match(/<img src="([^"]+)"/)?.[1];
  assert.ok(mediaPath);
  assert.equal((await request(mediaPath, { host: 'studio.example.org', origin: 'https://studio.example.org' })).response.status, 200);

  await stop();
  const radarFile = path.join(dir, 'radar.json');
  const saved = JSON.parse(await readFile(radarFile, 'utf8'));
  saved.opportunities.find(op => op.id === expired.id).expiresAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(radarFile, JSON.stringify(saved));
  await start();
  const expiredLink = await request(`/api/radar/opportunities/${expired.id}/link`, { method: 'POST', body: {} });
  const expiredView = await request(new URL(expiredLink.json.url).pathname);
  assert.match(expiredView.raw, /已过期/);
  assert.doesNotMatch(expiredView.raw, /<button[^>]*>批准并生成/);
  assert.equal((await request(`/api/radar/opportunities/${expired.id}/approve`, { method: 'POST', body: {} })).response.status, 409);
  const expiredDecision = laterDecisions.get(expired.id);
  assert.equal((await request(expiredDecision.route + '/approve', { method: 'POST', form: { csrf: expiredDecision.csrf } })).response.status, 409);
  assert.equal((await request('/api/radar/profile', { method: 'PUT', body: { description: 'MOCK 产品介绍已经更新。' } })).response.status, 200);
  const oldLink = await request(`/api/radar/opportunities/${outdated.id}/link`, { method: 'POST', body: {} });
  const oldView = await request(new URL(oldLink.json.url).pathname);
  assert.match(oldView.raw, /已过期/);
  assert.equal((await request(`/api/radar/opportunities/${outdated.id}/approve`, { method: 'POST', body: {} })).response.status, 409);
  const outdatedDecision = laterDecisions.get(outdated.id);
  assert.equal((await request(outdatedDecision.route + '/approve', { method: 'POST', form: { csrf: outdatedDecision.csrf } })).response.status, 409);
  assert.equal((await request('/api/projects')).json.projects.length, 1);
  assert.equal(imageCalls, 1);
  assert.equal(textCalls, 2);
  const persistedOutbox = JSON.parse(await readFile(path.join(dir, 'notification-outbox.json'), 'utf8'));
  assert.equal(persistedOutbox.entries.filter(entry => entry.kind === 'result' && entry.entityId === project.id).length, 1);
  assert.doesNotMatch(childLog, /MOCK_HTTP_SMTP_SECRET|MOCK_HTTP_MODEL_SECRET/);
});

test('radar HTTP enhancements: case photos, manual notice retries, progress, feedback and persistent daily history', { timeout: 35000 }, async t => {
  const port = 19498, base = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-radar-enhanced-http-'));
  const photos = { brand: solidPng(45, 86, 145), caseA: solidPng(65, 130, 91), caseB: solidPng(210, 80, 70) };
  let child, childLog = '', textCalls = 0, imageCalls = 0, scanCalls = 0, releaseImage;
  const imageGate = new Promise(resolve => { releaseImage = resolve; });
  const captured = { smtp: [], scans: [], plans: [], edits: [] };
  const upstream = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/json');
      // Multipart uploads must be recognized before parsing JSON model calls.
      if (req.url === '/v1/images/edits') {
        imageCalls++;
        const form = await new Request('http://mock.invalid/edits', { method: 'POST', headers: req.headers, body: bytes }).formData();
        const images = [...form.getAll('image'), ...form.getAll('image[]')].filter(item => typeof item !== 'string');
        captured.edits.push({ hashes: await Promise.all(images.map(async image => sha(Buffer.from(await image.arrayBuffer())))), model: form.get('model') });
        await imageGate;
        res.end(JSON.stringify({ data: [{ b64_json: png }] })); return;
      }
      const input = bytes.length ? JSON.parse(bytes) : {};
      if (req.url === '/v1/images/generations') { imageCalls++; res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'Case references must use image edits' } })); return; }
      if (req.url !== '/v1/chat/completions') { res.statusCode = 404; res.end('{}'); return; }
      textCalls++;
      let content;
      if (input.messages[0].content.includes('主动选题编辑')) {
        scanCalls++;
        const scan = JSON.parse(input.messages.at(-1).content); captured.scans.push(scan);
        content = JSON.stringify({ opportunities: scan.candidates.slice(0, 3).map((candidate, index) => ({ trendId: candidate.id, title: `MOCK 加强选题 ${index + 1}`, angle: `只使用案例 A 的实际 AI 工作流 ${index + 1}`, reason: '关联产品入口与已确认的案例 A', outline: ['展示案例 A 的真实使用场景'], materialIds: ['case-a'], count: 1, style: 'photo', aspect: '3:4', mode: 'cards', confidence: 'medium', factNotes: '未阅读热榜原帖。' })) });
      } else {
        captured.plans.push(input);
        content = JSON.stringify({ title: 'MOCK 案例 A 宣传作品', caption: 'MOCK 案例 A 发布正文。', pages: [{ title: '案例 A 的工作流', content: '已确认案例 A 资料', prompt: '只结合案例 A 与品牌参考图，展示已确认的工作流场景。' }] });
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const now = new Date().toISOString();
  await writeFile(path.join(dir, 'trends.json'), JSON.stringify({ version: 1, settings: { enabled: true, intervalMinutes: 30, keywords: [] }, platforms: [{ id: 'weibo', lastSuccessAt: now, sourceUpdatedAt: now, provider: 'MOCK', items: [1, 2, 3].map(index => ({ title: `MOCK weibo AI 案例工作流 ${index}`, url: `https://example.org/weibo/case/${index}`, rank: index })) }], memes: [] }));
  async function request(route, { method = 'GET', body, form } = {}) {
    const response = await fetch(base + route, { method, headers: { Origin: base, ...(form !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: form !== undefined ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text(); let json; try { json = JSON.parse(raw); } catch { json = null; }
    return { response, raw, json };
  }
  async function start() {
    childLog = '';
    const preload = `import nodemailer from 'nodemailer';
      const attempts = new Map();
      nodemailer.createTransport = () => ({ sendMail: async mail => {
        const attempt = (attempts.get(mail.subject) || 0) + 1; attempts.set(mail.subject, attempt);
        process.send?.({ type: 'mock-smtp', subject: mail.subject, attempt });
        if (attempt === 1 && (mail.subject.includes('MOCK 加强选题 1') || mail.subject.startsWith('图文生成结果：'))) throw Object.assign(new Error('MOCK first send failure ${smtpSecret}'), { code: 'EAUTH' });
        return { accepted: [mail.to], messageId: '<MOCK-accepted@example.org>' };
      }, close() {} });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, options) => {
        const url = new URL(String(input));
        if (url.origin === ${JSON.stringify(upstreamUrl)}) return originalFetch(input, options);
        if (url.hostname === 'uapis.cn' && url.pathname === '/api/v1/misc/hotboard') {
          const platform = url.searchParams.get('type');
          return new Response(JSON.stringify({ code: 200, type: platform, update_time: new Date().toISOString(), list: [1,2,3].map(index => ({ title: 'MOCK ' + platform + ' AI 案例工作流 ' + index, url: 'https://example.org/' + platform + '/case/' + index, index })) }), { headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error('External network disabled by enhanced radar HTTP test');
      };
      await import('./server.mjs');`;
    child = spawn(process.execPath, ['--input-type=module', '-e', preload], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dir, TRENDS_AUTO_REFRESH: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', bytes => { childLog += bytes; }); child.stderr.on('data', bytes => { childLog += bytes; });
    child.on('message', message => { if (message.type === 'mock-smtp') captured.smtp.push(message); });
    for (let index = 0; index < 100; index++) {
      if (child.exitCode !== null) assert.fail(`Enhanced isolated server exited: ${childLog}`);
      try { if ((await request('/api/config')).response.ok) return; } catch { /* waiting for local bind */ }
      await sleep(40);
    }
    assert.fail(`Enhanced isolated server did not start: ${childLog}`);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended;
  }
  async function pollSnapshot(predicate) {
    let snapshot;
    for (let index = 0; index < 160; index++) { snapshot = (await request('/api/radar')).json; if (predicate(snapshot)) return snapshot; await sleep(25); }
    assert.fail(`Radar condition did not settle: ${JSON.stringify(snapshot)}`);
  }
  t.after(async () => { releaseImage(); await stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await start();
  const initial = (await request('/api/radar')).json;
  assert.equal(initial.readiness.ready, false);
  assert.deepEqual(initial.today, { scans: 0, proposals: 0, approved: 0, completed: 0 });
  assert.deepEqual(initial.notificationHistory, []);
  const refs = {};
  for (const [name, bytes] of Object.entries(photos)) {
    const uploaded = await request('/api/reference-images', { method: 'POST', body: { name: `${name}.png`, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` } });
    assert.equal(uploaded.response.status, 201, uploaded.raw); refs[name] = uploaded.json.image.id;
  }
  const profile = { name: 'MOCK 模型 API 服务', industry: '开发者工具', audience: '开发者', description: '提供模型 API 入口。', sellingPoints: ['已确认的使用入口'], goal: '通过案例 A 说明使用场景', referenceIds: [refs.brand], materials: [
    { id: 'case-a', title: 'MOCK 案例 A', content: 'CASE_A_PRIVATE_DETAILS：已提供的 AI 工作流案例 A。', source: '用户提供 A', referenceIds: [refs.caseA] },
    { id: 'case-b', title: 'MOCK 案例 B', content: 'CASE_B_PRIVATE_DETAILS：另一个独立案例 B，不能混入 A。', source: '用户提供 B', referenceIds: [refs.caseB] },
  ] };
  const savedProfile = await request('/api/radar/profile', { method: 'PUT', body: profile });
  assert.equal(savedProfile.response.status, 200, savedProfile.raw);
  const profileVersion = savedProfile.json.profile.version;
  const invalidProfile = await request('/api/radar/profile', { method: 'PUT', body: { materials: [{ ...profile.materials[0], referenceIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] }] } });
  assert.equal(invalidProfile.response.status, 404, invalidProfile.raw);
  const unchangedProfile = (await request('/api/radar')).json.profile;
  assert.equal(unchangedProfile.version, profileVersion);
  assert.deepEqual(unchangedProfile.materials, savedProfile.json.profile.materials);
  assert.equal((await request('/api/config', { method: 'PUT', body: { text: { baseUrl: `${upstreamUrl}/v1`, apiKey: secret, model: 'MOCK-case-text' }, image: { baseUrl: `${upstreamUrl}/v1`, apiKey: secret, model: 'MOCK-case-image', mode: 'images', size: 'auto' } } })).response.status, 200);
  assert.equal((await request('/api/radar/settings', { method: 'PUT', body: { count: 1, maxPerDay: 3, enabled: true, dailyTime: '23:59' } })).response.status, 200);
  const notificationConfig = await request('/api/radar/notifications', { method: 'PUT', body: { channel: 'email', email: { host: 'smtp.example.org', port: 465, secure: true, user: 'sender@example.org', password: smtpSecret, from: 'sender@example.org', to: 'owner@example.org' }, publicBaseUrl: 'https://studio.example.org' } });
  assert.equal(notificationConfig.response.status, 200, notificationConfig.raw);
  assert.equal(notificationConfig.json.readiness.ready, true);
  assert.deepEqual(notificationConfig.json.readiness.setupMissing, []);
  assert.equal((await request('/api/radar/scan', { method: 'POST', body: {} })).response.status, 202);
  let snapshot = await pollSnapshot(value => !value.status.running && value.opportunities.length === 3 && value.opportunities.every(op => ['failed', 'accepted'].includes(op.notification.status)));
  const first = snapshot.opportunities.find(op => op.title === 'MOCK 加强选题 1');
  const skipApi = snapshot.opportunities.find(op => op.title === 'MOCK 加强选题 2');
  const skipMail = snapshot.opportunities.find(op => op.title === 'MOCK 加强选题 3');
  assert.equal(first.notification.status, 'failed');
  assert.deepEqual(snapshot.today, { scans: 1, proposals: 3, approved: 0, completed: 0 });
  assert.equal(snapshot.runHistory.length, 1);
  assert.equal(snapshot.runHistory[0].state, 'completed');
  assert.equal(snapshot.runHistory[0].added, 3);
  assert.equal(snapshot.runHistory[0].manual, true);
  assert.equal(snapshot.notificationHistory.length, 3);
  assert.equal(scanCalls, 1); assert.equal(textCalls, 1); assert.equal(imageCalls, 0);
  assert.deepEqual(new Set(first.referenceIds), new Set([refs.caseA, refs.brand]));
  assert.deepEqual(first.materialTitles, ['MOCK 案例 A']);
  assert.doesNotMatch(first.source, /CASE_B_PRIVATE_DETAILS/);
  const retried = await request(`/api/radar/notifications/opportunity/${first.id}/retry`, { method: 'POST', body: {} });
  assert.equal(retried.response.status, 200, retried.raw);
  assert.equal(retried.json.notificationResult.status, 'accepted');
  assert.equal(retried.json.notificationResult.attempts, 2);
  assert.equal(retried.json.opportunities.find(op => op.id === first.id).notification.status, 'accepted');
  assert.equal((await request(`/api/radar/notifications/opportunity/${first.id}/retry`, { method: 'POST', body: {} })).response.status, 409);
  assert.equal(captured.smtp.filter(item => item.subject.includes('MOCK 加强选题 1')).length, 2);
  assert.equal(textCalls, 1); assert.equal(imageCalls, 0);
  assert.equal((await request(`/api/radar/opportunities/${skipApi.id}/skip`, { method: 'POST', body: { reason: 'unsupported' } })).response.status, 400);
  const skippedApi = await request(`/api/radar/opportunities/${skipApi.id}/skip`, { method: 'POST', body: { reason: 'not_relevant', note: 'MOCK 希望更接近 API 使用需求' } });
  assert.equal(skippedApi.response.status, 200, skippedApi.raw);
  assert.equal(skippedApi.json.opportunities.find(op => op.id === skipApi.id).feedback.reason, 'not_relevant');
  const issuedSkip = await request(`/api/radar/opportunities/${skipMail.id}/link`, { method: 'POST', body: {} });
  const skipPath = new URL(issuedSkip.json.url).pathname;
  const mailPage = await request(skipPath);
  const mailCsrf = mailPage.raw.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(mailCsrf);
  const skippedMail = await request(skipPath + '/skip', { method: 'POST', form: { csrf: mailCsrf, reason: 'not_product_fit', note: 'MOCK 该角度不符合产品定位' } });
  assert.equal(skippedMail.response.status, 200, skippedMail.raw);
  snapshot = (await request('/api/radar')).json;
  assert.equal(snapshot.opportunities.find(op => op.id === skipMail.id).feedback.reason, 'not_product_fit');
  assert.equal(snapshot.opportunities.find(op => op.id === skipMail.id).feedback.note, 'MOCK 该角度不符合产品定位');
  assert.equal(snapshot.feedbackSummary.total, 2);
  assert.equal(snapshot.feedbackSummary.counts.not_relevant, 1);
  assert.equal(snapshot.feedbackSummary.counts.not_product_fit, 1);
  assert.equal(snapshot.feedbackSummary.withNote, 2);
  assert.equal((await request(`/api/radar/notifications/opportunity/${skipMail.id}/retry`, { method: 'POST', body: {} })).response.status, 409);
  assert.equal((await request(`/api/radar/opportunities/${skipMail.id}/approve`, { method: 'POST', body: {} })).response.status, 409);
  assert.equal(textCalls, 1); assert.equal(imageCalls, 0);

  const approval = await request(`/api/radar/opportunities/${first.id}/approve`, { method: 'POST', body: {} });
  assert.equal(approval.response.status, 202, approval.raw);
  const projectId = approval.json.project.id;
  assert.deepEqual(new Set(approval.json.project.referenceIds), new Set([refs.caseA, refs.brand]));
  snapshot = await pollSnapshot(value => captured.edits.length === 1 && value.projectsSummary[projectId]?.status === 'generating');
  assert.deepEqual({ completed: snapshot.projectsSummary[projectId].completed, total: snapshot.projectsSummary[projectId].total }, { completed: 0, total: 1 });
  assert.equal(snapshot.today.approved, 1);
  assert.equal(snapshot.today.completed, 0);
  assert.deepEqual(new Set(captured.edits[0].hashes), new Set([sha(photos.caseA), sha(photos.brand)]));
  assert.equal(captured.edits[0].model, 'MOCK-case-image');
  const planImages = captured.plans[0].messages.at(-1).content.filter(part => part.type === 'image_url').map(part => sha(Buffer.from(part.image_url.url.split(',')[1], 'base64')));
  assert.deepEqual(new Set(planImages), new Set([sha(photos.caseA), sha(photos.brand)]));
  assert.ok(!planImages.includes(sha(photos.caseB)));
  releaseImage();
  snapshot = await pollSnapshot(value => value.projectsSummary[projectId]?.status === 'completed' && value.projectsSummary[projectId]?.resultNotification?.status === 'failed');
  assert.deepEqual({ completed: snapshot.projectsSummary[projectId].completed, total: snapshot.projectsSummary[projectId].total }, { completed: 1, total: 1 });
  assert.deepEqual(snapshot.today, { scans: 1, proposals: 3, approved: 1, completed: 1 });
  assert.equal(textCalls, 2); assert.equal(imageCalls, 1);
  const resultRetried = await request(`/api/radar/notifications/result/${projectId}/retry`, { method: 'POST', body: {} });
  assert.equal(resultRetried.response.status, 200, resultRetried.raw);
  assert.equal(resultRetried.json.notificationResult.status, 'accepted');
  assert.equal(resultRetried.json.notificationResult.attempts, 2);
  assert.equal(resultRetried.json.projectsSummary[projectId].resultNotification.status, 'accepted');
  assert.equal((await request(`/api/radar/notifications/result/${projectId}/retry`, { method: 'POST', body: {} })).response.status, 409);
  assert.equal((await request(`/api/radar/notifications/opportunity/${first.id}/retry`, { method: 'POST', body: {} })).response.status, 409);
  assert.equal(captured.smtp.filter(item => item.subject.startsWith('图文生成结果：')).length, 2);
  assert.equal(textCalls, 2); assert.equal(imageCalls, 1);
  const completedProject = (await request(`/api/projects/${projectId}`)).json.project;
  assert.doesNotMatch(completedProject.source, /CASE_B_PRIVATE_DETAILS/);
  const safeHistory = resultRetried.json.notificationHistory;
  assert.equal(safeHistory.length, 4);
  assert.ok(safeHistory.every(entry => Object.keys(entry).every(key => ['id', 'entityId', 'kind', 'status', 'message', 'channel', 'attempts', 'updatedAt'].includes(key))));
  assert.doesNotMatch(JSON.stringify(safeHistory), /MOCK_HTTP_SMTP_SECRET|MOCK_HTTP_MODEL_SECRET|CASE_A_PRIVATE_DETAILS|CASE_B_PRIVATE_DETAILS|https?:|decision\//);
  const historyBeforeRestart = resultRetried.json.runHistory;
  const smtpCalls = captured.smtp.length;
  await stop(); await start();
  const persisted = (await request('/api/radar')).json;
  assert.deepEqual(persisted.today, { scans: 1, proposals: 3, approved: 1, completed: 1 });
  assert.deepEqual(persisted.runHistory, historyBeforeRestart);
  assert.equal(persisted.profile.version, profileVersion);
  assert.equal(persisted.feedbackSummary.total, 2);
  assert.equal(persisted.opportunities.find(op => op.id === skipMail.id).feedback.note, 'MOCK 该角度不符合产品定位');
  assert.equal(persisted.projectsSummary[projectId].resultNotification.status, 'accepted');
  assert.equal(persisted.notificationHistory.find(entry => entry.kind === 'result' && entry.entityId === projectId).attempts, 2);
  assert.equal(persisted.notificationHistory.find(entry => entry.kind === 'opportunity' && entry.entityId === first.id).attempts, 2);
  assert.equal(captured.smtp.length, smtpCalls);
  assert.equal(textCalls, 2); assert.equal(imageCalls, 1); assert.equal(scanCalls, 1);
  assert.doesNotMatch(childLog, /MOCK_HTTP_SMTP_SECRET|MOCK_HTTP_MODEL_SECRET/);
});
