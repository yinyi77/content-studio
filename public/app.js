import { formatImageDimensions, imageSizeOptions, requestedImageSize } from './image-specs.js';
import { editXhsDraft } from './xhs-draft-editor.js';
import { openXhsPublishDialog } from './xhs-publish-dialog.js';
import { createAccountMetrics } from './xhs-account-metrics.js';
import { projectPlatform, xhsCopyProblem } from './publishing-platform.js';
import { IMAGE_STYLES, STYLE_CATEGORIES } from './style-catalog.js';

const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const lightbox = document.querySelector('#lightbox');
const GUIDE_STORAGE_KEY = 'content-studio:briefing:v1';
const EMBEDDED_MODE = new URLSearchParams(location.search).get('embedded')==='1' && window.parent!==window;
const XHS_ACCOUNT_TABS = {overview:'账号数据',published:'已发布内容',drafts:'草稿箱'};
function xhsAccountRoute(accountId,tab) {
  return {accountId:typeof accountId==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(accountId)?accountId:'',
    tab:Object.hasOwn(XHS_ACCOUNT_TABS,tab)?tab:'overview'};
}
function readXhsRoute() {
  const params=new URLSearchParams(location.search);
  return xhsAccountRoute(params.get('accountId'),params.get('tab'));
}
if(EMBEDDED_MODE)document.documentElement.classList.add('legacy-embedded');
let lastEmbeddedView='';
let embeddedNavigationVersion=0;
let embeddedParentNavigationDepth=0;
const GUIDE_STYLES = IMAGE_STYLES;
const GUIDE_IMAGE_LIMIT = 4;
const GUIDE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const state = {
  view: ['trends','radar','xhs','dingtalk','history','settings'].includes(new URLSearchParams(location.search).get('view')) ? new URLSearchParams(location.search).get('view') : 'briefing', config: null, projects: [],
  busy: '', search: '', filter: 'all', adminMenuOpen: false,
  adminSidebarCollapsed: restoreAdminSidebar(), adminVisited: restoreAdminVisited(),
  settingsTab: 'text', settingsDraft: null, settingsDirty: false, settingsRevision: 0,
  historyLayout: 'table', historyPage: 1, historyPageSize: 12, historySort: 'updated', historyReloading: false,
  models: { text: [], image: [] }, testResults: {}, bootError: '',
  guide: restoreGuidance(), guideBusy: false, guideEdit: null, guideProject: null, guideActionBusy: '',
  guideStyleCategory: 'all', guideStyleSearch: '', guideHistorySearch: '', guideDeliverySettingsOpen: false,
  guideUploadBusy: false,
  trends: null, trendsError: '', trendsLoading: false, trendsBusy: '', trendsSettingsOpen: false, trendsSourcesOpen: false,
  trendPlatform: 'all', trendSearch: '', trendScope: 'all', trendLimit: 24, trendKeywordsDraft: '', trendKeywordsDirty: false, trendIntervalDraft: null,
  radar: null, radarLoading: false, radarError: '', radarBusy: '', radarFilter: 'pending', radarReferences: [], radarUploadBusy: false,
  radarMaterialReferences: {}, radarSkipDrafts: {}, radarNotificationBusy: '',
  xhsDefault: null, xhsScoped: null,
  get xhs() {
    const selected=this.view==='xhs'&&this.xhsRoute.accountId;
    return selected&&this.xhsScoped?.account?.id===selected?this.xhsScoped:this.xhsDefault;
  },
  xhsLoading: false, xhsError: '', xhsBusy: '', xhsProjectId: '', xhsPreview: null,
  xhsDetail: null, xhsPublished: null,
  xhsRoute:readXhsRoute(), xhsAccounts:null, xhsAccountsLoading:false, xhsAccountsError:'', xhsFetchedAt:null, xhsAccountSearch:'',
  xhsDraftSearch: '', xhsDraftSort: 'recent', xhsDraftSource: 'official', xhsComposerOpen: false,
  dingtalk: null, dingtalkLoading: false, dingtalkError: '', dingtalkActionError: '', dingtalkBusy: '', dingtalkDraft: null, dingtalkDirty: false, dingtalkTest: null,
};
let toastTimer;
let guideRequestVersion = 0;
let guideCreationVersion = 0;
let guideProjectPollTimer;
let guideProjectPollVersion = 0;
let trendsPollTimer;
let trendsLoadVersion = 0;
let radarPollTimer;
let radarLoadVersion = 0;
let xhsPollTimer;
let xhsLoadVersion = 0;
let xhsReadVersion = 0;
let xhsAccountsVersion = 0;
let xhsDraftRequestVersion = 0;
let xhsDetailRequestVersion = 0;
let xhsDetailReturnFocus = null;
let dingtalkPollTimer;
let dingtalkLoadVersion = 0;

const paths = {
  spark: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/><path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  settings: '<path d="M12 8v8m-4-4h8"/><circle cx="12" cy="12" r="9"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  cards: '<rect x="7" y="3" width="13" height="17" rx="2"/><path d="M4 7v13a2 2 0 0 0 2 2h10M11 8h5m-5 4h5"/>',
  chart: '<path d="M4 3v18h17M9 16v-5m5 5V7m5 9v-8"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6a8 8 0 0 1 13.4 3M4.5 15A8 8 0 0 0 18 18"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3m-10 0 1 15h12l1-15M10 10v7m4-7v7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  alert: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.1"/>',
  file: '<path d="M14 2H5v20h14V7Z"/><path d="M14 2v6h5M8 12h8m-8 4h6"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7Z"/>',
};
const icon = (name, extra = '') => `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
const h = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isActive = p => ['analyzing', 'generating'].includes(p?.status)||['thinking','analyzing','generating'].includes(p?.chatStatus);
const statusText = status => ({analyzing:'分析内容中', draft:'方案待确认', generating:'图片生成中', completed:'已完成', partial:'部分完成', error:'任务失败', interrupted:'任务已中断'}[status] || '待处理');
const modeText = mode => ({cards:'多页图文', infographic:'信息图', cover:'封面海报'}[mode] || mode);
const time = date => date ? new Date(date).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
const buttonBusy = name => state.busy === name ? '<span class="spinner spinner-small"></span>' : '';

function blankGuidance() {
  return {messages:[],analysis:'',source:'',input:'',error:'',pending:false,clarificationAsked:false,decision:null,
    matchTrends:true,targetPlatform:'generic',xhsAutoDelivery:false,trendMatches:null,selectedTrend:null,trendNotice:'',studioSource:'',creation:null,creationError:'',draftImages:[],referenceImages:[],attachmentError:'',
    preferences:{style:null,aspect:null,count:null,mode:null},
    recommendations:{style:'notion',aspect:'3:4',count:5,mode:'cards'},reasons:{}};
}
function guidePreferences(value = {}) {
  const preferences = {
    style:GUIDE_STYLES.some(s=>s.id===value.style)?value.style:null,
    aspect:['3:4','1:1','16:9'].includes(value.aspect)?value.aspect:null,
    count:Number.isInteger(value.count)&&value.count>=1&&value.count<=10?value.count:null,
    mode:['cards','infographic','cover'].includes(value.mode)?value.mode:null,
  };
  if(preferences.mode&&preferences.mode!=='cards')preferences.count=1;
  return preferences;
}
function restoreGuidance() {
  const base=blankGuidance();
  try {
    const data=JSON.parse(sessionStorage.getItem(GUIDE_STORAGE_KEY)||'null');
    if(!data||!Array.isArray(data.messages))return base;
    base.messages=trimGuideMessages(data.messages.filter(m=>['user','assistant'].includes(m?.role)&&typeof m.content==='string'&&m.content.length<=24000).map(m=>({role:m.role,content:m.content,images:normalizeGuideImages(m.images),...(m.role==='assistant'&&m.kind==='clarification'?{kind:'clarification'}:{})})));
    base.draftImages=normalizeGuideImages(data.draftImages);
    base.referenceImages=normalizeGuideImages(data.referenceImages);
    if(typeof data.attachmentError==='string')base.attachmentError=data.attachmentError.slice(0,600);
    base.clarificationAsked=data.clarificationAsked===true;
    base.decision=normalizeGuideDecision(data.decision);
    base.preferences=guidePreferences(data.preferences);
    const rec=guidePreferences(data.recommendations);
    for(const key of Object.keys(rec))if(rec[key]!==null)base.recommendations[key]=rec[key];
    for(const key of ['analysis','source','input','error'])if(typeof data[key]==='string')base[key]=data[key].slice(0,24000);
    if(data.reasons&&typeof data.reasons==='object')for(const key of ['style','aspect','count'])if(typeof data.reasons[key]==='string')base.reasons[key]=data.reasons[key].slice(0,1000);
    base.matchTrends=data.matchTrends!==false;
    base.xhsAutoDelivery=data.xhsAutoDelivery===true;
    base.targetPlatform=projectPlatform(data);
    base.trendMatches=normalizeGuideTrendMatches(data.trendMatches);
    if(base.matchTrends&&typeof data.selectedTrend?.id==='string'){
      const selected=base.trendMatches?.matches.find(item=>item.id===data.selectedTrend.id)||null;
      if(selected&&guideTrendUsable(selected))base.selectedTrend=selected;
      else if(selected)base.trendNotice='此前选择的热梗已满 14 天或缺少有效期，已移除，请重新匹配或按原主题继续。';
    }
    if(!base.trendNotice&&typeof data.trendNotice==='string')base.trendNotice=data.trendNotice.slice(0,500);
    if(typeof data.studioSource==='string')base.studioSource=data.studioSource.slice(0,24000);
    if(data.creation&&typeof data.creation==='object'&&isGuideUuid(data.creation.requestId)){
      const c=data.creation;base.creation={requestId:c.requestId,projectId:isGuideUuid(c.projectId)?c.projectId:null,status:typeof c.status==='string'?c.status.slice(0,40):'unknown',error:typeof c.error==='string'?c.error.slice(0,1000):'',requestedAt:typeof c.requestedAt==='string'?c.requestedAt:null};
      if(c.capture&&typeof c.capture==='object')base.creation.capture={targetPlatform:projectPlatform(c.capture),xhsAutoDelivery:c.capture.xhsAutoDelivery===true,...(c.capture.xhsAutoDelivery===true?{xhsAccountId:typeof c.capture.xhsAccountId==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(c.capture.xhsAccountId)?c.capture.xhsAccountId:null}:{})};
      if(c.lastChatRequest&&isGuideUuid(c.lastChatRequest.requestId)&&typeof c.lastChatRequest.message==='string'&&c.lastChatRequest.message.length<=6000)base.creation.lastChatRequest={requestId:c.lastChatRequest.requestId,message:c.lastChatRequest.message,images:normalizeGuideImages(c.lastChatRequest.images),status:typeof c.lastChatRequest.status==='string'?c.lastChatRequest.status.slice(0,40):'unknown',restoredInput:c.lastChatRequest.restoredInput===true};
    }
    if(typeof data.creationError==='string')base.creationError=data.creationError.slice(0,1000);
    if(data.pending&&!base.creation)base.error='上次分析未完成。你可以点击重试继续，不会自动重复请求模型。';
  }catch{/* A blocked or full session store should not prevent creation. */}
  return base;
}
function isGuideUuid(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);}
function normalizeGuideImages(value) {
  const seen=new Set();
  return (Array.isArray(value)?value:[]).slice(0,GUIDE_IMAGE_LIMIT).flatMap(image=>{
    if(!image||!isGuideUuid(image.id)||seen.has(image.id.toLowerCase()))return [];
    const id=image.id.toLowerCase();seen.add(id);
    return [{id,name:typeof image.name==='string'?image.name.slice(0,200):'产品参考图',mime:['image/png','image/jpeg','image/webp'].includes(image.mime)?image.mime:'image/png',size:Number.isInteger(image.size)&&image.size>=0?image.size:0,url:`/reference-images/${id}`,...(typeof image.sha256==='string'&&/^[a-f0-9]{64}$/.test(image.sha256)?{sha256:image.sha256}:{})}];
  });
}
function mergeGuideImages(...lists) {
  const unique=new Map();
  for(const list of lists)for(const image of normalizeGuideImages(list))if(!unique.has(image.id))unique.set(image.id,image);
  return [...unique.values()];
}
function guideImageMessageView(images) {
  const list=normalizeGuideImages(images);
  return list.length?`<div class="guide-message-images" aria-label="这条消息的产品参考图">${list.map(image=>`<button type="button" data-action="guide-reference-preview" data-id="${h(image.id)}" aria-label="查看参考图：${h(image.name)}"><img src="${h(image.url)}" alt="${h(image.name)}" loading="lazy"></button>`).join('')}</div>`:'';
}
function guideDraftImagesView() {
  const g=state.guide,images=normalizeGuideImages(g.draftImages);
  if(!images.length&&!state.guideUploadBusy&&!g.attachmentError)return '';
  return `<div class="guide-composer-attachments" aria-label="待发送的产品图片">${images.length?`<div class="guide-draft-images">${images.map(image=>`<div class="guide-draft-image"><button type="button" class="guide-draft-preview" data-action="guide-reference-preview" data-id="${h(image.id)}" aria-label="查看待发送图片：${h(image.name)}"><img src="${h(image.url)}" alt="${h(image.name)}"></button><button type="button" class="guide-draft-remove" data-action="guide-image-remove" data-id="${h(image.id)}" aria-label="移除图片：${h(image.name)}" ${state.guideUploadBusy?'disabled':''}>${icon('close')}</button></div>`).join('')}</div>`:''}${state.guideUploadBusy?'<div class="guide-upload-status" role="status"><span class="spinner spinner-small"></span>正在放入图片…</div>':images.length?`<span class="guide-attachment-note">${images.length} 张图片 · 随这条消息发送</span>`:''}${g.attachmentError?`<p class="guide-attachment-error" role="alert">${h(g.attachmentError)}</p>`:''}</div>`;
}
function referenceFileData(file) {
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('这张图片暂时无法读取，请重新粘贴或选择。'));reader.readAsDataURL(file);});
}
async function addGuideImages(files) {
  const g=state.guide;
  if(state.guideUploadBusy||state.guideBusy||guideWorkActive())return notify('当前消息正在处理中，完成后再添加图片。');
  const list=Array.from(files||[]);if(!list.length)return;
  g.attachmentError='';
  const current=g.creation?g.draftImages:mergeGuideImages(g.referenceImages,g.draftImages);
  const room=GUIDE_IMAGE_LIMIT-current.length;
  const validation=list.length>room?`这次创作最多使用 ${GUIDE_IMAGE_LIMIT} 张产品图片，当前还可以添加 ${Math.max(0,room)} 张。`:list.some(file=>!['image/png','image/jpeg','image/webp'].includes(file.type))?'请使用 PNG、JPEG 或 WebP 图片。':list.some(file=>file.size>GUIDE_IMAGE_MAX_BYTES)?'单张图片请控制在 8 MB 以内。':list.some(file=>!file.size)?'图片文件是空的，请换一张再试。':'';
  if(validation){g.attachmentError=validation;saveGuidance();renderGuidance({preserve:true});return;}
  const version=guideCreationVersion;state.guideUploadBusy=true;saveGuidance();renderGuidance({preserve:true});
  try {
    for(const file of list){
      const dataUrl=await referenceFileData(file);
      const {image}=await api('/api/reference-images',{method:'POST',body:{name:file.name||'粘贴的产品图片',dataUrl}});
      if(state.guide!==g||version!==guideCreationVersion)return;
      const saved=normalizeGuideImages([image]);if(!saved.length)throw new Error('图片保存结果无效，请重新添加。');
      g.draftImages=mergeGuideImages(g.draftImages,saved);saveGuidance();renderGuidance({preserve:true});
    }
  }catch(error){if(state.guide===g&&version===guideCreationVersion){g.attachmentError=`${error.message} 已添加的图片和文字会保留。`;saveGuidance();}}
  finally{state.guideUploadBusy=false;if(state.guide===g&&version===guideCreationVersion){saveGuidance();renderGuidance({preserve:true});document.querySelector('#guide-input')?.focus({preventScroll:true});}}
}
function guideComposerView({creating,locked,p,hint}) {
  const g=state.guide,busy=state.guideUploadBusy||state.guideBusy;
  const sendDisabled=busy||locked||(!creating&&!guideTextReady())||(creating&&!p);
  const placeholder=creating?'输入修改要求，可添加新的产品图片':g.decision?.action==='ask'?'一次回复补充信息，可添加产品图片':'输入创作需求，可粘贴或拖入图片';
  return `<form id="guide-form" class="guide-composer ${g.draftImages.length?'has-attachments':''}" aria-label="文字和图片消息输入框"><label class="sr-label" for="guide-input">${creating?'直接告诉我还想怎么改':'告诉创意编辑你想创作什么'}</label><input id="guide-image-input" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden ${busy||locked?'disabled':''}><button type="button" class="guide-attach-button" data-action="guide-image-add" aria-label="在消息中添加产品图片" title="可直接粘贴或拖入图片" ${busy||locked?'disabled':''}>${icon('image')}</button><div class="guide-composer-content">${guideDraftImagesView()}<textarea id="guide-input" maxlength="${creating?6000:24000}" rows="2" placeholder="${placeholder}" ${state.guideBusy?'disabled':''}>${h(g.input)}</textarea></div><div class="guide-composer-footer"><div class="guide-composer-options">${!creating?`<label class="guide-platform">目标平台<select id="guide-target-platform" ${busy||locked?'disabled':''}><option value="generic" ${g.targetPlatform==='generic'?'selected':''}>通用图文</option><option value="xhs" ${g.targetPlatform==='xhs'?'selected':''}>小红书</option></select></label><label class="guide-trends-toggle"><input id="guide-match-trends" type="checkbox" ${g.matchTrends?'checked':''} ${state.guideBusy?'disabled':''}><span>匹配相关热点</span></label>`:''}<span>${state.guideUploadBusy?'图片正在保存到本机，完成后可发送。':hint}</span></div><button class="button button-primary" type="submit" ${sendDisabled?'disabled':''}>${state.guideUploadBusy?'<span class="spinner spinner-small"></span>添加中':state.guideBusy?'<span class="spinner spinner-small"></span>分析中':locked?'<span class="spinner spinner-small"></span>处理中':creating?'发送修改':g.decision?.action==='ask'?'回答并创作':'发送想法'} ${icon('arrow')}</button></div></form>`;
}
function saveGuidance() {try{sessionStorage.setItem(GUIDE_STORAGE_KEY,JSON.stringify(state.guide));}catch{}}
const guideStyles = () => (state.config?.styles?.length?state.config.styles:GUIDE_STYLES).map(style=>{
  const fallback=GUIDE_STYLES.find(item=>item.id===style.id)||{};
  return {...fallback,...style,category:style.category||fallback.category||STYLE_CATEGORIES[0],aliases:Array.isArray(style.aliases)?style.aliases:fallback.aliases||[]};
});
const guideTextReady = () => Boolean(state.config?.text?.hasKey&&state.config.text.baseUrl&&state.config.text.model);
const guideFieldLabel = field => ({style:'视觉风格',aspect:'构图目标比例',count:'图片张数'}[field]);
function guideValueLabel(field,value) {
  if(field==='style')return guideStyles().find(s=>s.id===value)?.name||value;
  if(field==='aspect')return ({'3:4':'目标 3:4 · 竖版','1:1':'目标 1:1 · 方形','16:9':'目标 16:9 · 横版'}[value])||value;
  return `${value} 张`;
}
function normalizeGuideDecision(value) {
  if(!value||!['ask','generate','hold'].includes(value.action))return null;
  if(!value.resolvedSpec||typeof value.resolvedSpec!=='object')return null;
  const spec=guidePreferences(value.resolvedSpec);
  if(Object.values(spec).some(v=>v===null))return null;
  const questions=Array.isArray(value.questions)?value.questions:[];
  if(questions.length>4||questions.some(q=>!q||typeof q.id!=='string'||typeof q.question!=='string'||!q.question.trim()||q.question.length>800))return null;
  if((value.action==='ask'&&!questions.length)||(value.action!=='ask'&&questions.length))return null;
  return {action:value.action,questions,resolvedSpec:spec,summary:typeof value.summary==='string'?value.summary.slice(0,2000):''};
}
function guidanceReady() {
  return Boolean(state.guide.source.trim()&&state.guide.analysis&&state.guide.decision?.action==='generate'&&['style','aspect','count','mode'].every(f=>state.guide.preferences[f]!==null));
}
function guideQuestion(field) {
  return {style:'你想要怎样的视觉风格？',aspect:'希望按什么比例构图？',count:'这次想做几张图片？'}[field];
}
function guideHistoryItemsView() {
  const query=state.guideHistorySearch.trim().toLocaleLowerCase();
  const projects=[...state.projects].filter(project=>!query||String(project.title||'').toLocaleLowerCase().includes(query)).sort((a,b)=>(Date.parse(b.updatedAt||b.createdAt)||0)-(Date.parse(a.updatedAt||a.createdAt)||0)).slice(0,30);
  return projects.length?projects.map(project=>`<button class="admin-chat-history-item ${state.guideProject?.id===project.id?'is-active':''}" type="button" data-action="continue-chat" data-id="${h(project.id)}" ${state.guideBusy||guideWorkActive()?'disabled':''}><span class="admin-chat-history-title">${icon('file')}<strong>${h(project.title||'未命名作品')}</strong></span><span class="admin-chat-history-meta"><span class="${project.status==='completed'?'is-done':''}">${h(statusText(project.status))}</span><time>${project.updatedAt||project.createdAt?h(xhsDate(project.updatedAt||project.createdAt)):''}</time></span></button>`).join(''):`<div class="admin-chat-history-empty">${query?'没有匹配的作品':'还没有创作记录'}<span>${query?'试试其他标题关键词':'发起第一条创作需求后，作品会保存在这里。'}</span></div>`;
}
function guideHistoryView() {
  return `<aside class="admin-chat-sidebar" aria-label="最近创作"><button class="button button-primary" type="button" data-action="guide-new" ${state.guideBusy||guideWorkActive()?'disabled':''}>${icon('plus')}新建对话</button><div class="admin-chat-history-heading"><h2>最近创作</h2><span>${state.projects.length}</span></div><label class="admin-chat-history-search" for="guide-history-search">${icon('search')}<span class="sr-label">搜索最近作品</span><input id="guide-history-search" type="search" placeholder="搜索作品标题" value="${h(state.guideHistorySearch)}" maxlength="100"></label><div id="guide-history-results" class="admin-chat-history-list">${guideHistoryItemsView()}</div><button class="admin-chat-history-all text-button" type="button" data-action="navigate" data-view="history">全部作品记录 ${icon('arrow')}</button></aside>`;
}
function guideWelcomeView() {
  return `<div class="guide-welcome admin-chat-welcome"><span class="admin-chat-welcome-icon">${icon('file')}</span><h2>这次想创作什么？</h2><p>告诉我主题和用途，也可以直接粘贴产品图片。</p><div class="guide-examples">${['新手准备清单','产品宣传图文','AI 工作流知识图'].map((label,index)=>`<button type="button" data-action="guide-example" data-example="${index}">${label} ${icon('arrow')}</button>`).join('')}</div><span class="admin-chat-welcome-note">缺少的信息会一次追问，补充后直接生成图文。</span></div>`;
}
function guidanceView() {
  const g=state.guide,p=state.guideProject,creating=Boolean(g.creation),locked=guideWorkActive();
  const resultReady = creating && p?.id === g.creation.projectId && p.status === 'completed' && !guideGenerationActive(p);
  const thread=g.messages.length?g.messages.map(m=>`<article class="guide-message ${m.role==='user'?'user':'assistant'} ${m.kind==='clarification'?'is-clarification':''}"><span class="guide-message-label">${m.role==='user'?'你':'创意编辑'}</span>${m.kind==='clarification'?`<span class="guide-batch-label">${icon('file')}补充创作信息</span>`:''}${guideImageMessageView(m.images)}<p>${h(m.content)}</p></article>`).join(''):creating?`<article class="guide-message assistant"><span class="guide-message-label">创意编辑</span>${guideImageMessageView(g.referenceImages)}<p>已载入这份作品。查看图文，或直接告诉我想怎么改。</p></article>`:guideWelcomeView();
  const preferenceIcons={style:'image',aspect:'expand',count:'cards'};
  const preferences=(g.analysis||creating)?`<div class="guide-inline-brief" aria-label="创作参数">${['style','aspect','count'].map(f=>{
    const value=creating&&f==='count'&&p?.pages?.length?p.pages.length:g.preferences[f]??g.recommendations[f];
    return `<span class="guide-preference">${icon(preferenceIcons[f])}<span class="sr-label">${guideFieldLabel(f)}：</span><strong>${h(guideValueLabel(f,value))}</strong>${!creating&&g.preferences[f]===null?'<span>建议</span>':''}</span>`;
  }).join('')}</div>`:'';
  const trend=g.selectedTrend?`<details class="guide-context-trend"><summary><span>已选热点</span><strong>${h(g.selectedTrend.title)}</strong><span>${h(trendName(g.selectedTrend.platform))}</span></summary><p>${h(g.selectedTrend.angle)}</p>${g.selectedTrend.kind==='meme'?`<small>热梗候选 · 至 ${guideTrendDate(g.selectedTrend.expiresAt)} 有效</small>`:''}${!creating?`<button type="button" class="text-button" data-action="guide-trend-clear" ${state.guideBusy?'disabled':''}>移除热点</button>`:''}</details>`:'';
  const tools=!creating&&g.analysis&&!g.error?`<details class="guide-optional-tools" ${state.guideEdit?'open':''}><summary>查看创作方向与偏好 <span>可选，直接聊天也可以</span></summary><div class="guide-analysis"><span>内容方向</span><p>${h(g.analysis)}</p></div>${preferences}<div class="guide-optional-actions">${['style','aspect','count'].map(f=>`<button type="button" class="text-button" data-action="guide-edit" data-field="${f}" ${state.guideBusy?'disabled':''}>调整${guideFieldLabel(f)}</button>`).join('')}</div>${state.guideEdit?guideQuestionView(state.guideEdit):''}${guideTrendMatchesView()}</details>`:'';
  const hint=locked?'任务正在处理中，可以先写好下一条要求。':creating?'直接说想改哪里，或按 ⌘ / Ctrl + Enter 发送。':g.decision?.action==='ask'?'把上面的问题一起回复，拿不准的偏好可以交给我。':'信息齐全后会自动生成；暂不生成时直接告诉我。';
  const context = resultReady
    ? `<details class="guide-work-context"><summary>创作需求与参数</summary>${preferences}${trend}${g.messages.length ? thread : `<p>${h(p.source || '')}</p>${guideImageMessageView(g.referenceImages)}`}</details>`
    : `${thread}${creating ? preferences : ''}${trend}${tools}`;
  const result = guideCreationView(resultReady);
  return `<div class="briefing-layout conversation-layout admin-chat-layout ${resultReady?'is-result':''} ${creating?'has-creation':''} ${!creating&&!g.messages.length?'is-empty':''}">
    ${guideHistoryView()}
    <section class="briefing-panel admin-chat-panel" aria-label="创作需求对话">
      <div class="admin-chat-toolbar"><div class="admin-chat-current"><strong>${h(p?.title||(g.messages.length?'当前创作对话':'新建创作'))}</strong><span class="admin-chat-state ${locked||state.guideBusy?'is-working':''}">${locked||state.guideBusy?'<span class="spinner spinner-small"></span>':'<i></i>'}${h(state.guideBusy?'正在分析':locked?'正在处理':creating?guideCreationStatus(p||{}):g.decision?.action==='ask'?'等待补充':'就绪')}</span></div><div class="admin-chat-tools"><details id="guide-delivery-settings" class="admin-chat-delivery" ${state.guideDeliverySettingsOpen?'open':''}><summary>${icon('settings')}<span id="guide-delivery-label">${guideDeliverySettingsLabel()}</span></summary><div id="guide-xhs-region">${guideXhsConnectionView()}</div></details><button type="button" class="button button-secondary admin-chat-mobile-new" data-action="guide-new" ${state.guideBusy||locked?'disabled':''}>${icon('plus')}新建</button></div></div>
      <div class="guide-thread" role="log" aria-live="polite">${resultReady ? result : context}${state.guideBusy?'<div class="guide-thinking"><span class="spinner spinner-small"></span>正在分析需求…</div>':''}${g.error?`<div class="guide-error" role="alert"><p>${h(g.error)}</p>${!creating&&g.messages.some(m=>m.role==='user')?`<button class="text-button" data-action="guide-retry" ${state.guideBusy?'disabled':''}>重试这次分析</button>`:''}</div>`:''}${resultReady ? context : result}</div>
      <div class="admin-chat-compose-area">${guideComposerView({creating,locked,p,hint})}<div class="guide-model-note">${creating?'直接描述修改要求，需要重画时才会重新生图。':guideTextReady()?'支持粘贴或拖入图片 · ⌘ / Ctrl + Enter 发送':'先连接文字模型即可开始。'}${!guideTextReady()?` <button class="text-button" data-action="navigate" data-view="settings">去模型设置 ${icon('arrow')}</button>`:''}</div></div>
    </section>
  </div>`;
}

const GUIDE_DELIVERY_BUSY = new Set(['preparing','queued','running']);
const guideGenerationActive = project => Boolean(project&&(isActive(project)||['thinking','analyzing','generating'].includes(project.chatStatus)));
function guideDeliveryProviderChanged(delivery) {
  return Boolean(delivery?.enabled && state.xhs && (!delivery.providerKey || delivery.providerKey !== state.xhs.providerKey));
}
function guideDeliveryActive(project) {
  const delivery=project?.xhsDelivery;
  return Boolean(delivery?.enabled&&!guideDeliveryProviderChanged(delivery)&&(delivery.running||GUIDE_DELIVERY_BUSY.has(delivery.status)||(delivery.status==='waiting_generation'&&project.status==='completed')));
}
function guideProjectActive(project) { return guideGenerationActive(project)||guideDeliveryActive(project); }
function guideDeliverySettingsLabel() {
  if(xhsDeliveryReadOnly())return '交付设置 · 草稿只读';
  const p=state.guideProject,g=state.guide;
  const automatic=p?Boolean(p.xhsDelivery?.enabled&&p.xhsAutoDelivery!==false):Boolean(g.creation?.capture?.xhsAutoDelivery??g.xhsAutoDelivery);
  return automatic?'交付设置 · 自动送稿':'交付设置';
}
function guideXhsConnectionView() {
  if(!state.xhs)return `<p class="field-help" role="status">${h(state.xhsError||'正在读取送稿账号…')}</p>`;
  if(!xhsBound())return '<p class="field-help">'+h(xhsAccountSetupHint())+'</p><button class="text-button" type="button" data-action="navigate" data-view="xhs">查看接入说明</button>';
  if(!xhsDeliveryReadOnly()&&guideDeliveryProviderChanged(state.guideProject?.xhsDelivery))return '<p class="field-help">本次创作此前使用了其他小红书连接。</p>';
  const g=state.guide,delivery=state.guideProject?.xhsDelivery,fixed=delivery?.accountId||g.creation?.capture?.xhsAccountId;
  return `<div class="guide-xhs-connection"><div><span class="guide-xhs-mark">${icon('file')}</span><span><strong>${xhsDeliveryReadOnly()?'草稿账号':'送稿账号'} · ${h(xhsDeliveryReadOnly()?xhsAccountId():fixed||xhsAccountId())}</strong><small>${h(xhsConnectionHint('送稿前会检查发布服务。'))}</small></span></div>${publisherCheckButton()}${!g.creation&&!xhsDeliveryReadOnly()?`<label class="guide-xhs-auto-option"><input id="guide-xhs-auto-delivery" type="checkbox" ${g.xhsAutoDelivery?'checked':''} ${state.guideBusy||state.guideActionBusy?'disabled':''}><span>生成后自动存入小红书草稿 <small>可选</small></span></label>`:''}</div>`;
}
function guideEditedAfterDelivery(project) {
  const delivery=project?.xhsDelivery,at=Date.parse(delivery?.verifiedAt||delivery?.updatedAt);
  if(delivery?.status==='verified'&&typeof delivery.versionChanged==='boolean')return delivery.versionChanged;
  return delivery?.status==='verified'&&Number.isFinite(at)&&(project.chatRequests||[]).some(record=>record.status==='completed'&&['update_post','revise_pages','regenerate','replan'].includes(record.action)&&Date.parse(record.completedAt)>at);
}
function guideDeliveryReceipt(project) {
  const delivery=project?.xhsDelivery;
  return (state.xhs?.drafts||[]).find(draft=>draft.id===delivery?.draftId&&draft.accountId===delivery?.accountId)||delivery;
}
function guideDeliveryHistoryView(delivery) {
  const history=Array.isArray(delivery.history)?delivery.history:[];
  if(!history.length)return '';
  return `<details class="guide-delivery-history"><summary>此前草稿 · ${history.length} 个版本</summary><ol>${history.map((receipt,index)=>`<li><span>第 ${Number(receipt.version)||index+1} 版</span><strong>${h(XHS_DRAFT_LABELS[receipt.status]||'状态待确认')}</strong><time>${h(xhsDate(receipt.verifiedAt||receipt.updatedAt))}</time></li>`).join('')}</ol></details>`;
}
function guideDeliveryMayContinue(delivery) {
  return Boolean(delivery?.enabled&&delivery.canContinue!==false&&(['blocked','failed'].includes(delivery.status)||(delivery.status==='interrupted'&&delivery.canContinue===true)));
}
function guideDeliveryLabel(project) {
  const delivery=project?.xhsDelivery;if(!delivery?.enabled)return '';
  if(delivery.rechecking||guideDeliveryReceipt(project)?.rechecking)return '正在重新核验电脑草稿';
  if(delivery.status==='verified'&&delivery.running)return '电脑草稿已核验，正在保存记录';
  if(xhsDeliveryReadOnly()&&['waiting_generation','blocked'].includes(delivery.status))return '送稿已暂停';
  if(delivery.status==='interrupted'&&guideDeliveryMayContinue(delivery))return xhsDeliveryReadOnly()?'图文已保留，草稿尚未送出':'图文已保留，草稿尚未送出，可继续';
  if(guideEditedAfterDelivery(project))return '图文已更新，原草稿保留此前版本';
  return ({waiting_generation:'图文完成后自动存草稿',preparing:'正在准备小红书草稿',queued:'正在等待送入电脑草稿',running:'正在存入并核验电脑草稿',verified:'图文和电脑草稿已完成',filled:'图文已填入，草稿待核验',unknown:'草稿保存结果待核验',failed:'图文已保留，草稿尚未送达',blocked:'图文已保留，草稿等待继续',interrupted:'草稿流程已中断，需人工核验'}[delivery.status])||'草稿状态待确认';
}
function projectPublishButton(project,label='选择账号并发布') {
  return `<button class="button button-secondary" type="button" data-action="xhs-for-project" data-id="${h(project.id)}">${icon('arrow')}${h(label)}</button>`;
}
function guideLocalDraftView(project) {
  const ready=xhsEligible(project);
  return `<section class="guide-xhs-delivery guide-local-draft" aria-label="本平台草稿"><div class="guide-delivery-result"><div><strong>${icon('file')}${ready?'图文已保存在本平台':'创作内容保存在本平台'}</strong><p>${h(xhsDeliveryReadOnly()?xhsDeliverySetupHint():'可继续修改，或选择小红书账号存草稿、预约发布。')}</p></div>${ready?projectPublishButton(project):''}</div></section>`;
}
function publisherRecordsLink() {
  return `<button class="text-button" type="button" data-action="guide-publisher-records">查看送稿记录 ${icon('arrow')}</button>`;
}
function guideDeliveryView(project) {
  const delivery=project?.xhsDelivery;if(!delivery?.enabled)return guideLocalDraftView(project);
  if(guideDeliveryProviderChanged(delivery))return `<section class="guide-xhs-delivery" aria-label="原连接送稿记录"><div class="guide-delivery-result"><div><strong>原连接送稿记录</strong><p>${h(delivery.message||'这次送稿使用了其他小红书连接。')}</p></div>${xhsEligible(project)?projectPublishButton(project,'选择现在的账号送稿'):''}</div></section>`;
  const imagesReady=project.status==='completed'&&(project.pages||[]).length>0&&(project.pages||[]).every(page=>page.status==='done'&&page.imageUrl),busy=guideDeliveryActive(project),receipt=guideDeliveryReceipt(project),edited=guideEditedAfterDelivery(project);
  const warning=['blocked','failed','filled','unknown','interrupted'].includes(delivery.status),verified=delivery.status==='verified';
  const planningDone=Boolean(project.pages?.length),target=xhsAccountRecord(delivery.accountId||guideTargetAccountId()),accountMatch=xhsRecordBound(target),targetWorking=Boolean(target?.busy||state.xhsBusy);
  const stages=[['策划内容',planningDone,'analyzing'],['生成完整图文',imagesReady,'generating'],['存入小红书草稿',verified,'delivery']];
  const mayContinue=!xhsDeliveryReadOnly()&&imagesReady&&guideDeliveryMayContinue(delivery);
  const canContinue=mayContinue&&xhsRecordBound(target)&&accountMatch&&!busy&&!targetWorking&&!state.guideActionBusy;
  const canSend=xhsRecordBound(target)&&accountMatch&&!busy&&!targetWorking&&!guideGenerationActive(project)&&!state.guideActionBusy;
  const canOpen=accountMatch&&!busy&&!targetWorking&&!guideGenerationActive(project)&&!state.guideActionBusy;
  const canRecheck=Boolean(delivery.draftId&&xhsCanRecheck(receipt)),canSaveVersion=!xhsDeliveryReadOnly()&&edited&&imagesReady&&delivery.canSaveVersion!==false&&!delivery.pendingVersion;
  const problem=(canSaveVersion||mayContinue)&&draftCopyProblem(project.title,project.caption);
  const hint=xhsDeliveryReadOnly()?xhsDeliverySetupHint():problem|| (edited?'当前修改还未送入小红书。直接说“把修改版存到草稿箱”，或在这里另存新版；此前草稿保留。':delivery.message||(!imagesReady?'全部图片完成后，会自动送入本次服务账号的草稿。':busy?'正在后台送稿，刷新页面不会重复上传。':verified?'已存入该账号的草稿箱，可在这里预约发布。':'图文和图片已经保留，请按提示继续处理。'));
  const continueLabel=delivery.accountId?'继续送入草稿':`继续送至 ${xhsRecordName(target)} 草稿`;
  return `<section class="guide-xhs-delivery ${warning?'is-warning':verified?'is-verified':''}" aria-label="创作与草稿交付进度" aria-busy="${busy}"><ol class="guide-delivery-steps">${stages.map(([label,done,kind],index)=>{const current=!done&&(kind==='delivery'?imagesReady:(kind==='generating'?planningDone:!planningDone));return `<li class="${done?'is-done':current?'is-current':''}"><span>${done?icon('check'):index+1}</span><strong>${label}</strong></li>`;}).join('')}</ol><div class="guide-delivery-result"><div><strong>${busy?'<span class="spinner spinner-small"></span>':icon(verified?'check':warning?'alert':'file')}${h(guideDeliveryLabel(project))}</strong><p>${h(hint)}</p>${delivery.accountId?`<small>目标账号：${h(delivery.accountName||delivery.accountId)}${Number(delivery.version)>1?` · 第 ${Number(delivery.version)} 版`:''}</small>`:''}${delivery.accountId&&!accountMatch?'<small class="guide-delivery-account-mismatch">本次送稿的目标账号与当前服务账号不一致。</small>':''}</div><div class="guide-delivery-actions">${problem?'<button class="button button-secondary" type="button" data-action="guide-edit-xhs-copy">编辑送稿文案</button>':''}${!problem&&mayContinue?`<button class="button button-secondary" type="button" data-action="guide-xhs-continue" ${canContinue?'':'disabled'}>${icon('arrow')}${h(continueLabel)}</button>${!xhsRecordBound(target)?`<span>${h(xhsAccountSetupHint())}</span>`:!xhsRecordConnected(target)?`<span>${xhsAvailabilityHint}</span>`:''}`:''}${canRecheck?`<button class="button button-secondary" type="button" data-action="guide-xhs-recheck" data-id="${h(delivery.draftId)}" ${canOpen?'':'disabled'}>${icon('refresh')}查询任务结果</button>`:''}${canSaveVersion&&!problem?`<button class="button button-secondary" type="button" data-action="guide-xhs-version" ${canSend?'':'disabled'}>${icon('arrow')}将当前版本另存草稿</button>`:''}${delivery.draftId?publisherRecordsLink():''}${imagesReady&&!busy?projectPublishButton(project):''}</div></div>${delivery.status==='interrupted'&&mayContinue?'<p class="guide-delivery-note">上次在送稿前中断，图文已保留。点击继续后才会送入电脑草稿。</p>':['unknown','filled','interrupted'].includes(delivery.status)?`<p class="guide-delivery-note">在送稿记录中查询原任务。结果待确认时请在发布服务核对。</p>`:''}${guideDeliveryHistoryView(delivery)}</section>`;
}
function guideCompletionNotice(project) {
  const latest=project.chatRequests?.at(-1);
  if(project.chatStatus==='error'||latest?.status==='error')return {message:project.chatError||latest?.error||latest?.reply||'这次修改尚未应用，原图文已保留。',warning:true};
  if(latest?.status==='completed'&&latest.action==='reply')return {message:'已回复，图文保持当前版本。',warning:false};
  if(latest?.status==='completed'&&latest.action==='append_pages')return {message:Number.isInteger(latest.appendedCount)&&latest.appendedCount>0?`已追加 ${latest.appendedCount} 张配图，原有图片保留。`:'新增配图已保存，原有图片保留。',warning:false};
  const delivery=project?.xhsDelivery;
  if(delivery?.enabled){
    if(delivery.status==='verified')return {message:guideEditedAfterDelivery(project)?'本次图文修改已完成，原小红书草稿仍保留此前版本。':'图文已完成，并已存入小红书电脑草稿。',warning:false};
    if(xhsDeliveryReadOnly()&&['failed','blocked','interrupted'].includes(delivery.status))return {message:xhsDeliverySetupHint(),warning:true};
    if(delivery.status==='interrupted'&&guideDeliveryMayContinue(delivery))return {message:'图文已保留，草稿尚未送出，可在当前对话继续送稿。',warning:true};
    if(['filled','unknown','interrupted'].includes(delivery.status))return {message:'图文已保留，请查看发布服务的送稿记录。',warning:true};
    if(['failed','blocked'].includes(delivery.status)&&project.status==='completed')return {message:delivery.message||'图文已完成，草稿还未送达，可在当前对话继续处理。',warning:true};
  }
  return {message:project.status==='completed'?'图文已完成，可以直接在对话里查看和修改。':project.error||'这次处理已结束，结果已保存在对话中。',warning:['error','partial','interrupted'].includes(project.status)||['error','interrupted'].includes(project.chatStatus)};
}
function updateGuideXhs() {
  if(state.view!=='briefing')return;
  const label=document.querySelector('#guide-delivery-label');if(label)label.textContent=guideDeliverySettingsLabel();
  const region=document.querySelector('#guide-xhs-region');if(region)region.innerHTML=guideXhsConnectionView();
  const delivery=document.querySelector('.guide-xhs-delivery');if(delivery&&state.guideProject)delivery.outerHTML=guideDeliveryView(state.guideProject);
}
async function continueGuideXhsDelivery() {
  if(xhsDeliveryReadOnly())return notify(xhsDeliverySetupHint(),true);
  const p=state.guideProject,delivery=p?.xhsDelivery;
  if(!p||!guideDeliveryMayContinue(delivery)||guideGenerationActive(p)||guideDeliveryActive(p)||state.guideActionBusy)return;
  const target=xhsAccountRecord(delivery.accountId||guideTargetAccountId());if(!xhsRecordBound(target))return notify(xhsAccountSetupHint(),true);
  const version=guideCreationVersion,id=p.id,accountId=target.accountId;state.guideActionBusy='xhs-delivery';renderGuidance({preserve:true});
  try{const result=await api(`/api/projects/${encodeURIComponent(id)}/xhs-delivery`,{method:'POST',body:{accountId}});if(version!==guideCreationVersion||state.guide.creation?.projectId!==id)return;if(result.project)setGuideProject(result.project);else await loadGuideProject({quiet:true});}
  catch(error){if(version===guideCreationVersion){state.guide.creation.error=error.message;saveGuidance();notify(error.message,true);if(error.status===409)await loadXhs({quiet:true});}}
  finally{if(version===guideCreationVersion){state.guideActionBusy='';renderGuidance({preserve:true});beginGuidePolling();}}
}
async function saveGuideXhsVersion() {
  if(xhsDeliveryReadOnly())return notify(xhsDeliverySetupHint(),true);
  const p=state.guideProject,delivery=p?.xhsDelivery;
  if(!p||!guideEditedAfterDelivery(p)||delivery.canSaveVersion===false||delivery.pendingVersion||!xhsEligible(p)||guideWorkActive()||xhsWorking())return;
  const target=xhsAccountRecord(delivery.accountId);if(!xhsRecordBound(target))return notify('原草稿的账号与当前发布服务账号不一致。',true);
  const version=guideCreationVersion,id=p.id,accountId=delivery.accountId;state.guideActionBusy='xhs-version';renderGuidance({preserve:true});
  try{
    const result=await api(`/api/projects/${encodeURIComponent(id)}/xhs-delivery`,{method:'POST',body:{accountId,newVersion:true}});
    if(version!==guideCreationVersion||state.guide.creation?.projectId!==id)return;
    if(result.project)setGuideProject(result.project);else await loadGuideProject({quiet:true});
    notify('正在准备当前版本的电脑草稿，此前草稿保留。');
  }catch(error){if(version===guideCreationVersion){notify(error.message,true);if(error.status===409){await loadXhs({quiet:true});await loadGuideProject({quiet:true});}}}
  finally{if(version===guideCreationVersion){state.guideActionBusy='';renderGuidance({preserve:true});beginGuidePolling();}}
}
function guideWorkActive() {const c=state.guide.creation;return Boolean(state.guideUploadBusy||state.guideActionBusy||guideProjectActive(state.guideProject)||(!state.guideProject&&c&&!c.error&&['analyzing','generating'].includes(c.status)));}
function guideCreationStatus(project) {
  if (guideProjectActive(project) && project.contentQuality?.status === 'reviewing') return '正在审阅文案';
  if (guideProjectActive(project) && project.contentQuality?.status === 'rewriting') return '正在优化文案';
  if(project.chatStatus==='thinking')return project.chatAction==='save_draft'?'正在准备新版草稿':'正在理解修改要求';
  if(project.chatStatus==='analyzing')return project.chatAction==='create'?'正在策划图文':'正在修改内容';
  if(project.chatStatus==='generating'||project.status==='generating')return project.chatAction==='append_pages'?'正在追加配图':'正在生成图片';
  if(project.status==='analyzing')return '正在策划图文';
  if(project.chatStatus==='error')return '这次修改未完成';
  if(project.chatStatus==='interrupted')return '这次修改已中断';
  if(project.chatRequests?.at(-1)?.action==='reply')return '已回复，图文未更改';
  if(project.status==='completed'&&project.xhsDelivery?.enabled)return guideDeliveryLabel(project);
  return ({completed:'图文已完成',partial:'部分图片未完成',error:'这次创作未完成',interrupted:'创作已中断',draft:'内容已准备好'}[project.status])||'作品准备中';
}
function guideContentQualityView(project) {
  const review = project.contentQuality;
  if (!review) return '';
  const working = guideProjectActive(project) && ['reviewing', 'rewriting'].includes(review.status);
  const passed = review.status === 'passed' && review.applied;
  const title = working ? review.status === 'rewriting' ? '正在按审稿意见优化文案' : '正在审阅文案'
    : passed ? `本次文案审稿 ${review.score} / 100`
      : review.status === 'pending' ? '文案已修改，等待审稿' : '本次文案审稿待处理';
  const labels = { grounding: '素材一致', information: '信息价值', naturalness: '自然表达', audience: '读者适配', purpose: '内容目的' };
  const fieldLabel = field => field === 'title' ? '帖子标题' : field === 'caption' ? '帖子正文'
    : field.replace(/^pages\[(\d+)\]\.(title|content)$/, (match, index, part) => `第 ${Number(index) + 1} 张${part === 'title' ? '标题' : '图内文字'}`);
  const scope = (review.scope || []).map(fieldLabel).join('、');
  const scores = review.scores ? `<div class="guide-quality-scores">${Object.entries(labels).map(([key, label]) => `<span>${label} <strong>${h(review.scores[key])}</strong></span>`).join('')}</div>` : '';
  const issues = (review.issues || []).map(issue => `<li>${issue.quote ? `<blockquote>${h(issue.quote)}</blockquote>` : ''}<p>${h(issue.reason)}</p><small>${h(issue.suggestion)}</small></li>`).join('');
  const draft = review.draft ? `<details class="guide-quality-draft"><summary>查看待调整的文字</summary>${(review.scope || []).map(field => `<section><strong>${h(fieldLabel(field))}</strong><p>${h(review.draft[field] || '')}</p></section>`).join('')}</details>` : '';
  return `<details class="guide-content-quality ${passed ? 'is-passed' : 'needs-attention'}"><summary>${working ? '<span class="spinner spinner-small"></span>' : icon(passed ? 'check' : 'file')}<strong>${h(title)}</strong><span>${working ? '处理中' : review.rewriteCount ? `已优化 ${review.rewriteCount} 轮` : '查看详情'}</span></summary><div>${scores}${scope ? `<p>审核范围 ${h(scope)}</p>` : ''}${review.error || review.summary ? `<p>${h(review.error || review.summary)}</p>` : ''}${issues ? `<ul>${issues}</ul>` : ''}${draft}<small>这是本次文字的内部编辑评分，满分 100，初始通过线 80。${review.applied === false && review.draft ? '本次候选文字保留为草稿。' : ''}</small></div></details>`;
}
function outputSizeView(page, targetAspect) {
  const size = formatImageDimensions(page.imageDimensions?.width, page.imageDimensions?.height);
  const label = size ? `实际 ${size}` : '<span data-measure-output>实际尺寸未知</span>';
  return `<p class="guide-output-size">目标 ${h(targetAspect)} · ${label}</p>`;
}

// Old projects only have a URL. Reuse the image decoded for the preview.
app.addEventListener('load', event => {
  const image = event.target;
  if (!image.matches?.('.guide-created-image img')) return;
  const label = image.closest('.guide-created-page')?.querySelector('[data-measure-output]');
  if (!label) return;
  const size = formatImageDimensions(image.naturalWidth, image.naturalHeight);
  if (size) label.textContent = `实际 ${size}`;
}, true);

function guideCreationView(resultReady) {
  const g=state.guide,c=g.creation;
  if(!c)return g.creationError?`<div class="guide-creation-error guide-error" role="alert"><p>${h(g.creationError)}</p><button class="text-button" data-action="navigate" data-view="settings">检查模型设置 ${icon('arrow')}</button></div>`:'';
  const p=state.guideProject?.id===c.projectId?state.guideProject:null;
  if(!p)return `<section class="guide-creation" aria-label="创作结果"><div class="guide-creation-header"><div><span class="eyebrow">图文作品</span><h3>${c.projectId?'正在恢复你的作品':'正在确认创作请求'}</h3></div>${state.guideActionBusy?'<span class="spinner spinner-small"></span>':''}</div><p class="guide-creation-pending">${c.projectId?'正在读取已保存的结果，不会重复生成。':'提交后会在这里自动完成内容策划与图片生成。刷新页面不会自动再发一次生成请求。'}</p>${c.error?`<div class="guide-creation-error" role="alert">${h(c.error)}</div>`:''}<div class="guide-creation-actions"><button class="button button-secondary" data-action="${c.projectId?'guide-load-result':'guide-create-retry'}" ${state.guideActionBusy?'disabled':''}>${icon('refresh')}${c.projectId?'重新读取结果':'确认上次请求结果'}</button></div></section>`;
  const pages=p.pages||[],done=pages.filter(page=>page.status==='done').length,active=guideProjectActive(p)||Boolean(state.guideActionBusy);
  const canRetry=!active&&(pages.some(page=>page.status!=='done')||(!pages.length&&['error','interrupted'].includes(p.status)));
  const last=c.lastChatRequest;
  const chat=(p.chatMessages||[]).filter(message=>!(message.role==='user'&&(message.action==='create'||message.content===p.source))).slice(-20);
  const pending=last&&['sending','unknown'].includes(last.status)&&!chat.some(message=>message.requestId===last.requestId);
  const issue=['error','interrupted'].includes(p.chatStatus)||['error','partial','interrupted'].includes(p.status)||['failed','blocked','filled','unknown','interrupted'].includes(p.xhsDelivery?.status);
  const onlyReply=p.chatRequests?.at(-1)?.status==='completed'&&p.chatRequests.at(-1).action==='reply';
  const status=p.chatStatus==='error'||p.chatRequests?.at(-1)?.status==='error'?'这次修改未完成':onlyReply?'已回复，图文未更改':p.xhsDelivery?.enabled&&p.status==='completed'&&!guideGenerationActive(p)?guideDeliveryLabel(p):active||issue||!done||done!==pages.length?guideCreationStatus(p):`${done} 张已完成`;
  const progress=active||canRetry?`<div class="guide-creation-progress"><strong>${done} / ${pages.length||g.preferences.count||0} 张已完成</strong><span>${active?h(guideDeliveryActive(p)?p.xhsDelivery?.message||'图片已完成，正在送入电脑草稿。':p.logs?.at(-1)?.message||'正在处理，完成后会自动展示。'):pages.length?'已完成的图片会保留，可继续重试其余图片。':'这次尚未生成图片，可以重新开始内容策划。'}</span></div>`:'';
  const downloads=done&&!guideGenerationActive(p)?`<a class="button button-primary" href="/api/projects/${encodeURIComponent(p.id)}/export.zip" download>${icon('download')}下载整组</a>`:'';
  const retryActions=`${canRetry?`<button class="button button-secondary" data-action="guide-retry-images">${icon('refresh')}${pages.length?'重试未完成图片':'重试这次创作'}</button>`:''}${c.error&&!active?'<button class="text-button" data-action="guide-load-result">重新读取结果</button>':''}${last&&last.status==='unknown'&&!active?'<button class="text-button" data-action="guide-chat-retry">确认上次修改结果</button>':''}`;
  const gallery = pages.length?`<div class="guide-creation-grid" data-count="${pages.length}">${pages.map((page,index)=>`<article class="guide-created-page"><div class="guide-created-image" data-aspect="${h(p.aspect)}">${page.imageUrl?`<button data-action="guide-result-preview" data-id="${h(page.id)}" aria-label="查看第 ${index+1} 张完整图片"><img src="${h(page.imageUrl)}" alt="${h(page.title||'第 '+(index+1)+' 张图文')}" loading="lazy"><span>${icon('expand')}查看大图</span></button>`:`<div class="guide-created-placeholder">${page.status==='generating'?'<span class="spinner"></span>':icon('image')}<strong>第 ${index+1} 张</strong><span>${page.status==='error'?'这张图片暂未完成':page.status==='generating'?'正在绘制…':'等待生成'}</span></div>`}</div><div class="guide-created-page-footer"><span>${String(index+1).padStart(2,'0')} · ${h(page.title)}</span>${page.imageUrl?`<a href="${h(page.imageUrl)}" download="${h(p.id)}-${index+1}.${h(page.imageUrl.split('.').pop())}" aria-label="下载第 ${index+1} 张图片">${icon('download')}</a>`:''}</div>${page.imageUrl ? outputSizeView(page,p.aspect) : ''}${page.error?`<p class="guide-created-error">${h(page.error)}</p>`:''}</article>`).join('')}</div>`:'';
  const copyActions = `<div class="guide-post-actions guide-creation-actions"><button class="button button-secondary" data-action="guide-copy-result">${icon('copy')}复制文案</button>${downloads}</div>`;
  const copy = p.caption || p.title
    ? `<section class="guide-creation-copy" aria-label="帖子正文"><div class="guide-post-caption"><h4 class="sr-label">帖子正文</h4><p>${h(p.caption || '')}</p></div>${resultReady ? '' : copyActions}</section>`
    : downloads && !resultReady ? `<div class="guide-creation-actions">${downloads}</div>` : '';
  const delivery = guideDeliveryView(p);
  const review = guideContentQualityView(p);
  const error = p.error || c.error ? `<div class="guide-creation-error" role="alert">${h(c.error || p.error)}</div>` : '';
  const statusLabel = `<span class="guide-creation-status ${issue ? 'is-warning' : ''}">${active ? '<span class="spinner spinner-small"></span>' : icon(issue ? 'alert' : 'check')}${h(status)}</span>`;
  const content = resultReady
    ? `<div class="guide-result-tools">${statusLabel}${copyActions}<button class="text-button" type="button" data-action="guide-show-delivery">小红书草稿 ${icon('arrow')}</button></div>
       ${error}${gallery}${delivery}${progress}${copy}${review}`
    : `<div class="guide-creation-header"><div><span class="eyebrow">图文作品</span><h3>${h(p.title || '这次的图文作品')}</h3></div>${statusLabel}</div>
       ${review}${delivery}${progress}${error}${gallery}${copy}`;
  return `<section class="guide-creation" aria-label="创作结果" aria-busy="${active}">${content}${retryActions?`<div class="guide-creation-actions guide-retry-actions">${retryActions}</div>`:''}${canRetry?`<p class="guide-creation-note">${pages.length?'重试只处理未完成的图片，可能产生模型费用。':'重试会重新策划并生成图片，可能产生模型费用。'}</p>`:''}${chat.length||pending?`<div class="guide-project-chat" aria-label="作品修改对话">${chat.map(message=>`<article class="guide-project-message ${message.role==='user'?'user':'assistant'}"><span>${message.role==='user'?'你':'创意编辑'}</span>${guideImageMessageView(message.images||message.referenceImages)}<p>${h(message.content||'')}</p>${message.editXhsCopy&&xhsEligible(p)&&draftCopyProblem(p.title,p.caption)?'<button type="button" class="text-button" data-action="guide-edit-xhs-copy">编辑送稿文案</button>':''}</article>`).join('')}${pending?`<article class="guide-project-message user pending"><span>你 · 请求待确认</span>${guideImageMessageView(last.images)}<p>${h(last.message)}</p></article>`:''}</div>`:''}</section>`;
}

function setGuideProject(project) {
  const c=state.guide.creation;if(!c||!project?.id||(c.projectId&&project.id!==c.projectId))return;
  c.projectId=project.id;c.status=project.status;c.error='';state.guideProject=project;
  state.guide.preferences=guidePreferences(project);
  state.guide.targetPlatform=projectPlatform(project);
  state.guide.referenceImages=normalizeGuideImages(project.referenceImages);
  const last=c.lastChatRequest;
  if(last){const request=project.chatRequests?.find(item=>item.requestId===last.requestId||item.id===last.requestId);if(request)last.status=request.status;else if(project.chatMessages?.some(message=>message.requestId===last.requestId))last.status=guideProjectActive(project)?'running':'completed';if(last.restoredInput&&['running','completed'].includes(last.status)){if(state.guide.input===last.message)state.guide.input='';const sent=new Set(normalizeGuideImages(last.images).map(image=>image.id));state.guide.draftImages=state.guide.draftImages.filter(image=>!sent.has(image.id));last.restoredInput=false;}}
  const index=state.projects.findIndex(item=>item.id===project.id);if(index<0)state.projects.unshift(project);else state.projects[index]=project;
  saveGuidance();
}
async function loadGuideProject({quiet=false}={}) {
  const c=state.guide.creation;if(!c?.projectId)return;
  const version=guideCreationVersion,id=c.projectId;
  try{const {project}=await api(`/api/projects/${encodeURIComponent(id)}`);if(version!==guideCreationVersion||state.guide.creation?.projectId!==id)return;setGuideProject(project);}
  catch(error){if(version!==guideCreationVersion)return;c.error=error.status===404?'这份作品记录已不存在。不会自动重建或调用模型，请检查作品记录或开启新创作。':error.message;if(error.status===404)state.guideProject=null;saveGuidance();}
  if(version===guideCreationVersion){renderGuidance({preserve:true});if(guideProjectActive(state.guideProject))beginGuidePolling();}
}
function beginGuidePolling() {
  clearTimeout(guideProjectPollTimer);const version=++guideProjectPollVersion;
  const run=async()=>{
    const c=state.guide.creation;if(version!==guideProjectPollVersion||!c?.projectId)return;
    const id=c.projectId,previous=state.guideProject;
    try{const {project}=await api(`/api/projects/${encodeURIComponent(id)}`);if(version!==guideProjectPollVersion||state.guide.creation?.projectId!==id)return;setGuideProject(project);renderGuidance({preserve:true});if(guideProjectActive(previous)&&!guideProjectActive(project)){const result=guideCompletionNotice(project);notify(result.message,result.warning);}}
    catch(error){if(version!==guideProjectPollVersion)return;c.error=error.message;if(error.status===404)state.guideProject=null;saveGuidance();renderGuidance({preserve:true});}
    if(version===guideProjectPollVersion&&guideProjectActive(state.guideProject))guideProjectPollTimer=setTimeout(run,1800);
  };
  if(guideProjectActive(state.guideProject))guideProjectPollTimer=setTimeout(run,1200);
}
async function startGuideCreation({command='',retryRequest=false}={}) {
  const g=state.guide;if(state.guideBusy||state.guideActionBusy||guideProjectActive(state.guideProject))return;
  if(g.creation?.projectId)return loadGuideProject();
  if(g.creation)return recoverGuideCreation();
  if(!guidanceReady()||g.error)return notify('先把创作需求补充清楚，我会自动安排风格、比例和张数。',true);
  if((g.draftImages.length||g.input.trim()&&g.input.trim()!==command.trim())&&!retryRequest)return notify('还有未发送的补充，请先发送再生成。',true);
  if(g.selectedTrend&&!guideTrendUsable(g.selectedTrend)){g.selectedTrend=null;g.trendNotice='已选热梗已过 14 天留存期，已移除。请重新选择，或按原主题生成。';saveGuidance();renderGuidance();return notify(g.trendNotice,true);}
  if(!state.config?.configured){g.creationError='需求已整理好。请在模型设置中配置文字和图片模型，回来后告诉我“继续创作”即可。';saveGuidance();renderGuidance();return;}
  const source=guideSourceWithTrend(g);if(source.length>24000)return notify('完整素材加上热点信息超过 24000 字，请精简素材后再生成。原素材会保留。',true);
  const autoDelivery=g.xhsAutoDelivery===true&&!xhsDeliveryReadOnly();
  if(autoDelivery&&!xhsRecordBound(xhsAccountRecord(guideTargetAccountId()))){g.creationError=xhsAccountSetupHint();saveGuidance();renderGuidance();return;}
  const c=g.creation||{requestId:crypto.randomUUID(),projectId:null,status:'submitting',error:'',requestedAt:new Date().toISOString(),capture:{targetPlatform:g.targetPlatform,xhsAutoDelivery:autoDelivery,...(autoDelivery?{xhsAccountId:guideTargetAccountId()||null}:{})}};
  if(command&&!retryRequest){g.messages.push({role:'user',content:command});g.messages=trimGuideMessages(g.messages);g.input='';}
  g.creation=c;g.creationError='';c.error='';state.guideActionBusy='create';const version=++guideCreationVersion;saveGuidance();renderGuidance({focusCreation:true});
  try{const {project}=await api('/api/brief/create',{method:'POST',body:{requestId:c.requestId,source,style:g.preferences.style,aspect:g.preferences.aspect,count:g.preferences.count,mode:g.preferences.mode||'cards',referenceIds:g.referenceImages.map(image=>image.id),targetPlatform:projectPlatform(c.capture||g),xhsAutoDelivery:c.capture?.xhsAutoDelivery===true,...(c.capture?.xhsAutoDelivery===true?{xhsAccountId:c.capture.xhsAccountId}: {})}});if(version!==guideCreationVersion||state.guide!==g)return;setGuideProject(project);}
  catch(error){if(version!==guideCreationVersion)return;if(error.status&&error.status>=400&&error.status<500){g.creation=null;g.creationError=error.message;if(command&&!g.input)g.input=command;}else{c.status='unknown';c.error=`${error.message} 上次请求结果尚未确认，可以使用同一请求编号确认结果，不会重复创建。`;}saveGuidance();}
  finally{if(version===guideCreationVersion){state.guideActionBusy='';renderGuidance({focusCreation:true});beginGuidePolling();}}
}
async function recoverGuideCreation() {
  const c=state.guide.creation;if(!c||state.guideActionBusy)return;
  if(c.projectId)return loadGuideProject();
  const version=guideCreationVersion;state.guideActionBusy='recover';renderGuidance({preserve:true});
  try{const {projects}=await api('/api/projects');if(version!==guideCreationVersion)return;state.projects=projects;const project=projects.find(project=>project.creationRequestId===c.requestId);if(project)setGuideProject(project);else{c.error='作品记录中还未找到上次请求。可以稍后再查询；开启新创作会使用新的生成请求。此次查询没有调用模型。';saveGuidance();}}
  catch(error){if(version===guideCreationVersion){c.error=error.message;saveGuidance();}}
  finally{if(version===guideCreationVersion){state.guideActionBusy='';renderGuidance({focusCreation:true});beginGuidePolling();}}
}

async function sendGuideProjectMessage({message='',retry=false}={}) {
  const g=state.guide,c=g.creation,p=state.guideProject;
  if(!c?.projectId||!p)return notify('先读取这次的作品结果，再发送修改要求。',true);
  if(guideWorkActive()||state.guideBusy)return notify('当前任务正在处理中，完成后再发送修改。');
  if(!retry&&c.lastChatRequest?.status==='unknown'){await loadGuideProject({quiet:true});if(c.lastChatRequest.status==='unknown')return notify('上一条修改的结果尚未确认，请先点击“确认上次修改结果”。当前输入会保留。',true);}
  const previous=retry?c.lastChatRequest:null;
  const images=normalizeGuideImages(previous?.images||(!message&&!retry?g.draftImages:[]));
  const text=(previous?.message||message||g.input||(images.length?'请参考这些产品图片，帮我看看这份作品可以怎么调整。':'')).trim();if(!text)return notify('告诉我想怎么修改这份作品。');if(text.length>6000)return notify('修改要求请控制在 6000 字以内。',true);
  const request=previous||{requestId:crypto.randomUUID(),message:text,images,status:'sending'};request.status='sending';c.lastChatRequest=request;c.error='';
  if(!message&&!retry){g.input='';g.draftImages=[];g.attachmentError='';}
  state.guideActionBusy='chat';const version=guideCreationVersion;saveGuidance();renderGuidance({preserve:true});
  try{const {project}=await api(`/api/projects/${encodeURIComponent(c.projectId)}/chat`,{method:'POST',body:{message:request.message,requestId:request.requestId,...(images.length?{referenceIds:images.map(image=>image.id)}:{})}});if(version!==guideCreationVersion||state.guide!==g)return;request.status='running';setGuideProject(project);}
  catch(error){if(version!==guideCreationVersion)return;request.status=error.status&&error.status>=400&&error.status<500?'error':'unknown';c.error=error.message;if(!g.input&&!message){g.input=text;g.draftImages=mergeGuideImages(images,g.draftImages).slice(0,GUIDE_IMAGE_LIMIT);request.restoredInput=true;}saveGuidance();}
  finally{if(version===guideCreationVersion){state.guideActionBusy='';renderGuidance({preserve:true});beginGuidePolling();if(request.status==='unknown')loadGuideProject({quiet:true});}}
}
function resetGuideConversation({confirmExisting=true}={}) {
  if(state.guideBusy||guideWorkActive()){state.view='briefing';renderGuidance({preserve:true});notify('这次创作正在处理中，完成后再开启新创作。');return false;}
  const g=state.guide;
  if(confirmExisting&&(g.messages.length||g.input.trim()||g.draftImages.length||g.creation)&&!confirm(g.creation&&!g.creation.projectId?'上次生成请求的结果还未确认，旧任务可能仍在处理。开启新创作后再次生成将是新的请求。确认开启？当前对话会清空，已有作品保留。':'开启新的创作对话？当前未发送的文字和图片会清空，已有作品会保留在作品记录中。'))return false;
  ++guideRequestVersion;++guideCreationVersion;++guideProjectPollVersion;clearTimeout(guideProjectPollTimer);state.guide=blankGuidance();state.guideProject=null;state.guideEdit=null;state.guideActionBusy='';resetGuideStyleFilters();state.view='briefing';saveGuidance();renderGuidance();loadXhs({quiet:true});return true;
}
async function resumeProjectInGuide(id) {
  if(state.guide.creation?.projectId===id){state.view='briefing';renderGuidance({preserve:true});await loadGuideProject({quiet:true});return;}
  if(state.guideBusy||guideWorkActive())return notify('先等待当前创作任务完成，再继续另一份作品。');
  const existing=state.guide;if((existing.messages.length||existing.input.trim()||existing.draftImages.length||existing.creation)&&!confirm('在对话中继续这份作品？当前对话及未发送的文字和图片会替换，作品记录会保留。'))return;
  const {project}=await api(`/api/projects/${encodeURIComponent(id)}`);
  ++guideCreationVersion;++guideRequestVersion;++guideProjectPollVersion;clearTimeout(guideProjectPollTimer);
  const g=blankGuidance();g.source=project.source||'';g.analysis='已载入作品，直接告诉我想改哪里即可。';g.preferences=guidePreferences(project);g.recommendations={...g.recommendations,...g.preferences};g.creation={projectId:project.id,requestId:isGuideUuid(project.creationRequestId)?project.creationRequestId:crypto.randomUUID(),status:project.status,error:'',requestedAt:project.createdAt};
  state.guide=g;state.guideProject=null;state.guideEdit=null;state.view='briefing';setGuideProject(project);renderGuidance({focusCreation:true});beginGuidePolling();await loadXhs({quiet:true});
}

function guideTrendUrl(value) {
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:'';}catch{return '';}
}
function normalizeGuideTrendMatches(value) {
  if(!value||!['matched','none','unavailable','error','disabled'].includes(value.status))return null;
  const text=(input,max)=>typeof input==='string'?input.slice(0,max).trim():'';
  const date=input=>typeof input==='string'&&Number.isFinite(Date.parse(input))?input:null;
  const seen=new Set();
  const matches=(Array.isArray(value.matches)?value.matches:[]).slice(0,3).flatMap(item=>{
    if(!item||typeof item.id!=='string'||!item.id||item.id.length>200||seen.has(item.id)||!['weibo','douyin','xiaohongshu'].includes(item.platform))return [];
    const title=text(item.title,300),reason=text(item.reason,1200),angle=text(item.angle,1800);
    if(!title||!reason||!angle)return [];
    seen.add(item.id);
    return [{id:item.id,title,platform:item.platform,url:guideTrendUrl(item.url),rank:Number.isInteger(item.rank)&&item.rank>0?item.rank:null,
      heat:typeof item.heat==='number'?item.heat:text(item.heat,100),fetchedAt:date(item.fetchedAt),sourceUpdatedAt:date(item.sourceUpdatedAt),provider:text(item.provider,100),kind:item.kind==='meme'||item.category==='meme'?'meme':'hot',firstSeenAt:date(item.firstSeenAt),expiresAt:date(item.expiresAt),lastSeenAt:date(item.lastSeenAt),inCurrentBoard:item.inCurrentBoard===true,reason,angle}];
  });
  return {status:value.status==='matched'&&!matches.length?'none':value.status,checkedAt:date(value.checkedAt),candidateCount:Math.max(0,Number(value.candidateCount)||0),excludedCount:Math.max(0,Number(value.excludedCount)||0),matches:value.status==='matched'?matches:[],message:text(value.message,1500)};
}
function guideTrendUsable(item) {
  return item?.kind!=='meme'||Boolean(item.expiresAt&&Number.isFinite(Date.parse(item.expiresAt))&&Date.parse(item.expiresAt)>Date.now());
}
function guideTrendDate(value) {
  return value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'未知';
}
function guideTrendMatchesView() {
  const g=state.guide,result=g.trendMatches;
  const canMatch=g.matchTrends&&guideTextReady()&&!state.guideBusy;
  const rematch=canMatch?`<button class="text-button" data-action="guide-trend-rematch">${icon('refresh')}重新匹配</button>`:'';
  if(!g.matchTrends)return `<section class="guide-trend-matches is-disabled"><p>已关闭热点匹配，继续按你的原主题创作。</p></section>`;
  const status=result?.status;
  const defaults={none:'暂未发现与这个主题贴合的热点，可以继续按原主题创作。',unavailable:'暂时没有可用于匹配的新近榜单。可以先更新热点，或直接按原主题继续。',error:'这次热点匹配未完成，原主题分析已保留，可以继续创作。',disabled:'这次未匹配热点，可以按原主题继续。'};
  if(status!=='matched'||!result.matches.length){
    return `<section class="guide-trend-matches guide-trend-empty" aria-label="相关热点匹配"><div class="guide-trend-heading"><div><span class="section-index">A LITTLE OF THE NOW</span><h3>找一点相关的当下</h3></div>${rematch}</div><p>${h(result?.message||defaults[status]||'这段对话还没有匹配热点。可以重新检查当前榜单，也可以按原主题继续。')}</p>${g.trendNotice?`<p class="guide-trend-notice" role="status">${h(g.trendNotice)}</p>`:''}<div class="guide-trend-empty-actions">${['unavailable','error'].includes(status)?'<button class="text-button" data-action="navigate" data-view="trends">去当下热点更新榜单 ↗</button>':''}${!guideTextReady()?'<span>先配置文字模型，才能分析话题相关性。</span>':`<span>${canMatch?'重新匹配会使用一次文字分析。':'不会阻止你继续创作。'}</span>`}</div></section>`;
  }
  return `<section class="guide-trend-matches" aria-label="相关热点推荐"><div class="guide-trend-heading"><div><span class="section-index">A LITTLE OF THE NOW</span><h3>给这个想法，借一点当下</h3></div>${rematch}</div><p class="guide-trend-intro">找到 ${result.matches.length} 个可结合的选题。最多选一个，也可以按原主题继续。</p>${g.trendNotice?`<p class="guide-trend-notice" role="status">${h(g.trendNotice)}</p>`:''}<div class="guide-trend-cards">${result.matches.map(item=>{const selected=g.selectedTrend?.id===item.id,usable=guideTrendUsable(item);return `<article class="guide-trend-card ${selected?'selected':''}" data-guide-trend-id="${h(item.id)}"><div class="guide-trend-card-meta"><span>${h(trendName(item.platform))}${item.rank?` · ${item.kind==='meme'&&!item.inCurrentBoard?'最近采集榜内':'榜内'}第 ${item.rank} 位`:''}</span><span>${!usable?'已过期':selected?'已选中':h(item.provider||'公开热榜')}</span></div><h4>${item.url?`<a href="${h(item.url)}" target="_blank" rel="noopener noreferrer">${h(item.title)} <span>↗</span></a>`:h(item.title)}</h4>${item.kind==='meme'?`<p class="guide-trend-lifetime ${usable?'':'expired'}">热梗候选 · 至 ${guideTrendDate(item.expiresAt)} 有效<br><span>本机首次收录 ${guideTrendDate(item.firstSeenAt)}，保留 14 天；留存不代表持续火爆。</span></p>`:''}<div class="guide-trend-card-time">源更新 ${guideTrendDate(item.sourceUpdatedAt)} · 采集 ${guideTrendDate(item.fetchedAt)}（北京时间）</div><dl><div><dt>为什么相关</dt><dd>${h(item.reason)}</dd></div><div><dt>结合角度</dt><dd>${h(item.angle)}</dd></div></dl><button type="button" class="button ${selected?'button-secondary':'button-primary'} guide-trend-select" data-action="${selected?'guide-trend-clear':'guide-trend-select'}" data-id="${h(item.id)}" aria-pressed="${selected}" ${!usable?'disabled':''}>${!usable?'已过期，请重新匹配':selected?icon('check')+'已选，点击移除':'结合这个热点 '+icon('arrow')}</button></article>`;}).join('')}</div><div class="guide-trend-footer"><button class="text-button" data-action="guide-trend-clear">不结合热点，按原主题继续</button><span>选中不会额外调用模型；生成时只结合你选的一个。</span></div><p class="guide-trend-facts">匹配依据是热榜标题，相关理由与结合角度是创作建议。创作前请核实原内容与热梗语境。</p></section>`;
}
function chooseGuideTrend(id) {
  const g=state.guide;if(state.guideBusy||g.creation||!g.matchTrends)return;
  const match=g.trendMatches?.matches.find(item=>item.id===id);if(!match)return;
  if(!guideTrendUsable(match)){g.trendNotice='这个热梗已满 14 天或缺少有效期，请重新匹配。';saveGuidance();renderGuidance();return;}
  g.selectedTrend={...match};g.trendNotice='已选择这个热点，创作时会结合到你的原主题中。';saveGuidance();renderGuidance({focusTrends:true});
}
function clearGuideTrend() {
  if(state.guideBusy||state.guide.creation)return;
  state.guide.selectedTrend=null;state.guide.trendNotice='这次按原主题继续，不结合热点。';saveGuidance();renderGuidance({focusTrends:true});
}
function guideSourceWithTrend(g) {
  let source=g.source;
  if(g.studioSource&&!source.includes(g.studioSource))source=g.studioSource.includes(source)?g.studioSource:`${source}\n\n【原始素材（完整保留）】\n${g.studioSource}`;
  const selected=g.matchTrends&&g.selectedTrend?g.trendMatches?.matches.find(item=>item.id===g.selectedTrend.id):null;
  if(!selected||!guideTrendUsable(selected))return source;
  return `${source}\n\n【用户已选热点】\n主题：${selected.title}${selected.kind==='meme'?`\n类型：热梗候选；本机首次收录 ${guideTrendDate(selected.firstSeenAt)}，至 ${guideTrendDate(selected.expiresAt)} 有效（北京时间）。14 天是本机留存窗口，不代表持续火爆。`:''}\n平台：${trendName(selected.platform)}${selected.rank?'，'+(selected.kind==='meme'&&!selected.inCurrentBoard?'最近采集榜内':'榜内')+'第 '+selected.rank+' 位':''}\n数据来源：${selected.provider||'公开热榜'}\n源更新时间：${guideTrendDate(selected.sourceUpdatedAt)}（北京时间；未知时需先核实）\n采集时间：${guideTrendDate(selected.fetchedAt)}（北京时间）\n原话题链接：${selected.url||'来源未提供，请先补充原内容'}\n为什么相关：${selected.reason}\n结合角度：${selected.angle}\n素材限制：用户原主题、完整素材与创作目标优先；只把这一个已选热点作为切入点或类比。热榜标题不是完整事实，理由与角度是创作建议，不是事实证据。请先核实原内容、时效和热梗语境，不编造热梗含义、出处、人物、经历或数据；不要加入未选择的热点。以上来源与限制供策划参考，不要直接当成图上文案。`;
}
const guideStyleSearchText = value => String(value||'').normalize('NFKC').toLocaleLowerCase().trim();
function filteredGuideStyles() {
  const query=guideStyleSearchText(state.guideStyleSearch);
  return guideStyles().filter(style=>(state.guideStyleCategory==='all'||style.category===state.guideStyleCategory)&&(!query||guideStyleSearchText([style.name,style.description,style.id,...style.aliases].join(' ')).includes(query)));
}
function guideStyleResultsView() {
  const list=filteredGuideStyles(),g=state.guide;
  if(!list.length)return `<div class="guide-style-empty"><p>没有找到匹配的风格</p><span>试试“摄影”“复古”“3D”，或换个分类。</span><button type="button" class="text-button" data-action="guide-style-clear">清除搜索与分类</button></div>`;
  return `<div class="guide-choices guide-style-choices">${list.map(style=>{
    const selected=style.id===g.preferences.style,recommended=style.id===g.recommendations.style;
    const badge=selected?(recommended?'已选 · 建议':'已选'):recommended?'建议':'';
    return `<button type="button" class="guide-choice guide-style-choice ${selected?'selected':''} ${recommended?'recommended':''}" data-action="guide-choice" data-field="style" data-value="${h(style.id)}" aria-pressed="${selected}" aria-label="${h(style.name)}${selected?'，已选':''}${recommended?'，建议':''}" aria-describedby="guide-style-description-${h(style.id)}"><span class="guide-style-title"><strong>${h(style.name)}</strong>${badge?`<span class="guide-style-badge ${selected?'is-selected':''}">${h(badge)}</span>`:''}</span><small id="guide-style-description-${h(style.id)}">${h(style.description)}</small><span class="guide-style-category">${h(style.category)}</span></button>`;
  }).join('')}</div>`;
}
function guideStyleResultLabel() {
  const total=guideStyles().length,count=filteredGuideStyles().length;
  return count===total?`${total} 种风格，选择后即可继续`:`找到 ${count} / ${total} 种风格`;
}
function guideStylePickerView() {
  const list=guideStyles(),selected=list.find(style=>style.id===state.guide.preferences.style),recommended=list.find(style=>style.id===state.guide.recommendations.style);
  const categories=['all',...STYLE_CATEGORIES];
  return `<div class="guide-style-picker"><div class="guide-style-tools"><div class="guide-style-search"><label class="sr-label" for="guide-style-search">搜索图片风格</label>${icon('search')}<input id="guide-style-search" type="search" maxlength="120" placeholder="搜索风格，例如：摄影、水彩、3D" autocomplete="off" value="${h(state.guideStyleSearch)}" aria-controls="guide-style-results"/></div><p class="guide-style-current">${selected?`已选：<strong>${h(selected.name)}</strong>`:recommended?`建议：<strong>${h(recommended.name)}</strong>`:'选择适合这次内容的画面语言'}</p></div><div class="guide-style-categories" role="group" aria-label="按图片风格分类筛选">${categories.map(category=>{
    const count=category==='all'?list.length:list.filter(style=>style.category===category).length,label=category==='all'?'全部':category;
    return `<button type="button" class="${state.guideStyleCategory===category?'active':''}" data-action="guide-style-category" data-category="${h(category)}" aria-pressed="${state.guideStyleCategory===category}" aria-label="${h(label)}，${count}种风格" ${count?'':'disabled'}>${h(label)}<span aria-hidden="true">${count}</span></button>`;
  }).join('')}</div><p id="guide-style-result-count" class="guide-style-result-count" role="status" aria-live="polite">${guideStyleResultLabel()}</p><div id="guide-style-results" class="guide-style-results">${guideStyleResultsView()}</div><p class="guide-style-hint">也可以直接在对话里描述想要的质感、配色和氛围。</p></div>`;
}
function updateGuideStyleResults() {
  const results=document.querySelector('#guide-style-results');if(!results)return;
  results.innerHTML=guideStyleResultsView();
  const count=document.querySelector('#guide-style-result-count');if(count)count.textContent=guideStyleResultLabel();
  document.querySelectorAll('[data-action="guide-style-category"]').forEach(button=>{
    const active=button.dataset.category===state.guideStyleCategory;
    button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
  });
}
function resetGuideStyleFilters() {state.guideStyleCategory='all';state.guideStyleSearch='';}
function requestedSizeHint(aspect) {
  const size = requestedImageSize(state.config?.image, aspect);
  return size ? `请求 ${size.replace('x', ' × ')} px` : '尺寸由模型决定';
}

function guideQuestionView(field) {
  const g=state.guide, rec=g.recommendations[field];
  const index=['style','aspect','count'].indexOf(field)+1;
  let options;
  if(field==='style')options=guideStylePickerView();
  else if(field==='aspect')options=`<div class="guide-choices guide-aspect-choices">${[['3:4','portrait','竖版图文'],['1:1','square','方形卡片'],['16:9','landscape','横版展示']].map(([value,shape,label])=>`<button class="guide-choice ${value===rec?'recommended':''}" data-action="guide-choice" data-field="aspect" data-value="${value}"><span class="guide-ratio-icon ratio-${shape}" aria-hidden="true"></span><strong>${value}</strong><small>${label} · ${h(requestedSizeHint(value))}</small>${value===rec?'<span class="choice-recommended">建议</span>':''}</button>`).join('')}</div>`;
  else {const counts=[...new Set([1,3,5,6,8,10,Number(rec)])].filter(n=>n>=1&&n<=10).sort((a,b)=>a-b);options=`<div class="guide-count-choices">${counts.map(n=>`<button class="guide-choice ${n===rec?'recommended':''}" data-action="guide-choice" data-field="count" data-value="${n}"><strong>${n} 张</strong>${n===rec?'<span class="choice-recommended">建议</span>':''}</button>`).join('')}</div><div class="guide-custom-count"><label for="guide-custom-count">也可以自定张数</label><input id="guide-custom-count" type="number" min="1" max="10" value="${rec}" aria-label="自定义图片张数"><button class="button button-secondary" data-action="guide-count">确定</button></div>`;}
  return `<section class="guide-question"><span class="section-index">${String(index).padStart(2,'0')} / ${guideFieldLabel(field)}</span><h3>${guideQuestion(field)}</h3><p>${h(g.reasons[field]||'选择你更喜欢的方向，也可以在下面直接告诉我。')}</p>${options}${state.guideEdit?'<button class="text-button" data-action="guide-cancel-edit">保留原选择</button>':''}</section>`;
}
function trimGuideMessages(messages) {
  const limited=messages.length>20?[messages[0],...messages.slice(-19)]:[...messages];
  let total=limited.reduce((n,m)=>n+m.content.length,0);
  while(total>60000&&limited.length>2){total-=limited[1].content.length;limited.splice(1,1);}
  return limited;
}
function renderGuidance({focusTrends=false,focusCreation=false,preserve=false}={}) {
  if(state.view!=='briefing')return;
  const thread=document.querySelector('.guide-thread'),focused=document.activeElement;
  const previousScroll=thread?.scrollTop||0,nearBottom=!thread||thread.scrollHeight-thread.scrollTop-thread.clientHeight<95;
  const wasShowingResult = Boolean(thread?.closest('.is-result'));
  const previousChat=thread?.querySelector('.guide-project-chat')?.textContent||'';
  const inputFocused=focused?.id==='guide-input',focusId=inputFocused||focused?.id==='guide-history-search'||focused?.closest('#guide-xhs-region')?focused?.id:null,selection=typeof focused?.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
  const pageScroll=window.scrollY;
  render();
  if(focusId){const input=document.getElementById(focusId);if(input&&!input.disabled){input.focus({preventScroll:true});if(selection&&input.setSelectionRange)input.setSelectionRange(...selection);}}
  requestAnimationFrame(()=>{
    const next=document.querySelector('.guide-thread');if(!next)return;
    const nextChat=next.querySelector('.guide-project-chat')?.textContent||'';
    const hasNewChat=Boolean(nextChat.trim())&&nextChat!==previousChat;
    const showResultStart = next.closest('.is-result') &&
      (focusCreation || (!wasShowingResult && !state.guide.creation?.lastChatRequest));
    if(showResultStart)next.scrollTop=0;
    else if(preserve&&(inputFocused||!nearBottom||(state.guide.creation&&!hasNewChat)))next.scrollTop=previousScroll;
    else{
      let target=focusTrends?next.querySelector('.guide-trend-matches'):next.querySelector('.guide-style-picker')?.closest('.guide-question');
      if(focusCreation&&!focusTrends){
        const preferences=next.querySelector('.guide-inline-brief');
        const replies=next.querySelectorAll('.guide-message.assistant');
        const reply=replies[replies.length-1];
        target=preferences||next.querySelector('.guide-creation');
        if(reply&&preferences&&preferences.getBoundingClientRect().top-reply.getBoundingClientRect().top<220)target=reply;
      }
      if(target&&next.scrollHeight>next.clientHeight+4)next.scrollTop+=target.getBoundingClientRect().top-next.getBoundingClientRect().top-18;
      else next.scrollTop=next.scrollHeight;
    }
    if(preserve)window.scrollTo(window.scrollX,pageScroll);
  });
}
async function sendGuidance({retry=false,rematch=false}={}) {
  if(state.guideUploadBusy||state.guideBusy||state.guideActionBusy)return;
  const g=state.guide;
  if(g.creation){if(rematch)return notify('这次作品已开始创作。需要改动时，直接在对话里说明即可。');return sendGuideProjectMessage();}
  if(!guideTextReady())return notify('请先配置文字模型，然后回来开始创作对话。',true);
  const input=g.input.trim(),previousDecision=g.decision;
  if(rematch){
    if(input||g.draftImages.length)return notify('还有未发送的补充，请先发送，再重新匹配热点。',true);
    if(!g.source.trim())return notify('请先说说你想创作什么，再匹配相关热点。');
    if(!g.messages.length)g.messages.push({role:'user',content:g.source});
    g.matchTrends=true;g.messages.push({role:'user',content:'请保留当前创作主题、完整素材和已确认的风格、比例、张数，重新检查当前榜单里有没有适合自然结合的热点。只推荐相关内容，不要为了热点改变主题。这是一次更新热点建议的操作，保留已有的需求问题，不把它当作我对问题的回答。'});
  }else if(!retry){
    const images=normalizeGuideImages(g.draftImages);
    if(!input&&!images.length)return notify('先写下想法，或把产品图片粘贴进来。');
    const references=mergeGuideImages(g.referenceImages,images);
    if(references.length>GUIDE_IMAGE_LIMIT)return notify(`这次创作最多使用 ${GUIDE_IMAGE_LIMIT} 张产品图片。`,true);
    g.referenceImages=references;
    g.messages.push({role:'user',content:input||'请结合这些产品图片，帮我规划一组宣传图文。',...(images.length?{images}:{})});
    g.input='';g.draftImages=[];g.attachmentError='';
  }
  if(g.messages.at(-1)?.role!=='user')return;
  const messages=trimGuideMessages(g.messages);g.messages=messages;const preferences={...g.preferences};
  g.error='';g.creationError='';g.pending=true;state.guideBusy=true;state.guideEdit=null;
  let shouldCreate=false;const version=++guideRequestVersion;saveGuidance();renderGuidance();
  try{
    const result=await api('/api/brief/chat',{method:'POST',body:{messages,preferences,targetPlatform:g.targetPlatform,matchTrends:g.matchTrends,clarificationAsked:g.clarificationAsked,referenceIds:g.referenceImages.map(image=>image.id)}});
    if(version!==guideRequestVersion)return;
    if(typeof result.analysis!=='string'||typeof result.source!=='string'||!result.source.trim()||!result.recommendations)throw new Error('分析结果不完整，请重试。');
    let decision=normalizeGuideDecision(result.decision);
    if(!decision)throw new Error('分析结果缺少有效的下一步安排，请重试这次分析。');
    if(rematch)decision=previousDecision||{...decision,action:'hold',questions:[]};
    g.analysis=result.analysis;g.source=result.source;g.preferences=guidePreferences(result.preferences);g.recommendations={...blankGuidance().recommendations,...result.recommendations};g.reasons=result.reasons||{};g.decision=decision;
    const previousTrend=g.selectedTrend;
    g.trendMatches=normalizeGuideTrendMatches(result.trendMatches)||{status:g.matchTrends?'unavailable':'disabled',checkedAt:null,candidateCount:0,excludedCount:0,matches:[],message:g.matchTrends?'这次没有收到热点匹配结果，可以按原主题继续，或稍后重新匹配。':'已关闭热点匹配，将按原主题继续。'};
    g.selectedTrend=g.matchTrends&&previousTrend?g.trendMatches.matches.find(item=>item.id===previousTrend.id&&guideTrendUsable(item))||null:null;
    g.trendNotice=previousTrend&&!g.selectedTrend?'主题分析已更新，之前选择的热点不再出现在匹配结果中，已移除。你可以重新选择或按原主题继续。':'';
    if(rematch)g.messages.push({role:'assistant',content:'已更新相关热点建议，可以展开“创作方向与偏好”查看。继续补充创作需求即可，是否结合热点由你决定。'});
    else if(decision.action==='ask'){
      g.clarificationAsked=true;
      g.messages.push({role:'assistant',kind:'clarification',content:[result.reply||'我先把需要补充的信息一起列出来：',...decision.questions.map((q,index)=>`${index+1}. ${q.question}`),'一次回复即可；拿不准的风格、比例和张数可以说“你定”。回答后，我会直接生成完整图文。'].join('\n\n')});
    }else if(decision.action==='generate'&&!rematch){
      g.preferences={...decision.resolvedSpec};
      g.messages.push({role:'assistant',content:[result.reply||decision.summary||'创作方向已经清楚，我来完成帖子文案和整组图片。',`本次采用：${guideValueLabel('style',g.preferences.style)} · ${guideValueLabel('aspect',g.preferences.aspect)} · ${guideValueLabel('count',g.preferences.count)}。现在开始创作。`].join('\n\n')});
      shouldCreate=true;
    }else g.messages.push({role:'assistant',content:result.reply||'已记下你的想法。继续在这里补充，准备好后我会接着创作。'});
    g.messages=trimGuideMessages(g.messages);
  }catch(error){if(version===guideRequestVersion)g.error=error.message;}
  finally{if(version===guideRequestVersion){g.pending=false;state.guideBusy=false;saveGuidance();renderGuidance();}}
  // Only a freshly validated response can start paid work. Restoring the saved
  // conversation or polling an existing project never crosses this transition.
  if(version===guideRequestVersion&&state.guide===g&&shouldCreate)await startGuideCreation();
}

function chooseGuidePreference(field,value) {
  if(state.guideBusy)return;
  const g=state.guide;
  if(!g.analysis)return;
  const parsed=guidePreferences({...g.preferences,[field]:field==='count'?Number(value):value});
  if(!['style','aspect','count'].includes(field)||parsed[field]===null)return notify('请选择支持的风格、比例或 1–10 张图片。',true);
  g.preferences=parsed;g.error='';state.guideEdit=null;
  if(field==='style')resetGuideStyleFilters();
  g.decision=null;
  g.messages.push({role:'user',content:`${guideFieldLabel(field)}：${guideValueLabel(field,parsed[field])}`},{role:'assistant',content:`已记下「${guideValueLabel(field,parsed[field])}」。把其余补充一起发给我就好。`});
  g.messages=trimGuideMessages(g.messages);saveGuidance();renderGuidance();
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, ...(options.body !== undefined ? {body: JSON.stringify(options.body)} : {}) });
  } catch { throw new Error('无法连接本地服务，请确认工作台服务正在运行。'); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok){const error=new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message || `请求失败（${response.status}）`);error.status=response.status;throw error;}
  return payload;
}
function notify(message, error = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `toast ${error ? 'toast-error' : ''}`;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, error ? 6500 : 3500);
}
const ADMIN_PAGES = {
  briefing:{title:'创作对话',group:'内容创作',description:'提交需求、补充信息，生成并修改图文内容。',icon:'file'},
  radar:{title:'选题雷达',group:'内容创作',description:'管理产品资料、定时选题与待审核提案。',icon:'search'},
  trends:{title:'当下热点',group:'内容创作',description:'查看平台热榜、热梗与关注词，筛选可用选题。',icon:'chart'},
  xhs:{title:'账号管理',group:'账号与内容',description:'查看小红书账号、内容表现和草稿。',icon:'grid'},
  history:{title:'作品记录',group:'账号与内容',description:'查找作品，查看生成状态并继续编辑。',icon:'history'},
  dingtalk:{title:'钉钉接入',group:'系统管理',description:'配置机器人凭证、消息范围与连接状态。',icon:'bolt'},
  settings:{title:'模型设置',group:'系统管理',description:'配置文本与图片模型的 API 地址、密钥和模型。',icon:'settings'},
};
function restoreAdminSidebar() {
  try{return localStorage.getItem('content-studio:admin-sidebar:v2')==='1';}catch{return false;}
}
function restoreAdminVisited() {
  try{const tabs=JSON.parse(sessionStorage.getItem('content-studio:admin-pages:v2')||'[]');return ['briefing',...new Set((Array.isArray(tabs)?tabs:[]).filter(view=>['radar','trends','xhs','history','dingtalk','settings'].includes(view)))];}catch{return ['briefing'];}
}
function rememberAdminView() {
  if(!state.adminVisited.includes(state.view))state.adminVisited.push(state.view);
  try{sessionStorage.setItem('content-studio:admin-pages:v2',JSON.stringify(state.adminVisited));}catch{}
}
function adminTabItems() {
  return state.adminVisited.filter(view=>ADMIN_PAGES[view]).map(view=>`<div class="admin-page-tab ${view===state.view?'is-active':''}"><button type="button" data-action="admin-tab-navigate" data-view="${view}" aria-label="切换页面：${ADMIN_PAGES[view].title}" ${view===state.view?'aria-current="page"':''}>${view==='briefing'?icon('file'):''}${ADMIN_PAGES[view].title}</button>${view!=='briefing'?`<button type="button" class="admin-tab-close" data-action="admin-tab-close" data-view="${view}" aria-label="关闭${ADMIN_PAGES[view].title}页面">${icon('close')}</button>`:''}</div>`).join('');
}
function sidebar() {
  const groups=[['内容工作台',['briefing','radar','trends']],['账号与资产',['xhs','history']],['系统配置',['dingtalk','settings']]];
  return `<aside id="admin-navigation" class="site-header admin-sidebar" aria-label="工作区导航"><a href="#" class="brand" data-action="navigate" data-view="briefing" aria-label="图文工坊首页"><span class="brand-glyph" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="admin-brand-copy">图文工坊<small>内容运营工作台</small></span></a><nav class="main-nav" aria-label="主要导航">${groups.map(([group,views])=>`<div class="admin-nav-group"><div class="admin-nav-heading">${group}</div>${views.map(view=>{const page=ADMIN_PAGES[view];return `<button class="nav-item ${state.view===view?'active':''}" data-action="navigate" data-view="${view}" aria-label="${page.title}" title="${page.title}" ${state.view===view?'aria-current="page"':''}>${icon(page.icon)}<span class="nav-full-label">${page.title}</span>${view==='history'&&state.projects.length?`<span class="nav-count">${state.projects.length}</span>`:''}</button>`;}).join('')}</div>`).join('')}</nav><div class="admin-sidebar-footer"><span class="admin-status-dot"></span><span>本地工作区</span>${icon('lock')}</div></aside><button class="admin-nav-backdrop" type="button" data-action="admin-menu-close" aria-label="关闭导航菜单" tabindex="-1"></button>${adminTopbar()}<nav class="admin-page-tabs" aria-label="已打开页面">${adminTabItems()}</nav>`;
}
function adminTopbar() {
  const page=ADMIN_PAGES[state.view]||ADMIN_PAGES.briefing;
  const canReset=state.view==='briefing'&&(state.guide.creation||state.guide.messages.length||state.guide.draftImages.length);
  const menuIcon='<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
  return `<div class="admin-topbar"><div class="admin-topbar-start"><button class="admin-menu-toggle icon-button" type="button" data-action="admin-menu-toggle" aria-label="打开导航菜单" aria-expanded="${Boolean(state.adminMenuOpen)}" aria-controls="admin-navigation">${menuIcon}</button><button class="admin-sidebar-toggle icon-button" type="button" data-action="admin-sidebar-collapse" aria-label="${state.adminSidebarCollapsed?'展开侧边栏':'收起侧边栏'}" aria-expanded="${!state.adminSidebarCollapsed}" aria-controls="admin-navigation">${menuIcon}</button><nav class="admin-breadcrumb" aria-label="当前位置"><span>${page.group}</span><span aria-hidden="true">/</span><strong>${page.title}</strong></nav></div><div class="admin-topbar-actions">${canReset?`<button type="button" class="header-new button button-secondary" data-action="guide-new" aria-label="新建对话" ${guideWorkActive()||state.guideBusy?'disabled':''}>${icon('plus')}<span class="header-new-label">新建对话</span></button>`:''}<span class="admin-environment"><i></i>本地运行</span><span class="admin-user"><span class="avatar" aria-hidden="true">我</span><span>本地用户</span></span></div></div>`;
}
function toggleAdminSidebar() {
  state.adminSidebarCollapsed=!state.adminSidebarCollapsed;
  document.querySelector('.app-shell')?.classList.toggle('admin-sidebar-collapsed',state.adminSidebarCollapsed);
  const toggle=document.querySelector('[data-action="admin-sidebar-collapse"]');
  toggle?.setAttribute('aria-expanded',String(!state.adminSidebarCollapsed));
  toggle?.setAttribute('aria-label',state.adminSidebarCollapsed?'展开侧边栏':'收起侧边栏');
  try{localStorage.setItem('content-studio:admin-sidebar:v2',state.adminSidebarCollapsed?'1':'0');}catch{}
}
function toggleAdminMenu(open=!state.adminMenuOpen) {
  state.adminMenuOpen=Boolean(open);
  document.querySelector('.app-shell')?.classList.toggle('admin-menu-open',state.adminMenuOpen);
  const toggle=document.querySelector('[data-action="admin-menu-toggle"]');
  toggle?.setAttribute('aria-expanded',String(state.adminMenuOpen));
  toggle?.setAttribute('aria-label',state.adminMenuOpen?'关闭导航菜单':'打开导航菜单');
  if(state.adminMenuOpen)document.querySelector('.main-nav .nav-item.active')?.focus({preventScroll:true});
  else toggle?.focus({preventScroll:true});
}
async function navigateAdminPage(view,xhsRoute) {
  if(!Object.hasOwn(ADMIN_PAGES,view))return;
  if(state.adminMenuOpen)toggleAdminMenu(false);
  if(view!=='trends')state.trendsSettingsOpen=false;
  const prev=state.view;
  if(prev==='xhs'&&view!=='xhs'){state.xhsPublished=null;resetXhsAccountActivity();}
  state.view=view;const url=new URL(location.href);
  if(view==='xhs')applyXhsRoute(xhsRoute||xhsAccountRoute('','overview'));
  if(view==='xhs'&&state.xhsRoute.accountId){
    url.searchParams.set('accountId',state.xhsRoute.accountId);url.searchParams.set('tab',state.xhsRoute.tab);
  }else{url.searchParams.delete('accountId');url.searchParams.delete('tab');}
  if(view==='briefing')url.searchParams.delete('view');else url.searchParams.set('view',view);
  if(!EMBEDDED_MODE&&!embeddedParentNavigationDepth&&prev!==view&&view==='xhs')window.history.pushState({},'',url);
  else window.history.replaceState({},'',url);
  render();
  if(view==='history')await refreshHistory();
  if(view==='trends')await loadTrends();
  if(view==='radar')await loadRadar();
  if(view==='dingtalk')await loadDingtalk({quiet:Boolean(state.dingtalk)});
  if(view==='xhs')await loadXhsWorkspace();
  if(view==='briefing')await loadXhs({quiet:true});
}
async function closeAdminTab(view) {
  if(view==='briefing'||!state.adminVisited.includes(view))return;
  const index=state.adminVisited.indexOf(view);state.adminVisited=state.adminVisited.filter(item=>item!==view);
  if(state.view===view)await navigateAdminPage(state.adminVisited[Math.max(0,index-1)]||'briefing');
  else{try{sessionStorage.setItem('content-studio:admin-pages:v2',JSON.stringify(state.adminVisited));}catch{}const tabs=document.querySelector('.admin-page-tabs');if(tabs)tabs.innerHTML=adminTabItems();}
  document.querySelector('.admin-page-tabs [aria-current="page"]')?.focus({preventScroll:true});
}

function header() {
  const page=ADMIN_PAGES[state.view]||ADMIN_PAGES.briefing;
  const modelReady=state.view==='trends'?Boolean(state.trends?.items?.length):['briefing','radar'].includes(state.view)?guideTextReady():state.config?.configured;
  let status=`<span class="connection ${modelReady?'connected':''}"><i></i>${state.view==='trends'?'公开热榜':modelReady?'模型已配置':'待配置模型'}</span>`;
  if(state.view==='xhs')status='';
  if(state.view==='dingtalk')status=`<span id="dingtalk-header-connection" class="connection ${dingtalkConnected()?'connected':''}"><i></i>${dingtalkConnected()?'Stream 已连接':'待连接钉钉'}</span>`;
  const create=['history','trends'].includes(state.view)?`<button class="button button-primary" data-action="new">${icon('plus')}新建创作</button>`:'';
  return `<header class="page-header"><div><h1>${page.title}</h1><p>${page.description}</p></div><div class="header-actions">${status}${create}</div></header>`;
}
function postEmbeddedMessage(message) {
  if(EMBEDDED_MODE)window.parent.postMessage(message,location.origin);
}
function notifyEmbeddedView() {
  if(!EMBEDDED_MODE||lastEmbeddedView===state.view)return;
  const first=!lastEmbeddedView;lastEmbeddedView=state.view;
  if(!first&&embeddedParentNavigationDepth===0&&state.view==='xhs'&&state.xhsRoute.accountId){
    postEmbeddedMessage({type:'content-studio:xhs-route',view:'xhs',...state.xhsRoute});return;
  }
  if(first||embeddedParentNavigationDepth===0)postEmbeddedMessage({type:first?'content-studio:ready':'content-studio:navigate',view:state.view});
}
// Suppress only the synchronous render caused by a parent route request.
// User navigation during the subsequent GET remains observable by the shell.
function navigateFromEmbeddedParent(view,route) {
  embeddedParentNavigationDepth++;
  try{return navigateAdminPage(view,route);}finally{embeddedParentNavigationDepth--;}
}
function embeddedRequestId(value) {
  if(typeof value==='string')return {requestId:value.slice(0,120)};
  return Number.isSafeInteger(value)&&value>=0?{requestId:value}:{};
}
async function refreshEmbeddedView(view) {
  if(view!==state.view)return;
  if(view==='xhs')return loadXhsWorkspace();
  if(view==='dingtalk')return loadDingtalk({quiet:true});
  if(view==='trends')return loadTrends({quiet:true});
  if(view==='radar')return loadRadar({quiet:true});
  if(view==='history')return refreshHistory();
  if(view==='settings'){
    captureSettingsDraft();const payload=await api('/api/config');state.config=payload.config||payload;
    if(state.view==='settings')render();return;
  }
  if(view==='briefing'){
    await loadXhs({quiet:true,refreshProjects:true});
    if(state.view==='briefing'&&state.guide.creation?.projectId)await loadGuideProject({quiet:true});
  }
}
window.addEventListener('message',async event=>{
  if(!EMBEDDED_MODE||event.origin!==location.origin||event.source!==window.parent)return;
  const data=event.data;
  if(!data||typeof data!=='object'||!['content-studio:set-view','content-studio:refresh-view'].includes(data.type)||typeof data.view!=='string'||!Object.hasOwn(ADMIN_PAGES,data.view))return;
  const requestId=embeddedRequestId(data.requestId);
  if(state.guideUploadBusy||state.radarUploadBusy){postEmbeddedMessage({type:'content-studio:navigate',view:state.view});postEmbeddedMessage({type:'content-studio:view-ready',view:state.view,...requestId,rejected:true});return;}
  const version=++embeddedNavigationVersion;
  try{
    const route=data.view==='xhs'?xhsAccountRoute(data.accountId,data.tab):null;
    if(route&&state.view==='xhs')setXhsRoute(route,false);
    if(data.type==='content-studio:refresh-view')await refreshEmbeddedView(data.view);
    else if(state.view!==data.view)await navigateFromEmbeddedParent(data.view,route);
    if(version===embeddedNavigationVersion)postEmbeddedMessage({type:'content-studio:view-ready',view:state.view,...requestId});
  }catch(error){if(version===embeddedNavigationVersion){notify(error.message,true);postEmbeddedMessage({type:'content-studio:view-ready',view:state.view,...requestId});}}
});
function render() {
  captureSettingsDraft();if(!EMBEDDED_MODE)rememberAdminView();
  const tabFocus=document.activeElement?.closest('.admin-page-tabs [data-view]')?.dataset.view;
  const menuFocus=state.adminMenuOpen?document.activeElement?.closest('.main-nav [data-view]')?.dataset.view:null;
  if(state.xhsDetail)closeXhsDetail({restoreFocus:false});
  if(state.view!=='xhs'&&state.xhsBusy==='draft')++xhsDraftRequestVersion;
  if(state.view!=='trends')clearTimeout(trendsPollTimer);
  if(state.view!=='radar')clearTimeout(radarPollTimer);
  if(state.view!=='dingtalk')clearTimeout(dingtalkPollTimer);
  if(!['xhs','briefing'].includes(state.view))clearTimeout(xhsPollTimer);
  app.innerHTML = `<div class="app-shell view-${state.view} ${EMBEDDED_MODE?'is-embedded':''} ${state.adminMenuOpen?'admin-menu-open':''} ${state.adminSidebarCollapsed?'admin-sidebar-collapsed':''}">${EMBEDDED_MODE?'':sidebar()}<main class="main">${header()}${state.bootError ? `<div class="banner banner-error">${icon('alert')}<span>${h(state.bootError)}</span><button class="text-button" data-action="reload">重试连接</button></div>` : ''}${state.view === 'briefing' ? guidanceView() : state.view === 'radar' ? radarView() : state.view === 'xhs' ? xhsView() : state.view === 'dingtalk' ? dingtalkView() : state.view === 'trends' ? trendsView() : state.view === 'history' ? historyView() : settingsView()}<footer class="main-footer"><span>图文工坊 <i>©</i> ${new Date().getFullYear()}</span><span>一个给好内容的创作空间。</span><span>MADE FOR YOUR NEXT IDEA.</span></footer></main></div>`;
  restoreSettingsDraft();notifyEmbeddedView();
  if(state.adminMenuOpen)document.querySelector(`.main-nav [data-view="${menuFocus||state.view}"]`)?.focus({preventScroll:true});
  else if(tabFocus)document.querySelector(`.admin-page-tabs [data-action="admin-tab-navigate"][data-view="${state.view}"]`)?.focus({preventScroll:true});
}
const DINGTALK_STATES = {disconnected:'尚未连接',connecting:'正在连接 Stream',connected:'Stream 已连接',reconnecting:'正在重新连接',error:'连接需要处理',not_configured:'等待配置',stopped:'连接已停止'};
const DINGTALK_STAGES = {idle:'等待需求',clarifying:'等待补充信息',generating:'正在生成图文',completed:'图文已完成',partial:'部分图片未完成',interrupted:'任务已中断',error:'任务需要处理'};
const DINGTALK_DELIVERIES = {pending:'等待回传',sending:'正在回传',accepted:'钉钉已接收',partial:'部分图片未回传',failed:'回传失败',unknown:'回传结果待核实'};
const dingtalkConnected = () => state.dingtalk?.status?.state==='connected';
const dingtalkWorking = () => Boolean(state.dingtalkBusy||state.dingtalk?.status?.busy);
const dingtalkDate = value => value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'暂无';
const dingtalkProjectId = value => typeof value==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(value)?value:'';
function dingtalkDraftFromConfig(config={}) {
  return {clientId:config.clientId||'',clientSecret:'',robotCode:config.robotCode||'',corpId:config.corpId||'',allowedUserIds:(config.allowedUserIds||[]).join('\n'),matchTrends:config.matchTrends!==false,groupEnabled:config.groupEnabled===true,clearSecret:false};
}
function dingtalkView() {
  if(!state.dingtalk)return `<section id="dingtalk-page" class="dingtalk-page"><div class="panel dingtalk-loading" role="status">${state.dingtalkLoading?'<span class="spinner"></span>':''}<h2>${state.dingtalkError?'暂时没有读到钉钉配置':'正在准备钉钉接入'}</h2><p>${h(state.dingtalkError||'读取本地配置与连接状态…')}</p>${state.dingtalkError?'<button class="button button-secondary" data-action="dingtalk-reload">重新读取</button>':''}</div></section>`;
  const draft=state.dingtalkDraft||(state.dingtalkDraft=dingtalkDraftFromConfig(state.dingtalk.config)),config=state.dingtalk.config;
  return `<section id="dingtalk-page" class="dingtalk-page" aria-label="钉钉接入设置"><div id="dingtalk-status-region" aria-live="polite">${dingtalkStatusView()}</div><div class="dingtalk-layout"><section class="panel dingtalk-config-panel"><div class="dingtalk-section-heading"><div><span class="eyebrow">ONE CONVERSATION. THE WHOLE WORKFLOW.</span><h2>连接你的钉钉机器人</h2></div><span id="dingtalk-scope-label" class="dingtalk-scope-tag">${config.groupEnabled===true?'私聊 · 群聊 @':'私聊已启用'}</span></div><p class="dingtalk-intro">保存应用凭证，再手动开启连接。原有网页创作、作品记录和小红书送稿继续保留。</p><form id="dingtalk-config-form" autocomplete="off"><fieldset class="dingtalk-fields"><legend class="sr-label">钉钉应用配置</legend><div class="dingtalk-field-pair"><div><label for="dingtalk-client-id">Client ID / AppKey</label><input id="dingtalk-client-id" name="clientId" value="${h(draft.clientId)}" placeholder="企业内部应用的 AppKey" autocomplete="off" maxlength="200" required></div><div><label for="dingtalk-robot-code">Robot Code</label><input id="dingtalk-robot-code" name="robotCode" value="${h(draft.robotCode)}" placeholder="机器人 RobotCode" autocomplete="off" maxlength="200" required></div></div><div class="dingtalk-secret-label"><label for="dingtalk-client-secret">Client Secret / AppSecret</label><span id="dingtalk-secret-status">${config.hasSecret?'凭证已保存':'尚未保存凭证'}</span></div><input id="dingtalk-client-secret" name="clientSecret" type="password" value="${h(draft.clientSecret)}" placeholder="${config.hasSecret?'留空保留现有凭证；填写则替换':'输入应用的 AppSecret'}" autocomplete="new-password" maxlength="500" spellcheck="false"><p class="field-help">凭证由本地服务保存，不会回显，也不写入浏览器存储。</p><label id="dingtalk-clear-secret-label" class="dingtalk-check dingtalk-clear-secret" ${config.hasSecret?'':'hidden'}><input type="checkbox" name="clearSecret" ${draft.clearSecret?'checked':''}>清除已保存的 Secret</label><label for="dingtalk-corp-id">组织 CorpId</label><input id="dingtalk-corp-id" name="corpId" value="${h(draft.corpId)}" placeholder="应用所属组织的 CorpId" autocomplete="off" maxlength="200" required><label for="dingtalk-allowed-users">允许使用的成员 UserID</label><textarea id="dingtalk-allowed-users" name="allowedUserIds" rows="3" maxlength="6000" placeholder="先填写自己的员工 UserID，每行一个" required>${h(draft.allowedUserIds)}</textarea><p class="field-help">填写同一组织内的员工 UserID，不是昵称或手机号。首期建议只添加自己，其他成员消息不会触发生成。</p><label class="dingtalk-check dingtalk-group-option"><input id="dingtalk-group-enabled" type="checkbox" name="groupEnabled" ${draft.groupEnabled?'checked':''}><span>允许在群聊中创作（需 @ 机器人）<small>只处理上方已授权成员的群内 @ 消息，文案和图片回复到原群。每个群、每位成员的创作分开保存。</small></span></label><p class="field-help dingtalk-group-help">先将应用机器人加入同组织内部群，并确认应用可见范围包含自己。保存配置后重新连接；每次发需求、补充信息或改稿都需要 @。</p><label class="dingtalk-check dingtalk-trends-option"><input type="checkbox" name="matchTrends" ${draft.matchTrends?'checked':''}><span>为创作需求匹配相关热点<small>沿用平台现有热点资料，找到相关选题时一起参考。</small></span></label></fieldset><div class="dingtalk-save-row"><span id="dingtalk-draft-state" role="status">${state.dingtalkDirty?'有未保存的修改':'使用本地已保存配置'}</span><button type="submit" id="dingtalk-save" class="button button-primary">${icon('check')}保存配置</button></div><p class="dingtalk-save-help">保存不会自动连接。修改已连接应用的配置后，请重新开启连接。</p></form></section><aside class="dingtalk-guide"><section class="panel dingtalk-setup-panel"><div class="dingtalk-section-heading"><div><span class="eyebrow">A FEW THINGS TO PREPARE</span><h2>接入步骤</h2></div>${icon('file')}</div><ol class="dingtalk-setup-steps"><li><span>01</span><div><strong>创建企业内部应用</strong><p>在<a href="https://open-dev.dingtalk.com/" target="_blank" rel="noopener noreferrer">钉钉开发者后台 ↗</a>选择你的组织，创建企业内部应用，添加机器人能力。</p></div></li><li><span>02</span><div><strong>开启机器人 Stream 模式</strong><p>在消息接收模式选择 Stream，无需填写公网回调地址。复制 AppKey、AppSecret 和 RobotCode。</p></div></li><li><span>03</span><div><strong>填写组织与成员范围</strong><p>从企业与应用信息中获取 CorpId，确认自己的员工 UserID；将应用可见范围先设为自己。</p></div></li><li><span>04</span><div><strong>开通权限并发布内部版本</strong><p>按后台提示开通机器人消息发送、接收图片及媒体上传所需权限，发布版本。保存本页配置后测试凭证，再开启连接。</p></div></li></ol><a class="dingtalk-doc-link" href="https://open-dingtalk.github.io/developerpedia/docs/learn/stream/overview/" target="_blank" rel="noopener noreferrer">查看官方 Stream 接入说明 ${icon('arrow')}</a></section><section class="dingtalk-chat-note"><div class="dingtalk-note-icon">${icon('spark')}</div><h3>使用说明</h3><p class="dingtalk-example">“用这张产品图，做一组面向开发者的宣传图文。”</p><p>私聊可以直接发送文字和产品图；群聊开启后，在同组织内部群里 @ 机器人发需求。每次补充和修改也需要 @，完成后文案和图片回到原群。</p><p class="dingtalk-group-image-help">群里的图片也需通过带 @ 的消息送达。普通群消息中的图片不会被读取；产品图建议和需求一起发送，或直接在私聊中使用。</p><span>${icon('lock')}本机服务需持续运行，电脑保持联网、避免休眠。</span></section></aside></div><div id="dingtalk-recent-region" class="dingtalk-recent" aria-live="polite">${dingtalkRecentView()}</div></section>`;
}
function dingtalkStatusView() {
  const snapshot=state.dingtalk,status=snapshot.status||{},connected=dingtalkConnected(),busy=dingtalkWorking(),changing=['connecting','reconnecting'].includes(status.state),ready=snapshot.readiness?.configured===true,missing=snapshot.readiness?.missing||[],canStart=ready&&!state.dingtalkDirty&&!busy&&!changing&&!connected;
  return `<section class="panel dingtalk-connection-card"><div class="dingtalk-connection-main"><span class="dingtalk-connection-icon ${connected?'is-connected':''}">${changing?'<span class="spinner spinner-small"></span>':icon(connected?'check':'bolt')}</span><div><div class="dingtalk-connection-kicker">钉钉 Stream 连接 <span class="dingtalk-status-badge ${connected?'is-connected':''}">${h(DINGTALK_STATES[status.state]||'连接状态待确认')}</span></div><h2>${connected?'钉钉连接正常':changing?'正在建立钉钉连接':'机器人连接'}</h2><p>${h(status.message||(ready?'应用配置已保存，连接后可接收已授权成员的创作消息。':'先在下方填写应用信息与允许使用的成员。'))}</p></div></div><div class="dingtalk-connection-actions"><button type="button" class="button button-secondary" data-action="dingtalk-action" data-kind="test" ${!ready||busy||state.dingtalkDirty?'disabled':''}>${state.dingtalkBusy==='test'?'<span class="spinner spinner-small"></span>':icon('bolt')}测试凭证</button>${connected||changing?`<button type="button" class="button button-secondary" data-action="dingtalk-action" data-kind="disconnect" ${state.dingtalkBusy?'disabled':''}>${state.dingtalkBusy==='disconnect'?'<span class="spinner spinner-small"></span>':''}断开连接</button>`:`<button type="button" class="button button-primary" data-action="dingtalk-action" data-kind="connect" ${canStart?'':'disabled'}>${state.dingtalkBusy==='connect'?'<span class="spinner spinner-small"></span>':icon('arrow')}开启连接</button>`}<button type="button" class="text-button" data-action="dingtalk-reload" ${state.dingtalkBusy?'disabled':''}>${icon('refresh')}刷新状态</button></div><div class="dingtalk-connection-meta"><span>最近消息 <strong>${h(dingtalkDate(status.lastMessageAt))}</strong></span><span>${connected?`本次连接 ${h(dingtalkDate(status.connectedAt))}`:'测试凭证不会发消息，也不会调用模型。'}</span></div>${state.dingtalkDirty?'<p class="dingtalk-inline-notice">配置有修改，请先保存后再测试或开启连接。</p>':!ready?`<p class="dingtalk-inline-notice">${h(missing.length?'待完善：'+missing.map(item=>({clientId:'AppKey',clientSecret:'AppSecret',robotCode:'RobotCode',corpId:'CorpId',allowedUserIds:'成员 UserID'}[item]||item)).join('、'):'填写完整配置后，即可测试凭证并开启连接。')}</p>`:''}${connected?'<p class="dingtalk-inline-notice is-subtle">Stream 连接已建立。请用私聊或已启用的群内 @ 验证实际收发，连接状态不代表图文已完成。</p>':''}${state.dingtalkActionError||state.dingtalkError?`<div class="dingtalk-feedback is-error" role="alert">${icon('alert')}<span>${h(state.dingtalkActionError||state.dingtalkError)}</span></div>`:''}${state.dingtalkTest?`<div class="dingtalk-feedback ${state.dingtalkTest.ok?'is-success':'is-error'}" role="status">${icon(state.dingtalkTest.ok?'check':'alert')}<span>${h(state.dingtalkTest.message)}${state.dingtalkTest.ok?' 凭证可用；开启连接后，请在私聊或已启用的群内 @ 验证收发。':''}</span></div>`:''}<ol class="dingtalk-flow" aria-label="钉钉创作流程">${[['发起需求','私聊直接发，群聊需 @'],['集中追问','一次补齐创作信息'],['生成图文','沿用平台模型与风格'],['回到钉钉','直接收到文案和图片']].map(([title,desc],index)=>`<li><span>${String(index+1).padStart(2,'0')}</span><div><strong>${title}</strong><small>${desc}</small></div>${index<3?icon('arrow'):''}</li>`).join('')}</ol></section>`;
}
function dingtalkConversationLabel(item={}) {
  const group=String(item.conversationType)==='2',title=typeof item.conversationTitle==='string'?item.conversationTitle.trim().slice(0,160):'';
  return `<span class="dingtalk-channel-tag ${group?'is-group':''}">${group?'群聊':'私聊'}</span>${group?`<span class="dingtalk-channel-title">${h(title||'群内创作')}</span>`:''}`;
}
function dingtalkRecentView() {
  const sessions=state.dingtalk.sessions||[],deliveries=state.dingtalk.deliveries||[],activity=state.dingtalk.activity||[],busy=dingtalkWorking();
  return `<section class="panel dingtalk-sessions-panel"><div class="dingtalk-section-heading"><div><span class="eyebrow">EVERY CONVERSATION, IN VIEW</span><h2>最近创作</h2></div><span class="dingtalk-record-count">${sessions.length} 个会话</span></div>${sessions.length?`<div class="dingtalk-sessions-list">${sessions.slice(0,12).map(session=>{
    const projectId=dingtalkProjectId(session.projectId),group=String(session.conversationType)==='2';
    return `<article class="dingtalk-session"><div><span class="dingtalk-record-status status-${h(session.stage)}">${session.stage==='generating'?'<span class="spinner spinner-small"></span>':''}${h(DINGTALK_STAGES[session.stage]||'状态待确认')}</span><time>${h(dingtalkDate(session.updatedAt))}</time></div><div class="dingtalk-channel-line">${dingtalkConversationLabel(session)}</div><h3>成员 ${h(session.userId||'未识别')}</h3><p>${session.referenceCount?`${h(session.referenceCount)} 张参考图片 · `:''}${projectId?'作品已留存在平台，可继续对话修改。':group?'在原群 @ 机器人，继续这位成员的创作。':'需求与补充信息在钉钉私聊中继续。'}</p>${session.lastError?`<p class="dingtalk-record-error">${h(session.lastError)}</p>`:''}${projectId?`<button type="button" class="text-button" data-action="continue-chat" data-id="${h(projectId)}">在平台继续这份作品 ${icon('arrow')}</button>`:''}</article>`;
  }).join('')}</div>`:'<div class="dingtalk-empty">'+icon('cards')+'<h3>第一份图文，从钉钉发起</h3><p>连接后私聊机器人，或在已启用的群内 @ 发需求。会话与作品会留在这里。</p></div>'}</section><section class="panel dingtalk-deliveries-panel"><div class="dingtalk-section-heading"><div><span class="eyebrow">DELIVERED TO YOUR CONVERSATION</span><h2>结果回传</h2></div><span class="dingtalk-record-count">${deliveries.length} 条记录</span></div>${deliveries.length?`<div class="dingtalk-deliveries-list">${deliveries.slice(0,10).map(delivery=>`<article class="dingtalk-delivery"><div><span class="dingtalk-record-status status-${h(delivery.status)}">${['pending','sending'].includes(delivery.status)?'<span class="spinner spinner-small"></span>':''}${h(DINGTALK_DELIVERIES[delivery.status]||'状态待确认')}</span><time>${h(dingtalkDate(delivery.updatedAt||delivery.createdAt))}</time></div><div class="dingtalk-channel-line">${dingtalkConversationLabel(delivery)}${delivery.userId?`<small>成员 ${h(delivery.userId)}</small>`:''}</div><p>${h(delivery.message||'图文结果将回到发起需求的钉钉会话。')}</p>${delivery.status==='unknown'?'<small>请先到钉钉核对是否收到，避免重复发送。</small>':''}${delivery.status==='failed'&&delivery.canRetry===true?`<button type="button" class="text-button" data-action="dingtalk-retry-delivery" data-id="${h(delivery.id)}" ${busy?'disabled':''}>${icon('refresh')}重发失败的结果</button><small>只重发已有结果，不会重新生图。</small>`:''}</article>`).join('')}</div>`:'<div class="dingtalk-empty">'+icon('image')+'<h3>文案和图片，直接收到</h3><p>生成完成后自动回到原私聊或群聊。这里显示实际回传状态，失败结果可单独重发。</p></div>'}</section><details class="panel dingtalk-activity-panel"><summary><span>${icon('history')}接入活动</span><small>最近 ${Math.min(activity.length,20)} 条</small></summary>${activity.length?`<ol>${activity.slice(0,20).map(item=>`<li><span class="dingtalk-activity-dot ${['error','failed'].includes(item.status)?'is-error':''}"></span><p>${h(item.message||'状态已更新')}</p><time>${h(dingtalkDate(item.at))}</time></li>`).join('')}</ol>`:'<p class="dingtalk-activity-empty">保存配置、连接和消息处理活动会显示在这里，不展示密钥与聊天正文。</p>'}</details>`;
}
function acceptDingtalk(payload) {
  const snapshot=payload?.snapshot||payload;
  if(!snapshot?.config||!snapshot?.status||!Array.isArray(snapshot.sessions)||!Array.isArray(snapshot.activity))throw new Error('钉钉接入数据不完整，请重新读取。');
  state.dingtalk={...snapshot,deliveries:Array.isArray(snapshot.deliveries)?snapshot.deliveries:[]};
  if(!state.dingtalkDraft||!state.dingtalkDirty)state.dingtalkDraft=dingtalkDraftFromConfig(snapshot.config);
  return snapshot;
}
function captureDingtalkDraft() {
  const form=document.querySelector('#dingtalk-config-form');if(!form||state.dingtalkBusy==='save')return;
  const fields=new FormData(form);
  state.dingtalkDraft={clientId:String(fields.get('clientId')||''),clientSecret:String(fields.get('clientSecret')||''),robotCode:String(fields.get('robotCode')||''),corpId:String(fields.get('corpId')||''),allowedUserIds:String(fields.get('allowedUserIds')||''),matchTrends:fields.has('matchTrends'),groupEnabled:fields.has('groupEnabled'),clearSecret:fields.has('clearSecret')};
  state.dingtalkDirty=true;state.dingtalkTest=null;updateDingtalk(false);
}
function updateDingtalk(includeRecent=true) {
  if(state.view!=='dingtalk'||!state.dingtalk)return;
  const status=document.querySelector('#dingtalk-status-region');if(!status){render();return;}status.innerHTML=dingtalkStatusView();
  if(includeRecent){const recent=document.querySelector('#dingtalk-recent-region');if(recent){const activityOpen=recent.querySelector('.dingtalk-activity-panel')?.open;recent.innerHTML=dingtalkRecentView();if(activityOpen)recent.querySelector('.dingtalk-activity-panel').open=true;}}
  const connection=document.querySelector('#dingtalk-header-connection');if(connection){connection.classList.toggle('connected',dingtalkConnected());connection.innerHTML='<i></i>'+(dingtalkConnected()?'Stream 已连接':'等待连接钉钉');}
  const scope=document.querySelector('#dingtalk-scope-label');if(scope)scope.textContent=state.dingtalk.config.groupEnabled===true?'私聊 · 群聊 @':'私聊已启用';
  const form=document.querySelector('#dingtalk-config-form');if(form){const group=form.querySelector('#dingtalk-group-enabled');if(group&&!state.dingtalkDirty)group.checked=state.dingtalk.config.groupEnabled===true;form.querySelector('fieldset').disabled=state.dingtalkBusy==='save';const save=form.querySelector('#dingtalk-save');save.disabled=Boolean(state.dingtalkBusy);save.innerHTML=state.dingtalkBusy==='save'?'<span class="spinner spinner-small"></span>正在保存…':icon('check')+'保存配置';const draft=form.querySelector('#dingtalk-draft-state');draft.textContent=state.dingtalkDirty?'有未保存的修改':'使用本地已保存配置';draft.classList.toggle('is-dirty',state.dingtalkDirty);const secret=form.querySelector('#dingtalk-secret-status');secret.textContent=state.dingtalk.config.hasSecret?'凭证已保存':'尚未保存凭证';form.querySelector('#dingtalk-clear-secret-label').hidden=!state.dingtalk.config.hasSecret;}
}
function scheduleDingtalkPoll() {
  clearTimeout(dingtalkPollTimer);
  if(state.view==='dingtalk'&&state.dingtalk&&(state.dingtalkError||['connected','connecting','reconnecting'].includes(state.dingtalk.status.state)||state.dingtalk.status.busy||(state.dingtalk.sessions||[]).some(session=>session.stage==='generating')||(state.dingtalk.deliveries||[]).some(delivery=>['pending','sending'].includes(delivery.status))))dingtalkPollTimer=setTimeout(()=>loadDingtalk({quiet:true}),3000);
}
async function loadDingtalk({quiet=false}={}) {
  if(state.dingtalkBusy)return;
  const version=++dingtalkLoadVersion;state.dingtalkLoading=true;if(!quiet&&!state.dingtalk&&state.view==='dingtalk')render();
  try{const payload=await api('/api/dingtalk');if(version!==dingtalkLoadVersion)return;const first=!state.dingtalk;acceptDingtalk(payload);state.dingtalkError='';if(state.view==='dingtalk'){if(first){render();updateDingtalk();}else updateDingtalk();}}
  catch(error){if(version===dingtalkLoadVersion){state.dingtalkError=error.message;if(state.view==='dingtalk'){if(state.dingtalk)updateDingtalk();else render();}}}
  finally{if(version===dingtalkLoadVersion){state.dingtalkLoading=false;scheduleDingtalkPoll();}}
}
async function saveDingtalkConfig() {
  if(dingtalkWorking())return notify('请等待当前钉钉操作完成后再保存。');
  const form=document.querySelector('#dingtalk-config-form');if(!form?.reportValidity())return;
  captureDingtalkDraft();const draft=state.dingtalkDraft,allowedUserIds=[...new Set(draft.allowedUserIds.split(/[\n,，]/).map(value=>value.trim()).filter(Boolean))];
  if(!allowedUserIds.length)return notify('至少填写一个允许使用的成员 UserID。',true);
  if(!draft.clearSecret&&!draft.clientSecret.trim()&&!state.dingtalk.config.hasSecret)return notify('首次接入需要填写应用的 Client Secret。',true);
  if(draft.clearSecret&&draft.clientSecret.trim())return notify('清除凭证与设置新凭证不能同时进行，请选择一种操作。',true);
  ++dingtalkLoadVersion;clearTimeout(dingtalkPollTimer);state.dingtalkBusy='save';state.dingtalkError='';state.dingtalkActionError='';updateDingtalk();
  try{const payload=await api('/api/dingtalk/config',{method:'PUT',body:{clientId:draft.clientId.trim(),clientSecret:draft.clientSecret.trim(),robotCode:draft.robotCode.trim(),corpId:draft.corpId.trim(),allowedUserIds,matchTrends:draft.matchTrends,groupEnabled:draft.groupEnabled,clearSecret:draft.clearSecret}});acceptDingtalk(payload);state.dingtalkDirty=false;state.dingtalkDraft=dingtalkDraftFromConfig(state.dingtalk.config);state.dingtalkTest=null;if(state.view==='dingtalk')render();notify('钉钉配置已保存。测试凭证后，可手动开启连接。');}
  catch(error){state.dingtalkActionError=error.message;notify(error.message,true);}
  finally{state.dingtalkBusy='';updateDingtalk();scheduleDingtalkPoll();}
}
async function runDingtalkAction(kind) {
  if(!['test','connect','disconnect'].includes(kind)||state.dingtalkBusy)return;
  if(kind!=='disconnect'&&(state.dingtalkDirty||!state.dingtalk?.readiness?.configured))return notify('请先保存完整的钉钉配置，再进行此操作。',true);
  ++dingtalkLoadVersion;clearTimeout(dingtalkPollTimer);state.dingtalkBusy=kind;state.dingtalkError='';state.dingtalkActionError='';state.dingtalkTest=null;updateDingtalk();
  try{const payload=await api(`/api/dingtalk/${kind}`,{method:'POST',body:{}});if(payload?.snapshot||payload?.config)acceptDingtalk(payload);if(kind==='test'){state.dingtalkTest={ok:payload.ok===true,message:payload.message||(payload.ok===true?'应用凭证测试通过。':'没有收到有效的凭证测试结果，请重试。')};if(payload.ok!==true)notify(state.dingtalkTest.message,true);}else notify(kind==='connect'?(dingtalkConnected()?'Stream 已连接，请通过私聊或已启用的群内 @ 验证收发。':'连接请求已提交，正在确认实际连接状态。'):'断开请求已提交，正在确认实际连接状态。');}
  catch(error){state.dingtalkActionError=error.message;if(kind==='test')state.dingtalkTest={ok:false,message:error.message};notify(error.message,true);}
  finally{state.dingtalkBusy='';updateDingtalk();await loadDingtalk({quiet:true});}
}
async function retryDingtalkDelivery(id) {
  const delivery=state.dingtalk?.deliveries?.find(item=>item.id===id);if(dingtalkWorking()||delivery?.status!=='failed'||delivery.canRetry!==true)return;
  ++dingtalkLoadVersion;clearTimeout(dingtalkPollTimer);state.dingtalkBusy='retry';state.dingtalkError='';state.dingtalkActionError='';updateDingtalk();
  try{const payload=await api(`/api/dingtalk/deliveries/${encodeURIComponent(id)}/retry`,{method:'POST',body:{}});if(payload?.snapshot||payload?.config)acceptDingtalk(payload);notify(payload.message||'已请求重发失败的结果，不会重新生图。');}
  catch(error){state.dingtalkActionError=error.message;notify(error.message,true);}
  finally{state.dingtalkBusy='';updateDingtalk();await loadDingtalk({quiet:true});}
}
const XHS_DRAFT_LABELS = {queued:'等待处理',running:'正在准备电脑草稿',filled:'已填入发布页，待核验',verified:'电脑草稿已核验',unknown:'保存结果待核验',failed:'草稿准备未完成',interrupted:'上次操作已中断'};
const xhsConnected = () => state.xhs?.connection?.state==='connected'&&Boolean(xhsAccountId());
const xhsDeliveryReadOnly = () => state.xhs?.configured===true&&state.xhs.deliveryConfiguration?.configured===false;
const xhsDeliverySetupHint = () => state.xhs?.deliveryConfiguration?.message||'请在工作台配置内网临时图源或已有图片站点，重启后检查服务。';
function xhsConnectionHint(fallback) {
  const message=state.xhs?.connection?.message||fallback;
  if(!xhsDeliveryReadOnly())return message;
  const hint=xhsDeliverySetupHint();
  return message.includes(hint)?message:message+' '+hint;
}
const xhsBound = () => state.xhs?.configured!==false&&Boolean(xhsAccountId());
const xhsServerWorking = () => Boolean(state.xhs?.status?.busy||state.xhs?.officialDraftSync?.running);
const xhsWorking = () => Boolean(state.xhsBusy||xhsServerWorking());
const xhsDate = value => value&&Number.isFinite(new Date(value).getTime())?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'尚未同步';
const xhsEligible = project => project?.status==='completed'&&!isActive(project)&&Array.isArray(project.pages)&&project.pages.length>0&&project.pages.every(page=>page.status==='done'&&typeof page.imageUrl==='string'&&page.imageUrl.startsWith('/media/'));
const xhsAccountId = () => String(state.xhs?.account?.id||'');
function xhsAccountRecord(accountId) {
  if(!accountId||accountId!==xhsAccountId()||!xhsBound())return null;
  return {accountId,nickname:state.xhs.account.nickname||accountId,connectionState:state.xhs.connection.state,busy:xhsServerWorking()};
}
const xhsRecordBound = record => Boolean(record?.accountId);
const xhsRecordConnected = record => xhsRecordBound(record)&&record.connectionState==='connected';
const xhsRecordName = record => record?.nickname||'服务账号';
const guideTargetAccountId = () => String(state.guideProject?.xhsDelivery?.accountId||state.guide.creation?.capture?.xhsAccountId||xhsAccountId());
const xhsAvailabilityHint = '送稿时自动检查服务';
const xhsAccountSetupHint = () => state.xhs?.configured===false&&state.xhs.connection?.message||'请在工作台配置小红书发布服务，再使用送稿。';
const draftCopyProblem = (title,content) => xhsCopyProblem(title,content)||(!title?.trim()||!content?.trim()?'送稿需要帖子标题和正文。':'');
function replaceXhsRegion(selector,html) {
  const target=document.querySelector(selector);
  if(target&&target._xhsHtml!==html){target.innerHTML=html;target._xhsHtml=html;}
}
function xhsCanRecheck(draft) {
  return Boolean(draft?.canRecheck&&!draft.rechecking&&!['queued','running'].includes(draft.status));
}
function xhsDraftSourceView() {
  return [['official','服务草稿'],['submissions','平台送稿记录']].map(([source,label])=>`<button class="${state.xhsDraftSource===source?'is-active':''}" type="button" data-action="xhs-draft-source" data-source="${source}" aria-pressed="${state.xhsDraftSource===source}">${label}</button>`).join('');
}
function xhsDraftRefreshView() {
  return state.xhsDraftSource==='official'?`<button class="button button-secondary" type="button" data-action="xhs-official-sync" ${xhsWorking()?'disabled':''}>${icon('refresh')}读取服务草稿</button>`:`<button class="button button-secondary" type="button" data-action="xhs-reload" ${state.xhsLoading?'disabled':''}>${icon('refresh')}刷新记录</button>`;
}
function xhsDraftPanel() {
  return `    <section id="xhs-panel-drafts" aria-label="发布服务草稿">
      <section class="panel xhs-official-panel"><div class="xhs-section-heading"><div><h2>草稿箱</h2></div><div id="xhs-draft-refresh" class="xhs-row-actions">${xhsDraftRefreshView()}</div></div>
        <div class="xhs-draft-toolbar"><div class="xhs-draft-source" role="group" aria-label="草稿来源">${xhsDraftSourceView()}</div><label class="xhs-filter-search" for="xhs-draft-search">${icon('search')}<span class="sr-label">搜索草稿标题</span><input id="xhs-draft-search" type="search" placeholder="搜索草稿标题" value="${h(state.xhsDraftSearch)}"></label><label for="xhs-draft-sort" class="sr-label">草稿排序</label><select id="xhs-draft-sort"><option value="recent" ${state.xhsDraftSort==='recent'?'selected':''}>保存时间 · 最新</option><option value="oldest" ${state.xhsDraftSort==='oldest'?'selected':''}>保存时间 · 最早</option><option value="title" ${state.xhsDraftSort==='title'?'selected':''}>标题排序</option></select></div>
        <div id="xhs-official-drafts-region" ${state.xhsDraftSource==='official'?'':'hidden'}>${publisherDraftsView()}</div>
        <div id="xhs-submissions-region" ${state.xhsDraftSource==='submissions'?'':'hidden'}><p class="xhs-data-note">这里记录平台送出的版本及核验结果，小红书后续修改不会回写此记录。</p><div id="xhs-drafts-region" aria-live="polite">${xhsDraftsView()}</div></div>
      </section>
      ${xhsDeliveryReadOnly()?'':`<details id="xhs-composer-disclosure" class="xhs-composer-disclosure" ${state.xhsComposerOpen?'open':''}><summary>${icon('plus')}从作品送入草稿</summary><div id="xhs-composer-region">${xhsComposerView()}</div></details>`}
    </section>
    <p class="xhs-page-note">${icon('lock')}草稿箱收录此发布服务创建的草稿。</p>`;
}
const xhsSelectedAccount = () => state.xhsAccounts?.find(row=>row.accountId===state.xhsRoute.accountId);
const xhsDeliveryAccountOpen = () => Boolean(xhsSelectedAccount()&&state.xhsRoute.accountId===xhsAccountId());
function xhsScreenKey() {
  const r=state.xhsRoute;
  return JSON.stringify([r.accountId,r.tab,state.xhs?.providerKey,xhsAccountId(),xhsDeliveryReadOnly(),xhsSelectedAccount()||null]);
}
function xhsTaskStatus(row) {
  let label='状态未知',style='';
  if(row.enabled===false){label='已停用';style='is-attention';}
  else if(row.paused===true){label='已暂停';style='is-attention';}
  else if(row.executing===true){label='执行中';style='is-connected';}
  else if(row.queuedJobs>0){label='等待执行';}
  else if(row.executing===false){label='未在执行';}
  else if(row.paused===false){label='未暂停';}
  const details=[];
  if(row.executing===true&&(row.paused===true||row.enabled===false))details.push('有任务执行中');
  if(row.queuedJobs>0)details.push('排队 '+row.queuedJobs);
  if(row.needsAttention>0)details.push('待核对 '+row.needsAttention);
  return `<span class="xhs-table-status ${style}"><i></i>${label}</span>${details.length?`<small class="xhs-task-counts">${details.map(text=>`<span>${h(text)}</span>`).join('')}</small>`:''}`;
}
const XHS_ACCOUNT_METRICS = [
  ['followers','粉丝数'], ['following','关注数'], ['likesAndSaves','获赞与收藏'], ['notes','笔记数'],
];
const xhsAccountLabel = row => row.nickname || '用户名未提供';
const xhsPlatformLabel = row => row.platformAccountId ? '平台账号 ID · '+row.platformAccountId : '服务编号 · '+row.accountId;
function xhsAccountMonogram(row) {
  const initial=Array.from(row.nickname||'')[0];
  return `<span class="xhs-table-avatar xhs-account-avatar-frame" aria-hidden="true">${initial?h(initial):icon('cards')}</span>`;
}
function xhsLoginView(row) {
  const states={verified:'已核验',unverified:'未核验',expired:'登录已失效',logged_out:'已退出'};
  const label=Object.hasOwn(states,row.loginStatus)?states[row.loginStatus]:'状态未知';
  const style=row.loginStatus==='verified'?' is-connected':['expired','logged_out'].includes(row.loginStatus)?' is-attention':'';
  return `<span class="xhs-table-status${style}"><i></i>${label}</span>${row.identityCheckedAt?`<small class="xhs-identity-checked">核验于 ${h(xhsDate(row.identityCheckedAt))}</small>`:''}`;
}
function xhsAccountMetric(row,key) {
  const value=row.metrics?.[key];
  return Number.isFinite(value)&&value>=0 ? h(row.metricLabels?.[key]||value.toLocaleString('zh-CN')) : null;
}
function xhsMetricFootnote(rows) {
  if(rows.some(row=>row.metricsReadFailed))return '部分账号的指标缓存读取失败，可在账号详情重新读取。';
  return rows.some(row=>XHS_ACCOUNT_METRICS.some(([key])=>xhsAccountMetric(row,key)===null))
    ? '— 表示微服务尚未提供该项数据。' : '';
}
function xhsAccountsTableView() {
  const records=state.xhsAccounts;
  if(state.xhs?.configured===false)return `<div class="xhs-overview-empty"><h3>配置小红书发布服务</h3><p>${h(xhsAccountSetupHint())}</p><p>在工作台目录复制 <code>.env.example</code> 为 <code>.env.xhs-publisher</code>，填写服务地址、服务令牌和账号 ID 后重启工作台。</p></div>`;
  if(state.xhsAccountsError)return `<div class="xhs-overview-empty" role="alert">${icon('alert')}<h3>账号列表读取失败</h3><p>${h(state.xhsAccountsError)}</p><button type="button" class="button button-secondary" data-action="xhs-accounts-refresh">重试</button></div>`;
  if(!records)return '<div class="xhs-overview-empty" role="status"><span class="spinner spinner-small"></span> 正在读取服务账号…</div>';
  if(!records.length)return '<div class="xhs-overview-empty"><h3>暂无已配置账号</h3><p>在小红书发布服务配置账号后，刷新列表即可查看。</p></div>';
  const search=state.xhsAccountSearch.trim().toLowerCase();
  const rows=records.filter(row=>[row.nickname,row.platformAccountId,row.accountId].some(value=>value?.toLowerCase().includes(search))).map(row=>{
    const id=h(row.accountId);
    const cells=XHS_ACCOUNT_METRICS.map(([key,label])=>{
      const count=xhsAccountMetric(row,key);
      return `<td class="xhs-account-count" data-label="${label}">${count??'<span aria-label="未提供">—</span>'}</td>`;
    }).join('');
    return `<tr><td><button type="button" class="xhs-table-identity" data-action="xhs-account-open" data-id="${id}">${xhsAccountMonogram(row)}<span><strong>${h(xhsAccountLabel(row))}</strong><small>${h(xhsPlatformLabel(row))}</small></span></button></td>
      ${cells}<td data-label="登录状态">${xhsLoginView(row)}</td><td data-label="任务状态">${xhsTaskStatus(row)}</td>
      <td><button type="button" class="text-button" data-action="xhs-account-open" data-id="${id}" aria-label="查看 ${h(row.nickname||row.accountId)} 的账号详情">查看详情 ${icon('arrow')}</button></td></tr>`;
  }).join('');
  const headings=['小红书用户名',...XHS_ACCOUNT_METRICS.map(([,label])=>label),'登录状态','任务状态','操作'];
  return rows?`<div class="xhs-accounts-table-wrap"><table class="xhs-accounts-table"><thead><tr>${headings.map(label=>`<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`:'<div class="xhs-overview-empty">没有匹配的账号。</div>';
}
function xhsAccountsListView() {
  const records=state.xhsAccounts;
  return `<section class="panel xhs-overview"><div class="xhs-overview-heading"><div><h2>账号列表${records&&!state.xhsAccountsError?`<small>${records.length}</small>`:''}</h2></div>
    <div class="xhs-row-actions">${xhsBound()?publisherCheckButton():''}<button class="button button-secondary" type="button" data-action="xhs-accounts-refresh" ${state.xhsAccountsLoading?'disabled':''}>${icon('refresh')}刷新列表</button></div></div>
    ${records?.length>1||state.xhsAccountSearch?`<div class="xhs-overview-toolbar"><label class="xhs-filter-search">${icon('search')}<span class="sr-label">搜索账号</span><input id="xhs-account-search" type="search" placeholder="搜索用户名或账号 ID" value="${h(state.xhsAccountSearch)}"></label></div>`:''}
    <div id="xhs-accounts-table-region">${xhsAccountsTableView()}</div>
    ${state.xhsFetchedAt&&!state.xhsAccountsError?`<p class="xhs-list-footnote">${xhsMetricFootnote(records||[])} 最近读取 ${h(xhsDate(state.xhsFetchedAt))}</p>`:''}</section>`;
}
function xhsAccountView() {
  const row=xhsSelectedAccount();if(!row)return '';
  return `<div class="xhs-workspace-toolbar"><div class="xhs-context-main"><button class="text-button xhs-back-link" type="button" data-action="xhs-account-list">${icon('arrow')}账号列表</button><span class="xhs-context-divider" aria-hidden="true"></span><div class="xhs-current-account">${xhsAccountMonogram(row)}<div><h2>${h(xhsAccountLabel(row))}</h2><small>${h(xhsPlatformLabel(row))}</small></div></div></div>
    <div class="xhs-context-actions"><div>${xhsLoginView(row)}</div>${xhsDeliveryAccountOpen()?publisherCheckButton():''}</div></div>`;
}
function xhsRuntimePanel(row) {
  const flag=(value,yes,no)=>typeof value==='boolean'?(value?yes:no):null;
  const fields=[
    ['账号启用',flag(row.enabled,'已启用','已停用')],['任务暂停',flag(row.paused,'已暂停','未暂停')],
    ['正在执行',flag(row.executing,'是','否')],['排队任务',row.queuedJobs],['待人工核对',row.needsAttention],
    ['预约发布',flag(row.publishEnabled,'已开启','已关闭')],['每日限额',row.dailyLimit],
  ];
  const entries=fields.map(([label,value])=>`<div><dt>${label}</dt><dd>${value==null?'<span aria-label="未提供">—</span>':h(value)}</dd></div>`).join('');
  return `<section class="panel" aria-label="任务与配置"><div class="xhs-section-heading"><h2>任务与配置</h2><button type="button" class="button button-secondary" data-action="xhs-accounts-refresh" ${state.xhsAccountsLoading?'disabled':''}>${icon('refresh')}刷新状态</button></div><dl class="xhs-runtime-fields">${entries}</dl></section>`;
}
function xhsMetricsPanel(row) {
  const metrics=XHS_ACCOUNT_METRICS.map(([key,label])=>{
    const count=xhsAccountMetric(row,key);
    return `<div><span>${label}</span><strong${count===null?' class="is-missing" aria-label="未提供"':''}>${count??'—'}</strong></div>`;
  }).join('');
  const note=xhsMetricFootnote([row]);
  return `<section class="panel"><div class="xhs-section-heading"><h2>账号指标</h2></div><div class="xhs-basic-metrics">${metrics}</div>${note?`<p class="xhs-list-footnote">${note}</p>`:''}</section>`+accountMetricsView.panel(row);
}

const accountMetricsView=createAccountMetrics({
  api, escape:h, redraw:updateXhs, formatDate:xhsDate,
  providerKey:()=>state.xhsDefault?.providerKey||'',
  updateTotals(id,data) {
    const row=state.xhsAccounts?.find(item=>item.accountId===id);
    if(!row)return;
    if(data.sync)row.metricsSync=data.sync;
    row.metricsReadFailed=false;
    for(const [key,source] of [['following','following'],['followers','followers'],['likesAndSaves','likes_and_favorites']]){
      (row.metrics||={})[key]=data.totals?.[source]?.value??null;
      (row.metricLabels||={})[key]=data.totals?.[source]?.raw??null;
    }
  },
});
const noteSyncs = new Map();
let noteSyncTimer;
const notesPending = status => status === 'queued' || status === 'running';
function notesTask(accountId) {
  const key = 'xhs-notes-sync:' + (state.xhsDefault?.providerKey || '') + ':' + accountId;
  if (!noteSyncs.has(key)) {
    let requestId = null;
    try { requestId = sessionStorage.getItem(key); } catch {}
    noteSyncs.set(key, { key, requestId, job: null, busy: false, error: '' });
  }
  return noteSyncs.get(key);
}
function rememberNotesRequest(task, id) {
  task.requestId = id;
  try { if (id) sessionStorage.setItem(task.key,id); else sessionStorage.removeItem(task.key); } catch {}
}
// The desktop 笔记管理 card renders eye, speech bubble, heart, star, then share.
const publishedCountColumns = [
  { label: '浏览', slot: 0 },
  { label: '点赞', slot: 2 },
  { label: '评论', slot: 1 },
  { label: '收藏', slot: 3 },
  { label: '分享', slot: 4 },
];
function hasUnmappedNoteCounts(note) {
  return note.rawCounts?.length > 0 && note.rawCounts.length !== publishedCountColumns.length;
}
function publishedCountCells(note, showRawColumn) {
  const counts = note.rawCounts || [];
  const knownLayout = counts.length === publishedCountColumns.length;
  const cells = publishedCountColumns.map(({slot}) => {
    const value = knownLayout ? counts[slot] : null;
    return `<td class="xhs-count">${value != null && value !== '' ? h(value) : '<span class="xhs-count-missing" aria-label="暂无数据">—</span>'}</td>`;
  }).join('');
  if (!showRawColumn) return cells;
  const raw = hasUnmappedNoteCounts(note)
    ? `<details><summary>查看原始计数</summary><ol aria-label="按卡片顺序排列的计数">${counts.map(value => `<li>${h(value ?? '—')}</li>`).join('')}</ol></details>`
    : '—';
  return cells + `<td class="xhs-raw-counts">${raw}</td>`;
}
function xhsPublishedPanel() {
  const page=state.xhsPublished, loading=!page||page.loading===true, data=page?.data;
  const row=xhsSelectedAccount(), task=notesTask(row.accountId), sync=task.job || data?.sync;
  const pending=notesPending(sync?.status), checking=Boolean(task.error && pending);
  const remoteAction=checking?'查询同步进度':task.requestId?'重试本次同步':'同步小红书笔记';
  const actions=`<div class="xhs-draft-actions"><button type="button" class="button button-secondary" data-action="xhs-notes-page" data-kind="refresh" data-offset="${page?.offset??0}" ${loading?'disabled':''}>${icon('refresh')}${page?.error?'重试':'刷新列表'}</button><button type="button" class="button button-primary" data-action="xhs-notes-sync" ${task.busy||(!checking && pending)||!data||row.enabled===false?'disabled':''}>${task.busy?'处理中…':pending&&!checking?'正在同步':remoteAction}</button></div>`;
  const messages={queued:row.paused?'同步已排队，账号恢复后执行。':'同步已排队。',running:'正在同步小红书笔记。',failed:'上次笔记同步失败，可重新同步。',canceled:'上次笔记同步已取消。'};
  const notice=task.error || messages[sync?.status] || '';
  let body=notice?`<p class="xhs-list-footnote" role="status">${h(notice)}${sync?.error?' '+h(sync.error):''}</p>`:'';
  if(page?.error)body+=`<div class="xhs-inline-error" role="alert">${h(page.error)}</div>`;
  if(!data && loading)body+='<div class="xhs-data-empty" role="status">正在读取已发布笔记…</div>';
  if(data) {
    const {items,total,limit,offset,lastSyncedAt}=data;
    const summary=lastSyncedAt?`<div class="xhs-official-summary"><span>已同步 ${total} 篇已发布笔记</span><span>最近同步 ${h(xhsDate(lastSyncedAt))}</span></div>`:'';
    const showRawColumn=items.some(hasUnmappedNoteCounts);
    const countHeaders=publishedCountColumns.map(({label})=>`<th scope="col" class="xhs-count">${label}</th>`).join('');
    const rows=items.map(note=>{
      const at=note.publishedAt&&new Date(note.publishedAt);
      const time=at&&Number.isFinite(at.getTime())?at.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):note.publishedTimeText;
      return `<tr><th scope="row">${h(note.title||'未提供标题')}</th><td>${h(time||'—')}</td><td>${note.visibility==='private'?'仅自己可见':'未标明'}</td>${publishedCountCells(note,showRawColumn)}</tr>`;
    }).join('');
    const table=rows?`<div class="xhs-notes-table-wrap" tabindex="0" role="region" aria-label="已发布笔记数据表"><table class="xhs-notes-table xhs-published-table"><thead><tr><th scope="col">笔记标题</th><th scope="col">发布时间</th><th scope="col">可见范围</th>${countHeaders}${showRawColumn?'<th scope="col">原始计数</th>':''}</tr></thead><tbody>${rows}</tbody></table></div>`
      :`<div class="xhs-data-empty"><p>${lastSyncedAt?'最近同步的记录中没有已发布笔记。':'该账号尚未同步笔记。'}</p></div>`;
    const pager=total>limit?`<div class="xhs-draft-actions xhs-notes-pages"><button type="button" class="text-button" data-action="xhs-notes-page" data-kind="previous" data-offset="${Math.max(0,offset-limit)}" ${offset===0||loading?'disabled':''}>上一页</button><span>第 ${Math.floor(offset/limit)+1} / ${Math.ceil(total/limit)} 页</span><button type="button" class="text-button" data-action="xhs-notes-page" data-kind="next" data-offset="${offset+limit}" ${offset+limit>=total||loading?'disabled':''}>下一页</button></div>`:'';
    body+=summary+table+pager;
  }
  return `<section class="panel" aria-label="已发布笔记" aria-busy="${loading}"><div class="xhs-section-heading"><h2>已发布笔记</h2>${actions}</div>${body}</section>`;
}
function xhsManagementView() {
  if(!state.xhsRoute.accountId||state.xhs?.configured===false)return xhsAccountsListView();
  const back='<button type="button" class="text-button" data-action="xhs-account-list">返回账号列表</button>';
  const row=xhsSelectedAccount();
  if(!row){
    const pending=!state.xhsAccounts&&!state.xhsAccountsError;
    const heading=state.xhsAccountsError?'暂时无法读取账号':pending?'正在读取账号…':'该账号不在当前服务列表中';
    return `<div class="panel xhs-overview-empty" role="status"><h3>${heading}</h3>${state.xhsAccountsError?`<p>${h(state.xhsAccountsError)}</p><button class="button button-secondary" type="button" data-action="xhs-accounts-refresh">重试</button>`:''} ${back}</div>`;
  }
  const tab=state.xhsRoute.tab;
  const tabs=Object.entries(XHS_ACCOUNT_TABS).map(([key,label])=>`<button type="button" role="tab" id="xhs-tab-${key}" data-action="xhs-account-tab" data-tab="${key}" aria-selected="${key===tab}" aria-controls="xhs-tabpanel-${key}" tabindex="${key===tab?0:-1}">${label}</button>`).join('');
  let panel;
  if(tab==='overview')panel=xhsMetricsPanel(row)+xhsRuntimePanel(row);
  else if(tab==='published')panel=xhsPublishedPanel();
  else if(xhsDeliveryAccountOpen())panel=`<div id="xhs-connection-region">${xhsDraftConnectionView()}</div>${xhsDraftPanel()}`;
  else panel='<section class="panel xhs-overview-empty" role="status"><h3>'+(state.xhsError?'暂时无法读取该账号的草稿箱':'正在读取该账号的草稿箱…')+'</h3></section>';
  return `<div class="xhs-account-detail"><div id="xhs-account-region">${xhsAccountView()}</div>
    <div class="xhs-tabs" role="tablist" aria-label="账号详情">${tabs}</div><div role="tabpanel" id="xhs-tabpanel-${tab}" aria-labelledby="xhs-tab-${tab}">${panel}</div></div>`;
}
function xhsDraftConnectionView() {
  return `<div class="xhs-connection-notice ${xhsDeliveryReadOnly()?'is-warning':''}" role="status">${icon(xhsDeliveryReadOnly()?'alert':'lock')}<span>${h(xhsConnectionHint('送稿前会检查发布服务。'))}</span></div>`;
}
function xhsView() {
  if(!state.xhs)return `<section id="xhs-page" class="xhs-page xhs-management"><div class="panel xhs-loading" role="status">${state.xhsLoading?'<span class="spinner"></span>':''}<h2>${state.xhsError?'暂时没有连接上账号工作台':'正在准备小红书工作台'}</h2><p>${h(state.xhsError||'读取账号连接与草稿记录…')}</p>${state.xhsError?'<button class="button button-secondary" data-action="xhs-reload">重新连接</button>':''}</div></section>`;
  return `<section id="xhs-page" class="xhs-page xhs-management" aria-label="小红书账号管理"><div id="xhs-status-region" aria-live="polite">${xhsStatusView()}</div><div id="xhs-management-region" data-screen="${h(xhsScreenKey())}">${xhsManagementView()}</div><dialog id="xhs-detail-dialog" class="xhs-detail-dialog" aria-modal="true" aria-labelledby="xhs-detail-title"><div id="xhs-detail-region"></div></dialog></section>`;
}
function xhsStatusView() {
  const data=state.xhs,status=data?.status||{},draftTab=state.xhsRoute.tab==='drafts'&&xhsDeliveryAccountOpen();
  const error=state.xhsError||status.error||(draftTab&&data?.officialDraftSync?.error),busy=state.xhsBusy==='check'||(draftTab&&xhsWorking());
  const retryAction=draftTab&&state.xhsDraftSource==='official'?'xhs-official-sync':'xhs-reload';
  return `${busy?`<div class="xhs-notice xhs-working" role="status"><span class="spinner spinner-small"></span><span>${h(status.message||'正在后台处理小红书操作，完成后会更新。')}</span></div>`:''}${error?`<div class="xhs-notice is-error" role="alert">${icon('alert')}<span>${h(error)}</span><button class="text-button" data-action="${retryAction}" ${busy?'disabled':''}>重新读取</button></div>`:''}`;
}
function publisherCheckButton() {
  return `<button type="button" class="button button-secondary" data-action="xhs-check-service" ${xhsWorking()?'disabled':''}>${icon('refresh')}检查服务</button>`;
}
function xhsFilteredDrafts(items) {
  const search=state.xhsDraftSearch.trim().toLocaleLowerCase();
  return items.filter(item=>!search||String(item.title||'').toLocaleLowerCase().includes(search)).sort((a,b)=>{
    if(state.xhsDraftSort==='title')return String(a.title||'').localeCompare(String(b.title||''),'zh-CN');
    const timeA=Date.parse(a.updatedAt||a.createdAt),timeB=Date.parse(b.updatedAt||b.createdAt);
    if(!Number.isFinite(timeA))return Number.isFinite(timeB)?1:0;
    if(!Number.isFinite(timeB))return -1;
    return state.xhsDraftSort==='oldest'?timeA-timeB:timeB-timeA;
  });
}
const publisherPhases = {
  queued_create:'等待创建', downloading:'准备图片', creating:'保存并核验中', ready:'等待核验',
  queued_update:'等待修改',downloading_update:'准备替换配图',updating:'正在写入修改',update_failed:'修改素材准备失败',
  queued_schedule:'等待预约', scheduling:'正在预约', submit_intent:'待确认预约结果',
  scheduled:'预约待核验', create_failed:'素材准备失败', needs_attention:'需人工核对', canceled_create:'创建已取消'
};
function publisherDraftStatus(draft) {
  if(draft.phase==='ready'&&draft.platformStatus==='draft_verified')return '草稿已核验';
  if(draft.phase==='scheduled'&&draft.platformStatus==='scheduled')return '已预约';
  return publisherPhases[draft.phase]||'状态待确认';
}
function publisherDraftsView() {
  const sync=state.xhs.officialDraftSync||{},coverage=sync.coverage||{};
  const items=(state.xhs.officialDrafts||[]).filter(item=>item.accountId===xhsAccountId());
  const shown=xhsFilteredDrafts(items);
  const offset=Number(coverage.offset)||0,limit=Number(coverage.limit)||50;
  const pageButtons=offset>0||coverage.hasMore?`<div class="xhs-draft-actions"><button type="button" class="text-button" data-action="xhs-service-page" data-offset="${Math.max(0,offset-limit)}" ${offset<=0||xhsWorking()?'disabled':''}>上一页</button><span>第 ${Math.floor(offset/limit)+1} 页</span><button type="button" class="text-button" data-action="xhs-service-page" data-offset="${offset+limit}" ${!coverage.hasMore||xhsWorking()?'disabled':''}>下一页</button></div>`:'';
  const rows=shown.map(draft=>`<tr><td><button class="text-button" type="button" data-action="xhs-detail" data-kind="official-draft" data-id="${h(draft.key)}">${h(draft.title||'未命名草稿')}</button></td><td>${h(publisherDraftStatus(draft))}</td><td>${h(draft.imageCount??'—')}</td><td>${h(xhsDate(draft.updatedAt))}</td></tr>`).join('');
  return `${sync.error?`<div class="xhs-inline-error" role="alert">${h(sync.error)}</div>`:''}${sync.lastSyncAt?`<div class="xhs-official-summary"><span>本页 ${items.length} 份草稿</span><span>读取于 ${h(xhsDate(sync.lastSyncAt))}</span></div>`:''}${rows?`<div class="xhs-content-table-wrap"><table class="xhs-content-table"><thead><tr><th scope="col">草稿标题</th><th scope="col">处理状态</th><th scope="col">配图</th><th scope="col">更新时间</th></tr></thead><tbody>${rows}</tbody></table></div>`:`<div class="xhs-data-empty"><p>${state.xhsDraftSearch?'本页没有匹配的草稿。':sync.lastSyncAt?'本页暂无服务草稿。':'点击「读取服务草稿」查看这个账号的草稿。'}</p></div>`}${pageButtons}`;
}
function xhsExistingDraft(projectId=state.xhsProjectId) {
  return (state.xhs?.drafts||[]).find(draft=>draft.projectId===projectId&&draft.accountId===xhsAccountId()&&['queued','running','filled','unknown','interrupted'].includes(draft.status));
}
function xhsComposerView() {
  const available=state.projects.filter(xhsEligible),p=available.find(project=>project.id===state.xhsProjectId),preview=state.xhsPreview;
  if(p&&!preview)state.xhsPreview={title:p.title||'',content:p.caption||'',accountId:xhsAccountId()};
  const draft=state.xhsPreview;
  return `<form id="xhs-draft-form"><label for="xhs-project">选择已完成的作品</label><select id="xhs-project" name="projectId" ${state.xhsBusy==='draft'?'disabled':''}><option value="">选择一份图文…</option>${available.map(project=>`<option value="${h(project.id)}" ${p?.id===project.id?'selected':''}>${h(project.title||'未命名作品')}</option>`).join('')}</select>${!available.length?'<p class="field-help">完成文案和全部图片后，即可在这里选择作品。</p><button type="button" class="text-button" data-action="navigate" data-view="briefing">去创作图文 →</button>':''}${p&&draft?`<div class="xhs-preview-target" id="xhs-preview-target">${xhsBound()?`${icon(xhsConnected()?'check':'lock')}目标账号：${h(state.xhs.account.nickname||state.xhs.account.id)}${xhsConnected()?'':' · '+xhsAvailabilityHint}`:`${icon('lock')}${h(xhsAccountSetupHint())}`}</div><div class="xhs-preview-images" aria-label="本次草稿图片，按原作品顺序">${p.pages.map((page,index)=>`<figure><img src="${h(page.imageUrl)}" alt="第 ${index+1} 张：${h(page.title)}" loading="lazy"><figcaption>${String(index+1).padStart(2,'0')}</figcaption></figure>`).join('')}</div><div class="xhs-preview-label"><label for="xhs-title">小红书标题</label><span id="xhs-title-count"></span></div><input id="xhs-title" name="title" ${state.xhsBusy==='draft'?'disabled':''} value="${h(draft.title)}" placeholder="为这篇图文取个标题" required><div class="xhs-preview-label"><label for="xhs-content">帖子正文</label><span id="xhs-content-count"></span></div><textarea id="xhs-content" name="content" rows="7" ${state.xhsBusy==='draft'?'disabled':''} placeholder="检查正文和话题，确认后送入草稿">${h(draft.content)}</textarea><p class="field-help">这里的调整只用于本次小红书草稿，原作品会保留。</p><div id="xhs-submit-notice" class="xhs-submit-notice" role="status"></div><button id="xhs-submit-draft" type="submit" class="button button-primary button-full">${icon('arrow')}确认送入电脑草稿</button><p class="xhs-submit-help">会向上方账号上传 ${p.pages.length} 张图片并保存草稿。核验后，可从作品记录预约发布。</p>`:'<div class="xhs-composer-empty">'+icon('image')+'<p>选择作品后，先在这里检查图片、标题和正文。</p></div>'}</form>`;
}
function xhsRetryLabel(draft) {
  return ({recover_receipt:'找回任务回执',download:'重试素材下载',resubmit:'重新提交原请求'})[draft.retryMode]||'重新准备草稿';
}
function xhsDraftsView() {
  const drafts=xhsFilteredDrafts((state.xhs?.drafts||[]).filter(draft=>draft.accountId===xhsAccountId()));
  if(!drafts.length)return `<div class="xhs-data-empty"><p>${state.xhsDraftSearch?'没有匹配的送稿记录，试试其他标题关键词。':'送出的草稿会留在这里，展示真实处理结果。'}</p></div>`;
  return drafts.map(draft=>`<article class="xhs-draft-item"><div><span class="xhs-draft-state status-${h(draft.status)}">${['queued','running'].includes(draft.status)?'<span class="spinner spinner-small"></span>':''}${h(draft.rechecking?'正在重新核验草稿':XHS_DRAFT_LABELS[draft.status]||'状态待核验')}</span><small>${h(xhsDate(draft.updatedAt||draft.createdAt))}</small></div><h3>${h(draft.title||'未命名草稿')}</h3><p>${h(draft.message||'请在发布服务核对此任务。')}</p>${draft.verifiedAt?`<small>核验时间 ${h(xhsDate(draft.verifiedAt))}</small>`:''}${draft.remoteJobId?`<small>服务任务 <code>${h(draft.remoteJobId)}</code></small>`:''}<div class="xhs-draft-actions"><button type="button" class="text-button" data-action="xhs-detail" data-kind="submission" data-id="${h(draft.id)}">预览本地冻结稿</button>${xhsCanRecheck(draft)?`<button type="button" class="text-button" data-action="xhs-recheck" data-id="${h(draft.id)}" ${xhsWorking()||draft.accountId!==xhsAccountId()?'disabled':''}>${icon('refresh')}查询任务结果</button>`:''}${draft.canRetry&&draft.accountId===xhsAccountId()&&!xhsDeliveryReadOnly()?`<button type="button" class="text-button" data-action="xhs-retry" data-id="${h(draft.id)}" ${xhsWorking()?'disabled':''}>${h(xhsRetryLabel(draft))}</button>`:''}</div></article>`).join('');
}
function xhsDetailPath(detail=state.xhsDetail) {
  if(!detail)return '';
  const group=detail.kind==='official-draft'?'official-drafts':'submissions';
  return `/api/xhs/${group}/${encodeURIComponent(detail.id)}`;
}
function xhsDetailCurrent(detail,version) {
  return state.view==='xhs'&&state.xhsDetail===detail&&detail.accountId===xhsAccountId()&&detail.providerKey===state.xhs?.providerKey&&version===xhsDetailRequestVersion;
}
function closeXhsDetail({restoreFocus=true}={}) {
  clearTimeout(state.xhsDetail?.poll);
  document.querySelector('#xhs-draft-editor[open]')?.close();
  ++xhsDetailRequestVersion;state.xhsDetail=null;
  const dialog=document.querySelector('#xhs-detail-dialog');if(dialog?.open)dialog.close();
  if(restoreFocus){const target=xhsDetailReturnFocus?.isConnected?xhsDetailReturnFocus:document.querySelector('.xhs-draft-source [aria-pressed="true"]');target?.focus({preventScroll:true});}
  xhsDetailReturnFocus=null;
}
function updateXhsDetail() {
  const current=state.xhsDetail,region=document.querySelector('#xhs-detail-region');if(!current||!region)return;
  const detail=current.detail,local=current.kind==='submission',busy=current.loading;
  const images=(Array.isArray(detail?.images)?detail.images:[]).filter(image=>typeof image==='string'&&(local?image.startsWith('/media/'):image.startsWith('/api/xhs/official-drafts/'+current.id+'/images/')));
  const confirmed=detail?.phase==='ready'&&detail?.platformStatus==='draft_verified'&&!detail.pendingUpdate;
  const scheduled=detail?.phase==='scheduled'&&detail?.platformStatus==='scheduled';
  const version=detail?.contentVersion?' · 第 '+detail.contentVersion+' 版':'';
  const content=typeof detail?.content==='string'?detail.content:'';
  const source=local?'送稿时的内容':'发布服务草稿';
  const status=local?'送稿时保存的版本':detail?publisherDraftStatus(detail):'查询服务草稿';
  const focused=document.activeElement,focusAction=focused?.closest('#xhs-detail-region')?focused.dataset.action:null,scroll=region.closest('dialog')?.scrollTop||0;
  region.innerHTML=`<div class="xhs-detail-heading"><div><span class="xhs-detail-source">${source}</span><h2 id="xhs-detail-title">${h(detail?.title||current.title||'内容预览')}</h2></div><button class="icon-button" type="button" data-action="xhs-detail-close" aria-label="关闭内容预览">${icon('close')}</button></div>
    <div class="xhs-detail-body"><div class="xhs-detail-status"><strong>${h(status+version)}</strong>${detail?.message?`<p>${h(detail.message)}</p>`:''}</div>
    ${busy?'<div class="xhs-detail-loading" role="status"><span class="spinner spinner-small"></span>正在读取内容…</div>':''}
    ${current.error?`<div class="xhs-inline-error" role="alert">${h(current.error)}</div><button class="button button-secondary" type="button" data-action="xhs-detail-retry">重试读取预览</button>`:''}
    ${images.length?`<div class="xhs-detail-images" aria-label="送稿图片">${images.map((image,i)=>`<figure><img src="${h(image)}" alt="第 ${i+1} 张图片" loading="lazy"><figcaption>${i+1} / ${images.length}</figcaption></figure>`).join('')}</div>`:''}
    ${detail&&!local?`<p class="xhs-detail-empty">配图 ${h(detail.imageCount??'—')} 张</p>`:''}
    ${content?`<div class="xhs-detail-content">${h(content)}</div>`:''}
    ${detail?.pendingUpdate?`<div class="xhs-detail-status"><strong>待核验 · 第 ${h(detail.pendingUpdate.contentVersion)} 版</strong><p>${h(detail.pendingUpdate.title)} · ${h(detail.pendingUpdate.imageCount)} 张配图</p></div>`:''}
    ${current.editNotice?`<p role="status">${h(current.editNotice)}</p>`:''}
    ${detail&&!local?`<div class="xhs-draft-actions">${detail.editable?`<button type="button" class="button button-secondary" data-action="xhs-edit-official">修改这份草稿</button>`:h(detail.editBlockReason||'')}
    ${(confirmed||scheduled)&&detail.contentVersion&&detail.contentHash?`<button type="button" class="button button-secondary" data-action="xhs-schedule-official" data-id="${h(current.id)}">${scheduled?'查看预约':'预约这版草稿'}</button>`:''}<button type="button" class="text-button" data-action="xhs-detail-retry">刷新进度</button></div>`:''}
    ${detail?.versions?.length?`<details><summary>历史版本（${detail.versions.length}）</summary>${detail.versions.map(v=>`<details><summary>第 ${h(v.contentVersion)} 版 · ${h(v.title)}</summary><p class="xhs-detail-content">${h(v.content)}</p><div class="xhs-detail-images">${v.images.map((url,i)=>`<img src="${h(url)}" alt="历史版本配图 ${i+1}" loading="lazy">`).join('')}</div></details>`).join('')}</details>`:''}
    ${detail&&!local?`<p class="xhs-data-note">服务草稿编号 <code>${h(current.id)}</code></p>`:''}</div>`;
  if(focusAction)region.querySelector(`[data-action="${focusAction}"]`)?.focus({preventScroll:true});
  if(region.closest('dialog'))region.closest('dialog').scrollTop=scroll;
}
async function openXhsDetail(kind,id,trigger) {
  if(!['official-draft','submission'].includes(kind)||!id||!xhsDeliveryAccountOpen())return;
  const collection=kind==='official-draft'?state.xhs.officialDrafts:state.xhs.drafts;
  const item=(collection||[]).find(item=>(kind==='official-draft'?item.key:item.id)===id&&(!item.accountId||item.accountId===xhsAccountId()));
  if(!item)return;
  closeXhsDetail({restoreFocus:false});xhsDetailReturnFocus=trigger;
  const current={kind,id,accountId:xhsAccountId(),providerKey:state.xhs?.providerKey,title:item.title||'',detail:null,loading:true,error:''};state.xhsDetail=current;
  const version=++xhsDetailRequestVersion;updateXhsDetail();
  const dialog=document.querySelector('#xhs-detail-dialog');if(!dialog)return;dialog.showModal();dialog.querySelector('[data-action="xhs-detail-close"]')?.focus();
  await getXhsDetail(current,version);
}
async function getXhsDetail(current,version) {
  try{
    const query=new URLSearchParams({accountId:current.accountId});
    if(current.editReceipt)query.set('editJobId',current.editReceipt.jobId);
    const result=await api(xhsDetailPath(current)+'?'+query);
    if(!xhsDetailCurrent(current,version))return;
    if((result.accountId&&result.accountId!==current.accountId)||(result.detail?.accountId&&result.detail.accountId!==current.accountId))throw new Error('草稿内容不属于当前账号，请重新读取。');
    current.detail=result.detail||null;current.loading=false;
    current.error=result.contentStatus?.error||(!result.detail&&current.kind==='submission'?'这份送稿记录的本地冻结稿暂不可读取。':'');
    clearTimeout(current.poll);
    if(current.kind==='official-draft'&&current.detail){
      const draft=current.detail,receipt=current.editReceipt;
      const job=draft.editJob;
      const jobMatches=receipt&&job?.id===receipt.jobId&&job.status==='succeeded'&&job.contentVersion===receipt.contentVersion
        &&(!job.contentHash||job.contentHash===draft.contentHash);
      if(jobMatches&&draft.activeJobId===receipt.jobId&&draft.contentVersion===receipt.contentVersion&&draft.phase==='ready'&&draft.platformStatus==='draft_verified'&&!draft.pendingUpdate&&draft.contentHash){
        current.editNotice='微服务已核验本次修改。';current.editReceipt=null;
      } else if(receipt&&['failed','canceled','needs_attention'].includes(job?.status)){
        current.editNotice=job.status==='canceled'?'本次修改已取消。':'修改未完成，请在发布微服务中核对任务。';current.editReceipt=null;
      } else if(receipt&&!['ready','queued_update','downloading_update','updating'].includes(draft.phase)){
        current.editNotice='修改任务尚未核验成功，请查看草稿处理状态。';
      }
      if(current.editReceipt&&Date.now()-current.editReceipt.submittedAt>30*60_000){
        current.editReceipt=null;current.editNotice='请刷新查看微服务处理结果。';
      }
      if(['queued_update','downloading_update','updating'].includes(draft.phase)||current.editReceipt&&draft.phase==='ready'&&draft.contentVersion<current.editReceipt.contentVersion){
        current.poll=setTimeout(()=>{if(xhsDetailCurrent(current,version))void getXhsDetail(current,++xhsDetailRequestVersion);},5000);
      }
      const row=state.xhs?.officialDrafts?.find(r=>r.key===current.id&&r.accountId===current.accountId);
      if(row&&(row.title!==draft.title||row.phase!==draft.phase||row.platformStatus!==draft.platformStatus||row.updatedAt!==draft.updatedAt)){
        Object.assign(row,{title:draft.title,phase:draft.phase,platformStatus:draft.platformStatus,imageCount:draft.imageCount,updatedAt:draft.updatedAt});
        replaceXhsRegion('#xhs-official-drafts-region',publisherDraftsView());
      }
    }
    updateXhsDetail();
  }catch(error){if(xhsDetailCurrent(current,version)){current.loading=false;current.error=error.message;updateXhsDetail();}}
}
async function syncXhsOfficialDrafts(offset=0) {
  if(xhsWorking()||!xhsDeliveryAccountOpen())return;
  const accountId=xhsAccountId(),version=++xhsLoadVersion;clearTimeout(xhsPollTimer);state.xhsBusy='official-drafts';state.xhsError='';updateXhs();
  const current=()=>version===xhsLoadVersion&&state.view==='xhs'&&state.xhsRoute.accountId===accountId;
  try{const result=await api('/api/xhs/official-drafts/sync',{method:'POST',body:{accountId,offset,limit:50}});if(current())acceptXhs(result,accountId);}
  catch(error){if(current()){state.xhsError=error.message;notify(error.message,true);}}
  finally{if(version===xhsLoadVersion)state.xhsBusy='';updateXhs();scheduleXhsPoll();}
}
function acceptXhs(payload,accountId=xhsAccountId(),defaultRead=false) {
  const snapshot=payload?.snapshot||payload;
  if(!snapshot?.connection||!snapshot?.status||!Array.isArray(snapshot.drafts))throw new Error('小红书工作台数据不完整，请重新读取。');
  if(snapshot.provider!=='publisher')throw new Error('当前后端尚未接入小红书发布服务，请更新并重启工作台。');
  if(!defaultRead&&(!accountId||snapshot.account?.id!==accountId))throw new Error('草稿工作台回执与所选账号不一致。');
  const updateDefault=defaultRead||accountId===state.xhsDefault?.account?.id;
  const previous=updateDefault?state.xhsDefault:state.xhsScoped;
  if(previous&&(previous.providerKey!==snapshot.providerKey||previous.account?.id!==snapshot.account?.id)){
    state.xhsPublished=null;
    closeXhsDetail({restoreFocus:false});
    ++xhsDraftRequestVersion;state.xhsBusy='';state.xhsProjectId='';state.xhsPreview=null;
    state.xhsDraftSearch='';state.xhsDraftSource='official';state.xhsComposerOpen=false;
  }
  if(updateDefault){
    if(previous?.providerKey!==snapshot.providerKey)state.xhsScoped=null;
    state.xhsDefault=snapshot;
  }else state.xhsScoped=snapshot;
  if(state.xhsPreview&&!state.xhsPreview.accountId)state.xhsPreview.accountId=xhsAccountId();
  if(updateDefault&&(snapshot.deliveryConfiguration?.configured===false||!snapshot.account?.id&&!state.guide.creation)&&state.guide.xhsAutoDelivery){state.guide.xhsAutoDelivery=false;saveGuidance();}
  return snapshot;
}
function updateXhsComposerState() {
  const preview=state.xhsPreview,form=document.querySelector('#xhs-draft-form');if(!form)return;
  form.querySelectorAll('select,input,textarea').forEach(input=>{input.disabled=xhsWorking();});
  if(!preview)return;
  const titleLength=Array.from(preview.title).length,contentLength=Array.from(preview.content).length,existing=xhsExistingDraft(),previous=(state.xhs?.drafts||[]).find(draft=>draft.projectId===state.xhsProjectId&&draft.accountId===xhsAccountId());
  [['#xhs-title-count',titleLength,20],['#xhs-content-count',contentLength,1000]].forEach(([selector,count,max])=>{const el=form.querySelector(selector);if(el){el.textContent=`${count} / ${max}`;el.classList.toggle('is-error',count>max);}});
  const problem=draftCopyProblem(preview.title,preview.content);
  const valid=xhsBound()&&preview.accountId===xhsAccountId()&&preview.title.trim()&&!problem&&!xhsWorking()&&!existing;
  const button=form.querySelector('#xhs-submit-draft');if(button){button.disabled=!valid;button.innerHTML=state.xhsBusy==='draft'?'<span class="spinner spinner-small"></span>'+(!xhsConnected()?'正在检查服务':'正在准备'):existing?'这份作品已有待核验草稿':icon('arrow')+(!xhsConnected()&&xhsBound()?'检查服务并送稿':previous?.status==='verified'?'准备当前版本的电脑草稿':'确认送入电脑草稿');}
  const note=form.querySelector('#xhs-submit-notice');if(note){note.textContent=existing?`这份作品${XHS_DRAFT_LABELS[existing.status]||'已有草稿记录'}，请查看送稿记录。`:problem||(!xhsBound()?xhsAccountSetupHint():!preview.title.trim()?'请填写小红书标题。':!xhsConnected()?'送稿前会检查发布服务是否就绪。':previous?.status==='verified'?'已有电脑草稿已核验。相同内容会复用记录；调整标题、正文或图片后会另存新版，原草稿不会被覆盖。':previous?.status==='failed'?'这份作品有未完成的草稿记录。同一版本请在下方查看原因或重新准备；修改内容可另存新版。':'');note.classList.toggle('is-error',Boolean(problem));note.hidden=!note.textContent;}
}
function updateXhs() {
  if(state.view==='briefing'){updateGuideXhs();return;}
  if(state.view!=='xhs')return;
  const page=document.querySelector('#xhs-page'),management=page?.querySelector('#xhs-management-region');
  if(!page||!management||!state.xhs){render();return;}
  const active=document.activeElement,focus=active?.closest('#xhs-management-region')?{id:active.id,action:active.dataset.action,profileId:active.dataset.profileId,kind:active.dataset.kind,itemId:active.dataset.id,tab:active.dataset.tab,source:active.dataset.source,start:active.selectionStart,end:active.selectionEnd}:null;
  const scrollElement=page.querySelector('.xhs-content-table-wrap'),scrollTop=scrollElement?.scrollTop,scrollLeft=scrollElement?.scrollLeft;
  const replace=replaceXhsRegion;
  const draftPanel=state.xhsRoute.tab==='drafts'&&xhsDeliveryAccountOpen(),screen=xhsScreenKey();
  if(management.dataset.screen!==screen||!draftPanel){
    replace('#xhs-management-region',xhsManagementView());management.dataset.screen=screen;
  }
  replace('#xhs-status-region',xhsStatusView());
  if(draftPanel){
    const select=page.querySelector('#xhs-project'),priorSelection=select?.value||'',available=state.projects.filter(xhsEligible);
    if(state.xhsProjectId&&!available.some(project=>project.id===state.xhsProjectId)){state.xhsProjectId='';state.xhsPreview=null;}
    replace('#xhs-account-region',xhsAccountView());
    replace('#xhs-connection-region',xhsDraftConnectionView());
    replace('#xhs-drafts-region',xhsDraftsView());
    replace('#xhs-official-drafts-region',publisherDraftsView());
    replace('#xhs-draft-refresh',xhsDraftRefreshView());
    replace('.xhs-draft-source',xhsDraftSourceView());
    if(priorSelection!==state.xhsProjectId||!select)replace('#xhs-composer-region',xhsComposerView());
    else {
      const options='<option value="">选择一份图文…</option>'+available.map(project=>`<option value="${h(project.id)}" ${state.xhsProjectId===project.id?'selected':''}>${h(project.title||'未命名作品')}</option>`).join('');
      if(select._xhsOptions!==options){select.innerHTML=options;select.value=state.xhsProjectId;select._xhsOptions=options;}
    }
    const official=page.querySelector('#xhs-official-drafts-region'),submissions=page.querySelector('#xhs-submissions-region');
    if(official)official.hidden=state.xhsDraftSource!=='official';if(submissions)submissions.hidden=state.xhsDraftSource!=='submissions';
    const target=page.querySelector('#xhs-preview-target');if(target)target.textContent=xhsBound()?`目标账号：${state.xhs.account.nickname||state.xhs.account.id}${xhsConnected()?'':' · '+xhsAvailabilityHint}`:xhsAccountSetupHint();
    const draftSearch=page.querySelector('#xhs-draft-search');if(draftSearch&&draftSearch.value!==state.xhsDraftSearch)draftSearch.value=state.xhsDraftSearch;
  }
  const table=page.querySelector('.xhs-content-table-wrap');if(table&&scrollElement){table.scrollTop=scrollTop;table.scrollLeft=scrollLeft;}
  if(focus&&!active.isConnected){
    const next=focus.id?document.getElementById(focus.id):[...management.querySelectorAll('[data-action]')].find(el=>el.dataset.action===focus.action&&el.dataset.profileId===focus.profileId&&el.dataset.kind===focus.kind&&el.dataset.id===focus.itemId&&el.dataset.tab===focus.tab&&el.dataset.source===focus.source);
    if(next&&!next.disabled){next.focus({preventScroll:true});if(typeof focus.start==='number'&&typeof next.setSelectionRange==='function')try{next.setSelectionRange(focus.start,focus.end);}catch{}}
  }
  updateXhsComposerState();updateXhsDetail();
}
function scheduleXhsPoll() {
  clearTimeout(xhsPollTimer);
  if(['xhs','briefing'].includes(state.view)&&(xhsWorking()||(state.xhs?.drafts||[]).some(draft=>draft.accountId===xhsAccountId()&&['queued','running'].includes(draft.status))))xhsPollTimer=setTimeout(()=>loadXhs({quiet:true}),5000);
}
async function loadXhsAccounts() {
  const version=++xhsAccountsVersion;state.xhsAccountsLoading=true;
  updateXhs();
  try{
    const payload=await api('/api/xhs/accounts?includeMetrics=1');
    if(version!==xhsAccountsVersion)return;
    if(!Array.isArray(payload.accounts))throw new Error('账号列表格式无效。');
    state.xhsAccounts=payload.accounts;state.xhsFetchedAt=payload.fetchedAt;state.xhsAccountsError='';
  }catch(error){
    if(version!==xhsAccountsVersion)return;
    state.xhsAccounts=null;state.xhsAccountsError=error.message;
  }finally{if(version===xhsAccountsVersion){state.xhsAccountsLoading=false;updateXhs();}}
}
async function loadXhsWorkspace() {
  await loadXhs({quiet:Boolean(state.xhs),refreshProjects:true,accountId:''});
  if(state.view!=='xhs')return;
  if(!state.xhs?.configured){
    ++xhsAccountsVersion;state.xhsAccounts=null;state.xhsAccountsLoading=false;state.xhsAccountsError='';state.xhsFetchedAt=null;
    updateXhs();return;
  }
  await loadXhsAccounts();
  await loadOpenXhsTab(true);
}
function notesOpen(id) {
  return state.view==='xhs' && state.xhsRoute.accountId===id && state.xhsRoute.tab==='published';
}
function pollNotes(id, task) {
  clearTimeout(noteSyncTimer);
  if(notesOpen(id) && notesPending(task.job?.status) && !task.error) {
    noteSyncTimer=setTimeout(()=>{ if(notesOpen(id))void runNotesSync(id,false); },4000);
  }
}
async function runNotesSync(id, start) {
  if(!notesOpen(id))return;
  const task=notesTask(id);
  if(task.busy)return;
  const jobId=notesPending(task.job?.status)?task.job.jobId:null;
  if(!jobId && !start)return;
  clearTimeout(noteSyncTimer);
  task.busy=true;task.error='';updateXhs();
  try {
    const endpoint='/api/xhs/accounts/'+encodeURIComponent(id)+'/notes/sync';
    if(!jobId&&!task.requestId)rememberNotesRequest(task,crypto.randomUUID());
    const result=jobId?await api(endpoint+'/'+encodeURIComponent(jobId)):await api(endpoint,{method:'POST',body:{requestId:task.requestId}});
    const job=result?.job;
    if(job?.accountId!==id||job.action!=='sync_notes'||!job.jobId||(jobId&&job.jobId!==jobId))throw Error('笔记同步回执与所选账号或任务不一致。');
    task.job=job;
    rememberNotesRequest(task,null);
    if(notesOpen(id)&&!notesPending(job.status))await loadXhsPublished(0);
  } catch(error) {
    task.error=error.message;
  } finally {
    task.busy=false;
    if(notesOpen(id)){updateXhs();pollNotes(id,task);}
  }
}
async function loadXhsPublished(offset=0) {
  const row=xhsSelectedAccount();
  if(!row||!notesOpen(row.accountId)||!Number.isSafeInteger(offset)||offset<0)return;
  const request={offset,loading:true,data:state.xhsPublished?.data};
  state.xhsPublished=request;updateXhs();
  try {
    const data=await api(`/api/xhs/accounts/${encodeURIComponent(row.accountId)}/notes?offset=${offset}`);
    if(state.xhsPublished!==request)return;
    if(!Array.isArray(data.items)||!Number.isSafeInteger(data.total)||data.total<0||!Number.isSafeInteger(data.limit)||data.limit<1||data.offset!==offset)throw new Error('笔记列表格式无效。');
    if(offset>0&&offset>=data.total)return loadXhsPublished(Math.max(0,Math.floor((data.total-1)/data.limit)*data.limit));
    if(offset>0&&request.data?.lastSyncedAt&&data.lastSyncedAt!==request.data.lastSyncedAt)return loadXhsPublished(0);
    const task=notesTask(row.accountId);
    if(!task.busy && !notesPending(task.job?.status))task.job=data.sync || null;
    state.xhsPublished={offset,data};
    pollNotes(row.accountId,task);
  } catch(error) {
    if(state.xhsPublished!==request)return;
    state.xhsPublished={offset,data:request.data,error:error.message};
  }
  updateXhs();
}
async function loadOpenXhsTab(refresh=false) {
  const route=state.xhsRoute;
  if(state.view!=='xhs'||!xhsSelectedAccount())return;
  if(route.accountId!==state.xhsDefault?.account?.id&&(!xhsDeliveryAccountOpen()||refresh)){
    await loadXhs({quiet:true,accountId:route.accountId});
    if(state.view!=='xhs'||state.xhsRoute!==route)return;
  }
  if(state.xhsRoute.tab==='overview')return accountMetricsView.show(xhsSelectedAccount(),accountMetricsView.currentPeriod(),refresh);
  if(state.xhsRoute.tab==='published'){
    const current=state.xhsPublished;
    if(!current||refresh&&!current.loading)return loadXhsPublished(current?.offset??0);
    return;
  }
  return loadOpenXhsDrafts();
}
async function loadOpenXhsDrafts() {
  if(state.view==='xhs'&&state.xhsRoute.tab==='drafts'&&state.xhsDraftSource==='official'&&xhsDeliveryAccountOpen()&&!state.xhs?.officialDraftSync?.lastSyncAt&&!state.xhs?.officialDraftSync?.error)await syncXhsOfficialDrafts();
}
function applyXhsRoute(route) {
  const previous=state.xhsRoute;
  if(previous.accountId===route.accountId&&previous.tab===route.tab)return false;
  accountMetricsView.reset();
  state.xhsPublished=null;
  if(state.xhsDetail)closeXhsDetail({restoreFocus:false});
  if(previous.accountId!==route.accountId){
    resetXhsAccountActivity();
    state.xhsDraftSearch='';state.xhsDraftSource='official';state.xhsComposerOpen=false;state.xhsProjectId='';state.xhsPreview=null;
  }
  state.xhsRoute=route;
  return true;
}
function resetXhsAccountActivity() {
  accountMetricsView.reset();
  ++xhsLoadVersion;++xhsReadVersion;++xhsDraftRequestVersion;clearTimeout(xhsPollTimer);
  state.xhsScoped=null;state.xhsBusy='';state.xhsLoading=false;state.xhsError='';
}
function setXhsRoute(route,publish=true) {
  if(!applyXhsRoute(route))return;
  if(publish){
    if(EMBEDDED_MODE)postEmbeddedMessage({type:'content-studio:xhs-route',view:'xhs',...route});
    else{
      const url=new URL(location.href);url.searchParams.set('view','xhs');
      if(route.accountId){url.searchParams.set('accountId',route.accountId);url.searchParams.set('tab',route.tab);}
      else{url.searchParams.delete('accountId');url.searchParams.delete('tab');}
      window.history.pushState({},'',url);
    }
  }
  updateXhs();
  void loadOpenXhsTab();
}
window.addEventListener('popstate',()=>{
  if(EMBEDDED_MODE)return;
  const view=new URLSearchParams(location.search).get('view')||'briefing';
  if(view==='xhs'&&state.view==='xhs')setXhsRoute(readXhsRoute(),false);
  else if(state.view!==view)void navigateFromEmbeddedParent(view,view==='xhs'?readXhsRoute():null);
});
async function loadXhs({quiet=false,refreshProjects=false,accountId=state.view==='xhs'&&xhsSelectedAccount()?.accountId||''}={}) {
  const version=++xhsReadVersion,operation=xhsLoadVersion,busy=state.xhsBusy;
  const current=()=>version===xhsReadVersion&&operation===xhsLoadVersion&&(!busy||busy===state.xhsBusy)
    &&(!accountId||state.view==='xhs'&&state.xhsRoute.accountId===accountId);
  state.xhsLoading=true;if(!quiet&&!state.xhs&&state.view==='xhs')render();
  try{
    const snapshot=await api(accountId?'/api/xhs?accountId='+encodeURIComponent(accountId):'/api/xhs');if(!current())return;
    const first=!state.xhs;state.xhsError='';acceptXhs(snapshot,accountId,!accountId);
    if(refreshProjects){const result=await api('/api/projects');if(!current())return;state.projects=result.projects||state.projects;}
    if(state.view==='xhs'){if(first){render();updateXhsComposerState();}else updateXhs();}else if(state.view==='briefing')updateGuideXhs();
  }catch(error){if(current()){state.xhsError=error.message;if(state.view==='xhs'){if(state.xhs)updateXhs();else render();}else if(state.view==='briefing')updateGuideXhs();}}
  finally{if(version===xhsReadVersion){state.xhsLoading=false;if(state.view==='xhs'&&state.xhs)updateXhs();scheduleXhsPoll();}}
}
function chooseXhsProject(id) {
  ++xhsDraftRequestVersion;
  const p=state.projects.find(project=>project.id===id&&xhsEligible(project));state.xhsProjectId=p?.id||'';state.xhsPreview=p?{title:p.title||'',content:p.caption||'',accountId:xhsAccountId()}:null;
  replaceXhsRegion('#xhs-composer-region',xhsComposerView());updateXhsComposerState();
}
async function openXhsForProject(id,accountId='') {
  if(document.querySelector('#xhs-publish-dialog'))return;
  const {project}=await api('/api/projects/'+encodeURIComponent(id));
  if(project?.id!==id||!xhsEligible(project))return notify('请等文案和全部图片完成后，再准备小红书草稿。',true);
  await openXhsPublishDialog(project,{api,h,initialAccountId:accountId});
}
async function checkXhsPublisher() {
  if(!xhsBound()||xhsWorking())return;
  const accountId=xhsAccountId(),version=++xhsLoadVersion;clearTimeout(xhsPollTimer);state.xhsBusy='check';state.xhsError='';updateXhs();
  try{
    const result=await api('/api/xhs/check',{method:'POST',body:{accountId}});
    if(version===xhsLoadVersion&&accountId===xhsAccountId()){acceptXhs(result,accountId);notify(state.xhs.connection.message||'已检查发布服务。',!xhsConnected());}
  }catch(error){
    if(version===xhsLoadVersion&&accountId===xhsAccountId()){
      state.xhsError=error.message;notify(error.message,true);
      try{const snapshot=await api('/api/xhs?accountId='+encodeURIComponent(accountId));if(version===xhsLoadVersion&&accountId===xhsAccountId())acceptXhs(snapshot,accountId);}catch{}
    }
  }finally{if(version===xhsLoadVersion)state.xhsBusy='';updateXhs();scheduleXhsPoll();}
}
async function submitXhsDraft() {
  if(xhsDeliveryReadOnly())return notify(xhsDeliverySetupHint(),true);
  const preview=state.xhsPreview,p=state.projects.find(project=>project.id===state.xhsProjectId);if(!preview||!xhsEligible(p)||xhsWorking())return;
  if(!xhsBound()||preview.accountId!==xhsAccountId())return notify('服务账号已变化，请重新选择作品并核对目标账号。',true);
  if(!preview.title.trim()||draftCopyProblem(preview.title,preview.content))return updateXhsComposerState();
  if(xhsExistingDraft())return notify('请先在送稿记录中核对此次任务。',true);
  const body={projectId:p.id,accountId:preview.accountId,title:preview.title,content:preview.content};
  const operation=++xhsDraftRequestVersion;
  const isCurrent=()=>operation===xhsDraftRequestVersion&&state.view==='xhs'&&state.xhsProjectId===p.id&&state.xhsPreview===preview&&preview.accountId===body.accountId&&preview.title===body.title&&preview.content===body.content;
  const request=++xhsLoadVersion;clearTimeout(xhsPollTimer);state.xhsBusy='draft';state.xhsError='';updateXhs();
  try{
    if(xhsAccountId()!==body.accountId||state.xhs?.status?.busy||xhsExistingDraft(p.id))throw new Error('账号或草稿状态已变化，本次没有送稿，请重新核对。');
    const result=await api('/api/xhs/drafts',{method:'POST',body});if(!isCurrent())return;acceptXhs(result);const status=result.draft?.status;state.xhsDraftSource='submissions';notify(status==='verified'?'电脑草稿已核验。':status==='failed'?'这份草稿尚未准备完成，请查看下方原因。':['unknown','filled','interrupted'].includes(status)?'上次保存结果仍需核对，请查看送稿记录。':'草稿任务已提交，可在下方查看处理结果。',['failed','unknown','interrupted'].includes(status));
  }
  catch(error){if(!isCurrent())return;state.xhsError=error.message;notify(error.message,true);if(error.status===409){await loadXhs({quiet:true});if(isCurrent())state.xhsError=error.message;}}
  finally{if(request===xhsLoadVersion)state.xhsBusy='';updateXhs();scheduleXhsPoll();}
}
async function retryXhsDraft(id) {
  if(xhsDeliveryReadOnly())return notify(xhsDeliverySetupHint(),true);
  const draft=state.xhs?.drafts?.find(item=>item.id===id);if(!draft?.canRetry||draft.accountId!==xhsAccountId()||xhsWorking())return;
  const version=++xhsLoadVersion;clearTimeout(xhsPollTimer);state.xhsBusy='retry';state.xhsError='';updateXhs();
  const accountId=draft.accountId;
  try{const result=await api(`/api/xhs/drafts/${encodeURIComponent(id)}/retry`,{method:'POST',body:{accountId}});if(version!==xhsLoadVersion||accountId!==xhsAccountId())return;acceptXhs(result,accountId);notify('请在送稿记录中查看最新处理结果。');}
  catch(error){if(version!==xhsLoadVersion||accountId!==xhsAccountId())return;state.xhsError=error.message;notify(error.message,true);if(error.status===409)await loadXhs({quiet:true});}
  finally{if(version===xhsLoadVersion)state.xhsBusy='';updateXhs();scheduleXhsPoll();}
}
async function recheckXhsDraft(id,{fromGuide=false}={}) {
  const p=state.guideProject,delivery=p?.xhsDelivery;
  const draft=(state.xhs?.drafts||[]).find(item=>item.id===id)||(fromGuide&&delivery?.draftId===id?delivery:null);
  if(!id||!xhsCanRecheck(draft)||xhsWorking()||(fromGuide&&guideWorkActive()))return;
  if(draft.accountId!==xhsAccountId())return notify('目标账号与当前服务账号不一致。',true);
  const version=guideCreationVersion,projectId=p?.id,accountId=draft.accountId;
  const requestVersion=++xhsLoadVersion;clearTimeout(xhsPollTimer);state.xhsBusy='recheck';state.xhsError='';if(fromGuide)state.guideActionBusy='xhs-recheck';updateXhs();
  const current=()=>requestVersion===xhsLoadVersion&&accountId===xhsAccountId();
  try{
    const result=await api(`/api/xhs/drafts/${encodeURIComponent(id)}/recheck`,{method:'POST',body:{accountId}});if(!current())return;acceptXhs(result,accountId);
    if(fromGuide&&version===guideCreationVersion&&state.guide.creation?.projectId===projectId)await loadGuideProject({quiet:true});
    if(current())notify('已查询原任务，请查看最新状态。');
  }catch(error){if(!current())return;state.xhsError=error.message;notify(error.message,true);if(error.status===409)await loadXhs({quiet:true});}
  finally{
    if(requestVersion===xhsLoadVersion)state.xhsBusy='';
    if(fromGuide&&version===guideCreationVersion){state.guideActionBusy='';renderGuidance({preserve:true});beginGuidePolling();}
    else updateXhs();
    scheduleXhsPoll();
  }
}

const RADAR_SETTINGS = {enabled:false,dailyTime:'09:00',maxPerDay:3,style:'photo',aspect:'3:4',count:3,mode:'cards'};
const radarReady = () => state.radar?.profileReady ?? Boolean(state.radar?.profile?.name&&state.radar?.profile?.industry&&state.radar?.profile?.audience&&(state.radar?.profile?.description||state.radar?.profile?.sellingPoints?.length));
const radarDate = value => value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'暂未安排';
const radarStateText = value => ({pending:'待你决定',approved:'已批准',skipped:'已跳过',expired:'已失效'}[value]||'待你决定');
const RADAR_SKIP_REASONS = [['','暂不填写原因'],['not_relevant','与热点关联较弱'],['not_product_fit','不符合产品定位'],['repeated','类似内容做过了'],['timing','时机不适合'],['other','其他']];
const radarNotificationStatus = value => ({accepted:'服务已受理',failed:'发送失败',skipped:'未发送',unknown:'结果待确认',sending:'正在发送',pending:'等待发送'}[value]||'等待记录');
const radarReferenceMetadata = ids => (Array.isArray(ids)?ids:[]).filter(id=>/^[0-9a-f-]{36}$/i.test(id)).slice(0,4).map(id=>({id,url:`/reference-images/${id}`,name:'已保存的参考图'}));
const radarProjectActive = project => Boolean(project?.running||isActive(project));
function radarProjects() {
  const source=state.radar?.projectsSummary,items=Array.isArray(source)?source:Object.values(source||{}),ids=new Set((state.radar?.opportunities||[]).map(item=>item.projectId).filter(Boolean));
  const result=new Map(items.filter(Boolean).map(item=>[item.id,item]));
  state.projects.filter(item=>ids.has(item.id)&&!result.has(item.id)).forEach(item=>result.set(item.id,item));
  return [...result.values()];
}
function radarDashboardView() {
  const r=state.radar||{},today=r.today||{},checks=r.readiness?.checks||[
    {id:'profile',label:'产品资料',ready:radarReady(),section:'profile'},
    {id:'model',label:'文字与图片模型',ready:Boolean(state.config?.configured),section:'model'},
    {id:'schedule',label:'自动巡查',ready:Boolean(r.settings?.enabled),section:'schedule'},
    {id:'notifications',label:'选题通知',ready:Boolean(r.notificationConfig?.configured),section:'notifications'},
  ],required=checks.filter(item=>!item.optional),done=required.filter(item=>item.ready).length;
  const feedback=r.feedbackSummary,totalFeedback=typeof feedback==='number'?feedback:Number(feedback?.total??feedback?.count??0);
  return `<div class="radar-dashboard"><div class="radar-today" aria-label="今日概览">${[['scans','今日巡查'],['proposals','推荐选题'],['approved','已批准'],['completed','图文完成']].map(([key,label])=>`<div><strong>${Number(today[key])||0}</strong><span>${label}</span></div>`).join('')}</div><details class="radar-readiness"><summary><span class="${r.readiness?.ready||done===required.length?'is-ready':''}">${icon(done===required.length?'check':'settings')}设置完成 ${done} / ${required.length}</span><span>查看设置项 ＋</span></summary><div class="radar-readiness-checks">${checks.map(item=>`<button type="button" class="${item.ready?'is-ready':''}" data-action="radar-setup" data-section="${h(item.section||'profile')}">${icon(item.ready?'check':'plus')}<span>${h(item.label)}${item.optional?'（选填）':''}</span>${!item.ready?'<small>去设置 →</small>':''}</button>`).join('')}</div></details></div>${totalFeedback?`<p class="radar-feedback-summary">已记录 ${totalFeedback} 次选题偏好，用于后续选题参考。</p>`:''}`;
}
function radarHistoryView() {
  const items=Array.isArray(state.radar?.notificationHistory)?state.radar.notificationHistory:[],configured=state.radar?.notificationConfig?.configured;
  if(!items.length)return '<div class="radar-history-empty">还没有通知记录。发现选题、图文完成或发送测试后，会在这里显示实际状态。</div>';
  return `<div class="radar-notification-history-list">${items.map(item=>{
    const retry=['opportunity','result'].includes(item.kind)&&['failed','skipped'].includes(item.status)&&configured,busy=state.radarNotificationBusy===`${item.kind}:${item.entityId}`;
    return `<article class="radar-history-item"><div class="radar-history-heading"><strong>${h(({opportunity:'选题提案',result:'图文完成',test:'测试通知'}[item.kind])||'通知')}</strong><span class="radar-history-status status-${h(item.status)}">${item.status==='sending'?'<span class="spinner spinner-small"></span>':''}${h(radarNotificationStatus(item.status))}</span><small>${h(({email:'邮箱',wechat:'微信',none:'未开启'}[item.channel])||item.channel||'本地')}</small></div><p>${h(item.message||'暂无补充说明')}</p><div class="radar-history-footer"><span>${radarDate(item.updatedAt)}${Number(item.attempts)?` · 已尝试 ${Number(item.attempts)} 次`:''}</span>${retry?`<button type="button" class="text-button" data-action="radar-notification-retry" data-kind="${h(item.kind)}" data-id="${h(item.entityId)}" ${state.radarNotificationBusy?'disabled':''}>${busy?'<span class="spinner spinner-small"></span>正在重发':'重新发送'}</button>`:item.status==='unknown'?'<span>请先检查邮箱或微信，避免重复提醒。</span>':item.status==='accepted'?'<span>服务受理不等于已送达。</span>':''}</div></article>`;
  }).join('')}</div>`;
}
function radarView() {
  if(!state.radar)return `<section id="radar-page" class="radar-page"><div class="panel radar-loading" role="status">${state.radarLoading?'<span class="spinner"></span>':''}<h2>${state.radarError?'暂时没有连接上选题雷达':'正在准备你的选题雷达'}</h2><p>${h(state.radarError||'读取产品资料与待决策提案…')}</p>${state.radarError?'<button class="button button-secondary" data-action="radar-reload">重新连接</button>':''}</div></section>`;
  return `<section id="radar-page" class="radar-page" aria-label="选题雷达"><div id="radar-run-status">${radarRunView()}</div><div id="radar-dashboard">${radarDashboardView()}</div><section class="radar-board panel" aria-label="选题提案"><div class="radar-board-heading"><div><span class="eyebrow">A GOOD MOMENT TO SAY SOMETHING</span><h2>选题提案</h2></div><div class="radar-filter" role="group" aria-label="筛选提案">${[['pending','待决策'],['all','全部记录']].map(([value,label])=>`<button data-action="radar-filter" data-filter="${value}" class="${state.radarFilter===value?'active':''}" aria-pressed="${state.radarFilter===value}">${label}<span data-radar-count="${value}">${value==='pending'?state.radar.opportunities.filter(item=>item.state==='pending').length:state.radar.opportunities.length}</span></button>`).join('')}</div></div><div id="radar-opportunity-list" aria-live="polite">${radarOpportunitiesView()}</div><p class="radar-board-note">每条提案先给你看角度与依据。批准后，才会调用模型生成完整文案和图片。</p></section><div class="radar-setup-heading"><div><span class="eyebrow">TEACH YOUR EDITOR</span><h2>业务资料与任务配置</h2></div><p>资料与偏好保存一次，之后只需要做决定。</p></div><div class="radar-configuration"><details id="radar-profile-panel" class="panel radar-config-panel" ${!radarReady()?'open':''}><summary><span class="radar-config-icon">${icon('file')}</span><span><strong>产品与行业资料</strong><small id="radar-profile-summary">${h(radarProfileSummary())}</small></span><span class="radar-disclosure">+</span></summary><div class="radar-config-body">${radarProfileForm()}</div></details><details id="radar-schedule-panel" class="panel radar-config-panel"><summary><span class="radar-config-icon">${icon('history')}</span><span><strong>自动巡查与出图偏好</strong><small id="radar-schedule-summary">${h(radarScheduleSummary())}</small></span><span class="radar-disclosure">+</span></summary><div class="radar-config-body">${radarSettingsForm()}</div></details><details id="radar-notifications-panel" class="panel radar-config-panel"><summary><span class="radar-config-icon">${icon('bolt')}</span><span><strong>选题通知</strong><small id="radar-notifications-summary">${h(radarNotificationSummary())}</small></span><span class="radar-disclosure">+</span></summary><div class="radar-config-body">${radarNotificationsForm()}</div></details><details id="radar-notification-history-panel" class="panel radar-config-panel"><summary><span class="radar-config-icon">${icon('history')}</span><span><strong>通知记录</strong><small>查看选题提醒与图文完成通知的实际状态</small></span><span class="radar-disclosure">+</span></summary><div id="radar-notification-history">${radarHistoryView()}</div></details></div></section>`;
}
function radarProfileSummary() { const p=state.radar?.profile;return radarReady()?`${p.name} · ${p.materials?.length||0} 份案例与资料`:'补充产品、目标用户和可确认的卖点'; }
function radarScheduleSummary() { const s=state.radar?.settings||RADAR_SETTINGS;return s.enabled?`每天 ${s.dailyTime} · 北京时间 · 最多 ${s.maxPerDay} 个提案`:'尚未开启 · 也可以随时手动巡查'; }
function radarNotificationSummary() {const c=state.radar?.notificationConfig;return c?.channel==='email'?`邮箱提醒${c.configured?'已配置':'待完善'}`:c?.channel==='wechat'?`微信提醒${c.configured?'已配置':'待完善'}`:'尚未开启 · 推荐先使用邮箱';}
function radarRunView() {
  const r=state.radar,s=r?.settings||RADAR_SETTINGS,running=r?.status?.running||state.radarBusy==='scan';
  const error=state.radarError||r?.status?.error,notificationError=r?.status?.notificationError;
  return `<div class="radar-overview"><div class="radar-pulse ${running?'is-running':''}">${running?'<span class="spinner spinner-small"></span>':icon('search')}</div><div class="radar-overview-copy"><strong>${running?'正在寻找适合你的热点':radarReady()?`${h(r.profile.name)}的选题雷达`:'先让雷达认识你的产品'}</strong><p>${running?'采集热点并分析产品关联，页面会自动更新。':!radarReady()?'填写下方产品资料，就能开始筛选宣传机会。':s.enabled?`下次巡查 ${radarDate(r.nextRunAt)} · 北京时间`:'自动巡查已暂停，手动巡查随时可用。'}</p></div><button class="button button-primary" data-action="radar-scan" ${!radarReady()||running||!guideTextReady()?'disabled':''}>${running?'<span class="spinner spinner-small"></span>巡查中':icon('refresh')+'现在巡查'}</button></div>${!guideTextReady()?'<div class="radar-notice">配置文字模型后，就能开始分析选题。<button class="text-button" data-action="navigate" data-view="settings">去配置模型 →</button></div>':''}${error?`<div class="radar-notice is-error" role="alert">${icon('alert')}<span>${h(error)}</span><button class="text-button" data-action="radar-reload">重新读取</button></div>`:''}${notificationError?`<div class="radar-notice is-warning">${icon('alert')}<span>提案已保留，通知未成功：${h(notificationError)}</span></div>`:''}${r?.status?.lastRun?.message&&!running?`<p class="radar-last-run"><span>最近巡查 ${radarDate(r.status.lastScanAt||r.status.lastRun.completedAt)}</span>${h(r.status.lastRun.message)}</p>`:''}`;
}
function radarOpportunitiesView() {
  const items=(state.radar?.opportunities||[]).filter(item=>state.radarFilter==='all'||item.state==='pending');
  if(!items.length)return `<div class="radar-empty"><span class="radar-empty-mark">${icon(radarReady()?'search':'file')}</span><h3>${!radarReady()?'从你的产品开始':state.radarFilter==='all'?'暂无选题记录':'暂时没有待决策的选题'}</h3><p>${!radarReady()?'把中转站介绍、目标用户，以及你的工具作品或使用案例交给我。':state.radar?.status?.running?'正在分析本轮热点，请稍等。':'合适的话题出现后，会把宣传角度和理由一起送到这里。'}</p>${!radarReady()?'<button class="button button-secondary" data-action="radar-setup" data-section="profile">填写产品资料 '+icon('arrow')+'</button>':'<span class="radar-empty-note">有自然的结合点再做，保留每一次表达的质量。</span>'}</div>`;
  return items.map(radarOpportunityView).join('');
}
function radarProjectOpenLabel(item) {
  const p=radarProjects().find(project=>project.id===item.projectId);
  return ['error','partial','interrupted'].includes(p?.status)?'继续对话处理':p?.status==='completed'?'查看完整图文':p&&radarProjectActive(p)?'查看生成进度':'查看图文与进度';
}
function radarProjectView(item) {
  const p=item.state==='approved'&&radarProjects().find(project=>project.id===item.projectId);if(!p)return '';
  const active=radarProjectActive(p),total=Math.max(0,Number(p.total??p.pages?.length??p.count)||0),completed=Math.min(total,Math.max(0,Number(p.completed??p.pages?.filter(page=>page.imageUrl).length)||0));
  const label=p.status==='completed'&&p.running?'图文已完成，正在发送结果提醒':active&&p.chatStatus==='thinking'?'正在整理图文':statusText(p.status);
  return `<div class="radar-project-progress ${active?'is-active':''}"><div><strong>${active?'<span class="spinner spinner-small"></span>':''}${h(label)}</strong><span>${total?`${completed} / ${total} 张图片完成`:'正在准备内容与图片'}</span></div><progress class="radar-progress-track" aria-label="图文生成进度" max="${total||100}" ${total?`value="${completed}"`:''}></progress>${p.error?`<p class="radar-project-error">${h(p.error)} 可以继续对话调整或重试。</p>`:''}${p.resultNotification?.status?`<p class="radar-project-result-notification">完成通知 · ${h(radarNotificationStatus(p.resultNotification.status))}${p.resultNotification.error?` · ${h(p.resultNotification.error)}`:''}</p>`:''}</div>`;
}
function radarSkipForm(item) {
  const draft=state.radarSkipDrafts[item.id];if(item.state!=='pending'||!draft?.open)return '';
  return `<form class="radar-skip-form" data-radar-skip-id="${h(item.id)}"><div><strong>这次不做，也可以告诉我原因</strong><p>原因与备注都选填，会作为后续选题参考。</p></div><label>跳过原因<select data-radar-skip-field="reason" data-opportunity-id="${h(item.id)}">${RADAR_SKIP_REASONS.map(([value,label])=>`<option value="${value}" ${draft.reason===value?'selected':''}>${label}</option>`).join('')}</select></label><label>再补充一句（选填）<textarea data-radar-skip-field="note" data-opportunity-id="${h(item.id)}" maxlength="300" rows="2" placeholder="例如：希望多关联开发者的真实使用场景">${h(draft.note)}</textarea></label><div class="radar-skip-actions"><button type="button" class="text-button" data-action="radar-skip-cancel" data-id="${h(item.id)}">取消</button><button type="submit" class="button button-secondary" ${state.radarBusy?'disabled':''}>${state.radarBusy===`skip:${item.id}`?'<span class="spinner spinner-small"></span>正在跳过':'确认跳过'}</button></div></form>`;
}
function radarOpportunityView(item) {
  const t=item.trend||{},spec=item.spec||{},url=trendUrl(t.url),busy=Boolean(state.radarBusy);
  const materialTitles=[...new Set(item.materialTitles||item.productSnapshot?.materials?.map(material=>material.title)||[])],audience=item.audience||item.productSnapshot?.audience||'';
  const notice=item.notification||{},status=({accepted:'通知服务已接受',sent:'通知服务已接受',failed:'通知失败',unknown:'通知结果待确认',skipped:'未发送通知'}[notice.status]);
  return `<article class="radar-opportunity" data-radar-id="${h(item.id)}"><div class="radar-opportunity-top"><span class="radar-state radar-state-${h(item.state)}">${radarStateText(item.state)}</span><span>${h(trendName(t.platform))}${t.kind==='meme'?' · 留存期内热梗候选':''}</span><span class="radar-expiry">${item.state==='pending'?`建议在 ${radarDate(item.expiresAt)} 前决定`:`收录 ${radarDate(item.createdAt)}`}</span></div><h3>${h(item.title)}</h3><p class="radar-angle">${h(item.angle)}</p><div class="radar-origin"><span>话题线索</span>${url?`<a href="${h(url)}" target="_blank" rel="noopener noreferrer">${h(t.title)} ↗</a>`:`<strong>${h(t.title)}</strong>`}<small>采集 ${radarDate(t.fetchedAt)} · 源更新 ${t.sourceUpdatedAt?radarDate(t.sourceUpdatedAt):'时间未知'}</small></div><div class="radar-fit"><span class="radar-fit-label">为什么适合你</span><p>${h(item.reason)}</p>${audience?`<p class="radar-fit-detail"><strong>目标受众</strong>${h(audience)}</p>`:''}${materialTitles.length?`<p class="radar-fit-detail"><strong>关联案例与资料</strong>${materialTitles.map(h).join(' · ')}</p>`:''}</div>${item.outline?.length?`<details class="radar-outline"><summary>看看这 ${Number(spec.count)||item.outline.length} 张怎么讲 <span>＋</span></summary><ol>${item.outline.map(line=>`<li>${h(line)}</li>`).join('')}</ol></details>`:''}${item.factNotes?`<p class="radar-fact-note">${icon('file')}<span>${h(item.factNotes)}</span></p>`:''}${radarProjectView(item)}<div class="radar-opportunity-bottom"><div class="radar-spec"><span>${h(guideStyles().find(style=>style.id===spec.style)?.name||spec.style||'按默认风格')}</span><span>${h(spec.aspect||'3:4')}</span><span>${h(modeText(spec.mode||'cards'))} · ${Number(spec.count)||1} 张</span></div><div class="radar-decision-actions">${item.state==='pending'?`<button class="text-button" data-action="radar-skip" data-id="${h(item.id)}" ${busy?'disabled':''}>${state.radarBusy===`skip:${item.id}`?'正在跳过…':'这次跳过'}</button>${state.radar.notificationConfig?.publicBaseUrl?`<button class="text-button" data-action="radar-link" data-id="${h(item.id)}" ${busy?'disabled':''}>复制决策链接</button>`:''}<button class="button button-primary" data-action="radar-approve" data-id="${h(item.id)}" ${busy?'disabled':''}>${state.radarBusy===`approve:${item.id}`?'<span class="spinner spinner-small"></span>正在创建':'就做这篇'} ${icon('arrow')}</button>`:item.state==='approved'&&item.projectId?`<button class="button button-secondary" data-action="radar-open" data-id="${h(item.projectId)}">${h(radarProjectOpenLabel(item))} ${icon('arrow')}</button>`:`<span class="radar-decision-note">${h(item.expiryReason||(item.state==='skipped'?'已跳过，之后的机会会继续保留在这里。':'选题已超过有效窗口，可以重新巡查。'))}</span>`}</div></div>${radarSkipForm(item)}${status?`<div class="radar-notification-state ${['failed','unknown'].includes(notice.status)?'is-warning':''}">${h(status)}${notice.error?` · ${h(notice.error)}`:''}</div>`:''}</article>`;
}
function radarMaterialView(material={}) {
  const key=material.clientKey||material.id||`draft-${crypto.randomUUID()}`;
  if(!Object.hasOwn(state.radarMaterialReferences,key))state.radarMaterialReferences[key]=radarReferenceMetadata(material.referenceIds);
  return `<div class="radar-material" data-material-id="${h(material.id||'')}" data-material-key="${h(key)}"><div class="radar-material-heading"><label>工具作品 / 使用案例 / 行业资料<input data-material-field="title" maxlength="160" value="${h(material.title)}" placeholder="例如：一个用 API 做成的 coding 小工具"></label><button type="button" class="icon-button" data-action="radar-material-remove" aria-label="移除这份资料" ${state.radarUploadBusy?'disabled':''}>${icon('close')}</button></div><label>已确认的信息<textarea data-material-field="content" rows="5" maxlength="20000" placeholder="介绍作品解决什么问题、如何使用模型 API、已实现哪些功能。也可以粘贴行业资料。">${h(material.content)}</textarea></label><label>来源或链接（选填）<input data-material-field="source" maxlength="2000" value="${h(material.source)}" placeholder="作品链接、文档标题或资料出处"></label><div class="radar-material-images"><div><strong>这个案例的截图（选填）</strong><p>仅在选题引用此案例时使用，最多 4 张。</p></div><button type="button" class="text-button" data-action="radar-material-reference-add" data-key="${h(key)}" ${state.radarUploadBusy?'disabled':''}>${icon('image')}添加案例截图</button><input type="file" data-radar-material-input="${h(key)}" accept="image/png,image/jpeg,image/webp" multiple hidden><div class="radar-material-reference-images" data-material-reference-key="${h(key)}">${radarReferencesView(key)}</div></div></div>`;
}
function radarReferencesView(key='') {
  const images=key?(state.radarMaterialReferences[key]||[]):state.radarReferences;
  return `${images.length?`<div class="radar-reference-list">${images.map(image=>`<div class="radar-reference"><button type="button" class="radar-reference-preview" data-action="radar-reference-preview" data-id="${h(image.id)}" data-key="${h(key)}" aria-label="查看${key?'案例截图':'通用参考图'}：${h(image.name||'参考图')}"><img src="${h(image.url)}" alt="${h(image.name||'参考图')}"></button><button type="button" class="icon-button" data-action="${key?'radar-material-reference-remove':'radar-reference-remove'}" data-key="${h(key)}" data-id="${h(image.id)}" aria-label="移除${key?'此案例截图':'通用参考图'}" ${state.radarUploadBusy?'disabled':''}>${icon('close')}</button></div>`).join('')}</div>`:''}<span>${state.radarUploadBusy?'正在保存图片…':`${images.length} / 4 张 · PNG、JPEG 或 WebP，每张不超过 8 MB`}</span>`;
}
function radarProfileForm() {
  const p=state.radar?.profile||{};
  return `<form id="radar-profile-form"><p class="radar-form-intro">主产品可以是你的模型中转站。把多个 coding 小工具作为案例，雷达会从资料中寻找合适的宣传切口。</p><div class="radar-form-grid"><label for="radar-product-name">产品 / 品牌名称<input id="radar-product-name" name="name" maxlength="120" required value="${h(p.name)}" placeholder="例如：你的模型中转站"></label><label for="radar-industry">所属行业<input id="radar-industry" name="industry" maxlength="160" required value="${h(p.industry)}" placeholder="例如：模型 API 服务 / AI 开发工具"></label><label class="radar-span-full" for="radar-audience">想吸引谁<textarea id="radar-audience" name="audience" rows="2" maxlength="1200" required placeholder="例如：用 AI coding 做产品的开发者与独立创作者">${h(p.audience)}</textarea></label><label class="radar-span-full" for="radar-description">产品介绍<textarea id="radar-description" name="description" rows="4" maxlength="6000" required placeholder="介绍提供什么服务、解决什么问题、现阶段已具备什么能力。">${h(p.description)}</textarea></label><label class="radar-span-full" for="radar-selling-points">真实卖点 · 每行一条<textarea id="radar-selling-points" name="sellingPoints" rows="4" maxlength="8000" placeholder="只填写已经确认的功能、优势与使用场景。">${h(Array.isArray(p.sellingPoints)?p.sellingPoints.join('\n'):p.sellingPoints)}</textarea></label><label for="radar-tone">希望的表达口吻<input id="radar-tone" name="tone" maxlength="500" value="${h(p.tone)}" placeholder="例如：开发者分享，具体、坦诚"></label><label for="radar-goal">宣传目标<textarea id="radar-goal" name="goal" rows="2" maxlength="500" placeholder="通过工具作品展示真实 API 使用场景，带来中转站 Token 购买">${h(p.goal)}</textarea></label></div><div class="radar-materials-heading"><div><h3>作品案例与行业资料</h3><p>作为选题依据保存，可添加多份。最多 20 份，每份 2 万字。</p></div><div class="radar-material-tools"><button type="button" class="text-button" data-action="radar-material-import">${icon('file')}导入 TXT / MD</button><button type="button" class="text-button" data-action="radar-material-add">${icon('plus')}添加资料</button><input id="radar-material-files" type="file" accept=".txt,.md,text/plain,text/markdown" multiple hidden></div></div><div id="radar-materials">${(p.materials?.length?p.materials:[{}]).map(radarMaterialView).join('')}</div><p class="field-help">导入后可以直接编辑正文；本版支持 TXT、Markdown 文本，PDF 内容可先复制到这里。</p><div class="radar-product-images"><div><h3>品牌 / 通用参考图（选填）</h3><p>只放品牌标识或通用素材；具体工具界面请放在对应案例中，选中该案例时才会使用。</p></div><button type="button" class="button button-secondary" data-action="radar-reference-add" ${state.radarUploadBusy?'disabled':''}>${icon('image')}添加参考图</button><input id="radar-reference-input" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden><div id="radar-reference-images">${radarReferencesView()}</div></div><div class="radar-form-footer"><p>请仅保存确认可用的事实与素材。更新资料后，旧版待决策提案会失效。</p><button type="submit" class="button button-primary" ${state.radarUploadBusy?'disabled':''}>${icon('check')}保存产品资料</button></div></form>`;
}
function radarSettingsForm() {
  const s={...RADAR_SETTINGS,...state.radar?.settings};
  return `<form id="radar-settings-form"><label class="radar-toggle" for="radar-enabled"><span><strong>每天自动寻找宣传机会</strong><small>发现合适的再通知你，没有匹配就不打扰。</small></span><input id="radar-enabled" name="enabled" type="checkbox" ${s.enabled?'checked':''}></label><div class="radar-form-grid"><label for="radar-daily-time">每日巡查时间 · 北京时间<input id="radar-daily-time" name="dailyTime" type="time" value="${h(s.dailyTime)}" required></label><label for="radar-max-per-day">每天最多推荐<select id="radar-max-per-day" name="maxPerDay">${[1,2,3].map(n=>`<option value="${n}" ${s.maxPerDay===n?'selected':''}>${n} 个选题</option>`).join('')}</select></label><label for="radar-style">默认图片风格<select id="radar-style" name="style">${guideStyles().map(style=>`<option value="${h(style.id)}" ${s.style===style.id?'selected':''}>${h(style.name)}</option>`).join('')}</select></label><label for="radar-aspect">默认图片比例<select id="radar-aspect" name="aspect">${['3:4','1:1','16:9'].map(aspect=>`<option value="${aspect}" ${s.aspect===aspect?'selected':''}>${aspect}${aspect==='3:4'?' · 竖版':aspect==='1:1'?' · 方形':' · 横版'}</option>`).join('')}</select></label><label for="radar-mode">内容形式<select id="radar-mode" name="mode">${['cards','cover','infographic'].map(mode=>`<option value="${mode}" ${s.mode===mode?'selected':''}>${modeText(mode)}</option>`).join('')}</select></label><label for="radar-count">默认图片张数<input id="radar-count" name="count" type="number" min="1" max="10" value="${s.mode==='cards'?s.count:1}" ${s.mode==='cards'?'':'disabled'} required></label></div><div class="radar-notice">${icon('history')}<span>本机服务运行、电脑唤醒时执行。自动巡查会调用文字模型分析；你批准后，才会生成图片。</span></div><div class="radar-form-footer"><p>先保存产品资料，再开启自动巡查。</p><button type="submit" class="button button-primary">${icon('check')}保存巡查设置</button></div></form>`;
}
function radarNotificationsForm() {
  const c=state.radar?.notificationConfig||{},e=c.email||{},w=c.wechat||{},channel=c.channel||'none';
  return `<form id="radar-notifications-form" autocomplete="off"><p class="radar-form-intro">邮箱作为首选；如果已经在使用 PushPlus，也可以把选题发送到个人微信。只有找到待决策提案时才发送提醒。</p><label for="radar-channel" class="radar-channel-label">提醒方式<select id="radar-channel" name="channel"><option value="none" ${channel==='none'?'selected':''}>暂不提醒 · 在雷达页面查看</option><option value="email" ${channel==='email'?'selected':''}>邮箱 · SMTP</option><option value="wechat" ${channel==='wechat'?'selected':''}>个人微信 · PushPlus</option></select></label><fieldset id="radar-email-fields" class="radar-notification-fields" ${channel==='email'?'':'hidden disabled'}><legend class="sr-label">SMTP 邮箱设置</legend><div class="radar-form-grid"><label for="radar-smtp-host">SMTP 服务器<input id="radar-smtp-host" name="host" value="${h(e.host)}" maxlength="253" placeholder="例如：smtp.qq.com"></label><label for="radar-smtp-port">端口<input id="radar-smtp-port" name="port" type="number" min="1" max="65535" value="${Number(e.port)||465}"></label><label for="radar-smtp-user">SMTP 登录账号<input id="radar-smtp-user" name="user" value="${h(e.user)}" maxlength="320" placeholder="邮箱账号"></label><label for="radar-smtp-password">授权码 / SMTP 密码<input id="radar-smtp-password" name="password" type="password" autocomplete="new-password" placeholder="${e.hasPassword?'已保存 · 留空保留':'填写邮箱的 SMTP 授权码'}"></label><label for="radar-email-from">发件邮箱<input id="radar-email-from" name="from" type="email" value="${h(e.from)}" maxlength="320" placeholder="sender@example.com"></label><label for="radar-email-to">接收选题的邮箱<input id="radar-email-to" name="to" type="email" value="${h(e.to)}" maxlength="320" placeholder="you@example.com"></label></div><label class="radar-checkbox" for="radar-smtp-secure"><input id="radar-smtp-secure" name="secure" type="checkbox" ${e.secure!==false?'checked':''}>使用 SSL / TLS 连接（通常用于 465 端口）</label>${e.hasPassword?'<label class="radar-checkbox radar-clear-secret"><input name="clearPassword" type="checkbox">删除已保存的 SMTP 授权码</label>':''}<p class="field-help">使用邮箱提供的 SMTP 服务与授权码。支持 465（SSL / TLS）或 587（STARTTLS）端口；填写端口时会匹配连接方式。</p></fieldset><fieldset id="radar-wechat-fields" class="radar-notification-fields" ${channel==='wechat'?'':'hidden disabled'}><legend class="sr-label">PushPlus 微信通知设置</legend><label for="radar-wechat-token">PushPlus Token<input id="radar-wechat-token" name="token" type="password" autocomplete="new-password" placeholder="${w.hasToken?'已保存 · 留空保留':'填写 PushPlus 的 Token'}"></label>${w.hasToken?'<label class="radar-checkbox radar-clear-secret"><input name="clearToken" type="checkbox">删除已保存的 PushPlus Token</label>':''}<p class="field-help">在 <a href="https://www.pushplus.plus/" target="_blank" rel="noopener noreferrer">PushPlus ↗</a> 绑定接收微信，再填写 Token。提醒通过该服务发送。</p></fieldset><label for="radar-public-base-url" class="radar-public-url">手机决策链接的根服务地址（选填）<input id="radar-public-base-url" name="publicBaseUrl" type="url" value="${h(c.publicBaseUrl)}" placeholder="https://your-content.example.com"></label><p class="field-help">本机 127.0.0.1 地址只能在这台电脑打开。要从手机邮件或微信里批准选题，需要先配置可访问的 HTTPS 反向代理地址；留空仍可在本机决定。</p><div id="radar-notification-result" class="radar-notification-result" role="status">${h(c.readiness||'保存设置后，可发送一条测试通知。')}</div><div class="radar-form-footer"><p>密码与 Token 只保存到本地服务，保存后不会返回浏览器。</p><div class="radar-form-actions"><button type="button" class="button button-secondary" data-action="radar-notification-test" ${!c.configured||channel==='none'?'disabled':''}>${icon('bolt')}发送测试通知</button><button type="submit" class="button button-primary">${icon('check')}保存通知设置</button></div></div><p class="field-help">测试会使用已保存的配置，向邮箱或微信实际发送一条提醒。</p></form>`;
}
function updateRadarBoard() {
  if(state.view!=='radar')return;
  const status=document.querySelector('#radar-run-status'),list=document.querySelector('#radar-opportunity-list');
  if(!status||!list){render();return;}
  const expanded=new Set(Array.from(list.querySelectorAll('.radar-opportunity')).filter(el=>el.querySelector('.radar-outline')?.open).map(el=>el.dataset.radarId));
  const active=document.activeElement,focus=list.contains(active)?{action:active.dataset.action,id:active.dataset.id,field:active.dataset.radarSkipField,opportunityId:active.dataset.opportunityId,start:active.selectionStart,end:active.selectionEnd}:null;
  status.innerHTML=radarRunView();list.innerHTML=radarOpportunitiesView();
  list.querySelectorAll('.radar-opportunity').forEach(el=>{const outline=el.querySelector('.radar-outline');if(outline&&expanded.has(el.dataset.radarId))outline.open=true;});
  if(focus){const el=focus.field?Array.from(list.querySelectorAll('[data-radar-skip-field]')).find(el=>el.dataset.radarSkipField===focus.field&&el.dataset.opportunityId===focus.opportunityId):Array.from(list.querySelectorAll('[data-action]')).find(el=>el.dataset.action===focus.action&&el.dataset.id===focus.id);el?.focus({preventScroll:true});if(el?.tagName==='TEXTAREA'&&Number.isInteger(focus.start))el.setSelectionRange(focus.start,focus.end);}
  const dashboard=document.querySelector('#radar-dashboard');if(dashboard){const open=dashboard.querySelector('details')?.open;dashboard.innerHTML=radarDashboardView();if(open)dashboard.querySelector('details').open=true;}
  updateRadarHistory();
  document.querySelectorAll('[data-radar-count]').forEach(el=>{el.textContent=el.dataset.radarCount==='pending'?state.radar.opportunities.filter(item=>item.state==='pending').length:state.radar.opportunities.length;});
  [['#radar-profile-summary',radarProfileSummary()],['#radar-schedule-summary',radarScheduleSummary()],['#radar-notifications-summary',radarNotificationSummary()]].forEach(([selector,text])=>{const el=document.querySelector(selector);if(el)el.textContent=text;});
}
function updateRadarHistory() {const history=document.querySelector('#radar-notification-history');if(history)history.innerHTML=radarHistoryView();}
function filterRadar(value) {
  state.radarFilter=value==='all'?'all':'pending';
  document.querySelectorAll('.radar-filter button').forEach(el=>{const active=el.dataset.filter===state.radarFilter;el.classList.toggle('active',active);el.setAttribute('aria-pressed',String(active));});
  updateRadarBoard();
}
function acceptRadar(payload) {
  const snapshot=payload?.radar||payload?.snapshot||payload;
  if(!snapshot?.profile||!snapshot?.settings||!Array.isArray(snapshot.opportunities))throw new Error('选题雷达数据不完整，请重新读取。');
  state.radar={...state.radar,...snapshot,notificationConfig:snapshot.notificationConfig||state.radar?.notificationConfig};
  return state.radar;
}
function scheduleRadarPoll() {
  clearTimeout(radarPollTimer);
  if(state.view==='radar'&&(state.radar?.status?.running||radarProjects().some(radarProjectActive)||(state.radar?.notificationHistory||[]).some(item=>item.status==='sending')))radarPollTimer=setTimeout(()=>loadRadar({quiet:true}),2500);
}
async function loadRadar({quiet=false}={}) {
  const version=++radarLoadVersion;state.radarLoading=true;
  if(!quiet&&!state.radar&&state.view==='radar')render();
  try {
    const snapshot=await api('/api/radar');if(version!==radarLoadVersion)return;
    const first=!state.radar;acceptRadar(snapshot);state.radarError='';
    if(first)state.radarReferences=radarReferenceMetadata(state.radar.profile.referenceIds);
    if(state.view==='radar'){if(first)render();else updateRadarBoard();}
  }catch(error){if(version===radarLoadVersion){state.radarError=error.message;if(state.view==='radar'){if(state.radar)updateRadarBoard();else render();}}}
  finally{if(version===radarLoadVersion){state.radarLoading=false;scheduleRadarPoll();}}
}
function setRadarFormBusy(form,busy) { form.querySelectorAll('button[type="submit"]').forEach(button=>{button.disabled=busy;});form.setAttribute('aria-busy',String(busy)); }
async function saveRadarProfile(form) {
  if(state.radarUploadBusy||form.getAttribute('aria-busy')==='true')return;
  const data=new FormData(form),body=Object.fromEntries(['name','industry','audience','description','tone','goal'].map(key=>[key,String(data.get(key)||'').trim()]));
  body.sellingPoints=String(data.get('sellingPoints')||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  body.materials=Array.from(form.querySelectorAll('.radar-material')).map(el=>({...(el.dataset.materialId?{id:el.dataset.materialId}:{}),...Object.fromEntries(['title','content','source'].map(key=>[key,el.querySelector(`[data-material-field="${key}"]`).value.trim()])),referenceIds:(state.radarMaterialReferences[el.dataset.materialKey]||[]).map(image=>image.id)})).filter(item=>item.title||item.content||item.source||item.referenceIds.length);
  if(body.sellingPoints.length>16)return notify('真实卖点最多保存 16 条，请合并相近内容。',true);
  if(body.materials.some(item=>!item.title||!item.content))return notify('请为每份资料填写标题和正文，或移除空白资料。',true);
  body.referenceIds=state.radarReferences.map(image=>image.id);setRadarFormBusy(form,true);
  try {acceptRadar(await api('/api/radar/profile',{method:'PUT',body}));form.querySelectorAll('.radar-material').forEach(el=>{const title=el.querySelector('[data-material-field="title"]').value.trim(),content=el.querySelector('[data-material-field="content"]').value.trim(),saved=state.radar.profile.materials.find(item=>item.id===el.dataset.materialId||(item.title===title&&item.content===content));if(saved?.id){el.dataset.materialId=saved.id;state.radarMaterialReferences[saved.id]=state.radarMaterialReferences[el.dataset.materialKey]||radarReferenceMetadata(saved.referenceIds);}});state.radarError='';updateRadarBoard();notify('产品资料已保存，雷达会按这份资料寻找机会。');}
  catch(error){notify(error.message,true);}finally{setRadarFormBusy(form,false);}
}
async function saveRadarSettings(form) {
  if(form.getAttribute('aria-busy')==='true')return;
  const data=new FormData(form),body={enabled:data.has('enabled'),dailyTime:String(data.get('dailyTime')),maxPerDay:Number(data.get('maxPerDay')),style:String(data.get('style')),aspect:String(data.get('aspect')),mode:String(data.get('mode')),count:Number(data.get('count')||1)};
  if(body.enabled&&!radarReady())return notify('先保存产品名称、行业、目标用户与产品介绍，再开启自动巡查。',true);
  setRadarFormBusy(form,true);
  try{acceptRadar(await api('/api/radar/settings',{method:'PUT',body}));state.radarError='';updateRadarBoard();scheduleRadarPoll();notify(body.enabled?'自动巡查已开启。请保持本机服务运行。':'巡查设置已保存。');}catch(error){notify(error.message,true);}finally{setRadarFormBusy(form,false);}
}
async function saveRadarNotifications(form) {
  if(form.getAttribute('aria-busy')==='true')return;
  const data=new FormData(form),channel=String(data.get('channel')),body={channel,publicBaseUrl:String(data.get('publicBaseUrl')||'').trim()};
  if(channel==='email')body.email={host:String(data.get('host')||'').trim(),port:Number(data.get('port')||465),secure:data.has('secure'),user:String(data.get('user')||'').trim(),from:String(data.get('from')||'').trim(),to:String(data.get('to')||'').trim(),password:String(data.get('password')||''),clearPassword:data.has('clearPassword')};
  if(channel==='wechat')body.wechat={token:String(data.get('token')||''),clearToken:data.has('clearToken')};
  setRadarFormBusy(form,true);
  try {
    const result=await api('/api/radar/notifications',{method:'PUT',body});
    const config=result.notificationConfig||result.config||result;
    if(result.profile)acceptRadar(result);else state.radar.notificationConfig=config;
    form.querySelectorAll('input[type="password"]').forEach(input=>{input.value='';});
    form.outerHTML=radarNotificationsForm();
    updateRadarBoard();notify('通知设置已保存。');
  }catch(error){notify(error.message,true);}finally{setRadarFormBusy(form,false);}
}
async function testRadarNotification(button) {
  if(button.disabled)return;button.disabled=true;
  const target=document.querySelector('#radar-notification-result');if(target)target.textContent='正在向已配置的邮箱或微信发送测试通知…';
  try {const result=await api('/api/radar/notifications/test',{method:'POST',body:{}});if(target){target.textContent=result.message||(result.status==='accepted'?'通知服务已接受测试消息，请到邮箱或微信检查。':'测试通知尚未确认。');target.classList.toggle('is-error',['failed','unknown'].includes(result.status));}notify(result.message||'测试请求已完成。',['failed','unknown'].includes(result.status));}
  catch(error){if(target){target.textContent=error.message;target.classList.add('is-error');}notify(error.message,true);}finally{await loadRadar({quiet:true});button.disabled=!state.radar?.notificationConfig?.configured;}
}
async function retryRadarNotification(kind,id) {
  if(state.radarNotificationBusy||!['opportunity','result'].includes(kind))return;
  const record=(state.radar?.notificationHistory||[]).find(item=>item.entityId===id&&item.kind===kind);
  if(!record||!['failed','skipped'].includes(record.status)||!state.radar?.notificationConfig?.configured)return;
  state.radarNotificationBusy=`${kind}:${id}`;updateRadarHistory();
  try{const result=await api(`/api/radar/notifications/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/retry`,{method:'POST',body:{}});const notification=result.notificationResult||result;if(result.profile||result.radar||result.snapshot)acceptRadar(result);notify(notification.message||'通知重发请求已处理。',['failed','unknown'].includes(notification.status));updateRadarHistory();await loadRadar({quiet:true});}
  catch(error){notify(error.message,true);await loadRadar({quiet:true});}
  finally{state.radarNotificationBusy='';updateRadarHistory();scheduleRadarPoll();}
}
async function scanRadar() {
  if(state.radarBusy==='scan'||state.radar?.status?.running)return;
  state.radarBusy='scan';state.radarError='';updateRadarBoard();
  try {acceptRadar(await api('/api/radar/scan',{method:'POST',body:{}}));}
  catch(error){state.radarError=error.message;notify(error.message,true);}
  finally{state.radarBusy='';updateRadarBoard();scheduleRadarPoll();}
}
async function decideRadar(id,decision) {
  if(state.radarBusy)return;
  const item=state.radar?.opportunities.find(item=>item.id===id);if(!item||item.state!=='pending')return;
  state.radarBusy=`${decision}:${id}`;updateRadarBoard();
  try {
    const draft=state.radarSkipDrafts[id]||{},body=decision==='skip'?{reason:draft.reason||'',note:String(draft.note||'').slice(0,300)}:{};
    const result=await api(`/api/radar/opportunities/${encodeURIComponent(id)}/${decision}`,{method:'POST',body});
    if(decision==='approve'){
      const p=result.project;if(!p?.id)throw new Error('作品创建结果尚未确认，请重新读取提案后查看。');
      item.state='approved';item.projectId=p.id;const existing=state.projects.findIndex(project=>project.id===p.id);if(existing<0)state.projects.unshift(p);else state.projects[existing]=p;
      filterRadar('all');
      notify('已批准，正在生成完整图文。点击“查看图文与进度”即可查看。');
    }else{acceptRadar(result);delete state.radarSkipDrafts[id];notify('已跳过这次选题。');}
  }catch(error){notify(error.message,true);await loadRadar({quiet:true});}
  finally{state.radarBusy='';updateRadarBoard();scheduleRadarPoll();}
}
async function importRadarMaterials(files) {
  const list=Array.from(files||[]),target=document.querySelector('#radar-materials');if(!list.length||!target)return;
  const existing=target.querySelectorAll('.radar-material').length;
  if(existing+list.length>20)return notify('作品案例与资料最多保存 20 份。',true);
  if(list.some(file=>!/\.(txt|md)$/i.test(file.name)||file.size>200000))return notify('请使用 TXT 或 MD 文本，每个文件不超过 200 KB。',true);
  try{for(const file of list){const content=await file.text();if(!content.trim()||content.length>20000)throw new Error(`「${file.name}」正文需为 1 到 20000 字，请精简后导入。`);target.insertAdjacentHTML('beforeend',radarMaterialView({title:file.name.replace(/\.(txt|md)$/i,''),content,source:`本地文件：${file.name}`}));}notify('资料已放入表单，保存产品资料后生效。');}catch(error){notify(error.message,true);}
}
async function addRadarReferences(files,key='') {
  const list=Array.from(files||[]);if(!list.length||state.radarUploadBusy)return;
  const images=key?state.radarMaterialReferences[key]:state.radarReferences;if(!images)return;
  if(images.length+list.length>4)return notify(key?'每个案例最多使用 4 张截图。':'品牌与通用参考图最多使用 4 张。',true);
  if(list.some(file=>!['image/png','image/jpeg','image/webp'].includes(file.type)||!file.size||file.size>GUIDE_IMAGE_MAX_BYTES))return notify('请使用 8 MB 以内的 PNG、JPEG 或 WebP 图片。',true);
  state.radarUploadBusy=true;
  const update=()=>{const target=key?Array.from(document.querySelectorAll('[data-material-reference-key]')).find(el=>el.dataset.materialReferenceKey===key):document.querySelector('#radar-reference-images');if(target)target.innerHTML=radarReferencesView(key);document.querySelectorAll('#radar-profile-form button[type="submit"], [data-action="radar-reference-add"], [data-action="radar-material-reference-add"], [data-action="radar-material-remove"]').forEach(button=>{button.disabled=state.radarUploadBusy;});};update();
  try{for(const file of list){const {image}=await api('/api/reference-images',{method:'POST',body:{name:file.name,dataUrl:await referenceFileData(file)}});const saved=normalizeGuideImages([image]);if(!saved.length)throw new Error('参考图保存失败，请重试。');images.push(saved[0]);update();}notify(key?'案例截图已添加，保存产品资料后生效。':'通用参考图已添加，保存产品资料后生效。');}catch(error){notify(error.message,true);}finally{state.radarUploadBusy=false;update();}
}
const TREND_PLATFORMS = [{id:'weibo',name:'微博',mark:'微'},{id:'douyin',name:'抖音',mark:'抖'},{id:'xiaohongshu',name:'小红书',mark:'红'}];
const trendName = id => TREND_PLATFORMS.find(p=>p.id===id)?.name||'来源平台';
const trendUrl = value => {try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:'';}catch{return '';}};
const trendTime = value => value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'尚未采集';
const trendCandidate = item => /热梗|玩梗|梗图|挑战|魔性|名场面|整活|表情包|抽象|发疯文学|显眼包|同款舞|舞蹈|神曲/.test(item.title);
const trendMatches = item => (state.trends?.settings?.keywords||[]).filter(word=>item.title.toLocaleLowerCase().includes(word.toLocaleLowerCase()));
function acceptTrends(snapshot) {
  if(!snapshot||!Array.isArray(snapshot.items)||!Array.isArray(snapshot.platforms)||!snapshot.settings)throw new Error('热点数据格式不完整，请重试更新。');
  state.trends=snapshot;
  if(!state.trendKeywordsDirty)state.trendKeywordsDraft=(snapshot.settings.keywords||[]).join('，');
  state.trendsError='';
}
function trendSource(id) {return state.trends?.platforms.find(p=>p.id===id)||{};}
function trendSourceCard(platform) {
  const p=trendSource(platform.id), status=p.status||'empty';
  const statusLabel=({ready:p.freshness==='unknown'?'源时间未知':'已采集',stale:'榜单待更新',error:'暂不可用',empty:'暂无榜单'}[status])||'等待采集';
  const sourceLink=trendUrl(p.sourceUrl), originLink=trendUrl(p.platformUrl);
  const sourceNote=[...new Set([p.error,p.freshness==='fresh'?'':p.freshnessReason].filter(Boolean))].join('；');
  return `<article class="trend-source trend-source-${h(status)}" aria-label="${platform.name}数据状态"><div class="trend-source-heading"><span class="trend-platform-mark platform-${platform.id}" aria-hidden="true">${platform.mark}</span><strong>${platform.name}</strong><span class="trend-source-status"><i></i>${statusLabel}</span></div><div class="trend-source-number">${Number(p.itemCount)||0}<span>条话题</span></div><div class="trend-source-times"><span>采集 ${p.lastSuccessAt?trendTime(p.lastSuccessAt):'尚未成功'}</span><span>源更新 ${p.sourceUpdatedAt?trendTime(p.sourceUpdatedAt):'时间未知'}</span></div>${sourceNote?`<p class="trend-source-note">${h(sourceNote)}</p>`:''}<div class="trend-source-links">${sourceLink?`<a href="${h(sourceLink)}" target="_blank" rel="noopener noreferrer">数据来源：${h(p.provider||'公开热榜')} ↗</a>`:'<span>等待公开数据来源</span>'}${originLink?`<a href="${h(originLink)}" target="_blank" rel="noopener noreferrer" aria-label="打开${platform.name}榜单">原榜 ↗</a>`:''}</div></article>`;
}
function trendsSettingsView() {
  const snapshot=state.trends,settings=snapshot?.settings||{enabled:false,intervalMinutes:30,keywords:[]};
  return `<dialog id="trends-settings-dialog" class="admin-trends-dialog" aria-modal="true" aria-labelledby="trends-settings-title"><div class="admin-trends-dialog-heading"><div><h2 id="trends-settings-title">热点采集设置</h2><p>关注关键词与定时更新</p></div><button type="button" class="icon-button" data-action="trends-settings-close" aria-label="关闭热点设置">${icon('close')}</button></div><div class="admin-trends-dialog-body">
    <section class="admin-trends-setting-section"><h3>关注关键词</h3><p>匹配已采集的话题标题，快速找到与你有关的内容。</p><form id="trends-keywords-form"><label class="sr-label" for="trends-keywords">关注关键词</label><textarea id="trends-keywords" rows="3" maxlength="2000" placeholder="例如：AI，开发工具，职场">${h(state.trendKeywordsDraft)}</textarea><div class="admin-trends-field-footer"><span>逗号或换行分隔，最多 20 个词</span><button type="submit" class="button button-primary" ${!snapshot||state.trendsBusy?'disabled':''}>${state.trendsBusy==='keywords'?'<span class="spinner spinner-small"></span>保存中':'保存关键词'}</button></div></form></section>
    <section class="admin-trends-setting-section"><div class="admin-trends-setting-heading"><h3>定时采集</h3><span class="admin-trends-auto-state ${settings.enabled?'is-enabled':''}"><i></i>${!snapshot?'等待读取':settings.enabled?'已开启':'已暂停'}</span></div><label class="field-label" for="trends-interval">更新间隔</label><div class="admin-trends-interval"><select id="trends-interval" ${!snapshot||state.trendsBusy?'disabled':''}>${[15,30,60].map(value=>`<option value="${value}" ${(state.trendIntervalDraft??settings.intervalMinutes)===value?'selected':''}>每 ${value} 分钟</option>`).join('')}</select><button type="button" class="button button-secondary" data-action="trends-interval" ${!snapshot||state.trendsBusy?'disabled':''}>应用间隔</button><button type="button" class="text-button" data-action="trends-toggle" ${!snapshot||state.trendsBusy?'disabled':''}>${settings.enabled?'暂停采集':'恢复采集'}</button></div><p>下次更新：${snapshot?.refreshing?'正在采集':settings.enabled&&snapshot?.nextRefreshAt?trendTime(snapshot.nextRefreshAt):settings.enabled?'等待安排':'已暂停'}。任务在本地服务运行时执行。</p></section>
    <details id="trends-source-details" class="admin-trends-source-details" ${state.trendsSourcesOpen?'open':''}><summary id="trends-source-summary">平台来源与采集状态</summary><div class="admin-trend-sources">${TREND_PLATFORMS.map(trendSourceCard).join('')}</div></details>
    <p class="admin-trends-settings-note">来自第三方公开热榜，可能存在缓存或延迟。热梗按本机首次收录保留 14 天；留存不代表持续火爆。采集不会调用模型。</p>
  </div><div class="admin-trends-dialog-footer"><button class="button button-secondary" type="button" data-action="trends-settings-close">完成</button></div></dialog>`;
}
function trendsView() {
  const snapshot=state.trends,items=snapshot?.items||[],settings=snapshot?.settings||{},memes=snapshot?.memes||[];
  const latest=(snapshot?.platforms||[]).map(p=>p.lastSuccessAt).filter(value=>Number.isFinite(Date.parse(value))).sort((a,b)=>Date.parse(b)-Date.parse(a))[0];
  return `<section id="trends-page" class="trends-page admin-trends-page" aria-label="当下热点">
    ${state.trendsError?`<div class="trends-alert" role="alert">${icon('alert')}<span>${h(state.trendsError)}</span></div>`:''}${snapshot?.persistenceError?`<div class="trends-alert" role="alert">${icon('alert')}<span>本地缓存未保存：${h(snapshot.persistenceError)}</span></div>`:''}
    <section class="panel admin-trends-panel"><div class="admin-trends-heading"><div><h2>热点话题 <span id="trends-result-count">${filteredTrends().length} 条</span></h2><p>${snapshot?'最近采集 '+trendTime(latest):'正在读取已采集的热点'}<span>·</span>${settings.enabled?'每 '+settings.intervalMinutes+' 分钟更新':'定时采集已暂停'}${memes.length?' · 热梗库 '+memes.length+' 条':''}</p></div><div class="admin-trends-actions"><button id="trends-settings-button" type="button" class="button button-secondary" data-action="trends-settings-open">${icon('settings')}采集设置</button><button type="button" class="button button-primary" data-action="trends-refresh" ${state.trendsBusy||snapshot?.refreshing||state.trendsLoading?'disabled':''}>${snapshot?.refreshing||state.trendsBusy==='refresh'?'<span class="spinner spinner-small"></span>采集中':icon('refresh')+'更新榜单'}</button></div></div>
      <div class="admin-trends-filter-row"><div class="trends-platform-tabs" role="group" aria-label="筛选热点平台">${[{id:'all',name:'全部'},...TREND_PLATFORMS].map(platform=>{const source=trendSource(platform.id),count=platform.id==='all'?items.length:Number(source.itemCount)||0;return `<button type="button" data-action="trends-platform" data-platform="${platform.id}" aria-pressed="${state.trendPlatform===platform.id}" class="${state.trendPlatform===platform.id?'active':''}" title="${h(platform.id==='all'?'全部已采集的话题':source.freshnessReason||source.error||platform.name)}">${platform.name}<span>${count}</span>${platform.id!=='all'&&['stale','error','empty'].includes(source.status)?'<i class="admin-trends-platform-warning" aria-label="来源需要更新"></i>':''}</button>`;}).join('')}</div><label class="admin-trends-search" for="trends-search">${icon('search')}<span class="sr-label">搜索已采集的热点标题</span><input id="trends-search" type="search" maxlength="100" value="${h(state.trendSearch)}" placeholder="搜索话题或热梗"></label></div>
      <div class="admin-trends-filter-row admin-trends-secondary"><div class="trends-scope" role="group" aria-label="筛选热点类型">${[['all','全部话题'],['watched','关注词命中'],['memes','热梗库 · 14天']].map(([id,label])=>`<button type="button" data-action="trends-scope" data-scope="${id}" aria-pressed="${state.trendScope===id}" class="${state.trendScope===id?'active':''}">${label}</button>`).join('')}</div><span>${state.trendScope==='memes'?'按首次收录时间保留 14 天':'按各平台榜内排名展示'}</span></div>
      <div id="trends-results" class="trends-results" aria-live="polite">${trendsResults()}</div>
      <div class="admin-trends-footnote">${icon('file')}热榜仅提供选题线索；热度不跨平台比较，创作前请核实原内容和时效。</div>
    </section>${trendsSettingsView()}
  </section>`;
}
function filteredTrends() {
  const query=state.trendSearch.trim().toLocaleLowerCase();
  const snapshot=state.trends, archive=Array.isArray(snapshot?.memes)?snapshot.memes:(snapshot?.items||[]).filter(trendCandidate);
  const memeById=new Map(archive.map(item=>[item.id,item]));
  const current=(snapshot?.items||[]).map(item=>{const meme=memeById.get(item.id);return meme?.kind==='meme'?{...item,kind:'meme',firstSeenAt:meme.firstSeenAt,expiresAt:meme.expiresAt,lastSeenAt:meme.lastSeenAt,inCurrentBoard:true}:item;});
  const items=state.trendScope==='memes'?archive:state.trendScope==='watched'?[...new Map([...current,...archive].map(item=>[item.id,item])).values()]:current;
  return items.filter(item=>(item.kind!=='meme'||guideTrendUsable(item))&&(state.trendPlatform==='all'||item.platform===state.trendPlatform)&&(!query||item.title.toLocaleLowerCase().includes(query))&&(state.trendScope!=='watched'||trendMatches(item).length)).sort((a,b)=>(a.rank||999)-(b.rank||999)||TREND_PLATFORMS.findIndex(p=>p.id===a.platform)-TREND_PLATFORMS.findIndex(p=>p.id===b.platform));
}
function trendsResults() {
  if(!state.trends&&state.trendsLoading)return '<div class="trends-empty"><span class="spinner"></span><h3>正在读取热点</h3><p>公开热榜准备好后会展示在这里。</p></div>';
  const list=filteredTrends();
  if(!list.length){
    const filtered=Boolean(state.trendSearch.trim()||state.trendPlatform!=='all'||state.trendScope!=='all');
    return `<div class="trends-empty">${icon(filtered?'search':'chart')}<h3>${filtered?'没有匹配的话题':'暂时没有热点数据'}</h3><p>${filtered?'试试其他关键词或平台；热梗库只展示 14 天留存期内的内容。':state.trends?.refreshing?'正在采集各平台榜单，完成后会自动展示。':'点击「更新榜单」获取热点，来源状态可在采集设置中查看。'}</p>${filtered?'<button type="button" class="button button-secondary" data-action="trends-clear-filters">清空筛选</button>':''}</div>`;
  }
  const rows=list.slice(0,state.trendLimit).map(item=>{
    const source=trendSource(item.platform),url=trendUrl(item.url),matches=trendMatches(item),meme=item.kind==='meme';
    const rank=Number.isInteger(item.rank)&&item.rank>0?String(item.rank).padStart(2,'0'):'—';
    return `<tr class="trend-item" data-trend-id="${h(item.id)}"><td><span class="trend-rank ${item.rank<=3?'is-top':''}">${rank}</span></td><td><div class="trend-item-content"><h3>${url?`<a href="${h(url)}" target="_blank" rel="noopener noreferrer">${h(item.title)} <span>↗</span></a>`:h(item.title)}</h3><div class="admin-trends-row-meta">${item.isNew?'<span class="trend-new">新上榜</span>':''}${Number.isFinite(item.rankChange)&&item.rankChange>0?`<span class="trend-movement">↑ ${item.rankChange}</span>`:''}${meme?`<span class="trend-candidate">${item.inCurrentBoard?'热梗候选':'离榜留存'}</span><span class="trend-meme-expiry">有效至 ${trendTime(item.expiresAt)}</span>`:source.status==='stale'?'<span class="trend-delay">旧榜单，待更新</span>':source.freshness==='unknown'?'<span class="trend-time-unknown">源时间未知</span>':''}${matches.map(word=>`<span class="trend-keyword-match">${h(word)}</span>`).join('')}</div>${item.description?`<p class="trend-item-description">${h(item.description)}</p>`:''}</div></td><td><span class="admin-trends-platform">${h(trendName(item.platform))}</span></td><td class="admin-trends-heat">${item.heat!==null&&item.heat!==undefined&&item.heat!==''?h(item.heat):'未提供'}</td><td class="admin-trends-time"><time>${trendTime(item.fetchedAt)}</time>${meme?`<small>收录 ${trendTime(item.firstSeenAt)}</small>`:''}</td><td><button type="button" class="text-button trend-use-button" data-action="trends-use" data-id="${h(item.id)}" aria-label="以${h(item.title)}为主题去创作" ${state.guideBusy?'disabled':''}>用于创作 ${icon('arrow')}</button></td></tr>`;
  }).join('');
  return `<p class="admin-trends-scroll-hint">左右滑动查看来源、采集时间和操作</p><div class="admin-trends-table-wrap"><table class="admin-trends-table"><thead><tr><th scope="col">榜内排名</th><th scope="col">话题</th><th scope="col">来源</th><th scope="col">平台热度</th><th scope="col">采集时间</th><th scope="col">操作</th></tr></thead><tbody>${rows}</tbody></table></div><div class="admin-trends-list-footer"><span>已显示 ${Math.min(list.length,state.trendLimit)} / ${list.length} 条</span>${list.length>state.trendLimit?`<button type="button" class="button button-secondary" data-action="trends-more">加载更多 ${Math.min(24,list.length-state.trendLimit)} 条</button>`:''}</div>`;
}
function openTrendsSettings() {
  state.trendsSettingsOpen=true;renderTrends();document.querySelector('#trends-keywords')?.focus({preventScroll:true});
}
function closeTrendsSettings() {
  state.trendsSettingsOpen=false;document.querySelector('#trends-settings-dialog')?.close();document.querySelector('#trends-settings-button')?.focus({preventScroll:true});
}
function updateTrendsResults() {
  const target=document.querySelector('#trends-results');if(target)target.innerHTML=trendsResults();
  const counter=document.querySelector('#trends-result-count');if(counter)counter.textContent=`${filteredTrends().length} 条`;
}
function renderTrends() {
  if(state.view!=='trends')return;
  const focused=document.activeElement, focusId=focused?.id;
  const selection=typeof focused?.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
  const scroll={x:window.scrollX,y:window.scrollY},settingsScroll=document.querySelector('.admin-trends-dialog-body')?.scrollTop||0;
  render();
  if(state.trendsSettingsOpen)document.querySelector('#trends-settings-dialog')?.showModal();
  const settingsBody=document.querySelector('.admin-trends-dialog-body');if(settingsBody)settingsBody.scrollTop=settingsScroll;
  const next=focusId?document.getElementById(focusId):null;
  if(next){next.focus({preventScroll:true});if(selection&&next.setSelectionRange)next.setSelectionRange(...selection);}
  window.scrollTo(scroll.x,scroll.y);
}
function scheduleTrendsPoll() {
  clearTimeout(trendsPollTimer);
  if(state.view==='trends')trendsPollTimer=setTimeout(()=>loadTrends({quiet:true}),state.trends?.refreshing?1800:30000);
}
async function loadTrends({quiet=false}={}) {
  const version=++trendsLoadVersion;
  if(!quiet){state.trendsLoading=true;renderTrends();}
  try{const snapshot=await api('/api/trends');if(version===trendsLoadVersion)acceptTrends(snapshot);}
  catch(error){if(version===trendsLoadVersion)state.trendsError=error.message;}
  finally{if(version===trendsLoadVersion){state.trendsLoading=false;renderTrends();scheduleTrendsPoll();}}
}
async function refreshTrends() {
  if(state.trendsBusy||state.trends?.refreshing)return;
  ++trendsLoadVersion;state.trendsLoading=false;state.trendsBusy='refresh';state.trendsError='';renderTrends();
  try{acceptTrends(await api('/api/trends/refresh',{method:'POST',body:{}}));notify('已开始更新公开热榜，完成后会自动展示。');}
  catch(error){state.trendsError=error.message;}
  finally{state.trendsBusy='';renderTrends();scheduleTrendsPoll();}
}
async function saveTrendsSettings(change,kind='settings') {
  if(!state.trends||state.trendsBusy)return;
  ++trendsLoadVersion;state.trendsLoading=false;state.trendsBusy=kind;state.trendsError='';renderTrends();
  try{
    acceptTrends(await api('/api/trends/settings',{method:'PUT',body:change}));
    if(kind==='keywords'){state.trendKeywordsDirty=false;state.trendKeywordsDraft=(state.trends.settings.keywords||[]).join('，');}
    if(change.intervalMinutes)state.trendIntervalDraft=null;
    notify(kind==='keywords'?'关注关键词已保存。':'热点更新设置已保存。');
  }catch(error){state.trendsError=error.message;}
  finally{state.trendsBusy='';renderTrends();scheduleTrendsPoll();}
}
async function saveTrendKeywords() {
  const keywords=[...new Set(state.trendKeywordsDraft.split(/[,，\n;；]+/).map(word=>word.trim()).filter(Boolean))];
  if(keywords.length>20||keywords.some(word=>word.length>40))return notify('最多保存 20 个关键词，每个词不超过 40 个字。',true);
  await saveTrendsSettings({keywords},'keywords');
}
function useTrendForCreation(id) {
  if(state.guideBusy||guideWorkActive())return notify('当前创作正在处理中，请等它完成后再带入热点。');
  const item=[...(state.trends?.memes||[]),...(state.trends?.items||[])].find(item=>item.id===id);if(!item)return;
  if(!guideTrendUsable(item))return notify('这个热梗已过留存期，请更新榜单或选择其他话题。',true);
  const g=state.guide, p=trendSource(item.platform), url=trendUrl(item.url),sourceUpdatedAt=item.sourceUpdatedAt||p.sourceUpdatedAt;
  const input=`我想围绕「${item.title}」创作图文，请先帮我分析适合的内容方向，再问我风格、比例和图片张数。\n\n选题线索：${trendName(item.platform)}${item.kind==='meme'?'热梗候选':'热榜话题'}，${item.kind==='meme'&&!item.inCurrentBoard?'最近采集榜内':'榜内'}第 ${item.rank} 位。\n${url?'原内容链接：'+url+'\n':''}采集时间：${trendTime(item.fetchedAt)}（北京时间）。\n榜单源更新时间：${sourceUpdatedAt?trendTime(sourceUpdatedAt)+'（北京时间）':'未知，采集时间不代表榜单新鲜度'}。${p.status==='stale'?'\n注意：当前是缓存或延迟榜单，请先确认时效。':''}\n\n${item.kind==='meme'?`这是热梗候选，本机首次收录 ${trendTime(item.firstSeenAt)}，保留至 ${trendTime(item.expiresAt)}；14 天是本机留存窗口，不代表持续火爆。\n`:''}这只是热榜标题线索。请提醒我补充或核实原内容，不要凭标题编造事实、热梗含义或出处。`;
  if((g.messages.length||g.source||g.input.trim()||g.draftImages.length)&&!confirm('把这个热点作为新话题带入创作对话？当前对话及未发送的文字和图片会替换，作品记录会保留。'))return;
  guideRequestVersion++;guideCreationVersion++;guideProjectPollVersion++;clearTimeout(guideProjectPollTimer);state.guideProject=null;state.guide=blankGuidance();state.guide.input=input;state.guideEdit=null;resetGuideStyleFilters();saveGuidance();state.view='briefing';state.trendsSettingsOpen=false;render();
  document.querySelector('#guide-input')?.focus();notify('选题已带入，补充需求后发送即可。');
}

// Replace historyView/historyList with this block. Existing project actions stay in place.
function historyView() {
  return `<section class="history-section history-management" aria-label="作品管理">
    <div class="history-query-panel panel">
      <label class="history-query-field" for="history-search"><span>关键词</span><span class="search-box">${icon('search')}<input id="history-search" type="search" maxlength="200" placeholder="搜索作品标题、创作需求或文案" aria-label="搜索作品" value="${h(state.search)}" autocomplete="off"></span></label>
      <div class="history-status-filter"><span>作品状态</span><div class="filter-tabs" role="group" aria-label="筛选作品状态">${[['all','全部作品'],['completed','已完成'],['draft','待确认']].map(([id,name])=>`<button type="button" class="${state.filter===id?'active':''}" data-action="filter" data-filter="${id}" aria-pressed="${state.filter===id}">${name}</button>`).join('')}</div></div>
      <button class="button button-secondary history-reset" type="button" data-action="history-reset">重置</button>
    </div>
    <div id="history-list" aria-live="polite">${historyList()}</div>
  </section>`;
}
function historyProjectTimestamp(project,kind=state.historySort||'updated') {
  const value=kind==='created'?project.createdAt:project.updatedAt||project.createdAt;
  const parsed=new Date(value||0).getTime();return Number.isFinite(parsed)?parsed:0;
}
function historyProjectTime(project) {
  const value=historyProjectTimestamp(project,'updated');
  return value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
}
function historyFilteredProjects() {
  const query=state.search.trim().toLocaleLowerCase();
  return state.projects.filter(project=>(state.filter==='all'||project.status===state.filter)&&(!query||[project.title,project.source,project.caption].filter(Boolean).join(' ').toLocaleLowerCase().includes(query))).sort((a,b)=>historyProjectTimestamp(b)-historyProjectTimestamp(a));
}
function historyProjectStyle(project) {
  return guideStyles().find(style=>style.id===project.style)?.name||project.style||'默认风格';
}
function historyProjectProgress(project) {
  const pages=Array.isArray(project.pages)?project.pages:[];
  const total=pages.length||(Number.isInteger(project.count)&&project.count>0?project.count:0);
  const ready=pages.filter(page=>page.status==='done'&&Boolean(page.imageUrl)).length;
  return {total,ready};
}
function historyProjectPreview(project) {
  return project?.pages?.find(page=>typeof page.imageUrl==='string'&&page.imageUrl.startsWith('/media/'));
}
function historyCoverView(project,{card=false}={}) {
  const cover=historyProjectPreview(project),title=project.title||'未命名作品';
  return `<button type="button" class="${card?'history-cover':'history-table-cover'}" data-action="${cover?'history-preview':'open-project'}" data-id="${h(project.id)}" aria-label="${cover?'预览封面：':'打开作品：'}${h(title)}" title="${cover?'预览封面':'打开作品'}">${cover?`<img src="${h(cover.imageUrl)}" alt="" loading="lazy">`:`<span class="history-cover-placeholder">${icon('image')}</span>`}${card?`<span class="badge badge-${h(project.status)}">${h(statusText(project.status))}</span>`:''}</button>`;
}
function historyProjectActions(project,{card=false}={}) {
  const title=project.title||'未命名作品';
  return `<div class="history-row-actions ${card?'is-card':''}"><button type="button" class="text-button history-continue-chat" data-action="continue-chat" data-id="${h(project.id)}">${isActive(project)?'查看进度':project.pages?.length?'继续对话':'查看并继续'}</button><button type="button" class="icon-button history-delete" data-action="delete" data-id="${h(project.id)}" aria-label="删除 ${h(title)}" title="删除作品" ${isActive(project)?'disabled':''}>${icon('trash')}</button>${xhsEligible(project)?`<button type="button" class="text-button history-send-draft" data-action="xhs-for-project" data-id="${h(project.id)}">选择账号并发布 ${icon('arrow')}</button>`:''}</div>`;
}
function historyTableView(projects) {
  return `<div class="history-table-wrap"><table class="history-table"><caption class="sr-label">作品列表，包含内容类型、图片进度、状态、更新时间和操作</caption><thead><tr><th scope="col">作品</th><th scope="col">内容类型 / 风格</th><th scope="col">图片进度</th><th scope="col">状态</th><th scope="col">更新时间</th><th scope="col">操作</th></tr></thead><tbody>${projects.map(project=>{const {total,ready}=historyProjectProgress(project),title=project.title||'未命名作品';return `<tr><td><div class="history-project-cell">${historyCoverView(project)}<div><button type="button" class="history-table-title" data-action="open-project" data-id="${h(project.id)}" title="${h(title)}">${h(title)}</button><p title="${h(project.source||project.caption||'')}">${h(project.source||project.caption||'暂无创作需求')}</p></div></div></td><td><span class="history-mode">${h(modeText(project.mode)||'图文')}</span><small>${h(historyProjectStyle(project))}</small></td><td><span class="history-image-count">${ready}<span> / ${total} 张</span></span>${total?`<progress class="history-image-progress" value="${ready}" max="${total}" aria-label="已生成 ${ready} 张，共 ${total} 张"></progress>`:''}</td><td><span class="badge badge-${h(project.status)}">${h(statusText(project.status))}</span></td><td><time class="history-table-time">${h(historyProjectTime(project))}</time></td><td>${historyProjectActions(project)}</td></tr>`;}).join('')}</tbody></table></div><p class="history-table-mobile-hint">可横向滑动查看完整信息与操作</p>`;
}
function historyCardsView(projects) {
  return `<div class="history-grid">${projects.map(project=>{const {total,ready}=historyProjectProgress(project),title=project.title||'未命名作品';return `<article class="history-card">${historyCoverView(project,{card:true})}<div class="history-card-body"><button type="button" class="history-title" data-action="open-project" data-id="${h(project.id)}">${h(title)}</button><p>${h(project.source?.slice(0,90)||'暂无创作需求')}</p><div class="history-card-meta"><span>${h(modeText(project.mode)||'图文')} · ${ready} / ${total} 张</span><time>${h(historyProjectTime(project))}</time></div>${historyProjectActions(project,{card:true})}</div></article>`;}).join('')}</div>`;
}
function historyPaginationView(total,page,pages,pageSize) {
  const visible=[...new Set([1,page-1,page,page+1,pages].filter(value=>value>=1&&value<=pages))].sort((a,b)=>a-b);
  let previous=0;
  return `<div class="history-pagination"><span>共 ${total} 份，当前 ${total?(page-1)*pageSize+1:0}–${Math.min(page*pageSize,total)} 份</span><div class="history-pagination-controls"><label class="sr-label" for="history-page-size">每页显示数量</label><select id="history-page-size">${[12,24,48].map(size=>`<option value="${size}" ${pageSize===size?'selected':''}>${size} 条 / 页</option>`).join('')}</select><button type="button" class="history-page-button" data-action="history-page" data-page="${page-1}" aria-label="上一页作品" ${page===1?'disabled':''}>‹</button>${visible.map(value=>{const gap=previous&&value>previous+1;previous=value;return `${gap?'<span class="history-page-gap" aria-hidden="true">…</span>':''}<button type="button" class="history-page-button ${value===page?'is-current':''}" data-action="history-page" data-page="${value}" aria-label="第 ${value} 页作品" ${value===page?'aria-current="page"':''}>${value}</button>`;}).join('')}<button type="button" class="history-page-button" data-action="history-page" data-page="${page+1}" aria-label="下一页作品" ${page===pages?'disabled':''}>›</button></div></div>`;
}
function historyList() {
  const all=historyFilteredProjects(),layout=state.historyLayout==='cards'?'cards':'table',pageSize=[12,24,48].includes(state.historyPageSize)?state.historyPageSize:12;
  const pages=Math.max(1,Math.ceil(all.length/pageSize)),page=Math.min(pages,Math.max(1,Number.isInteger(state.historyPage)?state.historyPage:1));state.historyPage=page;
  const list=all.slice((page-1)*pageSize,page*pageSize);
  return `<section class="panel history-data-panel" aria-label="作品列表"><div class="history-data-heading"><div><h2>作品列表</h2><span>共 ${all.length} 份作品</span></div><div class="history-data-tools"><label class="sr-label" for="history-sort">作品排序</label><select id="history-sort"><option value="updated" ${(state.historySort||'updated')==='updated'?'selected':''}>最近更新</option><option value="created" ${state.historySort==='created'?'selected':''}>最近创建</option></select><div class="history-layout-switch" role="group" aria-label="作品展示方式"><button type="button" class="icon-button ${layout==='table'?'is-active':''}" data-action="history-layout" data-layout="table" aria-label="以表格查看作品" aria-pressed="${layout==='table'}" title="表格视图">${icon('file')}</button><button type="button" class="icon-button ${layout==='cards'?'is-active':''}" data-action="history-layout" data-layout="cards" aria-label="以卡片查看作品" aria-pressed="${layout==='cards'}" title="卡片视图">${icon('grid')}</button></div><button type="button" class="icon-button history-refresh" data-action="history-refresh" aria-label="更新作品列表" title="更新作品列表" ${state.historyReloading?'disabled':''}>${state.historyReloading?'<span class="spinner spinner-small"></span>':icon('refresh')}</button></div></div>${list.length?(layout==='cards'?historyCardsView(list):historyTableView(list)):`<div class="history-empty">${icon('cards')}<h3>${state.search||state.filter!=='all'?'没有找到匹配的作品':'暂无作品'}</h3><p>${state.search||state.filter!=='all'?'调整关键词或状态筛选后重试。':'创建一份图文后，即可在这里查看和继续编辑。'}</p><button type="button" class="button button-primary" data-action="${state.search||state.filter!=='all'?'history-reset':'new'}">${state.search||state.filter!=='all'?'清除筛选':icon('plus')+'新建创作'}</button></div>`}${historyPaginationView(all.length,page,pages,pageSize)}</section>`;
}
function updateHistoryResults({scroll=false}={}) {
  if(state.view!=='history')return;
  const region=document.querySelector('#history-list');if(!region)return;
  const focused=document.activeElement,action=focused?.closest('#history-list')?focused.dataset.action:null;
  region.innerHTML=historyList();
  if(action==='history-layout')region.querySelector(`[data-action="history-layout"][data-layout="${state.historyLayout}"]`)?.focus({preventScroll:true});
  else if(action==='history-page')region.querySelector('[data-action="history-page"][aria-current="page"]')?.focus({preventScroll:true});
  if(scroll)region.scrollIntoView({block:'start',behavior:'auto'});
}
async function reloadHistoryList() {
  if(state.historyReloading)return;
  state.historyReloading=true;updateHistoryResults();
  try{await refreshHistory();}
  finally{state.historyReloading=false;updateHistoryResults();}
}


function captureSettingsDraft() {
  const form=document.querySelector('#settings-form');
  if(form&&state.settingsDirty)state.settingsDraft=Object.fromEntries(new FormData(form));
}
function restoreSettingsDraft() {
  const form=document.querySelector('#settings-form');if(!form)return;
  if(state.settingsDraft)for(const [name,value] of Object.entries(state.settingsDraft)){const input=form.elements.namedItem(name);if(input&&'value' in input)input.value=value;}
  updateSettingsDraftStatus();
}
function updateSettingsDraftStatus() {
  const label=document.querySelector('#settings-draft-status');if(label){label.textContent=state.settingsDirty?'有未保存的修改':'使用已保存的配置';label.classList.toggle('is-dirty',state.settingsDirty);}
}
function switchSettingsProvider(kind) {
  if(!['text','image'].includes(kind))return;
  state.settingsTab=kind;
  for(const provider of ['text','image']){const tab=document.querySelector('#settings-tab-'+provider),panel=document.querySelector('#settings-provider-'+provider);if(tab){tab.setAttribute('aria-selected',String(provider===kind));tab.tabIndex=provider===kind?0:-1;}if(panel)panel.hidden=provider!==kind;}
}
function settingsView() {
  if(!state.config)return `<div class="panel settings-loading"><span class="spinner"></span><p>正在读取模型设置…</p><button class="button button-secondary" data-action="reload">重试连接</button></div>`;
  const c=state.config;
  return `<div class="settings-layout admin-settings-layout"><form id="settings-form" class="settings-form" novalidate><section class="panel admin-settings-panel"><div class="admin-settings-heading"><div><h2>模型接口配置</h2><p>文字和图片模型可独立配置，沿用 OpenAI 兼容接口。</p></div><span class="admin-form-tag">自定义 API</span></div><div class="admin-provider-tabs" role="tablist" aria-label="模型类型">${[['text','文本模型'],['image','图片模型']].map(([kind,label])=>`<button id="settings-tab-${kind}" type="button" role="tab" aria-selected="${state.settingsTab===kind}" aria-controls="settings-provider-${kind}" tabindex="${state.settingsTab===kind?0:-1}" data-action="settings-provider" data-kind="${kind}">${icon(kind==='text'?'file':'image')}${label}<span class="admin-provider-state ${c[kind]?.hasKey?'is-ready':''}">${c[kind]?.hasKey?'已配置':'待配置'}</span></button>`).join('')}</div>${[['text','文本模型','用于需求分析、内容策划与提示词生成'],['image','图片模型','用于生成图片和参考图编辑']].map(([kind,title,description])=>`<div id="settings-provider-${kind}" role="tabpanel" aria-labelledby="settings-tab-${kind}" ${state.settingsTab===kind?'':'hidden'}>${providerSettings(kind,title,description,c[kind])}</div>`).join('')}<div class="settings-save admin-save-toolbar"><div><span id="settings-draft-status" class="${state.settingsDirty?'is-dirty':''}">${state.settingsDirty?'有未保存的修改':'使用已保存的配置'}</span><p>已保存密钥不回显，留空保留原密钥。</p></div><div class="admin-save-actions"><button class="button button-secondary" type="button" data-action="settings-reset" ${state.busy?'disabled':''}>恢复已保存配置</button><button class="button button-primary" type="submit" ${state.busy?'disabled':''}>${buttonBusy('settings')||icon('check')}保存模型设置</button></div></div></section></form><aside class="settings-aside"><section class="panel admin-config-help"><h3>配置说明</h3><ol><li><strong>填写接口地址</strong><p>填写服务商提供的 API Base URL，通常以 /v1 结尾。</p></li><li><strong>选择模型</strong><p>输入准确的模型 ID，或读取服务商的模型列表。</p></li><li><strong>保存并测试</strong><p>连接测试使用已保存配置，会发起真实请求，可能计费。</p></li></ol></section><div class="admin-config-note">${icon('lock')}<p>密钥由本地服务保存，不写入布局偏好或访问页签。</p></div></aside></div>`;
}
function providerSettings(kind,title,description,c = {}) {
  const isImage=kind==='image';
  const result=state.testResults[kind];
  const sizes=Object.keys(imageSizeOptions);
  if (c.size && !sizes.includes(c.size)) sizes.unshift(c.size);
  return `<section class="panel provider-panel"><div class="provider-heading"><span class="provider-icon">${icon(isImage?'image':'file')}</span><div><h2>${title}</h2><p>${description}</p></div><span class="key-status ${c.hasKey?'has-key':''}">${c.hasKey?'密钥已保存':'未配置密钥'}</span></div><label class="field-label" for="${kind}-baseUrl">API Base URL</label><input id="${kind}-baseUrl" name="${kind}.baseUrl" type="url" value="${h(c.baseUrl)}" placeholder="https://api.example.com/v1" required autocomplete="off"/><div class="model-label"><label class="field-label" for="${kind}-model">模型 ID</label><button type="button" class="text-button" data-action="load-models" data-kind="${kind}" ${state.busy ? 'disabled' : ''}>${buttonBusy(`models-${kind}`)}读取模型列表</button></div><input id="${kind}-model" name="${kind}.model" value="${h(c.model)}" list="${kind}-models" placeholder="输入中转站支持的模型 ID" required autocomplete="off"/><datalist id="${kind}-models">${state.models[kind].map(m=>`<option value="${h(m)}"></option>`).join('')}</datalist><label class="field-label" for="${kind}-apiKey">API Key</label><input id="${kind}-apiKey" name="${kind}.apiKey" type="password" placeholder="${c.hasKey?'已保存 · 留空保留现有密钥':'输入你的 API Key'}" autocomplete="new-password" spellcheck="false"/><p class="field-help">${c.hasKey?'已保存的密钥不会显示。需要更换时，填写新密钥并保存。':'密钥只提交给本地服务，请勿将本地配置文件对外分享。'}</p>${isImage?`<div class="settings-options"><div><label class="field-label" for="image-mode">图片接口格式</label><select id="image-mode" name="image.mode"><option value="images" ${c.mode==='images'?'selected':''}>Images · /images/generations</option><option value="chat" ${c.mode==='chat'?'selected':''}>Chat · /chat/completions</option></select></div><div><label class="field-label" for="image-size">Images 请求尺寸</label><select id="image-size" name="image.size">${sizes.map(size=>`<option value="${h(size)}" ${c.size===size?'selected':''}>${h(imageSizeOptions[size] || size)}</option>`).join('')}</select></div></div><p class="field-help">Images 模式按所选尺寸发起请求。Chat 模式通过提示词传达构图比例。每张成品会显示实际像素尺寸。</p>`:''}<div class="provider-footer"><button type="button" class="button button-secondary" data-action="test" data-kind="${kind}" ${state.busy || !c.hasKey ? 'disabled' : ''}>${buttonBusy(`test-${kind}`)||icon('bolt')}${isImage?'测试生图（可能计费）':'测试文本连接（可能计费）'}</button><span>使用已保存的配置</span></div>${result?`<div class="test-result ${result.ok?'success':'failure'}">${icon(result.ok?'check':'alert')}<span>${h(result.message)}</span></div>`:''}</section>`;
}

app.addEventListener('input', event => {
  const el=event.target;
  if(el.closest('#settings-form')){state.settingsRevision++;state.settingsDirty=true;captureSettingsDraft();updateSettingsDraftStatus();}
  if(el.dataset.radarSkipField&&state.radarSkipDrafts[el.dataset.opportunityId])state.radarSkipDrafts[el.dataset.opportunityId][el.dataset.radarSkipField]=el.value;
  if(el.closest('#dingtalk-config-form'))captureDingtalkDraft();
  if(el.id==='guide-input') {state.guide.input=el.value;saveGuidance();}
  if(el.id==='guide-history-search'){state.guideHistorySearch=el.value;const target=document.querySelector('#guide-history-results');if(target)target.innerHTML=guideHistoryItemsView();}
  if(el.id==='guide-style-search'){state.guideStyleSearch=el.value;updateGuideStyleResults();}
  if(el.id==='trends-search'){state.trendSearch=el.value;state.trendLimit=24;updateTrendsResults();}
  if(el.id==='trends-keywords'){state.trendKeywordsDraft=el.value;state.trendKeywordsDirty=true;}
  if(el.id==='xhs-account-search'){state.xhsAccountSearch=el.value;replaceXhsRegion('#xhs-accounts-table-region',xhsAccountsTableView());}
  if(el.id==='xhs-draft-search'){state.xhsDraftSearch=el.value;replaceXhsRegion('#xhs-official-drafts-region',publisherDraftsView());replaceXhsRegion('#xhs-drafts-region',xhsDraftsView());}
  if(el.id==='xhs-title'&&state.xhsPreview){state.xhsPreview.title=el.value;updateXhsComposerState();}
  if(el.id==='xhs-content'&&state.xhsPreview){state.xhsPreview.content=el.value;updateXhsComposerState();}
  if(el.id==='history-search'){state.search=el.value;state.historyPage=1;updateHistoryResults();}
});
app.addEventListener('paste', event => {
  if(!event.target.closest('#guide-form'))return;
  const files=Array.from(event.clipboardData?.files||[]);
  if(!files.length)return;
  event.preventDefault();
  const input=document.querySelector('#guide-input'),text=event.clipboardData?.getData('text/plain')||'';
  if(input&&!input.disabled&&text){
    const start=input.selectionStart??input.value.length,end=input.selectionEnd??start;
    const room=Math.max(0,input.maxLength-(input.value.length-(end-start)));
    input.setRangeText(text.slice(0,room),start,end,'end');state.guide.input=input.value;saveGuidance();
  }
  addGuideImages(files);
});
app.addEventListener('dragover', event => {
  if(!Array.from(event.dataTransfer?.types||[]).includes('Files'))return;
  event.preventDefault();
  const form=event.target.closest('#guide-form');
  document.querySelector('#guide-form')?.classList.toggle('is-dragging',Boolean(form));
  if(event.dataTransfer)event.dataTransfer.dropEffect=form?'copy':'none';
});
app.addEventListener('dragleave', event => {
  const form=event.target.closest('#guide-form');
  if(form&&!form.contains(event.relatedTarget))form.classList.remove('is-dragging');
});
app.addEventListener('drop', event => {
  const files=Array.from(event.dataTransfer?.files||[]);
  if(!files.length)return;
  event.preventDefault();document.querySelector('#guide-form')?.classList.remove('is-dragging');
  if(event.target.closest('#guide-form'))addGuideImages(files);
  else notify('把产品图片拖进聊天输入框即可。');
});
app.addEventListener('change', async event => {
  const el=event.target;
  if(el.closest('#settings-form')){state.settingsRevision++;state.settingsDirty=true;captureSettingsDraft();updateSettingsDraftStatus();}
  if(el.closest('#dingtalk-config-form')){captureDingtalkDraft();return;}
  if(el.id==='guide-target-platform'&&!state.guide.creation&&!state.guideBusy){
    state.guide.targetPlatform=el.value==='xhs'?'xhs':'generic';
    if(state.guide.targetPlatform==='generic')state.guide.xhsAutoDelivery=false;
    saveGuidance();renderGuidance({preserve:true});return;
  }
  if(el.id==='guide-xhs-auto-delivery'){
    if(state.guide.creation||xhsDeliveryReadOnly())return;
    state.guide.xhsAutoDelivery=el.checked;if(el.checked)state.guide.targetPlatform='xhs';saveGuidance();renderGuidance({preserve:true});return;
  }
  if(el.id==='history-page-size'){const size=Number(el.value);if(![12,24,48].includes(size))return;state.historyPageSize=size;state.historyPage=1;updateHistoryResults();return;}
  if(el.id==='history-sort'){if(!['updated','created'].includes(el.value))return;state.historySort=el.value;state.historyPage=1;updateHistoryResults();return;}
  if(el.id==='xhs-draft-sort'){if(['recent','oldest','title'].includes(el.value))state.xhsDraftSort=el.value;updateXhs();return;}
  if(el.id==='xhs-project'){chooseXhsProject(el.value);return;}
  if(el.dataset.radarMaterialInput){const files=Array.from(el.files||[]);el.value='';await addRadarReferences(files,el.dataset.radarMaterialInput);}
  if(el.dataset.radarSkipField&&state.radarSkipDrafts[el.dataset.opportunityId])state.radarSkipDrafts[el.dataset.opportunityId][el.dataset.radarSkipField]=el.value;
  if(el.id==='radar-material-files'){const files=Array.from(el.files||[]);el.value='';await importRadarMaterials(files);}
  if(el.id==='radar-reference-input'){const files=Array.from(el.files||[]);el.value='';await addRadarReferences(files);}
  if(el.id==='radar-channel'){
    document.querySelector('#radar-email-fields').hidden=el.value!=='email';
    document.querySelector('#radar-email-fields').disabled=el.value!=='email';
    document.querySelector('#radar-wechat-fields').hidden=el.value!=='wechat';
    document.querySelector('#radar-wechat-fields').disabled=el.value!=='wechat';
    const test=document.querySelector('[data-action="radar-notification-test"]');if(test)test.disabled=el.value!==state.radar?.notificationConfig?.channel||!state.radar?.notificationConfig?.configured||el.value==='none';
  }
  if(el.id==='radar-mode'){const count=document.querySelector('#radar-count');count.disabled=el.value!=='cards';if(count.disabled)count.value='1';}
  if(el.id==='radar-smtp-port'){const secure=document.querySelector('#radar-smtp-secure');if(el.value==='465')secure.checked=true;if(el.value==='587')secure.checked=false;}
  if(el.id==='guide-image-input'){const files=Array.from(el.files||[]);el.value='';await addGuideImages(files);}
  if(el.id==='guide-match-trends'){
    state.guide.matchTrends=el.checked;state.guide.selectedTrend=null;state.guide.trendMatches=null;state.guide.trendNotice=el.checked?'已开启热点匹配。下次发送分析时会一起匹配，也可以点击重新匹配。':'已关闭热点匹配，将按原主题继续。';saveGuidance();renderGuidance();
  }
  if(el.id==='trends-interval')state.trendIntervalDraft=Number(el.value);
});
app.addEventListener('invalid',event=>{if(event.target.closest('#settings-form'))switchSettingsProvider(event.target.name?.startsWith('image.')?'image':'text');},true);
app.addEventListener('submit', async event => {
  event.preventDefault();
  if(event.target.matches('.radar-skip-form'))await decideRadar(event.target.dataset.radarSkipId,'skip');
  if(event.target.id==='dingtalk-config-form')await saveDingtalkConfig();
  if(event.target.id==='xhs-draft-form')await submitXhsDraft();
  if(event.target.id==='radar-profile-form')await saveRadarProfile(event.target);
  if(event.target.id==='radar-settings-form')await saveRadarSettings(event.target);
  if(event.target.id==='radar-notifications-form')await saveRadarNotifications(event.target);
  if(event.target.id==='trends-keywords-form')await saveTrendKeywords();
  if(event.target.id==='guide-form') await sendGuidance();
  if(event.target.id==='settings-form') await saveSettings();
});
app.addEventListener('click', async event => {
  const button=event.target.closest('[data-action]');
  if(!button || button.disabled) return;
  event.preventDefault();
  const {action,id,view,kind}=button.dataset;
  try {
    if(action==='history-layout'){if(!['table','cards'].includes(button.dataset.layout))return;state.historyLayout=button.dataset.layout;updateHistoryResults();return;}
    if(action==='history-page'){const page=Number(button.dataset.page);if(!Number.isInteger(page)||page<1)return;state.historyPage=page;updateHistoryResults({scroll:true});return;}
    if(action==='history-reset'){state.search='';state.filter='all';state.historyPage=1;render();document.querySelector('#history-search')?.focus({preventScroll:true});return;}
    if(action==='history-refresh'){await reloadHistoryList();return;}
    if(action==='history-preview'){const project=state.projects.find(project=>project.id===id),cover=historyProjectPreview(project);if(cover){document.querySelector('#lightbox-image').src=cover.imageUrl;lightbox.showModal();}return;}
    if(action==='admin-menu-toggle'){toggleAdminMenu();return;}
    if(action==='admin-sidebar-collapse'){toggleAdminSidebar();return;}
    if(action==='admin-tab-close'){if(!state.guideUploadBusy&&!state.radarUploadBusy)await closeAdminTab(view);return;}
    if(action==='settings-provider'){switchSettingsProvider(kind);return;}
    if(action==='settings-reset'){if(state.busy)return;state.settingsRevision++;state.settingsDirty=false;state.settingsDraft=null;render();return;}
    if(action==='admin-menu-close'){toggleAdminMenu(false);return;}
    if(action==='navigate'&&state.adminMenuOpen)toggleAdminMenu(false);
    if((state.guideUploadBusy||state.radarUploadBusy)&&['navigate','admin-tab-navigate','guide-new','guide-reset','new','continue-chat','open-project','trends-use','delete','radar-open','xhs-for-project'].includes(action))return notify('图片正在保存，完成后再切换。');
    if(action==='dingtalk-reload')await loadDingtalk({quiet:Boolean(state.dingtalk)});
    if(action==='dingtalk-action')await runDingtalkAction(kind);
    if(action==='dingtalk-retry-delivery')await retryDingtalkDelivery(id);
    if(action==='xhs-accounts-refresh'){await loadXhsWorkspace();return;}
    if(action==='xhs-metrics-period'){await accountMetricsView.show(xhsSelectedAccount(),button.dataset.kind);return;}
    if(action==='xhs-metrics-read'){await accountMetricsView.show(xhsSelectedAccount(),accountMetricsView.currentPeriod(),true);return;}
    if(action==='xhs-metrics-sync'){await accountMetricsView.sync();return;}
    if(action==='xhs-notes-sync'){await runNotesSync(state.xhsRoute.accountId,true);return;}
    if(action==='xhs-notes-page'){await loadXhsPublished(Number(button.dataset.offset));return;}
    if(action==='xhs-account-open'){if(state.xhsAccounts?.some(row=>row.accountId===id)){setXhsRoute(xhsAccountRoute(id,'overview'));document.querySelector('#xhs-tab-overview')?.focus({preventScroll:true});}return;}
    if(action==='xhs-account-list'){const prior=state.xhsRoute.accountId;setXhsRoute(xhsAccountRoute('','overview'));document.querySelector(`[data-action="xhs-account-open"][data-id="${CSS.escape(prior)}"]`)?.focus({preventScroll:true});return;}
    if(action==='xhs-account-tab'){if(Object.hasOwn(XHS_ACCOUNT_TABS,button.dataset.tab)){setXhsRoute(xhsAccountRoute(state.xhsRoute.accountId,button.dataset.tab));document.getElementById('xhs-tab-'+button.dataset.tab)?.focus({preventScroll:true});}return;}
    if(action==='xhs-draft-source'){if(!['official','submissions'].includes(button.dataset.source))return;state.xhsDraftSource=button.dataset.source;updateXhs();await loadOpenXhsDrafts();return;}
    if(action==='xhs-detail')await openXhsDetail(kind,id,button);
    if(action==='xhs-edit-official'){
      const current=state.xhsDetail;
      if(current?.kind==='official-draft'&&current.detail?.editable&&current.accountId===xhsAccountId()){
        editXhsDraft({draft:current.detail,account:{...state.xhs.account},projects:state.projects.filter(xhsEligible),api,h,isCurrent:()=>state.xhsDetail===current&&state.view==='xhs'&&xhsAccountId()===current.accountId,
          finished:receipt=>{if(receipt){current.editReceipt={...receipt,submittedAt:Date.now()};current.editNotice='修改已受理，正在等待微服务核验。';}current.error='';current.loading=true;updateXhsDetail();void getXhsDetail(current,++xhsDetailRequestVersion);}});
      }
      return;
    }
    if(action==='xhs-detail-close')closeXhsDetail();
    if(action==='xhs-detail-retry'&&state.xhsDetail){const current=state.xhsDetail;current.loading=true;current.error='';updateXhsDetail();await getXhsDetail(current,++xhsDetailRequestVersion);}
    if(action==='xhs-service-page'&&xhsBound()){
      const offset=Number(button.dataset.offset);
      if(Number.isSafeInteger(offset)&&offset>=0)await syncXhsOfficialDrafts(offset);
    }
    if(action==='xhs-official-sync')await syncXhsOfficialDrafts();
    if(action==='xhs-reload')await loadXhs({quiet:Boolean(state.xhs),refreshProjects:true});
    if(action==='xhs-check-service')await checkXhsPublisher();
    if(action==='guide-publisher-records'&&xhsBound()){
      const target=xhsAccountRecord(guideTargetAccountId());
      if(!target)return notify('当前服务中找不到本次送稿的账号。',true);
      await navigateAdminPage('xhs',xhsAccountRoute(target.accountId,'drafts'));
      state.xhsDraftSource='submissions';updateXhs();return;
    }
    if(action==='guide-show-delivery'){
      const delivery = app.querySelector('.guide-xhs-delivery');
      if(delivery){
        delivery.tabIndex = -1;
        delivery.focus({preventScroll:true});
        delivery.scrollIntoView({block:'start'});
      }
      return;
    }
    if(action==='guide-xhs-continue')await continueGuideXhsDelivery();
    if(action==='guide-xhs-version')await saveGuideXhsVersion();
    if(action==='guide-edit-xhs-copy'&&state.guideProject)await openXhsForProject(state.guideProject.id,guideTargetAccountId());
    if(action==='guide-xhs-recheck')await recheckXhsDraft(id,{fromGuide:true});
    if(action==='xhs-for-project')await openXhsForProject(id);
    if(action==='xhs-schedule-official'){
      const current=state.xhsDetail;
      if(current?.kind==='official-draft' && current.id===id && current.accountId===xhsAccountId()){
        await openXhsPublishDialog(null,{api,h,initialAccountId:current.accountId,officialDraftId:id});
      }
    }
    if(action==='xhs-retry')await retryXhsDraft(id);
    if(action==='xhs-recheck')await recheckXhsDraft(id);
    if(action==='guide-image-add')document.querySelector('#guide-image-input')?.click();
    if(action==='guide-image-remove'){
      if(state.guideUploadBusy||state.guideBusy)return;
      state.guide.draftImages=state.guide.draftImages.filter(image=>image.id!==id);state.guide.attachmentError='';saveGuidance();renderGuidance({preserve:true});
    }
    if(action==='guide-reference-preview'){
      const found=[...state.guide.draftImages,...state.guide.referenceImages,...state.guide.messages.flatMap(message=>normalizeGuideImages(message.images)),...normalizeGuideImages(state.guide.creation?.lastChatRequest?.images),...(state.guideProject?.chatMessages||[]).flatMap(message=>normalizeGuideImages(message.referenceImages||message.images))].find(image=>image.id===id);
      if(found){document.querySelector('#lightbox-image').src=found.url;lightbox.showModal();}
    }
    if(action==='guide-example') {const examples=['给新手做一组养猫准备清单','把产品介绍做成一组宣传图','做一张 AI 工作流知识图'];state.guide.input=examples[Number(button.dataset.example)]||'';saveGuidance();renderGuidance();document.querySelector('#guide-input')?.focus();}
    if(action==='guide-choice') chooseGuidePreference(button.dataset.field,button.dataset.value);
    if(action==='guide-style-category'){const category=button.dataset.category;if(category!=='all'&&!STYLE_CATEGORIES.includes(category))return;state.guideStyleCategory=category;updateGuideStyleResults();}
    if(action==='guide-style-clear'){resetGuideStyleFilters();const search=document.querySelector('#guide-style-search');if(search)search.value='';updateGuideStyleResults();search?.focus();}
    if(action==='guide-count') {const input=document.querySelector('#guide-custom-count');if(input?.checkValidity())chooseGuidePreference('count',Number(input.value));else input?.reportValidity();}
    if(action==='guide-trend-select')chooseGuideTrend(id);
    if(action==='guide-trend-clear')clearGuideTrend();
    if(action==='guide-trend-rematch')await sendGuidance({rematch:true});
    if(action==='guide-edit') {state.guideEdit=button.dataset.field;if(state.guideEdit==='style')resetGuideStyleFilters();renderGuidance();}
    if(action==='guide-cancel-edit') {state.guideEdit=null;renderGuidance();}
    if(action==='guide-create-retry')await recoverGuideCreation();
    if(action==='guide-load-result')await loadGuideProject();
    if(action==='guide-retry-images')await sendGuideProjectMessage({message:state.guideProject?.pages?.length?'重试失败图片，只处理未完成的图片，已完成的图片保持不变。':'重试这次创作，重新完成内容策划并生成图片。'});
    if(action==='guide-chat-retry')await sendGuideProjectMessage({retry:true});
    if(action==='guide-copy-result'){const p=state.guideProject;if(!p)return;await navigator.clipboard.writeText([p.title,p.caption].filter(Boolean).join('\n\n'));notify('帖子标题和文案已复制。');}
    if(action==='guide-result-preview'){const page=state.guideProject?.pages?.find(page=>page.id===id);if(page?.imageUrl){document.querySelector('#lightbox-image').src=page.imageUrl;lightbox.showModal();}}
    if(action==='guide-new')resetGuideConversation();
    if(action==='continue-chat')await resumeProjectInGuide(id);
    if(action==='guide-retry') await sendGuidance({retry:true});
    if(action==='guide-reset')resetGuideConversation();
    if(action==='navigate'||action==='admin-tab-navigate')await navigateAdminPage(view);
    if(action==='radar-reload')await loadRadar({quiet:Boolean(state.radar)});
    if(action==='radar-scan')await scanRadar();
    if(action==='radar-filter')filterRadar(button.dataset.filter);
    if(action==='radar-setup'){if(button.dataset.section==='model')document.querySelector('.nav-item[data-view="settings"]')?.click();else{const panel=document.querySelector(`#radar-${button.dataset.section}-panel`);if(panel){panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'start'});panel.querySelector('input,textarea,select')?.focus({preventScroll:true});}}}
    if(action==='radar-approve')await decideRadar(id,'approve');
    if(action==='radar-skip'){const item=state.radar?.opportunities.find(item=>item.id===id);if(item?.state==='pending'){state.radarSkipDrafts[id]={reason:'',note:'',...state.radarSkipDrafts[id],open:true};updateRadarBoard();Array.from(document.querySelectorAll('.radar-skip-form')).find(el=>el.dataset.radarSkipId===id)?.querySelector('select')?.focus({preventScroll:true});}}
    if(action==='radar-skip-cancel'){delete state.radarSkipDrafts[id];updateRadarBoard();}
    if(action==='radar-open')await resumeProjectInGuide(id);
    if(action==='radar-link'){const result=await api(`/api/radar/opportunities/${encodeURIComponent(id)}/link`,{method:'POST',body:{}});await navigator.clipboard.writeText(result.url);notify('决策链接已复制，请仅分享给自己。');}
    if(action==='radar-material-add'){const target=document.querySelector('#radar-materials');if(target.querySelectorAll('.radar-material').length>=20)return notify('最多保存 20 份资料。',true);target.insertAdjacentHTML('beforeend',radarMaterialView());target.lastElementChild?.querySelector('input')?.focus();}
    if(action==='radar-material-remove'&&!state.radarUploadBusy){const material=button.closest('.radar-material');if(material){delete state.radarMaterialReferences[material.dataset.materialKey];material.remove();}}
    if(action==='radar-material-import')document.querySelector('#radar-material-files')?.click();
    if(action==='radar-reference-add')document.querySelector('#radar-reference-input')?.click();
    if(action==='radar-material-reference-add')Array.from(document.querySelectorAll('[data-radar-material-input]')).find(el=>el.dataset.radarMaterialInput===button.dataset.key)?.click();
    if(action==='radar-material-reference-remove'&&!state.radarUploadBusy){const key=button.dataset.key;state.radarMaterialReferences[key]=(state.radarMaterialReferences[key]||[]).filter(image=>image.id!==id);const target=Array.from(document.querySelectorAll('[data-material-reference-key]')).find(el=>el.dataset.materialReferenceKey===key);if(target)target.innerHTML=radarReferencesView(key);}
    if(action==='radar-reference-preview'){const found=(button.dataset.key?state.radarMaterialReferences[button.dataset.key]:state.radarReferences)?.find(image=>image.id===id);if(found){document.querySelector('#lightbox-image').src=found.url;lightbox.showModal();}}
    if(action==='radar-reference-remove'&&!state.radarUploadBusy){state.radarReferences=state.radarReferences.filter(image=>image.id!==id);document.querySelector('#radar-reference-images').innerHTML=radarReferencesView();}
    if(action==='radar-notification-test')await testRadarNotification(button);
    if(action==='radar-notification-retry')await retryRadarNotification(kind,id);
    if(action==='trends-refresh')await refreshTrends();
    if(action==='trends-settings-open')openTrendsSettings();
    if(action==='trends-settings-close')closeTrendsSettings();
    if(action==='trends-platform'){state.trendPlatform=button.dataset.platform;state.trendLimit=24;renderTrends();}
    if(action==='trends-scope'){state.trendScope=button.dataset.scope;state.trendLimit=24;renderTrends();}
    if(action==='trends-more'){state.trendLimit+=24;renderTrends();}
    if(action==='trends-clear-filters'){state.trendSearch='';state.trendPlatform='all';state.trendScope='all';state.trendLimit=24;renderTrends();}
    if(action==='trends-toggle')await saveTrendsSettings({enabled:!state.trends.settings.enabled});
    if(action==='trends-interval'){const interval=Number(document.querySelector('#trends-interval')?.value);await saveTrendsSettings({intervalMinutes:interval});}
    if(action==='trends-use')useTrendForCreation(id);
    if(action==='reload') await boot();
    if(action==='new') resetGuideConversation();
    if(action==='open-project') await resumeProjectInGuide(id);
    if(action==='delete') await deleteProject(id);
    if(action==='filter'){state.filter=button.dataset.filter;state.historyPage=1;render();}
    if(action==='load-models') await loadModels(kind);
    if(action==='test') await testConnection(kind);
  } catch(error) {notify(error.message,true);}
});
document.querySelector('#close-lightbox').addEventListener('click',()=>lightbox.close());
lightbox.addEventListener('click',event=>{if(event.target===lightbox)lightbox.close();});
app.addEventListener('toggle',event=>{if(event.target.id==='xhs-composer-disclosure')state.xhsComposerOpen=event.target.open;if(event.target.id==='guide-delivery-settings')state.guideDeliverySettingsOpen=event.target.open;if(event.target.id==='trends-source-details')state.trendsSourcesOpen=event.target.open;},true);
app.addEventListener('cancel',event=>{if(event.target.id==='trends-settings-dialog'){event.preventDefault();closeTrendsSettings();}},true);
app.addEventListener('click',event=>{if(event.target.id!=='trends-settings-dialog')return;const rect=event.target.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeTrendsSettings();});
app.addEventListener('cancel',event=>{if(event.target.id==='xhs-detail-dialog'){event.preventDefault();closeXhsDetail();}},true);
app.addEventListener('click',event=>{const dialog=event.target;if(dialog.id==='xhs-detail-dialog'){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeXhsDetail();}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.adminMenuOpen){event.preventDefault();toggleAdminMenu(false);}});
app.addEventListener('keydown',event=>{
  const current=event.target.closest?.('.xhs-tabs [role=tab]');
  if(!current)return;
  const keys=Object.keys(XHS_ACCOUNT_TABS),index=keys.indexOf(current.dataset.tab);
  const next={Home:0,End:keys.length-1,ArrowLeft:(index+keys.length-1)%keys.length,ArrowRight:(index+1)%keys.length}[event.key];
  if(next===undefined)return;
  event.preventDefault();
  const tab=keys[next];setXhsRoute(xhsAccountRoute(state.xhsRoute.accountId,tab));document.getElementById('xhs-tab-'+tab)?.focus();
});
app.addEventListener('keydown',event=>{const tab=event.target.closest('.admin-provider-tabs [role=tab]');if(!tab)return;let kind;if(['ArrowRight','ArrowLeft'].includes(event.key))kind=tab.dataset.kind==='text'?'image':'text';if(event.key==='Home')kind='text';if(event.key==='End')kind='image';if(kind){event.preventDefault();switchSettingsProvider(kind);document.querySelector('#settings-tab-'+kind)?.focus();}});
app.addEventListener('keydown',event=>{if(event.target.id==='guide-input'&&(event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();sendGuidance();}});

async function refreshHistory() {
  try {const {projects}=await api('/api/projects');state.projects=projects;if(state.view==='history')render();}
  catch(error){notify(error.message,true);}
}
async function deleteProject(id) {
  const project=state.projects.find(p=>p.id===id);
  if(isActive(project))return;
  if(!confirm(`删除「${project?.title || '这份作品'}」及其生成文件？此操作无法恢复。`))return;
  await api(`/api/projects/${encodeURIComponent(id)}`,{method:'DELETE'});
  state.projects=state.projects.filter(p=>p.id!==id);
  if(state.guide.creation?.projectId===id){const view=state.view;resetGuideConversation({confirmExisting:false});state.view=view;}
  render();notify('作品已删除。');
}
async function saveSettings() {
  if(state.busy)return;
  const settingsForm=document.querySelector('#settings-form');if(!settingsForm)return;
  const invalid=[...settingsForm.elements].find(input=>input.willValidate&&!input.validity.valid);
  if(invalid){switchSettingsProvider(invalid.name?.startsWith('image.')?'image':'text');invalid.reportValidity();invalid.focus();return;}
  const submittedRevision=state.settingsRevision,form=new FormData(settingsForm);
  const data={text:{},image:{}};
  for(const [key,value] of form.entries()){const [kind,field]=key.split('.');data[kind][field]=String(value).trim();}
  state.busy='settings';
  const submit=document.querySelector('#settings-form [type="submit"]'),reset=document.querySelector('[data-action="settings-reset"]');if(reset)reset.disabled=true;if(submit){submit.disabled=true;submit.textContent='正在保存…';}
  try {const result=await api('/api/config',{method:'PUT',body:data});state.config=result.config||result;state.testResults={};if(state.settingsRevision===submittedRevision){state.settingsDraft=null;state.settingsDirty=false;}else{captureSettingsDraft();state.settingsDirty=true;}notify(state.settingsDirty?'已保存提交的配置，后续修改仍待保存。':'模型设置已保存。');}
  catch(error){notify(error.message,true);return;}
  finally{state.busy='';if(reset)reset.disabled=false;if(submit){submit.disabled=false;submit.textContent='保存模型设置';}}
  render();
}
async function loadModels(kind) {
  if(state.busy)return;
  state.busy=`models-${kind}`;
  const trigger=document.querySelector(`[data-action="load-models"][data-kind="${kind}"]`);
  if(trigger){trigger.disabled=true;trigger.textContent='正在读取…';}
  try {const {models}=await api(`/api/models?kind=${kind}`);state.models[kind]=models;document.querySelector(`#${kind}-models`).innerHTML=models.map(m=>`<option value="${h(m)}"></option>`).join('');notify(models.length?`已读取 ${models.length} 个模型，点击模型输入框选择。`:'接口没有返回模型列表，可手动填写模型 ID。');}
  finally{state.busy='';if(trigger){trigger.disabled=false;trigger.textContent='读取模型列表';}}
}
async function testConnection(kind) {
  if(state.busy)return;
  state.busy=`test-${kind}`;
  const trigger=document.querySelector(`[data-action="test"][data-kind="${kind}"]`);
  const oldLabel=trigger?.textContent;
  if(trigger){trigger.disabled=true;trigger.innerHTML='<span class="spinner spinner-small"></span>正在测试…';}
  try {const result=await api('/api/test',{method:'POST',body:{kind}});state.testResults[kind]=result;notify(result.message||'连接测试成功。',!result.ok);}
  catch(error){state.testResults[kind]={ok:false,message:error.message};notify(error.message,true);}
  finally{
    state.busy='';
    if(trigger){
      trigger.disabled=false;trigger.textContent=oldLabel;
      const panel=trigger.closest('.provider-panel');
      panel?.querySelector('.test-result')?.remove();
      const result=state.testResults[kind];
      if(panel&&result)panel.insertAdjacentHTML('beforeend',`<div class="test-result ${result.ok?'success':'failure'}">${icon(result.ok?'check':'alert')}<span>${h(result.message)}</span></div>`);
    }
  }
}
async function boot() {
  state.bootError='';
  const results=await Promise.allSettled([api('/api/config'),api('/api/projects')]);
  if(results[0].status==='fulfilled')state.config=results[0].value.config||results[0].value;
  else state.bootError=results[0].reason.message;
  if(results[1].status==='fulfilled')state.projects=results[1].value.projects;
  else if(!state.bootError)state.bootError=results[1].reason.message;
  render();
  if(state.guide.creation){
    const c=state.guide.creation,project=state.projects.find(project=>project.id===c.projectId||project.creationRequestId===c.requestId);
    if(project)setGuideProject(project);
    if(c.projectId)await loadGuideProject({quiet:true});
    else{c.error=c.error||'上次生成请求的结果尚未确认。点击确认上次请求结果，只查询已有作品，不会自动重新生成。';saveGuidance();renderGuidance({focusCreation:true});}
  }
  if(state.view==='trends')await loadTrends();
  if(state.view==='radar')await loadRadar();
  if(state.view==='dingtalk')await loadDingtalk();
  if(state.view==='xhs')await loadXhsWorkspace();
  else if(state.view==='briefing')await loadXhs({quiet:true});
}
boot();
