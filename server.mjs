import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Storage, zip } from './lib/storage.mjs';
import { styles, modes, planningMessages, renderingPrompt } from './lib/prompts.mjs';
import { normalizeBase, textCompletion, parsePlan, listModels, generateImage } from './lib/providers.mjs';
import { normalizeBriefRequest, briefingMessages, parseBriefingResponse } from './lib/briefing.mjs';
import { TrendsService } from './lib/trends.mjs';
import { buildTrendMatchContext } from './lib/trend-matching.mjs';
import { normalizeCreationRequestId, normalizeProjectChatRequest, requestFingerprint, chatActionMessages, parseChatAction } from './lib/chat-creation.mjs';
import { ReferenceImages, normalizeReferenceIds, withReferenceImages } from './lib/reference-images.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口');
const store = new Storage(path.resolve(process.env.DATA_DIR || path.join(root, 'data')));
await store.init();
const referenceImages = new ReferenceImages(store.root);
const trends = new TrendsService({ dir: store.root, autoRefresh: process.env.TRENDS_AUTO_REFRESH !== '0',
  fallbackBase: process.env.TRENDS_60S_BASE_URL || 'https://60s.viki.moe' });
await trends.init();
const defaults = { text: { baseUrl: '', model: '', apiKey: '' }, image: { baseUrl: '', model: '', apiKey: '', mode: 'images', size: 'auto' } };
let config = await store.config() || structuredClone(defaults);
const jobs = new Set();
let mutationInFlight = false;
let mutationFinished = Promise.resolve();
let briefRequests = 0;
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const allowedOrigins = new Set([...allowedHosts].map(x => `http://${x}`));
const running = project => jobs.has(project.id);
const ready = kind => Boolean(config[kind]?.baseUrl && config[kind]?.apiKey && config[kind]?.model);
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function redact(value, max = 600) {
  let message = String(value || '操作失败');
  for (const key of [config.text.apiKey, config.image.apiKey]) if (key) message = message.split(key).join('[已隐藏]');
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').slice(0, max);
}
function log(project, message) {
  project.logs.push({ at: new Date().toISOString(), message: redact(message) });
  project.logs = project.logs.slice(-100);
}
function safeConfig() {
  const expose = kind => {
    const { apiKey, ...rest } = config[kind];
    return { ...rest, hasKey: Boolean(apiKey) };
  };
  return { text: expose('text'), image: expose('image'), styles, modes, configured: ready('text') && ready('image') };
}
function requireConfig(kind) { if (!ready(kind)) fail(`请先在模型设置中配置${kind === 'text' ? '文字' : '生图'}模型的地址、API Key 和模型名称`); }
const referenceMetadata = images => images.map(({ id, name, mime, size, url, sha256 }) => ({ id, name, mime, size, url, sha256 }));
function jobCapacity() { if (jobs.size >= 2) fail('已有两个任务正在运行，请等待其中一个完成后再试', 429); }
function ensureIdle(project) { if (running(project)) fail('作品正在处理，请等待任务完成', 409); }
async function projectById(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) fail('作品不存在', 404);
  const project = await store.get(id);
  if (!project) fail('作品不存在', 404);
  return project;
}
function launch(project, work) {
  jobs.add(project.id);
  Promise.resolve().then(() => work(project)).catch(async e => {
    project.status = 'error'; project.error = redact(e.message);
    log(project, project.error);
    await store.save(project);
  }).catch(() => console.error('任务记录保存失败，请检查 data 目录权限和磁盘空间')).finally(() => jobs.delete(project.id));
}
async function analyze(project, { automatic = false } = {}) {
  const snapshot = structuredClone(config.text);
  log(project, '正在分析内容、拆分页面并组织视觉方案'); await store.save(project);
  const references = await referenceImages.resolve(project.referenceIds || []);
  const text = await textCompletion(snapshot, withReferenceImages(await planningMessages(project), references));
  const plan = parsePlan(text, project.mode === 'cards' ? project.count : 1);
  project.title = plan.title; project.caption = plan.caption;
  project.visualSystem = plan.visualSystem || null;
  project.planningNotes = plan.planningNotes ? redact(plan.planningNotes, 2000) : '';
  project.missingFacts = plan.missingFacts.map(item => redact(item, 200));
  project.pages = plan.pages.map(page => ({ id: randomUUID(), title: page.title, content: page.content, prompt: page.prompt, status: 'pending', imageUrl: null, error: null }));
  project.status = 'draft'; project.error = null;
  log(project, automatic ? '内容方案已准备好，接下来自动生成图片' : '拆页方案已准备好，可修改文字和画面描述，确认后生成图片');
  await store.save(project);
}
async function render(project, pageId) {
  const snapshot = structuredClone(config.image);
  const selected = pageId ? new Set(Array.isArray(pageId) ? pageId : [pageId]) : null;
  const pages = selected ? project.pages.filter(page => selected.has(page.id)) : project.pages.filter(page => page.status !== 'done');
  await mkdir(path.join(store.dir(project.id), 'images'), { recursive: true });
  await mkdir(path.join(store.dir(project.id), 'prompts'), { recursive: true });
  for (const page of pages) {
    page.status = 'generating'; page.error = null;
    log(project, `正在生成第 ${project.pages.indexOf(page) + 1} 张：${page.title}`); await store.save(project);
    try {
      const prompt = await renderingPrompt(project, page);
      await writeFile(path.join(store.dir(project.id), 'prompts', `${page.id}.md`), prompt, { mode: 0o600 });
      const references = await referenceImages.resolve(page.referenceIds ?? project.referenceIds ?? []);
      const image = await generateImage(snapshot, prompt, project.aspect, references);
      const filename = `${page.id}-${randomUUID()}.${image.extension}`;
      await writeFile(path.join(store.dir(project.id), 'images', filename), image.bytes, { mode: 0o600 });
      page.imageUrl = `/media/${project.id}/${filename}`; page.status = 'done';
      log(project, `第 ${project.pages.indexOf(page) + 1} 张已完成`);
    } catch (e) {
      page.status = 'error'; page.error = redact(e.message);
      log(project, `第 ${project.pages.indexOf(page) + 1} 张生成失败：${page.error}`);
    }
    await store.save(project);
  }
  const completed = project.pages.filter(page => page.status === 'done').length;
  project.status = completed === project.pages.length ? 'completed' : completed ? 'partial' : 'error';
  project.error = completed === project.pages.length ? null : '部分图片未完成，可查看页面错误并单独重试';
  log(project, `本次任务结束，已完成 ${completed}/${project.pages.length} 张`); await store.save(project);
}

