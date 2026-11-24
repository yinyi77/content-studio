import { randomUUID } from 'node:crypto';
import path from 'node:path';

const receiptIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const draftIdPattern = /^draft_[a-f0-9]{32}$/;
const jobIdPattern = /^job_[a-f0-9]{32}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const canStartAgain = status => status === 'failed' || status === 'canceled';
const unresolved = '预约提交结果待核对，可查询原任务。';

function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}

function minuteInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d(?::00(?:\.000)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    fail('请选择带时区、精确到分钟的预约时间。', 400);
  }
  const time = Date.parse(value);
  const wallTime = new Date(value.slice(0, 16) + ':00Z');
  if (!Number.isFinite(time) || !Number.isFinite(+wallTime) || wallTime.toISOString().slice(0, 16) !== value.slice(0, 16)) {
    fail('预约日期或时间无效。', 400);
  }
  return new Date(time).toISOString();
}

function view(record) {
  if (!record) return null;
  const { body, receiptId, title, status, message, remoteJobId, canRecover } = record;
  return { accountId: body.account_id, draftId: body.draft_id, receiptId, title, contentVersion: body.content_version,
    scheduledAt: body.publish_at, status, message, remoteJobId, canRecover: canRecover === true };
}

function sameDraft(draft, body, title) {
  return draft?.account_id === body.account_id && draft.draft_id === body.draft_id
    && draft.content_hash === body.approval.content_hash && draft.content_version === body.content_version && draft.title === title;
}

function sameJob(job, body) {
  return job?.action === 'schedule_publish' && jobIdPattern.test(job.job_id)
    && job.account_id === body.account_id && job.draft_id === body.draft_id && job.content_version === body.content_version
    && (!job.content_hash || job.content_hash === body.approval.content_hash) && Date.parse(job.publish_at) === Date.parse(body.publish_at);
}

async function jobResult(client, record, job) {
  const body = record.body;
  if (!sameJob(job, body) || (record.remoteJobId && record.remoteJobId !== job.job_id)) {
    return { status: 'unknown', message: '预约回执的账号、版本或时间不一致，请核对原任务。', canRecover: false };
  }
  const fields = { remoteJobId: job.job_id, canRecover: false };
  if (job.status === 'succeeded') {
    const draft = await client.request('/v1/drafts/' + body.draft_id);
    const check = draft.platform_result?.management_verification;
    if (sameDraft(draft, body, record.title) && draft.active_job_id === job.job_id && draft.phase === 'scheduled'
      && draft.platform_status === 'scheduled' && (!check || (check.scheduled_verified === true
        && Date.parse(check.publish_at) === Date.parse(body.publish_at) && (!check.title || check.title === record.title)))) {
      return { ...fields, status: 'scheduled', message: '小红书已确认预约时间。' };
    }
    return { ...fields, status: 'unknown', message: '任务已结束，平台草稿或预约时间仍待核对。' };
  }
  const messages = {
    queued: '微服务已受理，等待执行预约。', running: '微服务正在设置并核对预约时间。',
    needs_attention: '预约结果需在微服务中人工核对。', canceled: '预约任务已取消。',
    failed: '微服务返回预约失败，请核对草稿和时间。',
  };
  return Object.hasOwn(messages, job.status)
    ? { ...fields, status: job.status, message: messages[job.status] }
    : { ...fields, status: 'unknown', message: unresolved };
}

export class XhsSchedules {
  constructor({ store, xhs }) {
    this.store = store;
    this.xhs = xhs;
    this.pending = new Map();
  }

