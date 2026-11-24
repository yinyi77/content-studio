import assert from 'node:assert/strict';
import test from 'node:test';
import { draftVersionDetails, editPublisherDraft } from '../lib/xhs-draft-edit.mjs';

const accountId = 'test_account', platformId = 'xhs-100';
const key = 'draft_' + 'a'.repeat(32), editJob = 'job_' + 'b'.repeat(32);
const hash = 'c'.repeat(64);
function sample() {
  const snapshot = { draft_id: key, account_id: accountId, content_version: 1, content_hash: hash, phase:'ready',
    platform_status:'draft_verified', pending_update:null, editable:true, title:'标题', caption:'旧正文' };
  const response = { job_id:editJob, draft_id:key, account_id:accountId, action:'update_draft', status:'queued', base_version:1, content_version:2 };
  const writes = [];
  const account = { accountId, target:({accountId:id})=>assert.equal(id,accountId),
    ensureReady:()=>platformId, client:{ request(path,options={}) {
      if(options.method==='PATCH'){assert.equal(path,'/v1/drafts/'+key);writes.push(options);return response;}
      assert.equal(path,'/v1/drafts/'+key+'?account_id='+accountId);return snapshot;
    } } };
  const input={ accountId, expectedPlatformAccountId:platformId, confirmed:true, contentVersion:1,
    expectedContentHash:hash, changes:{caption:'新正文'} };
  return { account,input,snapshot,response,writes };
}
test('editor patches only supplied metadata; identical retries use the same upstream key', async()=>{
  const {account,input,writes}=sample();
  const first=await editPublisherDraft(account,key,input);
  assert.equal(first.status,'queued');assert.equal(first.contentVersion,2);assert.equal(first.jobId,editJob);
  assert.deepEqual(writes[0].body,{account_id:accountId,content_version:1,content:{caption:'新正文'}});
  await editPublisherDraft(account,key,{...input});
  assert.deepEqual(writes[0],writes[1]);
  await editPublisherDraft(account,key,{...input,changes:{image_urls:['https://media.invalid/b','https://media.invalid/a']}});
  assert.deepEqual(writes[2].body.content,{image_urls:['https://media.invalid/b','https://media.invalid/a']});
  assert.notEqual(writes[2].idempotencyKey,writes[0].idempotencyKey);
});
test('unapproved, stale, rebound, busy and malformed edits cannot reach the worker', async()=>{
  const {account,input,snapshot,writes}=sample();
  for(const changes of [{title:' '},{image_urls:[]},{caption:'X'.repeat(1001)},{image_urls:['file:///secret']},{bad:1},{caption:'旧正文'}]){
    await assert.rejects(editPublisherDraft(account,key,{...input,changes}),{status:400});
  }
  for(const overrides of [{confirmed:false},{contentVersion:2},{expectedContentHash:'a'.repeat(64)},{expectedPlatformAccountId:'another'}]){
    await assert.rejects(editPublisherDraft(account,key,{...input,...overrides}));
  }
  for(const [k,v] of [['account_id','other_account'],['draft_id','draft_'+'e'.repeat(32)],['phase','scheduled'],['editable',false],['pending_update',{}],['content_hash','d'.repeat(64)]]){
    const original=snapshot[k];snapshot[k]=v;await assert.rejects(editPublisherDraft(account,key,input));snapshot[k]=original;
  }
  assert.equal(writes.length,0);
});
test('versioned images and history use only local account-scoped authenticated image routes', ()=>{
  const {snapshot}=sample();
  const image={position:1,url:'/v1/drafts/'+key+'/images/1?content_version=1'};
  const details=draftVersionDetails({...snapshot,content_version:2,images:[image],versions:[{content_version:1,title:'第一版',images:[image]}]},accountId);
  assert.equal(details.editable,true);
  assert.equal(details.images[0],'/api/xhs/official-drafts/'+key+'/images/1?accountId='+accountId+'&contentVersion=2');
  assert.equal(details.versions[0].images[0],'/api/xhs/official-drafts/'+key+'/images/1?accountId='+accountId+'&contentVersion=1');
  assert.deepEqual(draftVersionDetails({...snapshot,images:[{position:2,url:image.url}]},accountId).images,[]);
});

test('selecting workbench pictures reuses frozen LAN URLs on concurrent retries and restart', async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const path=await import('node:path');
  const {Storage}=await import('../lib/storage.mjs');
  const {XhsPublisherDelivery}=await import('../lib/xhs-publisher-delivery.mjs');
  const dir=await mkdtemp(path.join(tmpdir(),'xhs-edit-images-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new Storage(dir);
  const projectId='751d88a5-3f41-45ad-a682-e2e29a0b49ef';
  const name=projectId+'-'+projectId+'.png';
  const expectedImages=['/media/'+projectId+'/'+name];
  const prepared={accountId,projectId,title:'标题',content:'新正文',fingerprint:hash,
    imageHashes:[hash],images:[path.join(dir,'projects',projectId,'images',name)]};
  let creates=0,renewals=0;
  const lanMedia={async createUrls(){return ['http://worker-media.invalid/batch-'+ (++creates) +'/1.png'];},async renewUrls(urls){renewals++;return urls;}};
  const open=()=>new XhsPublisherDelivery({dir,accountId,lanMedia,client:{baseUrl:'http://publisher.invalid'}});
  const options={store,draftId:key,version:1,expectedImages};
  const {account,input,writes}=sample();
  account.preflight=()=>platformId;
  let delivery=open();
  const request={...input,imageProject:{id:projectId,images:expectedImages},changes:{}};
  await Promise.all([1,2].map(()=>editPublisherDraft(account,key,request,()=>delivery.prepareEditImages(prepared,options))));
  delivery=open();
  await editPublisherDraft(account,key,request,()=>delivery.prepareEditImages(prepared,options));
  assert.deepEqual(writes[0],writes[1]);assert.deepEqual(writes[0],writes[2]);
  assert.equal(creates,1);assert.equal(renewals,2);
  await assert.rejects(delivery.prepareEditImages(prepared,{...options,expectedImages:['/media/stale']}),{status:409});
  assert.equal(creates,1);
});