function chatCollections(project) {
  project.chatMessages ||= [];
  project.chatRequests ||= [];
}
function chatMessage(project, role, content, requestId, extra = {}) {
  chatCollections(project);
  project.chatMessages.push({ id: randomUUID(), role, content: role === 'assistant' ? redact(content, 2000) : content,
    at: new Date().toISOString(), requestId, ...extra });
  project.chatMessages = project.chatMessages.slice(-40);
}
function beginChatRequest(project, { requestId, message, fingerprint, referenceImages: attachments = [] }, action = null) {
  chatCollections(project);
  const record = { requestId, fingerprint, status: 'running', action, createdAt: new Date().toISOString(), pageIds: [] };
  project.chatRequests.push(record);
  project.chatRequestId = requestId; project.chatAction = action; project.chatError = null;
  chatMessage(project, 'user', message, requestId, attachments.length ? { referenceImages: attachments } : {});
  return record;
}
async function finishChatRequest(project, record, reply, { error = null } = {}) {
  record.status = error ? 'error' : 'completed'; record.completedAt = new Date().toISOString();
  record.reply = redact(reply, 2000); record.error = error ? redact(error) : null;
  project.chatStatus = error ? 'error' : 'idle'; project.chatError = record.error;
  chatMessage(project, 'assistant', record.reply, record.requestId, { action: record.action, status: record.status });
  await store.save(project);
}
function generationResult(project, pageIds) {
  const pages = pageIds ? project.pages.filter(page => pageIds.includes(page.id)) : project.pages;
  const done = pages.filter(page => page.status === 'done').length;
  return { failed: done !== pages.length, reply: done === pages.length
    ? `已完成这次创作，${pages.length} 张图片已就绪。你可以直接告诉我需要调整哪部分。`
    : `本次完成 ${done}/${pages.length} 张，已有结果已保留。未完成图片可以直接告诉我“重试失败图片”。` };
}
function planningExplanation(project) {
  const parts = [];
  if (project.planningNotes?.trim()) parts.push(`创作说明：${project.planningNotes.slice(0, 800)}`);
  if (project.missingFacts?.length) parts.push(`可以继续补充的素材：\n${project.missingFacts.map(item => `· ${item.slice(0, 150)}`).join('\n')}`);
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}
async function createInChat(project, record) {
  try {
    await analyze(project, { automatic: true });
    project.status = 'generating'; project.chatStatus = 'generating';
    await store.save(project); await render(project);
    record.pageIds = project.pages.map(page => page.id);
    const result = generationResult(project);
    await finishChatRequest(project, record, result.reply + planningExplanation(project), { error: result.failed ? project.error : null });
  } catch (error) {
    project.status = 'error'; project.error = redact(error.message);
    log(project, project.error);
    await finishChatRequest(project, record, `这次创作没有全部完成：${project.error}。已有结果已保留，可直接告诉我“重试这次创作”。`, { error: project.error });
  }
}
async function modifyInChat(project, input, record) {
  const previousStatus = project.status;
  let imageWorkStarted = false;
  try {
    const references = await referenceImages.resolve(input.referenceIds.length ? input.referenceIds : project.referenceIds || []);
    const output = await textCompletion(structuredClone(config.text), withReferenceImages(chatActionMessages(project, input.message), references));
    const action = parseChatAction(output, project, input.message, { hasNewReferences: input.referenceIds.length > 0 });
    record.action = action.action; project.chatAction = action.action;
    if (action.action === 'reply') return await finishChatRequest(project, record, action.reply);
    if (action.action === 'update_post') {
      const changed = [];
      if (action.title !== undefined && action.title !== project.title) changed.push('帖子标题');
      if (action.caption !== undefined && action.caption !== project.caption) changed.push('发布文案');
      if (action.title !== undefined) project.title = action.title;
      if (action.caption !== undefined) project.caption = action.caption;
      log(project, '已通过聊天更新帖子文案');
      return await finishChatRequest(project, record, changed.length ? `已修改${changed.join('和')}。` : '帖子内容与当前版本一致，已保留现有内容。');
    }
    // Validate image access before changing any page or running a new plan.
    requireConfig('image');
    if (action.retryPlan) {
      if (input.referenceIds.length) {
        project.referenceIds = input.referenceIds;
        project.referenceImages = input.referenceImages;
      }
      project.status = 'analyzing'; project.chatStatus = 'analyzing'; imageWorkStarted = true;
      await store.save(project); await analyze(project, { automatic: true });
      action.pageIds = project.pages.map(page => page.id);
    } else if (action.action === 'revise_pages') {
      for (const patch of action.pages) {
        const page = project.pages.find(item => item.id === patch.id);
        Object.assign(page, patch, { status: 'pending', error: null });
      }
      action.pageIds = action.pages.map(page => page.id);
    }
    if (input.referenceIds.length && !action.retryPlan) {
      // A new photo changes only the pages explicitly selected by this message.
      // Other pages keep the original product reference, including later retries.
      for (const page of project.pages.filter(item => action.pageIds.includes(item.id))) {
        page.referenceIds = [...input.referenceIds]; page.referenceImages = input.referenceImages;
      }
    }
    imageWorkStarted = true; record.pageIds = action.pageIds;
    project.status = 'generating'; project.chatStatus = 'generating'; project.error = null;
    log(project, `聊天修改已确认，将生成 ${action.pageIds.length} 张图片`);
    await store.save(project); await render(project, action.pageIds);
    const result = generationResult(project, action.pageIds);
    await finishChatRequest(project, record, result.reply + (action.retryPlan ? planningExplanation(project) : ''), { error: result.failed ? project.error : null });
  } catch (error) {
    project.status = imageWorkStarted ? 'error' : previousStatus;
    const message = redact(error.message);
    if (imageWorkStarted) project.error = message;
    log(project, `聊天操作未完成：${message}`);
    await finishChatRequest(project, record, `这次操作没有完成：${message}。当前已保存的结果仍然保留，你可以说明需要重试或调整的内容。`, { error: message });
  }
}