  async withReceipt({ accountId, receiptId, draftId }, work) {
    const byDraft = draftId != null;
    if (typeof accountId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(accountId)
      || (byDraft ? !draftIdPattern.test(draftId) || receiptId != null : !receiptIdPattern.test(receiptId))) fail('请选择目标账号及作品草稿。', 400);
    const account = await this.xhs.forAccount(accountId);
    const receipt = byDraft
      ? account.delivery.listSubmissions().find(r => r.remoteDraftId === draftId && r.accountId === accountId)
      : await account.getSubmissionReceipt(receiptId, { accountId });
    if (!byDraft && (receipt?.id !== receiptId || receipt.accountId !== accountId)) fail('该账号下没有这份送稿回执。', 404);
    const remoteId = byDraft ? draftId : receipt.remoteDraftId;
    if (!draftIdPattern.test(remoteId)) fail('草稿送达后才能预约。');
    // Both entry points must serialize and persist against the same platform draft.
    const directory = path.join(account.delivery.directory, 'schedules');
    const file = path.join(directory, remoteId + '.json');
    const run = (this.pending.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
      let record = await this.store.read(file, null);
      if (!record && receipt) record = await this.store.read(path.join(directory, receipt.id + '.json'), null);
      if (record && (record.body?.account_id !== accountId || record.body.draft_id !== remoteId)) {
        fail('本地预约记录与所选草稿不一致。');
      }
      return work({ account, file, receipt, record, remoteId, byDraft });
    });
    this.pending.set(file, run);
    try { return await run; }
    finally { if (this.pending.get(file) === run) this.pending.delete(file); }
  }

  async save(file, record, fields) {
    const updated = { ...record, ...fields };
    if (Object.entries(fields).some(([k,v]) => record[k] !== v)) await this.store.atomic(file, updated);
    return updated;
  }

  async refresh({ account, file, record }) {
    if (!record || record.status === 'scheduled' || canStartAgain(record.status)) return record;
    const { body } = record;
    let job, fields;
    try {
      if (record.remoteJobId) {
        job = await account.client.request('/v1/jobs/' + record.remoteJobId);
      } else {
        // Lost responses are reconciled against this exact frozen draft. GET never submits a new job.
        const draft = await account.client.request('/v1/drafts/' + body.draft_id);
        if (sameDraft(draft, body, record.title)) {
          const matches = (draft.jobs || []).filter(candidate => sameJob(candidate, body)
            && !record.priorJobIds?.includes(candidate.job_id));
          if (matches.length === 1) job = await account.client.request('/v1/jobs/' + matches[0].job_id);
          else if (!matches.length && draft.phase === 'ready' && draft.platform_status === 'draft_verified') {
            fields = { status: 'unknown', message: '尚未找到预约回执，可再次确认，用原请求找回任务。', canRecover: true };
          }
        }
      }
      fields = job ? await jobResult(account.client, record, job) : fields;
    } catch {
      fields = { status: 'unknown', message: '暂时无法核对预约结果，可稍后查询。', canRecover: false };
    }
    return this.save(file, record, fields || { status: 'unknown', message: unresolved, canRecover: false });
  }

  get(input) {
    return this.withReceipt(input, async context => view(await this.refresh(context)));
  }

  async submit(input) {
    if (input?.confirmed !== true) fail('请确认目标账号、帖子版本和北京时间后再预约。', 400);
    const publishAt = minuteInstant(input.scheduledAt);
    return this.withReceipt(input, async context => {
      const { account, file, receipt, byDraft, remoteId } = context;
      const { accountId, expectedContentVersion, expectedContentHash } = input;
      if (!hashPattern.test(expectedContentHash) || !Number.isSafeInteger(expectedContentVersion) || expectedContentVersion < 1
        || (!byDraft && (receipt.status !== 'verified' || expectedContentVersion !== receipt.contentVersion
          || expectedContentHash !== receipt.contentHash))) fail('请先核对本账号已保存的草稿版本，再确认预约。');
      let record = await this.refresh(context);
      const recovering = record && !canStartAgain(record.status);
      if (recovering) {
        if (record.body.content_version !== expectedContentVersion || record.body.approval.content_hash !== expectedContentHash) fail('原预约使用了其他版本，请核对该草稿。');
        if (publishAt !== record.body.publish_at) fail('这份草稿已有预约请求，请先核对原时间和结果。');
        if (!record.canRecover) return view(record);
      }
      const lead = Date.parse(publishAt) - Date.now();
      if (lead <= 0 || lead > 14 * 86_400_000) fail('请选择未来 14 天内的预约时间。', 400);
      const { accounts } = await this.xhs.listAccounts();
      const row = accounts.find(a => a.accountId === accountId);
      if (!row || row.enabled === false || row.paused !== false) fail('该账号已停用、暂停或不可用，请检查账号配置。');
      if ((receipt?.platformAccountId && row.platformAccountId !== receipt.platformAccountId)
        || (input.expectedPlatformAccountId !== undefined && row.platformAccountId !== input.expectedPlatformAccountId)) {
        fail('所选服务账号的小红书绑定已变化，请重新选择账号并核对草稿。');
      }
      if (row.publishEnabled !== true) fail('该账号尚未开启预约发布，可保留草稿。');

      const body = recovering ? record.body : {
        action: 'schedule_publish', account_id: accountId, draft_id: remoteId,
        content_version: expectedContentVersion, publish_at: publishAt,
        approval: { approved: true, approved_by: 'content-studio-local-owner',
          approved_at: new Date().toISOString(), content_hash: expectedContentHash },
      };
      const draft = await account.client.request('/v1/drafts/' + body.draft_id);
      const title = recovering ? record.title : byDraft ? draft?.title : receipt.title;
      if (typeof title !== 'string' || !title.trim() || !sameDraft(draft, body, title) || draft.pending_update
        || draft.phase !== 'ready' || draft.platform_status !== 'draft_verified') {
        fail('服务草稿已变化、已有预约或尚未就绪，请重新核对。');
      }
      if (!recovering) {
        record = { receiptId: receipt?.id ?? null, title, body, idempotencyKey: 'content-studio:schedule:' + randomUUID(),
          priorJobIds: (draft.jobs || []).filter(job => job.action === 'schedule_publish').map(job => job.job_id),
          status: 'unknown', message: unresolved, remoteJobId: null, canRecover: false };
      } else {
        record = { ...record, canRecover: false, message: unresolved };
      }
      await this.store.atomic(file, record);
      let job;
      try {
        job = await account.client.request('/v1/jobs', { method: 'POST', body, idempotencyKey: record.idempotencyKey });
      } catch (error) {
        if (!recovering && error.status >= 400 && error.status < 500 && ![408, 409].includes(error.status)) {
          return view(await this.save(file, record, { status: 'failed', message: error.message }));
        }
        if (!recovering && ['PUBLISH_DISABLED', 'ACCOUNT_PAUSED', 'CONTENT_VERSION_MISMATCH',
          'DAILY_LIMIT_REACHED', 'SCHEDULE_TOO_SOON', 'SCHEDULE_TOO_FAR'].includes(error.code)) {
          return view(await this.save(file, record, { status: 'failed', message: error.message }));
        }
        return view(await this.refresh({ ...context, record }));
      }
      if (sameJob(job, body)) record = await this.save(file, record, { remoteJobId: job.job_id });
      // Persist the job ID before performing any further network read.
      let result;
      try { result = await jobResult(account.client, record, job); }
      catch { result = { status: 'unknown', message: unresolved, canRecover: false }; }
      return view(await this.save(file, record, result));
    });
  }
}
