// Short leases for model-selected activity. Sim retains ownership of rules, interruption and physics.
import type {Actor} from '../behavior/index.ts';

export const controlSeconds = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 300 ? value : 30;
interface Lease {actor: Actor; until: number; target?: Actor}
export class IntentControl {
  private leases = new Map<string, Lease>();
  acquire(actor: Actor, now: number, seconds: number): void {
    this.leases.delete(actor.id);
    if(seconds>0)this.leases.set(actor.id,{actor,until:now+seconds});
  }
  waitFor(owner: Actor, target: Actor): void {
    const lease=this.leases.get(owner.id);
    if(lease?.actor===owner)lease.target=target;
  }
  release(id: string): void { this.leases.delete(id); }
  releaseActor(id: string): void {
    for(const [owner,lease] of this.leases)if(owner===id||lease.target?.id===id)this.leases.delete(owner);
  }
  clear(): void { this.leases.clear(); }
  prune(now: number, actorOf:(id:string)=>Actor|null): void {
    for(const [id,l] of this.leases)if(now>=l.until||actorOf(id)!==l.actor||l.target&&actorOf(l.target.id)!==l.target)this.leases.delete(id);
  }
  status(actor: Actor, now: number): {owner:string;remaining_s:number} | null {
    for(const [owner,l] of this.leases)if(now<l.until&&(l.actor===actor||l.target===actor))return {owner,remaining_s:Math.round((l.until-now)*100)/100};
    return null;
  }
  waiting(actor: Actor, now: number): string | null {
    for(const [owner,l] of this.leases)if(now<l.until&&l.target===actor)return owner;
    return null;
  }
}
