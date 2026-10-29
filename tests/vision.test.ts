import test from 'node:test';
import assert from 'node:assert/strict';
import {Observer, type ObserverCharacter} from '../src/vision/index.ts';
import {DEFAULT_VISION, blockedApp, characterVisionValid, visionValid, type CapturedFrame} from '../src/vision/index.ts';
import {ImageAttachments} from '../src/llm/attachments.ts';

test('cached images recheck capture permission when attached to a later text request',()=>{
  let permitted=true;const cache=new ImageAttachments(),f:CapturedFrame={source:'synthetic',capturedAt:Date.now(),fingerprint:'x',width:1,height:1,
    dataUrl:'data:image/jpeg;base64,TEST',valid:()=>permitted};
  const messages=[{role:'system' as const,content:'rules'},{role:'user' as const,content:'previous observation'},{role:'assistant' as const,content:'{}'},{role:'user' as const,content:'now'}];
  cache.add('a','adult',1,f);permitted=false;
  assert.equal(cache.attach(messages,'a','adult',[1])[1].content,'previous observation');
  permitted=true;assert.equal(cache.attach(messages,'a','adult',[1])[1].content,'previous observation','revoked images are discarded');
});
import type {ChatMessage} from '../src/llm/context.ts';
function setup(){
  let now=0,active=true,captures=0;const cfg={...DEFAULT_VISION,enabled:true,auto:true,intervalSec:5,staggerSec:2};
  let chars:ObserverCharacter[]=Array.from({length:5},(_,i)=>({id:`char-${i}`,generation:i,capable:true,busy:false,auto:true,intervalSec:5}));
  let fingerprint='same';const seen:string[]=[],frames:CapturedFrame[]=[];
  const host={config:()=>cfg,active:()=>active,characters:()=>chars,target:()=>({displayId:'1'}),
    capture:async()=>{captures++;const f={source:'合成测试图',capturedAt:now,fingerprint,dataUrl:'data:image/jpeg;base64,TEST',width:2,height:2,valid:()=>true};frames.push(f);return f;},
    deliver:async(id:string)=>{seen.push(id);return true;}};
  const observer=new Observer(host,()=>now);
  return {observer,cfg,host,seen,frames,get captures(){return captures;},setNow:(v:number)=>{now=v;},setActive:(v:boolean)=>{active=v;},setChars:(v:ObserverCharacter[])=>{chars=v;},chars,setFingerprint:(v:string)=>{fingerprint=v;}};
}
test('N characters get their own first view, stable frames deduplicate per character, and due order remains fair',async()=>{
  const x=setup();await x.observer.tick();assert.equal(x.captures,0);
  for(let now=5000;now<=13000;now+=2000){x.setNow(now);await x.observer.tick();}
  assert.deepEqual(x.seen,x.chars.map(c=>c.id));
  for(let now=15000;now<=23000;now+=2000){x.setNow(now);await x.observer.tick();}
  assert.equal(x.seen.length,5);x.setFingerprint('changed');x.setNow(25000);await x.observer.tick();assert.equal(x.seen.length,6);
});
test('manual bypasses interval/dedup, repeated clicks merge, and manual selection precedes automatic work',async()=>{
  const x=setup();await x.observer.tick();x.chars[0].busy=true;
  assert.equal(x.observer.request('char-0'),true);assert.equal(x.observer.request('char-0'),true);
  assert.equal(x.captures,0);x.chars[0].busy=false;x.setNow(5000);await x.observer.tick();assert.deepEqual(x.seen,['char-0']);
  x.observer.request('char-0');await new Promise(r=>setImmediate(r));assert.deepEqual(x.seen,['char-0','char-0']);
});
test('absence, generation changes, suspend, and disable cancel pending or in-flight observations',async()=>{
  const x=setup();let finish!:(f:CapturedFrame)=>void;x.host.capture=()=>new Promise(r=>{finish=r;});
  x.observer.request('char-0');x.cfg.enabled=false;x.observer.reset();finish({source:'test',capturedAt:0,fingerprint:'a',dataUrl:'x',width:1,height:1,valid:()=>true});
  await new Promise(r=>setImmediate(r));assert.equal(x.seen.length,0);
  x.cfg.enabled=true;x.chars[1].busy=true;x.observer.request('char-1');x.setChars(x.chars.filter(c=>c.id!=='char-1'));await x.observer.tick();assert.equal(x.seen.length,0);
  x.setActive(false);assert.equal(x.observer.request('char-0'),false);
});

