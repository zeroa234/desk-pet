import test from 'node:test';
import assert from 'node:assert/strict';
import {SimClock} from '../src/main/sim-clock.ts';
import {makeDuo,drive,DT} from './helpers/fake-scene.ts';
import {currentFrame,setPlan} from '../src/behavior/index.ts';

test('suspension freezes plan stages, animation, physiological stats and played time together',()=>{
  const fx=makeDuo({aMind:{schema:1,stats:{energy:{start:50,perHour:3600}},behaviors:[]}}),sim=fx.sim,a=sim.charOf('a')!.actor!;
  a.state='idle';a.support=sim.supports.find(s=>s.kind==='floor')!;a.y=a.support.y;
  setPlan(a,sim.charOf('a')!.spec,{behavior:'test',steps:[{state:'act',action:'wave',sec:10,phase:'start'},{state:'act',action:'wave',sec:10,phase:'loop'}]},sim.ctx(),'test');
  const clock=new SimClock(100,{stallSec:2,recoveryStepSec:DT},sim.now),plan=a.plan;
  const advance=(wall:number,running=true)=>{const t=clock.step(wall,running);if(running)sim.step(t.now,t.dt);return t;};
  advance(100+DT);const frame=currentFrame(a,sim.charOf('a')!.spec,sim.now),end=a.stateEnd,played=sim.playSeconds,energy=sim.charOf('a')!.brain.stats.energy;
  advance(101,false);advance(200,false);const resumed=advance(300);
  assert.equal(resumed.stalled,0,'a suspended gap is not offline catch-up');assert.equal(resumed.dt,0);
  assert.equal(a.plan,plan);assert.equal(a.phase,'start');assert.equal(a.stateEnd,end);
  assert.deepEqual(currentFrame(a,sim.charOf('a')!.spec,sim.now),frame);
  assert.equal(sim.playSeconds,played);assert.equal(sim.charOf('a')!.brain.stats.energy,energy);
  advance(300+DT);assert.ok(sim.playSeconds>played);assert.ok(sim.charOf('a')!.brain.stats.energy>energy);
});

test('paired scenes survive a long hidden interval and resume the same shared stage',()=>{
  const fx=makeDuo(),sim=fx.sim;drive(sim).until(e=>e.type==='duo'&&e.what==='play','play');
  const d=sim.duos[0],phase=d.phase,clock=new SimClock(1,{stallSec:2,recoveryStepSec:DT},sim.now);
  clock.step(2,false);clock.step(200,false);const resumed=clock.step(201,true);sim.step(resumed.now,resumed.dt);
  assert.equal(sim.duos[0],d);assert.equal(d.phase,phase);assert.equal(d.stage,'play');
  const next=clock.step(201+DT,true);sim.step(next.now,next.dt);assert.equal(sim.duos[0],d);
});

test('an unsuspended sleep gap reports offline time but advances action clocks by one recovery step',()=>{
  const clock=new SimClock(10,{stallSec:2,recoveryStepSec:DT});
  clock.step(10+DT,true);const t=clock.step(1010,true);
  assert.ok(t.stalled>999);assert.equal(t.dt,DT);assert.ok(Math.abs(t.now-2*DT)<1e-8);
});
