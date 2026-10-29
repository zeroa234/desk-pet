import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDuo, drive} from './helpers/fake-scene.ts';
import {makeWindow, rect} from './helpers/fake-desktop.ts';

function free(fx:ReturnType<typeof makeDuo>,id='a') {
  const a=fx.sim.charOf(id)!.actor!; a.support=fx.sim.supports.find(s=>s.kind==='floor')!;a.y=a.support.y;a.plan=null; a.step=null;a.phase=null;a.state='idle';a.stateEnd=Infinity;
  return a;
}
test('candidate preview has no reservations, events, effects, cooldowns or random consumption',()=>{
  const fx=makeDuo(); const a=free(fx),b=free(fx,'b');
  const stats=structuredClone(fx.sim.saveState()); const epoch=a.epoch, other=b.plan;
  const before=fx.sim.llmCandidates('a'); const again=fx.sim.llmCandidates('a');
  assert.deepEqual(before,again);assert.ok(before.some(c=>c.scene==='s1'&&c.target==='b'));
  assert.equal(fx.sim.duos.length,0);assert.equal(b.plan,other);assert.equal(a.epoch,epoch);assert.deepEqual(fx.sim.saveState(),stats);
  const control=makeDuo();free(control);free(control,'b');
  fx.sim.applyLlmIntent('a',a.epoch,null,a);const ca=control.sim.charOf('a')!.actor!;control.sim.applyLlmIntent('a',ca.epoch,null,ca);
  assert.deepEqual(fx.sim.duos.map(d=>d.facing),control.sim.duos.map(d=>d.facing));
});
test('typed choice can select existing duo action, with both acceptance and concrete scene checked',()=>{
  const fx=makeDuo();const a=free(fx);free(fx,'b');
  const c=fx.sim.llmCandidates('a').find(c=>c.scene==='s1')!;assert.ok(c);
  assert.ok(fx.sim.applyLlmIntent('a',a.epoch,c.id,a));assert.equal(fx.sim.duos.length,1);assert.equal(fx.sim.duos[0].partner,'b');
  const drv=drive(fx.sim);drv.until(e=>e.type==='duo'&&e.what==='play','play');
  fx.sim.grab(fx.sim.duos[0].roles.receiver,{x:900,y:950});assert.ok(fx.sim.duos.every(d=>d.stage!=='play'));
});
test('unavailable partner, missing scene, low acceptance and SFW remove adult duo candidates',()=>{
  const low=makeDuo({bDesire:10});free(low);free(low,'b');assert.ok(!low.sim.llmCandidates('a').some(c=>c.scene));
  const absent=makeDuo();free(absent);absent.sim.setAbsent(['b']);assert.ok(!absent.sim.llmCandidates('a').some(c=>c.target==='b'));
  const sfw=makeDuo();free(sfw);sfw.sim.setR18(false);assert.ok(sfw.sim.llmCandidates('a').every(c=>!c.adult&&!c.scene));
});
test('stale choice cannot override drag, epoch, actor respawn, partner departure or changed eligibility',()=>{
  const fx=makeDuo();const a=free(fx);free(fx,'b'); const c=fx.sim.llmCandidates('a').find(c=>c.scene)!;const epoch=a.epoch;
  fx.sim.grab('a',{x:a.x,y:a.y});assert.equal(fx.sim.applyLlmIntent('a',epoch,c.id,a),false);assert.equal(a.state,'dragged');
  const r=makeDuo();const old=free(r);const oldEpoch=old.epoch;r.sim.spawn('a',{x:500,y:1040});const fresh=free(r);fresh.epoch=oldEpoch;
  assert.equal(r.sim.applyLlmIntent('a',oldEpoch,c.id,old),false);
  const gone=makeDuo();const ga=free(gone);free(gone,'b');gone.sim.setAbsent(['b']);
  assert.ok(gone.sim.applyLlmIntent('a',ga.epoch,c.id,ga));assert.equal(gone.sim.duos.length,0);
});
test('single-person adult action identifiers are selectable only when rule conditions allow',()=>{
  const mind={schema:1 as const,stats:{desire:{start:90}},behaviors:[
    {id:'idle',weight:1,steps:[{do:'idle' as const,sec:5}]},
    {id:'masturbate',weight:1,r18:true,when:{'>=':[{var:'self.stats.desire'},80]},steps:[{do:'play' as const,action:'wave',state:'masturbate' as const,phase:'loop' as const,sec:5}]},
  ]};
  const fx=makeDuo({aMind:mind});const a=free(fx);const c=fx.sim.llmCandidates('a').find(c=>c.behavior==='masturbate');assert.ok(c);
  assert.ok(fx.sim.applyLlmIntent('a',a.epoch,c.id,a));assert.equal(a.plan?.behavior,'masturbate');assert.equal(a.state,'masturbate');
  const low=makeDuo({aMind:mind});free(low);low.sim.charOf('a')!.brain.stats.desire=10;assert.ok(!low.sim.llmCandidates('a').some(c=>c.behavior==='masturbate'));
});
test('snapshot excludes private window titles and absent characters',()=>{
  const fx=makeDuo();fx.sim.setDesktop({...fx.sim.desktop,windows:[makeWindow(99,rect(200,200,900,700),{title:'secret-file-name private page'})]});
  fx.sim.setAbsent(['b']);const snapshot=JSON.stringify(fx.sim.llmSnapshot('a'));assert.ok(!snapshot.includes('secret-file-name'));assert.ok(!snapshot.includes('"id":"b"'));
});
