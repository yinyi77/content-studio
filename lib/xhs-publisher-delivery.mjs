import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { xhsCopyProblem } from '../public/publishing-platform.js';

const active = item => ['queued', 'running'].includes(item.status);
const now = () => new Date().toISOString();
const hash = /^[a-f0-9]{64}$/;
const jobId = /^job_[a-f0-9]{32}$/;
const draftId = /^draft_[a-f0-9]{32}$/;
const projectId = /^[a-f0-9-]{36}$/i;
const filename = /^[a-f0-9-]{36}-[a-f0-9-]{36}\.(png|jpg|webp)$/i;
function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
function admissionFailed(error) { error.submissionNotAttempted = true; throw error; }
const unresolved = message => ({ status: 'unknown', message, retryMode: null });
const receiptLost = () => ({
  ...unresolved('微服务受理回执尚未确认。可在送稿记录中用原请求和原幂等键找回任务。'),
  retryMode: 'recover_receipt',
});

function view(item) {
  if (!item) return null;
  const { id, accountId, projectId, fingerprint, status, message, createdAt, updatedAt, remoteJobId,
    remoteDraftId, contentHash, contentVersion, retryMode, attempts, operation, verifiedAt } = item;
  const canRetryDownload = retryMode === 'download' && status === 'failed' && jobId.test(remoteJobId) && draftId.test(remoteDraftId);
  const canReplayCreate = !remoteJobId && !remoteDraftId && (
    (retryMode === 'resubmit' && status === 'failed') || (retryMode === 'recover_receipt' && status === 'unknown'));
  return { id, accountId, platformAccountId: item.platformAccountId ?? null, projectId, fingerprint, title: item.body.content.title, status, message, createdAt, updatedAt,
    remoteJobId, remoteDraftId, contentHash, contentVersion, retryMode, attempts, operation, verifiedAt,
    rechecking: operation === 'recheck' && active(item), canRecheck: status === 'unknown' && Boolean(remoteJobId),
    canRetry: canRetryDownload || canReplayCreate };
}

function submissionImages(input, accountId) {
  if (!input || input.accountId !== accountId) fail('送稿账号与微服务配置不一致');
  if (!projectId.test(input.projectId) || !hash.test(input.fingerprint)) fail('本地作品版本无效', 400);
  if (typeof input.title !== 'string' || !input.title.trim() || typeof input.content !== 'string' || !input.content.trim()) fail('微服务送稿需要填写标题和正文', 400);
  const copyProblem = xhsCopyProblem(input.title, input.content);
  if (copyProblem) fail(copyProblem, 400);
  if (!Array.isArray(input.images) || input.images.length < 1 || input.images.length > 18) fail('微服务送稿需要 1 到 18 张静态图片', 400);
  return input.images.map(file => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !filename.test(path.basename(file))) fail('作品图片地址或格式无效', 400);
    return '/media/' + input.projectId + '/' + path.basename(file);
  });
}

function externalImageUrls(images, mediaBaseUrl) {
  let base;
  try { base = new URL(mediaBaseUrl); } catch { fail('请配置微服务可以读取的作品图片地址', 400); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) fail('作品图片地址配置无效', 400);
  return images.map(image => base.href.replace(/\/$/, '') + image);
}

function matchesJob(job, item) {
  return job && jobId.test(job.job_id) && draftId.test(job.draft_id) && job.account_id === item.accountId && job.action === 'create_draft'
    && (!item.remoteJobId || job.job_id === item.remoteJobId) && (!item.remoteDraftId || job.draft_id === item.remoteDraftId);
}

function createError(error, recovering) {
  const reason = {
    UNAUTHORIZED: '服务令牌无效，请检查微服务配置。',
    ACCOUNT_NOT_ALLOWED: '微服务拒绝了目标账号，请检查账号配置。',
    IMAGE_URL_NOT_ALLOWED: '微服务拒绝了图片来源，请检查微服务的图片域名许可配置。',
    INVALID_REQUEST: '微服务拒绝了草稿参数，请检查送稿内容。',
  }[error?.code];
  if (reason && !recovering) return { status: 'failed', message: reason, retryMode: 'resubmit' };
  if (['DUPLICATE_CONTENT', 'IDEMPOTENCY_CONFLICT'].includes(error?.code)) return unresolved('微服务检测到已有内容或相同幂等键冲突，请在微服务中核对原记录。');
  return receiptLost();
}

