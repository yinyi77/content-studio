import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Browser fixture only: never starts the account service or uses a real browser profile.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const image='/media/ui-fixture.svg';
const project={id:'project-one',title:'本平台源标题',caption:'本平台源正文，不能当作官网正文',status:'completed',pages:[{id:'page-one',title:'封面',status:'done',imageUrl:image}]};
let snapshot={connection:{state:'connected',message:'测试连接'},status:{busy:false,message:''},account:{id:'fixture-account',nickname:'工作台测试账号',followers:1234,following:26,likes:908,notesCount:2},metrics:[{id:'views7d',label:'阅读量',value:7632,period:'近7日',unit:'次'},{id:'followers7d',label:'新增粉丝',value:null,period:'近7日'}],sync:{lastSyncAt:'2026-11-10T04:00:00Z',coverage:{message:'测试覆盖',hasMore:true}},analyticsHistory:[{accountId:'fixture-account',at:'2026-11-01T01:00:00Z',account:{followers:1200}},{accountId:'fixture-account',at:'2026-11-04T01:00:00Z',account:{followers:null}},{accountId:'fixture-account',at:'2026-11-08T01:00:00Z',account:{followers:1228}},{accountId:'fixture-account',at:'2026-11-10T04:00:00Z',account:{followers:1234}},{accountId:'another-account',at:'2026-11-10T04:00:00Z',account:{followers:900000}}],notes:[{id:'note-one',accountId:'fixture-account',title:'新的笔记',publishedAt:'2026-11-09T05:00:00Z',imageUrl:image,views:235,likes:8,collects:2,comments:null},{id:'note-two',accountId:'fixture-account',title:'阅读最多的笔记',publishedAt:'2026-10-28T05:00:00Z',imageUrl:image,views:912,likes:18,collects:9,comments:0}],officialDrafts:[{key:'official-one',officialDraftId:'o1',title:'官网里的草稿',imageUrl:image,updatedAt:'2026-11-08T05:00:00Z',kind:'图文',canRead:true}],officialDraftSync:{lastSyncAt:'2026-11-10T04:00:00Z',coverage:{message:'仅电脑端'}},drafts:[{id:'submission-one',projectId:project.id,accountId:'fixture-account',title:'送稿时标题',status:'verified',canRecheck:false,createdAt:'2026-11-06T04:00:00Z',message:'电脑草稿已核验'}]};
const requests=[],cache=new Map();let delayNote=false,changeAccount=false,failNote=false;
const officialDetail=(id,title)=>({id,title,content:'来自官网的真实正文\n第二段正文',images:[image,image],tags:['产品','创作'],source:'official',isComplete:true,lastSyncAt:'2026-11-10T04:10:00Z'});
cache.set('notes/note-two',officialDetail('note-two','第二篇官方标题'));
const respond=(res,body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');let body='';for await(const chunk of req)body+=chunk;
  if(url.pathname.startsWith('/api/'))requests.push({path:url.pathname,method:req.method,query:Object.fromEntries(url.searchParams),body:body?JSON.parse(body):null});
  if(url.pathname==='/api/config')return respond(res,{config:{text:{hasKey:false},image:{hasKey:false},styles:[]}});
  if(url.pathname==='/api/projects')return respond(res,{projects:[project]});
  if(url.pathname==='/api/xhs'){
    if(changeAccount){snapshot={...snapshot,account:{...snapshot.account,id:'other-account',nickname:'其他测试账号'},notes:[],drafts:[],officialDrafts:[]};changeAccount=false;}
    return respond(res,snapshot);
  }
  if(url.pathname==='/api/xhs/submissions/submission-one')return respond(res,{detail:{title:'冻结时标题',content:'送稿时的本地冻结正文',images:[image],source:'local_submission'}});
  const match=url.pathname.match(/^\/api\/xhs\/(notes|official-drafts)\/([^/]+)$/);
  if(match&&req.method==='GET'){
    const key=`${match[1]}/${match[2]}`,value=cache.get(key)||null;
    if(failNote&&match[2]==='note-two'){failNote=false;return respond(res,{error:'测试读取暂时失败'},500);}
    if(delayNote&&match[2]==='note-one'){delayNote=false;return setTimeout(()=>respond(res,{detail:officialDetail('note-one','迟到的旧标题')}),700);}
    return respond(res,{accountId:'fixture-account',detail:value,contentStatus:{running:false,state:value?'ready':'not_fetched'}});
  }
  if(match&&req.method==='POST'){
    snapshot.status={busy:true,message:'正在读取官方内容'};
    setTimeout(()=>{cache.set(`${match[1]}/${match[2]}`,officialDetail(match[2],match[1]==='notes'?'第一篇官方标题':'官方草稿正文标题'));snapshot.status={busy:false,message:''};},80);
    return respond(res,snapshot,202);
  }
  if(req.method==='POST'&&['/api/xhs/sync','/api/xhs/official-drafts/sync'].includes(url.pathname)){
    snapshot.status={busy:true,message:'正在同步'};setTimeout(()=>{snapshot.status={busy:false,message:''};},80);return respond(res,snapshot,202);
  }
  if(req.method==='POST'&&url.pathname.endsWith('/open'))return respond(res,snapshot,202);
  if(url.pathname===image){res.writeHead(200,{'Content-Type':'image/svg+xml'});return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#eaf0f6"/><text x="40" y="160" fill="#244b76" font-size="32">Content fixture</text></svg>');}
  const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
  try{const contents=await readFile(path.join(root,'public',file));const ext=path.extname(file);res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[ext]||'application/octet-stream'});res.end(contents);}
  catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