test('resetting A does not invalidate B capture or remove B manual request',async()=>{
  const x=setup();let finish!:(f:CapturedFrame)=>void;x.host.capture=()=>new Promise(r=>{finish=r;});
  assert.equal(x.observer.request('char-1'),true);x.observer.reset('char-0');
  finish({source:'test',capturedAt:0,fingerprint:'f',dataUrl:'x',width:1,height:1,valid:()=>true});
  await new Promise(r=>setImmediate(r));assert.deepEqual(x.seen,['char-1']);
});
test('changing interval takes effect immediately; no images while disabled or unsupported; manual entries expire',async()=>{
  const x=setup();await x.observer.tick();x.chars[0].intervalSec=10;x.setNow(4900);await x.observer.tick();
  x.setChars([x.chars[0]]);x.setNow(5000);await x.observer.tick();assert.equal(x.captures,0);
  x.setNow(14900);await x.observer.tick();assert.equal(x.captures,1);
  x.chars[0].capable=false;assert.equal(x.observer.request('char-0'),false);
  x.chars[0].capable=true;x.chars[0].busy=true;x.observer.request('char-0');x.setNow(50000);await x.observer.tick();x.chars[0].busy=false;x.chars[0].auto=false;await x.observer.tick();assert.equal(x.captures,1);
});
test('image attachments isolate character/mode, cap memory, expire, and never mutate persistent history',()=>{
  const cache=new ImageAttachments(),now=Date.now(),frame:CapturedFrame={source:'合成图',capturedAt:now,fingerprint:'f',dataUrl:'data:image/jpeg;base64,TEST',width:1,height:1,valid:()=>true};
  const messages:ChatMessage[]=[{role:'system',content:'rules'},{role:'user',content:'past observation'},{role:'assistant',content:'reply'},{role:'user',content:'follow-up'}];
  cache.add('a','sfw',1,frame);assert.ok(Array.isArray(cache.attach(messages,'a','sfw',[1])[1].content));
  assert.equal(cache.attach(messages,'b','sfw',[1])[1].content,'past observation');assert.equal(cache.attach(messages,'a','adult',[1])[1].content,'past observation');assert.equal(messages[1].content,'past observation');
  cache.add('a','sfw',2,frame);cache.add('a','sfw',3,frame);assert.equal(cache.attach(messages,'a','sfw',[1])[1].content,'past observation');
  cache.prune(now+120001);assert.equal(cache.attach(messages,'a','sfw',[3])[1].content,'past observation');
  cache.add('a','sfw',1,frame);cache.clear('a');assert.equal(cache.attach(messages,'a','sfw',[1])[1].content,'past observation');
});
test('only implemented scope can be configured; interval ranges, override validation and blacklist are explicit',()=>{
  assert.ok(visionValid(DEFAULT_VISION));assert.equal(visionValid({...DEFAULT_VISION,scope:'window'}),false);assert.equal(visionValid({...DEFAULT_VISION,scope:'prefer-window'}),false);
  for(const intervalSec of [4,NaN,Infinity,86401])assert.equal(visionValid({...DEFAULT_VISION,intervalSec}),false);
  assert.ok(characterVisionValid({auto:true,intervalSec:5}));assert.equal(characterVisionValid({auto:'yes'} as any),false);
  assert.ok(blockedApp('KeePass.EXE',DEFAULT_VISION.blacklist));assert.ok(blockedApp('',[]));assert.equal(blockedApp('code.exe',DEFAULT_VISION.blacklist),false);
});

test('an invalidated in-flight manual request cannot delete the replacement requested after a settings change',async()=>{
  const x=setup();let finish!:(f:CapturedFrame)=>void;x.host.capture=()=>new Promise(r=>{finish=r;});
  x.observer.request('char-0');x.observer.reset();x.observer.request('char-0');
  finish({source:'old',capturedAt:0,fingerprint:'old',dataUrl:'x',width:1,height:1,valid:()=>true});await new Promise(r=>setImmediate(r));assert.equal(x.seen.length,0);
  x.host.capture=async()=>({source:'new',capturedAt:0,fingerprint:'new',dataUrl:'x',width:1,height:1,valid:()=>true});await x.observer.tick();assert.deepEqual(x.seen,['char-0']);
});
