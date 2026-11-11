import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm, access, mkdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { XhsBrowser, parseVisibleNumber, metricsFromVisibleText, normalizeXhsAccount, readVisibleXhsPage, readXhsEditorCopy, compareXhsCopy, markXhsBackgroundReadback, canReleaseXhsBackgroundReadback, advanceVisibleXhsNotes, clickVisibleXhsNote, readVisibleXhsNote, canCloseXhsReadPopup, readVisibleXhsDrafts, clickVisibleXhsDraft, readVisibleXhsDraftImages, readExistingXhsImageAssets } from '../lib/xhs-browser.mjs';

const ACCOUNT = { id: 'mock-account-123', nickname: 'MOCK 个人账号', fans: '1.2万', follows: '7', likedCount: '5,678' };
const title = 'MOCK 小工具的真实场景', content = 'MOCK 已确认的工具介绍\n\n第二段内容。';
const HOME = 'https://creator.xiaohongshu.com/';

test('displayed metric parsing preserves missing values, units, decimals, and explicit zero', () => {
  for (const value of [undefined, null, '', '--', '暂无数据', '未开放', '1.2万+', '-2', NaN, {}, '已收到100个赞']) assert.equal(parseVisibleNumber(value), null);
  assert.equal(parseVisibleNumber('0'), 0); assert.equal(parseVisibleNumber('1.2万'), 12000);
  assert.equal(parseVisibleNumber('2,345'), 2345); assert.equal(parseVisibleNumber('3.14％'), 3.14);
  assert.equal(parseVisibleNumber('2.5亿'), 250000000); assert.equal(parseVisibleNumber('1.1k'), 1100);
  const metrics = metricsFromVisibleText('数据分析\n曝光量：1.2万\n观看量：3,456\n封面点击率：3.14%\n点赞：0\n评论：--', HOME + 'statistics/data-analysis', '近7天');
  assert.equal(metrics.find(item => item.id === 'exposure').value, 12000);
  assert.equal(metrics.find(item => item.id === 'views').value, 3456);
  assert.equal(metrics.find(item => item.id === 'click_rate').unit, '%');
  assert.equal(metrics.find(item => item.id === 'comments').value, null);
  assert.equal(metrics.find(item => item.id === 'likes').value, 0);
  assert.ok(metrics.every(item => item.period === '近7天' && item.source.startsWith(HOME)));
});

test('ambiguous neighboring labels never borrow another metric card value', () => {
  for (const value of ['57\n曝光量\n20\n观看量', '点赞\n5\n评论\n--']) assert.ok(metricsFromVisibleText(value, HOME).every(item => item.value === null));
  const bound = metricsFromVisibleText('57\n曝光量\n20\n观看量', HOME, '', [{ label: '曝光量', value: '57' }, { label: '观看量', value: '20' }]);
  assert.equal(bound.find(item => item.id === 'exposure').value, 57);
  assert.equal(bound.find(item => item.id === 'views').value, 20);
  assert.equal(metricsFromVisibleText('', HOME, '', [{ label: '曝光量', value: '57' }, { label: '曝光量', value: '20' }]).find(item => item.id === 'exposure').value, null);
});

test('account identity requires a stable explicit ID and never derives one from a nickname', () => {
  assert.equal(normalizeXhsAccount({ nickname: 'MOCK 看起来已登录' }), null);
  assert.equal(normalizeXhsAccount({ id: '../foreign' }), null);
  const account = normalizeXhsAccount({ ...ACCOUNT, avatar: 'javascript:bad', url: 'https://user:password@example.org/' });
  assert.equal(account.id, ACCOUNT.id); assert.equal(account.followers, 12000); assert.equal(account.following, 7);
  assert.equal(account.avatar, null); assert.equal(account.url, null);
  assert.equal(account.notesCount, null);
  assert.equal(normalizeXhsAccount({id:ACCOUNT.id,userAvatar:'https://example.org/mock-avatar.png'}).avatar,'https://example.org/mock-avatar.png');
});

test('HOME summary counts only supplement a separately verified current self identity',()=>{
  const browser=new XhsBrowser({dir:'/private/tmp/mock-xhs-summary-test'}),raw={id:'mock-identity-123',nickname:'MOCK 本人'};
  const accountStats={followers:'1.2万',following:'0',likes:'3,456'};
  const state=browser.stateFor({url:HOME+'new/home',account:raw,accountStats,login:false,challenge:false});
  assert.equal(state.state,'connected');assert.equal(state.account.followers,12000);assert.equal(state.account.following,0);assert.equal(state.account.likes,3456);assert.equal(state.account.notesCount,null);
  assert.equal(browser.stateFor({url:HOME+'new/home',account:null,accountStats}).state,'needs_attention');
  for(const url of [HOME+'manage/notes','https://example.org/new/home']){
    const ignored=browser.stateFor({url,account:raw,accountStats});assert.equal(ignored.account.followers,null);assert.equal(ignored.account.following,null);assert.equal(ignored.account.likes,null);
  }
  const invalid=browser.stateFor({url:HOME,account:raw,accountStats:{followers:'--',following:'未获取',likes:'1万+'}});
  assert.equal(invalid.account.followers,null);assert.equal(invalid.account.following,null);assert.equal(invalid.account.likes,null);
});

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-xhs-browser-'));
  const image = path.join(dir, 'example.png'); await writeFile(image, 'MOCK local image bytes');
  const actions = [], pages = [];
  function makePage() {
    let currentUrl = 'about:blank', formTitle = options.savedDraft ? title : '', formContent = options.savedDraft ? content : '', imageCount = options.savedDraft ? 1 : 0, saved = Boolean(options.savedDraft), stage = 'initial', closed = false, selectedImageTab = false;
    const listeners = new Map(); let draftEntryPattern = null, resolvePopup = null, draftEntryReads = 0;
    const page = {
      isClosed: () => closed, url: () => currentUrl, setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, handlers: {},
      on(event, handler) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(handler); this.handlers[event] = value => { for (const listener of listeners.get(event)) listener(value); }; return this; },
      off(event, handler) { listeners.get(event)?.delete(handler); return this; }, listenerCount(event) { return listeners.get(event)?.size || 0; },
      async goto(target) {
        currentUrl = target; stage = 'page'; actions.push(['navigate', target]);
        if (options.onGoto) await options.onGoto(target, page);
        else if (target.endsWith('/new/note-manager')) emitPosted(page, [{ id: options.noteDetail ? 'mock-published-123' : 'mock-note-123', display_title: 'MOCK 笔记', time: '2026-11-09 10:30', likes: 0, comments_count: 3, collected_count: null, view_count: 22 }]);
      }, async waitForTimeout() {}, async bringToFront() { actions.push(['front', pages.indexOf(page)]); },
      async evaluate(fn, args) {
        if (fn === markXhsBackgroundReadback) return true;
        if (fn === canReleaseXhsBackgroundReadback) return options.readbackChanged !== true;
        if (fn === advanceVisibleXhsNotes && options.advanceNotes) return options.advanceNotes(page);
        if (fn === clickVisibleXhsNote && options.noteDetail) {
          actions.push(['read-note-open']); const target = 'https://www.xiaohongshu.com/explore/mock-published-123?xsec_token=MOCK-do-not-export';
          if (options.notePopup) { const popup = makePage(); await popup.goto(target); resolvePopup?.(popup); } else currentUrl = target;
          return true;
        }
        if (fn === readVisibleXhsNote && options.noteDetail) return options.noteDetail({ page, args });
        if (fn === canCloseXhsReadPopup && options.noteDetail) return !options.readPopupEditing;
        if (fn === readVisibleXhsDrafts && options.draftCards) return { cards: typeof options.draftCards === 'function' ? options.draftCards({ page, stage, selectedImageTab }) : options.draftCards, hasMore: false, url: currentUrl };
        if (fn === clickVisibleXhsDraft && options.draftCards) { actions.push(['read-draft-open', args]); stage = 'reopened'; currentUrl = HOME + 'publish/publish'; return true; }
        if (fn === readVisibleXhsDraftImages && options.draftCards) return options.draftMedia || { images: ['https://example.org/mock-original.png', 'https://example.org/mock-second.png'], count: 2, isComplete: true };
        if (fn === readExistingXhsImageAssets && options.draftCards) return options.imageAssets ? options.imageAssets(args) : { assets: [], isComplete: true };
        assert.equal(fn, readVisibleXhsPage);
        const snapshot = { url: currentUrl, text: 'MOCK 笔记管理', metrics: [{label:'曝光量',value:'500'},{label:'观看量',value:'200'}], account: ACCOUNT, challenge: false, login: false, period: '近7天', notes: [], hasMore: false };
        if (currentUrl.includes('/manage/notes') || currentUrl.includes('/new/note-manager')) snapshot.notes = [{ id: options.noteDetail ? 'mock-published-123' : 'mock-note-123', title: 'MOCK 笔记', url: 'https://www.xiaohongshu.com/explore/mock-note-123', text: '点赞：0\n评论：3\n收藏：--\n观看量：22', publishedAt: '2026-11-09 10:30', imageUrl: '' }];
        return options.snapshot ? options.snapshot(snapshot, { saved, stage, page }) : snapshot;
      },
      async waitForFunction(_fn, args) { actions.push(['upload-check', args]); if (options.uploadIncomplete) throw Error('MOCK upload incomplete'); },
      locator(selector) { const kind = selector === '.notes-container .note-card' ? 'note-cards' : selector === '.draft-drawer .draft-list > .draft-item[data-draft-id][data-draft-type]' ? 'official-draft-cards' : selector === '.draft-drawer .draft-tabs .tab-item' ? 'draft-tabs' : selector.includes('placeholder') ? 'title' : selector.includes('contenteditable') ? 'editor' : selector === 'input[type="file"]' ? 'file' : 'images'; return locator(kind); },
      getByRole(role, opts) { actions.push(['selector-role', role, opts.name]); return locator('save'); },
      getByText(value) { if (value instanceof RegExp) draftEntryPattern = value; return locator(value instanceof RegExp ? 'draft-entry' : value === '上传图文' ? 'image-tab' : 'draft-item'); },
      editManually(value) { formContent = value; }, form() { return { title: formTitle, content: formContent }; }, close() { closed = true; },
    };
    if (options.notePopup) page.waitForEvent = async () => new Promise(resolve => { resolvePopup = resolve; });
    function locator(kind, index = 0, textFilter = null) {
      return {
        first() { return locator(kind, 0, textFilter); }, nth(next) { return locator(kind, next, textFilter); }, filter(options = {}) { return kind === 'draft-tabs' && options.hasText ? locator(kind, index, options.hasText) : this; }, async waitFor() {},
        locator(selector) { return locator(kind === 'note-cards' && selector === '.note-card__cover' ? 'note-cover' : 'images'); },
        async count() {
          if (kind === 'official-draft-cards') return options.draftCards ? 1 : 0;
          if (kind === 'draft-tabs') return (options.draftTabLabels || []).filter(label => !textFilter || textFilter.test(label)).length;
          if (kind === 'draft-entry') {
            if (options.draftEntryCounts) {
              const sequence = options.draftEntryCounts, count = typeof sequence === 'function' ? sequence(draftEntryReads++, page) : sequence[Math.min(draftEntryReads++, sequence.length - 1)];
              actions.push(['draft-entry-count', count]); return count;
            }
            return saved && !options.noDraftEntry && (options.draftEntryLabel === undefined || draftEntryPattern?.test(options.draftEntryLabel)) ? 1 : 0;
          }
          if (kind === 'draft-item') return options.draftCount || (stage === 'draft-list' && !options.duplicateDraft ? 1 : options.duplicateDraft ? 2 : 0);
          if (kind === 'save') return options.noSaveButton ? 0 : 1;
          if (kind === 'images') return options.existingImageEditor ? 1 : imageCount;
          return 1;
        },
        async evaluateAll() { return kind === 'draft-item' ? (options.changingList && pages.indexOf(page) > 0 ? ['changed', 'list'] : Array.from({ length: options.draftCount || 2 }, (_, index) => ({ id: options.identicalCards ? '' : `mock-draft-${index}`, text: title }))) : Boolean(options.existingFileSelection); },
        async evaluate(fn) { assert.equal(fn, readXhsEditorCopy); return options.reopenedDifferent && stage === 'reopened' ? 'MOCK 不同的正文' : formContent; },
        async getAttribute() { return 'image/png,image/jpeg'; },
        async inputValue() { return options.existingEditor && !imageCount ? '已有人工稿件' : formTitle; },
        async innerText() { return options.reopenedDifferent && stage === 'reopened' ? 'MOCK 不同的正文' : options.paragraphCssSpacing ? formContent.replaceAll('\n', '\n\n') : formContent; },
        async fill(value) { actions.push(['fill', kind]); if (kind === 'title') formTitle = options.truncateTitle ? value.slice(0, 3) : value; else formContent = value; },
        async setInputFiles(files) { actions.push(['upload', files]); imageCount = files.length; },
        async click() {
          actions.push(['click', kind]);
          if (kind === 'note-cover') {
            actions.push(['read-note-open']); const target = 'https://www.xiaohongshu.com/explore/mock-published-123?xsec_token=MOCK-do-not-export';
            if (options.notePopup) { const popup = makePage(); await popup.goto(target); resolvePopup?.(popup); } else currentUrl = target;
          }
          if (kind === 'save') { if (options.saveThrows) throw Error('MOCK ambiguous click result'); saved = true; currentUrl = HOME; stage = 'saved'; }
          if (kind === 'draft-entry') stage = 'draft-list';
          if (kind === 'draft-tabs') selectedImageTab = Boolean(textFilter?.test('图文笔记(10)'));
          if (kind === 'draft-item') { stage = 'reopened'; currentUrl = HOME + 'publish/publish'; if (index && options.otherDraftContent !== undefined) formContent = options.otherDraftContent; }
        },
      };
    }
    pages.push(page); return page;
  }
  const page = makePage(); let launches = 0, launchOptions;
  const launchHistory = [];
  const browser = new XhsBrowser({ dir, background: options.background === true, chromiumImpl: { async launchPersistentContext(profile, opts) {
    launches++; launchOptions = { profile, ...opts }; launchHistory.push(launchOptions);
    if (options.launchThrows) throw Error('MOCK private browser secret');
    const owned = launches === 1 ? [page] : [makePage()];
    return { pages: () => owned.filter(item => !item.isClosed()), async newPage() { const next = makePage(); owned.push(next); return next; }, on() {}, async close() { owned.forEach(item => item.close()); actions.push(['close']); } };
  } } });
  t.after(async () => { await browser.close(); await rm(dir, { recursive: true, force: true }); });
  return { browser, page, pages, actions, image, launchOptions: () => launchOptions, launchHistory, launches: () => launches, payload: { accountId: ACCOUNT.id, title, content, images: [image], fingerprint: 'MOCK-fingerprint' } };
}

