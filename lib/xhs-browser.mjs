import path from 'node:path';
import { mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';

const CREATOR = 'https://creator.xiaohongshu.com';
const HOME = `${CREATOR}/`; const NOTES = `${CREATOR}/manage/notes`; const PUBLISH = `${CREATOR}/publish/publish?from=menu&target=image`;
const TITLE = 'input[placeholder*="标题"],textarea[placeholder*="标题"],div.d-input input';
const EDITOR = 'div.ql-editor[contenteditable="true"],div.tiptap.ProseMirror[contenteditable="true"],div[contenteditable="true"][role="textbox"]';
const PREVIEWS = '.img-preview-area .pr,.img-preview-area .image-item,.image-preview-item,[data-uploaded-image]';
const ID = /^[A-Za-z0-9_:-]{3,120}$/;
const clean = (value, max = 1000) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const url = value => { try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null; } catch { return null; } };
const normalizeCopy = value => String(value || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();

/** Read paragraph boundaries rather than CSS-created innerText spacing. Empty
 * paragraphs and explicit line breaks remain meaningful; inline topic spans,
 * punctuation and emoji are kept verbatim. Runs in the editor's DOM only. */
export function readXhsEditorCopy(editor) {
  const blocks = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const read = node => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.tagName === 'BR') return '\n';
    if (['SCRIPT', 'STYLE'].includes(node.tagName) || getComputedStyle(node).display === 'none') return '';
    const children = [...node.childNodes]; let text = '';
    for (let index = 0; index < children.length; index++) {
      const child = children[index], value = read(child), block = blocks.has(child.tagName);
      if (index && (block || blocks.has(children[index - 1].tagName)) && !text.endsWith('\n')) text += '\n';
      // An empty editor paragraph uses <br> as its placeholder. Its block
      // boundary supplies one empty line; don't turn it into two blank lines.
      text += block && child.childNodes.length === 1 && child.firstChild?.nodeName === 'BR' ? '' : value;
      if (block && index < children.length - 1) text += '\n';
    }
    return text;
  };
  return read(editor);
}

export function compareXhsCopy({ title, content }, actual) {
  const expectedTitle = normalizeCopy(title), observedTitle = normalizeCopy(actual.title);
  const expectedContent = normalizeCopy(content), observedContent = normalizeCopy(actual.content);
  const semantic = typeof actual.semantic === 'string' ? normalizeCopy(actual.semantic) : observedContent;
  const difference = (field, expected, observed) => {
    const left = Array.from(expected), right = Array.from(observed); let index = 0;
    while (index < left.length && index < right.length && left[index] === right[index]) index++;
    return { field, expectedLength: left.length, actualLength: right.length, firstDifference: index + 1 };
  };
  if (expectedTitle !== observedTitle) return { matches: false, ...difference('title', expectedTitle, observedTitle) };
  if (expectedContent !== observedContent && expectedContent !== semantic) return { matches: false, ...difference('content', expectedContent, semantic) };
  return { matches: true, formatAdjusted: expectedContent !== observedContent };
}
function copyDifferenceMessage(check) {
  const field = check.field === 'title' ? '标题' : '正文';
  return `${field}与原稿不一致（原稿${check.expectedLength}字，页面${check.actualLength}字，第${check.firstDifference}字起不同）`;
}
const metricDefinitions = [
  ['exposure', '曝光量', ['曝光量', '曝光次数'], '次'], ['views', '观看量', ['观看量', '阅读量'], '次'],
  ['click_rate', '封面点击率', ['封面点击率', '点击率'], '%'], ['likes', '点赞', ['点赞数', '点赞量', '点赞'], '次'],
  ['comments', '评论', ['评论数', '评论量', '评论'], '次'], ['collects', '收藏', ['收藏数', '收藏量', '收藏'], '次'],
  ['new_followers', '涨粉', ['涨粉数', '涨粉量', '新增粉丝', '涨粉'], '人'], ['shares', '分享', ['分享数', '分享量', '分享'], '次'],
];

