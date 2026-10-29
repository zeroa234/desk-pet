import type {SpeechUnit,SpeechVoice} from '../llm/types.ts';
import {scheduleSpeech,type Scheduled} from './speech-synth.ts';

export interface VoicePreview {voice:SpeechVoice;units:SpeechUnit[];volume:number}

/** One local audition at a time, using the exact same synthesis as desktop dialogue. */
export class SpeechPreview {
  private ctx:AudioContext|null=null;
  private scheduled:Scheduled|null=null;
  private gain:GainNode|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private serial=0;
  stop():void {
    this.serial++;if(this.timer!==null)clearTimeout(this.timer);this.timer=null;
    for(const s of this.scheduled?.sources??[]){try{s.stop();}catch{}s.disconnect();}
    for(const n of this.scheduled?.nodes??[])n.disconnect();this.scheduled=null;
    this.gain?.disconnect();this.gain=null;
    if(this.ctx)void this.ctx.suspend().catch(()=>{});
  }
  async play(preview:VoicePreview,ended:()=>void):Promise<boolean> {
    this.stop();const serial=this.serial;
    const ctx=this.ctx??=new AudioContext();
    await ctx.resume();if(serial!==this.serial)return false;
    this.gain=ctx.createGain();this.gain.gain.value=preview.volume;this.gain.connect(ctx.destination);
    const start=ctx.currentTime+.04;
    this.scheduled=scheduleSpeech(ctx,this.gain,preview.units,preview.voice,start);
    const duration=preview.units.reduce((n,u)=>Math.max(n,u.at+u.duration),0);
    this.timer=setTimeout(()=>{this.stop();ended();},(duration+.1)*1000);
    return true;
  }
  close():void {this.stop();const ctx=this.ctx;this.ctx=null;if(ctx)void ctx.close().catch(()=>{});}
}