test('construction is passive; explicit login uses one isolated headed persistent browser without exporting cookies', async t => {
  const f = await fixture(t); assert.equal(f.launches(), 0);
  const state = await f.browser.openLogin(); assert.equal(state.state, 'connected');
  assert.equal(state.account.id, ACCOUNT.id); assert.equal(f.launches(), 1);
  assert.equal(f.launchOptions().headless, false); assert.equal(path.basename(f.launchOptions().profile), 'xhs-browser');
  assert.ok(!JSON.stringify(state).includes('cookie'));
  assert.deepEqual(f.actions.filter(action => action[0] === 'front'), [['front', 0]], 'Explicit first login still opens its normal foreground window');
  await f.browser.inspectAccount(); assert.equal(f.launches(), 1);
});

test('checking a saved binding preserves an unsaved editor in its original tab without taking foreground', async t => {
  const f = await fixture(t); await f.browser.ensurePage();
  await f.page.goto(HOME + 'publish/publish'); f.page.editManually('MOCK 用户尚未保存的人工修改');
  const originalUrl = f.page.url(), original = f.page.form(), before = f.actions.length;
  const result = await f.browser.inspectAccount();
  assert.equal(result.state, 'connected'); assert.equal(result.account.id, ACCOUNT.id);
  assert.equal(f.pages.length, 2); assert.equal(f.launches(), 1);
  assert.equal(f.browser.page, f.pages[1]); assert.equal(f.pages[1].url(), HOME);
  assert.equal(f.page.url(), originalUrl); assert.deepEqual(f.page.form(), original); assert.equal(f.page.isClosed(), false);
  const checking = f.actions.slice(before);
  assert.deepEqual(checking.filter(action => action[0] === 'navigate'), [['navigate', HOME]]);
  assert.ok(!checking.some(action => ['front', 'fill', 'upload', 'click', 'close'].includes(action[0])));
});

test('saved binding checks also preserve image-only editors and selected upload files', async t => {
  for (const options of [{ existingImageEditor: true }, { existingFileSelection: true }]) {
    const f = await fixture(t, options); await f.browser.ensurePage(); await f.page.goto(HOME + 'publish/publish');
    const original = f.page.form(), before = f.actions.length;
    const result = await f.browser.inspectAccount();
    assert.equal(result.state, 'connected'); assert.equal(f.pages.length, 2);
    assert.equal(f.page.url(), HOME + 'publish/publish'); assert.deepEqual(f.page.form(), original);
    assert.ok(!f.actions.slice(before).some(action => ['front', 'fill', 'upload', 'click', 'close'].includes(action[0])));
  }
});

test('a preserved editor cannot supply stale identity to a newly opened binding-check tab', async t => {
  const f = await fixture(t, { snapshot: value => ({ ...value, account: null }) });
  await f.browser.ensurePage(); await f.browser.navigate(f.page, HOME + 'publish/publish'); f.page.editManually('MOCK 私人编辑内容');
  const request = {}; f.page.handlers.request(request);
  const oldResponse = () => f.page.handlers.response({ request: () => request, url: () => HOME + 'api/galaxy/user/info', json: async () => ({ data: { userId: 'mock-old-account', nickname: 'MOCK 旧账号' } }) });
  oldResponse(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.browser.observedAccount.account.id, 'mock-old-account');
  const checked = await f.browser.inspectAccount(); assert.equal(checked.state, 'needs_attention'); assert.equal(checked.account, null);
  const control = f.browser.page; assert.notEqual(control, f.page);
  oldResponse(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.browser.stateFor(await f.browser.snapshot(control)).state, 'needs_attention');
  const current = {}; control.handlers.request(current);
  control.handlers.response({ request: () => current, url: () => HOME + 'api/galaxy/user/info', json: async () => ({ data: { userId: ACCOUNT.id, nickname: ACCOUNT.nickname } }) });
  await Promise.resolve(); await Promise.resolve();
  oldResponse(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.browser.stateFor(await f.browser.snapshot(control)).account.id, ACCOUNT.id);
  assert.equal(f.page.form().content, 'MOCK 私人编辑内容');
});

test('saving after a binding check uses a fresh editor while leaving manual content intact', async t => {
  const f = await fixture(t); await f.browser.ensurePage();
  await f.page.goto(HOME + 'publish/publish'); f.page.editManually('MOCK 用户自己的待发布正文');
  const original = f.page.form(), result = await f.browser.saveDraft(f.payload);
  assert.equal(result.state, 'verified'); assert.equal(result.submitted, true);
  assert.equal(f.page.url(), HOME + 'publish/publish'); assert.deepEqual(f.page.form(), original);
  assert.equal(f.actions.filter(action => action[0] === 'upload').length, 1);
  assert.equal(f.actions.filter(action => action[0] === 'click' && action[1] === 'save').length, 1);
});

test('login, challenge, missing identity and browser failures remain explicit rather than connected', async t => {
  for (const [state, snapshot] of [
    ['login_required', value => ({ ...value, login: true, account: null })],
    ['needs_attention', value => ({ ...value, challenge: true })],
    ['needs_attention', value => ({ ...value, account: null })],
  ]) {
    const f = await fixture(t, { snapshot }); const result = await f.browser.openLogin(); assert.equal(result.state, state); assert.equal(result.account, null);
  }
  const f = await fixture(t, { launchThrows: true }); const result = await f.browser.openLogin();
  assert.equal(result.state, 'browser_unavailable'); assert.ok(!result.message.includes('private browser secret'));
});

test('late identity is reread within bounds and only self responses from the current navigation are accepted', async t => {
  let reads = 0;
  const delayed = await fixture(t, { snapshot: value => ({ ...value, account: ++reads < 4 ? null : ACCOUNT }) });
  const result = await delayed.browser.openLogin(); assert.equal(result.state, 'connected'); assert.equal(reads, 4);
  const f = await fixture(t, { snapshot: value => ({ ...value, account: null }) }); await f.browser.ensurePage();
  await f.browser.navigate(f.page, HOME);
  const request = {}; f.page.handlers.request(request);
  f.page.handlers.response({ request: () => request, url: () => HOME + 'api/galaxy/user/info', json: async () => ({data:{userId:ACCOUNT.id,nickname:ACCOUNT.nickname,token:'MOCK_SECRET_DO_NOT_EXPORT'}}) });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.browser.stateFor(await f.browser.snapshot(f.page)).account.id, ACCOUNT.id);
  assert.ok(!JSON.stringify(f.browser.stateFor(await f.browser.snapshot(f.page))).includes('MOCK_SECRET'));
  const stale = {}; f.page.handlers.request(stale); await f.browser.navigate(f.page, HOME);
  f.page.handlers.response({request:()=>stale,url:()=>HOME+'api/galaxy/user/info',json:async()=>({data:{userId:'foreign-old-account'}})});
  await Promise.resolve(); assert.equal(f.browser.stateFor(await f.browser.snapshot(f.page)).state,'needs_attention');
  for (const source of ['https://example.org/api/galaxy/user/info', HOME + 'api/galaxy/user/profile']) {
    const ignored={};f.page.handlers.request(ignored);f.page.handlers.response({request:()=>ignored,url:()=>source,json:async()=>({data:ACCOUNT})});
    await Promise.resolve();assert.equal(f.browser.stateFor(await f.browser.snapshot(f.page)).state,'needs_attention');
  }
});

test('sync reads bounded visible notes and statistics and clears all data on an identity change', async t => {
  const f = await fixture(t); const result = await f.browser.sync();
  assert.equal(result.state, 'connected'); assert.equal(result.notes.length, 1); assert.equal(result.notes[0].likes, 0); assert.equal(result.notes[0].collects, null);
  assert.equal(result.metrics.find(item => item.id === 'exposure').value, 500);
  assert.equal(result.coverage.limit, 50); assert.match(result.coverage.message, /首批/);
  assert.equal(f.actions.filter(action => action[0] === 'navigate').length, 4);
  const changed = await fixture(t, { snapshot: value => /\/(?:manage\/notes|new\/note-manager)/.test(value.url) ? { ...value, account: { id: 'different-account', nickname: 'MOCK B' } } : value });
  const inconsistent = await changed.browser.sync(); assert.equal(inconsistent.state, 'needs_attention'); assert.deepEqual(inconsistent.notes, []); assert.deepEqual(inconsistent.metrics, []);
});

test('sync accepts identity-less authenticated subpages only after a second fresh HOME identity check', async t => {
  const f = await fixture(t, { snapshot: value => value.url === HOME ? value : { ...value, account: null } });
  const result = await f.browser.sync();
  assert.equal(result.state, 'connected'); assert.equal(result.account.id, ACCOUNT.id);
  assert.equal(result.notes.length, 1); assert.equal(result.notes[0].likes, 0);
  assert.equal(result.metrics.find(item => item.id === 'exposure').value, 500);
  assert.deepEqual(f.actions.filter(action => action[0] === 'navigate').map(action => action[1]), [HOME, HOME+'new/note-manager', HOME+'statistics/account/v2', HOME]);
  assert.ok(!f.actions.some(action => ['fill','upload','click','front'].includes(action[0])));
});

test('sync discards provisional data when the final fresh HOME identity changes or cannot be confirmed', async t => {
  for (const finalState of [
    { account: { id:'mock-other-account', nickname:'MOCK B' } },
    { account: null },
    { account: null, login: true },
    { account: null, challenge: true },
  ]) {
    let homeReads=0;
    const f=await fixture(t,{snapshot:value=>value.url===HOME?(++homeReads===1?value:{...value,...finalState}):{...value,account:null}});
    const result=await f.browser.sync();
    assert.notEqual(result.state,'connected'); assert.deepEqual(result.notes,[]); assert.deepEqual(result.metrics,[]);
    assert.match(result.coverage.message,/本轮未合并/); assert.ok(homeReads>=2);
    if(finalState.account)assert.equal(result.accountMismatch,true);
  }
});

test('sync rejects an explicit changed account, login, challenge or foreign origin after reading the first subpage',async t=>{
  for(const change of [
    {account:{id:'mock-other-account',nickname:'MOCK B'}},
    {account:null,login:true},
    {account:null,challenge:true},
    {account:null,url:'https://example.org/foreign'},
  ]){
    const f=await fixture(t,{snapshot:value=>value.url.includes('/statistics/')?{...value,...change}:value});
    const result=await f.browser.sync();assert.notEqual(result.state,'connected');assert.deepEqual(result.notes,[]);assert.deepEqual(result.metrics,[]);
    assert.match(result.coverage.message,/本轮未合并/);
  }
});

test('sync records denied statistics permissions without borrowing visible numbers or treating missing data as zero',async t=>{
  for(const notice of ['暂无访问权限','数据权限申请中，次日再来查看']){
    const f=await fixture(t,{snapshot:value=>value.url.includes('/statistics/')?{...value,account:null,text:notice}:value});
    const result=await f.browser.sync();assert.equal(result.state,'connected');assert.equal(result.notes.length,1);assert.deepEqual(result.metrics,[]);
    assert.match(result.coverage.message,/权限/);assert.match(result.message,/部分页面/);
  }
});

