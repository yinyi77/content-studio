import { IMAGE_STYLES, STYLE_CATEGORIES } from './style-catalog.js';

const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const lightbox = document.querySelector('#lightbox');
const GUIDE_STORAGE_KEY = 'content-studio:briefing:v1';
const EMBEDDED_MODE = new URLSearchParams(location.search).get('embedded')==='1' && window.parent!==window;
if(EMBEDDED_MODE)document.documentElement.classList.add('legacy-embedded');
let lastEmbeddedView='';
let embeddedNavigationVersion=0;
let embeddedParentNavigationDepth=0;
const GUIDE_STYLES = IMAGE_STYLES;
const GUIDE_IMAGE_LIMIT = 4;
const GUIDE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const XHS_LOCATION_KEY = 'content-studio:xhs-workspace:v1';
function restoreXhsLocation() {
  try {
    const value=JSON.parse(localStorage.getItem(XHS_LOCATION_KEY)||'null');
    const tabs=Object.fromEntries(Object.entries(value?.tabs||{}).filter(([id,tab])=>/^[A-Za-z0-9_-]{1,120}$/.test(id)&&['analytics','published','drafts'].includes(tab)).slice(-50));
    return {tabs};
  } catch {return {tabs:{}};}
}
const state = {
  view: ['trends','radar','xhs','dingtalk','history','settings'].includes(new URLSearchParams(location.search).get('view')) ? new URLSearchParams(location.search).get('view') : 'briefing', config: null, projects: [],
  busy: '', search: '', filter: 'all', adminMenuOpen: false,
  adminSidebarCollapsed: restoreAdminSidebar(), adminVisited: restoreAdminVisited(),
  settingsTab: 'text', settingsDraft: null, settingsDirty: false, settingsRevision: 0,
  historyLayout: 'table', historyPage: 1, historyPageSize: 12, historySort: 'updated', historyReloading: false,
  models: { text: [], image: [] }, testResults: {}, bootError: '',
  guide: restoreGuidance(), guideBusy: false, guideEdit: null, guideProject: null, guideActionBusy: '', guidePublishPrompt: false,
  guideStyleCategory: 'all', guideStyleSearch: '',
  guideUploadBusy: false,
  trends: null, trendsError: '', trendsLoading: false, trendsBusy: '',
  trendPlatform: 'all', trendSearch: '', trendScope: 'all', trendLimit: 24, trendKeywordsDraft: '', trendKeywordsDirty: false, trendIntervalDraft: null,
  radar: null, radarLoading: false, radarError: '', radarBusy: '', radarFilter: 'pending', radarReferences: [], radarUploadBusy: false,
  radarMaterialReferences: {}, radarSkipDrafts: {}, radarNotificationBusy: '',
  xhs: null, xhsLoading: false, xhsError: '', xhsBusy: '', xhsProjectId: '', xhsPreview: null,
  xhsAccountBusy: '', xhsAccountEditor: null, xhsAccountGroup: 'all', xhsAccountSearch: '', xhsAccountStatus: 'all',
  xhsLocation: restoreXhsLocation(), xhsSection: 'auto', xhsTab: 'analytics',
  xhsNoteSearch: '', xhsNoteSort: 'recent', xhsNoteLimit: 50, xhsMissingOpen: false, xhsDetail: null,
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
    matchTrends:true,xhsAutoDelivery:false,xhsTargetAccountId:null,trendMatches:null,selectedTrend:null,trendNotice:'',studioSource:'',creation:null,creationError:'',draftImages:[],referenceImages:[],attachmentError:'',
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
    if(typeof data.xhsTargetAccountId==='string'&&(!data.xhsTargetAccountId||/^[A-Za-z0-9_-]{1,120}$/.test(data.xhsTargetAccountId)))base.xhsTargetAccountId=data.xhsTargetAccountId;
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
      if(c.capture&&typeof c.capture==='object')base.creation.capture={xhsAutoDelivery:c.capture.xhsAutoDelivery===true,...(c.capture.xhsAutoDelivery===true?{xhsAccountId:typeof c.capture.xhsAccountId==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(c.capture.xhsAccountId)?c.capture.xhsAccountId:null}:{})};
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
  return `<form id="guide-form" class="guide-composer ${g.draftImages.length?'has-attachments':''}" aria-label="文字和图片消息输入框"><label class="sr-label" for="guide-input">${creating?'直接告诉我还想怎么改':'告诉创意编辑你想创作什么'}</label><input id="guide-image-input" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden ${busy||locked?'disabled':''}><button type="button" class="guide-attach-button" data-action="guide-image-add" aria-label="在消息中添加产品图片" title="可直接粘贴或拖入图片" ${busy||locked?'disabled':''}>${icon('image')}</button><div class="guide-composer-content">${guideDraftImagesView()}<textarea id="guide-input" maxlength="${creating?6000:24000}" rows="2" placeholder="${placeholder}" ${state.guideBusy?'disabled':''}>${h(g.input)}</textarea></div><div class="guide-composer-footer"><div class="guide-composer-options">${!creating?`<label class="guide-trends-toggle"><input id="guide-match-trends" type="checkbox" ${g.matchTrends?'checked':''} ${state.guideBusy?'disabled':''}><span>匹配相关热点</span></label>`:''}<span>${state.guideUploadBusy?'图片正在保存到本机，完成后可发送。':hint}</span></div><button class="button button-primary" type="submit" ${sendDisabled?'disabled':''}>${state.guideUploadBusy?'<span class="spinner spinner-small"></span>添加中':state.guideBusy?'<span class="spinner spinner-small"></span>分析中':locked?'<span class="spinner spinner-small"></span>处理中':creating?'发送修改':g.decision?.action==='ask'?'回答并创作':'发送想法'} ${icon('arrow')}</button></div></form>`;
}
function saveGuidance() {try{sessionStorage.setItem(GUIDE_STORAGE_KEY,JSON.stringify(state.guide));}catch{}}
const guideStyles = () => (state.config?.styles?.length?state.config.styles:GUIDE_STYLES).map(style=>{
  const fallback=GUIDE_STYLES.find(item=>item.id===style.id)||{};
  return {...fallback,...style,category:style.category||fallback.category||STYLE_CATEGORIES[0],aliases:Array.isArray(style.aliases)?style.aliases:fallback.aliases||[]};
});
const guideTextReady = () => Boolean(state.config?.text?.hasKey&&state.config.text.baseUrl&&state.config.text.model);
const guideFieldLabel = field => ({style:'视觉风格',aspect:'画面比例',count:'图片张数'}[field]);
function guideValueLabel(field,value) {
  if(field==='style')return guideStyles().find(s=>s.id===value)?.name||value;
  if(field==='aspect')return ({'3:4':'3:4 · 竖版','1:1':'1:1 · 方形','16:9':'16:9 · 横版'}[value])||value;
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
  return {style:'你想要怎样的视觉风格？',aspect:'准备用什么画面比例？',count:'这次想做几张图片？'}[field];
}
function guidanceView() {
  const g=state.guide,p=state.guideProject,creating=Boolean(g.creation),locked=guideWorkActive();
  const examples=['给新手做一组养猫准备清单','把产品介绍做成一组宣传图','做一张 AI 工作流知识图'];
  const thread=g.messages.length?g.messages.map(m=>`<article class="guide-message ${m.role==='user'?'user':'assistant'} ${m.kind==='clarification'?'is-clarification':''}"><span class="guide-message-label">${m.role==='user'?'你':'创意编辑'}</span>${m.kind==='clarification'?`<span class="guide-batch-label">${icon('file')}补充创作信息</span>`:''}${guideImageMessageView(m.images)}<p>${h(m.content)}</p></article>`).join(''):creating?`<article class="guide-message assistant"><span class="guide-message-label">创意编辑</span>${guideImageMessageView(g.referenceImages)}<p>已载入这份作品。查看图文，或直接告诉我想怎么改。</p></article>`:`<div class="guide-welcome"><span class="eyebrow">从一个想法，到一整组内容</span><h2>新建图文任务</h2><p>输入创作需求，可直接粘贴或拖入产品图片。补充信息后生成文案和图片。</p><div class="guide-flow" aria-label="创作流程"><span>说个想法</span><i>→</i><span>一次补充</span><i>→</i><span>完整图文</span><i>→</i><span>${g.xhsAutoDelivery?'小红书草稿':'发布时再送稿'}</span></div><div class="guide-examples">${examples.map((example,i)=>`<button data-action="guide-example" data-example="${i}">${h(example)} ${icon('arrow')}</button>`).join('')}</div></div>`;
  const preferenceIcons={style:'image',aspect:'expand',count:'cards'};
  const preferences=(g.analysis||creating)?`<div class="guide-inline-brief" aria-label="创作参数">${['style','aspect','count'].map(f=>{
    const value=creating&&f==='count'&&p?.pages?.length?p.pages.length:g.preferences[f]??g.recommendations[f];
    return `<span class="guide-preference">${icon(preferenceIcons[f])}<span class="sr-label">${guideFieldLabel(f)}：</span><strong>${h(guideValueLabel(f,value))}</strong>${!creating&&g.preferences[f]===null?'<span>建议</span>':''}</span>`;
  }).join('')}</div>`:'';
  const trend=g.selectedTrend?`<details class="guide-context-trend"><summary><span>已选热点</span><strong>${h(g.selectedTrend.title)}</strong><span>${h(trendName(g.selectedTrend.platform))}</span></summary><p>${h(g.selectedTrend.angle)}</p>${g.selectedTrend.kind==='meme'?`<small>热梗候选 · 至 ${guideTrendDate(g.selectedTrend.expiresAt)} 有效</small>`:''}${!creating?`<button type="button" class="text-button" data-action="guide-trend-clear" ${state.guideBusy?'disabled':''}>移除热点</button>`:''}</details>`:'';
  const tools=!creating&&g.analysis&&!g.error?`<details class="guide-optional-tools" ${state.guideEdit?'open':''}><summary>查看创作方向与偏好 <span>可选，直接聊天也可以</span></summary><div class="guide-analysis"><span>内容方向</span><p>${h(g.analysis)}</p></div>${preferences}<div class="guide-optional-actions">${['style','aspect','count'].map(f=>`<button type="button" class="text-button" data-action="guide-edit" data-field="${f}" ${state.guideBusy?'disabled':''}>调整${guideFieldLabel(f)}</button>`).join('')}</div>${state.guideEdit?guideQuestionView(state.guideEdit):''}${guideTrendMatchesView()}</details>`:'';
  const hint=locked?'任务正在处理中，可以先写好下一条要求。':creating?'直接说想改哪里，或按 ⌘ / Ctrl + Enter 发送。':g.decision?.action==='ask'?'把上面的问题一起回复，拿不准的偏好可以交给我。':'信息齐全后会自动生成；暂不生成时直接告诉我。';
  return `<div class="briefing-layout conversation-layout ${creating?'has-creation':''} ${!creating&&!g.messages.length?'is-empty':''}"><section class="briefing-panel" aria-label="创作需求对话"><div id="guide-xhs-region">${guideXhsConnectionView()}</div><div class="guide-thread" role="log" aria-live="polite">${thread}${state.guideBusy?'<div class="guide-thinking"><span class="spinner spinner-small"></span>正在理解你的想法，检查还需要哪些信息…</div>':''}${g.error?`<div class="guide-error" role="alert"><p>${h(g.error)}</p>${!creating&&g.messages.some(m=>m.role==='user')?`<button class="text-button" data-action="guide-retry" ${state.guideBusy?'disabled':''}>重试这次分析</button>`:''}</div>`:''}${creating?preferences:''}${trend}${tools}${guideCreationView()}</div>${guideComposerView({creating,locked,p,hint})}<div class="guide-model-note">${creating?'修改通过文字模型理解；需要重画时才调用图片模型，可能产生费用。':guideTextReady()?'发送后会分析需求，信息齐全时自动调用文字与图片模型。':'先连接文字模型即可开始。'}${!guideTextReady()?` <button class="text-button" data-action="navigate" data-view="settings">去模型设置 ${icon('arrow')}</button>`:''}</div></section></div>`;
}

