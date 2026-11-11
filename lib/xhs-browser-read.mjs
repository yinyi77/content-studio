// These functions execute in an ordinary official page. They read only the
// rendered UI and that page's own hydrated note, never storage or private APIs.
export function advanceVisibleXhsNotes() {
  const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const next = [...document.querySelectorAll('button,[role="button"],a,.el-pagination .btn-next,.pagination-next')].filter(el => visible(el) && (/^(下一页|加载更多)$/.test(el.innerText.trim()) || /^(下一页|next)$/i.test(el.getAttribute('aria-label') || '') || el.matches('.el-pagination .btn-next,.pagination-next')));
  if (next.length === 1) {
    const el = next[0];
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || /(?:^|\s)(?:is-disabled|disabled)(?:\s|$)/.test(el.className || '')) return { attempted: false, exhausted: true };
    el.click(); return { attempted: true, exhausted: false, kind: 'next' };
  }
  if (next.length > 1) return { attempted: false, exhausted: false };
  const card = document.querySelector('.notes-container .note-card,.note-item,[data-note-id]');
  let parent = card?.parentElement;
  while (parent && parent !== document.body) {
    if (visible(parent) && /auto|scroll/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 2) break;
    parent = parent.parentElement;
  }
  const scroller = parent && parent !== document.body ? parent : document.scrollingElement;
  if (!scroller) return { attempted: false, exhausted: false };
  const before = scroller.scrollTop;
  scroller.scrollTop = Math.min(scroller.scrollHeight, before + Math.max(scroller.clientHeight * .85, 500));
  return { attempted: scroller.scrollTop !== before, exhausted: false, kind: 'scroll', position: scroller.scrollTop, atEnd: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 };
}

export function clickVisibleXhsNote({ title, publishedAt }) {
  if (location.origin !== 'https://creator.xiaohongshu.com' || location.pathname.replace(/\/+$/, '') !== '/new/note-manager') return false;
  const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const cards = [...document.querySelectorAll('.notes-container .note-card')].filter(el => visible(el) && !el.closest('[class*="recommend"],[class*="suggest"]') && el.querySelector('.note-card__title')?.innerText.trim() === title && el.querySelector('.note-card__time')?.innerText.trim() === publishedAt);
  if (cards.length !== 1) return false;
  const cover = cards[0].querySelector('.note-card__cover'); if (!visible(cover)) return false;
  cover.click(); return true;
}

