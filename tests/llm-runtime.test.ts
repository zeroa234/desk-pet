import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {makeDuo,drive} from './helpers/fake-scene.ts';
import {LlmRuntime,loadConfig} from '../src/llm/runtime.ts';
import {setPlan} from '../src/behavior/index.ts';
import {Observer} from '../src/vision/index.ts';
import {DEFAULT_VOICE,textToUnits} from '../src/llm/speech.ts';

const flush=async()=>{for(let i=0;i<10;i++)await new Promise<void>(r=>setImmediate(r));};
function setup(t: test.TestContext, pair=false) {
  fs.mkdirSync('temp',{recursive:true});const root=fs.mkdtempSync(path.resolve('temp/llm-runtime-'));fs.mkdirSync(path.join(root,'config'));
  const config=JSON.parse(fs.readFileSync('config/llm.json','utf8'));
  for(const p of Object.values(config.providers) as any[]) {p.baseUrl='http://127.0.0.1:18888/v1';p.keyEnv='DESK_PET_NONEXISTENT_TEST_KEY';p.timeoutMs=300;}
  fs.writeFileSync(path.join(root,'config','llm.json'),JSON.stringify(config));fs.copyFileSync('config/pricing.json',path.join(root,'config','pricing.json'));
  const fx=makeDuo(pair?{}:{aMind:{schema:1,stats:{desire:{start:90}},behaviors:[{id:'idle',weight:1,steps:[{do:'idle',sec:20}]},
    {id:'masturbate',weight:1,r18:true,steps:[{do:'play',action:'wave',state:'masturbate',phase:'loop',sec:20}]}]}});
  const a=fx.sim.charOf('a')!.actor!;a.support=fx.sim.supports.find(s=>s.kind==='floor')!;a.y=a.support.y;a.state='idle';a.plan=null;a.step=null;a.stateEnd=Infinity;
  const logs:any[]=[];const rt=new LlmRuntime(root,fx.sim,r=>logs.push(r));const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;rt.close();fs.rmSync(root,{recursive:true,force:true});});
  return {rt,fx,a,root,logs};
}
function decision(body:any,wanted='masturbate') {
  const criteria=body.questions.intent.criteria;const choice=Object.keys(criteria).find(k=>criteria[k].includes(`behavior: ${wanted};`))??'rule';
  return new Response(JSON.stringify({answers:Object.fromEntries(Object.entries(body.questions).map(([key,q]:[string,any])=>{
    const selected=key==='intent'?choice:key==='plan_size'?'one':'stop';
    return [key,{type:'choice',choice:selected,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===selected?1:0]))}];
  })),usage:{input_tokens:100,output_tokens:0}}));
}
test('LLM disabled preserves rule path without network; enabling chooses a permitted abstract action',async t=>{
  const {rt,fx,a,logs}=setup(t);let calls=0;
  globalThis.fetch=async(_u,init)=>{calls++;return decision(JSON.parse(String(init?.body)));};
  assert.equal(fx.sim.decisionGate?.('a'),false);rt.step(fx.sim.now,[]);await flush();assert.equal(calls,0);
  rt.setEnabled(true);assert.equal(fx.sim.decisionGate?.('a'),true);rt.step(fx.sim.now,[]);await flush();
  assert.equal(calls,1);assert.equal(a.plan?.behavior,'masturbate');assert.equal(rt.store.summary().total,1);
  assert.equal(logs.find(e=>e.type==='llm-decision-options').stats.desire,90);
  assert.equal(logs.find(e=>e.type==='llm-decision-result').actual,'masturbate');
  assert.equal(rt.store.summary().cacheRate,null);
});

test('temporary suspension preserves action protection; failure or low confidence preserves grace, explicit rule releases it',async t=>{
  for(const outcome of ['network','low-confidence','rule'] as const){
    const {rt,fx,a}=setup(t);
    (fx.sim.charOf('a')!.brain.cfg.behaviors[0].steps![0] as any).sec=0.1;
    rt.setEnabled(true);
    const idle=fx.sim.llmCandidates('a').find(c=>c.behavior==='idle')!;
    fx.sim.applyLlmIntent('a',a.epoch,idle.id,a);
    rt.suspend(true);assert.ok(fx.sim.hasLlmControl('a'));rt.suspend(false);
    drive(fx.sim).until(e=>e.type==='plan-end'&&e.behavior==='idle','idle done');
    globalThis.fetch=async(_u,init)=>{
      if(outcome==='network')throw new Error('synthetic network failure');
      const body=JSON.parse(String(init?.body));
      if(outcome==='rule')return decision(body,'rule');
      const response=await decision(body).json();
      response.answers.intent.probabilities[response.answers.intent.choice]=0.1;
      return new Response(JSON.stringify(response));
    };
    rt.config.minChoiceProbability=0.9;
    fx.sim.decisionGate?.('a');rt.step(fx.sim.now,[]);await flush();
    assert.equal(fx.sim.hasLlmControl('a'),outcome!=='rule',outcome);
    rt.setEnabled(false);assert.equal(fx.sim.hasLlmControl('a'),false);
  }
});

test('Clef receives the shared prefix, persona, protocol and per-character abilities; dialogue keeps changing state in the last message',async t=>{
  const {rt,fx,a,root}=setup(t);fs.writeFileSync(path.join(root,'config','prompts.local.json'),JSON.stringify({_shared:{adult:'测试公共前缀'},a:{adult:'测试独立人设'}}));
  let state='';globalThis.fetch=async(_u,init)=>{const body=JSON.parse(String(init?.body));state=body.state;return decision(body);};
  rt.setEnabled(true);fx.sim.decisionGate?.('a');rt.step(fx.sim.now,[]);await flush();
  assert.ok(state.startsWith('测试公共前缀'));for(const text of ['测试独立人设','程序状态协议 v1','你的能力目录','position','blocked_by'])assert.ok(state.includes(text),text);
  const m=chat(()=>[{text:'我听见啦。',to:'user'}]);globalThis.fetch=m.fetch;
  startWave(fx,a);await touch(rt,fx,'a');
  assert.ok(m.seen[0].body.messages[0].content.includes('你的能力目录'));
  const snap=JSON.parse(/^你的状态：(.*)$/m.exec(m.seen[0].user)![1]);
  assert.equal(snap.state_schema,1);assert.ok(Array.isArray(snap.displays));assert.ok(Array.isArray(snap.behaviors));assert.equal(snap.self.id,'a');
  assert.ok(!m.seen[0].body.messages[0].content.includes('"position":'),'changing coordinates stay out of the stable prefix');
});

test('clearing memory invalidates an in-flight reply and preserves the other mode and usage',async t=>{
  const {rt,fx,a}=setup(t);rt.memory.append('a','sfw',{at:1,kind:'line',user:'sfw record',reply:'{"lines":[]}'});
  let finish!:(r:Response)=>void,response!:Response;const m=chat(()=>[{text:'迟到的这一句。',to:'user'}]);
  globalThis.fetch=async(u,init)=>{response=await m.fetch(u,init);return new Promise<Response>(r=>{finish=r;});};
  startWave(fx,a);rt.setEnabled(true);await touch(rt,fx,'a');
  rt.forgetMemory('a','adult');finish(response);await flush();
  assert.deepEqual(rt.memory.counts('a','adult'),{active:0,archived:0});assert.equal(rt.memory.window('a','adult').summary,'');
  assert.equal(rt.memory.counts('a','sfw').active,1);assert.equal(rt.active,null);assert.equal(rt.store.summary().total,1);
});

test('forgetting A does not abort B or discard B dialogue already in flight',async t=>{
  const {rt,fx}=setup(t);let finish!:(r:Response)=>void,response!:Response,signal!:AbortSignal;
  const m=chat(()=>[{text:'乙的问候继续。',to:'user'}]);
  globalThis.fetch=async(u,init)=>{signal=init!.signal!;response=await m.fetch(u,init);return new Promise<Response>(r=>{finish=r;});};
  rt.setEnabled(true);await touch(rt,fx,'b');rt.forgetMemory('a','adult');
  assert.equal(signal.aborted,false);finish(response);await flush();rt.step(fx.sim.now,[]);
  assert.equal(rt.memory.counts('b','adult').active,1);assert.equal(rt.active?.ticket.speaker,'b');
});

test('forgotten or previous-mode heard records cannot return through a late request catch',async t=>{
  for(const change of ['forget','mode'] as const){
    const {rt,fx,a}=setup(t);const h={from:'b',fromName:'乙',to:'a',toName:'甲',text:'旧模式私有记录'};
    rt.setEnabled(true);(rt as any).heard.set('a',[h]);
    let finish!:(r:Response)=>void,response!:Response;const first=chat(()=>[{text:'迟到的回答。',to:'user'}]);
    globalThis.fetch=async(u,init)=>{response=await first.fetch(u,init);return new Promise<Response>(r=>{finish=r;});};
    startWave(fx,a);await touch(rt,fx,'a');
    if(change==='forget')rt.forgetMemory('a','adult');else{rt.setEnabled(false);fx.sim.setR18(false);rt.setEnabled(true);}
    finish(response);await flush();const next=chat(()=>[{text:'现在的新问候。',to:'user'}]);globalThis.fetch=next.fetch;
    fx.sim.now+=10;startWave(fx,a);await touch(rt,fx,'a');
    assert.ok(next.seen.length);assert.ok(!next.seen[0].user.includes(h.text),change);
    assert.ok(!JSON.stringify(rt.memory.window('a',change==='mode'?'sfw':'adult')).includes(h.text),change);
  }
});

