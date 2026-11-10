import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DingtalkService } from '../lib/dingtalk.mjs';

// No real credentials, network, SDK connections, model calls or messages.
const SECRET='MOCK_DING_PRIVATE_SECRET';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWQAAAAASUVORK5CYII=','base64');
const DATA=`data:image/png;base64,${PNG.toString('base64')}`;
const config=()=>({clientId:'MOCK_APP',clientSecret:SECRET,robotCode:'MOCK_ROBOT',corpId:'MOCK_CORP',allowedUserIds:['MOCK_USER'],matchTrends:true});
const spec={mode:'cards',style:'notion',aspect:'3:4',count:2};
const generate=()=>({reply:'现在开始制作',source:'MOCK 已确认的产品资料',preferences:spec,recommendations:spec,decision:{action:'generate',questions:[],resolvedSpec:spec}});
const message=(id,text='做一组宣传图',extra={})=>({msgId:id,senderStaffId:'MOCK_USER',chatbotCorpId:'MOCK_CORP',senderCorpId:'MOCK_CORP',robotCode:'MOCK_ROBOT',conversationId:'MOCK_SINGLE_CONVERSATION',conversationType:'1',msgtype:'text',text:{content:text},...extra});
const groupMessage=(id,text='做一组群内宣传图',extra={})=>message(id,text,{conversationType:'2',conversationId:'cidMOCK_GROUP_A==',conversationTitle:'MOCK 项目群 A',isInAtList:true,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const definite=()=>Object.assign(new Error('MOCK 明确未受理'),{definiteFailure:true});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await tick();}assert.fail('Mock operation did not start');}
async function settle(service){await Promise.all([...service.tails.values()]);await Promise.all([...service.attachments.values()]);await service.writeTail;}

async function fixture(t,overrides={}){
  const dir=overrides.dir||await mkdtemp(path.join(os.tmpdir(),'content-ding-unit-'));
  const calls={factory:0,connect:0,disconnect:0,test:0,analyze:[],create:[],chat:[],get:[],reference:[],download:[],text:[],image:[]};
  const projects=new Map();let options;
  const transport={
    async connect(){calls.connect++;options.onStatus({state:'connected',message:'MOCK 已连接'});},
    async disconnect(){calls.disconnect++;},
    async testCredentials(){calls.test++;return{ok:true,message:'MOCK 凭证有效'};},
    async downloadImage(input){calls.download.push(input);return overrides.download?overrides.download(input):{name:'MOCK_PRODUCT.png',dataUrl:DATA};},
    async sendText(input){calls.text.push(input);if(overrides.sendText)await overrides.sendText(input);return{accepted:true,processQueryKey:'MOCK_QUERY'};},
    async sendImage(input){calls.image.push(input);if(overrides.sendImage)await overrides.sendImage(input);return{accepted:true,processQueryKey:'MOCK_QUERY'};},
  };
  const callbacks={
    async analyzeBrief(input){calls.analyze.push(structuredClone(input));return overrides.analyze?overrides.analyze(input):generate();},
    async createProject(input){calls.create.push(structuredClone(input));if(overrides.create)return overrides.create(input,projects);const p={id:randomUUID(),title:'MOCK 产品标题',caption:'MOCK PRIVATE_POST_BODY',status:'completed',chatStatus:'idle',pages:[{id:'PAGE_A',status:'done',imageUrl:'MOCK_IMAGE_A'},{id:'PAGE_B',status:'done',imageUrl:'MOCK_IMAGE_B'}],chatRequests:[]};projects.set(p.id,p);return structuredClone(p);},
    async chatProject(input){calls.chat.push(structuredClone(input));if(overrides.chat)return overrides.chat(input,projects);const p=projects.get(input.projectId);p.caption='MOCK 修改后的文案';p.chatRequests.push({requestId:input.requestId,status:'completed',action:'update_post',reply:'MOCK 文案已更新',pageIds:[]});return structuredClone(p);},
    async getProject(id){calls.get.push(id);return overrides.get?overrides.get(id,projects):structuredClone(projects.get(id)||null);},
    async saveReference(input){calls.reference.push(input);return{id:`REF_${calls.reference.length}`};},
    async getProjectImages(project){return project.pages.filter(p=>p.status==='done').map((p,i)=>({bytes:PNG,name:`${i+1}.png`,mime:'image/png',pageId:p.id}));},
  };
  const service=new DingtalkService({dir,...callbacks,transportFactory:async input=>{calls.factory++;options=input;return transport;},...(overrides.service||{})});
  await service.init();
  t.after(async()=>{await service.close();if(!overrides.keep)await rm(dir,{recursive:true,force:true});});
  return{service,dir,calls,projects,transport,get options(){return options;},async start(extra={}){await service.updateConfig({...config(),...extra});await service.connect();}};
}

