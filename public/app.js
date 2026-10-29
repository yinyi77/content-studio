const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const lightbox = document.querySelector('#lightbox');
const GUIDE_STORAGE_KEY = 'content-studio:briefing:v1';
const GUIDE_STYLES = [
  {id:'notion',name:'手绘知识',description:'干净线条、浅色纸感，适合知识分享'},
  {id:'editorial',name:'杂志编辑',description:'清晰层级与留白，适合观点和产品介绍'},
  {id:'warm',name:'温暖生活',description:'柔和暖色，适合故事与日常分享'},
  {id:'bold',name:'醒目海报',description:'强烈对比和大标题，适合宣传与清单'},
  {id:'blueprint',name:'工程蓝图',description:'技术图解，适合流程和结构说明'},
  {id:'minimal',name:'极简留白',description:'简约克制，适合品牌与概念表达'},
];
const state = {
  view: new URLSearchParams(location.search).get('view') === 'trends' ? 'trends' : 'briefing', config: null, projects: [], project: null, draft: null,
  selectedPage: null, editorTab: 'outline', dirty: false, busy: '', search: '', filter: 'all',
  brief: { source: '', mode: 'cards', style: 'notion', aspect: '3:4', count: 5 },
  models: { text: [], image: [] }, testResults: {}, bootError: '',
  guide: restoreGuidance(), guideBusy: false, guideEdit: null,
  trends: null, trendsError: '', trendsLoading: false, trendsBusy: '',
  trendPlatform: 'all', trendSearch: '', trendScope: 'all', trendLimit: 24, trendKeywordsDraft: '', trendKeywordsDirty: false, trendIntervalDraft: null,
};
let pollTimer;
let pollVersion = 0;
let toastTimer;
let guideRequestVersion = 0;
let trendsPollTimer;
let trendsLoadVersion = 0;

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
const isActive = p => ['analyzing', 'generating'].includes(p?.status);
const canEdit = p => p && !isActive(p) && p.pages?.length > 0;
const hasImageEdits = () => Boolean(state.draft?.pages?.some(page => {
  const saved = state.project?.pages?.find(item => item.id === page.id);
  return !saved || ['title','content','prompt'].some(key => page[key] !== saved[key]);
}));
const statusText = status => ({analyzing:'分析内容中', draft:'方案待确认', generating:'图片生成中', completed:'已完成', partial:'部分完成', error:'任务失败', interrupted:'任务已中断'}[status] || '待处理');
const modeText = mode => ({cards:'多页图文', infographic:'信息图', cover:'封面海报'}[mode] || mode);
const time = date => date ? new Date(date).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
const buttonBusy = name => state.busy === name ? '<span class="spinner spinner-small"></span>' : '';

