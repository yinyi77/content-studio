import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';

const DEFAULTS = { channel: 'none', email: { host: '', port: 465, secure: true, user: '', password: '', from: '', to: '' }, wechat: { token: '' }, publicBaseUrl: '' };
const MAX_MANUAL_ATTEMPTS = 5;
const MAX_ATTEMPT_HISTORY = 10;
const clone = value => structuredClone(value);
const clean = (value, max = 1000) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max).trim();
const html = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function invalid(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
const attemptsFor = entry => Number.isSafeInteger(entry?.attempts) && entry.attempts >= 1 ? entry.attempts : (Array.isArray(entry?.attemptHistory) ? entry.attemptHistory : []).reduce((count, attempt) => Number.isSafeInteger(attempt?.attempt) && attempt.attempt >= 1 ? Math.max(count, attempt.attempt) : count, 1);
const manualAttemptsFor = entry => Number.isSafeInteger(entry?.manualAttempts) && entry.manualAttempts >= 0 ? entry.manualAttempts : 0;
function scalar(value, label, max = 500) {
  if (typeof value !== 'string' || /[\r\n\u0000-\u001f\u007f]/.test(value) || value.length > max) invalid(`${label}格式无效`);
  return value.trim();
}
function mailbox(value, label) {
  value = scalar(value, label, 254);
  if (value && !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)) invalid(`${label}请填写单个完整邮箱地址`);
  if (value && (value.split('@')[0].length > 64 || value.includes('..'))) invalid(`${label}格式无效`);
  return value;
}
function hostName(value) {
  value = scalar(value, 'SMTP 主机', 253);
  if (value && !(value === 'localhost' || isIP(value) || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(value))) invalid('SMTP 主机只填写域名或 IP，不包含协议、路径或端口');
  return value.toLowerCase();
}
function safeUrl(value, { base = false } = {}) {
  value = scalar(value, base ? '访问地址' : '通知链接', 4096);
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { invalid('访问地址应为完整的 http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (base && (url.search || url.hash))) invalid('访问地址不能包含账号、查询参数或片段');
  if (base && url.pathname !== '/') invalid('访问地址只填写网站根地址，不包含部署路径，例如 https://studio.example.org');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) invalid('远程访问地址必须使用 HTTPS；本机可使用 http://127.0.0.1');
  return base ? url.href.replace(/\/+$/, '') : url.href;
}
function sourceUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
function normalizeConfig(input, current = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('通知配置应为对象');
  const next = clone(current), email = input.email, wechat = input.wechat;
  if (input.channel !== undefined) {
    if (!['none', 'email', 'wechat'].includes(input.channel)) invalid('请选择邮箱、微信或关闭通知');
    next.channel = input.channel;
  }
  if (email !== undefined) {
    if (!email || typeof email !== 'object' || Array.isArray(email)) invalid('邮箱配置格式无效');
    for (const key of ['host', 'user', 'from', 'to']) if (email[key] !== undefined) {
      next.email[key] = key === 'host' ? hostName(email[key]) : ['from', 'to'].includes(key) ? mailbox(email[key], key === 'from' ? '发件邮箱' : '收件邮箱') : scalar(email[key], 'SMTP 用户名');
    }
    if (email.port !== undefined) {
      if (![465, 587].includes(Number(email.port))) invalid('SMTP 端口仅支持 465（TLS）或 587（STARTTLS）');
      next.email.port = Number(email.port);
      if (email.secure === undefined) next.email.secure = next.email.port === 465;
    }
    if (email.secure !== undefined) {
      if (typeof email.secure !== 'boolean') invalid('SMTP secure 应为布尔值');
      next.email.secure = email.secure;
    }
    if (next.email.secure !== (next.email.port === 465)) invalid('465 端口必须开启 TLS；587 端口使用强制 STARTTLS');
    if (email.password !== undefined) {
      const password = scalar(email.password, 'SMTP 授权码', 2000);
      if (password) next.email.password = password;
    }
  }
  if (wechat !== undefined) {
    if (!wechat || typeof wechat !== 'object' || Array.isArray(wechat)) invalid('微信配置格式无效');
    if (wechat.token !== undefined) { const token = scalar(wechat.token, 'PushPlus Token', 2000); if (token) next.wechat.token = token; }
  }
  if (input.clearPassword === true || email?.clearPassword === true) next.email.password = '';
  if (input.clearToken === true || wechat?.clearToken === true) next.wechat.token = '';
  if (input.publicBaseUrl !== undefined) next.publicBaseUrl = safeUrl(input.publicBaseUrl, { base: true });
  return next;
}
function readiness(config) {
  if (config.channel === 'none') return { configured: false, readiness: '通知已关闭，选题仍会保存在热点雷达中。' };
  if (config.channel === 'wechat') return config.wechat.token ? { configured: true, readiness: 'PushPlus 已配置；接口受理后仍需关注服务商投递状态。' } : { configured: false, readiness: '请先保存 PushPlus Token，并关注其微信公众号。' };
  const labels = { host: 'SMTP 主机', user: 'SMTP 用户名', password: 'SMTP 授权码', from: '发件邮箱', to: '收件邮箱' };
  const missing = Object.keys(labels).filter(key => !config.email[key]).map(key => labels[key]);
  return missing.length ? { configured: false, readiness: `请先配置${missing.join('、')}。` } : { configured: true, readiness: '邮箱已配置；SMTP 受理仅代表进入投递流程。' };
}

function opportunityMessage(opportunity, decisionUrl) {
  const trend = opportunity.trend || opportunity.snapshot?.trend || {};
  const title = clean(opportunity.title, 160) || '新的宣传选题';
  const lines = [
    ['热点', clean(trend.title, 200) || '未提供'],
    ['来源', clean(trend.platform || trend.provider, 100) || '未提供'],
    ['来源更新时间', clean(trend.sourceUpdatedAt || trend.fetchedAt, 80) || '未提供'],
    ['来源链接', sourceUrl(trend.url) || '未提供'],
    ['产品关联', clean(opportunity.reason, 1000) || '打开选题查看'],
    ['建议标题', title],
    ['创作角度', clean(opportunity.angle, 1000) || '打开选题查看'],
    ['建议图片', `${Number(opportunity.spec?.count || opportunity.count) || 1} 张`],
    ['有效期至', clean(opportunity.expiresAt, 80) || '以选题页为准'],
  ];
  if (Array.isArray(opportunity.outline)) lines.push(['内容提纲', opportunity.outline.slice(0, 10).map(item => clean(item, 300)).join('；')]);
  return { subject: `值得考虑的宣传选题：${title}`, lines, link: decisionUrl, action: '查看选题并决定是否制作', note: '打开链接只会查看选题；确认制作后才会调用模型生成内容。' };
}
function resultMessage(project, resultUrl) {
  const title = clean(project.title, 160) || '图文作品';
  const pages = Array.isArray(project.pages) ? project.pages : [];
  const completed = pages.filter(page => page.image?.url || page.image?.path || page.imageUrl || page.imagePath || (typeof page.image === 'string' && page.image)).length;
  return { subject: `图文生成结果：${title}`, lines: [['作品', title], ['图片进度', `${completed} / ${pages.length} 张已生成`]], link: resultUrl, action: '查看图文结果', note: '请在发布前检查文案、图片与产品事实。' };
}
function renderMessage(message) {
  const text = message.lines.map(([label, value]) => `${label}：${value}`).join('\n\n') + `\n\n${message.note}\n\n${message.link ? `${message.action}：${message.link}` : '请回到应用的热点雷达查看。'}`;
  const body = `<h2>${html(message.subject)}</h2>${message.lines.map(([label, value]) => `<p><strong>${html(label)}</strong><br>${html(value).replace(/\n/g, '<br>')}</p>`).join('')}<p>${html(message.note)}</p>${message.link ? `<p><a href="${html(message.link)}">${html(message.action)}</a></p>` : '<p>请回到应用的热点雷达查看。</p>'}`;
  return { text, html: body };
}

/** Durable notifications: automatic sends once; definite failures retry only on explicit request. */
export class NotificationService {
  constructor({ dir, sendMailImpl, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    if (!dir) throw new Error('通知服务缺少数据目录');
    this.dir = dir;
    this.sendMailImpl = sendMailImpl;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.config = clone(DEFAULTS);
    this.revision = 0;
    this.outbox = [];
    this.pending = new Map();
    this.writeQueue = Promise.resolve();
    this.configQueue = Promise.resolve();
  }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const read = async (file, fallback) => { try { return JSON.parse(await readFile(path.join(this.dir, file), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } };
    const saved = await read('notifications.json', null);
    if (saved) { this.config = normalizeConfig(saved.config || saved); this.revision = Number(saved.revision) || 0; await chmod(path.join(this.dir, 'notifications.json'), 0o600); }
    const savedOutbox = await read('notification-outbox.json', { entries: [] });
    this.outbox = (Array.isArray(savedOutbox.entries) ? savedOutbox.entries : []).filter(entry => entry && typeof entry === 'object').map(entry => this.sanitizeEntry(entry));
    for (const entry of this.outbox) {
      if (entry.status === 'sending') { entry.status = 'unknown'; entry.message = '发送时服务中断，是否受理未知；为避免重复提醒，不会自动重发。'; entry.updatedAt = this.timestamp(); }
      if (!entry.attemptHistory.length) entry.attemptHistory.push(this.attemptRecord(entry));
      else if (entry.attemptHistory.at(-1).status === 'sending') Object.assign(entry.attemptHistory.at(-1), { status: entry.status, message: entry.message, updatedAt: entry.updatedAt });
    }
    if (this.outbox.length) await this.persistOutbox();
    return this;
  }
  timestamp() { return new Date(this.now()).toISOString(); }
  sanitizeEntry(entry) {
    const safe = { id: clean(entry.id, 128), kind: clean(entry.kind, 40), entityId: clean(entry.entityId, 200), channel: clean(entry.channel, 40), revision: Number.isSafeInteger(entry.revision) ? entry.revision : 0, status: clean(entry.status, 40), message: this.redact(entry.message), createdAt: clean(entry.createdAt, 80), updatedAt: clean(entry.updatedAt, 80), attempts: attemptsFor(entry), manualAttempts: manualAttemptsFor(entry), attemptHistory: [] };
    if (entry.providerMessageId) safe.providerMessageId = this.redact(entry.providerMessageId);
    safe.attemptHistory = (Array.isArray(entry.attemptHistory) ? entry.attemptHistory : []).filter(attempt => attempt && typeof attempt === 'object').slice(-MAX_ATTEMPT_HISTORY).map(attempt => ({ attempt: Number.isSafeInteger(attempt.attempt) && attempt.attempt >= 1 ? attempt.attempt : 1, status: clean(attempt.status, 40), channel: clean(attempt.channel, 40), message: this.redact(attempt.message), manual: attempt.manual === true, attemptedAt: clean(attempt.attemptedAt, 80), updatedAt: clean(attempt.updatedAt, 80) }));
    return safe;
  }
  async atomic(file, value) {
    const target = path.join(this.dir, file), temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, target);
    await chmod(target, 0o600);
  }
  persistOutbox() {
    const snapshot = clone({ version: 1, entries: this.outbox });
    const operation = this.writeQueue.then(() => this.atomic('notification-outbox.json', snapshot));
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
  getSafeConfig() {
    const { password, ...email } = this.config.email;
    return { channel: this.config.channel, email: { ...email, hasPassword: Boolean(password) }, wechat: { hasToken: Boolean(this.config.wechat.token) }, publicBaseUrl: this.config.publicBaseUrl, ...readiness(this.config) };
  }
  getHistory({ limit = 30 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('通知历史条数应为 1 到 100 的整数');
    return this.outbox.slice().reverse().sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0)).slice(0, limit).map(entry => ({ id: this.redact(entry.id), entityId: this.redact(entry.entityId), kind: this.redact(entry.kind), status: this.redact(entry.status), message: this.redact(entry.message).replace(/https?:\/\/[^\s<>"']+/gi, '[链接已隐藏]'), channel: this.redact(entry.channel), attempts: attemptsFor(entry), updatedAt: this.redact(clean(entry.updatedAt, 80)) }));
  }
  updateConfig(input) {
    const operation = this.configQueue.then(async () => {
      const config = normalizeConfig(input, this.config);
      const revision = this.revision + 1;
      await this.atomic('notifications.json', { version: 1, revision, config });
      this.config = config; this.revision = revision;
      return this.getSafeConfig();
    });
    this.configQueue = operation.catch(() => {});
    return operation;
  }
  redact(value, config = this.config) {
    let message = clean(value, 4000);
    for (const secret of [config.email.password, config.wechat.token]) if (secret) message = message.split(secret).join('[已隐藏]');
    return message.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [已隐藏]').slice(0, 600);
  }
  sendOpportunity(opportunity, { decisionUrl = '' } = {}) {
    if (!opportunity?.id) return Promise.reject(new Error('选题缺少编号，不能去重发送'));
    return this.send('opportunity', opportunity.id, opportunityMessage(opportunity, safeUrl(decisionUrl)));
  }
  sendResult(project, { resultUrl = '' } = {}) {
    if (!project?.id) return Promise.reject(new Error('作品缺少编号，不能去重发送'));
    return this.send('result', project.id, resultMessage(project, safeUrl(resultUrl)));
  }
  retryOpportunity(opportunity, { decisionUrl = '' } = {}) {
    if (!opportunity?.id) return Promise.reject(new Error('选题缺少编号，不能去重发送'));
    return this.send('opportunity', opportunity.id, opportunityMessage(opportunity, safeUrl(decisionUrl)), { retry: true });
  }
  retryResult(project, { resultUrl = '' } = {}) {
    if (!project?.id) return Promise.reject(new Error('作品缺少编号，不能去重发送'));
    return this.send('result', project.id, resultMessage(project, safeUrl(resultUrl)), { retry: true });
  }
  test() {
    return this.send('test', randomUUID(), { subject: '图文工坊 · 通知测试', lines: [['状态', '这是一条手动触发的测试通知。']], note: '收到此消息表示当前通知通道可以受理消息；无需任何操作。', link: '', action: '' });
  }
  send(kind, entityId, message, { retry = false } = {}) {
    const id = createHash('sha256').update(`${kind}:${entityId}`).digest('hex');
    if (this.pending.has(id)) {
      if (retry) return Promise.reject(Object.assign(new Error('这条通知正在发送，请等待当前尝试完成'), { status: 409 }));
      return this.pending.get(id);
    }
    const operation = this.sendOnce({ id, kind, entityId: clean(entityId, 200), message, retry });
    this.pending.set(id, operation);
    operation.finally(() => this.pending.delete(id)).catch(() => {});
    return operation;
  }
  attemptRecord(entry, manual = false) {
    return { attempt: attemptsFor(entry), status: entry.status, channel: entry.channel, message: this.redact(entry.message), manual, attemptedAt: entry.updatedAt, updatedAt: entry.updatedAt };
  }
  async sendOnce({ id, kind, entityId, message, retry = false }) {
    const config = clone(this.config), revision = this.revision;
    const previous = this.outbox.find(entry => entry.id === id);
    if (!retry && previous) return { ...clone(previous), duplicate: true };
    if (retry && previous && !['failed', 'skipped'].includes(previous.status)) invalid('仅明确失败或未配置而跳过的通知可以重试；已受理、受理未知或正在发送的通知不会重复发送', 409);
    if (retry && manualAttemptsFor(previous) >= MAX_MANUAL_ATTEMPTS) invalid('这条通知已达到 5 次手动重试上限，请检查通知配置与服务商状态', 429);
    const state = readiness(config);
    if (retry && !state.configured) invalid(state.readiness);
    const entry = { id, kind, entityId, channel: config.channel, revision, attempts: previous ? attemptsFor(previous) + 1 : 1, manualAttempts: manualAttemptsFor(previous) + (retry ? 1 : 0), attemptHistory: clone(previous?.attemptHistory || []), status: state.configured ? 'sending' : 'skipped', message: state.configured ? '正在请求通知服务商。' : state.readiness, createdAt: previous?.createdAt || this.timestamp(), updatedAt: this.timestamp() };
    entry.attemptHistory.push(this.attemptRecord(entry, retry));
    entry.attemptHistory = entry.attemptHistory.slice(-MAX_ATTEMPT_HISTORY);
    if (previous) this.outbox.splice(this.outbox.indexOf(previous), 1, entry); else this.outbox.push(entry);
    await this.persistOutbox();
    if (!state.configured) return clone(entry);
    try {
      const rendered = renderMessage(message);
      const result = config.channel === 'email' ? await this.email(config, message.subject, rendered) : await this.wechat(config, message.subject, rendered.html);
      Object.assign(entry, result);
    } catch (error) {
      const knownFailure = ['EAUTH', 'EENVELOPE', 'ECONFIG', 'ETLS', 'EDNS', 'ENOTFOUND', 'ECONNREFUSED'].includes(error.code) || (error.responseCode >= 400 && error.responseCode < 600);
      entry.status = knownFailure ? 'failed' : 'unknown';
      entry.message = `${knownFailure ? '通知服务未受理' : '通知是否受理未知，不会自动重发'}：${this.redact(error.message || '请求失败', config)}`;
    }
    entry.message = this.redact(entry.message, config);
    if (entry.providerMessageId) entry.providerMessageId = this.redact(entry.providerMessageId, config);
    entry.updatedAt = this.timestamp();
    Object.assign(entry.attemptHistory.at(-1), { status: entry.status, message: entry.message, updatedAt: entry.updatedAt });
    await this.persistOutbox();
    return clone(entry);
  }
  async email(config, subject, rendered) {
    const email = config.email;
    const options = { host: email.host, port: email.port, secure: email.secure, requireTLS: !email.secure, auth: { user: email.user, pass: email.password }, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true }, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000, disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false };
    const mail = { from: email.from, to: email.to, subject: clean(subject, 250).replace(/[\r\n]/g, ' '), text: rendered.text, html: rendered.html, messageId: `<${randomUUID()}@content-studio.local>`, disableFileAccess: true, disableUrlAccess: true };
    let info;
    if (this.sendMailImpl) info = await this.sendMailImpl(mail, options);
    else { const transport = nodemailer.createTransport(options); try { info = await transport.sendMail(mail); } finally { transport.close(); } }
    const accepted = (info?.accepted || []).map(item => String(typeof item === 'object' ? item.address : item).toLowerCase());
    if (!accepted.includes(email.to.toLowerCase())) return { status: 'failed', message: 'SMTP 未受理收件邮箱，请检查邮箱地址与授权码。' };
    return { status: 'accepted', message: 'SMTP 已受理，最终投递情况请查看收件邮箱。', providerMessageId: clean(info.messageId, 200) };
  }
  async wechat(config, subject, content) {
    const response = await this.fetchImpl('https://www.pushplus.plus/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: config.wechat.token, title: clean(subject, 100), content, template: 'html', channel: 'wechat' }), signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) return { status: response.status < 500 ? 'failed' : 'unknown', message: `PushPlus 返回 HTTP ${response.status}，${response.status < 500 ? '未受理消息' : '受理状态未知，不会自动重发'}。` };
    const payload = await response.json();
    if (Number(payload.code) !== 200) return { status: 'failed', message: `PushPlus 未受理：${clean(payload.msg || payload.message || `业务码 ${payload.code}`, 400)}` };
    return { status: 'accepted', message: 'PushPlus 已受理，微信最终送达以服务商投递状态为准。', providerMessageId: clean(typeof payload.data === 'string' ? payload.data : payload.data?.shortCode, 200) };
  }
}