test('daily caps do not treat an in-flight reservation as a completed call with unknown usage',async t=>{
  const {rt,fx,a}=setup(t);rt.config.dailyUsd=100;rt.config.dailyTokens=1000000;rt.setHourlyLimit(null);
  let finish!:(r:Response)=>void,response!:Response;const mock=chat(()=>[{text:'正常问候。',to:'user'}]);
  globalThis.fetch=async(u,init)=>{response=await mock.fetch(u,init);return new Promise<Response>(r=>{finish=r;});};
  startWave(fx,a);rt.setEnabled(true);await touch(rt,fx,'a');
  assert.equal((rt as any).allowed('reaction'),true);assert.equal(rt.limitHit,null);
  finish(response);await flush();
});

test('failed memory persistence publishes no speech or desire',async t=>{
  const {rt,fx,a}=setup(t);const mock=chat(()=>[{text:'这句不能先播。',to:'user'}],()=> '想挥手');globalThis.fetch=mock.fetch;
  rt.memory.append=()=>{throw new Error('simulated storage lock');};
  startWave(fx,a);rt.setEnabled(true);await touch(rt,fx,'a');rt.step(fx.sim.now,[]);
  assert.equal(rt.active,null);assert.equal((rt as any).waiting.length,0);assert.equal((rt as any).wants.size,0);
  assert.equal(rt.memory.counts('a','adult').active,0);
});

test('image capability saves a field override and provider defaults remain editable; invalid remote HTTP fails at config load',t=>{
  const {rt,root}=setup(t);assert.equal(rt.setProviderImages('ollama-text',false),true);
  const local=JSON.parse(fs.readFileSync(path.join(root,'config','llm.local.json'),'utf8'));assert.deepEqual(local.providers['ollama-text'],{images:false});
  const file=path.join(root,'config','llm.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));cfg.providers['ollama-text'].model='changed-base-model';fs.writeFileSync(file,JSON.stringify(cfg));
  assert.equal(loadConfig(root).providers['ollama-text'].model,'changed-base-model');
  cfg.providers['ollama-text'].baseUrl='http://example.test/v1';fs.writeFileSync(file,JSON.stringify(cfg));
  assert.throws(()=>loadConfig(root),/provider URL/);
});

test('multi-goal Clef requests receive earlier choices, account for every call and bind the checked sequence',async t=>{
  const {rt,fx,a}=setup(t);
  (fx.sim.charOf('a')!.brain.cfg.behaviors as any[]).push({id:'wave',weight:1,steps:[{do:'play',action:'wave',sec:1}]});
  const requests:any[]=[];const order=['idle','wave','masturbate'];
  globalThis.fetch=async(_u,init)=>{
    const body=JSON.parse(String(init?.body)),index=requests.length;requests.push(body);
    const criteria=body.questions.intent.criteria,key=Object.keys(criteria).find(k=>criteria[k].includes(`behavior: ${order[index]};`))!;
    return new Response(JSON.stringify({answers:Object.fromEntries(Object.entries(body.questions).map(([q,def]:[string,any])=>{
      const choice=q==='plan_size'?'three':key;
      return [q,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(def.criteria).map(k=>[k,k===choice?1:0]))}];
    })),usage:{input_tokens:100,output_tokens:0}}));
  };
  rt.setEnabled(true);fx.sim.decisionGate?.('a');rt.step(fx.sim.now,[]);await flush();
  assert.equal(requests.length,3);assert.equal(rt.store.summary().total,3);
  assert.ok(requests[1].questions.intent.instructions.includes('"behavior":"idle"'));
  assert.ok(requests[2].questions.intent.instructions.includes('"behavior":"wave"'));
  assert.equal(a.plan?.behavior,'idle');assert.deepEqual(fx.sim.llmSnapshot('a')!.pending_goals.map(g=>g.behavior),['wave','masturbate']);
});

test('a three-goal answer with only two candidates stops before an invalid one-choice question is charged',async t=>{
  const {rt,fx}=setup(t);let calls=0;
  globalThis.fetch=async(_u,init)=>{
    const body=JSON.parse(String(init?.body)),wanted=calls++?'masturbate':'idle',criteria=body.questions.intent.criteria;
    const selected=Object.keys(criteria).find(k=>criteria[k].includes(`behavior: ${wanted};`))!;
    return new Response(JSON.stringify({answers:Object.fromEntries(Object.entries(body.questions).map(([q,def]:[string,any])=>{
      const choice=q==='plan_size'?'three':selected;
      return [q,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(def.criteria).map(k=>[k,k===choice?1:0]))}];
    })),usage:{input_tokens:100,output_tokens:0}}));
  };
  rt.setEnabled(true);fx.sim.decisionGate?.('a');rt.step(fx.sim.now,[]);await flush();
  assert.equal(calls,2);assert.equal(rt.store.summary().total,2);assert.ok(rt.store.recent().every(r=>r.result==='ok'));
});

/** 假文本模型：读最后一条 user 消息里的 speaker / v / plan / phases，按 write 写台词；“整理记忆”的请求回一段摘要 */
type Req={speaker:string;v:number;plan:string;phases:string[];body:any;user:string};
function chat(write:(r:Req)=>{phase?:string;to?:string;text:string}[],want?:(r:Req)=>string) {
  const seen:Req[]=[];
  const fetch=async(_u:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body)),user=body.messages.at(-1).content as string;
    if(user.includes('整理记忆')){seen.push({speaker:'',v:0,plan:'',phases:[],body,user});return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({memory:'我记得刚才一直在挥手。'})},finish_reason:'stop'}],usage:{prompt_tokens:300,completion_tokens:30,prompt_tokens_details:{cached_tokens:280}}}));}
    const r:Req={speaker:/^speaker: (.+)$/m.exec(user)![1],v:Number(/^v: (\d+)$/m.exec(user)![1]),plan:/^plan: (.+)$/m.exec(user)![1],phases:JSON.parse(/^phases: (.+)$/m.exec(user)![1]),body,user};seen.push(r);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({v:r.v,plan:r.plan,lines:write(r).map(l=>({phase:r.phases[0],...l})),...(want?{want:want(r)}:{})})},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:40,prompt_tokens_details:{cached_tokens:0}}}));};
  return {fetch:fetch as typeof globalThis.fetch,seen};
}
const startWave=(fx:ReturnType<typeof setup>['fx'],a:ReturnType<typeof setup>['a'])=>setPlan(a,fx.sim.charOf('a')!.spec,{behavior:'wave',steps:[{state:'act',action:'wave',sec:100}]},fx.sim.ctx(),'test');
const planEvent=[{id:'a',e:{type:'plan' as const,behavior:'wave',steps:1}}];
const poke=(id:string,part='head',kind:'click'|'stroke'='click')=>({id,e:{type:'poke' as const,kind,part,reaction:'click',overlay:true,cooling:false}});
/** 点 / 摸以后过了防抖的安静时间，收件箱才发请求 */
async function touch(rt:LlmRuntime,fx:ReturnType<typeof setup>['fx'],...ids:string[]) {
  rt.step(fx.sim.now,ids.map(id=>poke(id)));await flush();fx.sim.now+=rt.config.debounce.quietSec+.01;rt.step(fx.sim.now,[]);await flush();
}
function bothIdle(fx:ReturnType<typeof setup>['fx']) {
  for(const id of ['a','b']){const x=fx.sim.charOf(id)!.actor!;x.support=fx.sim.supports.find(s=>s.kind==='floor')!;x.y=x.support.y;x.state='idle';x.plan=null;x.step=null;x.stateEnd=Infinity;}
}

test('duo: inviter writes her part first, partner sees it and writes her own; each speaks only in the current phase',async t=>{
  const {rt,fx,a}=setup(t,true);a.stateEnd=fx.sim.now;
  const drv=drive(fx.sim),play=drv.until(e=>e.type==='duo'&&e.what==='play','play');
  const m=chat(r=>r.phases.map(phase=>({phase,to:r.speaker==='a'?'b':'a',text:`${r.speaker}在${phase}说的话。`})));globalThis.fetch=m.fetch;
  rt.setEnabled(true);rt.step(fx.sim.now,play);await flush();rt.step(fx.sim.now,[]);await flush();rt.step(fx.sim.now,[]);   // 对方等邀请方写完，下一帧才排上
  assert.deepEqual(m.seen.map(r=>r.speaker),['a','b']);
  for(const r of m.seen)assert.deepEqual(r.phases,['start','loop','climax']);
  assert.ok(m.seen[1].user.includes('"phase":"start","to":"b","text":"a在start说的话。"'),'partner sees phase and audience of the draft');
  assert.ok(m.seen[1].user.includes('partner_draft'));
  assert.ok(!rt.memory.window('b','adult').turns[0].user.includes('a在start说的话。'),'unspoken script never becomes heard history');
  assert.equal(m.seen[1].body.messages.length,2,'partner uses her own (empty) session');
  assert.equal(rt.active?.ticket.binding.phase,'start');
  const loop=drv.until(e=>e.type==='duo'&&e.what==='phase'&&e.phase==='loop','loop');rt.step(fx.sim.now,loop);
  assert.equal(rt.active?.ticket.binding.phase,'loop');
  fx.sim.grab(fx.sim.duos[0].roles.receiver,{x:900,y:950});rt.step(fx.sim.now,[]);assert.equal(rt.active,null);
});