test('startup and configuration are inert; secret and private content never appear in the snapshot',async t=>{
  const f=await fixture(t);assert.equal(f.calls.factory,0);assert.equal(f.service.snapshot().readiness.configured,false);
  await f.service.updateConfig(config());assert.equal(f.calls.factory,0);assert.equal(f.calls.connect,0);
  const snapshot=f.service.snapshot();assert.equal(snapshot.config.hasSecret,true);assert.equal(snapshot.readiness.configured,true);assert.doesNotMatch(JSON.stringify(snapshot),new RegExp(SECRET));
  assert.equal((await stat(path.join(f.dir,'dingtalk.json'))).mode&0o777,0o600);
  assert.equal((await stat(path.join(f.dir,'dingtalk-state.json'))).mode&0o777,0o600);
  const tested=await f.service.testCredentials();assert.equal(tested.ok,true);assert.equal(tested.status.busy,false);assert.equal(f.calls.test,1);assert.equal(f.calls.connect,0);assert.equal(f.calls.text.length,0);assert.equal(f.calls.analyze.length,0);
});

test('configuration validates identifiers, preserves a blank secret, disconnects before changing access',async t=>{
  const f=await fixture(t);await f.start();
  await assert.rejects(f.service.updateConfig({clientId:'changed'}),/重新填写/);
  await assert.rejects(f.service.updateConfig({allowedUserIds:['bad value']}),/格式不正确/);
  await assert.rejects(f.service.updateConfig({matchTrends:'yes'}),/格式不正确/);
  await f.service.updateConfig({clientSecret:'',allowedUserIds:'MOCK_USER,MOCK_SECOND'});
  assert.equal(f.calls.disconnect,1);assert.equal(f.service.config.clientSecret,SECRET);assert.equal(f.service.snapshot().status.state,'disconnected');
  assert.deepEqual(f.service.config.allowedUserIds,['MOCK_USER','MOCK_SECOND']);
  await f.service.updateConfig({clearSecret:true});assert.equal(f.service.snapshot().config.hasSecret,false);await assert.rejects(f.service.connect(),/完整/);
});

test('a failed initial Stream connection disposes its SDK and ignores a late connected callback',async t=>{
  const f=await fixture(t);await f.service.updateConfig(config());f.transport.connect=async()=>{throw new Error('MOCK Stream connect failed');};
  const result=await f.service.connect();assert.equal(result.status.state,'error');assert.equal(result.status.busy,false);assert.equal(f.calls.disconnect,1);assert.equal(f.service.transport,null);assert.equal(f.service.accepting,false);
  f.options.onStatus({state:'connected',message:'MOCK late reconnection'});assert.equal(f.service.snapshot().status.state,'error');assert.deepEqual(await f.options.onMessage(message('LATE')),{accepted:false});assert.equal(f.service.data.inbox.length,0);
});

test('foreign enterprises, robots, groups and unlisted users are dropped before persistence or model work',async t=>{
  const f=await fixture(t);await f.start();
  for(const extra of [{chatbotCorpId:'FOREIGN'},{senderCorpId:'FOREIGN'},{robotCode:'OTHER'},{conversationType:'2'},{senderStaffId:'OTHER_USER'},{msgId:''}])assert.deepEqual(await f.service.receive(message('DENIED','PRIVATE_TEXT',extra)),{accepted:false});
  await settle(f.service);assert.equal(f.calls.analyze.length,0);assert.equal(f.service.data.inbox.length,0);assert.equal(f.calls.text.length,0);
});

test('simultaneous duplicate callbacks are durably ACKed once without waiting for analysis',async t=>{
  const gate=deferred();const f=await fixture(t,{analyze:async()=>{await gate.promise;return generate();}});await f.start();
  const responses=await Promise.all([f.service.receive(message('SAME')),f.service.receive(message('SAME'))]);
  assert.equal(responses.filter(x=>x.duplicate===false).length,1);assert.equal(responses.filter(x=>x.duplicate===true).length,1);
  const stored=JSON.parse(await readFile(path.join(f.dir,'dingtalk-state.json'),'utf8'));assert.equal(stored.inbox.length,1);assert.ok(['queued','running'].includes(stored.inbox[0].status));
  await until(()=>f.calls.analyze.length===1);assert.equal(f.calls.create.length,0);gate.resolve();await settle(f.service);
  assert.equal(f.calls.create.length,1);assert.equal(f.calls.image.length,2);assert.equal(f.calls.create[0].xhsAutoDelivery,false);assert.equal(f.calls.create[0].origin,'dingtalk');
  assert.doesNotMatch(JSON.stringify(f.service.snapshot()),/PRIVATE_POST_BODY|MOCK 已确认的产品资料|downloadCode|dingtalk-outbox/);
  assert.equal((await f.service.receive(message('SAME'))).duplicate,true);await settle(f.service);assert.equal(f.calls.create.length,1);
});

test('one consolidated clarification is remembered and answered into an automatic full creation',async t=>{
  let n=0;const f=await fixture(t,{analyze:async()=>++n===1?{reply:'一次补充这些信息即可',source:'MOCK 产品',preferences:{style:null,count:null,aspect:null,mode:null},decision:{action:'ask',questions:[{id:'audience',question:'面向谁？'},{id:'format',question:'风格、比例和张数？'}]}}:generate()});await f.start();
  await f.service.receive(message('ASK','宣传一个 coding 工具'));await settle(f.service);assert.equal(f.calls.create.length,0);assert.match(f.calls.text.at(-1).text,/1\. 面向谁？\n2\. 风格、比例和张数？/);
  await f.service.receive(message('ANSWER','开发者，专业风，3:4，两张'));await settle(f.service);
  assert.equal(f.calls.analyze[1].clarificationAsked,true);assert.equal(f.calls.analyze[1].messages.length,3);assert.equal(f.calls.create.length,1);assert.equal(f.service.data.sessions[0].source,'MOCK 已确认的产品资料');
});

