// Pure scheduling: one capture/delivery at a time; manual requests precede automatic ones.
import type {CaptureTarget, CapturedFrame, VisionConfig} from './types.ts';
import {msg, type Msg} from '../shared/msg.ts';
export interface ObserverCharacter {id: string; generation: number; capable: boolean; busy: boolean; auto: boolean; intervalSec: number}
export interface ObserverHost {
  config(): VisionConfig; active(): boolean; characters(): ObserverCharacter[]; target(): CaptureTarget | null;
  capture(target: CaptureTarget): Promise<CapturedFrame>;
  deliver(id: string, generation: number, frame: CapturedFrame, manual: boolean): Promise<boolean>;
}
interface Slot {generation:number; interval:number; due:number; fingerprint?:string}
export class Observer {
  private host: ObserverHost; private clock:()=>number; private slots=new Map<string,Slot>();
  private manual=new Map<string,{target:CaptureTarget;generation:number;at:number}>();
  private running=false; private stopped=false; private lastAutomatic=-Infinity; private revision=0;
  /** 最近一次的结果（界面按当前语言翻译；manualFailed 键以 status.vision.failed 开头） */
  latest:Msg=msg('status.vision.none');
  onStatus:((message:Msg,manual:boolean)=>void)|null=null;
  constructor(host:ObserverHost,clock=Date.now) {this.host=host;this.clock=clock;}
  private characterRevisions = new Map<string,number>();
  reset(id?:string) {
    if(id){this.characterRevisions.set(id,(this.characterRevisions.get(id)??0)+1);this.slots.delete(id);this.manual.delete(id);}
    else{this.revision++;this.slots.clear();this.manual.clear();}
  }
  close() {this.stopped=true;this.reset();}
  request(id:string,target=this.host.target()):boolean {
    const c=this.host.characters().find(c=>c.id===id);
    if(this.stopped || !this.host.active() || !this.host.config().enabled || !c?.capable || !target) return false;
    if(!this.manual.has(id)) this.manual.set(id,{target,generation:c.generation,at:this.clock()});
    void this.tick();return true;
  }
  async tick():Promise<void> {
    if(this.running || this.stopped) return;
    const cfg=this.host.config(),now=this.clock(),chars=this.host.characters();
    if(!cfg.enabled || !this.host.active()){this.reset();return;}
    for(const [id,s] of this.slots) if(!chars.some(c=>c.id===id && c.capable && c.auto && c.generation===s.generation))this.slots.delete(id);
    for(const c of chars) if(c.capable && c.auto) {
      const old=this.slots.get(c.id);
      if(!old || old.interval!==c.intervalSec)this.slots.set(c.id,{generation:c.generation,interval:c.intervalSec,due:now+c.intervalSec*1000,fingerprint:old?.fingerprint});
    }
    let selected:ObserverCharacter|undefined,target:CaptureTarget|null=null,manual=false;
    for(const [id,m] of this.manual){
      const c=chars.find(c=>c.id===id && c.capable && c.generation===m.generation);
      if(!c || now-m.at>30000){this.manual.delete(id);continue;}
      if(!c.busy){selected=c;target=m.target;manual=true;break;}
    }
    if(!selected && now-this.lastAutomatic>=cfg.staggerSec*1000) {
      selected=chars.filter(c=>c.capable && !c.busy && c.auto && (this.slots.get(c.id)?.due??Infinity)<=now)
        .sort((a,b)=>this.slots.get(a.id)!.due-this.slots.get(b.id)!.due)[0];
      if(selected)target=this.host.target();
    }
    if(!selected || !target)return;
    const c=selected,rev=this.revision,charRev=this.characterRevisions.get(c.id)??0,slot=this.slots.get(c.id),manualEntry=manual?this.manual.get(c.id):undefined;
    this.running=true;
    // Keep the manual entry while running: repeated clicks merge into the same request.
    if(!manual){this.lastAutomatic=now;if(slot)slot.due=now+c.intervalSec*1000;}
    const current=()=>!this.stopped && rev===this.revision && charRev===(this.characterRevisions.get(c.id)??0) && this.host.config().enabled && this.host.active() &&
      this.host.characters().some(x=>x.id===c.id && x.generation===c.generation && x.capable);
    this.latest=msg('status.vision.cancelled');
    try {
      const frame=await this.host.capture(target);
      if(!current() || !frame.valid())return;
      if(!manual && slot?.fingerprint===frame.fingerprint){this.latest=msg('status.vision.unchanged');return;}
      if(await this.host.deliver(c.id,c.generation,frame,manual) && current()) {
        if(slot)slot.fingerprint=frame.fingerprint;
        this.latest=msg('status.vision.done');
      } else this.latest=msg('status.vision.failedDeliver');
    } catch {this.latest=msg('status.vision.failedCapture');}
    finally {if(manual && this.manual.get(c.id)===manualEntry)this.manual.delete(c.id);this.running=false;if(!this.stopped)this.onStatus?.(this.latest,manual);}
  }
}