/** Missing and redacted values stay null; percentages retain their displayed unit. */
export function parseVisibleNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[,，\s]/g, '').replace(/(?:次|人|个|篇|%|％)$/, '');
  const match = normalized.match(/^(\d+(?:\.\d+)?)(万|亿|[kKwW])?$/);
  if (!match) return null;
  return Number(match[1]) * ({ 万: 10000, 亿: 100000000, k: 1000, K: 1000, w: 10000, W: 10000 }[match[2]] || 1);
}
function countNear(text, labels) {
  // Flat page text has no reliable card boundaries. Never pair a label with
  // the previous/next line: it can belong to an adjacent card or comparison.
  const matches = [];
  for (const line of String(text || '').split(/\n/).map(value => value.trim()).filter(Boolean)) {
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = line.match(new RegExp(`^${escaped}[：:]\\s*([\\d,.，]+(?:万|亿|[kKwW])?[%％]?)$`));
      if (match) { const value = parseVisibleNumber(match[1]); if (value !== null) matches.push(value); }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
export function metricsFromVisibleText(text, source, period = '', cards = []) {
  return metricDefinitions.map(([id, label, aliases, unit]) => {
    const bound = cards.filter(card => aliases.includes(String(card.label || '').trim()));
    const value = bound.length ? (bound.length === 1 ? parseVisibleNumber(bound[0].value) : null) : countNear(text, aliases);
    return { id, label, value, unit, source, period: clean(period, 120) || '页面当前选择的时间范围' };
  });
}
export function normalizeXhsAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = clean(raw.userId ?? raw.user_id ?? raw.id ?? raw.redId ?? raw.red_id, 120);
  if (!ID.test(id)) return null;
  return { id, nickname: clean(raw.nickname ?? raw.nickName ?? raw.nick_name ?? raw.userName ?? raw.name, 120) || '小红书账号', avatar: url(raw.avatar ?? raw.image ?? raw.imageb ?? raw.avatarUrl),
    url: url(raw.url) || (/^[a-f0-9]{24}$/i.test(id) ? `https://www.xiaohongshu.com/user/profile/${id}` : null),
    followers: parseVisibleNumber(raw.followers ?? raw.fans), following: parseVisibleNumber(raw.following ?? raw.follows), likes: parseVisibleNumber(raw.likes ?? raw.likedCount), notesCount: parseVisibleNumber(raw.notesCount ?? raw.noteCount) };
}

/** This function runs only in the authenticated page. It reads rendered state,
 * not cookies, local storage, or arbitrary API responses. */
export function readVisibleXhsPage() {
  const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const text = document.body?.innerText || '';
  const challenge = [...document.querySelectorAll('[class*="captcha"],[class*="verify"],[class*="risk"],iframe[src*="captcha"]')].some(visible)
    || /请完成(?:以下)?验证|拖动滑块|安全验证|访问过于频繁|操作过于频繁|账号存在异常|网络环境存在风险/.test(text);
  const login = /\/(?:login|auth)(?:\/|\?|$)/.test(location.href)
    || [...document.querySelectorAll('.login-container,.qrcode-img,[class*="login-qrcode"]')].some(visible)
    || /扫码登录|手机号登录|请先登录|登录后查看/.test(text);
  const unwrap = value => value && typeof value === 'object' ? value.value ?? value._value ?? value : value;
  const roots = [window.__INITIAL_STATE__, window.__NUXT__, window.__INITIAL_DATA__].filter(Boolean);
  let account = null;
  for (const root of roots) {
    const candidates = [root.userInfo, root.currentUser, root.accountInfo, root.user?.userInfo, root.user?.currentUser, root.user?.info, root.creator?.userInfo, root.creator?.accountInfo, root.home?.userInfo];
    for (const value of candidates) {
      const candidate = unwrap(value);
      if (candidate && typeof candidate === 'object' && (candidate.userId || candidate.user_id || candidate.redId || candidate.red_id)) { account = candidate; break; }
    }
    if (account) break;
  }
  const selfId = document.querySelector('[data-self-user-id],[data-account-id]');
  if (!account && selfId) account = { id: selfId.getAttribute('data-self-user-id') || selfId.getAttribute('data-account-id'), nickname: selfId.getAttribute('data-nickname') || selfId.innerText };
  if (!account) {
    const selfLink = [...document.querySelectorAll('a[href*="/user/profile/"]')].find(el => visible(el) && (/^(我|我的主页|个人主页)$/.test(el.innerText.trim()) || el.closest('.user-info,.user-wrapper,.information-wrapper,.account-info')));
    if (selfLink) { const id = selfLink.href.match(/\/user\/profile\/([A-Za-z0-9_-]+)/)?.[1]; if (id) account = { id, nickname: document.querySelector('.user-name,.nickname,.user-nickname')?.innerText }; }
  }
  const knownLabels = ['曝光量', '曝光次数', '观看量', '阅读量', '封面点击率', '点击率', '点赞数', '点赞量', '点赞', '评论数', '评论量', '评论', '收藏数', '收藏量', '收藏', '涨粉数', '涨粉量', '新增粉丝', '涨粉', '分享数', '分享量', '分享'];
  const numeric = value => /^(?:\d[\d,.，]*)(?:万|亿|[kKwW])?[%％]?$/.test(String(value || '').replace(/\s/g, ''));
  const boundValues = scope => {
    const result = [], labels = [...scope.querySelectorAll('span,div,p,dt,label,[data-metric-label]')].filter(el => visible(el) && knownLabels.includes(el.innerText?.trim()) && ![...el.children].some(child => knownLabels.includes(child.innerText?.trim())));
    for (const label of labels) {
      let parent = label.parentElement;
      for (let level = 0; parent && parent !== scope && level < 3; level++, parent = parent.parentElement) {
        const otherLabels = [...parent.querySelectorAll('span,div,p,dt,label,[data-metric-label]')].filter(el => visible(el) && knownLabels.includes(el.innerText?.trim()) && ![...el.children].some(child => knownLabels.includes(child.innerText?.trim())));
        if (otherLabels.length !== 1) break;
        const values = [...parent.querySelectorAll('[data-value],[class*="number"],[class*="value"],[class*="num"],dd')].filter(el => visible(el) && numeric(el.innerText) && ![...el.children].some(child => numeric(child.innerText)));
        if (values.length) { result.push({ label: label.innerText.trim(), value: values.length === 1 ? values[0].innerText.trim() : null }); break; }
      }
    }
    return result;
  };
  const metricCards = boundValues(document.body);
  const period = [...document.querySelectorAll('[class*="date-range"],[class*="time-range"],[class*="date-picker"],.date-select')].filter(visible).map(el => el.innerText).find(Boolean) || '';
  const cards = [...document.querySelectorAll('.note-item,.note-card,[class*="note-manage-card"],.content-item,[data-note-id],table tbody tr')].filter(visible).slice(0, 50).map(el => {
    const a = el.querySelector('a[href*="/explore/"],a[href*="/discovery/item/"],a[href*="note_id="],a[href*="noteId="]');
    const href = a?.href || '', id = el.getAttribute('data-note-id') || href.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]+)/)?.[1] || href.match(/[?&](?:note_id|noteId)=([A-Za-z0-9_-]+)/)?.[1];
    const image = el.querySelector('img');
    let values = boundValues(el);
    if (el.tagName === 'TR') {
      const table = el.closest('table'), headers = [...(table?.querySelectorAll('thead th') || [])].map(item => item.innerText.trim()), cells = [...el.querySelectorAll('td')];
      values = headers.flatMap((label, index) => knownLabels.includes(label) ? [{ label, value: cells[index]?.innerText.trim() ?? null }] : []);
    }
    return { values, id, url: href, title: el.querySelector('[class*="title"],.note-title')?.innerText || a?.innerText || '', text: el.innerText, imageUrl: image?.currentSrc || image?.src, publishedAt: el.querySelector('time')?.getAttribute('datetime') || el.querySelector('[class*="publish-time"]')?.innerText || null };
  });
  return { text: text.slice(0, 150000), challenge, login, account, period, metrics: metricCards, notes: cards, hasMore: /下一页|加载更多/.test(text), url: location.href };
}