test('image-only messages save product references without triggering a model; later text uses them',async t=>{
  const f=await fixture(t);await f.start();await f.service.receive(message('IMAGE','',{msgtype:'picture',content:{downloadCode:'MOCK_TEMP_CODE'}}));await settle(f.service);
  assert.equal(f.calls.download.length,1);assert.equal(f.calls.reference.length,1);assert.equal(f.calls.analyze.length,0);assert.equal(f.calls.create.length,0);assert.match(f.calls.text.at(-1).text,/不会单独触发/);
  await f.service.receive(message('TEXT','就结合这个产品图做两张宣传'));await settle(f.service);
  assert.deepEqual(f.calls.analyze[0].referenceIds,['REF_1']);assert.deepEqual(f.calls.create[0].referenceIds,['REF_1']);assert.equal(f.service.data.sessions[0].referenceIds.length,0);
});

test('temporary images download immediately even when the same user has a model task running',async t=>{
  const gate=deferred();const f=await fixture(t,{analyze:async()=>{await gate.promise;return generate();}});await f.start();
  await f.service.receive(message('BLOCK'));await until(()=>f.calls.analyze.length===1);
  await f.service.receive(message('QUICK_IMAGE','',{msgtype:'picture',content:{downloadCode:'MOCK_EXPIRING_CODE'}}));await until(()=>f.calls.reference.length===1);
  assert.equal(f.calls.create.length,0);gate.resolve();await settle(f.service);assert.equal(f.calls.create.length,1);assert.equal(f.service.data.sessions[0].referenceIds.length,1);
});

test('rich text preserves text and references, while oversized or unsupported attachments never trigger creation',async t=>{
  const f=await fixture(t);await f.start();
  await f.service.receive(message('RICH','',{msgtype:'richText',content:{richText:[{type:'text',text:'MOCK 产品宣传'},{type:'picture',downloadCode:'MOCK_CODE'}]}}));await settle(f.service);
  assert.equal(f.calls.create.length,1);assert.deepEqual(f.calls.create[0].referenceIds,['REF_1']);
  await f.service.receive(message('BAD','',{msgtype:'richText',content:{richText:Array.from({length:5},(_,i)=>({type:'picture',downloadCode:`CODE_${i}`}))}}));await settle(f.service);
  assert.equal(f.calls.chat.length,0);assert.equal(f.calls.download.length,1);
  await f.service.receive(message('AUDIO','',{msgtype:'audio',content:{}}));await settle(f.service);assert.equal(f.calls.chat.length,0);
});

test('an invalid or over-8MB downloaded product image is rejected without silent reference loss',async t=>{
  const f=await fixture(t,{download:async()=>({name:'oversized.png',dataUrl:`data:image/png;base64,${Buffer.alloc(8*1024*1024+1).toString('base64')}`})});await f.start();
  await f.service.receive(message('TOO_BIG','',{msgtype:'richText',content:{richText:[{type:'text',text:'结合这张图宣传'},{type:'picture',downloadCode:'MOCK_CODE'}]}}));await settle(f.service);
  assert.equal(f.calls.reference.length,0);assert.equal(f.calls.analyze.length,0);assert.equal(f.calls.create.length,0);assert.match(f.calls.text.at(-1).text,/8MB/);
});

test('text modifications stay on the same project and do not resend old pictures',async t=>{
  const f=await fixture(t);await f.start();await f.service.receive(message('CREATE'));await settle(f.service);const projectId=f.service.data.sessions[0].projectId;
  await f.service.receive(message('EDIT','标题改得专业一点'));await settle(f.service);
  assert.equal(f.calls.create.length,1);assert.equal(f.calls.chat.length,1);assert.equal(f.calls.chat[0].projectId,projectId);assert.equal(f.calls.image.length,2);assert.match(f.calls.text.at(-1).text,/MOCK 修改后的文案/);
  await f.service.receive(message('NEW','新建创作'));await settle(f.service);assert.equal(f.service.data.sessions[0].projectId,null);assert.equal(f.projects.size,1);
});

test('a conversational reply does not pretend to revise or resend existing images',async t=>{
  const f=await fixture(t,{chat:async(input,projects)=>{const p=projects.get(input.projectId);p.chatRequests.push({requestId:input.requestId,status:'completed',action:'reply',reply:'MOCK 这是建议，尚未改图'});return p;}});await f.start();
  await f.service.receive(message('CREATE'));await settle(f.service);await f.service.receive(message('ADVICE','先说说可以怎么优化'));await settle(f.service);
  assert.equal(f.calls.image.length,2);assert.match(f.calls.text.at(-1).text,/^本次仅回复，尚未修改图文。/);assert.match(f.calls.text.at(-1).text,/MOCK 这是建议，尚未改图/);
});

