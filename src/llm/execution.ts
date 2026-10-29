// Compact program execution receipts, shared by decision and dialogue. Never copy arbitrary event payloads.
import type {SimEvent} from '../main/sim.ts';
import type {Actor} from '../behavior/index.ts';
import type {ActorFacts} from './state.ts';

export function actorMotion(a: Actor): ActorFacts['motion'] {
  const kind=a.state==='dragged'?'carried':a.state==='walk'||a.state==='jump'||a.state==='fall'?a.state:'stationary';
  const dx=a.state==='walk'?(a.targetX??a.x)-a.x:a.state==='jump'||a.state==='fall'?a.vx:0;
  return {kind,direction:dx>0?'right':dx<0?'left':'none',
    ...(a.state==='walk'&&a.targetX!==null?{destination_x:Math.round(a.targetX)}:{}),
    ...(a.state==='walk'&&a.step?.targetBodyX!==undefined?{body_destination_x:Math.round(a.step.targetBodyX)}:{})};
}

/** Ignore animation/pose changes, but reject dialogue produced against a different locomotion context. */
export function movementStamp(a: Actor): string {
  const {kind,direction}=actorMotion(a);
  return `${kind}:${direction}`;
}

export function executionEvent(e: SimEvent, at: number): object | null {
  const base={at_sim_s:+at.toFixed(2),type:e.type};
  switch(e.type) {
    case 'plan': return {...base,behavior:e.behavior};
    case 'plan-end': return {...base,behavior:e.behavior,outcome:e.outcome,reason:e.reason};
    case 'intent-plan': return {...base,what:e.what,reason:e.reason};
    case 'state': return {...base,from:e.from,to:e.to,reason:e.reason};
    case 'duo': return {...base,what:e.what,...Object.fromEntries(['partner','scene','reason','phase'].flatMap(k=>
      typeof e[k]==='string'?[[k,e[k]]]:[]))};
    case 'poke': return {...base,kind:e.kind,part:e.part};
    case 'outfit': return {...base,outfit:e.outfit};
    case 'discovered': return {...base,continued:!!e.continued,by:e.by};
    default: return null;
  }
}
