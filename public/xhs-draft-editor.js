import { xhsCopyProblem } from './publishing-platform.js';

export function editXhsDraft({ draft, account, projects = [], api, h, finished, isCurrent }) {
  if (!draft.editable || document.querySelector('#xhs-draft-editor')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'xhs-draft-editor';
  dialog.className = 'xhs-detail-dialog';
  dialog.setAttribute('aria-labelledby', 'draft-edit-title');
  dialog.innerHTML = `<header class="xhs-detail-heading"><div><span class="xhs-detail-source">${h(account.nickname || account.id)} · 第 ${h(draft.contentVersion)} 版</span><h2 id="draft-edit-title">修改草稿</h2></div>
    <button type="button" class="button button-secondary" data-close>关闭</button></header>
    <form class="publish-body"><label for="draft-edit-post-title">标题</label><input id="draft-edit-post-title" value="${h(draft.title)}" required>
    <label for="draft-edit-caption">正文</label><textarea id="draft-edit-caption" rows="7" required>${h(draft.content)}</textarea>
    <label for="draft-edit-image-source">配图</label><select id="draft-edit-image-source"><option value="keep">沿用当前 ${h(draft.imageCount)} 张</option>
    ${projects.length?'<option value="project">使用作品记录中的配图</option>':''}<option value="urls">填写图片链接</option></select>
    <div id="draft-edit-project-region" hidden><label for="draft-edit-project">选择配图作品</label><select id="draft-edit-project"><option value="">请选择作品</option>
    ${projects.map(p=>`<option value="${h(p.id)}">${h(p.title)} · ${p.pages.length} 张</option>`).join('')}</select><div class="publish-images" id="draft-edit-preview"></div></div>
    <div class="draft-edit-replacements" hidden><label for="draft-edit-images">按发布顺序填写全部图片链接，每行一条</label><textarea id="draft-edit-images" rows="4"></textarea></div>
    <p class="xhs-inline-error" role="alert" hidden></p><div><button type="submit" class="button button-primary">确认修改这份草稿</button>
    <button type="button" data-reload class="button button-secondary" hidden>重新读取原草稿</button></div></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const submit = form.querySelector('[type=submit]');
  const source = form.querySelector('#draft-edit-image-source');
  const projectSelect = form.querySelector('#draft-edit-project');
  const errorBox = form.querySelector('[role=alert]');
  const reload = form.querySelector('[data-reload]');
  const close = dialog.querySelector('[data-close]');
  let busy = false;
  function dismiss() { dialog.close(); }
  close.onclick = dismiss;
  reload.onclick = () => { dismiss(); if (isCurrent()) finished(); };
  source.onchange = () => {
    form.querySelector('.draft-edit-replacements').hidden = source.value !== 'urls';
    form.querySelector('#draft-edit-project-region').hidden = source.value !== 'project';
  };
  projectSelect.onchange = () => {
    const project = projects.find(p => p.id === projectSelect.value);
    form.querySelector('#draft-edit-preview').innerHTML = (project?.pages || []).map((p,i) => `<img src="${h(p.imageUrl)}" alt="配图 ${i+1}">`).join('');
  };
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || submit.disabled || !isCurrent()) return;
    const title = form.querySelector('#draft-edit-post-title').value.trim();
    const caption = form.querySelector('#draft-edit-caption').value.trim();
    const changes = {};
    if (title !== draft.title) changes.title = title;
    if (caption !== draft.content) changes.caption = caption;
    const selected = source.value === 'project' ? projects.find(p => p.id === projectSelect.value) : null;
    const imageProject = selected && { id: selected.id, images: selected.pages.map(p => p.imageUrl) };
    if (source.value === 'urls') changes.image_urls = form.querySelector('#draft-edit-images').value.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    const issue = !title || !caption ? '标题和正文都需要填写。' : xhsCopyProblem(title, caption)
      || (source.value === 'project' && !imageProject ? '请选择一份作品以替换配图。' : '')
      || (!Object.keys(changes).length && !imageProject ? '还没有修改内容。' : '')
      || (source.value === 'urls' && (changes.image_urls.length < 1 || changes.image_urls.length > 18) ? '请输入 1 到 18 条图片链接。' : '');
    errorBox.hidden = !issue;
    errorBox.textContent = issue;
    if (issue) return;
    busy = true;
    submit.disabled = true;
    submit.textContent = '正在提交…';
    try {
      const receipt = await api('/api/xhs/official-drafts/' + draft.id, { method: 'PATCH', body: {
        accountId: account.id, expectedPlatformAccountId: account.platformAccountId ?? null,
        ...(imageProject ? { imageProject } : {}), contentVersion: draft.contentVersion, expectedContentHash: draft.contentHash, changes, confirmed: true,
      } });
      if (receipt.accountId !== account.id || receipt.draftId !== draft.id || receipt.contentVersion !== draft.contentVersion + 1
        || !/^job_[a-f0-9]{32}$/.test(receipt.jobId)) throw Error('修改回执与所选草稿不一致。');
      if (dialog.open) dismiss();
      if (isCurrent()) finished(receipt);
    } catch (error) {
      if (!dialog.open || !isCurrent()) return;
      errorBox.hidden = false; errorBox.textContent = error.message;
      const needsRead = ![400, 422].includes(error.status);
      reload.hidden = !needsRead; submit.disabled = needsRead;
    } finally {
      busy = false; submit.textContent = '确认修改这份草稿';
    }
  };
  dialog.showModal();
}
