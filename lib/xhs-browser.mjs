import path from 'node:path';
import { mkdir, access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { advanceVisibleXhsNotes, clickVisibleXhsNote, readVisibleXhsNote, canCloseXhsReadPopup, readVisibleXhsDrafts, clickVisibleXhsDraft, readVisibleXhsDraftImages, readExistingXhsImageAssets } from './xhs-browser-read.mjs';
export { advanceVisibleXhsNotes, clickVisibleXhsNote, readVisibleXhsNote, canCloseXhsReadPopup, readVisibleXhsDrafts, clickVisibleXhsDraft, readVisibleXhsDraftImages, readExistingXhsImageAssets } from './xhs-browser-read.mjs';

const CREATOR = 'https://creator.xiaohongshu.com';
const HOME = `${CREATOR}/`; const NOTES = `${CREATOR}/new/note-manager`; const PUBLISH = `${CREATOR}/publish/publish?from=menu&target=image`;
const TITLE = 'input[placeholder*="标题"],textarea[placeholder*="标题"],div.d-input input';
const EDITOR = 'div.ql-editor[contenteditable="true"],div.tiptap.ProseMirror[contenteditable="true"],div[contenteditable="true"][role="textbox"]';
const PREVIEWS = '.img-preview-area .pr,.img-preview-area .image-item,.image-preview-item,[data-uploaded-image]';
const ID = /^[A-Za-z0-9_:-]{3,120}$/;
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const profileOwners = new Map();
const DRAFT_ENTRY = /^(?:草稿箱|我的草稿|草稿)\s*(?:[（(]\s*\d+\s*[）)]|\d+)?$/;
const clean = (value, max = 1000) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const url = value => { try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null; } catch { return null; } };
const normalizeCopy = value => String(value || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
const officialMediaUrl = value => {
  try { const parsed = new URL(value); if (parsed.protocol === 'http:' && /(?:^|\.)(?:xhscdn\.com|xiaohongshu\.com)$/.test(parsed.hostname)) parsed.protocol = 'https:'; return url(parsed.href); }
  catch { return null; }
};
const stableCoverUrl = value => {
  const safe = officialMediaUrl(value); if (!safe) return null;
  const source = new URL(safe); source.searchParams.delete('sign'); source.searchParams.delete('t'); return source.href;
};
const stableDraftCard = card => card.officialDraftId ? JSON.stringify([card.officialDraftId, clean(card.title, 300), clean(card.updatedAt, 100), card.kind]) : card.signature;
const sameDraftCover = (left, right) => {
  const before = stableCoverUrl(left.imageUrl), after = stableCoverUrl(right.imageUrl);
  if (before && after && before !== after) return false;
  return left.coverDigest && right.coverDigest ? left.coverDigest === right.coverDigest : true;
};

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

// Only readback editors created in a headless context can carry this marker.
// A human input event or changed source content prevents a later mode switch
// from discarding the page. No storage or authentication data is inspected.
export function markXhsBackgroundReadback() {
  const title = document.querySelector('input[placeholder*="标题"],textarea[placeholder*="标题"],div.d-input input');
  const editor = document.querySelector('div.ql-editor[contenteditable="true"],div.tiptap.ProseMirror[contenteditable="true"],div[contenteditable="true"][role="textbox"]');
  if (!title || !editor) return false;
  const imageNodes = [...document.querySelectorAll('.img-preview-area img,.image-preview-item img,[data-uploaded-image] img')];
  const guard = { dirty: false, title: title.value, content: editor.innerHTML, imageNodes, images: imageNodes.map(img => img.currentSrc || img.src) };
  window.__contentStudioReadback = guard;
  for (const name of ['input', 'change', 'paste', 'drop', 'keydown', 'pointerdown']) document.addEventListener(name, () => { guard.dirty = true; }, { capture: true, once: true });
  return true;
}
export function canReleaseXhsBackgroundReadback() {
  const guard = window.__contentStudioReadback;
  if (!guard || guard.dirty) return false;
  const title = document.querySelector('input[placeholder*="标题"],textarea[placeholder*="标题"],div.d-input input');
  const editor = document.querySelector('div.ql-editor[contenteditable="true"],div.tiptap.ProseMirror[contenteditable="true"],div[contenteditable="true"][role="textbox"]');
  const imageNodes = [...document.querySelectorAll('.img-preview-area img,.image-preview-item img,[data-uploaded-image] img')];
  // The creator can replace blob URLs with uploaded previews, or refresh sign/t
  // on the same <img>, without any input. Slot identity/order is stable across
  // those automatic updates; adding/removing/reordering actual nodes is not.
  const sameSlots = Array.isArray(guard.imageNodes)
    ? guard.imageNodes.length === imageNodes.length && guard.imageNodes.every((node, index) => node === imageNodes[index])
    // Compatibility for this driver's already-open, invisible readback pages
    // created before node tracking. All other input/text guards still apply.
    : Array.isArray(guard.images) && guard.images.length === imageNodes.length;
  return Boolean(title && editor && guard.title === title.value && guard.content === editor.innerHTML && sameSlots);
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
  ['exposure', '曝光量', ['曝光量', '曝光次数', '曝光数'], '次'], ['views', '观看量', ['观看量', '阅读量', '观看数'], '次'],
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
  return { id, nickname: clean(raw.nickname ?? raw.nickName ?? raw.nick_name ?? raw.userName ?? raw.name, 120) || '小红书账号', avatar: url(raw.avatar ?? raw.image ?? raw.imageb ?? raw.avatarUrl ?? raw.userAvatar),
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
  const accountStats = { followers: null, following: null, likes: null };
  const homePath = location.pathname.replace(/\/+$/, '') || '/';
  if (location.origin === 'https://creator.xiaohongshu.com' && ['/', '/new/home'].includes(homePath)) {
    const summaries = [...document.querySelectorAll('.static.description-text')].filter(visible);
    const summary = summaries.length === 1 ? summaries[0] : null;
    if (summary && !summary.closest('[class*="recommend"],[class*="suggest"],.author-card,[data-author-id]')) {
      const labels = { '关注数': 'following', '粉丝数': 'followers', '获赞与收藏': 'likes' }, counts = {};
      for (const item of [...summary.children].filter(el => el.tagName === 'DIV' && visible(el))) {
        const values = [...item.querySelectorAll('span.numerical')].filter(visible);
        const copy = item.cloneNode(true); for (const number of copy.querySelectorAll('span.numerical')) number.remove();
        const label = copy.textContent.replace(/\s+/g, '').trim(), field = labels[label];
        if (!field) continue;
        counts[field] = (counts[field] || 0) + 1;
        accountStats[field] = counts[field] === 1 && values.length === 1 ? values[0].innerText.trim() : null;
      }
    }
  }
  const knownLabels = ['曝光量', '曝光次数', '曝光数', '观看量', '阅读量', '观看数', '封面点击率', '点击率', '点赞数', '点赞量', '点赞', '评论数', '评论量', '评论', '收藏数', '收藏量', '收藏', '涨粉数', '涨粉量', '新增粉丝', '涨粉', '分享数', '分享量', '分享'];
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
  let metricCards = boundValues(document.body);
  let period = [...document.querySelectorAll('[class*="date-range"],[class*="time-range"],[class*="date-picker"],.date-select')].filter(visible).map(el => el.innerText).find(Boolean) || '';
  if (location.origin === 'https://creator.xiaohongshu.com' && homePath === '/statistics/account/v2') {
    const overviews = [...document.querySelectorAll('.indicators')].filter(el => visible(el) && !el.closest('[class*="recommend"],[class*="suggest"],.author-card,[data-author-id]') && [...el.querySelectorAll(':scope > .indicators-header > .title')].filter(visible).some(title => /数据总览/.test(title.innerText) && /统计周期/.test(title.innerText)));
    metricCards = []; period = '';
    if (overviews.length === 1) {
      const overview = overviews[0], titles = [...overview.querySelectorAll(':scope > .indicators-header > .title')].filter(visible);
      if (titles.length === 1) { const text = titles[0].innerText; period = text.slice(text.indexOf('统计周期')).replace(/\s+/g, ' ').trim(); }
      metricCards = (titles.length === 1 ? [...overview.querySelectorAll(':scope > .datas > .creator-block')] : []).filter(visible).flatMap(card => {
        const titles = [...card.querySelectorAll('.title')].filter(visible);
        if (titles.length !== 1 || !['曝光数', '观看数', '封面点击率'].includes(titles[0].innerText.trim())) return [];
        const containers = [...card.querySelectorAll('.number-container')].filter(visible), label = titles[0].innerText.trim();
        if (containers.length !== 1) return [{ label, value: null }];
        const numbers = [...containers[0].querySelectorAll(':scope > span.number')].filter(visible), units = [...containers[0].querySelectorAll(':scope > span.unit')].filter(visible);
        return [{ label, value: numbers.length === 1 && units.length <= 1 ? numbers[0].innerText.trim() + (units[0]?.innerText.trim() || '') : null }];
      });
    }
  }
  const noteSelector = location.origin === 'https://creator.xiaohongshu.com' && homePath === '/new/note-manager' ? '.notes-container .note-card' : '.note-item,.note-card,[class*="note-manage-card"],.content-item,[data-note-id],table tbody tr';
  const cards = [...document.querySelectorAll(noteSelector)].filter(el => visible(el) && !el.closest('[class*="recommend"],[class*="suggest"],.author-card,[data-author-id]')).slice(0, 200).map(el => {
    const a = el.querySelector('a[href*="/explore/"],a[href*="/discovery/item/"],a[href*="note_id="],a[href*="noteId="]');
    const href = a?.href || '', id = el.getAttribute('data-note-id') || href.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]+)/)?.[1] || href.match(/[?&](?:note_id|noteId)=([A-Za-z0-9_-]+)/)?.[1];
    const image = el.querySelector('img');
    let values = boundValues(el);
    if (el.tagName === 'TR') {
      const table = el.closest('table'), headers = [...(table?.querySelectorAll('thead th') || [])].map(item => item.innerText.trim()), cells = [...el.querySelectorAll('td')];
      values = headers.flatMap((label, index) => knownLabels.includes(label) ? [{ label, value: cells[index]?.innerText.trim() ?? null }] : []);
    }
    return { values, id, url: href, title: el.querySelector('[class*="title"],.note-title')?.innerText || a?.innerText || '', text: el.innerText, imageUrl: image?.currentSrc || image?.src, publishedAt: el.querySelector('time')?.getAttribute('datetime') || el.querySelector('.note-card__time,[class*="publish-time"]')?.innerText || null };
  });
  let notesCount = null;
  if (location.origin === 'https://creator.xiaohongshu.com' && ['/manage/notes', '/new/note-manager'].includes(homePath)) {
    const lists = [...document.querySelectorAll('.tab-list')].filter(visible);
    if (lists.length === 1) {
      const totals = [...lists[0].querySelectorAll('.tab-item')].filter(visible).map(el => el.innerText.trim().match(/^全部\s*(\d+)$/)).filter(Boolean);
      if (totals.length === 1) notesCount = totals[0][1];
    }
  }
  const nextControls = [...document.querySelectorAll('button,[role="button"],a,.el-pagination .btn-next,.pagination-next')].filter(el => visible(el) && (/^(下一页|加载更多)$/.test(el.innerText.trim()) || /^(下一页|next)$/i.test(el.getAttribute('aria-label') || '') || el.matches('.el-pagination .btn-next,.pagination-next')));
  const disabled = el => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || /(?:^|\s)(?:is-disabled|disabled)(?:\s|$)/.test(el.className || '');
  const noMore = /(?:没有更多|已加载全部|已经到底|暂无更多)/.test(text);
  const hasMore = noMore ? false : nextControls.length === 1 ? !disabled(nextControls[0]) : notesCount !== null ? Number(notesCount) > cards.length : null;
  return { text: text.slice(0, 150000), challenge, login, account, accountStats, notesCount, period, metrics: metricCards, notes: cards, hasMore, url: location.href };
}

