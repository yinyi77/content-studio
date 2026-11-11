import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { XhsMediaCache } from '../lib/xhs-media.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const base = 'http://127.0.0.1:19516';
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const key = '99999999-9999-4999-8999-999999999999';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function mediaPng(red, green, blue) {
  const chunk = (type, data) => {
    const tag = Buffer.from(type), bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); tag.copy(bytes, 4); data.copy(bytes, 8);
    let crc = 0xffffffff; for (const byte of Buffer.concat([tag, data])) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue]))), chunk('IEND', Buffer.alloc(0))]);
}
const draftPng = mediaPng(35, 70, 120), coverPng = mediaPng(65, 130, 91), unusedPng = mediaPng(160, 120, 35);


test('XHS workspace routes expose scoped cached content and queue only explicit read operations', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-studio-xhs-workspace-http-'));
  const controls = path.join(dir, 'controls.json'), callsFile = path.join(dir, 'calls.json');
  await writeFile(controls, JSON.stringify({ accountId: A })); await writeFile(callsFile, '[]');
  const preload = `
    import {readFile,writeFile} from 'node:fs/promises';
    import {XhsBrowser} from './lib/xhs-browser.mjs';
    const controls=${JSON.stringify(controls)},callsFile=${JSON.stringify(callsFile)};
    const draftAsset={index:0,mime:'image/png',base64:${JSON.stringify(draftPng.toString('base64'))}},coverAsset={mime:'image/png',base64:${JSON.stringify(coverPng.toString('base64'))}};
    const current=async()=>JSON.parse(await readFile(controls,'utf8'));
    const record=async action=>{const calls=JSON.parse(await readFile(callsFile,'utf8'));calls.push(action);await writeFile(callsFile,JSON.stringify(calls));};
    const identity=async()=>({state:'connected',browserOpen:true,account:{id:(await current()).accountId,nickname:'MOCK 账号',followers:0,following:3,likes:null,notesCount:2}});
    XhsBrowser.prototype.openLogin=async function(){await record('login');return identity();};
    XhsBrowser.prototype.inspectAccount=async function(){await record('check');return identity();};
    XhsBrowser.prototype.sync=async function(options){await record('sync:'+options.noteLimit);return{...await identity(),notes:[{id:'mock-note',title:'MOCK 已发布',views:0,likes:5}],metrics:[{id:'views',label:'观看',value:0,period:'近7天',source:'MOCK 官网'}],coverage:{limit:options.noteLimit,hasMore:false,message:'MOCK 已加载'}};};
    XhsBrowser.prototype.readNote=async function({accountId,noteId}){await record('note:'+accountId+':'+noteId);return{...await identity(),detail:{id:noteId,title:'MOCK 正文',content:'PRIVATE_OFFICIAL_NOTE_BODY',images:['https://sns-webpic-qc.xhscdn.com/mock.jpg','javascript:alert(1)'],tags:['MOCK'],source:'official',isComplete:true,rawCookie:'SECRET_BROWSER_COOKIE'},rawHtml:'PRIVATE_HTML'};};
    XhsBrowser.prototype.listDrafts=async function(){await record('official-list');return{...await identity(),officialDrafts:[{key:${JSON.stringify(key)},officialDraftId:null,title:'MOCK 官方草稿',imageUrl:'blob:https://creator.xiaohongshu.com/cover',coverAsset,canRead:true}],coverage:{limit:200,hasMore:false,message:'MOCK 当前电脑草稿'}};};
    XhsBrowser.prototype.readDraft=async function({key,foreground}){await record('official-detail:'+Boolean(foreground));return{...await identity(),detail:{id:null,title:'MOCK 官方草稿',content:'PRIVATE_OFFICIAL_DRAFT_BODY',images:['blob:https://creator.xiaohongshu.com/draft-image'],imageAssets:[draftAsset],source:'official',isComplete:true}};};
    XhsBrowser.prototype.close=async function(){};
    globalThis.fetch=async()=>{throw Error('External network disabled in fixture');};
    await import('./server.mjs');
  `;
  let log = '';
  const child = spawn(process.execPath, ['--input-type=module', '-e', preload], { cwd: root, env: { ...process.env, PORT: '19516', DATA_DIR: dir, TRENDS_AUTO_REFRESH: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
  t.after(async () => { if (child.exitCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended; } await rm(dir, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', body, origin = base } = {}) {
    const response = await fetch(base + route, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); return { status: response.status, value };
  }
  for (let i = 0; i < 120; i++) { try { if ((await request('/api/xhs')).status === 200) break; } catch {} if (child.exitCode !== null) assert.fail(log); await sleep(30); }
  async function mediaRequest(route, method = 'GET') {
    const response = await fetch(base + route, { method, headers: { Origin: base } });
    return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
  }
  async function assertPng(route, expected) {
    const get = await mediaRequest(route); assert.equal(get.status, 200); assert.equal(get.headers.get('content-type'), 'image/png'); assert.equal(get.headers.get('content-length'), String(expected.length)); assert.equal(get.headers.get('cache-control'), 'private, no-store'); assert.deepEqual(get.bytes, expected);
    const head = await mediaRequest(route, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'image/png'); assert.equal(head.headers.get('content-length'), String(expected.length)); assert.equal(head.headers.get('cache-control'), 'private, no-store'); assert.equal(head.bytes.length, 0, 'HEAD returns metadata without an image body');
  }
  async function settle() { for (let i = 0; i < 160; i++) { const { value } = await request('/api/xhs'); if (!value.status.busy) return value; await sleep(15); } assert.fail('Workspace read did not settle'); }
  const calls = async () => JSON.parse(await readFile(callsFile, 'utf8'));
  assert.deepEqual(await calls(), []);
  assert.equal((await request('/api/xhs/login', { method: 'POST', body: {} })).status, 202); await settle();
  assert.equal((await request('/api/xhs/sync', { method: 'POST', body: { noteLimit: 201 } })).status, 400);
  assert.equal((await request('/api/xhs/sync', { method: 'POST', body: { noteLimit: 150 } })).status, 202); let snapshot = await settle();
  assert.ok((await calls()).includes('sync:150')); assert.equal(snapshot.analyticsHistory.length, 1);

  const notePath = '/api/xhs/notes/mock-note';
  const beforeRead = await calls();
  assert.equal((await request(notePath)).status, 400);
  assert.equal((await request(notePath + '?accountId=' + B)).status, 409);
  assert.equal((await request(notePath + '?accountId=' + A)).value.detail, null);
  assert.deepEqual(await calls(), beforeRead, 'Cache reads cannot open the browser');
  assert.equal((await request(notePath, { method: 'POST', body: { accountId: B } })).status, 409);
  assert.equal((await request('/api/xhs/notes/not-synced', { method: 'POST', body: { accountId: A } })).status, 404);
  assert.equal((await request(notePath, { method: 'POST', body: { accountId: A }, origin: 'https://example.org' })).status, 403);
  assert.equal((await request(notePath, { method: 'POST', body: { accountId: A } })).status, 202); snapshot = await settle();
  const note = await request(notePath + '?accountId=' + A);
  assert.equal(note.value.detail.content, 'PRIVATE_OFFICIAL_NOTE_BODY'); assert.equal(note.value.contentStatus.state, 'partial', 'a rejected image must not be reported as a complete image set');
  assert.equal(note.value.detail.images.length, 1);
  assert.doesNotMatch(JSON.stringify(note.value), /SECRET_BROWSER_COOKIE|PRIVATE_HTML|javascript:/);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_OFFICIAL_NOTE_BODY|SECRET_BROWSER_COOKIE|PRIVATE_HTML/);

  assert.equal((await request('/api/xhs/official-drafts/sync', { method: 'POST', body: { accountId: A } })).status, 202); snapshot = await settle();
  assert.equal(snapshot.officialDrafts.length, 1); assert.equal(snapshot.officialDrafts[0].officialDraftId, null);
  const officialCoverUrl = snapshot.officialDrafts[0].imageUrl;
  assert.match(officialCoverUrl, new RegExp(`^/media/xhs/${A}/[a-f0-9]{64}\\.png$`));
  assert.doesNotMatch(JSON.stringify(snapshot), /base64|imageAssets|coverAsset|blob:|PRIVATE_OFFICIAL_DRAFT_BODY/);
  await assertPng(officialCoverUrl, coverPng);

  const draftPath = '/api/xhs/official-drafts/' + key;
  assert.equal((await request(draftPath + '?accountId=' + A)).value.detail, null);
  assert.equal((await request(draftPath, { method: 'POST', body: { accountId: A } })).status, 202); await settle();
  assert.equal((await request(draftPath + '?accountId=' + A)).value.detail.content, 'PRIVATE_OFFICIAL_DRAFT_BODY');
  const cachedDraft = (await request(draftPath + '?accountId=' + A)).value.detail, draftImageUrl = cachedDraft.images[0], draftImageName = draftImageUrl.split('/').at(-1);
  assert.equal(cachedDraft.isComplete, true); assert.match(draftImageUrl, new RegExp(`^/media/xhs/${A}/[a-f0-9]{64}\\.png$`));
  assert.doesNotMatch(JSON.stringify(cachedDraft), /base64|imageAssets|blob:/); await assertPng(draftImageUrl, draftPng);
  assert.equal((await mediaRequest(`/media/xhs/${B}/${draftImageName}`)).status, 409, 'an image path for a different account cannot read the active account cache');
  const wrongAccountHead = await mediaRequest(`/media/xhs/${B}/${draftImageName}`, 'HEAD'); assert.equal(wrongAccountHead.status, 409); assert.equal(wrongAccountHead.bytes.length, 0);
  const unused = await new XhsMediaCache({ dir }).materialize({ images: [null], imageAssets: [{ index: 0, mime: 'image/png', base64: unusedPng.toString('base64') }], isComplete: true }, { accountId: A });
  assert.deepEqual((await new XhsMediaCache({ dir }).read(A, unused.images[0].split('/').at(-1))).bytes, unusedPng);
  assert.equal((await mediaRequest(unused.images[0])).status, 404, 'a valid file on disk is hidden unless a current detail or cover references it');
  assert.equal((await mediaRequest(officialCoverUrl)).status, 404, 'replaced list covers are no longer an authorized reference');

  assert.equal((await request(draftPath + '/open', { method: 'GET' })).status, 405);
  assert.equal((await request(draftPath + '/open', { method: 'POST', body: { accountId: A } })).status, 202); snapshot = await settle();
  assert.ok((await calls()).includes('official-detail:true'));
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_OFFICIAL_DRAFT_BODY/);
  assert.equal((await request('/api/xhs/submissions/' + key + '?accountId=' + A)).status, 404);
  assert.equal((await request('/api/xhs/submissions/' + key + '?accountId=' + A, { method: 'POST', body: {} })).status, 405);
  assert.equal((await request('/api/xhs/official-drafts/' + key + '/delete', { method: 'POST', body: { accountId: A } })).status, 404);

  await request('/api/xhs/disconnect', { method: 'POST', body: {} }); await settle();
  const legacyProfile = (await request('/api/xhs')).value.selectedProfileId;
  const beforeAdd = await calls();
  const added = await request('/api/xhs/accounts', { method: 'POST', body: { accountName: 'MOCK 账号B', group: '产品案例' } });
  assert.equal(added.status, 201); assert.equal(added.value.accounts.length, 2); assert.equal(added.value.account, null);
  assert.deepEqual(await calls(), beforeAdd, 'adding an independent account cannot silently open a login window');
  const profileB = added.value.selectedProfileId;
  const edited = await request('/api/xhs/accounts/' + profileB, { method: 'PATCH', body: { accountName: 'MOCK 账号B-改名', group: '工具推广' } });
  assert.equal(edited.status, 200); assert.equal(edited.value.selectedProfileId, profileB); assert.equal(edited.value.accounts.find(item => item.profileId === profileB).group, '工具推广');
  await writeFile(controls, JSON.stringify({ accountId: B }));
  await request('/api/xhs/login', { method: 'POST', body: {} }); snapshot = await settle();
  assert.equal(snapshot.account.id, B); assert.deepEqual(snapshot.officialDrafts, []); assert.deepEqual(snapshot.analyticsHistory, []);
  assert.equal((await mediaRequest(draftImageUrl)).status, 200, 'an explicitly named registered account can read its own cache independently of selection');
  assert.equal((await mediaRequest(`/media/xhs/${B}/${draftImageName}`)).status, 404);

  assert.equal((await request(notePath + '?accountId=' + B)).value.detail, null);
  assert.equal((await request(notePath + '?accountId=' + A)).value.detail.content, 'PRIVATE_OFFICIAL_NOTE_BODY');
  assert.equal((await request(draftPath + '?accountId=' + B)).status, 404);
  assert.equal((await request(notePath, { method: 'POST', body: { accountId: B } })).status, 404);
  const beforeSwitch = await calls();
  assert.equal((await request('/api/xhs/accounts/' + legacyProfile + '/select', { method: 'POST', body: {} })).value.account.id, A);
  assert.deepEqual(await calls(), beforeSwitch, 'switching workspace accounts reads cache only');
  assert.equal((await request('/api/xhs/accounts/' + profileB + '/select', { method: 'POST', body: {} })).value.account.id, B);
  assert.equal((await request('/api/xhs?accountId=' + A)).value.account.id, A);
  assert.equal((await request('/api/xhs')).value.account.id, B, 'targeted reads cannot change workspace selection');
  assert.equal((await request('/api/xhs/accounts/' + legacyProfile, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await mediaRequest(draftImageUrl)).status, 409, 'removing the bound profile revokes its cached image route');
  assert.equal((await request(notePath + '?accountId=' + A)).status, 409);
  assert.ok(!(await calls()).some(action => /publish|save|delete/i.test(action)), 'Workspace reads do not invoke writing methods');
});
