import type {SpeechVoice} from './types.ts';

export const DEFAULT_VOICE: SpeechVoice = {pitch:220,speed:1,formantScale:1,breath:.1};
/**
 * Shared by validation, synthesis and the editor; pitch is the base frequency, before tone contours.
 * 名字和说明是界面词条 voice.<key>.label / .hint（src/locales/），单位 unit.<unit>
 */
export const VOICE_CONTROLS: readonly {key:keyof SpeechVoice;min:number;max:number;step:number;unit:'hz'|'times'|''}[] = [
  {key:'pitch',min:80,max:600,step:1,unit:'hz'},
  {key:'speed',min:.5,max:2.5,step:.05,unit:'times'},
  {key:'formantScale',min:.5,max:2,step:.05,unit:'times'},
  {key:'breath',min:0,max:1,step:.01,unit:''},
];

export function voiceValid(value: unknown): value is SpeechVoice {
  if(!value || typeof value!=='object' || Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  return Object.keys(v).every(k=>VOICE_CONTROLS.some(c=>c.key===k)) && VOICE_CONTROLS.every(({key,min,max})=>
    typeof v[key]==='number' && Number.isFinite(v[key]) && v[key]>=min && v[key]<=max);
}

/** Clamp untrusted/legacy pack values to the range actually used by synthesis. */
export function resolveVoice(value?: Partial<SpeechVoice>): SpeechVoice {
  const result={...DEFAULT_VOICE};
  for(const {key,min,max} of VOICE_CONTROLS) {
    const v=value?.[key];if(typeof v==='number'&&Number.isFinite(v))result[key]=Math.min(max,Math.max(min,v));
  }
  return result;
}