function notesFromPage(snapshot) {
  return (snapshot.notes || []).flatMap(item => {
    const id = clean(item.id, 120); if (!ID.test(id)) return [];
    return [{ id, title: clean(item.title, 300) || '未读取到标题', url: url(item.url) || (/^[a-f0-9]{24}$/i.test(id) ? `https://www.xiaohongshu.com/explore/${id}` : null), publishedAt: clean(item.publishedAt, 100) || null,
      likes: metricsFromVisibleText(item.text, '', '', item.values).find(metric => metric.id === 'likes').value, comments: metricsFromVisibleText(item.text, '', '', item.values).find(metric => metric.id === 'comments').value, collects: metricsFromVisibleText(item.text, '', '', item.values).find(metric => metric.id === 'collects').value, views: metricsFromVisibleText(item.text, '', '', item.values).find(metric => metric.id === 'views').value, imageUrl: url(item.imageUrl) }];
  }).filter((item, index, all) => all.findIndex(other => other.id === item.id) === index).slice(0, 200);
}

function syncPageSource(kind, value) {
  try {
    const source = new URL(value), pathname = source.pathname.replace(/\/+$/, '') || '/';
    if (source.origin !== CREATOR) return null;
    const paths = kind === 'notes' ? ['/manage/notes', '/new/note-manager'] : ['/statistics/data-analysis', '/statistics/account/v2'];
    return paths.includes(pathname) ? source.origin + pathname : null;
  } catch { return null; }
}
function syncPermissionNotice(value) {
  const text = String(value || '');
  if (/数据权限申请中/.test(text)) return '页面提示数据权限申请中，请在小红书开放权限后重试';
  if (/暂无访问权限|没有访问权限|无访问权限|权限不足|暂未开通(?:数据)?权限|未开通(?:数据)?权限/.test(text)) return '当前页面暂无访问权限，未读取该页数据';
  return '';
}

