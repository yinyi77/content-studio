import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat, readdir, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { XhsMediaCache, normalizeXhsImageUrl } from '../lib/xhs-media.mjs';

// Tiny images were generated locally. Tests never read the user's browser,
// contact a remote host, or use production account records.
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWQAAAAASUVORK5CYII=','base64');
const JPEG=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDgKKKK9w8s/9k=','base64');
const WEBP=Buffer.from('UklGRjYAAABXRUJQVlA4ICoAAACQAQCdASoCAAIAAUAmJZgCdLoAA5gA/vY/3/4ILaj0w6UP43m81qxAAAA=','base64');
const id='fixture_account-1',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const name=(bytes=PNG,extension='png')=>`${sha(bytes)}.${extension}`;
const asset=(index=0,bytes=PNG,mime='image/png')=>({index,mime,base64:bytes.toString('base64')});
const detail=(assets=[asset()])=>({id:'draft-1',title:'官方草稿',content:'从官方页面读取的正文',images:assets.map(()=>null),imageAssets:assets,isComplete:true});
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'content-studio-xhs-media-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,store:new XhsMediaCache({dir})};}

// Add a legal private ancillary chunk to exercise byte limits without huge
// image dimensions or a dependency on an image encoding package.
function paddedPng(length){
  const data=Buffer.alloc(length-PNG.length-12),tag=Buffer.from('npAD'),chunk=Buffer.alloc(data.length+12);chunk.writeUInt32BE(data.length);tag.copy(chunk,4);data.copy(chunk,8);
  let crc=0xffffffff;for(const byte of Buffer.concat([tag,data])){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
  return Buffer.concat([PNG.subarray(0,-12),chunk,PNG.subarray(-12)]);
}

test('blob image slots become private account-scoped PNG/JPEG/WebP assets and survive restart',async t=>{
  const {dir,store}=await fixture(t),input=detail([asset(),asset(1,JPEG,'image/jpeg'),asset(2,WEBP,'image/webp')]);input.images[0]='blob:https://creator.xiaohongshu.com/not-persistable';
  const original=structuredClone(input),result=await store.materialize(input,{accountId:id});
  assert.deepEqual(input,original,'materialization must not mutate browser detail');
  assert.deepEqual(result.images,[name(PNG,'png'),name(JPEG,'jpg'),name(WEBP,'webp')].map(file=>`/media/xhs/${id}/${file}`));
  assert.equal(result.isComplete,true);assert.equal(result.title,input.title);assert.equal(result.content,input.content);
  assert.ok(!Object.hasOwn(result,'imageAssets'));assert.ok(!JSON.stringify(result).includes('base64'));assert.ok(!JSON.stringify(result).includes(dir));assert.ok(!JSON.stringify(result).includes('blob:'));
  const restarted=new XhsMediaCache({dir});
  for(const [index,bytes,mime] of [[0,PNG,'image/png'],[1,JPEG,'image/jpeg'],[2,WEBP,'image/webp']]){
    const file=result.images[index].split('/').at(-1),image=await restarted.read(id,file);assert.deepEqual(image,{bytes,mime});
    assert.equal((await lstat(path.join(dir,'xhs-media',id,file))).mode&0o777,0o600);
  }
  assert.equal((await restarted.materialize(result,{accountId:id})).isComplete,true,'already materialized slots remain readable');
  await assert.rejects(restarted.read('another-account',name()),error=>error.status===404&&!error.message.includes(dir));
  assert.equal(normalizeXhsImageUrl(result.images[0],{accountId:'another-account'}),'');
});

test('image URL normalization restricts hosts/accounts and removes secret query values',()=>{
  const good='https://sns-webpic-qc.xhscdn.com/image.png?width=800&token=secret&xsec_token=abc&auth=abc&signature=abc&api_key=abc&session_id=abc#fragment';
  assert.equal(normalizeXhsImageUrl(good,{accountId:id}),'https://sns-webpic-qc.xhscdn.com/image.png?width=800');
  assert.equal(normalizeXhsImageUrl('http://sns-img.xhscdn.com/p.png'), 'https://sns-img.xhscdn.com/p.png');
  assert.equal(normalizeXhsImageUrl('https://creator.xiaohongshu.com/p.png?%74oken=abc&h=42'),'https://creator.xiaohongshu.com/p.png?h=42');
  const local=`/media/xhs/${id}/${name()}`;assert.equal(normalizeXhsImageUrl(local,{accountId:id}),local);
  for(const url of ['https://evil.test/p.png','http://127.0.0.1/p.png','https://xhscdn.com.evil.test/a','https://evilxhscdn.com/a','https://u:p@xhscdn.com/a','https://xhscdn.com:8443/a','file:///etc/passwd','data:image/png;base64,AAAA','blob:https://creator.xiaohongshu.com/a','//sns-img.xhscdn.com/a','https://xhscdn.com./a',`/media/xhs/another-account/${name()}`,local+'?x=1',local+'#x',local.replace('/'+id+'/', '/'+encodeURIComponent(id)+'/../'),local.replace('.png','.svg'),'/media/xhs/../'+name(),'/media/xhs/'+id+'/'+name().replace('.png','%2epng')])assert.equal(normalizeXhsImageUrl(url,{accountId:id}),'',url);
});

test('unsafe or missing image slots stay partial instead of promoting a cover to a complete set',async t=>{
  const {store}=await fixture(t);
  const result=await store.materialize({title:'正文仍可预览',images:['https://sns-img.xhscdn.com/a.png',null,'https://evil.test/a.png','blob:https://creator.xiaohongshu.com/other'],isComplete:true},{accountId:id});
  assert.deepEqual(result.images,['https://sns-img.xhscdn.com/a.png']);assert.equal(result.isComplete,false);
  const repaired=await store.materialize({...detail(),images:[null,'http://sns-img.xhscdn.com/a.png?token=secret'],imageAssets:[asset()]},{accountId:id});
  assert.equal(repaired.images.length,2);assert.equal(repaired.isComplete,true);assert.ok(repaired.images.every(image=>!image.includes('secret')));
  assert.equal((await store.materialize({...detail(),isComplete:false},{accountId:id})).isComplete,false);
  assert.equal((await store.materialize({images:[],isComplete:true},{accountId:id})).isComplete,false);
  assert.equal((await store.materialize({images:[`/media/xhs/${id}/${'a'.repeat(64)}.png`],isComplete:true},{accountId:id})).isComplete,false);
});

test('malformed base64, SVG, wrong MIME, duplicate/out-of-range slots and account/path tricks are rejected',async t=>{
  const {dir,store}=await fixture(t);
  const invalidAssets=[{...asset(),base64:'data:image/png;base64,'+PNG.toString('base64')},{...asset(),base64:PNG.toString('base64')+'\n'},{...asset(),base64:'!!!!'},{...asset(),base64:'AB=='},{...asset(),base64:''},{...asset(),mime:'image/svg+xml',base64:Buffer.from('<svg onload="alert(1)"/>').toString('base64')},{...asset(),base64:Buffer.from('<svg/>').toString('base64')},{...asset(),mime:'image/jpeg'},{...asset(),base64:PNG.subarray(0,25).toString('base64')},{...asset(),index:-1},{...asset(),index:1},{...asset(),index:0.5}];
  for(const bad of invalidAssets)await assert.rejects(store.materialize({images:[null],imageAssets:[bad],isComplete:true},{accountId:id}),error=>error.status===400);
  await assert.rejects(store.materialize({images:[null],imageAssets:[asset(),asset()]},{accountId:id}),error=>error.status===400);
  await assert.rejects(store.materialize({images:[null],imageAssets:{}},{accountId:id}),error=>error.status===400);
  for(const accountId of ['',null,'../outside','x/y','x\\y','x'.repeat(121),'x%2fy'])await assert.rejects(store.materialize(detail(),{accountId}),error=>error.status===400);
  await store.materialize(detail(),{accountId:id});
  for(const file of ['../'+name(),name()+'?x=1',name()+'.svg',name().replace('.png','%2epng'),'a'.repeat(64)+'.png/other','file.png'])await assert.rejects(store.read(id,file),error=>error.status===400);
  assert.deepEqual(await readdir(path.join(dir,'xhs-media')), [id]);
});

test('image count, per-image size, and total decoded bytes are bounded before writing',async t=>{
  const {dir,store}=await fixture(t);
  await assert.rejects(store.materialize({images:Array(19).fill(null),imageAssets:[]},{accountId:id}),error=>error.status===413);
  await assert.rejects(store.materialize(detail(Array.from({length:19},(_,i)=>asset(i))),{accountId:id}),error=>error.status===413);
  await assert.rejects(store.materialize({images:[null],imageAssets:[{...asset(),base64:'A'.repeat(Math.ceil((15*1024*1024+1)/3)*4)}]},{accountId:id}),error=>error.status===413);
  const big=paddedPng(12*1024*1024),encoded=big.toString('base64');
  await assert.rejects(store.materialize({images:Array(6).fill(null),imageAssets:Array.from({length:6},(_,index)=>({index,mime:'image/png',base64:encoded})),isComplete:true},{accountId:id}),error=>error.status===413);
  await assert.rejects(lstat(path.join(dir,'xhs-media')),error=>error.code==='ENOENT','failed validation must not create asset files');
});

test('existing cache files are hash-checked and never replaced',async t=>{
  const {dir,store}=await fixture(t);await store.materialize(detail(),{accountId:id});const file=path.join(dir,'xhs-media',id,name()),initial=await lstat(file);
  await store.materialize(detail(),{accountId:id});assert.equal((await lstat(file)).ino,initial.ino,'same image reuses its content address');
  await writeFile(file,Buffer.from('corrupted cached bytes'));
  await assert.rejects(store.read(id,name()),error=>error.status===409);
  await assert.rejects(store.materialize(detail(),{accountId:id}),error=>error.status===409);
  assert.equal(await readFile(file,'utf8'),'corrupted cached bytes','corrupt existing content must not be overwritten');
});

test('root, account and file symlinks and linked files cannot escape the cache',async t=>{
  const {dir,store}=await fixture(t),outside=path.join(dir,'outside');await mkdir(outside);await writeFile(path.join(outside,name()),PNG);
  await symlink(outside,path.join(dir,'xhs-media'),'dir');
  await assert.rejects(store.materialize(detail(),{accountId:id}),error=>error.status===409&&!error.message.includes(dir));
  await rm(path.join(dir,'xhs-media'));await mkdir(path.join(dir,'xhs-media'));await symlink(outside,path.join(dir,'xhs-media',id),'dir');
  await assert.rejects(store.materialize(detail(),{accountId:id}),error=>error.status===409);
  await assert.rejects(store.read(id,name()),error=>error.status===409);
  await rm(path.join(dir,'xhs-media',id));await mkdir(path.join(dir,'xhs-media',id));const cached=path.join(dir,'xhs-media',id,name());await symlink(path.join(outside,name()),cached);
  await assert.rejects(store.read(id,name()),error=>error.status===409);
  await assert.rejects(store.materialize(detail(),{accountId:id}),error=>error.status===409);
  await rm(cached);await link(path.join(outside,name()),cached);await assert.rejects(store.read(id,name()),error=>error.status===409);
  assert.deepEqual(await readFile(path.join(outside,name())),PNG);
  const alias=path.join(dir,'alias');await symlink(outside,alias,'dir');await assert.rejects(new XhsMediaCache({dir:alias}).materialize(detail(),{accountId:id}),error=>error.status===409);
});