test('a separately sent replacement picture reaches the next modification, and only changed pages return',async t=>{
  const f=await fixture(t,{chat:async(input,projects)=>{const p=projects.get(input.projectId);p.pages[1].imageUrl='MOCK_UPDATED';p.chatRequests.push({requestId:input.requestId,status:'completed',action:'revise_pages',reply:'第二张已更新',pageIds:['PAGE_B']});return p;}});await f.start();
  await f.service.receive(message('CREATE'));await settle(f.service);await f.service.receive(message('REF','',{msgtype:'picture',content:{downloadCode:'MOCK_NEW_PRODUCT'}}));await settle(f.service);
  await f.service.receive(message('EDIT','把第二张换成这个产品'));await settle(f.service);
  assert.deepEqual(f.calls.chat[0].referenceIds,['REF_1']);assert.equal(f.calls.image.length,3);assert.equal(f.calls.image.at(-1).name,'2.png');
});

test('the result waits for image and chat finalization, including a busy-to-idle transition',async t=>{
  let reads=0;const f=await fixture(t,{get:async(id,projects)=>{const p=structuredClone(projects.get(id));if(++reads<3)p.chatStatus='thinking';return p;},service:{wait:async()=>{}}});await f.start();
  await f.service.receive(message('WAIT'));await settle(f.service);assert.equal(reads,3);assert.equal(f.calls.image.length,2);assert.equal(f.service.data.sessions[0].stage,'completed');
});

test('a definite image rejection can be manually retried from frozen bytes without model work or accepted-text duplication',async t=>{
  let failures=1;const f=await fixture(t,{sendImage:async()=>{if(failures-->0)throw definite();}});await f.start();await f.service.receive(message('CREATE'));await settle(f.service);
  const delivery=f.service.data.deliveries.find(d=>d.projectId);assert.equal(delivery.status,'failed');assert.equal(delivery.texts[0].status,'accepted');assert.equal(f.calls.image.length,1);const textCount=f.calls.text.length;
  await f.service.retryDelivery(delivery.id);assert.equal(delivery.status,'accepted');assert.equal(f.calls.image.length,3);assert.equal(f.calls.text.length,textCount);assert.equal(f.calls.create.length,1);assert.equal(f.calls.analyze.length,1);
  assert.equal((await stat(path.join(f.dir,'dingtalk-outbox',delivery.id,delivery.images[0].file))).mode&0o777,0o600);
});

test('an uncertain image submission is never automatically or manually resent',async t=>{
  const f=await fixture(t,{sendImage:async()=>{throw new Error('MOCK timeout after submit');}});await f.start();await f.service.receive(message('UNKNOWN'));await settle(f.service);
  const delivery=f.service.data.deliveries.find(d=>d.projectId);assert.equal(delivery.status,'unknown');assert.equal(f.calls.image.length,1);await assert.rejects(f.service.retryDelivery(delivery.id),e=>e.status===409);assert.equal(f.calls.image.length,1);
  await f.service.receive(message('DUPLICATE_COMMAND','补发结果'));await settle(f.service);assert.equal(f.calls.image.length,1);assert.equal(f.calls.create.length,1);
});

test('over-8MB results are explicitly reported as partial delivery and never enter a futile retry loop',async t=>{
  const f=await fixture(t,{service:{getProjectImages:async()=>[{bytes:Buffer.alloc(8*1024*1024+1),name:'01.png',mime:'image/png',pageId:'PAGE_A'},{bytes:PNG,name:'02.png',mime:'image/png',pageId:'PAGE_B'}]}});await f.start();await f.service.receive(message('LARGE_RESULT'));await settle(f.service);
  const delivery=f.service.data.deliveries.find(d=>d.projectId);assert.equal(delivery.status,'partial');assert.equal(delivery.images[0].status,'blocked');assert.equal(delivery.images[1].status,'accepted');assert.equal(f.calls.image.length,1);assert.equal(f.calls.image[0].name,'02.png');assert.match(f.calls.text.at(-1).text,/01\.png：超过钉钉回传的8MB限制/);assert.match(delivery.message,/1张图片/);
  assert.equal(f.service.snapshot().deliveries.find(d=>d.id===delivery.id).canRetry,false);await assert.rejects(f.service.retryDelivery(delivery.id),e=>e.status===409);assert.equal(f.calls.create.length,1);
});

test('restarting preserves message dedupe, does not connect, and does not repeat a completed result',async t=>{
  const f=await fixture(t,{keep:true});await f.start();await f.service.receive(message('PERSISTED'));await settle(f.service);await f.service.close();
  const g=await fixture(t,{dir:f.dir});assert.equal(g.calls.factory,0);assert.equal(g.calls.analyze.length,0);await g.service.connect();
  assert.equal((await g.service.receive(message('PERSISTED'))).duplicate,true);await settle(g.service);assert.equal(g.calls.create.length,0);assert.equal(g.calls.text.length,0);
});