test('duo dialogue addressed to the partner never schedules an extra talk request after debounce',async t=>{
  const {rt,fx,a}=setup(t,true);a.stateEnd=fx.sim.now;
  const drv=drive(fx.sim),play=drv.until(e=>e.type==='duo'&&e.what==='play','play');
  const mock=chat(r=>[{phase:'start',to:r.speaker==='a'?'b':'a',text:`${r.speaker}的一句开场问候。`}]);globalThis.fetch=mock.fetch;
  rt.setEnabled(true);fx.sim.decisionGate=()=>true;rt.step(fx.sim.now,play);await flush();rt.step(fx.sim.now,[]);await flush();rt.step(fx.sim.now,[]);
  for(let i=0;i<240;i++){const evs=drv.frame();rt.step(fx.sim.now,evs);if(i%30===0)await flush();}
  await flush();assert.equal(rt.store.summary(undefined,'duo').total,2);assert.equal(rt.store.summary(undefined,'talk').total,0);
});

test('a failed inviter turn never schedules the second duo request',async t=>{
  const {rt,fx,a}=setup(t,true);a.stateEnd=fx.sim.now;const drv=drive(fx.sim),play=drv.until(e=>e.type==='duo'&&e.what==='play','play');
  const mock=chat(r=>[{phase:'start',to:r.speaker==='a'?'b':'a',text:'普通开场问候。'}]);globalThis.fetch=mock.fetch;
  rt.memory.append=()=>{throw new Error('simulated storage lock');};
  rt.setEnabled(true);rt.step(fx.sim.now,play);await flush();rt.step(fx.sim.now,[]);await flush();rt.step(fx.sim.now,[]);await flush();
  assert.equal(mock.seen.length,1);assert.equal(rt.store.summary(undefined,'duo').total,1);
});

test('summary read failures always release their compaction slot and are handled',async t=>{
  for(const stage of ['pending','window'] as const){
    const {rt,logs}=setup(t);rt.setEnabled(true);
    if(stage==='pending')rt.memory.pending=()=>{throw new Error('simulated read lock');};
    else{rt.memory.pending=()=>[{seq:1,at:1,kind:'line',user:'test',reply:'{"lines":[]}'}];rt.memory.window=()=>{throw new Error('simulated read lock');};}
    await assert.doesNotReject((rt as any).compact('a','adult'));assert.equal((rt as any).compacting.size,0);
    assert.ok(logs.some(e=>e.type==='llm-memory-fail'));
  }
});
test('invalid model answer falls back to rule without mutating state from arbitrary model fields',async t=>{
  const {rt,fx,a}=setup(t);globalThis.fetch=async()=>new Response(JSON.stringify({answers:{intent:{type:'choice',choice:'arbitrary',confidence:1,probabilities:{arbitrary:1}}},usage:{input_tokens:77,output_tokens:0},stats:{desire:9999}}));
  rt.setEnabled(true);fx.sim.decisionGate?.('a');rt.step(fx.sim.now,[]);await flush();
  assert.ok(a.plan);assert.equal(fx.sim.charOf('a')!.brain.stats.desire,90);assert.equal(rt.store.recent()[0].result,'invalid');assert.equal(rt.store.recent()[0].usage?.prompt,77);
});
test('late decision is billed as stale and cannot replace a dragged actor',async t=>{
  const {rt,fx,a}=setup(t);let finish!:(r:Response)=>void,body:any;
  globalThis.fetch=async(_u,init)=>{body=JSON.parse(String(init?.body));return new Promise<Response>(r=>{finish=r;});};
  rt.setEnabled(true);fx.sim.decisionGate?.('a');rt.step(fx.sim.now,[]);await flush();
  fx.sim.grab('a',{x:a.x,y:a.y});finish(decision(body));await flush();
  assert.equal(a.state,'dragged');assert.equal(rt.store.recent()[0].result,'stale');assert.equal(rt.active,null);
});
test('same action name in a new plan instance cannot accept previous plan dialogue',async t=>{
  const {rt,fx,a}=setup(t);let finish!:(r:Response)=>void,user='';
  globalThis.fetch=async(_u,init)=>{const body=JSON.parse(String(init?.body));user=body.messages.at(-1).content;return new Promise<Response>(r=>{finish=r;});};
  const plan={behavior:'wave',steps:[{state:'act' as const,action:'wave',sec:20}]};
  setPlan(a,fx.sim.charOf('a')!.spec,plan,fx.sim.ctx(),'test');rt.setEnabled(true);
  rt.step(fx.sim.now,[{id:'a',e:{type:'plan',behavior:'wave',steps:1}}]);await flush();
  const v=Number(/^v: (\d+)$/m.exec(user)![1]),instance=/^plan: (.+)$/m.exec(user)![1];
  setPlan(a,fx.sim.charOf('a')!.spec,plan,fx.sim.ctx(),'test-repeat');
  finish(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({v,plan:instance,lines:[{speaker:'a',phase:'say',text:'你好呀。'}]})},finish_reason:'stop'}],usage:{prompt_tokens:120,completion_tokens:20}})));
  await flush();rt.step(fx.sim.now,[]);assert.equal(rt.active,null);assert.equal(rt.store.recent()[0].result,'stale');
});
test('valid locked-plan dialogue enters one global speech slot and stops when dragged',async t=>{
  const {rt,fx,a}=setup(t);
  globalThis.fetch=async(_u,init)=>{const b=JSON.parse(String(init?.body)),user=b.messages.at(-1).content;
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({v:Number(/^v: (\d+)$/m.exec(user)![1]),plan:/^plan: (.+)$/m.exec(user)![1],lines:[{speaker:'a',phase:'say',text:'你好，今天也一起玩吧。'}]})},finish_reason:'stop'}],usage:{prompt_tokens:120,completion_tokens:20}}));};
  setPlan(a,fx.sim.charOf('a')!.spec,{behavior:'wave',steps:[{state:'act',action:'wave',sec:20}]},fx.sim.ctx(),'test');rt.setEnabled(true);
  rt.step(fx.sim.now,[{id:'a',e:{type:'plan',behavior:'wave',steps:1}}]);await flush();rt.step(fx.sim.now,[]);
  assert.equal(rt.active?.ticket.speaker,'a');assert.ok(rt.active!.units.length>0);
  fx.sim.grab('a',{x:a.x,y:a.y});rt.step(fx.sim.now,[]);assert.equal(rt.active,null);
});

