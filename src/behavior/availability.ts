// Shared material checks for behavior previews and execution. Uses the actor's existing action resolver.
import {actionAvailable, resolveAction} from './actor.ts';
import type {ActorSpec, ActorState, Plan} from './types.ts';
import type {BehaviorDef} from './mind.ts';

function playable(spec: ActorSpec, state: ActorState, action: string | undefined, outfit: string, r18: boolean): boolean {
  if (action && !actionAvailable(spec, action, outfit)) return false;
  const resolved = resolveAction(spec, state, action, outfit);
  return !!resolved && (r18 || !spec.actions[resolved].r18);
}

/** Check every step, including implicit state actions and both sides of an outfit switch. */
export function planPlayable(spec: ActorSpec, plan: Plan, outfit: string, outfits: readonly string[], r18: boolean): boolean {
  return plan.steps.length > 0 && plan.steps.every(s => {
    if (s.outfit) outfit = s.outfit;
    if (!outfits.includes(outfit) || !r18 && outfit !== 'clothed' || !playable(spec, s.state, s.action, outfit, r18)) return false;
    if (s.outfitAt) {
      outfit = s.outfitAt.to;
      if (!outfits.includes(outfit) || !r18 && outfit !== 'clothed' || !playable(spec, s.state, s.action, outfit, r18)) return false;
    }
    return true;
  });
}

/** Static ability: at least one starting outfit can play the template. World conditions belong to Sim.resolve. */
export function behaviorHasMaterials(spec: ActorSpec, def: BehaviorDef, outfits: readonly string[], r18: boolean): boolean {
  if (def.r18 && !r18) return false;
  if (def.duo) return true; // Scene/role compatibility is checked by the scene owner.
  return !!def.steps?.length && outfits.filter(o=>r18 || o === 'clothed').some(initial => {
    let outfit = initial;
    return def.steps!.every(t => {
      if (t.do === 'outfit') { outfit = t.to; return outfits.includes(outfit) && (r18 || outfit === 'clothed'); }
      const state: ActorState = t.do === 'sit' ? 'sit' : t.do === 'play' ? t.state ?? 'act' :
        ['wander', 'gotoHide', 'approach', 'emerge'].includes(t.do) ? 'walk' :
        ['hide', 'hideHere'].includes(t.do) ? 'hide' : ['hop', 'enter', 'leave'].includes(t.do) ? 'jump' : 'idle';
      if (t.do === 'peek' && !playable(spec, 'walk', t.walkAction, outfit, r18)) return false;
      return playable(spec, state, 'action' in t ? t.action : undefined, outfit, r18);
    });
  });
}