test('sync accepts the known statistics redirect and refuses unrelated routes without reading their cards',async t=>{
  const redirected=await fixture(t,{snapshot:value=>value.url.includes('/statistics/')?{...value,account:null,url:HOME+'statistics/account/v2?from=menu'}:value});
  const known=await redirected.browser.sync();assert.equal(known.state,'connected');assert.equal(known.metrics.find(item=>item.id==='exposure').value,500);
  assert.ok(known.metrics.every(item=>item.source===HOME+'statistics/account/v2'));
  const unrelated=await fixture(t,{snapshot:value=>value.url!==HOME?{...value,account:null,url:HOME}:value});
  const ignored=await unrelated.browser.sync();assert.equal(ignored.state,'connected');assert.deepEqual(ignored.notes,[]);assert.deepEqual(ignored.metrics,[]);
  assert.equal(ignored.coverage.hasMore,null);assert.match(ignored.coverage.message,/未支持的位置/);
});

test('sync preserves an unsaved editor while checking HOME identity before and after provisional data reads',async t=>{
  const f=await fixture(t,{snapshot:value=>value.url===HOME?value:{...value,account:null}});await f.browser.ensurePage();
  await f.page.goto(HOME+'publish/publish');f.page.editManually('MOCK 未保存的人工正文');const original=f.page.form();
  const result=await f.browser.sync();assert.equal(result.state,'connected');assert.equal(f.pages.length,2);
  assert.equal(f.page.url(),HOME+'publish/publish');assert.deepEqual(f.page.form(),original);assert.equal(f.page.isClosed(),false);
  assert.ok(!f.actions.some(action=>['fill','upload','click','front'].includes(action[0])));
});

const POSTED = HOME + 'api/galaxy/v2/creator/note/user/posted';
const POSTED_ROW = { id: '1234567890abcdef12345678', display_title: 'MOCK 可见作品', time: '2026-11-09 10:30', images_list: [{ url: 'https://example.org/mock.png?xsec_token=MOCK-private' }], likes: 0, comments_count: 3, collected_count: null, view_count: 22, xsec_token: 'MOCK-secret', xsec_source: 'MOCK-private' };
const visiblePosted = { title: POSTED_ROW.display_title, publishedAt: POSTED_ROW.time, text: 'MOCK 卡片', values: [], imageUrl: '' };
function emitPosted(page, rows, { endpoint = POSTED, request = null, json } = {}) {
  const req = request || { method: () => 'GET', url: () => endpoint };
  if (!request) page.handlers.request(req);
  page.handlers.response({ request: () => req, url: () => endpoint, status: () => 200, json: json || (async () => ({ success: true, data: { notes: rows } })) });
  return req;
}

test('sync matches only unique visible own notes from the normal navigation response and drops private fields', async t => {
  const f = await fixture(t, {
    onGoto(target, page) { if (target.endsWith('/new/note-manager')) emitPosted(page, [POSTED_ROW, { ...POSTED_ROW, id: 'abcdef123456789012345678', display_title: 'MOCK 不可见作品' }]); },
    snapshot(value) { return value.url.endsWith('/new/note-manager') ? { ...value, account: null, notes: [visiblePosted], notesCount: '18' } : value; },
  });
  const result = await f.browser.sync(); assert.equal(result.state, 'connected'); assert.equal(result.notes.length, 1); assert.equal(result.account.notesCount, 18);
  assert.deepEqual(result.notes[0], { id: POSTED_ROW.id, title: POSTED_ROW.display_title, url: 'https://www.xiaohongshu.com/explore/' + POSTED_ROW.id, publishedAt: POSTED_ROW.time, likes: 0, comments: 3, collects: null, views: 22, imageUrl: 'https://example.org/mock.png' });
  assert.ok(!JSON.stringify(result).includes('xsec')); assert.ok(!JSON.stringify(result).includes('MOCK-secret'));
  assert.equal(f.page.listenerCount('request'), 1); assert.equal(f.page.listenerCount('response'), 1, 'Temporary listeners are removed; normal self-identity listeners remain');
});

test('sync rejects stale requests, unrelated response paths and ambiguous posted or visible title/time pairs', async t => {
  for (const scenario of ['stale-request', 'recommendation', 'duplicate-response', 'duplicate-posted', 'duplicate-visible', 'wrong-time', 'wrong-dom-id', 'dom-id-without-posted']) {
    let stale;
    const f = await fixture(t, {
      onGoto(target, page) {
        if (target === HOME) { stale = { method: () => 'GET', url: () => POSTED }; page.handlers.request(stale); }
        if (!target.endsWith('/new/note-manager')) return;
        if (scenario === 'dom-id-without-posted') return;
        if (scenario === 'stale-request') emitPosted(page, [POSTED_ROW], { request: stale });
        else if (scenario === 'recommendation') emitPosted(page, [POSTED_ROW], { endpoint: HOME + 'api/galaxy/v2/creator/note/recommend' });
        else if (scenario === 'duplicate-response') { emitPosted(page, [POSTED_ROW]); emitPosted(page, [POSTED_ROW]); }
        else emitPosted(page, scenario === 'duplicate-posted' ? [POSTED_ROW, { ...POSTED_ROW, id: 'abcdef123456789012345678' }] : [POSTED_ROW]);
      },
      snapshot(value) { return value.url.endsWith('/new/note-manager') ? { ...value, account: null, notes: scenario === 'duplicate-visible' ? [visiblePosted, visiblePosted] : [{ ...visiblePosted, ...(scenario === 'wrong-time' ? { publishedAt: '2026-11-09 10:31' } : {}), ...(scenario === 'wrong-dom-id' ? { id: 'mock-unrelated-note' } : scenario === 'dom-id-without-posted' ? { id: POSTED_ROW.id } : {}) }] } : value; },
    });
    const result = await f.browser.sync(); assert.equal(result.state, 'connected', scenario); assert.deepEqual(result.notes, [], scenario);
    assert.equal(f.page.listenerCount('response'), 1, scenario);
  }
});

test('a posted response decoded after its navigation cannot contribute data', async t => {
  let finish;
  const f = await fixture(t, {
    onGoto(target, page) {
      if (target.endsWith('/new/note-manager')) emitPosted(page, [], { json: () => new Promise(resolve => { finish = () => resolve({ success: true, data: { notes: [POSTED_ROW] } }); }) });
      if (target.endsWith('/statistics/account/v2')) finish?.();
    },
    snapshot(value) { return value.url.endsWith('/new/note-manager') ? { ...value, notes: [visiblePosted] } : value; },
  });
  const result = await f.browser.sync(); await Promise.resolve(); assert.equal(result.state, 'connected'); assert.deepEqual(result.notes, []); assert.equal(f.page.listenerCount('response'), 1);
});

test('V2 analytics never fill missing overview cards from unrelated body labels', async t => {
  const f = await fixture(t, { snapshot(value) { return value.url.endsWith('/statistics/account/v2') ? { ...value, metrics: [{ label: '曝光数', value: '57' }], text: '点赞：999\n观看数：888\n评论：777' } : value; } });
  const result = await f.browser.sync(); assert.equal(result.metrics.find(item => item.id === 'exposure').value, 57);
  for (const id of ['likes', 'views', 'comments']) assert.equal(result.metrics.find(item => item.id === id).value, null);
});

test('draft refuses invalid paths, unknown account and mismatched identity before any upload', async t => {
  const f = await fixture(t);
  assert.equal((await f.browser.saveDraft({ ...f.payload, images: ['relative.png'] })).submitted, false);
  assert.equal(f.launches(), 0);
  const result = await f.browser.saveDraft({ ...f.payload, accountId: 'another-account' });
  assert.equal(result.state, 'failed'); assert.equal(result.accountMismatch, true); assert.equal(result.submitted, false);
  assert.ok(!f.actions.some(action => action[0] === 'upload' || action[0] === 'fill' || action[0] === 'click'));
});

test('draft never overwrites an existing manual editor and cannot silently truncate generated text', async t => {
  const f = await fixture(t, { existingEditor: true }); const refused = await f.browser.saveDraft(f.payload);
  assert.equal(refused.state, 'failed'); assert.equal(refused.submitted, false); assert.ok(!f.actions.some(action => action[0] === 'upload'));
  for (const option of [{ existingImageEditor: true }, { existingFileSelection: true }]) {
    const imagesOnly = await fixture(t, option), result = await imagesOnly.browser.saveDraft(imagesOnly.payload);
    assert.equal(result.state, 'failed'); assert.equal(result.submitted, false); assert.ok(!imagesOnly.actions.some(action => action[0] === 'upload'));
  }
  const truncated = await fixture(t, { truncateTitle: true }); const result = await truncated.browser.saveDraft(truncated.payload);
  assert.equal(result.state, 'filled'); assert.equal(result.submitted, false); assert.ok(!truncated.actions.some(action => action[1] === 'save'));
});

test('draft is verified only after reopening exact title, full copy and image count, with no publish action', async t => {
  const f = await fixture(t); const result = await f.browser.saveDraft(f.payload);
  assert.equal(result.state, 'verified'); assert.equal(result.submitted, true); assert.ok(result.verifiedAt);
  assert.deepEqual(f.actions.filter(action => action[0] === 'click').map(action => action[1]), ['image-tab', 'save', 'draft-entry', 'draft-item']);
  const roles = f.actions.filter(action => action[0] === 'selector-role');
  assert.ok(roles.every(action => !action[2].test('发布') && !action[2].test('定时发布')));
});

test('a verified editor is left intact while a new control tab handles the next draft', async t => {
  const f = await fixture(t); const first = await f.browser.saveDraft(f.payload); assert.equal(first.state, 'verified');
  assert.equal(f.pages.length, 2); f.page.editManually('MOCK 用户之后修改的文字');
  const checked = await f.browser.inspectAccount(); assert.equal(checked.state, 'connected');
  const next = await f.browser.saveDraft({ ...f.payload, title: 'MOCK 第二篇', content: 'MOCK 第二篇正文' });
  assert.equal(next.state, 'verified'); assert.equal(f.page.form().content, 'MOCK 用户之后修改的文字');
});

test('save uncertainty, absent draft readback and changed reopened content never claim success or retry a click', async t => {
  for (const options of [{ saveThrows: true }, { noDraftEntry: true }, { duplicateDraft: true }, { reopenedDifferent: true }]) {
    const f = await fixture(t, options), result = await f.browser.saveDraft(f.payload);
    assert.equal(result.state, 'unknown'); assert.equal(result.submitted, true);
    assert.equal(f.actions.filter(action => action[0] === 'click' && action[1] === 'save').length, 1);
  }
  const f = await fixture(t, { noSaveButton: true }); const result = await f.browser.saveDraft(f.payload);
  assert.equal(result.state, 'filled'); assert.equal(result.submitted, false);
});

test('copy checks allow rendered paragraph spacing while preserving words, blank paragraphs, topics and emoji', async t => {
  const f = await fixture(t, { paragraphCssSpacing: true });
  assert.equal((await f.browser.saveDraft(f.payload)).state, 'verified');
  assert.deepEqual(compareXhsCopy({ title: '示例🚀', content: '第一段\n\n#工具 🧑‍💻' }, { title: '示例🚀', content: '第一段\n\n\n\n#工具 🧑‍💻', semantic: '第一段\n\n#工具 🧑‍💻' }), { matches: true, formatAdjusted: true });
  for (const semantic of ['第一段\n#工具 🧑‍💻', '第一段\n\n#工具 🧑', '第一段\n\n工具 🧑‍💻', '第一段\n\n#工具！ 🧑‍💻']) {
    const check = compareXhsCopy({ title: '示例🚀', content: '第一段\n\n#工具 🧑‍💻' }, { title: '示例🚀', content: semantic, semantic });
    assert.equal(check.matches, false); assert.equal(check.field, 'content'); assert.ok(check.firstDifference > 0);
  }
  const differentTitle = compareXhsCopy({ title: '示例🚀', content: '' }, { title: '示例', content: '', semantic: '' });
  assert.equal(differentTitle.field, 'title'); assert.equal(differentTitle.expectedLength, 3); assert.equal(differentTitle.actualLength, 2);
  const truncated = await fixture(t, { truncateTitle: true }), result = await truncated.browser.saveDraft(truncated.payload);
  assert.match(result.message, /标题与原稿不一致.*原稿\d+字.*页面3字.*第4字起不同/);
  assert.doesNotMatch(result.message, /可能有字数限制/);
});

test('copy verification waits for stable editor content and never accepts ongoing changes', async t => {
  const f = await fixture(t); let reads = 0, waits = 0;
  const page = { async waitForTimeout() { waits++; } }, titleInput = { async inputValue() { return title; } };
  const editor = { async innerText() { reads++; return reads < 3 ? '正在更新' : content; }, async evaluate() { return reads < 3 ? '正在更新' : content; } };
  const check = await f.browser.stableDraftCopy(page, titleInput, editor, { title, content });
  assert.equal(check.matches, true); assert.equal(check.stable, true); assert.ok(waits >= 4);
  const changing = { async innerText() { return String(++reads); }, async evaluate() { return content; } };
  const unstable = await f.browser.stableDraftCopy(page, titleInput, changing, { title, content });
  assert.equal(unstable.matches, false); assert.equal(unstable.stable, false);
});

