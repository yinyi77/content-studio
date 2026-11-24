import { createHash } from 'node:crypto';
import { draftVersionDetails } from './xhs-draft-edit.mjs';
import { imageInfo } from './reference-images.mjs';
import { includeAccountTotals, metricsSyncInfo, readMetrics } from './xhs-account-metrics.mjs';
import { savedPublisherAccounts, XhsPublisherDelivery } from './xhs-publisher-delivery.mjs';

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const DRAFT_ID = /^draft_[a-f0-9]{32}$/;
const JOB_ID = /^job_[a-f0-9]{32}$/;
const pendingLanCheck = '请检查微服务连接，确认局域网图片主机已加入 XHS_IMAGE_ALLOWED_HOSTS。';
const capabilities = Object.freeze({
  manageAccounts: false, accountAnalytics: false, publishedNotes: false,
  officialDrafts: false, serviceDrafts: true, browserLogin: false, openDrafts: false,
});

function failure(message, status = 502, code = 'PUBLISHER_ERROR') {
  return Object.assign(new Error(message), { status, code });
}

function serviceUrl(value) {
  let url;
  try { url = new URL(value); } catch { /* Report configuration errors without echoing credentials. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw failure('小红书微服务地址无效，请配置 HTTP(S) 服务地址。', 503, 'PUBLISHER_CONFIG');
  }
  return url.href.replace(/\/+$/, '');
}

const remoteErrors = {
  UNAUTHORIZED: '小红书微服务鉴权失败，请检查服务令牌。',
  ACCOUNT_NOT_ALLOWED: '微服务拒绝了当前配置的账号。',
  DRAFT_NOT_FOUND: '该服务草稿不存在，请检查服务环境和草稿编号。',
  DRAFT_NOT_EDITABLE: '当前草稿正在处理、已预约或已达到修改上限。',
  NO_CONTENT_CHANGE: '这次修改与已保存的草稿一致。',
  JOB_NOT_FOUND: '该服务任务不存在，请检查服务环境和任务编号。',
  IDEMPOTENCY_CONFLICT: '该次送稿记录与微服务已受理的内容冲突，请核对原任务。',
  DUPLICATE_CONTENT: '微服务已有相同素材，请先核对已有草稿。',
  RETRY_NOT_SAFE: '微服务要求人工核对原任务，无法重试素材下载。',
  IMAGE_URL_NOT_ALLOWED: '微服务拒绝了图片来源，请检查服务端的图片域名配置。',
  INVALID_REQUEST: '微服务未接受请求参数，请核对账号、标题、正文和图片。',
  PUBLISH_DISABLED: '该账号的预约发布开关未开启。',
  ACCOUNT_PAUSED: '该账号的任务已暂停。',
  CONTENT_VERSION_MISMATCH: '微服务草稿版本已变化，请重新核对要发布的版本。',
  DRAFT_NOT_READY_OR_ALREADY_SCHEDULED: '草稿尚未就绪或已有预约，请核对原草稿。',
  SCHEDULE_TOO_SOON: '所选时间离现在太近，请为微服务预留更多提前量。',
  SCHEDULE_TOO_FAR: '预约时间超过微服务允许的范围。',
  DAILY_LIMIT_REACHED: '该账号当天的预约名额已满。',
  APPROVAL_IN_FUTURE: '微服务未接受审批时间，请核对两台电脑的系统时间。',
  SYNC_BUSY: '该账号已有同步任务排队，请稍后查询原任务。',
};

export class XhsPublisherClient {
  #token;

  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
    this.baseUrl = serviceUrl(baseUrl);
    this.#token = typeof token === 'string' ? token.trim() : '';
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  requireToken() {
    if (!this.#token || /[\x00-\x20\x7f]/.test(this.#token)) throw failure('请配置有效的小红书微服务令牌。', 503, 'PUBLISHER_CONFIG');
  }

  async draftImage(accountId, draftId, position, version) {
    if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId) || typeof draftId !== 'string' || !DRAFT_ID.test(draftId) || !Number.isInteger(position) || position < 1 || position > 18
        || !Number.isInteger(version) || version < 1 || version > 10000) throw failure('草稿配图的账号、版本或序号无效。', 400);
    const params = new URLSearchParams({ account_id: accountId, content_version: String(version) });
    return this.request('/v1/drafts/' + draftId + '/images/' + position + '?' + params, { image: true });
  }

  async request(path, { method = 'GET', body, idempotencyKey, image = false } = {}) {
    // Paths are constructed by this adapter. Never forward a service bearer to a redirect.
    if (typeof path !== 'string' || !/^\/(?:health|v1)\//.test(path) || /[\\#\r\n]/.test(path) || path.includes('..')) {
      throw failure('小红书微服务请求路径无效。', 400);
    }
    const headers = { Accept: image ? 'image/png, image/jpeg, image/webp' : 'application/json' };
    if (path !== '/health/live') {
      this.requireToken();
      headers.Authorization = `Bearer ${this.#token}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response, data;
    try {
      response = await this.fetch(this.baseUrl + path, {
        method, headers, redirect: 'manual', signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (image && response.ok) {
        const max = 30 * 1024 * 1024;
        let size = 0;
        const chunks = [];
        if (Number(response.headers.get('content-length')) > max) {
          await response.body?.cancel();
          throw failure('微服务草稿配图超过 30 MB。', 413);
        }
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > max) throw failure('微服务草稿配图超过 30 MB。', 413);
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks, size);
        let mime;
        try { ({ mime } = imageInfo(bytes, { reference: false })); } catch { /* Reject non-image payloads. */ }
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw failure('微服务返回的草稿配图格式无效。');
        return { bytes, mime };
      }
      data = await response.json().catch(() => null);
    } catch (error) {
      if (error.code === 'PUBLISHER_ERROR') throw error;
      if (!signal.aborted) throw failure('无法连接小红书微服务，请检查服务地址和网络。', 502, 'PUBLISHER_NETWORK');
    }
    if (signal.aborted) throw failure('小红书微服务响应超时，请核对服务状态。', 504, 'PUBLISHER_TIMEOUT');
    if (!response.ok) {
      const candidate = data?.error?.code ?? data?.detail?.code;
      const code = typeof candidate === 'string' && Object.hasOwn(remoteErrors, candidate) ? candidate : `HTTP_${response.status}`;
      const message = remoteErrors[code] || (response.status === 401 ? remoteErrors.UNAUTHORIZED : `小红书微服务请求失败（HTTP ${response.status}）。`);
      throw failure(message, response.status >= 400 ? response.status : 502, code);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('小红书微服务返回了无效的 JSON 对象。');
    return data;
  }
}

