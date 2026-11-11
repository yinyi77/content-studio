import { createHash } from 'node:crypto';

const ACTIVE = new Set(['preparing', 'queued', 'running']);
const UNCERTAIN = new Set(['filled', 'unknown']);
const resumable = (delivery, task) => (delivery.status === 'blocked' || delivery.status === 'interrupted') && !delivery.attempted
  || delivery.status === 'failed' && (task?.canRetry === true || !delivery.attempted && !delivery.draftId);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = (message, status = 409) => { const error = new Error(message); error.status = status; throw error; };
const complete = project => project.status === 'completed' && Array.isArray(project.pages) && project.pages.length > 0 && project.pages.every(page => page.status === 'done' && page.imageUrl);
// A saved binding is sufficient to accept an explicit delivery request. The
// worker still has to recheck its live session before preparing or writing.
const bound = state => Boolean(state.account?.id && ['connected', 'needs_attention', 'login_required', 'browser_unavailable'].includes(state.connection.state));
// A display-only change detector. Admission still prepares real file hashes;
// this signature never authorizes an external write or replaces its fingerprint.
const contentSignature = project => createHash('sha256').update(JSON.stringify({ title: String(project.title || '').trim(), content: String(project.caption || '').trim(), images: (project.pages || []).map(page => page.imageUrl) })).digest('hex');
const receiptKeys = ['accountId', 'accountName', 'draftId', 'fingerprint', 'version', 'status', 'reason', 'message', 'attempted', 'updatedAt', 'verifiedAt', 'contentSignature'];
const receipt = value => Object.fromEntries(receiptKeys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const sameVersion = (left, right) => left?.accountId === right?.accountId && Boolean(left?.fingerprint && left.fingerprint === right?.fingerprint || left?.draftId && left.draftId === right?.draftId);
const historyOf = delivery => (Array.isArray(delivery?.history) ? delivery.history : []).map(receipt).filter(item => item.fingerprint || item.draftId);
const appendReceipt = (history, value) => value?.fingerprint || value?.draftId ? [...history.filter(item => !sameVersion(item, value)), receipt(value)] : history;

export function initialXhsDelivery(snapshot, requestedAccountId) {
  const current = snapshot.account;
  const accountId = requestedAccountId === undefined ? current?.id || null : requestedAccountId || null;
  const mismatch = Boolean(accountId && accountId !== current?.id);
  return { enabled: true, accountId, accountName: accountId === current?.id ? current.nickname : '',
    status: mismatch ? 'blocked' : 'waiting_generation', reason: mismatch ? 'account_changed' : '',
    message: mismatch ? '目标小红书账号已变化，图文会保留，送稿前请核对账号。' : '图文全部生成后，自动存入本次绑定的小红书电脑草稿。',
    draftId: null, fingerprint: null, attempted: false, version: 1, history: [], updatedAt: new Date().toISOString() };
}

/** The queue owns only delivery metadata. It never runs a model, publishes a
 * note, or restores a write action from a GET request or process restart. */
export class XhsDeliveryQueue {
  constructor({ store, xhs, prepare, modelBusy, admit = work => work(), safe = value => String(value || '送稿未完成'), wait = pause, maxWaitMs = 180000 } = {}) {
    this.store = store; this.xhs = xhs; this.prepare = prepare; this.modelBusy = modelBusy; this.admit = admit; this.safe = safe;
    this.wait = wait; this.maxWaitMs = maxWaitMs; this.active = new Set(); this.tail = Promise.resolve(); this.closed = false;
  }
  accountState(accountId) {
    if (!accountId || typeof this.xhs.getAccountSnapshot !== 'function') return this.xhs.snapshot();
    return this.xhs.getAccountSnapshot(accountId) || { account: null, connection: { state: 'disconnected', message: '目标小红书账号已从平台移除，图文已保留。' }, status: { busy: false }, drafts: [] };
  }
  task(project, d = project?.xhsDelivery) {
    if (!d?.enabled) return null;
    const state = this.accountState(d.accountId);
    if (d.accountId !== state.account?.id) return null;
    return state.drafts.find(item => item.accountId === d.accountId && item.projectId === project.id && (d.draftId ? item.id === d.draftId : d.fingerprint && item.fingerprint === d.fingerprint)) || null;
  }
  isProcessing(project) {
    return this.active.has(project.id) || this.accountState(project.xhsDelivery?.accountId).drafts.some(task => task.projectId === project.id && (['queued', 'running'].includes(task.status) || task.rechecking));
  }
  view(project) {
    if (!project?.xhsDelivery?.enabled) return project;
    const d = { ...project.xhsDelivery }, task = d.draftId || !ACTIVE.has(d.status) ? this.task(project) : null;
    if (task) Object.assign(d, { status: task.status, draftId: task.id, fingerprint: task.fingerprint, message: task.message, updatedAt: task.updatedAt, verifiedAt: task.verifiedAt || null,
      canRecheck: task.canRecheck, operation: task.operation, rechecking: task.rechecking });
    d.history = historyOf(d).map(item => {
      const old = this.task(project, { ...item, enabled: true });
      return old ? { ...item, status: old.status, message: old.message, updatedAt: old.updatedAt, verifiedAt: old.verifiedAt || null,
        canRecheck: old.canRecheck, operation: old.operation, rechecking: old.rechecking } : item;
    });
    d.version ||= 1;
    const handoff = project.chatRequests?.at(-1);
    d.running = this.isProcessing(project) || Boolean(this.modelBusy?.(project.id) && handoff?.saveVersionRequested && handoff.status === 'completed');
    d.canContinue = !d.running && resumable(d, task);
    const state = this.accountState(d.accountId);
    const unresolved = state.drafts.some(item => item.projectId === project.id && item.accountId === d.accountId
      && (['queued', 'running', 'filled', 'unknown', 'interrupted'].includes(item.status) || item.rechecking));
    d.canSaveVersion = !d.running && complete(project) && bound(state)
      && (!d.accountId || d.accountId === state.account.id) && !UNCERTAIN.has(d.status)
      && !unresolved && (d.status !== 'interrupted' || !d.attempted) && (d.status !== 'failed' || resumable(d, task));
    d.versionChanged = d.contentSignature ? d.contentSignature !== contentSignature(project) : null;
    if (d.canRecheck === undefined) d.canRecheck = !d.running && !state.status.busy && state.connection.state === 'connected'
      && d.accountId === state.account?.id && Boolean(d.draftId) && UNCERTAIN.has(d.status);
    return { ...project, xhsDelivery: d };
  }
  async update(id, patch) {
    const project = await this.store.get(id); if (!project?.xhsDelivery) return null;
    project.xhsDelivery = { ...project.xhsDelivery, ...patch, updatedAt: new Date().toISOString() };
    await this.store.save(project); return project;
  }
  async recover() {
    for (const project of await this.store.list()) {
      const task = this.task(project);
      const d = project.xhsDelivery;
      if (!d?.enabled || !(ACTIVE.has(d.status) || d.status === 'waiting_generation' && project.status === 'completed' && project.chatStatus === 'idle' || !d.draftId && d.fingerprint && task)) continue;
      await this.update(project.id, task ? { status: task.status, draftId: task.id, message: task.message, verifiedAt: task.verifiedAt || null }
        : { status: d.attempted ? 'unknown' : 'interrupted', message: d.attempted ? '上次送稿结果尚未确认，请先核对小红书电脑草稿，不会自动重传。' : '上次自动送稿被中断，图文已保留；确认账号后可继续送入草稿。' });
    }
  }
  async afterCreative(project) {
    const d = project.xhsDelivery;
    if (!d?.enabled || d.draftId || d.status !== 'waiting_generation' || project.status !== 'completed' || project.chatStatus !== 'idle') return;
    if (!d.accountId) { await this.update(project.id, { status: 'blocked', reason: 'not_connected', message: '图文已全部完成。请在当前对话连接并确认小红书账号，再继续送入草稿。' }); return; }
    await this.enqueue(project.id);
  }
  async enqueueVersion(id, { accountId } = {}) {
    if (this.closed) fail('自动送稿队列已关闭', 503);
    if (this.active.has(id)) {
      const current = this.view(await this.store.get(id));
      if (current.xhsDelivery?.pendingVersion && accountId && current.xhsDelivery.accountId === accountId && this.accountState(accountId).account?.id === accountId) return current;
      fail('这份作品仍在送稿，请等待当前操作完成');
    }
    this.active.add(id);
    try {
      let project = await this.store.get(id); if (!project) fail('作品不存在', 404);
      const state = this.accountState(accountId);
      if (!accountId || state.account?.id !== accountId || !bound(state)) fail('请先绑定本次送稿的小红书账号');
      project = this.view(project);
      const d = project.xhsDelivery?.enabled ? project.xhsDelivery : initialXhsDelivery(state, accountId);
      if (d.accountId && d.accountId !== accountId) fail('本次创作绑定的账号与当前账号不同，不能改投其他账号');
      const related = state.drafts.filter(item => item.projectId === id && item.accountId === accountId);
      if (related.some(item => ['queued', 'running', 'filled', 'unknown', 'interrupted'].includes(item.status) || item.rechecking)
        || UNCERTAIN.has(d.status) || d.status === 'interrupted' && d.attempted) fail('此前版本仍在处理或保存结果待核验，请先核验电脑草稿，不能另存或重复送出');
      if (d.status === 'failed' && !resumable(d, this.task(project))) fail('此前草稿不能安全重试，请先核对电脑端实际结果');
      if (!complete(project)) fail('请先完成全部图片，再保存当前版本草稿');
      const previous = receipt(d), history = appendReceipt(historyOf(d), previous);
      const nextVersion = d.fingerprint || d.draftId ? Math.max(d.version || 1, ...history.map(item => item.version || 1)) + 1 : d.version || 1;
      project.xhsDelivery = { enabled: true, accountId, accountName: state.account.nickname, status: 'queued', reason: '',
        message: '正在按当前图文版本准备草稿；相同版本会复用原有记录，新版本会另存，原草稿保留。',
        draftId: null, fingerprint: null, attempted: false, verifiedAt: null, contentSignature: null,
        version: nextVersion, history, pendingVersion: true, previousVersion: previous, updatedAt: new Date().toISOString() };
      await this.store.save(project);
      this.schedule(id); return this.view(project);
    } catch (error) { this.active.delete(id); throw error; }
  }
  schedule(id) {
    const work = this.tail.catch(() => {}).then(() => this.run(id)).catch(async error => {
      const current = await this.store.get(id); if (!current?.xhsDelivery) return;
      const task = this.task(current);
      await this.update(id, task ? { status: task.status, draftId: task.id, message: task.message, verifiedAt: task.verifiedAt || null }
        : { status: current.xhsDelivery.attempted ? 'unknown' : 'blocked', reason: 'delivery_error', message: this.safe(error.message) });
    }).finally(() => this.active.delete(id));
    this.tail = work;
  }
  async enqueue(id, { manual = false, accountId } = {}) {
    if (this.closed) fail('自动送稿队列已关闭', 503);
    if (this.active.has(id)) {
      const current = this.view(await this.store.get(id));
      if (manual && UNCERTAIN.has(current.xhsDelivery?.status)) fail('暂存结果待核对，不能重复送出，请先检查电脑草稿');
      if (manual && ['failed', 'blocked', 'interrupted'].includes(current.xhsDelivery?.status)) fail('上次送稿正在完成记录，请稍后继续', 409);
      return current;
    }
    this.active.add(id);
    try {
      let project = await this.store.get(id); if (!project?.xhsDelivery?.enabled) fail('这份作品没有开启自动草稿交付，请使用作品的手动送稿入口');
      project = this.view(project); const d = project.xhsDelivery;
      if (d.status === 'verified') { this.active.delete(id); return project; }
      if (UNCERTAIN.has(d.status)) fail('这份稿件已经填写或暂存结果待核对，请先检查电脑端草稿，不能重复送出');
      if (manual) {
        const current = this.accountState(accountId);
        if (!accountId || accountId !== current.account?.id || !bound(current)) fail('请先绑定本次送稿的小红书账号');
        if (d.accountId && d.accountId !== accountId) fail('本次创作绑定的账号与当前账号不同，不能改投其他账号');
        if (!resumable(d, this.task(project)) && d.status !== 'waiting_generation') fail('这份草稿目前不能继续重传，请先核对实际状态');
        d.accountId = accountId; d.accountName = current.account.nickname;
        d.draftId = null; d.fingerprint = null; d.attempted = false;
      } else if (d.status !== 'waiting_generation') fail('这份作品已经进入过送稿流程，不会自动重复交付');
      if (!complete(project)) fail('请先完成全部图片，再继续送入草稿');
      project.xhsDelivery = { ...d, status: 'queued', reason: '', message: '图文已完成，正在等待自动送入电脑草稿。', updatedAt: new Date().toISOString() };
      await this.store.save(project);
      this.schedule(id); return this.view(project);
    } catch (error) { this.active.delete(id); throw error; }
  }
  async idle(deadline, accountId) {
    while (this.accountState(accountId).status.busy) {
      if (this.closed) fail('送稿已中断，请先核对电脑草稿');
      if (Date.now() > deadline) fail('小红书浏览器仍在处理其他任务，图文已保留，请稍后继续送稿');
      await this.wait(100);
    }
  }
  async run(id) {
    const deadline = Date.now() + this.maxWaitMs;
    while (this.modelBusy(id)) { if (this.closed || Date.now() > deadline) fail('创作任务尚未结束，图文已保留，请稍后继续送稿'); await this.wait(50); }
    let project = await this.store.get(id); if (!project) return;
    const expected = project.xhsDelivery.accountId;
    await this.idle(deadline, expected);
    let state = this.accountState(expected);
    if (!expected || state.account?.id !== expected) fail('目标小红书账号已断开或变化，图文已保留，未改投其他账号');
    if (state.connection.state !== 'connected') {
      await this.update(id, { status: 'preparing', message: '正在检查已绑定账号的登录会话；有效后会自动继续送稿，无需手动检查连接。' });
      await this.admit(async () => { if (!this.accountState(expected).status.busy) await this.xhs.checkLogin({ accountId: expected }); });
      await this.idle(deadline, expected); state = this.accountState(expected);
    }
    if (state.account?.id !== expected || state.connection.state !== 'connected') fail(state.connection.message || '已绑定账号的登录会话已失效或需要验证。图文已保留，请重新扫码后再送稿');
    await this.update(id, { status: 'preparing', message: '正在核对目标账号、文案和图片，随后自动保存电脑草稿。' });
    const payload = await this.prepare({ projectId: id, accountId: expected }, { allowDeliveryJob: true });
    project = await this.store.get(id);
    const d = project.xhsDelivery;
    const previous = historyOf(d).find(item => item.accountId === expected && item.fingerprint === payload.fingerprint);
    const version = previous?.version || d.version || 1;
    await this.update(id, { fingerprint: payload.fingerprint, contentSignature: contentSignature(project), version,
      history: historyOf(d).filter(item => !(item.accountId === expected && item.fingerprint === payload.fingerprint)), pendingVersion: false, previousVersion: null });
    let result;
    for (;;) {
      await this.idle(deadline, expected);
      state = this.accountState(expected);
      if (state.account?.id !== expected || state.connection.state !== 'connected') fail('送稿前目标账号已变化或失联，图文已保留，未改投其他账号');
      try {
        result = await this.admit(async () => {
          const current = this.accountState(expected);
          if (current.status.busy) fail('浏览器忙，请等待', 429);
          if (current.account?.id !== expected || current.connection.state !== 'connected') fail('目标小红书账号已经变化，请核对后继续');
          const old = current.drafts.find(draft => draft.projectId === id && draft.accountId === expected && draft.fingerprint === payload.fingerprint)
            || (previous?.status === 'verified' ? { ...previous, id: previous.draftId } : null);
          await this.update(id, { attempted: true });
          if (old && old.status !== 'failed') return { draft: old, duplicate: true };
          return old?.status === 'failed' && old.canRetry ? this.xhs.retryDraft(old.id, { accountId: expected }) : this.xhs.submitDraft(payload);
        });
        break;
      } catch (error) {
        if ((error.status === 409 || error.status === 429) && this.accountState(expected).status.busy && this.accountState(expected).account?.id === expected && Date.now() <= deadline) continue;
        throw error;
      }
    }
    await this.update(id, { draftId: result.draft.id, status: result.draft.status, message: result.draft.message, fingerprint: payload.fingerprint });
    if (result.duplicate && result.draft.status === 'verified') {
      await this.update(id, { verifiedAt: result.draft.verifiedAt || null });
      return;
    }
    await this.idle(deadline, expected);
    project = await this.store.get(id);
    const task = this.task(project);
    if (task) await this.update(id, { status: task.status, message: task.message, verifiedAt: task.verifiedAt || null });
    else await this.update(id, { status: 'unknown', message: '任务已经受理，但当前无法核对草稿结果，请先查看电脑草稿，不会自动重传。' });
  }
  stop() { this.closed = true; }
}
