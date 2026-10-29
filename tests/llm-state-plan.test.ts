import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDuo, drive, DT} from './helpers/fake-scene.ts';
import {rect, makeWindow} from './helpers/fake-desktop.ts';
import {bodyX, setPlan, type MindConfig} from '../src/behavior/index.ts';

function ready(fx: ReturnType<typeof makeDuo>, id = 'a') {
  const a = fx.sim.charOf(id)!.actor!;
  a.support = fx.sim.supports.find(s=>s.kind==='floor')!; a.y=a.support.y;
  a.state='idle'; a.plan=null; a.step=null; a.phase=null; a.stateEnd=Infinity;
  return a;
}
const mind: MindConfig = {schema:1,stats:{energy:{start:50}},behaviors:[
  {id:'approach',weight:1,cooldown:5,steps:[{do:'approach',who:'b',sec:0.1,gap:0.5}]},
  {id:'rest',weight:1,cooldown:10,steps:[{do:'sit',sec:0.2}]},
  {id:'wave',weight:1,cooldown:10,steps:[{do:'play',action:'wave',sec:0.2}]},
]};
function fixture() {
  const fx=makeDuo({aMind:mind,extraActions:{sit:{frames:1,fps:1,loop:true,clip:'sit'}}});
  const a=ready(fx);ready(fx,'b'); fx.sim.decisionGate=()=>true;
  return {...fx,a};
}
const choice=(fx: ReturnType<typeof makeDuo>, behavior:string)=>fx.sim.llmCandidates('a').find(i=>i.behavior===behavior)!.id;

test('state protocol has foot coordinates, display bounds and presence independent of visibility; snapshot owns its data',()=>{
  const fx=fixture(), b=fx.sim.charOf('b')!.actor!;
  fx.sim.desktop.displays.push({id:2,bounds:rect(-1920,-100,0,1080),workArea:rect(-1920,-100,0,1040),scale:2});
  b.x=-500;b.y=1040;
  const snap=fx.sim.llmSnapshot('a')!;
  assert.equal(snap.state_schema,1);assert.deepEqual(snap.self.position,{x:fx.a.x,y:fx.a.y});
  assert.equal(snap.others[0].display_id,2);assert.equal(snap.others[0].position.x,-500);
  assert.ok(!JSON.stringify(snap).includes('distance'));
  snap.displays[0].bounds.left=999;snap.self.stats.energy=0;
  assert.equal(fx.sim.desktop.displays[0].bounds.left,0);assert.equal(fx.sim.charOf('a')!.brain.stats.energy,50);
  fx.sim.setAbsent(['b']);assert.equal(fx.sim.llmSnapshot('a')!.others.length,0);
});

test('catalog excludes missing default sit and explicit actions, while diagnostics do not inherit the 25-choice limit',()=>{
  const behaviors:MindConfig['behaviors']=[
    {id:'sit-missing',weight:1,steps:[{do:'sit',sec:1}]},
    {id:'animation-missing',weight:1,steps:[{do:'play',action:'not-in-pack'}]},
    ...Array.from({length:30},(_,i)=>({id:`idle-${i}`,weight:1,steps:[{do:'idle' as const,sec:1}]})),
  ];
  const fx=makeDuo({aMind:{schema:1,stats:{},behaviors}});ready(fx);
  assert.equal(fx.sim.llmCapabilities('a').length,30);assert.equal(fx.sim.llmSnapshot('a')!.behaviors.length,30);
  assert.equal(fx.sim.llmCandidates('a').length,25);
  const statuses=fx.sim.llmSnapshot('a')!.behaviors;
  assert.equal(statuses.filter(s=>s.decision_selectable).length,25);
  assert.ok(statuses.slice(25).every(s=>s.available&&!s.decision_selectable),'valid behavior outside the selection table is not advertised as selectable');
});

test('same rule results report multiple blockers and decreasing cooldown without inventing psychological reasons',()=>{
  const fx=fixture(),brain=fx.sim.charOf('a')!.brain;
  const def={id:'blocked',weight:0,when:false,cooldown:12,steps:[{do:'idle' as const,sec:1}]};
  (brain.cfg.behaviors as unknown as object[]).push(def);brain.started(def,fx.sim.now);
  const first=fx.sim.llmSnapshot('a')!.behaviors.find(b=>b.id==='blocked')!;
  assert.deepEqual(first.blocked_by,['condition_not_met','cooldown','weight_zero']);assert.equal(first.cooldown_remaining_s,12);
  fx.sim.now+=3;assert.equal(fx.sim.llmSnapshot('a')!.behaviors.find(b=>b.id==='blocked')!.cooldown_remaining_s,9);
  assert.ok(!fx.sim.llmCandidates('a').some(b=>b.behavior==='blocked'));
});