const output=process.env.XHS_UI_OUTPUT||'/tmp/xhs-workspace-ui';await mkdir(output,{recursive:true});
try{
  await page.goto(base+'/?view=xhs');await page.getByRole('tab',{name:'账号数据'}).waitFor();
  assert.equal(requests.filter(r=>r.path.match(/\/(notes|official-drafts|submissions)\//)).length,0,'opening workspace must not read individual bodies');
  assert.equal(await page.locator('.xhs-basic-metrics > div').count(),4);
  assert.equal(await page.locator('.xhs-history-chart polyline').count(),1,'missing snapshot must split the line');
  assert.ok(!(await page.locator('.xhs-history').innerText()).includes('尚未同步'),'numeric timestamps must be formatted');
  assert.ok((await page.locator('.xhs-history').innerText()).includes('+34'),'trend excludes other accounts');
  const originalSnapshot=structuredClone(snapshot);snapshot.account.followers=0;await page.reload();await page.getByRole('tab',{name:'账号数据'}).waitFor();
  assert.equal(await page.locator('.xhs-history-chart').count(),0,'inconsistent current and same-time history values must not form a misleading chart');assert.match(await page.locator('.xhs-history').innerText(),/不一致/);
  snapshot.analyticsHistory=snapshot.analyticsHistory.map(row=>({...row,account:{followers:row.account.followers===null?null:0}}));await page.reload();await page.getByRole('tab',{name:'账号数据'}).waitFor();
  assert.equal(await page.locator('.xhs-chart-y-labels > span').last().innerText(),'0','zero follower history keeps a zero baseline');
  snapshot=originalSnapshot;await page.reload();await page.getByRole('tab',{name:'账号数据'}).waitFor();
  await page.locator('#xhs-missing-metrics summary').click();
  await page.screenshot({path:path.join(output,'analytics-desktop.png'),fullPage:true});
  await page.getByRole('tab',{name:'已发布',exact:true}).click();
  await page.locator('#xhs-note-search').fill('不存在');assert.equal(await page.locator('.xhs-note-open').count(),0);
  await page.locator('#xhs-note-search').fill('');await page.locator('#xhs-note-sort').selectOption('views');
  assert.equal(await page.locator('.xhs-note-open').first().getAttribute('data-id'),'note-two');
  await page.locator('[data-action="xhs-detail"][data-id="note-one"]').click();
  await page.locator('.xhs-detail-content').waitFor({timeout:7000});
  assert.match(await page.locator('.xhs-detail-content').innerText(),/来自官网/);
  assert.equal(await page.locator('.xhs-detail-images img').count(),2);
  assert.equal(requests.filter(r=>r.path==='/api/xhs/notes/note-one'&&r.method==='POST').length,1,'uncached body reads once');
  await page.screenshot({path:path.join(output,'note-preview-desktop.png'),fullPage:true});
  await page.keyboard.press('Escape');assert.equal(await page.locator('#xhs-detail-dialog').evaluate(el=>el.open),false);
  delayNote=true;await page.locator('[data-action="xhs-detail"][data-id="note-one"]').click();await page.keyboard.press('Escape');
  await page.locator('[data-action="xhs-detail"][data-id="note-two"]').click();await page.waitForTimeout(850);
  assert.equal(await page.locator('#xhs-detail-title').innerText(),'第二篇官方标题','late response must not replace current detail');
  await page.getByRole('button',{name:'关闭内容预览'}).click();
  await page.getByRole('tab',{name:'草稿箱',exact:true}).click();
  await page.locator('#xhs-project').selectOption(project.id);await page.locator('#xhs-title').fill('我手动修改的标题');await page.locator('#xhs-content').fill('保留这段尚未提交的正文');
  await page.locator('[data-action="xhs-official-sync"]').first().click();
  await page.waitForFunction(()=>!document.querySelector('#xhs-title').disabled,{timeout:7000});
  assert.equal(await page.locator('#xhs-title').inputValue(),'我手动修改的标题','polling preserves composer title');
  assert.equal(await page.locator('#xhs-content').inputValue(),'保留这段尚未提交的正文','polling preserves composer body');
  await page.getByRole('tab',{name:'账号数据',exact:true}).click();
  assert.equal(await page.locator('#xhs-missing-metrics').evaluate(el=>el.open),true,'polling preserves disclosure');
  await page.getByRole('tab',{name:'草稿箱',exact:true}).click();assert.equal(await page.locator('#xhs-title').inputValue(),'我手动修改的标题','tab switches preserve composer');
  await page.getByRole('button',{name:'预览本地冻结稿',exact:true}).click();await page.locator('.xhs-detail-content').waitFor();
  assert.equal(await page.locator('#xhs-detail-title').innerText(),'冻结时标题');assert.match(await page.locator('.xhs-detail-source').innerText(),/本平台冻结稿/);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'预览官方草稿',exact:true}).click();await page.locator('.xhs-detail-content').waitFor({timeout:7000});
  assert.equal(await page.locator('#xhs-detail-title').innerText(),'官方草稿正文标题');
  assert.ok(!(await page.locator('#xhs-detail-region').innerText()).includes(project.caption),'official draft cannot fall back to source project');
  await page.keyboard.press('Escape');await page.screenshot({path:path.join(output,'drafts-desktop.png'),fullPage:true});
  await page.getByRole('tab',{name:'已发布',exact:true}).click();await page.locator('#xhs-note-limit').selectOption('150');await page.getByRole('button',{name:'同步列表',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.xhs-note-toolbar button').disabled,{timeout:7000});
  assert.equal(requests.filter(r=>r.path==='/api/xhs/sync').at(-1).body.noteLimit,150);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'published-mobile.png'),fullPage:true});
  const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,nodes:[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1&&getComputedStyle(el).position!=='absolute').slice(0,12).map(el=>({tag:el.tagName,id:el.id,class:el.className,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width}))}));
  assert.ok(overflow.scroll<=overflow.width,'mobile page must not overflow horizontally: '+JSON.stringify(overflow));
  await page.locator('[data-action="xhs-detail"][data-id="note-two"]').click();await page.locator('.xhs-detail-content').waitFor();
  await page.screenshot({path:path.join(output,'preview-mobile.png'),fullPage:true});
  const dialogBox=await page.locator('#xhs-detail-dialog').boundingBox();assert.ok(dialogBox.x>=0&&dialogBox.x+dialogBox.width<=390);
  await page.mouse.click(1,1);assert.equal(await page.locator('#xhs-detail-dialog').evaluate(el=>el.open),false,'backdrop click closes');
  await page.getByRole('tab',{name:'草稿箱',exact:true}).click();await page.screenshot({path:path.join(output,'drafts-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.setViewportSize({width:1440,height:1100});
  snapshot.connection={state:'needs_attention',message:'测试需要验证'};snapshot.officialDrafts[0].canRead=false;snapshot.officialDrafts[0].contentStatus={state:'ready',lastSyncAt:'2026-11-10T04:10:00Z'};
  await page.getByRole('button',{name:'小红书账号',exact:true}).click();
  const postCount=requests.filter(r=>r.method==='POST').length;
  await page.getByRole('button',{name:'预览已读取的草稿',exact:true}).click();await page.locator('.xhs-detail-content').waitFor();
  assert.equal(await page.locator('#xhs-detail-title').innerText(),'官方草稿正文标题');
  assert.equal(requests.filter(r=>r.method==='POST').length,postCount,'disconnected cache preview must not launch a browser read');
  await page.keyboard.press('Escape');snapshot.connection={state:'connected',message:'测试恢复'};
  await page.getByRole('button',{name:'小红书账号',exact:true}).click();await page.getByRole('tab',{name:'已发布',exact:true}).click();
  failNote=true;await page.locator('[data-action="xhs-detail"][data-id="note-two"]').click();
  await page.getByRole('button',{name:'重试读取预览',exact:true}).click();await page.locator('.xhs-detail-content').waitFor();
  assert.equal(await page.locator('#xhs-detail-title').innerText(),'第二篇官方标题');
  await page.keyboard.press('Escape');
  delayNote=true;await page.locator('[data-action="xhs-detail"][data-id="note-one"]').click();changeAccount=true;
  await page.evaluate(()=>document.querySelector('#xhs-detail-dialog').close());
  // Trigger a normal snapshot refresh while the previous account's detail GET is delayed.
  await page.getByRole('button',{name:'小红书账号',exact:true}).click();await page.waitForTimeout(850);
  assert.equal(await page.locator('#xhs-detail-dialog').evaluate(el=>el.open),false);
  assert.equal(await page.locator('#xhs-title').count(),0,'account change clears old target');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks:['lazy detail reads','real history gaps/account isolation','search/sort','async detail completion','late-response protection','frozen submission separation','composer survives polling/tabs','official drafts read','noteLimit 150','mobile overflow/dialog','offline cached official preview','failed GET retry','account change'],screenshots:output,requests:requests.length},null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