const GUIDE_DELIVERY_BUSY = new Set(['preparing','queued','running']);
const guideGenerationActive = project => Boolean(project&&(isActive(project)||['thinking','analyzing','generating'].includes(project.chatStatus)));
function guideDeliveryActive(project) {
  const delivery=project?.xhsDelivery;
  return Boolean(delivery?.enabled&&(delivery.running||GUIDE_DELIVERY_BUSY.has(delivery.status)||(delivery.status==='waiting_generation'&&project.status==='completed')));
}
function guideProjectActive(project) { return guideGenerationActive(project)||guideDeliveryActive(project); }
function guideXhsConnectionView() {
  const g=state.guide,p=state.guideProject,delivery=p?.xhsDelivery,targetId=guideTargetAccountId(),record=xhsAccountRecord(targetId)||(!targetId?(xhsAccounts().find(record=>record.profileId===xhsProfileId())||(state.xhs?{profileId:xhsProfileId(),connectionState:state.xhs.connection?.state}:null)):null),targetBound=xhsRecordBound(record),connected=xhsRecordConnected(record),busy=Boolean(state.guideActionBusy||record?.busy||guideDeliveryActive(p));
  const automatic=Boolean(delivery?.enabled||!p&&(g.creation?.capture?.xhsAutoDelivery??g.xhsAutoDelivery)),fixed=Boolean(delivery?.accountId||g.creation?.capture?.xhsAutoDelivery),showConnection=automatic||state.guidePublishPrompt;
  const name=delivery?.accountName||xhsRecordName(record),label=fixed?`本次草稿账号：${name}`:automatic?(targetBound?`完成后自动存至：${name}`:'已开启自动存入小红书草稿'):targetBound?`送稿账号：${name}`:'创作与修改保存在本平台';
  const message=fixed?'本次目标账号已固定。切换工作台账号不会改变送稿目标。':targetBound&&!connected?'账号已保存，送稿时会检查该账号的登录状态。':automatic?'整组图文完成后送入所选账号的电脑草稿，发布由你决定。':'准备发布时，选择一个账号再送入电脑草稿。';
  const records=xhsAccounts().filter(record=>xhsRecordBound(record)),fallback=!records.length&&targetBound?[record]:records;
  const selector=(showConnection||records.length>1)&&!fixed?`<label class="guide-xhs-target" for="guide-xhs-target-account"><span>送稿账号</span><select id="guide-xhs-target-account" ${busy?'disabled':''}><option value="">选择已绑定账号</option>${fallback.map(record=>`<option value="${h(record.accountId)}" ${record.accountId===targetId?'selected':''}>${h(xhsRecordName(record))}${record.group?' · '+h(record.group):''}</option>`).join('')}${targetId&&!fallback.some(record=>record.accountId===targetId)?`<option value="${h(targetId)}" selected disabled>原目标账号已移除，请重新选择</option>`:''}</select><button class="text-button" type="button" data-action="navigate" data-view="xhs">管理账号 ↗</button></label>`:'';
  return `<div class="guide-xhs-connection ${connected&&automatic?'is-connected':''} ${automatic?'':'is-local'}"><div><span class="guide-xhs-mark">${icon('file')}</span><span><strong>${busy?'<span class="spinner spinner-small"></span>':''}${h(label)}</strong><small>${h(message)}</small></span></div>${selector}${showConnection?`<div class="guide-xhs-connection-actions">${connected?`<button class="text-button" type="button" data-action="guide-xhs-action" data-kind="open-drafts" ${busy?'disabled':''}>打开电脑草稿 ${icon('arrow')}</button>`:`<button class="text-button" type="button" data-action="guide-xhs-action" data-kind="login" ${busy?'disabled':''}>${targetBound?'重新扫码登录':'连接小红书'} ${icon('arrow')}</button>`}<button class="text-button" type="button" data-action="guide-xhs-action" data-kind="check" ${busy||!record?'disabled':''}>${connected?'检查连接':'我已登录，检查连接'}</button></div>`:''}${!g.creation?`<label class="guide-xhs-auto-option"><input id="guide-xhs-auto-delivery" type="checkbox" ${g.xhsAutoDelivery?'checked':''} ${state.guideBusy||state.guideActionBusy?'disabled':''}><span>生成后自动存入小红书草稿 <small>可选</small></span></label>`:''}</div>`;
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
  if(delivery.status==='interrupted'&&guideDeliveryMayContinue(delivery))return '图文已保留，草稿尚未送出，可继续';
  if(guideEditedAfterDelivery(project))return '图文已更新，原草稿保留此前版本';
  return ({waiting_generation:'图文完成后自动存草稿',preparing:'正在准备小红书草稿',queued:'正在等待送入电脑草稿',running:'正在存入并核验电脑草稿',verified:'图文和电脑草稿已完成',filled:'图文已填入，草稿待核验',unknown:'草稿保存结果待核验',failed:'图文已保留，草稿尚未送达',blocked:'图文已保留，草稿等待继续',interrupted:'草稿流程已中断，需人工核验'}[delivery.status])||'草稿状态待确认';
}
function guideLocalDraftView(project) {
  const ready=xhsEligible(project),busy=guideGenerationActive(project)||Boolean(state.guideActionBusy),targetId=guideTargetAccountId(),record=xhsAccountRecord(targetId),boundAccount=xhsRecordBound(record);
  return `<section class="guide-xhs-delivery guide-local-draft" aria-label="本平台草稿" aria-busy="${busy}"><div class="guide-delivery-result"><div><strong>${icon('file')}${ready?'图文已保存在本平台':'创作内容保存在本平台'}</strong><p>直接在对话里继续修改，准备发布时再送入小红书草稿。</p>${state.guidePublishPrompt&&!boundAccount?'<p class="guide-local-login-hint" role="status">首次送入小红书时，请在上方扫码并确认绑定账号，之后送稿会自动检查保存的登录状态。</p>':boundAccount?`<small>目标账号：${h(xhsRecordName(record))}${xhsRecordConnected(record)?'':' · 送稿时自动检查登录'}</small>`:''}</div>${ready?`<div class="guide-delivery-actions"><button class="button button-secondary" type="button" data-action="guide-xhs-first" data-account-id="${h(boundAccount?targetId:'')}" ${busy||record?.busy||state.xhsAccountBusy?'disabled':''}>${icon('arrow')}送入小红书草稿</button></div>`:''}</div></section>`;
}
function guideDeliveryView(project) {
  const delivery=project?.xhsDelivery;if(!delivery?.enabled)return guideLocalDraftView(project);
  const imagesReady=project.status==='completed'&&(project.pages||[]).length>0&&(project.pages||[]).every(page=>page.status==='done'&&page.imageUrl),busy=guideDeliveryActive(project),receipt=guideDeliveryReceipt(project),edited=guideEditedAfterDelivery(project);
  const warning=['blocked','failed','filled','unknown','interrupted'].includes(delivery.status),verified=delivery.status==='verified';
  const planningDone=Boolean(project.pages?.length),target=xhsAccountRecord(delivery.accountId||guideTargetAccountId()),accountMatch=xhsRecordBound(target),targetWorking=Boolean(target?.busy||state.xhsAccountBusy||state.xhsBusy);
  const stages=[['策划内容',planningDone,'analyzing'],['生成完整图文',imagesReady,'generating'],['存入小红书草稿',verified,'delivery']];
  const canContinue=imagesReady&&guideDeliveryMayContinue(delivery)&&xhsRecordBound(target)&&accountMatch&&!busy&&!targetWorking&&!state.guideActionBusy;
  const canSend=xhsRecordBound(target)&&accountMatch&&!busy&&!targetWorking&&!guideGenerationActive(project)&&!state.guideActionBusy;
  const canOpen=xhsRecordConnected(target)&&accountMatch&&!busy&&!targetWorking&&!guideGenerationActive(project)&&!state.guideActionBusy;
  const canRecheck=Boolean(delivery.draftId&&xhsCanRecheck(receipt)),canSaveVersion=edited&&imagesReady&&delivery.canSaveVersion!==false&&!delivery.pendingVersion;
  const hint=edited?'当前修改还未送入小红书。直接说“把修改版存到草稿箱”，或在这里另存新版；此前草稿保留。':delivery.message||(!imagesReady?'全部图片完成后，会自动送入本次绑定账号的电脑草稿。':busy?'正在后台送稿，刷新页面不会重复上传。':verified?'已保存至电脑草稿，发布由你在小红书决定。':'图文和图片已经保留，请按提示继续处理。');
  const continueLabel=delivery.accountId?'继续送入草稿':`继续送至 ${xhsRecordName(target)} 草稿`;
  return `<section class="guide-xhs-delivery ${warning?'is-warning':verified?'is-verified':''}" aria-label="创作与草稿交付进度" aria-busy="${busy}"><ol class="guide-delivery-steps">${stages.map(([label,done,kind],index)=>{const current=!done&&(kind==='delivery'?imagesReady:(kind==='generating'?planningDone:!planningDone));return `<li class="${done?'is-done':current?'is-current':''}"><span>${done?icon('check'):index+1}</span><strong>${label}</strong></li>`;}).join('')}</ol><div class="guide-delivery-result"><div><strong>${busy?'<span class="spinner spinner-small"></span>':icon(verified?'check':warning?'alert':'file')}${h(guideDeliveryLabel(project))}</strong><p>${h(hint)}</p>${delivery.accountId?`<small>目标账号：${h(delivery.accountName||delivery.accountId)}${Number(delivery.version)>1?` · 第 ${Number(delivery.version)} 版`:''}</small>`:''}${delivery.accountId&&!accountMatch?'<small class="guide-delivery-account-mismatch">原目标账号已移除，请先重新绑定该账号，平台不会改投。</small>':''}</div><div class="guide-delivery-actions">${imagesReady&&guideDeliveryMayContinue(delivery)?`<button class="button button-secondary" type="button" data-action="guide-xhs-continue" ${canContinue?'':'disabled'}>${icon('arrow')}${h(continueLabel)}</button>${!xhsRecordBound(target)?'<span>首次使用请先在上方扫码绑定账号。</span>':!xhsRecordConnected(target)?'<span>已绑定账号，送稿时会自动检查登录。</span>':''}`:''}${canRecheck?`<button class="button button-secondary" type="button" data-action="guide-xhs-recheck" data-id="${h(delivery.draftId)}" ${canOpen?'':'disabled'}>${icon('refresh')}重新核验草稿</button>`:''}${canSaveVersion?`<button class="button button-secondary" type="button" data-action="guide-xhs-version" ${canSend?'':'disabled'}>${icon('arrow')}将当前版本另存草稿</button>`:''}${['verified','filled','unknown','interrupted'].includes(delivery.status)?`<button class="text-button" type="button" data-action="guide-xhs-action" data-kind="open-drafts" ${canOpen?'':'disabled'}>${verified?'打开电脑草稿':'打开官方窗口核对'} ${icon('arrow')}</button>`:''}</div></div>${delivery.status==='interrupted'&&guideDeliveryMayContinue(delivery)?'<p class="guide-delivery-note">上次在送稿前中断，图文已保留。点击继续后才会送入电脑草稿。</p>':['unknown','filled','interrupted'].includes(delivery.status)?`<p class="guide-delivery-note">${canRecheck?'重新核验只读取已有草稿，不会再次上传。若尚未保存，请先在官方窗口保存后再核验。':'请在小红书官方窗口核对，本平台不会自动重复提交这份草稿。'}</p>`:''}${guideDeliveryHistoryView(delivery)}</section>`;
}
function guideCompletionNotice(project) {
  const latest=project.chatRequests?.at(-1);
  if(project.chatStatus==='error'||latest?.status==='error')return {message:project.chatError||latest?.error||latest?.reply||'这次修改尚未应用，原图文已保留。',warning:true};
  if(latest?.status==='completed'&&latest.action==='reply')return {message:'已回复，图文保持当前版本。',warning:false};
  if(latest?.status==='completed'&&latest.action==='append_pages')return {message:Number.isInteger(latest.appendedCount)&&latest.appendedCount>0?`已追加 ${latest.appendedCount} 张配图，原有图片保留。`:'新增配图已保存，原有图片保留。',warning:false};
  const delivery=project?.xhsDelivery;
  if(delivery?.enabled){
    if(delivery.status==='verified')return {message:guideEditedAfterDelivery(project)?'本次图文修改已完成，原小红书草稿仍保留此前版本。':'图文已完成，并已存入小红书电脑草稿。',warning:false};
    if(delivery.status==='interrupted'&&guideDeliveryMayContinue(delivery))return {message:'图文已保留，草稿尚未送出，可在当前对话继续送稿。',warning:true};
    if(['filled','unknown','interrupted'].includes(delivery.status))return {message:xhsCanRecheck(guideDeliveryReceipt(project))?'图文已保留，可在当前对话重新核验电脑草稿。':'图文已保留，草稿保存结果需要在小红书窗口核验。',warning:true};
    if(['failed','blocked'].includes(delivery.status)&&project.status==='completed')return {message:delivery.message||'图文已完成，草稿还未送达，可在当前对话继续处理。',warning:true};
  }
  return {message:project.status==='completed'?'图文已完成，可以直接在对话里查看和修改。':project.error||'这次处理已结束，结果已保存在对话中。',warning:['error','partial','interrupted'].includes(project.status)||['error','interrupted'].includes(project.chatStatus)};
}
function updateGuideXhs() {
  if(state.view!=='briefing')return;
  const region=document.querySelector('#guide-xhs-region');if(region)region.innerHTML=guideXhsConnectionView();
  const delivery=document.querySelector('.guide-xhs-delivery');if(delivery&&state.guideProject)delivery.outerHTML=guideDeliveryView(state.guideProject);
}
async function continueGuideXhsDelivery() {
  const p=state.guideProject,delivery=p?.xhsDelivery;
  if(!p||!guideDeliveryMayContinue(delivery)||guideGenerationActive(p)||guideDeliveryActive(p)||state.guideActionBusy)return;
  const target=xhsAccountRecord(delivery.accountId||guideTargetAccountId());if(!xhsRecordBound(target))return notify('请先在账号管理中绑定本次目标账号。',true);
  const version=guideCreationVersion,id=p.id,accountId=target.accountId;state.guideActionBusy='xhs-delivery';renderGuidance({preserve:true});
  try{const result=await api(`/api/projects/${encodeURIComponent(id)}/xhs-delivery`,{method:'POST',body:{accountId}});if(version!==guideCreationVersion||state.guide.creation?.projectId!==id)return;if(result.project)setGuideProject(result.project);else await loadGuideProject({quiet:true});}
  catch(error){if(version===guideCreationVersion){state.guide.creation.error=error.message;saveGuidance();notify(error.message,true);if(error.status===409)await loadXhs({quiet:true});}}
  finally{if(version===guideCreationVersion){state.guideActionBusy='';renderGuidance({preserve:true});beginGuidePolling();}}
}
async function saveGuideXhsVersion() {
  const p=state.guideProject,delivery=p?.xhsDelivery;
  if(!p||!guideEditedAfterDelivery(p)||delivery.canSaveVersion===false||delivery.pendingVersion||!xhsEligible(p)||guideWorkActive()||xhsWorking())return;
  const target=xhsAccountRecord(delivery.accountId);if(!xhsRecordBound(target))return notify('原草稿目标账号尚未绑定，请在账号管理中重新绑定。',true);
  const version=guideCreationVersion,id=p.id,accountId=delivery.accountId;state.guideActionBusy='xhs-version';renderGuidance({preserve:true});
  try{
    const result=await api(`/api/projects/${encodeURIComponent(id)}/xhs-delivery`,{method:'POST',body:{accountId,newVersion:true}});
    if(version!==guideCreationVersion||state.guide.creation?.projectId!==id)return;
    if(result.project)setGuideProject(result.project);else await loadGuideProject({quiet:true});
    notify('正在准备当前版本的电脑草稿，此前草稿保留。');
  }catch(error){if(version===guideCreationVersion){notify(error.message,true);if(error.status===409){await loadXhs({quiet:true});await loadGuideProject({quiet:true});}}}
  finally{if(version===guideCreationVersion){state.guideActionBusy='';renderGuidance({preserve:true});beginGuidePolling();}}
}
async function saveGuideFirstXhsDraft(shownAccountId) {
  const p=state.guideProject;
  if(!p||p.xhsDelivery?.enabled||!xhsEligible(p)||guideWorkActive()||xhsWorking())return;
  state.guidePublishPrompt=true;
  if(!xhsRecordBound(xhsAccountRecord(guideTargetAccountId()))){
    renderGuidance({preserve:true});
    document.querySelector('#guide-xhs-region')?.scrollIntoView({behavior:'smooth',block:'nearest'});
    return notify('图文已经保存在本平台。首次送稿请在上方扫码并确认绑定账号。');
  }
  if(!shownAccountId||shownAccountId!==guideTargetAccountId()){renderGuidance({preserve:true});return notify('小红书账号已变化，请核对当前显示的目标账号后再送稿。',true);}
  const version=guideCreationVersion,id=p.id,accountId=shownAccountId;state.guideActionBusy='xhs-first';renderGuidance({preserve:true});
  try{
    const result=await api(`/api/projects/${encodeURIComponent(id)}/xhs-delivery`,{method:'POST',body:{accountId,newVersion:true}});
    if(version!==guideCreationVersion||state.guide.creation?.projectId!==id)return;
    if(result.project)setGuideProject(result.project);else await loadGuideProject({quiet:true});
    notify('正在将当前图文送入电脑草稿，结果会在本对话中显示。');
  }catch(error){if(version===guideCreationVersion){notify(error.message,true);if(error.status===409){await loadXhs({quiet:true});await loadGuideProject({quiet:true});}}}
  finally{if(version===guideCreationVersion){state.guideActionBusy='';renderGuidance({preserve:true});beginGuidePolling();}}
}
function guideWorkActive() {const c=state.guide.creation;return Boolean(state.guideUploadBusy||state.guideActionBusy||guideProjectActive(state.guideProject)||(!state.guideProject&&c&&!c.error&&['analyzing','generating'].includes(c.status)));}
function guideCreationStatus(project) {
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
function guideCreationView() {
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
  return `<section class="guide-creation" aria-label="创作结果" aria-busy="${active}"><div class="guide-creation-header"><div><span class="eyebrow">图文作品</span><h3>${h(p.title||'这次的图文作品')}</h3></div><span class="guide-creation-status ${issue?'is-warning':''}">${active?'<span class="spinner spinner-small"></span>':icon(issue?'alert':'check')}${h(status)}</span></div>${guideDeliveryView(p)}${progress}${p.error||c.error?`<div class="guide-creation-error" role="alert">${h(c.error||p.error)}</div>`:''}${pages.length?`<div class="guide-creation-grid" data-count="${pages.length}">${pages.map((page,index)=>`<article class="guide-created-page"><div class="guide-created-image" data-aspect="${h(p.aspect)}">${page.imageUrl?`<button data-action="guide-result-preview" data-id="${h(page.id)}" aria-label="查看第 ${index+1} 张完整图片"><img src="${h(page.imageUrl)}" alt="${h(page.title||'第 '+(index+1)+' 张图文')}" loading="lazy"><span>${icon('expand')}查看大图</span></button>`:`<div class="guide-created-placeholder">${page.status==='generating'?'<span class="spinner"></span>':icon('image')}<strong>第 ${index+1} 张</strong><span>${page.status==='error'?'这张图片暂未完成':page.status==='generating'?'正在绘制…':'等待生成'}</span></div>`}</div><div class="guide-created-page-footer"><span>${String(index+1).padStart(2,'0')} · ${h(page.title)}</span>${page.imageUrl?`<a href="${h(page.imageUrl)}" download="${h(p.id)}-${index+1}.${h(page.imageUrl.split('.').pop())}" aria-label="下载第 ${index+1} 张图片">${icon('download')}</a>`:''}</div>${page.error?`<p class="guide-created-error">${h(page.error)}</p>`:''}</article>`).join('')}</div>`:''}${p.caption||p.title?`<section class="guide-creation-copy" aria-label="帖子正文"><div class="guide-post-caption"><h4 class="sr-label">帖子正文</h4><p>${h(p.caption||'')}</p></div><div class="guide-post-actions guide-creation-actions"><button class="button button-secondary" data-action="guide-copy-result">${icon('copy')}复制文案</button>${downloads}${xhsEligible(p)&&p.xhsDelivery?.enabled?`<button class="button button-secondary" data-action="guide-xhs-action" data-kind="open-drafts" ${!xhsRecordConnected(xhsAccountRecord(p.xhsDelivery.accountId))||xhsAccountRecord(p.xhsDelivery.accountId)?.busy||Boolean(state.xhsAccountBusy)||guideDeliveryActive(p)?'disabled':''}>${icon('arrow')}打开电脑草稿</button>`:''}</div></section>`:downloads?`<div class="guide-creation-actions">${downloads}</div>`:''}${retryActions?`<div class="guide-creation-actions guide-retry-actions">${retryActions}</div>`:''}${canRetry?`<p class="guide-creation-note">${pages.length?'重试只处理未完成的图片，可能产生模型费用。':'重试会重新策划并生成图片，可能产生模型费用。'}</p>`:''}${chat.length||pending?`<div class="guide-project-chat" aria-label="作品修改对话">${chat.map(message=>`<article class="guide-project-message ${message.role==='user'?'user':'assistant'}"><span>${message.role==='user'?'你':'创意编辑'}</span>${guideImageMessageView(message.images||message.referenceImages)}<p>${h(message.content||'')}</p></article>`).join('')}${pending?`<article class="guide-project-message user pending"><span>你 · 请求待确认</span>${guideImageMessageView(last.images)}<p>${h(last.message)}</p></article>`:''}</div>`:''}</section>`;
}

function setGuideProject(project) {
  const c=state.guide.creation;if(!c||!project?.id||(c.projectId&&project.id!==c.projectId))return;
  c.projectId=project.id;c.status=project.status;c.error='';state.guideProject=project;
  state.guide.preferences=guidePreferences(project);
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
  if(g.xhsAutoDelivery&&!xhsRecordBound(xhsAccountRecord(guideTargetAccountId()))){g.creationError='请先选择一个已绑定的小红书账号，再开始自动送稿创作。';saveGuidance();renderGuidance();return;}
  const c=g.creation||{requestId:crypto.randomUUID(),projectId:null,status:'submitting',error:'',requestedAt:new Date().toISOString(),capture:{xhsAutoDelivery:g.xhsAutoDelivery===true,...(g.xhsAutoDelivery?{xhsAccountId:guideTargetAccountId()||null}:{})}};
  if(command&&!retryRequest){g.messages.push({role:'user',content:command});g.messages=trimGuideMessages(g.messages);g.input='';}
  g.creation=c;g.creationError='';c.error='';state.guideActionBusy='create';const version=++guideCreationVersion;saveGuidance();renderGuidance({focusCreation:true});
  try{const {project}=await api('/api/brief/create',{method:'POST',body:{requestId:c.requestId,source,style:g.preferences.style,aspect:g.preferences.aspect,count:g.preferences.count,mode:g.preferences.mode||'cards',referenceIds:g.referenceImages.map(image=>image.id),xhsAutoDelivery:c.capture?.xhsAutoDelivery===true,...(c.capture?.xhsAutoDelivery===true?{xhsAccountId:c.capture.xhsAccountId}: {})}});if(version!==guideCreationVersion||state.guide!==g)return;setGuideProject(project);}
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
  ++guideRequestVersion;++guideCreationVersion;++guideProjectPollVersion;clearTimeout(guideProjectPollTimer);state.guide=blankGuidance();state.guideProject=null;state.guideEdit=null;state.guideActionBusy='';state.guidePublishPrompt=false;resetGuideStyleFilters();state.view='briefing';saveGuidance();renderGuidance();loadXhs({quiet:true});return true;
}
async function resumeProjectInGuide(id) {
  if(state.guide.creation?.projectId===id){state.view='briefing';renderGuidance({preserve:true});await loadGuideProject({quiet:true});return;}
  if(state.guideBusy||guideWorkActive())return notify('先等待当前创作任务完成，再继续另一份作品。');
  const existing=state.guide;if((existing.messages.length||existing.input.trim()||existing.draftImages.length||existing.creation)&&!confirm('在对话中继续这份作品？当前对话及未发送的文字和图片会替换，作品记录会保留。'))return;
  const {project}=await api(`/api/projects/${encodeURIComponent(id)}`);
  ++guideCreationVersion;++guideRequestVersion;++guideProjectPollVersion;clearTimeout(guideProjectPollTimer);
  const g=blankGuidance();g.source=project.source||'';g.analysis='已载入作品，直接告诉我想改哪里即可。';g.preferences=guidePreferences(project);g.recommendations={...g.recommendations,...g.preferences};g.creation={projectId:project.id,requestId:isGuideUuid(project.creationRequestId)?project.creationRequestId:crypto.randomUUID(),status:project.status,error:'',requestedAt:project.createdAt};
  state.guide=g;state.guideProject=null;state.guideEdit=null;state.guidePublishPrompt=false;state.view='briefing';setGuideProject(project);renderGuidance({focusCreation:true});beginGuidePolling();await loadXhs({quiet:true});
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
function guideQuestionView(field) {
  const g=state.guide, rec=g.recommendations[field];
  const index=['style','aspect','count'].indexOf(field)+1;
  let options;
  if(field==='style')options=guideStylePickerView();
  else if(field==='aspect')options=`<div class="guide-choices guide-aspect-choices">${[['3:4','portrait','竖版图文'],['1:1','square','方形卡片'],['16:9','landscape','横版展示']].map(([value,shape,label])=>`<button class="guide-choice ${value===rec?'recommended':''}" data-action="guide-choice" data-field="aspect" data-value="${value}"><span class="guide-ratio-icon ratio-${shape}" aria-hidden="true"></span><strong>${value}</strong><small>${label}</small>${value===rec?'<span class="choice-recommended">建议</span>':''}</button>`).join('')}</div>`;
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
  const previousChat=thread?.querySelector('.guide-project-chat')?.textContent||'';
  const inputFocused=focused?.id==='guide-input',selection=inputFocused?[focused.selectionStart,focused.selectionEnd]:null;
  const pageScroll=window.scrollY;
  render();
  if(inputFocused){const input=document.querySelector('#guide-input');if(input&&!input.disabled){input.focus({preventScroll:true});if(selection)input.setSelectionRange(...selection);}}
  requestAnimationFrame(()=>{
    const next=document.querySelector('.guide-thread');if(!next)return;
    const nextChat=next.querySelector('.guide-project-chat')?.textContent||'';
    const hasNewChat=Boolean(nextChat.trim())&&nextChat!==previousChat;
    if(preserve&&(inputFocused||!nearBottom||(state.guide.creation&&!hasNewChat)))next.scrollTop=previousScroll;
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
    const result=await api('/api/brief/chat',{method:'POST',body:{messages,preferences,matchTrends:g.matchTrends,clarificationAsked:g.clarificationAsked,referenceIds:g.referenceImages.map(image=>image.id)}});
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
  xhs:{title:'小红书账号',group:'账号与内容',description:'管理账号数据、已发布笔记和电脑草稿。',icon:'grid'},
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
async function navigateAdminPage(view) {
  if(!Object.hasOwn(ADMIN_PAGES,view))return;
  if(state.adminMenuOpen)toggleAdminMenu(false);
  if(view==='xhs'&&state.view!=='xhs')state.xhsSection='overview';
  state.view=view;const url=new URL(location.href);
  if(view==='briefing')url.searchParams.delete('view');else url.searchParams.set('view',view);
  window.history.replaceState({},'',url);render();
  if(view==='history')await refreshHistory();
  if(view==='trends')await loadTrends();
  if(view==='radar')await loadRadar();
  if(view==='dingtalk')await loadDingtalk({quiet:Boolean(state.dingtalk)});
  if(view==='xhs')await loadXhs({refreshProjects:true});
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
  if(first||embeddedParentNavigationDepth===0)postEmbeddedMessage({type:first?'content-studio:ready':'content-studio:navigate',view:state.view});
}
// Suppress only the synchronous render caused by a parent route request.
// User navigation during the subsequent GET remains observable by the shell.
function navigateFromEmbeddedParent(view) {
  embeddedParentNavigationDepth++;
  try{return navigateAdminPage(view);}finally{embeddedParentNavigationDepth--;}
}
function embeddedRequestId(value) {
  if(typeof value==='string')return {requestId:value.slice(0,120)};
  return Number.isSafeInteger(value)&&value>=0?{requestId:value}:{};
}
async function refreshEmbeddedView(view) {
  if(view!==state.view)return;
  if(view==='xhs')return loadXhs({quiet:true,refreshProjects:true});
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
    if(data.type==='content-studio:refresh-view')await refreshEmbeddedView(data.view);
    else if(state.view!==data.view)await navigateFromEmbeddedParent(data.view);
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
const XHS_CONNECTION_LABELS = {disconnected:'尚未连接',connecting:'正在打开登录',connected:'账号已连接',login_required:'等待本人登录',needs_attention:'需要本人处理',browser_unavailable:'浏览器暂不可用'};
const xhsConnected = () => state.xhs?.connection?.state==='connected'&&Boolean(state.xhs?.account?.id);
// Binding remembers the approved account; only connected confirms this session.
const xhsBound = () => /^[A-Za-z0-9_-]{1,120}$/.test(String(state.xhs?.account?.id||''))&&['connected','needs_attention','login_required','browser_unavailable','disconnected'].includes(state.xhs?.connection?.state);
const xhsServerWorking = () => Boolean(state.xhs?.status?.busy||state.xhs?.sync?.running||state.xhs?.officialDraftSync?.running||state.xhs?.contentStatus?.running);
const xhsWorking = () => Boolean(state.xhsBusy||state.xhsAccountBusy||xhsServerWorking());
const xhsDate = value => value&&Number.isFinite(new Date(value).getTime())?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'尚未同步';
const xhsValue = value => typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('zh-CN'):'未获取';
const xhsEligible = project => project?.status==='completed'&&!isActive(project)&&Array.isArray(project.pages)&&project.pages.length>0&&project.pages.every(page=>page.status==='done'&&typeof page.imageUrl==='string'&&page.imageUrl.startsWith('/media/'));
const xhsHref = value => {try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(u.hostname==='xiaohongshu.com'||u.hostname.endsWith('.xiaohongshu.com'))?u.href:'';}catch{return '';}};
const xhsAccountId = () => String(state.xhs?.account?.id||'');
const xhsProfileId = () => String(state.xhs?.selectedProfileId||'');
const xhsAccounts = () => Array.isArray(state.xhs?.accounts)?state.xhs.accounts:[];
function xhsAccountRecord(accountId) {
  if(!accountId)return null;
  const record=xhsAccounts().find(record=>record.accountId===accountId);
  if(record)return record;
  return accountId===xhsAccountId()?{profileId:xhsProfileId(),accountId,nickname:state.xhs?.account?.nickname,connectionState:state.xhs?.connection?.state,busy:xhsServerWorking()}:null;
}
const xhsRecordBound = record => Boolean(record?.accountId&&!record.duplicateOf);
const xhsRecordConnected = record => xhsRecordBound(record)&&record.connectionState==='connected';
const xhsRecordName = record => record?.accountName||record?.nickname||'尚未登录的账号';
const guideTargetAccountId = () => String(state.guideProject?.xhsDelivery?.accountId||state.guide.creation?.capture?.xhsAccountId||(typeof state.guide.xhsTargetAccountId==='string'?state.guide.xhsTargetAccountId:xhsAccountId())||'');
const xhsDisplayName = record => record?.nickname||record?.accountName||'待登录账号';
function xhsAvatarUrl(record) {
  if(!record?.accountId||record.duplicateOf)return '';
  const selected=record.profileId===xhsProfileId()&&record.accountId===xhsAccountId();
  const value=record.avatarUrl||(selected?state.xhs?.account?.avatar:'');
  if(typeof value!=='string'||!value||value.length>8192)return '';
  try {
    const url=new URL(value,location.origin);
    if(url.origin===location.origin)return url.pathname.startsWith(`/media/xhs/${record.accountId}/`)&&!url.search&&!url.hash?url.pathname:'';
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&['xhscdn.com','xiaohongshu.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host))?url.href:'';
  } catch {return '';}
}
function xhsAvatarView(record,name=xhsDisplayName(record)) {
  const source=xhsAvatarUrl(record);
  return `<span class="xhs-table-avatar xhs-account-avatar-frame" aria-hidden="true"><span class="xhs-avatar-initial">${h(Array.from(name)[0]||'账')}</span>${source?`<img class="xhs-avatar-image" data-xhs-avatar src="${h(source)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:''}</span>`;
}
function replaceXhsRegion(selector,html) {
  const target=document.querySelector(selector);
  if(target&&target._xhsHtml!==html){target.innerHTML=html;target._xhsHtml=html;}
}
function rememberXhsLocation() {
  if(!['overview','detail'].includes(state.xhsSection))return;
  if(xhsProfileId())state.xhsLocation.tabs[xhsProfileId()]=state.xhsTab;
  try{localStorage.setItem(XHS_LOCATION_KEY,JSON.stringify({tabs:Object.fromEntries(Object.entries(state.xhsLocation.tabs).slice(-50))}));}catch{}
}
function xhsRecordStatus(record) {
  return record.busy?'正在处理':record.duplicateOf?'重复绑定，需处理':!record.accountId?'待扫码登录':record.connectionState==='connected'?'已连接':'需检查登录';
}
function xhsRecordSummary(record,key) {
  if(record.duplicateOf)return null;
  const value=record.summary?.[key]??(record.profileId===xhsProfileId()&&record.accountId===xhsAccountId()?state.xhs?.account?.[key]:null);
  return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
}
function xhsAccountsResultsView() {
  const accounts=xhsAccounts(),search=state.xhsAccountSearch.trim().toLocaleLowerCase();
  const shown=accounts.filter(record=>(state.xhsAccountGroup==='all'||(record.group||'默认分组')===state.xhsAccountGroup)&&(!search||[record.nickname,record.accountName,record.group].some(value=>String(value||'').toLocaleLowerCase().includes(search)))&&(state.xhsAccountStatus==='all'||(state.xhsAccountStatus==='connected'?xhsRecordConnected(record):!xhsRecordConnected(record))));
  if(!accounts.length)return `<div class="xhs-overview-empty">${icon('cards')}<h3>添加第一个小红书账号</h3><p>扫码登录后，在这里查看账号数据、已发布笔记和电脑草稿。</p><button class="button button-primary" type="button" data-action="xhs-account-add">${icon('plus')}添加账号</button><small>在小红书官方窗口登录，无需填写密码或 Cookie。</small></div>`;
  if(!shown.length)return `<div class="xhs-overview-empty">${icon('search')}<h3>没有匹配的账号</h3><p>试试其他昵称、备注或分组。</p><button class="button button-secondary" type="button" data-action="xhs-clear-filters">清空筛选</button></div>`;
  return `<p class="xhs-table-scroll-hint">左右滑动，查看完整数据与操作</p><div class="xhs-accounts-table-wrap"><table class="xhs-accounts-table"><caption class="sr-label">小红书账号表现与连接状态</caption><thead><tr><th scope="col">账号</th><th scope="col">分组</th><th scope="col">连接状态</th><th scope="col">粉丝</th><th scope="col">获赞与收藏</th><th scope="col">笔记</th><th scope="col">数据更新时间</th><th scope="col">操作</th></tr></thead><tbody>${shown.map(record=>`<tr><td><button class="xhs-table-identity" type="button" data-action="xhs-account-select" data-profile-id="${h(record.profileId)}" aria-label="查看账号：${h(xhsDisplayName(record))}" ${state.xhsAccountBusy?'disabled':''}>${xhsAvatarView(record)}<span><strong>${h(xhsDisplayName(record))}</strong><small>${h(record.accountName&&record.accountName!==xhsDisplayName(record)?record.accountName:record.accountId?'小红书号已绑定':'等待扫码绑定')}</small></span></button></td><td>${h(record.group||'默认分组')}</td><td><span class="xhs-table-status ${xhsRecordConnected(record)?'is-connected':'is-attention'}"><i></i>${h(xhsRecordStatus(record))}</span></td>${['followers','likes','notesCount'].map(key=>`<td class="xhs-numeric">${h(xhsValue(xhsRecordSummary(record,key)))}</td>`).join('')}<td class="xhs-table-time">${h(xhsDate(record.lastSyncAt))}</td><td><div class="xhs-row-actions"><button class="text-button" type="button" data-action="xhs-account-select" data-profile-id="${h(record.profileId)}" ${state.xhsAccountBusy?'disabled':''}>查看详情</button><button class="text-button" type="button" data-action="xhs-account-select" data-profile-id="${h(record.profileId)}" data-tab="drafts" ${state.xhsAccountBusy?'disabled':''}>草稿箱</button></div></td></tr>`).join('')}</tbody></table></div><p class="xhs-list-footnote">${shown.length===accounts.length?'共 '+accounts.length+' 个账号':'显示 '+shown.length+' / '+accounts.length+' 个账号'} · 数据来自各账号最近一次同步，未获取的指标保留标记。</p>`;
}
function xhsAccountsView() {
  const accounts=xhsAccounts(),groups=[...new Set(accounts.map(record=>record.group||'默认分组'))];
  return `<div class="xhs-overview"><section class="panel xhs-overview-surface"><div class="xhs-overview-heading"><div><h2>账号列表 <small>${accounts.length}</small></h2><p>查看各账号表现，进入账号管理笔记与草稿。</p></div>${accounts.length?`<button class="button button-primary" type="button" data-action="xhs-account-add" ${state.xhsAccountBusy?'disabled':''}>${icon('plus')}添加账号</button>`:''}</div>${accounts.length?`<div class="xhs-overview-toolbar"><label class="xhs-filter-search" for="xhs-account-search">${icon('search')}<span class="sr-label">搜索账号</span><input id="xhs-account-search" type="search" placeholder="搜索昵称、备注或分组" value="${h(state.xhsAccountSearch)}"></label><label class="sr-label" for="xhs-account-group-filter">账号分组</label><select id="xhs-account-group-filter"><option value="all">全部分组</option>${groups.map(group=>`<option value="${h(group)}" ${state.xhsAccountGroup===group?'selected':''}>${h(group)}</option>`).join('')}</select><label class="sr-label" for="xhs-account-status-filter">连接状态</label><select id="xhs-account-status-filter"><option value="all">全部状态</option><option value="connected" ${state.xhsAccountStatus==='connected'?'selected':''}>已连接</option><option value="attention" ${state.xhsAccountStatus==='attention'?'selected':''}>需处理</option></select><button type="button" class="button button-secondary" data-action="xhs-reload" ${state.xhsLoading||state.xhsAccountBusy?'disabled':''}>${icon('refresh')}刷新列表</button></div>`:''}<div id="xhs-overview-results">${xhsAccountsResultsView()}</div></section></div>`;
}
function openXhsAccountEditor(profileId='') {
  if(state.xhsAccountBusy)return;
  const record=xhsAccounts().find(record=>record.profileId===profileId);
  state.xhsAccountEditor={profileId:record?.profileId||'',accountName:record?.accountName||'',group:record?.group||'',error:'',pending:false};
  renderXhsAccountEditor();document.querySelector('#xhs-account-dialog')?.showModal();document.querySelector('#xhs-account-name')?.focus();
}
function closeXhsAccountEditor() {
  if(state.xhsAccountEditor?.pending)return;
  state.xhsAccountEditor=null;document.querySelector('#xhs-account-dialog')?.close();
}
function renderXhsAccountEditor() {
  const draft=state.xhsAccountEditor,region=document.querySelector('#xhs-account-editor-region');if(!draft||!region)return;
  region.innerHTML=`<form id="xhs-account-form"><div class="xhs-account-editor-heading"><div><span class="eyebrow">YOUR ACCOUNT DETAILS</span><h2 id="xhs-account-editor-title">${draft.profileId?'编辑账号备注':'添加小红书账号'}</h2></div><button class="icon-button" type="button" data-action="xhs-account-editor-close" aria-label="关闭账号设置" ${draft.pending?'disabled':''}>${icon('close')}</button></div><label class="field-label" for="xhs-account-name">账号备注 <small>选填</small></label><input id="xhs-account-name" maxlength="80" value="${h(draft.accountName)}" placeholder="例如：产品主号、工具分享号" autocomplete="off" ${draft.pending?'disabled':''}><label class="field-label" for="xhs-account-group">账号分组 <small>选填</small></label><input id="xhs-account-group" maxlength="80" value="${h(draft.group)}" placeholder="例如：工具作品" autocomplete="off" ${draft.pending?'disabled':''}><p class="field-help">${draft.profileId?'修改备注和分组会保留当前登录与草稿。':'添加后，点击账号页的「扫码登录」完成绑定，无需填写密码、手机号或 Cookie。'}</p>${draft.error?`<p class="xhs-account-editor-error" role="alert">${h(draft.error)}</p>`:''}<div class="xhs-account-editor-actions"><button class="button button-secondary" type="button" data-action="xhs-account-editor-close" ${draft.pending?'disabled':''}>取消</button><button class="button button-primary" type="submit" ${draft.pending?'disabled':''}>${draft.pending?'<span class="spinner spinner-small"></span>':icon(draft.profileId?'check':'plus')}${draft.profileId?'保存备注':'添加账号'}</button></div></form>`;
}
async function saveXhsAccountEditor() {
  const draft=state.xhsAccountEditor;if(!draft||draft.pending||state.xhsAccountBusy)return;
  const body={accountName:draft.accountName.trim(),group:draft.group.trim()},version=++xhsLoadVersion;
  draft.pending=true;state.xhsAccountBusy='save';renderXhsAccountEditor();
  try{
    const snapshot=await api('/api/xhs/accounts'+(draft.profileId?'/'+encodeURIComponent(draft.profileId):''),{method:draft.profileId?'PATCH':'POST',body});
    if(version===xhsLoadVersion){acceptXhs(snapshot);if(!draft.profileId){state.xhsSection='detail';rememberXhsLocation();}}
    draft.pending=false;if(state.xhsAccountEditor===draft)closeXhsAccountEditor();
    notify(draft.profileId?'账号备注已保存。':'账号已添加，点击「扫码登录」完成绑定。');
  }catch(error){if(state.xhsAccountEditor===draft){draft.error=error.message;draft.pending=false;renderXhsAccountEditor();}else notify(error.message,true);}
  finally{state.xhsAccountBusy='';updateXhs();scheduleXhsPoll();}
}
async function selectXhsAccount(profileId,{tab}={}) {
  if(!profileId||state.xhsAccountBusy||!xhsAccounts().some(record=>record.profileId===profileId))return;
  if(profileId===xhsProfileId()){
    state.xhsSection='detail';if(['analytics','published','drafts'].includes(tab))state.xhsTab=tab;
    rememberXhsLocation();updateXhs();return;
  }
  const version=++xhsLoadVersion;++xhsDraftRequestVersion;clearTimeout(xhsPollTimer);closeXhsDetail({restoreFocus:false});
  state.xhsAccountBusy='select';state.xhsError='';updateXhs();
  try{const snapshot=await api(`/api/xhs/accounts/${encodeURIComponent(profileId)}/select`,{method:'POST',body:{}});if(version===xhsLoadVersion){acceptXhs(snapshot);state.xhsSection='detail';if(['analytics','published','drafts'].includes(tab))state.xhsTab=tab;rememberXhsLocation();}}
  catch(error){if(version===xhsLoadVersion){state.xhsError=error.message;notify(error.message,true);}}
  finally{state.xhsAccountBusy='';state.xhsBusy='';updateXhs();scheduleXhsPoll();}
}
async function removeXhsAccount(profileId) {
  const record=xhsAccounts().find(record=>record.profileId===profileId);if(!record||state.xhsAccountBusy||record.busy)return;
  if(!confirm(`从平台移除「${xhsRecordName(record)}」？\n这会关闭该账号的专用浏览器。浏览器中的原草稿、已有作品和本机存储会保留，不会退出或删除小红书账号。\n如果官网还有未保存的编辑，请先取消并保存。`))return;
  const version=++xhsLoadVersion;state.xhsAccountBusy='remove';updateXhs();
  try{const snapshot=await api(`/api/xhs/accounts/${encodeURIComponent(profileId)}`,{method:'DELETE'});if(version===xhsLoadVersion)acceptXhs(snapshot);notify('已从平台移除账号，原稿和本机存储已保留。');}
  catch(error){if(version===xhsLoadVersion){state.xhsError=error.message;notify(error.message,true);}}
  finally{state.xhsAccountBusy='';updateXhs();scheduleXhsPoll();}
}

function xhsCanRecheck(draft) {
  return Boolean(draft&&draft.canRecheck!==false&&(draft.canRecheck===true||['filled','unknown'].includes(draft.status))&&!draft.rechecking&&!['queued','running'].includes(draft.status));
}
function xhsTabsView() {
  const notes=(state.xhs.notes||[]).filter(note=>!note.accountId||note.accountId===xhsAccountId()).length;
  const drafts=(state.xhs.officialDrafts||[]).filter(draft=>!draft.accountId||draft.accountId===xhsAccountId()).length;
  return [['analytics','数据概览',null],['published','已发布',notes],['drafts','电脑草稿',drafts]].map(([id,label,count])=>`<button type="button" id="xhs-tab-${id}" role="tab" aria-selected="${state.xhsTab===id}" aria-controls="xhs-panel-${id}" tabindex="${state.xhsTab===id?0:-1}" data-action="xhs-tab" data-tab="${id}">${label}${count!==null?`<span class="xhs-tab-count">${count}</span>`:''}</button>`).join('');
}
function xhsDraftSourceView() {
  return [['official','官方电脑草稿'],['submissions','平台送稿记录']].map(([source,label])=>`<button class="${state.xhsDraftSource===source?'is-active':''}" type="button" data-action="xhs-draft-source" data-source="${source}" aria-pressed="${state.xhsDraftSource===source}">${label}</button>`).join('');
}
function xhsDraftRefreshView() {
  return state.xhsDraftSource==='official'?`<button class="button button-secondary" type="button" data-action="xhs-action" data-kind="open-drafts" ${xhsWorking()||!xhsConnected()?'disabled':''}>打开小红书草稿 ${icon('arrow')}</button><button class="button button-primary" type="button" data-action="xhs-official-sync" ${xhsWorking()||!xhsConnected()?'disabled':''}>${icon('refresh')}刷新草稿</button>`:`<button class="button button-secondary" type="button" data-action="xhs-reload" ${state.xhsAccountBusy?'disabled':''}>${icon('refresh')}刷新记录</button>`;
}
function xhsDetailWorkspaceView() {
  const busy=xhsWorking()||!xhsConnected();
  return `<div class="xhs-account-detail">
    <div id="xhs-account-region">${xhsAccountView()}</div>
    <div class="xhs-tabs" role="tablist" aria-label="账号工作台页签">${xhsTabsView()}</div>
    <section id="xhs-panel-analytics" role="tabpanel" aria-labelledby="xhs-tab-analytics" ${state.xhsTab==='analytics'?'':'hidden'}>
      <section class="panel xhs-metrics-panel"><div class="xhs-section-heading"><div><h2>账号表现</h2><span id="xhs-sync-time">数据更新 ${h(xhsDate(state.xhs.sync?.lastSyncAt))}</span></div><button class="button button-primary" type="button" data-action="xhs-action" data-kind="sync" ${busy?'disabled':''}>${icon('refresh')}刷新数据</button></div><div id="xhs-metrics-region">${xhsMetricsView()}</div></section>
    </section>
    <section id="xhs-panel-published" role="tabpanel" aria-labelledby="xhs-tab-published" ${state.xhsTab==='published'?'':'hidden'}>
      <section class="panel xhs-notes-panel"><div class="xhs-section-heading"><div><h2>已发布笔记</h2><span id="xhs-notes-count">${(state.xhs.notes||[]).filter(note=>!note.accountId||note.accountId===xhsAccountId()).length} 篇已读取</span></div></div>
        <div class="xhs-note-toolbar"><label class="xhs-note-search" for="xhs-note-search">${icon('search')}<span class="sr-label">搜索已发布笔记标题</span><input id="xhs-note-search" type="search" placeholder="搜索笔记标题" value="${h(state.xhsNoteSearch)}"></label><label for="xhs-note-sort" class="sr-label">笔记排序</label><select id="xhs-note-sort">${[['recent','发布时间 · 最新'],['views','阅读 · 最多'],['likes','点赞 · 最多'],['collects','收藏 · 最多'],['comments','评论 · 最多']].map(([value,label])=>`<option value="${value}" ${state.xhsNoteSort===value?'selected':''}>${label}</option>`).join('')}</select><label for="xhs-note-limit" class="sr-label">列表同步数量</label><select id="xhs-note-limit">${[50,100,150,200].map(n=>`<option value="${n}" ${state.xhsNoteLimit===n?'selected':''}>最近 ${n} 篇</option>`).join('')}</select><button class="button button-primary" type="button" data-action="xhs-action" data-kind="sync" ${busy?'disabled':''}>${icon('refresh')}刷新列表</button></div>
        <div id="xhs-notes-region">${xhsNotesView()}</div><p id="xhs-notes-coverage" class="xhs-data-note">${h(xhsNotesCoverage())}</p>
      </section>
    </section>
    <section id="xhs-panel-drafts" role="tabpanel" aria-labelledby="xhs-tab-drafts" ${state.xhsTab==='drafts'?'':'hidden'}>
      <section class="panel xhs-official-panel"><div class="xhs-section-heading"><div><h2>电脑草稿</h2></div><div id="xhs-draft-refresh" class="xhs-row-actions">${xhsDraftRefreshView()}</div></div>
        <div class="xhs-draft-toolbar"><div class="xhs-draft-source" role="group" aria-label="草稿来源">${xhsDraftSourceView()}</div><label class="xhs-filter-search" for="xhs-draft-search">${icon('search')}<span class="sr-label">搜索草稿标题</span><input id="xhs-draft-search" type="search" placeholder="搜索草稿标题" value="${h(state.xhsDraftSearch)}"></label><label for="xhs-draft-sort" class="sr-label">草稿排序</label><select id="xhs-draft-sort"><option value="recent" ${state.xhsDraftSort==='recent'?'selected':''}>保存时间 · 最新</option><option value="oldest" ${state.xhsDraftSort==='oldest'?'selected':''}>保存时间 · 最早</option><option value="title" ${state.xhsDraftSort==='title'?'selected':''}>标题排序</option></select></div>
        <div id="xhs-official-drafts-region" ${state.xhsDraftSource==='official'?'':'hidden'}>${xhsOfficialDraftsView()}</div>
        <div id="xhs-submissions-region" ${state.xhsDraftSource==='submissions'?'':'hidden'}><p class="xhs-data-note">这里记录平台送出的版本及核验结果，小红书后续修改不会回写此记录。</p><div id="xhs-drafts-region" aria-live="polite">${xhsDraftsView()}</div></div>
      </section>
      <details id="xhs-composer-disclosure" class="xhs-composer-disclosure" ${state.xhsComposerOpen?'open':''}><summary>${icon('plus')}从作品送入草稿</summary><div id="xhs-composer-region">${xhsComposerView()}</div></details>
    </section>
    <p class="xhs-page-note">${icon('lock')}数据按账号分别保存。电脑草稿不包含手机本地草稿。</p>
  </div>`;
}
function xhsManagementView() {
  return state.xhsSection==='overview'||!xhsAccounts().length&&!state.xhs.account?xhsAccountsView():xhsDetailWorkspaceView();
}
function xhsView() {
  if(!state.xhs)return `<section id="xhs-page" class="xhs-page xhs-management"><div class="panel xhs-loading" role="status">${state.xhsLoading?'<span class="spinner"></span>':''}<h2>${state.xhsError?'暂时没有连接上账号工作台':'正在准备小红书工作台'}</h2><p>${h(state.xhsError||'读取账号连接与草稿记录…')}</p>${state.xhsError?'<button class="button button-secondary" data-action="xhs-reload">重新连接</button>':''}</div></section>`;
  return `<section id="xhs-page" class="xhs-page xhs-management" aria-label="小红书账号工作台"><div id="xhs-status-region" aria-live="polite">${xhsStatusView()}</div><div id="xhs-management-region" data-section="${h(state.xhsSection)}" data-profile-id="${h(xhsProfileId())}">${xhsManagementView()}</div><dialog id="xhs-account-dialog" class="xhs-account-dialog" aria-modal="true" aria-labelledby="xhs-account-editor-title"><div id="xhs-account-editor-region"></div></dialog><dialog id="xhs-detail-dialog" class="xhs-detail-dialog" aria-modal="true" aria-labelledby="xhs-detail-title"><div id="xhs-detail-region"></div></dialog></section>`;
}
function switchXhsTab(tab,{focus=false}={}) {
  if(!['analytics','published','drafts'].includes(tab))return;
  state.xhsTab=tab;rememberXhsLocation();
  document.querySelectorAll('.xhs-tabs [role="tab"]').forEach(el=>{const selected=el.dataset.tab===tab;el.setAttribute('aria-selected',String(selected));el.tabIndex=selected?0:-1;if(selected&&focus)el.focus();});
  for(const id of ['analytics','published','drafts']){const panel=document.querySelector('#xhs-panel-'+id);if(panel)panel.hidden=id!==tab;}
  updateXhsComposerState();
}
function xhsNotesCoverage() {
  const coverage=state.xhs?.sync?.coverage;
  return [typeof coverage==='string'?coverage:coverage?.message,coverage?.hasMore?'仍有更多笔记，可提高读取数量后再次同步。':'',`本次同步上限 ${state.xhs?.sync?.noteLimit||coverage?.requestedLimit||state.xhsNoteLimit} 篇；列表与笔记正文分别读取。`].filter(Boolean).join(' ');
}
function xhsStatusView() {
  const data=state.xhs,status=data?.status||{},error=state.xhsError||status.error||data?.sync?.error,busy=xhsWorking();
  return `${busy?`<div class="xhs-notice xhs-working" role="status"><span class="spinner spinner-small"></span><span>${h(status.message||'正在后台处理小红书操作，完成后会更新。')}</span></div>`:''}${error?`<div class="xhs-notice is-error" role="alert">${icon('alert')}<span>${h(error)}</span><button class="text-button" data-action="xhs-reload" ${busy?'disabled':''}>重新读取</button></div>`:''}`;
}
function xhsAccountView() {
  const data=state.xhs,account=data?.account,record=xhsAccounts().find(item=>item.profileId===xhsProfileId()),connection=data?.connection||{},connected=xhsConnected(),busy=xhsWorking(),url=xhsHref(account?.url);
  const name=account?.nickname||xhsDisplayName(record),label=connected?'已连接':record?.duplicateOf?'重复绑定，需处理':account?.id?'需检查登录':'待扫码登录';
  return `<div class="xhs-workspace-toolbar"><div class="xhs-context-main"><button type="button" class="text-button xhs-back-link" data-action="xhs-overview" ${state.xhsAccountBusy?'disabled':''}>${icon('arrow')}返回账号列表</button><span class="xhs-context-divider" aria-hidden="true"></span><div class="xhs-current-account">${xhsAvatarView(record||{profileId:xhsProfileId(),accountId:account?.id,avatarUrl:account?.avatar},name)}<div><h2>${h(name)}</h2><small>${h([record?.accountName&&record.accountName!==name?record.accountName:'',record?.group||'默认分组'].filter(Boolean).join(' · '))}</small></div></div><span class="xhs-connection-badge ${connected?'is-connected':''}"><i></i>${h(label)}</span></div><div class="xhs-context-actions">${url?`<a class="text-button" href="${h(url)}" target="_blank" rel="noopener noreferrer">账号主页 ↗</a>`:''}<details class="xhs-more-menu"><summary id="xhs-account-settings">账号设置 ${icon('settings')}</summary><div class="xhs-more-items"><span class="xhs-more-caption">${h(record?.accountName||name)}${record?.group?' · '+h(record.group):''}</span><button type="button" data-action="xhs-account-edit" data-profile-id="${h(xhsProfileId())}" ${state.xhsAccountBusy?'disabled':''}>备注与分组</button><button type="button" data-action="xhs-action" data-kind="check" ${busy?'disabled':''}>检查登录状态</button><button type="button" data-action="xhs-action" data-kind="login" ${busy?'disabled':''}>${xhsBound()?'重新扫码登录':'扫码绑定账号'}</button><button type="button" data-action="xhs-account-add" ${state.xhsAccountBusy?'disabled':''}>添加账号</button><div class="xhs-menu-separator"></div><button type="button" data-action="xhs-action" data-kind="disconnect" ${busy||!account&&!connection.browserOpen?'disabled':''}>关闭浏览器连接</button><button type="button" class="is-danger" data-action="xhs-account-remove" data-profile-id="${h(xhsProfileId())}" ${state.xhsAccountBusy||record?.busy?'disabled':''}>从平台移除账号</button></div></details></div></div>${!connected?`<div class="xhs-connection-notice" role="status">${icon('lock')}<span>${h(connection.message||'登录后可刷新账号数据和电脑草稿。已读取的数据仍可查看。')}</span><button class="text-button" type="button" data-action="xhs-action" data-kind="${connection.browserOpen||xhsBound()&&connection.state==='disconnected'?'check':'login'}" ${busy?'disabled':''}>${connection.browserOpen?'我已登录，检查连接':xhsBound()&&connection.state==='disconnected'?'检查登录':'扫码登录'}</button></div>`:''}`;
}
function xhsMetricsView() {
  const data=state.xhs,account=data?.account,metrics=Array.isArray(data?.metrics)?data.metrics:[],basics=[['粉丝',account?.followers],['关注',account?.following],['获赞与收藏',account?.likes],['笔记数',account?.notesCount]];
  const known=metrics.filter(m=>typeof m.value==='number'&&Number.isFinite(m.value)),missing=metrics.filter(m=>!(typeof m.value==='number'&&Number.isFinite(m.value)));
  if(!account&&!known.length)return `<div class="xhs-onboarding"><span class="xhs-onboarding-icon" aria-hidden="true">${icon('chart')}</span><h3>从一个账号，开始看见内容的表现</h3><p>${xhsAccounts().length?'在上方扫码连接账号，即可同步数据与内容。':'先添加一个账号，再扫码完成连接。'}你的笔记和电脑草稿会集中保存在这个工作区。</p><ol><li><span>01</span>扫码连接账号</li><li><span>02</span>同步数据与笔记</li><li><span>03</span>查看或送出草稿</li></ol></div>`;
  const metricView=metric=>`<article><span>${h(metric.label||metric.id)}</span><strong>${h(xhsValue(metric.value))}${metric.unit?`<small>${h(metric.unit)}</small>`:''}</strong>${metric.period?`<small>${h(metric.period)}</small>`:''}${metric.source?`<small class="xhs-metric-source">来源：${h(xhsHref(metric.source)?'创作者中心':metric.source)}</small>`:''}</article>`;
  const coverage=typeof data?.sync?.coverage==='string'?data.sync.coverage:data?.sync?.coverage?.message;
  return `<div class="xhs-basic-metrics">${basics.map(([label,value])=>`<div><span>${label}</span><strong class="${value==null?'is-missing':''}">${h(xhsValue(value))}</strong></div>`).join('')}</div>${xhsHistoryView()}${known.length?`<div class="xhs-metrics-label"><h3>已获取指标</h3><span>按官方标注的统计周期展示</span></div><div class="xhs-detail-metrics">${known.map(metricView).join('')}</div>`:`<div class="xhs-data-empty">${icon('chart')}<p>${xhsConnected()?'同步后显示创作者中心实际提供的指标。':'连接账号后，在这里查看可获取的运营数据。'}</p></div>`}${missing.length?`<details id="xhs-missing-metrics" class="xhs-missing-metrics" ${state.xhsMissingOpen?'open':''}><summary>未获取的指标 <span>${missing.length} 项</span></summary><div>${missing.map(metric=>`<p><span>${h(metric.label||metric.id)}</span><small>${h(metric.message||metric.reason||'未获取')}${metric.period?' · '+h(metric.period):''}</small></p>`).join('')}</div></details>`:''}<p class="xhs-data-note">${h(coverage||'指标只读展示。未提供、无权限或读取失败的指标保留「未获取」。')} 近 7 日等滚动指标不换算为单日增量。</p>`;
}
function xhsHistoryView() {
  const rows=(Array.isArray(state.xhs?.analyticsHistory)?state.xhs.analyticsHistory:[]).filter(row=>row.accountId===xhsAccountId()&&Number.isFinite(Date.parse(row.at))).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-30);
  const points=rows.map(row=>({at:Date.parse(row.at),label:xhsDate(row.at),value:typeof row.account?.followers==='number'&&Number.isFinite(row.account.followers)?row.account.followers:null}));
  const valid=points.filter(p=>p.value!==null);
  const current=state.xhs?.account?.followers,latest=valid.at(-1),syncedAt=Date.parse(state.xhs?.sync?.lastSyncAt);
  if(latest&&Number.isFinite(current)&&latest.at===syncedAt&&latest.value!==current)return '<section class="xhs-history"><div class="xhs-history-heading"><h3>粉丝变化</h3><span>数据待核对</span></div><p class="xhs-history-empty">当前粉丝数与同一时间的历史快照不一致，趋势暂不展示。请重新同步账号数据后核对。</p></section>';
  if(valid.length<2)return `<section class="xhs-history"><div class="xhs-history-heading"><h3>粉丝变化</h3><span>每次同步的实际快照</span></div><p class="xhs-history-empty">${valid.length?'已有 1 次有效记录，再次同步后可比较粉丝变化。':'累计 2 次有效同步后显示趋势。'}</p></section>`;
  const w=760,ht=150,l=0,r=0,t=12,b=12,minX=points[0].at,maxX=points.at(-1).at,minV=Math.min(...valid.map(p=>p.value)),maxV=Math.max(...valid.map(p=>p.value)),pad=Math.max(1,(maxV-minV)*.15),low=Math.max(0,minV-pad),high=maxV+pad;
  const x=p=>l+(p.at-minX)/(maxX-minX||1)*(w-l-r),y=p=>t+(high-p.value)/(high-low||1)*(ht-t-b);
  const segments=[];let segment=[];for(const point of points){if(point.value===null){if(segment.length)segments.push(segment);segment=[];}else segment.push(point);}if(segment.length)segments.push(segment);
  const first=valid[0],last=valid.at(-1),delta=last.value-first.value;
  return `<section class="xhs-history"><div class="xhs-history-heading"><h3>粉丝变化</h3><span>${h(xhsDate(first.at))} 至 ${h(xhsDate(last.at))} · 净变化 ${delta>0?'+':''}${h(xhsValue(delta))}</span></div><div class="xhs-history-plot"><div class="xhs-chart-y-labels" aria-hidden="true"><span>${h(xhsValue(Math.round(high)))}</span><span>${h(xhsValue(Math.round(low)))}</span></div><div class="xhs-chart-canvas"><svg class="xhs-history-chart" viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none" role="img" aria-label="${h(valid.map(p=>p.label+'：'+p.value+' 位粉丝').join('；'))}"><path class="xhs-chart-grid" d="M${l} ${t}H${w-r}M${l} ${ht-b}H${w-r}"/>${segments.filter(segment=>segment.length>1).map(segment=>`<polyline points="${segment.map(p=>x(p)+','+y(p)).join(' ')}"/>`).join('')}${valid.map(p=>`<path class="xhs-chart-point-mark" d="M${x(p)} ${y(p)}h0"><title>${h(p.label)}：${h(xhsValue(p.value))}</title></path>`).join('')}</svg></div></div><div class="xhs-chart-dates" aria-hidden="true"><span>${h(new Date(points[0].at).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'}))}</span><span>${h(new Date(points.at(-1).at).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'}))}</span></div><p>仅比较粉丝总数的实测快照；横轴为实际同步时间，未获取的记录处断开连线。</p></section>`;
}
function xhsImageUrl(value) {
  if(typeof value!=='string'||!value)return '';
  if(/^\/(?:media|api\/xhs\/images|xhs-media)\//.test(value))return value;
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}
}
function xhsNotesView() {
  const all=(Array.isArray(state.xhs?.notes)?state.xhs.notes:[]).filter(note=>!note.accountId||note.accountId===xhsAccountId());
  const search=state.xhsNoteSearch.trim().toLocaleLowerCase(),sort=state.xhsNoteSort;
  const value=note=>sort==='recent'?(Date.parse(note.publishedAt)||0):(typeof note[sort]==='number'&&Number.isFinite(note[sort])?note[sort]:-1);
  const notes=all.filter(note=>!search||String(note.title||'').toLocaleLowerCase().includes(search)).sort((a,b)=>value(b)-value(a));
  if(!notes.length)return `<div class="xhs-data-empty">${icon('cards')}<p>${search?'没有找到匹配的笔记，试试其他标题关键词。':'还没有读取到笔记。同步后会显示封面、标题和互动数据。'}</p></div>`;
  return `<div class="xhs-notes-table-wrap"><table class="xhs-notes-table"><thead><tr><th scope="col">笔记</th><th scope="col">阅读</th><th scope="col">赞</th><th scope="col">藏</th><th scope="col">评</th></tr></thead><tbody>${notes.map(note=>{const image=xhsImageUrl(note.imageUrl||note.coverUrl||note.cover?.url||note.cover);return `<tr><td><button class="xhs-note-open" type="button" data-action="xhs-detail" data-kind="note" data-id="${h(note.id)}" aria-label="预览已发布笔记：${h(note.title||'未命名笔记')}">${image?`<img src="${h(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:`<span class="xhs-note-cover-placeholder">${icon('image')}</span>`}<span><strong>${h(note.title||'未命名笔记')}</strong><small>${note.publishedAt?h(xhsDate(note.publishedAt)):'发布时间未获取'}</small><em>${note.contentStatus?.isComplete?'已读取官方内容':'点击预览正文与图片'}</em></span></button></td>${['views','likes','collects','comments'].map(key=>`<td>${h(xhsValue(note[key]))}</td>`).join('')}</tr>`;}).join('')}</tbody></table></div>`;
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
function xhsOfficialDraftsView() {
  const all=(state.xhs?.officialDrafts||[]).filter(draft=>!draft.accountId||draft.accountId===xhsAccountId()),drafts=xhsFilteredDrafts(all),sync=state.xhs?.officialDraftSync||{},coverage=typeof sync.coverage==='string'?sync.coverage:sync.coverage?.message;
  const summary=`<div class="xhs-official-summary"><span>${state.xhsDraftSearch?'找到 '+drafts.length+' / '+all.length+' 份草稿':'共 '+all.length+' 份草稿'}</span><span>数据更新 ${h(xhsDate(sync.lastSyncAt))}</span></div>`;
  const error=sync.error?`<div class="xhs-inline-error" role="alert">${h(sync.error)}<button class="text-button" data-action="xhs-official-sync" ${xhsWorking()||!xhsConnected()?'disabled':''}>重新读取</button></div>`:'';
  const empty=`<div class="xhs-data-empty">${icon('file')}<p>${state.xhsDraftSearch?'没有匹配的草稿，试试其他标题关键词。':sync.lastSyncAt?'本次未读到可见的电脑草稿。':'点击「刷新草稿」，读取小红书电脑端当前可见的草稿。'}</p>${state.xhsDraftSearch?'<button class="text-button" type="button" data-action="xhs-clear-draft-search">清空搜索</button>':''}</div>`;
  return summary+error+(drafts.length?`<p class="xhs-table-scroll-hint">左右滑动，查看保存时间与草稿操作</p><div class="xhs-content-table-wrap"><table class="xhs-content-table xhs-drafts-table"><caption class="sr-label">小红书官方电脑草稿</caption><thead><tr><th scope="col">草稿内容</th><th scope="col">类型</th><th scope="col">保存时间</th><th scope="col">内容预览</th><th scope="col">操作</th></tr></thead><tbody>${drafts.map(draft=>{
    const image=xhsImageUrl(draft.imageUrl),cached=Boolean(draft.contentStatus?.lastSyncAt||['ready','partial'].includes(draft.contentStatus?.state)),canPreview=draft.canRead!==false||cached;
    const title=`${image?`<img src="${h(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:`<span class="xhs-note-cover-placeholder" aria-hidden="true">${icon('file')}</span>`}<span><strong>${h(draft.title||'未命名电脑草稿')}</strong></span>`;
    return `<tr><td>${canPreview?`<button class="xhs-content-title" type="button" data-action="xhs-detail" data-kind="official-draft" data-id="${h(draft.key)}" aria-label="预览草稿：${h(draft.title||'未命名电脑草稿')}">${title}</button>`:`<div class="xhs-content-title">${title}</div>`}</td><td>${h(({image:'图文',video:'视频'})[draft.kind]||draft.kind||'未获取')}</td><td class="xhs-table-time">${draft.updatedAt?h(xhsDate(draft.updatedAt)):draft.updatedAtLabel?h(draft.updatedAtLabel):'未获取'}</td><td><span class="xhs-preview-state ${canPreview?'is-ready':''}">${cached?'已读取':canPreview?'可预览':'暂不支持预览'}</span></td><td><div class="xhs-row-actions">${canPreview?`<button class="text-button" type="button" data-action="xhs-detail" data-kind="official-draft" data-id="${h(draft.key)}">${cached&&!xhsConnected()?'预览缓存':'预览'}</button>`:''}<button class="text-button" type="button" data-action="xhs-official-open" data-id="${h(draft.key)}" ${xhsWorking()||!xhsConnected()?'disabled':''}>官网编辑 ↗</button></div></td></tr>`;
  }).join('')}</tbody></table></div>`:empty)+`<p class="xhs-data-note">${h(coverage||'此处展示小红书电脑端草稿，不包含手机本地草稿。')}</p>`;
}
function xhsExistingDraft(projectId=state.xhsProjectId) {
  return (state.xhs?.drafts||[]).find(draft=>draft.projectId===projectId&&draft.accountId===xhsAccountId()&&['queued','running','filled','unknown','interrupted'].includes(draft.status));
}
function xhsComposerView() {
  const available=state.projects.filter(xhsEligible),p=available.find(project=>project.id===state.xhsProjectId),preview=state.xhsPreview;
  if(p&&!preview)state.xhsPreview={title:p.title||'',content:p.caption||'',accountId:xhsAccountId()};
  const draft=state.xhsPreview;
  return `<form id="xhs-draft-form"><label for="xhs-project">选择已完成的作品</label><select id="xhs-project" name="projectId" ${state.xhsBusy==='draft'?'disabled':''}><option value="">选择一份图文…</option>${available.map(project=>`<option value="${h(project.id)}" ${p?.id===project.id?'selected':''}>${h(project.title||'未命名作品')}</option>`).join('')}</select>${!available.length?'<p class="field-help">完成文案和全部图片后，即可在这里选择作品。</p><button type="button" class="text-button" data-action="navigate" data-view="briefing">去创作图文 →</button>':''}${p&&draft?`<div class="xhs-preview-target" id="xhs-preview-target">${xhsBound()?`${icon(xhsConnected()?'check':'lock')}目标账号：${h(state.xhs.account.nickname||state.xhs.account.id)}${xhsConnected()?'':' · 送稿时自动检查登录'}`:`${icon('lock')}请先扫码绑定小红书账号`}</div><div class="xhs-preview-images" aria-label="本次草稿图片，按原作品顺序">${p.pages.map((page,index)=>`<figure><img src="${h(page.imageUrl)}" alt="第 ${index+1} 张：${h(page.title)}" loading="lazy"><figcaption>${String(index+1).padStart(2,'0')}</figcaption></figure>`).join('')}</div><div class="xhs-preview-label"><label for="xhs-title">小红书标题</label><span id="xhs-title-count"></span></div><input id="xhs-title" name="title" ${state.xhsBusy==='draft'?'disabled':''} value="${h(draft.title)}" placeholder="为这篇图文取个标题" required><div class="xhs-preview-label"><label for="xhs-content">帖子正文</label><span id="xhs-content-count"></span></div><textarea id="xhs-content" name="content" rows="7" ${state.xhsBusy==='draft'?'disabled':''} placeholder="检查正文和话题，确认后送入草稿">${h(draft.content)}</textarea><p class="field-help">这里的调整只用于本次小红书草稿，原作品会保留。</p><div id="xhs-submit-notice" class="xhs-submit-notice" role="status"></div><button id="xhs-submit-draft" type="submit" class="button button-primary button-full">${icon('arrow')}确认送入电脑草稿</button><p class="xhs-submit-help">会向上方账号上传 ${p.pages.length} 张图片并准备草稿；发布由你在小红书决定。</p>`:'<div class="xhs-composer-empty">'+icon('image')+'<p>选择作品后，先在这里检查图片、标题和正文。</p></div>'}</form>`;
}
function xhsDraftsView() {
  const drafts=xhsFilteredDrafts((state.xhs?.drafts||[]).filter(draft=>draft.accountId===xhsAccountId()));
  if(!drafts.length)return `<div class="xhs-data-empty"><p>${state.xhsDraftSearch?'没有匹配的送稿记录，试试其他标题关键词。':'送出的草稿会留在这里，展示真实处理结果。'}</p></div>`;
  return drafts.map(draft=>`<article class="xhs-draft-item"><div><span class="xhs-draft-state status-${h(draft.status)}">${['queued','running'].includes(draft.status)?'<span class="spinner spinner-small"></span>':''}${h(draft.rechecking?'正在重新核验草稿':XHS_DRAFT_LABELS[draft.status]||'状态待核验')}</span><small>${h(xhsDate(draft.updatedAt||draft.createdAt))}</small></div><h3>${h(draft.title||'未命名草稿')}</h3><p>${h(draft.message||'请到小红书电脑草稿页核对内容。')}</p>${draft.verifiedAt?`<small>核验时间 ${h(xhsDate(draft.verifiedAt))}</small>`:''}<div class="xhs-draft-actions"><button type="button" class="text-button" data-action="xhs-detail" data-kind="submission" data-id="${h(draft.id)}">预览本地冻结稿</button>${xhsCanRecheck(draft)?`<button type="button" class="text-button" data-action="xhs-recheck" data-id="${h(draft.id)}" ${xhsWorking()||!xhsConnected()||draft.accountId!==xhsAccountId()?'disabled':''}>${icon('refresh')}重新核验草稿</button>`:''}${draft.canRetry&&draft.accountId===xhsAccountId()?`<button type="button" class="text-button" data-action="xhs-retry" data-id="${h(draft.id)}" ${xhsWorking()||!xhsConnected()?'disabled':''}>重新准备草稿</button>`:''}${['verified','filled','unknown','interrupted'].includes(draft.status)?`<button type="button" class="text-button" data-action="xhs-action" data-kind="open-drafts" ${xhsWorking()||!xhsConnected()||draft.accountId!==xhsAccountId()?'disabled':''}>打开电脑草稿核对 ↗</button>`:''}</div></article>`).join('');
}
function xhsDetailPath(detail=state.xhsDetail) {
  if(!detail)return '';
  const group=detail.kind==='note'?'notes':detail.kind==='official-draft'?'official-drafts':'submissions';
  return `/api/xhs/${group}/${encodeURIComponent(detail.id)}`;
}
function xhsDetailCurrent(detail,version) {
  return state.view==='xhs'&&state.xhsDetail===detail&&detail.accountId===xhsAccountId()&&detail.profileId===xhsProfileId()&&version===xhsDetailRequestVersion;
}
function closeXhsDetail({restoreFocus=true}={}) {
  ++xhsDetailRequestVersion;state.xhsDetail=null;
  const dialog=document.querySelector('#xhs-detail-dialog');if(dialog?.open)dialog.close();
  if(restoreFocus){const target=xhsDetailReturnFocus?.isConnected?xhsDetailReturnFocus:document.querySelector('.xhs-tabs [aria-selected="true"]');target?.focus({preventScroll:true});}
  xhsDetailReturnFocus=null;
}
function updateXhsDetail() {
  const current=state.xhsDetail,region=document.querySelector('#xhs-detail-region');if(!current||!region)return;
  const detail=current.detail,local=current.kind==='submission',officialDraft=current.kind==='official-draft',busy=current.loading||current.waiting,images=(Array.isArray(detail?.images)?detail.images:[]).map(image=>xhsImageUrl(typeof image==='string'?image:image?.url)).filter(Boolean),url=xhsHref(detail?.url),content=typeof detail?.content==='string'?detail.content:'',tags=Array.isArray(detail?.tags)?detail.tags:[];
  const source=local?'本平台冻结稿':officialDraft?'小红书官方电脑草稿':'小红书官方已发布笔记';
  const status=local?'送稿时保存的本地版本，官网后续修改不回写此处。':detail?.isComplete?'已读取官方内容':detail?'官方内容读取不完整，请核对下方来源说明。':'尚未读取到官方正文与图片。';
  const focused=document.activeElement,focusAction=focused?.closest('#xhs-detail-region')?focused.dataset.action:null,scroll=region.closest('dialog')?.scrollTop||0;
  region.innerHTML=`<div class="xhs-detail-heading"><div><span class="xhs-detail-source">${h(source)}</span><h2 id="xhs-detail-title">${h(detail?.title||current.title||'内容预览')}</h2></div><button class="icon-button" type="button" data-action="xhs-detail-close" aria-label="关闭内容预览">${icon('close')}</button></div><div class="xhs-detail-body"><div class="xhs-detail-status ${detail&&!detail.isComplete&&!local?'is-warning':''}"><strong>${h(status)}</strong>${detail?.message?`<p>${h(detail.message)}</p>`:''}${detail?.fetchedAt||detail?.lastSyncAt?`<small>读取时间 ${h(xhsDate(detail.fetchedAt||detail.lastSyncAt))}</small>`:''}</div>${busy?`<div class="xhs-detail-loading" role="status"><span class="spinner spinner-small"></span>${current.waiting?'正在官方页面读取内容，完成后会自动更新…':'正在读取内容…'}</div>`:''}${current.error?`<div class="xhs-inline-error" role="alert">${h(current.error)}</div>`:''}${images.length?`<div class="xhs-detail-images" aria-label="${h(source)}图片，共 ${images.length} 张">${images.map((image,i)=>`<figure><img src="${h(image)}" alt="第 ${i+1} 张图片" loading="lazy" referrerpolicy="no-referrer"><figcaption>${i+1} / ${images.length}</figcaption></figure>`).join('')}</div>`:!busy?'<p class="xhs-detail-empty">图片未获取</p>':''}${content?`<div class="xhs-detail-content">${h(content)}</div>`:!busy?'<p class="xhs-detail-empty">正文未获取</p>':''}${tags.length?`<div class="xhs-detail-tags">${tags.filter(tag=>typeof tag==='string').map(tag=>`<span>${h(tag.startsWith('#')?tag:'#'+tag)}</span>`).join('')}</div>`:''}<div class="xhs-detail-actions">${current.error&&!busy?'<button class="button button-secondary" type="button" data-action="xhs-detail-retry">重试读取预览</button>':''}${!local?`<button class="button button-secondary" type="button" data-action="xhs-detail-read" ${busy||xhsWorking()||!xhsConnected()?'disabled':''}>${icon('refresh')}${detail?'重新读取官方内容':'读取官方内容'}</button>`:``}${officialDraft?`<button class="text-button" type="button" data-action="xhs-official-open" data-id="${h(current.id)}" ${xhsWorking()||!xhsConnected()?'disabled':''}>到官网编辑 ↗</button>`:url&&current.kind!=='note'?`<a class="text-button" href="${h(url)}" target="_blank" rel="noopener noreferrer">在官网查看 ↗</a>`:''}</div>${!local&&!xhsConnected()?'<p class="field-help">重新连接账号后可读取最新官方内容；已读取内容仍可查看。</p>':''}</div>`;
  if(focusAction)region.querySelector(`[data-action="${focusAction}"]`)?.focus({preventScroll:true});
  if(region.closest('dialog'))region.closest('dialog').scrollTop=scroll;
}
async function openXhsDetail(kind,id,trigger) {
  if(!['note','official-draft','submission'].includes(kind)||!id||!xhsAccountId())return;
  const collection=kind==='note'?state.xhs.notes:kind==='official-draft'?state.xhs.officialDrafts:state.xhs.drafts;
  const item=(collection||[]).find(item=>(kind==='official-draft'?item.key:item.id)===id&&(!item.accountId||item.accountId===xhsAccountId()));
  if(!item)return;
  closeXhsDetail({restoreFocus:false});xhsDetailReturnFocus=trigger;
  const current={kind,id,accountId:xhsAccountId(),profileId:xhsProfileId(),title:item.title||'',detail:null,loading:true,waiting:false,error:''};state.xhsDetail=current;
  const version=++xhsDetailRequestVersion;updateXhsDetail();
  const dialog=document.querySelector('#xhs-detail-dialog');if(!dialog)return;dialog.showModal();dialog.querySelector('[data-action="xhs-detail-close"]')?.focus();
  await getXhsDetail(current,version,{readIfMissing:true});
}
async function getXhsDetail(current,version,{readIfMissing=false}={}) {
  try{
    const result=await api(xhsDetailPath(current)+'?accountId='+encodeURIComponent(current.accountId));
    if(!xhsDetailCurrent(current,version))return;
    current.detail=result.detail||null;current.loading=false;current.waiting=false;
    current.error=result.contentStatus?.error||(!result.detail&&current.kind==='submission'?'这份送稿记录的本地冻结稿暂不可读取。':'');
    updateXhsDetail();
    if(!result.detail&&readIfMissing&&current.kind!=='submission'){
      if(xhsConnected()&&!xhsWorking())await readXhsDetail();
      else{current.error=xhsWorking()?'当前有小红书操作正在进行，完成后可点击「读取官方内容」。':'请先重新连接账号，再读取官方内容。';updateXhsDetail();}
    }
  }catch(error){if(xhsDetailCurrent(current,version)){current.loading=false;current.waiting=false;current.error=error.message;updateXhsDetail();}}
}
async function readXhsDetail() {
  const current=state.xhsDetail;if(!current||current.kind==='submission'||current.accountId!==xhsAccountId()||xhsWorking()||!xhsConnected())return;
  const version=++xhsDetailRequestVersion,loadVersion=++xhsLoadVersion;clearTimeout(xhsPollTimer);
  state.xhsBusy='content-read';current.loading=true;current.error='';updateXhs();
  try{
    const result=await api(xhsDetailPath(current),{method:'POST',body:{accountId:current.accountId,profileId:current.profileId}});if(xhsDetailCurrent(current,version))acceptXhs(result);
    if(xhsDetailCurrent(current,version)){current.loading=false;current.waiting=true;}
  }catch(error){if(xhsDetailCurrent(current,version)){current.loading=false;current.waiting=false;current.error=error.message;}}
  finally{if(loadVersion===xhsLoadVersion)state.xhsBusy='';updateXhs();scheduleXhsPoll();}
  if(xhsDetailCurrent(current,version)&&current.waiting&&!xhsWorking())await finishXhsDetailRead();
}
async function finishXhsDetailRead() {
  const current=state.xhsDetail;if(!current?.waiting||current.loading||xhsWorking()||current.accountId!==xhsAccountId())return;
  current.loading=true;updateXhsDetail();
  await getXhsDetail(current,xhsDetailRequestVersion);
  if(state.xhsDetail===current&&!current.detail&&!current.error){current.error='本次未读取到内容，请在官方窗口处理登录或验证后重试。';updateXhsDetail();}
}
async function syncXhsOfficialDrafts() {
  if(xhsWorking()||!xhsConnected())return;
  const accountId=xhsAccountId(),profileId=xhsProfileId(),version=++xhsLoadVersion;clearTimeout(xhsPollTimer);state.xhsBusy='official-drafts';state.xhsError='';updateXhs();
  try{const result=await api('/api/xhs/official-drafts/sync',{method:'POST',body:{accountId,profileId}});if(version===xhsLoadVersion)acceptXhs(result);}
  catch(error){if(version===xhsLoadVersion){state.xhsError=error.message;notify(error.message,true);}}
  finally{if(version===xhsLoadVersion)state.xhsBusy='';updateXhs();scheduleXhsPoll();}
}
async function openXhsOfficialDraft(id) {
  if(xhsWorking()||!xhsConnected()||!(state.xhs.officialDrafts||[]).some(draft=>draft.key===id&&(!draft.accountId||draft.accountId===xhsAccountId())))return;
  const accountId=xhsAccountId(),profileId=xhsProfileId(),version=++xhsLoadVersion;clearTimeout(xhsPollTimer);state.xhsBusy='official-open';state.xhsError='';updateXhs();
  try{const result=await api(`/api/xhs/official-drafts/${encodeURIComponent(id)}/open`,{method:'POST',body:{accountId,profileId}});if(version===xhsLoadVersion)acceptXhs(result);notify('已打开官方草稿页面，请在官网继续编辑。');}
  catch(error){if(version===xhsLoadVersion){state.xhsError=error.message;notify(error.message,true);}}
  finally{if(version===xhsLoadVersion)state.xhsBusy='';updateXhs();scheduleXhsPoll();}
}
function acceptXhs(payload) {
  const snapshot=payload?.snapshot||payload;
  if(!snapshot?.connection||!snapshot?.status||!Array.isArray(snapshot.drafts))throw new Error('小红书工作台数据不完整，请重新读取。');
  const oldId=xhsAccountId(),oldProfile=xhsProfileId(),newId=String(snapshot.account?.id||'');state.xhs=snapshot;
  if(state.xhsSection==='auto')state.xhsSection='overview';
  if(!xhsAccounts().length&&!snapshot.account)state.xhsSection='overview';
  if(oldProfile!==xhsProfileId()||oldId!==newId){closeXhsDetail({restoreFocus:false});state.xhsNoteSearch='';state.xhsDraftSearch='';state.xhsTab=state.xhsLocation.tabs[xhsProfileId()]||'analytics';state.xhsDraftSource='official';state.xhsComposerOpen=false;if(oldId||oldProfile){++xhsDraftRequestVersion;state.xhsProjectId='';state.xhsPreview=null;state.xhsError='';}}
  if(state.xhsPreview&&!state.xhsPreview.accountId&&newId)state.xhsPreview.accountId=newId;
  if(!state.guide.creation&&state.guide.xhsAutoDelivery&&state.guide.xhsTargetAccountId===null&&newId){state.guide.xhsTargetAccountId=newId;saveGuidance();}
  return snapshot;
}
function updateXhsComposerState() {
  const preview=state.xhsPreview,form=document.querySelector('#xhs-draft-form');if(!form)return;
  form.querySelectorAll('select,input,textarea').forEach(input=>{input.disabled=xhsWorking();});
  if(!preview)return;
  const titleLength=Array.from(preview.title).length,contentLength=Array.from(preview.content).length,existing=xhsExistingDraft(),previous=(state.xhs?.drafts||[]).find(draft=>draft.projectId===state.xhsProjectId&&draft.accountId===xhsAccountId());
  [['#xhs-title-count',titleLength,20],['#xhs-content-count',contentLength,1000]].forEach(([selector,count,max])=>{const el=form.querySelector(selector);if(el){el.textContent=`${count} / ${max}`;el.classList.toggle('is-error',count>max);}});
  const valid=xhsBound()&&preview.accountId===xhsAccountId()&&preview.title.trim()&&titleLength<=20&&contentLength<=1000&&!xhsWorking()&&!existing;
  const button=form.querySelector('#xhs-submit-draft');if(button){button.disabled=!valid;button.innerHTML=state.xhsBusy==='draft'?'<span class="spinner spinner-small"></span>'+(!xhsConnected()?'正在检查绑定账号':'正在准备'):existing?'这份作品已有待核验草稿':icon('arrow')+(!xhsConnected()&&xhsBound()?'检查登录并送入草稿':previous?.status==='verified'?'准备当前版本的电脑草稿':'确认送入电脑草稿');}
  const note=form.querySelector('#xhs-submit-notice');if(note){note.textContent=existing?`这份作品${XHS_DRAFT_LABELS[existing.status]||'已有草稿记录'}，请打开电脑草稿核对，避免重复送出。`:!xhsBound()?'首次使用请先扫码绑定小红书账号。':titleLength>20?'标题超过 20 字，请调整后再送出。':contentLength>1000?'正文超过 1000 字，请调整后再送出。':!preview.title.trim()?'请填写小红书标题。':!xhsConnected()?'账号已绑定。本次点击将自动检查保存的登录状态，通过后送稿；需要重新登录时会提示。':previous?.status==='verified'?'已有电脑草稿已核验。相同内容会复用记录；调整标题、正文或图片后会另存新版，原草稿不会被覆盖。':previous?.status==='failed'?'这份作品有未完成的草稿记录。同一版本请在下方查看原因或重新准备；修改内容可另存新版。':'';note.classList.toggle('is-error',titleLength>20||contentLength>1000);note.hidden=!note.textContent;}
}
function updateXhs() {
  if(state.view==='briefing'){updateGuideXhs();return;}
  if(state.view!=='xhs')return;
  const page=document.querySelector('#xhs-page'),management=page?.querySelector('#xhs-management-region');
  if(!page||!management||!state.xhs){render();return;}
  const active=document.activeElement,focus=active?.closest('#xhs-management-region')?{id:active.id,action:active.dataset.action,profileId:active.dataset.profileId,kind:active.dataset.kind,itemId:active.dataset.id,tab:active.dataset.tab,source:active.dataset.source,start:active.selectionStart,end:active.selectionEnd}:null;
  const menuOpen=Boolean(page.querySelector('.xhs-more-menu[open]'));
  const scrolls=[...page.querySelectorAll('.xhs-accounts-table-wrap,.xhs-content-table-wrap,.xhs-notes-table-wrap')].map(el=>({name:el.className,top:el.scrollTop,left:el.scrollLeft}));
  const structural=management.dataset.section!==state.xhsSection||management.dataset.profileId!==xhsProfileId();
  const replace=replaceXhsRegion;
  if(structural){management.innerHTML=xhsManagementView();management.dataset.section=state.xhsSection;management.dataset.profileId=xhsProfileId();}
  replace('#xhs-status-region',xhsStatusView());
  if(state.xhsSection==='overview'){
    replace('#xhs-overview-results',xhsAccountsResultsView());
    const refresh=page.querySelector('.xhs-overview-toolbar [data-action="xhs-reload"]');if(refresh)refresh.disabled=Boolean(state.xhsAccountBusy||state.xhsLoading);
  }
  else {
    const select=page.querySelector('#xhs-project'),priorSelection=select?.value||'',available=state.projects.filter(xhsEligible);
    if(state.xhsProjectId&&!available.some(project=>project.id===state.xhsProjectId)){state.xhsProjectId='';state.xhsPreview=null;}
    replace('#xhs-account-region',xhsAccountView());
    replace('.xhs-tabs',xhsTabsView());
    replace('#xhs-metrics-region',xhsMetricsView());
    replace('#xhs-notes-region',xhsNotesView());
    replace('#xhs-drafts-region',xhsDraftsView());
    replace('#xhs-official-drafts-region',xhsOfficialDraftsView());
    replace('#xhs-draft-refresh',xhsDraftRefreshView());
    replace('.xhs-draft-source',xhsDraftSourceView());
    if(priorSelection!==state.xhsProjectId||!select)replace('#xhs-composer-region',xhsComposerView());
    else {
      const options='<option value="">选择一份图文…</option>'+available.map(project=>`<option value="${h(project.id)}" ${state.xhsProjectId===project.id?'selected':''}>${h(project.title||'未命名作品')}</option>`).join('');
      if(select._xhsOptions!==options){select.innerHTML=options;select.value=state.xhsProjectId;select._xhsOptions=options;}
    }
    if(menuOpen&&!structural){const menu=page.querySelector('.xhs-more-menu');if(menu)menu.open=true;}
    for(const id of ['analytics','published','drafts']){const panel=page.querySelector('#xhs-panel-'+id);if(panel)panel.hidden=state.xhsTab!==id;}
    const official=page.querySelector('#xhs-official-drafts-region'),submissions=page.querySelector('#xhs-submissions-region');
    if(official)official.hidden=state.xhsDraftSource!=='official';if(submissions)submissions.hidden=state.xhsDraftSource!=='submissions';
    const time=page.querySelector('#xhs-sync-time');if(time)time.textContent='数据更新 '+xhsDate(state.xhs.sync?.lastSyncAt);
    const count=page.querySelector('#xhs-notes-count');if(count)count.textContent=`${(state.xhs.notes||[]).filter(note=>!note.accountId||note.accountId===xhsAccountId()).length} 篇已读取`;
    const target=page.querySelector('#xhs-preview-target');if(target)target.textContent=xhsBound()?`目标账号：${state.xhs.account.nickname||state.xhs.account.id}${xhsConnected()?'':' · 送稿时自动检查登录'}`:'请先扫码绑定小红书账号';
    const coverage=page.querySelector('#xhs-notes-coverage');if(coverage)coverage.textContent=xhsNotesCoverage();
    page.querySelectorAll('#xhs-panel-analytics [data-kind="sync"],.xhs-note-toolbar [data-kind="sync"]').forEach(button=>{button.disabled=xhsWorking()||!xhsConnected();});
    const search=page.querySelector('#xhs-note-search');if(search&&search.value!==state.xhsNoteSearch)search.value=state.xhsNoteSearch;
    const draftSearch=page.querySelector('#xhs-draft-search');if(draftSearch&&draftSearch.value!==state.xhsDraftSearch)draftSearch.value=state.xhsDraftSearch;
  }
  for(const scroll of scrolls){const element=[...page.querySelectorAll('.xhs-accounts-table-wrap,.xhs-content-table-wrap,.xhs-notes-table-wrap')].find(el=>el.className===scroll.name);if(element){element.scrollTop=scroll.top;element.scrollLeft=scroll.left;}}
  if(focus&&!active.isConnected){
    const next=focus.id?document.getElementById(focus.id):[...management.querySelectorAll('[data-action]')].find(el=>el.dataset.action===focus.action&&el.dataset.profileId===focus.profileId&&el.dataset.kind===focus.kind&&el.dataset.id===focus.itemId&&el.dataset.tab===focus.tab&&el.dataset.source===focus.source);
    if(next&&!next.disabled){next.focus({preventScroll:true});if(typeof focus.start==='number'&&typeof next.setSelectionRange==='function')try{next.setSelectionRange(focus.start,focus.end);}catch{}}
  }
  updateXhsComposerState();updateXhsDetail();
}
function scheduleXhsPoll() {
  clearTimeout(xhsPollTimer);
  if(['xhs','briefing'].includes(state.view)&&(xhsWorking()||xhsAccounts().some(record=>record.busy)||state.xhsDetail?.waiting||(state.xhs?.drafts||[]).some(draft=>draft.accountId===xhsAccountId()&&['queued','running'].includes(draft.status))))xhsPollTimer=setTimeout(()=>loadXhs({quiet:true}),2000);
}
async function loadXhs({quiet=false,refreshProjects=false}={}) {
  const version=++xhsLoadVersion;state.xhsLoading=true;if(!quiet&&!state.xhs&&state.view==='xhs')render();
  try{
    const snapshot=await api('/api/xhs');if(version!==xhsLoadVersion)return;
    const first=!state.xhs;state.xhsError='';acceptXhs(snapshot);
    if(refreshProjects){const result=await api('/api/projects');if(version!==xhsLoadVersion)return;state.projects=result.projects||state.projects;}
    if(state.view==='xhs'){if(first){render();updateXhsComposerState();}else updateXhs();}else if(state.view==='briefing')updateGuideXhs();
    if(state.xhsDetail?.waiting&&!xhsWorking())await finishXhsDetailRead();
  }catch(error){if(version===xhsLoadVersion){state.xhsError=error.message;if(state.view==='xhs'){if(state.xhs)updateXhs();else render();}else if(state.view==='briefing')updateGuideXhs();}}
  finally{if(version===xhsLoadVersion){state.xhsLoading=false;if(state.view==='xhs'&&state.xhs)updateXhs();scheduleXhsPoll();}}
}
function chooseXhsProject(id) {
  ++xhsDraftRequestVersion;
  const p=state.projects.find(project=>project.id===id&&xhsEligible(project));state.xhsProjectId=p?.id||'';state.xhsPreview=p?{title:p.title||'',content:p.caption||'',accountId:xhsAccountId()}:null;
  replaceXhsRegion('#xhs-composer-region',xhsComposerView());updateXhsComposerState();
}
async function openXhsForProject(id) {
  ++xhsDraftRequestVersion;
  const p=state.projects.find(project=>project.id===id)||state.guideProject;if(!p||p.id!==id||!xhsEligible(p))return notify('请等文案和全部图片完成后，再准备小红书草稿。',true);
  state.xhsSection='detail';state.xhsTab='drafts';state.xhsComposerOpen=true;state.xhsProjectId=id;state.xhsPreview={title:p.title||'',content:p.caption||'',accountId:xhsAccountId()};rememberXhsLocation();state.view='xhs';const url=new URL(location.href);url.searchParams.set('view','xhs');window.history.replaceState({},'',url);render();updateXhsComposerState();await loadXhs({quiet:true,refreshProjects:true});state.xhsSection='detail';state.xhsTab='drafts';state.xhsComposerOpen=true;rememberXhsLocation();updateXhs();const disclosure=document.querySelector('#xhs-composer-disclosure');if(disclosure)disclosure.open=true;document.querySelector('#xhs-composer-region')?.scrollIntoView({behavior:'smooth',block:'start'});
}
async function runXhsAction(kind,{accountId='',profileId=''}={}) {
  if(!['login','check','sync','open-drafts','disconnect'].includes(kind)||state.xhsAccountBusy)return;
  const target=accountId?xhsAccountRecord(accountId):null;
  if(accountId&&!target)return notify('目标账号已移除，请在账号管理中重新绑定。',true);
  const targetProfile=profileId||target?.profileId||xhsProfileId(),selected=targetProfile===xhsProfileId();
  if(selected?xhsWorking():target?.busy)return;
  const version=++xhsLoadVersion;clearTimeout(xhsPollTimer);state.xhsBusy=kind;state.xhsError='';updateXhs();
  const body={...(targetProfile?{profileId:targetProfile}:{}),...(accountId?{accountId}:{}),...(kind==='sync'?{noteLimit:state.xhsNoteLimit}:{})};
  try{const result=await api(`/api/xhs/${kind}`,{method:'POST',body});if(version!==xhsLoadVersion)return;acceptXhs(result);if(kind==='disconnect'){state.xhsProjectId='';state.xhsPreview=null;notify('已关闭该账号的浏览器连接，账号和原稿保留。');}else if(kind==='login')notify('请在打开的官方浏览器中登录，完成后点击「检查连接」。');}
  catch(error){if(version===xhsLoadVersion){state.xhsError=error.message;notify(error.message,true);}}
  finally{if(version===xhsLoadVersion)state.xhsBusy='';updateXhs();scheduleXhsPoll();}
}
async function checkBoundXhsForDraft(accountId,isCurrent) {
  if(!isCurrent())return false;
  const result=await api('/api/xhs/check',{method:'POST',body:{accountId,profileId:xhsProfileId()}});if(!isCurrent())return false;acceptXhs(result);
  const deadline=Date.now()+45000;
  for(;;){
    if(!isCurrent())return false;
    if(!xhsBound()||xhsAccountId()!==accountId)throw new Error('绑定账号已变化，本次没有送稿。请重新选择作品并确认账号。');
    updateXhs();
    if(!state.xhs?.status?.busy){
      if(xhsConnected())return true;
      throw new Error(state.xhs?.connection?.message||'保存的登录状态需要重新验证，请扫码登录后再次送稿。');
    }
    if(Date.now()>=deadline)throw new Error('登录检查仍在处理中，本次没有送稿。完成后可再次点击送稿。');
    await new Promise(resolve=>setTimeout(resolve,750));
    if(!isCurrent())return false;
    const snapshot=await api('/api/xhs');
    if(!isCurrent())return false;
    acceptXhs(snapshot);
  }
}
async function submitXhsDraft() {
  const preview=state.xhsPreview,p=state.projects.find(project=>project.id===state.xhsProjectId);if(!preview||!xhsEligible(p)||xhsWorking())return;
  if(!xhsBound()||preview.accountId!==xhsAccountId())return notify('账号绑定已变化，请重新选择作品并核对目标账号。',true);
  if(!preview.title.trim()||Array.from(preview.title).length>20||Array.from(preview.content).length>1000)return updateXhsComposerState();
  if(xhsExistingDraft())return notify('这份作品已有草稿记录，请先打开电脑草稿核对。',true);
  const body={projectId:p.id,accountId:preview.accountId,title:preview.title,content:preview.content};
  const operation=++xhsDraftRequestVersion;
  const isCurrent=()=>operation===xhsDraftRequestVersion&&state.view==='xhs'&&state.xhsProjectId===p.id&&state.xhsPreview===preview&&preview.accountId===body.accountId&&preview.title===body.title&&preview.content===body.content;
  ++xhsLoadVersion;clearTimeout(xhsPollTimer);state.xhsBusy='draft';state.xhsError='';updateXhs();
  try{
    if(!xhsConnected()){
      if(!await checkBoundXhsForDraft(body.accountId,isCurrent))return;
      if(!isCurrent())return;
      const {project:current}=await api(`/api/projects/${encodeURIComponent(p.id)}`);
      if(!isCurrent())return;
      if(!xhsEligible(current)||current.title!==p.title||current.caption!==p.caption||JSON.stringify(current.pages.map(page=>page.imageUrl))!==JSON.stringify(p.pages.map(page=>page.imageUrl)))throw new Error('检查期间原作品已更新，本次没有送稿。请重新选择作品并确认最新内容。');
    }
    if(!isCurrent())return;
    if(!xhsConnected()||xhsAccountId()!==body.accountId||state.xhs?.status?.busy||xhsExistingDraft(p.id))throw new Error('账号或草稿状态已变化，本次没有送稿，请重新核对。');
    const result=await api('/api/xhs/drafts',{method:'POST',body});if(!isCurrent())return;acceptXhs(result);const status=result.draft?.status;notify(status==='verified'?'电脑草稿已核验。':status==='failed'?'这份草稿尚未准备完成，请查看下方原因。':['unknown','filled','interrupted'].includes(status)?'上次保存结果仍需核对，请打开电脑草稿检查。':'草稿任务已提交，可在下方查看处理结果。',['failed','unknown','interrupted'].includes(status));
  }
  catch(error){state.xhsError=error.message;notify(error.message,true);if(error.status===409){const previousAccount=xhsAccountId();await loadXhs({quiet:true});if(previousAccount===xhsAccountId())state.xhsError=error.message;}}
  finally{if(operation===xhsDraftRequestVersion)state.xhsBusy='';updateXhs();scheduleXhsPoll();}
}
async function retryXhsDraft(id) {
  const draft=state.xhs?.drafts?.find(item=>item.id===id);if(!draft?.canRetry||!xhsConnected()||draft.accountId!==xhsAccountId()||xhsWorking())return;
  const version=++xhsLoadVersion;clearTimeout(xhsPollTimer);state.xhsBusy='retry';state.xhsError='';updateXhs();
  const accountId=draft.accountId,profileId=xhsProfileId();
  try{const result=await api(`/api/xhs/drafts/${encodeURIComponent(id)}/retry`,{method:'POST',body:{accountId,profileId}});if(version===xhsLoadVersion)acceptXhs(result);notify('已重新准备这份草稿，可查看下方处理结果。');}
  catch(error){state.xhsError=error.message;notify(error.message,true);if(error.status===409){const previousAccount=xhsAccountId();await loadXhs({quiet:true});if(previousAccount===xhsAccountId())state.xhsError=error.message;}}
  finally{if(version===xhsLoadVersion)state.xhsBusy='';updateXhs();scheduleXhsPoll();}
}
async function recheckXhsDraft(id,{fromGuide=false}={}) {
  const p=state.guideProject,delivery=p?.xhsDelivery;
  const draft=(state.xhs?.drafts||[]).find(item=>item.id===id)||(fromGuide&&delivery?.draftId===id?delivery:null);
  if(!id||!xhsCanRecheck(draft)||xhsWorking()||(fromGuide&&guideWorkActive()))return;
  const record=xhsAccountRecord(draft.accountId);if(!xhsRecordConnected(record))return notify('请先检查原草稿账号的登录状态后再核验。',true);
  const version=guideCreationVersion,projectId=p?.id,accountId=draft.accountId;
  const requestVersion=++xhsLoadVersion;clearTimeout(xhsPollTimer);state.xhsBusy='recheck';state.xhsError='';if(fromGuide)state.guideActionBusy='xhs-recheck';updateXhs();
  try{
    const result=await api(`/api/xhs/drafts/${encodeURIComponent(id)}/recheck`,{method:'POST',body:{accountId}});if(requestVersion===xhsLoadVersion)acceptXhs(result);
    if(fromGuide&&version===guideCreationVersion&&state.guide.creation?.projectId===projectId)await loadGuideProject({quiet:true});
    notify(result.draft?.status==='verified'?'电脑草稿已重新核验。':'正在读取已有草稿进行核验，不会重新上传。');
  }catch(error){state.xhsError=error.message;notify(error.message,true);if(error.status===409)await loadXhs({quiet:true});}
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
function trendsView() {
  const snapshot=state.trends;
  const items=snapshot?.items||[], memes=snapshot?.memes||[], watchItems=[...new Map([...items,...memes].map(item=>[item.id,item])).values()], settings=snapshot?.settings||{enabled:true,intervalMinutes:30,keywords:[]};
  const available=snapshot?.platforms.filter(p=>p.itemCount>0).length||0;
  return `<section id="trends-page" class="trends-page" aria-label="当下热点"><div class="trends-topline"><div><span class="section-index">THE SOCIAL NOTE / 今日选题</span><span class="trends-overview">${snapshot?`${items.length} 条话题 · ${available} 个平台有榜单${memes.length?' · 热梗库 '+memes.length+' 条':''}`:'正在连接公开热榜'}</span></div><button class="button button-secondary" data-action="trends-refresh" ${state.trendsBusy||snapshot?.refreshing||state.trendsLoading?'disabled':''}>${snapshot?.refreshing||state.trendsBusy==='refresh'?'<span class="spinner spinner-small"></span>更新中':icon('refresh')+'更新热点'}</button></div>${state.trendsError?`<div class="trends-alert" role="alert">${icon('alert')}<span>${h(state.trendsError)}</span></div>`:''}${snapshot?.persistenceError?`<div class="trends-alert" role="alert">${icon('alert')}<span>本地缓存未保存：${h(snapshot.persistenceError)}</span></div>`:''}<div class="trend-sources">${TREND_PLATFORMS.map(trendSourceCard).join('')}</div><div class="trends-layout"><section class="trends-board"><div class="trends-board-heading"><div><span class="eyebrow">FIND YOUR NEXT STORY</span><h2>热点列表</h2></div><span id="trends-result-count">${filteredTrends().length} 条</span></div><div class="trends-toolbar"><div class="trends-platform-tabs" role="group" aria-label="筛选热点平台">${[{id:'all',name:'全部'},...TREND_PLATFORMS].map(p=>`<button data-action="trends-platform" data-platform="${p.id}" aria-pressed="${state.trendPlatform===p.id}" class="${state.trendPlatform===p.id?'active':''}">${p.name}</button>`).join('')}</div><div class="search-box trends-search">${icon('search')}<input id="trends-search" type="search" maxlength="100" value="${h(state.trendSearch)}" placeholder="搜索话题，例如：闪身步" aria-label="搜索已采集的热点标题"></div></div><div class="trends-scope" role="group" aria-label="筛选热点类型">${[['all','全部话题'],['watched','关注词命中'],['memes','热梗库 · 14天']].map(([id,label])=>`<button data-action="trends-scope" data-scope="${id}" aria-pressed="${state.trendScope===id}" class="${state.trendScope===id?'active':''}">${label}</button>`).join('')}<span>${state.trendScope==='memes'?'按本机首次收录保留 14 天；留存不代表持续火爆。':'各平台榜内排名交错展示，热度不跨平台比较。'}</span></div><div id="trends-results" class="trends-results" aria-live="polite">${trendsResults()}</div><div class="trends-board-footnote">${icon('file')}热榜是选题线索。创作前打开原内容，确认事实、热梗语境与时效。</div></section><aside class="trends-aside"><section class="trends-watch panel"><span class="section-index">01 / KEEP AN EYE ON</span><h2>关键词监控</h2><p>记下几个词，下次更新时一眼找到相关话题。</p><form id="trends-keywords-form"><label for="trends-keywords">关注关键词</label><textarea id="trends-keywords" rows="3" maxlength="2000" placeholder="例如：闪身步，AI，职场">${h(state.trendKeywordsDraft)}</textarea><div class="trends-keyword-help">用逗号或换行分隔，最多 20 个词。</div><button type="submit" class="button button-secondary" ${!snapshot||state.trendsBusy?'disabled':''}>${state.trendsBusy==='keywords'?'<span class="spinner spinner-small"></span>保存中':'保存关注词'}</button></form>${settings.keywords?.length?`<div class="trends-watch-tags">${settings.keywords.map(word=>{const count=watchItems.filter(item=>item.title.toLocaleLowerCase().includes(word.toLocaleLowerCase())).length;return `<span>${h(word)}<small>${count}</small></span>`;}).join('')}</div>`:''}<p class="trends-watch-note">匹配已采集热榜与留存期内的热梗标题；未命中不代表平台上没有相关内容。</p></section><section class="trends-schedule panel"><div class="trends-schedule-heading"><span class="section-index">02 / STAY UP TO DATE</span><span class="trends-schedule-status ${settings.enabled?'enabled':''}"><i></i>${!snapshot?'等待读取设置':settings.enabled?'定时更新中':'已暂停'}</span></div><h2>采集设置</h2><label for="trends-interval">更新间隔</label><div class="trends-interval-control"><select id="trends-interval" ${!snapshot||state.trendsBusy?'disabled':''}>${[15,30,60].map(value=>`<option value="${value}" ${(state.trendIntervalDraft??settings.intervalMinutes)===value?'selected':''}>每 ${value} 分钟</option>`).join('')}</select><button class="button button-secondary" data-action="trends-interval" ${!snapshot||state.trendsBusy?'disabled':''}>应用</button></div><div class="trends-next-refresh"><span>${snapshot?.refreshing?'当前状态':'下次更新'}</span><strong>${!snapshot?'等待读取设置':snapshot.refreshing?'正在获取各平台榜单…':settings.enabled?(snapshot?.nextRefreshAt?trendTime(snapshot.nextRefreshAt):'等待服务安排'):'定时更新已暂停'}</strong></div><button class="text-button trends-schedule-toggle" data-action="trends-toggle" ${!snapshot||state.trendsBusy?'disabled':''}>${settings.enabled?'暂停定时更新':'恢复定时更新'} ${icon('arrow')}</button><p>定时任务在本地服务运行时执行。关闭服务或电脑休眠期间不会更新，恢复后会补采集。</p></section><div class="trends-data-note"><span>关于这份热点</span><p>来自第三方公开热榜，可能存在缓存和延迟。所有时间均为北京时间，采集时间不代表榜单更新时间。</p><span class="trends-no-model">获取热榜不会调用你的模型 API。</span></div></aside></div></section>`;
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
    const hasFilters=Boolean(state.trendSearch.trim()||state.trendPlatform!=='all'||state.trendScope!=='all');
    return `<div class="trends-empty">${icon(hasFilters?'search':'chart')}<h3>${hasFilters?'暂未找到相关话题':'热点还在路上'}</h3><p>${hasFilters?(state.trendScope==='memes'?'热梗库保留本机首次收录后 14 天内的候选。试试其他词或平台，或更新榜单。':'试试其他词或平台。这里搜索的是已采集的榜单与热梗标题。'):state.trends?.refreshing?'正在采集各平台榜单，完成后会自动展示。':'可以点击更新热点；来源暂不可用时，查看上方状态。'}</p>${hasFilters?'<button class="text-button" data-action="trends-clear-filters">查看全部话题 ↗</button>':''}</div>`;
  }
  const rows=list.slice(0,state.trendLimit).map(item=>{
    const p=trendSource(item.platform), url=trendUrl(item.url), matches=trendMatches(item),meme=item.kind==='meme';
    const rank=Number.isInteger(item.rank)&&item.rank>0?String(item.rank).padStart(2,'0'):'—';
    return `<article class="trend-item" data-trend-id="${h(item.id)}"><div class="trend-rank ${item.rank<=3?'is-top':''}">${rank}</div><div class="trend-item-content"><div class="trend-item-meta"><span class="trend-platform-name platform-${h(item.platform)}">${h(trendName(item.platform))}</span>${item.isNew?'<span class="trend-new">新上榜</span>':''}${Number.isFinite(item.rankChange)&&item.rankChange>0?`<span class="trend-movement">↑ ${item.rankChange}</span>`:''}${meme?`<span class="trend-candidate">热梗候选 · 留存期内</span><span class="trend-time-unknown">${item.inCurrentBoard?'榜内候选':'已离榜 · 本机留存'}</span>`:p.status==='stale'?'<span class="trend-delay">旧榜单</span>':p.freshness==='unknown'?'<span class="trend-time-unknown">源时间未知</span>':''}${!meme&&trendCandidate(item)?'<span class="trend-candidate">热梗候选</span>':''}</div><h3>${url?`<a href="${h(url)}" target="_blank" rel="noopener noreferrer">${h(item.title)} <span>↗</span></a>`:h(item.title)}</h3>${item.description?`<p class="trend-item-description">${h(item.description)}</p>`:''}<div class="trend-item-detail">${item.heat!==null&&item.heat!==undefined&&item.heat!==''?`<span>平台热度 ${h(item.heat)}</span>`:''}<span>采集 ${trendTime(item.fetchedAt)}</span>${meme?`<span>源更新 ${item.sourceUpdatedAt?trendTime(item.sourceUpdatedAt):'未知'}</span><span>本机收录 ${trendTime(item.firstSeenAt)}</span><span class="trend-meme-expiry">至 ${trendTime(item.expiresAt)} 有效</span>`:''}${matches.map(word=>`<span class="trend-keyword-match">${h(word)}</span>`).join('')}</div></div><button class="trend-use-button" data-action="trends-use" data-id="${h(item.id)}" aria-label="以${h(item.title)}为主题去创作" ${state.guideBusy?'disabled':''}><span>聊聊这个</span>${icon('arrow')}</button></article>`;
  }).join('');
  return rows+(list.length>state.trendLimit?`<div class="trends-more"><button data-action="trends-more">再看 ${Math.min(24,list.length-state.trendLimit)} 条话题 · 还有 ${list.length-state.trendLimit} 条</button></div>`:'');
}
function updateTrendsResults() {
  const target=document.querySelector('#trends-results');if(target)target.innerHTML=trendsResults();
  const counter=document.querySelector('#trends-result-count');if(counter)counter.textContent=`${filteredTrends().length} 条`;
}
function renderTrends() {
  if(state.view!=='trends')return;
  const focused=document.activeElement, focusId=focused?.id;
  const selection=typeof focused?.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
  const scroll={x:window.scrollX,y:window.scrollY};
  render();
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
  guideRequestVersion++;guideCreationVersion++;guideProjectPollVersion++;clearTimeout(guideProjectPollTimer);state.guideProject=null;state.guide=blankGuidance();state.guide.input=input;state.guideEdit=null;resetGuideStyleFilters();saveGuidance();state.view='briefing';render();
  document.querySelector('#guide-input')?.focus();notify('选题已带入。补充你的想法，再点击“开始聊聊”。');
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
  return `<div class="history-row-actions ${card?'is-card':''}"><button type="button" class="text-button history-continue-chat" data-action="continue-chat" data-id="${h(project.id)}">${isActive(project)?'查看进度':project.pages?.length?'继续对话':'查看并继续'}</button><button type="button" class="icon-button history-delete" data-action="delete" data-id="${h(project.id)}" aria-label="删除 ${h(title)}" title="删除作品" ${isActive(project)?'disabled':''}>${icon('trash')}</button>${xhsEligible(project)?`<button type="button" class="text-button history-send-draft" data-action="xhs-for-project" data-id="${h(project.id)}">送入小红书草稿 ${icon('arrow')}</button>`:''}</div>`;
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
  const sizes=['1024x1536','1024x1024','1536x1024','1024x1792','1792x1024','auto'];
  if (c.size && !sizes.includes(c.size)) sizes.unshift(c.size);
  return `<section class="panel provider-panel"><div class="provider-heading"><span class="provider-icon">${icon(isImage?'image':'file')}</span><div><h2>${title}</h2><p>${description}</p></div><span class="key-status ${c.hasKey?'has-key':''}">${c.hasKey?'密钥已保存':'未配置密钥'}</span></div><label class="field-label" for="${kind}-baseUrl">API Base URL</label><input id="${kind}-baseUrl" name="${kind}.baseUrl" type="url" value="${h(c.baseUrl)}" placeholder="https://api.example.com/v1" required autocomplete="off"/><div class="model-label"><label class="field-label" for="${kind}-model">模型 ID</label><button type="button" class="text-button" data-action="load-models" data-kind="${kind}" ${state.busy ? 'disabled' : ''}>${buttonBusy(`models-${kind}`)}读取模型列表</button></div><input id="${kind}-model" name="${kind}.model" value="${h(c.model)}" list="${kind}-models" placeholder="输入中转站支持的模型 ID" required autocomplete="off"/><datalist id="${kind}-models">${state.models[kind].map(m=>`<option value="${h(m)}"></option>`).join('')}</datalist><label class="field-label" for="${kind}-apiKey">API Key</label><input id="${kind}-apiKey" name="${kind}.apiKey" type="password" placeholder="${c.hasKey?'已保存 · 留空保留现有密钥':'输入你的 API Key'}" autocomplete="new-password" spellcheck="false"/><p class="field-help">${c.hasKey?'已保存的密钥不会显示。需要更换时，填写新密钥并保存。':'密钥只提交给本地服务，请勿将本地配置文件对外分享。'}</p>${isImage?`<div class="settings-options"><div><label class="field-label" for="image-mode">图片接口格式</label><select id="image-mode" name="image.mode"><option value="images" ${c.mode==='images'?'selected':''}>Images · /images/generations</option><option value="chat" ${c.mode==='chat'?'selected':''}>Chat · /chat/completions</option></select></div><div><label class="field-label" for="image-size">默认图片尺寸</label><select id="image-size" name="image.size">${sizes.map(size=>`<option value="${h(size)}" ${c.size===size?'selected':''}>${h(size)}</option>`).join('')}</select></div></div><p class="field-help">部分生图模型通过 Chat 接口返回图片，请以你的中转站说明为准。</p>`:''}<div class="provider-footer"><button type="button" class="button button-secondary" data-action="test" data-kind="${kind}" ${state.busy || !c.hasKey ? 'disabled' : ''}>${buttonBusy(`test-${kind}`)||icon('bolt')}${isImage?'测试生图（可能计费）':'测试文本连接（可能计费）'}</button><span>使用已保存的配置</span></div>${result?`<div class="test-result ${result.ok?'success':'failure'}">${icon(result.ok?'check':'alert')}<span>${h(result.message)}</span></div>`:''}</section>`;
}

app.addEventListener('input', event => {
  const el=event.target;
  if(el.closest('#settings-form')){state.settingsRevision++;state.settingsDirty=true;captureSettingsDraft();updateSettingsDraftStatus();}
  if(el.dataset.radarSkipField&&state.radarSkipDrafts[el.dataset.opportunityId])state.radarSkipDrafts[el.dataset.opportunityId][el.dataset.radarSkipField]=el.value;
  if(el.closest('#dingtalk-config-form'))captureDingtalkDraft();
  if(el.id==='guide-input') {state.guide.input=el.value;saveGuidance();}
  if(el.id==='guide-style-search'){state.guideStyleSearch=el.value;updateGuideStyleResults();}
  if(el.id==='trends-search'){state.trendSearch=el.value;state.trendLimit=24;updateTrendsResults();}
  if(el.id==='trends-keywords'){state.trendKeywordsDraft=el.value;state.trendKeywordsDirty=true;}
  if(el.id==='xhs-account-name'&&state.xhsAccountEditor)state.xhsAccountEditor.accountName=el.value;
  if(el.id==='xhs-account-group'&&state.xhsAccountEditor)state.xhsAccountEditor.group=el.value;
  if(el.id==='xhs-note-search'){state.xhsNoteSearch=el.value;replaceXhsRegion('#xhs-notes-region',xhsNotesView());}
  if(el.id==='xhs-account-search'){state.xhsAccountSearch=el.value;replaceXhsRegion('#xhs-overview-results',xhsAccountsResultsView());}
  if(el.id==='xhs-draft-search'){state.xhsDraftSearch=el.value;replaceXhsRegion('#xhs-official-drafts-region',xhsOfficialDraftsView());replaceXhsRegion('#xhs-drafts-region',xhsDraftsView());}
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
  if(el.id==='guide-xhs-auto-delivery'){
    if(state.guide.creation)return;
    state.guide.xhsAutoDelivery=el.checked;if(el.checked&&state.guide.xhsTargetAccountId===null&&xhsAccountId())state.guide.xhsTargetAccountId=xhsAccountId();saveGuidance();renderGuidance({preserve:true});return;
  }
  if(el.id==='guide-xhs-target-account'){if(!state.guide.creation?.capture?.xhsAutoDelivery&&!state.guideProject?.xhsDelivery?.accountId){state.guide.xhsTargetAccountId=el.value;saveGuidance();renderGuidance({preserve:true});}return;}
  if(el.id==='history-page-size'){const size=Number(el.value);if(![12,24,48].includes(size))return;state.historyPageSize=size;state.historyPage=1;updateHistoryResults();return;}
  if(el.id==='history-sort'){if(!['updated','created'].includes(el.value))return;state.historySort=el.value;state.historyPage=1;updateHistoryResults();return;}
  if(el.id==='xhs-account-group-filter'){state.xhsAccountGroup=el.value;updateXhs();return;}
  if(el.id==='xhs-account-status-filter'){state.xhsAccountStatus=el.value;updateXhs();return;}
  if(el.id==='xhs-draft-sort'){if(['recent','oldest','title'].includes(el.value))state.xhsDraftSort=el.value;updateXhs();return;}
  if(el.id==='xhs-note-sort'){state.xhsNoteSort=el.value;replaceXhsRegion('#xhs-notes-region',xhsNotesView());return;}
  if(el.id==='xhs-note-limit'){state.xhsNoteLimit=Number(el.value)||50;return;}
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
  if(event.target.id==='xhs-account-form')await saveXhsAccountEditor();
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
    if(button.closest('.xhs-more-menu'))button.closest('.xhs-more-menu').open=false;
    if(action==='xhs-overview'){state.xhsSection='overview';rememberXhsLocation();updateXhs();return;}
    if(action==='xhs-clear-filters'){state.xhsAccountSearch='';state.xhsAccountGroup='all';state.xhsAccountStatus='all';const region=document.querySelector('#xhs-management-region');if(region)region.innerHTML=xhsManagementView();return;}
    if(action==='xhs-clear-draft-search'){state.xhsDraftSearch='';updateXhs();return;}
    if(action==='xhs-draft-source'){if(!['official','submissions'].includes(button.dataset.source))return;state.xhsDraftSource=button.dataset.source;updateXhs();return;}
    if(action==='xhs-account-add')openXhsAccountEditor();
    if(action==='xhs-account-edit')openXhsAccountEditor(button.dataset.profileId);
    if(action==='xhs-account-editor-close')closeXhsAccountEditor();
    if(action==='xhs-account-select')await selectXhsAccount(button.dataset.profileId,{tab:button.dataset.tab});
    if(action==='xhs-account-remove')await removeXhsAccount(button.dataset.profileId);
    if(action==='xhs-tab')switchXhsTab(button.dataset.tab);
    if(action==='xhs-detail')await openXhsDetail(kind,id,button);
    if(action==='xhs-detail-close')closeXhsDetail();
    if(action==='xhs-detail-read')await readXhsDetail();
    if(action==='xhs-detail-retry'&&state.xhsDetail){const current=state.xhsDetail;current.loading=true;current.error='';updateXhsDetail();await getXhsDetail(current,++xhsDetailRequestVersion);}
    if(action==='xhs-official-sync')await syncXhsOfficialDrafts();
    if(action==='xhs-official-open')await openXhsOfficialDraft(id);
    if(action==='xhs-reload')await loadXhs({quiet:Boolean(state.xhs),refreshProjects:true});
    if(action==='xhs-action')await runXhsAction(button.dataset.kind);
    if(action==='guide-xhs-action')await runXhsAction(button.dataset.kind,{accountId:guideTargetAccountId()});
    if(action==='guide-xhs-continue')await continueGuideXhsDelivery();
    if(action==='guide-xhs-version')await saveGuideXhsVersion();
    if(action==='guide-xhs-first')await saveGuideFirstXhsDraft(button.dataset.accountId);
    if(action==='guide-xhs-recheck')await recheckXhsDraft(id,{fromGuide:true});
    if(action==='xhs-for-project')await openXhsForProject(id);
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
app.addEventListener('load',event=>{if(event.target.matches?.('img[data-xhs-avatar]'))event.target.classList.add('is-loaded');},true);
app.addEventListener('error',event=>{if(event.target.matches?.('img[data-xhs-avatar]'))event.target.hidden=true;},true);
app.addEventListener('toggle',event=>{if(event.target.id==='xhs-missing-metrics')state.xhsMissingOpen=event.target.open;if(event.target.id==='xhs-composer-disclosure')state.xhsComposerOpen=event.target.open;},true);
document.addEventListener('click',event=>{document.querySelectorAll('.xhs-more-menu[open]').forEach(menu=>{if(!menu.contains(event.target))menu.open=false;});});
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;const menu=document.querySelector('.xhs-more-menu[open]');if(menu){menu.open=false;menu.querySelector('summary')?.focus();}});
app.addEventListener('cancel',event=>{if(event.target.id==='xhs-account-dialog'){event.preventDefault();closeXhsAccountEditor();}if(event.target.id==='xhs-detail-dialog'){event.preventDefault();closeXhsDetail();}},true);
app.addEventListener('click',event=>{const dialog=event.target;if(dialog.id==='xhs-account-dialog'){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeXhsAccountEditor();}if(dialog.id==='xhs-detail-dialog'){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeXhsDetail();}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.adminMenuOpen){event.preventDefault();toggleAdminMenu(false);}});
app.addEventListener('keydown',event=>{const tab=event.target.closest('.admin-provider-tabs [role=tab]');if(!tab)return;let kind;if(['ArrowRight','ArrowLeft'].includes(event.key))kind=tab.dataset.kind==='text'?'image':'text';if(event.key==='Home')kind='text';if(event.key==='End')kind='image';if(kind){event.preventDefault();switchSettingsProvider(kind);document.querySelector('#settings-tab-'+kind)?.focus();}});
app.addEventListener('keydown',event=>{const tab=event.target.closest('.xhs-tabs [role="tab"]');if(!tab)return;const ids=['analytics','published','drafts'],i=ids.indexOf(tab.dataset.tab);let next;if(event.key==='ArrowRight')next=(i+1)%ids.length;if(event.key==='ArrowLeft')next=(i+ids.length-1)%ids.length;if(event.key==='Home')next=0;if(event.key==='End')next=ids.length-1;if(next!==undefined){event.preventDefault();switchXhsTab(ids[next],{focus:true});}});
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
  if(state.view==='xhs')await loadXhs({refreshProjects:true});
  else if(state.view==='briefing')await loadXhs({quiet:true});
}
boot();
