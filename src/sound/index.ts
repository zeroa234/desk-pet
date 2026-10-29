// sound/：原版 mod 音效的规则（R2.8、R6.3）。纯逻辑（不碰 DOM、不 import electron），别的模块只 import 这个文件。
//
// （开源版省略）
// 声音、第几个、音量、怎么随机），声音文件和每个文件的电平（gainDb）也在里面。什么时候响由 main/sim.ts 按精灵帧给出
// （角色包 / 场景的 sfx.json），这里只管“这个 effect 现在放哪几个声音”。
// （开源版省略）
//   {play: 组, index?: 第几个（没写随机）, volume?, repeat?, gap?（秒）, pitch?: [lo, hi]}、{chance: p, then: 步}、
//   {oneOf: [[权重, 步], …]}、{cycle: 计数器, start: n, steps: [a, b]}（第 (计数 + start) % 长度 步，每次 +1）；
//   pick: fresh = 不和这一组上一次放的重复（试 10 次，mod 的 SoundHandler.randomSound），any = 随便。
// 一个角色一个 Voice（计数器、“上一次放的”是每个角色自己的，和 mod 里每个实体一份一样）。

export interface SfxStep {
  play?: string;
  index?: number;
  volume?: number;
  repeat?: number;
  gap?: number;
  pitch?: [number, number];
  chance?: number;
  then?: SfxStep;
  oneOf?: [number, SfxStep][];
  cycle?: string;
  start?: number;
  steps?: SfxStep[];
}

export interface VoiceRules {
  pick?: 'fresh' | 'any';
  events: Record<string, SfxStep[]>;
}

export interface SfxFile {
  /** 相对 packs/_sfx/sounds/ */
  file: string;
  /** 统一电平用的增益（dB，导出时算好） */
  gainDb: number;
  sec: number;
}

export interface SfxManifest {
  schema: 1;
  voices: Record<string, VoiceRules>;
  /** （开源版省略） */
  files: Record<string, SfxFile[]>;
}

/** 要放的一个声音 */
export interface Sound {
  /** 相对 packs/_sfx/sounds/ */
  file: string;
  gainDb: number;
  /** 规则写的音量比例（mod 里 > 1 只是听得更远，增益封顶 1，播放时 min(1, volume)） */
  volume: number;
  /** 播放速度（Minecraft 的 pitch：变调同时变长短） */
  pitch: number;
  /** 相对这一次触发晚几秒（repeat 的间隔） */
  delay: number;
}

export class Voice {
  readonly rules: VoiceRules;
  private files: SfxManifest['files'];
  private rng: () => number;
  private counters = new Map<string, number>();
  private last = new Map<string, number>();
  constructor(rules: VoiceRules, files: SfxManifest['files'], rng: () => number) {
    this.rules = rules; this.files = files; this.rng = rng;
  }

  /** 规则认不认得这个 effect */
  knows(effect: string): boolean { return Object.hasOwn(this.rules.events, effect); }

  run(effect: string): Sound[] {
    const out: Sound[] = [];
    // 只认规则自己的键（toString 之类原型链上的名字不算，2026-10-20 子代理单测发现）
    for (const st of this.knows(effect) ? this.rules.events[effect] : []) this.step(st, out);
    return out;
  }

  private step(st: SfxStep, out: Sound[]): void {
    if (st.chance !== undefined) {
      if (this.rng() < st.chance && st.then) this.step(st.then, out);
    } else if (st.oneOf) {
      let r = this.rng() * st.oneOf.reduce((s, [w]) => s + w, 0);
      for (const [w, s] of st.oneOf) { r -= w; if (r < 0) { this.step(s, out); break; } }
    } else if (st.cycle !== undefined && st.steps) {
      const c = this.counters.get(st.cycle) ?? 0;
      this.counters.set(st.cycle, c + 1);
      this.step(st.steps[(c + (st.start ?? 0)) % st.steps.length], out);
    } else if (st.play) {
      const group = this.files[st.play];
      if (!group?.length) return;
      for (let k = 0; k < (st.repeat ?? 1); k++) {
        let i = st.index;
        if (i === undefined) {
          for (let tries = 0; tries < 10; tries++) {
            i = Math.floor(this.rng() * group.length);
            if (this.rules.pick !== 'fresh' || i !== this.last.get(st.play)) break;
          }
          this.last.set(st.play, i!);
        }
        const f = group[Math.min(i!, group.length - 1)], [lo, hi] = st.pitch ?? [1, 1];
        out.push({file: f.file, gainDb: f.gainDb, volume: st.volume ?? 1, pitch: lo + (hi - lo) * this.rng(), delay: k * (st.gap ?? 0)});
      }
    }
  }
}
