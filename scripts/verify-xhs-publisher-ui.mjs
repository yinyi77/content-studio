import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {chromium} from 'playwright-core';

// Intercept every request, including assets. Never connect to a service or platform.
const browser=await chromium.launch({
  executablePath:process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true
});
try {
  const page=await browser.newPage();
  page.setDefaultTimeout(6000);
  const accountId='xhs_account_001',draftId='draft_'+'1'.repeat(32);
  const secondId='xhs_account_002';
  const directoryRows=[
    {accountId,enabled:true,paused:false,executing:true,queuedJobs:0,needsAttention:0,publishEnabled:false,isDeliveryAccount:true},
    {accountId:secondId,nickname:'小满工具箱',platformAccountId:'platform-tools-123',loginStatus:'verified',
      identityCheckedAt:'2026-11-01T00:00:00Z',metricsSync:{status:'succeeded'},metrics:{followers:523,following:0,likesAndSaves:null,notes:18},
      enabled:true,paused:true,executing:false,queuedJobs:1,needsAttention:1,dailyLimit:3,publishEnabled:true,isDeliveryAccount:false}
  ];
  const project={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'工具笔记',caption:'产品介绍正文',status:'completed',pages:[{id:'p1',title:'封面',status:'done',imageUrl:'/media/fixture.png'}]};
  let configured=true,connected=false, currentOffset=null,submitted=false;
  const editedTitle='送稿专用标题',editedCaption='送稿时编辑的正文';
  let publishReceipt=null,publishSchedule=null,publishPosts=0,draftPosts=0,expectedIso;
  let deliveryConfiguration,creationBody;
  const metricJobId = 'job_'+'b'.repeat(32);
  let metricsPosts=0, metricJobStatus='succeeded';
  let directory=directoryRows,directoryError=false,draftReads=0;
  const secondDraftId='draft_'+'2'.repeat(32);
  const publishDraftId='draft_'+'3'.repeat(32);
  let secondDraftReads=0,holdSecondDrafts=false,releaseSecondDrafts;
  let notesError=false,holdNextNotes=false,releaseNotes,firstNotesSynced=false;
  const jobNotes='job_'+'9'.repeat(32);
  let notesSyncSubmissions=0, failNotesAcceptance=true, previousKey;
  let serviceEdits=0;
  const editJobId='job_'+'7'.repeat(32);
  const setupMessage='请将 XHS_PUBLISHER_MEDIA_BASE_URL 设为发布服务可读取的图片地址，并重启工作台。';
  const spec={style:'notion',aspect:'3:4',count:1,mode:'cards'};
  const unexpected=[],errors=[];
  page.on('pageerror',err=>errors.push(err.message));
  const snapshot=()=>!configured?{provider:'publisher',configured:false,connection:{state:'unconfigured',message:'发布服务尚未配置'},status:{busy:false},account:null,accounts:[],drafts:[]}:({
    configured:true,deliveryConfiguration,
    provider:'publisher',providerKey:'publisher:fixture',selectedProfileId:'publisher',account:{id:accountId,nickname:accountId},
    connection:{state:connected?'connected':'needs_attention',message:connected?'发布服务就绪':'等待检查服务'},
    status:{busy:false},accounts:[{accountId,profileId:'publisher',nickname:accountId,connectionState:connected?'connected':'needs_attention'}],
    drafts:submitted?[{id:'fixture-receipt',accountId,projectId:project.id,title:project.title,status:'unknown',canRecheck:true},{id:'failed-receipt',accountId,title:'失败的草稿',status:'failed',retryMode:'resubmit',canRetry:true}]:[],
    officialDrafts:currentOffset===null?[]:[{key:draftId,accountId,title:currentOffset?'历史服务草稿':'最近服务草稿',imageCount:2,phase:'ready',platformStatus:'draft_verified'}],
    officialDraftSync:currentOffset===null?{}:{lastSyncAt:'2026-11-01T00:00:00Z',coverage:{offset:currentOffset,limit:50,hasMore:currentOffset===0}}
  });
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
  const secondSnapshot=()=>({...snapshot(),providerKey:'publisher:second',account:{id:secondId,nickname:'小满工具箱'},
    deliveryConfiguration:{configured:false,canPreflight:true,message:'首次送稿时检查'},
    drafts:[{id:'second-older-receipt',accountId:secondId,title:'小满送稿记录',status:'verified'},...(publishReceipt?[publishReceipt]:[])],
    officialDrafts:secondDraftReads?[{key:secondDraftId,accountId:secondId,title:'小满专属的服务草稿',imageCount:1,phase:'ready',platformStatus:'draft_verified'}]:[],
    officialDraftSync:secondDraftReads?{lastSyncAt:'2026-11-02T00:00:00Z',coverage:{offset:0,limit:50,hasMore:false}}:{}});
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),name=url.pathname.slice(1)||'index.html';
    if(url.origin==='https://workspace.test'&&/^[\w.-]+\.(js|css|html)$/.test(name)){
      return route.fulfill({contentType:types[extname(name)],body:await readFile(new URL('../public/'+name,import.meta.url))});
    }
    if(url.origin!=='https://workspace.test'){unexpected.push(request.url());return route.abort();}
    const body=request.postDataJSON();
    if(deliveryConfiguration?.configured===false&&request.method()==='POST'&&
      (url.pathname==='/api/xhs/drafts'||/\/(retry|xhs-delivery)$/.test(url.pathname))){
      unexpected.push('只读模式触发送稿 '+url.pathname);
      return route.fulfill({status:409,json:{error:'草稿只读'}});
    }
    switch(url.pathname){
      case '/api/xhs/accounts/'+secondId+'/metrics': {
        const period=url.searchParams.get('period');
        assert.ok(period==='7d'||period==='30d');
        const sync={status:metricJobStatus,jobId:metricJobId,error:metricJobStatus==='failed'?'METRICS_PERMISSION_REQUIRED':null};
        return route.fulfill({json:{accountId:secondId,period,hasData:true,sync,lastSyncedAt:'2026-11-20T01:30:00Z',
          totals:{followers:{value:523},following:{value:0},likes_and_favorites:{value:null}},metrics:{
            views:{value:period==='7d'?32:60},cover_click_rate:{value:8.9,raw:'8.9%'},net_followers:{value:-2,comparison:-5} },
          dateRange:{start:'2026-10-24',end:'2026-11-22'}}});
      }
      case '/api/xhs/accounts/'+secondId+'/metrics/sync':
        assert.equal(request.method(),'POST');assert.ok(body.requestId);metricsPosts++;metricJobStatus='queued';
        return route.fulfill({status:202,json:{job:{accountId:secondId,jobId:metricJobId,action:'sync_metrics',status:metricJobStatus}}});
      case '/api/xhs/accounts/'+secondId+'/metrics/sync/'+metricJobId:
        assert.equal(request.method(),'GET');metricJobStatus='failed';
        return route.fulfill({json:{job:{accountId:secondId,jobId:metricJobId,action:'sync_metrics',status:metricJobStatus,error:'METRICS_PERMISSION_REQUIRED'}}});
      case '/media/fixture.png':return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')});
      case '/api/config':return route.fulfill({json:{config:{configured:true,text:{hasKey:true,baseUrl:'https://fixture.invalid',model:'fixture'},image:{hasKey:true}}}});
      case '/api/brief/chat':
        return route.fulfill({json:{analysis:'已整理需求',source:'创建一份产品介绍',recommendations:spec,preferences:spec,
          decision:{action:'generate',resolvedSpec:spec,questions:[]}}});
      case '/api/brief/create':
        creationBody=body;
        return route.fulfill({json:{project}});
      case '/api/projects':return route.fulfill({json:{projects:[project]}});
      case '/api/projects/'+project.id:return route.fulfill({json:{project}});
      case '/api/xhs': {
        const scope=url.searchParams.get('accountId');
        if(scope===secondId)return route.fulfill({json:secondSnapshot()});
        return route.fulfill({json:snapshot()});
      }
      case '/api/xhs/schedules': {
        if(request.method()==='GET'){
          assert.equal(url.searchParams.get('accountId'),secondId);
          assert.equal(url.searchParams.get('draftId'),publishDraftId);
        }else{
          assert.equal(body.accountId,secondId);assert.equal(body.expectedPlatformAccountId,directoryRows[1].platformAccountId);assert.equal(body.draftId,publishDraftId);
          assert.equal(body.expectedContentHash,'2'.repeat(64));assert.equal(body.expectedContentVersion,2);
          assert.equal(body.confirmed,true);assert.equal(body.scheduledAt,expectedIso);publishPosts++;
          const outcomes=[
            {status:'failed',message:'模拟预约失败'},
            {status:'unknown',message:'首次确认响应中断',canRecover:true},
            {status:'scheduled',message:'平台已核验预约'},
          ];
          assert.ok(outcomes[publishPosts-1],'每次提交均须显式确认');
          publishSchedule={accountId:secondId,draftId:publishDraftId,receiptId:publishReceipt.id,scheduledAt:body.scheduledAt,...outcomes[publishPosts-1]};
        }
        return route.fulfill({json:{schedule:publishSchedule}});
      }
      case '/api/xhs/official-drafts/'+publishDraftId:
        assert.equal(url.searchParams.get('accountId'),secondId);
        return route.fulfill({json:{detail:{id:publishDraftId,accountId:secondId,title:editedTitle+'新版',content:editedCaption,images:project.pages.map(p=>p.imageUrl),contentHash:'2'.repeat(64),contentVersion:2,phase:'ready',platformStatus:'draft_verified',pendingUpdate:null}}});
      case '/api/xhs/submissions/second-receipt':
        assert.equal(url.searchParams.get('accountId'),secondId);
        return route.fulfill({json:{detail:{id:publishReceipt.id,projectId:project.id,accountId:secondId,
          title:editedTitle,content:editedCaption,images:project.pages.map(p=>p.imageUrl)}}});
      case '/api/xhs/accounts':
        assert.equal(request.method(),'GET');
        if(directoryError||!configured)return route.fulfill({status:503,json:{error:'模拟账号服务暂不可用'}});
        return route.fulfill({json:{accounts:directory,fetchedAt:'2026-11-01T00:00:00Z'}});
      case '/api/xhs/accounts/'+secondId+'/notes': {
        assert.equal(request.method(),'GET');
        const offset=Number(url.searchParams.get('offset'));assert.ok([0,1].includes(offset));
        if(holdNextNotes){holdNextNotes=false;await new Promise(resolve=>{releaseNotes=resolve;});}
        if(notesError)return route.fulfill({status:502,json:{error:'模拟笔记读取失败'}});
        const rawCounts=offset?['32','17']:['1.2万','3','41',null,'0'];
        return route.fulfill({json:{items:[{title:offset?'旧的开发手记':'新的开发手记',visibility:'private',rawCounts,publishedAt:offset?null:'2026-11-01T01:00:00Z',publishedTimeText:offset?'2026-10-31':''}],
          lastSyncedAt:'2026-11-01T04:00:00Z',total:2,offset,limit:1}});
      }
      case '/api/xhs/accounts/'+accountId+'/notes':
        assert.equal(request.method(),'GET');
        return route.fulfill({json:{items:[],lastSyncedAt:firstNotesSynced?'2026-11-01T04:00:00Z':null,total:0,offset:0,limit:1}});
      case '/api/xhs/accounts/'+accountId+'/notes/sync': {
        assert.equal(request.method(),'POST');notesSyncSubmissions++;
        if(failNotesAcceptance){failNotesAcceptance=false;previousKey=body.requestId;return route.fulfill({status:502,json:{error:'同步回执超时'}});}
        assert.equal(body.requestId,previousKey);
        return route.fulfill({status:202,json:{job:{jobId:jobNotes,action:'sync_notes',accountId,status:'queued'}}});
      }
      case '/api/xhs/accounts/'+accountId+'/notes/sync/'+jobNotes:
        assert.equal(request.method(),'GET');firstNotesSynced=true;
        return route.fulfill({json:{job:{jobId:jobNotes,action:'sync_notes',accountId,status:'succeeded'}}});
      case '/api/xhs/check':connected=true;return route.fulfill({json:snapshot()});
      case '/api/xhs/official-drafts/sync':
        if(body.accountId===secondId){
          secondDraftReads++;
          if(holdSecondDrafts){holdSecondDrafts=false;await new Promise(resolve=>{releaseSecondDrafts=resolve;});}
          return route.fulfill({json:secondSnapshot()});
        }
        assert.equal(body.accountId,accountId);draftReads++;currentOffset=body.offset;return route.fulfill({json:snapshot()});
      case '/api/xhs/official-drafts/'+secondDraftId:
        assert.equal(url.searchParams.get('accountId'),secondId);
        return route.fulfill({json:{accountId:secondId,detail:{accountId:secondId,title:'小满专属的服务草稿',content:'仅小满账号的草稿正文',imageCount:1}}});
      case '/api/xhs/official-drafts/'+draftId: {
        if(request.method()==='PATCH'){
          assert.equal(body.accountId,accountId);assert.equal(body.contentVersion,1);assert.equal(body.expectedContentHash,'a'.repeat(64));
          assert.equal(body.confirmed,true);assert.deepEqual(body.changes,{caption:'修改后的正文'});serviceEdits++;
          return route.fulfill({status:202,json:{accountId,draftId,jobId:editJobId,contentVersion:2,status:'queued'}});
        }
        assert.equal(request.method(),'GET');assert.equal(url.searchParams.get('accountId'),accountId);
        const version=serviceEdits?2:1,contentHash=(serviceEdits?'b':'a').repeat(64);
        return route.fulfill({json:{accountId,detail:{id:draftId,accountId,title:'草稿详情',content:serviceEdits?'修改后的正文':'服务返回的正文',
          imageCount:2,images:[],phase:'ready',platformStatus:'draft_verified',editable:true,contentVersion:version,contentHash,
          activeJobId:serviceEdits?editJobId:null,pendingUpdate:null,
          editJob:serviceEdits?{id:editJobId,status:'succeeded',contentVersion:2,contentHash}:null}}});
      }
      case '/api/xhs/drafts':
        if(body.accountId===secondId){
          assert.equal(body.expectedPlatformAccountId,directoryRows[1].platformAccountId);assert.equal(body.projectId,project.id);assert.equal(body.title,editedTitle);assert.equal(body.content,editedCaption);draftPosts++;
          publishReceipt={id:'second-receipt',remoteDraftId:publishDraftId,accountId:secondId,projectId:project.id,title:editedTitle,
            status:'verified',contentVersion:1,contentHash:'1'.repeat(64)};
          return route.fulfill({json:{draft:publishReceipt}});
        }
        assert.equal(body.accountId,accountId);assert.equal(body.content,project.caption);submitted=true;
        return route.fulfill({json:{snapshot:snapshot(),draft:{status:'unknown'}}});
      case '/api/xhs/submissions/fixture-receipt':
        assert.equal(request.method(),'GET');assert.equal(url.searchParams.get('accountId'),accountId);
        return route.fulfill({json:{detail:{title:project.title,content:'本地保留的正文'}}});
      case '/api/xhs/drafts/fixture-receipt/recheck':
        assert.equal(body.accountId,accountId);
        return route.fulfill({json:{snapshot:snapshot(),draft:{status:'unknown'}}});
      default:unexpected.push(request.method()+' '+url.pathname);return route.fulfill({status:404,json:{error:'fixture route missing'}});
    }
  });
  const openAccount=id=>page.locator('[data-action="xhs-account-open"][data-id="'+id+'"]').first().click();
  const selectTab=tab=>page.locator('[data-action="xhs-account-tab"][data-tab="'+tab+'"]').click();
  const backToAccounts=()=>page.locator('[data-action="xhs-account-list"]').first().click();
  const refreshDirectory=()=>page.locator('[data-action="xhs-accounts-refresh"]').first().click();
  await page.goto('https://workspace.test/?view=xhs&accountId=unknown&tab=drafts');
  await page.getByRole('heading',{name:'该账号不在当前服务列表中'}).waitFor();
  assert.equal(await page.locator('#xhs-composer-disclosure,[data-action="xhs-official-sync"]').count(),0);
  await backToAccounts();
  await page.locator('[data-action="xhs-account-open"][data-id="'+accountId+'"]').first().waitFor();
  assert.equal(await page.getByRole('button',{name:'添加账号'}).count(),0);
  assert.equal(await page.locator('#xhs-composer-disclosure').count(),0);
  const table=page.locator('.xhs-accounts-table');
  const rowFor=id=>table.getByRole('row').filter({has:page.locator('[data-action="xhs-account-open"][data-id="'+id+'"]')});
  const headers=await table.getByRole('columnheader').allTextContents();
  for(const label of ['小红书用户名','粉丝数','关注数','获赞与收藏','笔记数','登录状态','任务状态','操作'])assert.ok(headers.includes(label),label);
  const listMetric=(id,label)=>rowFor(id).getByRole('cell').nth(headers.indexOf(label)).innerText();
  const nickname=directoryRows[1].nickname;
  const expectedMetrics={'粉丝数':'523','关注数':'0','获赞与收藏':'—','笔记数':'18'};
  await rowFor(secondId).getByText(nickname,{exact:true}).waitFor();
  await rowFor(secondId).getByText('已核验',{exact:true}).waitFor();
  await rowFor(accountId).getByText('用户名未提供',{exact:true}).waitFor();
  const pausedSummary=await listMetric(secondId,'任务状态');
  for(const status of ['已暂停','排队 1','待核对 1'])assert.ok(pausedSummary.includes(status),status);
  const executingSummary=await listMetric(accountId,'任务状态');
  assert.match(executingSummary,/执行中|正在执行/);
  assert.doesNotMatch(executingSummary,/已暂停|待核对 1/);
  for(const [label,value] of Object.entries(expectedMetrics)){
    assert.equal(await listMetric(secondId,label),value);
    assert.equal(await listMetric(accountId,label),'—');
  }
  const search=page.locator('#xhs-account-search');
  for(const query of ['小满','PLATFORM-TOOLS-123',secondId]){
    await search.fill(query);
    assert.equal(await rowFor(accountId).count(),0);
    await rowFor(secondId).waitFor();
  }
  await search.fill('');
  const desktopSize=page.viewportSize();
  await page.setViewportSize({width:390,height:844});
  const fitsMobile=await table.evaluate(el=>{
    const viewport=document.documentElement.clientWidth;
    return [...el.querySelectorAll('tbody td')].every(cell=>{
      const bounds=cell.getBoundingClientRect();
      return bounds.width>0&&bounds.left>=0&&bounds.right<=viewport+1;
    });
  });
  assert.ok(fitsMobile,'账号列表各列应在手机视口内');
  await page.setViewportSize(desktopSize);
  await openAccount(secondId);
  await page.getByRole('heading',{name:nickname,exact:true}).waitFor();
  await page.getByRole('heading',{name:'账号指标'}).waitFor();
  const detail=page.getByRole('tabpanel');
  for(const [label,value] of Object.entries(expectedMetrics)){
    const metric=detail.locator('.xhs-basic-metrics > div').filter({has:page.getByText(label,{exact:true})});
    assert.equal(await metric.locator('strong').innerText(),value);
  }
  const taskConfig=detail.getByRole('region',{name:'任务与配置',exact:true});
  const metricsPanel=detail.getByRole('region',{name:'周期指标',exact:true});
  await metricsPanel.getByText('32',{exact:true}).waitFor();
  await metricsPanel.getByRole('button',{name:'近 30 天'}).click();
  await metricsPanel.getByText('60',{exact:true}).waitFor();
  await metricsPanel.getByText('8.9%',{exact:true}).waitFor();
  assert.equal(metricsPosts,0);
  await metricsPanel.getByRole('button',{name:'同步指标'}).click();
  await metricsPanel.getByText(/指标同步已排队/).waitFor();
  await metricsPanel.getByText(/账号的数据看板尚未开放权限/).waitFor();
  await metricsPanel.getByText('60',{exact:true}).waitFor();
  assert.equal(metricsPosts,1);
  const taskValue=label=>taskConfig.locator('dt').filter({hasText:new RegExp('^'+label+'$')}).locator('xpath=following-sibling::dd[1]').innerText();
  for(const label of ['账号启用','任务暂停','正在执行','排队任务','待人工核对','预约发布','每日限额']){
    assert.ok((await taskValue(label)).trim(),label);
  }
  assert.match(await taskValue('排队任务'),/^1\D*$/);
  assert.match(await taskValue('待人工核对'),/^1\D*$/);
  assert.match(await taskValue('每日限额'),/^3\D*$/);
  await selectTab('published');
  const published=page.getByRole('region',{name:'已发布笔记',exact:true});
  await published.getByText('新的开发手记',{exact:true}).waitFor();
  const noteHeaders=['笔记标题','发布时间','可见范围','浏览','点赞','评论','收藏','分享'];
  const publishedHeaders=published.getByRole('columnheader');
  assert.deepEqual(await publishedHeaders.allTextContents(),noteHeaders);
  await published.getByText('仅自己可见').waitFor();
  const newNoteCells=published.getByRole('row').filter({hasText:'新的开发手记'}).getByRole('cell');
  assert.deepEqual((await newNoteCells.allInnerTexts()).slice(2),['1.2万','41','3','—','0']);
  await published.getByRole('button',{name:'下一页'}).click();
  await published.getByText('旧的开发手记',{exact:true}).waitFor();
  await published.getByText('2026-10-31',{exact:true}).waitFor();
  assert.deepEqual(await publishedHeaders.allTextContents(),[...noteHeaders,'原始计数']);
  const olderNoteCells=published.getByRole('row').filter({hasText:'旧的开发手记'}).getByRole('cell');
  assert.deepEqual((await olderNoteCells.allInnerTexts()).slice(2,7),['—','—','—','—','—']);
  const originalCounts=olderNoteCells.last();
  await originalCounts.locator('summary').click();
  assert.match(await originalCounts.innerText(),/32[\s\S]*17/);
  assert.equal(notesSyncSubmissions,0);
  notesError=true;
  await published.getByRole('button',{name:'刷新列表'}).click();
  await published.getByRole('alert').getByText('模拟笔记读取失败').waitFor();
  notesError=false;
  await published.getByRole('button',{name:'重试'}).click();
  await published.getByText('旧的开发手记',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('accountId'),secondId);
  assert.equal(new URL(page.url()).searchParams.get('tab'),'published');
  await selectTab('drafts');
  await page.getByRole('button',{name:'小满专属的服务草稿'}).click();
  await page.getByText('仅小满账号的草稿正文').waitFor();
  await page.getByRole('button',{name:'关闭内容预览'}).click();
  await page.goBack();
  await page.getByRole('heading',{name:'已发布笔记',exact:true}).waitFor();
  await page.goForward();
  await page.getByRole('button',{name:'小满专属的服务草稿'}).waitFor();
  await page.getByRole('button',{name:'平台送稿记录'}).click();
  await page.locator('#xhs-submissions-region').getByText('小满送稿记录').waitFor();
  assert.equal(secondDraftReads,1);
  assert.equal(draftReads,0);
  await backToAccounts();
  await openAccount(secondId);
  await selectTab('published');
  await published.getByText('新的开发手记',{exact:true}).waitFor();
  holdNextNotes=true;
  await Promise.all([page.waitForRequest(req=>req.url().includes(secondId+'/notes')),published.getByRole('button',{name:'刷新列表'}).click()]);
  await backToAccounts();
  await openAccount(accountId);
  await selectTab('published');
  await published.getByText('该账号尚未同步笔记。').waitFor();
  await Promise.all([page.waitForResponse(res=>res.url().includes(secondId+'/notes')),Promise.resolve().then(()=>releaseNotes())]);
  assert.equal(notesSyncSubmissions,0);
  await published.getByRole('button',{name:'同步小红书笔记'}).click();
  await published.getByText('同步回执超时').waitFor();
  await published.getByRole('button',{name:'重试本次同步'}).click();
  await published.getByText('同步已排队。').waitFor();
  await published.getByText('最近同步的记录中没有已发布笔记。').waitFor();
  assert.equal(notesSyncSubmissions,2,'recovery reuses the existing request id');
  assert.equal(await published.getByText('新的开发手记',{exact:true}).count(),0);
  await backToAccounts();
  directoryError=true;
  await refreshDirectory();
  await page.getByText('模拟账号服务暂不可用',{exact:false}).first().waitFor();
  directoryError=false;directory=[];
  await refreshDirectory();
  await page.getByRole('heading',{name:'暂无已配置账号'}).waitFor();
  directory=directoryRows;
  await refreshDirectory();
  await openAccount(accountId);
  await selectTab('overview');
  assert.match(await taskValue('排队任务'),/^0\D*$/);
  assert.match(await taskValue('待人工核对'),/^0\D*$/);
  assert.equal(await taskValue('每日限额'),'—');
  await Promise.all([page.waitForResponse(res=>res.url().endsWith('/api/xhs/check')),
    page.getByRole('button',{name:'检查服务'}).click()]);
  assert.equal(await page.locator('[data-kind="login"],[data-kind="open-drafts"],[data-kind="sync"]').count(),0);
  await selectTab('drafts');
  await page.locator('#xhs-page').getByText('发布服务就绪',{exact:true}).waitFor();
  await page.getByRole('button',{name:'最近服务草稿'}).click();
  assert.equal(draftReads,1);
  await page.getByText('服务返回的正文').waitFor();
  await page.getByRole('button',{name:'修改这份草稿'}).click();
  const editor=page.locator('#xhs-draft-editor');
  await editor.getByLabel('配图',{exact:true}).selectOption('project');
  await editor.getByLabel('选择配图作品').selectOption(project.id);
  assert.equal(await editor.getByAltText('配图 1').getAttribute('src'),project.pages[0].imageUrl);
  await editor.getByLabel('配图',{exact:true}).selectOption('keep');
  await editor.getByLabel('正文',{exact:true}).fill('修改后的正文');
  assert.equal(serviceEdits,0);
  await editor.getByRole('button',{name:'确认修改这份草稿'}).click();
  await page.getByText('微服务已核验本次修改。').waitFor();
  await page.getByText('修改后的正文',{exact:true}).waitFor();
  assert.equal(serviceEdits,1);
  assert.equal(await page.locator('[data-action="xhs-detail-read"],[data-action="xhs-official-open"]').count(),0);
  await page.getByRole('button',{name:'关闭内容预览'}).click();
  await page.getByRole('button',{name:'下一页'}).click();
  await page.getByRole('button',{name:'历史服务草稿'}).waitFor();
  assert.equal(currentOffset,50);
  const readsAfterPaging=draftReads;
  await backToAccounts();
  await openAccount(secondId);
  await selectTab('drafts');
  assert.equal(await page.getByRole('button',{name:'历史服务草稿'}).count(),0);
  assert.equal(draftReads,readsAfterPaging);
  await page.reload();
  await page.locator('[data-action="xhs-account-list"]').first().waitFor();
  await page.getByRole('button',{name:'小满专属的服务草稿'}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('accountId'),secondId);
  assert.equal(new URL(page.url()).searchParams.get('tab'),'drafts');
  assert.equal(await page.getByRole('button',{name:'历史服务草稿'}).count(),0);
  assert.equal(draftReads,readsAfterPaging);
  holdSecondDrafts=true;
  const lateResponse=page.waitForResponse(res=>res.url().endsWith('/api/xhs/official-drafts/sync')&&res.request().postDataJSON().accountId===secondId);
  await Promise.all([page.waitForRequest(req=>req.url().endsWith('/api/xhs/official-drafts/sync')),page.getByRole('button',{name:'读取服务草稿'}).click()]);
  await backToAccounts();
  await openAccount(accountId);
  await selectTab('drafts');
  await page.getByRole('button',{name:'历史服务草稿'}).waitFor();
  releaseSecondDrafts();await lateResponse;
  assert.equal(await page.getByRole('button',{name:'小满专属的服务草稿'}).count(),0);
  await page.locator('#xhs-composer-disclosure > summary').click();
  await page.locator('#xhs-project').selectOption(project.id);
  await page.locator('#xhs-content').fill('');
  assert.equal(await page.locator('#xhs-submit-draft').isDisabled(),true);
  await page.locator('#xhs-content').fill(project.caption);
  await page.locator('#xhs-submit-draft').click();
  await page.getByRole('button',{name:'查询任务结果'}).click();
  assert.equal(submitted,true);
  await page.getByRole('button',{name:'重新提交原请求'}).waitFor();
  await backToAccounts();
  await openAccount(secondId);
  await selectTab('drafts');
  await page.getByRole('button',{name:'小满专属的服务草稿'}).waitFor();
  await page.getByRole('link',{name:'图文工坊首页'}).click();
  await page.locator('#guide-delivery-settings > summary').click();
  await page.locator('#guide-xhs-region').getByText('送稿账号 · '+accountId).waitFor();
  await page.locator('#guide-xhs-auto-delivery').check();
  assert.equal(await page.locator('#guide-xhs-region [data-kind="login"],#guide-xhs-region [data-kind="open-drafts"]').count(),0);
  await page.evaluate(({accountId,projectId})=>{
    sessionStorage.setItem('content-studio:briefing:v1',JSON.stringify({
      xhsTargetAccountId:accountId,messages:[],
      creation:{requestId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',projectId,status:'completed'}
    }));
  },{accountId,projectId:project.id});
  await page.reload();
  await page.locator('.guide-local-draft').getByRole('button',{name:'选择账号并发布'}).click();
  const publishDialog=page.getByRole('dialog',{name:'发送到小红书'});
  const choose=publishDialog.getByLabel('目标账号');
  const assignedDraft=publishDialog.getByRole('button',{name:'存入所选账号草稿箱'});
  await choose.selectOption(secondId);
  await publishDialog.getByText('账号已停用或暂停，暂时无法送稿。').waitFor();
  assert.equal(await assignedDraft.isDisabled(),true);
  await publishDialog.getByRole('button',{name:'关闭'}).click();
  directoryRows[1].paused=false;
  await page.locator('.guide-local-draft').getByRole('button',{name:'选择账号并发布'}).click();
  await choose.selectOption(secondId);
  await assignedDraft.waitFor();
  await publishDialog.getByText('检查标题、正文和配图').click();
  await publishDialog.getByLabel('帖子标题').fill(editedTitle);
  await publishDialog.getByLabel('帖子正文').fill(editedCaption);
  await assignedDraft.click();
  await publishDialog.getByText('服务草稿 · 第 2 版').waitFor();
  const beijingInput=new Date(Date.now()+2*86400000+8*3600000).toISOString().slice(0,16);
  expectedIso=new Date(beijingInput+':00+08:00').toISOString();
  await publishDialog.locator('#publish-time').fill(beijingInput);
  await publishDialog.getByRole('button',{name:'核对发布时间'}).click();
  await publishDialog.getByText('确认这次定时发布').waitFor();
  assert.equal(publishPosts,0);
  await choose.selectOption(accountId);
  await assignedDraft.waitFor();
  assert.equal(await publishDialog.getByRole('button',{name:'确认定时发布'}).count(),0);
  await choose.selectOption(secondId);
  await publishDialog.getByText('服务草稿 · 第 2 版').waitFor();
  await publishDialog.locator('#publish-time').fill(beijingInput);
  await publishDialog.getByRole('button',{name:'核对发布时间'}).click();
  await publishDialog.getByRole('button',{name:'确认定时发布'}).click();
  await publishDialog.getByText('模拟预约失败').waitFor();
  await publishDialog.getByRole('button',{name:'重新选择时间'}).click();
  await publishDialog.getByText('原预约 · 预约失败',{exact:false}).waitFor();
  const retryTime=new Date(Date.now()+3*86400000+8*3600000).toISOString().slice(0,16);
  expectedIso=new Date(retryTime+':00+08:00').toISOString();
  await publishDialog.locator('#publish-time').fill(retryTime);
  await publishDialog.getByRole('button',{name:'核对发布时间'}).click();
  assert.equal(publishPosts,1);
  await publishDialog.getByRole('button',{name:'确认定时发布'}).click();
  await publishDialog.getByText('首次确认响应中断').waitFor();
  await publishDialog.getByRole('button',{name:'刷新预约状态'}).click();
  await publishDialog.getByRole('button',{name:'找回原预约'}).click();
  assert.equal(publishPosts,2);
  await publishDialog.getByRole('button',{name:'确认找回原预约'}).click();
  await publishDialog.getByText('平台已核验预约').waitFor();
  assert.equal(publishPosts,3);assert.equal(draftPosts,1);
  await publishDialog.getByRole('button',{name:'关闭'}).click();
  await page.goto('https://workspace.test/?view=history');
  await page.getByRole('button',{name:'选择账号并发布'}).click();
  await choose.selectOption(secondId);
  await publishDialog.getByLabel('送稿版本').selectOption('second-receipt');
  await publishDialog.getByText('平台已核验预约').waitFor();
  assert.equal(await publishDialog.getByLabel('帖子标题').inputValue(),editedTitle+'新版');
  assert.equal(await publishDialog.getByLabel('帖子正文').inputValue(),editedCaption);
  assert.equal(await publishDialog.getByAltText('第 1 张配图').getAttribute('src'),project.pages[0].imageUrl);
  assert.equal(publishPosts,3);assert.equal(draftPosts,1);
  await publishDialog.getByRole('button',{name:'关闭'}).click();
  project.xhsDelivery={enabled:true,accountId,status:'running',draftId:'old-provider-task',canContinue:false,canRecheck:false};
  await page.goto('https://workspace.test/?view=briefing');
  await page.getByText('原连接送稿记录',{exact:true}).waitFor();
  await page.getByRole('button',{name:'选择现在的账号送稿'}).waitFor();
  assert.equal(await page.locator('[data-action="guide-xhs-recheck"]').count(),0);
  // Switch an already open composer to read-only on a fresh snapshot.
  await page.goto('https://workspace.test/?view=xhs');
  await openAccount(accountId);
  await selectTab('drafts');
  await page.locator('#xhs-composer-disclosure > summary').click();
  await page.locator('#xhs-project').selectOption(project.id);
  deliveryConfiguration={configured:false,message:setupMessage};
  await page.getByRole('button',{name:'检查服务'}).click();
  await page.locator('#xhs-page').getByText(setupMessage,{exact:false}).first().waitFor();
  assert.equal(await page.locator('#xhs-project,#xhs-submit-draft').count(),0);
  await page.getByRole('button',{name:'读取服务草稿'}).click();
  await page.getByRole('button',{name:'最近服务草稿'}).click();
  await page.getByText('修改后的正文',{exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭内容预览'}).click();
  await page.getByRole('button',{name:'平台送稿记录'}).click();
  assert.equal(await page.locator('[data-action="xhs-retry"]').count(),0);
  await page.locator('[data-kind="submission"][data-id="fixture-receipt"]').click();
  await page.getByText('本地保留的正文').waitFor();
  await page.getByRole('button',{name:'关闭内容预览'}).click();
  const recheckPath='/api/xhs/drafts/fixture-receipt/recheck';
  await Promise.all([page.waitForResponse(res=>res.url().endsWith(recheckPath)),
    page.getByRole('button',{name:'查询任务结果'}).click()]);

  project.xhsDelivery={enabled:true,accountId,providerKey:'publisher:fixture',status:'blocked',draftId:'fixture-receipt',canContinue:true};
  await page.goto('https://workspace.test/?view=briefing');
  await page.locator('.guide-xhs-delivery').getByText(setupMessage).waitFor();
  assert.equal(await page.locator('[data-action="guide-xhs-continue"]').count(),0);
  await Promise.all([page.waitForResponse(res=>res.url().endsWith(recheckPath)),
    page.getByRole('button',{name:'查询任务结果'}).click()]);
  project.xhsDelivery={...project.xhsDelivery,status:'verified',versionChanged:true};
  await page.reload();
  await page.locator('.guide-xhs-delivery').getByText(setupMessage).waitFor();
  assert.equal(await page.locator('[data-action="guide-xhs-version"]').count(),0);

  // Restore a pre-existing automatic-delivery preference and start a new creation.
  delete project.xhsDelivery;
  await page.evaluate(()=>sessionStorage.setItem('content-studio:briefing:v1',
    JSON.stringify({messages:[],targetPlatform:'xhs',xhsAutoDelivery:true})));
  await page.reload();
  await page.locator('#guide-delivery-settings > summary').click();
  await page.locator('#guide-xhs-region').getByText(setupMessage,{exact:false}).waitFor();
  assert.equal(await page.locator('#guide-xhs-auto-delivery').count(),0);
  assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('content-studio:briefing:v1')).xhsAutoDelivery),false);
  await page.locator('#guide-input').fill('创建一份产品介绍');
  await page.locator('#guide-form button[type="submit"]').click();
  await page.locator('.guide-local-draft').getByText(setupMessage).waitFor();
  assert.equal(await page.locator('[data-action="guide-xhs-first"]').count(),0);
  assert.equal(creationBody.targetPlatform,'xhs');
  assert.equal(creationBody.xhsAutoDelivery,false);
  assert.equal(Object.hasOwn(creationBody,'xhsAccountId'),false);

  configured=false;
  await page.goto('https://workspace.test/?view=xhs');
  await page.getByRole('heading',{name:'配置小红书发布服务'}).waitFor();
  assert.equal(await page.locator('[data-action="xhs-official-sync"],#xhs-project,[data-action="xhs-check-service"]').count(),0);
  await page.goto('https://workspace.test/?view=briefing');
  await page.locator('#guide-delivery-settings > summary').click();
  await page.getByRole('button',{name:'查看接入说明'}).waitFor();
  assert.equal(await page.locator('#guide-xhs-auto-delivery').count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  console.log('Verified account list, scoped account details, draft handoff and chat using intercepted requests.');
} finally {
  await browser.close();
}