// Only a successful create job followed by the matching verified draft can
// complete a submission. A queued receipt or a local copy of the media cannot.
function checkedResult(job, draft, item) {
  const { title, caption, image_urls } = item.body.content;
  if (draft?.draft_id !== item.remoteDraftId || draft.account_id !== item.accountId || draft.phase !== 'ready'
    || draft.platform_status !== 'draft_verified' || draft.active_job_id !== item.remoteJobId
    || !hash.test(draft.content_hash) || !Number.isInteger(draft.content_version) || draft.content_version < 1
    || job.content_hash && job.content_hash !== draft.content_hash || job.content_version !== draft.content_version
    || draft.title !== title || draft.caption !== caption || draft.image_count !== image_urls.length) {
    return unresolved('创建任务已结束，但草稿记录与本次送稿尚未核对一致。请检查微服务记录后重新核验。');
  }
  return { status: 'verified', message: '微服务已核验该账号的电脑草稿。', verifiedAt: now(),
    contentHash: draft.content_hash, contentVersion: draft.content_version, retryMode: null };
}

function storageScope(serviceUrl, accountId) {
  return createHash('sha256').update(JSON.stringify([String(serviceUrl).replace(/\/+$/, ''), accountId])).digest('hex');
}

// Reopen only receipts from this service, even if the configured default account changes.
export async function savedPublisherAccounts(dir, serviceUrl) {
  const directory = path.join(dir, 'xhs-publisher');
  const folders = await readdir(directory, { withFileTypes: true });
  const ids = await Promise.all(folders.filter(entry => entry.isDirectory() && hash.test(entry.name)).map(async entry => {
    let id;
    try { id = await readFile(path.join(directory, entry.name, 'account-id'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return /^[\w-]{1,120}$/.test(id) && storageScope(serviceUrl, id) === entry.name ? id : null;
  }));
  return ids.filter(Boolean);
}

export class XhsPublisherDelivery {
  constructor({ dir, client, accountId, mediaBaseUrl, lanMedia, serviceUrl = client.baseUrl || '', pollMs = 5000, maxPollMs = 30 * 60_000 }) {
    this.client = client;
    this.accountId = accountId;
    this.mediaBaseUrl = mediaBaseUrl;
    this.lanMedia = lanMedia;
    const scope = storageScope(serviceUrl, accountId);
    this.dataDir = dir;
    this.directory = path.join(dir, 'xhs-publisher', scope);
    this.file = path.join(this.directory, 'delivery.json');
    this.pollMs = pollMs;
    this.maxPollMs = maxPollMs;
    this.records = [];
    this.serial = Promise.resolve();
    this.workers = new Map();
    this.stop = new AbortController();
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { await writeFile(path.join(this.directory, 'account-id'), this.accountId, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(saved) || saved.some(item => item.accountId !== this.accountId || !item.body?.content)) fail('小红书微服务送稿记录无效', 500);
      this.records = saved;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const item of this.records.filter(active)) {
      if (item.remoteJobId) this.launch(item.id);
      else await this.patch(item.id, receiptLost());
    }
    return this;
  }

  // All admission decisions and durable state transitions are serialized.
  // A failed write never becomes the state visible to the next caller.
  locked(fn) {
    const result = this.serial.then(fn);
    this.serial = result.catch(() => {});
    return result;
  }

  async persist(records) {
    const temp = this.file + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(records), { mode: 0o600 });
    await rename(temp, this.file);
    this.records = records;
  }

  row(id) { return this.records.find(item => item.id === id); }
  patch(id, fields) {
    return this.locked(async () => {
      const item = this.row(id);
      if (Object.entries(fields).every(([key, value]) => item[key] === value)) return item;
      const updated = { ...item, ...fields, updatedAt: now() };
      await this.persist(this.records.map(row => row.id === id ? updated : row));
      return updated;
    });
  }

  listSubmissions() { return this.records.map(view).reverse(); }
  prepareEditImages(input, { store, draftId, version, expectedImages }) {
    return this.locked(async () => {
      const images = submissionImages(input, this.accountId);
      if (!Array.isArray(expectedImages) || images.length !== expectedImages.length || images.some((url, i) => url !== expectedImages[i])) {
        fail('所选作品的配图已变更，请重新选择后查看。');
      }
      const key = createHash('sha256').update(JSON.stringify([this.accountId, draftId, version, input.projectId, images, input.imageHashes])).digest('hex');
      const file = path.join(this.directory, 'edit-images', key + '.json');
      const saved = await store.read(file, null);
      if (saved) {
        if (saved.lan !== Boolean(this.lanMedia) || !Array.isArray(saved.urls) || saved.urls.length !== images.length) fail('图片服务设置已变化，请核对原修改记录。');
        if (saved.lan) await this.lanMedia.renewUrls(saved.urls);
        return saved.urls;
      }
      const urls = this.lanMedia ? await this.lanMedia.createUrls(input) : externalImageUrls(images, this.mediaBaseUrl);
      await store.atomic(file, { lan: Boolean(this.lanMedia), urls });
      return urls;
    });
  }
  findSubmission({ projectId, accountId = this.accountId, fingerprint }) {
    return view(this.records.find(item => item.projectId === projectId && item.accountId === accountId && item.fingerprint === fingerprint));
  }
  getSubmission(id, { accountId = this.accountId } = {}) { return accountId === this.accountId ? view(this.row(id)) : null; }
  async getSubmissionDetail(id, { accountId = this.accountId } = {}) {
    const item = this.row(id);
    if (!item || accountId !== item.accountId) fail('送稿记录不存在', 404);
    const directory = path.join(await realpath(this.dataDir), 'projects', item.projectId, 'images');
    const images = [];
    for (const image of item.images) {
      const name = path.basename(image);
      if (!filename.test(name) || image !== '/media/' + item.projectId + '/' + name) continue;
      try {
        const file = path.join(directory, name);
        if (await realpath(file) === file) images.push(image);
      } catch { /* A user may remove the project after delivery. */ }
    }
    const isComplete = images.length === item.images.length;
    return { id, accountId, projectId: item.projectId, title: item.body.content.title, content: item.body.content.caption,
      images, imageURLs: [...images], isComplete, message: isComplete ? '' : '部分本地原图已移除或不可读取，仍可查看送稿时的文案。' };
  }

  submitDraft(input) {
    return this.locked(async () => {
      if (this.stop.signal.aborted) fail('送稿服务正在关闭', 503);
      const images = submissionImages(input, this.accountId);
      const old = this.findSubmission(input);
      if (old?.platformAccountId && old.platformAccountId !== input.platformAccountId) {
        fail('此前草稿所属的平台账号与当前绑定不一致，请重新核对送稿记录。');
      }
      if (old) return { draft: old, duplicate: true };
      if (this.records.some(item => item.projectId === input.projectId && (active(item) || item.status === 'unknown'))) fail('此前版本仍在处理或等待核验，请先核对原送稿记录。');
      const imageUrls = this.lanMedia ? await this.lanMedia.createUrls(input) : externalImageUrls(images, this.mediaBaseUrl);
      const body = { action: 'create_draft', account_id: this.accountId, content: { external_content_id: input.projectId + ':' + input.fingerprint,
        title: input.title, caption: input.content, image_urls: imageUrls } };
      const createdAt = now();
      const item = { id: randomUUID(), projectId: input.projectId, accountId: this.accountId, platformAccountId: input.platformAccountId ?? null, fingerprint: input.fingerprint,
        idempotencyKey: 'content-studio:create:' + input.fingerprint, body, images, ...(this.lanMedia ? { mediaMode: 'lan' } : {}), status: 'queued', operation: 'save',
        message: '正在向微服务提交电脑草稿。', attempts: 1, retryMode: null, verifiedAt: null,
        remoteJobId: null, remoteDraftId: null, contentHash: null, contentVersion: null, createdAt, updatedAt: createdAt };
      await this.persist([...this.records, item]);
      this.launch(item.id, 'create');
      return { draft: view(item), duplicate: false };
    }).catch(admissionFailed);
  }

  retryDraft(id, options = {}) { return this.resume(id, options, 'retry'); }
  recheckDraft(id, options = {}) { return this.resume(id, options, 'recheck'); }
  resume(id, { accountId = this.accountId, platformAccountId }, operation) {
    return this.locked(async () => {
      if (this.stop.signal.aborted) fail('送稿服务正在关闭', 503);
      const item = this.row(id);
      if (!item || item.accountId !== accountId) fail('送稿记录不存在', 404);
      if (operation === 'retry' && item.platformAccountId && item.platformAccountId !== platformAccountId) {
        fail('原草稿所属的平台账号与当前绑定不一致，无法向新绑定重试送稿。');
      }
      if (item.status === 'verified') return { draft: view(item), duplicate: true };
      const check = operation === 'recheck';
      if (!(check ? view(item).canRecheck : view(item).canRetry) || this.workers.has(id)) fail(check ? '当前没有可以只读核验的任务。' : '这次送稿不能安全重试，请核对原任务。');
      if (!check && item.mediaMode === 'lan') {
        if (!this.lanMedia) fail('请恢复原局域网图片服务的配置后，再重试该送稿记录。', 503);
        await this.lanMedia.renewUrls([...item.body.content.image_urls]);
      }
      const updated = { ...item, status: 'queued', operation: check ? 'recheck' : 'save', retryMode: null, updatedAt: now(),
        attempts: item.attempts + Number(!check), message: check ? '正在核验原微服务任务。' : '正在恢复原送稿任务。' };
      await this.persist(this.records.map(row => row.id === id ? updated : row));
      this.launch(id, check ? 'poll' : item.retryMode);
      return { draft: view(updated), duplicate: false };
    }).catch(admissionFailed);
  }

  launch(id, operation = 'poll') {
    const worker = this.process(id, operation).catch(async () => {
      // Persistence errors after a request must not cause a second create.
      const item = this.row(id);
      if (!this.stop.signal.aborted && active(item)) {
        await this.patch(id, item.remoteJobId ? unresolved('送稿记录暂未更新，请重新核验原任务。') : receiptLost()).catch(() => {});
      }
    }).finally(() => this.workers.delete(id));
    this.workers.set(id, worker);
  }

  async process(id, operation) {
    let item = this.row(id);
    if (!['poll', 'download'].includes(operation)) {
      let job;
      try { job = await this.client.request('/v1/jobs', { method: 'POST', body: structuredClone(item.body), idempotencyKey: item.idempotencyKey }); }
      catch (error) { await this.patch(id, createError(error, operation === 'recover_receipt')); return; }
      if (!matchesJob(job, item)) { await this.patch(id, unresolved('微服务回执与送稿账号或任务类型不一致，请在服务端核对。')); return; }
      item = await this.patch(id, { remoteJobId: job.job_id, remoteDraftId: job.draft_id, message: '微服务已受理，正在等待草稿核验。' });
    } else if (operation === 'download') {
      try {
        const job = await this.client.request('/v1/jobs/' + item.remoteJobId + '/retry-download', { method: 'POST' });
        if (!matchesJob(job, item)) { await this.patch(id, unresolved('素材重试回执与原任务不一致，请核对。')); return; }
      } catch {
        await this.patch(id, unresolved('素材重试回执尚未确认，请重新查询原任务。'));
        return;
      }
    }

    const deadline = Date.now() + this.maxPollMs;
    while (!this.stop.signal.aborted) {
      let fields;
      try { fields = await this.observe(item); }
      catch (error) {
        if ([401, 403, 404].includes(error?.status)) {
          await this.patch(id, unresolved('微服务没有返回可读取的原任务，请检查服务地址、凭证和任务编号后重新核验。'));
          return;
        }
      }
      if (fields) {
        item = await this.patch(id, fields);
        if (!active(item)) return;
      }
      if (Date.now() >= deadline) {
        await this.patch(id, unresolved('等待微服务核验超时。任务编号已保留，可继续查询原任务。'));
        return;
      }
      await sleep(this.pollMs, undefined, { signal: this.stop.signal, ref: false });
    }
  }

  async observe(item) {
    const job = await this.client.request('/v1/jobs/' + item.remoteJobId, { method: 'GET' });
    if (!matchesJob(job, item)) return unresolved('微服务返回的任务与本次送稿不一致，请核对服务记录。');
    switch (job.status) {
      case 'queued': return { status: 'queued', message: '微服务已受理，正在排队。' };
      case 'running': return { status: 'running', message: '微服务正在处理草稿。' };
      case 'succeeded': {
        const draft = await this.client.request('/v1/drafts/' + item.remoteDraftId, { method: 'GET' });
        return checkedResult(job, draft, item);
      }
      case 'failed':
        if (job.phase === 'create_failed') return { status: 'failed', message: '素材准备失败。请检查图片地址及下载权限，再对原任务重试下载。', retryMode: 'download' };
        return unresolved('创建任务失败，平台保存结果尚未确认。请在微服务中核对。');
      case 'canceled': return { status: 'failed', message: '微服务中的创建任务已取消。', retryMode: null };
      case 'needs_attention': return unresolved('微服务要求人工核对账号或草稿。处理完成后，可重新查询原任务。');
      default: return unresolved('微服务返回了未识别的任务状态，请核对原记录。');
    }
  }

  async close() {
    this.stop.abort();
    await this.serial;
    await Promise.allSettled([...this.workers.values()]);
    await this.serial;
  }
}