test('explicit draft recheck only reads saved content and preserves any manually edited page', async t => {
  const f = await fixture(t, { savedDraft: true }); await f.browser.ensurePage();
  await f.page.goto(HOME + 'publish/publish'); f.page.editManually('MOCK 原编辑页上的人工修改');
  const result = await f.browser.verifyDraft({ ...f.payload, count: 1 });
  assert.equal(result.state, 'verified'); assert.equal(result.accountId, ACCOUNT.id); assert.ok(result.verifiedAt);
  assert.equal(f.page.form().content, 'MOCK 原编辑页上的人工修改');
  assert.ok(!f.actions.some(action => ['fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
  assert.deepEqual(f.actions.filter(action => action[0] === 'click').map(action => action[1]), ['draft-entry', 'draft-item']);
  assert.ok(f.pages.length >= 3);
});

test('draft recheck rejects duplicates, altered content, wrong image counts and account changes without writing', async t => {
  for (const [options, extra, message] of [
    [{ savedDraft: true, duplicateDraft: true }, {}, /多个.*同名草稿/],
    [{ savedDraft: true, reopenedDifferent: true }, {}, /正文与原稿不一致/],
    [{ savedDraft: true }, { count: 2 }, /图片数量与原稿不一致/],
    [{ savedDraft: true, noDraftEntry: true }, {}, /草稿入口/],
    [{ savedDraft: true }, { accountId: 'different-account' }, /账号/],
  ]) {
    const f = await fixture(t, options), result = await f.browser.verifyDraft({ ...f.payload, count: 1, ...extra });
    assert.equal(result.state, 'unknown'); assert.match(result.message, message);
    assert.ok(!f.actions.some(action => ['fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
    if (options.duplicateDraft) assert.equal(f.actions.filter(action => action[0] === 'click' && action[1] === 'draft-item').length, 2);
  }
});

test('same-title drafts require exactly one complete match after bounded read-only enumeration', async t => {
  const f = await fixture(t, { savedDraft: true, duplicateDraft: true, otherDraftContent: 'MOCK 旧版正文' });
  const result = await f.browser.verifyDraft({ ...f.payload, count: 1 });
  assert.equal(result.state, 'verified');
  assert.equal(f.actions.filter(action => action[0] === 'front').at(-1)[1], 0);
  assert.equal(f.actions.filter(action => action[0] === 'click' && action[1] === 'draft-item').length, 2);
  assert.ok(!f.actions.some(action => ['fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
  const changed = await fixture(t, { savedDraft: true, duplicateDraft: true, otherDraftContent: 'MOCK 旧版正文', changingList: true });
  const uncertain = await changed.browser.verifyDraft({ ...changed.payload, count: 1 });
  assert.equal(uncertain.state, 'unknown'); assert.match(uncertain.message, /列表发生变化/);
  const tooMany = await fixture(t, { savedDraft: true, draftCount: 6 });
  const bounded = await tooMany.browser.verifyDraft({ ...tooMany.payload, count: 1 });
  assert.equal(bounded.state, 'unknown'); assert.match(bounded.message, /超过5份/);
  assert.ok(!tooMany.actions.some(action => action[0] === 'click' && action[1] === 'draft-item'));
});

test('visually indistinguishable same-title cards are not enumerated or mistaken for a unique version', async t => {
  const f = await fixture(t, { savedDraft: true, draftCount: 3, identicalCards: true, otherDraftContent: 'MOCK 另一个版本' });
  const result = await f.browser.verifyDraft({ ...f.payload, count: 1 });
  assert.equal(result.state, 'unknown'); assert.match(result.message, /可见卡片信息相同/);
  assert.ok(!f.actions.some(action => action[0] === 'click' && action[1] === 'draft-item'));
  assert.ok(!f.actions.some(action => ['fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
});

test('real DOM fixtures ignore recommendations, read only explicit self identity, and detect login/challenge', { timeout: 20000 }, async t => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try { await access(chrome); } catch { t.skip('System Chrome is optional for DOM fixture verification'); return; }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  t.after(() => browser.close()); const page = await browser.newPage();
  await page.setContent('<body><nav>创作中心</nav><section class="recommend"><a href="https://www.xiaohongshu.com/user/profile/foreign-123">其他作者</a></section></body>');
  assert.equal((await page.evaluate(readVisibleXhsPage)).account, null);
  await page.setContent('<body><div data-self-user-id="mock-self-123" data-nickname="MOCK 本人"></div><section class="note-card" data-note-id="mock-note-123"><a href="https://www.xiaohongshu.com/explore/mock-note-123"><span class="note-title">MOCK 工具演示</span></a><p>点赞\n0</p></section></body>');
  const own = await page.evaluate(readVisibleXhsPage); assert.equal(own.account.id, 'mock-self-123'); assert.equal(own.notes.length, 1); assert.equal(own.notes[0].title, 'MOCK 工具演示');
  await page.setContent('<body><div class="metric-card"><span class="number">57</span><span class="label">曝光量</span></div><div class="metric-card"><span class="label">观看量</span><span class="number">20</span></div><div class="metric-card"><span class="label">评论</span><span class="number">--</span></div></body>');
  const cards = await page.evaluate(readVisibleXhsPage), metrics = metricsFromVisibleText(cards.text, HOME, '', cards.metrics);
  assert.equal(metrics.find(item => item.id === 'exposure').value, 57); assert.equal(metrics.find(item => item.id === 'views').value, 20); assert.equal(metrics.find(item => item.id === 'comments').value, null);
  await page.setContent('<body><div class="login-container">扫码登录</div></body>'); assert.equal((await page.evaluate(readVisibleXhsPage)).login, true);
  await page.setContent('<body><div class="captcha">请完成验证</div></body>'); assert.equal((await page.evaluate(readVisibleXhsPage)).challenge, true);
  // This creator URL is fulfilled locally; no account or website is contacted.
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<body>MOCK</body>'}));
  await page.goto(HOME+'new/home');
  const summary='<div class="static description-text"><div class="text"><span class="numerical">0</span><span>关注数</span></div><div class="text"><span class="numerical">1.2万</span><span>粉丝数</span></div><div class="text"><span class="numerical">3,456</span><span>获赞与收藏</span></div></div>';
  await page.setContent('<body><div data-self-user-id="mock-self-123"></div>'+summary+'</body>');
  const summarySnapshot=await page.evaluate(readVisibleXhsPage);assert.deepEqual(summarySnapshot.accountStats,{followers:'1.2万',following:'0',likes:'3,456'});
  await page.setContent('<body><section class="recommend">'+summary+'</section></body>');
  assert.deepEqual((await page.evaluate(readVisibleXhsPage)).accountStats,{followers:null,following:null,likes:null});
  await page.setContent('<body>'+summary+summary+'</body>');
  assert.deepEqual((await page.evaluate(readVisibleXhsPage)).accountStats,{followers:null,following:null,likes:null});
  await page.setContent('<body><div class="static description-text"><div><span class="numerical">1</span><span>粉丝数</span></div><div><span class="numerical">2</span><span>粉丝数</span></div></div></body>');
  assert.equal((await page.evaluate(readVisibleXhsPage)).accountStats.followers,null);
  await page.goto(HOME+'manage/notes');await page.setContent('<body>'+summary+'</body>');
  assert.deepEqual((await page.evaluate(readVisibleXhsPage)).accountStats,{followers:null,following:null,likes:null});
  await page.goto(HOME+'statistics/account/v2');
  const overview='<div class="indicators"><div class="indicators-header"><div class="title">数据总览<br>统计周期 11-01 至 11-07</div></div><div class="datas">'+[
    ['曝光数','1.2','万'],['观看数','345',''],['封面点击率','3.14','%'],['平均观看时长','37','秒'],
  ].map(([label,value,unit])=>`<div class="creator-block"><div class="title">${label}</div><div class="number-container"><span class="number">${value}</span><span class="unit">${unit}</span></div><div class="tendency"><span class="number">999</span>同类比较</div></div>`).join('')+'</div><div class="area-graph">MOCK 走势</div></div>';
  await page.setContent('<body><section class="recommend">点赞：999<br>观看数：888</section>'+overview+'</body>');
  const v2=await page.evaluate(readVisibleXhsPage),v2metrics=metricsFromVisibleText('',HOME+'statistics/account/v2',v2.period,v2.metrics);
  assert.equal(v2.period,'统计周期 11-01 至 11-07');assert.equal(v2.metrics.length,3);
  assert.equal(v2metrics.find(item=>item.id==='exposure').value,12000);assert.equal(v2metrics.find(item=>item.id==='views').value,345);assert.equal(v2metrics.find(item=>item.id==='click_rate').value,3.14);assert.equal(v2metrics.find(item=>item.id==='likes').value,null);
  for(const html of [overview+overview,'<section class="recommend">'+overview+'</section>','<div>曝光数：777<br>点赞：999</div>']){
    await page.setContent('<body>'+html+'</body>');const ignored=await page.evaluate(readVisibleXhsPage);assert.deepEqual(ignored.metrics,[]);assert.equal(ignored.period,'');
  }
  await page.goto(HOME+'new/note-manager');
  const noteCard='<div class="note-card"><div class="note-card__cover"></div><div class="note-card__body"><span class="note-card__title">MOCK 可见作品</span><span class="note-card__time">2026-11-09 10:30</span></div></div>',tabs='<div class="tab-list"><div class="tab-item">全部 18</div><div class="tab-item">已发布</div></div>';
  await page.setContent('<body>'+tabs+'<div class="notes-container">'+noteCard+'<section class="recommend">'+noteCard+'</section></div>'+noteCard+'</body>');
  const notesPage=await page.evaluate(readVisibleXhsPage);assert.equal(notesPage.notesCount,'18');assert.equal(notesPage.notes.length,1);assert.equal(notesPage.notes[0].id,undefined);assert.equal(notesPage.notes[0].publishedAt,'2026-11-09 10:30');
  await page.evaluate(() => { document.querySelector('.notes-container > .note-card .note-card__cover').onclick = () => { document.body.dataset.noteOpened = 'true'; }; });
  assert.equal(await page.evaluate(clickVisibleXhsNote, { title: 'MOCK 可见作品', publishedAt: '2026-11-09 10:30' }), true); assert.equal(await page.getAttribute('body', 'data-note-opened'), 'true');
  await page.setContent('<body>'+tabs+tabs+'</body>');assert.equal((await page.evaluate(readVisibleXhsPage)).notesCount,null);
  await page.goto(HOME+'new/home');await page.setContent('<body>'+tabs+'</body>');assert.equal((await page.evaluate(readVisibleXhsPage)).notesCount,null);
  await page.setContent('<div contenteditable="true" class="ql-editor"><p>第一段</p><p><br></p><p>第二段<span>#工具</span> 🧑‍💻</p></div>');
  let editor = page.locator('.ql-editor');
  assert.equal(await editor.evaluate(readXhsEditorCopy), '第一段\n\n第二段#工具 🧑‍💻');
  await page.setContent('<div contenteditable="true" class="tiptap"><p style="margin:1em">第一行</p><p style="margin:1em">第二行<br>第三行 <span data-type="topic">#工具</span>🚀</p></div>');
  editor = page.locator('.tiptap');
  assert.equal(await editor.evaluate(readXhsEditorCopy), '第一行\n第二行\n第三行 #工具🚀');
  await page.goto('about:blank');
  const pending = await page.evaluate(readVisibleXhsNote, { noteId: 'mock-published-123' }); assert.equal(pending.pending, true); assert.equal(pending.challenge, false);
  await page.goto('https://www.xiaohongshu.com/explore/mock-published-123');
  await page.setContent('<div class="verify-info">MOCK 已认证作者</div>');
  await page.evaluate(() => { window.__INITIAL_STATE__ = { note: { noteDetailMap: { selected: { note: { noteId: 'mock-published-123', title: 'MOCK 官方全文', desc: '完整第一段\n\n第二段 #工具', type: 'normal', user: { userId: 'mock-self-123' }, imageList: [{ urlDefault: 'https://example.org/one.png' }, { infoList: [{ imageScene: 'WB_DFT', url: 'https://example.org/two.png' }] }], tagList: [{ name: '工具' }] } }, recommendation: { note: { noteId: 'mock-another-123', desc: 'MOCK 不属于目标笔记' } } } } }; });
  const full = await page.evaluate(readVisibleXhsNote, { noteId: 'mock-published-123' }); assert.equal(full.challenge, false); assert.equal(full.note.authorId, 'mock-self-123'); assert.equal(full.note.images.length, 2); assert.equal(full.note.isComplete, true); assert.equal(full.note.content, '完整第一段\n\n第二段 #工具');
  assert.equal(await page.evaluate(canCloseXhsReadPopup, { noteId: 'mock-published-123' }), true);
  await page.setContent('<textarea>MOCK 用户正在输入的评论</textarea>'); assert.equal(await page.evaluate(canCloseXhsReadPopup, { noteId: 'mock-published-123' }), false);
  assert.equal((await page.evaluate(readVisibleXhsNote, { noteId: 'mock-another-123' })).note, null);
  await page.goto(HOME + 'publish/publish');
  await page.setContent('<div class="draft-list"><div class="draft-card" data-draft-id="mock-official-draft"><img src="https://example.org/cover.png"><div class="draft-card__body"><div class="draft-title">MOCK 官方草稿</div><time datetime="2026-11-10T10:00:00Z">今天</time></div><button onclick="document.body.dataset.deleted=\'true\'">删除</button></div></div>');
  const list = await page.evaluate(readVisibleXhsDrafts); assert.equal(list.cards.length, 1); assert.equal(list.cards[0].officialDraftId, 'mock-official-draft'); assert.equal(list.cards[0].title, 'MOCK 官方草稿');
  assert.equal(await page.evaluate(clickVisibleXhsDraft, { index: 0, signature: 'MOCK wrong signature' }), false);
  await page.evaluate(() => { document.querySelector('.draft-title').onclick = () => { document.body.dataset.opened = 'true'; }; });
  assert.equal(await page.evaluate(clickVisibleXhsDraft, { index: 0, signature: list.cards[0].signature }), true);
  assert.equal(await page.getAttribute('body', 'data-opened'), 'true'); assert.equal(await page.getAttribute('body', 'data-deleted'), null);
  await page.evaluate(() => { document.querySelector('.draft-card img').src = 'https://example.org/changed-cover.png'; });
  assert.equal(await page.evaluate(clickVisibleXhsDraft, { index: 0, signature: list.cards[0].signature }), false, 'Outer card cover remains part of the locator signature');
  await page.setContent('<div class="img-preview-area"><div class="pr"><img src="https://example.org/visible.png"></div><div class="pr" style="display:none"><img></div></div>');
  const media = await page.evaluate(readVisibleXhsDraftImages); assert.equal(media.count, 2); assert.equal(media.images.length, 2); assert.equal(media.isComplete, false);
  await page.setContent('<div class="draft-item" data-draft-id="mock-outside-drawer"><div class="draft-title">MOCK 底层卡片</div></div><div class="draft-drawer"><div class="draft-list"><div class="draft-item" data-draft-id="mock-real-draft" data-draft-type="image"><div class="draft-cover"><img src="https://example.org/real-cover.png"></div><div class="draft-info"><div class="draft-info-desc"><div class="draft-title-text has-title">MOCK 真实图文草稿</div><div class="draft-time">2026-11-10 13:22</div></div><div class="draft-actions"><div class="btn" onclick="document.body.dataset.deleted=\'true\'">删除</div><div class="btn" onclick="document.body.dataset.edited=\'true\'">编辑</div></div></div></div></div></div>');
  const drawer = await page.evaluate(readVisibleXhsDrafts); assert.equal(drawer.cards.length, 1); assert.equal(drawer.cards[0].officialDraftId, 'mock-real-draft'); assert.equal(drawer.cards[0].title, 'MOCK 真实图文草稿'); assert.equal(drawer.cards[0].updatedAt, '2026-11-10 13:22');
  assert.equal(await page.evaluate(clickVisibleXhsDraft, { index: 0, signature: drawer.cards[0].signature }), true); assert.equal(await page.getAttribute('body', 'data-edited'), 'true'); assert.equal(await page.getAttribute('body', 'data-deleted'), null);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', cdn = 'https://sns-webpic.xhscdn.com/mock-local.png?sign=MOCK-fixture&t=1';
  await page.route('https://sns-webpic.xhscdn.com/**', route => route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: Buffer.from(png, 'base64') }));
  await page.locator('.draft-drawer .draft-cover img').evaluate((image, source) => { image.src = source; }, cdn);
  const cdnAsset = await page.evaluate(readExistingXhsImageAssets, { images: [cdn], allowOfficialCdn: true }); assert.equal(cdnAsset.isComplete, true); assert.equal(cdnAsset.assets[0].mime, 'image/png'); assert.equal(cdnAsset.assets[0].base64, png); assert.ok(!JSON.stringify(cdnAsset).includes('MOCK-fixture'));
});

test('sync accumulates only visible matching own notes through ordinary pagination and reports the actual bounded range', async t => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ ...POSTED_ROW, id: `mock-paged-note-${index}`, display_title: `MOCK 分页 ${index}` }));
  let batch = 0;
  const f = await fixture(t, {
    onGoto(target, page) { if (target.endsWith('/new/note-manager')) { batch = 0; emitPosted(page, rows.slice(0, 2), { endpoint: POSTED + '?page=1' }); } },
    advanceNotes(page) { batch++; emitPosted(page, rows.slice(batch * 2, batch * 2 + 2), { endpoint: POSTED + '?page=' + (batch + 1) }); return { attempted: true }; },
    snapshot(value) { return value.url.endsWith('/new/note-manager') ? { ...value, notes: rows.slice(batch * 2, batch * 2 + 2).map(row => ({ title: row.display_title, publishedAt: row.time })), notesCount: '5', hasMore: batch < 2 } : value; },
  });
  const all = await f.browser.sync({ noteLimit: 200 });
  assert.deepEqual(all.notes.map(row => row.id), rows.map(row => row.id)); assert.equal(all.coverage.limit, 200); assert.equal(all.coverage.hasMore, false);
  const bounded = await f.browser.sync({ noteLimit: 3 }); assert.equal(bounded.notes.length, 3); assert.equal(bounded.coverage.hasMore, true); assert.equal(bounded.coverage.limit, 3);
  const capped = await f.browser.sync({ noteLimit: 10000 }); assert.equal(capped.coverage.limit, 200);
  assert.ok(!f.actions.some(action => ['fill', 'upload', 'front'].includes(action[0])));
  let second = false;
  const noTotal = await fixture(t, {
    onGoto(target, page) { if (target.endsWith('/new/note-manager')) emitPosted(page, rows.slice(0, 2), { endpoint: POSTED + '?page=1' }); },
    advanceNotes(page) { second = true; emitPosted(page, rows.slice(2, 4), { endpoint: POSTED + '?page=2' }); return { attempted: true }; },
    snapshot(value) { return value.url.endsWith('/new/note-manager') ? { ...value, notes: rows.slice(second ? 2 : 0, second ? 4 : 2).map(row => ({ title: row.display_title, publishedAt: row.time })), notesCount: null, hasMore: !second } : value; },
  });
  const overflow = await noTotal.browser.sync({ noteLimit: 3 }); assert.equal(overflow.notes.length, 3); assert.equal(overflow.coverage.hasMore, true, 'A final official page can still contain one row omitted by the local cap');
});

test('published detail requires the actual author ID and a second fresh HOME check', async t => {
  for (const authorId of [ACCOUNT.id, 'mock-foreign-author', '']) {
    const f = await fixture(t, { noteDetail: () => ({ note: { id: 'mock-published-123', authorId, title: 'MOCK 官方标题', content: 'MOCK 官方完整正文\n\n第二段', images: ['https://example.org/one.png', 'https://example.org/two.png'], tags: ['工具'], isComplete: true } }) });
    const result = await f.browser.readNote({ accountId: ACCOUNT.id, noteId: 'mock-published-123' });
    if (authorId === ACCOUNT.id) { assert.equal(result.detail.isComplete, true); assert.equal(result.detail.source, 'official'); assert.equal(result.detail.images.length, 2); assert.match(result.detail.content, /官方完整正文/); }
    else { assert.equal(result.detail, null); assert.equal(result.state, 'needs_attention'); }
    assert.deepEqual(f.actions.filter(action => action[0] === 'navigate').map(action => action[1]), [HOME, HOME + 'new/note-manager', HOME]);
    assert.equal(f.actions.filter(action => action[0] === 'read-note-open').length, 1); assert.ok(!JSON.stringify(result).includes('MOCK-do-not-export'));
    assert.ok(!f.actions.some(action => ['fill', 'upload', 'front'].includes(action[0]) || action[0] === 'click' && action[1] !== 'note-cover'));
  }
  let homes = 0;
  const changed = await fixture(t, { snapshot: value => value.url === HOME && ++homes > 1 ? { ...value, account: { id: 'mock-replaced-account' } } : value, noteDetail: () => ({ note: { id: 'mock-published-123', authorId: ACCOUNT.id, title, content, images: ['https://example.org/one.png'], isComplete: true } }) });
  const result = await changed.browser.readNote({ accountId: ACCOUNT.id, noteId: 'mock-published-123' }); assert.equal(result.detail, null); assert.equal(result.accountMismatch, true);
});

const draftCard = (overrides = {}) => ({ index: 0, officialDraftId: null, title, imageUrl: 'https://example.org/mock-cover.png', updatedAt: '2026-11-10 13:00', kind: 'image', signature: 'MOCK observed draft card signature', ...overrides });

test('official draft list keys are opaque session handles, refreshed and account-bound, never synthetic official IDs', async t => {
  const f = await fixture(t, { savedDraft: true, draftCards: [draftCard()] });
  const first = await f.browser.listDrafts({ accountId: ACCOUNT.id }), entry = first.officialDrafts[0];
  assert.equal(first.state, 'connected'); assert.equal(entry.officialDraftId, null); assert.equal(entry.canRead, true); assert.match(entry.key, /^[a-f\d-]{36}$/);
  const wrong = await f.browser.readDraft({ accountId: 'mock-other-account', key: entry.key }); assert.equal(wrong.accountMismatch, true); assert.equal(wrong.detail, null);
  const second = await f.browser.listDrafts({ accountId: ACCOUNT.id }); assert.notEqual(second.officialDrafts[0].key, entry.key);
  const stale = await f.browser.readDraft({ accountId: ACCOUNT.id, key: entry.key }); assert.equal(stale.detail, null); assert.match(stale.message, /失效/);
  assert.ok(!f.actions.some(action => ['fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
});

test('official draft detail reads copy and all previews without writes and preserves the reopened editor for later manual edits', async t => {
  const f = await fixture(t, { savedDraft: true, draftCards: [draftCard()] });
  const list = await f.browser.listDrafts({ accountId: ACCOUNT.id });
  const result = await f.browser.readDraft({ accountId: ACCOUNT.id, key: list.officialDrafts[0].key });
  assert.equal(result.state, 'connected'); assert.equal(result.detail.id, null); assert.equal(result.detail.title, title); assert.equal(result.detail.content, content); assert.equal(result.detail.isComplete, true); assert.equal(result.detail.images.length, 2);
  const reopened = f.pages.find(page => page.url() === HOME + 'publish/publish'); assert.ok(reopened); assert.notEqual(f.browser.page, reopened); reopened.editManually('MOCK 读取后人工修改');
  await f.browser.inspectAccount(); assert.equal(reopened.form().content, 'MOCK 读取后人工修改'); assert.equal(reopened.isClosed(), false);
  assert.ok(!f.actions.some(action => ['fill', 'upload', 'front'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
});

test('official draft detail refuses same-title ambiguity and a changed list before opening any editor', async t => {
  for (const mode of ['duplicate', 'changed']) {
    let changed = false;
    const f = await fixture(t, { savedDraft: true, draftCards: () => changed ? mode === 'duplicate' ? [draftCard(), draftCard({ index: 1, signature: 'MOCK different card same title' })] : [draftCard({ signature: 'MOCK modified visible card' })] : [draftCard()] });
    const list = await f.browser.listDrafts({ accountId: ACCOUNT.id }); changed = true;
    const result = await f.browser.readDraft({ accountId: ACCOUNT.id, key: list.officialDrafts[0].key });
    assert.equal(result.detail, null); assert.match(result.message, mode === 'duplicate' ? /歧义/ : /发生变化/);
    assert.ok(!f.actions.some(action => ['read-draft-open', 'fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
  }
});

test('official draft list and detail discard provisional data after a changed final HOME identity', async t => {
  for (const operation of ['list', 'detail']) {
    let homeReads = 0;
    const f = await fixture(t, { savedDraft: true, draftCards: [draftCard()], snapshot: value => value.url === HOME && ++homeReads === (operation === 'list' ? 2 : 4) ? { ...value, account: { id: 'mock-switched-account' } } : value });
    const listed = await f.browser.listDrafts({ accountId: ACCOUNT.id });
    if (operation === 'list') { assert.equal(listed.accountMismatch, true); assert.deepEqual(listed.officialDrafts, []); }
    else {
      const result = await f.browser.readDraft({ accountId: ACCOUNT.id, key: listed.officialDrafts[0].key }); assert.equal(result.accountMismatch, true); assert.equal(result.detail, null);
      assert.ok(f.pages.some(page => page.url() === HOME + 'publish/publish' && !page.isClosed()), 'Reopened editor remains available after the failed final check');
    }
    assert.ok(!f.actions.some(action => ['fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
  }
});

test('sync continues scrolling through an unchanged long rendered batch and respects the official end despite unmatched cards', async t => {
  const rows = Array.from({ length: 4 }, (_, index) => ({ ...POSTED_ROW, id: `mock-long-list-${index}`, display_title: `MOCK 长列表 ${index}` })); let scrolls = 0;
  const f = await fixture(t, {
    onGoto(target, page) { if (target.endsWith('/new/note-manager')) emitPosted(page, rows.slice(0, 2), { endpoint: POSTED + '?page=1' }); },
    advanceNotes(page) { scrolls++; if (scrolls === 4) emitPosted(page, rows.slice(2), { endpoint: POSTED + '?page=2' }); return { attempted: true, kind: 'scroll', position: scrolls * 500 }; },
    snapshot(value) { return value.url.endsWith('/new/note-manager') ? { ...value, notes: rows.slice(scrolls < 4 ? 0 : 2, scrolls < 4 ? 2 : 4).map(row => ({ title: row.display_title, publishedAt: row.time })), hasMore: scrolls < 4, notesCount: '4' } : value; },
  });
  const result = await f.browser.sync({ noteLimit: 200 }); assert.equal(scrolls, 4); assert.equal(result.notes.length, 4); assert.equal(result.coverage.hasMore, false);
  const partial = await fixture(t, {
    onGoto(target, page) { if (target.endsWith('/new/note-manager')) emitPosted(page, rows); },
    snapshot(value) { return value.url.endsWith('/new/note-manager') ? { ...value, notes: rows.slice(0, 2).map((row, index) => ({ title: index ? 'MOCK 无法匹配' : row.display_title, publishedAt: row.time })), notesCount: '4', hasMore: false } : value; },
  });
  const ended = await partial.browser.sync(); assert.equal(ended.notes.length, 1); assert.equal(ended.coverage.hasMore, false, 'Skipped or ambiguous rows do not imply another source page exists');
});

test('official draft detail stays partial when a hidden or unfinished preview has no complete image evidence', async t => {
  const f = await fixture(t, { savedDraft: true, draftCards: [draftCard()], draftMedia: { images: ['https://example.org/visible.png', ''], count: 2, isComplete: false } });
  const listed = await f.browser.listDrafts({ accountId: ACCOUNT.id }); const result = await f.browser.readDraft({ accountId: ACCOUNT.id, key: listed.officialDrafts[0].key });
  assert.equal(result.state, 'connected'); assert.equal(result.detail.isComplete, false); assert.equal(result.detail.images.filter(Boolean).length, 1); assert.match(result.detail.message, /未完整确认/);
});

test('official draft entry accepts the counted desktop 草稿箱 label for list and detail without matching other actions', async t => {
  for (const label of ['草稿箱(3)', '草稿箱（3）', '草稿箱 ( 3 )', '我的草稿（3）', '草稿(3)', '草稿箱']) {
    const f = await fixture(t, { savedDraft: true, draftCards: [draftCard()], draftEntryLabel: label });
    const listed = await f.browser.listDrafts({ accountId: ACCOUNT.id }); assert.equal(listed.officialDrafts.length, 1, label);
    const detail = await f.browser.readDraft({ accountId: ACCOUNT.id, key: listed.officialDrafts[0].key }); assert.equal(detail.detail?.isComplete, true, label);
    assert.ok(!f.actions.some(action => ['fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
  }
  for (const label of ['清空草稿箱(3)', '删除草稿', '草稿箱设置']) {
    const f = await fixture(t, { savedDraft: true, draftCards: [draftCard()], draftEntryLabel: label });
    const result = await f.browser.listDrafts({ accountId: ACCOUNT.id }); assert.deepEqual(result.officialDrafts, []); assert.match(result.message, /入口/);
    assert.ok(!f.actions.some(action => action[0] === 'click'));
  }
});

test('official draft drawer explicitly opens image drafts instead of trusting its default empty video tab', async t => {
  const f = await fixture(t, { savedDraft: true, draftEntryLabel: '草稿箱(10)', draftTabLabels: ['视频笔记(0)', '图文笔记(10)', '长文笔记(0)', '播客笔记(0)'], draftCards: ({ selectedImageTab }) => selectedImageTab ? [draftCard()] : [] });
  const result = await f.browser.listDrafts({ accountId: ACCOUNT.id }); assert.equal(result.officialDrafts.length, 1);
  assert.deepEqual(f.actions.filter(action => action[0] === 'click').map(action => action[1]), ['draft-entry', 'draft-tabs']);
  for (const labels of [['视频笔记(0)', '长文笔记(0)'], ['视频笔记(0)', '图文笔记(10)', '图文笔记(10)']]) {
    const invalid = await fixture(t, { savedDraft: true, draftEntryLabel: '草稿箱(10)', draftTabLabels: labels, draftCards: [draftCard()] });
    const blocked = await invalid.browser.listDrafts({ accountId: ACCOUNT.id }); assert.equal(blocked.state, 'needs_attention'); assert.deepEqual(blocked.officialDrafts, []); assert.match(blocked.message, /图文草稿分类/);
    assert.ok(!invalid.actions.some(action => ['fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
  }
});

test('existing draft verification also selects the official image tab before exact-copy readback', async t => {
  const f = await fixture(t, { savedDraft: true, draftEntryLabel: '草稿箱(10)', draftTabLabels: ['视频笔记(0)', '图文笔记(10)'] });
  const result = await f.browser.verifyDraft({ ...f.payload, count: 1 }); assert.equal(result.state, 'verified');
  assert.deepEqual(f.actions.filter(action => action[0] === 'click').map(action => action[1]), ['draft-entry', 'draft-tabs', 'draft-item']);
  assert.ok(!f.actions.some(action => ['fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
});

test('published detail follows the normal cover popup and can find the target after ordinary list scrolling', async t => {
  let second = false;
  const targetRow = { ...POSTED_ROW, id: 'mock-published-123', display_title: 'MOCK 目标全文' };
  const f = await fixture(t, {
    notePopup: true,
    onGoto(target, page) { if (target.endsWith('/new/note-manager')) emitPosted(page, [{ ...POSTED_ROW, id: 'mock-before-target', display_title: 'MOCK 前一页' }], { endpoint: POSTED + '?page=1' }); },
    advanceNotes(page) { second = true; emitPosted(page, [targetRow], { endpoint: POSTED + '?page=2' }); return { attempted: true, kind: 'scroll' }; },
    snapshot(value) { return value.url.endsWith('/new/note-manager') ? { ...value, notes: [{ title: second ? targetRow.display_title : 'MOCK 前一页', publishedAt: POSTED_ROW.time }], hasMore: !second } : value; },
    noteDetail: () => ({ note: { id: 'mock-published-123', authorId: ACCOUNT.id, title, content, images: ['https://example.org/one.png'], isComplete: true } }),
  });
  const result = await f.browser.readNote({ accountId: ACCOUNT.id, noteId: 'mock-published-123' }); assert.equal(result.detail?.isComplete, true); assert.equal(second, true); assert.equal(f.browser.page.url(), HOME);
  assert.ok(f.pages.some(page => page.url().includes('/explore/mock-published-123?') && page.isClosed())); assert.equal(result.detail.url, 'https://www.xiaohongshu.com/explore/mock-published-123'); assert.ok(!JSON.stringify(result).includes('MOCK-do-not-export'));
});

test('official draft blob assets keep mixed image order and reject a refreshed cover whose bytes changed', async t => {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  let reloaded = false;
  const f = await fixture(t, {
    savedDraft: true,
    draftCards: () => [draftCard({ officialDraftId: 'mock-real-id', imageUrl: `blob:${HOME}cover-${reloaded ? 'reopened' : 'first'}`, signature: `MOCK volatile-${reloaded}` })],
    draftMedia: { images: ['https://example.org/remote.png', `blob:${HOME}image-two`, 'data:image/png;base64,' + base64], count: 3, isComplete: true },
    imageAssets: args => ({ isComplete: true, assets: args.images.length === 1 ? [{ index: 0, mime: 'image/png', base64 }] : [{ index: 1, mime: 'image/png', base64 }, { index: 2, mime: 'image/png', base64 }] }),
  });
  const list = await f.browser.listDrafts({ accountId: ACCOUNT.id }); assert.equal(list.officialDrafts[0].coverAsset.base64, base64); reloaded = true;
  const result = await f.browser.readDraft({ accountId: ACCOUNT.id, key: list.officialDrafts[0].key }); assert.equal(result.detail.isComplete, true); assert.deepEqual(result.detail.images, ['https://example.org/remote.png', null, null]); assert.deepEqual(result.detail.imageAssets.map(asset => asset.index), [1, 2]);
  assert.ok(!JSON.stringify(result.detail).includes('blob:'));
  let changed = false;
  const different = await fixture(t, { savedDraft: true, draftCards: [draftCard({ officialDraftId: 'mock-real-id', imageUrl: `blob:${HOME}cover` })], imageAssets: () => ({ isComplete: true, assets: [{ index: 0, mime: 'image/png', base64: changed ? Buffer.from('MOCK different image bytes').toString('base64') : base64 }] }) });
  const before = await different.browser.listDrafts({ accountId: ACCOUNT.id }); changed = true;
  const rejected = await different.browser.readDraft({ accountId: ACCOUNT.id, key: before.officialDrafts[0].key }); assert.equal(rejected.detail, null); assert.match(rejected.message, /发生变化/); assert.ok(!different.actions.some(action => action[0] === 'read-draft-open'));
});

test('existing image asset extraction reads only current creator blobs/data, enforces limits and never fetches remote URLs', async () => {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', bytes = Buffer.from(base64, 'base64');
  const blobUrl = 'blob:https://creator.xiaohongshu.com/mock-local', foreignBlob = 'blob:https://www.xiaohongshu.com/mock-foreign', data = 'data:image/png;base64,' + base64, gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==', requests = [];
  let sources = [blobUrl, foreignBlob, data, gif], blobSize = bytes.length;
  const context = {
    location: { origin: 'https://creator.xiaohongshu.com' }, URL, Blob, Uint8Array, atob, AbortController, setTimeout, clearTimeout,
    document: { querySelectorAll: () => sources.map(source => ({ matches: () => true, currentSrc: source, src: source, hasAttribute: () => true })) },
    getComputedStyle: () => ({ backgroundImage: 'none' }),
    fetch: async source => { requests.push(source); assert.equal(source, blobUrl); const blob = new Blob([bytes], { type: 'image/png' }); return { ok: true, blob: async () => blobSize === bytes.length ? blob : { size: blobSize } }; },
    FileReader: class { readAsDataURL(blob) { blob.arrayBuffer().then(buffer => { this.result = 'data:image/png;base64,' + Buffer.from(buffer).toString('base64'); this.onload(); }, error => this.onerror(error)); } },
  };
  const read = vm.runInNewContext('(' + readExistingXhsImageAssets.toString() + ')', context);
  const good = await read({ images: [blobUrl, 'https://example.org/no-fetch.png', data] }); assert.equal(good.isComplete, true); assert.deepEqual(Array.from(good.assets, asset => asset.index), [0, 2]); assert.equal(good.assets[0].base64, base64); assert.deepEqual(requests, [blobUrl]);
  const forbidden = await read({ images: [foreignBlob, gif, 'data:image/svg+xml;base64,PHN2Zz4='] }); assert.equal(forbidden.isComplete, false); assert.equal(forbidden.assets.length, 0); assert.deepEqual(requests, [blobUrl]);
  const tooMany = await read({ images: Array(19).fill(data) }); assert.equal(tooMany.isComplete, false); assert.equal(tooMany.assets.length, 0);
  blobSize = 15 * 1024 * 1024 + 1; const oversized = await read({ images: [blobUrl] }); assert.equal(oversized.isComplete, false); assert.equal(oversized.assets.length, 0);
  blobSize = bytes.length; const budget = await read({ images: [blobUrl, data], maxTotalBytes: bytes.length }); assert.equal(budget.isComplete, false); assert.equal(budget.assets.length, 1);
  sources = []; const absent = await read({ images: [data] }); assert.equal(absent.isComplete, false); assert.equal(absent.assets.length, 0);
});

test('published detail waits for popup hydration and preserves a popup with manual input', async t => {
  let reads = 0;
  const f = await fixture(t, { notePopup: true, readPopupEditing: true, noteDetail: () => ++reads < 3 ? { pending: true, challenge: false, note: null } : { note: { id: 'mock-published-123', authorId: ACCOUNT.id, title, content, images: ['https://example.org/one.png'], isComplete: true } } });
  const result = await f.browser.readNote({ accountId: ACCOUNT.id, noteId: 'mock-published-123' }); assert.equal(result.detail.isComplete, true); assert.equal(reads, 3);
  assert.ok(f.pages.some(page => page.url().includes('/explore/mock-published-123?') && !page.isClosed())); assert.equal(f.browser.page.url(), HOME);
});

test('official draft handles tolerate a lazy cover becoming available while keeping the real ID and metadata fixed', async t => {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='; let loaded = false;
  const f = await fixture(t, { savedDraft: true, draftCards: () => [draftCard({ officialDraftId: 'mock-real-stable-id', imageUrl: `blob:${HOME}${loaded ? 'loaded' : 'pending'}`, signature: `MOCK volatile ${loaded}` })], imageAssets: args => ({ isComplete: true, assets: loaded && args.images.length === 1 ? [{ index: 0, mime: 'image/png', base64 }] : [] }) });
  const listed = await f.browser.listDrafts({ accountId: ACCOUNT.id }); assert.equal(listed.officialDrafts[0].coverAsset, undefined); loaded = true;
  const detail = await f.browser.readDraft({ accountId: ACCOUNT.id, key: listed.officialDrafts[0].key }); assert.equal(detail.detail?.isComplete, true);
});

test('official draft cover signatures ignore only expiring sign/t authorization while preserving path changes', async t => {
  let query = 'sign=MOCK-first-secret&t=123', changedPath = false;
  const f = await fixture(t, { savedDraft: true, draftCards: () => [draftCard({ officialDraftId: 'mock-real-signed-id', imageUrl: `https://sns-webpic.xhscdn.com/${changedPath ? 'changed' : 'stable'}.png?${query}`, signature: `MOCK runtime ${query}` })] });
  const listed = await f.browser.listDrafts({ accountId: ACCOUNT.id }); assert.equal(listed.officialDrafts[0].imageUrl, 'https://sns-webpic.xhscdn.com/stable.png'); assert.ok(!JSON.stringify(listed).includes('MOCK-first-secret'));
  query = 'sign=MOCK-renewed-secret&t=456';
  const detail = await f.browser.readDraft({ accountId: ACCOUNT.id, key: listed.officialDrafts[0].key }); assert.equal(detail.detail?.isComplete, true);
  const current = await f.browser.listDrafts({ accountId: ACCOUNT.id }); changedPath = true;
  const changed = await f.browser.readDraft({ accountId: ACCOUNT.id, key: current.officialDrafts[0].key }); assert.equal(changed.detail, null); assert.match(changed.message, /发生变化/);
});

test('optional CDN cover extraction fetches only exact current DOM official images without credentials or redirects and stops at limits', async () => {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', bytes = Buffer.from(base64, 'base64');
  const cdn = 'https://sns-webpic.xhscdn.com/visible.png?sign=MOCK-runtime&t=1', absent = 'https://sns-webpic.xhscdn.com/absent.png', arbitrary = 'https://example.org/visible.png', privateApi = 'https://ci.xiaohongshu.com/api/private/image', redirect = 'https://img.xiaohongshu.com/redirect.png', large = 'https://sns-webpic.xhscdn.com/large.png', requests = [];
  const encodedApi = 'https://ci.xiaohongshu.com/%61pi/private/image', sources = [cdn, arbitrary, privateApi, encodedApi, redirect, large]; let streamCancelled = false;
  const context = {
    location: { origin: 'https://creator.xiaohongshu.com' }, URL, Blob, Uint8Array, atob, AbortController, setTimeout, clearTimeout,
    document: { querySelectorAll: () => sources.map(source => ({ matches: () => true, currentSrc: source, src: source, hasAttribute: () => true })) }, getComputedStyle: () => ({ backgroundImage: 'none' }),
    fetch: async (source, options) => {
      requests.push(source); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
      if (source === redirect) throw TypeError('MOCK redirect rejected');
      if (source === large) return { ok: true, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(15 * 1024 * 1024 + 1) }), cancel: async () => { streamCancelled = true; } }) } };
      assert.equal(source, cdn); return { ok: true, blob: async () => new Blob([bytes], { type: 'image/png' }) };
    },
    FileReader: class { readAsDataURL(blob) { blob.arrayBuffer().then(buffer => { this.result = 'data:image/png;base64,' + Buffer.from(buffer).toString('base64'); this.onload(); }, error => this.onerror(error)); } },
  };
  const read = vm.runInNewContext('(' + readExistingXhsImageAssets.toString() + ')', context);
  const disabled = await read({ images: [cdn] }); assert.equal(disabled.assets.length, 0); assert.equal(requests.length, 0);
  const result = await read({ images: [cdn, absent, arbitrary, privateApi, encodedApi, redirect, large], allowOfficialCdn: true });
  assert.equal(result.isComplete, false); assert.equal(result.assets.length, 1); assert.equal(result.assets[0].index, 0); assert.equal(result.assets[0].base64, base64); assert.deepEqual(requests, [cdn, redirect, large]); assert.equal(streamCancelled, true); assert.ok(!JSON.stringify(result).includes('MOCK-runtime'));
});

// Account mode fixtures stay entirely local. Their Chromium implementation
// records profile/mode arguments and never starts a real browser or network.
test('profile identifiers isolate complete storage directories and reject path-like values', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-xhs-profile-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
  assert.equal(new XhsBrowser({ dir }).dir, path.join(dir, 'xhs-browser'));
  assert.equal(new XhsBrowser({ dir, profileId: first, legacy: true }).dir, path.join(dir, 'xhs-browser'));
  assert.equal(new XhsBrowser({ dir, profileId: first }).dir, path.join(dir, 'xhs-profiles', first));
  assert.notEqual(new XhsBrowser({ dir, profileId: first }).dir, new XhsBrowser({ dir, profileId: second }).dir);
  for (const profileId of ['../other', '/tmp/other', '', null, {}, 'account-name', first + '/extra']) assert.throws(() => new XhsBrowser({ dir, profileId }), /会话编号无效/);
  const external = path.join(dir, 'external'); await mkdir(external); await symlink(external, path.join(dir, 'xhs-profiles'));
  await assert.rejects(new XhsBrowser({ dir, profileId: first }).prepareProfile(), /目录不安全/);
});

test('background reads use headless persistent profiles and explicit login switches that same profile to visible mode', async t => {
  const f = await fixture(t, { background: true });
  const first = await f.browser.inspectAccount(); assert.equal(first.state, 'connected'); assert.equal(first.background, true);
  assert.equal(f.launchOptions().headless, true); assert.equal(f.browser.contextMode, 'background'); assert.ok(!f.actions.some(action => action[0] === 'front'));
  const originalProfile = f.launchOptions().profile, sentinel = path.join(originalProfile, 'indexeddb-draft-marker'); await writeFile(sentinel, 'MOCK original complete profile storage');
  await f.browser.openLogin(); assert.equal(f.browser.contextMode, 'visible'); assert.equal(f.launchOptions().headless, false); assert.equal(f.launchOptions().profile, originalProfile); assert.equal(await readFile(sentinel, 'utf8'), 'MOCK original complete profile storage');
  assert.equal(f.actions.filter(action => action[0] === 'front').length, 1);
  const before = f.actions.length; const synced = await f.browser.sync(); assert.equal(synced.state, 'connected'); assert.equal(f.browser.contextMode, 'background'); assert.equal(f.launchOptions().profile, originalProfile);
  assert.deepEqual(f.launchHistory.map(options => options.headless), [true, false, true]);
  assert.ok(!f.actions.slice(before).some(action => ['front', 'fill', 'upload'].includes(action[0])));
});

test('background login or verification states never open a visible window or silently retry authentication', async t => {
  for (const condition of ['login', 'challenge']) {
    const f = await fixture(t, { background: true, snapshot: value => ({ ...value, [condition]: true }) });
    const result = await f.browser.sync(); assert.equal(result.state, condition === 'login' ? 'login_required' : 'needs_attention');
    assert.equal(f.launches(), 1); assert.equal(f.launchOptions().headless, true); assert.equal(result.background, true); assert.match(result.message, /打开登录窗口/);
    assert.deepEqual(result.notes, []); assert.ok(!f.actions.some(action => ['front', 'fill', 'upload'].includes(action[0])));
  }
});

test('background operations preserve all visible manual editors and do not bring their control tab forward', async t => {
  const f = await fixture(t, { background: true }); await f.browser.openLogin();
  await f.page.goto(HOME + 'publish/publish'); f.page.editManually('MOCK 不可关闭的人工草稿');
  const original = f.page.form(), before = f.actions.length; const result = await f.browser.sync();
  assert.equal(result.state, 'connected'); assert.equal(f.browser.contextMode, 'visible'); assert.equal(f.launches(), 1); assert.equal(f.page.isClosed(), false); assert.deepEqual(f.page.form(), original);
  assert.equal(await f.browser.hasPendingEdits(), true);
  assert.notEqual(f.browser.page, f.page); assert.ok(!f.actions.slice(before).some(action => ['close', 'front', 'fill', 'upload'].includes(action[0])));
});

test('foreground draft editing revalidates one observed identity across a headless-to-visible profile transition', async t => {
  const f = await fixture(t, { background: true, savedDraft: true, draftCards: [draftCard({ officialDraftId: 'official-draft-profile-123' })] });
  // The simplified fixture keeps stored draft text in every page. Only the
  // reopened marked editor is considered live, matching the actual drawer.
  f.browser.editorBusy = async page => Boolean(page.__xhsBackgroundReadback);
  const listed = await f.browser.listDrafts({ accountId: ACCOUNT.id }), key = listed.officialDrafts[0].key;
  const cached = await f.browser.readDraft({ accountId: ACCOUNT.id, key }); assert.equal(cached.detail.isComplete, true); assert.equal(f.browser.contextMode, 'background');
  const reopened = f.pages.find(page => page.__xhsBackgroundReadback); assert.ok(reopened); assert.equal(reopened.isClosed(), true); assert.match(cached.detail.message, /后台读取页已关闭/);
  assert.equal(await f.browser.hasPendingEdits(), false, 'An untouched headless readback is not a manual unsaved edit');
  const foreground = await f.browser.readDraft({ accountId: ACCOUNT.id, key, foreground: true });
  assert.equal(foreground.detail.isComplete, true); assert.equal(foreground.detail.id, 'official-draft-profile-123'); assert.equal(f.browser.contextMode, 'visible'); assert.equal(reopened.isClosed(), true);
  assert.deepEqual(f.launchHistory.map(options => options.headless), [true, false]); assert.equal(new Set(f.launchHistory.map(options => options.profile)).size, 1);
  assert.ok(!f.actions.some(action => ['fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
});

test('a changed or unmarked headless editor blocks visibility conversion without losing unsaved content', async t => {
  const f = await fixture(t, { background: true }); await f.browser.ensurePage();
  await f.page.goto(HOME + 'publish/publish'); f.page.editManually('MOCK 不能丢失的后台编辑');
  const before = f.actions.length; const result = await f.browser.openLogin(); assert.equal(result.state, 'needs_attention'); assert.equal(f.browser.contextMode, 'background'); assert.equal(f.launches(), 1); assert.equal(f.page.isClosed(), false);
  assert.equal(f.page.form().content, 'MOCK 不能丢失的后台编辑'); assert.ok(!f.actions.slice(before).some(action => ['close', 'front', 'fill'].includes(action[0])));
  const changed = await fixture(t, { background: true, readbackChanged: true }); await changed.browser.ensurePage(); await changed.page.goto(HOME + 'publish/publish'); changed.page.editManually('MOCK 已改变的只读页'); changed.page.__xhsBackgroundReadback = true;
  assert.equal((await changed.browser.openLogin()).state, 'needs_attention'); assert.equal(changed.launches(), 1); assert.equal(changed.page.isClosed(), false);
});

test('same-profile launch and visibility changes are serialized while distinct profiles can run independently', async t => {
  const f = await fixture(t, { background: true });
  await Promise.all(Array.from({ length: 7 }, () => f.browser.ensureMode('background'))); assert.equal(f.launches(), 1);
  await Promise.all([f.browser.ensureMode('visible'), f.browser.ensureMode('background'), f.browser.ensureMode('visible')]);
  assert.deepEqual(f.launchHistory.map(options => options.headless), [true, false, true, false]);
  const duplicate = new XhsBrowser({ dir: f.browser.root, background: true, chromiumImpl: { launchPersistentContext() { assert.fail('A duplicate profile must not launch another Chrome'); } } }); t.after(() => duplicate.close());
  const blocked = await duplicate.inspectAccount(); assert.equal(blocked.state, 'browser_unavailable'); assert.match(blocked.message, /另一个进程/);
  await f.browser.close();
  let launched = 0; const first = '33333333-3333-4333-8333-333333333333', second = '44444444-4444-4444-8444-444444444444';
  const implementation = { async launchPersistentContext() { launched++; return { pages: () => [], on() {}, async close() {} }; } };
  const a = new XhsBrowser({ dir: f.browser.root, profileId: first, background: true, chromiumImpl: implementation }), b = new XhsBrowser({ dir: f.browser.root, profileId: second, background: true, chromiumImpl: implementation }); t.after(() => Promise.all([a.close(), b.close()]));
  await Promise.all([a.ensureMode('background'), b.ensureMode('background')]); assert.equal(launched, 2); assert.notEqual(a.profilePath, b.profilePath);
});

function backgroundGuardFixture() {
  const title = { value: 'MOCK 原标题' }, editor = { innerHTML: '<p>MOCK 原正文</p>' }, images = [{ currentSrc: 'blob:mock-original-1', src: 'blob:mock-original-1' }, { currentSrc: 'https://sns-creator-preview.xhscdn.com/2.png?sign=first&t=1', src: 'https://sns-creator-preview.xhscdn.com/2.png?sign=first&t=1' }], handlers = new Map();
  const context = vm.createContext({ window: {}, document: { querySelector(selector) { return selector.startsWith('input') ? title : editor; }, querySelectorAll() { return images; }, addEventListener(name, fn) { handlers.set(name, fn); } } });
  const run = fn => vm.runInContext('(' + fn.toString() + ')()', context); return { title, editor, images, handlers, context, run };
}

test('background readback marker rejects changed text, image slots, their order, or input events', () => {
  for (const mutate of [f => { f.title.value += '改'; }, f => { f.editor.innerHTML += '<p>新增</p>'; }, f => { f.images[0] = { ...f.images[0] }; }, f => { f.images.reverse(); }, f => { f.images.pop(); }, f => { f.images.push({ src: 'blob:new', currentSrc: 'blob:new' }); }, f => f.handlers.get('input')(), f => f.handlers.get('drop')()]) {
    const f = backgroundGuardFixture(); assert.equal(f.run(markXhsBackgroundReadback), true); assert.equal(f.run(canReleaseXhsBackgroundReadback), true); mutate(f); assert.equal(f.run(canReleaseXhsBackgroundReadback), false);
  }
});

test('an unchanged headless readback tolerates automatic blob-to-preview and signed URL refresh on the same image nodes', () => {
  const f = backgroundGuardFixture(); assert.equal(f.run(markXhsBackgroundReadback), true);
  f.images[0].currentSrc = f.images[0].src = 'https://sns-creator-preview.xhscdn.com/1.png?sign=uploaded&t=2';
  f.images[1].currentSrc = f.images[1].src = 'https://sns-creator-preview.xhscdn.com/2.png?sign=renewed&t=2';
  assert.equal(f.run(canReleaseXhsBackgroundReadback), true, 'Same node slots and no input must not keep an auto-saving editor alive just because its temporary URL changed');
  f.handlers.get('input')(); assert.equal(f.run(canReleaseXhsBackgroundReadback), false, 'A real input remains protected even when all nodes still match');
});

test('legacy invisible readback markers allow URL refresh only while text, input guard, and slot count remain unchanged', () => {
  for (const mutate of [null, f => { f.title.value += '改'; }, f => { f.editor.innerHTML += '<p>新增</p>'; }, f => f.handlers.get('input')(), f => { f.images.pop(); }]) {
    const f = backgroundGuardFixture(); f.run(markXhsBackgroundReadback); delete f.context.window.__contentStudioReadback.imageNodes;
    f.images[0].currentSrc = f.images[0].src = 'https://sns-creator-preview.xhscdn.com/1.png?sign=uploaded&t=2';
    f.images[1].currentSrc = f.images[1].src = 'https://sns-creator-preview.xhscdn.com/2.png?sign=renewed&t=2';
    if (mutate) mutate(f); assert.equal(f.run(canReleaseXhsBackgroundReadback), mutate === null);
  }
});

test('draft detail caches every blob and signed creator CDN slot even before lazy images naturally load', async t => {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const sources = [`blob:${HOME}draft-image-0`, ...Array.from({ length: 5 }, (_, index) => `https://sns-creator-preview.xhscdn.com/mock-image-${index + 1}.png?sign=MOCK_PRIVATE_SIGN_${index}&t=123456`)];
  let sawAllSources = false;
  const f = await fixture(t, {
    savedDraft: true, draftCards: [draftCard({ officialDraftId: 'mock-real-six-image-draft' })],
    draftMedia: { images: sources, count: 6, isComplete: false },
    imageAssets(args) {
      if (args.images.length !== 6) return { assets: [], isComplete: true };
      assert.equal(args.allowOfficialCdn, true); assert.deepEqual(args.images, sources); sawAllSources = true;
      return { assets: sources.map((_, index) => ({ index, mime: 'image/png', base64 })), isComplete: true };
    },
  });
  const list = await f.browser.listDrafts({ accountId: ACCOUNT.id }), result = await f.browser.readDraft({ accountId: ACCOUNT.id, key: list.officialDrafts[0].key });
  assert.equal(sawAllSources, true); assert.equal(result.state, 'connected'); assert.equal(result.detail.isComplete, true);
  assert.deepEqual(result.detail.imageAssets.map(asset => asset.index), [0, 1, 2, 3, 4, 5]); assert.deepEqual(result.detail.images, Array(6).fill(null));
  assert.doesNotMatch(JSON.stringify(result.detail), /MOCK_PRIVATE_SIGN|sign=|blob:/);
  assert.ok(!f.actions.some(action => ['fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
});

test('draft image byte retrieval failures and incomplete slot counts stay partial', async t => {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const sources = [`blob:${HOME}draft-image-0`, ...Array.from({ length: 5 }, (_, index) => `https://sns-creator-preview.xhscdn.com/mock-failed-${index + 1}.png?sign=MOCK_PRIVATE_SIGN&t=123456`)];
  for (const scenario of [
    { slots: sources, count: 6, assetCount: 5, isComplete: false },
    { slots: sources, count: 6, assetCount: 1, isComplete: true },
    { slots: sources, count: 7, assetCount: 6, isComplete: true },
    { slots: sources.slice(0, 1), count: 6, assetCount: 1, isComplete: true },
  ]) {
    const f = await fixture(t, {
      savedDraft: true, draftCards: [draftCard({ officialDraftId: 'mock-real-incomplete-draft' })],
      draftMedia: { images: scenario.slots, count: scenario.count, isComplete: false },
      imageAssets(args) {
        if (args.images[0] !== sources[0]) return { assets: [], isComplete: true };
        assert.equal(args.allowOfficialCdn, true);
        return { assets: Array.from({ length: scenario.assetCount }, (_, index) => ({ index, mime: 'image/png', base64 })), isComplete: scenario.isComplete };
      },
    });
    const list = await f.browser.listDrafts({ accountId: ACCOUNT.id }), result = await f.browser.readDraft({ accountId: ACCOUNT.id, key: list.officialDrafts[0].key });
    assert.equal(result.state, 'connected'); assert.equal(result.detail.isComplete, false); assert.equal(result.detail.imageAssets.length, scenario.assetCount);
    assert.doesNotMatch(JSON.stringify(result.detail), /MOCK_PRIVATE_SIGN|sign=|blob:/); assert.match(result.detail.message, /未完整确认/);
    assert.ok(!f.actions.some(action => ['fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
  }
});

test('background draft reads close only their unchanged readback editor and clear old readbacks before another list', async t => {
  const f = await fixture(t, { background: true, savedDraft: true, draftCards: [draftCard({ officialDraftId: 'mock-cleaned-readback' })] });
  f.browser.editorBusy = async page => Boolean(page.__xhsBackgroundReadback);
  const first = await f.browser.listDrafts({ accountId: ACCOUNT.id }), result = await f.browser.readDraft({ accountId: ACCOUNT.id, key: first.officialDrafts[0].key });
  const editor = f.pages.find(page => page.__xhsBackgroundReadback); assert.ok(editor); assert.equal(editor.isClosed(), true);
  assert.equal(f.browser.page.isClosed(), false); assert.equal(f.browser.page.url(), HOME); assert.match(result.message, /后台读取/); assert.match(result.detail.message, /后台读取页已关闭/); assert.doesNotMatch(result.detail.message, /编辑页已保留/);
  const stale = await f.browser.context.newPage(); await stale.goto(HOME + 'publish/publish'); stale.__xhsBackgroundReadback = true;
  const manual = await f.browser.context.newPage(); await manual.goto(HOME + 'publish/publish'); manual.editManually('MOCK 未被本系统标记的后台内容');
  const second = await f.browser.listDrafts({ accountId: ACCOUNT.id }); assert.equal(second.officialDrafts.length, 1); assert.equal(stale.isClosed(), true); assert.equal(manual.isClosed(), false); assert.equal(manual.form().content, 'MOCK 未被本系统标记的后台内容');
  assert.ok(!f.actions.some(action => ['fill', 'upload'].includes(action[0]) || action[0] === 'click' && action[1] === 'save'));
});

test('background readback cleanup preserves dirty guarded pages and every visible editor', async t => {
  const dirty = await fixture(t, { background: true, savedDraft: true, readbackChanged: true, draftCards: [draftCard({ officialDraftId: 'mock-dirty-readback' })] });
  dirty.browser.editorBusy = async page => Boolean(page.__xhsBackgroundReadback);
  const listed = await dirty.browser.listDrafts({ accountId: ACCOUNT.id }), read = await dirty.browser.readDraft({ accountId: ACCOUNT.id, key: listed.officialDrafts[0].key });
  const protectedPage = dirty.pages.find(page => page.__xhsBackgroundReadback); assert.ok(protectedPage); assert.equal(protectedPage.isClosed(), false); assert.match(read.detail.message, /编辑页已保留/);
  assert.equal(await dirty.browser.cleanupBackgroundReadbacks(), 0); assert.equal(protectedPage.isClosed(), false);
  await dirty.browser.listDrafts({ accountId: ACCOUNT.id }); assert.equal(protectedPage.isClosed(), false, 'Reading another list must not discard a changed page');
  const visible = await fixture(t, { background: true }); await visible.browser.openLogin(); await visible.page.goto(HOME + 'publish/publish'); visible.page.editManually('MOCK 可见人工编辑'); visible.page.__xhsBackgroundReadback = true;
  assert.equal(await visible.browser.cleanupBackgroundReadbacks(), 0); assert.equal(visible.page.isClosed(), false); assert.equal(visible.page.form().content, 'MOCK 可见人工编辑');
  assert.ok(!visible.actions.some(action => action[0] === 'close'));
});

test('background readback cleanup does not relax a genuine official draft save-time change', async t => {
  let changed = false;
  const f = await fixture(t, { background: true, savedDraft: true, draftCards: () => [draftCard({ officialDraftId: 'mock-real-saved-at', updatedAt: changed ? '保存于2026-11-11 11:05:00' : '保存于2026-11-11 11:04:50' })] });
  const listed = await f.browser.listDrafts({ accountId: ACCOUNT.id }); changed = true;
  const result = await f.browser.readDraft({ accountId: ACCOUNT.id, key: listed.officialDrafts[0].key });
  assert.equal(result.detail, null); assert.match(result.message, /列表发生变化/); assert.ok(!f.actions.some(action => ['read-draft-open', 'fill', 'upload'].includes(action[0])));
});

test('official draft entry waits for bounded SPA loading without repeating navigation', async t => {
  const f = await fixture(t, { savedDraft: true, draftCards: [draftCard()], draftEntryCounts: [0, 0, 1] });
  await f.browser.inspectAccount(); const before = f.actions.length;
  const opened = await f.browser.openReadOnlyDraftList(ACCOUNT.id); assert.ok(opened.snapshot); assert.equal(opened.snapshot.cards.length, 1);
  assert.deepEqual(f.actions.slice(before).filter(action => action[0] === 'draft-entry-count').map(action => action[1]), [0, 0, 1]);
  assert.deepEqual(f.actions.slice(before).filter(action => action[0] === 'navigate').map(action => action[1]), [HOME + 'publish/publish?from=menu&target=image']);
  assert.equal(f.actions.slice(before).filter(action => action[0] === 'click' && action[1] === 'draft-entry').length, 1);
});

test('duplicate official draft entries are rejected immediately, including after a delayed zero', async t => {
  for (const counts of [[2, 1], [0, 2, 1]]) {
    const f = await fixture(t, { savedDraft: true, draftCards: [draftCard()], draftEntryCounts: counts }); await f.browser.inspectAccount();
    const opened = await f.browser.openReadOnlyDraftList(ACCOUNT.id); assert.equal(opened.blocked.state, 'needs_attention'); assert.match(opened.blocked.message, /唯一.*草稿入口/);
    assert.deepEqual(f.actions.filter(action => action[0] === 'draft-entry-count').map(action => action[1]), counts.slice(0, -1));
    assert.ok(!f.actions.some(action => action[0] === 'click' && action[1] === 'draft-entry'));
  }
});

test('missing draft entry stops after twenty waits and rechecks actual login or challenge state', async t => {
  for (const condition of ['login', 'challenge', 'missing']) {
    let expired = false;
    const f = await fixture(t, {
      savedDraft: true, draftCards: [draftCard()],
      draftEntryCounts(attempt) { if (attempt === 20) expired = true; return 0; },
      snapshot(value) { return expired && condition !== 'missing' ? { ...value, [condition]: true, account: null } : value; },
    });
    await f.browser.inspectAccount(); const before = f.actions.length;
    const opened = await f.browser.openReadOnlyDraftList(ACCOUNT.id);
    assert.equal(opened.blocked.state, condition === 'login' ? 'login_required' : 'needs_attention');
    if (condition === 'missing') assert.match(opened.blocked.message, /唯一.*草稿入口/); else assert.doesNotMatch(opened.blocked.message, /唯一.*草稿入口/);
    assert.equal(f.actions.filter(action => action[0] === 'draft-entry-count').length, 21, 'One initial count plus at most twenty polls');
    assert.deepEqual(f.actions.slice(before).filter(action => action[0] === 'navigate').map(action => action[1]), [HOME + 'publish/publish?from=menu&target=image']);
    assert.ok(!f.actions.slice(before).some(action => ['fill', 'upload', 'front'].includes(action[0]) || action[0] === 'click'));
  }
});