test('interrupted work is not replayed on init; explicit recovery reuses its original request ID',async t=>{
  let rejectCreate=true;const f=await fixture(t,{keep:true,create:async(input,projects)=>{if(rejectCreate)throw new Error('MOCK busy');const p={id:randomUUID(),title:'MOCK 恢复结果',caption:'MOCK 文案',status:'completed',chatStatus:'idle',pages:[]};projects.set(p.id,p);return p;}});await f.start();
  await f.service.receive(message('ORIGINAL'));await settle(f.service);const original=f.calls.create[0].requestId;await f.service.close();
  const state=JSON.parse(await readFile(path.join(f.dir,'dingtalk-state.json'),'utf8'));state.inbox[0].status='running';await writeFile(path.join(f.dir,'dingtalk-state.json'),JSON.stringify(state));
  const g=await fixture(t,{dir:f.dir});assert.equal(g.service.data.inbox[0].status,'interrupted');assert.equal(g.calls.create.length,0);assert.equal(g.calls.connect,0);await g.service.connect();
  await g.service.receive(message('RESUME','继续上次任务'));await settle(g.service);assert.equal(g.calls.create.length,1);assert.equal(g.calls.create[0].requestId,original);assert.equal(g.calls.analyze.length,0);
});

test('a saved result receipt survives a crash and recovery never creates a fresh delivery or model task',async t=>{
  const f=await fixture(t,{keep:true});await f.start();await f.service.receive(message('ORIGINAL'));await settle(f.service);await f.service.close();
  const state=JSON.parse(await readFile(path.join(f.dir,'dingtalk-state.json'),'utf8'));state.inbox[0].status='running';await writeFile(path.join(f.dir,'dingtalk-state.json'),JSON.stringify(state));
  const g=await fixture(t,{dir:f.dir});await g.service.connect();await g.service.receive(message('RESUME','继续上次任务'));await settle(g.service);
  assert.equal(g.calls.create.length,0);assert.equal(g.calls.analyze.length,0);assert.equal(g.calls.image.length,0);assert.equal(g.calls.text.length,0);assert.equal(g.service.data.deliveries.length,state.deliveries.length);
});

test('a crash during transmission marks unknown receipts and never enables their retry',async t=>{
  const f=await fixture(t,{keep:true});await f.start();await f.service.receive(message('ORIGINAL'));await settle(f.service);await f.service.close();
  const state=JSON.parse(await readFile(path.join(f.dir,'dingtalk-state.json'),'utf8'));const d=state.deliveries.find(d=>d.projectId);d.status='sending';d.images[0].status='sending';await writeFile(path.join(f.dir,'dingtalk-state.json'),JSON.stringify(state));
  const g=await fixture(t,{dir:f.dir});assert.equal(g.service.data.deliveries.find(d=>d.projectId).status,'unknown');assert.equal(g.service.snapshot().deliveries.find(d=>d.projectId).canRetry,false);assert.equal(g.calls.factory,0);
});

test('disconnecting after acceptance prevents queued messages and late analysis results from launching models',async t=>{
  const gate=deferred();const f=await fixture(t,{analyze:async()=>{await gate.promise;return generate();}});await f.start();
  await f.service.receive(message('FIRST'));await until(()=>f.calls.analyze.length===1);await f.service.receive(message('SECOND'));await f.service.disconnect();await f.service.connect();gate.resolve();await settle(f.service);
  assert.equal(f.calls.analyze.length,1);assert.equal(f.calls.create.length,0);assert.equal(f.service.data.inbox[1].status,'interrupted');
});

test('corrupt local history blocks connection without replacing the existing dedupe file',async t=>{
  const f=await fixture(t,{keep:true});await f.service.updateConfig(config());await f.service.close();await writeFile(path.join(f.dir,'dingtalk-state.json'),'MOCK_CORRUPT');
  const g=await fixture(t,{dir:f.dir});assert.equal(g.service.snapshot().status.state,'error');assert.equal(g.service.snapshot().readiness.configured,false);await assert.rejects(g.service.connect(),e=>e.status===409);await assert.rejects(g.service.updateConfig(config()),e=>e.status===409);
  assert.equal(await readFile(path.join(f.dir,'dingtalk-state.json'),'utf8'),'MOCK_CORRUPT');assert.equal(g.calls.factory,0);
});

test('DingTalk text chunks remain below the transport byte limit for emoji-heavy long posts',async t=>{
  const f=await fixture(t,{create:async(input,projects)=>{const p={id:randomUUID(),title:'MOCK 长文',caption:'🦊'.repeat(7000),status:'completed',chatStatus:'idle',pages:[]};projects.set(p.id,p);return p;}});await f.start();await f.service.receive(message('LONG'));await settle(f.service);
  assert.ok(f.calls.text.length>3);for(const sent of f.calls.text)assert.ok(Buffer.byteLength(sent.text)<18*1024);
});

