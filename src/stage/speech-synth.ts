// 说话短音的合成（R6.1）：把 SpeechUnit 排到一个 AudioContext 的时间线上。
// 实时播放（SpeechDisplay）和离线量响度（scripts/llm-ui/speech-level.ts 用 OfflineAudioContext）共用这一份，
// 量出来的就是实际放出来的。不用第三方录音：锯齿波过三个共振峰带通（F1 最响，往上依次减弱，元音音色的常见做法）
// （开源版省略）
import type {SpeechUnit, SpeechVoice} from '../llm/types.ts';

export interface Scheduled { sources: AudioScheduledSourceNode[]; nodes: AudioNode[] }

/**
 * 包络峰值（音量 1 时）。按 scripts/llm-ui/speech-level.ts 校准：最响 100 ms 的 RMS 约 −14 dBFS，
 * 和原版音效导出时拉到的电平一样（packs/_sfx/sfx.json 的 normalize.targetDb，同一口径），所以说话和叫声在同一音量下差不多响。
 * 2026-10-23 以前是 0.08、没有分路增益，量出来 −40 dBFS，几乎听不见。改合成结构以后要重跑脚本、重新校准。
 */
export const SPEECH_PEAK = 1.75;
// 共振峰各路增益和 Q（F1 / F2 / F3）、直通低通、噪声
const FORMANT_GAIN = [1, .55, .3], FORMANT_Q = [4, 5, 6], BODY_GAIN = .35, CONSONANT_NOISE = .35, BREATH_NOISE = .3;

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseOf(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseBuffers.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * .18), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, buf);
  }
  return buf;
}

/** start = 第 0 个单元在 ctx 时间线上的时刻；已经过去的单元不排（续排时用）。 */
export function scheduleSpeech(ctx: BaseAudioContext, out: AudioNode, units: SpeechUnit[], voice: SpeechVoice, start: number): Scheduled {
  const sources: AudioScheduledSourceNode[] = [], nodes: AudioNode[] = [];
  const gain = (value: number, to: AudioNode) => { const g = ctx.createGain(); g.gain.value = value; g.connect(to); nodes.push(g); return g; };
  for (const u of units) {
    if ((!u.formants && !/[\p{L}\p{N}]/u.test(u.text)) || start + u.at < ctx.currentTime) continue;
    const at = start + u.at, d = Math.min(u.duration, 0.16), env = ctx.createGain();
    env.gain.setValueAtTime(0, at); env.gain.linearRampToValueAtTime(SPEECH_PEAK, at + Math.min(.012, d / 4));
    env.gain.exponentialRampToValueAtTime(.001, at + d); env.connect(out); nodes.push(env);
    if (u.formants) {
      const source = ctx.createOscillator(); source.type = 'sawtooth'; source.frequency.setValueAtTime(u.pitch, at);
      if (u.tone === 2) { source.frequency.setValueAtTime(u.pitch * .9, at); source.frequency.linearRampToValueAtTime(u.pitch * 1.12, at + d); }
      else if (u.tone === 3) { source.frequency.linearRampToValueAtTime(u.pitch * .8, at + d * .5); source.frequency.linearRampToValueAtTime(u.pitch, at + d); }
      else if (u.tone === 4) { source.frequency.setValueAtTime(u.pitch * 1.15, at); source.frequency.linearRampToValueAtTime(u.pitch * .82, at + d); }
      u.formants.forEach((f, i) => {
        const filter = ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = f * voice.formantScale; filter.Q.value = FORMANT_Q[i] ?? 6;
        source.connect(filter); filter.connect(gain(FORMANT_GAIN[i] ?? .3, env)); nodes.push(filter);
      });
      const body = ctx.createBiquadFilter(); body.type = 'lowpass'; body.frequency.value = u.formants[0] * voice.formantScale * 1.2;
      source.connect(body); body.connect(gain(BODY_GAIN, env)); nodes.push(body);
      source.start(at); source.stop(at + d); sources.push(source);
    }
    if (!u.formants || voice.breath > 0) {
      const noise = ctx.createBufferSource(), filter = ctx.createBiquadFilter(); noise.buffer = noiseOf(ctx);
      filter.type = 'highpass'; filter.frequency.value = 2000;
      noise.connect(filter); filter.connect(gain(u.formants ? voice.breath * BREATH_NOISE : CONSONANT_NOISE, env));
      noise.start(at); noise.stop(at + d); sources.push(noise); nodes.push(filter);
    }
  }
  return {sources, nodes};
}