// Observe only the own-posted response emitted by normal creator navigation.
// Keep a short whitelist, never the raw response or signed access parameters.
function observeOwnPosted(browser, page) {
  const requests = new WeakMap(), pending = new Set(), batches = [], responseKeys = new Set(); let epoch = null, active = true, ambiguous = false;
  const isCurrent = version => active && epoch !== null && version === epoch && browser.navigationVersion === epoch && browser.page === page && Boolean(syncPageSource('notes', page.url()));
  const ownSource = value => { try { const source = new URL(value); return source.origin === CREATOR && source.pathname === '/api/galaxy/v2/creator/note/user/posted'; } catch { return false; } };
  const onRequest = request => {
    if (isCurrent(browser.navigationVersion) && request.method?.() === 'GET' && ownSource(request.url?.())) requests.set(request, { version: epoch, key: request.url() });
  };
  const onResponse = response => {
    const request = response.request?.(), observed = request && requests.get(request), version = observed?.version;
    if (!isCurrent(version) || !ownSource(response.url?.())) return;
    if (responseKeys.has(observed.key)) { ambiguous = true; return; }
    responseKeys.add(observed.key);
    if (response.status?.() !== 200) return;
    const task = Promise.resolve().then(() => response.json()).then(value => {
      if (!isCurrent(version) || value?.success !== true || !Array.isArray(value.data?.notes)) return;
      batches.push(value.data.notes.slice(0, 200).flatMap(row => {
        const id = clean(row?.id, 120), title = clean(row?.display_title, 300), publishedAt = clean(row?.time, 100);
        if (!ID.test(id) || !title || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(publishedAt)) return [];
        const image = officialMediaUrl(row.images_list?.[0]?.url); let imageUrl = null;
        if (image) { const source = new URL(image); source.search = ''; source.hash = ''; imageUrl = source.href; }
        return [{ id, title, publishedAt, imageUrl, values: [{ label: '点赞', value: parseVisibleNumber(row.likes) }, { label: '评论', value: parseVisibleNumber(row.comments_count) }, { label: '收藏', value: parseVisibleNumber(row.collected_count) }, { label: '观看量', value: parseVisibleNumber(row.view_count) }] }];
      }));
    }).catch(() => {}).finally(() => pending.delete(task));
    pending.add(task);
  };
  page.on('request', onRequest); page.on('response', onResponse);
  return {
    begin(version) { epoch = version; },
    async read() {
      let timer;
      try { await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
      finally { clearTimeout(timer); }
      if (!isCurrent(epoch) || ambiguous) return [];
      const rows = batches.flat(), grouped = new Map();
      for (const row of rows) { const previous = grouped.get(row.id); if (previous && JSON.stringify(previous) !== JSON.stringify(row)) return []; grouped.set(row.id, row); }
      return [...grouped.values()].slice(0, 200);
    },
    close() { active = false; page.off('request', onRequest); page.off('response', onResponse); },
  };
}
function matchVisiblePosted(snapshot, posted) {
  const key = row => { const title = clean(row?.title, 300), time = clean(row?.publishedAt, 100); return title && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(time) ? JSON.stringify([title, time]) : null; };
  const visible = snapshot.notes || [], visibleKeys = visible.map(key), postedKeys = posted.map(key), legacy = syncPageSource('notes', snapshot.url)?.endsWith('/manage/notes');
  return visible.flatMap((card, index) => {
    if (legacy && ID.test(clean(card.id, 120))) return [card];
    const matchKey = visibleKeys[index];
    if (!matchKey || visibleKeys.filter(value => value === matchKey).length !== 1 || postedKeys.filter(value => value === matchKey).length !== 1) return [];
    const row = posted[postedKeys.indexOf(matchKey)];
    if (card.id != null && clean(card.id, 120) !== row.id) return [];
    return [{ ...row, text: '', url: /^[a-f0-9]{24}$/i.test(row.id) ? `https://www.xiaohongshu.com/explore/${row.id}` : null }];
  });
}

export class XhsBrowser {
  constructor({ dir, profileId, legacy = false, background = false, chromiumImpl, executablePath } = {}) {
    if (!dir) throw new Error('小红书浏览器缺少数据目录');
    if (profileId !== undefined && (typeof profileId !== 'string' || !PROFILE_ID.test(profileId))) throw new Error('小红书浏览器会话编号无效');
    this.root = path.resolve(dir); this.profileId = profileId?.toLowerCase() || null; this.legacy = legacy === true || !this.profileId; this.background = background === true;
    this.dir = this.legacy ? path.join(this.root, 'xhs-browser') : path.join(this.root, 'xhs-profiles', this.profileId); this.chromiumImpl = chromiumImpl; this.executablePath = executablePath;
    this.context = null; this.contextMode = null; this.modeTransition = Promise.resolve(); this.profilePath = null;
    this.page = null; this.launching = null; this.observedAccount = null; this.lastNavigationAt = 0; this.navigationVersion = 0; this.identityRequests = new WeakMap(); this.draftHandles = new Map();
  }
  async prepareProfile() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let current = await realpath(this.root);
    for (const name of this.legacy ? ['xhs-browser'] : ['xhs-profiles', this.profileId]) {
      current = path.join(current, name);
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) throw new Error('小红书浏览器会话目录不安全');
    }
    this.profilePath = current; return current;
  }
  async closeContext() {
    const context = this.context, profile = this.profilePath;
    this.context = null; this.contextMode = null; this.page = null; this.observedAccount = null; this.draftHandles.clear(); this.identityRequests = new WeakMap(); this.navigationVersion++;
    try { if (context) await context.close(); }
    finally { if (profileOwners.get(profile) === this) profileOwners.delete(profile); }
  }
  async hasPendingEdits() {
    if (!this.context) return false;
    for (const page of this.context.pages()) {
      if (page.isClosed() || !await this.editorBusy(page)) continue;
      if (this.contextMode === 'background' && page.__xhsBackgroundReadback && await page.evaluate(canReleaseXhsBackgroundReadback).catch(() => false)) continue;
      return true;
    }
    return false;
  }
  async cleanupBackgroundReadbacks() {
    if (!this.context || this.contextMode !== 'background') return 0;
    let closed = 0;
    for (const page of this.context.pages()) {
      if (page.isClosed() || !page.__xhsBackgroundReadback) continue;
      if (!await page.evaluate(canReleaseXhsBackgroundReadback).catch(() => false)) continue;
      try {
        await page.close(); closed++;
        if (this.page === page) { this.page = null; this.observedAccount = null; this.navigationVersion++; }
      } catch { /* A page that cannot be proved closed stays protected. */ }
    }
    return closed;
  }
  async ensureMode(mode = this.background ? 'background' : 'visible') {
    const target = mode === 'background' && this.background ? 'background' : 'visible';
    const transition = async () => {
      // Existing contexts from an earlier process/runtime are headed. Never
      // assume a live window is safe to discard merely because it is untyped.
      if (this.context && !this.contextMode) this.contextMode = 'visible';
      if (this.context && this.contextMode === target) return this.contextMode;
      if (this.context) {
        for (const page of this.context.pages()) {
          if (page.isClosed() || !await this.editorBusy(page)) continue;
          const readOnly = this.contextMode === 'background' && page.__xhsBackgroundReadback && await page.evaluate(canReleaseXhsBackgroundReadback).catch(() => false);
          if (readOnly) continue;
          // A visible editor may have manual changes. Background work reuses
          // its context with a separate control tab instead of closing it.
          if (target === 'background') return this.contextMode;
          const error = new Error('后台编辑页已有未处理的内容，本次没有关闭或替换浏览器。'); error.code = 'XHS_EDITOR_PENDING'; throw error;
        }
        await this.closeContext();
      }
      this.launching = this.launch(target).finally(() => { this.launching = null; });
      await this.launching; return this.contextMode;
    };
    const pending = this.modeTransition.then(transition, transition);
    this.modeTransition = pending.catch(() => {}); return pending;
  }
  async ensurePage() {
    if (this.page && !this.page.isClosed() && this.page.__xhsObserved) return this.page;
    if (!this.context) await this.ensureMode();
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
  async launch(mode = this.background ? 'background' : 'visible') {
    const profile = await this.prepareProfile();
    const chromium = this.chromiumImpl || (await import('playwright-core')).chromium;
    let executablePath = this.executablePath;
    if (executablePath && !path.isAbsolute(executablePath)) throw new Error('Chrome 可执行文件路径必须是绝对路径');
    if (!executablePath) {
      const candidates = process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] : process.platform === 'win32' ? [process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
      for (const candidate of candidates.filter(Boolean)) { try { await access(candidate, constants.F_OK); executablePath = candidate; break; } catch {} }
    }
    if (!executablePath && !this.chromiumImpl) throw new Error('没有找到系统 Chrome。请先安装 Google Chrome，再重新连接小红书。');
    if (profileOwners.has(profile)) { const error = new Error('小红书专用浏览器正在被另一个进程使用'); error.code = 'XHS_PROFILE_IN_USE'; throw error; }
    profileOwners.set(profile, this);
    try {
      const context = await chromium.launchPersistentContext(profile, { headless: mode === 'background', ...(executablePath ? { executablePath } : { channel: 'chrome' }), viewport: mode === 'background' ? { width: 1280, height: 960 } : null, acceptDownloads: false, locale: 'zh-CN', timeout: 30000 });
      this.context = context; this.contextMode = mode;
      context.on('close', () => {
        if (this.context !== context) return;
        this.context = null; this.contextMode = null; this.page = null; this.observedAccount = null; this.draftHandles.clear();
        if (profileOwners.get(profile) === this) profileOwners.delete(profile);
      });
    } catch (error) { if (profileOwners.get(profile) === this) profileOwners.delete(profile); throw error; }
  }
  browserFailure(error) { return { state: error?.code === 'XHS_EDITOR_PENDING' ? 'needs_attention' : 'browser_unavailable', account: null, browserOpen: Boolean(this.context), background: this.contextMode === 'background', message: error?.code === 'XHS_EDITOR_PENDING' ? '后台编辑页有未处理的内容，本次已保留原页面。请先处理后重试。' : error?.code === 'XHS_PROFILE_IN_USE' || /Singleton|ProcessSingleton|profile.*use|already.*running/i.test(String(error?.message)) ? '小红书专用浏览器正在被另一个进程使用，请先关闭它再连接。' : '无法打开或读取小红书专用浏览器。请确认 Chrome 已安装并可运行，再重新连接。' }; }
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
    if (snapshot.challenge) return { state: 'needs_attention', account: null, browserOpen: true, background: this.contextMode === 'background', message: this.contextMode === 'background' ? '小红书需要人工验证，请点击「打开登录窗口」后完成验证；本次未继续读取。' : '小红书需要人工验证。请在专用浏览器完成验证，再检查连接；平台不会绕过验证。' };
    if (snapshot.login) return { state: 'login_required', account: null, browserOpen: true, background: this.contextMode === 'background', message: this.contextMode === 'background' ? '保存的登录状态需要本人确认，请点击「打开登录窗口」扫码或正常登录。' : '请在打开的小红书创作中心完成扫码或正常登录，再点击检查连接。' };
    const account = normalizeXhsAccount(snapshot.account);
    if (!account) return { state: 'needs_attention', account: null, browserOpen: true, message: '页面已打开，但暂未读到可核对的账号编号。请确认创作中心已登录；未确认账号前不会写入草稿。' };
    // Counts are descriptive data, never an account identity. Only the current
    // creator HOME summary can supplement a separately verified self account.
    try {
      const source = new URL(snapshot.url), pathname = source.pathname.replace(/\/+$/, '') || '/';
      if (source.origin === CREATOR && ['/', '/new/home'].includes(pathname)) {
        for (const field of ['followers', 'following', 'likes']) if (account[field] === null) account[field] = parseVisibleNumber(snapshot.accountStats?.[field]);
      }
    } catch { /* An unknown page cannot supply self-account summary counts. */ }
    return { state: 'connected', account, browserOpen: true, background: this.contextMode === 'background', message: '已识别当前小红书账号。' };
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
      if (foreground) await this.ensureMode('visible');
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
  async openLogin() { return this.readAccount({ preserveEditor: true, foreground: true }); }
  async inspectAccount() { return this.readAccount({ preserveEditor: true }); }
  async sync({ noteLimit = 50 } = {}) {
    try { await this.ensureMode('background'); } catch (error) { return { ...this.browserFailure(error), metrics: [], notes: [], coverage: { message: '后台浏览器尚未就绪。', limit: 50, hasMore: null } }; }
    const limit = Number.isInteger(Number(noteLimit)) ? Math.min(200, Math.max(1, Number(noteLimit))) : 50;
    const initial = await this.inspectAccount(); if (initial.state !== 'connected') return { ...initial, metrics: [], notes: [], coverage: { message: '尚未取得账号数据。', limit, hasMore: null } };
    const page = this.page, notes = [], metrics = [], posted = observeOwnPosted(this, page); let hasMore = null, notesCount = null; const missing = [];
    const blocked = state => ({ ...state, metrics: [], notes: [], coverage: { message: '读取期间账号或页面状态发生变化，本轮未合并数据。', limit, hasMore: null } });
    const mismatch = state => blocked({ ...state, state: 'needs_attention', browserOpen: true, accountMismatch: true, message: '读取期间检测到不同账号，请断开后重新连接；本轮数据未合并。' });
    const validate = snapshot => {
      if (snapshot.login || snapshot.challenge) return blocked(this.stateFor(snapshot));
      try { if (new URL(snapshot.url).origin !== CREATOR) return blocked(this.stateFor({ ...snapshot, account: null, challenge: true })); }
      catch { return blocked(this.stateFor({ ...snapshot, account: null, challenge: true })); }
      const observed = normalizeXhsAccount(snapshot.account);
      if (snapshot.account && !observed) return blocked(this.stateFor(snapshot));
      if (observed && observed.id !== initial.account.id) return mismatch({ account: observed });
      return null;
    };
    try {
      for (const [kind, target] of [['notes', NOTES], ['analytics', `${CREATOR}/statistics/account/v2`]]) {
        try {
          if (kind === 'notes') posted.begin(this.navigationVersion + 1);
          await this.navigate(page, target); let snapshot = await this.snapshot(page);
          const invalid = validate(snapshot); if (invalid) return invalid;
          const source = syncPageSource(kind, snapshot.url), label = kind === 'notes' ? '笔记页' : '统计页';
          if (!source) { missing.push(`${label}跳转到了未支持的位置，未读取该页内容`); continue; }
          const permission = syncPermissionNotice(snapshot.text);
          if (permission) { missing.push(`${label}：${permission}`); continue; }
          if (kind === 'notes') {
            let rounds = 0, idle = 0, lastCards = '', lastAdvance = null;
            while (rounds++ < 40) {
              const total = parseVisibleNumber(snapshot.notesCount); if (Number.isSafeInteger(total)) notesCount = total;
              const rows = notesFromPage({ ...snapshot, notes: matchVisiblePosted(snapshot, await posted.read()) });
              let omitted = false;
              for (const row of rows) if (!notes.some(item => item.id === row.id)) { if (notes.length < limit) notes.push(row); else omitted = true; }
              hasMore = typeof snapshot.hasMore === 'boolean' ? snapshot.hasMore : null;
              if (hasMore === null && notesCount !== null) hasMore = notesCount > notes.length;
              // Reaching a local limit does not imply the official list ended.
              if (notes.length >= limit) { if (omitted) hasMore = true; break; }
              if (hasMore === false) break;
              const signature = JSON.stringify((snapshot.notes || []).map(row => [row.id, row.title, row.publishedAt]));
              // Scrolling through a long already-rendered batch changes the
              // position without changing its cards. Only a next-page click
              // that fails to replace cards counts as a stalled page change.
              idle = signature === lastCards && lastAdvance?.kind === 'next' ? idle + 1 : 0; lastCards = signature;
              if (idle >= 2) { missing.push('笔记列表暂未继续加载，可稍后扩大范围重试'); break; }
              if (idle) { await page.waitForTimeout(850); snapshot = await this.snapshot(page); const changed = validate(snapshot); if (changed) return changed; continue; }
              const advanced = await page.evaluate(advanceVisibleXhsNotes);
              lastAdvance = advanced;
              if (!advanced?.attempted) { if (advanced?.exhausted) hasMore = false; break; }
              await page.waitForTimeout(850); snapshot = await this.snapshot(page);
              const changed = validate(snapshot); if (changed) return changed;
              if (!syncPageSource('notes', snapshot.url)) { missing.push('笔记翻页离开了受支持的列表，已停止读取'); hasMore = null; break; }
            }
            if (!notes.length) missing.push('未从当前笔记页识别到可同步的笔记');
          } else {
            metrics.push(...metricsFromVisibleText(source.endsWith('/statistics/account/v2') ? '' : snapshot.text, source, snapshot.period, snapshot.metrics));
            if (!metrics.some(item => item.value !== null)) missing.push('未识别到当前账号可见的统计卡片');
          }
        } catch { missing.push(kind === 'notes' ? '笔记页未读取成功' : '统计页未读取成功'); }
      }
      // All provisional page reads are committed only after a fresh HOME ID.
      const verified = await this.inspectAccount();
      if (verified.state !== 'connected') return blocked(verified);
      if (verified.account.id !== initial.account.id) return mismatch(verified);
      if (verified.account.notesCount === null && notesCount !== null) verified.account.notesCount = notesCount;
      return { ...verified, message: missing.length ? '账号已识别，部分页面数据尚未读取。' : '已同步当前页面可见数据。', metrics, notes, coverage: { message: `${missing.join('；')}${missing.length ? '。' : ''}已读取首批及正常翻页/滚动可见内容，本次上限${limit}条；未读取值保留为空，不代表零。`, hasMore, limit } };
    } finally { posted.close(); }
  }
  readMismatch(account = null) {
    return { state: 'needs_attention', account, browserOpen: Boolean(this.context), accountMismatch: true, message: '当前浏览器账号与目标账号不同，本次读取未合并。' };
  }
  readPageGuard(snapshot, accountId) {
    if (snapshot.login || snapshot.challenge) return this.stateFor(snapshot);
    try { if (new URL(snapshot.url).origin !== CREATOR) return this.stateFor({ ...snapshot, challenge: true }); }
    catch { return this.stateFor({ ...snapshot, challenge: true }); }
    const account = normalizeXhsAccount(snapshot.account);
    if (snapshot.account && !account) return this.stateFor(snapshot);
    return account && account.id !== accountId ? this.readMismatch(account) : null;
  }
  async readNote({ accountId, noteId } = {}) {
    if (!ID.test(String(accountId || '')) || !ID.test(String(noteId || ''))) return { state: 'needs_attention', account: null, browserOpen: Boolean(this.context), message: '缺少可核对的账号或笔记编号。', detail: null };
    try {
      await this.ensureMode('background');
      const initial = await this.inspectAccount();
      if (initial.state !== 'connected') return { ...initial, detail: null };
      if (initial.account.id !== accountId) return { ...this.readMismatch(initial.account), detail: null };
      const page = this.page, target = `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`;
      const posted = observeOwnPosted(this, page); let snapshot = null, detailPage = null;
      try {
        posted.begin(this.navigationVersion + 1); await this.navigate(page, NOTES);
        for (let round = 0; round < 40; round++) {
          const list = await this.snapshot(page), guard = this.readPageGuard(list, accountId);
          if (guard) return { ...guard, detail: null };
          if (!syncPageSource('notes', list.url) || syncPermissionNotice(list.text)) break;
          const matches = matchVisiblePosted(list, await posted.read()).filter(row => row.id === noteId);
          if (matches.length === 1) {
            // Cover click lets the official site supply its own public access
            // parameters. We never construct, cache, or return those tokens.
            const popup = typeof page.waitForEvent === 'function' ? page.waitForEvent('popup', { timeout: 5000 }).catch(() => null) : Promise.resolve(null);
            const exact = value => new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
            const matched = page.locator('.notes-container .note-card').filter({ visible: true })
              .filter({ has: page.locator('.note-card__title').filter({ hasText: exact(matches[0].title) }) })
              .filter({ has: page.locator('.note-card__time').filter({ hasText: exact(matches[0].publishedAt) }) });
            if (await matched.count() !== 1) break;
            const cover = matched.locator('.note-card__cover').filter({ visible: true });
            if (await cover.count() !== 1) break;
            // A real pointer click is required by the official cover handler;
            // HTMLElement.click() can return without opening its public page.
            await cover.click();
            detailPage = await popup || page;
            if (typeof detailPage.waitForLoadState === 'function') await detailPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            await detailPage.waitForTimeout(1000);
            for (let attempt = 0; attempt < 21; attempt++) {
              snapshot = await detailPage.evaluate(readVisibleXhsNote, { noteId });
              if (snapshot.challenge || snapshot.note?.isComplete || attempt === 20) break;
              await detailPage.waitForTimeout(250);
            }
            break;
          }
          if (list.hasMore === false) break;
          const advanced = await page.evaluate(advanceVisibleXhsNotes);
          if (!advanced?.attempted) break;
          await page.waitForTimeout(850);
        }
      } finally {
        posted.close();
        // Only this operation's own successfully read public popup is eligible
        // for cleanup. Existing creator editors and typed public forms stay.
        if (detailPage && detailPage !== page && snapshot?.note && !snapshot.challenge && !snapshot.pending) {
          try { if (!detailPage.isClosed() && await detailPage.evaluate(canCloseXhsReadPopup, { noteId })) await detailPage.close(); } catch {}
        }
      }
      const final = await this.inspectAccount();
      if (final.state !== 'connected') return { ...final, detail: null };
      if (final.account.id !== accountId) return { ...this.readMismatch(final.account), detail: null };
      const note = snapshot?.note;
      if (snapshot?.challenge) return { ...final, state: 'needs_attention', message: '官方笔记页需要人工验证或跳转到了未支持的位置。', detail: null };
      if (snapshot?.pending) return { ...final, state: 'needs_attention', message: '官方笔记详情尚未载入或当前链接暂不可访问，请在浏览器核对后重试。', detail: null };
      if (!note || note.id !== noteId || note.authorId !== accountId) return { ...final, state: 'needs_attention', message: note?.authorId && note.authorId !== accountId ? '官方笔记作者与当前账号不同，未读取为本人作品。' : '官方笔记尚未提供可核对的本人作者编号，未保存正文。', detail: null };
      const images = Array.isArray(note.images) ? note.images.map(officialMediaUrl).filter(Boolean) : [], isComplete = Boolean(note.isComplete && images.length === note.images.length);
      return { ...final, message: isComplete ? '已读取本人已发布笔记的官方全文与图片。' : '已读取官方笔记的部分内容，完整图片尚未确认。', detail: { id: noteId, title: clean(note.title, 300), content: clean(note.content, 30000), images, tags: (Array.isArray(note.tags) ? note.tags : []).map(tag => clean(tag, 100)).filter(Boolean).slice(0, 100), url: target, source: 'official', isComplete, message: isComplete ? '作者编号已核对，内容来自官方笔记页。' : '官方页面仅提供部分详情，未声称全文完整。' } };
    } catch (error) { return { ...this.browserFailure(error), detail: null }; }
  }
  async selectImageDraftTab(page) {
    // The official drawer opens on the video tab even for an image editor.
    // Read only the image tab explicitly; a video count of zero says nothing
    // about this account's image drafts.
    const tabs = page.locator('.draft-drawer .draft-tabs .tab-item').filter({ visible: true });
    if (await tabs.count()) {
      const images = tabs.filter({ hasText: /^图文笔记\s*(?:[（(]\s*\d+\s*[）)])?$/ });
      if (await images.count() !== 1) return '未识别到唯一的图文草稿分类，未将其他分类作为图文草稿读取。';
      await images.click(); await page.waitForTimeout(700);
    }
    return '';
  }
  async openReadOnlyDraftList(accountId) {
    // An untouched background readback should not sit in the official editor:
    // its client can auto-save and change the draft time even without inputs.
    // Preserve every visible/manual/changed page; only our guarded headless
    // readbacks are eligible for this cleanup.
    await this.cleanupBackgroundReadbacks();
    const page = await this.ensurePage();
    await this.navigate(page, PUBLISH);
    let snapshot = await this.snapshot(page), blocked = this.readPageGuard(snapshot, accountId);
    if (blocked) return { blocked };
    const entry = page.getByText(DRAFT_ENTRY).filter({ visible: true });
    let entryCount = await entry.count();
    for (let attempt = 0; entryCount === 0 && attempt < 20; attempt++) {
      await page.waitForTimeout(250); entryCount = await entry.count();
    }
    if (entryCount !== 1) {
      if (entryCount === 0) { blocked = this.readPageGuard(await this.snapshot(page), accountId); if (blocked) return { blocked }; }
      return { blocked: { state: 'needs_attention', account: null, browserOpen: true, message: '未识别到唯一的官方电脑草稿入口，请在浏览器查看。' } };
    }
    await entry.click(); await page.waitForTimeout(700);
    const tabError = await this.selectImageDraftTab(page);
    if (tabError) return { blocked: { state: 'needs_attention', account: null, browserOpen: true, message: tabError } };
    snapshot = await this.snapshot(page); blocked = this.readPageGuard(snapshot, accountId);
    if (blocked) return { blocked };
    // Let the official drawer's own lazy loader see the bounded card range.
    // This is ordinary scrolling; it makes no thumbnail/API requests itself.
    const cards = page.locator('.draft-drawer .draft-list > .draft-item[data-draft-id][data-draft-type]').filter({ visible: true }), count = Math.min(200, await cards.count());
    if (count && typeof cards.nth(0).scrollIntoViewIfNeeded === 'function') {
      const deadline = Date.now() + 3500;
      for (let index = 0; index < count && Date.now() < deadline; index++) {
        await cards.nth(index).scrollIntoViewIfNeeded({ timeout: 250 }).catch(() => {}); await page.waitForTimeout(80);
      }
      await cards.nth(0).scrollIntoViewIfNeeded({ timeout: 250 }).catch(() => {}); await page.waitForTimeout(200);
    }
    const list = await page.evaluate(readVisibleXhsDrafts);
    let remaining = 64 * 1024 * 1024; const coverDeadline = Date.now() + 8000;
    for (let offset = 0; offset < (list.cards || []).length && remaining > 0 && Date.now() < coverDeadline; offset += 18) {
      const batch = list.cards.slice(offset, offset + 18), media = await page.evaluate(readExistingXhsImageAssets, { images: batch.map(card => card.imageUrl), maxTotalBytes: remaining, allowOfficialCdn: true, maxReadMs: coverDeadline - Date.now() });
      for (const asset of media.assets || []) {
        const card = batch[asset.index]; if (!card) continue;
        const size = Buffer.byteLength(asset.base64, 'base64'); if (size > remaining) continue;
        remaining -= size; card.coverAsset = { mime: asset.mime, base64: asset.base64 }; card.coverDigest = createHash('sha256').update(asset.base64, 'base64').digest('hex');
      }
    }
    return { page, snapshot: list };
  }
  async listDrafts({ accountId } = {}) {
    const empty = state => ({ ...state, officialDrafts: [], coverage: { limit: 200, hasMore: null, message: '尚未读取官方电脑草稿；本机草稿列表句柄已失效。' } });
    // Keys identify one observed list in this browser process. Refreshing the
    // list invalidates all older keys; they are never official draft IDs.
    this.draftHandles.clear();
    if (!ID.test(String(accountId || ''))) return empty({ state: 'needs_attention', account: null, browserOpen: Boolean(this.context), message: '请先连接并核对账号。' });
    try {
      await this.ensureMode('background');
      const initial = await this.inspectAccount();
      if (initial.state !== 'connected') return empty(initial);
      if (initial.account.id !== accountId) return empty(this.readMismatch(initial.account));
      const listed = await this.openReadOnlyDraftList(accountId);
      if (listed.blocked) return empty(listed.blocked);
      const cards = (listed.snapshot?.cards || []).slice(0, 200), signature = JSON.stringify(cards.map(stableDraftCard));
      const final = await this.inspectAccount();
      if (final.state !== 'connected') return empty(final);
      if (final.account.id !== accountId) return empty(this.readMismatch(final.account));
      const officialDrafts = cards.flatMap(card => {
        const title = clean(card.title, 300); if (typeof card.signature !== 'string') return [];
        const key = randomUUID(), officialDraftId = ID.test(String(card.officialDraftId || '')) ? card.officialDraftId : null;
        this.draftHandles.set(key, { accountId, signature, card: { title, officialDraftId, imageUrl: stableCoverUrl(card.imageUrl), updatedAt: card.updatedAt, kind: card.kind, coverDigest: card.coverDigest, signature: officialDraftId ? null : card.signature }, context: this.context });
        return [{ key, officialDraftId, title: title || '未命名草稿', imageUrl: stableCoverUrl(card.imageUrl), ...(card.coverAsset ? { coverAsset: card.coverAsset } : {}), updatedAt: clean(card.updatedAt, 100) || null, kind: card.kind === 'video' ? 'video' : 'image', canRead: true }];
      });
      return { ...final, message: officialDrafts.length ? '已只读获取官方电脑草稿列表。' : '官方电脑草稿列表暂无可读取条目。', officialDrafts, coverage: { limit: 200, hasMore: typeof listed.snapshot.hasMore === 'boolean' ? listed.snapshot.hasMore : null, message: '仅展示电脑端官方可见草稿；不会包含仅存在手机端的草稿。列表刷新后旧详情句柄失效。' } };
    } catch (error) { this.draftHandles.clear(); return empty(this.browserFailure(error)); }
  }
  async readDraft({ accountId, key, foreground = false } = {}) {
    const refused = (message, state = {}) => ({ state: 'needs_attention', account: null, browserOpen: Boolean(this.context), message, ...state, detail: null });
    let handle = this.draftHandles.get(key);
    if (!handle || handle.context !== this.context) return refused('草稿列表句柄已失效，请刷新官方草稿列表后重试。');
    if (handle.accountId !== accountId) return refused('草稿列表属于其他账号，未打开草稿。', { accountMismatch: true });
    let openedPage = null;
    try {
      await this.ensureMode(foreground ? 'visible' : 'background');
      // Changing visibility reopens the same complete on-disk profile. The
      // old DOM handle is not reused: only its observed account/real draft
      // identity survives, followed by a fresh list and signature check.
      if (handle.context !== this.context) { handle = { ...handle, context: this.context }; this.draftHandles.set(key, handle); }
      const initial = await this.inspectAccount();
      if (initial.state !== 'connected') return { ...initial, detail: null };
      if (initial.account.id !== accountId) { this.draftHandles.clear(); return { ...this.readMismatch(initial.account), detail: null }; }
      const listed = await this.openReadOnlyDraftList(accountId);
      if (listed.blocked) return { ...listed.blocked, detail: null };
      const cards = listed.snapshot?.cards || [], sameTitle = cards.filter(card => clean(card.title, 300) === handle.card.title);
      if (sameTitle.length !== 1) return refused('同名草稿存在歧义或已经移除，请在官方浏览器核对后刷新列表。', { account: initial.account });
      if (JSON.stringify(cards.map(stableDraftCard)) !== handle.signature || stableDraftCard(sameTitle[0]) !== stableDraftCard(handle.card) || !sameDraftCover(sameTitle[0], handle.card)) { this.draftHandles.clear(); return refused('官方草稿列表发生变化，请刷新列表后重试。', { account: initial.account }); }
      const page = listed.page, clicked = await page.evaluate(clickVisibleXhsDraft, { index: sameTitle[0].index, signature: sameTitle[0].signature });
      if (!clicked) return refused('草稿可见卡片发生变化，尚未打开内容。', { account: initial.account });
      openedPage = page;
      const titleInput = page.locator(TITLE).filter({ visible: true }).first(), editor = page.locator(EDITOR).filter({ visible: true }).first();
      await titleInput.waitFor({ state: 'visible', timeout: 10000 }); await editor.waitFor({ state: 'visible', timeout: 10000 });
      let copy = null, previous = '', repeats = 0;
      for (let attempt = 0; attempt < 10; attempt++) {
        copy = { title: await titleInput.inputValue(), content: await editor.evaluate(readXhsEditorCopy), media: await page.evaluate(readVisibleXhsDraftImages) };
        const current = JSON.stringify(copy); repeats = current === previous ? repeats + 1 : 0; previous = current;
        if (repeats >= 2 && copy.media?.isComplete) break;
        await page.waitForTimeout(200);
      }
      const rawImages = (Array.isArray(copy.media?.images) ? copy.media.images : []).slice(0, 18), assets = await page.evaluate(readExistingXhsImageAssets, { images: rawImages, allowOfficialCdn: true });
      const guard = this.readPageGuard(await this.snapshot(page), accountId);
      if (guard) return { ...guard, detail: null };
      if (this.contextMode === 'background') page.__xhsBackgroundReadback = await page.evaluate(markXhsBackgroundReadback);
      // Always move future control operations off this reopened editor. The
      // user may continue editing it manually after this read completes.
      this.page = await this.context.newPage(); await this.ensurePage();
      const final = await this.inspectAccount();
      if (final.state !== 'connected') return { ...final, detail: null };
      if (final.account.id !== accountId) { this.draftHandles.clear(); return { ...this.readMismatch(final.account), detail: null }; }
      const imageAssets = Array.isArray(assets.assets) ? assets.assets : [], assetIndexes = new Set(imageAssets.map(asset => asset.index));
      const completeAssets = imageAssets.length === rawImages.length && assetIndexes.size === rawImages.length && imageAssets.every(asset => Number.isInteger(asset.index) && asset.index >= 0 && asset.index < rawImages.length && typeof asset.base64 === 'string' && asset.base64.length > 0);
      // Signed creator-preview URLs expire or lose access once their query is
      // removed. Cache the exact, already-rendered CDN sources just like blob
      // slots; their bytes establish completeness even when <img> is lazy.
      const images = rawImages.map((source, index) => assetIndexes.has(index) ? null : stableCoverUrl(source));
      const isComplete = repeats >= 2 && copy.title.trim() === handle.card.title && assets.isComplete === true && images.length > 0 && images.length === copy.media.count && rawImages.every(source => typeof source === 'string' && source.length > 0) && (completeAssets || copy.media?.isComplete === true && images.every((value, index) => value || assetIndexes.has(index)));
      if (foreground) await page.bringToFront();
      else await this.cleanupBackgroundReadbacks();
      const retained = !page.isClosed(), locationNote = retained ? '编辑页已保留。' : '后台读取页已关闭。';
      return { ...final, message: isComplete ? retained ? '已只读打开官方电脑草稿并读取全文与图片。' : '已在后台读取官方电脑草稿的全文与图片。' : '已读取官方草稿，部分内容尚未完整读取。', detail: { id: handle.card.officialDraftId || null, title: clean(copy.title, 300), content: clean(copy.content, 30000), images, imageAssets, tags: [...new Set((copy.content.match(/#[^#\s]+/gu) || []).map(tag => tag.slice(1)))].slice(0, 100), url: url(page.url()), source: 'official', isComplete, message: `${isComplete ? '内容来自当前账号官方电脑草稿，' : '图片或正文仍未完整确认，'}${locationNote}` } };
    } catch (error) { return { ...this.browserFailure(error), detail: null }; }
    finally {
      if (openedPage && this.page === openedPage) { try { this.page = await this.context.newPage(); await this.ensurePage(); } catch {} }
      if (!foreground) await this.cleanupBackgroundReadbacks();
    }
  }
  async openDrafts() {
    try {
      await this.ensureMode('visible');
      const page = await this.ensurePage();
      if (await this.editorBusy(page)) return { state: 'needs_attention', account: null, browserOpen: true, message: '浏览器中还有正在编辑的内容，请先手动保存。' };
      await this.navigate(page, PUBLISH); await page.bringToFront();
      const state = this.stateFor(await this.snapshot(page)); if (state.state !== 'connected') return state;
      const entry = page.getByText(DRAFT_ENTRY).filter({ visible: true });
      if (await entry.count() === 1) { await entry.click(); const tabError = await this.selectImageDraftTab(page); return { ...state, ...(tabError ? { state: 'needs_attention' } : {}), message: tabError || '已打开电脑端图文草稿入口。' }; }
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
    try { this.page = await this.context.newPage(); await this.ensurePage(); if (this.contextMode !== 'background') await page.bringToFront(); } catch {}
  }
  async verifyDraft({ accountId, title, content, count, fingerprint } = {}) {
    const result = (state, message, extra = {}) => ({ state, message, accountId, fingerprint, ...extra });
    if (!ID.test(String(accountId || '')) || typeof title !== 'string' || !title.trim() || typeof content !== 'string' || !Number.isInteger(count) || count < 1 || count > 18) return result('unknown', '冻结的草稿记录不完整，无法重新核验。');
    try {
      await this.ensureMode('background');
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
      await this.ensureMode('visible');
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
      const opened = candidates.open ? await candidates.open(index) : (await candidates.locator.nth(index).click(), true);
      if (!opened) return { matches: false, opened: results.length > 0, page: currentPage, message: '草稿可见卡片发生变化，未打开其他草稿，请刷新后重试' };
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
    let entry = page.getByText(DRAFT_ENTRY).filter({ visible: true });
    if (await entry.count() !== 1) { if (await this.editorBusy(page)) return { matches: false, message: '当前编辑页有待处理内容，请先保存后再核验' }; await this.navigate(page, PUBLISH); entry = page.getByText(DRAFT_ENTRY).filter({ visible: true }); }
    if (await entry.count() !== 1) return { matches: false, message: '尚未识别到唯一的电脑草稿入口' }; await entry.click();
    const tabError = await this.selectImageDraftTab(page); if (tabError) return { matches: false, message: tabError };
    const match = page.getByText(title.trim(), { exact: true }).filter({ visible: true });
    try { await match.first().waitFor({ state: 'visible', timeout: 10000 }); } catch { return { matches: false, message: '当前草稿列表未找到原稿标题' }; }
    const count = await match.count();
    if (!count) return { matches: false, message: '当前草稿列表未找到原稿标题' };
    let officialCards = null;
    if (await page.locator('.draft-drawer .draft-list > .draft-item[data-draft-id][data-draft-type]').filter({ visible: true }).count()) {
      officialCards = (await page.evaluate(readVisibleXhsDrafts)).cards.filter(card => clean(card.title, 300) === title.trim());
      if (officialCards.length !== count) return { matches: false, message: '草稿标题与官方卡片未唯一对应，请刷新列表后重试' };
    }
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
    return { locator: match, count, keys, open: async index => {
      if (officialCards) { const card = officialCards[index]; return card ? page.evaluate(clickVisibleXhsDraft, { index: card.index, signature: card.signature }) : false; }
      await match.nth(index).click(); return true;
    } };
  }
  async readDraftCandidate(page, { accountId, title, content, count }) {
    try {
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
    } finally {
      if (this.contextMode === 'background' && !page.isClosed()) {
        try { page.__xhsBackgroundReadback = await page.evaluate(markXhsBackgroundReadback); } catch {}
      }
    }
  }
  async close() {
    const closing = this.modeTransition.then(() => this.closeContext(), () => this.closeContext());
    this.modeTransition = closing.catch(() => {}); await closing;
  }
}
