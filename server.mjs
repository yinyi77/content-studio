import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Storage, zip } from './lib/storage.mjs';
import { styles, modes, planningMessages, renderingPrompt } from './lib/prompts.mjs';
import { normalizeBase, textCompletion, parsePlan, listModels, generateImage } from './lib/providers.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口');
const store = new Storage(path.resolve(process.env.DATA_DIR || path.join(root, 'data')));
await store.init();
const defaults = { text: { baseUrl: '', model: '', apiKey: '' }, image: { baseUrl: '', model: '', apiKey: '', mode: 'images', size: 'auto' } };
let config = await store.config() || structuredClone(defaults);
const jobs = new Set();
let mutationInFlight = false;
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const allowedOrigins = new Set([...allowedHosts].map(x => `http://${x}`));
const running = project => jobs.has(project.id);
const ready = kind => Boolean(config[kind]?.baseUrl && config[kind]?.apiKey && config[kind]?.model);
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function redact(value) {
  let message = String(value || '操作失败');
  for (const key of [config.text.apiKey, config.image.apiKey]) if (key) message = message.split(key).join('[已隐藏]');
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').slice(0, 600);
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
async function analyze(project) {
  const snapshot = structuredClone(config.text);
  log(project, '正在分析内容、拆分页面并组织视觉方案'); await store.save(project);
  const text = await textCompletion(snapshot, await planningMessages(project));
  const plan = parsePlan(text, project.mode === 'cards' ? project.count : 1);
  project.title = plan.title; project.caption = plan.caption;
  project.pages = plan.pages.map(page => ({ id: randomUUID(), title: page.title, content: page.content, prompt: page.prompt, status: 'pending', imageUrl: null, error: null }));
  project.status = 'draft'; project.error = null;
  log(project, '拆页方案已准备好，可修改文字和画面描述，确认后生成图片');
  await store.save(project);
}
async function render(project, pageId) {
  const snapshot = structuredClone(config.image);
  const pages = pageId ? project.pages.filter(page => page.id === pageId) : project.pages.filter(page => page.status !== 'done');
  await mkdir(path.join(store.dir(project.id), 'images'), { recursive: true });
  await mkdir(path.join(store.dir(project.id), 'prompts'), { recursive: true });
  for (const page of pages) {
    page.status = 'generating'; page.error = null;
    log(project, `正在生成第 ${project.pages.indexOf(page) + 1} 张：${page.title}`); await store.save(project);
    try {
      const prompt = await renderingPrompt(project, page);
      await writeFile(path.join(store.dir(project.id), 'prompts', `${page.id}.md`), prompt, { mode: 0o600 });
      const image = await generateImage(snapshot, prompt, project.aspect);
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

// A restart never silently repeats a billed API call.
for (const project of await store.list()) {
  if (['analyzing', 'generating'].includes(project.status)) {
    project.status = 'interrupted'; project.error = '上次运行已中断。请检查已有结果，再手动重试未完成的任务';
    for (const page of project.pages) if (page.status === 'generating') { page.status = 'error'; page.error = '任务因服务退出被中断'; }
    log(project, project.error); await store.save(project);
  }
}

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let length = 0; const parts = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) fail('提交内容过大，单次请求请控制在 1 MB 以内', 413);
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
  const match = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(generate|analyze|export\.zip))?$/);
  if (!match) fail('接口不存在', 404);
  const project = await projectById(match[1]), action = match[2];
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
      const mutating = !['GET', 'HEAD'].includes(req.method) && url.pathname !== '/api/test';
      if (!mutating) return await api(req, res, url);
      if (mutationInFlight) fail('另一个操作正在保存，请稍后重试', 409);
      mutationInFlight = true;
      try { return await api(req, res, url); }
      finally { mutationInFlight = false; }
    }
    if (!['GET', 'HEAD'].includes(req.method)) fail('不支持的请求', 405);
    let file;
    const media = url.pathname.match(/^\/media\/([0-9a-f-]{36})\/([0-9a-f-]{36}-[0-9a-f-]{36}\.(?:png|jpg|webp|gif))$/);
    if (media) file = path.join(store.dir(media[1]), 'images', media[2]);
    else {
      const allowed = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
      if (!allowed[url.pathname]) fail('文件不存在', 404);
      file = path.join(root, 'public', allowed[url.pathname]);
    }
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': media ? 'private, max-age=3600' : 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (e) {
    if (res.headersSent) return res.end();
    send(res, e.code === 'ENOENT' ? 404 : e.status || 400, { error: redact(e.code === 'ENOENT' ? '文件不存在' : e.message) });
  }
});
server.requestTimeout = 360000;
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，可设置 PORT 更换端口` : `服务启动失败：${e.code}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`图文创作工作台已启动：http://127.0.0.1:${port}\n模型密钥和作品只保存在本机 data 目录。按 Ctrl+C 停止。`));
