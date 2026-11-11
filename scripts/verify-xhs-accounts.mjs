import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

// Fully isolated UI fixture: no real account service, credentials or browser profile.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',C='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const image='/media/accounts-fixture.svg',projectId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const records=[{profileId:A,accountId:'account-a',accountName:'产品主号',group:'产品',nickname:'产品笔记',connectionState:'connected',lastSyncAt:'2026-11-11T02:00:00Z',legacy:true,busy:false},{profileId:B,accountId:'account-b',accountName:'工具分享号',group:'工具',nickname:'工具笔记',connectionState:'connected',lastSyncAt:'2026-11-11T03:00:00Z',busy:false}];
let selected=A,delayDetail=false,requests=[],project=null;
const snapshots=new Map(records.map((r,index)=>[r.profileId,{account:{id:r.accountId,nickname:r.nickname,followers:index?222:111,following:3,likes:6,notesCount:1},connection:{state:'connected',message:'MOCK 已连接'},status:{busy:false,message:''},notes:[{id:'note-'+r.accountId,title:r.accountName+'专属笔记',publishedAt:'2026-11-11T03:00:00Z',imageUrl:image,views:index?200:100}],metrics:[],analyticsHistory:[],officialDrafts:[{key:'draft-'+r.accountId,title:r.accountName+'电脑草稿',canRead:true}],officialDraftSync:{},drafts:[],sync:{lastSyncAt:r.lastSyncAt,coverage:{hasMore:false,message:'MOCK 正常加载'}}}]));
function snapshot(){return {...structuredClone(snapshots.get(selected)),selectedProfileId:selected,accounts:records.map(r=>({...r,selected:r.profileId===selected}))};}
const detail=(id,title)=>({id,title,content:'官网正文 '+title,images:[image,image],source:'official',isComplete:true});
const respond=(res,body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};
 if(u.pathname.startsWith('/api/'))requests.push({path:u.pathname,method:req.method,query:Object.fromEntries(u.searchParams),body});
 if(u.pathname==='/api/config')return respond(res,{config:{configured:true,text:{hasKey:true,baseUrl:'https://model.fixture.invalid/v1',model:'fixture'},image:{hasKey:true},styles:[]}});
 if(u.pathname==='/api/projects')return respond(res,{projects:project?[project]:[]});
 if(u.pathname==='/api/xhs')return respond(res,snapshot());
 if(u.pathname==='/api/xhs/accounts'&&req.method==='POST'){
  records.push({profileId:C,accountId:null,accountName:body.accountName,group:body.group||'默认分组',connectionState:'disconnected',lastSyncAt:null,busy:false});selected=C;
  snapshots.set(C,{account:null,connection:{state:'disconnected',message:'MOCK 等待扫码'},status:{busy:false},notes:[],metrics:[],analyticsHistory:[],officialDrafts:[],officialDraftSync:{},drafts:[],sync:{}});return respond(res,snapshot(),201);
 }
 const account=u.pathname.match(/^\/api\/xhs\/accounts\/([^/]+)(\/select)?$/);
 if(account){const record=records.find(r=>r.profileId===account[1]);if(!record)return respond(res,{error:'MOCK 不存在'},404);
  if(account[2])selected=record.profileId;
  else if(req.method==='PATCH'){record.accountName=body.accountName;record.group=body.group||'默认分组';}
  else if(req.method==='DELETE'){records.splice(records.indexOf(record),1);snapshots.delete(record.profileId);if(selected===record.profileId)selected=records[0].profileId;}
  return respond(res,snapshot());
 }
 const note=u.pathname.match(/^\/api\/xhs\/(notes|official-drafts)\/([^/]+)$/);
 if(note){const id=body.accountId||u.searchParams.get('accountId');const r=records.find(r=>r.accountId===id),value=detail(note[2],r.accountName+'官方内容');if(delayDetail&&id==='account-a'){delayDetail=false;return setTimeout(()=>respond(res,{detail:value}),700);}return respond(res,{detail:value});}
 if(['/api/xhs/login','/api/xhs/check','/api/xhs/sync','/api/xhs/open-drafts','/api/xhs/disconnect'].includes(u.pathname))return respond(res,snapshot(),202);
 if(u.pathname==='/api/brief/chat'){const spec={style:'notion',aspect:'3:4',count:2,mode:'cards'};return respond(res,{analysis:'MOCK 需求已齐',source:'MOCK 工具宣传',recommendations:spec,preferences:spec,decision:{action:'generate',resolvedSpec:spec,questions:[]},reply:'MOCK 开始创作'});}
 if(u.pathname==='/api/brief/create'){
  project={id:projectId,title:'MOCK 已生成作品',caption:'MOCK 产品正文',source:body.source,status:'completed',style:'notion',aspect:'3:4',mode:'cards',pages:[{id:'page-one',title:'封面',status:'done',imageUrl:image}],xhsDelivery:{enabled:true,accountId:body.xhsAccountId,accountName:'产品主号',status:'blocked',canContinue:true,message:'MOCK 请继续送稿'},creationRequestId:body.requestId};return respond(res,{project});
 }
 if(u.pathname==='/api/projects/'+projectId)return respond(res,{project});
 if(u.pathname==='/api/projects/'+projectId+'/xhs-delivery')return respond(res,{project});
 if(u.pathname===image){res.writeHead(200,{'Content-Type':'image/svg+xml'});return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#eaf0f6"/><text x="35" y="150" fill="#244b76" font-size="30">Account fixture</text></svg>');}
 const file=u.pathname==='/'?'index.html':u.pathname.slice(1);try{const bytes=await readFile(path.join(root,'public',file));res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream'});res.end(bytes);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
const output=process.env.XHS_ACCOUNTS_UI_OUTPUT||'/tmp/xhs-accounts-ui';await mkdir(output,{recursive:true});
try{
 await page.goto(base+'/?view=xhs');await page.locator('.xhs-profile-card').first().waitFor();
 assert.equal(await page.locator('.xhs-profile-card').count(),2);assert.equal(await page.locator('.xhs-basic-metrics strong').first().innerText(),'111');
 assert.equal(requests.filter(r=>r.method==='POST').length,0,'boot must be inert');
 await page.locator('#xhs-account-group-filter').selectOption('工具');assert.equal(await page.locator('.xhs-profile-card').count(),1,'group filter updates the account rail immediately');assert.match(await page.locator('.xhs-account-list').innerText(),/工具分享号/);assert.equal(await page.locator('.xhs-basic-metrics strong').first().innerText(),'111','filtering does not switch the current account');
 await page.locator('#xhs-account-group-filter').selectOption('all');assert.equal(await page.locator('.xhs-profile-card').count(),2);
 await page.getByRole('button',{name:'切换到账号：工具分享号',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.xhs-basic-metrics strong')?.textContent==='222');
 assert.equal(requests.filter(r=>/\/check|\/sync|\/login/.test(r.path)).length,0,'switching only displays cached data');
 await page.getByRole('button',{name:'编辑账号备注：工具分享号',exact:true}).click();await page.locator('#xhs-account-name').fill('工具实验室');await page.locator('#xhs-account-group').fill('开发工具');await page.getByRole('button',{name:'保存备注',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#xhs-account-dialog').open);
 assert.equal(records[1].profileId,B);assert.equal(records[1].accountId,'account-b');assert.equal(records[1].accountName,'工具实验室');
 await page.getByRole('button',{name:'添加账号',exact:true}).click();await page.locator('#xhs-account-name').fill('新产品号');await page.locator('#xhs-account-group').fill('产品');await page.locator('#xhs-account-form').getByRole('button',{name:'添加账号',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#xhs-account-dialog').open);
 assert.equal(records.length,3);assert.equal(selected,C);assert.equal(requests.filter(r=>r.path==='/api/xhs/login').length,0,'adding must not launch a login browser');
 await page.getByRole('button',{name:'打开浏览器登录',exact:true}).click();assert.equal(requests.filter(r=>r.path==='/api/xhs/login').at(-1).body.profileId,C,'login routes to the captured profile');
 await page.getByRole('button',{name:'创作对话',exact:true}).click();await page.locator('#guide-xhs-auto-delivery').check();await page.locator('[data-action="guide-xhs-action"][data-kind="check"]').click();assert.equal(requests.filter(r=>r.path==='/api/xhs/check').at(-1).body.profileId,C,'an unbound profile can check its login from creation');await page.getByRole('button',{name:'小红书账号',exact:true}).click();
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'移除账号：新产品号',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.xhs-profile-card').length===2);
 assert.equal(records.length,2);assert.equal(requests.filter(r=>r.method==='DELETE').at(-1).path,'/api/xhs/accounts/'+C);
 await page.getByRole('tab',{name:'已发布',exact:true}).click();delayDetail=true;await page.locator('[data-action="xhs-detail"]').first().click();await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'切换到账号：工具实验室',exact:true}).click();await page.waitForTimeout(850);
 assert.equal(await page.locator('#xhs-detail-dialog').evaluate(el=>el.open),false);assert.ok((await page.locator('#xhs-notes-region').innerText()).includes('工具分享号专属笔记'));
 await page.getByRole('button',{name:'同步账号数据',exact:true}).click();assert.equal(requests.filter(r=>r.path==='/api/xhs/sync').at(-1).body.profileId,B);
 await page.screenshot({path:path.join(output,'accounts-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'添加账号',exact:true}).click();await page.screenshot({path:path.join(output,'account-form-mobile.png'),fullPage:true});
 const rect=await page.locator('#xhs-account-dialog').boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=390);await page.keyboard.press('Escape');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:path.join(output,'accounts-mobile.png'),fullPage:true});
 // A creation explicitly chooses A while the workspace remains on B.
 await page.setViewportSize({width:1440,height:1100});await page.getByRole('button',{name:'创作对话',exact:true}).click();await page.locator('#guide-xhs-auto-delivery').check();await page.locator('#guide-xhs-target-account').selectOption('account-a');
 assert.equal(selected,B);await page.locator('#guide-input').fill('给开发者做两张工具宣传图，你决定风格和比例，直接生成。');await page.locator('#guide-form button[type="submit"]').click();await page.locator('.guide-creation').waitFor();
 const creation=requests.find(r=>r.path==='/api/brief/create');assert.equal(creation.body.xhsAccountId,'account-a');assert.equal(creation.body.xhsAutoDelivery,true);
 assert.match(await page.locator('#guide-xhs-region').innerText(),/本次草稿账号：产品主号/);assert.ok(!(await page.locator('#guide-xhs-region').innerText()).includes('请连接原账号'));
 await page.locator('[data-action="guide-xhs-continue"]').click();assert.equal(requests.filter(r=>r.path.endsWith('/xhs-delivery')).at(-1).body.accountId,'account-a');
 await page.locator('[data-action="guide-xhs-action"][data-kind="check"]').click();const check=requests.filter(r=>r.path==='/api/xhs/check').at(-1);assert.equal(check.body.accountId,'account-a');assert.equal(check.body.profileId,A);assert.equal(selected,B);
 assert.equal(await page.locator('#guide-xhs-target-account').count(),0,'created delivery target is locked');
 await page.screenshot({path:path.join(output,'frozen-target-desktop.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['inert boot/add/switch','group filter updates rail without switching','profile-targeted login/sync','rename preserves identity','remove preserves content contract','delayed detail isolation','mobile dialog/overflow','explicit creation account','frozen A delivery with B selected','targeted A login check'],screenshots:output,requests:requests.length},null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
