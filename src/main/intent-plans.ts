// Small bridge between typed model choices and the existing behavior executor. No navigation or rule copies.
import type {Actor} from '../behavior/index.ts';
import type {Intent} from '../llm/types.ts';
import type {Point} from '../shared/types.ts';

interface TargetFacts {actor: Actor; position: Point}

interface Sequence {actor: Actor; remaining: Intent[]; active: string | null; target?: {actor: Actor; x: number; y: number; support: string | null}}
export class IntentPlans {
  private entries = new Map<string, Sequence>();
  controls(actor: Actor): boolean { return this.entries.get(actor.id)?.actor === actor; }
  active(actor: Actor, behavior: string): boolean { const p=this.entries.get(actor.id);return p?.actor===actor&&p.active===behavior; }
  cancelPending(): void {
    for(const [id,p] of this.entries){
      if(p.active===null)this.entries.delete(id);
      else {p.remaining=[];p.target=undefined;}
    }
  }
  begin(actor: Actor, goals: Intent[]): void { this.entries.set(actor.id, {actor, remaining: goals.slice(1), active: null}); }
  clear(id: string): void { this.entries.delete(id); }
  activate(actor: Actor, behavior: string, target?: TargetFacts | null): void {
    const p = this.entries.get(actor.id);
    if (p?.actor === actor) { p.active = behavior; p.target = target ? {actor: target.actor, ...target.position, support: target.actor.support?.key ?? null} : undefined; }
  }
  ended(actor: Actor, behavior: string, outcome: 'done' | 'aborted'): void {
    const p = this.entries.get(actor.id);
    if (p?.actor !== actor || p.active !== behavior) return;
    if (outcome === 'aborted' || !p.remaining.length) this.clear(actor.id);
    else { p.active = null; p.target = undefined; }
  }
  next(actor: Actor): Intent | null {
    const p = this.entries.get(actor.id);
    if (!p) return null;
    if (p.actor !== actor) { this.clear(actor.id); return null; }
    return p.active === null ? p.remaining.shift() ?? null : null;
  }
  pending(id: string): {behavior: string; target?: string; scene?: string}[] {
    return (this.entries.get(id)?.remaining ?? []).map(({behavior,target,scene})=>({behavior,target,scene}));
  }
  invalid(actor: Actor, actorOf: (id: string)=>TargetFacts | null): string | null {
    const p = this.entries.get(actor.id), t = p?.target;
    if (!p || !t) return null;
    const other = actorOf(t.actor.id);
    return !other || other.actor !== t.actor ? 'target-left' : other.actor.support?.key !== t.support || Math.hypot(other.position.x-t.x, other.position.y-t.y) > 1 ? 'target-moved' : null;
  }
}
