// 说话音效的纯逻辑部分（R6.1）：把一句台词切成逐个音节 / 字母的合成单元，
// 以及全局说话队列。这里不创建 AudioContext，也不碰 DOM；renderer 只消费
// SpeechUnit 的 at / duration / pitch / formants。
//
// 中文用 pinyin-pro（官方 API）对整句做一次转换，多音字由它按整句上下文判断。
// 共振峰表按 temp/research/repos/procedural-animalese 的元音 F1/F2/F3 思路简化，
// 没有复制它的文件或代码。
import {pinyin} from 'pinyin-pro';
import type {SpeechTicket, SpeechUnit, SpeechVoice} from './types.ts';
import {resolveVoice} from './voice.ts';
export {DEFAULT_VOICE} from './voice.ts';


const MAX_INPUT_CHARS = 160;
const MAX_UNITS = 128;
// 一首 40 字左右的气泡台词即使把语速调到最慢也在 10 秒上下；这里再留一截，
// 同时保证异常长 / 异常慢的输入不会生成无界时长。
const MAX_TOTAL_SECONDS = 15;
const MAX_QUEUE = 64;

type Vowel = 'a' | 'e' | 'i' | 'o' | 'u' | 'ü';

const FORMANTS: Record<Vowel, readonly [number, number, number]> = {
  a: [800, 1150, 2900],
  e: [400, 1700, 2600],
  i: [300, 2200, 3000],
  o: [500, 900, 2600],
  u: [350, 600, 2700],
  ü: [300, 2000, 2400],
};

// 四个声调给一个固定的音高倍数，不做随机，测试和回放都可重复。
const TONE_PITCH: Record<number, number> = {
  0: 0.96,
  1: 1.18,
  2: 1.06,
  3: 0.86,
  4: 1.1,
};

function vowelFromFinal(final: string): Vowel | null {
  // pinyin-pro 的 final 带声调数字，例如 "ao3" / "ü3"。
  const clean = final.replace(/[0-9]/g, '').toLowerCase();
  if (!clean) return null;

  // 复韵母里决定音色的是主要元音，不是拼写里的第一个字母。
  if (clean === 'iu' || clean === 'iou' || clean === 'ong' || clean === 'iong') return 'o';
  if (clean === 'ui' || clean === 'uei' || clean === 'un' || clean === 'uen') return 'e';
  if (clean.includes('a')) return 'a';
  if (clean.includes('o')) return 'o';
  if (clean.includes('e')) return 'e';
  if (clean.includes('ü')) return 'ü';
  if (clean.includes('i')) return 'i';
  if (clean.includes('u')) return 'u';
  return null;
}

// 返回基频（Hz）。renderer 手里有 SpeechVoice，会再乘 formantScale；这里不能先乘，否则缩放两次。
function formantsFor(vowel: Vowel | null): [number, number, number] | null {
  if (!vowel) return null;
  return [...FORMANTS[vowel]];
}

function vowelFromLatinLetter(ch: string): Vowel | null {
  const lower = ch.normalize('NFKC').toLowerCase();
  if (lower === 'a' || lower === 'e' || lower === 'i' || lower === 'o' || lower === 'u') return lower;
  if (lower === 'y') return 'i'; // 英文里 y 在词尾常当元音用，只给一个近似值。
  if (lower === 'ü') return 'ü';
  return null;
}

/** 标点 / 空白的停顿长度（秒）；返回 null 表示不是停顿字符。 */
function pauseSeconds(ch: string): number | null {
  if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '…') return 0.32;
  if (ch === '，' || ch === '、' || ch === '；' || ch === '：' || ch === ',' || ch === ';' || ch === ':') return 0.18;
  if (ch === '—' || ch === '–' || ch === '-' || ch === '.' || ch === '~' || ch === '～') return 0.14;
  if (ch === '\n' || ch === '\r') return 0.24;
  if (/\s/u.test(ch)) return 0.06;
  if (/[\p{P}\p{S}]/u.test(ch)) return 0.02;
  return null;
}

function tonePitch(tone: number): number {
  return TONE_PITCH[tone] ?? TONE_PITCH[0];
}

