import { createHash } from 'node:crypto';
import { xhsCopyProblem } from '../public/publishing-platform.js';

const draftIdPattern = /^draft_[a-f0-9]{32}$/;
const jobIdPattern = /^job_[a-f0-9]{32}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const validVersion = version => Number.isInteger(version) && version >= 1 && version <= 10000;

function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status });
}

function imageUrls(draftId, accountId, version, images) {
  if (!validVersion(version) || !Array.isArray(images)) return [];
  const query = new URLSearchParams({ accountId, contentVersion: String(version) });
  return images.flatMap((image, index) => {
    const position = index + 1;
    if (position > 18 || image?.position !== position || !image.url) return [];
    return ['/api/xhs/official-drafts/' + draftId + '/images/' + position + '?' + query];
  });
}

export function draftVersionDetails(item, accountId) {
  const version = validVersion(item.content_version) ? item.content_version : null;
  const hash = typeof item.content_hash === 'string' && hashPattern.test(item.content_hash) ? item.content_hash : null;
  const pending = item.pending_update;
  const pendingUpdate = pending ? { contentVersion: pending.content_version, title: pending.title, content: pending.caption,
    imageCount: pending.image_count, imagesChanged: pending.images_changed === true } : null;
  const versions = (Array.isArray(item.versions) ? item.versions : []).filter(v => validVersion(v?.content_version) && v.content_version < version).map(v => ({
    contentVersion: v.content_version, title: v.title, content: v.caption,
    images: imageUrls(item.draft_id, accountId, v.content_version, v.images), archivedAt: v.archived_at,
  }));
  return {
    contentVersion: version, contentHash: hash, pendingUpdate, versions,
    activeJobId: jobIdPattern.test(item.active_job_id) ? item.active_job_id : null,
    editable: Boolean(item.editable === true && item.phase === 'ready' && item.platform_status === 'draft_verified'
      && item.pending_update === null && version && hash),
    editBlockReason: item.edit_block_reason === 'HISTORY_LIMIT' ? '已达到草稿历史版本或操作上限。' : '',
    images: imageUrls(item.draft_id, accountId, version, item.images),
  };
}

export async function editPublisherDraft(account, draftId, input, prepareProjectImages) {
  account.target({ accountId: input?.accountId });
  if (!draftIdPattern.test(draftId) || input?.accountId !== account.accountId || input.confirmed !== true
      || !validVersion(input.contentVersion) || typeof input.expectedContentHash !== 'string' || !hashPattern.test(input.expectedContentHash)) {
    fail('请重新读取草稿，核对要修改的账号和版本后确认。', 400);
  }
  const changes = input.changes;
  if (!changes || Array.isArray(changes) || typeof changes !== 'object' || (!Object.keys(changes).length && !input.imageProject)
      || Object.keys(changes).some(k => !['title', 'caption', 'image_urls'].includes(k))) fail('请选择要修改的标题、正文或配图。', 400);
  if (input.imageProject && (!prepareProjectImages || Object.hasOwn(changes, 'image_urls') ||
      typeof input.imageProject.id !== 'string' || !Array.isArray(input.imageProject.images) ||
      input.imageProject.images.length < 1 || input.imageProject.images.length > 18)) fail('请选择一份已完成的作品作为配图来源。', 400);
  const content = {};
  for (const key of ['title', 'caption']) {
    if (!Object.hasOwn(changes, key)) continue;
    if (typeof changes[key] !== 'string' || !changes[key].trim()) fail('修改后的标题和正文需要有内容。', 400);
    content[key] = changes[key].trim();
  }
  const copyError = xhsCopyProblem(content.title, content.caption);
  if (copyError) fail(copyError, 400);
  if (Object.hasOwn(changes, 'image_urls')) {
    const urls = changes.image_urls;
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > 18) fail('替换配图需要 1 到 18 条图片链接。', 400);
    content.image_urls = urls.map(value => {
      let url;
      if (typeof value === 'string' && value.length <= 4096) {
        try { url = new URL(value); } catch {}
      }
      if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
        fail('请使用发布服务可访问的 HTTP(S) 图片链接。', 400);
      }
      return value.trim();
    });
  }
  // Editing existing text and remotely hosted images does not require the workspace LAN image server.
  const identity = input.imageProject
    ? await account.preflight({ accountId: input.accountId, expectedPlatformAccountId: input.expectedPlatformAccountId })
    : await account.ensureReady({ accountId: input.accountId });
  if (identity !== (input.expectedPlatformAccountId ?? null)) fail('账号绑定已变化，请重新选择草稿。');
  const path = '/v1/drafts/' + draftId;
  const draft = await account.client.request(path + '?' + new URLSearchParams({ account_id: input.accountId }));
  if (draft?.draft_id !== draftId || draft.account_id !== input.accountId || draft.content_version !== input.contentVersion
      || draft.content_hash !== input.expectedContentHash) fail('草稿或其版本已变化，请重新读取后编辑。');
  if (!draftVersionDetails(draft, input.accountId).editable) fail('当前草稿状态不允许修改，请刷新查看任务进度。');
  if (input.imageProject) content.image_urls = await prepareProjectImages(draft);
  if (!content.image_urls && (!content.title || content.title === draft.title) && (!content.caption || content.caption === draft.caption)) {
    fail('标题和正文没有变化。', 400);
  }
  const body = { account_id: input.accountId, content_version: input.contentVersion, content };
  const digest = createHash('sha256').update(JSON.stringify([draftId, identity, input.expectedContentHash, body])).digest('hex');
  const job = await account.client.request(path, { method: 'PATCH', body, idempotencyKey: 'content-studio:update:' + digest });
  if (!jobIdPattern.test(job?.job_id) || job.action !== 'update_draft' || job.draft_id !== draftId
      || job.account_id !== input.accountId || job.base_version !== input.contentVersion || job.content_version !== input.contentVersion + 1) {
    fail('修改回执尚未核对，请重新读取原草稿。', 502);
  }
  return { accountId: input.accountId, draftId, jobId: job.job_id, contentVersion: job.content_version, status: job.status };
}