function blankGuidance() {
  return {messages:[],analysis:'',source:'',input:'',error:'',pending:false,
    matchTrends:true,trendMatches:null,selectedTrend:null,trendNotice:'',studioSource:'',
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
    base.messages=trimGuideMessages(data.messages.filter(m=>['user','assistant'].includes(m?.role)&&typeof m.content==='string'&&m.content.length<=24000));
    base.preferences=guidePreferences(data.preferences);
    const rec=guidePreferences(data.recommendations);
    for(const key of Object.keys(rec))if(rec[key]!==null)base.recommendations[key]=rec[key];
    for(const key of ['analysis','source','input','error'])if(typeof data[key]==='string')base[key]=data[key].slice(0,24000);
    if(data.reasons&&typeof data.reasons==='object')for(const key of ['style','aspect','count'])if(typeof data.reasons[key]==='string')base.reasons[key]=data.reasons[key].slice(0,1000);
    base.matchTrends=data.matchTrends!==false;
    base.trendMatches=normalizeGuideTrendMatches(data.trendMatches);
    if(base.matchTrends&&typeof data.selectedTrend?.id==='string'){
      const selected=base.trendMatches?.matches.find(item=>item.id===data.selectedTrend.id)||null;
      if(selected&&guideTrendUsable(selected))base.selectedTrend=selected;
      else if(selected)base.trendNotice='此前选择的热梗已满 14 天或缺少有效期，已移除，请重新匹配或按原主题继续。';
    }
    if(!base.trendNotice&&typeof data.trendNotice==='string')base.trendNotice=data.trendNotice.slice(0,500);
    if(typeof data.studioSource==='string')base.studioSource=data.studioSource.slice(0,24000);
    if(data.pending)base.error='上次分析未完成。你可以点击重试继续，不会自动重复请求模型。';
  }catch{/* A blocked or full session store should not prevent creation. */}
  return base;
}
function saveGuidance() {try{sessionStorage.setItem(GUIDE_STORAGE_KEY,JSON.stringify(state.guide));}catch{}}
const guideStyles = () => state.config?.styles?.length?state.config.styles:GUIDE_STYLES;
const guideTextReady = () => Boolean(state.config?.text?.hasKey&&state.config.text.baseUrl&&state.config.text.model);
const guideFieldLabel = field => ({style:'视觉风格',aspect:'画面比例',count:'图片张数'}[field]);
function guideValueLabel(field,value) {
  if(field==='style')return guideStyles().find(s=>s.id===value)?.name||value;
  if(field==='aspect')return ({'3:4':'3:4 · 竖版','1:1':'1:1 · 方形','16:9':'16:9 · 横版'}[value])||value;
  return `${value} 张`;
}
function currentGuideField() {
  if(state.guideEdit)return state.guideEdit;
  return ['style','aspect','count'].find(field=>state.guide.preferences[field]===null)||null;
}
function guidanceReady() {
  return Boolean(state.guide.source.trim()&&state.guide.analysis&&['style','aspect','count'].every(f=>state.guide.preferences[f]!==null));
}
function guideQuestion(field) {
  return {style:'你想要怎样的视觉风格？',aspect:'准备用什么画面比例？',count:'这次想做几张图片？'}[field];
}
function guidanceView() {
  const g=state.guide, ready=guidanceReady(), field=currentGuideField();
  const examples=['给新手做一组养猫准备清单','把产品介绍做成一组宣传图','做一张 AI 工作流知识图'];
  const thread=g.messages.length?`${g.messages.map(m=>`<article class="guide-message ${m.role==='user'?'user':'assistant'}"><span class="guide-message-label">${m.role==='user'?'你':'创意编辑'}</span><p>${h(m.content)}</p></article>`).join('')}${g.analysis?`<div class="guide-analysis"><span>我的内容分析</span><p>${h(g.analysis)}</p></div>`:''}`:`<div class="guide-welcome"><span class="eyebrow">LET'S FIND YOUR DIRECTION</span><h2>你想做点什么？</h2><p>一个主题、一段素材，甚至一个还没想完整的念头都可以。<br>我会先帮你分析，再一起确定画面的样子。</p><div class="guide-examples">${examples.map((example,i)=>`<button data-action="guide-example" data-example="${i}">${h(example)} <span>↗</span></button>`).join('')}</div></div>`;
  return `<div class="briefing-layout"><section class="briefing-panel" aria-label="创作需求对话"><div class="briefing-panel-heading"><span class="guide-avatar" aria-hidden="true">${icon('file')}</span><div><h2>创意编辑</h2><p>先聊清楚，再开始创作。</p></div><span class="guide-session-label">01 / DISCOVER</span></div><div class="guide-thread" role="log" aria-live="polite">${thread}${state.guideBusy?`<div class="guide-thinking"><span class="spinner spinner-small"></span>正在理解你的想法，整理内容方向…</div>`:''}${g.error?`<div class="guide-error" role="alert"><p>${h(g.error)}</p>${g.messages.some(m=>m.role==='user')?`<button class="text-button" data-action="guide-retry" ${state.guideBusy?'disabled':''}>重试这次分析</button>`:''}</div>`:''}${g.analysis&&!state.guideBusy&&!g.error?guideTrendMatchesView():''}${g.analysis&&!state.guideBusy&&!g.error?(field?guideQuestionView(field):`<div class="guide-ready">${icon('check')}创作方向已经明确，确认后就可以进入创作台。</div>`):''}</div><form id="guide-form" class="guide-composer"><label class="sr-label" for="guide-input">告诉创意编辑你想创作什么</label><textarea id="guide-input" maxlength="24000" rows="3" placeholder="${g.messages.length?'可以继续补充：面向职场新人、暖色、竖版、5 张…':'例如：我想做一组面向职场新人的 AI 提效指南…'}" ${state.guideBusy?'disabled':''}>${h(g.input)}</textarea><label class="guide-trends-toggle"><input id="guide-match-trends" type="checkbox" ${g.matchTrends?'checked':''} ${state.guideBusy?'disabled':''}><span>帮我匹配相关热点<small>分析时一起找，自主选择是否结合</small></span></label><div class="guide-composer-footer"><span>${g.messages.length?'按你的想法补充或修改，也可以点选上方选项。':'只需要说想做什么，暂时不用填其他参数。'}</span><button class="button button-primary" type="submit" ${state.guideBusy||!guideTextReady()?'disabled':''}>${state.guideBusy?'<span class="spinner spinner-small"></span>分析中':g.messages.length?'发送补充':'开始聊聊'} ${icon('arrow')}</button></div></form><div class="guide-model-note">${guideTextReady()?'分析使用你的文字模型；点选快捷选项不会额外调用模型。':`先连接文字模型即可开始分析。<button class="text-button" data-action="navigate" data-view="settings">去模型设置 ↗</button>`}</div></section><aside class="guide-summary panel"><span class="section-index">YOUR CREATIVE BRIEF</span><h2>这次的创作方向</h2><p>每确定一点，想法就更清楚一点。</p><div class="guide-summary-topic"><strong>内容主题</strong><p>${g.source?h(g.source.slice(0,360))+(g.source.length>360?'…':''):'等待你写下第一个想法。'}</p></div>${g.selectedTrend?`<div class="guide-summary-trend"><span>已选热点</span><strong>${h(g.selectedTrend.title)}</strong><small>${h(trendName(g.selectedTrend.platform))}${g.selectedTrend.kind==='meme'?` · 热梗候选，至 ${guideTrendDate(g.selectedTrend.expiresAt)} 有效`:''} · ${h(g.selectedTrend.angle)}</small><button class="text-button" data-action="guide-trend-clear" ${state.guideBusy?'disabled':''}>移除热点</button></div>`:''}<div class="guide-summary-list">${['style','aspect','count'].map(f=>`<div class="guide-summary-item"><div><span>${guideFieldLabel(f)}</span><strong>${g.preferences[f]!==null?h(guideValueLabel(f,g.preferences[f])):'待确认'}</strong>${g.analysis&&g.preferences[f]===null?`<small>建议：${h(guideValueLabel(f,g.recommendations[f]))}</small>`:''}</div>${g.analysis&&g.preferences[f]!==null&&!(f==='count'&&g.preferences.mode&&g.preferences.mode!=='cards')?`<button class="text-button" data-action="guide-edit" data-field="${f}" ${state.guideBusy||g.error?'disabled':''}>调整</button>`:''}</div>`).join('')}</div><div class="guide-progress"><span>${['style','aspect','count'].filter(f=>g.preferences[f]!==null).length} / 3 项已确认</span><div class="guide-progress-dots">${['style','aspect','count'].map(f=>`<i class="${g.preferences[f]!==null?'done':''}"></i>`).join('')}</div></div>${g.analysis&&!ready&&!g.error?`<button class="button button-secondary button-full" data-action="guide-accept" ${state.guideBusy?'disabled':''}>未选项采用建议</button>`:''}<button class="guide-handoff button button-primary button-full" data-action="guide-handoff" ${!ready||state.guideBusy||g.error?'disabled':''}>确认，进入创作台 ${icon('arrow')}</button><p class="guide-privacy">确认后会自动填好参数，进入创作台后仍可修改。图片由你点击生成。</p><button class="guide-reset text-button" data-action="guide-reset" ${state.guideBusy?'disabled':''}>${icon('refresh')}重新聊一个想法</button></aside></div>`;
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
  return `<section class="guide-trend-matches" aria-label="相关热点推荐"><div class="guide-trend-heading"><div><span class="section-index">A LITTLE OF THE NOW</span><h3>给这个想法，借一点当下</h3></div>${rematch}</div><p class="guide-trend-intro">找到 ${result.matches.length} 个可结合的选题。最多选一个，也可以按原主题继续。</p>${g.trendNotice?`<p class="guide-trend-notice" role="status">${h(g.trendNotice)}</p>`:''}<div class="guide-trend-cards">${result.matches.map(item=>{const selected=g.selectedTrend?.id===item.id,usable=guideTrendUsable(item);return `<article class="guide-trend-card ${selected?'selected':''}" data-guide-trend-id="${h(item.id)}"><div class="guide-trend-card-meta"><span>${h(trendName(item.platform))}${item.rank?` · ${item.kind==='meme'&&!item.inCurrentBoard?'最近采集榜内':'榜内'}第 ${item.rank} 位`:''}</span><span>${!usable?'已过期':selected?'已选中':h(item.provider||'公开热榜')}</span></div><h4>${item.url?`<a href="${h(item.url)}" target="_blank" rel="noopener noreferrer">${h(item.title)} <span>↗</span></a>`:h(item.title)}</h4>${item.kind==='meme'?`<p class="guide-trend-lifetime ${usable?'':'expired'}">热梗候选 · 至 ${guideTrendDate(item.expiresAt)} 有效<br><span>本机首次收录 ${guideTrendDate(item.firstSeenAt)}，保留 14 天；留存不代表持续火爆。</span></p>`:''}<div class="guide-trend-card-time">源更新 ${guideTrendDate(item.sourceUpdatedAt)} · 采集 ${guideTrendDate(item.fetchedAt)}（北京时间）</div><dl><div><dt>为什么相关</dt><dd>${h(item.reason)}</dd></div><div><dt>结合角度</dt><dd>${h(item.angle)}</dd></div></dl><button type="button" class="button ${selected?'button-secondary':'button-primary'} guide-trend-select" data-action="${selected?'guide-trend-clear':'guide-trend-select'}" data-id="${h(item.id)}" aria-pressed="${selected}" ${!usable?'disabled':''}>${!usable?'已过期，请重新匹配':selected?icon('check')+'已选，点击移除':'结合这个热点 '+icon('arrow')}</button></article>`;}).join('')}</div><div class="guide-trend-footer"><button class="text-button" data-action="guide-trend-clear">不结合热点，按原主题继续</button><span>选中不会额外调用模型；进入创作台时只带入你选的一个。</span></div><p class="guide-trend-facts">匹配依据是热榜标题，相关理由与结合角度是创作建议。创作前请核实原内容与热梗语境。</p></section>`;
}
function chooseGuideTrend(id) {
  const g=state.guide;if(state.guideBusy||!g.matchTrends)return;
  const match=g.trendMatches?.matches.find(item=>item.id===id);if(!match)return;
  if(!guideTrendUsable(match)){g.trendNotice='这个热梗已满 14 天或缺少有效期，请重新匹配。';saveGuidance();renderGuidance();return;}
  g.selectedTrend={...match};g.trendNotice='已选择这个热点，确认进入创作台时会结合到你的原主题中。';saveGuidance();renderGuidance({focusTrends:true});
}
function clearGuideTrend() {
  if(state.guideBusy)return;
  state.guide.selectedTrend=null;state.guide.trendNotice='这次按原主题继续，不结合热点。';saveGuidance();renderGuidance({focusTrends:true});
}
function guideSourceWithTrend(g) {
  let source=g.source;
  if(g.studioSource&&!source.includes(g.studioSource))source=g.studioSource.includes(source)?g.studioSource:`${source}\n\n【原始素材（完整保留）】\n${g.studioSource}`;
  const selected=g.matchTrends&&g.selectedTrend?g.trendMatches?.matches.find(item=>item.id===g.selectedTrend.id):null;
  if(!selected||!guideTrendUsable(selected))return source;
  return `${source}\n\n【用户已选热点】\n主题：${selected.title}${selected.kind==='meme'?`\n类型：热梗候选；本机首次收录 ${guideTrendDate(selected.firstSeenAt)}，至 ${guideTrendDate(selected.expiresAt)} 有效（北京时间）。14 天是本机留存窗口，不代表持续火爆。`:''}\n平台：${trendName(selected.platform)}${selected.rank?'，'+(selected.kind==='meme'&&!selected.inCurrentBoard?'最近采集榜内':'榜内')+'第 '+selected.rank+' 位':''}\n数据来源：${selected.provider||'公开热榜'}\n源更新时间：${guideTrendDate(selected.sourceUpdatedAt)}（北京时间；未知时需先核实）\n采集时间：${guideTrendDate(selected.fetchedAt)}（北京时间）\n原话题链接：${selected.url||'来源未提供，请先补充原内容'}\n为什么相关：${selected.reason}\n结合角度：${selected.angle}\n素材限制：用户原主题、完整素材与创作目标优先；只把这一个已选热点作为切入点或类比。热榜标题不是完整事实，理由与角度是创作建议，不是事实证据。请先核实原内容、时效和热梗语境，不编造热梗含义、出处、人物、经历或数据；不要加入未选择的热点。以上来源与限制供策划参考，不要直接当成图上文案。`;
}
async function matchTrendsFromStudio() {
  if(state.guideBusy)return notify('创作对话正在分析，请等待完成后再匹配热点。');
  if(state.busy||isActive(state.project))return notify('当前作品正在处理中，完成后再匹配热点。');
  const source=state.brief.source.trim();
  if(source.length<5)return notify('请先写下至少 5 个字的创作主题或素材，再匹配相关热点。',true);
  if(!guideTextReady())return notify('需要先在模型设置里配置文字模型，才能分析主题与热点的相关性。',true);
  const hasGuide=state.guide.messages.length||state.guide.source||state.guide.input.trim();
  if((state.dirty||hasGuide)&&!confirm(`${state.dirty?'创作台有未保存的修改。当前素材和参数将完整带入创作对话，确认交接时才替换作品方案。\n':''}${hasGuide?'已有创作对话及未发送的文字将被这次需求替换。\n':''}现在分析可结合的热点吗？会使用一次文字分析。`))return;
  const g=blankGuidance();g.input=source;g.studioSource=source;g.preferences=guidePreferences(state.brief);g.recommendations={...g.recommendations,...g.preferences};g.matchTrends=true;
  guideRequestVersion++;state.guide=g;state.guideEdit=null;state.view='briefing';saveGuidance();render();await sendGuidance();
}

