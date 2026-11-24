import test from 'node:test';
import { replyToQualityReview } from './helpers/quality-provider.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// All model and publisher calls stay on temporary loopback fixtures.
const root = fileURLToPath(new URL('..', import.meta.url));
const testPort = Number(process.env.AUTO_XHS_TEST_PORT || 19514);
const base = `http://127.0.0.1:${testPort}`;
const accountA = 'xhs_account_001', accountB = 'xhs_account_other';
const publisherToken = 'mock-only-publisher-token';
const secret = 'MOCK_AUTO_DELIVERY_MODEL_SECRET';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const active = project => ['analyzing','generating'].includes(project?.status)||['thinking','analyzing','generating'].includes(project?.chatStatus);
const delivering = project => ['preparing','queued','running'].includes(project?.xhsDelivery?.status);
const createBody = extra => ({requestId:randomUUID(),source:'MOCK 用真实 coding 工具案例介绍模型 API 使用场景，制作图文并放入草稿。',style:'notion',aspect:'3:4',count:2,mode:'cards',xhsAutoDelivery:true,...extra});

test('chat creation delivers a verified draft through the configured publisher with safe recovery', {timeout:60000}, async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(),'content-studio-auto-xhs-')));
  const publisherRequests = [], drafts = [], jobs = new Map();
  let availableAccount = accountA, paused = false, needsAttention = false, queryDelay = 0;
  function publisher(req, res, input) {
    const reply = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    publisherRequests.push({ method: req.method, url: req.url });
    if (req.url === '/health/live') return reply(200, {status:'ok'});
    if (req.headers.authorization !== 'Bearer ' + publisherToken) return reply(401, {});
    if (req.url === '/health/ready') return reply(200, {database:'ok',worker_active:true,account_paused:paused});
    if (req.url === '/v1/accounts') return reply(200, {items:[{account_id:availableAccount,paused,publish_enabled:false}]});
    if (req.url === '/v1/jobs' && req.method === 'POST') {
      assert.equal(input.action,'create_draft');
      assert.equal(input.account_id,accountA);
      assert.ok(req.headers['idempotency-key']);
      const id = randomUUID().replaceAll('-', '');
      const job = {job_id:'job_'+id,draft_id:'draft_'+id,account_id:accountA,action:'create_draft',content_version:1,content_hash:'e'.repeat(64)};
      jobs.set(job.job_id,job);
      drafts.push({input,job});
      return reply(202,{...job,status:'queued'});
    }
    const id = req.url.split('/').at(-1);
    if (req.url.startsWith('/v1/jobs/') && req.method === 'GET' && jobs.has(id)) {
      const status = needsAttention ? 'needs_attention' : 'succeeded';
      return setTimeout(() => reply(200,{...jobs.get(id),status}),queryDelay);
    }
    if (req.url.startsWith('/v1/drafts/') && req.method === 'GET') {
      const entry = drafts.find(row => row.job.draft_id === id);
      if (entry) {
        const {job,input:{content}} = entry;
        return reply(200,{...job,active_job_id:job.job_id,title:content.title,caption:content.caption,
          image_count:content.image_urls.length,phase:'ready',platform_status:'draft_verified'});
      }
    }
    return reply(404,{});
  }
  let child,log='',textCalls=0,imageCalls=0,planCalls=0,imageFailures=0,textDelay=0,imageDelay=0,planTitle;
  let chatOutput={action:'reply',reply:'MOCK 请说明要修改的内容。'};
  const incoming=[];
  const upstream=createServer(async(req,res)=>{
    try {
      let raw='';for await(const chunk of req)raw+=chunk;
      const input=raw?JSON.parse(raw):{};
      if (req.url.startsWith('/health/') || /^\/v1\/(accounts|drafts|jobs)(?:\/|$)/.test(req.url)) return publisher(req,res,input);
      if (replyToQualityReview(input, res)) return;
      incoming.push({path:req.url,input});res.setHeader('Content-Type','application/json');
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
  async function request(route,{method='GET',body}={}){
    const response=await fetch(base+route,{method,headers:{Origin:base,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    const raw=await response.text();let value;try{value=JSON.parse(raw);}catch{}return {response,raw,value};
  }
  async function waitProject(id,predicate,label='project'){
    for(let i=0;i<500;i++){const r=await request(`/api/projects/${id}`);assert.equal(r.response.status,200,r.raw);if(predicate(r.value.project)&&(label==='in-flight'||!r.value.project.xhsDelivery?.running))return r.value.project;await sleep(20);}
    assert.fail(`${label} did not settle: ${JSON.stringify((await request(`/api/projects/${id}`)).value)}`);
  }
  async function start(){
    log='';
    const preload=`
      const originalFetch=globalThis.fetch;
      globalThis.fetch=async(input,options)=>{
        if(new URL(String(input)).origin===${JSON.stringify(upstreamOrigin)}) return originalFetch(input,options);
        throw new Error('External network disabled in auto-draft test');
      };
      await import('./server.mjs');`;
    child=spawn(process.execPath,['--input-type=module','-e',preload],{cwd:root,env:{...process.env,
      PORT:String(testPort),DATA_DIR:dir,TRENDS_AUTO_REFRESH:'0',XHS_PUBLISHER_BASE_URL:upstreamOrigin,
      XHS_PUBLISHER_LAN_MEDIA_ORIGIN:'',XHS_PUBLISHER_MEDIA_BASE_URL:base,XHS_PUBLISHER_TOKEN:publisherToken,XHS_PUBLISHER_ACCOUNT_ID:accountA},
      stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',value=>{log+=value;});child.stderr.on('data',value=>{log+=value;});
    for(let i=0;i<100;i++){if(child.exitCode!==null)assert.fail(`Server exited: ${log}`);try{if((await request('/api/xhs')).response.ok)return;}catch{}await sleep(30);}
    assert.fail(`Server failed to start: ${log}`);
  }
  async function stop(){if(child?.exitCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await ended;}}
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
  assert.equal(configured.response.status,200,configured.raw);assert.equal(publisherRequests.length,0,'Boot and GET do not contact the publisher');

  let localProject;
  await t.test('new work defaults to platform-only and never requires a social session to edit',async()=>{
    const input=createBody({count:1});delete input.xhsAutoDelivery;
    const created=await request('/api/brief/create',{method:'POST',body:input});assert.equal(created.response.status,202,created.raw);
    localProject=await waitProject(created.value.project.id,p=>!active(p));assert.equal(localProject.xhsDelivery,undefined);assert.equal(localProject.xhsAutoDelivery,false);
    localProject=await chat(localProject.id,'只修改帖子正文，图片不动',{action:'update_post',reply:'MOCK 改好正文',caption:'MOCK 保存在平台内的修改'});
    assert.equal(localProject.caption,'MOCK 保存在平台内的修改');assert.equal(publisherRequests.length,0);
    const changed=await request('/api/brief/create',{method:'POST',body:{...input,xhsAutoDelivery:true}});assert.equal(changed.response.status,409,changed.raw);
  });

  await t.test('XHS-targeted writing is available offline and independent of automatic delivery',async()=>{
    const before=publisherRequests.length;
    const {input,initial}=await create({count:1,targetPlatform:'xhs',xhsAutoDelivery:false});
    const result=await waitProject(initial.id,p=>!active(p));
    assert.equal(result.status,'completed');assert.equal(result.targetPlatform,'xhs');
    assert.equal(result.xhsDelivery,undefined);assert.equal(publisherRequests.length,before);
    const plan=incoming.filter(item=>item.path==='/v1/chat/completions'&&item.input.messages[0].content.includes('中文图文内容策划与视觉导演')).at(-1);
    assert.match(plan.input.messages[0].content,/目标平台为小红书/);
    const replay=await request('/api/brief/create',{method:'POST',body:{...input,targetPlatform:'generic'}});
    assert.equal(replay.response.status,409);
    const over=await request(`/api/projects/${result.id}`,{method:'PATCH',body:{title:'🌿'.repeat(21)}});
    assert.equal(over.response.status,400);assert.match(over.raw,/21\/20/);
  });

  await t.test('an over-limit generic copy stays in the conversation for editing before any microservice check',async()=>{
    const before=publisherRequests.length;
    const {initial}=await create({count:1,targetPlatform:'generic',xhsAutoDelivery:false});
    await waitProject(initial.id,p=>!active(p));
    const title='🌿'.repeat(21),caption='字'.repeat(1001);
    const edit=await request(`/api/projects/${initial.id}`,{method:'PATCH',body:{title,caption}});
    assert.equal(edit.response.status,200,edit.raw);
    const queue=await request(`/api/projects/${initial.id}/xhs-delivery`,{method:'POST',body:{newVersion:true}});
    assert.equal(queue.response.status,400);assert.match(queue.raw,/21\/20/);assert.match(queue.raw,/1001\/1000/);
    const result=await chat(initial.id,'把当前版本存到草稿箱');
    assert.equal(result.chatMessages.at(-1).editXhsCopy,true);assert.equal(result.xhsDelivery,undefined);
    assert.equal(result.title,title);assert.equal(result.caption,caption);assert.equal(publisherRequests.length,before);
  });

  await t.test('platform-only work can be sent from its conversation explicitly when ready',async()=>{
    const before={textCalls,imageCalls,drafts:drafts.length};
    const result=await request(`/api/projects/${localProject.id}/xhs-delivery`,{method:'POST',body:{accountId:accountA,newVersion:true}});assert.equal(result.response.status,202,result.raw);
    const sent=await waitProject(localProject.id,p=>p.xhsDelivery?.status==='verified');assert.equal(sent.xhsDelivery.accountId,accountA);
    assert.deepEqual({textCalls,imageCalls},{textCalls:before.textCalls,imageCalls:before.imageCalls});assert.equal(drafts.length,before.drafts+1);
  });

  let first,originalInput;
  await t.test('one creation request plans all pictures and automatically stores one draft without a handoff click',async()=>{
    const before={planCalls,imageCalls,drafts:drafts.length};textDelay=60;originalInput=createBody();
    const responses=await Promise.all([request('/api/brief/create',{method:'POST',body:originalInput}),request('/api/brief/create',{method:'POST',body:originalInput})]);
    for(const r of responses)assert.equal(r.response.status,202,r.raw);assert.equal(responses[0].value.project.id,responses[1].value.project.id);
    first=await waitProject(responses[0].value.project.id,p=>p.xhsDelivery?.status==='verified');textDelay=0;
    assert.equal(first.status,'completed');assert.equal(first.xhsDelivery.accountId,accountA);assert.ok(first.xhsDelivery.draftId);
    assert.equal(planCalls,before.planCalls+1);assert.equal(imageCalls,before.imageCalls+2);assert.equal(drafts.length,before.drafts+1);
    const actual=drafts.at(-1).input;assert.equal(actual.account_id,accountA);assert.equal(actual.content.title,first.title);assert.equal(actual.content.caption,first.caption);assert.deepEqual(actual.content.image_urls,first.pages.map(page=>base+page.imageUrl));
    const plan=incoming.filter(item=>item.path==='/v1/chat/completions'&&item.input.messages[0].content.includes('中文图文内容策划与视觉导演')).at(-1),prompt=JSON.stringify(plan.input.messages);
    assert.match(prompt,/小红书/);assert.match(prompt,/20/);assert.match(prompt,/1000/);
    const counts={textCalls,imageCalls,drafts:drafts.length};await request(`/api/projects/${first.id}`);await request('/api/projects');const replay=await request('/api/brief/create',{method:'POST',body:originalInput});
    assert.equal(replay.value.project.id,first.id);assert.deepEqual({textCalls,imageCalls,drafts:drafts.length},counts);
  });

  await t.test('legacy work and ordinary post or image edits do not quietly create new native drafts',async()=>{
    const before=drafts.length;assert.equal((await request(`/api/projects/${legacy.id}`)).value.project.xhsDelivery,undefined);
    await chat(legacy.id,'只修改帖子正文，图片不动。',{action:'update_post',reply:'MOCK 已更新正文',caption:'MOCK 旧作品的新正文'});
    first=await chat(first.id,'只修改帖子正文，图片不动。',{action:'update_post',reply:'MOCK 已更新正文',caption:'MOCK 已投作品的新正文'});
    first=await chat(first.id,'重画第1张图片。',{action:'regenerate',reply:'MOCK 已重画第1张',pageIds:[first.pages[0].id]});
    assert.equal(first.xhsDelivery.status,'verified');assert.equal(drafts.length,before);
  });

  await t.test('chat can save an edited version with no model call and replay cannot duplicate it',async()=>{
    const before={textCalls,imageCalls,drafts:drafts.length},oldDraft=first.xhsDelivery.draftId,body={requestId:randomUUID(),message:'把修改后的版本存到草稿箱'};
    const responses=await Promise.all([request(`/api/projects/${first.id}/chat`,{method:'POST',body}),request(`/api/projects/${first.id}/chat`,{method:'POST',body})]);
    for(const r of responses)assert.equal(r.response.status,202,r.raw);
    first=await waitProject(first.id,p=>p.chatRequests?.some(record=>record.requestId===body.requestId&&record.status==='completed')&&p.xhsDelivery?.status==='verified'&&p.xhsDelivery?.version===2);
    assert.deepEqual({textCalls,imageCalls},{textCalls:before.textCalls,imageCalls:before.imageCalls});assert.equal(drafts.length,before.drafts+1);
    assert.notEqual(first.xhsDelivery.draftId,oldDraft);assert.equal(first.xhsDelivery.version,2);assert.ok(first.xhsDelivery.history.some(receipt=>receipt.draftId===oldDraft));
    const counts={textCalls,imageCalls,drafts:drafts.length};
    await chat(first.id,'把当前版本存到草稿箱',{action:'reply',reply:'MOCK 不应调用模型'});
    first=await waitProject(first.id,p=>p.xhsDelivery?.status==='verified');assert.deepEqual({textCalls,imageCalls,drafts:drafts.length},counts);
    assert.equal(first.xhsDelivery.version,2);
  });

  await t.test('one chat message can edit a post and deliver its new version without redrawing images',async()=>{
    const before={textCalls,imageCalls,drafts:drafts.length},images=first.pages.map(page=>page.imageUrl);
    first=await chat(first.id,'帖子标题改成“工具开发新体验”，然后存到草稿箱',{action:'update_post',reply:'MOCK 改标题',title:'工具开发新体验'});
    first=await waitProject(first.id,p=>p.xhsDelivery?.status==='verified'&&p.xhsDelivery?.version===3);
    assert.equal(textCalls,before.textCalls+1);assert.equal(imageCalls,before.imageCalls);assert.equal(drafts.length,before.drafts+1);
    assert.deepEqual(first.pages.map(page=>page.imageUrl),images);assert.equal(drafts.at(-1).input.content.title,'工具开发新体验');assert.equal(first.xhsDelivery.version,3);
  });

  await t.test('quoted post material and conditional approval do not authorize a new native draft',async()=>{
    const before=drafts.length;
    first=await chat(first.id,'把正文改成下面这段文字：\n存到草稿箱',{action:'update_post',reply:'MOCK 修改正文',caption:'存到草稿箱'});
    assert.equal(first.caption,'存到草稿箱');assert.equal(drafts.length,before);
    first=await chat(first.id,'标题先改短，如果我同意，存到草稿箱',{action:'update_post',reply:'MOCK 修改标题',title:'开发小工具'});
    assert.equal(first.title,'开发小工具');assert.equal(drafts.length,before);assert.equal(first.xhsDelivery.version,3);
  });

  await t.test('copy limits are checked before paid image work and invalid chat edits preserve the old copy',async()=>{
    const before=imageCalls;planTitle='长'.repeat(21);const made=await create({count:1}),p=await waitProject(made.initial.id,p=>!active(p));planTitle=undefined;
    assert.equal(p.status,'error');assert.match(p.error,/标题超过20/);assert.equal(imageCalls,before);
    const title=first.title,caption=first.caption,draftCount=drafts.length;
    const result=await chat(first.id,'只修改帖子正文，图片不动',{action:'update_post',reply:'MOCK 正文过长',caption:'长'.repeat(1001)});
    assert.equal(result.title,title);assert.equal(result.caption,caption);assert.equal(result.status,'completed');assert.equal(imageCalls,before);assert.equal(drafts.length,draftCount);
  });

  await t.test('a saved draft with uncertain status is checked against the frozen request without another write', async () => {
    needsAttention = true;
    const { initial, input } = await create({ count:1 });
    const p = await waitProject(initial.id, p => p.xhsDelivery?.status === 'unknown');
    const counts = { textCalls, imageCalls, drafts:drafts.length };
    const route = `/api/xhs/drafts/${p.xhsDelivery.draftId}/recheck`;
    const replay = await request('/api/brief/create', { method:'POST', body:input });
    assert.equal(replay.value.project.id,p.id);
    assert.equal((await request(`/api/projects/${p.id}/xhs-delivery`, {method:'POST',body:{accountId:accountA,newVersion:true}})).response.status,409);
    assert.equal((await request(route,{method:'POST',body:{accountId:accountB}})).response.status,409);
    await request(`/api/projects/${p.id}`,{method:'PATCH',body:{caption:'修改后的本地正文'}});
    needsAttention = false;
    assert.equal((await request(route,{method:'POST',body:{accountId:accountA}})).response.status,202);
    const verified = await waitProject(p.id, p => p.xhsDelivery?.status === 'verified');
    assert.equal(verified.caption,'修改后的本地正文');
    assert.deepEqual({textCalls,imageCalls,drafts:drafts.length},counts);
  });

  await t.test('partial images are preserved and the first successful image retry continues the automatic handoff',async()=>{
    imageFailures=1;const before=drafts.length,made=await create({count:3});let p=await waitProject(made.initial.id,p=>!active(p));
    assert.equal(p.status,'partial');assert.equal(p.pages.filter(page=>page.status==='done').length,2);assert.equal(drafts.length,before);
    const good=p.pages.filter(page=>page.status==='done'),bad=p.pages.find(page=>page.status==='error'),beforeImage=imageCalls;
    p=await chat(p.id,'重试失败的那张图片。',{action:'regenerate',reply:'MOCK 补齐失败页',pageIds:[bad.id]});p=await waitProject(p.id,p=>p.xhsDelivery?.status==='verified');
    assert.equal(imageCalls,beforeImage+1);assert.equal(drafts.length,before+1);for(const page of good)assert.deepEqual(p.pages.find(item=>item.id===page.id),page);
  });

  await t.test('in-flight delivery freezes edits and deletion of the same work',async()=>{
    queryDelay=350;const made=await create({count:1}),p=await waitProject(made.initial.id,p=>delivering(p)&&p.status==='completed','in-flight'),beforeText=textCalls;
    assert.equal((await request(`/api/projects/${p.id}`,{method:'PATCH',body:{title:'MOCK 不应应用'}})).response.status,409);
    assert.equal((await request(`/api/projects/${p.id}`,{method:'DELETE'})).response.status,409);
    assert.equal((await request(`/api/projects/${p.id}/chat`,{method:'POST',body:{requestId:randomUUID(),message:'把帖子标题改成不应应用。'}})).response.status,409);assert.equal(textCalls,beforeText);
    await waitProject(p.id,p=>p.xhsDelivery?.status==='verified');queryDelay=0;
  });

  await t.test('an unexpected service account cannot receive the pending draft', async () => {
    availableAccount=accountB;
    const before=drafts.length;
    const {initial}=await create({count:1});
    const blocked=await waitProject(initial.id,p=>p.xhsDelivery?.status==='blocked');
    assert.equal(blocked.status,'completed');
    assert.equal(blocked.xhsDelivery.accountId,accountA);
    assert.equal(blocked.xhsDelivery.attempted,false);
    assert.equal(drafts.length,before);
    assert.equal((await request(`/api/projects/${blocked.id}/xhs-delivery`,{method:'POST',body:{accountId:accountB}})).response.status,409);
    availableAccount=accountA;
  });

  await t.test('paused delivery preserves the artwork and can be resumed without another model call', async () => {
    paused=true;
    const before=drafts.length;
    const {initial}=await create({count:1});
    const blocked=await waitProject(initial.id,p=>p.xhsDelivery?.status==='blocked');
    assert.equal(blocked.xhsDelivery.attempted,false);
    assert.ok(blocked.pages.every(page=>page.imageUrl));
    assert.equal(drafts.length,before);
    const counts={textCalls,imageCalls};
    paused=false;
    await continueDelivery(blocked.id);
    await waitProject(blocked.id,p=>p.xhsDelivery?.status==='verified');
    assert.deepEqual({textCalls,imageCalls},counts);
    assert.equal(drafts.length,before+1);
  });

  await t.test('invalid or outside-project assets and cross-site requests cannot reach the publisher', async () => {
    const before=publisherRequests.length;
    const source=await legacyProject();
    async function invalidProject(change) {
      const item=await legacyProject();
      await change(item);
      await writeFile(path.join(dir,'projects',item.id,'project.json'),JSON.stringify(item));
      const r=await request('/api/xhs/drafts',{method:'POST',body:{accountId:accountA,projectId:item.id}});
      assert.equal(r.response.status,409,r.raw);
    }
    await invalidProject(item=>{ item.status='partial'; });
    await invalidProject(item=>{ item.pages[0].imageUrl=source.pages[0].imageUrl; });
    await invalidProject(async item=>{
      const file=path.join(dir,'projects',item.id,'images',path.basename(item.pages[0].imageUrl));
      await rm(file);
      await symlink(path.join(dir,'projects',source.id,'project.json'),file);
    });
    const cross=await fetch(base+'/api/xhs/drafts',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},
      body:JSON.stringify({accountId:accountA,projectId:source.id})});
    assert.equal(cross.status,403);
    assert.equal(publisherRequests.length,before);
  });

  await t.test('a restarted workspace can send through the configured service without a manual account operation', async () => {
    const {initial}=await create({count:1,xhsAutoDelivery:false});
    await waitProject(initial.id,p=>!active(p));
    await stop();
    const before={textCalls,imageCalls,drafts:drafts.length};
    await start();
    const result=await request(`/api/projects/${initial.id}/xhs-delivery`,{method:'POST',body:{accountId:accountA,newVersion:true}});
    assert.equal(result.response.status,202,result.raw);
    const delivered=await waitProject(initial.id,p=>p.xhsDelivery?.status==='verified');
    assert.equal(delivered.xhsDelivery.accountId,accountA);
    assert.deepEqual({textCalls,imageCalls},{textCalls:before.textCalls,imageCalls:before.imageCalls});
    assert.equal(drafts.length,before.drafts+1);
  });
  assert.ok(!log.includes(secret));
  assert.ok(!log.includes(publisherToken));
});
