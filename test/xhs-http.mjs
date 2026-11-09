import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No browser or real social/model service is contacted. Browser actions are
// injected before server import; project files and every session use temp data.
const root = fileURLToPath(new URL('..', import.meta.url));
const base = 'http://127.0.0.1:19512';
const accountA = 'aaaaaaaaaaaaaaaaaaaaaaaa', accountB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=', 'base64');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('XHS HTTP freezes local work, scopes one account, never publishes and handles draft uncertainty without replay', { timeout: 35000 }, async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'content-studio-xhs-http-')));
  let child, log = '';
  const controls = path.join(dir, 'driver-controls.json'), callsFile = path.join(dir, 'driver-calls.json');
  await writeFile(controls, JSON.stringify({ accountId: accountA }));
  await writeFile(callsFile, '[]');
  async function fixtureProject(extra = {}) {
    const id = randomUUID(), projectDir = path.join(dir, 'projects', id), now = new Date().toISOString();
    await mkdir(path.join(projectDir, 'images'), { recursive: true });
    const pages = [];
    for (let index = 0; index < 2; index++) {
      const pageId = randomUUID(), filename = `${pageId}-${randomUUID()}.png`;
      await writeFile(path.join(projectDir, 'images', filename), png);
      pages.push({ id: pageId, title: `MOCK 图片 ${index + 1}`, content: 'MOCK 图中文字', prompt: 'MOCK 画面', status: 'done', imageUrl: `/media/${id}/${filename}`, error: null });
    }
    const project = { id, title: 'MOCK 工具案例', caption: 'PRIVATE_DRAFT_BODY_MARKER', source: 'MOCK 已确认工具资料', status: 'completed', chatStatus: 'idle', createdAt: now, updatedAt: now, pages, count: 2, style: 'notion', mode: 'cards', aspect: '3:4', logs: [], ...extra };
    await writeFile(path.join(projectDir, 'project.json'), JSON.stringify(project));
    return project;
  }
  const project = await fixtureProject();
  const partial = await fixtureProject({ status: 'partial' });
  partial.pages[0].status = 'error';
  await writeFile(path.join(dir, 'projects', partial.id, 'project.json'), JSON.stringify(partial));
  const forged = await fixtureProject();
  forged.pages[0].imageUrl = project.pages[0].imageUrl;
  await writeFile(path.join(dir, 'projects', forged.id, 'project.json'), JSON.stringify(forged));
  const linked = await fixtureProject();
  const linkedFile = path.join(dir, 'projects', linked.id, 'images', path.basename(linked.pages[0].imageUrl));
  await rm(linkedFile); await symlink(callsFile, linkedFile);
  const calls = async () => JSON.parse(await readFile(callsFile, 'utf8'));
  async function request(route, { method = 'GET', body, origin = base } = {}) {
    const response = await fetch(base + route, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch {}
    return { response, raw, value };
  }
  async function waitFor(predicate) {
    for (let i = 0; i < 200; i++) {
      const result = await request('/api/xhs');
      if (predicate(result.value)) return result.value;
      await sleep(20);
    }
    assert.fail(`XHS job did not settle: ${JSON.stringify((await request('/api/xhs')).value)}`);
  }
  async function stop() {
    if (child?.exitCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended; }
  }
  async function start() {
    log = '';
    const preload = `
      import { readFile, writeFile } from 'node:fs/promises';
      import { XhsBrowser } from './lib/xhs-browser.mjs';
      const controls=${JSON.stringify(controls)}, callsFile=${JSON.stringify(callsFile)};
      const controlsNow=async()=>JSON.parse(await readFile(controls,'utf8'));
      const record=async entry=>{const calls=JSON.parse(await readFile(callsFile,'utf8'));calls.push(entry);await writeFile(callsFile,JSON.stringify(calls));return calls;};
      const identity=async()=>({state:'connected',browserOpen:true,account:{id:(await controlsNow()).accountId,nickname:'MOCK 测试账号',avatar:null,url:'https://www.xiaohongshu.com/user/profile/'+(await controlsNow()).accountId,followers:25,following:null,likes:72,notesCount:2},message:'MOCK 已连接'});
      XhsBrowser.prototype.openLogin=async function(){await record({action:'login'});return identity();};
      XhsBrowser.prototype.inspectAccount=async function(){await record({action:'check'});return identity();};
      XhsBrowser.prototype.sync=async function(){await record({action:'sync'});return {...await identity(),metrics:[{id:'views',label:'观看量',value:null,unit:'次',source:'MOCK 页面',period:'当前页面'}],notes:[{id:'mock-note',title:'MOCK 工具笔记',url:'https://www.xiaohongshu.com/explore/mock-note',views:null,likes:5,comments:1,collects:null}],coverage:{message:'MOCK 仅本页可见数据',hasMore:true,limit:50}};};
      XhsBrowser.prototype.openDrafts=async function(){await record({action:'open-drafts'});return identity();};
      XhsBrowser.prototype.saveDraft=async function(payload){
        const history=await record({action:'draft',payload});await new Promise(r=>setTimeout(r,60));
        if(payload.title==='MOCK 结果待核实')return {state:'unknown',submitted:true,accountId:payload.accountId,message:'MOCK 已点击暂存，结果不明确'};
        if(payload.title==='MOCK 失败一次'&&history.filter(x=>x.action==='draft'&&x.payload.fingerprint===payload.fingerprint).length===1)return {state:'failed',submitted:false,accountId:payload.accountId,message:'MOCK 上传未完成，未点击暂存'};
        return {state:'verified',submitted:true,accountId:payload.accountId,verifiedAt:new Date().toISOString(),message:'MOCK 重开草稿核验内容及图片数一致'};
      };
      XhsBrowser.prototype.close=async function(){};
      globalThis.fetch=async()=>{throw new Error('Network disabled in XHS HTTP fixture');};
      await import('./server.mjs');`;
    child = spawn(process.execPath, ['--input-type=module', '-e', preload], { cwd: root, env: { ...process.env, PORT: '19512', DATA_DIR: dir, TRENDS_AUTO_REFRESH: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) assert.fail(`XHS server exited: ${log}`);
      try { if ((await request('/api/xhs')).response.ok) return; } catch {}
      await sleep(30);
    }
    assert.fail(`XHS server did not start: ${log}`);
  }
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  await start();
  assert.deepEqual(await calls(), [], 'Server boot and GET must not open a browser');
  assert.equal((await request('/api/xhs', { origin: 'https://example.org' })).response.status, 403);
  assert.equal((await request('/api/xhs/drafts', { method: 'POST', body: { projectId: project.id, accountId: accountA } })).response.status, 409);
  assert.equal((await request('/api/xhs/login', { method: 'POST', body: {} })).response.status, 202);
  await waitFor(value => !value.status.busy && value.connection.state === 'connected');
  assert.equal((await request('/api/xhs/sync', { method: 'POST', body: {} })).response.status, 202);
  let snapshot = await waitFor(value => !value.status.busy && value.notes.length > 0);
  assert.equal(snapshot.metrics.find(item => item.id === 'views').value, null);
  assert.equal(snapshot.notes[0].collects, null);
  assert.match(snapshot.sync.coverage.message, /仅本页/);
  for (const input of [
    { projectId: partial.id, accountId: accountA },
    { projectId: forged.id, accountId: accountA },
    { projectId: linked.id, accountId: accountA },
    { projectId: project.id, accountId: accountB },
  ]) assert.equal((await request('/api/xhs/drafts', { method: 'POST', body: input })).response.status, 409);
  assert.equal((await request('/api/xhs/drafts', { method: 'POST', body: { projectId: project.id } })).response.status, 400);
  assert.equal((await request('/api/xhs/drafts', { method: 'POST', body: { projectId: project.id, accountId: accountA, title: '长'.repeat(21) } })).response.status, 400);
  assert.equal((await request('/api/xhs/drafts', { method: 'POST', body: { projectId: project.id, accountId: accountA, content: '文'.repeat(1001) } })).response.status, 400);
  const payload = { projectId: project.id, accountId: accountA, images: ['/etc/passwd'] };
  const submitted = await request('/api/xhs/drafts', { method: 'POST', body: payload });
  assert.equal(submitted.response.status, 202, submitted.raw);
  snapshot = await waitFor(value => !value.status.busy && value.drafts.some(draft => draft.status === 'verified'));
  const verified = snapshot.drafts.find(draft => draft.status === 'verified');
  const repeat = await request('/api/xhs/drafts', { method: 'POST', body: payload });
  assert.equal(repeat.response.status, 202, repeat.raw);
  assert.equal(repeat.value.draft.id, verified.id);
  let draftCalls = (await calls()).filter(entry => entry.action === 'draft');
  assert.equal(draftCalls.length, 1);
  assert.equal(draftCalls[0].payload.content, project.caption);
  assert.deepEqual(draftCalls[0].payload.images, project.pages.map(page => path.join(dir, 'projects', project.id, 'images', path.basename(page.imageUrl))));
  const safe = JSON.stringify(snapshot);
  assert.ok(!safe.includes(dir)); assert.ok(!safe.includes(project.caption));

  const unknown = await request('/api/xhs/drafts', { method: 'POST', body: { ...payload, title: 'MOCK 结果待核实' } });
  assert.equal(unknown.response.status, 202, unknown.raw);
  await waitFor(value => !value.status.busy && value.drafts.some(draft => draft.status === 'unknown'));
  assert.equal((await request('/api/xhs/drafts', { method: 'POST', body: { ...payload, title: 'MOCK 结果待核实' } })).value.draft.id, unknown.value.draft.id);
  assert.equal((await request(`/api/xhs/drafts/${unknown.value.draft.id}/retry`, { method: 'POST', body: { accountId: accountA } })).response.status, 409);

  const failed = await request('/api/xhs/drafts', { method: 'POST', body: { ...payload, title: 'MOCK 失败一次' } });
  assert.equal(failed.response.status, 202, failed.raw);
  snapshot = await waitFor(value => !value.status.busy && value.drafts.some(draft => draft.id === failed.value.draft.id && draft.status === 'failed'));
  assert.equal(snapshot.drafts.find(draft => draft.id === failed.value.draft.id).canRetry, true);
  assert.equal((await request(`/api/xhs/drafts/${failed.value.draft.id}/retry`, { method: 'POST', body: { accountId: accountB } })).response.status, 409);
  const retry = await request(`/api/xhs/drafts/${failed.value.draft.id}/retry`, { method: 'POST', body: { accountId: accountA } });
  assert.equal(retry.response.status, 202, retry.raw);
  await waitFor(value => !value.status.busy && value.drafts.some(draft => draft.id === failed.value.draft.id && draft.status === 'verified'));
  assert.equal((await calls()).filter(entry => entry.action === 'draft').length, 4);

  await stop(); await start();
  assert.equal((await calls()).filter(entry => entry.action === 'draft').length, 4, 'Restart never transfers an old draft automatically');
  await request('/api/xhs/check', { method: 'POST', body: {} });
  await waitFor(value => !value.status.busy && value.connection.state === 'connected');
  assert.equal((await request('/api/xhs/drafts', { method: 'POST', body: payload })).value.draft.id, verified.id);
  assert.equal((await calls()).filter(entry => entry.action === 'draft').length, 4);
  assert.equal((await request('/api/xhs/disconnect', { method: 'POST', body: {} })).response.status, 202);
  await waitFor(value => !value.status.busy && value.connection.state === 'disconnected');
  await writeFile(controls, JSON.stringify({ accountId: accountB }));
  await request('/api/xhs/login', { method: 'POST', body: {} });
  snapshot = await waitFor(value => !value.status.busy && value.account?.id === accountB);
  assert.equal(snapshot.notes.length, 0); assert.equal(snapshot.drafts.length, 0);
  assert.equal((await request('/api/xhs/drafts', { method: 'POST', body: payload })).response.status, 409);
  assert.equal((await request('/api/projects')).value.projects.length, 4, 'Disconnect does not remove creative work');
});
