import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDuo,drive,DT} from './helpers/fake-scene.ts';
import {makeWindow,rect} from './helpers/fake-desktop.ts';
import {setPlan,type MindConfig} from '../src/behavior/index.ts';
import {controlSeconds} from '../src/main/intent-control.ts';

const idle:MindConfig={schema:1,stats:{},behaviors:[{id:'idle',weight:1,steps:[{do:'idle',sec:0.1}]}]};
function free(fx:ReturnType<typeof makeDuo>,id='a'){
  const a=fx.sim.charOf(id)!.actor!;a.support=fx.sim.supports.find(s=>s.kind==='floor')!;
  a.y=a.support.y;a.state='idle';a.plan=null;a.step=null;a.phase=null;a.stateEnd=Infinity;return a;
}
const select=(fx:ReturnType<typeof makeDuo>,id:string,behavior:string)=>{
  const a=fx.sim.charOf(id)!.actor!,candidate=fx.sim.llmCandidates(id).find(c=>c.behavior===behavior)!;
  assert.ok(candidate,`${id}/${behavior}`);assert.ok(fx.sim.applyLlmIntent(id,a.epoch,candidate.id,a));
};
function approach(){
  const fx=makeDuo({aMind:{schema:1,stats:{energy:{start:50,perHour:3600}},behaviors:[
    {id:'approach',weight:1,steps:[{do:'approach',who:'b',gap:0.5,sec:0.2}]},
    {id:'wander',weight:1000000,steps:[{do:'wander'}]},
  ]},bMind:{schema:1,stats:{},behaviors:[{id:'wander',weight:1,steps:[{do:'wander'}]}]}});
  free(fx);free(fx,'b');fx.sim.setLlmControlSeconds(8);return fx;
}

test('rendezvous pauses a moving ambient target, then both reach idle without rule drift; stats keep advancing',()=>{
  const fx=approach(),b=fx.sim.charOf('b')!.actor!;
  fx.sim.applyLlmIntent('b',b.epoch,null,b);assert.equal(b.state,'walk');
  select(fx,'a','approach');assert.equal(b.state,'idle');
  assert.equal(fx.sim.llmSnapshot('b')!.self.routine_control?.owner,'a');
  assert.ok(fx.sim.llmSnapshot('b')!.behaviors.every(o=>o.blocked_by.includes('actor_reserved')));
  const x=b.x,start=fx.sim.now,drv=drive(fx.sim);
  drv.until(e=>e.type==='plan-end'&&e.behavior==='approach'&&e.outcome==='done','arrival');
  assert.equal(b.x,x);assert.ok(Math.abs(fx.sim.charOf('a')!.actor!.x-b.x)<=61);
  assert.ok(fx.sim.charOf('a')!.brain.stats.energy>50);
  while(drv.now<start+7.8)drv.frame();
  assert.equal(b.x,x);assert.equal(fx.sim.charOf('a')!.actor!.plan,null);
  drv.until(e=>e.type==='plan'&&e.behavior==='wander','routine resumes',2);
  assert.equal(fx.sim.llmSnapshot('b')!.self.routine_control,null);
});

test('a reserved target rejects a late independent model choice; grab, departure and mode change release it',()=>{
  for(const kind of ['grab-owner','grab-target','despawn','sfw','disable'] as const){
    const fx=approach(),a=fx.sim.charOf('a')!.actor!,b=fx.sim.charOf('b')!.actor!;
    const old=fx.sim.llmCandidates('b')[0].id;
    select(fx,'a','approach');
    assert.equal(fx.sim.applyLlmIntent('b',b.epoch,old,b),false);
    if(kind==='grab-owner')fx.sim.grab('a',{x:a.x,y:a.y});
    if(kind==='grab-target')fx.sim.grab('b',{x:b.x,y:b.y});
    if(kind==='despawn')fx.sim.despawn('a');
    if(kind==='sfw')fx.sim.setR18(false);
    if(kind==='disable')fx.sim.clearLlmControl();
    assert.equal(fx.sim.llmSnapshot('b')!.self.routine_control,null,kind);
  }
});

