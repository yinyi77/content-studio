import path from 'node:path';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const CONNECTION_STATES = new Set(['disconnected', 'connecting', 'connected', 'login_required', 'needs_attention', 'browser_unavailable']);
const DRAFT_STATES = new Set(['queued', 'running', 'filled', 'verified', 'unknown', 'failed', 'interrupted']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const clipped = (value, max = 600) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '';
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
const clippedText = (value, max) => Array.from(clipped(value, max * 2)).slice(0, max).join('');
function required(value, label, max, { empty = false } = {}) { if (typeof value !== 'string' || (!empty && !value.trim()) || Array.from(value).length > max) fail(`${label}请填写${max}字以内的文本`); return value.trim(); }
function url(value, { image = false } = {}) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    if (!image && parsed.hostname !== 'xiaohongshu.com' && !parsed.hostname.endsWith('.xiaohongshu.com')) return '';
    parsed.hash = '';
    if (!image) parsed.search = '';
    else for (const name of [...parsed.searchParams.keys()]) if (/cookie|token|auth|secret|key/i.test(name)) parsed.searchParams.delete(name);
    return parsed.href;
  } catch { return ''; }
}
function account(value) {
  if (!object(value) || typeof value.id !== 'string' || !ACCOUNT_ID.test(value.id)) return null;
  return { id: value.id, nickname: clipped(value.nickname, 120) || '小红书账号', avatar: url(value.avatar, { image: true }), url: url(value.url),
    followers: number(value.followers), following: number(value.following), likes: number(value.likes), notesCount: number(value.notesCount) };
}
function metrics(value) {
  return (Array.isArray(value) ? value : []).slice(0, 50).filter(item => object(item) && /^[a-zA-Z0-9_-]{1,100}$/.test(item.id)).map(item => ({
    id: item.id, label: clipped(item.label, 100), value: number(item.value), unit: clipped(item.unit, 40), source: clipped(item.source, 200), period: clipped(item.period, 200),
  }));
}
function notes(value) {
  return (Array.isArray(value) ? value : []).slice(0, 50).filter(item => object(item) && typeof item.id === 'string' && ACCOUNT_ID.test(item.id)).map(item => ({
    id: item.id, title: clipped(item.title, 300), url: url(item.url), publishedAt: timestamp(item.publishedAt),
    likes: number(item.likes), comments: number(item.comments), collects: number(item.collects), views: number(item.views), imageUrl: url(item.imageUrl, { image: true }),
  }));
}
const defaultCoverage = () => ({ message: '尚未同步；仅显示当前账号页面实际可见的数据。', hasMore: null, limit: 50 });
const blank = () => ({ version: 1, account: null, connection: { state: 'disconnected', message: '连接你的电脑端小红书账号。', browserOpen: false, lastCheckedAt: null },
  sync: { running: false, lastSyncAt: null, error: '', coverage: defaultCoverage() }, metrics: [], notes: [], drafts: [],
  status: { busy: false, action: '', message: '', error: '' }, history: [] });

