import path from 'node:path';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max = 600) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => { const s = hash(value); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20,32)}`; };
const ID = /^[A-Za-z0-9_.:@-]{1,200}$/;
const defaults = () => ({ clientId: '', clientSecret: '', robotCode: '', corpId: '', allowedUserIds: [], matchTrends: true, groupEnabled: false });
const preferences = () => ({ style:null, aspect:null, count:null, mode:null });
const active = project => ['analyzing','generating'].includes(project?.status) || ['thinking','analyzing','generating'].includes(project?.chatStatus);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
const conversationKind = record => record?.conversationType === undefined ? '1' : String(record.conversationType);
const conversationIdValid = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\u0000-\u001f\u007f]/u.test(value);
function validTarget(record) {
  const kind=conversationKind(record);
  if(kind==='1')return record?.openConversationId===undefined;
  return kind==='2' && conversationIdValid(record.conversationId) && record.openConversationId===record.conversationId;
}
function sameTarget(session,record) {
  if(!session||!record||!validTarget(session)||!validTarget(record)||conversationKind(session)!==conversationKind(record)||record.userId!==session.userId)return false;
  if(conversationKind(session)==='2')return record.corpId===session.corpId&&record.robotCode===session.robotCode&&record.conversationId===session.conversationId&&record.openConversationId===session.openConversationId;
  // Private records written before group support have no target metadata.
  return (record.corpId===undefined||record.corpId===session.corpId)&&(record.robotCode===undefined||record.robotCode===session.robotCode)&&(record.conversationId===undefined||record.conversationId===session.conversationId);
}
function targetFields(record) {
  return {conversationType:conversationKind(record),conversationId:record.conversationId,conversationTitle:clean(record.conversationTitle,120),...(conversationKind(record)==='2'?{openConversationId:record.openConversationId}:{})};
}
function normalizeConfig(input, previous = defaults()) {
  if (!object(input)) fail('请填写钉钉应用配置');
  const next = clone(previous);
  for (const key of ['clientId','robotCode','corpId']) if (input[key] !== undefined) {
    if (typeof input[key] !== 'string' || input[key].length > 200 || input[key].trim() && !ID.test(input[key].trim())) fail('钉钉应用编号格式不正确');
    next[key] = input[key].trim();
  }
  if (input.clientSecret !== undefined && (typeof input.clientSecret !== 'string' || input.clientSecret.length > 4096 || /[\r\n]/.test(input.clientSecret))) fail('Client Secret 格式不正确');
  if (input.clearSecret !== undefined && typeof input.clearSecret !== 'boolean') fail('清除密钥选项格式不正确');
  if (input.clearSecret === true) next.clientSecret = '';
  else if (input.clientSecret?.trim()) next.clientSecret = input.clientSecret.trim();
  if (next.clientId !== previous.clientId && previous.clientSecret && !input.clientSecret?.trim() && input.clearSecret !== true) fail('更换 Client ID 时请重新填写 Client Secret');
  if (input.allowedUserIds !== undefined) {
    const ids = typeof input.allowedUserIds === 'string' ? input.allowedUserIds.split(/[\s,，;；]+/).filter(Boolean) : input.allowedUserIds;
    if (!Array.isArray(ids) || ids.length > 30 || ids.some(id => typeof id !== 'string' || !ID.test(id))) fail('允许使用的钉钉用户编号格式不正确，最多30个');
    next.allowedUserIds = [...new Set(ids)];
  }
  if (input.matchTrends !== undefined) { if (typeof input.matchTrends !== 'boolean') fail('热点匹配选项格式不正确'); next.matchTrends = input.matchTrends; }
  if (input.groupEnabled !== undefined) { if (typeof input.groupEnabled !== 'boolean') fail('群聊开关格式不正确'); next.groupEnabled = input.groupEnabled; }
  return next;
}
function missing(config) { return [!config.clientId && 'Client ID', !config.clientSecret && 'Client Secret', !config.robotCode && 'Robot Code', !config.corpId && '企业 Corp ID', !config.allowedUserIds.length && '允许使用的用户编号'].filter(Boolean); }
function parseMessage(message) {
  let text = '', codes = [];
  if (message.msgtype === 'text') text = message.text?.content;
  else if (message.msgtype === 'picture') codes = [message.content?.downloadCode || message.content?.pictureDownloadCode];
  else if (message.msgtype === 'richText') {
    const items = message.content?.richText;
    if (!Array.isArray(items) || items.length > 30) fail('这条图文消息格式不支持');
    text = items.map(item => typeof item?.text === 'string' ? item.text : '').filter(Boolean).join('\n');
    codes = items.filter(item => item?.type === 'picture').map(item => item.downloadCode || item.pictureDownloadCode);
  } else return { text:'', codes:[], unsupported:true };
  if (text !== undefined && (typeof text !== 'string' || text.length > 24000)) fail('消息文字请控制在24000字符以内');
  if (codes.some(code => typeof code !== 'string' || !code || code.length > 4096)) fail('图片下载信息无效，请重新发送图片');
  codes = [...new Set(codes)];
  if (codes.length > 4) fail('每次最多使用4张产品参考图');
  return { text: String(text || '').trim(), codes, unsupported:false };
}
function chunks(value, size = 1700) {
  const chars = Array.from(value), result = [];
  for (let offset=0; offset<chars.length; offset+=size) result.push(chars.slice(offset,offset+size).join(''));
  return result.length ? result : ['图文已保存在平台。'];
}

/** Durable adapter for private chats and explicitly enabled group mentions. Receiving a Stream callback only
 * persists its inbox entry; the existing creative service runs asynchronously. */
export class DingtalkService {
  constructor({ dir, transportFactory, analyzeBrief, createProject, chatProject, getProject, saveReference, getProjectImages, isProjectBusy = active, now = Date.now, wait = pause, maxWaitMs = 1800000 } = {}) {
    if (!dir) throw new Error('钉钉接入缺少数据目录');
    this.dir = path.resolve(dir); this.config = defaults(); this.data = {version:1,sessions:[],inbox:[],deliveries:[],activity:[]};
    this.status = {state:'disconnected',message:'尚未连接钉钉；填写应用信息后手动连接。',busy:false,connectedAt:null,lastMessageAt:null};
    Object.assign(this,{transportFactory,analyzeBrief,createProject,chatProject,getProject,saveReference,getProjectImages,isProjectBusy,now,wait,maxWaitMs});
    this.transport = null; this.accepting = false; this.epoch = 0; this.tails = new Map(); this.attachments = new Map(); this.writeTail = Promise.resolve(); this.admission = Promise.resolve(); this.control = false; this.storageError = false;
  }
  iso() { return new Date(this.now()).toISOString(); }
  safe(value) {
    let text = clean(value,3000);
    if (this.config.clientSecret) text = text.split(this.config.clientSecret).join('[已隐藏]');
    return text.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi,'[凭据已隐藏]').replace(/https?:\/\/[^\s<>"']+/gi,'[链接已隐藏]').replace(/(?:\/(?:Users|home|private|tmp|var)\/[^\s"'<>]+)/g,'[本机路径]').slice(0,600);
  }
  async atomic(file, value) { const target=path.join(this.dir,file),temp=`${target}.${randomUUID()}.tmp`; await writeFile(temp,JSON.stringify(value,null,2),{mode:0o600}); await rename(temp,target); await chmod(target,0o600); }
  persist() { const snapshot=clone(this.data); const op=this.writeTail.then(()=>this.atomic('dingtalk-state.json',snapshot)); this.writeTail=op.catch(()=>{}); return op; }
  async init() {
    await mkdir(this.dir,{recursive:true,mode:0o700});
    for (const [file,kind] of [['dingtalk.json','config'],['dingtalk-state.json','state']]) {
      try {
        const raw=await readFile(path.join(this.dir,file),'utf8'); if (Buffer.byteLength(raw)>30*1024*1024) fail('钉钉本机记录过大');
        const value=JSON.parse(raw);
        if (kind==='config') this.config=normalizeConfig(value.config || value);
        else {
          if (value?.version!==1 || !['sessions','inbox','deliveries','activity'].every(key=>Array.isArray(value[key]))) fail('钉钉记录格式无效');
          this.data=value;
        }
        await chmod(path.join(this.dir,file),0o600);
      } catch (error) { if (error.code!=='ENOENT') { this.storageError=true;this.status.state='error'; this.status.message='本机钉钉记录读取失败，请检查原文件后重启，避免覆盖消息去重记录。'; this.accepting=false; return this; } }
    }
    for (const entry of this.data.inbox) if (['queued','running'].includes(entry.status)) { entry.status='interrupted'; entry.error='服务中断，未自动重复调用模型；可在钉钉明确回复“继续上次任务”。'; }
    for (const session of this.data.sessions) if (this.data.inbox.some(entry=>entry.sessionId===session.id && entry.status==='interrupted')) { session.stage='interrupted'; session.lastError='上次任务中断，已有作品保留；可明确继续上次任务。'; }
    for (const delivery of this.data.deliveries) {
      for (const part of [...(delivery.texts||[]),...(delivery.images||[])]) if (part.status==='sending') { part.status='unknown'; part.message='发送期间中断，是否受理未知，不会自动重发。'; }
      if (delivery.status==='sending') { delivery.status='unknown'; delivery.message='上次交付中断，不会自动重发。'; }
    }
    this.status.message=missing(this.config).length?'填写钉钉应用配置并连接后，即可接收创作消息。':'应用配置已保存。点击连接后开始接收创作消息；重启没有自动连接或重放任务。';
    await this.persist(); return this;
  }
  snapshot() {
    const {clientSecret,...config}=this.config;
    return { config:{...clone(config),hasSecret:Boolean(clientSecret)},status:clone(this.status),readiness:{configured:!this.storageError&&!missing(this.config).length,missing:[...missing(this.config),...(this.storageError?['本机消息记录读取失败']:[])]},
      sessions:this.data.sessions.slice(-50).reverse().map(s=>({id:s.id,userId:s.userId,conversationType:conversationKind(s),conversationTitle:this.safe(s.conversationTitle),stage:s.stage,projectId:s.projectId||null,referenceCount:s.referenceIds?.length||0,updatedAt:s.updatedAt,lastError:this.safe(s.lastError)})),
      activity:this.data.activity.slice(-40).reverse().map(a=>({...a,message:this.safe(a.message)})),
      deliveries:this.data.deliveries.slice(-40).reverse().map(d=>({id:d.id,userId:d.userId,projectId:d.projectId||null,conversationType:conversationKind(d),conversationTitle:this.safe(d.conversationTitle),status:d.status,createdAt:d.createdAt,updatedAt:d.updatedAt,message:this.safe(d.message),canRetry:d.status==='failed'&&d.attempts<5&&this.status.state==='connected'&&this.current(this.data.sessions.find(s=>s.id===d.sessionId),d)})) };
  }
  record(kind,status,message,projectId) { this.data.activity.push({id:randomUUID(),kind,status,message:this.safe(message),at:this.iso(),...(projectId?{projectId}:{})}); this.data.activity=this.data.activity.slice(-100); }
  async updateConfig(input) {
    if(this.storageError)fail('本机钉钉记录读取失败，请先修复原文件并重启，未覆盖现有配置和去重记录。',409);
    if (this.control) fail('钉钉连接正在处理，请稍后再保存',409);
    const next=normalizeConfig(input,this.config); this.control=true;
    try { await this.disconnect(); await this.atomic('dingtalk.json',{version:1,config:next}); this.config=next; this.status.message='钉钉配置已保存，点击连接后生效。'; return this.snapshot(); }
    finally { this.control=false; }
  }
  async makeTransport() {
    if (!this.transport) {
      const current=++this.epoch;
      const options={getConfig:()=>clone(this.config),onMessage:message=>current===this.epoch?this.receive(message):Promise.resolve({accepted:false}),onStatus:value=>{
        if (current!==this.epoch) return;
        if (['connecting','connected','disconnected','error'].includes(value?.state)) { this.status.state=value.state; this.status.message=this.safe(value.message); if(value.state==='connected')this.status.connectedAt=this.iso(); }
      }};
      this.transport=this.transportFactory?await this.transportFactory(options):new (await import('./dingtalk-transport.mjs')).DingtalkTransport(options);
    }
    return this.transport;
  }
  async connect() {
    if(this.storageError)fail('本机钉钉记录读取失败，已停止接入以保护消息去重记录。',409);
    if (missing(this.config).length) fail('请先填写完整的应用配置和允许使用的用户编号');
    if (this.control || this.status.state==='connecting') fail('钉钉连接正在处理中',409);
    if (this.accepting && this.status.state==='connected') return this.snapshot();
    this.control=true; this.accepting=true; this.status.state='connecting'; this.status.busy=true; this.status.message='正在连接钉钉 Stream。';
    try { await (await this.makeTransport()).connect(); this.record('connect',this.status.state,'已请求连接钉钉 Stream'); await this.persist(); }
    catch { await this.disconnect();this.status.state='error'; this.status.message='钉钉连接未成功，请核对凭证、机器人发布状态和网络后再连接。'; }
    finally { this.control=false; this.status.busy=false; }
    return this.snapshot();
  }
  async disconnect() {
    this.accepting=false; ++this.epoch;
    const transport=this.transport; this.transport=null;
    if (transport) await transport.disconnect().catch(()=>{});
    this.status.state='disconnected'; this.status.busy=false; this.status.message='钉钉连接已断开，应用配置和已有作品保留。';
    return this.snapshot();
  }
  async testCredentials() {
    if(this.storageError)fail('本机钉钉记录读取失败，请先修复后重启。',409);
    if (missing(this.config).length) fail('请先填写完整钉钉应用配置');
    if (this.control) fail('另一个钉钉操作正在进行',409);
    this.control=true; this.status.busy=true;
    let result;
    try { result=await(await this.makeTransport()).testCredentials(); this.record('test','success','应用凭证验证通过；没有发送消息或调用模型。'); await this.persist(); }
    catch { fail('应用凭证验证未通过，请检查 Client ID、Client Secret 和网络。'); }
    finally { this.control=false; this.status.busy=false; }
    const message=this.safe(result?.message)||'应用凭证验证通过。';return {...this.snapshot(),ok:true,message,test:{ok:true,message}};
  }
  receive(message) {
    const operation=this.admission.then(()=>this.accept(message)); this.admission=operation.catch(()=>{}); return operation;
  }
  async accept(message) {
    if (this.storageError || !this.accepting || !object(message) || missing(this.config).length) return {accepted:false};
    const userId=message.senderStaffId,conversationId=message.conversationId,msgId=message.msgId,conversationType=String(message.conversationType);
    if(typeof userId!=='string'||!ID.test(userId)||!conversationIdValid(conversationId)||typeof msgId!=='string'||!msgId||msgId.length>512)return {accepted:false};
    if (!['1','2'].includes(conversationType) || conversationType==='2'&&(!this.config.groupEnabled||message.isInAtList!==true) || message.chatbotCorpId!==this.config.corpId || message.senderCorpId && message.senderCorpId!==this.config.corpId || message.robotCode!==this.config.robotCode || !this.config.allowedUserIds.includes(userId)) return {accepted:false};
    // The robot callback's conversationId is the OpenAPI openConversationId.
    // Reject ambiguous targets rather than silently replying in a private chat.
    if(message.openConversationId!==undefined&&(conversationType!=='2'||message.openConversationId!==conversationId))return {accepted:false};
    const route={conversationType,conversationId,conversationTitle:conversationType==='2'?clean(message.conversationTitle,120):'',...(conversationType==='2'?{openConversationId:conversationId}:{})};
    const boundary=conversationType==='2'?[this.config.corpId,this.config.robotCode,'group',conversationId,userId]:[this.config.corpId,this.config.robotCode,conversationId,userId];
    const id=hash(JSON.stringify([...boundary,msgId]));
    if (this.data.inbox.some(entry=>entry.id===id)) return {accepted:true,duplicate:true};
    if (this.data.inbox.length>=20000) fail('钉钉消息记录已达到上限，请先备份整理记录',503);
    let parsed;try{parsed=parseMessage(message);}catch{parsed={text:'',codes:[],invalid:true};}
    const sessionId=hash(JSON.stringify(boundary));
    let session=this.data.sessions.find(item=>item.id===sessionId);
    if(!session){session={id:sessionId,userId,corpId:this.config.corpId,robotCode:this.config.robotCode,...route,stage:'idle',messages:[],preferences:preferences(),referenceIds:[],clarificationAsked:false,projectId:null,lastError:'',updatedAt:this.iso()};this.data.sessions.push(session);}
    else if(!sameTarget(session,{userId,corpId:this.config.corpId,robotCode:this.config.robotCode,...route}))return {accepted:false};
    else if(conversationType==='2')session.conversationTitle=route.conversationTitle;
    const entry={id,sessionId,userId,corpId:this.config.corpId,robotCode:this.config.robotCode,...route,connectionEpoch:this.epoch,status:'queued',text:parsed.text,codes:parsed.codes,unsupported:parsed.unsupported||false,invalid:parsed.invalid||false,createdAt:this.iso(),updatedAt:this.iso(),operation:null,projectId:null,error:''};
    this.data.inbox.push(entry); this.status.lastMessageAt=this.iso(); this.record('received','queued',conversationType==='2'?'收到允许成员的一条群聊 @ 消息，已保存等待处理。':'收到允许用户的一条私聊消息，已保存等待处理。');
    try { await this.persist(); } catch(error) { this.data.inbox=this.data.inbox.filter(item=>item!==entry);throw error; }
    // Start only after the durable inbox is committed. Nothing below this line
    // is awaited by Stream, so expensive providers cannot delay its ACK.
    if(entry.codes.length){const download=this.prepareReferences(entry).catch(error=>{entry.attachmentError=this.safe(error.message);return this.persist();});this.attachments.set(entry.id,download);download.catch(()=>{});}
    const queueId=sessionId;
    const next=(this.tails.get(queueId)||Promise.resolve()).catch(()=>{}).then(()=>this.process(entry));
    this.tails.set(queueId,next); next.catch(()=>{});
    return {accepted:true,duplicate:false};
  }
  current(session,frozen=session) { return Boolean(session&&this.accepting && session.corpId===this.config.corpId && session.robotCode===this.config.robotCode && this.config.allowedUserIds.includes(session.userId) && sameTarget(session,frozen) && (conversationKind(session)==='1'||this.config.groupEnabled)); }
  async prepareReferences(entry){
    const session=this.data.sessions.find(item=>item.id===entry.sessionId);entry.references||=[];
    for(let index=entry.references.length;index<entry.codes.length;index++){
      if(!this.current(session,entry)||entry.connectionEpoch!==this.epoch)fail('连接、会话目标或使用范围已变更，未继续下载参考图。');
      const image=await(await this.makeTransport()).downloadImage({downloadCode:entry.codes[index]});
      const match=typeof image?.dataUrl==='string'&&image.dataUrl.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
      if(!match||Buffer.from(match[1],'base64').length>8*1024*1024)fail('参考图需为 PNG、JPEG 或 WebP，单张不超过8MB。');
      const saved=await this.saveReference(image);if(!saved?.id)fail('产品图片保存未完成，请重新发送原图。');entry.references.push(saved.id);await this.persist();
    }
  }
  async process(entry,{resume=false}={}) {
    const session=this.data.sessions.find(item=>item.id===entry.sessionId); if(!session)return;
    if(!this.current(session,entry)||!resume&&entry.connectionEpoch!==this.epoch){entry.status='interrupted';entry.error='连接、会话目标或使用范围已变更，未执行这条消息。';await this.persist();return;}
    if(resume)entry.connectionEpoch=this.epoch;
    entry.status='running';session.activeEntryId=entry.id;session.lastError='';await this.persist();
    try {
      if (resume && entry.operation) await this.execute(entry,session);
      else if(entry.invalid||entry.unsupported) await this.reply(session,'首版支持文字和静态产品图片。每次最多4张参考图，请重新发送支持的内容。');
      else if(/^(?:新建创作|新建对话|开始新创作|新的一篇)[。！!\s]*$/.test(entry.text)) {
        Object.assign(session,{stage:'idle',messages:[],preferences:preferences(),referenceIds:[],clarificationAsked:false,projectId:null});
        await this.persist();await this.reply(session,'已开始新的创作。直接发需求，也可以先发送产品图片。已有作品仍保存在平台。');
      } else if(/^(?:进度|查看进度|当前进度)[？?。！!\s]*$/.test(entry.text)) {
        const p=session.projectId?await this.getProject(session.projectId):null;
        await this.reply(session,p?`作品 ${p.id.slice(0,8)}：已完成 ${(p.pages||[]).filter(page=>page.status==='done').length}/${p.pages?.length||0} 张。`:'当前还没有生成中的作品，可以直接发创作需求。');
      } else if(/^(?:补发结果|重发结果|重试交付)[。！!\s]*$/.test(entry.text)) {
        const d=[...this.data.deliveries].reverse().find(item=>item.sessionId===session.id&&item.status==='failed');
        if(d)await this.retryDelivery(d.id);else await this.reply(session,'没有明确失败且可以补发的交付记录。已受理或结果未知的消息不会重复发送。');
      } else if(/^(?:继续上次任务|恢复上次任务)[。！!\s]*$/.test(entry.text)) {
        const old=[...this.data.inbox].reverse().find(item=>item.id!==entry.id&&item.sessionId===session.id&&['interrupted','error'].includes(item.status)&&item.operation);
        if(old)await this.process(old,{resume:true});else await this.reply(session,'当前没有可恢复的已保存任务。请直接说明新的需求或修改内容。');
      } else {
        if(entry.codes.length){
          if(session.referenceIds.length+entry.codes.length>4)fail('本次参考图超过4张。请新建创作后重新选择，或先发送当前需求。');
          if(this.attachments.has(entry.id))await this.attachments.get(entry.id);else await this.prepareReferences(entry);
          if(entry.attachmentError)fail(entry.attachmentError);
          session.referenceIds=[...new Set([...session.referenceIds,...entry.references])];await this.persist();
        }
        if(!entry.text)await this.reply(session,`已收到产品图片，当前共${session.referenceIds.length}张。接着告诉我想创作什么，图片不会单独触发生图。`);
        else if(session.projectId){
          entry.operation={kind:'chat',input:{projectId:session.projectId,requestId:uuid(`dingtalk:chat:${entry.id}`),message:entry.text,referenceIds:[...session.referenceIds]}};
          session.referenceIds=[];
          await this.persist();await this.execute(entry,session);
        } else {
          session.messages.push({role:'user',content:entry.text});session.messages=session.messages.slice(-18);
          while(session.messages.reduce((n,item)=>n+item.content.length,0)>55000)session.messages.shift();
          session.stage='clarifying';await this.persist();
          if(!this.current(session,entry)||entry.connectionEpoch!==this.epoch)fail('连接、会话目标或使用范围已变更，未调用需求分析。');
          const result=await this.analyzeBrief({messages:clone(session.messages),preferences:clone(session.preferences),referenceIds:[...session.referenceIds],matchTrends:this.config.matchTrends,clarificationAsked:session.clarificationAsked});
          if(!this.current(session,entry)||entry.connectionEpoch!==this.epoch)fail('连接、会话目标或使用范围已变更，未继续处理需求分析。');
          if(typeof result.source==='string')session.source=result.source;
          session.preferences={...session.preferences,...Object.fromEntries(Object.entries(result.preferences||{}).filter(([,v])=>v!==null))};
          const decision=result.decision;
          if(!decision||!['ask','generate','hold'].includes(decision.action))fail('需求分析没有返回有效决策，请重新说明需求。');
          if(decision.action==='generate'){
            entry.operation={kind:'create',input:{requestId:uuid(`dingtalk:create:${entry.id}`),source:result.source,...decision.resolvedSpec,referenceIds:[...session.referenceIds],xhsAutoDelivery:false,origin:'dingtalk'}};
            await this.persist();await this.execute(entry,session);
          }else{
            const questions=decision.action==='ask'?(decision.questions||[]).map((q,i)=>`${i+1}. ${q.question}`).join('\n'):'';
            const response=[result.reply,questions].filter(Boolean).join('\n\n')||'请再补充创作主题和真实素材。';
            session.messages.push({role:'assistant',content:response.slice(0,6000)});if(decision.action==='ask')session.clarificationAsked=true;
            await this.persist();await this.reply(session,response);
          }
        }
      }
      entry.status='completed';entry.updatedAt=this.iso();session.updatedAt=this.iso();await this.persist();
    }catch(error){entry.status='error';entry.error=this.safe(error.message);entry.updatedAt=this.iso();session.stage=entry.operation?'interrupted':'error';session.lastError=entry.error;session.updatedAt=this.iso();this.record('processing','error','创作任务未完成，已有作品和任务编号保留。',session.projectId);await this.persist();if(this.current(session,entry))await this.reply(session,`这次操作未完成：${entry.error}。${entry.operation?'可回复“继续上次任务”，沿用原请求编号检查或继续，不会重复创建同一任务。':'请补充或重新发送需求。'}`).catch(()=>{});}
  }
  async execute(entry,session){
    if(!this.current(session,entry)||entry.connectionEpoch!==this.epoch)fail('钉钉连接或会话目标已变更，本次未继续执行。');
    const existingDelivery=entry.resultDeliveryId&&this.data.deliveries.find(item=>item.id===entry.resultDeliveryId);
    if(existingDelivery){
      if(existingDelivery.status==='failed')await this.retryDelivery(existingDelivery.id);
      else if(existingDelivery.status==='pending')await this.deliver(existingDelivery);
      else if(existingDelivery.status==='unknown')await this.reply(session,'已有作品已经生成，但上次部分消息是否受理未知；为避免重复，不会再次发送这些图片。可以在平台查看成品。');
      const saved=existingDelivery.projectId&&await this.getProject(existingDelivery.projectId);if(saved)session.stage=saved.status==='completed'?'completed':saved.status==='partial'?'partial':'error';await this.persist();
      return;
    }
    const op=entry.operation;session.stage='generating';await this.persist();
    await this.reply(session,op.kind==='create'?`需求已整理好，正在生成文案和图片。完成后会在${conversationKind(session)==='2'?'这个群':'这个私聊'}里发回结果。`:'正在处理这份作品的修改，已有图片会保留；完成后会发回实际修改结果。');
    if(!this.current(session,entry)||entry.connectionEpoch!==this.epoch)fail('钉钉连接或会话目标已变更，未发起生成任务。');
    const result=op.kind==='create'?await this.createProject(clone(op.input)):await this.chatProject(clone(op.input));
    const initial=result?.project||result;
    if(!initial?.id)fail('平台没有返回有效作品编号，任务已保留。');
    session.projectId=initial.id;entry.projectId=initial.id;if(op.kind==='create')session.referenceIds=[];await this.persist();
    const deadline=this.now()+this.maxWaitMs;let p=initial;
    for(;;){
      p=await this.getProject(initial.id);if(!p)fail('关联作品已不存在，请新建创作。');
      if(!this.isProjectBusy(p))break;
      if(this.now()>deadline)fail('作品仍在平台处理中，可稍后回复“继续上次任务”查询同一任务。');
      await this.wait(1000);
    }
    const record=p.chatRequests?.find(item=>item.requestId===op.input.requestId);
    if(op.kind==='chat'&&record&&(record.action==='reply'||['error','interrupted'].includes(record.status)&&!record.pageIds?.length)){
      session.stage=['error','interrupted'].includes(record.status)?'error':p.status==='completed'?'completed':'partial';
      const response=record.action==='reply'?`本次仅回复，尚未修改图文。${record.reply?'\n\n'+record.reply:''}`:record.reply||record.error||'这次修改未完成，已有图文仍保留。';
      await this.persist();await this.reply(session,response,entry);return;
    }
    session.stage=p.status==='completed'?'completed':p.status==='partial'?'partial':'error';await this.persist();
    await this.resultDelivery(session,p,entry,record);
  }
  async reply(session,text,entry){return this.createDelivery(session,{texts:chunks(String(text||'').slice(0,12000)),images:[],projectId:entry?.projectId||null,entry});}
  async resultDelivery(session,p,entry,record){
    let images=entry.operation.kind==='chat'&&['update_post','save_draft'].includes(record?.action)?[]:await this.getProjectImages(p);
    if(entry.operation.kind==='chat'&&record?.pageIds?.length)images=images.filter(image=>record.pageIds.includes(image.pageId));
    const done=(p.pages||[]).filter(page=>page.status==='done').length;
    const text=`作品 ${p.id.slice(0,8)} · 已完成 ${done}/${p.pages?.length||0} 张${record?.reply?'\n'+record.reply:''}\n\n${p.title||''}\n\n${p.caption||''}${p.status!=='completed'?'\n\n部分内容尚未完成，可回复“重试失败图片”。':''}\n\n可继续说“标题改成…”“第2张…”或“再补2张配图”。新主题请说“新建创作”。`;
    return this.createDelivery(session,{texts:chunks(text),images,projectId:p.id,entry});
  }
  async createDelivery(session,{texts,images,projectId,entry}){
    const route=targetFields(entry||session);
    if(!sameTarget(session,{userId:session.userId,corpId:session.corpId,robotCode:session.robotCode,...route}))fail('交付的会话目标不一致，未改投其他聊天。',409);
    const id=randomUUID(),directory=path.join(this.dir,'dingtalk-outbox',id);await mkdir(directory,{recursive:true,mode:0o700});
    const frozen=[],notices=[];
    for(let i=0;i<images.length;i++){
      const image=images[i],extension=({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'})[image.mime];
      if(!Buffer.isBuffer(image.bytes)||!image.bytes.length)fail('生成图片数据无效，请在平台查看已保存的作品。');
      if(!extension||image.bytes.length>8*1024*1024){const reason=image.bytes.length>8*1024*1024?'超过钉钉回传的8MB限制':'格式暂不支持钉钉回传';const name=clean(image.name,160)||`第${i+1}张`;frozen.push({name,mime:image.mime,status:'blocked',message:reason});notices.push(`${name}：${reason}，原图已保留在平台，请在平台查看或下载。`);continue;}
      const file=`${String(i+1).padStart(2,'0')}.${extension}`;await writeFile(path.join(directory,file),image.bytes,{mode:0o600});frozen.push({file,name:clean(image.name,160)||file,mime:image.mime,status:'pending'});
    }
    const deliveryTexts=notices.length?chunks(`${texts.join('\n')}\n\n部分图片未回传：\n${notices.join('\n')}`):texts;
    const delivery={id,sessionId:session.id,userId:session.userId,corpId:session.corpId,robotCode:session.robotCode,...route,projectId,status:'pending',texts:deliveryTexts.map(text=>({text,status:'pending'})),images:frozen,createdAt:this.iso(),updatedAt:this.iso(),message:'等待交付',attempts:0};
    this.data.deliveries.push(delivery);if(entry)entry.resultDeliveryId=id;await this.persist();return this.deliver(delivery);
  }
  async deliver(delivery){
    const session=this.data.sessions.find(item=>item.id===delivery.sessionId);
    if(!this.current(session,delivery)||this.status.state!=='connected'){delivery.status='failed';delivery.message=delivery.projectId?'连接、使用范围或会话目标已变化，成品已保留，未改投其他聊天。':'连接、使用范围或会话目标已变化，文字消息已保存，未改投其他聊天。';delivery.updatedAt=this.iso();await this.persist();return;}
    delivery.status='sending';delivery.attempts++;await this.persist();
    const transport=await this.makeTransport(),epoch=this.epoch;
    for(const part of [...delivery.texts,...delivery.images]){
      if(!['pending','failed'].includes(part.status))continue;
      if(epoch!==this.epoch||!this.current(session,delivery)||this.status.state!=='connected'){part.status='failed';part.message='连接、使用范围或会话目标已变化，本条尚未发送。';break;}
      part.status='sending';await this.persist();
      let dispatched=false;
      try{
        if(epoch!==this.epoch||!this.current(session,delivery)||this.status.state!=='connected')fail('连接或会话目标已变化，本条尚未发送。');
        const target=conversationKind(delivery)==='2'?{openConversationId:delivery.openConversationId}:{userId:delivery.userId};
        if(part.text!==undefined){dispatched=true;await transport.sendText({...target,text:part.text,title:delivery.projectId?'图文创作结果':'图文工坊'});}
        else{
          if(!/^\d{2}\.(png|jpg|webp)$/.test(part.file)||!/^[0-9a-f-]{36}$/.test(delivery.id))fail('本机交付图片记录无效');
          const bytes=await readFile(path.join(this.dir,'dingtalk-outbox',delivery.id,part.file));if(epoch!==this.epoch||!this.current(session,delivery)||this.status.state!=='connected')fail('连接或会话目标已变化，本条尚未发送。');dispatched=true;await transport.sendImage({...target,bytes,name:part.name,mime:part.mime});
        }
        part.status='accepted';
      }catch(error){part.status=!dispatched||error.definiteFailure===true?'failed':'unknown';part.message=part.status==='failed'?`钉钉明确未受理，可手动补发。${this.safe(error.message)?'原因：'+this.safe(error.message):''}`:'本条是否受理未知，为避免重复不重发。';break;}
      await this.persist();
    }
    const parts=[...delivery.texts,...delivery.images];
    delivery.status=parts.some(part=>part.status==='unknown')?'unknown':parts.every(part=>part.status==='accepted')?'accepted':parts.every(part=>['accepted','blocked'].includes(part.status))?'partial':'failed';
    delivery.message=delivery.status==='accepted'?(delivery.projectId?'钉钉接口已受理本次图文交付。':'钉钉接口已受理本次文字消息。'):delivery.status==='partial'?`${delivery.images.filter(part=>part.status==='blocked').length}张图片受大小或格式限制未回传，原图保存在平台；其余消息已受理。`:delivery.status==='unknown'?'部分消息是否受理未知，已有结果保留，不会自动重复发送。':`部分消息尚未交付，连接正常后可明确补发未受理部分。${parts.find(part=>part.status==='failed')?.message||''}`;
    delivery.updatedAt=this.iso();this.record('delivery',delivery.status,delivery.message,delivery.projectId);await this.persist();return {id:delivery.id,status:delivery.status};
  }
  async retryDelivery(id){
    const delivery=this.data.deliveries.find(item=>item.id===id);if(!delivery)fail('钉钉交付记录不存在',404);
    if(delivery.status!=='failed')fail('仅明确失败的交付可补发；已受理或受理未知不会重复发送',409);
    if(delivery.attempts>=5)fail('本次交付已达到5次尝试上限',429);
    if(!this.accepting||this.status.state!=='connected')fail('请先连接钉钉再补发结果',409);
    if(!this.current(this.data.sessions.find(s=>s.id===delivery.sessionId),delivery))fail('群聊开关、使用范围或会话目标已变化，未改投其他聊天',409);
    await this.deliver(delivery);return this.snapshot();
  }
  async close(){await this.disconnect();await this.writeTail;}
}
