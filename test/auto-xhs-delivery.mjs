import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only synthetic local providers and temporary files are used. The injected
// browser driver cannot navigate or publish to any real social account.
const root = fileURLToPath(new URL('..', import.meta.url));
const testPort = Number(process.env.AUTO_XHS_TEST_PORT || 19514);
const base = `http://127.0.0.1:${testPort}`;
const accountA = 'aaaaaaaaaaaaaaaaaaaaaaaa', accountB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const secret = 'MOCK_AUTO_DELIVERY_MODEL_SECRET';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const active = project => ['analyzing','generating'].includes(project?.status)||['thinking','analyzing','generating'].includes(project?.chatStatus);
const delivering = project => ['preparing','queued','running'].includes(project?.xhsDelivery?.status);
const createBody = extra => ({requestId:randomUUID(),source:'MOCK 用真实 coding 工具案例介绍模型 API 使用场景，制作图文并放入草稿。',style:'notion',aspect:'3:4',count:2,mode:'cards',...extra});

test('chat generation automatically delivers once to its bound desktop account with safe queueing and recovery', {timeout:60000}, async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(),'content-studio-auto-xhs-')));
  const controlsFile=path.join(dir,'driver-controls.json'), callsFile=path.join(dir,'driver-calls.json');
  let controls={accountId:accountA,loggedIn:true,outcome:'verified',draftDelay:40,syncDelay:0};
  await writeFile(controlsFile,JSON.stringify(controls)); await writeFile(callsFile,'[]');
  let child,log='',textCalls=0,imageCalls=0,planCalls=0,imageFailures=0,textDelay=0,imageDelay=0,planTitle;
  let chatOutput={action:'reply',reply:'MOCK 请说明要修改的内容。'};
  const incoming=[];
  const upstream=createServer(async(req,res)=>{
    try {
      let raw='';for await(const chunk of req)raw+=chunk;
      const input=raw?JSON.parse(raw):{};incoming.push({path:req.url,input});res.setHeader('Content-Type','application/json');
      if(req.url==='/v1/images/generations'){
        imageCalls++;if(imageDelay)await sleep(imageDelay);
        if(imageFailures>0){imageFailures--;res.statusCode=429;return res.end(JSON.stringify({error:{message:'MOCK image capacity exhausted'}}));}
        return res.end(JSON.stringify({data:[{b64_json:png}]}));
      }
      if(req.url!=='/v1/chat/completions'){res.statusCode=404;return res.end('{}');}
      textCalls++;const isPlan=input.messages?.some(m=>m.role==='system'&&typeof m.content==='string'&&m.content.includes('中文图文内容策划与视觉导演'));
      let content;
      if(isPlan){
        planCalls++;if(textDelay)await sleep(textDelay);
        const prompt=input.messages.map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
        const count=Number(prompt.match(/页数[：:]\s*(\d+)/)?.[1])||1;
        content=JSON.stringify({title:planTitle||'MOCK 顺序创作案例',caption:'MOCK 以已确认的工具案例介绍模型 API，完整正文。',pages:Array.from({length:count},(_,i)=>({title:`MOCK 页面${i+1}`,content:`MOCK 真实场景${i+1}`,prompt:`MOCK 为第${i+1}张制作清楚的图文。`}))});
      }else content=JSON.stringify(chatOutput);
      res.end(JSON.stringify({choices:[{message:{content}}]}));
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:{message:error.message}}));}
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const upstreamOrigin=`http://127.0.0.1:${upstream.address().port}`;
  async function setControls(patch){controls={...controls,...patch};const temp=controlsFile+'.tmp';await writeFile(temp,JSON.stringify(controls));await rename(temp,controlsFile);}
  const calls=async()=>JSON.parse(await readFile(callsFile,'utf8'));
  const draftCalls=async()=>(await calls()).filter(call=>call.action==='draft');
  async function request(route,{method='GET',body}={}){
    const response=await fetch(base+route,{method,headers:{Origin:base,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    const raw=await response.text();let value;try{value=JSON.parse(raw);}catch{}return {response,raw,value};
  }
  async function waitProject(id,predicate,label='project'){
    for(let i=0;i<500;i++){const r=await request(`/api/projects/${id}`);assert.equal(r.response.status,200,r.raw);if(predicate(r.value.project)&&(label==='in-flight'||!r.value.project.xhsDelivery?.running))return r.value.project;await sleep(20);}
    assert.fail(`${label} did not settle: ${JSON.stringify((await request(`/api/projects/${id}`)).value)}`);
  }
  async function waitXhs(predicate=value=>!value.status.busy){
    for(let i=0;i<300;i++){const r=await request('/api/xhs');if(predicate(r.value))return r.value;await sleep(20);}
    assert.fail(`Account did not settle: ${JSON.stringify((await request('/api/xhs')).value)}`);
  }
  async function start(){
    log='';
    const preload=`
      import {readFile,writeFile} from 'node:fs/promises';
      import {XhsBrowser} from './lib/xhs-browser.mjs';
      const controlsFile=${JSON.stringify(controlsFile)},callsFile=${JSON.stringify(callsFile)};
      const config=async()=>JSON.parse(await readFile(controlsFile,'utf8'));
      const record=async item=>{const a=JSON.parse(await readFile(callsFile,'utf8'));a.push(item);await writeFile(callsFile,JSON.stringify(a));};
      const identity=async()=>{const c=await config();return c.loggedIn?{state:'connected',browserOpen:true,account:{id:c.accountId,nickname:c.accountId===${JSON.stringify(accountA)}?'MOCK 账号A':'MOCK 账号B',followers:5,following:null,likes:12,notesCount:2},message:'MOCK 已确认账号'}:{state:'login_required',account:null,browserOpen:true,message:'MOCK 登录过期'};};
      XhsBrowser.prototype.openLogin=async function(){await record({action:'login'});return identity();};
      XhsBrowser.prototype.inspectAccount=async function(){await record({action:'check'});return identity();};
      XhsBrowser.prototype.sync=async function(){await record({action:'sync-start'});const c=await config();await new Promise(r=>setTimeout(r,c.syncDelay));await record({action:'sync-end'});return {...await identity(),metrics:[],notes:[],coverage:{message:'MOCK 当前页面',hasMore:null,limit:50}};};
      XhsBrowser.prototype.openDrafts=async function(){await record({action:'open-drafts'});return identity();};
      XhsBrowser.prototype.saveDraft=async function(payload){const c=await config();if(!c.loggedIn)return {state:'failed',submitted:false,needsAttention:true,message:'MOCK 登录已过期，未暂存'};if(c.accountId!==payload.accountId)return {state:'failed',submitted:false,accountMismatch:true,accountId:c.accountId,message:'MOCK 浏览器账号已变化，未暂存'};await record({action:'draft',payload});await new Promise(r=>setTimeout(r,c.draftDelay));if(c.outcome==='unknown')return {state:'unknown',submitted:true,accountId:payload.accountId,message:'MOCK 已点击暂存，结果待核对'};if(c.outcome==='filled')return {state:'filled',submitted:false,accountId:payload.accountId,message:'MOCK 已填入，原文待核对'};if(c.outcome==='failed')return {state:'failed',submitted:false,accountId:payload.accountId,message:'MOCK 上传前失败，未点击暂存'};return {state:'verified',submitted:true,accountId:payload.accountId,verifiedAt:new Date().toISOString(),message:'MOCK 已重开草稿核对'};};
      XhsBrowser.prototype.verifyDraft=async function(payload){const c=await config();await record({action:'verify',payload});await new Promise(r=>setTimeout(r,c.verifyDelay||20));if(c.accountId!==payload.accountId)return {state:'unknown',accountMismatch:true,accountId:c.accountId,message:'MOCK 核验期间账号变化'};if(c.verifyOutcome==='unknown')return {state:'unknown',accountId:payload.accountId,message:'MOCK 草稿内容暂不一致'};return {state:'verified',accountId:payload.accountId,verifiedAt:new Date().toISOString(),message:'MOCK 只读复核一致'};};
      XhsBrowser.prototype.close=async function(){};
      const originalFetch=globalThis.fetch;globalThis.fetch=async(input,options)=>{const u=new URL(String(input));if(u.origin===${JSON.stringify(upstreamOrigin)})return originalFetch(input,options);throw new Error('External network disabled in auto-draft test');};
      await import('./server.mjs');`;
    child=spawn(process.execPath,['--input-type=module','-e',preload],{cwd:root,env:{...process.env,PORT:String(testPort),DATA_DIR:dir,TRENDS_AUTO_REFRESH:'0'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',value=>{log+=value;});child.stderr.on('data',value=>{log+=value;});
    for(let i=0;i<100;i++){if(child.exitCode!==null)assert.fail(`Server exited: ${log}`);try{if((await request('/api/xhs')).response.ok)return;}catch{}await sleep(30);}
    assert.fail(`Server failed to start: ${log}`);
  }
  async function stop(){if(child?.exitCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await ended;}}
  async function connect(action='login'){const r=await request(`/api/xhs/${action}`,{method:'POST',body:{}});assert.equal(r.response.status,202,r.raw);return waitXhs(v=>!v.status.busy&&v.connection.state==='connected');}
  async function create(extra={}){const input=createBody(extra),r=await request('/api/brief/create',{method:'POST',body:input});assert.equal(r.response.status,202,r.raw);return {input,initial:r.value.project};}
  async function chat(id,message,output){await waitProject(id,p=>!active(p));chatOutput=output;const requestId=randomUUID(),r=await request(`/api/projects/${id}/chat`,{method:'POST',body:{requestId,message}});assert.equal(r.response.status,202,r.raw);return waitProject(id,p=>p.chatRequests?.some(record=>record.requestId===requestId&&record.status!=='running'),'chat');}
  async function continueDelivery(id,accountId=accountA){const r=await request(`/api/projects/${id}/xhs-delivery`,{method:'POST',body:{accountId}});assert.equal(r.response.status,202,r.raw);return r;}
  async function legacyProject(){
    const id=randomUUID(),pageId=randomUUID(),now=new Date().toISOString(),directory=path.join(dir,'projects',id,'images'),filename=`${pageId}-${randomUUID()}.png`;
    await mkdir(directory,{recursive:true});await writeFile(path.join(directory,filename),Buffer.from(png,'base64'));
    const p={id,title:'MOCK 旧作品',caption:'MOCK 过去的正文',source:'MOCK 旧素材',createdAt:now,updatedAt:now,status:'completed',chatStatus:'idle',count:1,mode:'cards',style:'notion',aspect:'3:4',logs:[],pages:[{id:pageId,title:'MOCK 旧图',content:'MOCK 已有文字',prompt:'MOCK 画面',status:'done',imageUrl:`/media/${id}/${filename}`,error:null}]};
    await writeFile(path.join(dir,'projects',id,'project.json'),JSON.stringify(p));return p;
  }
  const legacy=await legacyProject();
  t.after(async()=>{await stop();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));await rm(dir,{recursive:true,force:true});});
  await start();
  const configured=await request('/api/config',{method:'PUT',body:{text:{baseUrl:upstreamOrigin+'/v1',model:'mock-text',apiKey:secret},image:{baseUrl:upstreamOrigin+'/v1',model:'mock-image',apiKey:secret,mode:'images',size:'auto'}}});
  assert.equal(configured.response.status,200,configured.raw);assert.equal((await calls()).length,0,'Boot and GET do not open a social browser');

  await t.test('unconnected creation stays local until a deliberate same-account continuation',async()=>{
    const made=await create({count:1}),p=await waitProject(made.initial.id,p=>!active(p)&&p.xhsDelivery?.status==='blocked');
    assert.equal(p.status,'completed');assert.equal(p.pages.length,1);assert.equal(p.xhsDelivery.accountId,null);assert.equal((await draftCalls()).length,0);
    await connect();await request(`/api/projects/${p.id}`);await request('/api/projects');assert.equal((await draftCalls()).length,0,'Logging in does not retroactively bind a work');
    const before={textCalls,imageCalls};await continueDelivery(p.id);const delivered=await waitProject(p.id,p=>p.xhsDelivery?.status==='verified');
    assert.equal(delivered.xhsDelivery.accountId,accountA);assert.deepEqual({textCalls,imageCalls},before);
  });

  let first,originalInput;
  await t.test('one creation request plans all pictures and automatically stores one draft without a handoff click',async()=>{
    const before={planCalls,imageCalls,drafts:(await draftCalls()).length};textDelay=60;originalInput=createBody();
    const responses=await Promise.all([request('/api/brief/create',{method:'POST',body:originalInput}),request('/api/brief/create',{method:'POST',body:originalInput})]);
    for(const r of responses)assert.equal(r.response.status,202,r.raw);assert.equal(responses[0].value.project.id,responses[1].value.project.id);
    first=await waitProject(responses[0].value.project.id,p=>p.xhsDelivery?.status==='verified');textDelay=0;
    assert.equal(first.status,'completed');assert.equal(first.xhsDelivery.accountId,accountA);assert.ok(first.xhsDelivery.draftId);
    assert.equal(planCalls,before.planCalls+1);assert.equal(imageCalls,before.imageCalls+2);assert.equal((await draftCalls()).length,before.drafts+1);
    const actual=(await draftCalls()).at(-1).payload;assert.equal(actual.accountId,accountA);assert.equal(actual.title,first.title);assert.equal(actual.content,first.caption);assert.equal(actual.images.length,2);
    const plan=incoming.filter(item=>item.path==='/v1/chat/completions'&&item.input.messages[0].content.includes('中文图文内容策划与视觉导演')).at(-1),prompt=JSON.stringify(plan.input.messages);
    assert.match(prompt,/小红书/);assert.match(prompt,/20/);assert.match(prompt,/1000/);
    const counts={textCalls,imageCalls,drafts:(await draftCalls()).length};await request(`/api/projects/${first.id}`);await request('/api/projects');const replay=await request('/api/brief/create',{method:'POST',body:originalInput});
    assert.equal(replay.value.project.id,first.id);assert.deepEqual({textCalls,imageCalls,drafts:(await draftCalls()).length},counts);
  });

  await t.test('legacy work and ordinary post or image edits do not quietly create new native drafts',async()=>{
    const before=(await draftCalls()).length;assert.equal((await request(`/api/projects/${legacy.id}`)).value.project.xhsDelivery,undefined);
    await chat(legacy.id,'只修改帖子正文，图片不动。',{action:'update_post',reply:'MOCK 已更新正文',caption:'MOCK 旧作品的新正文'});
    first=await chat(first.id,'只修改帖子正文，图片不动。',{action:'update_post',reply:'MOCK 已更新正文',caption:'MOCK 已投作品的新正文'});
    first=await chat(first.id,'重画第1张图片。',{action:'regenerate',reply:'MOCK 已重画第1张',pageIds:[first.pages[0].id]});
    assert.equal(first.xhsDelivery.status,'verified');assert.equal((await draftCalls()).length,before);
  });

  await t.test('chat can save an edited version with no model call and replay cannot duplicate it',async()=>{
    const before={textCalls,imageCalls,drafts:(await draftCalls()).length},oldDraft=first.xhsDelivery.draftId,body={requestId:randomUUID(),message:'把修改后的版本存到草稿箱'};
    const responses=await Promise.all([request(`/api/projects/${first.id}/chat`,{method:'POST',body}),request(`/api/projects/${first.id}/chat`,{method:'POST',body})]);
    for(const r of responses)assert.equal(r.response.status,202,r.raw);
    first=await waitProject(first.id,p=>p.chatRequests?.some(record=>record.requestId===body.requestId&&record.status==='completed')&&p.xhsDelivery?.status==='verified'&&p.xhsDelivery?.version===2);
    assert.deepEqual({textCalls,imageCalls},{textCalls:before.textCalls,imageCalls:before.imageCalls});assert.equal((await draftCalls()).length,before.drafts+1);
    assert.notEqual(first.xhsDelivery.draftId,oldDraft);assert.equal(first.xhsDelivery.version,2);assert.ok(first.xhsDelivery.history.some(receipt=>receipt.draftId===oldDraft));
    const counts={textCalls,imageCalls,drafts:(await draftCalls()).length};
    await chat(first.id,'把当前版本存到草稿箱',{action:'reply',reply:'MOCK 不应调用模型'});
    first=await waitProject(first.id,p=>p.xhsDelivery?.status==='verified');assert.deepEqual({textCalls,imageCalls,drafts:(await draftCalls()).length},counts);
    assert.equal(first.xhsDelivery.version,2);
  });

  await t.test('one chat message can edit a post and deliver its new version without redrawing images',async()=>{
    const before={textCalls,imageCalls,drafts:(await draftCalls()).length},images=first.pages.map(page=>page.imageUrl);
    first=await chat(first.id,'帖子标题改成“工具开发新体验”，然后存到草稿箱',{action:'update_post',reply:'MOCK 改标题',title:'工具开发新体验'});
    first=await waitProject(first.id,p=>p.xhsDelivery?.status==='verified'&&p.xhsDelivery?.version===3);
    assert.equal(textCalls,before.textCalls+1);assert.equal(imageCalls,before.imageCalls);assert.equal((await draftCalls()).length,before.drafts+1);
    assert.deepEqual(first.pages.map(page=>page.imageUrl),images);assert.equal((await draftCalls()).at(-1).payload.title,'工具开发新体验');assert.equal(first.xhsDelivery.version,3);
  });

  await t.test('quoted post material and conditional approval do not authorize a new native draft',async()=>{
    const before=(await draftCalls()).length;
    first=await chat(first.id,'把正文改成下面这段文字：\n存到草稿箱',{action:'update_post',reply:'MOCK 修改正文',caption:'存到草稿箱'});
    assert.equal(first.caption,'存到草稿箱');assert.equal((await draftCalls()).length,before);
    first=await chat(first.id,'标题先改短，如果我同意，存到草稿箱',{action:'update_post',reply:'MOCK 修改标题',title:'开发小工具'});
    assert.equal(first.title,'开发小工具');assert.equal((await draftCalls()).length,before);assert.equal(first.xhsDelivery.version,3);
  });

  await t.test('copy limits are checked before paid image work and invalid chat edits preserve the old copy',async()=>{
    const before=imageCalls;planTitle='长'.repeat(21);const made=await create({count:1}),p=await waitProject(made.initial.id,p=>!active(p));planTitle=undefined;
    assert.equal(p.status,'error');assert.match(p.error,/标题超过20/);assert.equal(imageCalls,before);
    const title=first.title,caption=first.caption,drafts=(await draftCalls()).length;
    const result=await chat(first.id,'只修改帖子正文，图片不动',{action:'update_post',reply:'MOCK 正文过长',caption:'长'.repeat(1001)});
    assert.equal(result.title,title);assert.equal(result.caption,caption);assert.equal(result.status,'completed');assert.equal(imageCalls,before);assert.equal((await draftCalls()).length,drafts);
  });

  await t.test('filled receipts can be checked read-only against their frozen version without uploading again',async()=>{
    await setControls({outcome:'filled',verifyOutcome:'unknown'});const made=await create({count:1}),p=await waitProject(made.initial.id,p=>p.xhsDelivery?.status==='filled'),counts={textCalls,imageCalls,drafts:(await draftCalls()).length};
    const route=`/api/xhs/drafts/${p.xhsDelivery.draftId}/recheck`;
    assert.equal((await request(route)).response.status,405);
    assert.equal((await request(route,{method:'POST',body:{accountId:accountB}})).response.status,409);
    const noReplay=await request(`/api/projects/${p.id}/xhs-delivery`,{method:'POST',body:{accountId:accountA,newVersion:true}});assert.equal(noReplay.response.status,409,noReplay.raw);
    const recheck=await request(route,{method:'POST',body:{accountId:accountA}});assert.equal(recheck.response.status,202,recheck.raw);await waitXhs();
    assert.equal((await request(`/api/projects/${p.id}`)).value.project.xhsDelivery.status,'filled');
    const patch=await request(`/api/projects/${p.id}`,{method:'PATCH',body:{caption:'MOCK 手工修改后的本地正文'}});assert.equal(patch.response.status,200,patch.raw);
    await setControls({verifyOutcome:'verified',verifyDelay:200});const second=await request(route,{method:'POST',body:{accountId:accountA}});assert.equal(second.response.status,202,second.raw);
    const busy=await request('/api/xhs/sync',{method:'POST',body:{}});assert.equal(busy.response.status,409,busy.raw);
    const verified=await waitProject(p.id,p=>p.xhsDelivery?.status==='verified');assert.ok(verified.xhsDelivery.verifiedAt);
    const actual=(await calls()).filter(call=>call.action==='verify').at(-1).payload;assert.equal(actual.content,p.caption,'Recheck uses frozen delivered text, not edited project content');
    assert.deepEqual({textCalls,imageCalls,drafts:(await draftCalls()).length},counts);
    await setControls({outcome:'verified',verifyOutcome:'verified',verifyDelay:20});
  });

  await t.test('partial images are preserved and the first successful image retry continues the automatic handoff',async()=>{
    imageFailures=1;const before=(await draftCalls()).length,made=await create({count:3});let p=await waitProject(made.initial.id,p=>!active(p));
    assert.equal(p.status,'partial');assert.equal(p.pages.filter(page=>page.status==='done').length,2);assert.equal((await draftCalls()).length,before);
    const good=p.pages.filter(page=>page.status==='done'),bad=p.pages.find(page=>page.status==='error'),beforeImage=imageCalls;
    p=await chat(p.id,'重试失败的那张图片。',{action:'regenerate',reply:'MOCK 补齐失败页',pageIds:[bad.id]});p=await waitProject(p.id,p=>p.xhsDelivery?.status==='verified');
    assert.equal(imageCalls,beforeImage+1);assert.equal((await draftCalls()).length,before+1);for(const page of good)assert.deepEqual(p.pages.find(item=>item.id===page.id),page);
  });

  await t.test('another account task is awaited without a second manual send operation',async()=>{
    await setControls({syncDelay:350});const sync=await request('/api/xhs/sync',{method:'POST',body:{}});assert.equal(sync.response.status,202,sync.raw);await waitXhs(v=>v.status.busy);
    const before=(await draftCalls()).length,made=await create({count:1}),p=await waitProject(made.initial.id,p=>p.xhsDelivery?.status==='verified');
    assert.equal(p.status,'completed');assert.equal((await draftCalls()).length,before+1);const events=await calls();assert.ok(events.findLastIndex(e=>e.action==='draft')>events.findLastIndex(e=>e.action==='sync-end'));
    await setControls({syncDelay:0});
  });

  await t.test('in-flight delivery freezes edits and deletion of the same work',async()=>{
    await setControls({draftDelay:350});const made=await create({count:1}),p=await waitProject(made.initial.id,p=>delivering(p)&&p.status==='completed','in-flight'),beforeText=textCalls;
    assert.equal((await request(`/api/projects/${p.id}`,{method:'PATCH',body:{title:'MOCK 不应应用'}})).response.status,409);
    assert.equal((await request(`/api/projects/${p.id}`,{method:'DELETE'})).response.status,409);
    assert.equal((await request(`/api/projects/${p.id}/chat`,{method:'POST',body:{requestId:randomUUID(),message:'把帖子标题改成不应应用。'}})).response.status,409);assert.equal(textCalls,beforeText);
    await waitProject(p.id,p=>p.xhsDelivery?.status==='verified');await setControls({draftDelay:40});
  });

  await t.test('changing the browser account during generation cannot redirect a bound delivery to another account',async()=>{
    textDelay=180;const before=(await draftCalls()).length,made=await create({count:1});assert.equal(made.initial.xhsDelivery.accountId,accountA);await setControls({accountId:accountB});
    const p=await waitProject(made.initial.id,p=>!active(p)&&['blocked','failed'].includes(p.xhsDelivery?.status));textDelay=0;
    assert.equal(p.status,'completed');assert.equal(p.xhsDelivery.accountId,accountA);assert.equal((await draftCalls()).length,before);
    assert.equal((await request(`/api/projects/${p.id}/xhs-delivery`,{method:'POST',body:{accountId:accountB}})).response.status,409);await setControls({accountId:accountA});await connect('check');
  });

  await t.test('expired login does not lose artwork and explicit continuation makes no model requests',async()=>{
    textDelay=120;const before=(await draftCalls()).length,made=await create({count:1});await setControls({loggedIn:false});
    const p=await waitProject(made.initial.id,p=>!active(p)&&['blocked','failed'].includes(p.xhsDelivery?.status));textDelay=0;
    assert.equal(p.status,'completed');assert.ok(p.pages.every(page=>page.imageUrl));assert.equal((await draftCalls()).length,before);await setControls({loggedIn:true});await connect('check');
    const counts={textCalls,imageCalls};await continueDelivery(p.id);await waitProject(p.id,p=>p.xhsDelivery?.status==='verified');assert.deepEqual({textCalls,imageCalls},counts);assert.equal((await draftCalls()).length,before+1);
  });

  await t.test('a definite pre-save failure can be continued explicitly without generating content twice',async()=>{
    await setControls({outcome:'failed'});const before=(await draftCalls()).length,made=await create({count:1}),p=await waitProject(made.initial.id,p=>!active(p)&&p.xhsDelivery?.status==='failed');
    assert.equal(p.status,'completed');assert.equal((await draftCalls()).length,before+1);const counts={textCalls,imageCalls};await request(`/api/projects/${p.id}`);await request('/api/projects');assert.equal((await draftCalls()).length,before+1);
    await setControls({outcome:'verified'});await continueDelivery(p.id);await waitProject(p.id,p=>p.xhsDelivery?.status==='verified');assert.deepEqual({textCalls,imageCalls},counts);assert.equal((await draftCalls()).length,before+2);
  });

  let unknownProject;
  await t.test('an uncertain save is not repeated by reads, creation replay, or explicit continuation',async()=>{
    await setControls({outcome:'unknown'});const before=(await draftCalls()).length,made=await create({count:1});unknownProject=await waitProject(made.initial.id,p=>p.xhsDelivery?.status==='unknown');
    assert.equal(unknownProject.status,'completed');assert.equal((await draftCalls()).length,before+1);await request(`/api/projects/${unknownProject.id}`);await request('/api/projects');await request('/api/brief/create',{method:'POST',body:made.input});
    assert.equal((await request(`/api/projects/${unknownProject.id}/xhs-delivery`,{method:'POST',body:{accountId:accountA}})).response.status,409);assert.equal((await draftCalls()).length,before+1);await setControls({outcome:'verified'});
  });

  await t.test('a restart while the browser is saving records uncertainty and does not replay that action',async()=>{
    await setControls({draftDelay:1000});const made=await create({count:1}),p=await waitProject(made.initial.id,p=>p.xhsDelivery?.status==='running'&&p.xhsDelivery.draftId,'in-flight'),before=(await draftCalls()).length;
    await stop();await setControls({draftDelay:40});await start();const restored=(await request(`/api/projects/${p.id}`)).value.project;
    assert.equal(restored.status,'completed');assert.ok(['unknown','interrupted'].includes(restored.xhsDelivery.status));assert.equal((await draftCalls()).length,before);
    await request('/api/projects');await request(`/api/projects/${p.id}`);assert.equal((await draftCalls()).length,before);assert.equal((await request(`/api/projects/${unknownProject.id}`)).value.project.xhsDelivery.status,'unknown');await connect('check');
    assert.equal((await request(`/api/projects/${p.id}/xhs-delivery`,{method:'POST',body:{accountId:accountA}})).response.status,409);assert.equal((await draftCalls()).length,before);
  });
  assert.ok(!log.includes(secret));
});
