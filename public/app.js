const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const lightbox = document.querySelector('#lightbox');
const state = {
  view: 'studio', config: null, projects: [], project: null, draft: null,
  selectedPage: null, editorTab: 'outline', dirty: false, busy: '', search: '', filter: 'all',
  brief: { source: '', mode: 'cards', style: 'notion', aspect: '3:4', count: 5 },
  models: { text: [], image: [] }, testResults: {}, bootError: '',
};
let pollTimer;
let pollVersion = 0;
let toastTimer;

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
const statusText = status => ({analyzing:'分析内容中', draft:'方案待确认', generating:'图片生成中', completed:'已完成', partial:'部分完成', error:'任务失败', interrupted:'任务已中断'}[status] || '待处理');
const modeText = mode => ({cards:'多页图文', infographic:'信息图', cover:'封面海报'}[mode] || mode);
const time = date => date ? new Date(date).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
const buttonBusy = name => state.busy === name ? '<span class="spinner spinner-small"></span>' : '';

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
  if (reset || previous?.id !== project.id || (isActive(previous) && !isActive(project))) {
    state.editorTab = ['generating', 'completed', 'partial'].includes(project.status) ? 'preview' : 'outline';
  }
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
  const links = [['studio','创作台','01'],['history','作品记录','02'],['settings','模型设置','03']];
  return `<header class="site-header"><a href="#" class="brand" data-action="navigate" data-view="studio" aria-label="图文工坊首页"><span class="brand-glyph" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span>图文工坊<small>THE CONTENT ATELIER</small></span></a><nav class="main-nav" aria-label="主要导航">${links.map(([view,label,index]) => `<button class="nav-item ${state.view === view ? 'active' : ''}" data-action="navigate" data-view="${view}" ${state.view === view ? 'aria-current="page"' : ''}><span>${label}</span><small>${index}</small>${view === 'history' && state.projects.length ? `<span class="nav-count">${state.projects.length}</span>` : ''}</button>`).join('')}</nav><div class="header-end"><span class="local-indicator"><i></i>本地工作空间</span><span class="avatar" aria-label="个人创作空间">我</span></div></header>`;
}
function header() {
  const labels = {
    studio:['A LITTLE IDEA. A BEAUTIFUL STORY.','好想法，<span>值得好好表达<i>。</i></span>','把内容交给 AI，把创作的决定留给你。'],
    history:['YOUR CREATIVE COLLECTION','让作品，<span>慢慢积累<i>。</i></span>','每一次认真表达，都值得留下。'],
    settings:['TOOLS FOR YOUR NEXT IDEA','让工具，<span>顺手起来<i>。</i></span>','连接你自己的文字与图片模型。'],
  };
  const [eyebrow, title, sub] = labels[state.view];
  return `<header class="page-header"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${sub}</p></div><div class="header-actions"><span class="connection ${state.config?.configured ? 'connected' : ''}"><i></i>${state.config?.configured ? '模型已配置' : '等待配置模型'}</span>${state.view !== 'settings' ? `<button class="button button-ink" data-action="new">${icon('plus')}新建创作<span class="button-arrow">↗</span></button>` : ''}</div></header>`;
}
function render() {
  app.innerHTML = `<div class="app-shell">${sidebar()}<main class="main">${header()}${state.bootError ? `<div class="banner banner-error">${icon('alert')}<span>${h(state.bootError)}</span><button class="text-button" data-action="reload">重试连接</button></div>` : ''}${state.view === 'studio' ? studio() : state.view === 'history' ? historyView() : settingsView()}<footer class="main-footer"><span>图文工坊 <i>©</i> ${new Date().getFullYear()}</span><span>一个给好内容的创作空间。</span><span>MADE FOR YOUR NEXT IDEA.</span></footer></main></div>`;
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
  return `<section class="brief-panel panel"><div class="panel-heading"><span class="section-number">01</span><h2>创作简报</h2><span class="muted">从内容开始</span></div><form id="brief-form"><fieldset ${locked ? 'disabled' : ''}><label class="field-label" for="source">想要创作什么？<button type="button" class="text-button" data-action="sample">试试示例</button></label><textarea id="source" name="source" class="source-input" placeholder="输入一个主题、一段文章或产品介绍…&#10;&#10;例如：给第一次养猫的人，做一组实用的准备清单。" required minlength="5" maxlength="24000">${h(b.source)}</textarea><div class="input-note"><span>内容越具体，生成效果越贴近你的想法</span><span id="source-count">${b.source.length}</span></div><label class="field-label">内容形式</label><div class="mode-options">${[['cards','cards','多页图文'],['infographic','chart','信息图'],['cover','image','封面海报']].map(([id,i,name]) => `<label class="mode-option ${b.mode === id ? 'selected' : ''}"><input type="radio" name="mode" value="${id}" ${b.mode === id ? 'checked' : ''}/>${icon(i)}<span>${name}</span></label>`).join('')}</div><label class="field-label" for="style">视觉风格</label><select id="style" name="style">${styleOptions.map(s => `<option value="${h(s.id)}" ${b.style === s.id ? 'selected' : ''}>${h(s.name)}${s.description ? ' · ' + h(s.description) : ''}</option>`).join('')}</select><div class="brief-options"><div><label class="field-label" for="aspect">图片比例</label><select id="aspect" name="aspect">${[['3:4','3:4 · 竖版'],['1:1','1:1 · 方形'],['16:9','16:9 · 横版']].map(([v,l]) => `<option value="${v}" ${b.aspect === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div><label class="field-label" for="count">图片张数</label><div class="count-input"><button type="button" data-action="count" data-delta="-1" aria-label="减少张数" ${b.mode !== 'cards' ? 'disabled' : ''}>−</button><input id="count" name="count" type="number" min="1" max="10" value="${b.mode === 'cards' ? b.count : 1}" ${b.mode !== 'cards' ? 'disabled' : ''}/><button type="button" data-action="count" data-delta="1" aria-label="增加张数" ${b.mode !== 'cards' ? 'disabled' : ''}>+</button></div></div></div><p class="field-help ratio-note">比例为构图目标，实际像素尺寸以模型输出为准。</p><div class="brief-divider"></div><button type="submit" class="button ${completedClean ? 'button-secondary' : 'button-primary'} button-full" ${!state.config?.configured || locked ? 'disabled' : ''}>${buttonBusy('create') || icon('spark')}${state.busy === 'create' ? '正在创建…' : '生成内容方案'}${icon('arrow')}</button><p class="form-help">先生成拆页与文案，确认后再调用图片模型。</p></fieldset></form><div class="brief-bottom">${icon('lock')}API 密钥由本地服务保存</div></section>`;
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
  const page = pages.find(page => page.id === state.selectedPage) || pages[0];
  const currentIndex = pages.findIndex(item => item.id === page?.id);
  const editorMode = state.editorTab === 'preview' ? 'preview' : 'outline';
  const tabs = pages.length ? `<div class="project-toolbar"><div class="editor-tabs" role="tablist" aria-label="创作工作区视图">${[['preview','视觉预览'],['outline','内容大纲']].map(([tab,label]) => `<button id="editor-tab-${tab}" class="editor-tab ${editorMode === tab ? 'active' : ''}" role="tab" aria-selected="${editorMode === tab}" aria-controls="page-detail-panel" data-action="editor-tab" data-tab="${tab}">${label}</button>`).join('')}</div><span class="editor-page-indicator">${String(currentIndex + 1).padStart(2,'0')} / ${String(pages.length).padStart(2,'0')}</span></div>` : '';
  const rail = `<div class="page-rail" aria-label="页面选择">${pages.map((item,index) => `<button class="page-thumb ${item.id === page?.id ? 'selected' : ''}" data-action="select-page" data-id="${h(item.id)}" aria-label="第 ${index + 1} 页：${h(item.title)}" aria-pressed="${item.id === page?.id}"><div class="thumb-preview" data-aspect="${h(p.aspect)}">${item.imageUrl ? `<img src="${h(item.imageUrl)}" alt="第 ${index+1} 页缩略图"/>` : `<span class="thumb-number">${String(index+1).padStart(2,'0')}</span><span class="thumb-title">${h(item.title)}</span>`}${item.status === 'generating' ? '<span class="thumb-generating"><span class="spinner"></span></span>' : ''}</div><span class="thumb-label"><span>${String(index+1).padStart(2,'0')} · ${h(item.title)}</span><i class="page-dot page-dot-${h(item.status)}"></i></span></button>`).join('')}</div>`;
  const content = p.status === 'analyzing' ? analysisState(p) : pages.length ? `${tabs}<div class="page-workspace ${editorMode}-mode"><div id="page-detail-panel" class="page-detail" role="tabpanel" aria-labelledby="editor-tab-${editorMode}">${page ? pageDetail(page, p) : ''}</div>${rail}</div>${captionPanel(draft, editable)}<div class="project-actionbar"><div><span class="section-index">02 / CREATE</span><span class="action-hint">${active ? `${done}/${pages.length} 张已完成，请保持服务运行` : state.dirty ? '修改文案后，可保存方案或直接开始生成' : p.status === 'completed' ? '作品已就绪，点击图片可查看大图' : '确认文案与提示词后，开始生成图片'}</span></div><div class="action-buttons">${editable ? `<button class="button button-secondary" data-action="save" ${state.busy ? 'disabled' : ''}>${buttonBusy('save') || icon('check')}保存方案</button>` : ''}${done && !active ? `<a class="button ${p.status === 'completed' ? 'button-ink' : 'button-secondary'}" href="/api/projects/${encodeURIComponent(p.id)}/export.zip" download>${icon('download')}打包下载</a>` : ''}${!active ? `<button class="button button-primary" data-action="generate" ${state.busy || (done === pages.length && !state.dirty) ? 'disabled' : ''}>${buttonBusy('generate') || icon('spark')}${state.dirty ? '保存并生成图片' : done === pages.length ? '全部已生成' : done ? '生成剩余图片' : '开始生成图片'}</button>` : `<button class="button button-primary" disabled><span class="spinner spinner-small"></span>正在生成图片</button>`}</div></div>` : `<div class="failed-empty">${icon('alert')}<h3>${p.status === 'interrupted' ? '任务已中断' : '暂时没有生成方案'}</h3><p>请检查模型配置和错误信息，然后重试内容分析。</p><button class="button button-primary" data-action="reanalyze" ${state.busy ? 'disabled' : ''}>${icon('refresh')}重新分析内容</button></div>`;
  return `<div class="project-panel"><div class="project-heading"><div class="project-subline"><span class="project-meta">${h(modeText(p.mode))} · ${h(p.aspect)}${pages.length ? ` · ${pages.length} 张` : ''}</span><span>${time(p.createdAt)} 创建</span><span class="dirty-status ${state.dirty ? 'visible' : ''}" id="dirty-status">有未保存的修改</span>${pages.length ? `<span class="completion-count">${done}/${pages.length} 张已生成</span>` : ''}</div></div>${p.error ? `<div class="project-error">${icon('alert')}<span>${h(p.error)}</span></div>` : ''}${content}${logsPanel(p)}</div>`;
}

function analysisState(p) {
  return `<div class="analysis-state"><div class="analysis-orb">${icon('spark')}</div><h3>正在把你的想法整理成方案</h3><p>理解内容、梳理结构、设计逐页文案与画面提示词…</p><div class="analysis-progress"><span></span></div><small>文本模型正在处理中，完成后会自动展示。</small></div>`;
}
function pageDetail(page, project) {
  const editable = canEdit(project);
  const index = (state.draft.pages || []).findIndex(p => p.id === page.id);
  const editor = `<div class="page-editor ${page.imageUrl ? 'has-image' : ''}"><label class="field-label" for="page-title">页面标题</label><input id="page-title" data-edit="title" data-page="${h(page.id)}" value="${h(page.title)}" ${!editable ? 'disabled' : ''}/><label class="field-label" for="page-content">图片文案<span class="muted">检查文字，减少生成后的返工</span></label><textarea id="page-content" data-edit="content" data-page="${h(page.id)}" rows="5" ${!editable ? 'disabled' : ''}>${h(page.content)}</textarea><details class="prompt-details" ${!page.imageUrl ? 'open' : ''}><summary>画面提示词 <span>${editable ? '可编辑' : '查看'}</span></summary><textarea aria-label="画面提示词" class="prompt-input" data-edit="prompt" data-page="${h(page.id)}" rows="6" ${!editable ? 'disabled' : ''}>${h(page.prompt)}</textarea><p class="field-help">图上文案以页面标题和图片文案为准，修改后可重新生成这一页。</p></details></div>`;
  const image = page.imageUrl ? `<button class="image-preview" data-action="preview" data-id="${h(page.id)}" data-aspect="${h(project.aspect)}" aria-label="查看第 ${index+1} 页完整图片"><img src="${h(page.imageUrl)}" alt="${h(page.title || '生成的图文作品')}"/><span>${icon('expand')}点击查看大图</span></button>` : page.status === 'generating' ? `<div class="image-generating" data-aspect="${h(project.aspect)}"><span class="spinner"></span><strong>正在绘制第 ${index+1} 张</strong><p>图片生成可能需要几分钟，请耐心等待。</p></div>` : `<div class="image-generating image-pending" data-aspect="${h(project.aspect)}">${icon('image')}<span class="section-index">PAGE ${String(index+1).padStart(2,'0')}</span><strong>${h(page.title)}</strong><p>${page.status === 'error' ? '这张图片尚未完成，可以单独重试。' : '确认内容方案后，生成这页的图文。'}</p><span class="pending-note">图片尚未生成</span></div>`;
  return `<div class="detail-topbar"><span class="detail-page-label">PAGE ${String(index + 1).padStart(2,'0')}</span><div>${page.imageUrl ? `<a class="icon-button" title="下载这张图片" aria-label="下载这张图片" href="${h(page.imageUrl)}" download="${h(project.id)}-${index+1}.${h(page.imageUrl.split('.').pop())}">${icon('download')}</a><button class="icon-button" title="查看大图" aria-label="查看大图" data-action="preview" data-id="${h(page.id)}">${icon('expand')}</button>` : ''}${editable ? `<button class="text-button" data-action="regenerate" data-id="${h(page.id)}" ${state.busy ? 'disabled' : ''}>${icon('refresh')}${page.imageUrl ? '重新生成' : page.status === 'error' ? '重试这张' : '生成这张'}</button>` : ''}</div></div>${page.error ? `<div class="inline-error">${h(page.error)}</div>` : ''}<div class="preview-stage">${image}</div>${state.editorTab === 'preview' ? `<details class="page-editor-details"><summary>${icon('file')}查看与编辑这一页的文案<span>展开</span></summary>${editor}</details>` : `<div class="plan-notice">${icon('file')}这是内容方案，确认后将生成真实图片。</div>${editor}`}`;
}
function captionPanel(p, editable) {
  return `<details class="caption-panel" ${p.caption && state.editorTab === 'outline' ? 'open' : ''}><summary>发布文案 <button type="button" class="text-button" data-action="copy-caption">${icon('copy')}复制文案</button></summary><textarea aria-label="发布文案" data-edit="caption" rows="4" placeholder="可在这里补充发布文案…" ${!editable ? 'disabled' : ''}>${h(p.caption)}</textarea></details>`;
}

function logsPanel(p) {
  if (!p.logs?.length) return '';
  return `<details class="logs-panel"><summary>任务动态<span>${p.logs.length} 条记录</span></summary><div class="log-list">${p.logs.slice(-25).reverse().map(log => `<div><time>${time(log.at)}</time><span>${h(log.message)}</span></div>`).join('')}</div></details>`;
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
  if(el.id==='source') {state.brief.source=el.value; const counter=document.querySelector('#source-count'); if(counter) counter.textContent=el.value.length;}
  if(el.id==='history-search') {state.search=el.value;document.querySelector('#history-list').innerHTML=historyList();}
  if(el.closest('#brief-form') && ['style','aspect','count'].includes(el.name)) state.brief[el.name]=el.name==='count'?Math.max(1,Math.min(10,Number(el.value)||1)):el.value;
  if(el.dataset.edit && state.draft && canEdit(state.project)) {
    if(el.dataset.edit==='project-title') state.draft.title=el.value;
    else if(el.dataset.edit==='caption') state.draft.caption=el.value;
    else {const page=state.draft.pages.find(p=>p.id===el.dataset.page);if(page)page[el.dataset.edit]=el.value;}
    state.dirty=true;
    document.querySelector('#dirty-status')?.classList.add('visible');
    const briefSubmit=document.querySelector('#brief-form [type="submit"]');
    if(briefSubmit){briefSubmit.classList.remove('button-secondary');briefSubmit.classList.add('button-primary');}
    const generateButton=document.querySelector('[data-action="generate"]');
    if(generateButton&&!state.busy){generateButton.disabled=false;generateButton.innerHTML=`${icon('spark')}保存并生成图片`;}
  }
});
app.addEventListener('change', event => {
  const el=event.target;
  if(el.name==='mode') {state.brief.mode=el.value;render();}
});
app.addEventListener('submit', async event => {
  event.preventDefault();
  if(event.target.id==='brief-form') await createProject();
  if(event.target.id==='settings-form') await saveSettings();
});
app.addEventListener('click', async event => {
  const button=event.target.closest('[data-action]');
  if(!button || button.disabled) return;
  event.preventDefault();
  const {action,id,view,kind}=button.dataset;
  try {
    if(action==='navigate') {state.view=view;render();if(view==='history')await refreshHistory();}
    if(action==='reload') await boot();
    if(action==='new') {if(state.dirty&&!confirm('当前方案有未保存的修改，确定新建作品吗？'))return;state.view='studio';state.project=null;state.draft=null;state.dirty=false;state.selectedPage=null;state.editorTab='outline';clearTimeout(pollTimer);pollVersion++;render();}
    if(action==='sample') {state.brief.source='为刚开始接触 AI 的职场人，制作一组「让 AI 真正帮你省时间的 5 个方法」图文。\n\n内容包括：先说明任务和目标；提供必要背景与参考；把大任务拆成小步骤；让 AI 给出多个方案再做选择；对事实和关键数据进行检查。\n\n面向普通职场人，语言清晰实用，避免夸张承诺。每页一个方法，包含一个具体例子。最后给出今天就能尝试的小行动。';render();document.querySelector('#source')?.focus();}
    if(action==='count') {state.brief.count=Math.max(1,Math.min(10,state.brief.count+Number(button.dataset.delta)));render();}
    if(action==='select-page') {state.selectedPage=id;render();}
    if(action==='editor-tab') {state.editorTab=button.dataset.tab==='preview'?'preview':'outline';render();}
    if(action==='save') await saveProject();
    if(action==='generate') await generate();
    if(action==='regenerate') await generate(id);
    if(action==='reanalyze') await reanalyze();
    if(action==='preview') {const page=state.project?.pages.find(p=>p.id===id);if(page?.imageUrl){document.querySelector('#lightbox-image').src=page.imageUrl;lightbox.showModal();}}
    if(action==='copy-caption') {const text=state.draft?.caption || state.project?.caption;if(!text)return notify('暂时没有可复制的文案。');await navigator.clipboard.writeText(text);notify('发布文案已复制。');}
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
}
boot();