test('group mentions are opt-in and apply the same enterprise, robot and member boundaries before any work',async t=>{
  const f=await fixture(t);await f.start();assert.equal(f.service.config.groupEnabled,false);
  assert.deepEqual(await f.service.receive(groupMessage('DISABLED')),{accepted:false});
  await assert.rejects(f.service.updateConfig({groupEnabled:'true'}),/群聊开关/);
  await f.service.updateConfig({groupEnabled:true});await f.service.connect();
  const denied=[{isInAtList:false},{isInAtList:undefined},{isInAtList:'true'},{chatbotCorpId:'FOREIGN'},{senderCorpId:'FOREIGN'},{robotCode:'OTHER'},{senderStaffId:'OTHER_USER'},{conversationType:'3'},{conversationId:''},{conversationId:'cid invalid'},{conversationId:'cid\ninvalid'},{conversationId:'x'.repeat(513)},{openConversationId:'cidOTHER_GROUP=='}];
  for(const [i,extra]of denied.entries())assert.deepEqual(await f.service.receive(groupMessage(`DENIED_${i}`,'PRIVATE_GROUP_INPUT',extra)),{accepted:false});
  assert.equal(f.service.data.inbox.length,0);assert.equal(f.calls.analyze.length,0);assert.equal(f.calls.download.length,0);assert.equal(f.calls.text.length,0);
  const accepted=await f.service.receive(groupMessage('ACCEPTED'));assert.equal(accepted.accepted,true);await settle(f.service);
  assert.equal(f.calls.create.length,1);assert.equal(f.calls.image.length,2);
});

test('group results and pictures are addressed only to the original group, and snapshots identify channel and member',async t=>{
  const f=await fixture(t);await f.start({groupEnabled:true});const incoming=groupMessage('ORIGINAL');
  await f.service.receive(incoming);await settle(f.service);
  for(const sent of [...f.calls.text,...f.calls.image]){assert.equal(sent.openConversationId,incoming.conversationId);assert.equal(sent.userId,undefined);}
  const session=f.service.data.sessions[0],entry=f.service.data.inbox[0],delivery=f.service.data.deliveries.find(d=>d.projectId);
  for(const record of [session,entry,delivery]){assert.equal(record.conversationType,'2');assert.equal(record.conversationId,incoming.conversationId);assert.equal(record.openConversationId,incoming.conversationId);assert.equal(record.conversationTitle,'MOCK 项目群 A');}
  const snapshot=f.service.snapshot();assert.equal(snapshot.sessions[0].conversationType,'2');assert.equal(snapshot.sessions[0].conversationTitle,incoming.conversationTitle);assert.equal(snapshot.deliveries[0].conversationType,'2');assert.equal(snapshot.deliveries[0].userId,'MOCK_USER');
  assert.doesNotMatch(JSON.stringify(snapshot),/cidMOCK|PRIVATE_POST_BODY|downloadCode|MOCK_DING_PRIVATE_SECRET/);
  const before={analyze:f.calls.analyze.length,create:f.calls.create.length,text:f.calls.text.length,image:f.calls.image.length};
  assert.equal((await f.service.receive(incoming)).duplicate,true);await settle(f.service);
  assert.deepEqual({analyze:f.calls.analyze.length,create:f.calls.create.length,text:f.calls.text.length,image:f.calls.image.length},before);
});

test('private chats, different groups and different members in the same group keep independent works and edits',async t=>{
  const f=await fixture(t);await f.start({groupEnabled:true,allowedUserIds:['MOCK_USER','MOCK_SECOND']});
  const inputs=[message('PRIVATE','MOCK 私聊主题',{conversationId:'cidMOCK_GROUP_A=='}),groupMessage('GROUP_A','MOCK 群 A 的第一位成员主题'),groupMessage('GROUP_B','MOCK 群 B 的主题',{conversationId:'cidMOCK_GROUP_B==',conversationTitle:'MOCK 项目群 B'}),groupMessage('SECOND_MEMBER','MOCK 群 A 第二位成员主题',{senderStaffId:'MOCK_SECOND'})];
  for(const input of inputs){await f.service.receive(input);await settle(f.service);}
  assert.equal(f.calls.create.length,4);assert.equal(f.service.data.sessions.length,4);assert.equal(new Set(f.service.data.sessions.map(s=>s.projectId)).size,4);
  for(const analysis of f.calls.analyze){assert.equal(analysis.messages.length,1);assert.deepEqual(analysis.referenceIds,[]);}
  const groupA=f.service.data.sessions.find(s=>s.conversationType==='2'&&s.conversationId==='cidMOCK_GROUP_A=='&&s.userId==='MOCK_USER');
  const unrelated=new Map(f.service.data.sessions.filter(s=>s.id!==groupA.id).map(s=>[s.projectId,structuredClone(f.projects.get(s.projectId))]));
  await f.service.receive(groupMessage('GROUP_EDIT','正文缩短一点'));await settle(f.service);
  assert.equal(f.calls.chat.length,1);assert.equal(f.calls.chat[0].projectId,groupA.projectId);
  for(const [id,original]of unrelated)assert.deepEqual(f.projects.get(id),original);
  assert.equal(f.calls.text.at(-1).openConversationId,'cidMOCK_GROUP_A==');assert.equal(f.calls.text.at(-1).userId,undefined);
});