function guideQuestionView(field) {
  const g=state.guide, rec=g.recommendations[field];
  const index=['style','aspect','count'].indexOf(field)+1;
  let options;
  if(field==='style')options=`<div class="guide-choices">${guideStyles().map(s=>`<button class="guide-choice ${s.id===rec?'recommended':''} ${s.id===g.preferences.style?'selected':''}" data-action="guide-choice" data-field="style" data-value="${h(s.id)}"><strong>${h(s.name)}</strong><small>${h(s.description)}</small>${s.id===rec?'<span class="choice-recommended">建议</span>':''}</button>`).join('')}</div>`;
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
function renderGuidance({focusTrends=false}={}) {
  if(state.view!=='briefing')return;
  render();
  requestAnimationFrame(()=>{const thread=document.querySelector('.guide-thread');if(!thread||!state.guide.messages.length)return;const target=focusTrends?thread.querySelector('.guide-trend-matches'):null;if(target&&thread.scrollHeight>thread.clientHeight+4)thread.scrollTop+=target.getBoundingClientRect().top-thread.getBoundingClientRect().top-18;else thread.scrollTop=thread.scrollHeight;});
}
async function sendGuidance({retry=false,rematch=false}={}) {
  if(state.guideBusy)return;
  if(!guideTextReady())return notify('请先配置文字模型，然后回来开始创作对话。',true);
  const g=state.guide;
  if(rematch){
    if(g.input.trim())return notify('还有未发送的补充，请先发送，再重新匹配热点。',true);
    if(!g.source.trim())return notify('请先说说你想创作什么，再匹配相关热点。');
    if(!g.messages.length)g.messages.push({role:'user',content:g.source});
    g.matchTrends=true;
    g.messages.push({role:'user',content:'请保留当前创作主题、完整素材和已确认的风格、比例、张数，重新检查当前榜单里有没有适合自然结合的热点。只推荐相关内容，找不到就按原主题继续，不要为了热点改变主题。'});
  }else if(!retry){const text=g.input.trim();if(!text)return notify('先写下你想创作什么。');g.messages.push({role:'user',content:text});g.input='';}
  if(g.messages.at(-1)?.role!=='user')return;
  const messages=trimGuideMessages(g.messages);
  g.messages=messages;
  const preferences={...g.preferences};
  g.error='';g.pending=true;state.guideBusy=true;state.guideEdit=null;
  let analyzed=false;
  const version=++guideRequestVersion;saveGuidance();renderGuidance();
  try{
    const result=await api('/api/brief/chat',{method:'POST',body:{messages,preferences,matchTrends:g.matchTrends}});
    if(version!==guideRequestVersion)return;
    if(typeof result.analysis!=='string'||typeof result.source!=='string'||!result.source.trim()||!result.recommendations)throw new Error('分析结果不完整，请重试。');
    g.analysis=result.analysis;g.source=result.source;g.preferences=guidePreferences(result.preferences);g.recommendations={...blankGuidance().recommendations,...result.recommendations};g.reasons=result.reasons||{};
    const previousTrend=g.selectedTrend;
    g.trendMatches=normalizeGuideTrendMatches(result.trendMatches)||{status:g.matchTrends?'unavailable':'disabled',checkedAt:null,candidateCount:0,excludedCount:0,matches:[],message:g.matchTrends?'这次没有收到热点匹配结果，可以按原主题继续，或稍后重新匹配。':'已关闭热点匹配，将按原主题继续。'};
    g.selectedTrend=g.matchTrends&&previousTrend?g.trendMatches.matches.find(item=>item.id===previousTrend.id&&guideTrendUsable(item))||null:null;
    g.trendNotice=previousTrend&&!g.selectedTrend?'主题分析已更新，之前选择的热点不再出现在匹配结果中，已移除。你可以重新选择或按原主题继续。':'';
    g.messages.push({role:'assistant',content:result.reply||'我已整理好内容方向，接下来一起确认画面的样子。'});
    g.messages=trimGuideMessages(g.messages);analyzed=true;
  }catch(error){if(version===guideRequestVersion)g.error=error.message;}
  finally{if(version===guideRequestVersion){g.pending=false;state.guideBusy=false;saveGuidance();renderGuidance({focusTrends:analyzed&&g.matchTrends});}}
}
function chooseGuidePreference(field,value) {
  if(state.guideBusy)return;
  const g=state.guide;
  if(!g.analysis)return;
  const parsed=guidePreferences({...g.preferences,[field]:field==='count'?Number(value):value});
  if(!['style','aspect','count'].includes(field)||parsed[field]===null)return notify('请选择支持的风格、比例或 1–10 张图片。',true);
  g.preferences=parsed;g.error='';state.guideEdit=null;
  const next=currentGuideField();
  g.messages.push({role:'user',content:`${guideFieldLabel(field)}：${guideValueLabel(field,parsed[field])}`},{role:'assistant',content:`好，采用「${guideValueLabel(field,parsed[field])}」。${next?'接下来确认一下'+guideFieldLabel(next)+'。':'创作参数已确认，可以进入创作台了。'}`});
  g.messages=trimGuideMessages(g.messages);saveGuidance();renderGuidance();
}
function acceptGuideRecommendations() {
  if(state.guideBusy||!state.guide.analysis)return;
  const g=state.guide;
  for(const f of ['style','aspect','count'])if(g.preferences[f]===null)g.preferences[f]=g.recommendations[f];
  g.preferences=guidePreferences(g.preferences);g.error='';state.guideEdit=null;
  g.messages.push({role:'user',content:'尚未选择的参数采用你的建议。'},{role:'assistant',content:'已经整理好创作方向。检查右侧的参数，确认后就可以进入创作台。'});
  g.messages=trimGuideMessages(g.messages);saveGuidance();renderGuidance();
}
function handoffGuidance() {
  if(state.guideBusy||!guidanceReady()||state.guide.error)return;
  if(state.dirty&&!confirm('创作台还有未保存的修改，确定带入这次的新创作需求吗？'))return;
  const g=state.guide,p=g.preferences;
  if(g.input.trim())return notify('还有未发送的补充，请先发送后再确认。',true);
  if(g.selectedTrend&&!guideTrendUsable(g.selectedTrend)){g.selectedTrend=null;g.trendNotice='已选热梗已满 14 天或缺少有效期，已移除。请重新匹配，或按原主题继续。';saveGuidance();renderGuidance();return notify(g.trendNotice,true);}
  const source=guideSourceWithTrend(g);
  if(source.length>24000)return notify('完整素材加上热点信息超过 24000 字，请先精简素材后再进入创作台。原素材仍保留在对话中。',true);
  state.brief={source,style:p.style,aspect:p.aspect,count:p.count,mode:p.mode||'cards'};
  state.project=null;state.draft=null;state.selectedPage=null;state.dirty=false;state.editorTab='outline';state.view='studio';
  clearTimeout(pollTimer);pollVersion++;saveGuidance();render();notify('创作需求已带入。检查后点击“生成内容方案”即可继续。');
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, ...(options.body !== undefined ? {body: JSON.stringify(options.body)} : {}) });
  } catch { throw new Error('无法连接本地服务，请确认工作台服务正在运行。'); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message || `请求失败（${response.status}）`);
  return payload;
}
function notify(message, error = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `toast ${error ? 'toast-error' : ''}`;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, error ? 6500 : 3500);
}
function setProject(project, {reset = false} = {}) {
  if (!project) return;
  const previous = state.project;
  if (previous?.id !== project.id) state.editorTab = 'outline';
  state.project = project;
  if (reset || !state.dirty) state.draft = structuredClone(project);
  if (reset) state.dirty = false;
  if (!project.pages?.some(p => p.id === state.selectedPage)) state.selectedPage = project.pages?.[0]?.id || null;
  const index = state.projects.findIndex(p => p.id === project.id);
  if (index < 0) state.projects.unshift(project);
  else state.projects[index] = project;
}
function beginPolling() {
  clearTimeout(pollTimer);
  const version = ++pollVersion;
  const run = async () => {
    if (version !== pollVersion || !state.project || !isActive(state.project)) return;
    const id = state.project.id;
    try {
      const {project} = await api(`/api/projects/${encodeURIComponent(id)}`);
      if (version !== pollVersion || state.project?.id !== id) return;
      const wasActive = isActive(state.project);
      setProject(project);
      if (state.view === 'studio' || state.view === 'history') render();
      if (wasActive && !isActive(project)) notify(project.status === 'completed' ? '作品生成完成，可以预览和下载了。' : project.status === 'draft' ? '内容方案已生成，请检查文案后开始出图。' : project.error || '任务已结束，请检查结果。', ['error', 'partial', 'interrupted'].includes(project.status));
    } catch (error) { notify(error.message, true); }
    if (version === pollVersion && isActive(state.project)) pollTimer = setTimeout(run, 1800);
  };
  if (isActive(state.project)) pollTimer = setTimeout(run, 1500);
}