test('ordered goals reach the target then sit then wave, with fresh checks and independent effects/cooldowns',()=>{
  const fx=fixture();const goals=['approach','rest','wave'].map(b=>choice(fx,b));
  assert.ok(fx.sim.applyLlmPlan('a',fx.a.epoch,goals,fx.a));
  assert.deepEqual(fx.sim.llmSnapshot('a')!.pending_goals.map(g=>g.behavior),['rest','wave']);
  const drv=drive(fx.sim);drv.until(e=>e.type==='plan'&&e.behavior==='rest','sit');
  assert.ok(Math.abs(fx.a.x-fx.sim.charOf('b')!.actor!.x)<=61);assert.equal(fx.a.state,'sit');
  drv.until(e=>e.type==='plan'&&e.behavior==='wave','wave');
  assert.equal(fx.a.action,'wave');assert.equal(fx.sim.llmSnapshot('a')!.pending_goals.length,0);
});

test('approach aligns visible bodies across pose offsets instead of approaching model origins',()=>{
  for(const side of [-1,1]) {
  const fx=makeDuo({aMind:mind,extraActions:{
    walk:{frames:1,fps:1,loop:true,clip:'walk',hip:{right:[0.2],left:[-0.2]}},
    pose:{frames:1,fps:1,loop:true,clip:'pose',hip:{right:[0.8],left:[0.8]}},
  }});
  const a=ready(fx),b=ready(fx,'b');a.x=side<0?300:1000;b.x=600;b.action='pose';fx.sim.decisionGate=()=>true;
  const before=bodyX(b,fx.sim.charOf('b')!.spec,fx.sim.ctx());
  fx.sim.applyLlmPlan('a',a.epoch,[choice(fx,'approach')],a);
  assert.equal(a.step?.targetBodyX,before+side*60);
  const snap=fx.sim.llmSnapshot('a')!;
  assert.equal(snap.self.motion.direction,side<0?'right':'left');assert.equal(snap.self.motion.body_destination_x,before+side*60);
  assert.equal(snap.others[0].body_position.x,before);assert.equal(snap.others[0].motion.kind,'stationary');
  drive(fx.sim).until(e=>e.type==='plan-end'&&e.behavior==='approach','arrived');
  const actual=bodyX(a,fx.sim.charOf('a')!.spec,fx.sim.ctx());
  assert.ok(Math.abs(actual-(before+side*60))<1,`${actual} should be ${before+side*60}`);
  }
});

test('a moved or departed target cancels the remaining goals, and dragging never resumes a previous chain',()=>{
  for (const cause of ['move','leave','grab'] as const) {
    const fx=fixture();fx.sim.applyLlmPlan('a',fx.a.epoch,['approach','rest'].map(b=>choice(fx,b)),fx.a);
    if(cause==='move')fx.sim.charOf('b')!.actor!.x+=30;
    if(cause==='leave')fx.sim.setAbsent(['b']);
    if(cause==='grab')fx.sim.grab('a',{x:fx.a.x,y:fx.a.y});
    fx.sim.step(fx.sim.now+DT,DT);
    assert.equal(fx.sim.llmSnapshot('a')!.pending_goals.length,0,cause);
    assert.notEqual(fx.a.plan?.behavior,'rest',cause);
  }
});

test('replacing a target at the same location invalidates the original approach',()=>{
  const fx=fixture(),b=fx.sim.charOf('b')!.actor!;
  fx.sim.applyLlmPlan('a',fx.a.epoch,['approach','rest'].map(x=>choice(fx,x)),fx.a);
  fx.sim.spawn('b',{x:b.x,y:b.y});ready(fx,'b');
  const events=fx.sim.step(fx.sim.now+DT,DT);
  assert.ok(events.some(x=>x.e.type==='intent-plan'&&x.e.what==='cancelled'));
  assert.equal(fx.sim.llmSnapshot('a')!.pending_goals.length,0);
});

test('movement timeout and changed eligibility cancel prerequisites instead of proceeding to sit',()=>{
  const slow=fixture();slow.sim.charOf('a')!.spec.tuning.walkMaxSec=0;
  slow.sim.applyLlmPlan('a',slow.a.epoch,['approach','rest'].map(b=>choice(slow,b)),slow.a);
  const timeout=drive(slow.sim).until(e=>e.type==='plan-end'&&e.outcome==='aborted','movement timeout');
  assert.ok(timeout.some(x=>x.e.type==='plan-end'&&x.e.outcome==='aborted'));
  assert.equal(slow.sim.llmSnapshot('a')!.pending_goals.length,0);assert.notEqual(slow.a.plan?.behavior,'rest');
  const changed=fixture();changed.sim.applyLlmPlan('a',changed.a.epoch,['approach','rest'].map(b=>choice(changed,b)),changed.a);
  changed.sim.charOf('a')!.brain.cooldown(mind.behaviors[1],changed.sim.now,100);
  const drv=drive(changed.sim);drv.until(e=>e.type==='intent-plan','cancelled');
  assert.notEqual(changed.a.plan?.behavior,'rest');
});