test('only mentioned group product pictures are retained and references never cross member or private-chat contexts',async t=>{
  const f=await fixture(t);await f.start({groupEnabled:true,allowedUserIds:['MOCK_USER','MOCK_SECOND']});
  const picture={msgtype:'richText',content:{richText:[{type:'picture',downloadCode:'MOCK_GROUP_REFERENCE'}]}};
  assert.equal((await f.service.receive(groupMessage('NOT_MENTIONED','',{...picture,isInAtList:false}))).accepted,false);
  await f.service.receive(groupMessage('PRODUCT','',picture));await settle(f.service);assert.equal(f.calls.download.length,1);assert.equal(f.calls.reference.length,1);assert.equal(f.calls.create.length,0);
  await f.service.receive(groupMessage('SECOND','MOCK 另一位成员的需求',{senderStaffId:'MOCK_SECOND'}));await settle(f.service);assert.deepEqual(f.calls.create[0].referenceIds,[]);
  await f.service.receive(message('PRIVATE','MOCK 私聊独立需求'));await settle(f.service);assert.deepEqual(f.calls.create[1].referenceIds,[]);
  await f.service.receive(groupMessage('FIRST','MOCK 使用我刚才的产品图'));await settle(f.service);assert.deepEqual(f.calls.create[2].referenceIds,['REF_1']);
});

test('group clarification and follow-up commands stay with the initiating member and require every message to mention the bot',async t=>{
  const seen=new Map();const f=await fixture(t,{analyze:async input=>{const n=seen.get(input.messages[0].content)||0;seen.set(input.messages[0].content,n+1);return n?generate():{reply:'请一起补充',source:input.messages[0].content,preferences:{},decision:{action:'ask',questions:[{id:'facts',question:'真实卖点是什么？'},{id:'visual',question:'风格、比例和张数？'}]}};}});
  await f.start({groupEnabled:true,allowedUserIds:['MOCK_USER','MOCK_SECOND']});
  await f.service.receive(groupMessage('FIRST','MOCK 第一个成员的产品'));await settle(f.service);
  assert.equal(f.calls.create.length,0);assert.match(f.calls.text.at(-1).text,/真实卖点/);
  await f.service.receive(groupMessage('SECOND','MOCK 第二个成员的产品',{senderStaffId:'MOCK_SECOND'}));await settle(f.service);
  assert.equal((await f.service.receive(groupMessage('NO_AT','真实卖点，两张',{isInAtList:false}))).accepted,false);
  await f.service.receive(groupMessage('ANSWER','卖点是真实截图，风格你定，两张'));await settle(f.service);
  assert.equal(f.calls.create.length,1);assert.equal(f.calls.analyze[2].clarificationAsked,true);assert.equal(f.calls.analyze[2].messages[0].content,'MOCK 第一个成员的产品');
  assert.equal(f.service.data.sessions.find(s=>s.userId==='MOCK_SECOND').projectId,null);
  await f.service.receive(groupMessage('NEW','新建创作'));await settle(f.service);assert.equal(f.service.data.sessions.find(s=>s.userId==='MOCK_USER').projectId,null);assert.equal(f.projects.size,1);
});

test('a failed group image delivery retries frozen bytes to its original group after restart without rerunning models',async t=>{
  let reject=true;const f=await fixture(t,{keep:true,sendImage:async()=>{if(reject)throw definite();}});await f.start({groupEnabled:true});
  await f.service.receive(groupMessage('ORIGINAL'));await settle(f.service);const delivery=f.service.data.deliveries.find(d=>d.projectId);assert.equal(delivery.status,'failed');assert.equal(delivery.openConversationId,'cidMOCK_GROUP_A==');
  await f.service.close();const g=await fixture(t,{dir:f.dir});assert.equal(g.service.config.groupEnabled,true);assert.equal(g.calls.factory,0);assert.equal(g.calls.create.length,0);
  await g.service.connect();assert.equal(g.service.snapshot().deliveries.find(d=>d.id===delivery.id).canRetry,true);await g.service.retryDelivery(delivery.id);
  assert.equal(g.calls.create.length,0);assert.equal(g.calls.analyze.length,0);assert.equal(g.calls.text.length,0);assert.equal(g.calls.image.length,2);
  for(const image of g.calls.image){assert.equal(image.openConversationId,'cidMOCK_GROUP_A==');assert.equal(image.userId,undefined);}
  assert.equal(g.service.data.deliveries.find(d=>d.id===delivery.id).status,'accepted');
});