export function readVisibleXhsNote({ noteId }) {
  const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const text = document.body?.innerText || '', routeId = location.pathname.match(/^\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  const challenge = [...document.querySelectorAll('[class*="captcha"],[class*="verify-container"],[class*="verify-dialog"],[class*="verify-modal"],iframe[src*="captcha"]')].some(visible) || /(?:^|\n)\s*(?:请完成(?:以下)?(?:安全)?验证|安全验证|拖动滑块(?:完成验证)?|访问过于频繁|操作过于频繁)\s*(?:$|\n)/.test(text);
  if (location.origin !== 'https://www.xiaohongshu.com' || routeId !== noteId) return { challenge, pending: true, url: location.href, note: null };
  const unwrap = value => value && typeof value === 'object' ? value.value ?? value._value ?? value : value;
  const candidates = [], state = window.__INITIAL_STATE__;
  const detailMap = unwrap(state?.note?.noteDetailMap);
  if (detailMap && typeof detailMap === 'object') {
    for (const value of Object.values(detailMap).slice(0, 200)) {
      const note = unwrap(unwrap(value)?.note);
      if (note && String(note.noteId ?? note.note_id ?? note.id ?? '') === noteId) candidates.push(note);
    }
  }
  if (candidates.length === 1) {
    const note = candidates[0], images = Array.isArray(note.imageList) ? note.imageList.map(image => image.urlDefault || image.url || image.infoList?.find(info => /WB_DFT|CRD_WM_WEBP/.test(info.imageScene || ''))?.url || image.infoList?.[0]?.url || '') : [];
    return { challenge, url: location.href, note: { id: noteId, authorId: String(note.user?.userId ?? note.user?.user_id ?? ''), title: typeof note.title === 'string' ? note.title : '', content: typeof note.desc === 'string' ? note.desc : '', images, tags: Array.isArray(note.tagList) ? note.tagList.map(tag => tag.name).filter(name => typeof name === 'string') : [], isComplete: typeof note.desc === 'string' && typeof note.title === 'string' && Array.isArray(note.imageList) && images.length > 0 && note.type !== 'video', kind: note.type || 'image' } };
  }
  // A DOM-only carousel can omit lazy images, so this fallback is explicitly
  // partial. Never promote a list-card excerpt to the complete published note.
  const titles = [...document.querySelectorAll('#detail-title')].filter(visible), copies = [...document.querySelectorAll('#detail-desc')].filter(visible);
  const authors = [...document.querySelectorAll('.note-detail-mask .author-container a[href*="/user/profile/"],.note-container .author-container a[href*="/user/profile/"]')].filter(el => visible(el) && !el.closest('[class*="recommend"],[class*="comment"]'));
  const authorIds = [...new Set(authors.map(el => el.href.match(/\/user\/profile\/([A-Za-z0-9_-]+)/)?.[1]).filter(Boolean))];
  const images = [...document.querySelectorAll('.note-detail-mask .note-slider img,.note-container .note-slider img')].filter(el => !el.closest('[class*="recommend"],[class*="comment"]')).map(el => el.currentSrc || el.src).filter(Boolean);
  return { challenge, url: location.href, note: copies.length === 1 ? { id: noteId, authorId: authorIds.length === 1 ? authorIds[0] : '', title: titles.length === 1 ? titles[0].innerText : '', content: copies[0].innerText, images: [...new Set(images)], tags: [...copies[0].querySelectorAll('a.tag,span.tag,a[href*="/search_result"]')].map(el => el.innerText.replace(/^#/, '')), isComplete: false } : null };
}

export function canCloseXhsReadPopup({ noteId }) {
  if (location.origin !== 'https://www.xiaohongshu.com' || location.pathname.match(/^\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]+)\/?$/)?.[1] !== noteId) return false;
  return ![...document.querySelectorAll('input,textarea,[contenteditable="true"]')].some(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && (el === document.activeElement || String(el.value || el.innerText || '').trim()));
}

export function readVisibleXhsDrafts() {
  const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const eligible = el => visible(el) && !el.closest('[class*="recommend"],[class*="suggest"]');
  const drawers = [...document.querySelectorAll('.draft-drawer')].filter(visible);
  if (drawers.length > 1) return { url: location.href, cards: [], hasMore: null };
  const scope = drawers[0] || document, official = [...scope.querySelectorAll('.draft-list > .draft-item[data-draft-id][data-draft-type]')].filter(eligible);
  const exact = official.length ? official : [...scope.querySelectorAll('[data-draft-id],.draft-item,.draft-card')].filter(eligible);
  const candidates = exact.length ? exact : [...scope.querySelectorAll('[class*="draft-item"],[class*="draft-card"]')].filter(el => eligible(el) && el.querySelector('[class*="title"],[data-draft-title]') && el.querySelector('img,[class*="cover"]'));
  const cards = exact.length ? candidates.filter(el => !candidates.some(other => other !== el && other.contains(el))) : candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
  return { url: location.href, cards: cards.slice(0, 200).map((el, index) => {
    const title = el.querySelector('.draft-info-desc .draft-title-text') || el.querySelector('[class*="title"],[data-draft-title]'), image = el.querySelector('.draft-cover img') || el.querySelector('img'), time = el.querySelector('.draft-time') || el.querySelector('time,[class*="time"],[class*="date"]');
    const text = el.innerText.trim();
    return { index, officialDraftId: el.getAttribute('data-draft-id') || null, title: title?.innerText.trim() || '', imageUrl: image?.currentSrc || image?.src || null, updatedAt: time?.getAttribute('datetime') || time?.innerText.trim() || null, kind: /video/i.test(el.getAttribute('data-draft-type') || '') || /视频/.test(text) ? 'video' : 'image', signature: JSON.stringify([el.getAttribute('data-draft-id') || '', el.getAttribute('data-draft-type') || '', text, image?.currentSrc || image?.src || '', image?.getAttribute('src') || '', time?.getAttribute('datetime') || '']), text };
  }), hasMore: cards.length > 200 ? true : /(?:加载更多|下一页)/.test(document.body?.innerText || '') ? null : false };
}

export function clickVisibleXhsDraft({ index, signature }) {
  const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const eligible = el => visible(el) && !el.closest('[class*="recommend"],[class*="suggest"]');
  const drawers = [...document.querySelectorAll('.draft-drawer')].filter(visible);
  if (drawers.length > 1) return false;
  const scope = drawers[0] || document, official = [...scope.querySelectorAll('.draft-list > .draft-item[data-draft-id][data-draft-type]')].filter(eligible);
  const exact = official.length ? official : [...scope.querySelectorAll('[data-draft-id],.draft-item,.draft-card')].filter(eligible);
  const candidates = exact.length ? exact : [...scope.querySelectorAll('[class*="draft-item"],[class*="draft-card"]')].filter(el => eligible(el) && el.querySelector('[class*="title"],[data-draft-title]') && el.querySelector('img,[class*="cover"]'));
  const cards = exact.length ? candidates.filter(el => !candidates.some(other => other !== el && other.contains(el))) : candidates.filter(el => !candidates.some(other => other !== el && el.contains(other))), el = cards[index];
  if (!el) return false;
  const image = el.querySelector('.draft-cover img') || el.querySelector('img'), time = el.querySelector('.draft-time') || el.querySelector('time,[class*="time"],[class*="date"]'), actual = JSON.stringify([el.getAttribute('data-draft-id') || '', el.getAttribute('data-draft-type') || '', el.innerText.trim(), image?.currentSrc || image?.src || '', image?.getAttribute('src') || '', time?.getAttribute('datetime') || '']);
  if (actual !== signature) return false;
  // The real drawer opens drafts through its exact 编辑 action. Never choose
  // an adjacent action by index: the other official control is 删除.
  const edit = [...el.querySelectorAll('.draft-actions .btn')].filter(button => visible(button) && button.innerText.trim() === '编辑');
  if (el.querySelector('.draft-actions')) { if (edit.length !== 1) return false; edit[0].click(); return true; }
  const target = el.querySelector('.draft-info-desc .draft-title-text') || el.querySelector('[class*="title"],[data-draft-title]') || el.querySelector('img');
  if (!target) return false;
  target.click(); return true;
}

export function readVisibleXhsDraftImages() {
  // Off-screen and hidden carousel slots still count. Omitting one would let
  // a single visible cover be mistaken for the entire draft's image set.
  const all = [...document.querySelectorAll('.img-preview-area .pr,.img-preview-area .image-item,.image-preview-item,[data-uploaded-image]')];
  const cards = all.filter(el => !all.some(other => other !== el && other.contains(el)));
  let loaded = true;
  const images = cards.map(el => {
    const image = el.matches('img') ? el : el.querySelector('img');
    if (image) { if (!image.complete || image.naturalWidth < 2) loaded = false; return image.currentSrc || image.getAttribute('src') || ''; }
    const background = getComputedStyle(el).backgroundImage;
    return background.match(/^url\(["']?(.*?)["']?\)$/)?.[1] || '';
  });
  return { images, count: cards.length, isComplete: loaded && cards.length > 0 && images.every(Boolean) };
}

export async function readExistingXhsImageAssets({ images, maxTotalBytes = 64 * 1024 * 1024, allowOfficialCdn = false, maxReadMs = 8000 }) {
  const MAX_IMAGE = 15 * 1024 * 1024, MAX_TOTAL = Math.min(64 * 1024 * 1024, Math.max(0, Number(maxTotalBytes) || 0));
  if (location.origin !== 'https://creator.xiaohongshu.com' || !Array.isArray(images) || images.length > 18) return { assets: [], isComplete: false };
  const existing = new Set();
  for (const el of document.querySelectorAll('.img-preview-area .pr,.img-preview-area .image-item,.image-preview-item,[data-uploaded-image],.draft-drawer .draft-list > .draft-item[data-draft-id][data-draft-type] .draft-cover img')) {
    const image = el.matches('img') ? el : el.querySelector('img');
    if (image) { if (image.currentSrc) existing.add(image.currentSrc); if (image.hasAttribute('src')) existing.add(image.src); }
    const background = getComputedStyle(el).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1]; if (background) existing.add(background);
  }
  const assets = []; let total = 0, complete = true;
  const deadline = Date.now() + Math.min(8000, Math.max(1, Number(maxReadMs) || 8000));
  const readResponse = async response => {
    if (!response.ok) throw Error('missing image');
    const declared = Number(response.headers?.get('content-length'));
    if (Number.isFinite(declared) && (declared > MAX_IMAGE || declared + total > MAX_TOTAL)) throw Error('image limit');
    if (!response.body?.getReader) return response.blob();
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_IMAGE || size + total > MAX_TOTAL) throw Error('image limit');
        chunks.push(chunk.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    return new Blob(chunks, { type: response.headers?.get('content-type') || '' });
  };
  const imageMime = bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
    : bytes[0] === 0x89 && String.fromCharCode(...bytes.slice(1, 4)) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10 ? 'image/png'
    : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' ? 'image/webp' : null;
  for (let index = 0; index < images.length; index++) {
    const source = images[index];
    if (typeof source !== 'string') { complete = false; continue; }
    let cdn = false;
    if (!source.startsWith('blob:') && !source.startsWith('data:')) {
      if (!allowOfficialCdn) continue;
      try {
        const remote = new URL(source);
        cdn = remote.protocol === 'https:' && !remote.username && !remote.password && !/^\/api(?:\/|$)/i.test(decodeURIComponent(remote.pathname)) && (/(?:^|\.)xhscdn\.com$/.test(remote.hostname) || ['ci.xiaohongshu.com', 'img.xiaohongshu.com'].includes(remote.hostname));
      } catch {}
      if (!cdn) { complete = false; continue; }
    }
    if (!existing.has(source)) { complete = false; continue; }
    try {
      let blob;
      if (source.startsWith('blob:') || cdn) {
        if (!cdn && new URL(source).origin !== location.origin) { complete = false; continue; }
        const remaining = deadline - Date.now(); if (remaining <= 0) throw Error('read timeout');
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(2500, remaining));
        try { blob = await readResponse(await fetch(source, { credentials: 'omit', redirect: 'error', signal: controller.signal })); }
        finally { clearTimeout(timer); }
      } else {
        const match = source.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
        if (!match || match[2].length > Math.ceil(MAX_IMAGE / 3) * 4 + 4) throw Error('invalid data image');
        const binary = atob(match[2].replace(/[\r\n]/g, '')); if (binary.length > MAX_IMAGE) throw Error('oversized image');
        blob = new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: match[1].toLowerCase() });
      }
      if (!blob.size || blob.size > MAX_IMAGE || total + blob.size > MAX_TOTAL) throw Error('image limit');
      const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer()), mime = imageMime(bytes);
      if (!mime) throw Error('unsupported image');
      const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
      if (!base64) throw Error('empty image'); total += blob.size; assets.push({ index, mime, base64 });
    } catch { complete = false; }
  }
  return { assets, isComplete: complete };
}