function roundPitch(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 把文本切成说话音效单元。
 * - 中文：一个汉字一个单元，用整句拼音的声调改 pitch、韵母选 formants；
 * - 英文：一个字母一个单元，元音有共振峰，辅音没有；
 * - 标点 / 空白：只占时间，formants 为 null。
 * at / duration 都是秒，at 从 0 开始累加，总时长有上限。
 */
export function textToUnits(text: string, voice?: Partial<SpeechVoice>): SpeechUnit[] {
  if (typeof text !== 'string' || !text.trim()) return [];

  const resolved = resolveVoice(voice);
  const normalized = text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim();
  if (!normalized) return [];

  // 先按码点截断，避免超长输入让 pinyin-pro 和下面的循环无界。
  const source = Array.from(normalized).slice(0, MAX_INPUT_CHARS).join('');
  if (!source) return [];

  let entries;
  try {
    entries = pinyin(source, {type: 'all', toneType: 'num'});
  } catch {
    // pinyin-pro 对极少数输入可能失败；宁可不出声，也不让主循环崩掉。
    return [];
  }

  const units: SpeechUnit[] = [];
  let at = 0;

  const push = (unitText: string, duration: number, pitch: number, formants: [number, number, number] | null): boolean => {
    if (units.length >= MAX_UNITS || at >= MAX_TOTAL_SECONDS) return false;
    const limited = Math.min(duration, MAX_TOTAL_SECONDS - at);
    if (limited <= 0) return false;
    units.push({text: unitText, at, duration: limited, pitch, formants});
    at = Math.min(MAX_TOTAL_SECONDS, at + limited);
    return true;
  };

  for (const entry of entries) {
    const origin = entry.origin;
    if (!origin) continue;

    // pinyin-pro 一般一个码点一条；万一有条目带多个字符，仍逐个处理并沿用该条的声调。
    for (const ch of Array.from(origin)) {
      const pause = pauseSeconds(ch);
      if (pause !== null) {
        if (!push(ch, pause / resolved.speed, roundPitch(resolved.pitch), null)) return units;
        continue;
      }

      if (entry.isZh) {
        // 每个汉字都是浊音节；嗯 / 呣 这类成音节鼻音没有元音字母（pinyin-pro 给的 final 是 "g" / ""），按闭口的 u 哼出来，不当噪声。
        const vowel = vowelFromFinal(entry.final) ?? 'u';
        const pitch = roundPitch(resolved.pitch * tonePitch(entry.num));
        if (!push(ch, 0.11 / resolved.speed, pitch, formantsFor(vowel))) return units;
        units[units.length-1].tone=entry.num;
        continue;
      }

      const latinVowel = vowelFromLatinLetter(ch);
      if (latinVowel) {
        const pitch = roundPitch(resolved.pitch);
        if (!push(ch, 0.075 / resolved.speed, pitch, formantsFor(latinVowel))) return units;
        continue;
      }

      if (/^[A-Za-z]$/.test(ch) || /^[0-9]$/.test(ch)) {
        // 英文辅音和数字不选元音共振峰；字符本身仍占一个短音，方便气泡按字同步。
        if (!push(ch, 0.06 / resolved.speed, roundPitch(resolved.pitch), null)) return units;
        continue;
      }

      // 其它文字（日文假名等）没有拼音表，给一个短音节，不让整句丢掉。
      if (!push(ch, 0.08 / resolved.speed, roundPitch(resolved.pitch), null)) return units;
    }
  }

  return units;
}

// ---------------------------------------------------------------------------
// 全局说话队列

interface QueuedTicket {
  ticket: SpeechTicket;
  seq: number;
}

/**
 * 全局唯一的说话队列（R8.1 / state-rules §1“说话”通道）。
 * - 最多 64 条；满了以后丢优先级最低的（同优先级丢最早入队的）。
 * - 数字越大越优先；同优先级按入队顺序。
 * - next() 跳过并删掉已过期、或 valid() 认为动作实例 / 阶段不对的票。
 */
export class SpeechQueue {
  #items: QueuedTicket[] = [];
  #seq = 0;

  get size(): number {
    return this.#items.length;
  }

  enqueue(ticket: SpeechTicket): void {
    if (!ticket || typeof ticket !== 'object') return;
    this.#items.push({ticket, seq: this.#seq++});
    while (this.#items.length > MAX_QUEUE) {
      let worst = 0;
      for (let i = 1; i < this.#items.length; i++) {
        const a = this.#items[i]!;
        const b = this.#items[worst]!;
        const aPriority = Number.isFinite(a.ticket.priority) ? a.ticket.priority : 0;
        const bPriority = Number.isFinite(b.ticket.priority) ? b.ticket.priority : 0;
        if (aPriority < bPriority || (aPriority === bPriority && a.seq < b.seq)) worst = i;
      }
      this.#items.splice(worst, 1);
    }
  }

  next(now: number, valid: (ticket: SpeechTicket) => boolean): SpeechTicket | null {
    this.#items = this.#items.filter(item => {
      const expiresAt = item.ticket.expiresAt;
      return typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt > now;
    });

    // 优先级从高到低，同优先级按入队先后。
    const order = [...this.#items].sort((a, b) => {
      const ap = Number.isFinite(a.ticket.priority) ? a.ticket.priority : 0;
      const bp = Number.isFinite(b.ticket.priority) ? b.ticket.priority : 0;
      return bp - ap || a.seq - b.seq;
    });

    for (const item of order) {
      let ok = false;
      try {
        ok = valid(item.ticket) === true;
      } catch {
        ok = false;
      }
      if (ok) {
        const index = this.#items.indexOf(item);
        if (index >= 0) this.#items.splice(index, 1);
        return item.ticket;
      }
      const index = this.#items.indexOf(item);
      if (index >= 0) this.#items.splice(index, 1);
    }

    return null;
  }

  clear(speaker?: string): void {
    if (speaker === undefined) {
      this.#items = [];
      return;
    }
    this.#items = this.#items.filter(item => item.ticket.speaker !== speaker);
  }
}