test('protection prevents covered-rule reselection, but expiry never forcibly interrupts the active plan',()=>{
  const fx=approach();fx.sim.setLlmControlSeconds(4);
  fx.sim.setDesktop({...fx.sim.desktop,windows:[makeWindow(90,rect(100,650,1600,1060))]});
  select(fx,'a','approach');const drv=drive(fx.sim),start=drv.now;
  while(drv.now<start+3.5)drv.frame();
  assert.ok(!drv.log.some(x=>x.id==='a'&&x.e.type==='state'&&x.e.reason==='covered'));
  assert.ok(!drv.log.some(x=>x.id==='a'&&x.e.type==='plan-end'&&x.e.outcome==='aborted'));
  while(drv.now<start+4.1)drv.frame();
  assert.equal(fx.sim.llmSnapshot('a')!.self.routine_control,null);
  assert.ok(!drv.log.some(x=>x.id==='a'&&x.e.type==='plan-end'&&x.e.outcome==='aborted'));
});

test('a long explicit plan remains protected from new coverage after its timed grace has expired',()=>{
  const fx=makeDuo({aMind:{schema:1,stats:{},behaviors:[
    {id:'sit',weight:1,steps:[{do:'sit',sec:20}]},{id:'wander',weight:1000000,steps:[{do:'wander'}]},
  ]},bMind:idle,extraActions:{sit:{clip:'sit',frames:1,fps:1,loop:true}}});
  const a=free(fx);free(fx,'b');fx.sim.setLlmControlSeconds(1);select(fx,'a','sit');
  const drv=drive(fx.sim);drv.frames(90);
  assert.equal(fx.sim.llmSnapshot('a')!.self.routine_control,null);
  fx.sim.setDesktop({...fx.sim.desktop,windows:[makeWindow(90,rect(100,650,1600,1060))]});
  drv.frames(220);assert.equal(a.plan?.behavior,'sit');
  assert.ok(!drv.log.some(x=>x.id==='a'&&x.e.type==='plan-end'&&x.e.outcome==='aborted'));
});

test('changing duration applies to future choices and simulation time excludes a paused wall-clock gap',()=>{
  const fx=approach();select(fx,'a','approach');
  const left=fx.sim.llmSnapshot('b')!.self.routine_control!.remaining_s;
  fx.sim.setLlmControlSeconds(8);fx.sim.setLlmControlSeconds(0);
  assert.equal(fx.sim.llmSnapshot('b')!.self.routine_control!.remaining_s,left);
  fx.sim.step(fx.sim.now+100,DT);
  assert.ok(fx.sim.llmSnapshot('b')!.self.routine_control!.remaining_s>left-0.1);
});

test('disabling model control drops pending goals while letting the active plan finish',()=>{
  const fx=approach(),a=fx.sim.charOf('a')!.actor!;
  (fx.sim.charOf('a')!.brain.cfg.behaviors as any[]).push({id:'rest',weight:1,steps:[{do:'idle',sec:1}]});
  const options=fx.sim.llmCandidates('a');
  fx.sim.applyLlmPlan('a',a.epoch,['approach','rest'].map(id=>options.find(c=>c.behavior===id)!.id),a);
  fx.sim.clearLlmControl();assert.equal(a.plan?.behavior,'approach');
  assert.deepEqual(fx.sim.llmSnapshot('a')!.pending_goals,[]);
  const drv=drive(fx.sim);drv.until(e=>e.type==='plan-end'&&e.behavior==='approach'&&e.outcome==='done','active completion');
  assert.ok(!drv.log.some(x=>x.id==='a'&&x.e.type==='plan'&&x.e.behavior==='rest'));
});

test('an explicit target plan and an adult target activity are never replaced with ambient wait',()=>{
  for(const adult of [false,true]){
    const fx=approach(),b=fx.sim.charOf('b')!.actor!;
    if(adult){
      const ch=fx.sim.charOf('b')!;
      setPlan(b,ch.spec,{behavior:'test:adult',steps:[{state:'masturbate',action:'wave',sec:30}]},(fx.sim as any).ctx(),'test');
    }else select(fx,'b','wander');
    const plan=b.plan;select(fx,'a','approach');
    assert.equal(b.plan,plan);assert.notEqual(b.plan?.behavior,'system:intent-wait');
    if(!adult){fx.sim.step(fx.sim.now+DT,DT);fx.sim.step(fx.sim.now+DT,DT);assert.notEqual(fx.sim.charOf('a')!.actor!.plan?.behavior,'approach');}
  }
});