function notesFromPage(snapshot) {
  return (snapshot.notes || []).flatMap(item => {
    const id = clean(item.id, 120); if (!ID.test(id)) return [];
    return [{ id, title: clean(item.title, 300) || '未读取到标题', url: url(item.url) || (/^[a-f0-9]{24}$/i.test(id) ? `https://www.xiaohongshu.com/explore/${id}` : null), publishedAt: clean(item.publishedAt, 100) || null,
      likes: metricsFromVisibleText(item.text, '', '', item.values).find(metric => metric.id === 'likes').value, comments: metricsFromVisibleText(item.text, '', '', item.values).find(metric => metric.id === 'comments').value, collects: metricsFromVisibleText(item.text, '', '', item.values).find(metric => metric.id === 'collects').value, views: metricsFromVisibleText(item.text, '', '', item.values).find(metric => metric.id === 'views').value, imageUrl: url(item.imageUrl) }];
  }).filter((item, index, all) => all.findIndex(other => other.id === item.id) === index).slice(0, 50);
}

export class XhsBrowser {
  constructor({ dir, chromiumImpl, executablePath } = {}) {
    if (!dir) throw new Error('小红书浏览器缺少数据目录');
    this.dir = path.join(path.resolve(dir), 'xhs-browser'); this.chromiumImpl = chromiumImpl; this.executablePath = executablePath;
    this.context = null; this.page = null; this.launching = null; this.observedAccount = null; this.lastNavigationAt = 0; this.navigationVersion = 0; this.identityRequests = new WeakMap();
  }
  async ensurePage() {
    if (this.page && !this.page.isClosed() && this.page.__xhsObserved) return this.page;
    if (!this.context) {
      if (!this.launching) this.launching = this.launch().finally(() => { this.launching = null; });
      await this.launching;
    }
    if (!this.page || this.page.isClosed()) this.page = this.context.pages().find(page => !page.isClosed()) || await this.context.newPage();
    this.page.setDefaultTimeout(7000); this.page.setDefaultNavigationTimeout(30000);
    if (!this.page.__xhsObserved) {
      this.page.__xhsObserved = true;
      const observedPage = this.page;
      this.page.on('request', request => { if (observedPage === this.page) this.identityRequests.set(request, this.navigationVersion); });
      this.page.on('response', response => {
        if (observedPage !== this.page) return;
        const request = response.request?.(), version = request && this.identityRequests.get(request);
        if (version === undefined || version !== this.navigationVersion) return;
        let source; try { source = new URL(response.url()); } catch { return; }
        if (!['creator.xiaohongshu.com', 'www.xiaohongshu.com'].includes(source.hostname)) return;
        // Only self-identity responses emitted by the normal page, never an
        // arbitrary user-profile response or a constructed private API call.
        if (!/^\/api\/(?:sns\/web\/v1\/user\/selfinfo|galaxy\/(?:user\/info|creator\/(?:home\/user|user\/info)))\/?$/.test(source.pathname)) return;
        response.json().then(value => { const account = normalizeXhsAccount(value?.data?.userInfo || value?.data); if (account && this.context && observedPage === this.page && version === this.navigationVersion) this.observedAccount = { account, version }; }).catch(() => {});
      });
    }
    return this.page;
  }
  async launch() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const chromium = this.chromiumImpl || (await import('playwright-core')).chromium;
    let executablePath = this.executablePath;
    if (executablePath && !path.isAbsolute(executablePath)) throw new Error('Chrome 可执行文件路径必须是绝对路径');
    if (!executablePath) {
      const candidates = process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] : process.platform === 'win32' ? [process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
      for (const candidate of candidates.filter(Boolean)) { try { await access(candidate, constants.F_OK); executablePath = candidate; break; } catch {} }
    }
    if (!executablePath && !this.chromiumImpl) throw new Error('没有找到系统 Chrome。请先安装 Google Chrome，再重新连接小红书。');
    this.context = await chromium.launchPersistentContext(this.dir, { headless: false, ...(executablePath ? { executablePath } : { channel: 'chrome' }), viewport: null, acceptDownloads: false, locale: 'zh-CN', timeout: 30000 });
    this.context.on('close', () => { this.context = null; this.page = null; this.observedAccount = null; });
  }
  browserFailure(error) { return { state: 'browser_unavailable', account: null, browserOpen: Boolean(this.context), message: /Singleton|ProcessSingleton|profile.*use|already.*running/i.test(String(error?.message)) ? '小红书专用浏览器正在被另一个进程使用，请先关闭它再连接。' : '无法打开或读取小红书专用浏览器。请确认 Chrome 已安装并可运行，再重新连接。' }; }
  async navigate(page, target) {
    const source = new URL(target); if (source.origin !== CREATOR) throw new Error('小红书连接器只访问官方创作中心');
    this.observedAccount = null; this.lastNavigationAt = Date.now(); this.navigationVersion++;
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1300);
  }
  async snapshot(page) {
    let snapshot;
    // The creator's identity request can finish after the initial DOM. Wait a
    // bounded five seconds; every response must belong to this navigation and
    // control tab, so an old or another tab's account cannot fill the gap.
    for (let attempt = 0; attempt <= 20; attempt++) {
      snapshot = await page.evaluate(readVisibleXhsPage);
      if (new URL(snapshot.url).origin !== CREATOR) return { ...snapshot, account: null, challenge: true };
      if (!snapshot.account && this.observedAccount?.version === this.navigationVersion) snapshot.account = this.observedAccount.account;
      if (snapshot.login || snapshot.challenge || normalizeXhsAccount(snapshot.account)) return snapshot;
      if (attempt < 20) await page.waitForTimeout(250);
    }
    return snapshot;
  }
  stateFor(snapshot) {
    if (snapshot.challenge) return { state: 'needs_attention', account: null, browserOpen: true, message: '小红书需要人工验证。请在专用浏览器完成验证，再检查连接；平台不会绕过验证。' };
    if (snapshot.login) return { state: 'login_required', account: null, browserOpen: true, message: '请在打开的小红书创作中心完成扫码或正常登录，再点击检查连接。' };
    const account = normalizeXhsAccount(snapshot.account);
    if (!account) return { state: 'needs_attention', account: null, browserOpen: true, message: '页面已打开，但暂未读到可核对的账号编号。请确认创作中心已登录；未确认账号前不会写入草稿。' };
    return { state: 'connected', account, browserOpen: true, message: '已识别当前小红书账号。' };
  }
  async editorBusy(page) {
    if (!page.url().includes('/publish/')) return false;
    const title = page.locator(TITLE).first(); const editor = page.locator(EDITOR).first();
    if ((await title.count() && await title.inputValue().catch(() => '')) || (await editor.count() && await editor.innerText().catch(() => ''))) return true;
    if (await page.locator(PREVIEWS).count()) return true;
    try { return await page.locator('input[type="file"]').evaluateAll(elements => elements.some(element => element.files?.length > 0)); }
    catch { return true; }
  }
  async readAccount({ preserveEditor = false, foreground = false } = {}) {
    try {
      let page = await this.ensurePage();
      if (await this.editorBusy(page)) {
        if (!preserveEditor) return { state: 'needs_attention', browserOpen: true, message: '专用浏览器中有正在编辑的内容，请先保存或处理，再检查账号。', account: null };
        // Checking a saved binding must not navigate away from the user's
        // unsaved editor. The new control tab uses the same persistent session;
        // navigate() resets identity observations for its own navigation only.
        this.page = await this.context.newPage(); page = await this.ensurePage();
      }
      await this.navigate(page, HOME);
      if (foreground) await page.bringToFront();
      return this.stateFor(await this.snapshot(page));
    } catch (error) { return this.browserFailure(error); }
  }
  async openLogin() { return this.readAccount({ foreground: true }); }
  async inspectAccount() { return this.readAccount({ preserveEditor: true }); }
  async sync() {
    const initial = await this.inspectAccount(); if (initial.state !== 'connected') return { ...initial, metrics: [], notes: [], coverage: { message: '尚未取得账号数据。', limit: 50, hasMore: null } };
    const page = this.page, notes = [], metrics = []; let hasMore = null; const missing = [];
    for (const [kind, target] of [['notes', NOTES], ['analytics', `${CREATOR}/statistics/data-analysis`]]) {
      try {
        await this.navigate(page, target); const snapshot = await this.snapshot(page), state = this.stateFor(snapshot);
        if (state.state !== 'connected') return { ...state, metrics: [], notes: [], coverage: { message: '读取期间账号或页面状态发生变化，本轮未合并数据。', limit: 50, hasMore: null } };
        if (state.account.id !== initial.account.id) return { state: 'needs_attention', account: state.account, browserOpen: true, message: '读取期间检测到不同账号，请断开后重新连接；本轮数据未合并。', metrics: [], notes: [], coverage: { message: '账号不一致', limit: 50, hasMore: null } };
        if (kind === 'notes') { notes.push(...notesFromPage(snapshot)); hasMore = Boolean(snapshot.hasMore); if (!notes.length) missing.push('未从当前笔记页识别到可同步的笔记'); }
        else { metrics.push(...metricsFromVisibleText(snapshot.text, target, snapshot.period, snapshot.metrics)); if (!metrics.some(item => item.value !== null)) missing.push('未识别到当前账号可见的统计卡片'); }
      } catch { missing.push(kind === 'notes' ? '笔记页未读取成功' : '统计页未读取成功'); }
    }
    return { ...initial, message: missing.length ? '账号已识别，部分页面数据尚未读取。' : '已同步当前页面可见数据。', metrics, notes, coverage: { message: `${missing.join('；')}${missing.length ? '。' : ''}仅同步当前页面首批可见内容，最多50条；未读取值保留为空，不代表零。`, hasMore, limit: 50 } };
  }
  async openDrafts() {
    try {
      const page = await this.ensurePage();
      if (await this.editorBusy(page)) return { state: 'needs_attention', account: null, browserOpen: true, message: '浏览器中还有正在编辑的内容，请先手动保存。' };
      await this.navigate(page, PUBLISH); await page.bringToFront();
      const state = this.stateFor(await this.snapshot(page)); if (state.state !== 'connected') return state;
      const entry = page.getByText(/^(草稿箱|我的草稿|草稿\s*[（(]?\d*[）)]?)$/).filter({ visible: true });
      if (await entry.count() === 1) { await entry.click(); return { ...state, message: '已打开电脑端草稿入口。' }; }
      return { ...state, message: '已打开官方创作页，请在浏览器中查看草稿入口。' };
    } catch (error) { return this.browserFailure(error); }
  }
  async stableDraftCopy(page, titleInput, editor, expected) {
    let previous = '', repeats = 0, check;
    for (let attempt = 0; attempt < 10; attempt++) {
      const actual = { title: await titleInput.inputValue(), content: await editor.innerText(), semantic: await editor.evaluate(readXhsEditorCopy) };
      check = compareXhsCopy(expected, actual);
      const current = JSON.stringify(actual);
      repeats = current === previous ? repeats + 1 : 0; previous = current;
      if (repeats >= 2) return { ...check, stable: true };
      if (attempt < 9) await page.waitForTimeout(200);
    }
    return { ...check, matches: false, stable: false };
  }
  async nextControlPage(page) {
    // A readback editor may later be edited manually. Never navigate it away
    // to service another task, even when this particular verification failed.
    try { this.page = await this.context.newPage(); await this.ensurePage(); await page.bringToFront(); } catch {}
  }
  async verifyDraft({ accountId, title, content, count, fingerprint } = {}) {
    const result = (state, message, extra = {}) => ({ state, message, accountId, fingerprint, ...extra });
    if (!ID.test(String(accountId || '')) || typeof title !== 'string' || !title.trim() || typeof content !== 'string' || !Number.isInteger(count) || count < 1 || count > 18) return result('unknown', '冻结的草稿记录不完整，无法重新核验。');
    try {
      let page = await this.ensurePage();
      if (await this.editorBusy(page)) {
        // Filled/unknown records can leave an unsaved editor. A fresh control
        // tab preserves it; verification never clicks save or uploads files.
        this.page = await this.context.newPage(); page = await this.ensurePage();
      }
      const initial = await this.inspectAccount();
      if (initial.state !== 'connected') return result('unknown', initial.message, { needsAttention: true });
      if (initial.account.id !== accountId) return result('unknown', '当前浏览器账号与草稿目标账号不同，未读取其他账号草稿。', { accountMismatch: true, accountId: initial.account.id });
      const checked = await this.reopenDraftForVerification(page, { accountId, title, content, count });
      if (checked.opened) await this.nextControlPage(checked.page || page);
      if (checked.matches) return result('verified', '已重新读取电脑草稿，标题、正文和图片数量与原稿一致。', { verifiedAt: new Date().toISOString() });
      return result('unknown', checked.message || '尚未从草稿列表核验到这一版本，未重新上传或保存。', checked.accountMismatch ? { accountMismatch: true } : checked.needsAttention ? { needsAttention: true } : {});
    } catch { return result('unknown', '草稿重新核验未完成，请检查专用浏览器中的登录和页面状态；未重新上传或保存。'); }
  }
  async saveDraft({ accountId, title, content, images, fingerprint } = {}) {
    let submitted = false;
    const result = (state, message, extra = {}) => ({ state, submitted, message, ...extra });
    if (!ID.test(String(accountId || '')) || typeof title !== 'string' || !title.trim() || title.length > 300 || typeof content !== 'string' || content.length > 20000 || !Array.isArray(images) || images.length < 1 || images.length > 18 || images.some(file => typeof file !== 'string' || !path.isAbsolute(file) || !/\.(?:png|jpe?g|webp)$/i.test(file))) return result('failed', '草稿需要已核对的账号、标题、正文和1到18张本机图片。');
    for (const file of images) { try { await access(file, constants.R_OK); } catch { return result('failed', '有草稿图片已不存在或无法读取，请回到作品记录检查。'); } }
    try {
      const initial = await this.inspectAccount();
      if (initial.state !== 'connected') return result('failed', initial.message, { needsAttention: true });
      if (initial.account.id !== accountId) return result('failed', '当前浏览器账号与已连接账号不同，请断开后重新连接，未填写或提交草稿。', { accountMismatch: true, accountId: initial.account.id });
      const page = this.page; await this.navigate(page, PUBLISH); await page.bringToFront();
      let state = this.stateFor(await this.snapshot(page));
      if (state.state !== 'connected' || state.account.id !== accountId) return result('failed', '无法再次核对发布页账号，未填写草稿。请在浏览器确认当前账号。', { needsAttention: true, accountMismatch: state.account?.id && state.account.id !== accountId });
      if (await this.editorBusy(page)) return result('failed', '官方发布页有未完成的内容，请先手动处理，避免覆盖已有草稿。');
      const imageTab = page.getByText('上传图文', { exact: true }).filter({ visible: true }); if (await imageTab.count() === 1) await imageTab.click();
      const inputs = page.locator('input[type="file"]');
      let fileInput = null;
      for (let index = 0; index < await inputs.count(); index++) { const candidate = inputs.nth(index), accept = await candidate.getAttribute('accept') || ''; if (/image|\.png|\.jpg/i.test(accept) || !accept) { fileInput = candidate; break; } }
      if (!fileInput) return result('failed', '没有找到图文上传控件，请在浏览器确认创作中心已切换到上传图文。');
      await fileInput.setInputFiles(images, { timeout: 30000 });
      const titleInput = page.locator(TITLE).filter({ visible: true }).first(), editor = page.locator(EDITOR).filter({ visible: true }).first();
      await titleInput.waitFor({ state: 'visible', timeout: 60000 }); await editor.waitFor({ state: 'visible', timeout: 15000 });
      await titleInput.fill(title); await editor.fill(content);
      const copy = await this.stableDraftCopy(page, titleInput, editor, { title, content });
      if (!copy.matches) return result('filled', `${copy.stable ? copyDifferenceMessage(copy) : '编辑器文字仍在变化，暂未取得稳定的核验结果'}。内容已保留在发布页，请核对后保存。`, { accountId, fingerprint });
      const previews = page.locator(PREVIEWS).filter({ visible: true });
      try { await page.waitForFunction(({ selector, expected }) => [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length).length === expected, { selector: PREVIEWS, expected: images.length }, { timeout: 60000 }); } catch { return result('filled', '标题与正文已填入，但图片上传数量尚未核对成功，请在专用浏览器确认图片后手动保存。', { accountId, fingerprint }); }
      if (await previews.count() !== images.length) return result('filled', '图片数量尚未核对，内容保留在编辑页。', { accountId, fingerprint });
      state = this.stateFor(await this.snapshot(page));
      if (state.state !== 'connected' || state.account.id !== accountId) return result('filled', '提交前无法核对账号，内容保留在发布页，请人工检查。', { accountId, fingerprint, needsAttention: true });
      const save = page.getByRole('button', { name: /^(暂存离开|存草稿|保存草稿)$/ }).filter({ visible: true });
      if (await save.count() !== 1) return result('filled', '图文已填入发布页，未找到唯一的保存草稿按钮。请在浏览器检查并手动暂存。', { accountId, fingerprint });
      submitted = true; await save.click({ timeout: 15000 });
      await page.waitForTimeout(1600);
      const after = await this.snapshot(page);
      if (after.challenge || after.login) return result('unknown', '已点击保存，但小红书要求重新登录或验证，草稿结果待人工核对。', { accountId, fingerprint });
      // Do not infer success from a toast or URL. Reopen the matching draft and
      // compare its complete title, text, and actual uploaded-image count.
      const opened = await this.reopenDraftForVerification(page, { accountId, title, content, count: images.length });
      if (opened.matches) {
        // Keep the verified editor intact for the user. A new control tab lets
        // the next task proceed without navigating away from later manual edits.
        await this.nextControlPage(opened.page || page);
        return result('verified', '已从电脑端草稿列表重新打开，并核对标题、正文和图片数量。', { accountId, fingerprint, verifiedAt: new Date().toISOString() });
      }
      if (opened.opened) await this.nextControlPage(opened.page || page);
      return result('unknown', `已点击保存草稿，${opened.message || '尚未完成草稿列表读回核验'}。请在专用浏览器查看，平台不会自动重复提交。`, { accountId, fingerprint, ...(opened.accountMismatch ? { accountMismatch: true } : opened.needsAttention ? { needsAttention: true } : {}) });
    } catch { return result(submitted ? 'unknown' : 'failed', submitted ? '保存操作已发起，结果未能确认。请到小红书草稿箱核对后再决定下一步，平台不会自动重发。' : '草稿操作未完成。请检查专用浏览器登录、页面提示和图片，尚未点击保存草稿。'); }
  }
  async reopenDraftForVerification(page, { accountId, title, content, count }) {
    const expected = { accountId, title, content, count };
    const first = await this.draftCandidates(page, expected);
    if (!first.locator) return first;
    if (first.count > 5) return { matches: false, message: '同名草稿超过5份，暂未逐一核验，请人工核对' };
    const results = []; let currentPage = page, candidates = first;
    for (let index = 0; index < first.count; index++) {
      if (index) {
        this.page = await this.context.newPage(); currentPage = await this.ensurePage();
        await this.navigate(currentPage, HOME);
        candidates = await this.draftCandidates(currentPage, expected);
        if (!candidates.locator || candidates.count !== first.count || JSON.stringify(candidates.keys) !== JSON.stringify(first.keys)) return { matches: false, opened: true, page: currentPage, message: '核验期间草稿列表发生变化，未确认该版本，请稍后重新核验', ...(candidates.accountMismatch ? { accountMismatch: true } : candidates.needsAttention ? { needsAttention: true } : {}) };
      }
      await candidates.locator.nth(index).click();
      const checked = await this.readDraftCandidate(currentPage, expected);
      if (!checked.stable && !checked.matches) return { ...checked, opened: true, page: currentPage };
      results.push({ ...checked, page: currentPage });
    }
    const matched = results.filter(item => item.matches);
    if (matched.length === 1) return { matches: true, opened: true, page: matched[0].page };
    return { matches: false, opened: true, page: currentPage, message: matched.length > 1 ? '存在多个内容及图片数量一致的同名草稿，无法确认唯一版本，请人工核对' : first.count > 1 ? '已逐一核验同名草稿，尚未找到与原稿正文及图片数量一致的版本' : results[0]?.message || '尚未完成原稿核验' };
  }
  async draftCandidates(page, { accountId, title }) {
    const state = this.stateFor(await this.snapshot(page));
    if (state.state !== 'connected') return { matches: false, message: '草稿列表账号尚未核对，请先检查登录', needsAttention: true };
    if (state.account.id !== accountId) return { matches: false, message: '草稿列表账号与目标账号不同', accountMismatch: true };
    let entry = page.getByText(/^(草稿箱|我的草稿|草稿\s*[（(]?\d*[）)]?)$/).filter({ visible: true });
    if (await entry.count() !== 1) { if (await this.editorBusy(page)) return { matches: false, message: '当前编辑页有待处理内容，请先保存后再核验' }; await this.navigate(page, PUBLISH); entry = page.getByText(/^(草稿箱|我的草稿|草稿\s*[（(]?\d*[）)]?)$/).filter({ visible: true }); }
    if (await entry.count() !== 1) return { matches: false, message: '尚未识别到唯一的电脑草稿入口' }; await entry.click();
    const match = page.getByText(title.trim(), { exact: true }).filter({ visible: true });
    try { await match.first().waitFor({ state: 'visible', timeout: 10000 }); } catch { return { matches: false, message: '当前草稿列表未找到原稿标题' }; }
    const count = await match.count();
    if (!count) return { matches: false, message: '当前草稿列表未找到原稿标题' };
    // The sequence plus observed card text/identity/cover/time must remain
    // unchanged across control tabs. Never construct a private draft API URL.
    const keys = count > 1 && count <= 5 ? await match.evaluateAll(elements => elements.map(element => {
      let card = element.closest('[data-draft-id],[data-note-id],.draft-item,.draft-card,[class*="draft-item"],[class*="draft-card"]');
      if (!card) {
        card = element;
        for (let level = 0; level < 4 && card.parentElement; level++) {
          const parent = card.parentElement;
          const sameTitle = [...parent.querySelectorAll('*')].filter(node => node.children.length === 0 && node.textContent.trim() === element.textContent.trim());
          if (sameTitle.length > 1) break;
          card = parent; if (card.querySelector('img')) break;
        }
      }
      return { id: card.getAttribute('data-draft-id') || card.getAttribute('data-note-id') || card.getAttribute('data-id') || '', text: card.innerText,
        images: [...card.querySelectorAll('img')].map(image => image.currentSrc || image.src), time: [...card.querySelectorAll('time')].map(time => time.dateTime || time.innerText) };
    })) : [];
    if (count > 1 && count <= 5 && (!Array.isArray(keys) || keys.length !== count)) return { matches: false, message: '未能完整读取同名草稿列表，请人工核对' };
    if (count > 1 && count <= 5 && new Set(keys.map(key => JSON.stringify(key))).size !== count) return { matches: false, message: '同名草稿的可见卡片信息相同，无法逐一确认版本，请人工核对' };
    return { locator: match, count, keys };
  }
  async readDraftCandidate(page, { accountId, title, content, count }) {
    const titleInput = page.locator(TITLE).filter({ visible: true }).first(), editor = page.locator(EDITOR).filter({ visible: true }).first();
    await titleInput.waitFor({ state: 'visible', timeout: 10000 }); await editor.waitFor({ state: 'visible', timeout: 10000 });
    const current = this.stateFor(await this.snapshot(page));
    if (current.state !== 'connected') return { matches: false, opened: true, message: '草稿打开后无法确认账号，请检查登录', needsAttention: true };
    if (current.account.id !== accountId) return { matches: false, opened: true, message: '草稿打开后的账号与目标账号不同', accountMismatch: true };
    const copy = await this.stableDraftCopy(page, titleInput, editor, { title, content });
    if (!copy.matches) return { ...copy, opened: true, message: copy.stable ? copyDifferenceMessage(copy) : '草稿正文仍在加载或变化，暂未取得稳定结果' };
    try { await page.waitForFunction(({ selector, expected }) => [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length).length === expected, { selector: PREVIEWS, expected: count }, { timeout: 10000 }); } catch {}
    const actualCount = await page.locator(PREVIEWS).filter({ visible: true }).count();
    if (actualCount !== count) return { matches: false, stable: true, opened: true, message: `草稿图片数量与原稿不一致（原稿${count}张，页面${actualCount}张）` };
    return { matches: true, stable: true, opened: true };
  }
  async close() { const context = this.context; this.context = null; this.page = null; this.observedAccount = null; if (context) await context.close(); }
}
