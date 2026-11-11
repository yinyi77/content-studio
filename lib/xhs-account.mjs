import path from 'node:path';
import { mkdir, readFile, writeFile, rename, chmod, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { XhsMediaCache, normalizeXhsImageUrl } from './xhs-media.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const CONNECTION_STATES = new Set(['disconnected', 'connecting', 'connected', 'login_required', 'needs_attention', 'browser_unavailable']);
const DRAFT_STATES = new Set(['queued', 'running', 'filled', 'verified', 'unknown', 'failed', 'interrupted']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const clipped = (value, max = 600) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '';
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
// The account workspace groups samples by the creator's Beijing calendar day.
const accountDay = value => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10);
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
function notes(value, limit = 50) {
  return (Array.isArray(value) ? value : []).slice(0, limit).filter(item => object(item) && typeof item.id === 'string' && ACCOUNT_ID.test(item.id)).map(item => ({
    id: item.id, title: clipped(item.title, 300), url: url(item.url), publishedAt: timestamp(item.publishedAt),
    likes: number(item.likes), comments: number(item.comments), collects: number(item.collects), views: number(item.views), imageUrl: url(item.imageUrl, { image: true }),
  }));
}
const defaultCoverage = () => ({ message: '尚未同步；仅显示当前账号页面实际可见的数据。', hasMore: null, limit: 50 });
const defaultOfficialSync = () => ({ running: false, lastSyncAt: null, error: '', coverage: { message: '尚未读取电脑端官方草稿。', hasMore: null, limit: 100 } });
const emptyCache = () => ({ account: null, metrics: [], notes: [], sync: { running: false, lastSyncAt: null, error: '', coverage: defaultCoverage() }, noteDetails: Object.create(null), noteStatuses: Object.create(null), officialDrafts: [], officialDraftDetails: Object.create(null), officialDraftStatuses: Object.create(null), officialDraftSync: defaultOfficialSync(), analyticsHistory: [], history: [] });
const blank = () => ({ version: 1, account: null, connection: { state: 'disconnected', message: '连接你的电脑端小红书账号。', browserOpen: false, lastCheckedAt: null },
  sync: { running: false, lastSyncAt: null, error: '', coverage: defaultCoverage() }, metrics: [], notes: [], drafts: [],
  status: { busy: false, action: '', message: '', error: '' }, history: [], accountCaches: Object.create(null) });

/** A single local browser worker; loading saved state never performs an account action. */
export class XhsAccountService {
  constructor({ dir, driver, stateFile, validateAccount, now = Date.now } = {}) {
    if (!dir || !driver) throw new Error('小红书账号服务缺少数据目录或浏览器连接器');
    this.dir = path.resolve(dir); this.file = stateFile ? path.resolve(stateFile) : path.join(this.dir, 'xhs-account.json'); this.driver = driver; this.now = now;
    const relative = path.relative(this.dir, this.file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('小红书账号状态文件必须位于本机数据目录');
    this.validateAccount = typeof validateAccount === 'function' ? validateAccount : null;
    this.media = new XhsMediaCache({ dir: this.dir });
    this.data = blank(); this.liveDraftKeys = new Set(); this.accountMismatch = false; this.privateReadContent = ''; this.persistence = Promise.resolve(); this.active = null; this.inFlight = null; this.closed = false;
  }
  iso() { return new Date(this.now()).toISOString(); }
  safe(value) {
    let message = clipped(value, 2000);
    for (const content of [this.privateReadContent, ...this.data.drafts.map(draft => draft.content), ...Object.values(this.data.accountCaches).flatMap(cache => [...Object.values(cache.noteDetails || {}), ...Object.values(cache.officialDraftDetails || {})].map(detail => detail.content))].filter(content => content && content.length >= 8)) message = message.split(content).join('[稿件正文已隐藏]');
    for (const local of [this.dir, ...this.data.drafts.flatMap(draft => draft.images || [])].sort((a, b) => b.length - a.length)) if (local) message = message.split(local).join('[本机路径]');
    return message.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[登录凭据已隐藏]')
      .replace(/\b(?:cookie|authorization|token|password|x-s|x-t)\s*[:=]\s*[^\r\n;]+/gi, '[登录凭据已隐藏]')
      .replace(/(?:\/(?:Users|home|private|tmp|var|Applications|opt)\/[^\s"'<>]+|[A-Z]:\\[^\s"'<>]+)/g, '[本机路径]').slice(0, 600);
  }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const raw = await readFile(this.file, 'utf8'); if (Buffer.byteLength(raw) > 64 * 1024 * 1024) throw new Error('小红书连接记录过大');
      const saved = JSON.parse(raw); if (!object(saved) || saved.version !== 1) throw new Error('小红书连接记录格式无效');
      this.data.account = account(saved.account);
      this.data.metrics = metrics(saved.metrics); this.data.notes = notes(saved.notes, 200);
      if (object(saved.accountCaches)) for (const [id, value] of Object.entries(saved.accountCaches).slice(-100)) if (ACCOUNT_ID.test(id) && object(value)) this.data.accountCaches[id] = this.restoreCache(value, id);
      this.data.connection = { state: this.data.account ? 'needs_attention' : 'disconnected', message: this.data.account ? '服务已重启，请检查登录后继续操作；未自动打开浏览器。' : '连接你的电脑端小红书账号。', browserOpen: false, lastCheckedAt: timestamp(saved.connection?.lastCheckedAt) };
      this.data.sync.lastSyncAt = timestamp(saved.sync?.lastSyncAt); this.data.sync.error = this.safe(saved.sync?.error);
      this.data.sync.coverage = this.coverage(saved.sync?.coverage, 200);
      if (this.data.account) {
        if (!this.data.accountCaches[this.data.account.id]) this.saveCurrentCache();
        else this.restoreCurrentCache(this.data.account.id);
      }
      this.data.drafts = (Array.isArray(saved.drafts) ? saved.drafts : []).slice(-100).filter(item => object(item) && UUID.test(item.id) && UUID.test(item.projectId) && ACCOUNT_ID.test(item.accountId) && /^[a-f0-9]{64}$/i.test(item.fingerprint) && DRAFT_STATES.has(item.status)).map(item => ({
        id: item.id, projectId: item.projectId, accountId: item.accountId, fingerprint: item.fingerprint, title: clippedText(item.title, 20), content: clippedText(item.content, 1000),
        images: (Array.isArray(item.images) ? item.images : []).filter(image => typeof image === 'string' && path.isAbsolute(image) && image.length <= 4096).slice(0, 18),
        status: ['queued', 'running', 'interrupted'].includes(item.status) ? 'unknown' : item.status, submitted: ['queued', 'running', 'interrupted', 'unknown', 'verified'].includes(item.status) ? true : item.submitted !== false,
        operation: item.operation === 'recheck' ? 'recheck' : 'save',
        message: ['queued', 'running', 'interrupted'].includes(item.status) ? item.operation === 'recheck' ? '上次草稿核验被中断，原稿已保留；可再次核验，不会重新上传。' : '上次操作被中断，是否暂存未知，请先核对电脑端草稿；不会自动重传。' : this.safe(item.message),
        attempts: Math.min(5, Math.max(1, Number.isInteger(item.attempts) ? item.attempts : 1)), createdAt: timestamp(item.createdAt) || this.iso(), updatedAt: timestamp(item.updatedAt) || this.iso(), verifiedAt: timestamp(item.verifiedAt),
      }));
      this.data.history = (Array.isArray(saved.history) ? saved.history : []).slice(-40).filter(item => object(item)).map(item => ({ id: UUID.test(item.id) ? item.id : randomUUID(), action: clipped(item.action, 50), state: clipped(item.state, 40), message: this.safe(item.message), at: timestamp(item.at) || this.iso(), accountId: typeof item.accountId === 'string' && ACCOUNT_ID.test(item.accountId) ? item.accountId : null }));
      for (const item of this.data.history) if (item.accountId && !Array.isArray(saved.accountCaches?.[item.accountId]?.history)) { const history = this.cache(item.accountId).history; history.push(clone(item)); this.cache(item.accountId).history = history.slice(-40); }
      if (saved.status?.busy || this.data.drafts.some(item => item.status === 'unknown')) this.data.status.message = '已保留上次记录，不会自动同步或重传草稿。';
      await chmod(this.file, 0o600); await this.persist();
    } catch (error) {
      if (error.code !== 'ENOENT') { this.data.status.error = '本机小红书记录读取失败，请检查数据文件后重新连接。'; this.data.connection.state = 'needs_attention'; }
    }
    return this.snapshot();
  }
  coverage(value, limit = 50) { return { message: this.safe(value?.message) || defaultCoverage().message, hasMore: typeof value?.hasMore === 'boolean' ? value.hasMore : null, limit: Math.min(limit, Math.max(1, Number.isInteger(value?.limit) ? value.limit : limit)) }; }
  cache(id = this.data.account?.id) {
    if (!id || !ACCOUNT_ID.test(id)) return null;
    return this.data.accountCaches[id] ||= emptyCache();
  }
  saveCurrentCache() {
    const cache = this.cache(); if (!cache) return null;
    if (this.accountMismatch) return cache;
    cache.account = clone(this.data.account); cache.metrics = clone(this.data.metrics); cache.notes = clone(this.data.notes);
    cache.sync = { ...clone(this.data.sync), running: false }; return cache;
  }
  restoreCurrentCache(id) {
    const cache = this.cache(id);
    this.data.metrics = clone(cache.metrics); this.data.notes = clone(cache.notes); this.data.sync = { ...clone(cache.sync), running: false };
  }
  detail(value, id, accountId = this.data.account?.id) {
    if (!object(value)) return null;
    return { id: typeof id === 'string' ? id : clipped(value.id, 200), title: clipped(value.title, 300), content: clippedText(value.content, 20000),
      images: (Array.isArray(value.images) ? value.images : []).slice(0, 18).map(image => normalizeXhsImageUrl(image, { accountId })).filter(Boolean),
      tags: (Array.isArray(value.tags) ? value.tags : []).slice(0, 50).map(tag => clipped(tag, 100)).filter(Boolean), url: url(value.url), source: 'official',
      isComplete: value.isComplete === true, message: this.safe(value.message), lastSyncAt: timestamp(value.lastSyncAt) };
  }
  contentStatus(value, detail) {
    return { state: ['ready', 'partial', 'error'].includes(value?.state) ? value.state : detail ? detail.isComplete ? 'ready' : 'partial' : 'not_loaded',
      running: value?.running === true, lastSyncAt: timestamp(value?.lastSyncAt) || timestamp(detail?.lastSyncAt), error: this.safe(value?.error), isComplete: detail?.isComplete === true };
  }
  restoreCache(value, id) {
    const cache = emptyCache(); cache.account = account(value.account); cache.metrics = metrics(value.metrics); cache.notes = notes(value.notes, 200);
    cache.sync = { running: false, lastSyncAt: timestamp(value.sync?.lastSyncAt), error: this.safe(value.sync?.error), coverage: this.coverage(value.sync?.coverage, 200) };
    for (const key of ['noteDetails', 'officialDraftDetails']) if (object(value[key])) for (const [detailId, item] of Object.entries(value[key]).slice(-200)) {
      if (!(key === 'noteDetails' ? ACCOUNT_ID.test(detailId) : UUID.test(detailId))) continue;
      const detail = this.detail(item, detailId, id); if (detail) cache[key][detailId] = detail;
    }
    for (const [statusKey, detailKey] of [['noteStatuses', 'noteDetails'], ['officialDraftStatuses', 'officialDraftDetails']]) {
      for (const detailId of new Set([...Object.keys(cache[detailKey]), ...Object.keys(object(value[statusKey]) ? value[statusKey] : {}).slice(-200)])) {
        if (!(statusKey === 'noteStatuses' ? ACCOUNT_ID.test(detailId) : UUID.test(detailId))) continue;
        cache[statusKey][detailId] = this.contentStatus(value[statusKey]?.[detailId], cache[detailKey][detailId]); cache[statusKey][detailId].running = false;
      }
    }
    cache.officialDrafts = this.officialDrafts(value.officialDrafts, { restored: true, accountId: id });
    cache.officialDraftSync = { running: false, lastSyncAt: timestamp(value.officialDraftSync?.lastSyncAt), error: this.safe(value.officialDraftSync?.error), coverage: this.coverage(value.officialDraftSync?.coverage, 200) };
    cache.analyticsHistory = (Array.isArray(value.analyticsHistory) ? value.analyticsHistory : []).slice(-365).filter(item => object(item) && item.accountId === id && timestamp(item.at)).map(item => ({
      accountId: id, at: timestamp(item.at), account: Object.fromEntries(['followers', 'following', 'likes', 'notesCount'].map(key => [key, number(item.account?.[key])])), metrics: metrics(item.metrics),
    }));
    cache.history = this.history(value.history, id); return cache;
  }
  history(value, expected) {
    return (Array.isArray(value) ? value : []).slice(-40).filter(item => object(item) && (!expected || item.accountId === expected)).map(item => ({ id: UUID.test(item.id) ? item.id : randomUUID(), action: clipped(item.action, 50), state: clipped(item.state, 40), message: this.safe(item.message), at: timestamp(item.at) || this.iso(), accountId: typeof item.accountId === 'string' && ACCOUNT_ID.test(item.accountId) ? item.accountId : null }));
  }
  officialDrafts(value, { restored = false, accountId = this.data.account?.id } = {}) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).slice(0, 200).filter(item => object(item) && UUID.test(item.key) && !seen.has(item.key) && seen.add(item.key)).map(item => ({
      key: item.key, officialDraftId: typeof item.officialDraftId === 'string' && ACCOUNT_ID.test(item.officialDraftId) ? item.officialDraftId : null,
      title: clipped(item.title, 300), imageUrl: normalizeXhsImageUrl(item.imageUrl, { accountId }), updatedAt: timestamp(item.updatedAt), updatedAtLabel: clipped(item.updatedAtLabel || item.updatedAt, 80), kind: clipped(item.kind, 40) || 'image', canRead: !restored && item.canRead === true,
    }));
  }
  currentAccount(expected) {
    const id = this.data.account?.id;
    if (!id || expected && expected !== id) fail('目标账号已经变化，请核对当前小红书账号', 409);
    return id;
  }
  operationError(action, message) {
    const cache = this.cache(); if (!cache) return;
    if (action === 'official_drafts') cache.officialDraftSync.error = message;
    if (this.detailOperation && this.detailOperation.action === action) {
      const { kind, key } = this.detailOperation; const statuses = kind === 'note' ? cache.noteStatuses : cache.officialDraftStatuses;
      statuses[key] = { ...this.contentStatus(statuses[key], (kind === 'note' ? cache.noteDetails : cache.officialDraftDetails)[key]), state: 'error', running: false, error: message };
    }
  }
  getNoteDetail(noteId, { accountId } = {}) {
    const id = this.currentAccount(accountId); if (!ACCOUNT_ID.test(String(noteId || ''))) fail('笔记记录不存在', 404);
    const cache = this.cache(id), detail = cache.noteDetails[noteId] || null;
    return { accountId: id, detail: detail ? { ...clone(detail), message: this.safe(detail.message) } : null, contentStatus: this.contentStatus(cache.noteStatuses[noteId], detail) };
  }
  async startNoteDetail(noteId, { accountId } = {}) {
    this.idle(); const id = this.connected(accountId); if (!ACCOUNT_ID.test(String(noteId || ''))) fail('笔记记录不存在', 404);
    const cache = this.cache(id); if (!this.data.notes.some(note => note.id === noteId) && !cache.noteDetails[noteId]) fail('请先同步当前账号的这篇笔记', 404);
    if (typeof this.driver.readNote !== 'function') fail('当前浏览器连接器暂不支持读取笔记正文', 503);
    return this.startDetail('note', noteId, id, () => this.driver.readNote({ accountId: id, noteId }));
  }
  async startOfficialDraftSync({ accountId } = {}) {
    this.idle(); const id = this.connected(accountId); if (typeof this.driver.listDrafts !== 'function') fail('当前浏览器连接器暂不支持读取官方草稿', 503);
    return this.launch('official_drafts', async token => {
      const cache = this.cache(id); cache.officialDraftSync.running = true;
      const result = await this.driver.listDrafts({ accountId: id }); if (this.active !== token) return;
      if (!this.applyConnection(result) || result?.account?.id !== id) {
        cache.officialDraftSync.error = this.data.connection.message; this.data.status.error = this.data.connection.message;
        this.record('official_drafts', 'blocked', this.data.connection.message); return;
      }
      if (!Array.isArray(result.officialDrafts)) { const message = this.safe(result.message) || '未能读取官方草稿，已保留上次列表。'; cache.officialDraftSync.error = message; this.data.status.error = message; this.record('official_drafts', 'error', message); return; }
      const prepared = []; let coverBytes = 0;
      for (const row of result.officialDrafts.slice(0, 200)) {
        if (!object(row)) continue;
        let imageUrl = row.imageUrl;
        if (object(row.coverAsset)) {
          coverBytes += typeof row.coverAsset.base64 === 'string' ? Math.ceil(row.coverAsset.base64.length * .75) : 0;
          if (coverBytes <= 64 * 1024 * 1024) {
            const cover = await this.media.materialize({ images: [null], imageAssets: [{ ...row.coverAsset, index: 0 }], isComplete: true }, { accountId: id });
            imageUrl = cover.images[0] || '';
          }
        }
        prepared.push({ ...row, imageUrl });
      }
      if (this.active !== token) return;
      const list = this.officialDrafts(prepared);
      // Session handles change on refresh. Only a genuine, unique official
      // draft ID can carry an explicitly dated cached preview to a new handle.
      for (const item of list) {
        if (!item.officialDraftId || cache.officialDrafts.filter(old => old.officialDraftId === item.officialDraftId).length !== 1 || list.filter(other => other.officialDraftId === item.officialDraftId).length !== 1) continue;
        const old = cache.officialDrafts.find(old => old.officialDraftId === item.officialDraftId), detail = cache.officialDraftDetails[old.key];
        if (detail) { cache.officialDraftDetails[item.key] = clone(detail); cache.officialDraftStatuses[item.key] = clone(cache.officialDraftStatuses[old.key]); }
      }
      for (const key of this.liveDraftKeys) if (key.startsWith(`${id}:`)) this.liveDraftKeys.delete(key);
      for (const item of list) if (item.canRead) this.liveDraftKeys.add(`${id}:${item.key}`);
      cache.officialDrafts = list; cache.officialDraftSync = { running: true, lastSyncAt: this.iso(), error: '', coverage: this.coverage(result.coverage, 200) };
      this.data.status.message = '已读取当前账号电脑端实际可见的官方草稿。'; this.record('official_drafts', 'completed', this.data.status.message);
    });
  }
  getOfficialDraftDetail(key, { accountId } = {}) {
    const id = this.currentAccount(accountId); if (!UUID.test(String(key || ''))) fail('官方草稿记录不存在', 404);
    const cache = this.cache(id); if (!cache.officialDrafts.some(item => item.key === key)) fail('官方草稿记录不存在', 404);
    const detail = cache.officialDraftDetails[key] || null;
    return { accountId: id, detail: detail ? { ...clone(detail), message: this.safe(detail.message) } : null, contentStatus: this.contentStatus(cache.officialDraftStatuses[key], detail) };
  }
  async startOfficialDraftDetail(key, { accountId, foreground = false } = {}) {
    this.idle(); const id = this.connected(accountId); if (!UUID.test(String(key || ''))) fail('官方草稿记录不存在', 404);
    const item = this.cache(id).officialDrafts.find(value => value.key === key);
    if (!item) fail('官方草稿记录不存在', 404);
    if (!item.canRead || !this.liveDraftKeys.has(`${id}:${key}`)) fail('请重新读取官方草稿列表后再打开这份草稿', 409);
    if (typeof this.driver.readDraft !== 'function') fail('当前浏览器连接器暂不支持读取官方草稿内容', 503);
    return this.startDetail('official_draft', key, id, () => this.driver.readDraft({ accountId: id, key, foreground: foreground === true }));
  }
  async startDetail(kind, key, accountId, read) {
    const action = kind === 'note' ? 'note_detail' : 'official_draft_detail', cache = this.cache(accountId);
    const details = kind === 'note' ? cache.noteDetails : cache.officialDraftDetails, statuses = kind === 'note' ? cache.noteStatuses : cache.officialDraftStatuses;
    const previous = statuses[key]; this.detailOperation = { action, kind, key };
    statuses[key] = { ...this.contentStatus(previous, details[key]), running: true, error: '' };
    try {
      return await this.launch(action, async token => {
        const result = await read(); if (this.active !== token) return;
        this.privateReadContent = clippedText(result?.detail?.content, 20000);
        if (!this.applyConnection(result) || result?.account?.id !== accountId) {
          const message = this.data.connection.message; this.operationError(action, message); this.data.status.error = message; this.record(action, 'blocked', message); return;
        }
        if (kind === 'note' && result.detail?.id && result.detail.id !== key) { const message = '官方页面返回的笔记与请求不一致，已保留上次内容。'; this.operationError(action, message); this.data.status.error = message; this.record(action, 'blocked', message); return; }
        const materialized = object(result.detail) ? await this.media.materialize(result.detail, { accountId }) : null;
        if (this.active !== token) return;
        const detail = this.detail(materialized, key, accountId);
        if (!detail || (!detail.isComplete && !detail.content && !detail.images.length)) {
          const message = this.safe(result.detail?.message || result.message) || '未能完整读取内容，已保留上次读取结果。';
          this.operationError(action, message); this.data.status.error = message; this.record(action, 'error', message); return;
        }
        const previousDetail = details[key];
        if (!detail.isComplete && previousDetail?.isComplete) {
          const message = detail.message || '本次未能完整读取内容，已保留上次完整结果。'; this.operationError(action, message); this.data.status.error = message; this.record(action, 'partial', message); return;
        }
        if (!detail.isComplete && previousDetail) {
          detail.title ||= previousDetail.title; detail.content ||= previousDetail.content; detail.url ||= previousDetail.url;
          if (!detail.images.length) detail.images = clone(previousDetail.images); if (!detail.tags.length) detail.tags = clone(previousDetail.tags);
        }
        detail.lastSyncAt = this.iso(); details[key] = detail;
        if (kind === 'official_draft') {
          const item = cache.officialDrafts.find(item => item.key === key);
          if (item && detail.images[0]) item.imageUrl = detail.images[0];
        }
        for (const oldKey of Object.keys(details).slice(0, Math.max(0, Object.keys(details).length - 200))) { delete details[oldKey]; delete statuses[oldKey]; }
        statuses[key] = { state: detail.isComplete ? 'ready' : 'partial', running: false, lastSyncAt: detail.lastSyncAt, error: detail.isComplete ? '' : detail.message, isComplete: detail.isComplete };
        this.data.status.message = this.safe(detail.message) || (detail.isComplete ? '已读取官方页面内容。' : '已读取部分内容；详情中显示实际读取范围。'); this.record(action, statuses[key].state, this.data.status.message);
      });
    } catch (error) { if (previous) statuses[key] = previous; else delete statuses[key]; throw error; }
  }
  async getCachedImage(accountId, filename) {
    const id = this.currentAccount(accountId), source = `/media/xhs/${id}/${filename}`, cache = this.cache(id);
    const referenced = cache.officialDrafts.some(item => item.imageUrl === source) || [...Object.values(cache.noteDetails), ...Object.values(cache.officialDraftDetails)].some(detail => detail.images.includes(source));
    if (!referenced) fail('图片不存在或不属于当前账号', 404);
    const image = await this.media.read(id, filename);
    this.currentAccount(id); return image;
  }
  async getSubmissionDetail(id, { accountId } = {}) {
    const current = this.currentAccount(accountId); if (!UUID.test(String(id || ''))) fail('送稿记录不存在', 404);
    const item = this.data.drafts.find(draft => draft.id === id && draft.accountId === current); if (!item) fail('送稿记录不存在', 404);
    const images = [], directory = path.join(this.dir, 'projects', item.projectId, 'images');
    let realDirectory;
    try { realDirectory = path.join(await realpath(this.dir), 'projects', item.projectId, 'images'); } catch { realDirectory = ''; }
    for (const file of item.images) {
      const relative = path.relative(directory, file);
      if (!realDirectory || !relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) continue;
      if (!/^[0-9a-f-]{36}-[0-9a-f-]{36}\.(?:png|jpg|webp|gif)$/i.test(relative)) continue;
      try { const actual = await realpath(file); if (path.dirname(actual) !== realDirectory) continue; images.push(`/media/${item.projectId}/${encodeURIComponent(relative)}`); } catch { /* Missing frozen images stay unavailable. */ }
    }
    this.currentAccount(current);
    return { id: item.id, projectId: item.projectId, accountId: current, title: item.title, content: item.content, images, imageURLs: [...images] };
  }
  safeDraft(item) { return { id: item.id, projectId: item.projectId, accountId: item.accountId, title: item.title, fingerprint: item.fingerprint, status: item.status,
    createdAt: item.createdAt, updatedAt: item.updatedAt, message: this.safe(item.message), verifiedAt: item.verifiedAt || null, attempts: item.attempts,
    operation: item.operation === 'recheck' ? 'recheck' : 'save', rechecking: item.operation === 'recheck' && ['queued', 'running'].includes(item.status),
    canRecheck: ['filled', 'unknown'].includes(item.status) && typeof this.driver.verifyDraft === 'function',
    canRetry: item.status === 'failed' && item.submitted === false && item.attempts < 5 };
  }
  snapshot() {
    const id = this.data.account?.id, cache = id ? this.cache(id) : null;
    return { account: clone(this.data.account), connection: clone(this.data.connection), sync: clone(this.data.sync), metrics: id ? clone(this.data.metrics) : [], notes: id ? this.data.notes.map(note => ({ ...clone(note), contentStatus: this.contentStatus(cache.noteStatuses[note.id], cache.noteDetails[note.id]) })) : [],
      analyticsHistory: cache ? clone(cache.analyticsHistory) : [],
      officialDrafts: cache ? cache.officialDrafts.map(item => ({ ...clone(item), canRead: Boolean(item.canRead && this.liveDraftKeys.has(`${id}:${item.key}`) && this.data.connection.state === 'connected'), contentStatus: this.contentStatus(cache.officialDraftStatuses[item.key], cache.officialDraftDetails[item.key]) })) : [],
      officialDraftSync: cache ? clone(cache.officialDraftSync) : defaultOfficialSync(),
      drafts: this.data.drafts.filter(item => id && item.accountId === id).map(item => this.safeDraft(item)).reverse(), status: clone(this.data.status),
      history: (cache ? cache.history : this.data.history.filter(item => !item.accountId)).map(item => ({ ...clone(item), message: this.safe(item.message) })).reverse() };
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
    const cache = this.cache(); if (cache) { cache.history.push(clone(this.data.history.at(-1))); cache.history = cache.history.slice(-40); }
  }
  applyConnection(result, { preserveCounters = true } = {}) {
    const incoming = account(result?.account), current = this.data.account;
    this.data.connection.browserOpen = result?.browserOpen !== false;
    this.data.connection.lastCheckedAt = this.iso();
    if (result?.accountMismatch || (incoming && current && incoming.id !== current.id)) {
      this.saveCurrentCache(); this.accountMismatch = true;
      this.data.metrics = []; this.data.notes = []; this.data.sync.lastSyncAt = null; this.data.sync.coverage = defaultCoverage();
      this.data.connection.state = 'needs_attention';
      this.data.connection.message = '浏览器中的账号与已连接账号不同。请先断开连接，再连接要使用的账号。';
      return false;
    }
    let state = CONNECTION_STATES.has(result?.state) ? result.state : 'needs_attention';
    if (state === 'connected' && !incoming) state = 'needs_attention';
    if (state === 'connected' && this.validateAccount) {
      let rejection;
      try { rejection = this.validateAccount(incoming.id); } catch { rejection = false; }
      if (rejection === false || typeof rejection === 'string' && rejection) {
        this.data.connection.state = 'needs_attention';
        this.data.connection.message = typeof rejection === 'string' ? this.safe(rejection) : '该账号暂不能绑定到此登录会话，请核对账号列表。';
        return false;
      }
    }
    this.data.connection.state = state;
    this.data.connection.message = this.safe(result?.message) || (state === 'connected' ? '电脑端账号已连接。' : '请在打开的浏览器中完成登录或验证，再检查登录。');
    if (state === 'connected') {
      if (!current || this.accountMismatch) this.restoreCurrentCache(incoming.id);
      const previous = current?.id === incoming.id ? current : this.cache(incoming.id).account;
      if (preserveCounters) for (const key of ['followers', 'following', 'likes', 'notesCount']) if (incoming[key] === null && previous?.[key] !== undefined) incoming[key] = previous[key];
      this.accountMismatch = false; this.data.account = incoming; this.cache(incoming.id).account = clone(incoming);
    }
    return state === 'connected';
  }
  async launch(action, work) {
    this.idle(); const token = { action }; this.active = token;
    this.data.status = { busy: true, action, message: ({ login: '正在打开小红书登录窗口', check: '正在检查账号登录状态', sync: '正在同步账号页面可见数据', open_drafts: '正在打开电脑端草稿', save_draft: '正在准备并暂存图文', verify_draft: '正在重新读取并核验电脑草稿', note_detail: '正在读取官方笔记内容', official_drafts: '正在读取电脑端官方草稿', official_draft_detail: '正在读取电脑端草稿内容', disconnect: '正在断开本平台账号连接' })[action] || '正在处理', error: '' };
    if (action === 'sync') this.data.sync.running = true;
    if (action === 'official_drafts') this.cache().officialDraftSync.running = true;
    try { await this.persist(); } catch {
      this.active = null; this.data.status.busy = false; this.data.sync.running = false;
      if (action === 'official_drafts') this.cache().officialDraftSync.running = false;
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
      this.operationError(action, message);
      this.record(action, 'error', message);
    }).finally(async () => {
      if (this.active !== token) return;
      this.active = null; this.privateReadContent = ''; this.data.status.busy = false; this.data.sync.running = false;
      for (const cache of Object.values(this.data.accountCaches)) { cache.officialDraftSync.running = false; for (const status of [...Object.values(cache.noteStatuses), ...Object.values(cache.officialDraftStatuses)]) status.running = false; }
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
  async startSync({ noteLimit = 50 } = {}) {
    this.idle(); const expected = this.connected();
    if (!Number.isInteger(noteLimit) || noteLimit < 50 || noteLimit > 200) fail('笔记读取上限应为50到200的整数');
    return this.launch('sync', async token => {
      const result = await this.driver.sync({ noteLimit }); if (this.active !== token) return;
      if (!this.applyConnection(result, { preserveCounters: false }) || result?.account?.id !== expected) {
        this.data.sync.error = this.data.connection.message; this.data.status.error = this.data.connection.message;
        this.record('sync', 'blocked', this.data.connection.message); return;
      }
      this.data.metrics = metrics(result.metrics); this.data.notes = notes(result.notes, noteLimit).map(note => { const detail = this.cache(expected).noteDetails[note.id]; return { ...note, title: note.title || detail?.title || '', imageUrl: note.imageUrl || detail?.images?.[0] || '' }; });
      this.data.sync = { running: true, lastSyncAt: this.iso(), error: '', coverage: this.coverage(result.coverage, noteLimit) };
      const cache = this.saveCurrentCache();
      const point = { accountId: expected, at: this.iso(), account: Object.fromEntries(['followers', 'following', 'likes', 'notesCount'].map(key => [key, this.data.account[key]])), metrics: clone(this.data.metrics) };
      cache.analyticsHistory = [...cache.analyticsHistory.filter(item => accountDay(item.at) !== accountDay(point.at)), point].slice(-365);
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
      this.saveCurrentCache(); this.liveDraftKeys.clear(); this.accountMismatch = false;
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
    this.data.status.busy = false; this.data.sync.running = false; this.data.connection.browserOpen = false; this.liveDraftKeys.clear();
    for (const cache of Object.values(this.data.accountCaches)) { cache.officialDraftSync.running = false; for (const status of [...Object.values(cache.noteStatuses), ...Object.values(cache.officialDraftStatuses)]) status.running = false; }
    if (this.data.account) { this.data.connection.state = 'needs_attention'; this.data.connection.message = '浏览器连接已关闭，请检查登录后继续。'; }
    await this.persist().catch(() => {}); await this.driver.close();
  }
}
