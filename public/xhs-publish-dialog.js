import { xhsCopyProblem } from './publishing-platform.js';

const pendingJob = status => ['queued', 'running'].includes(status);
const repeatableSchedule = status => ['failed', 'canceled'].includes(status);
const scheduleLabels = {
  queued: '预约已入队', running: '正在核验预约', scheduled: '已预约发布',
  unknown: '预约结果待确认', failed: '预约失败', canceled: '预约已取消', needs_attention: '预约需人工核对',
};
const beijingTime = value => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value));

export async function openXhsPublishDialog(project, { api, h, initialAccountId = '', officialDraftId = '' }) {
  if (document.querySelector('#xhs-publish-dialog')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'xhs-publish-dialog';
  dialog.className = 'xhs-detail-dialog xhs-publish-dialog';
  dialog.setAttribute('aria-labelledby', 'publish-heading');
  document.body.append(dialog);
  const images = project?.pages.map(page => page.imageUrl) ?? [];
  const original = { title: (project?.title||'').trim(), content: (project?.caption||'').trim() };
  dialog.innerHTML = `<header class="xhs-detail-heading"><div><h2 id="publish-heading">发送到小红书</h2><small id="publish-work-caption">作品 · ${h(original.title)} · ${images.length} 张配图</small></div><button type="button" class="button button-secondary" data-publish="close">关闭</button></header>
    <div class="publish-body"><label for="publish-account">目标账号</label><select id="publish-account" disabled><option>正在读取账号…</option></select>
    <label for="publish-version" hidden>送稿版本</label><select id="publish-version" hidden></select>
    <details class="publish-copy"><summary>检查标题、正文和配图</summary>
      <label for="publish-title">帖子标题</label><input id="publish-title" value="${h(original.title)}">
      <label for="publish-content">帖子正文</label><textarea id="publish-content" rows="5">${h(original.content)}</textarea>
      <div class="publish-images">${images.map((url,i)=>`<img src="${h(url)}" alt="第 ${i+1} 张配图">`).join('')}</div><small id="publish-image-notice" hidden></small>
    </details><div class="publish-progress" aria-live="polite"></div></div>`;
  const select = dialog.querySelector('#publish-account');
  const versionSelect = dialog.querySelector('#publish-version');
  const titleInput = dialog.querySelector('#publish-title');
  const contentInput = dialog.querySelector('#publish-content');
  const region = dialog.querySelector('.publish-progress');
  const copy = () => ({title:titleInput.value.trim(),content:contentInput.value.trim()});
  let accounts = [], row = null, receipt = null, schedule = null, scheduledAt = '', serviceDraft = null;
  let versions = [], selectedVersion = '', currentCopy = {...original}, rescheduling = false;
  let snapshot = null, confirmation = null, stage = 'loading', error = '', timer, generation = 0;
  const active = token => dialog.open && token === generation;
  const identity = item => [item.nickname || item.accountId, item.platformAccountId || item.accountId].join(' · ');
  const allowed = () => row && row.enabled !== false && row.paused !== true;
  const writing = () => ['sending', 'scheduling'].includes(stage);
  const scheduleTarget = () => serviceDraft ? {draftId:serviceDraft.id} : {receiptId:receipt.id};
  const scheduleMatches = result => result?.accountId===row.accountId
    && (serviceDraft ? result.draftId===serviceDraft.id : result.receiptId===receipt.id);
  const serviceReady = () => !serviceDraft || (serviceDraft.phase==='ready' && serviceDraft.platformStatus==='draft_verified' && !serviceDraft.pendingUpdate);
  const button = (action, text, primary=false, disabled=false) =>
    `<button type="button" data-publish="${action}" class="button ${primary?'button-primary':'button-secondary'}" ${disabled?'disabled':''}>${h(text)}</button>`;
  function displayCopy(text, urls, frozen = false) {
    titleInput.value=text.title; contentInput.value=text.content;
    dialog.querySelector('#publish-work-caption').textContent=(frozen?'已送草稿 · ':'作品 · ')+text.title+' · '+urls.length+' 张可预览配图';
    const notice=dialog.querySelector('#publish-image-notice');
    notice.hidden=!frozen||text.isComplete!==false;
    notice.textContent=notice.hidden?'':text.message||'部分送稿时的原图已无法在本机预览。';
    dialog.querySelector('.publish-images').innerHTML=urls.map((url,i)=>
      `<img src="${h(url)}" alt="第 ${i+1} 张配图">`).join('');
  }
  function render() {
    select.disabled = Boolean(officialDraftId) || !accounts.length || writing();
    versionSelect.hidden = dialog.querySelector('label[for="publish-version"]').hidden = !versions.length;
    versionSelect.disabled = writing() || stage==='loading';
    versionSelect.innerHTML='<option value="">当前作品版本</option>'+versions.map(item=>{
      const time=item.createdAt&&Number.isFinite(Date.parse(item.createdAt))?beijingTime(item.createdAt)+' · ':'';
      return `<option value="${h(item.id)}">${h(time+item.title)}${item.status==='verified'?'（已核验）':''}</option>`;
    }).join('');
    versionSelect.value=selectedVersion;
    const locked = stage === 'loading' || writing() || Boolean(receipt);
    titleInput.disabled = contentInput.disabled = locked;
    let html = '';
    if (error) html += `<p role="alert" class="publish-error">${h(error)}</p>`;
    if (stage === 'loading') html += '<p role="status">正在读取…</p>';
    else if (stage === 'error') html += button('refresh','重新读取');
    else if (!row) html += accounts.length?'':'<p>发布服务中还没有可选账号。</p>';
    else if (writing()) html += `<p role="status">${stage==='sending'?'正在将图文送入所选账号的草稿箱…':'正在提交已确认的预约…'}</p>`;
    else if (!receipt) {
      const problem = xhsCopyProblem(copy().title, copy().content) || (!copy().title || !copy().content ? '请补全帖子标题和正文。' : '');
      const hint = !allowed()?'账号已停用或暂停，暂时无法送稿。':snapshot?.deliveryConfiguration?.configured===false&&!snapshot.deliveryConfiguration.canPreflight?snapshot.deliveryConfiguration.message:problem;
      if (hint) html += `<p>${h(hint)}</p>`;
      html += button('draft','存入所选账号草稿箱',true,Boolean(hint));
      if (allowed() && snapshot?.deliveryConfiguration?.configured === false && !snapshot.deliveryConfiguration.canPreflight) html += button('check','检查送稿服务');
    } else {
      const reviewed = serviceDraft || receipt;
      const draftVersion = Number.isInteger(reviewed.contentVersion) ? ` · 第 ${reviewed.contentVersion} 版` : '';
      html += `<p><strong>${serviceDraft?'服务草稿'+draftVersion:receipt.status==='verified'?'草稿已核验'+draftVersion:'草稿核验进度'}</strong></p>`;
      if(serviceDraft && !officialDraftId && receipt.contentHash!==serviceDraft.contentHash) html+='<p>这份草稿送达后有过修改。请核对上方最新图文，再确认预约。</p>';
      if (receipt.status !== 'verified') {
        html += `<p>${h(receipt.message||'草稿已受理，正在等候核验。')}</p>`;
        html += button(receipt.canRecheck?'recheck':receipt.canRetry?'retry':'refresh',receipt.canRecheck?'核对原草稿':receipt.canRetry?'重试原草稿':'刷新进度');
      } else if (confirmation) {
        html += `<div class="publish-confirm"><strong>确认这次定时发布</strong><dl><div><dt>账号</dt><dd>${h(identity(row))}</dd></div><div><dt>帖子</dt><dd>${h(reviewed.title)}${h(draftVersion)}</dd></div><div><dt>北京时间</dt><dd>${h(beijingTime(confirmation))}</dd></div></dl></div>`;
        html += button('back','返回')+button('confirm',schedule?.canRecover?'确认找回原预约':'确认定时发布',true);
      } else if (schedule && !rescheduling) {
        html += `<p><strong>${h(scheduleLabels[schedule.status]||'预约状态待确认')}</strong>${schedule.scheduledAt?' · 北京时间 '+h(beijingTime(schedule.scheduledAt)):''}</p><p>${h(schedule.message||'')}</p>`;
        html += button('refresh','刷新预约状态');
        if (repeatableSchedule(schedule.status) && serviceReady() && allowed() && row.publishEnabled) html += button('reschedule','重新选择时间');
        if (schedule.canRecover) html += button('recover','找回原预约',false,!allowed()||!row.publishEnabled);
      } else if (!serviceReady()) {
        html += `<p>${serviceDraft.phase==='scheduled'?'这份服务草稿已预约。':serviceDraft.pendingUpdate?'草稿修改正在处理，完成核验后可预约新版。':'当前草稿尚未就绪，请刷新核验状态。'}</p>`+button('refresh','刷新状态');
      } else if (!allowed() || !row.publishEnabled) {
        html += `<p>${!allowed()?'账号已停用或暂停。':'该账号未开启预约发布。'}草稿已保留。</p>`+button('refresh','刷新状态');
      } else {
        if(rescheduling)html+=`<p>原预约 · ${h(scheduleLabels[schedule.status])} · ${h(beijingTime(schedule.scheduledAt))}</p>`;
        html += `<label for="publish-time">定时发布时间（北京时间）</label><input id="publish-time" type="datetime-local" step="60" value="${h(scheduledAt)}"><small>可选未来 14 天内的时间，通常需提前 65 分钟。</small>`+button('preview','核对发布时间',true);
      }
    }
    region.innerHTML=html;
  }
  function fail(token, e) {
    if (!active(token)) return;
    stage='error'; error=e.message || '暂时无法读取，请重试。'; confirmation=null; render();
  }
  function poll() {
    clearTimeout(timer);
    if (pendingJob(receipt?.status) || pendingJob(schedule?.status)) timer=setTimeout(()=>readAccount(false),5000);
  }
  async function lookupSchedule(token) {
    if (receipt?.status!=='verified') return;
    const remoteId=officialDraftId || receipt.remoteDraftId;
    if(remoteId){
      const {detail}=await api('/api/xhs/official-drafts/'+encodeURIComponent(remoteId)+'?'+new URLSearchParams({accountId:row.accountId}));
      if(!active(token))return;
      if(detail?.id!==remoteId || detail.accountId!==row.accountId || !Number.isInteger(detail.contentVersion)
        || !/^[a-f0-9]{64}$/.test(detail.contentHash) || typeof detail.title!=='string' || typeof detail.content!=='string' || !Array.isArray(detail.images))
        throw Error('暂时无法核对服务草稿的账号与当前版本，请重新读取。');
      serviceDraft=detail;
      displayCopy(detail,detail.images,true);
      if(officialDraftId || receipt.contentHash!==detail.contentHash) dialog.querySelector('.publish-copy').open=true;
    }
    const data=await api('/api/xhs/schedules?'+new URLSearchParams({accountId:row.accountId,...scheduleTarget()}));
    if (!active(token)) return;
    if (data.schedule && !scheduleMatches(data.schedule)) throw Error('预约记录与所选账号或草稿不一致。');
    schedule=data.schedule??null;
  }
  async function readAccount(findMatching=true, versionId='') {
    clearTimeout(timer);
    const token=++generation, accountId=select.value;
    row=accounts.find(item=>item.accountId===accountId)||null; confirmation=null; error='';
    if (findMatching) {
      receipt=null;schedule=null;serviceDraft=null;scheduledAt='';rescheduling=false;versions=[];selectedVersion=versionId;
      displayCopy(currentCopy,images);
    }
    if (!row) {stage='ready';render();return;}
    stage='loading';render();
    try {
      if(officialDraftId){
        receipt={status:'verified',remoteDraftId:officialDraftId};
        await lookupSchedule(token);
        if(active(token)){stage='ready';render();poll();}
        return;
      }
      const data=await api('/api/xhs?'+new URLSearchParams({accountId}));
      if (!active(token)) return;
      if (data.account?.id!==accountId || !Array.isArray(data.drafts)) throw Error('服务返回的草稿账号与所选账号不一致。');
      snapshot=data;
      const mine=data.drafts.filter(d=>d.accountId===accountId && d.projectId===project.id);
      versions=mine;
      if (versionId) {
        const candidate=mine.find(d=>d.id===versionId);
        if(!candidate)throw Error('这份送稿记录已不在所选账号下。');
        const {detail}=await api('/api/xhs/submissions/'+encodeURIComponent(versionId)+'?'+new URLSearchParams({accountId}));
        if(!active(token))return;
        if(detail?.id!==versionId || detail.accountId!==accountId || detail.projectId!==project.id ||
            detail.title!==candidate.title || typeof detail.content!=='string' || !Array.isArray(detail.images))throw Error('冻结稿内容与所选回执不一致。');
        displayCopy(detail,detail.images,true);
        dialog.querySelector('.publish-copy').open=true;
        receipt=candidate;
      } else if (receipt) {
        const updated=mine.find(d=>d.id===receipt.id);
        if (!updated) throw Error('未找到本次送稿回执，请重新核对账号。');
        receipt=updated;
      } else {
        const {title,content}=copy();
        for (const candidate of mine.filter(d=>d.title===title)) {
          const {detail}=await api('/api/xhs/submissions/'+encodeURIComponent(candidate.id)+'?'+new URLSearchParams({accountId}));
          if (!active(token)) return;
          if (detail?.id===candidate.id && detail.accountId===accountId && detail.projectId===project.id &&
              detail.title===title && detail.content===content && Array.isArray(detail.images) &&
              detail.images.length===images.length && detail.images.every((url,i)=>url===images[i])) {receipt=candidate;break;}
        }
      }
      await lookupSchedule(token);
      if (!active(token)) return;
      if(!repeatableSchedule(schedule?.status))rescheduling=false;
      stage='ready';render();poll();
    } catch(e){fail(token,e);}
  }
  async function loadAccounts() {
    const token=++generation; clearTimeout(timer);stage='loading';error='';render();
    try {
      const data=await api('/api/xhs/accounts');
      if (!active(token)) return;
      if (!Array.isArray(data.accounts)) throw Error('账号列表格式无效。');
      accounts=data.accounts;
      const previous=select.value||initialAccountId;
      select.innerHTML='<option value="">请选择小红书账号</option>'+accounts.map(item=>
        `<option value="${h(item.accountId)}">${h(identity(item))}${item.enabled===false?'（已停用）':item.paused?'（已暂停）':''}</option>`).join('');
      if(officialDraftId && !accounts.some(a=>a.accountId===initialAccountId))throw Error('这份草稿所属的账号已不可用。');
      select.value=officialDraftId?initialAccountId:accounts.some(a=>a.accountId===previous)?previous:accounts.length===1?accounts[0].accountId:'';
      await readAccount(!receipt || receipt.accountId!==select.value,receipt?.accountId===select.value?selectedVersion:'');
    } catch(e){fail(token,e);}
  }
  async function write(action) {
    const token=++generation,accountId=row.accountId;
    const binding=row.platformAccountId?{expectedPlatformAccountId:row.platformAccountId}:{};
    clearTimeout(timer);error='';
    const priorReceipt=receipt;
    try {
      if (action==='check') {
        stage='loading';render();await api('/api/xhs/check',{method:'POST',body:{accountId}});
      } else if (action==='draft' || action==='recheck' || action==='retry') {
        if (action!=='recheck' && !allowed()) return;
        stage='sending';render();
        const {title,content}=copy();
        const result=action==='draft'
          ?await api('/api/xhs/drafts',{method:'POST',body:{projectId:project.id,accountId,...binding,title,content}})
          :await api('/api/xhs/drafts/'+encodeURIComponent(priorReceipt.id)+'/'+action,{method:'POST',body:{accountId}});
        if (!active(token)) return;
        const item=result.draft ?? result.snapshot?.drafts?.find(d=>d.id===priorReceipt?.id) ?? result.drafts?.find(d=>d.id===priorReceipt?.id);
        if (!item?.id || item.accountId!==accountId || item.projectId!==project.id || (priorReceipt && item.id!==priorReceipt.id)) throw Error('送稿回执与所选账号或作品不一致。');
        receipt=item;
      } else if (action==='confirm') {
        const reviewed=serviceDraft || receipt;
        if (!allowed() || !row.publishEnabled || !confirmation || receipt?.status!=='verified' || !reviewed.contentHash || !reviewed.contentVersion || !serviceReady()) throw Error('请重新核对已验证的草稿版本和目标账号。');
        const at=confirmation;
        confirmation=null;rescheduling=false;stage='scheduling';render();
        const result=await api('/api/xhs/schedules',{method:'POST',body:{accountId,...binding,...scheduleTarget(),scheduledAt:at,confirmed:true,
          expectedContentVersion:reviewed.contentVersion,expectedContentHash:reviewed.contentHash}});
        if (!active(token)) return;
        if (!scheduleMatches(result.schedule)) throw Error('预约回执与所选账号或草稿不一致。');
        schedule=result.schedule;
      }
      if(active(token))await readAccount(false);
    } catch(e){fail(token,e);}
  }
  select.addEventListener('change',()=>readAccount());
  versionSelect.addEventListener('change',()=>readAccount(true,versionSelect.value));
  for(const field of [titleInput,contentInput]){
    field.addEventListener('input',()=>{if(!receipt&&stage==='ready'){currentCopy=copy();error='';render();}});
  }
  region.addEventListener('input',event=>{if(event.target.id==='publish-time')scheduledAt=event.target.value;});
  dialog.addEventListener('click',event=>{
    const target=event.target.closest('[data-publish]');if(!target||target.disabled)return;
    const action=target.dataset.publish;
    if(action==='close'){dialog.close();return;}
    if(writing())return;
    if(action==='refresh'){void loadAccounts();return;}
    if(!row||stage!=='ready')return;
    if(action==='reschedule' && repeatableSchedule(schedule?.status)){rescheduling=true;scheduledAt='';render();region.querySelector('#publish-time')?.focus();return;}
    if(action==='preview'){
      const at=scheduledAt?Date.parse(scheduledAt+':00+08:00'):NaN;
      if(!Number.isFinite(at)||at<=Date.now()||at>Date.now()+14*86400000){error='请选择未来 14 天内的北京时间。';render();region.querySelector('#publish-time')?.focus();return;}
      error='';confirmation=new Date(at).toISOString();render();region.querySelector('[data-publish="confirm"]')?.focus();return;
    }
    if(action==='recover' && schedule?.canRecover){confirmation=schedule.scheduledAt;render();return;}
    if(action==='back'){confirmation=null;render();return;}
    void write(action);
  });
  dialog.addEventListener('close',()=>{++generation;clearTimeout(timer);dialog.remove();},{once:true});
  dialog.showModal();
  if(xhsCopyProblem(original.title,original.content))dialog.querySelector('.publish-copy').open=true;
  await loadAccounts();
}
