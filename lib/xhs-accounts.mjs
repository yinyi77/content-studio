import path from 'node:path';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { XhsAccountService } from './xhs-account.mjs';
import { buildAccountPartitionOf, recordAccountNameOf, recordGroupOf } from '../vendor/matrixmedia/core/accountIdentity.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const MAX_ACCOUNTS = 30;
const SUMMARY_KEYS = ['followers', 'following', 'likes', 'notesCount'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const text = (value, max = 80) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function field(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || Array.from(value).length > 80) fail(`${name}请填写80字以内的文本`);
  return text(value) || fallback;
}
function emptySnapshot(message = '') {
  return { account: null, connection: { state: 'disconnected', message: message || '添加账号后，在官方窗口完成扫码登录。', browserOpen: false, lastCheckedAt: null },
    sync: { running: false, lastSyncAt: null, error: '', coverage: { message: '尚未同步。', hasMore: null, limit: 50 } }, metrics: [], notes: [], analyticsHistory: [], officialDrafts: [],
    officialDraftSync: { running: false, lastSyncAt: null, error: '', coverage: { message: '尚未读取电脑端官方草稿。', hasMore: null, limit: 100 } }, drafts: [],
    status: { busy: false, action: '', message: '', error: message }, history: [] };
}

/** MatrixMedia's account identity/partition helpers with independent Playwright
 * profiles. Selection is presentation state; explicit tasks never follow it. */
