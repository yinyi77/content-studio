import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { XhsBrowser, parseVisibleNumber, metricsFromVisibleText, normalizeXhsAccount, readVisibleXhsPage, readXhsEditorCopy, compareXhsCopy } from '../lib/xhs-browser.mjs';

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
});

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-xhs-browser-'));
  const image = path.join(dir, 'example.png'); await writeFile(image, 'MOCK local image bytes');
  const actions = [], pages = [];
  function makePage() {
    let currentUrl = 'about:blank', formTitle = options.savedDraft ? title : '', formContent = options.savedDraft ? content : '', imageCount = options.savedDraft ? 1 : 0, saved = Boolean(options.savedDraft), stage = 'initial', closed = false;
    const page = {
      isClosed: () => closed, url: () => currentUrl, setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, handlers: {}, on(event, handler) { this.handlers[event] = handler; },
      async goto(target) { currentUrl = target; stage = 'page'; actions.push(['navigate', target]); }, async waitForTimeout() {}, async bringToFront() { actions.push(['front', pages.indexOf(page)]); },
      async evaluate(fn) {
        assert.equal(fn, readVisibleXhsPage);
        const snapshot = { url: currentUrl, text: 'MOCK 笔记管理', metrics: [{label:'曝光量',value:'500'},{label:'观看量',value:'200'}], account: ACCOUNT, challenge: false, login: false, period: '近7天', notes: [], hasMore: false };
        if (currentUrl.includes('/manage/notes')) snapshot.notes = [{ id: 'mock-note-123', title: 'MOCK 笔记', url: 'https://www.xiaohongshu.com/explore/mock-note-123', text: '点赞：0\n评论：3\n收藏：--\n观看量：22', publishedAt: '2026-11-09', imageUrl: '' }];
        return options.snapshot ? options.snapshot(snapshot, { saved, stage }) : snapshot;
      },
      async waitForFunction(_fn, args) { actions.push(['upload-check', args]); if (options.uploadIncomplete) throw Error('MOCK upload incomplete'); },
      locator(selector) { const kind = selector.includes('placeholder') ? 'title' : selector.includes('contenteditable') ? 'editor' : selector === 'input[type="file"]' ? 'file' : 'images'; return locator(kind); },
      getByRole(role, opts) { actions.push(['selector-role', role, opts.name]); return locator('save'); },
      getByText(value) { return locator(value instanceof RegExp ? 'draft-entry' : value === '上传图文' ? 'image-tab' : 'draft-item'); },
      editManually(value) { formContent = value; }, form() { return { title: formTitle, content: formContent }; }, close() { closed = true; },
    };
    function locator(kind, index = 0) {
      return {
        first() { return locator(kind); }, nth(next) { return locator(kind, next); }, filter() { return this; }, async waitFor() {},
        async count() {
          if (kind === 'draft-entry') return saved && !options.noDraftEntry ? 1 : 0;
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
          if (kind === 'save') { if (options.saveThrows) throw Error('MOCK ambiguous click result'); saved = true; currentUrl = HOME; stage = 'saved'; }
          if (kind === 'draft-entry') stage = 'draft-list';
          if (kind === 'draft-item') { stage = 'reopened'; currentUrl = HOME + 'publish/publish'; if (index && options.otherDraftContent !== undefined) formContent = options.otherDraftContent; }
        },
      };
    }
    pages.push(page); return page;
  }
  const page = makePage(); let launches = 0, launchOptions;
  const context = { pages: () => pages, async newPage() { return makePage(); }, on() {}, async close() { pages.forEach(item => item.close()); actions.push(['close']); } };
  const browser = new XhsBrowser({ dir, chromiumImpl: { async launchPersistentContext(profile, opts) { launches++; launchOptions = { profile, ...opts }; if (options.launchThrows) throw Error('MOCK private browser secret'); return context; } } });
  t.after(async () => { await browser.close(); await rm(dir, { recursive: true, force: true }); });
  return { browser, page, pages, actions, image, launchOptions: () => launchOptions, launches: () => launches, payload: { accountId: ACCOUNT.id, title, content, images: [image], fingerprint: 'MOCK-fingerprint' } };
}

test('construction is passive; explicit login uses one isolated headed persistent browser without exporting cookies', async t => {
  const f = await fixture(t); assert.equal(f.launches(), 0);
  const state = await f.browser.openLogin(); assert.equal(state.state, 'connected');
  assert.equal(state.account.id, ACCOUNT.id); assert.equal(f.launches(), 1);
  assert.equal(f.launchOptions().headless, false); assert.equal(path.basename(f.launchOptions().profile), 'xhs-browser');
  assert.ok(!JSON.stringify(state).includes('cookie'));
  await f.browser.inspectAccount(); assert.equal(f.launches(), 1);
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
  assert.equal(f.actions.filter(action => action[0] === 'navigate').length, 3);
  const changed = await fixture(t, { snapshot: value => value.url.includes('/manage/') ? { ...value, account: { id: 'different-account', nickname: 'MOCK B' } } : value });
  const inconsistent = await changed.browser.sync(); assert.equal(inconsistent.state, 'needs_attention'); assert.deepEqual(inconsistent.notes, []); assert.deepEqual(inconsistent.metrics, []);
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
  await page.setContent('<div contenteditable="true" class="ql-editor"><p>第一段</p><p><br></p><p>第二段<span>#工具</span> 🧑‍💻</p></div>');
  let editor = page.locator('.ql-editor');
  assert.equal(await editor.evaluate(readXhsEditorCopy), '第一段\n\n第二段#工具 🧑‍💻');
  await page.setContent('<div contenteditable="true" class="tiptap"><p style="margin:1em">第一行</p><p style="margin:1em">第二行<br>第三行 <span data-type="topic">#工具</span>🚀</p></div>');
  editor = page.locator('.tiptap');
  assert.equal(await editor.evaluate(readXhsEditorCopy), '第一行\n第二行\n第三行 #工具🚀');
});