test('population limit controls actual instances, never overrides user selection, refills slots and blocks summon bypass',()=>{
  const fx=fixture();fx.sim.setPopulationLimit(1);
  assert.equal(fx.sim.actors.length,1);const kept=fx.sim.actors[0].id,waiting=kept==='a'?'b':'a';
  assert.ok(fx.sim.isAbsent(waiting));assert.equal(fx.sim.isRequestedAbsent(waiting),false);
  assert.equal(fx.sim.spawn(waiting,{x:300,y:0}),null);
  assert.equal(fx.sim.llmSnapshot(kept)!.others.length,0);
  fx.sim.setAbsent([kept]);assert.equal(fx.sim.actors.length,1);assert.equal(fx.sim.actors[0].id,waiting);
  fx.sim.setPopulationLimit(null);assert.equal(fx.sim.actors.length,1,'explicitly disabled resident stays disabled');
  fx.sim.setAbsent([]);assert.equal(fx.sim.actors.length,2);
});

test('snapshot occlusion follows the actual body rather than an offset model origin',()=>{
  const fx=makeDuo({aMind:mind,extraActions:{pose:{frames:1,fps:1,loop:true,clip:'pose',hip:{right:[0.8],left:[0.8]}}}});
  const a=ready(fx),c=fx.sim.charOf('a')!;a.action='pose';a.actionStart=fx.sim.now;
  const box=fx.sim.boxOf(c,a);
  fx.sim.desktop.windows=[makeWindow(99,box,{topmost:true})];fx.sim.desktop.overlayAbove={1:[99]};
  assert.equal(fx.sim.llmSnapshot('a')!.self.covered_fraction,1);
});

test('a stationary target changing pose keeps the approach sequence alive',()=>{
  const fx=makeDuo({aMind:mind,extraActions:{sit:{frames:1,fps:1,loop:true,clip:'sit'},pose:{frames:1,fps:1,loop:true,clip:'pose',hip:{right:[0.4],left:[0.4]}}}});
  const a=ready(fx),b=ready(fx,'b'),before=b.x;fx.sim.decisionGate=()=>true;
  fx.sim.applyLlmPlan('a',a.epoch,['approach','rest'].map(x=>choice(fx,x)),a);
  setPlan(b,fx.sim.charOf('b')!.spec,{behavior:'pose',steps:[{state:'act',action:'pose',sec:10}]},fx.sim.ctx(),'test');
  assert.notEqual(b.x,before,'pose alignment changes model origin');
  const drv=drive(fx.sim);drv.until(e=>e.type==='plan'&&e.behavior==='rest','sit after target changes pose');
  assert.equal(a.state,'sit');assert.ok(!drv.log.some(x=>x.e.type==='intent-plan'));
});

test('a stationary target swaying inside an animation is not locomotion',()=>{
  const fx=makeDuo({aMind:mind,extraActions:{sit:{frames:1,fps:1,loop:true,clip:'sit'},sway:{frames:2,fps:12,loop:true,clip:'sway',hip:{right:[0,0.1],left:[0,0.1]}}}});
  const a=ready(fx),b=ready(fx,'b');fx.sim.decisionGate=()=>true;
  fx.sim.applyLlmPlan('a',a.epoch,['approach','rest'].map(x=>choice(fx,x)),a);
  setPlan(b,fx.sim.charOf('b')!.spec,{behavior:'sway',steps:[{state:'act',action:'sway',sec:10}]},fx.sim.ctx(),'test');
  const drv=drive(fx.sim);drv.until(e=>e.type==='plan'&&e.behavior==='rest','sit after target sways');
  assert.ok(!drv.log.some(x=>x.e.type==='intent-plan'));assert.equal(a.state,'sit');
});

test('summoning resets old hiding and away markers, without inventing a discovery on landing',()=>{
  const fx=fixture(),c=fx.sim.charOf('a')!;c.coverHide={behavior:'old-hide',hwnd:99};c.awayDeeds=true;
  fx.sim.spawn('a',{x:300,y:1040});ready(fx);
  const events=fx.sim.step(fx.sim.now+DT,DT);
  assert.ok(!events.some(x=>x.id==='a'&&x.e.type==='discovered'));
  assert.equal(c.coverHide,null);assert.equal(c.awayDeeds,false);
});
