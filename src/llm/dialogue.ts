// 台词请求的严格解析与清洗（阶段 3，R9.3 / R6.5）。
//
// 这里只做两件纯逻辑的事：
// - parseDialogue：校验文本模型按阶段写回的台词。动作已经由程序锁定，台词里就算带了
//   action 之类的字段也不会被执行；版本 / 计划实例对不上就当过期。want（她心里想接下来做的事，空 = 没有）原样取出，
//   不显示、不执行，给 Clef 参考；没写或写坏了只当没有，不连累台词。
// - cleanLine：去掉思考块、把舞台说明抽成 aside、查禁用词和不在场角色、限长、近期去重。
// 不碰 DOM、窗口、网络和存档。
import type {Dialogue, DialogueLine} from './types.ts';

export type DialogueErrorCode = 'bad-json' | 'invalid' | 'stale' | 'refusal';

/** 解析失败时抛的错误。调用方按 code 走“LLM 不可用 -> 规则模式”。 */
export class DialogueError extends Error {
  readonly code: DialogueErrorCode;

  constructor(code: DialogueErrorCode, message: string) {
    super(message);
    this.name = 'DialogueError';
    this.code = code;
  }
}

export interface DialogueContext {
  /** 发出请求时的快照版本，返回时必须原样带回 */
  v: number;
  /** 已锁定的计划实例 id（不是动作名），同名动作的新实例也必须对不上 */
  plan: string;
  /** 本次允许说话的说话人 id */
  speakers: string[];
  /** 本次动作的阶段；每个阶段至少要有一句台词（optionalPhases 时不要求） */
  phases: string[];
  /** 单人一轮（2026-10-23 起运行时都是这种）：没写 speaker 的句子算她说的 */
  defaultSpeaker?: string;
  /** to 除了说话人以外还能写的对象：'user'（屏幕前的用户）、'self'（自言自语）、在场的别的角色 id */
  audience?: string[];
  /** 不要求每个阶段都有台词，也允许 0 句（没话说就不说，避免为了凑数复读） */
  optionalPhases?: boolean;
}

export interface CleanLineContext {
  /** 人设标签等禁用词，命中后整句丢弃 */
  banned: readonly string[];
  /** 不在场的角色名，命中后整句丢弃 */
  absentNames: string[];
  /** 最近说过的句子（只用最后 20 句做规范化去重和近似去重） */
  recent: string[];
  /** 气泡文字上限，默认 40 个 Unicode 码点 */
  maxChars?: number;
}

export interface CleanLineResult {
  text: string;
  aside: string[];
}

const MAX_LINES = 32;
const MAX_LINE_CHARS = 500;
const DEFAULT_MAX_CHARS = 40;
const RECENT_WINDOW = 20;
const MAX_WANT_CHARS = 60;

/** Enforce the prompt's output limits after cleaning. A reply has one line, so one exchange cannot fork. */
export function limitDialogueLines<T extends {phase:string;to:string}>(lines: T[], opts: {reply:boolean;scripted:boolean;recipients:string[]}): T[] {
  const phases = new Map<string,number>();
  let directed = false;
  return lines.filter(line => {
    if (opts.reply && phases.size) return false;
    if ((phases.get(line.phase) ?? 0) >= 2) return false;
    const toCharacter = opts.recipients.includes(line.to);
    if (!opts.scripted && toCharacter && directed) return false;
    phases.set(line.phase,(phases.get(line.phase) ?? 0)+1);
    if (toCharacter) directed = true;
    return true;
  });
}

