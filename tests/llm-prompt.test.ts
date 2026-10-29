import test from 'node:test';
import assert from 'node:assert/strict';
import {currentMessage, turnRecord, type TurnFacts} from '../src/llm/context.ts';
import {makeDuo, drive} from './helpers/fake-scene.ts';

test('partner drafts preserve phase and addressee only in the current message, never as heard history',()=>{
  const facts:TurnFacts={at:0,what:'开始双人场景',behavior:'duo:sex',phases:['start','loop'],heard:[],
    partnerScript:{name:'甲',lines:[{phase:'loop',to:'b',text:'这是尚未说出口的后段台词。'}]}};
  const current=currentMessage({...facts,speaker:'b',v:1,plan:'p',present:['a'],state:{}});
  const history=turnRecord(facts);
  assert.ok(current.includes('"phase":"loop"'));
  assert.ok(current.includes('"to":"b"'));
  assert.ok(current.includes('尚未说出口'));
  assert.ok(!history.includes('这是尚未说出口的后段台词。'));
  facts.heard.push({from:'a',fromName:'甲',to:'b',toName:'乙',text:'这句确实说出口了。'});
  assert.ok(turnRecord(facts).includes('这句确实说出口了。'));
});

test('both actors know the actual duo scene, partner, initiator and role, then lose that fact on interruption',()=>{
  const fx=makeDuo(),drv=drive(fx.sim);
  drv.until(e=>e.type==='duo'&&e.what==='play','play');
  const a=fx.sim.llmSnapshot('a')!,b=fx.sim.llmSnapshot('b')!;
  assert.deepEqual(a.self.interaction,{scene:'s1',role:'receiver',partner:'b',initiated_by:'a',stage:'play',phase:'start'});
  assert.deepEqual(b.self.interaction,{scene:'s1',role:'giver',partner:'a',initiated_by:'a',stage:'play',phase:'start'});
  assert.deepEqual(a.others[0].interaction,b.self.interaction);
  fx.sim.grab('a',{x:500,y:700});
  assert.equal(fx.sim.llmSnapshot('b')!.self.interaction,undefined);
});
