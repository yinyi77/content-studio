import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Isolated end-to-end adapter test. All DingTalk traffic is replaced before the
// server loads; models use an ephemeral localhost provider, never real keys.
const root = fileURLToPath(new URL('..', import.meta.url));
const base = 'http://127.0.0.1:19531';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBuoAAAAASUVORK5CYII=';
const secret = 'dingtalk-http-mock-secret';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(route, { method='GET', body, origin=base }={}) {
  const response=await fetch(base+route,{method,headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const raw=await response.text();let value;try{value=JSON.parse(raw);}catch{}
  return {response,raw,value};
}
async function until(check,label) {
  for(let i=0;i<400;i++){const value=await check();if(value)return value;await sleep(30);}
  assert.fail(`Did not settle: ${label}`);
}

test('DingTalk HTTP settings and real creative pipeline remain isolated, durable and idempotent', {timeout:45_000}, async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'content-dingtalk-http-'));
  const inputFile=path.join(dir,'mock-incoming.json'),outFile=path.join(dir,'mock-outgoing.jsonl'),preload=path.join(dir,'mock-transport.mjs');
  let child,log='',messages=[],briefCalls=0,planCalls=0,chatCalls=0,imageCalls=0;
  let chatOutput={action:'reply',reply:'MOCK 请说明具体修改要求。'};
  const upstream=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    res.setHeader('Content-Type','application/json');
    if(['/v1/images/generations','/v1/images/edits'].includes(req.url)){imageCalls++;return res.end(JSON.stringify({data:[{b64_json:png}]}));}
    if(req.url!=='/v1/chat/completions'){res.statusCode=404;return res.end('{}');}
    try{
      const body=JSON.parse(raw),prompt=JSON.stringify(body.messages),isPlan=prompt.includes('中文图文内容策划与视觉导演');
      let content;
      if(isPlan){planCalls++;content={title:'MOCK 工具宣传',caption:'MOCK 介绍工具的真实使用场景。',pages:[1,2].map(i=>({title:`MOCK 页面${i}`,content:`MOCK 图片文案${i}`,prompt:`MOCK 清晰展示页面${i}`}))};}
      else if(prompt.includes('你是图文工坊的创作策划助手')){
        briefCalls++;const answered=briefCalls>1;
        content={analysis:'MOCK 分析宣传需求。',reply:answered?'MOCK 按补充开始制作。':'MOCK 请一次补充下面信息。',source:'MOCK 宣传一个编程工具，面向开发者，真实卖点是整理工作记录，使用产品参考图。',preferences:{style:null,aspect:null,count:null,mode:null},recommendations:{style:'notion',aspect:'3:4',count:2,mode:'cards'},reasons:{style:'清晰说明工具',aspect:'竖版阅读',count:'两张图展示'},decision:{action:answered?'generate':'ask',questions:answered?[]:[{id:'facts',question:'面向谁，真实卖点是什么？风格、比例和张数有偏好吗？'}]}};
      }else{chatCalls++;content=chatOutput;}
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}]}));
    }catch{res.statusCode=500;res.end('{}');}
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const upstreamOrigin=`http://127.0.0.1:${upstream.address().port}`;
  await writeFile(inputFile,'[]');
  await writeFile(preload,`
    import {readFile,appendFile} from 'node:fs/promises';
    import {DingtalkTransport} from ${JSON.stringify(pathToFileURL(path.join(root,'lib/dingtalk-transport.mjs')).href)};
    const realFetch=globalThis.fetch;
    globalThis.fetch=(url,options)=>{if(new URL(String(url)).origin!==${JSON.stringify(upstreamOrigin)})throw new Error('External request prohibited in test');return realFetch(url,options);};
    const record=value=>appendFile(${JSON.stringify(outFile)},JSON.stringify(value)+'\\n');
    DingtalkTransport.prototype.connect=async function(){
      this.onStatus({state:'connected',message:'MOCK connected'});await record({kind:'connect'});
      let cursor=JSON.parse(await readFile(${JSON.stringify(inputFile)},'utf8')).length,polling=false;
      this.mockTimer=setInterval(async()=>{if(polling)return;polling=true;try{const entries=JSON.parse(await readFile(${JSON.stringify(inputFile)},'utf8'));for(;cursor<entries.length;cursor++)await this.onMessage(entries[cursor]);}finally{polling=false;}},20);
    };
    DingtalkTransport.prototype.disconnect=async function(){clearInterval(this.mockTimer);this.onStatus({state:'disconnected',message:'MOCK disconnected'});};
    DingtalkTransport.prototype.testCredentials=async()=>({ok:true,message:'MOCK credential test'});
    DingtalkTransport.prototype.sendText=async value=>{await record({kind:'text',...value});return {accepted:true};};
    DingtalkTransport.prototype.sendImage=async({userId,openConversationId,name,mime,bytes})=>{await record({kind:'image',userId,openConversationId,name,mime,byteLength:bytes.length});return {accepted:true};};
    DingtalkTransport.prototype.downloadImage=async()=>({name:'product.png',dataUrl:'data:image/png;base64,${png}'});
  `);
  async function start(){
    log='';child=spawn(process.execPath,['--import',preload,'server.mjs'],{cwd:root,env:{...process.env,PORT:'19531',DATA_DIR:dir,TRENDS_AUTO_REFRESH:'0'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',value=>log+=value);child.stderr.on('data',value=>log+=value);
    await until(async()=>{if(child.exitCode!==null)assert.fail(`Server exited: ${log}`);try{return (await request('/api/dingtalk')).response.ok;}catch{return false;}},'server startup');
  }
  async function stop(){if(child?.exitCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;}}
  async function outgoing(){try{return(await readFile(outFile,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return[];throw error;}}
  async function publishIncoming(){await writeFile(inputFile+'.tmp',JSON.stringify(messages));await rename(inputFile+'.tmp',inputFile);}
  async function incoming(text,extra={}){messages.push({msgId:`mock-${messages.length+1}`,senderStaffId:'mock-user',conversationId:'mock-conversation',conversationType:'1',chatbotCorpId:'mock-corp',senderCorpId:'mock-corp',robotCode:'mock-robot',msgtype:'text',text:{content:text},...extra});await publishIncoming();return messages.at(-1);}
  const snapshot=async()=> (await request('/api/dingtalk')).value;
  const idle=async()=>until(async()=>{const state=JSON.parse(await readFile(path.join(dir,'dingtalk-state.json'),'utf8'));return state.inbox.every(e=>!['queued','running'].includes(e.status))?state:false;},'inbox idle');
  t.after(async()=>{await stop();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));await rm(dir,{recursive:true,force:true});});
  await start();let project;

  await t.test('configuration is private, explicit and protected by same-origin checks',async()=>{
    assert.equal((await snapshot()).status.state,'disconnected');assert.equal((await outgoing()).length,0);
    assert.equal((await request('/api/dingtalk/connect',{method:'POST',body:{}})).response.status,400);
    assert.equal((await request('/api/dingtalk/config',{method:'PUT',origin:'https://other.example',body:{}})).response.status,403);
    assert.equal((await request('/api/dingtalk/connect')).response.status,405);
    const saved=await request('/api/dingtalk/config',{method:'PUT',body:{clientId:'mock-app',clientSecret:secret,robotCode:'mock-robot',corpId:'mock-corp',allowedUserIds:['mock-user'],matchTrends:false}});
    assert.equal(saved.response.status,200,saved.raw);assert.equal(saved.value.config.hasSecret,true);assert.ok(!saved.raw.includes(secret));assert.equal(saved.value.readiness.configured,true);
    assert.equal((await stat(path.join(dir,'dingtalk.json'))).mode&0o777,0o600);
    const retained=await request('/api/dingtalk/config',{method:'PUT',body:{clientSecret:''}});assert.equal(retained.value.config.hasSecret,true);
    assert.equal((await request('/api/dingtalk/test',{method:'POST',body:{}})).response.status,200);
    assert.equal((await outgoing()).length,0);assert.equal(briefCalls+planCalls+imageCalls,0);
    const models=await request('/api/config',{method:'PUT',body:{text:{baseUrl:upstreamOrigin+'/v1',apiKey:'mock-model-key',model:'mock-text'},image:{baseUrl:upstreamOrigin+'/v1',apiKey:'mock-model-key',model:'mock-image',mode:'images',size:'auto'}}});
    assert.equal(models.response.status,200,models.raw);
    assert.equal((await request('/api/dingtalk/connect',{method:'POST',body:{}})).value.status.state,'connected');
  });
  await t.test('only the configured enterprise, bot and single-chat users can invoke models',async()=>{
    await incoming('ignored',{senderStaffId:'other-user'});await incoming('ignored',{conversationType:'2'});await incoming('ignored',{chatbotCorpId:'other-corp'});await incoming('ignored',{robotCode:'other-bot'});
    await sleep(150);assert.equal((await snapshot()).sessions.length,0);assert.equal(briefCalls+planCalls+imageCalls,0);
  });
  await t.test('a greeting replies locally and does not consume the one clarification round or call models',async()=>{
    await incoming('你好');await until(async()=>(await outgoing()).some(m=>m.kind==='text'&&m.text.includes('创作')),'local greeting');await idle();
    assert.equal(briefCalls+planCalls+chatCalls+imageCalls,0);
    const session=(await snapshot()).sessions[0];assert.equal(session.projectId,null);assert.equal(session.lastError,'');
    assert.match((await snapshot()).deliveries[0].message,/文字消息/);
    const state=JSON.parse(await readFile(path.join(dir,'dingtalk-state.json'),'utf8'));assert.equal(state.sessions[0].clarificationAsked,false);
    assert.ok(!['error','interrupted'].includes(session.stage));
  });
  await t.test('one clarification and a product image lead to one complete local project and image delivery',async()=>{
    await incoming('帮我宣传一个编程小工具。');await until(async()=>briefCalls===1&&(await outgoing()).some(m=>m.kind==='text'&&m.text.includes('请一次补充')),'batched questions');await idle();
    await incoming('',{msgtype:'picture',content:{downloadCode:'mock-download-code'}});await until(async()=>(await snapshot()).sessions[0]?.referenceCount===1,'product image');await idle();
    assert.equal(planCalls+imageCalls,0,'picture alone must not charge for images');
    const answer=await incoming('面向开发者，卖点是整理工作记录。风格你定，3:4竖版2张，结合刚才的产品图直接生成。');
    await until(async()=>(await outgoing()).filter(m=>m.kind==='image').length===2,'result images');await idle();
    const state=await snapshot();project=(await request(`/api/projects/${state.sessions[0].projectId}`)).value.project;
    assert.equal(project.status,'completed');assert.equal(project.origin,'dingtalk');assert.equal(project.xhsAutoDelivery,false);assert.equal(project.referenceIds.length,1);assert.equal(briefCalls,2);assert.equal(planCalls,1);assert.equal(imageCalls,2);
    assert.ok((await outgoing()).some(m=>m.kind==='text'&&m.text.includes('MOCK 工具宣传')&&m.text.includes('真实使用场景')));
    const before={briefCalls,planCalls,imageCalls,out:(await outgoing()).length};messages.push(answer);await publishIncoming();await sleep(150);
    assert.deepEqual({briefCalls,planCalls,imageCalls,out:(await outgoing()).length},before,'redelivered msgId must not pay or deliver twice');
    assert.equal((await request('/api/xhs')).value.connection.state,'disconnected');
  });
  await t.test('follow-up copy edits reuse the project without redrawing or resending old pictures',async()=>{
    const oldPages=structuredClone(project.pages),before=imageCalls,oldDeliveries=(await outgoing()).filter(m=>m.kind==='image').length;
    chatOutput={action:'update_post',reply:'MOCK 已调整文案。',title:'MOCK 新标题',caption:'MOCK 新的简洁正文。'};
    await incoming('把帖子标题改成新标题，正文更简洁，图片不动。');
    await until(async()=>{const p=(await request(`/api/projects/${project.id}`)).value.project;return p.title==='MOCK 新标题'&&p.chatStatus!=='thinking';},'copy update');await idle();
    const latest=(await request(`/api/projects/${project.id}`)).value.project;
    assert.equal(chatCalls,1);assert.equal(imageCalls,before);assert.deepEqual(latest.pages,oldPages);
    assert.equal((await outgoing()).filter(m=>m.kind==='image').length,oldDeliveries);
    assert.ok((await outgoing()).some(m=>m.kind==='text'&&m.text.includes('MOCK 新标题')));
  });
  const group={conversationType:'2',conversationId:'cidMOCK_GROUP_A==',conversationTitle:'MOCK 创作协作群',isInAtList:true};
  let groupProject;
  await t.test('opted-in group requests reply only to the originating group and create a separate work',async()=>{
    const configured=await request('/api/dingtalk/config',{method:'PUT',body:{groupEnabled:true}});assert.equal(configured.response.status,200,configured.raw);assert.equal(configured.value.config.groupEnabled,true);
    assert.equal((await request('/api/dingtalk/connect',{method:'POST',body:{}})).value.status.state,'connected');
    const before={briefCalls,planCalls,imageCalls,out:(await outgoing()).length};
    await incoming('群里普通消息不应触发生成',{...group,isInAtList:false});await incoming('拒绝未授权成员',{...group,senderStaffId:'mock-not-allowed'});await sleep(120);
    assert.deepEqual({briefCalls,planCalls,imageCalls,out:(await outgoing()).length},before);
    await incoming('你好',group);await until(async()=>(await outgoing()).some(m=>m.kind==='text'&&m.openConversationId===group.conversationId),'group greeting');await idle();
    assert.equal(briefCalls,before.briefCalls);assert.equal(imageCalls,before.imageCalls);
    await incoming('直接做一组面向开发者的工具宣传图，3:4竖版2张，风格你定，真实卖点是整理工作记录。',group);
    await until(async()=>(await outgoing()).filter(m=>m.kind==='image'&&m.openConversationId===group.conversationId).length===2,'group images');await idle();
    const grouped=(await snapshot()).sessions.find(s=>s.conversationType==='2');assert.ok(grouped);assert.equal(grouped.conversationTitle,group.conversationTitle);assert.notEqual(grouped.projectId,project.id);
    groupProject=(await request(`/api/projects/${grouped.projectId}`)).value.project;assert.equal(groupProject.status,'completed');
    assert.equal((await outgoing()).filter(m=>m.kind==='image'&&!m.openConversationId).length,2,'no group output may fall back to direct chat');
    const stored=JSON.parse(await readFile(path.join(dir,'dingtalk-state.json'),'utf8'));const receipt=stored.deliveries.find(d=>d.projectId===groupProject.id);assert.equal(receipt.conversationType,'2');assert.equal(receipt.openConversationId,group.conversationId);
  });
  await t.test('group follow-ups preserve private conversation context and disabling groups stops new group requests',async()=>{
    chatOutput={action:'update_post',reply:'MOCK 群作品文案已改。',title:'MOCK 群新标题',caption:'MOCK 群里的新版正文。'};
    const before=imageCalls;
    await incoming('帖子标题改成群新标题，图片不动。',group);await until(async()=>{const p=(await request(`/api/projects/${groupProject.id}`)).value.project;return p.title==='MOCK 群新标题'&&p.chatStatus!=='thinking';},'group copy update');await idle();
    assert.equal(imageCalls,before);assert.equal((await request(`/api/projects/${project.id}`)).value.project.title,'MOCK 新标题');
    assert.ok((await outgoing()).some(m=>m.kind==='text'&&m.openConversationId===group.conversationId&&m.text.includes('MOCK 群新标题')));
    await request('/api/dingtalk/config',{method:'PUT',body:{groupEnabled:false}});await request('/api/dingtalk/connect',{method:'POST',body:{}});
    const unchanged={briefCalls,planCalls,chatCalls,imageCalls,out:(await outgoing()).length};await incoming('关闭后不处理这条',group);await sleep(120);
    assert.deepEqual({briefCalls,planCalls,chatCalls,imageCalls,out:(await outgoing()).length},unchanged);
  });
  await t.test('restart retains configuration and works but never reconnects or replays paid work',async()=>{
    const before={briefCalls,planCalls,chatCalls,imageCalls,out:(await outgoing()).length};await stop();await start();await sleep(150);
    const state=await snapshot();assert.equal(state.status.state,'disconnected');assert.equal(state.config.hasSecret,true);assert.ok(state.sessions.some(session=>session.projectId===project.id));
    assert.deepEqual({briefCalls,planCalls,chatCalls,imageCalls,out:(await outgoing()).length},before);
    assert.ok(!JSON.stringify(state).includes(secret));assert.ok(!log.includes(secret));
    assert.equal((await request(`/api/projects/${project.id}`)).value.project.title,'MOCK 新标题');
  });
});