function profileIdFor(service, accountId) {
  const bytes = createHash('sha256').update(JSON.stringify([service, accountId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x80;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const id = bytes.toString('hex');
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');
}

function accountText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function accountCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function accountTime(value) {
  const text = accountText(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function publishedNoteCount(sync) {
  if (!sync || sync.status === 'never' || sync.coverage?.full_scan !== true || !accountTime(sync.last_synced_at)) return null;
  return accountCount(sync.coverage.tabs?.published);
}

const syncStatuses = new Set(['queued', 'running', 'succeeded', 'failed', 'canceled']);
const syncRequestId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const syncErrorCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : null;

function draftRow(item, accountId) {
  if (item?.account_id !== accountId) throw failure('微服务返回的草稿归属与所选账号不符，请检查服务端的账号筛选。');
  if (!DRAFT_ID.test(item.draft_id) || typeof item.title !== 'string' ||
    !Number.isInteger(item.image_count) || item.image_count < 1 || item.image_count > 18 || typeof item.phase !== 'string' ||
    typeof item.platform_status !== 'string') throw failure('微服务草稿的编号或内容格式无效。');
  return {
    key: item.draft_id, serviceDraftId: item.draft_id, accountId, title: item.title,
    kind: 'image', imageUrl: '', imageCount: item.image_count, updatedAt: item.updated_at || null,
    updatedAtLabel: item.updated_at || '', phase: item.phase, platformStatus: item.platform_status, canRead: true,
    contentStatus: { running: false, state: 'not_loaded', isComplete: false, error: '' },
  };
}

class PublisherAccount {
  constructor({ dir, baseUrl, token, client, accountId = 'xhs_account_001', mediaBaseUrl, lanMedia, fetchImpl, configurationError, deliveryConfigurationError }) {
    if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) throw failure('小红书微服务账号 ID 无效。', 503, 'PUBLISHER_CONFIG');
    this.configurationError = configurationError || (!client && !token?.trim() ? '请在 .env.xhs-publisher 填写微服务令牌 XHS_PUBLISHER_TOKEN，并重启工作台。' : '');
    this.lanMedia = lanMedia;
    this.requireEnabledFlag = Boolean(client);
    this.mediaConfigurationError = this.configurationError || deliveryConfigurationError
      || (!mediaBaseUrl && !lanMedia ? '当前仅支持查询。送稿前请设置 XHS_PUBLISHER_MEDIA_BASE_URL，并重启工作台。' : '');
    this.lanReadinessError = lanMedia ? pendingLanCheck : '';
    this.accountId = this.configurationError ? null : accountId;
    this.profileId = null;
    if (!this.configurationError) {
      this.client = client || new XhsPublisherClient({ baseUrl, token, fetchImpl });
      this.profileId = profileIdFor(this.client.baseUrl, accountId);
      this.delivery = new XhsPublisherDelivery({ dir, client: this.client, accountId, mediaBaseUrl, lanMedia, serviceUrl: this.client.baseUrl });
    }
    this.connection = { state: this.configurationError ? 'unconfigured' : 'needs_attention',
      message: this.configurationError || '微服务就绪状态待检查。', lastCheckedAt: null };
    this.draftSync = { running: false, lastSyncAt: null, error: '', coverage: { offset: 0, limit: 50, hasMore: null, message: '尚未读取服务草稿。' } };
    this.rows = [];
    this.checking = null;
    this.closed = false;
  }

  get deliveryConfiguration() {
    const message = this.mediaConfigurationError || this.lanReadinessError;
    const canPreflight = !this.mediaConfigurationError && (!this.lanReadinessError || this.lanReadinessError === pendingLanCheck);
    return { configured: !message, canPreflight, message };
  }

  async init() {
    await this.delivery?.init();
    if (this.lanMedia && !this.mediaConfigurationError) {
      try { await this.lanMedia.init(); }
      catch (error) {
        this.mediaConfigurationError = '局域网图片服务启动失败。' + error.message;
        await this.lanMedia.close();
      }
    }
    return this.snapshot();
  }

  async close() {
    this.closed = true;
    try { await this.delivery?.close(); }
    finally { await this.lanMedia?.close(); }
  }

  target({ profileId, accountId } = {}) {
    if (this.closed) throw failure('小红书服务连接已关闭。', 503);
    if (this.configurationError) throw failure(this.configurationError, 503, 'PUBLISHER_CONFIG');
    if ((accountId !== undefined && accountId !== this.accountId) || (profileId !== undefined && profileId !== this.profileId)) {
      throw failure('目标账号与当前配置的微服务账号不一致。', 409, 'ACCOUNT_NOT_ALLOWED');
    }
  }

  snapshot() {
    const account = this.accountId ? { id: this.accountId, nickname: this.accountNickname ?? null, platformAccountId: this.platformAccountId ?? null } : null;
    return {
      provider: 'publisher', providerKey: 'publisher:' + (this.profileId || 'unconfigured'), configured: !this.configurationError,
      deliveryConfiguration: { ...this.deliveryConfiguration },
      capabilities: { ...capabilities, publishedNotes: this.canReadPublishedNotes === true, accountAnalytics: this.canReadMetrics === true }, profileId: this.profileId, selectedProfileId: this.profileId,
      accounts: account ? [{ profileId: this.profileId, accountId: account.id, nickname: account.nickname, connectionState: this.connection.state, busy: Boolean(this.checking) }] : [],
      account, connection: { ...this.connection },
      officialDrafts: structuredClone(this.rows), officialDraftSync: structuredClone(this.draftSync), drafts: this.delivery?.listSubmissions() || [],
      status: { busy: Boolean(this.checking), action: this.checking ? 'check' : '', message: this.connection.message, error: '' },
    };
  }

  async readAccountItems() {
    this.target();
    const { items } = await this.client.request('/v1/accounts');
    if (!Array.isArray(items)) throw failure('微服务返回的账号列表格式无效。');
    const self = items.find(item => item?.account_id === this.accountId);
    this.accountNickname = accountText(self?.nickname);
    this.platformAccountId = accountText(self?.platform_account_id);
    this.canReadPublishedNotes = items.some(item => item && Object.hasOwn(item, 'notes_sync'));
    this.canReadMetrics = items.some(item => item && Object.hasOwn(item, 'metrics_sync'));
    return items;
  }

  async listAccounts({ includeMetrics = false } = {}) {
    const items = await this.readAccountItems();
    const ids = new Set();
    const accounts = items.map(item => {
      if (typeof item?.account_id !== 'string' || !ACCOUNT_ID.test(item.account_id) || ids.has(item.account_id)
        || typeof item.paused !== 'boolean' || typeof item.publish_enabled !== 'boolean') {
        throw failure('微服务返回的账号编号或状态无效，请检查账号列表。');
      }
      ids.add(item.account_id);
      const metrics = item.metrics;
      return {
        accountId: item.account_id, nickname: accountText(item.nickname),
        platformAccountId: accountText(item.platform_account_id), loginStatus: accountText(item.login_status),
        identityCheckedAt: accountTime(item.identity_checked_at),
        ...(Object.hasOwn(item, 'metrics_sync') ? {metricsSync: metricsSyncInfo(item.metrics_sync)} : {}),
        enabled: typeof item.enabled === 'boolean' ? item.enabled : null,
        executing: typeof item.executing === 'boolean' ? item.executing : null,
        dailyLimit: accountCount(item.daily_limit), queuedJobs: accountCount(item.queued_jobs),
        needsAttention: accountCount(item.needs_attention),
        metrics: {
          followers: accountCount(metrics?.followers), following: accountCount(metrics?.following),
          likesAndSaves: accountCount(metrics?.likes_and_saves),
          notes: accountCount(metrics?.notes) ?? publishedNoteCount(item.notes_sync),
        },
        paused: item.paused, publishEnabled: item.publish_enabled, isDeliveryAccount: item.account_id === this.accountId,
      };
    });
    if (includeMetrics) await includeAccountTotals(this.client, accounts);
    return { accounts, fetchedAt: new Date().toISOString() };
  }

  async accountMetrics(accountId, period) {
    this.target({accountId});
    return readMetrics(this.client, accountId, period);
  }

  async listPublishedNotes(accountId, offset = 0) {
    if (!ACCOUNT_ID.test(accountId) || accountCount(offset) === null) throw failure('账号编号或分页位置无效。', 400);
    const { accounts } = await this.listAccounts();
    if (!accounts.some(row => row.accountId === accountId)) throw failure('该账号不在当前微服务的账号列表中。', 404);
    const limit = 20;
    const query = new URLSearchParams({ account_id: accountId, status: 'published', limit: String(limit), offset: String(offset) });
    let page;
    try { page = await this.client.request('/v1/notes?' + query); }
    catch (error) {
      if (error.status === 404 && error.code === 'HTTP_404') {
        this.canReadPublishedNotes = false;
        throw failure('当前微服务版本尚未提供已发布笔记接口。', 501);
      }
      throw error;
    }
    if (!Array.isArray(page.items) || accountCount(page.total) === null || page.limit !== limit || page.offset !== offset
      || page.items.length !== Math.min(limit, Math.max(0, page.total - offset))) {
      throw failure('微服务返回的笔记分页信息无效。');
    }
    if (page.sync_accounts !== undefined && (!Array.isArray(page.sync_accounts) || page.sync_accounts.length > 1 || page.sync_accounts.some(sync => sync?.account_id !== accountId))) {
      throw failure('笔记同步记录与所选账号不符。');
    }
    const items = page.items.map(note => {
      if (note?.account_id !== accountId || note.status !== 'published') throw failure('微服务笔记的归属或发布状态与查询条件不符。');
      if (typeof note.title !== 'string') throw failure('微服务返回的笔记标题格式无效。');
      return {
        title: note.title, publishedAt: accountTime(note.published_at) ?? accountTime(note.platform_time),
        publishedTimeText: accountText(note.platform_time_text),
        visibility: note.visibility === 'private' ? 'private' : 'unknown',
        rawCounts: Array.isArray(note.metrics_raw)
          ? note.metrics_raw.map(value => accountCount(value) !== null ? String(value) : accountText(value))
          : [],
      };
    });
    this.canReadPublishedNotes = true;
    const status = page.sync_accounts?.[0];
    if (['queued', 'running'].includes(status?.status) && !JOB_ID.test(status.latest_job_id)) {
      throw failure('微服务未给出进行中笔记同步的任务编号。');
    }
    const sync = status && (syncStatuses.has(status.status) || status.status === 'never')
      ? { status: status.status, jobId: JOB_ID.test(status.latest_job_id) ? status.latest_job_id : null,
        error: syncErrorCode(status.error) } : null;
    return { items, total: page.total, offset, limit, lastSyncedAt: accountTime(page.last_synced_at), sync };
  }

  async accountSyncJob(scope, { requestId, jobId }) {
    this.target();
    if (!['metrics', 'notes'].includes(scope)) throw failure('该同步范围无效。', 400);
    const reading = jobId !== undefined;
    if (reading ? !JOB_ID.test(jobId) : typeof requestId !== 'string' || !syncRequestId.test(requestId)) {
      throw failure('同步任务或请求编号无效。', 400);
    }
    const id = this.accountId;
    const job = reading
      ? await this.client.request('/v1/jobs/' + jobId + '?account_id=' + encodeURIComponent(id))
      : await this.client.request('/v1/accounts/' + encodeURIComponent(id) + '/sync', {
        method: 'POST', body: { scope }, idempotencyKey: 'studio:' + id + ':' + scope + ':' + requestId,
      });
    if (!JOB_ID.test(job.job_id) || (reading && job.job_id !== jobId)
      || job.account_id !== id || job.action !== 'sync_' + scope || !syncStatuses.has(job.status)) {
      throw failure('同步任务回执与所选账号、同步范围或原任务不符。');
    }
    return { jobId: job.job_id, accountId: id, action: job.action, status: job.status,
      updatedAt: accountTime(job.updated_at), error: syncErrorCode(job.error) };
  }

  async inspect() {
    this.client.requireToken();
    const live = await this.client.request('/health/live');
    if (live.status !== 'ok') throw failure('小红书微服务存活检查失败。', 503);
    const ready = await this.client.request('/health/ready');
    if (ready.database !== 'ok' || ready.worker_active !== true) throw failure('小红书微服务的数据库或 worker 尚未就绪。', 503);
    const items = await this.readAccountItems();
    const configured = items.find(item => item?.account_id === this.accountId);
    if (!configured) throw failure('微服务账号列表中没有当前配置的账号，请核对账号 ID。', 409);
    if (configured.enabled !== true && (this.requireEnabledFlag || Object.hasOwn(configured, 'enabled'))) {
      throw failure('目标账号已停用或启用状态无效，请在微服务核对该账号。', 409);
    }
    // v0.1 exposes one account on /health/ready. Multi-account directories carry
    // their individual pause flag on /v1/accounts; the default account may be paused.
    const readyForTarget = ready.account_id === this.accountId || (!ready.account_id && items.length === 1);
    if (configured.paused !== false || (readyForTarget && ready.account_paused !== false)) {
      throw failure('微服务账号已暂停或状态未确认，请在服务端核对。', 409);
    }
    if (this.lanMedia && !this.mediaConfigurationError) {
      const host = new URL(this.lanMedia.origin).hostname;
      const allowed = Array.isArray(ready.image_allowed_hosts) && ready.image_allowed_hosts.includes(host);
      this.lanReadinessError = allowed ? '' : `微服务尚未允许局域网图片主机 ${host}。请将 ${host} 加入 XHS_IMAGE_ALLOWED_HOSTS，设置 XHS_IMAGE_ALLOW_PRIVATE=true，然后重启 API 和 worker。`;
    }
    const message = this.deliveryConfiguration.configured ? '微服务及账号队列已就绪，服务将在执行任务时核对小红书登录身份。'
      : '微服务已连接，可查询账号、草稿和已有任务。' + this.deliveryConfiguration.message;
    return { message, platformAccountId: accountText(configured.platform_account_id) };
  }

  async ensureReady(options) {
    this.target(options);
    if (!this.checking) {
      this.checking = this.inspect().then(({ message, platformAccountId }) => {
        this.connection = { ...this.connection, state: 'connected', message, lastCheckedAt: new Date().toISOString() };
        return platformAccountId;
      }).catch(error => {
        if (this.lanMedia) this.lanReadinessError = pendingLanCheck;
        this.connection = { ...this.connection, state: 'needs_attention', message: error.message, lastCheckedAt: new Date().toISOString() };
        throw error;
      }).finally(() => { this.checking = null; });
    }
    const platformAccountId = await this.checking;
    this.target(options);
    return platformAccountId;
  }

  async checkLogin(options) { await this.ensureReady(options); return this.snapshot(); }

  async preflight(options) {
    try {
      this.target(options);
      if (this.mediaConfigurationError) throw failure(this.mediaConfigurationError, 503, 'PUBLISHER_MEDIA_CONFIG');
      const platformAccountId = await this.ensureReady(options);
      if (!this.deliveryConfiguration.configured) throw failure(this.deliveryConfiguration.message, 503, 'PUBLISHER_MEDIA_CONFIG');
      if (options?.expectedPlatformAccountId != null && options.expectedPlatformAccountId !== platformAccountId) {
        throw failure('目标账号绑定已变化或无法核对，请刷新账号列表后重新确认。', 409, 'XHS_ACCOUNT_REBOUND');
      }
      return platformAccountId;
    }
    catch (error) { error.submissionNotAttempted = true; throw error; }
  }

  async startOfficialDraftSync({ accountId, limit = 50, offset = 0 } = {}) {
    this.target({ accountId });
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw failure('服务草稿的分页参数无效。', 400);
    if (this.draftSync.running) throw failure('正在读取服务草稿，请稍后再试。', 409);
    this.draftSync.running = true;
    try {
      const query = new URLSearchParams({ account_id: this.accountId, limit: String(limit), offset: String(offset) });
      const result = await this.client.request('/v1/drafts?' + query);
      if (!Array.isArray(result.items) || result.items.length > limit) throw failure('微服务草稿列表格式无效。');
      const rows = result.items.map(item => draftRow(item, this.accountId));
      this.rows = rows;
      this.draftSync = { running: false, lastSyncAt: new Date().toISOString(), error: '', coverage: {
        offset, limit, hasMore: Number.isSafeInteger(result.total) && result.total >= 0
          ? offset + rows.length < result.total : rows.length === limit, message: '仅包含此微服务跟踪的草稿。',
      } };
    } catch (error) { this.draftSync.error = error.message; throw error; }
    finally { this.draftSync.running = false; }
    return this.snapshot();
  }

  async getOfficialDraftDetail(key, options) {
    this.target(options);
    if (typeof key !== 'string' || !DRAFT_ID.test(key)) throw failure('服务草稿编号无效。', 404);
    const editJobId = options?.editJobId;
    if (editJobId && !JOB_ID.test(editJobId)) throw failure('修改任务编号无效。', 400);
    const item = await this.client.request('/v1/drafts/' + key + '?' + new URLSearchParams({ account_id: this.accountId }));
    const row = draftRow(item, this.accountId);
    if (row.key !== key || typeof item.caption !== 'string') throw failure('微服务返回的草稿编号或正文无效。');
    const lastSyncAt = new Date().toISOString();
    const jobs = (Array.isArray(item.jobs) ? item.jobs : []).filter(job => JOB_ID.test(job?.job_id) &&
      (!job.account_id || job.account_id === this.accountId) && (!job.draft_id || job.draft_id === key)).map(job => ({
      id: job.job_id, action: job.action, status: job.status, contentVersion: job.content_version, updatedAt: job.updated_at || null,
    }));
    const version = draftVersionDetails(item, this.accountId);
    const isComplete = version.images.length === row.imageCount;
    let editJob = null;
    if (editJobId && jobs.some(job => job.id === editJobId && job.action === 'update_draft')) {
      const remote = await this.client.request('/v1/jobs/' + editJobId);
      if (remote.job_id !== editJobId || remote.draft_id !== key || remote.account_id !== this.accountId || remote.action !== 'update_draft') {
        throw failure('微服务修改任务与所选账号或草稿不一致。');
      }
      editJob = { id: editJobId, status: remote.status, contentVersion: remote.content_version, contentHash: remote.content_hash };
    }
    const detail = { ...row, ...version, id: key, content: item.caption, tags: [], jobs, editJob, source: 'publisher_draft',
      fetchedAt: lastSyncAt, lastSyncAt, isComplete, message: isComplete ? '' : '部分草稿图片暂未提供预览。' };
    return { accountId: this.accountId, detail, contentStatus: { running: false, state: isComplete ? 'complete' : 'partial', error: '', isComplete, lastSyncAt } };
  }
  async submitDraft(input) {
    const platformAccountId = await this.preflight({ accountId: input?.accountId ?? null, expectedPlatformAccountId: input?.expectedPlatformAccountId });
    const result = await this.delivery.submitDraft({ ...input, platformAccountId });
    return { ...result, snapshot: this.snapshot() };
  }
  async retryDraft(id, options) {
    const platformAccountId = await this.preflight(options);
    const result = await this.delivery.retryDraft(id, { ...options, platformAccountId });
    return { ...result, snapshot: this.snapshot() };
  }
  async recheckDraft(id, options) {
    this.target(options);
    const result = await this.delivery.recheckDraft(id, options);
    return { ...result, snapshot: this.snapshot() };
  }
  getSubmissionDetail(id, options) {
    this.target(options);
    return this.delivery.getSubmissionDetail(id, options);
  }
  getSubmissionReceipt(id, options) {
    this.target(options);
    return this.delivery.getSubmission(id, options);
  }
}

// The configured default is also the original automatic-delivery target. Selecting
// another account uses its own receipt store, watcher, health state and draft pages.
export class XhsPublisherService extends PublisherAccount {
  constructor(options) {
    super(options);
    this.dir = options.dir;
    this.mediaBaseUrl = options.mediaBaseUrl;
    this.scopes = new Map();
    this.opening = new Map();
  }

  async init() {
    await super.init();
    if (this.client) {
      const ids = await savedPublisherAccounts(this.dir, this.client.baseUrl);
      await Promise.all(ids.filter(id => id !== this.accountId).map(id => this.openScope(id)));
    }
    return this.snapshot();
  }

  async openScope(id) {
    if (this.scopes.has(id)) return this.scopes.get(id);
    if (this.opening.has(id)) return this.opening.get(id);
    const scope = new PublisherAccount({ dir: this.dir, accountId: id, client: this.client, mediaBaseUrl: this.mediaBaseUrl,
      lanMedia: this.lanMedia, deliveryConfigurationError: this.mediaConfigurationError });
    // The parent owns the one shared LAN media listener.
    const opening = scope.delivery.init().then(() => {
      this.scopes.set(id, scope);
      return scope;
    }).finally(() => this.opening.delete(id));
    this.opening.set(id, opening);
    return opening;
  }

  async forAccount(id) {
    this.target();
    if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) throw failure('目标小红书账号编号无效。', 400);
    const { accounts } = await this.listAccounts();
    const row = accounts.find(account => account.accountId === id);
    if (!row) throw failure('目标账号已不在当前微服务的账号列表中。', 409, 'ACCOUNT_NOT_ALLOWED');
    this.target();
    const account = id === this.accountId ? this : await this.openScope(id);
    account.accountNickname = row.nickname;
    account.platformAccountId = row.platformAccountId;
    account.canReadPublishedNotes = this.canReadPublishedNotes;
    account.canReadMetrics = this.canReadMetrics;
    return account;
  }

  getAccountSnapshot(id) {
    if (this.accountId && id === this.accountId) return this.snapshot();
    return this.scopes.get(id)?.snapshot() ?? null;
  }

  async close() {
    this.closed = true;
    await Promise.allSettled(this.opening.values());
    await Promise.all([...this.scopes.values()].map(scope => {
      scope.closed = true;
      return scope.delivery.close();
    }));
    await super.close();
  }
}