export class XhsAccountsService {
  constructor({ dir, driverFactory, now = Date.now } = {}) {
    if (!dir || typeof driverFactory !== 'function') throw new Error('多账号服务缺少数据目录或浏览器工厂');
    this.dir = path.resolve(dir); this.file = path.join(this.dir, 'xhs-accounts.json'); this.driverFactory = driverFactory; this.now = now;
    this.records = []; this.services = new Map(); this.selectedProfileId = null; this.persistence = Promise.resolve(); this.pending = new Set(); this.removing = new Set(); this.closed = false; this.storageError = '';
  }
  iso() { return new Date(this.now()).toISOString(); }
  get inFlight() { return Promise.allSettled([...this.services.values()].map(service => service.inFlight).filter(Boolean).concat([...this.pending])); }
  get active() { return [...this.services.values()].some(service => service.active); }
  assertOpen() { if (this.closed) fail('小红书账号管理已关闭', 503); if (this.storageError) fail(this.storageError, 503); }
  makeRecord(input = {}, legacy = false) {
    const profileId = randomUUID(), group = field(input.group, '分组', '默认分组'), accountName = field(input.accountName, '账号备注', `账号 ${this.records.length + 1}`);
    const record = { profileId, legacy, accountKey: profileId.replace(/-/g, ''), group, accountName, accountId: null, nickname: '', createdAt: this.iso(), updatedAt: this.iso() };
    record.partition = buildAccountPartitionOf(record, '小红书'); return record;
  }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const raw = await readFile(this.file, 'utf8'); if (Buffer.byteLength(raw) > 1024 * 1024) throw Error('oversize');
      const saved = JSON.parse(raw);
      if (!object(saved) || saved.version !== 1 || !Array.isArray(saved.accounts) || saved.accounts.length > MAX_ACCOUNTS) throw Error('invalid');
      const ids = new Set(), bound = new Set(); let legacy = false;
      this.records = saved.accounts.map(item => {
        if (!object(item) || !UUID.test(item.profileId) || ids.has(item.profileId.toLowerCase()) || item.legacy === true && legacy) throw Error('invalid');
        const profileId = item.profileId.toLowerCase(); ids.add(profileId); if (item.legacy === true) legacy = true;
        const accountId = typeof item.accountId === 'string' && ACCOUNT_ID.test(item.accountId) ? item.accountId : null;
        if (accountId && bound.has(accountId)) throw Error('duplicate'); if (accountId) bound.add(accountId);
        const record = { profileId, legacy: item.legacy === true, accountKey: profileId.replace(/-/g, ''), group: text(item.group) || '默认分组', accountName: text(item.accountName) || '小红书账号',
          accountId, nickname: text(item.nickname, 120), createdAt: timestamp(item.createdAt) || this.iso(), updatedAt: timestamp(item.updatedAt) || this.iso() };
        record.partition = buildAccountPartitionOf(record, '小红书'); return record;
      });
      this.selectedProfileId = ids.has(saved.selectedProfileId) ? saved.selectedProfileId : this.records[0]?.profileId || null;
      await chmod(this.file, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') { this.records = []; this.selectedProfileId = null; this.storageError = '本机账号列表读取失败，原有账号文件和浏览器数据已保留；请检查记录后再继续。'; return this.snapshot(); }
      const legacy = this.makeRecord({}, true); this.records = [legacy]; this.selectedProfileId = legacy.profileId;
    }
    try {
      for (const record of this.records) await this.createService(record);
      await this.persist();
    } catch { this.storageError = '本机账号管理记录暂不可用，原有登录和草稿数据已保留。'; }
    return this.snapshot();
  }
  async createService(record) {
    const driver = this.driverFactory({ profileId: record.profileId, legacy: record.legacy, background: true });
    const service = new XhsAccountService({ dir: this.dir, driver, now: this.now,
      stateFile: record.legacy ? path.join(this.dir, 'xhs-account.json') : path.join(this.dir, 'xhs-accounts', record.profileId, 'state.json'),
      validateAccount: accountId => this.validateBinding(record, accountId) });
    this.services.set(record.profileId, service); await service.init();
    const current = service.data.account;
    if (current) {
      const rejection = this.validateBinding(record, current.id);
      if (rejection !== true) { service.data.account = null; service.data.metrics = []; service.data.notes = []; service.data.connection.state = 'needs_attention'; service.data.connection.message = rejection; }
      else { record.accountId = current.id; record.nickname = current.nickname; }
    }
    return service;
  }
  validateBinding(record, accountId) {
    if (record.accountId && record.accountId !== accountId) return '此登录会话已绑定其他小红书账号，请为新账号添加独立会话。';
    const existing = this.records.find(other => other.profileId !== record.profileId && (other.accountId === accountId || this.services.get(other.profileId)?.data.account?.id === accountId));
    return existing ? '这个小红书账号已经添加，请切换到已有账号；当前新会话尚未绑定。' : true;
  }
  record(profileId = this.selectedProfileId) {
    const record = this.records.find(item => item.profileId === profileId); if (!record) fail('账号不存在，请先添加或选择账号', 404); return record;
  }
  resolveTarget({ profileId, accountId } = {}) {
    this.assertOpen();
    if (profileId !== undefined && (typeof profileId !== 'string' || !UUID.test(profileId))) fail('账号会话编号无效');
    if (accountId !== undefined && (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId))) fail('小红书账号编号无效');
    const record = accountId ? this.records.find(item => item.accountId === accountId || this.services.get(item.profileId)?.data.account?.id === accountId) : this.record(profileId);
    if (!record || profileId && record.profileId !== profileId) fail('目标小红书账号未绑定或与会话不一致', 409);
    if (this.removing.has(record.profileId)) fail('此账号正在移除，请稍后再操作', 409);
    return record;
  }
  serviceFor(options = {}) { return this.services.get(this.resolveTarget(options).profileId); }
  metadata(record) {
    const service = this.services.get(record.profileId), snapshot = service?.snapshot(), account = snapshot?.account;
    const ownsAccount = Boolean(account && typeof account.id === 'string' && ACCOUNT_ID.test(account.id) && this.validateBinding(record, account.id) === true);
    const summary = Object.fromEntries(SUMMARY_KEYS.map(key => {
      const value = ownsAccount ? account[key] : null;
      return [key, typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null];
    }));
    return { profileId: record.profileId, accountId: record.accountId || account?.id || null, accountName: recordAccountNameOf(record), group: recordGroupOf(record), nickname: account?.nickname || record.nickname || '',
      connectionState: snapshot?.connection.state || 'disconnected', browserOpen: Boolean(snapshot?.connection.browserOpen), busy: Boolean(snapshot?.status.busy), lastSyncAt: snapshot?.sync.lastSyncAt || null,
      summary, avatarUrl: ownsAccount && typeof account.avatar === 'string' ? account.avatar : '',
      selected: record.profileId === this.selectedProfileId, legacy: record.legacy, createdAt: record.createdAt, updatedAt: record.updatedAt };
  }
  decorate(snapshot, record) { return { ...snapshot, profileId: record?.profileId || null, selectedProfileId: this.selectedProfileId, accounts: this.records.map(item => this.metadata(item)), busyProfiles: this.records.filter(item => this.services.get(item.profileId)?.data.status.busy).map(item => item.profileId) }; }
  snapshot() {
    const record = this.records.find(item => item.profileId === this.selectedProfileId), snapshot = record ? this.services.get(record.profileId)?.snapshot() || emptySnapshot() : emptySnapshot(this.storageError);
    if (this.storageError) snapshot.status = { ...snapshot.status, error: this.storageError };
    return this.decorate(snapshot, record);
  }
  snapshotForProfile(profileId) { this.assertOpen(); const record = this.record(profileId); return this.decorate(this.services.get(profileId).snapshot(), record); }
  getAccountSnapshot(accountId) {
    if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) return null;
    const record = this.records.find(item => item.accountId === accountId || this.services.get(item.profileId)?.data.account?.id === accountId);
    return record ? this.decorate(this.services.get(record.profileId).snapshot(), record) : null;
  }
  async persist() {
    if (this.storageError) fail(this.storageError, 503);
    const saved = JSON.stringify({ version: 1, selectedProfileId: this.selectedProfileId, accounts: this.records }, null, 2);
    const operation = this.persistence.catch(() => {}).then(async () => { const temp = `${this.file}.${randomUUID()}.tmp`; await writeFile(temp, saved, { mode: 0o600, flag: 'wx' }); await rename(temp, this.file); });
    this.persistence = operation; await operation;
  }
  watch(record, service) {
    const inflight = service.inFlight;
    if (!inflight) return;
    const pending = Promise.resolve(inflight).then(async () => {
      if (this.closed || !this.records.includes(record)) return;
      const current = service.data.account;
      if (current && this.validateBinding(record, current.id) === true) { record.accountId = current.id; record.nickname = current.nickname; record.updatedAt = this.iso(); }
      await this.persist();
    }).catch(() => { if (!this.closed) { service.data.status.error ||= '账号列表保存失败；当前内容已保留，请检查本机存储后继续。'; } }).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }
  response(result, record, service) {
    if (result && object(result) && result.draft) return { ...result, snapshot: this.snapshot(), targetProfileId: record.profileId, targetSnapshot: this.decorate(service.snapshot(), record) };
    return { ...this.snapshot(), targetProfileId: record.profileId, targetSnapshot: this.decorate(service.snapshot(), record) };
  }
  async invoke(method, args, options = {}) {
    const record = this.resolveTarget(options), service = this.services.get(record.profileId), result = await service[method](...args);
    this.watch(record, service); return this.response(result, record, service);
  }
  async addAccount(input = {}) {
    this.assertOpen(); if (!object(input)) fail('请填写账号信息'); if (this.records.length >= MAX_ACCOUNTS) fail(`最多管理${MAX_ACCOUNTS}个小红书账号`, 409);
    const record = this.makeRecord(input), previous = this.selectedProfileId; this.records.push(record); this.selectedProfileId = record.profileId;
    try { await this.createService(record); await this.persist(); }
    catch (error) { this.records = this.records.filter(item => item !== record); this.selectedProfileId = previous; this.services.delete(record.profileId); throw error; }
    return this.snapshot();
  }
  async selectAccount(profileId) {
    this.assertOpen(); this.record(profileId); const previous = this.selectedProfileId; this.selectedProfileId = profileId;
    try { await this.persist(); } catch (error) { this.selectedProfileId = previous; throw error; } return this.snapshot();
  }
  async updateAccount(profileId, input = {}) {
    this.assertOpen(); if (!object(input)) fail('请填写账号信息'); const record = this.record(profileId), previous = { ...record };
    const group = field(input.group, '分组', record.group), accountName = field(input.accountName, '账号备注', record.accountName);
    record.group = group; record.accountName = accountName; record.updatedAt = this.iso();
    try { await this.persist(); } catch (error) { Object.assign(record, previous); throw error; } return this.snapshot();
  }
  async removeAccount(profileId) {
    this.assertOpen(); const record = this.record(profileId), service = this.services.get(profileId);
    if (service.active || service.data.status.busy) fail('该账号仍在处理任务，请完成后再移除', 409);
    if (this.removing.has(profileId)) fail('此账号正在移除，请稍后再操作', 409);
    this.removing.add(profileId);
    try {
      if (typeof service.driver.hasPendingEdits === 'function' && await service.driver.hasPendingEdits()) fail('该账号的官方窗口还有编辑内容，请先手动保存或关闭编辑页，再移除账号。', 409);
    } catch (error) { this.removing.delete(profileId); throw error; }
    const previous = this.selectedProfileId, oldRecords = this.records; this.records = this.records.filter(item => item !== record);
    if (this.selectedProfileId === profileId) this.selectedProfileId = this.records[0]?.profileId || null;
    try { await this.persist(); } catch (error) { this.records = oldRecords; this.selectedProfileId = previous; this.removing.delete(profileId); throw error; }
    this.services.delete(profileId); this.removing.delete(profileId);
    let warning = '';
    try { await service.close(); } catch { warning = '账号已移除；若其专用浏览器仍打开，请手动关闭该窗口。'; }
    return { ...this.snapshot(), ...(warning ? { warning } : {}) };
  }
  startLogin(options = {}) { return this.invoke('startLogin', [], options); }
  checkLogin(options = {}) { return this.invoke('checkLogin', [], options); }
  startSync(options = {}) { return this.invoke('startSync', [{ noteLimit: options.noteLimit ?? 50 }], options); }
  openDrafts(options = {}) { return this.invoke('openDrafts', [], options); }
  async disconnect(options = {}) {
    const record = this.resolveTarget(options), service = this.services.get(record.profileId);
    await service.launch('disconnect', async token => {
      await service.driver.close(); if (service.active !== token) return;
      service.saveCurrentCache(); service.liveDraftKeys.clear(); service.accountMismatch = false;
      service.data.connection = { ...service.data.connection, state: service.data.account ? 'needs_attention' : 'disconnected', browserOpen: false, lastCheckedAt: service.iso(), message: '账号及电脑草稿已保留，专用浏览器已断开；下次操作可重新检查登录。' };
      service.data.status.message = service.data.connection.message; service.record('disconnect', 'completed', service.data.connection.message);
    });
    this.watch(record, service); return { ...this.snapshot(), targetProfileId: record.profileId, targetSnapshot: this.decorate(service.snapshot(), record) };
  }
  getNoteDetail(noteId, options = {}) { return this.serviceFor(options).getNoteDetail(noteId, options); }
  startNoteDetail(noteId, options = {}) { return this.invoke('startNoteDetail', [noteId, options], options); }
  startOfficialDraftSync(options = {}) { return this.invoke('startOfficialDraftSync', [options], options); }
  getOfficialDraftDetail(key, options = {}) { return this.serviceFor(options).getOfficialDraftDetail(key, options); }
  startOfficialDraftDetail(key, options = {}) { return this.invoke('startOfficialDraftDetail', [key, options], options); }
  getSubmissionDetail(id, options = {}) { return this.serviceFor(options).getSubmissionDetail(id, options); }
  getCachedImage(accountId, filename) { return this.serviceFor({ accountId }).getCachedImage(accountId, filename); }
  submitDraft(input) { return this.invoke('submitDraft', [input], { accountId: input?.accountId }); }
  async retryDraft(id, options = {}) { const record = this.draftOwner(id, options); return this.invoke('retryDraft', [id], { profileId: record.profileId, accountId: record.accountId || undefined }); }
  async recheckDraft(id, options = {}) { const record = this.draftOwner(id, options); return this.invoke('recheckDraft', [id, { ...options, accountId: record.accountId }], { profileId: record.profileId, accountId: record.accountId || undefined }); }
  draftOwner(id, options = {}) {
    const candidates = this.records.filter(record => this.services.get(record.profileId).data.drafts.some(item => item.id === id && item.accountId === record.accountId));
    if (candidates.length !== 1) fail('草稿记录不存在', 404); const record = candidates[0];
    if (options.accountId && options.accountId !== record.accountId || options.profileId && options.profileId !== record.profileId) fail('草稿不属于目标账号', 409); return record;
  }
  async close() {
    this.closed = true; await Promise.allSettled([...this.services.values()].map(service => service.close())); await this.persistence.catch(() => {});
  }
}