/** A single local browser worker; loading saved state never performs an account action. */
export class XhsAccountService {
  constructor({ dir, driver, now = Date.now } = {}) {
    if (!dir || !driver) throw new Error('小红书账号服务缺少数据目录或浏览器连接器');
    this.dir = path.resolve(dir); this.file = path.join(this.dir, 'xhs-account.json'); this.driver = driver; this.now = now;
    this.data = blank(); this.persistence = Promise.resolve(); this.active = null; this.inFlight = null; this.closed = false;
  }
  iso() { return new Date(this.now()).toISOString(); }
  safe(value) {
    let message = clipped(value, 2000);
    for (const content of this.data.drafts.map(draft => draft.content).filter(content => content && content.length >= 8)) message = message.split(content).join('[稿件正文已隐藏]');
    for (const local of [this.dir, ...this.data.drafts.flatMap(draft => draft.images || [])].sort((a, b) => b.length - a.length)) if (local) message = message.split(local).join('[本机路径]');
    return message.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[登录凭据已隐藏]')
      .replace(/\b(?:cookie|authorization|token|password|x-s|x-t)\s*[:=]\s*[^\r\n;]+/gi, '[登录凭据已隐藏]')
      .replace(/(?:\/(?:Users|home|private|tmp|var|Applications|opt)\/[^\s"'<>]+|[A-Z]:\\[^\s"'<>]+)/g, '[本机路径]').slice(0, 600);
  }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const raw = await readFile(this.file, 'utf8'); if (Buffer.byteLength(raw) > 12 * 1024 * 1024) throw new Error('小红书连接记录过大');
      const saved = JSON.parse(raw); if (!object(saved) || saved.version !== 1) throw new Error('小红书连接记录格式无效');
      this.data.account = account(saved.account);
      this.data.metrics = metrics(saved.metrics); this.data.notes = notes(saved.notes);
      this.data.connection = { state: this.data.account ? 'needs_attention' : 'disconnected', message: this.data.account ? '服务已重启，请检查登录后继续操作；未自动打开浏览器。' : '连接你的电脑端小红书账号。', browserOpen: false, lastCheckedAt: timestamp(saved.connection?.lastCheckedAt) };
      this.data.sync.lastSyncAt = timestamp(saved.sync?.lastSyncAt); this.data.sync.error = this.safe(saved.sync?.error);
      this.data.sync.coverage = this.coverage(saved.sync?.coverage);
      this.data.drafts = (Array.isArray(saved.drafts) ? saved.drafts : []).slice(-100).filter(item => object(item) && UUID.test(item.id) && UUID.test(item.projectId) && ACCOUNT_ID.test(item.accountId) && /^[a-f0-9]{64}$/i.test(item.fingerprint) && DRAFT_STATES.has(item.status)).map(item => ({
        id: item.id, projectId: item.projectId, accountId: item.accountId, fingerprint: item.fingerprint, title: clippedText(item.title, 20), content: clippedText(item.content, 1000),
        images: (Array.isArray(item.images) ? item.images : []).filter(image => typeof image === 'string' && path.isAbsolute(image) && image.length <= 4096).slice(0, 18),
        status: ['queued', 'running', 'interrupted'].includes(item.status) ? 'unknown' : item.status, submitted: ['queued', 'running', 'interrupted', 'unknown', 'verified'].includes(item.status) ? true : item.submitted !== false,
        operation: item.operation === 'recheck' ? 'recheck' : 'save',
        message: ['queued', 'running', 'interrupted'].includes(item.status) ? item.operation === 'recheck' ? '上次草稿核验被中断，原稿已保留；可再次核验，不会重新上传。' : '上次操作被中断，是否暂存未知，请先核对电脑端草稿；不会自动重传。' : this.safe(item.message),
        attempts: Math.min(5, Math.max(1, Number.isInteger(item.attempts) ? item.attempts : 1)), createdAt: timestamp(item.createdAt) || this.iso(), updatedAt: timestamp(item.updatedAt) || this.iso(), verifiedAt: timestamp(item.verifiedAt),
      }));
      this.data.history = (Array.isArray(saved.history) ? saved.history : []).slice(-40).filter(item => object(item)).map(item => ({ id: UUID.test(item.id) ? item.id : randomUUID(), action: clipped(item.action, 50), state: clipped(item.state, 40), message: this.safe(item.message), at: timestamp(item.at) || this.iso(), accountId: typeof item.accountId === 'string' && ACCOUNT_ID.test(item.accountId) ? item.accountId : null }));
      if (saved.status?.busy || this.data.drafts.some(item => item.status === 'unknown')) this.data.status.message = '已保留上次记录，不会自动同步或重传草稿。';
      await chmod(this.file, 0o600); await this.persist();
    } catch (error) {
      if (error.code !== 'ENOENT') { this.data.status.error = '本机小红书记录读取失败，请检查数据文件后重新连接。'; this.data.connection.state = 'needs_attention'; }
    }
    return this.snapshot();
  }
  coverage(value) { return { message: this.safe(value?.message) || defaultCoverage().message, hasMore: typeof value?.hasMore === 'boolean' ? value.hasMore : null, limit: Math.min(50, Math.max(1, Number.isInteger(value?.limit) ? value.limit : 50)) }; }
  safeDraft(item) { return { id: item.id, projectId: item.projectId, accountId: item.accountId, title: item.title, fingerprint: item.fingerprint, status: item.status,
    createdAt: item.createdAt, updatedAt: item.updatedAt, message: this.safe(item.message), verifiedAt: item.verifiedAt || null, attempts: item.attempts,
    operation: item.operation === 'recheck' ? 'recheck' : 'save', rechecking: item.operation === 'recheck' && ['queued', 'running'].includes(item.status),
    canRecheck: ['filled', 'unknown'].includes(item.status) && typeof this.driver.verifyDraft === 'function',
    canRetry: item.status === 'failed' && item.submitted === false && item.attempts < 5 };
  }
  snapshot() {
    const id = this.data.account?.id;
    return { account: clone(this.data.account), connection: clone(this.data.connection), sync: clone(this.data.sync), metrics: id ? clone(this.data.metrics) : [], notes: id ? clone(this.data.notes) : [],
      drafts: this.data.drafts.filter(item => id && item.accountId === id).map(item => this.safeDraft(item)).reverse(), status: clone(this.data.status),
      history: this.data.history.filter(item => !item.accountId || item.accountId === id).map(item => ({ ...clone(item), message: this.safe(item.message) })).reverse() };
  }
  async persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const operation = this.persistence.catch(() => {}).then(async () => {
      const temp = `${this.file}.${randomUUID()}.tmp`; await writeFile(temp, snapshot, { mode: 0o600 }); await rename(temp, this.file);
    });
    this.persistence = operation; await operation;
  }
  idle() { if (this.closed) fail('小红书账号连接器已关闭', 503); if (this.active) fail('小红书账号正在处理另一项操作，请稍后重试', 409); }
  connected(expected) {
    if (!this.data.account || this.data.connection.state !== 'connected') fail('请先连接小红书并检查登录状态', 409);
    if (expected && expected !== this.data.account.id) fail('目标账号已经变化，请核对当前小红书账号', 409);
    return this.data.account.id;
  }
  record(action, state, message) {
    this.data.history.push({ id: randomUUID(), action, state, message: this.safe(message), at: this.iso(), accountId: this.data.account?.id || null });
    this.data.history = this.data.history.slice(-40);
  }
  applyConnection(result) {
    const incoming = account(result?.account), current = this.data.account;
    this.data.connection.browserOpen = result?.browserOpen !== false;
    this.data.connection.lastCheckedAt = this.iso();
    if (result?.accountMismatch || (incoming && current && incoming.id !== current.id)) {
      this.data.metrics = []; this.data.notes = []; this.data.sync.lastSyncAt = null; this.data.sync.coverage = defaultCoverage();
      this.data.connection.state = 'needs_attention';
      this.data.connection.message = '浏览器中的账号与已连接账号不同。请先断开连接，再连接要使用的账号。';
      return false;
    }
    let state = CONNECTION_STATES.has(result?.state) ? result.state : 'needs_attention';
    if (state === 'connected' && !incoming) state = 'needs_attention';
    this.data.connection.state = state;
    this.data.connection.message = this.safe(result?.message) || (state === 'connected' ? '电脑端账号已连接。' : '请在打开的浏览器中完成登录或验证，再检查登录。');
    if (state === 'connected') this.data.account = incoming;
    return state === 'connected';
  }
  async launch(action, work) {
    this.idle(); const token = { action }; this.active = token;
    this.data.status = { busy: true, action, message: ({ login: '正在打开小红书登录窗口', check: '正在检查账号登录状态', sync: '正在同步账号页面可见数据', open_drafts: '正在打开电脑端草稿', save_draft: '正在准备并暂存图文', verify_draft: '正在重新读取并核验电脑草稿', disconnect: '正在断开本平台账号连接' })[action] || '正在处理', error: '' };
    if (action === 'sync') this.data.sync.running = true;
    try { await this.persist(); } catch {
      this.active = null; this.data.status.busy = false; this.data.sync.running = false;
      this.data.status.error = '连接记录无法保存，本次操作未执行';
      if (this.data.connection.state === 'connecting') this.data.connection.state = 'needs_attention';
      fail(this.data.status.error, 503);
    }
    this.inFlight = Promise.resolve().then(() => work(token)).catch(error => {
      if (this.active !== token) return;
      const message = '浏览器操作未完成，请在专用小红书浏览器中核对登录或页面状态后再继续。';
      this.data.status.error = message;
      this.data.connection.state = 'needs_attention'; this.data.connection.message = message;
      if (action === 'sync') this.data.sync.error = message;
      this.record(action, 'error', message);
    }).finally(async () => {
      if (this.active !== token) return;
      this.active = null; this.data.status.busy = false; this.data.sync.running = false;
      try { await this.persist(); } catch { this.data.status.error = '操作记录保存失败，请先核对电脑端实际结果。'; }
    });
    return this.snapshot();
  }
  async startLogin() {
    this.idle();
    this.data.connection.state = 'connecting';
    return this.launch('login', async token => {
      const result = await this.driver.openLogin(); if (this.active !== token) return;
      this.applyConnection(result); this.data.status.message = this.data.connection.message;
      this.record('login', this.data.connection.state, this.data.connection.message);
    });
  }
  async checkLogin() {
    return this.launch('check', async token => {
      const result = await this.driver.inspectAccount(); if (this.active !== token) return;
      this.applyConnection(result); this.data.status.message = this.data.connection.message;
      this.record('check', this.data.connection.state, this.data.connection.message);
    });
  }
  async startSync() {
    this.idle(); const expected = this.connected();
    return this.launch('sync', async token => {
      const result = await this.driver.sync(); if (this.active !== token) return;
      if (!this.applyConnection(result) || result?.account?.id !== expected) {
        this.data.sync.error = this.data.connection.message; this.data.status.error = this.data.connection.message;
        this.record('sync', 'blocked', this.data.connection.message); return;
      }
      this.data.metrics = metrics(result.metrics); this.data.notes = notes(result.notes);
      this.data.sync = { running: true, lastSyncAt: this.iso(), error: '', coverage: this.coverage(result.coverage) };
      this.data.status.message = '已同步当前账号可见数据；未提供的指标显示为未获取。';
      this.record('sync', 'completed', this.data.status.message);
    });
  }
  async openDrafts() {
    this.idle(); this.connected();
    return this.launch('open_drafts', async token => {
      const result = await this.driver.openDrafts(); if (this.active !== token) return;
      this.applyConnection(result); this.data.status.message = this.data.connection.message;
      this.record('open_drafts', this.data.connection.state, this.data.connection.message);
    });
  }
  async disconnect() {
    return this.launch('disconnect', async token => {
      await this.driver.close(); if (this.active !== token) return;
      this.data.account = null; this.data.metrics = []; this.data.notes = [];
      this.data.connection = { state: 'disconnected', message: '已断开本平台连接并关闭专用浏览器；官方登录状态仍保存在这台电脑。', browserOpen: false, lastCheckedAt: this.iso() };
      this.data.sync = { running: false, lastSyncAt: null, error: '', coverage: defaultCoverage() };
      this.data.status.message = this.data.connection.message;
      this.record('disconnect', 'completed', this.data.connection.message);
    });
  }
  async submitDraft(input) {
    if (!object(input) || !UUID.test(input.projectId)) fail('请选择已有图文作品');
    if (!this.data.account || input.accountId && input.accountId !== this.data.account.id) fail('目标账号已经变化，请核对当前小红书账号', 409);
    const accountId = this.data.account.id;
    if (typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(input.fingerprint)) fail('图文版本编号无效');
    const old = this.data.drafts.find(item => item.projectId === input.projectId && item.accountId === accountId && item.fingerprint === input.fingerprint);
    if (old) return { draft: this.safeDraft(old), snapshot: this.snapshot(), duplicate: true };
    this.idle(); this.connected(input.accountId);
    const title = required(input.title, '帖子标题', 20), content = required(input.content, '帖子正文', 1000, { empty: true });
    if (!Array.isArray(input.images) || input.images.length < 1 || input.images.length > 18 || input.images.some(image => typeof image !== 'string' || !path.isAbsolute(image) || image.length > 4096)) fail('请准备1到18张有效的本机图片');
    const item = { id: randomUUID(), projectId: input.projectId, accountId, title, content, images: [...input.images], fingerprint: input.fingerprint,
      status: 'queued', operation: 'save', submitted: false, attempts: 1, createdAt: this.iso(), updatedAt: this.iso(), message: '图文已冻结，准备送入电脑端草稿。', verifiedAt: null };
    this.data.drafts.push(item); this.data.drafts = this.data.drafts.slice(-100);
    try { await this.saveDraft(item); }
    catch (error) {
      item.status = 'failed'; item.submitted = false; item.message = '任务记录无法保存，尚未上传或点击暂存；恢复保存后可明确重试。'; item.updatedAt = this.iso();
      await this.persist().catch(() => {}); throw error;
    }
    return { draft: this.safeDraft(item), snapshot: this.snapshot(), duplicate: false };
  }
  async retryDraft(id) {
    this.idle(); const accountId = this.connected();
    const item = this.data.drafts.find(value => value.id === id && value.accountId === accountId);
    if (!item) fail('草稿记录不存在', 404);
    if (item.status !== 'failed' || item.submitted !== false) fail('只有确认未点击暂存的失败稿件可重试；请先核对电脑端草稿', 409);
    if (item.attempts >= 5) fail('这份草稿已达到5次尝试上限，请检查浏览器中的实际情况', 429);
    const attempts = item.attempts;
    item.attempts++; item.status = 'queued'; item.updatedAt = this.iso(); item.message = '正在按原图文版本重试。';
    try { await this.saveDraft(item); }
    catch (error) {
      item.attempts = attempts; item.status = 'failed'; item.submitted = false; item.message = '重试记录无法保存，未执行浏览器操作。'; item.updatedAt = this.iso();
      await this.persist().catch(() => {}); throw error;
    }
    return { draft: this.safeDraft(item), snapshot: this.snapshot() };
  }
  async recheckDraft(id, { accountId: expected } = {}) {
    this.idle(); const accountId = this.connected(expected);
    if (!UUID.test(String(id || ''))) fail('草稿记录不存在', 404);
    const item = this.data.drafts.find(value => value.id === id && value.accountId === accountId);
    if (!item) fail('草稿记录不存在', 404);
    if (item.status === 'verified') return { draft: this.safeDraft(item), snapshot: this.snapshot(), duplicate: true };
    if (!['filled', 'unknown'].includes(item.status)) fail('这份草稿暂不需要重新核验，请等当前操作完成', 409);
    if (typeof this.driver.verifyDraft !== 'function') fail('当前浏览器连接器暂不支持重新核验草稿', 503);
    const previous = { status: item.status, submitted: item.submitted, message: item.message, operation: item.operation, verifiedAt: item.verifiedAt };
    item.status = 'queued'; item.operation = 'recheck'; item.message = '正在按原稿重新核验，未重新上传或保存。'; item.updatedAt = this.iso();
    try {
      await this.launch('verify_draft', async token => {
        item.status = 'running'; item.updatedAt = this.iso();
        let result;
        try {
          await this.persist();
          if (this.active !== token) return;
          result = await this.driver.verifyDraft({ accountId: item.accountId, title: item.title, content: item.content, count: item.images.length, fingerprint: item.fingerprint });
        } catch { result = { state: 'unknown', message: '重新核验未完成，原草稿记录已保留；未重新上传或保存。' }; }
        if (this.active !== token) return;
        const mismatch = result?.accountMismatch || result?.accountId && result.accountId !== item.accountId;
        if (mismatch) {
          this.applyConnection({ state: 'needs_attention', accountMismatch: true, browserOpen: result.browserOpen });
          result = { ...result, state: 'unknown', message: this.data.connection.message };
        } else if (result?.needsAttention) {
          this.data.connection.state = 'needs_attention'; this.data.connection.message = this.safe(result.message) || '请检查专用浏览器中的账号登录状态。';
          this.data.connection.lastCheckedAt = this.iso();
        }
        const verified = result?.state === 'verified' && result.accountId === item.accountId && timestamp(result.verifiedAt) && !mismatch;
        item.status = verified ? 'verified' : previous.status;
        item.submitted = verified ? true : previous.submitted;
        item.verifiedAt = verified ? timestamp(result.verifiedAt) : previous.verifiedAt;
        item.message = this.safe(result?.message) || (verified ? '已重新读取并核验电脑草稿，内容与原稿一致。' : '尚未核验到该版本，原草稿记录已保留；未重新上传或保存。');
        if (result?.state === 'verified' && !verified) item.message = '连接器未提供完整的账号与核验结果，原记录已保留；未重新上传或保存。';
        item.updatedAt = this.iso(); this.data.status.message = item.message;
        if (!verified) this.data.status.error = item.message;
        this.record('verify_draft', item.status, item.message);
      });
    } catch (error) {
      Object.assign(item, previous, { updatedAt: this.iso() });
      await this.persist().catch(() => {}); throw error;
    }
    return { draft: this.safeDraft(item), snapshot: this.snapshot(), duplicate: false };
  }
  async saveDraft(item) {
    return this.launch('save_draft', async token => {
      item.status = 'running'; item.updatedAt = this.iso(); await this.persist();
      if (this.active !== token) return;
      let result;
      try { result = await this.driver.saveDraft({ accountId: item.accountId, title: item.title, content: item.content, images: [...item.images], fingerprint: item.fingerprint }); }
      catch { result = { state: 'unknown', submitted: true, message: '暂存过程被中断，结果待核对；不会自动重传。' }; }
      if (this.active !== token) return;
      const mismatch = result?.accountMismatch || result?.accountId && result.accountId !== item.accountId;
      if (mismatch) {
        this.applyConnection({ state: 'needs_attention', accountMismatch: true, browserOpen: result.browserOpen });
        result = { ...result, state: result.submitted === false ? 'failed' : 'unknown', message: this.data.connection.message };
      } else if (result?.needsAttention) {
        this.data.connection.state = 'needs_attention';
        this.data.connection.message = this.safe(result.message) || '请在专用浏览器核对登录或账号后，重新检查连接。';
        this.data.connection.lastCheckedAt = this.iso();
      }
      const verified = result?.state === 'verified' && result.accountId === item.accountId && result.submitted === true && timestamp(result.verifiedAt);
      if (verified) { item.status = 'verified'; item.submitted = true; item.verifiedAt = timestamp(result.verifiedAt); }
      else if (['failed', 'filled'].includes(result?.state) && result.submitted === false) { item.status = result.state; item.submitted = false; }
      else { item.status = 'unknown'; item.submitted = true; }
      item.message = this.safe(result?.message) || ({ verified: '电脑端草稿已重新打开核验；尚未发布。', filled: '已填入电脑发布页，请在浏览器中继续核对和暂存。', failed: '暂存前操作失败，请检查浏览器后明确重试。', unknown: '草稿结果待核对，请先检查电脑端草稿；不会自动重传。' })[item.status];
      if (result?.state === 'verified' && !verified) item.message = '连接器未提供完整的账号与草稿核验结果，请先检查电脑端草稿；不会自动重传。';
      item.updatedAt = this.iso(); this.data.status.message = item.message;
      if (['unknown', 'failed'].includes(item.status)) this.data.status.error = item.message;
      this.record('save_draft', item.status, item.message);
    });
  }
  async close() {
    this.closed = true; this.active = null;
    for (const item of this.data.drafts) if (['queued', 'running'].includes(item.status)) { item.status = 'unknown'; item.submitted = true; item.updatedAt = this.iso(); item.message = item.operation === 'recheck' ? '草稿核验已停止，原稿记录已保留；可再次核验，不会重新上传。' : '连接器已停止，暂存结果待核对；不会自动重传。'; }
    this.data.status.busy = false; this.data.sync.running = false; this.data.connection.browserOpen = false;
    if (this.data.account) { this.data.connection.state = 'needs_attention'; this.data.connection.message = '浏览器连接已关闭，请检查登录后继续。'; }
    await this.persist().catch(() => {}); await this.driver.close();
  }
}