test('bad provider URLs and missing output limits fail at configuration load',t=>{
  const {root,fx}=setup(t),file=path.join(root,'config','llm.json'),original=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const url of ['https://','ollama.com/v1']) {const c=structuredClone(original);c.providers[c.decision].baseUrl=url;fs.writeFileSync(file,JSON.stringify(c));assert.throws(()=>new LlmRuntime(root,fx.sim),/provider URL/);}
  const c=structuredClone(original);delete c.maxTokens.duo;fs.writeFileSync(file,JSON.stringify(c));assert.throws(()=>new LlmRuntime(root,fx.sim),/max tokens/);
});
test('proactive lines are rare: one per interval, later plans stay silent; edited prompts are read on the next request',async t=>{
  const {rt,fx,a,root}=setup(t),m=chat(()=>[{text:'今天也一起玩吧。'}]);globalThis.fetch=m.fetch;
  rt.setEnabled(true);startWave(fx,a);rt.step(fx.sim.now,planEvent);await flush();assert.equal(m.seen.length,1);
  fx.sim.now+=rt.config.proactive.intervalSec-1;startWave(fx,a);rt.step(fx.sim.now,planEvent);await flush();
  assert.equal(m.seen.length,1,'within the interval: no request and nothing deferred');
  fs.writeFileSync(path.join(root,'config','prompts.local.json'),JSON.stringify({_shared:{adult:'公共前缀。'},a:{adult:'这是用户保存的普通日常人设。'}}));
  fx.sim.now+=2;startWave(fx,a);rt.step(fx.sim.now,planEvent);await flush();assert.equal(m.seen.length,2);
  const system=m.seen[1].body.messages[0].content as string;
  assert.ok(system.startsWith('公共前缀。'));assert.ok(system.indexOf('【桌宠台词规则】')<system.indexOf('这是用户保存的普通日常人设。'),'shared prefix, rules, then persona');
});
test('each character keeps her own session: history is appended, the prefix stays identical, nothing leaks to the other',async t=>{
  const {rt,fx}=setup(t,true);bothIdle(fx);let n=0;
  const m=chat(r=>[{to:'user',text:`${r.speaker}的第${++n}句${'不一样'.repeat(n)}`}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  await touch(rt,fx,'a');fx.sim.now+=rt.config.reactionIntervalSec+1;await touch(rt,fx,'a');
  await touch(rt,fx,'b');
  const [a1,a2,b1]=m.seen;assert.deepEqual([a1.speaker,a2.speaker,b1.speaker],['a','a','b']);
  assert.equal(a1.body.messages.length,2);assert.equal(a2.body.messages.length,4,'system + one recorded turn (user, assistant) + current');
  assert.deepEqual(a2.body.messages[0],a1.body.messages[0],'system prompt identical between turns');
  assert.ok(a2.body.messages[1].content.includes('用户点了你的头')&&!a2.body.messages[1].content.includes('你的状态'),'history keeps the short record, not the snapshot');
  assert.ok(a2.body.messages[2].content.includes('a的第1句'));
  assert.equal(b1.body.messages.length,2,'b has her own session');assert.ok(!JSON.stringify(b1.body.messages.slice(0,-1)).includes('a的第'));
  assert.equal(rt.memory.window('a','adult').turns.length,2);assert.equal(rt.memory.window('b','adult').turns.length,1);
});
test('a line said to another character is heard and answered, up to talk.maxExchanges lines',async t=>{
  const {rt,fx}=setup(t,true);bothIdle(fx);let n=0;
  const m=chat(r=>[{to:r.speaker==='a'?'b':'a',text:`第${++n}句：你好呀，今天${'怎样'.repeat(n)}`}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  await touch(rt,fx,'a');
  for(let i=0;i<12;i++){fx.sim.now+=5;rt.step(fx.sim.now,[]);await flush();}
  assert.deepEqual(m.seen.map(r=>r.speaker),['a','b','a','b'],'a starts, three replies (maxExchanges 4)');
  assert.ok(m.seen[1].user.includes('对你说：「第1句'),'b hears what a said to her');
  assert.ok(m.seen[2].user.includes('听到：'),'a hears b');
});
test('the current message lists the locked steps ahead (only there, not in the history)',async t=>{
  const {rt,fx,a}=setup(t),m=chat(()=>[{text:'先把衣服脱了吧。'}]);globalThis.fetch=m.fetch;
  setPlan(a,fx.sim.charOf('a')!.spec,{behavior:'masturbate',steps:[{state:'act',action:'wave',sec:2,outfit:'nude'},{state:'masturbate',action:'wave',phase:'loop',sec:30},{state:'masturbate',action:'wave',phase:'climax',sec:5}]},fx.sim.ctx(),'test');
  fx.sim.now+=1;
  rt.setEnabled(true);rt.step(fx.sim.now,[{id:'a',e:{type:'plan',behavior:'masturbate',steps:3}}]);await flush();
  const line=/^这一步和接下来.*$/m.exec(m.seen[0].user)?.[0]??'';
  assert.ok(/wave，当前剩余约1秒.*换成nude.*→ loop：wave，计划时长约30秒 → climax：wave，计划时长约5秒/.test(line),line);
  assert.ok(!rt.memory.window('a','adult').turns[0].user.includes('接下来'),'not written into the session history');
});
test('dialogue and its history receive bounded execution receipts including cancellations, not just earlier promises',async t=>{
  const {rt,fx}=setup(t),m=chat(()=>[{text:'刚才没走成。'}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  rt.step(fx.sim.now,[{id:'a',e:{type:'plan-end',behavior:'approach',outcome:'aborted',reason:'intent-target-moved'}},
    {id:'a',e:{type:'intent-plan',what:'cancelled',reason:'target-moved'}}]);
  await touch(rt,fx,'a');
  assert.ok(m.seen[0].user.includes('"outcome":"aborted"'));
  assert.ok(m.seen[0].user.includes('"reason":"target-moved"'));
  assert.ok(rt.memory.window('a','adult').turns[0].user.includes('程序执行回执'));
});
/** 回复先挂着，等测试里改完世界再放回来 */
function held(write:(r:Req)=>{phase?:string;text:string}[]) {
  const m=chat(write),release:(()=>void)[]=[];
  const fetch=async(u:unknown,init?:RequestInit)=>{await new Promise<void>(r=>release.push(r));return m.fetch(u as string,init);};
  return {fetch:fetch as typeof globalThis.fetch,seen:m.seen,release:()=>release.splice(0).forEach(r=>r())};
}
test('a reaction line is still spoken after the short reaction animation has ended (2026-10-23: 11 of 12 were dropped)',async t=>{
  const {rt,fx,a}=setup(t),m=held(()=>[{text:'哎呀，别突然戳我嘛。'}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  setPlan(a,fx.sim.charOf('a')!.spec,{behavior:'reaction:click',steps:[{state:'act',action:'wave',sec:1}]},fx.sim.ctx(),'test');
  await touch(rt,fx,'a');
  startWave(fx,a);fx.sim.now+=1.5;m.release();await flush();rt.step(fx.sim.now,[]);   // 反应动作已经换成别的计划，台词这时才回来
  assert.equal(rt.active?.ticket.text,'哎呀，别突然戳我嘛。');
  fx.sim.grab('a',{x:a.x,y:a.y});rt.step(fx.sim.now,[]);assert.equal(rt.active,null,'still stops when she is picked up');
});
test('a reaction line that comes back too late is not spoken',async t=>{
  const {rt,fx,a}=setup(t),m=held(()=>[{text:'哎呀，别突然戳我嘛。'}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  await touch(rt,fx,'a');fx.sim.now+=13;m.release();await flush();rt.step(fx.sim.now,[]);
  assert.equal(rt.active,null);assert.equal(a.state,'idle');
});
test('a started line finishes after its short plan ends naturally (2026-10-23 silent bubble cut after 0.29 s)',async t=>{
  const {rt,fx,a,logs}=setup(t),m=chat(()=>[{text:'先休息一下，刚才聊得很开心。'},{text:'这一句还没有开始说。'}]);globalThis.fetch=m.fetch;
  setPlan(a,fx.sim.charOf('a')!.spec,{behavior:'wave',steps:[{state:'idle',phase:'end',sec:.3}]},fx.sim.ctx(),'test');
  rt.setEnabled(true);fx.sim.decisionGate=()=>true;
  rt.step(fx.sim.now,planEvent);await flush();rt.step(fx.sim.now,[]);
  const line=rt.active!;assert.ok(line);assert.ok(line.duration>1);
  const done=drive(fx.sim).until(e=>e.type==='plan-end'&&e.behavior==='wave','short plan end');
  rt.step(fx.sim.now,done);assert.equal(rt.active?.token,line.token,'ordinary plan completion must not remove an unfinished sentence');
  fx.sim.now=line.start+line.duration+.5;rt.step(fx.sim.now,[]);
  assert.equal(rt.active?.token,line.token,'keep the existing one-second reading hold');
  fx.sim.now=line.start+line.duration+1.01;rt.step(fx.sim.now,[]);assert.equal(rt.active,null);
  const speech=logs.filter(e=>e.type==='llm-speech');
  assert.deepEqual(speech.map(e=>e.what),['start','end'],'unstarted lines still expire with the old plan');
  assert.equal(speech[1].reason,'complete');assert.equal(speech[1].readComplete,true);
  assert.ok(!JSON.stringify(speech).includes(line.ticket.text),'lifecycle logs contain timing, not dialogue');
});

test('a started reaction finishes across ordinary walk changes; stale motion is checked before speaking',async t=>{
  const {rt,fx,a}=setup(t),m=chat(()=>[{text:'哎呀，我听见你叫我啦，慢慢说。'}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  const walk=()=>setPlan(a,fx.sim.charOf('a')!.spec,{behavior:'walk',steps:[{state:'walk',targetX:a.x+100}]},fx.sim.ctx(),'test');
  walk();await touch(rt,fx,'a');rt.step(fx.sim.now,[]);
  const line=rt.active!;assert.ok(line);
  fx.sim.now+=.4;walk();rt.step(fx.sim.now,[]);
  assert.equal(rt.active?.token,line.token,'same locomotion context, only the plan instance changed');
  a.targetX=a.x-100;rt.step(fx.sim.now,[]);
  assert.equal(rt.active?.token,line.token,'ordinary direction changes do not cut a sentence already being spoken');
  fx.sim.grab('a',{x:a.x,y:a.y});rt.step(fx.sim.now,[]);assert.equal(rt.active,null,'physical interruptions still stop it');
});

test('a reply about movement cannot survive reversing direction while the model is in flight',async t=>{
  const {rt,fx,a}=setup(t),m=held(()=>[{text:'我正往右走。'}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  setPlan(a,fx.sim.charOf('a')!.spec,{behavior:'walk',steps:[{state:'walk',targetX:a.x+100}]},fx.sim.ctx(),'test');
  await touch(rt,fx,'a');
  a.targetX=a.x-100;m.release();await flush();rt.step(fx.sim.now,[]);
  assert.equal(rt.active,null);assert.equal(rt.memory.window('a','adult').turns.length,0);
});
test('a plan line survives a state change inside the same plan (v is taken when the request is sent)',async t=>{
  const {rt,fx,a}=setup(t),m=held(r=>[{phase:'start',text:'先换个姿势。'},{phase:'loop',text:'嗯，这样舒服多了。'}].filter(l=>r.phases.includes(l.phase)));globalThis.fetch=m.fetch;rt.setEnabled(true);
  setPlan(a,fx.sim.charOf('a')!.spec,{behavior:'wave',steps:[{state:'act',action:'wave',phase:'start',sec:1},{state:'act',action:'wave',phase:'loop',sec:30}]},fx.sim.ctx(),'test');
  rt.step(fx.sim.now,planEvent);await flush();
  a.epoch++;a.phase='loop';m.release();await flush();rt.step(fx.sim.now,[]);assert.deepEqual(m.seen[0].phases,['start','loop']);
  assert.equal(rt.active?.ticket.text,'嗯，这样舒服多了。');assert.equal(rt.store.recent()[0].result,'ok');
});
test('near-duplicate lines are dropped before they are queued or recorded',async t=>{
  const {rt,fx,a}=setup(t),m=chat(()=>[{text:'今天天气真好呀，一起出去走走吧'},{text:'今天天气真好啊，一起出去走走吧！'}]);globalThis.fetch=m.fetch;
  rt.setEnabled(true);startWave(fx,a);rt.step(fx.sim.now,planEvent);await flush();
  assert.equal(JSON.parse(rt.memory.window('a','adult').turns[0].reply).lines.length,1);
});
test('over maxTurns the oldest turns are folded with a source-aware memory-only prompt',async t=>{
  const {rt,fx}=setup(t);Object.assign(rt.config.context,{maxTurns:3,dropTurns:2});let n=0;
  const m=chat(()=>[{text:`第${++n}句完全不同的话${'啊'.repeat(n)}`}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  for(let i=0;i<4;i++){fx.sim.now+=rt.config.reactionIntervalSec+1;await touch(rt,fx,'a');}
  await flush();
  const summary=m.seen.find(r=>r.user.includes('整理记忆'));assert.ok(summary);
  assert.ok(summary!.body.messages[0].content.includes('只输出 {"memory"'));
  assert.ok(!summary!.body.messages[0].content.includes('【桌宠台词规则】'),'no competing dialogue JSON instruction');
  assert.ok(summary!.user.includes('中断不能写成到达或成功'));
  const win=rt.memory.window('a','adult');assert.equal(win.summary,'我记得刚才一直在挥手。');assert.equal(win.turns.length,2,'fold exactly dropTurns=2, retaining the other two');
  assert.deepEqual(rt.memory.counts('a','adult'),{active:2,archived:2});
  assert.equal(rt.store.summary(undefined,'memory').total,1);
});
test('per-character context limits override the defaults and are saved to llm.local.json',async t=>{
  const {rt,fx,root}=setup(t);
  assert.equal(rt.setCharacter('a',{maxTurns:3,dropTurns:3}),false,'must keep at least one turn');
  assert.equal(rt.setCharacter('a',{maxTurns:3,dropTurns:2,decisionTurns:4}),false,'decision turns cannot exceed the session limit');
  assert.ok(rt.setCharacter('a',{maxTurns:3,dropTurns:2,decisionTurns:1}));assert.deepEqual(rt.turnsOf('a'),{maxTurns:3,dropTurns:2,decisionTurns:1});
  assert.deepEqual(rt.turnsOf('b'),{maxTurns:50,dropTurns:30,decisionTurns:6});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'config','llm.local.json'),'utf8')).characters.a,{maxTurns:3,dropTurns:2,decisionTurns:1});
  let n=0;const m=chat(()=>[{text:`第${++n}句完全不同的话${'啊'.repeat(n)}`}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  for(let i=0;i<4;i++){fx.sim.now+=rt.config.reactionIntervalSec+1;await touch(rt,fx,'a');}
  await flush();assert.equal(rt.memory.window('a','adult').turns.length,2);
  for(let i=0;i<2;i++){fx.sim.now+=rt.config.reactionIntervalSec+1;await touch(rt,fx,'a');}
  assert.equal(rt.memory.window('a','adult').turns.length,2);
  // 会话里有 2 轮，决策只带最近 1 轮
  let state='';globalThis.fetch=(async(_u:unknown,init?:RequestInit)=>{state=JSON.parse(String(init?.body)).state;return decision(JSON.parse(String(init?.body)),'idle');}) as typeof fetch;
  const a=fx.sim.charOf('a')!.actor!;a.plan=null;a.step=null;a.state='idle';a.stateEnd=Infinity;fx.sim.now+=1000;fx.sim.decisionGate?.('a');rt.step(fx.sim.now,[]);await flush();
  assert.equal((state.match(/用户点了你的头/g)??[]).length,1,'one recent turn in the decision state');
  assert.ok(rt.setCharacter('a',{maxTurns:null,dropTurns:null,decisionTurns:null}));assert.deepEqual(rt.turnsOf('a'),{maxTurns:50,dropTurns:30,decisionTurns:6});
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'config','llm.local.json'),'utf8')).characters.a,undefined);
  const reload=new LlmRuntime(root,fx.sim);try{assert.deepEqual(reload.turnsOf('a'),{maxTurns:50,dropTurns:30,decisionTurns:6});}finally{reload.close();}
});
test('voice overrides persist per character and apply to the next utterance without changing active audio',async t=>{
  const {rt,fx,a,root}=setup(t);
  const first={pitch:300,speed:1.5,formantScale:1.2,breath:.2},next={pitch:420,speed:.75,formantScale:.8,breath:0};
  assert.ok(rt.setCharacter('a',{maxTurns:20,dropTurns:10,voice:first}));
  first.pitch=500;assert.equal(rt.voiceOf('a').pitch,300,'settings own a copy');
  assert.deepEqual(rt.voiceOf('b'),DEFAULT_VOICE);assert.equal(rt.store.summary().total,0,'editing makes no model calls');
  const before=fs.readFileSync(path.join(root,'config','llm.local.json'),'utf8');
  for(const voice of [{...next,pitch:601},{...next,speed:0},{...next,breath:NaN},{pitch:200},{...next,unknown:1}])
    assert.equal(rt.setCharacter('a',{voice:voice as any}),false);
  assert.equal(fs.readFileSync(path.join(root,'config','llm.local.json'),'utf8'),before,'invalid drafts do not write config');
  const m=chat(()=>[{text:'你好呀，今天一起玩。'},{text:'嗯，我听见啦。'}]);globalThis.fetch=m.fetch;
  startWave(fx,a);rt.setEnabled(true);rt.step(fx.sim.now,planEvent);await flush();rt.step(fx.sim.now,[]);
  const active=rt.active!;assert.equal(active.voice.pitch,300);
  assert.ok(rt.setCharacter('a',{voice:next}));assert.equal(active.voice.pitch,300,'the current sentence keeps its timing and voice');
  fx.sim.now=active.start+active.duration+1.01;rt.step(fx.sim.now,[]);
  assert.deepEqual(rt.active?.voice,next);assert.deepEqual(rt.active?.units,textToUnits(rt.active!.ticket.text,next));
  const reload=new LlmRuntime(root,fx.sim);
  try{assert.deepEqual(reload.voiceOf('a'),next);assert.deepEqual(reload.voiceOf('b'),DEFAULT_VOICE);}finally{reload.close();}
  assert.ok(rt.setCharacter('a',{voice:null}));assert.deepEqual(rt.voiceOf('a'),DEFAULT_VOICE);
  assert.equal(loadConfig(root).characters.a.maxTurns,20,'reset removes only voice');
});

test('restoring a voice uses that pack default, and legacy pitch above the synthesis limit is displayed honestly',t=>{
  const {root,fx}=setup(t),packDir=path.join(root,'packs','a');fs.mkdirSync(packDir,{recursive:true});
  const packVoice={pitch:185,speed:1.1,formantScale:.9,breath:.15};
  const file=path.join(packDir,'voice.json');fs.writeFileSync(file,JSON.stringify(packVoice));
  const rt=new LlmRuntime(root,fx.sim);
  try {
    assert.deepEqual(rt.voiceOf('a'),packVoice);assert.ok(rt.setCharacter('a',{voice:{...packVoice,pitch:350}}));
    assert.ok(rt.setCharacter('a',{voice:null}));assert.deepEqual(rt.voiceOf('a'),packVoice);
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),packVoice,'the exported pack stays untouched');
  } finally{rt.close();}
  fs.writeFileSync(file,JSON.stringify({...packVoice,pitch:800}));
  const legacy=new LlmRuntime(root,fx.sim);try{assert.equal(legacy.voiceOf('a').pitch,600);}finally{legacy.close();}
});

test('triggers within the debounce window (same or different) go out as one request',async t=>{
  const {rt,fx}=setup(t),m=chat(()=>[{text:'哎呀，你干嘛呀。'}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  rt.step(fx.sim.now,[poke('a')]);fx.sim.now+=.4;rt.step(fx.sim.now,[poke('a')]);fx.sim.now+=.4;rt.step(fx.sim.now,[poke('a','chest','stroke')]);await flush();
  assert.equal(m.seen.length,0,'still inside the quiet window');
  fx.sim.now+=rt.config.debounce.quietSec+.01;rt.step(fx.sim.now,[]);await flush();
  assert.equal(m.seen.length,1);assert.ok(m.seen[0].user.includes('用户点了你的头（2 次）；用户在摸你的胸'),m.seen[0].user.split('\n')[0]);
});
test('continuous touching still sends after maxWaitSec',async t=>{
  const {rt,fx}=setup(t),m=chat(()=>[{text:'别一直摸啦。'}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  for(let i=0;i<10;i++){rt.step(fx.sim.now,[poke('a','arm','stroke')]);await flush();fx.sim.now+=.5;}
  assert.equal(m.seen.length,1,'sent once maxWaitSec passed although the touches never stopped');
});
test('triggers while a request is in flight are kept and sent together afterwards; nothing is cancelled',async t=>{
  const {rt,fx}=setup(t),m=held(()=>[{text:'第一句回应呀。'}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  await touch(rt,fx,'a');                                                     // 第一次请求在途
  for(const part of ['chest','leg','head']){rt.step(fx.sim.now,[poke('a',part)]);fx.sim.now+=.3;}
  fx.sim.now+=rt.config.reactionIntervalSec;rt.step(fx.sim.now,[]);await flush();
  m.release();await flush();assert.equal(m.seen.length,1,'still one request: the second waits for the first');
  rt.step(fx.sim.now,[]);await flush();m.release();await flush();
  assert.equal(m.seen.length,2);assert.ok(m.seen[1].user.includes('用户点了你的胸；用户点了你的腿；用户点了你的头'),m.seen[1].user.split('\n')[0]);
  assert.ok(rt.store.recent().every(r=>r.result!=='aborted'),'the first request was not cancelled');
});
test('at most maxTriggers are kept; older ones are only counted',async t=>{
  const {rt,fx}=setup(t),m=chat(()=>[{text:'好多人在戳我。'}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  rt.step(fx.sim.now,Array.from({length:15},(_,i)=>poke('a',`p${i}`)));fx.sim.now+=rt.config.debounce.quietSec+.01;rt.step(fx.sim.now,[]);await flush();
  const what=m.seen[0].user.split('\n')[0];
  assert.ok(what.includes('（更早还有 5 件）')&&what.includes('p5')&&what.includes('p14')&&!what.includes('p4的'),what);
});
test('hourly limit full when a duo starts (2026-10-23 log: 200 in 41 min, duo scene 11 s later had no lines): one notice, then unlimited lets requests through and is saved',async t=>{
  const {rt,fx,a,root}=setup(t,true);a.stateEnd=fx.sim.now;
  const notices:{block:any;notify:boolean}[]=[];rt.onLimit=(block,notify)=>notices.push({block,notify});
  for(let i=0;i<200;i++)rt.store.record({at:Date.now()-i*1000,character:'a',kind:'talk',provider:'ollama-text',model:'m',usage:null,costUsd:null,latencyMs:1,result:'ok'});
  const drv=drive(fx.sim),play=drv.until(e=>e.type==='duo'&&e.what==='play','play');
  const m=chat(r=>r.phases.map(phase=>({phase,text:`${r.speaker}在${phase}说的话。`})));globalThis.fetch=m.fetch;
  rt.setEnabled(true);rt.step(fx.sim.now,play);await flush();rt.step(fx.sim.now,[]);await flush();
  assert.equal(m.seen.length,0,'blocked by the hourly limit');
  assert.equal(notices.length,1);assert.equal(notices[0].notify,true);assert.equal(notices[0].block.reason,'hourly');assert.equal(notices[0].block.used,200);
  assert.equal(rt.latest.key,'status.llm.hourlyLimit',JSON.stringify(rt.latest));assert.equal(rt.latest.params?.limit,200);
  await touch(rt,fx,'a');assert.equal(m.seen.length,0);assert.equal(notices.length,1,'still the same trip: no second notice');
  assert.equal(rt.setHourlyLimit(0),false);assert.equal(rt.setHourlyLimit(1.5),false);
  assert.ok(rt.setHourlyLimit(null));assert.equal(rt.limitHit,null);assert.deepEqual(notices.at(-1),{block:null,notify:false});
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'config','llm.local.json'),'utf8')).hourlyRequests,null);
  fx.sim.now+=rt.config.reactionIntervalSec+1;await touch(rt,fx,'a');assert.equal(m.seen.length,1,'unlimited: the next trigger is requested');
  const reload=new LlmRuntime(root,fx.sim);try{assert.equal(reload.config.hourlyRequests,null);}finally{reload.close();}
});
test('want: not in the bubble and not heard by others, kept in her own session; her next idle asks Clef early with it, once; stale wants expire',async t=>{
  const {rt,fx,a}=setup(t);bothIdle(fx);let n=0;
  const m=chat(r=>[{to:'user',text:`${r.speaker}：别碰我啦，才不想被摸${'呀'.repeat(++n)}。`}],r=>r.speaker==='a'?'其实想让用户再摸一下头':'');
  let state='',decisions=0;
  globalThis.fetch=(async(u:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));
    if(String(u).includes('systemone')){decisions++;state=body.state;return decision(body,'idle');}return m.fetch(u as string,init);}) as typeof fetch;
  const idle=()=>{a.plan=null;a.step=null;a.state='idle';a.stateEnd=Infinity;};
  rt.setEnabled(true);assert.equal(fx.sim.decisionGate?.('a'),true);rt.step(fx.sim.now,[]);await flush();assert.equal(decisions,1);
  idle();assert.equal(fx.sim.decisionGate?.('a'),false,'inside the decision interval');
  await touch(rt,fx,'a');for(let i=0;i<3;i++){rt.step(fx.sim.now,[]);await flush();}
  assert.ok(m.seen[0].body.messages[0].content.includes('可以和嘴上说的不一样'),'the rule asks for her honest want');
  assert.ok(!JSON.stringify(rt.active?.ticket??{}).includes('其实想'),'the bubble only has the line');
  assert.equal(JSON.parse(rt.memory.window('a','adult').turns[0].reply).want,'其实想让用户再摸一下头','kept in her own session');
  fx.sim.now+=rt.config.reactionIntervalSec+1;await touch(rt,fx,'b');
  const b=m.seen.find(r=>r.speaker==='b')!;assert.ok(b.user.includes('才不想被摸')&&!JSON.stringify(b.body).includes('其实想'),'b hears the line, never the want');
  idle();assert.equal(fx.sim.decisionGate?.('a'),true,'a fresh want opens the gate before the interval');rt.step(fx.sim.now,[]);await flush();
  assert.equal(decisions,2);assert.match(state,/^want: \d+ 秒前她心里想（没说出口）：其实想让用户再摸一下头$/m);
  idle();assert.equal(fx.sim.decisionGate?.('a'),false,'used once');
  rt.config.decisionIntervalSec=10000;fx.sim.now+=rt.config.reactionIntervalSec+1;await touch(rt,fx,'a');
  assert.equal(JSON.parse(rt.memory.window('a','adult').turns.at(-1)!.reply).want,'其实想让用户再摸一下头','a new want was recorded');
  fx.sim.now+=91;idle();assert.equal(fx.sim.decisionGate?.('a'),false,'a want older than 90 s no longer counts');
});
/** 假文本模型按顺序回这几段原文（第几次请求回第几段，多的回最后一段）；before 在回复前改世界（比如让时间过去） */
function replies(texts:((r:Req)=>string)[],before?:()=>void) {
  const seen:Req[]=[];
  const fetch=async(_u:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body)),user=body.messages.at(-1).content as string,first=body.messages.findLast((m:any)=>m.role==='user'&&/^speaker: /m.test(m.content)).content as string;
    const r:Req={speaker:/^speaker: (.+)$/m.exec(first)![1],v:Number(/^v: (\d+)$/m.exec(first)![1]),plan:/^plan: (.+)$/m.exec(first)![1],phases:JSON.parse(/^phases: (.+)$/m.exec(first)![1]),body,user};
    seen.push(r);before?.();
    return new Response(JSON.stringify({choices:[{message:{content:texts[Math.min(seen.length,texts.length)-1](r)},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:40,prompt_tokens_details:{cached_tokens:0}}}));};
  return {fetch:fetch as typeof globalThis.fetch,seen};
}
const good=(text:string)=>(r:Req)=>JSON.stringify({v:r.v,plan:r.plan,lines:[{phase:'say',to:'user',text}],want:''});
test('a broken reply is retried once with what was wrong; the broken text only goes to the event log, never to the session',async t=>{
  const {rt,fx,logs}=setup(t),m=replies([()=>'{"v":1,"lines":[坏掉的回复XYZ',good('这次好好说话了。')]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  await touch(rt,fx,'a');await flush();
  assert.equal(m.seen.length,2);
  const retry=m.seen[1].body.messages;assert.equal(retry.length,m.seen[0].body.messages.length+1,'the same request plus one note');
  assert.ok(retry.at(-1).content.includes('程序读不了')&&retry.at(-1).content.includes('say'),retry.at(-1).content);
  assert.ok(!JSON.stringify(retry).includes('坏掉的回复XYZ'),'the broken reply is not sent back');
  rt.step(fx.sim.now,[]);assert.equal(rt.active?.ticket.text,'这次好好说话了。');
  const turns=rt.memory.window('a','adult').turns;assert.equal(turns.length,1);assert.ok(!JSON.stringify(turns).includes('坏掉的')&&!JSON.stringify(turns).includes('程序读不了'),'session keeps only the good turn');
  const b=logs.filter(l=>l.type==='llm-broken');assert.equal(b.length,1);assert.equal(b[0].code,'bad-json');assert.equal(b[0].retry,true);assert.ok(b[0].reply.includes('坏掉的回复XYZ'));
  assert.deepEqual(rt.store.recent().map(r=>r.result).sort(),['bad-json','ok'],'both calls are billed');
});
test('broken twice: only one retry, nothing is said or recorded; refusals and late event lines are not retried',async t=>{
  const {rt,fx,logs}=setup(t);rt.setEnabled(true);
  const bad=(r:Req)=>JSON.stringify({v:r.v,plan:r.plan,lines:[{phase:'climax',text:'阶段不对的一句'}]});
  let m=replies([bad]);globalThis.fetch=m.fetch;await touch(rt,fx,'a');await flush();
  rt.step(fx.sim.now,[]);assert.equal(m.seen.length,2,'one retry only');assert.equal(rt.memory.window('a','adult').turns.length,0);assert.equal(rt.active,null);
  assert.deepEqual(logs.filter(l=>l.type==='llm-broken').map(l=>[l.code,l.retry]),[['invalid',true],['invalid',false]]);
  assert.ok(logs.some(l=>l.type==='llm-line-drop'&&l.result==='invalid'));
  m=replies([()=>'抱歉，我无法生成这类内容。']);globalThis.fetch=m.fetch;fx.sim.now+=rt.config.reactionIntervalSec+1;await touch(rt,fx,'a');await flush();
  assert.equal(m.seen.length,1,'a refusal is not retried');
  m=replies([bad],()=>{fx.sim.now+=7;});globalThis.fetch=m.fetch;fx.sim.now+=rt.config.reactionIntervalSec+1;logs.length=0;await touch(rt,fx,'a');await flush();
  assert.equal(m.seen.length,1,'less than half of the 12 s window left: not retried');assert.equal(logs.find(l=>l.type==='llm-broken')?.retry,false);
});


// End-to-end runtime vision requests use fake image data and a mocked endpoint; no screenshots or cloud calls.
const frame=()=>({source:'显示器 test 整屏',capturedAt:Date.now(),fingerprint:'synthetic',dataUrl:'data:image/jpeg;base64,TEST_ONLY',width:10,height:10,valid:()=>true});
function visionChat(observation='左侧是红色矩形。',quiet=false){
  const seen:any[]=[];const fetch=async(_u:unknown,init?:RequestInit)=>{
    const b=JSON.parse(String(init?.body));seen.push(b);const current=b.messages.at(-1).content;
    const text=typeof current==='string'?current:current.find((x:any)=>x.type==='text').text;
    const r={v:Number(/^v: (\d+)$/m.exec(text)![1]),plan:/^plan: (.+)$/m.exec(text)![1],lines:quiet?[]:[{phase:'say',to:'user',text:'我看到红色方块啦。'}],want:'想安静看一会儿',observation};
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(r)},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:40,prompt_tokens_details:{cached_tokens:0}}}));
  };return {seen,fetch:fetch as typeof globalThis.fetch};
}
const observerGen=(rt:LlmRuntime,id:string)=>rt.visionCharacters().find(c=>c.id===id)!.generation;

test('a sole executable behavior still gives Clef the choice between it and rule',async t=>{
  const {rt,fx,a}=setup(t);(fx.sim.charOf('a')!.brain.cfg.behaviors as any[]).splice(0,1);
  let calls=0;globalThis.fetch=async(_u,init)=>{calls++;return decision(JSON.parse(String(init?.body)));};
  rt.setEnabled(true);fx.sim.decisionGate?.('a');rt.step(fx.sim.now,[]);await flush();
  assert.equal(calls,1);assert.equal(a.plan?.behavior,'masturbate');
});

test('a newer empty want withdraws the previous unconsumed desire',async t=>{
  const {rt,fx}=setup(t);let n=0;const m=chat(()=>[],()=>++n===1?'想挥手':'');globalThis.fetch=m.fetch;rt.setEnabled(true);
  await touch(rt,fx,'a');assert.equal((rt as any).wants.get('a').text,'想挥手');
  fx.sim.now+=7;await touch(rt,fx,'a');assert.equal((rt as any).wants.has('a'),false);
});

test('duo jobs bind both original plans, before sending and after returning',async t=>{
  for(const when of ['before-send','in-flight','second-queued'] as const){
    const {rt,fx,a}=setup(t,true);a.stateEnd=fx.sim.now;
    const play=drive(fx.sim).until(e=>e.type==='duo'&&e.what==='play','play');
    const m=chat(r=>[{phase:'start',text:`${r.speaker}的场景开场。`}]);let release:(()=>void)|undefined;
    globalThis.fetch=when==='in-flight'?async(u,init)=>{await new Promise<void>(r=>{release=r;});return m.fetch(u,init);}:m.fetch;
    rt.setEnabled(true);
    if(when==='before-send')(rt as any).busy.add('a');
    rt.step(fx.sim.now,play);await flush();
    fx.sim.grab('b',{x:900,y:950});
    if(when==='in-flight')release!();
    if(when==='before-send')(rt as any).busy.delete('a');
    await flush();rt.step(fx.sim.now,[]);await flush();rt.step(fx.sim.now,[]);await flush();
    assert.equal(m.seen.length,when==='before-send'?0:1,when);
    assert.equal(rt.memory.counts('b','adult').active,0,when);
    if(when!=='second-queued')assert.equal(rt.memory.counts('a','adult').active,0,when);
  }
});

test('multi-line talk cannot fork beyond the configured four-line exchange',async t=>{
  const {rt,fx}=setup(t,true);bothIdle(fx);let n=0;
  const m=chat(r=>Array.from({length:2},()=>({to:r.speaker==='a'?'b':'a',text:`不同句${++n}：${'甲乙丙丁'.repeat(n)}。`})));globalThis.fetch=m.fetch;rt.setEnabled(true);
  await touch(rt,fx,'a');
  for(let i=0;i<60;i++){fx.sim.now+=3;rt.step(fx.sim.now,[]);await flush();}
  assert.ok(m.seen.length<=4,`one seed plus at most three replies, got ${m.seen.length}`);
});

test('expired reaction responses publish neither memory nor want',async t=>{
  const {rt,fx}=setup(t);const m=held(()=>[{text:'已经过时的回应。'}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  await touch(rt,fx,'a');fx.sim.now+=13;m.release();await flush();
  assert.equal(rt.memory.counts('a','adult').active,0);assert.equal(rt.store.recent()[0].result,'stale');
});

test('a queued decision made obsolete by dragging is never sent or charged',async t=>{
  const {rt,fx,a}=setup(t);const m=held(()=>[{text:'占住账户的问候。'}]);let decisions=0;
  globalThis.fetch=async(u,init)=>String(u).includes('systemone')?(decisions++,decision(JSON.parse(String(init?.body)))):m.fetch(u,init);rt.setEnabled(true);
  await touch(rt,fx,'b');fx.sim.decisionGate?.('a');rt.step(fx.sim.now,[]);await flush();
  fx.sim.grab('a',{x:a.x,y:a.y});m.release();await flush();
  assert.equal(decisions,0);assert.equal(rt.store.summary(undefined,'decision').total,0);
  assert.equal(a.state,'dragged');
});

test('an event inbox from an old actor cannot trigger a replacement actor',async t=>{
  const {rt,fx}=setup(t);const m=chat(()=>[{text:'不该给新实例的回应。'}]);globalThis.fetch=m.fetch;rt.setEnabled(true);
  rt.step(fx.sim.now,[poke('a')]);fx.sim.spawn('a',{x:500,y:1040});bothIdle(fx);
  fx.sim.now+=2;rt.step(fx.sim.now,[]);await flush();assert.equal(m.seen.length,0);
});

test('transport retries each consume a request slot and stop at the hourly cap',async t=>{
  const {rt,fx}=setup(t);rt.setHourlyLimit(1);rt.setEnabled(true);let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'0'}});};
  await touch(rt,fx,'a');await new Promise(r=>setTimeout(r,25));await flush();
  assert.equal(calls,1);assert.equal(rt.store.summary().total,1);assert.equal(rt.store.recent()[0].result,'http');
  assert.equal(rt.limitHit?.reason,'hourly');
});

test('automatic observation yields to interactions while an explicit manual look keeps user priority',async t=>{
  const {rt}=setup(t);rt.setEnabled(true);const order:string[]=[];let release!:()=>void;
  globalThis.fetch=async(_u,init)=>{const tag=String(init?.body);order.push(tag);if(tag==='block')await new Promise<void>(r=>{release=r;});return new Response('{}');};
  const job=(id:string,kind:string,priority?:number)=>(rt as any).tracked(id,kind,'ollama-text',new AbortController().signal,
    async(s:AbortSignal,send:typeof fetch)=>{await send('http://127.0.0.1:18888/v1/test',{method:'POST',body:id,signal:s});return {usage:null};},undefined,priority);
  const first=job('block','reaction');await flush();
  const auto=job('auto','vision'),reaction=job('reaction','reaction'),manual=job('manual','vision',5);
  release();await Promise.all([first,auto,reaction,manual]);assert.deepEqual(order,['block','manual','reaction','auto']);
});

test('successful transport after two retryable failures records all three exchanges',async t=>{
  const {rt,fx}=setup(t);rt.setEnabled(true);let calls=0;const m=chat(()=>[{text:'这次网络终于恢复啦。'}]);
  globalThis.fetch=async(u,init)=>++calls<3?new Response('{}',{status:503,headers:{'retry-after':'0'}}):m.fetch(u,init);
  await touch(rt,fx,'a');await new Promise(r=>setTimeout(r,25));await flush();
  assert.equal(calls,3);assert.equal(rt.store.summary().total,3);
  assert.deepEqual(rt.store.recent().map(x=>x.result),['ok','http','http']);
});

test('failed compaction backs off and request history stays within its character and turn budgets',async t=>{
  const {rt,fx}=setup(t);Object.assign(rt.config.context,{maxTurns:3,dropTurns:2,maxChars:1000});
  for(let i=0;i<3;i++)rt.memory.append('a','adult',{at:i,kind:'line',user:`旧记录${i}`+'甲'.repeat(400),reply:'{"lines":[],"want":""}'});
  let summaries=0;const m=chat(()=>[]);
  globalThis.fetch=async(u,init)=>{
    const body=JSON.parse(String(init?.body));
    if(body.messages.at(-1).content.includes('整理记忆')){summaries++;throw new Error('synthetic outage');}
    return m.fetch(u,init);
  };
  rt.setEnabled(true);await touch(rt,fx,'a');fx.sim.now+=7;await touch(rt,fx,'a');
  assert.equal(summaries,1,'one summary attempt per backoff interval, not per text turn');
  const history=m.seen[0].body.messages.slice(1,-1);
  assert.ok(history.reduce((n:number,x:any)=>n+Array.from(x.content).length,0)<=1000);
  assert.ok(history.length<=6);
});

test('queued summaries are invalidated by forgetting before a network request is sent',async t=>{
  const {rt,fx}=setup(t);Object.assign(rt.config.context,{maxTurns:3,dropTurns:2});rt.setEnabled(true);
  const m=held(()=>[{text:'账户正在说这句。'}]);let summaries=0;
  globalThis.fetch=async(u,init)=>{
    const body=JSON.parse(String(init?.body));
    if(body.messages?.at(-1).content.includes('整理记忆')){summaries++;return new Response(JSON.stringify({choices:[{message:{content:'{"memory":"旧内容"}'}}],usage:{prompt_tokens:10,completion_tokens:5}}));}
    return m.fetch(u,init);
  };
  await touch(rt,fx,'b');
  for(let i=0;i<4;i++)rt.memory.append('a','adult',{at:i,kind:'line',user:`旧事${i}`,reply:'{"lines":[]}'});
  const summary=(rt as any).compact('a','adult');await flush();rt.forgetMemory('a','adult');m.release();await summary;await flush();
  assert.equal(summaries,0);assert.equal(rt.memory.counts('a','adult').active,0);
});

test('cached image permission revoked during HTTP backoff prevents an image-bearing retry',async t=>{
  const {rt,fx}=setup(t);rt.setEnabled(true);rt.setVision({enabled:true});let permitted=true;
  const image={...frame(),valid:()=>permitted};globalThis.fetch=visionChat('合成图的普通观察。',true).fetch;
  assert.ok(await rt.observe('a',observerGen(rt,'a'),image,true));let calls=0;
  globalThis.fetch=async(_u,init)=>{
    const messages=JSON.parse(String(init?.body)).messages;assert.ok(Array.isArray(messages[1].content));
    calls++;permitted=false;return new Response('{}',{status:503,headers:{'retry-after':'0'}});
  };
  await touch(rt,fx,'a');await new Promise(r=>setTimeout(r,25));await flush();assert.equal(calls,1);
});

test('forget, mode switch and suspend invalidate an in-flight capture before it can enter a fresh conversation',async t=>{
  for(const change of ['forget','mode','suspend'] as const){
    const {rt,fx}=setup(t,true);bothIdle(fx);rt.setEnabled(true);rt.setVision({enabled:true});
    const mock=visionChat('清空前的旧图。',true);globalThis.fetch=mock.fetch;
    let finish!:(f:ReturnType<typeof frame>)=>void;
    const observer=new Observer({config:()=>rt.config.vision,active:()=>true,characters:()=>rt.visionCharacters(),target:()=>({displayId:'1'}),
      capture:()=>new Promise(r=>{finish=r;}),deliver:(id,gen,f,manual)=>rt.observe(id,gen,f,manual)});
    rt.onVisionChange=id=>observer.reset(id);t.after(()=>observer.close());
    assert.equal(observer.request('a'),true);
    if(change==='forget')rt.forgetMemory('a','adult');
    else if(change==='mode'){rt.setEnabled(false);fx.sim.setR18(false);rt.setEnabled(true);}
    else{rt.suspend(true);rt.suspend(false);}
    finish(frame());await flush();assert.equal(mock.seen.length,0,change);
    assert.equal(rt.memory.counts('a','adult').active,0);assert.equal(rt.memory.counts('a','sfw').active,0);
  }
});

test('vision repair preserves observation requirements and accepts the same fenced JSON as dialogue',async t=>{
  const {rt,fx}=setup(t,true);bothIdle(fx);rt.setEnabled(true);rt.setVision({enabled:true});
  const mock=visionChat('合成图中有红色矩形。',true);let calls=0;
  globalThis.fetch=async(u,init)=>{
    const body=JSON.parse(String(init?.body));if(calls)assert.ok(String(body.messages.at(-1).content).includes('observation'));
    const forMock=calls?{...body,messages:body.messages.slice(0,-1)}:body;
    const response=await mock.fetch(u,{...init,body:JSON.stringify(forMock)}),raw=await response.json(),content=JSON.parse(raw.choices[0].message.content);
    if(!calls++)delete content.observation;
    raw.choices[0].message.content='```json\n'+JSON.stringify(content)+'\n```';return new Response(JSON.stringify(raw));
  };
  assert.equal(await rt.observe('a',observerGen(rt,'a'),frame(),true),true);assert.equal(calls,2);assert.equal(rt.memory.counts('a','adult').active,1);
});

test('editing A settings leaves B image result valid, including an unrelated A context-size change',async t=>{
  for(const patch of [{maxTurns:60},{vision:{auto:false}}]){
    const {rt,fx}=setup(t,true);bothIdle(fx);rt.setEnabled(true);rt.setVision({enabled:true});
    const mock=visionChat('合成图。',true);let finish!:(r:Response)=>void,response!:Response;
    globalThis.fetch=async(u,init)=>{response=await mock.fetch(u,init);return new Promise<Response>(r=>{finish=r;});};
    const pending=rt.observe('b',observerGen(rt,'b'),frame(),true);await flush();rt.setCharacter('a',patch);finish(response);
    assert.equal(await pending,true);assert.equal(rt.memory.counts('b','adult').active,1);
  }
});
test('vision enters the existing character session, quiet observations persist, followups get short-lived images, other characters never do',async t=>{
  const {rt,fx}=setup(t,true);bothIdle(fx);const mock=visionChat('左侧是红色矩形，右侧是蓝色圆形。',true);globalThis.fetch=mock.fetch;
  rt.setEnabled(true);rt.setVision({enabled:true});
  assert.equal(await rt.observe('a',observerGen(rt,'a'),frame(),true),true);
  const saved=rt.memory.window('a','adult').turns;assert.equal(saved.length,1);assert.ok(saved[0].user.includes('观察记录（模型描述）：左侧是红色矩形'));
  assert.equal(saved[0].user.includes('data:image'),false);assert.ok(saved[0].reply.includes('想安静看一会儿'));assert.equal(rt.active,null);
  assert.equal(rt.store.summary(undefined,'vision').total,1);assert.ok(Array.isArray(mock.seen[0].messages.at(-1).content));
  await touch(rt,fx,'b');assert.equal(mock.seen[1].messages.some((m:any)=>Array.isArray(m.content)),false);
  await touch(rt,fx,'a');assert.ok(Array.isArray(mock.seen[2].messages[1].content));
  rt.forgetImages('a');fx.sim.now+=rt.config.reactionIntervalSec;await touch(rt,fx,'a');assert.equal(mock.seen[3].messages.some((m:any)=>Array.isArray(m.content)),false);
});
test('vision rejects unsupported providers, stale frames, privacy revocation, absence and hard budgets without making a request',async t=>{
  const {rt,fx}=setup(t,true);bothIdle(fx);const mock=visionChat();globalThis.fetch=mock.fetch;rt.setEnabled(true);rt.setVision({enabled:true});
  rt.setProviderImages('ollama-text',false);assert.equal(await rt.observe('a',observerGen(rt,'a'),frame(),true),false);
  rt.setProviderImages('ollama-text',true);assert.equal(await rt.observe('a',observerGen(rt,'a'),{...frame(),capturedAt:Date.now()-31000},true),false);
  assert.equal(await rt.observe('a',observerGen(rt,'a'),{...frame(),valid:()=>false},true),false);
  rt.setHourlyLimit(1);rt.store.record({at:Date.now(),character:'a',kind:'line',provider:'ollama-text',model:'test',usage:null,costUsd:null,latencyMs:1,result:'ok'});
  assert.equal(await rt.observe('a',observerGen(rt,'a'),frame(),true),false);assert.equal(mock.seen.length,0);
  rt.setHourlyLimit(null);const gen=observerGen(rt,'a');fx.sim.setAbsent(['a']);assert.equal(await rt.observe('a',gen,frame(),true),false);
});
test('queued vision rechecks the master switch at send time, and never sends the queued image after revocation',async t=>{
  const {rt,fx}=setup(t,true);bothIdle(fx);const mock=visionChat();let finish!:(r:Response)=>void,firstBody:any;let calls=0;
  globalThis.fetch=async(u,init)=>{calls++;if(calls===1){firstBody=JSON.parse(String(init?.body));return new Promise<Response>(r=>{finish=r;});}return mock.fetch(u,init);};
  rt.setEnabled(true);rt.setVision({enabled:true});await touch(rt,fx,'a');
  const pending=rt.observe('b',observerGen(rt,'b'),frame(),true);await flush();assert.equal(calls,1);rt.setVision({enabled:false});
  const user=firstBody.messages.at(-1).content as string;finish(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({v:Number(/^v: (\d+)$/m.exec(user)![1]),plan:/^plan: (.+)$/m.exec(user)![1],lines:[]})},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:5}})));
  assert.equal(await pending,false);assert.equal(calls,1);assert.equal(rt.memory.counts('b','adult').active,0);
});
test('HTTP image rejection pauses automatic observation for that provider, manual retry can verify it again',async t=>{
  const {rt,fx}=setup(t,true);bothIdle(fx);rt.setEnabled(true);rt.setVision({enabled:true,auto:true});globalThis.fetch=async()=>new Response('',{status:400});
  assert.equal(await rt.observe('a',observerGen(rt,'a'),frame(),true),false);assert.equal(rt.imageStatus('a'),'failed');assert.equal(rt.visionCharacters().find(c=>c.id==='a')!.auto,false);
  globalThis.fetch=visionChat().fetch;assert.equal(await rt.observe('a',observerGen(rt,'a'),frame(),true),true);assert.equal(rt.imageStatus('a'),'verified');assert.equal(rt.visionCharacters().find(c=>c.id==='a')!.auto,true);
});
test('live vision settings preserve unrelated config, validate overrides, and invalidate in-flight results when changed',async t=>{
  const {rt,fx,root}=setup(t,true);bothIdle(fx);rt.setEnabled(true);rt.setVision({enabled:true});
  assert.equal(rt.setVision({scope:'window'}),false);assert.equal(rt.setVision({scope:'prefer-window'}),false);assert.equal(rt.setCharacter('a',{vision:{intervalSec:4}}),false);
  assert.equal(rt.setCharacter('a',{vision:{auto:true,intervalSec:7}}),true);assert.equal(rt.visionCharacters().find(c=>c.id==='a')!.intervalSec,7);
  let finish!:(r:Response)=>void,body:any;globalThis.fetch=async(_u,init)=>{body=JSON.parse(String(init?.body));return new Promise<Response>(r=>{finish=r;});};
  const pending=rt.observe('a',observerGen(rt,'a'),frame(),true);await flush();rt.setCharacter('a',{vision:{auto:false}});
  const text=body.messages.at(-1).content[0].text;finish(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({v:Number(/^v: (\d+)$/m.exec(text)![1]),plan:/^plan: (.+)$/m.exec(text)![1],lines:[],observation:'合成图'})},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:5}})));
  assert.equal(await pending,false);assert.equal(rt.memory.counts('a','adult').active,0);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'config','llm.local.json'),'utf8')).vision.enabled,true);
});