function sidebar() {
  const links = [['briefing','创作对话','对话','01'],['studio','创作台','创作','02'],['trends','当下热点','热点','03'],['history','作品记录','作品','04'],['settings','模型设置','模型','05']];
  return `<header class="site-header"><a href="#" class="brand" data-action="navigate" data-view="briefing" aria-label="图文工坊首页"><span class="brand-glyph" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span>图文工坊<small>THE CONTENT ATELIER</small></span></a><nav class="main-nav" aria-label="主要导航">${links.map(([view,label,short,index]) => `<button class="nav-item ${state.view === view ? 'active' : ''}" data-action="navigate" data-view="${view}" aria-label="${label}" ${state.view === view ? 'aria-current="page"' : ''}><span class="nav-full-label">${label}</span><span class="nav-short-label">${short}</span><small>${index}</small>${view === 'history' && state.projects.length ? `<span class="nav-count">${state.projects.length}</span>` : ''}</button>`).join('')}</nav><div class="header-end"><span class="local-indicator"><i></i>本地工作空间</span><span class="avatar" aria-label="个人创作空间">我</span></div></header>`;
}
function header() {
  const labels = {
    briefing:['GOOD CONTENT STARTS WITH A CONVERSATION.','一个想法，<span>我们一起聊清楚<i>。</i></span>','先说想做什么，接下来的问题交给我。'],
    studio:['A LITTLE IDEA. A BEAUTIFUL STORY.','好想法，<span>值得好好表达<i>。</i></span>','把内容交给 AI，把创作的决定留给你。'],
    trends:['A PULSE OF WHAT PEOPLE ARE TALKING ABOUT.','捕捉当下，<span>找到新的灵感<i>。</i></span>','看看大家正在聊什么，把好话题变成你的内容。'],
    history:['YOUR CREATIVE COLLECTION','让作品，<span>慢慢积累<i>。</i></span>','每一次认真表达，都值得留下。'],
    settings:['TOOLS FOR YOUR NEXT IDEA','让工具，<span>顺手起来<i>。</i></span>','连接你自己的文字与图片模型。'],
  };
  const [eyebrow, title, sub] = labels[state.view];
  const modelReady=state.view==='trends'?Boolean(state.trends?.items?.length):state.view==='briefing'?guideTextReady():state.config?.configured;
  const modelLabel=state.view==='trends'?'公开热榜 · 无需模型':state.view==='briefing'?(modelReady?'文字模型已配置':'等待配置文字模型'):(modelReady?'模型已配置':'等待配置模型');
  return `<header class="page-header"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${sub}</p></div><div class="header-actions"><span class="connection ${modelReady ? 'connected' : ''}"><i></i>${modelLabel}</span>${state.view === 'briefing' ? `<button class="button button-secondary" data-action="navigate" data-view="studio">直接去创作台 <span>↗</span></button>` : state.view !== 'settings' ? `<button class="button button-ink" data-action="new">${icon('plus')}新建创作<span class="button-arrow">↗</span></button>` : ''}</div></header>`;
}
function render() {
  if(state.view!=='trends')clearTimeout(trendsPollTimer);
  app.innerHTML = `<div class="app-shell view-${state.view}">${sidebar()}<main class="main">${header()}${state.bootError ? `<div class="banner banner-error">${icon('alert')}<span>${h(state.bootError)}</span><button class="text-button" data-action="reload">重试连接</button></div>` : ''}${state.view === 'briefing' ? guidanceView() : state.view === 'studio' ? studio() : state.view === 'trends' ? trendsView() : state.view === 'history' ? historyView() : settingsView()}<footer class="main-footer"><span>图文工坊 <i>©</i> ${new Date().getFullYear()}</span><span>一个给好内容的创作空间。</span><span>MADE FOR YOUR NEXT IDEA.</span></footer></main></div>`;
}
function studio() {
  const p = state.project;
  const documentTitle = state.draft?.title || p?.title || '一份新的好内容';
  const title = p && canEdit(p) ? `<input class="workspace-title-input" data-edit="project-title" aria-label="作品标题" value="${h(documentTitle)}" maxlength="200"/>` : `<span>${h(documentTitle)}</span>`;
  return `${!state.config?.configured ? `<div class="banner">${icon('bolt')}<span>连接你的模型 API，即可开始图文创作。</span><button class="text-button" data-action="navigate" data-view="settings">去设置 ${icon('arrow')}</button></div>` : ''}<section class="editor-studio" aria-label="图文创作工作台"><div class="workspace-heading"><div class="document-name">${icon('file')}${title}<span class="workspace-tag ${p ? `badge badge-${h(p.status)}` : ''}">${p ? statusText(p.status) : '新创作'}</span></div><div class="save-state"><i></i>${p ? time(p.updatedAt) + ' 更新' : '从一个想法开始'}</div></div><div class="studio-grid">${briefPanel()}<section class="canvas-panel">${p ? projectPanel() : emptyCanvas()}</section></div></section><section class="below-editor"><div><span class="micro-cross" aria-hidden="true">＋</span><p>灵感不必完整，<em>开始就很好。</em></p></div><span>CONCEIVED BY YOU. CRAFTED WITH AI.</span><button class="text-button" data-action="navigate" data-view="history">看看最近的作品 <span>↗</span></button></section>`;
}
function briefPanel() {
  const b = state.brief;
  const locked = isActive(state.project) || state.busy === 'create';
  const completedClean = state.project?.status === 'completed' && !state.dirty;
  const styleOptions = state.config?.styles?.length ? state.config.styles : [{id:'notion',name:'手绘知识',description:'干净线条、浅色纸感，适合知识分享'},{id:'editorial',name:'杂志编辑',description:'清晰层级与留白，适合观点或产品介绍'},{id:'warm',name:'温暖生活',description:'柔和暖色，适合故事与日常分享'},{id:'bold',name:'醒目海报',description:'强烈对比和大标题，适合宣传与清单'},{id:'blueprint',name:'工程蓝图',description:'技术图解，适合流程和结构说明'},{id:'minimal',name:'极简留白',description:'简约克制，适合品牌与概念表达'}];
  return `<section class="brief-panel panel"><div class="panel-heading"><span class="section-number">01</span><h2>创作简报</h2><span class="muted">从内容开始</span></div><form id="brief-form"><fieldset ${locked ? 'disabled' : ''}><label class="field-label" for="source">想要创作什么？<button type="button" class="text-button" data-action="sample">试试示例</button></label><textarea id="source" name="source" class="source-input" placeholder="输入一个主题、一段文章或产品介绍…&#10;&#10;例如：给第一次养猫的人，做一组实用的准备清单。" required minlength="5" maxlength="24000">${h(b.source)}</textarea><div class="input-note"><span>内容越具体，生成效果越贴近你的想法</span><span id="source-count">${b.source.length}</span></div><label class="field-label">内容形式</label><div class="mode-options">${[['cards','cards','多页图文'],['infographic','chart','信息图'],['cover','image','封面海报']].map(([id,i,name]) => `<label class="mode-option ${b.mode === id ? 'selected' : ''}"><input type="radio" name="mode" value="${id}" ${b.mode === id ? 'checked' : ''}/>${icon(i)}<span>${name}</span></label>`).join('')}</div><label class="field-label" for="style">视觉风格</label><select id="style" name="style">${styleOptions.map(s => `<option value="${h(s.id)}" ${b.style === s.id ? 'selected' : ''}>${h(s.name)}${s.description ? ' · ' + h(s.description) : ''}</option>`).join('')}</select><div class="brief-options"><div><label class="field-label" for="aspect">图片比例</label><select id="aspect" name="aspect">${[['3:4','3:4 · 竖版'],['1:1','1:1 · 方形'],['16:9','16:9 · 横版']].map(([v,l]) => `<option value="${v}" ${b.aspect === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div><label class="field-label" for="count">图片张数</label><div class="count-input"><button type="button" data-action="count" data-delta="-1" aria-label="减少张数" ${b.mode !== 'cards' ? 'disabled' : ''}>−</button><input id="count" name="count" type="number" min="1" max="10" value="${b.mode === 'cards' ? b.count : 1}" ${b.mode !== 'cards' ? 'disabled' : ''}/><button type="button" data-action="count" data-delta="1" aria-label="增加张数" ${b.mode !== 'cards' ? 'disabled' : ''}>+</button></div></div></div><p class="field-help ratio-note">比例为构图目标，实际像素尺寸以模型输出为准。</p><div class="brief-trend-entry"><button type="button" class="text-button" data-action="guide-from-studio" ${locked||state.guideBusy?'disabled':''}>${icon('search')}先匹配相关热点 ${icon('arrow')}</button><p>${guideTextReady()?'可选：使用一次文字分析，选中后再带入方案。':'需要先配置文字模型，再分析可结合的热点。'}</p></div><div class="brief-divider"></div><button type="submit" class="button ${completedClean ? 'button-secondary' : 'button-primary'} button-full" ${!state.config?.configured || locked ? 'disabled' : ''}>${buttonBusy('create') || icon('spark')}${state.busy === 'create' ? '正在创建…' : '生成内容方案'}${icon('arrow')}</button><p class="form-help">先生成拆页与文案，确认后再调用图片模型。</p></fieldset></form><div class="brief-bottom">${icon('lock')}API 密钥由本地服务保存</div></section>`;
}
function emptyCanvas() {
  return `<div class="empty-studio"><div class="canvas-topline"><span>${icon('image')}创作画布</span><span class="mini-label">等待你的第一个想法</span></div><div class="empty-art" aria-hidden="true"><div class="paper paper-back"></div><div class="paper paper-front"><span class="empty-paper-label">THE CREATOR'S NOTE</span><div class="empty-paper-title">把想法，<br>好好表达。</div><i></i><i></i><span class="empty-paper-mark">↗</span></div><span class="art-dot dot-one"></span><span class="art-dot dot-two"></span></div><div class="empty-copy"><span class="eyebrow">MAKE SOMETHING WORTH SHARING</span><h2>从一个想法，<br>开始一份作品。</h2><p>写下主题或粘贴素材，先梳理内容与画面，<br>确认后再生成属于你的图文。</p></div><div class="workflow"><div><span>01</span><strong>输入内容</strong><small>给创作一个起点</small></div><i>→</i><div><span>02</span><strong>确认方案</strong><small>文案与视觉由你把关</small></div><i>→</i><div><span>03</span><strong>生成作品</strong><small>预览、调整、下载</small></div></div><div class="canvas-footnote">${icon('file')}生成后的图片会保存在这里，当前尚无生成结果。</div></div>`;
}
function projectPanel() {
  const p = state.project;
  const draft = state.draft || p;
  const pages = draft.pages || [];
  const done = p.pages?.filter(page => page.status === 'done').length || 0;
  const active = isActive(p);
  const editable = canEdit(p);
  const imageEdits = hasImageEdits();
  const page = pages.find(page => page.id === state.selectedPage) || pages[0];
  const currentIndex = pages.findIndex(item => item.id === page?.id);
  const editorMode = state.editorTab === 'preview' ? 'preview' : 'outline';
  const tabs = pages.length ? `<div class="project-toolbar"><div class="editor-tabs" role="tablist" aria-label="创作工作区视图">${[['outline','图文编辑'],['preview','大图预览']].map(([tab,label]) => `<button id="editor-tab-${tab}" class="editor-tab ${editorMode === tab ? 'active' : ''}" role="tab" aria-selected="${editorMode === tab}" aria-controls="page-detail-panel" data-action="editor-tab" data-tab="${tab}">${label}</button>`).join('')}</div><span class="editor-page-indicator">${String(currentIndex + 1).padStart(2,'0')} / ${String(pages.length).padStart(2,'0')}</span></div>` : '';
  const rail = `<div class="page-rail" aria-label="页面选择">${pages.map((item,index) => `<button class="page-thumb ${item.id === page?.id ? 'selected' : ''}" data-action="select-page" data-id="${h(item.id)}" aria-label="第 ${index + 1} 页：${h(item.title)}" aria-pressed="${item.id === page?.id}"><div class="thumb-preview" data-aspect="${h(p.aspect)}">${item.imageUrl ? `<img src="${h(item.imageUrl)}" alt="第 ${index+1} 页缩略图"/>` : `<span class="thumb-number">${String(index+1).padStart(2,'0')}</span><span class="thumb-title">${h(item.title)}</span>`}${item.status === 'generating' ? '<span class="thumb-generating"><span class="spinner"></span></span>' : ''}</div><span class="thumb-label"><span>${String(index+1).padStart(2,'0')} · ${h(item.title)}</span><i class="page-dot page-dot-${h(item.status)}"></i></span></button>`).join('')}</div>`;
  const content = p.status === 'analyzing' ? analysisState(p) : pages.length ? `${tabs}<div class="page-workspace ${editorMode}-mode"><div id="page-detail-panel" class="page-detail" role="tabpanel" aria-labelledby="editor-tab-${editorMode}">${page ? pageDetail(page, p) : ''}</div>${rail}</div>${page ? imageCopyPanel(page, p) : ''}<div class="project-actionbar"><div><span class="section-index">02 / CREATE</span><span class="action-hint">${active ? `${done}/${pages.length} 张已完成，请保持服务运行` : state.dirty ? (imageEdits ? '图片内文字有修改，保存后可重新生成' : '帖子内容有修改，保存即可更新') : p.status === 'completed' ? '作品已就绪，点击图片可查看大图' : '确认文案后，开始生成图片'}</span></div><div class="action-buttons">${editable ? `<button class="button button-secondary" data-action="save" ${state.busy ? 'disabled' : ''}>${buttonBusy('save') || icon('check')}保存方案</button>` : ''}${done && !active ? `<a class="button ${p.status === 'completed' ? 'button-ink' : 'button-secondary'}" href="/api/projects/${encodeURIComponent(p.id)}/export.zip" download>${icon('download')}打包下载</a>` : ''}${!active ? `<button class="button button-primary" data-action="generate" ${state.busy || (done === pages.length && !imageEdits) ? 'disabled' : ''}>${buttonBusy('generate') || icon('spark')}${done === pages.length && !imageEdits ? '全部已生成' : state.dirty ? '保存并生成图片' : done ? '生成剩余图片' : '开始生成图片'}</button>` : `<button class="button button-primary" disabled><span class="spinner spinner-small"></span>正在生成图片</button>`}</div></div>` : `<div class="failed-empty">${icon('alert')}<h3>${p.status === 'interrupted' ? '任务已中断' : '暂时没有生成方案'}</h3><p>请检查模型配置和错误信息，然后重试内容分析。</p><button class="button button-primary" data-action="reanalyze" ${state.busy ? 'disabled' : ''}>${icon('refresh')}重新分析内容</button></div>`;
  return `<div class="project-panel"><div class="project-heading"><div class="project-subline"><span class="project-meta">${h(modeText(p.mode))} · ${h(p.aspect)}${pages.length ? ` · ${pages.length} 张` : ''}</span><span>${time(p.createdAt)} 创建</span><span class="dirty-status ${state.dirty ? 'visible' : ''}" id="dirty-status">有未保存的修改</span>${pages.length ? `<span class="completion-count">${done}/${pages.length} 张已生成</span>` : ''}</div></div>${p.error ? `<div class="project-error">${icon('alert')}<span>${h(p.error)}</span></div>` : ''}${content}${logsPanel(p)}</div>`;
}

function analysisState(p) {
  return `<div class="analysis-state"><div class="analysis-orb">${icon('spark')}</div><h3>正在把你的想法整理成方案</h3><p>理解内容、梳理结构、设计逐页文案与画面提示词…</p><div class="analysis-progress"><span></span></div><small>文本模型正在处理中，完成后会自动展示。</small></div>`;
}
function pageDetail(page, project) {
  const editable = canEdit(project);
  const index = (state.draft?.pages || project.pages || []).findIndex(p => p.id === page.id);
  const image = page.imageUrl ? `<button class="image-preview" data-action="preview" data-id="${h(page.id)}" data-aspect="${h(project.aspect)}" aria-label="查看第 ${index+1} 页完整图片"><img src="${h(page.imageUrl)}" alt="${h(page.title || '生成的图文作品')}"/><span>${icon('expand')}点击查看大图</span></button>` : page.status === 'generating' ? `<div class="image-generating" data-aspect="${h(project.aspect)}"><span class="spinner"></span><strong>正在绘制第 ${index+1} 张</strong><p>图片生成可能需要几分钟，请耐心等待。</p></div>` : `<div class="image-generating image-pending" data-aspect="${h(project.aspect)}">${icon('image')}<span class="section-index">PAGE ${String(index+1).padStart(2,'0')}</span><strong>${h(page.title)}</strong><p>${page.status === 'error' ? '这张图片尚未完成，可以单独重试。' : '确认内容方案后，生成这页的图文。'}</p><span class="pending-note">图片尚未生成</span></div>`;
  return `<div class="detail-topbar"><span class="detail-page-label">PAGE ${String(index + 1).padStart(2,'0')}</span><div>${page.imageUrl ? `<a class="icon-button" title="下载这张图片" aria-label="下载这张图片" href="${h(page.imageUrl)}" download="${h(project.id)}-${index+1}.${h(page.imageUrl.split('.').pop())}">${icon('download')}</a><button class="icon-button" title="查看大图" aria-label="查看大图" data-action="preview" data-id="${h(page.id)}">${icon('expand')}</button>` : ''}${editable ? `<button class="text-button" data-action="regenerate" data-id="${h(page.id)}" ${state.busy ? 'disabled' : ''}>${icon('refresh')}${page.imageUrl ? '重新生成' : page.status === 'error' ? '重试这张' : '生成这张'}</button>` : ''}</div></div>${page.error ? `<div class="inline-error">${h(page.error)}</div>` : ''}<div class="page-content-layout"><section class="page-visual-panel" aria-label="第 ${index+1} 页图片"><div class="preview-stage">${image}</div><p class="page-visual-caption">${page.imageUrl ? '点击图片查看大图' : page.status === 'generating' ? '图片完成后会展示在这里' : '确认文案后，生成这页图片'}</p></section>${captionPanel(state.draft || project, editable)}</div>`;
}
function captionPanel(p, editable) {
  return `<section class="page-copy-panel post-copy-panel" aria-label="帖子内容文案"><div class="page-copy-heading"><span class="eyebrow">POST CONTENT</span><textarea id="post-title" class="post-title-input" aria-label="帖子标题" data-edit="project-title" rows="2" maxlength="200" placeholder="填写帖子标题" ${!editable ? 'disabled' : ''}>${h(p.title)}</textarea></div><div class="post-copy-toolbar"><label class="field-label" for="post-caption">帖子正文</label><button type="button" class="text-button" data-action="copy-caption">${icon('copy')}复制文案</button></div><textarea id="post-caption" aria-label="帖子文案" data-edit="caption" rows="14" maxlength="12000" placeholder="在这里编辑发布帖子的正文和话题标签…" ${!editable ? 'disabled' : ''}>${h(p.caption)}</textarea><p class="field-help">发布时配在图片旁边的内容。修改这里不会改变图片内的文字。</p></section>`;
}
function imageCopyPanel(page, project) {
  const editable = canEdit(project);
  const index = (state.draft?.pages || project.pages || []).findIndex(p => p.id === page.id);
  const editor = `<div class="page-editor ${page.imageUrl ? 'has-image' : ''}"><label class="field-label" for="page-title">标题</label><input id="page-title" data-edit="title" data-page="${h(page.id)}" value="${h(page.title)}" ${!editable ? 'disabled' : ''}/><label class="field-label" for="page-content">正文</label><textarea id="page-content" data-edit="content" data-page="${h(page.id)}" rows="6" ${!editable ? 'disabled' : ''}>${h(page.content)}</textarea><p class="field-help">这里的文字会出现在图片中。修改后，保存并重新生成即可更新画面。</p></div>`;
  const advanced = `<details class="advanced-settings prompt-details"><summary>高级设置 <span>画面提示词</span></summary><div class="advanced-settings-body"><label class="field-label" for="page-prompt">画面提示词</label><textarea id="page-prompt" aria-label="画面提示词" class="prompt-input" data-edit="prompt" data-page="${h(page.id)}" rows="6" ${!editable ? 'disabled' : ''}>${h(page.prompt)}</textarea><p class="field-help">需要调整构图、配色或细节时再修改。图片中的文字仍以标题和正文为准。</p></div></details>`;
  return `<details class="image-copy-panel" open><summary><span>图片内文字</span><small>第 ${index+1} 页 · 标题与正文</small></summary>${editor}${advanced}</details>`;
}

function logsPanel(p) {
  if (!p.logs?.length) return '';
  return `<details class="logs-panel"><summary>任务动态<span>${p.logs.length} 条记录</span></summary><div class="log-list">${p.logs.slice(-25).reverse().map(log => `<div><time>${time(log.at)}</time><span>${h(log.message)}</span></div>`).join('')}</div></details>`;
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
  return `<section id="trends-page" class="trends-page" aria-label="当下热点"><div class="trends-topline"><div><span class="section-index">THE SOCIAL NOTE / 今日选题</span><span class="trends-overview">${snapshot?`${items.length} 条话题 · ${available} 个平台有榜单${memes.length?' · 热梗库 '+memes.length+' 条':''}`:'正在连接公开热榜'}</span></div><button class="button button-secondary" data-action="trends-refresh" ${state.trendsBusy||snapshot?.refreshing||state.trendsLoading?'disabled':''}>${snapshot?.refreshing||state.trendsBusy==='refresh'?'<span class="spinner spinner-small"></span>更新中':icon('refresh')+'更新热点'}</button></div>${state.trendsError?`<div class="trends-alert" role="alert">${icon('alert')}<span>${h(state.trendsError)}</span></div>`:''}${snapshot?.persistenceError?`<div class="trends-alert" role="alert">${icon('alert')}<span>本地缓存未保存：${h(snapshot.persistenceError)}</span></div>`:''}<div class="trend-sources">${TREND_PLATFORMS.map(trendSourceCard).join('')}</div><div class="trends-layout"><section class="trends-board"><div class="trends-board-heading"><div><span class="eyebrow">FIND YOUR NEXT STORY</span><h2>大家正在聊什么</h2></div><span id="trends-result-count">${filteredTrends().length} 条</span></div><div class="trends-toolbar"><div class="trends-platform-tabs" role="group" aria-label="筛选热点平台">${[{id:'all',name:'全部'},...TREND_PLATFORMS].map(p=>`<button data-action="trends-platform" data-platform="${p.id}" aria-pressed="${state.trendPlatform===p.id}" class="${state.trendPlatform===p.id?'active':''}">${p.name}</button>`).join('')}</div><div class="search-box trends-search">${icon('search')}<input id="trends-search" type="search" maxlength="100" value="${h(state.trendSearch)}" placeholder="搜索话题，例如：闪身步" aria-label="搜索已采集的热点标题"></div></div><div class="trends-scope" role="group" aria-label="筛选热点类型">${[['all','全部话题'],['watched','关注词命中'],['memes','热梗库 · 14天']].map(([id,label])=>`<button data-action="trends-scope" data-scope="${id}" aria-pressed="${state.trendScope===id}" class="${state.trendScope===id?'active':''}">${label}</button>`).join('')}<span>${state.trendScope==='memes'?'按本机首次收录保留 14 天；留存不代表持续火爆。':'各平台榜内排名交错展示，热度不跨平台比较。'}</span></div><div id="trends-results" class="trends-results" aria-live="polite">${trendsResults()}</div><div class="trends-board-footnote">${icon('file')}热榜是选题线索。创作前打开原内容，确认事实、热梗语境与时效。</div></section><aside class="trends-aside"><section class="trends-watch panel"><span class="section-index">01 / KEEP AN EYE ON</span><h2>留意你感兴趣的</h2><p>记下几个词，下次更新时一眼找到相关话题。</p><form id="trends-keywords-form"><label for="trends-keywords">关注关键词</label><textarea id="trends-keywords" rows="3" maxlength="2000" placeholder="例如：闪身步，AI，职场">${h(state.trendKeywordsDraft)}</textarea><div class="trends-keyword-help">用逗号或换行分隔，最多 20 个词。</div><button type="submit" class="button button-secondary" ${!snapshot||state.trendsBusy?'disabled':''}>${state.trendsBusy==='keywords'?'<span class="spinner spinner-small"></span>保存中':'保存关注词'}</button></form>${settings.keywords?.length?`<div class="trends-watch-tags">${settings.keywords.map(word=>{const count=watchItems.filter(item=>item.title.toLocaleLowerCase().includes(word.toLocaleLowerCase())).length;return `<span>${h(word)}<small>${count}</small></span>`;}).join('')}</div>`:''}<p class="trends-watch-note">匹配已采集热榜与留存期内的热梗标题；未命中不代表平台上没有相关内容。</p></section><section class="trends-schedule panel"><div class="trends-schedule-heading"><span class="section-index">02 / STAY UP TO DATE</span><span class="trends-schedule-status ${settings.enabled?'enabled':''}"><i></i>${!snapshot?'等待读取设置':settings.enabled?'定时更新中':'已暂停'}</span></div><h2>让灵感，持续更新</h2><label for="trends-interval">更新间隔</label><div class="trends-interval-control"><select id="trends-interval" ${!snapshot||state.trendsBusy?'disabled':''}>${[15,30,60].map(value=>`<option value="${value}" ${(state.trendIntervalDraft??settings.intervalMinutes)===value?'selected':''}>每 ${value} 分钟</option>`).join('')}</select><button class="button button-secondary" data-action="trends-interval" ${!snapshot||state.trendsBusy?'disabled':''}>应用</button></div><div class="trends-next-refresh"><span>${snapshot?.refreshing?'当前状态':'下次更新'}</span><strong>${!snapshot?'等待读取设置':snapshot.refreshing?'正在获取各平台榜单…':settings.enabled?(snapshot?.nextRefreshAt?trendTime(snapshot.nextRefreshAt):'等待服务安排'):'定时更新已暂停'}</strong></div><button class="text-button trends-schedule-toggle" data-action="trends-toggle" ${!snapshot||state.trendsBusy?'disabled':''}>${settings.enabled?'暂停定时更新':'恢复定时更新'} ${icon('arrow')}</button><p>定时任务在本地服务运行时执行。关闭服务或电脑休眠期间不会更新，恢复后会补采集。</p></section><div class="trends-data-note"><span>关于这份热点</span><p>来自第三方公开热榜，可能存在缓存和延迟。所有时间均为北京时间，采集时间不代表榜单更新时间。</p><span class="trends-no-model">获取热榜不会调用你的模型 API。</span></div></aside></div></section>`;
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
  if(state.guideBusy)return notify('创作对话正在分析，请等它完成后再带入热点。');
  const item=[...(state.trends?.memes||[]),...(state.trends?.items||[])].find(item=>item.id===id);if(!item)return;
  if(!guideTrendUsable(item))return notify('这个热梗已过留存期，请更新榜单或选择其他话题。',true);
  if(state.dirty&&!confirm('创作台有未保存的修改。先进入创作对话选题？原方案会保留。'))return;
  const g=state.guide, p=trendSource(item.platform), url=trendUrl(item.url),sourceUpdatedAt=item.sourceUpdatedAt||p.sourceUpdatedAt;
  const input=`我想围绕「${item.title}」创作图文，请先帮我分析适合的内容方向，再问我风格、比例和图片张数。\n\n选题线索：${trendName(item.platform)}${item.kind==='meme'?'热梗候选':'热榜话题'}，${item.kind==='meme'&&!item.inCurrentBoard?'最近采集榜内':'榜内'}第 ${item.rank} 位。\n${url?'原内容链接：'+url+'\n':''}采集时间：${trendTime(item.fetchedAt)}（北京时间）。\n榜单源更新时间：${sourceUpdatedAt?trendTime(sourceUpdatedAt)+'（北京时间）':'未知，采集时间不代表榜单新鲜度'}。${p.status==='stale'?'\n注意：当前是缓存或延迟榜单，请先确认时效。':''}\n\n${item.kind==='meme'?`这是热梗候选，本机首次收录 ${trendTime(item.firstSeenAt)}，保留至 ${trendTime(item.expiresAt)}；14 天是本机留存窗口，不代表持续火爆。\n`:''}这只是热榜标题线索。请提醒我补充或核实原内容，不要凭标题编造事实、热梗含义或出处。`;
  if((g.messages.length||g.source||g.input.trim())&&!confirm('把这个热点作为新话题带入创作对话？当前对话及未发送的文字会替换，作品记录会保留。'))return;
  guideRequestVersion++;state.guide=blankGuidance();state.guide.input=input;state.guideEdit=null;saveGuidance();state.view='briefing';render();
  document.querySelector('#guide-input')?.focus();notify('选题已带入。补充你的想法，再点击“开始聊聊”。');
}

function historyView() {
  return `<section class="history-section"><div class="history-toolbar"><div class="filter-tabs">${[['all','全部作品'],['completed','已完成'],['draft','待确认']].map(([id,name]) => `<button class="${state.filter === id ? 'active' : ''}" data-action="filter" data-filter="${id}">${name}</button>`).join('')}</div><div class="search-box">${icon('search')}<input id="history-search" placeholder="搜索作品标题或内容" aria-label="搜索作品" value="${h(state.search)}"/></div></div><div id="history-list">${historyList()}</div></section>`;
}
function historyList() {
  const query = state.search.trim().toLowerCase();
  const list = state.projects.filter(p => (state.filter === 'all' || p.status === state.filter) && (!query || `${p.title} ${p.source}`.toLowerCase().includes(query))).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!list.length) return `<div class="history-empty">${icon('cards')}<h3>${state.search || state.filter !== 'all' ? '没有找到匹配的作品' : '你的作品，会从这里开始积累'}</h3><p>${state.search || state.filter !== 'all' ? '试试其他关键词或筛选条件。' : '从一个想法开始，创作第一组图文。'}</p><button class="button button-primary" data-action="new">${icon('plus')}开始创作</button></div>`;
  return `<div class="history-grid">${list.map(p => {const cover=p.pages?.find(page => page.imageUrl); return `<article class="history-card"><button class="history-cover" data-action="open-project" data-id="${h(p.id)}">${cover ? `<img src="${h(cover.imageUrl)}" alt="${h(p.title)}" loading="lazy"/>` : `<div class="history-placeholder">${icon('cards')}<span>${h(modeText(p.mode))}</span></div>`}<span class="badge badge-${h(p.status)}">${statusText(p.status)}</span></button><div class="history-card-body"><button class="history-title" data-action="open-project" data-id="${h(p.id)}">${h(p.title || '未命名作品')}</button><p>${h(p.source?.slice(0,90))}</p><div class="history-card-footer"><span>${time(p.createdAt)} · ${p.pages?.length || p.count || 0} 张</span><button class="icon-button" aria-label="删除 ${h(p.title)}" title="删除作品" data-action="delete" data-id="${h(p.id)}" ${isActive(p) ? 'disabled' : ''}>${icon('trash')}</button></div></div></article>`;}).join('')}</div>`;
}
function settingsView() {
  if (!state.config) return `<div class="panel settings-loading"><span class="spinner"></span><p>正在读取模型设置…</p><button class="button button-secondary" data-action="reload">重试连接</button></div>`;
  const c=state.config;
  return `<div class="settings-layout"><form id="settings-form" class="settings-form"><div class="settings-intro">${icon('lock')}<div><strong>使用你自己的模型资源</strong><p>文本模型负责内容策划，图片模型负责出图，可以使用不同的中转站。</p></div></div>${providerSettings('text','文本模型','内容分析、拆页和提示词生成',c.text)}${providerSettings('image','图片模型','根据提示词生成真实图片',c.image)}<div class="settings-save"><p>密钥保存后不会返回浏览器，留空表示保留已保存的密钥。</p><button class="button button-primary" type="submit" ${state.busy ? 'disabled' : ''}>${buttonBusy('settings') || icon('check')}保存模型设置</button></div></form><aside class="settings-aside"><div class="panel"><span class="eyebrow">QUICK START</span><h3>连接模型，只需三步</h3><ol><li><strong>填写 API 地址</strong><p>一般填到 /v1，例如 https://api.example.com/v1，以中转站文档为准。</p></li><li><strong>填写模型 ID 与密钥</strong><p>使用中转站提供的准确模型名；文本与图片模型可共用一个密钥，但需分别填写。</p></li><li><strong>保存后测试连接</strong><p>测试会发送真实请求，可能产生少量费用。通过后即可回到创作台。</p></li></ol></div><div class="settings-tip">${icon('file')}<p>作品、内容方案和任务记录保存在本地。图片中的中文与细节仍需人工检查。</p></div></aside></div>`;
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
  if(el.id==='guide-input') {state.guide.input=el.value;saveGuidance();}
  if(el.id==='source') {state.brief.source=el.value; const counter=document.querySelector('#source-count'); if(counter) counter.textContent=el.value.length;}
  if(el.id==='trends-search'){state.trendSearch=el.value;state.trendLimit=24;updateTrendsResults();}
  if(el.id==='trends-keywords'){state.trendKeywordsDraft=el.value;state.trendKeywordsDirty=true;}
  if(el.id==='history-search') {state.search=el.value;document.querySelector('#history-list').innerHTML=historyList();}
  if(el.closest('#brief-form') && ['style','aspect','count'].includes(el.name)) state.brief[el.name]=el.name==='count'?Math.max(1,Math.min(10,Number(el.value)||1)):el.value;
  if(el.dataset.edit && state.draft && canEdit(state.project)) {
    if(el.dataset.edit==='project-title') {state.draft.title=el.value;document.querySelectorAll('[data-edit="project-title"]').forEach(other=>{if(other!==el)other.value=el.value;});}
    else if(el.dataset.edit==='caption') state.draft.caption=el.value;
    else {const page=state.draft.pages.find(p=>p.id===el.dataset.page);if(page)page[el.dataset.edit]=el.value;}
    state.dirty=true;
    document.querySelector('#dirty-status')?.classList.add('visible');
    const briefSubmit=document.querySelector('#brief-form [type="submit"]');
    if(briefSubmit){briefSubmit.classList.remove('button-secondary');briefSubmit.classList.add('button-primary');}
    const generateButton=document.querySelector('[data-action="generate"]');
    if(generateButton&&!state.busy){const allDone=state.project.pages.every(page=>page.status==='done')&&!hasImageEdits();generateButton.disabled=allDone;generateButton.innerHTML=`${icon('spark')}${allDone?'全部已生成':'保存并生成图片'}`;}
  }
});
app.addEventListener('change', event => {
  const el=event.target;
  if(el.id==='guide-match-trends'){
    state.guide.matchTrends=el.checked;state.guide.selectedTrend=null;state.guide.trendMatches=null;state.guide.trendNotice=el.checked?'已开启热点匹配。下次发送分析时会一起匹配，也可以点击重新匹配。':'已关闭热点匹配，将按原主题继续。';saveGuidance();renderGuidance();
  }
  if(el.id==='trends-interval')state.trendIntervalDraft=Number(el.value);
  if(el.name==='mode') {state.brief.mode=el.value;render();}
});
app.addEventListener('submit', async event => {
  event.preventDefault();
  if(event.target.id==='trends-keywords-form')await saveTrendKeywords();
  if(event.target.id==='guide-form') await sendGuidance();
  if(event.target.id==='brief-form') await createProject();
  if(event.target.id==='settings-form') await saveSettings();
});
app.addEventListener('click', async event => {
  const button=event.target.closest('[data-action]');
  if(!button || button.disabled) return;
  event.preventDefault();
  const {action,id,view,kind}=button.dataset;
  try {
    if(action==='guide-example') {const examples=['给新手做一组养猫准备清单','把产品介绍做成一组宣传图','做一张 AI 工作流知识图'];state.guide.input=examples[Number(button.dataset.example)]||'';saveGuidance();renderGuidance();document.querySelector('#guide-input')?.focus();}
    if(action==='guide-choice') chooseGuidePreference(button.dataset.field,button.dataset.value);
    if(action==='guide-count') {const input=document.querySelector('#guide-custom-count');if(input?.checkValidity())chooseGuidePreference('count',Number(input.value));else input?.reportValidity();}
    if(action==='guide-trend-select')chooseGuideTrend(id);
    if(action==='guide-trend-clear')clearGuideTrend();
    if(action==='guide-trend-rematch')await sendGuidance({rematch:true});
    if(action==='guide-from-studio')await matchTrendsFromStudio();
    if(action==='guide-accept') acceptGuideRecommendations();
    if(action==='guide-edit') {state.guideEdit=button.dataset.field;renderGuidance();}
    if(action==='guide-cancel-edit') {state.guideEdit=null;renderGuidance();}
    if(action==='guide-handoff') handoffGuidance();
    if(action==='guide-retry') await sendGuidance({retry:true});
    if(action==='guide-reset') {if(state.guideBusy)return;if(state.guide.messages.length&&!confirm('重新开始创作对话？当前对话和已选参数将清空，作品记录不会受影响。'))return;guideRequestVersion++;state.guide=blankGuidance();state.guideEdit=null;saveGuidance();renderGuidance();}
    if(action==='navigate') {if(!['briefing','studio','trends','history','settings'].includes(view))return;state.view=view;render();if(view==='history')await refreshHistory();if(view==='trends')await loadTrends();}
    if(action==='trends-refresh')await refreshTrends();
    if(action==='trends-platform'){state.trendPlatform=button.dataset.platform;state.trendLimit=24;renderTrends();}
    if(action==='trends-scope'){state.trendScope=button.dataset.scope;state.trendLimit=24;renderTrends();}
    if(action==='trends-more'){state.trendLimit+=24;renderTrends();}
    if(action==='trends-clear-filters'){state.trendSearch='';state.trendPlatform='all';state.trendScope='all';state.trendLimit=24;renderTrends();}
    if(action==='trends-toggle')await saveTrendsSettings({enabled:!state.trends.settings.enabled});
    if(action==='trends-interval'){const interval=Number(document.querySelector('#trends-interval')?.value);await saveTrendsSettings({intervalMinutes:interval});}
    if(action==='trends-use')useTrendForCreation(id);
    if(action==='reload') await boot();
    if(action==='new') {if(state.dirty&&!confirm('当前方案有未保存的修改，确定新建作品吗？'))return;if(state.guideBusy){state.view='briefing';render();return;}state.view='briefing';state.guide=blankGuidance();state.guideEdit=null;saveGuidance();state.project=null;state.draft=null;state.dirty=false;state.selectedPage=null;state.editorTab='outline';clearTimeout(pollTimer);pollVersion++;render();}
    if(action==='sample') {state.brief.source='为刚开始接触 AI 的职场人，制作一组「让 AI 真正帮你省时间的 5 个方法」图文。\n\n内容包括：先说明任务和目标；提供必要背景与参考；把大任务拆成小步骤；让 AI 给出多个方案再做选择；对事实和关键数据进行检查。\n\n面向普通职场人，语言清晰实用，避免夸张承诺。每页一个方法，包含一个具体例子。最后给出今天就能尝试的小行动。';render();document.querySelector('#source')?.focus();}
    if(action==='count') {state.brief.count=Math.max(1,Math.min(10,state.brief.count+Number(button.dataset.delta)));render();}
    if(action==='select-page') {state.selectedPage=id;render();}
    if(action==='editor-tab') {state.editorTab=button.dataset.tab==='preview'?'preview':'outline';render();}
    if(action==='save') await saveProject();
    if(action==='generate') await generate();
    if(action==='regenerate') await generate(id);
    if(action==='reanalyze') await reanalyze();
    if(action==='preview') {const page=state.project?.pages.find(p=>p.id===id);if(page?.imageUrl){document.querySelector('#lightbox-image').src=page.imageUrl;lightbox.showModal();}}
    if(action==='copy-caption') {const text=state.draft?.caption ?? state.project?.caption;if(!text?.trim())return notify('暂时没有可复制的文案。');await navigator.clipboard.writeText(text);notify('发布文案已复制。');}
    if(action==='open-project') {if(state.dirty&&!confirm('当前方案有未保存的修改，确定切换作品吗？'))return;const {project}=await api(`/api/projects/${encodeURIComponent(id)}`);setProject(project,{reset:true});state.view='studio';render();beginPolling();}
    if(action==='delete') await deleteProject(id);
    if(action==='filter') {state.filter=button.dataset.filter;render();}
    if(action==='load-models') await loadModels(kind);
    if(action==='test') await testConnection(kind);
  } catch(error) {notify(error.message,true);}
});
document.querySelector('#close-lightbox').addEventListener('click',()=>lightbox.close());
lightbox.addEventListener('click',event=>{if(event.target===lightbox)lightbox.close();});
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
app.addEventListener('keydown',event=>{if(event.target.id==='guide-input'&&(event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();sendGuidance();}});

async function createProject() {
  if(state.busy)return;
  if(state.dirty&&!confirm('当前方案有未保存的修改，确定创建新作品吗？'))return;
  const source=state.brief.source.trim();
  if(source.length<5)return notify('请至少输入 5 个字，描述你的创作内容。',true);
  state.busy='create';render();
  try {
    const {project}=await api('/api/projects',{method:'POST',body:{...state.brief,source,count:state.brief.mode==='cards'?state.brief.count:1}});
    setProject(project,{reset:true});notify('创作任务已创建，正在生成内容方案。');
  } catch(error){notify(error.message,true);} finally {state.busy='';render();beginPolling();}
}
async function saveProject({quiet=false}={}) {
  if(!canEdit(state.project))return;
  const p=state.draft;
  const payload={title:p.title,caption:p.caption,pages:p.pages.map(({id,title,content,prompt})=>({id,title,content,prompt}))};
  state.busy='save';render();
  try {const {project}=await api(`/api/projects/${encodeURIComponent(p.id)}`,{method:'PATCH',body:payload});setProject(project,{reset:true});if(!quiet)notify('方案已保存。');return project;}
  finally{state.busy='';render();}
}
async function generate(pageId) {
  if(state.busy||!canEdit(state.project))return;
  if(state.dirty)await saveProject({quiet:true});
  state.busy='generate';render();
  try {const {project}=await api(`/api/projects/${encodeURIComponent(state.project.id)}/generate`,{method:'POST',body:pageId?{pageId}:{}});setProject(project,{reset:true});notify('已开始生成图片，完成后会自动展示。');}
  finally{state.busy='';render();beginPolling();}
}
async function reanalyze() {
  if(state.busy||isActive(state.project))return;
  state.busy='analyze';render();
  try {const {project}=await api(`/api/projects/${encodeURIComponent(state.project.id)}/analyze`,{method:'POST',body:{}});setProject(project,{reset:true});}
  finally{state.busy='';render();beginPolling();}
}
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
  if(state.project?.id===id){state.project=null;state.draft=null;state.dirty=false;}
  render();notify('作品已删除。');
}
async function saveSettings() {
  if(state.busy)return;
  const form=new FormData(document.querySelector('#settings-form'));
  const data={text:{},image:{}};
  for(const [key,value] of form.entries()){const [kind,field]=key.split('.');data[kind][field]=String(value).trim();}
  state.busy='settings';
  const submit=document.querySelector('#settings-form [type="submit"]');if(submit){submit.disabled=true;submit.textContent='正在保存…';}
  try {const result=await api('/api/config',{method:'PUT',body:data});state.config=result.config||result;state.testResults={};notify('模型设置已保存。');}
  catch(error){notify(error.message,true);return;}
  finally{state.busy='';if(submit){submit.disabled=false;submit.textContent='保存模型设置';}}
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
  if(state.view==='trends')await loadTrends();
}
boot();