test('the model may start a follow-up paired goal with its waiting target without waiting for protection expiry',()=>{
  const fx=makeDuo(),a=free(fx);free(fx,'b');
  (fx.sim.charOf('a')!.brain.cfg.behaviors as any[]).push({id:'approach',weight:1,steps:[{do:'approach',who:'b',gap:0.5,sec:0.2}]});
  const choices=fx.sim.llmCandidates('a');
  assert.ok(fx.sim.applyLlmPlan('a',a.epoch,['approach','sex'].map(id=>choices.find(c=>c.behavior===id)!.id),a));
  assert.equal(fx.sim.llmSnapshot('b')!.self.routine_control?.owner,'a');
  const drv=drive(fx.sim);drv.until(e=>e.type==='duo'&&e.what==='play','paired start');
  assert.ok(fx.sim.duos.some(d=>d.stage==='play'));assert.ok(drv.now<30);
});

test('paired preview respects the partner explicit plan and its own acceptance, rather than interrupting it',()=>{
  const fx=makeDuo(),a=free(fx);free(fx,'b');
  select(fx,'b','idle');
  assert.ok(!fx.sim.llmCandidates('a').some(c=>c.scene));
  const partnerPlan=fx.sim.charOf('b')!.actor!.plan;
  fx.sim.applyLlmIntent('a',a.epoch,null,a);
  assert.equal(fx.sim.charOf('b')!.actor!.plan,partnerPlan);assert.equal(fx.sim.duos.length,0);
  const refused=makeDuo({bDesire:0});free(refused);free(refused,'b');
  assert.ok(!refused.sim.llmCandidates('a').some(c=>c.scene));
});

test('zero seconds opts out of waiting; explicit rule fallback releases grace immediately',()=>{
  const fx=approach();fx.sim.setLlmControlSeconds(0);select(fx,'a','approach');
  assert.equal(fx.sim.llmSnapshot('b')!.self.routine_control,null);
  const solo=makeDuo({aMind:idle,bMind:idle});const a=free(solo);free(solo,'b');select(solo,'a','idle');
  const drv=drive(solo.sim);drv.until(e=>e.type==='plan-end'&&e.behavior==='idle','finish');
  assert.ok(solo.sim.llmSnapshot('a')!.self.routine_control);
  assert.ok(solo.sim.applyLlmIntent('a',a.epoch,null,a));
  assert.equal(solo.sim.llmSnapshot('a')!.self.routine_control,null);assert.equal(a.plan?.behavior,'idle');
  for(const invalid of [-1,NaN,Infinity,301,'30',null])assert.equal(controlSeconds(invalid),30);
});

test('explicit model choices can override preference and zero score, while routine rules and hard checks remain intact',()=>{
  const fx=makeDuo({aDesire:0,aMind:{schema:1,stats:{desire:{start:0}},behaviors:[
    {id:'idle',weight:1,steps:[{do:'idle',sec:1}]},
    {id:'chosen',weight:{var:'self.stats.desire'},prefer:{'>=':[{var:'self.stats.desire'},60]},r18:true,cooldown:100,when:{'>=':[{var:'self.stats.desire'},0]},
      steps:[{do:'play',action:'wave',state:'masturbate',sec:1}]},
  ]}});const a=free(fx),ch=fx.sim.charOf('a')!;
  const routine=ch.brain.availability(fx.sim.view(ch),fx.sim.now,{r18:true}).find(o=>o.def.id==='chosen')!;
  assert.ok(routine.blocked_by.includes('preference_not_met'));assert.ok(routine.blocked_by.includes('weight_zero'));
  const status=fx.sim.llmSnapshot('a')!.behaviors.find(o=>o.id==='chosen')!;
  assert.equal(status.preference_met,false);assert.equal(status.rule_weight,0);assert.equal(status.available,true);
  assert.equal(fx.sim.llmSnapshot('a')!.self.stats.desire,0);
  select(fx,'a','chosen');assert.equal(a.state,'masturbate');
  const drv=drive(fx.sim);drv.until(e=>e.type==='plan-end'&&e.behavior==='chosen','finish');
  assert.ok(!fx.sim.llmCandidates('a').some(c=>c.behavior==='chosen'),'cooldown remains hard');
  ch.brain.cooldown(ch.brain.cfg.behaviors[1],fx.sim.now,0);
  ch.brain.stats.desire=-1;assert.ok(!fx.sim.llmCandidates('a').some(c=>c.behavior==='chosen'),'when remains hard');
  ch.brain.stats.desire=0;fx.sim.setR18(false);assert.ok(!fx.sim.llmCandidates('a').some(c=>c.behavior==='chosen'),'mode remains hard');
});