test('disabling group use prevents late analysis, old group retries and new group tasks while keeping private chats available',async t=>{
  const gate=deferred();let first=true;const f=await fixture(t,{analyze:async()=>{if(first){first=false;await gate.promise;}return generate();}});await f.start({groupEnabled:true});
  await f.service.receive(groupMessage('PENDING'));await until(()=>f.calls.analyze.length===1);await f.service.updateConfig({groupEnabled:false});await f.service.connect();gate.resolve();await settle(f.service);
  assert.equal(f.calls.create.length,0);assert.equal(f.calls.image.length,0);assert.equal(f.calls.text.length,0);
  assert.equal((await f.service.receive(groupMessage('DISABLED'))).accepted,false);
  await f.service.receive(message('PRIVATE'));await settle(f.service);assert.equal(f.calls.create.length,1);assert.ok(f.calls.text.every(sent=>sent.openConversationId===undefined));
  const g=await fixture(t,{sendImage:async()=>{throw definite();}});await g.start({groupEnabled:true});await g.service.receive(groupMessage('FAILED'));await settle(g.service);const delivery=g.service.data.deliveries.find(d=>d.projectId),before=g.calls.image.length;
  await g.service.updateConfig({groupEnabled:false});await g.service.connect();assert.equal(g.service.snapshot().deliveries.find(d=>d.id===delivery.id).canRetry,false);await assert.rejects(g.service.retryDelivery(delivery.id),/群聊开关/);assert.equal(g.calls.image.length,before);
});

test('malformed or changed group targets cannot fall back to a private chat or another group',async t=>{
  const f=await fixture(t,{sendImage:async()=>{throw definite();}});await f.start({groupEnabled:true});await f.service.receive(groupMessage('ORIGINAL'));await settle(f.service);
  const delivery=f.service.data.deliveries.find(d=>d.projectId),before={text:f.calls.text.length,image:f.calls.image.length};
  for(const extra of [{openConversationId:''},{openConversationId:'cidANOTHER_GROUP=='},{conversationType:undefined},{conversationType:'1'},{userId:'OTHER'},{corpId:'OTHER'},{robotCode:'OTHER'}]){
    const saved=structuredClone(delivery);Object.assign(delivery,extra);assert.equal(f.service.snapshot().deliveries.find(d=>d.id===delivery.id).canRetry,false);await assert.rejects(f.service.retryDelivery(delivery.id),e=>e.status===409);Object.keys(delivery).forEach(key=>delete delivery[key]);Object.assign(delivery,saved);
  }
  const session=f.service.data.sessions[0];session.conversationId='cidREPLACED_GROUP==';session.openConversationId=session.conversationId;
  await assert.rejects(f.service.retryDelivery(delivery.id),e=>e.status===409);assert.deepEqual({text:f.calls.text.length,image:f.calls.image.length},before);
});

test('legacy private history without channel metadata stays private and retains its original message dedupe identity',async t=>{
  const f=await fixture(t,{keep:true,sendImage:async()=>{throw definite();}});await f.start();const incoming=message('LEGACY');await f.service.receive(incoming);await settle(f.service);await f.service.close();
  const state=JSON.parse(await readFile(path.join(f.dir,'dingtalk-state.json'),'utf8')),oldId=state.inbox[0].id,deliveryId=state.deliveries.find(d=>d.projectId).id;
  for(const record of [...state.sessions,...state.inbox,...state.deliveries]){delete record.conversationType;delete record.conversationTitle;delete record.openConversationId;if(!state.sessions.includes(record))delete record.conversationId;}
  await writeFile(path.join(f.dir,'dingtalk-state.json'),JSON.stringify(state));
  const oldConfig=JSON.parse(await readFile(path.join(f.dir,'dingtalk.json'),'utf8'));delete oldConfig.config.groupEnabled;await writeFile(path.join(f.dir,'dingtalk.json'),JSON.stringify(oldConfig));
  const g=await fixture(t,{dir:f.dir});assert.equal(g.service.config.groupEnabled,false);assert.equal(g.service.snapshot().sessions[0].conversationType,'1');await g.service.connect();
  assert.equal((await g.service.receive(incoming)).duplicate,true);assert.equal(g.service.data.inbox[0].id,oldId);await g.service.retryDelivery(deliveryId);
  assert.equal(g.calls.create.length,0);assert.equal(g.calls.analyze.length,0);assert.equal(g.calls.image.length,2);for(const image of g.calls.image){assert.equal(image.userId,'MOCK_USER');assert.equal(image.openConversationId,undefined);}
});

test('definite group delivery errors show a redacted reason while ambiguous errors remain non-retryable',async t=>{
  const f=await fixture(t,{sendImage:async()=>{throw Object.assign(new Error(`权限不足，请开通企业机器人发消息权限 ${SECRET} https://example.test/private`),{definiteFailure:true});}});await f.start({groupEnabled:true});await f.service.receive(groupMessage('PERMISSION'));await settle(f.service);
  const delivery=f.service.snapshot().deliveries.find(d=>d.projectId);assert.equal(delivery.status,'failed');assert.match(delivery.message,/权限不足/);assert.doesNotMatch(delivery.message,new RegExp(SECRET));assert.doesNotMatch(delivery.message,/https:\/\/example/);assert.equal(delivery.canRetry,true);
  const g=await fixture(t,{sendImage:async()=>{throw new Error(`unknown ${SECRET}`);}});await g.start({groupEnabled:true});await g.service.receive(groupMessage('UNKNOWN'));await settle(g.service);const unknown=g.service.snapshot().deliveries.find(d=>d.projectId);assert.equal(unknown.status,'unknown');assert.equal(unknown.canRetry,false);assert.doesNotMatch(unknown.message,new RegExp(SECRET));
});
