import type {SpeechUnit, SpeechVoice} from '../llm/types.ts';
import {scheduleSpeech} from './speech-synth.ts';

export interface StageSpeech {
  token: number; speaker: string; text: string; aside: string[]; units: SpeechUnit[]; voice: SpeechVoice;
  x: number; y: number; show: boolean; play: boolean; volume: number; elapsed: number;
  /** 说给谁：没有 = 对用户说；有就在气泡上面标一行小字（“对 xx” / “自言自语”） */
  toLabel?: string;
}
export interface SpeechBridge { onSpeech(cb:(s:StageSpeech|null)=>void):void }

/** One audio clock drives both glyphs and synthesizer; the overlay remains click-through. */
export class SpeechDisplay {
  private bubble: HTMLDivElement; private current: StageSpeech|null=null;
  private sources: AudioScheduledSourceNode[]=[]; private nodes: AudioNode[]=[];
  private gain: GainNode|null=null; private ctx: AudioContext|null=null; private start=0; private raf=0;
  private getAudio: ()=>{ctx:AudioContext;bus:AudioNode};
  constructor(bridge:SpeechBridge,getAudio:()=>{ctx:AudioContext;bus:AudioNode}) {
    this.getAudio=getAudio; this.bubble=document.createElement('div'); this.bubble.id='speech-bubble';
    this.bubble.style.cssText='position:absolute;display:none;pointer-events:none;max-width:240px;padding:9px 12px;border-radius:12px;border:1px solid #53436b;background:rgba(255,250,255,.96);color:#30283d;font:14px/1.5 "Microsoft YaHei",sans-serif;box-shadow:0 3px 12px #0003;white-space:pre-wrap;transform:translate(-50%,-100%);z-index:5';
    document.body.append(this.bubble); bridge.onSpeech(s=>this.set(s));
  }
  private stop() {
    cancelAnimationFrame(this.raf); this.raf=0;
    for(const s of this.sources) { try{s.stop();}catch{} s.disconnect(); }
    for(const n of this.nodes) n.disconnect(); this.sources=[]; this.nodes=[];
    this.gain?.disconnect(); this.gain=null; this.bubble.style.display='none';
  }
  private set(s:StageSpeech|null) {
    if (s && this.current?.token===s.token) {
      const resume=!this.current.play&&s.play;
      this.current=s; if(!resume){if(this.gain)this.gain.gain.value=s.play?s.volume:0;return;}
      // Enabling sound mid-utterance schedules only remaining units on the same timeline.
    }
    this.stop(); this.current=s; if(!s)return;
    const {ctx,bus}=this.getAudio(); this.ctx=ctx;
    if(ctx.state==='suspended') void ctx.resume().catch(()=>{});
    this.start=ctx.currentTime+0.04-Math.max(0,s.elapsed);
    this.gain=ctx.createGain(); this.gain.gain.value=s.play?s.volume:0; this.gain.connect(bus);
    if(s.play) { const r=scheduleSpeech(ctx,this.gain,s.units,s.voice,this.start); this.sources=r.sources; this.nodes=r.nodes; }
    const draw=()=>{
      const cur=this.current;if(!cur||!this.ctx)return;
      const elapsed=this.ctx.currentTime-this.start;
      this.bubble.style.display=cur.show?'block':'none';
      const scale=devicePixelRatio;
      this.bubble.style.left=`${Math.max(130,Math.min(innerWidth-130,cur.x/scale))}px`;
      this.bubble.style.top=`${Math.max(70,Math.min(innerHeight-10,cur.y/scale))}px`;
      this.bubble.textContent='';
      if(cur.toLabel){const to=document.createElement('span');to.style.cssText='display:block;font-size:11px;color:#8a6ca8';to.textContent=cur.toLabel;this.bubble.append(to);}
      this.bubble.append(cur.units.filter(u=>u.at<=elapsed).map(u=>u.text).join(''));
      if(cur.aside.length){const note=document.createElement('span');note.style.cssText='display:block;font-size:11px;font-style:italic;color:#766b80';note.textContent=cur.aside.join(' · ');this.bubble.append(note);}
      this.raf=requestAnimationFrame(draw);
    };draw();
  }
}