function fail(code: DialogueErrorCode, message: string): never {
  throw new DialogueError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function charCount(value: string): number {
  return Array.from(value).length;
}

/** 去掉 BOM、首尾空白；只接受纯 JSON 或整体包住的 ```json 代码块。 */
export function extractJson(raw: string): {text: string; wellFormed: boolean} {
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (!trimmed.startsWith('```')) return {text: trimmed, wellFormed: true};

  const match = /^```[ \t]*([A-Za-z0-9_.+-]*)[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```$/i.exec(trimmed);
  if (!match) return {text: trimmed, wellFormed: false};

  const language = match[1].toLowerCase();
  if (language && language !== 'json') return {text: match[2].trim(), wellFormed: false};
  return {text: match[2].trim(), wellFormed: true};
}

// 非 JSON 回复及 JSON 内的各句台词都检查明确拒答；“我不能飞”之类不会被当成拒答。
// 中文模式要求出现拒绝对象（提供 / 协助 / 这类内容……），不能只凭“不能 / 无法”。
const CN_REFUSAL_PATTERNS: readonly RegExp[] = [
  /作为(?:一个|一名)?(?:ai|人工智能|语言模型|大模型|智能助手|助手)[^。！？!?\n]{0,24}(?:不能|无法|不会|不可以|不便|拒绝)/i,
  /(?:我|本人)[^。！？!?\n]{0,8}(?:必须|只能|要)(?:拒绝|婉拒)/,
  /(?:不能|无法|不可以)(?:满足|提供|完成|执行|协助|帮助|参与|继续|生成|编写|撰写|创作|回答|处理)[^。！？!?\n]{0,8}(?:这个|这种|这类|该|此|你的|您的要求|请求|要求|内容|任务|问题)/,
  /(?:这个|这种|这类|该|此)(?:请求|要求|内容|任务|问题)[^。！？!?\n]{0,12}(?:违反|超出|不在|无法|不能|不可以)/,
  /(?:抱歉|对不起)[^。！？!?\n]{0,12}(?:超出|超过)[^。！？!?\n]{0,8}(?:能力|范围|底线)/,
  /(?:抱歉|对不起|很抱歉|不好意思)[^。！？!?\n]{0,8}(?:不能|无法)[。！？!?\s]*$/,
  /(?:我|本人)(?:不能|无法)[。！？!?\s]*$/,
];

// 英文同样要求出现拒绝对象。“I can't fly”不算拒答。
const EN_REFUSAL_PATTERNS: readonly RegExp[] = [
  /\bas an? (?:ai|artificial intelligence|language model|large language model|assistant)\b[^.!?\n]{0,48}\b(?:cannot|can't|can not|won't|will not|unable|must decline|refuse)\b/i,
  /\bi(?:'m| am)? (?:sorry|afraid)[, ]+(?:but )?i\s+(?:cannot|can't|can not|am unable to|'m unable to|must decline|won't|will not)\b[^.!?\n]{0,48}\b(?:help|assist|provide|comply|complete|answer|generate|continue|engage|create|write|discuss|support|participate)\b/i,
  /\bi\s+(?:cannot|can't|can not|am unable to|'m unable to|must decline|won't|will not)\b[^.!?\n]{0,36}\b(?:assist|comply|fulfill|help (?:you|with)|provide (?:that|this|any|you|the)|continue (?:this|that|with)|generate (?:that|this|such)|write (?:that|this)|answer (?:that|this)|do (?:that|this)|participate|engage with|discuss (?:that|this))\b/i,
  /\bi(?:'m| am) (?:not able|unable) to (?:help|assist|provide|comply|complete|answer|generate|continue|create|write|discuss|support|do (?:that|this))\b/i,
  /\b(?:i )?(?:must|have to|need to) (?:respectfully )?decline\b/i,
  /\b(?:this|that|your) (?:request|prompt) (?:violates|goes against|is not something i can|is outside|exceeds)\b/i,
  /\bi (?:cannot|can't|won't) (?:engage|assist|comply) with (?:that|this|such|your)\b/i,
  /\b(?:sorry|apologies)[,. ]+(?:but )?(?:i )?(?:cannot|can't|can not|won't|will not) (?:help|assist|provide|comply|continue|answer|generate|write|create) (?:with )?(?:that|this|it|you|any)\b/i,
  /\b(?:sorry|apologies)[,. ]+(?:but )?(?:i )?(?:cannot|can't|can not|won't|will not)[.!?\s]*$/i,
  /\b(?:sorry|apologies)[,. ]+(?:but )?(?:i )?(?:cannot|can't|can not|won't|will not) (?:help|assist)[.!?\s]*$/i,
  /\bi (?:cannot|can't|can not|won't|will not) (?:help|assist|provide|comply|continue|answer|generate|write|create|participate)\b[.!?\s]*$/i,
  /\bi (?:cannot|can't|can not|won't|will not)[.!?\s]*$/i,
  /\bi(?:'m| am) not comfortable (?:with|doing|writing|continuing|describing)\b/i,
  /\bi(?:'d| would) rather not\b/i,
  /\b(?:cannot|can't|unable to) (?:fulfill|comply with|assist with|help with|provide) (?:this|that|your) (?:request|prompt|content)\b/i,
];

function isRefusal(raw: string): boolean {
  const text = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return CN_REFUSAL_PATTERNS.some(re => re.test(text)) || EN_REFUSAL_PATTERNS.some(re => re.test(text));
}

function readName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function validateDialogue(value: Record<string, unknown>, ctx: DialogueContext): Dialogue {
  const version = value.v;
  if (typeof version !== 'number' || !Number.isFinite(version)) fail('invalid', 'dialogue v is not a finite number');

  const plan = value.plan;
  if (typeof plan !== 'string' || !plan.trim()) fail('invalid', 'dialogue plan is not a non-empty string');
  const planInstance = plan.trim();

  const expectedVersion = ctx.v;
  if (typeof expectedVersion !== 'number' || !Number.isFinite(expectedVersion)) {
    fail('invalid', 'request version is not a finite number');
  }
  if (!Array.isArray(ctx.speakers) || !Array.isArray(ctx.phases)) {
    fail('invalid', 'request speaker / phase whitelist is missing');
  }
  const expectedPlan = typeof ctx.plan === 'string' ? ctx.plan.trim() : '';
  if (!expectedPlan) fail('invalid', 'request plan instance is empty');

  // 版本和计划实例先查：旧答复哪怕内容也不合法，调用方也应当按过期处理。
  if (version !== expectedVersion || planInstance !== expectedPlan) {
    fail('stale', 'dialogue does not belong to the current snapshot / plan instance');
  }

  const rawLines = value.lines;
  if (!Array.isArray(rawLines)) fail('invalid', 'dialogue lines is not an array');
  if (rawLines.length === 0 && !ctx.optionalPhases) fail('invalid', 'dialogue has no lines');
  if (rawLines.length > MAX_LINES) fail('invalid', `dialogue has more than ${MAX_LINES} lines`);

  const speakers = new Set(
    ctx.speakers.filter((s): s is string => typeof s === 'string').map(s => s.trim()).filter(Boolean),
  );
  const phases = new Set(
    ctx.phases.filter((p): p is string => typeof p === 'string').map(p => p.trim()).filter(Boolean),
  );
  const audience = new Set(
    (Array.isArray(ctx.audience) ? ctx.audience : []).filter((s): s is string => typeof s === 'string').map(s => s.trim()).filter(Boolean),
  );
  const covered = new Set<string>();
  const lines: DialogueLine[] = [];

  for (let index = 0; index < rawLines.length; index++) {
    const item = rawLines[index];
    if (!isRecord(item)) fail('invalid', `line ${index} is not an object`);

    const speaker = item.speaker === undefined && ctx.defaultSpeaker ? ctx.defaultSpeaker : readName(item.speaker);
    if (!speaker) fail('invalid', `line ${index} has no speaker`);
    if (!speakers.has(speaker)) fail('invalid', `line ${index} speaker is not allowed`);

    const phase = readName(item.phase);
    if (!phase) fail('invalid', `line ${index} has no phase`);
    if (!phases.has(phase)) fail('invalid', `line ${index} phase is not allowed`);

    const rawText = item.text;
    if (typeof rawText !== 'string') fail('invalid', `line ${index} text is not a string`);
    const text = rawText.trim();
    if (!text) fail('invalid', `line ${index} text is empty`);
    if (isRefusal(text)) fail('refusal', `line ${index} contains a provider refusal`);
    if (charCount(text) > MAX_LINE_CHARS) fail('invalid', `line ${index} text is longer than ${MAX_LINE_CHARS}`);

    const line: DialogueLine = {speaker, phase, text};
    if (item.to !== undefined) {
      const to = readName(item.to);
      if (!to) fail('invalid', `line ${index} to is not a non-empty string`);
      if (to === speaker || !speakers.has(to) && !audience.has(to)) fail('invalid', `line ${index} to is not an allowed audience (use self for self-talk)`);
      line.to = to;
    }

    // 只复制上面这几个字段：请求里夹带的 action / effect 等内容不会往下传。
    lines.push(line);
    covered.add(phase);
  }

  // 双人剧本不要求每个人每个阶段都说话，但每个阶段至少要有一句。
  if (!ctx.optionalPhases) for (const phase of phases) {
    if (!covered.has(phase)) fail('invalid', `dialogue is missing phase ${phase}`);
  }

  const want = readWant(value.want);
  return {v: version, plan: planInstance, lines, ...(want ? {want} : {})};
}

/** “想做”是附带信息：没写、不是字符串、空、像拒答都只当没有，不连累整段台词；空白合并，最多 MAX_WANT_CHARS 字 */
function readWant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = stripThinkBlocks(value).replace(/\s+/g, ' ').trim();
  if (!text || isRefusal(text)) return null;
  return Array.from(text).slice(0, MAX_WANT_CHARS).join('');
}

/**
 * 解析文本模型返回的台词。纯 JSON 或整体 fenced JSON。
 * - 版本 / 计划实例不符：`stale`
 * - JSON 坏了：`bad-json`
 * - 模型拒答：`refusal`
 * - 字段、白名单、阶段、长度不合法：`invalid`
 */
export function parseDialogue(raw: string, ctx: DialogueContext): Dialogue {
  if (typeof raw !== 'string') fail('bad-json', 'dialogue response is not text');
  const response = raw.replace(/^\uFEFF/, '').trim();
  if (!response) fail('bad-json', 'dialogue response is empty');

  const extracted = extractJson(response);
  if (!extracted.wellFormed) {
    if (isRefusal(extracted.text) || isRefusal(response)) fail('refusal', 'model refused to write the dialogue');
    fail('bad-json', 'dialogue response is not whole JSON or a whole fenced JSON block');
  }

  let parsed: unknown;
  let jsonOk = true;
  try {
    parsed = JSON.parse(extracted.text);
  } catch {
    jsonOk = false;
  }

  if (jsonOk && isRecord(parsed) && Array.isArray(parsed.lines)) {
    return validateDialogue(parsed, ctx);
  }

  // 不是台词 JSON（例如 {"error": "..."}）时才看拒答模式。
  // 已经通过 JSON 解析、但 lines 不是数组的回复，也可能只是坏了；拒答优先于 invalid。
  if (isRefusal(extracted.text) || isRefusal(response)) fail('refusal', 'model refused to write the dialogue');
  if (!jsonOk) fail('bad-json', 'dialogue response is not valid JSON');
  fail('invalid', 'dialogue response has no lines array');
}

// ---------------------------------------------------------------------------
// 清洗

const THINK_TAGS = 'think|thinking|reasoning|thought|analysis|scratchpad|reflection';

function stripThinkBlocks(raw: string): string {
  let text = raw;

  // 自闭合的 <think/> / <reasoning/> 只删标签，不影响后面的台词。
  text = text.replace(new RegExp(`<\\s*(?:${THINK_TAGS})\\b[^>]*?\\/\\s*>`, 'gi'), '');

  // 成对的 think / reasoning / [think] 块。先删成对的。
  text = text.replace(
    new RegExp(`<\\s*(${THINK_TAGS})\\b[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, 'gi'),
    '',
  );
  text = text.replace(
    new RegExp(`\\[\\s*(${THINK_TAGS})\\b[^\\]\\n]*\\][\\s\\S]*?\\[\\s*/\\s*\\1\\s*\\]`, 'gi'),
    '',
  );

  // 没闭合的块：从开标签起到结尾全部丢掉（包括后面的台词），不让思考内容漏出来。
  text = text.replace(new RegExp(`<\\s*(?:${THINK_TAGS})\\b[^>]*>[\\s\\S]*$`, 'i'), '');
  text = text.replace(new RegExp(`\\[\\s*(?:${THINK_TAGS})\\b[^\\]\\n]*\\][\\s\\S]*$`, 'i'), '');

  // 只有闭合标签的残片也去掉。
  text = text.replace(new RegExp(`<\\s*/\\s*(?:${THINK_TAGS})\\s*>`, 'gi'), '');
  text = text.replace(new RegExp(`\\[\\s*/\\s*(?:${THINK_TAGS})\\s*\\]`, 'gi'), '');
  return text;
}

function pushAside(asides: string[], value: string): void {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text) asides.push(text);
}

/** 把圆括号（中英文）和 *舞台说明* 抽到 asides；正文里不再保留这些标记。 */
function extractAsides(raw: string, asides: string[]): string {
  let out = '';
  let index = 0;

  while (index < raw.length) {
    const ch = raw[index];

    if (ch === '(' || ch === '（') {
      let depth = 0;
      let end = index;
      for (; end < raw.length; end++) {
        const inner = raw[end];
        if (inner === '(' || inner === '（') depth++;
        else if (inner === ')' || inner === '）') {
          depth--;
          if (depth === 0) {
            end++;
            break;
          }
        }
      }
      if (depth !== 0) {
        // 不闭合的括号按普通文字留下，避免把后面的台词整段吃掉。
        out += ch;
        index++;
        continue;
      }
      pushAside(asides, raw.slice(index + 1, end - 1));
      index = end;
      continue;
    }

    if (ch === '*' || ch === '＊') {
      // 单个 * 是舞台说明；顺手支持 **强调** / ***强调***，不要把它们拆坏。
      let run = 1;
      while (run < 3 && raw[index + run] === ch) run++;
      const close = raw.indexOf(ch, index + run);
      if (close < 0) {
        out += ch.repeat(run);
        index += run;
        continue;
      }
      let closeRun = 1;
      while (closeRun < run && raw[close + closeRun] === ch) closeRun++;
      const inner = raw.slice(index + run, close);
      if (inner.trim()) pushAside(asides, inner);
      index = close + closeRun;
      continue;
    }

    out += ch;
    index++;
  }

  return out;
}

function fold(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function containsBanned(haystack: string, token: string): boolean {
  const needle = fold(token).trim();
  return needle.length > 0 && haystack.includes(needle);
}

/** ASCII 名字按词边界匹配，避免短名字（Al）命中 also 之类的普通单词。 */
function containsName(haystack: string, name: string): boolean {
  const needle = fold(name).trim();
  if (!needle) return false;
  if (!/^[\x00-\x7F]+$/.test(needle)) return haystack.includes(needle);

  const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[a-z0-9]/.test(ch);
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[at + needle.length])) return true;
    from = at + 1;
  }
}

/** 去重用的规范化：大小写、全半角、空白和标点都不参与比较。 */
function dedupeKey(value: string): string {
  return fold(value).replace(/[\s\p{P}\p{S}]+/gu, '');
}

// 近似重复：规范化后的字二元组 Dice 系数（常见的短文本相似度）≥ 0.8 算同一句换了个标点 / 语气词。
// 太短的句子（< 6 个字）二元组太少，只按完全相同算。
const NEAR_DUPLICATE = 0.8;
const NEAR_MIN_CHARS = 6;
function bigrams(key: string): Map<string, number> {
  const chars = Array.from(key), out = new Map<string, number>();
  for (let i = 0; i + 1 < chars.length; i++) {
    const pair = chars[i] + chars[i + 1];
    out.set(pair, (out.get(pair) ?? 0) + 1);
  }
  return out;
}
function nearDuplicate(a: string, b: string): boolean {
  if (Array.from(a).length < NEAR_MIN_CHARS || Array.from(b).length < NEAR_MIN_CHARS) return false;
  const x = bigrams(a), y = bigrams(b);
  let shared = 0, total = 0;
  for (const [k, n] of x) { shared += Math.min(n, y.get(k) ?? 0); total += n; }
  for (const n of y.values()) total += n;
  return total > 0 && 2 * shared / total >= NEAR_DUPLICATE;
}

function truncateLine(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;

  // 优先在 maxChars 内的句末标点处截断；找不到再按词 / 硬截。
  for (let i = maxChars - 1; i >= 0; i--) {
    const ch = chars[i];
    const sentenceEnd = ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?'
      || ch === '…' || ch === '；' || ch === ';'
      || (ch === '.' && (i + 1 >= chars.length || /\s/.test(chars[i + 1] ?? '')));
    if (sentenceEnd) return chars.slice(0, i + 1).join('').trimEnd();
  }

  let cut = maxChars;
  if (/^[\x00-\x7F]*$/.test(chars.slice(0, maxChars).join(''))) {
    const candidate = chars.slice(0, maxChars).join('');
    const space = candidate.lastIndexOf(' ');
    if (space >= Math.floor(maxChars * 0.6)) cut = space;
  }
  return chars.slice(0, cut).join('').trimEnd();
}

/**
 * 清洗一句台词。
 * 返回 null 表示整句不能用：命中禁用词 / 不在场角色，或者清洗后没有可说的正文，
 * 或者和最近 20 句重复 / 近似重复。
 */
export function cleanLine(raw: string, ctx: CleanLineContext): CleanLineResult | null {
  if (typeof raw !== 'string') return null;

  const asides: string[] = [];
  const withoutThink = stripThinkBlocks(raw.replace(/[\u200B-\u200D\uFEFF]/g, ''));
  const stripped = extractAsides(withoutThink, asides);
  const text = stripped.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const maxChars = typeof ctx.maxChars === 'number' && Number.isFinite(ctx.maxChars)
    ? Math.max(1, Math.floor(ctx.maxChars))
    : DEFAULT_MAX_CHARS;

  // 禁用词和不在场角色按整句判断，包含 aside；截断前就判，避免把命中的部分截掉后漏过。
  const foldedForBanned = fold([text, ...asides].join('\n'));
  const banned = Array.isArray(ctx.banned) ? ctx.banned : [];
  for (const token of banned) {
    if (typeof token === 'string' && containsBanned(foldedForBanned, token)) return null;
  }

  const absentNames = Array.isArray(ctx.absentNames) ? ctx.absentNames : [];
  for (const name of absentNames) {
    if (typeof name === 'string' && containsName(foldedForBanned, name)) return null;
  }

  // 先截到气泡真正会显示的长度，再和最近 20 句比较；否则两条不同的长句
  // 截断后可能显示成同一句，却因为原文不同而漏过去重。
  const clipped = truncateLine(text, maxChars);
  if (!clipped) return null;

  const key = dedupeKey(clipped);
  if (key) {
    const recent = Array.isArray(ctx.recent) ? ctx.recent : [];
    const recentKeys = recent
      .slice(-RECENT_WINDOW)
      .filter((value): value is string => typeof value === 'string')
      .map(dedupeKey)
      .filter(Boolean);
    if (recentKeys.some(other => other === key || nearDuplicate(other, key))) return null;
  }

  return {text: clipped, aside: asides};
}