// A restart never silently repeats a billed API call.
for (const project of await store.list()) {
  const activeProject = ['analyzing', 'generating'].includes(project.status);
  const activeChat = ['thinking', 'analyzing', 'generating'].includes(project.chatStatus) || project.chatRequests?.some(record => record.status === 'running');
  if (activeProject || activeChat) {
    if (activeProject || project.chatAction === 'create') project.status = 'interrupted';
    if (activeProject) project.error = '上次运行已中断。请检查已有结果，再手动重试未完成的任务';
    if (activeChat) {
      project.chatStatus = 'interrupted'; project.chatError = '上次聊天操作已中断，不会自动重复调用模型。';
      for (const record of project.chatRequests || []) if (record.status === 'running') {
        record.status = 'interrupted'; record.completedAt = new Date().toISOString(); record.error = project.chatError;
        record.reply = '上次操作因服务退出而中断，已有结果已保留。需要继续时，请明确告诉我“继续生成”或重新说明修改要求。';
        chatMessage(project, 'assistant', record.reply, record.requestId, { action: record.action, status: 'interrupted' });
      }
    }
    for (const page of project.pages) if (page.status === 'generating') { page.status = 'error'; page.error = '任务因服务退出被中断'; }
    log(project, activeChat ? project.chatError : project.error); await store.save(project);
  }
}

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
async function body(req, maxBytes = 1024 * 1024) {
  let length = 0; const parts = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) fail(maxBytes === 1024 * 1024 ? '提交内容过大，单次请求请控制在 1 MB 以内' : '图片上传内容过大，单张图片请控制在 8 MB 以内', 413);
    parts.push(chunk);
  }
  try { return parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {}; }
  catch { fail('请求内容不是有效 JSON'); }
}
const str = (value, label, max, empty = false) => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(`${label}不能为空且不能超过 ${max} 字符`);
  return value.trim();
};
function updateConfig(input) {
  const next = structuredClone(config);
  for (const kind of ['text', 'image']) {
    if (!input[kind] || typeof input[kind] !== 'object') fail('请完整填写文字和生图模型配置');
    const value = input[kind];
    const baseUrl = normalizeBase(str(value.baseUrl, 'API 地址', 2048));
    const apiKey = value.clearKey === true ? '' : typeof value.apiKey === 'string' && value.apiKey.trim() ? value.apiKey.trim() : next[kind].apiKey;
    if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) fail('API Key 格式不正确');
    if (next[kind].apiKey && next[kind].baseUrl && new URL(baseUrl).origin !== new URL(next[kind].baseUrl).origin && !value.apiKey?.trim() && !value.clearKey) fail('更换中转站地址时，请重新输入 API Key，避免将原有密钥发送到新站点');
    next[kind] = { ...next[kind], baseUrl, model: str(value.model, '模型名称', 200), apiKey };
    if (kind === 'image') {
      if (!['images', 'chat'].includes(value.mode || 'images')) fail('不支持的生图接口类型');
      const size = value.size || 'auto';
      if (!['auto', '1024x1024', '1024x1536', '1536x1024', '1024x1792', '1792x1024'].includes(size)) fail('不支持的图片尺寸');
      next.image.mode = value.mode || 'images'; next.image.size = size;
    }
  }
  return next;
}
function newProject(input) {
  const source = str(input.source, '创作内容', 24000);
  const mode = input.mode || 'cards', style = input.style || 'notion', aspect = input.aspect || '3:4';
  if (!modes.some(x => x.id === mode) || !styles.some(x => x.id === style) || !['3:4', '1:1', '16:9'].includes(aspect)) fail('请选择支持的创作类型、风格和比例');
  const count = mode === 'cards' ? Number(input.count || 4) : 1;
  if (!Number.isInteger(count) || count < 1 || count > 10) fail('页数应为 1 到 10 的整数');
  const now = new Date().toISOString();
  return { id: randomUUID(), title: source.split('\n')[0].slice(0, 36), source, mode, style, aspect, count, caption: '', createdAt: now, updatedAt: now, status: 'analyzing', error: null, pages: [], logs: [] };
}
async function api(req, res, url) {
  const method = req.method, pathname = url.pathname;
  if (pathname === '/api/reference-images') {
    if (method !== 'POST') fail('图片上传仅支持 POST 请求', 405);
    return send(res, 201, { image: await referenceImages.create(await body(req, 12 * 1024 * 1024)) });
  }
  if (pathname === '/api/brief/create') {
    if (method !== 'POST') fail('聊天创作仅支持 POST 请求', 405);
    const input = await body(req);
    const requestId = normalizeCreationRequestId(input?.requestId);
    if (input.count !== undefined && (!Number.isInteger(input.count) || input.count < 1 || input.count > 10)) fail('图片张数应为 1 到 10 的整数');
    const project = newProject(input);
    const referenceIds = normalizeReferenceIds(input.referenceIds);
    const references = await referenceImages.resolve(referenceIds);
    if (referenceIds.length) { project.referenceIds = referenceIds; project.referenceImages = referenceMetadata(references); }
    const fingerprint = requestFingerprint({ source: project.source, style: project.style, aspect: project.aspect, count: project.count, mode: project.mode,
      ...(referenceIds.length ? { referenceImages: project.referenceImages.map(({ id, sha256 }) => ({ id, sha256 })) } : {}) });
    const existing = (await store.list()).find(item => item.creationRequestId === requestId);
    if (existing) {
      if (existing.creationRequestFingerprint && existing.creationRequestFingerprint !== fingerprint) fail('这个 requestId 已用于其他创作要求，请使用新的请求编号', 409);
      return send(res, 202, { project: existing });
    }
    requireConfig('text'); requireConfig('image'); jobCapacity();
    project.creationRequestId = requestId; project.creationRequestFingerprint = fingerprint;
    project.chatStatus = 'analyzing';
    const record = beginChatRequest(project, { requestId, message: project.source, fingerprint, referenceImages: project.referenceImages }, 'create');
    await store.save(project); launch(project, item => createInChat(item, record));
    return send(res, 202, { project });
  }
  if (pathname === '/api/trends') {
    if (method !== 'GET') fail('热点列表仅支持 GET 请求', 405);
    return send(res, 200, trends.snapshot());
  }
  if (pathname === '/api/trends/refresh') {
    if (method !== 'POST') fail('刷新热点仅支持 POST 请求', 405);
    await body(req);
    return send(res, 202, trends.startRefresh({ manual: true }));
  }
  if (pathname === '/api/trends/settings') {
    if (method !== 'PUT') fail('热点设置仅支持 PUT 请求', 405);
    return send(res, 200, await trends.updateSettings(await body(req)));
  }
  if (pathname === '/api/brief/chat') {
    if (method !== 'POST') fail('创作对话仅支持 POST 请求', 405);
    requireConfig('text');
    const input = normalizeBriefRequest(await body(req));
    if (briefRequests >= 2) fail('已有两个创作分析正在进行，请稍后再试', 429);
    const snapshot = structuredClone(config.text);
    const trendContext = buildTrendMatchContext(input.matchTrends ? trends.snapshot() : null, { messages: input.messages, enabled: input.matchTrends });
    briefRequests++;
    try {
      const references = await referenceImages.resolve(input.referenceIds);
      const response = await textCompletion(snapshot, withReferenceImages(briefingMessages(input, trendContext), references));
      return send(res, 200, parseBriefingResponse(response, input.preferences, trendContext, input));
    } finally { briefRequests--; }
  }
  if (pathname === '/api/config' && method === 'GET') return send(res, 200, safeConfig());
  if (pathname === '/api/config' && method === 'PUT') {
    if (jobs.size) fail('有创作任务正在运行，完成后再更改模型设置', 409);
    const next = updateConfig(await body(req));
    await store.saveConfig(next); config = next;
    return send(res, 200, safeConfig());
  }
  if (pathname === '/api/models' && method === 'GET') {
    const kind = url.searchParams.get('kind');
    if (!['text', 'image'].includes(kind)) fail('请选择文字或生图模型');
    requireConfig(kind);
    return send(res, 200, { models: await listModels(structuredClone(config[kind])) });
  }
  if (pathname === '/api/test' && method === 'POST') {
    const { kind } = await body(req);
    if (!['text', 'image'].includes(kind)) fail('请选择文字或生图模型');
    requireConfig(kind);
    if (kind === 'text') await textCompletion(structuredClone(config.text), [{ role: 'user', content: 'Reply with OK only.' }]);
    else await generateImage(structuredClone(config.image), 'A simple green circle on a plain white background. No text. Square image.', '1:1');
    return send(res, 200, { ok: true, message: kind === 'text' ? '文字接口调用成功' : '生图接口调用成功，已完成一次真实图片生成' });
  }
  if (pathname === '/api/projects' && method === 'GET') return send(res, 200, { projects: await store.list() });
  if (pathname === '/api/projects' && method === 'POST') {
    requireConfig('text'); jobCapacity();
    const project = newProject(await body(req)); await store.save(project);
    launch(project, analyze); return send(res, 201, { project });
  }
  const match = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(generate|analyze|export\.zip|chat))?$/);
  if (!match) fail('接口不存在', 404);
  const project = await projectById(match[1]), action = match[2];
  if (action === 'chat') {
    if (method !== 'POST') fail('作品聊天仅支持 POST 请求', 405);
    const input = normalizeProjectChatRequest(await body(req));
    const existing = project.chatRequests?.find(record => record.requestId === input.requestId);
    if (existing) {
      if (existing.fingerprint && existing.fingerprint !== input.fingerprint) fail('这个 requestId 已用于其他聊天内容，请使用新的请求编号', 409);
      return send(res, 202, { project, reply: existing.reply || '', action: existing.action });
    }
    ensureIdle(project); requireConfig('text'); jobCapacity();
    input.referenceImages = referenceMetadata(await referenceImages.resolve(input.referenceIds));
    const record = beginChatRequest(project, input);
    project.chatStatus = 'thinking'; await store.save(project);
    launch(project, item => modifyInChat(item, input, record));
    return send(res, 202, { project });
  }
  if (!action && method === 'GET') return send(res, 200, { project });
  if (!action && method === 'DELETE') { ensureIdle(project); await store.remove(project.id); return send(res, 200, { ok: true }); }
  if (!action && method === 'PATCH') {
    ensureIdle(project);
    const data = await body(req);
    if (!project.pages.length) fail('拆页尚未完成，请先重试分析');
    if (data.title !== undefined) project.title = str(data.title, '作品标题', 200);
    if (data.caption !== undefined) project.caption = str(data.caption, '发布文案', 12000, true);
    if (data.pages !== undefined) {
      if (!Array.isArray(data.pages) || data.pages.length !== project.pages.length || new Set(data.pages.map(x => x.id)).size !== project.pages.length) fail('页面数量和编号必须与当前拆页方案一致');
      const updated = [];
      for (const input of data.pages) {
        const page = project.pages.find(x => x.id === input.id);
        if (!page) fail('页面编号不存在');
        const title = str(input.title, '页面标题', 200), content = str(input.content, '页面文案', 4000), prompt = str(input.prompt, '画面描述', 16000);
        if (title !== page.title || content !== page.content || prompt !== page.prompt) updated.push({ ...page, title, content, prompt, status: 'pending', imageUrl: null, error: null });
        else updated.push(page);
      }
      project.pages = updated;
    }
    project.status = project.pages.every(x => x.status === 'done') ? 'completed' : 'draft'; project.error = null;
    await store.save(project); return send(res, 200, { project });
  }
  if (action === 'analyze' && method === 'POST') {
    ensureIdle(project); requireConfig('text'); jobCapacity();
    if (project.pages.length) fail('已有拆页方案，请直接编辑；如需重新策划，请新建作品');
    project.status = 'analyzing'; project.error = null; await store.save(project);
    launch(project, analyze); return send(res, 202, { project });
  }
  if (action === 'generate' && method === 'POST') {
    ensureIdle(project); requireConfig('image'); jobCapacity();
    if (!project.pages.length) fail('请先完成内容分析');
    const { pageId } = await body(req);
    if (pageId && !project.pages.some(x => x.id === pageId)) fail('页面不存在', 404);
    if (!pageId && project.pages.every(x => x.status === 'done')) return send(res, 200, { project });
    project.status = 'generating'; project.error = null; await store.save(project);
    launch(project, p => render(p, pageId)); return send(res, 202, { project });
  }
  if (action === 'export.zip' && method === 'GET') {
    if (running(project)) fail('请等待当前任务完成后再导出', 409);
    const files = [
      { name: '发布文案.md', body: `# ${project.title}\n\n${project.caption}\n` },
      { name: '原始素材.md', body: project.source },
      { name: '作品信息.json', body: JSON.stringify(project, null, 2) },
    ];
    for (const [i, page] of project.pages.entries()) {
      const prefix = String(i + 1).padStart(2, '0');
      files.push({ name: `prompts/${prefix}.md`, body: await renderingPrompt(project, page) });
      if (page.imageUrl) {
        const filename = path.basename(page.imageUrl);
        files.push({ name: `images/${prefix}.${filename.split('.').pop()}`, body: await readFile(path.join(store.dir(project.id), 'images', filename)) });
      }
    }
    const archive = zip(files);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="content-${project.id.slice(0, 8)}.zip"; filename*=UTF-8''${encodeURIComponent(project.title.slice(0, 60) + '.zip')}`, 'Content-Length': archive.length, 'Cache-Control': 'no-store' });
    return res.end(archive);
  }
  fail('不支持的操作', 405);
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    if (!allowedHosts.has(req.headers.host)) fail('仅允许通过本机地址访问', 403);
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) fail('不允许跨站访问本地工作台', 403);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.headers['sec-fetch-site'] === 'cross-site' && !['/', '/index.html'].includes(url.pathname)) fail('不允许跨站访问本地工作台', 403);
    if (url.pathname.startsWith('/api/')) {
      // Serialize short mutations across browser tabs. Reserve before any await,
      // so duplicate clicks cannot start two billed jobs from the same draft.
      const mutating = !['GET', 'HEAD'].includes(req.method) && !['/api/test', '/api/brief/chat', '/api/trends/refresh'].includes(url.pathname);
      if (!mutating) return await api(req, res, url);
      const chatMutation = url.pathname === '/api/brief/create' || /^\/api\/projects\/[^/]+\/chat$/.test(url.pathname);
      if (chatMutation) while (mutationInFlight) await mutationFinished;
      else if (mutationInFlight) fail('另一个操作正在保存，请稍后重试', 409);
      mutationInFlight = true;
      let finishMutation;
      mutationFinished = new Promise(resolve => { finishMutation = resolve; });
      try { return await api(req, res, url); }
      finally { mutationInFlight = false; finishMutation(); }
    }
    if (!['GET', 'HEAD'].includes(req.method)) fail('不支持的请求', 405);
    let file;
    const reference = url.pathname.match(/^\/reference-images\/([0-9a-f-]{36})$/);
    if (reference) {
      const [image] = await referenceImages.resolve([reference[1]]);
      res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.bytes.length, 'Cache-Control': 'private, max-age=3600' });
      return res.end(req.method === 'HEAD' ? undefined : image.bytes);
    }
    const media = url.pathname.match(/^\/media\/([0-9a-f-]{36})\/([0-9a-f-]{36}-[0-9a-f-]{36}\.(?:png|jpg|webp|gif))$/);
    if (media) file = path.join(store.dir(media[1]), 'images', media[2]);
    else {
      const allowed = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/professional.css': 'professional.css', '/style-catalog.js': 'style-catalog.js' };
      if (!allowed[url.pathname]) fail('文件不存在', 404);
      file = path.join(root, 'public', allowed[url.pathname]);
    }
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': media ? 'private, max-age=3600' : 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (e) {
    if (res.headersSent) return res.end();
    const retry = Number.isFinite(e.retryAfterMs) ? { retryAfterMs: e.retryAfterMs } : {};
    send(res, e.code === 'ENOENT' ? 404 : e.status || 400, { error: redact(e.code === 'ENOENT' ? '文件不存在' : e.message), ...retry },
      retry.retryAfterMs ? { 'Retry-After': String(Math.ceil(retry.retryAfterMs / 1000)) } : {});
  }
});
server.requestTimeout = 360000;
server.on('error', e => {
  trends.close();
  console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，可设置 PORT 更换端口` : `服务启动失败：${e.code}`);
  process.exitCode = 1;
});
server.on('close', () => trends.close());
server.listen(port, '127.0.0.1', () => console.log(`图文创作工作台已启动：http://127.0.0.1:${port}\n模型密钥和作品只保存在本机 data 目录。按 Ctrl+C 停止。`));
