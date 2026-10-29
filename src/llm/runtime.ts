// LLM 运行时（阶段 3；2026-10-23 改成每个角色一段自己的会话）：Clef 选意图，文本模型给已锁定的动作写台词。
//
// - 会话：每个角色、每个模式一段多轮上下文（MemoryStore，data/memory.sqlite），拼法见 context.ts（公共前缀 → 规则 → 人设 → 记忆摘要
//   → 最近若干轮 → 这一次）。同一个模型也分开请求，人设和上下文互不串。超过 maxTurns 轮时把最早的 dropTurns 轮折叠成记忆摘要
//   （一次丢一批，缓存只断一次；每个角色可以单独设，没设的用 context 里的）。
// - 谁来说：互动触发为主（被点 / 被摸 / 被拎起来扔 / 躲着被发现 / 双人 / 别的角色对她说话），没人触发的主动台词按 proactive 的间隔很少说。
// - 每个角色一个收件箱（2026-10-23 用户提的）：事件触发先攒着，安静 debounce.quietSec 秒或攒满 maxWaitSec 秒、并且离她上一次事件请求
//   过了 reactionIntervalSec，就合成一次请求；她有请求在途时新来的照样攒着、回来以后再一起发（不取消在途的）；最多攒 maxTriggers 件。
//   同一个角色的请求一次一个（事件、主动台词、双人都排在她自己这条队里），不会互相取消。
// - 角色之间：说出口的话在场的角色都听得到（下一轮的“听到”），说给某个角色的话她会回（talk，最多 talk.maxExchanges 句一来一回）。
// - 双人：邀请方先写自己这一段，对方看着她的台词再写自己的（两次请求，各用各的会话）。
// - 每个角色可以单独指定文本模型（characters.<id>.text，托盘面板里改，存 config/llm.local.json）；Clef 决策全局一个。
// - 想做（2026-10-23 用户提的）：台词回复每轮都带 want（她心里真实想接下来做的事，可以和嘴上说的不一样，没有就空），不显示，
//   只进她自己的会话（别的角色只听得到台词）；她下次空下来时不等决策间隔就问 Clef，want 写进 Clef 的输入，候选里有对得上的优先选。
//   程序照旧只在规则给的候选里执行，做不到就当她只是想想。
import {ImageAttachments, VISION_INSTRUCTIONS, withImage} from './attachments.ts';
import {DEFAULT_VISION, characterVisionValid, visionValid, type CharacterVision, type VisionConfig, type CapturedFrame} from '../vision/index.ts';
import type {ObserverCharacter} from '../vision/index.ts';
import fs from 'node:fs';
import path from 'node:path';
import type {Actor, Plan} from '../behavior/index.ts';
import type {Sim, SimEvent} from '../main/sim.ts';
import {ChatCompletions, ClefProvider, LlmFailure, providerUrl, failureOf, type Fetcher} from './providers.ts';
import {CallTracker} from './calls.ts';
import {executionEvent, movementStamp} from './execution.ts';
import {RequestQueue} from './queue.ts';
import {BudgetGate, UsageStore, type BudgetBlock} from './usage.ts';
import {DialogueError, cleanLine, parseDialogue, extractJson, limitDialogueLines} from './dialogue.ts';
import {SpeechQueue, textToUnits, DEFAULT_VOICE} from './speech.ts';
import {resolveVoice,voiceValid} from './voice.ts';
import {msg, type Msg} from '../shared/msg.ts';
import {turnsValid, hourlyValid, type Turns} from './turns.ts';
import {MemoryStore, type MemoryMode} from './memory.ts';
import {capabilitiesText} from './state.ts';
import {decisionMessage} from './context.ts';
import {decisionQuestions, selectedGoals, requestedPlanSize} from './decision.ts';
export {DECISION_INSTRUCTIONS} from './decision.ts';
import {boundedHistory, buildMessages, buildSummaryMessages, currentMessage, mergeTriggers, repairRequest, replyRecord, summaryRequest, turnRecord, type ChatMessage, type HeardLine, type PendingTrigger, type StepInfo, type TurnFacts} from './context.ts';
import type {Binding, Price, ProviderConfig, RequestKind, SpeechTicket, SpeechUnit, SpeechVoice, TextKind, Usage} from './types.ts';

interface Config {
  vision: VisionConfig;
  decision: string; routes: Record<TextKind,string>; providers: Record<string,ProviderConfig>;
  /** 每个角色单独的设置（面板里改，存 config/llm.local.json）：文本模型（provider id，没写按 routes）、会话超过几轮时丢最早几轮、
   *  决策带最近几轮（没写的按 context） */
  characters: Record<string,CharacterConfig>;
  /** reactionIntervalSec：同一角色两次事件请求之间至少隔多久（这期间的触发攒着，不丢） */
  decisionIntervalSec: number; reactionIntervalSec: number;
  /** 事件触发的防抖：安静 quietSec 秒、或者从第一件起满 maxWaitSec 秒就发；最多攒 maxTriggers 件，再多丢最早的 */
  debounce: {quietSec: number; maxWaitSec: number; maxTriggers: number};
  /** 没人触发的主动台词：同一角色普通行为 / R18 行为各隔多久，所有角色之间至少隔多久 */
  proactive: {intervalSec: number; adultIntervalSec: number; globalGapSec: number};
  /** 角色之间一来一回最多几句 */
  talk: {maxExchanges: number};
  /** 会话的默认值：超过 maxTurns 轮（或 maxChars 字）时把最早的 dropTurns 轮折叠进记忆；折叠一直失败、到了 maxTurns + dropTurns 轮
   *  就不摘要直接归档（不让会话无限长）；决策（Clef）带最近 decisionTurns 轮；记忆摘要最多 summaryChars 字 */
  context: {maxTurns: number; dropTurns: number; maxChars: number; decisionTurns: number; summaryChars: number};
  minChoiceProbability: number | null;
  /** 每小时最多几次请求（防循环 bug 刷请求的熔断，null = 不限；托盘里改，存 llm.local.json） */
  hourlyRequests: number | null; dailyUsd: number | null; dailyTokens: number | null;
  maxTokens: Record<TextKind | 'memory',number>;
}
export interface CharacterConfig { vision?: CharacterVision; voice?: SpeechVoice; text?: string; maxTurns?: number; dropTurns?: number; decisionTurns?: number }
export interface ActiveSpeech { token: number; ticket: SpeechTicket; units: SpeechUnit[]; voice: SpeechVoice; start: number; duration: number }
interface SpeechPlayback extends ActiveSpeech { actor: Actor; recipient?: Actor; completedPlan: boolean }
const TEXT_KINDS: TextKind[] = ['line','adult-line','reaction','duo','talk','reply','vision'];
/** 对事件的台词（被点 / 被发现 / 被扔 / 回话）：不跟着动作阶段，从发请求起这么多秒内说出来都算自然，再晚就不说了 */
const EVENT_LINE_SEC = 12;
const EVENT_KINDS: ReadonlySet<TextKind> = new Set(['reaction','talk','reply','vision']);
/** Clef 选下一步的指令（运行时和 scripts/probe-llm.ts --want-clef 共用一份） */
/** 想做（台词回复里的 want）多久内还算数：她这段时间里空下来就拿去问 Clef，过了就当念头过去了 */
const WANT_SEC = 90;
/** Application-level summary failures back off independently of provider HTTP retries. */
const MEMORY_RETRY_SEC = 60;
/** 部位图的部位 id（docs/pack-format.md）→ 给模型看的中文 */
const PART_NAMES: Record<string,string> = {head:'头',chest:'胸',torso:'身体',crotch:'下面',butt:'屁股',arm:'手臂',leg:'腿',skirt:'裙子'};
/** 当前这一步 + 计划里还没做的几步（plan.steps 是剩下的，执行时一步步 shift 掉） */
const stepsOf = (a: Actor, now:number): StepInfo[] => (a.plan ? [a.step, ...a.plan.steps] : []).filter((s): s is NonNullable<typeof s> => !!s)
  .map(s => ({phase: s.phase, state: s.state, action: s.action, sec: s.sec,
    ...(s===a.step&&Number.isFinite(a.stateEnd)&&a.state!=='walk'?{remainingSec:Math.max(0,a.stateEnd-now)}:{}),
    outfit: s.outfit, outfitAt: s.outfitAt, behind: s.layer?.kind === 'behind'}));
const phasesOf = (a: Actor): string[] => [...new Set([a.phase, ...(a.plan?.steps.map(s=>s.phase) ?? [])].filter((x):x is NonNullable<typeof x>=>!!x))];
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hhmm = (ms: number) => { const d=new Date(ms); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
/** 被上限挡下时的状态文字（托盘 / 面板 / 提示共用） */
export const limitText = (b: BudgetBlock): Msg => b.reason==='hourly'
  ? msg('status.llm.hourlyLimit', {used: b.used, limit: b.limit, until: hhmm(b.until)})
  : msg('status.llm.dailyLimit');
const posInt = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
const nonNeg = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export {turnsValid, hourlyValid} from './turns.ts';
const turnsWith = (c: CharacterConfig | undefined, d: Turns): Turns =>
  ({maxTurns: c?.maxTurns ?? d.maxTurns, dropTurns: c?.dropTurns ?? d.dropTurns, decisionTurns: c?.decisionTurns ?? d.decisionTurns});

/** config/llm.json，再叠上 config/llm.local.json（不入库：自己的服务商、每个角色的模型）；providers / routes / characters 按键合并，其余整项覆盖 */
export function loadConfig(root: string): Config {
  const c = readJson(path.join(root,'config','llm.json')) as Config;
  let local: Partial<Config> = {};
  try { local = readJson(path.join(root,'config','llm.local.json')); } catch { /* optional */ }
  if (local && typeof local === 'object') for (const [k,v] of Object.entries(local) as [keyof Config, any][]) {
    if (k==='providers' && v && typeof v==='object') {
      c.providers=Object.fromEntries([...new Set([...Object.keys(c.providers),...Object.keys(v)])].map(id=>[id,{...c.providers[id],...v[id]}]));
    } else (c as any)[k] = ['routes','characters'].includes(k) && v && typeof v === 'object' ? {...(c as any)[k], ...v} : v;
  }
  c.characters ??= {};
  c.vision={...DEFAULT_VISION,...c.vision};
  c.routes.vision ??= c.routes.line; c.maxTokens.vision ??= c.maxTokens.line;
  if (!visionValid(c.vision)) throw new Error('invalid vision config');
  if (!c || typeof c !== 'object' || !c.providers || !c.routes || !Object.hasOwn(c.providers,c.decision)) throw new Error('invalid llm config');
  for (const id of Object.values(c.routes)) if (!Object.hasOwn(c.providers,id)) throw new Error('invalid llm route');
  for (const [id,v] of Object.entries(c.characters)) if (!v || typeof v !== 'object' || v.text !== undefined && (!Object.hasOwn(c.providers,v.text) || v.text === c.decision) ||
    !turnsValid(turnsWith(v, c.context ?? {} as Turns)) || v.vision!==undefined && !characterVisionValid(v.vision) || v.voice!==undefined && !voiceValid(v.voice)) throw new Error(`invalid llm character ${id}`);
  for (const p of Object.values(c.providers)) {
    if (!p || p.images!==undefined && typeof p.images!=='boolean' || !p.model || !p.account || !p.baseUrl || !Number.isInteger(p.concurrency) || p.concurrency < 1 || p.concurrency > 8 ||
      !Number.isFinite(p.timeoutMs) || p.timeoutMs < 1 || p.timeoutMs > 60000 || !['none','json_object','json_schema'].includes(p.jsonMode)) throw new Error('invalid llm provider');
    try { providerUrl(p.baseUrl); }
    catch { throw new Error('invalid llm provider URL'); }
  }
  for (const n of [c.decisionIntervalSec,c.reactionIntervalSec]) if (!Number.isFinite(n) || n <= 0) throw new Error('invalid llm limits');
  if (!hourlyValid(c.hourlyRequests)) throw new Error('invalid llm limits');
  const pr = c.proactive, cx = c.context;
  if (!pr || ![pr.intervalSec,pr.adultIntervalSec,pr.globalGapSec].every(nonNeg)) throw new Error('invalid llm proactive');
  if (!c.talk || !Number.isInteger(c.talk.maxExchanges) || c.talk.maxExchanges < 0) throw new Error('invalid llm talk');
  const db = c.debounce;
  if (!db || ![db.quietSec,db.maxWaitSec].every(nonNeg) || db.maxWaitSec < db.quietSec || !posInt(db.maxTriggers) || db.maxTriggers > 50) throw new Error('invalid llm debounce');
  if (!cx || !turnsValid(cx) || ![cx.maxChars,cx.summaryChars].every(posInt) || cx.summaryChars > 3000) throw new Error('invalid llm context');
  for (const n of [c.dailyUsd,c.dailyTokens]) if (n !== null && (!Number.isFinite(n) || n <= 0)) throw new Error('invalid llm budget');
  if (c.minChoiceProbability !== null && (!Number.isFinite(c.minChoiceProbability) || c.minChoiceProbability < 0 || c.minChoiceProbability > 1)) throw new Error('invalid llm probability');
  for (const k of [...TEXT_KINDS,'memory'] as const) {const n=c.maxTokens?.[k];if (!Number.isInteger(n) || n < 1 || n > 4096) throw new Error('invalid llm max tokens');}
  for (const k of TEXT_KINDS) if (!Object.hasOwn(c.providers,c.routes[k])) throw new Error('invalid llm route');
  return c;
}

interface Trigger {
  /** Instance/lifecycle check for work that may wait in an inbox or account queue. */
  valid?: () => boolean;
  frame?: CapturedFrame; manual?: boolean;
  kind: TextKind;
  /** 发生了什么（写进她的会话） */
  what: string;
  /** 双人：对方 id；对方已经写好的这一段 */
  partner?: string; partnerScript?: {phase:string;to:string;text:string}[];
  /** 角色之间对话：这一句回的是第几句 */
  thread?: {id: number; depth: number};
  /** 跟计划走的（主动台词、双人）：排到时计划已经换了就不发 */
  plan?: Plan;
  /** 这一轮完了以后（双人：邀请方写完再排对方） */
  then?: (kept: {phase:string;to:string;text:string}[] | null) => void;
}
/** 每个角色的收件箱：攒着的事件触发 + 一件跟计划走的（新的顶掉旧的） */
interface Inbox { actor: Actor | undefined; events: PendingTrigger[]; first: number; last: number; dropped: number; job: Trigger | null }
interface Said { speaker: string; text: string }

export class LlmRuntime {
  private images=new ImageAttachments(); private visionRevision=0;
  private visionStatus=new Map<string,'verified'|'failed'>();
  onVisionChange: ((id?:string)=>void) | null=null;
  readonly config: Config; readonly store: UsageStore; readonly memory: MemoryStore;
  private root: string; private sim: Sim; private queue: RequestQueue; private budget: BudgetGate;
  private prices: Record<string,Price>; private keys = new Map<string,string>();
  private enabled = false; private blocked = false; private closed = false;
  private wanted = new Set<string>(); private pending = new Map<string,AbortController>();
  private lastDecision = new Map<string,number>(); private lastEventTurn = new Map<string,number>();
  private inbox = new Map<string,Inbox>(); private busy = new Set<string>();
  private lastProactive = new Map<string,number>(); private lastProactiveAny = -Infinity;
  private ids = new WeakMap<Plan,string>(); private serial = 0; private speechSerial = 0; private threadSerial = 0;
  private actorIds = new WeakMap<Actor,number>(); private actorSerial=0;
  private recentEvents = new Map<string,object[]>();
  private speechCurrent = new WeakMap<SpeechTicket,()=>boolean>();
  private requested = new WeakSet<Plan>(); private speech = new SpeechQueue();
  private waiting: {ticket: SpeechTicket; actors: Actor[]}[] = [];
  /** 最近写好的和说出口的台词（所有角色一起，去重用：自己不复读，也不学别人刚说的） */
  private said: Said[] = [];
  /** 每个角色上次说话以后听到的（说出口时记给在场的其他角色，下一轮带上） */
  private heard = new Map<string,HeardLine[]>();
  private thrown = new Map<string,number>(); private compacting = new Set<string>();
  private compactRetryAt = new Map<string,number>();
  /** 每个角色最近一次“想做”：内容、什么时候（sim 时间）、哪一次出场；问过一次 Clef 就删 */
  private wants = new Map<string,{text: string; at: number; gen: number}>();
  private calls: CallTracker;
  private voices = new Map<string,SpeechVoice>();
  private contextRevision = 0;
  private characterVisionRevisions = new Map<string, number>();
  active: SpeechPlayback | null = null;
  latest: Msg = msg('status.llm.off');
  /** 现在被哪个上限挡着（null = 没挡）；变化时调 onLimit，notify = 该弹提示了（同一种上限一小时最多一次，改了上限重新算） */
  limitHit: BudgetBlock | null = null;
  onLimit: ((block: BudgetBlock | null, notify: boolean) => void) | null = null;
  private noticeAt = new Map<BudgetBlock['reason'],number>();
  private log: (r: object)=>void;

  constructor(root: string, sim: Sim, log: (r: object)=>void = ()=>{}) {
    this.root=root; this.sim=sim; this.log=log; this.config=loadConfig(root);
    this.prices=readJson(path.join(root,'config','pricing.json'));
    fs.mkdirSync(path.join(root,'data'),{recursive:true});
    this.store=new UsageStore(path.join(root,'data','llm.sqlite'));
    this.calls=new CallTracker({available:()=>this.available(),allowed:kind=>this.allowed(kind),price:provider=>this.prices[provider],record:record=>{
      if(!this.closed)this.store.record(record);
      this.latest=msg('status.llm.call',{kind:record.kind,result:record.result,ms:Math.round(record.latencyMs)});this.log({type:'llm',...record});
    }});
    this.memory=new MemoryStore(path.join(root,'data','memory.sqlite'));
    const limits: Record<string,number> = {};
    for (const p of Object.values(this.config.providers)) limits[p.account]=Math.min(limits[p.account] ?? Infinity,p.concurrency);
    this.queue=new RequestQueue(limits); this.budget=new BudgetGate(this.config);
    for (const id of sim.chars.keys()) {
      try {
        const voice=readJson(path.join(root,sim.chars.get(id)!.pack.relDir,'voice.json'));
        if ([voice.pitch,voice.speed,voice.formantScale,voice.breath].every(v=>typeof v==='number'&&Number.isFinite(v)) && voice.pitch>=80&&voice.pitch<=800&&voice.speed>=.5&&voice.speed<=2.5&&voice.formantScale>=.5&&voice.formantScale<=2&&voice.breath>=0&&voice.breath<=1) this.voices.set(id,resolveVoice(voice));
      } catch { /* default synthesis voice */ }
    }
    let secrets: Record<string,any> = {};
    try { secrets=readJson(path.join(root,'config','secrets.local.json')); } catch { /* environment-only is supported */ }
    for (const [id,p] of Object.entries(this.config.providers)) {
      const value=process.env[p.keyEnv] || secrets[p.secretName]?.api_key;
      if (typeof value==='string') this.keys.set(id,value);
    }
    sim.decisionGate = id => {
      if (!this.available() || !this.hasKey(this.config.decision) || sim.userIdleSec >= 1800) return false;
      if (this.pending.has(id) || this.wanted.has(id)) return true;
      // 她刚想做什么：空下来就问，不等决策间隔（一个想做只问一次，decide 里取走）
      const interval=this.freshWant(id)?0:this.config.decisionIntervalSec*(sim.userIdleSec>=300?4:1);
      if (sim.now-(this.lastDecision.get(id)??-Infinity)<interval || !this.allowed('decision')) return false;
      this.wanted.add(id); return true;
    };
  }
  private hasKey(id: string) {
    const p=this.config.providers[id];
    try { return !!p && (!!this.keys.get(id) || ['localhost','127.0.0.1','[::1]'].includes(new URL(p.baseUrl).hostname)); }
    catch { return false; }
  }
  private available() { return this.enabled && !this.blocked && !this.closed; }
  /** 所有请求都过这一道：被上限挡下时记下来、更新状态文字，第一次（之后每小时一次）通知 main 弹提示；恢复了也通知（托盘提示文字跟着变） */
  private allowed(kind: RequestKind) {
    const now=Date.now(), date=new Date(now), dayStart=new Date(date.getFullYear(),date.getMonth(),date.getDate()).getTime();
    const since=this.config.dailyUsd!==null || this.config.dailyTokens!==null ? Math.min(dayStart,now-3600000) : now-3600000;
    const block=this.budget.check(this.store.since(since),kind,now,this.calls.reservations), was=this.limitHit;
    this.limitHit=block;
    if (!block) { if (was) { this.latest=msg('status.llm.limitRecovered'); this.onLimit?.(null,false); } return true; }
    this.latest=limitText(block);
    if (!was || was.reason!==block.reason) {
      const notify=now-(this.noticeAt.get(block.reason)??-Infinity)>=3600e3;
      if (notify) this.noticeAt.set(block.reason,now);
      this.log({type:'llm-budget',kind,...block,notify});
      this.onLimit?.(block,notify);
    }
    return false;
  }
  private mode(): MemoryMode { return this.sim.opts.r18 ? 'adult' : 'sfw'; }
  private memoryVersions = new Map<string, number>();
  private memoryVersion(id: string, mode: MemoryMode): number { return this.memoryVersions.get(`${id}:${mode}`) ?? 0; }
  /** Invalidate in-flight replies and summaries before deleting persistent and transient context. */
  forgetMemory(id: string, mode: MemoryMode): void {
    this.memoryVersions.set(`${id}:${mode}`, this.memoryVersion(id, mode) + 1);
    this.compactRetryAt.delete(`${id}:${mode}`);
    if (mode===this.mode()) {
      for (const key of [id,`text:${id}`]) {this.pending.get(key)?.abort();this.pending.delete(key);}
      this.wanted.delete(id);this.inbox.delete(id);this.wants.delete(id);this.heard.delete(id);this.recentEvents.delete(id);this.thrown.delete(id);
      this.waiting=this.waiting.filter(w=>w.ticket.speaker!==id);this.speech.clear(id);this.said=this.said.filter(s=>s.speaker!==id);
      if(this.active?.ticket.speaker===id)this.endSpeech('memory-cleared');
      this.onVisionChange?.(id);
    }
    this.memory.forget(id, mode); this.images.clear(id,mode);
    this.log({type:'llm-memory-cleared',id,mode});
  }
  setEnabled(on: boolean) { this.enabled=on; if (!on) this.cancel(); this.latest=msg(on?'status.llm.on':'status.llm.off'); }
  suspend(on: boolean) { if (on && !this.blocked) this.cancel(true,true); this.blocked=on; }
  private cancel(notify = true, preserveActivity = false) {
    if(!preserveActivity)this.sim.clearLlmControl();
    this.contextRevision++;this.heard.clear();this.recentEvents.clear();this.said=[];this.thrown.clear();
    this.images.clear();this.visionRevision++;
    for (const c of this.pending.values()) c.abort();
    this.pending.clear(); this.wanted.clear(); this.waiting=[]; this.speech.clear(); this.endSpeech(preserveActivity?'suspended':'cancelled'); this.inbox.clear(); this.wants.clear();
    if(notify)this.onVisionChange?.();
  }
  close() { this.cancel(false); this.closed=true; this.queue.close(); this.sim.decisionGate=undefined; this.store.close(); this.memory.close(); }

  /** 角色用哪个文本模型（provider id） */
  textProvider(id: string, kind: TextKind): string { return this.config.characters[id]?.text ?? this.config.routes[kind]; }
  /** Pack defaults stay read-only; user overrides affect the next utterance, including already queued lines. */
  voiceOf(id: string): SpeechVoice { return {...(this.config.characters[id]?.voice??this.defaultVoiceOf(id))}; }
  defaultVoiceOf(id: string): SpeechVoice { return {...(this.voices.get(id)??DEFAULT_VOICE)}; }
  /** 角色的会话上限和决策带几轮：她自己设的，没设用 context 的默认 */
  turnsOf(id: string): Turns { return turnsWith(this.config.characters[id],this.config.context); }
  /** 面板里改某个角色的设置（值为 null = 删掉这一项、用默认），写进 config/llm.local.json；下一次请求生效 */
  setCharacter(id: string, patch: {[K in keyof CharacterConfig]?: CharacterConfig[K] | null}): boolean {
    if (!this.sim.chars.has(id)) return false;
    const previous=this.config.characters[id], next: CharacterConfig={...previous};
    for (const [k,v] of Object.entries(patch) as [keyof CharacterConfig, unknown][]) {
      if (!['text','maxTurns','dropTurns','decisionTurns','vision','voice'].includes(k)) return false;
      if (v===null) delete next[k]; else (next as Record<string,unknown>)[k]=v;
    }
    if (next.text!==undefined && (typeof next.text!=='string' || !Object.hasOwn(this.config.providers,next.text) || next.text===this.config.decision)) return false;
    if (!turnsValid(turnsWith(next,this.config.context)) || next.vision!==undefined && !characterVisionValid(next.vision) || next.voice!==undefined && !voiceValid(next.voice)) return false;
    if(next.voice)next.voice={...next.voice};
    this.writeLocal(local=>{ local.characters={...local.characters,[id]:next}; if (!Object.keys(next).length) delete local.characters[id]; });
    if (Object.keys(next).length) this.config.characters[id]=next; else delete this.config.characters[id];
    if(next.text!==previous?.text || JSON.stringify(next.vision)!==JSON.stringify(previous?.vision)) {
      this.images.clear(id);this.characterVisionRevisions.set(id,(this.characterVisionRevisions.get(id)??0)+1);this.onVisionChange?.(id);
    }
    return true;
  }
  /** 托盘里改每小时上限（null = 不限），写进 config/llm.local.json，马上生效；改了以后被挡着的重新判断、提示重新算 */
  setHourlyLimit(n: number | null): boolean {
    if (!hourlyValid(n)) return false;
    this.writeLocal(local=>{ local.hourlyRequests=n; });
    this.config.hourlyRequests=n; this.budget=new BudgetGate(this.config); this.noticeAt.clear();
    if (this.limitHit) { this.limitHit=null; this.latest=n===null?msg('status.llm.hourlyUnlimited'):msg('status.llm.hourlyChanged',{n}); this.onLimit?.(null,false); }
    return true;
  }
  /** Screen settings are live; unsupported capture strategies remain reserved interfaces. */
  setVision(patch: Partial<VisionConfig>): boolean {
    if (!patch || typeof patch!=='object' || Array.isArray(patch) || Object.keys(patch).some(k=>!Object.hasOwn(DEFAULT_VISION,k)))return false;
    const next={...this.config.vision,...patch};if(!visionValid(next))return false;
    this.writeLocal(local=>{local.vision=next;});this.config.vision=next;
    this.images.clear();this.visionRevision++;this.onVisionChange?.();return true;
  }
  setProviderImages(id:string,on:boolean):boolean {
    if (!Object.hasOwn(this.config.providers,id) || id===this.config.decision || typeof on!=='boolean')return false;
    const next={...this.config.providers[id],images:on};
    this.writeLocal(local=>{local.providers={...local.providers,[id]:{...local.providers?.[id],images:on}};});this.config.providers[id]=next;
    this.visionStatus.delete(id);this.images.clear();this.visionRevision++;this.onVisionChange?.();return true;
  }
  forgetImages(id:string) {this.images.clear(id);}
  visionActive():boolean {return this.available() && this.sim.userIdleSec<1800 && this.allowed('vision');}
  visionCharacters():ObserverCharacter[] {
    return [...this.sim.chars.keys()].flatMap(id=>{
      const a=this.present(id);if(!a)return [];
      const provider=this.textProvider(id,'vision'), p=this.config.providers[provider],v=this.config.characters[id]?.vision;
      return [{id,generation:this.gen(a),capable:p?.images===true && this.hasKey(provider),
        busy:this.busy.has(id)||this.pending.has(id)||a.state==='dragged'||a.state==='fall',
        auto:(v?.auto??this.config.vision.auto) && this.visionStatus.get(provider)!=='failed',intervalSec:v?.intervalSec??this.config.vision.intervalSec}];
    });
  }
  imageStatus(id:string) {const provider=this.textProvider(id,'vision');return this.config.providers[provider]?.images===true?this.visionStatus.get(provider)??'unverified':'unsupported';}
  async observe(id:string,generation:number,frame:CapturedFrame,manual:boolean):Promise<boolean> {
    const c=this.visionCharacters().find(c=>c.id===id);
    if(!this.config.vision.enabled || !this.visionActive() || !c?.capable || c.busy || c.generation!==generation)return false;
    this.busy.add(id);
    try {return (await this.turn(id,{kind:'vision',what:`${manual?'用户请你看一次':'你主动看了'}屏幕`,frame,manual}))!==null;}
    finally {this.busy.delete(id);}
  }
  /** config/llm.local.json 读出来改一项再原子写回（不入库，面板和托盘的设置都存这里） */
  private writeLocal(edit: (local: Record<string,any>) => void) {
    const file=path.join(this.root,'config','llm.local.json');
    let local: Record<string,any> = {};
    try { local=readJson(file); } catch { /* new file */ }
    edit(local);
    fs.writeFileSync(file+'.tmp',JSON.stringify(local,null,2)); fs.renameSync(file+'.tmp',file);
  }

  /** 角色这一次出场的编号（重新生成 / 召唤就是新的一次） */
  private gen(a: Actor): number { let id=this.actorIds.get(a); if(!id){id=++this.actorSerial;this.actorIds.set(a,id);} return id; }
  private planId(a: Actor): string {
    if (!a.plan) return `actor-${this.gen(a)}-state-${a.epoch}`;
    let id=this.ids.get(a.plan); if (!id) { id=`plan-${++this.serial}`; this.ids.set(a.plan,id); } return id;
  }
  /** 还算数的想做：同一次出场、WANT_SEC 秒内；过期的顺手删掉 */
  private freshWant(id: string) {
    const w=this.wants.get(id), a=this.present(id);
    if (w && a && this.gen(a)===w.gen && this.sim.now-w.at<=WANT_SEC) return w;
    this.wants.delete(id); return null;
  }
  private binding(a: Actor): Binding { return {id:a.id,epoch:a.epoch,plan:this.planId(a),action:a.plan?.behavior??a.action,phase:a.phase}; }
  private present(id: string): Actor | undefined { const a=this.sim.chars.get(id)?.actor; return a && !this.sim.isAbsent(id) ? a : undefined; }
  private nameOf(id: string): string { return id==='user'?'用户':id==='self'?'自己':this.sim.chars.get(id)?.pack.manifest.name??id; }
  private valid(t: SpeechTicket, started = false): boolean {
    // 运动事实过期会阻止开口；已经开口后，普通走路启停 / 转向不掐断一句话。
    if(!started && this.speechCurrent.get(t)?.()===false)return false;
    const a=this.present(t.speaker);
    if (!a || a.state==='dragged' || a.state==='fall') return false;
    // 对事件的台词只要还是同一次出场；跟动作的台词要还在同一个计划、同一个阶段
    if (t.gen!==undefined ? this.gen(a)!==t.gen : this.planId(a)!==t.binding.plan || (a.phase??'say')!==(t.binding.phase??'say')) return false;
    // 说给某个角色的话：她得还在桌面上（对已经走开的角色说话是违和感清单的一条）
    if (t.binding.to && !this.present(t.binding.to)) return false;
    return true;
  }

  private endSpeech(reason: string, now = this.sim.now): void {
    const s=this.active;if(!s)return;this.active=null;
    const elapsed=Math.max(0,now-s.start);
    this.log({type:'llm-speech',what:'end',id:s.ticket.speaker,token:s.token,kind:s.ticket.kind,reason,
      elapsedSec:+elapsed.toFixed(3),durationSec:+s.duration.toFixed(3),readComplete:elapsed>=s.duration});
  }
  /** 队列仍严格绑定生成时的事实；开口后仅在真正中断或场景阶段失效时撤掉气泡。 */
  private speechStopReason(now: number, events: {id:string;e:SimEvent}[]): string | null {
    const s=this.active!;const t=s.ticket,a=this.present(t.speaker);
    if(a!==s.actor)return 'speaker-unavailable';
    if(t.binding.to && this.present(t.binding.to)!==s.recipient)return 'recipient-unavailable';
    if(a.state==='dragged'||a.state==='fall'||events.some(({id,e})=>id===a.id&&e.type==='state'&&(e.to==='dragged'||e.to==='fall')))return 'physical-interruption';
    if(t.gen===undefined && !s.completedPlan) {
      const end=events.find(({id,e})=>id===a.id&&e.type==='plan-end'&&e.behavior===t.binding.action);
      if(end?.e.type==='plan-end') {
        if(end.e.outcome==='aborted')return 'plan-aborted';
        if(this.planId(a)!==t.binding.plan)s.completedPlan=true;
      }
    }
    if(s.completedPlan ? a.phase!==null : !this.valid(t,true))return 'binding-changed';
    return now>s.start+s.duration+1?'complete':null;
  }

  step(now: number, events: {id:string;e:SimEvent}[]): void {
    this.images.prune();
    if (!this.available()) return;
    for(const {id,e} of events) {
      const safe=executionEvent(e,now);
      if(safe)this.recentEvents.set(id,[...(this.recentEvents.get(id)??[]),safe].slice(-8));
    }
    for (const id of this.wanted) { this.wanted.delete(id); void this.decide(id); }
    for (const {id,e} of events) {
      const c=this.sim.chars.get(id), a=c?.actor;
      if (!c || !a) continue;
      // 点 / 摸都算（动作在冷却、没配反应的也算，她照样被碰了）；点到躲着的她另有一条 discovered，这里不重复记
      if (e.type==='poke' && e.reaction!=='discovered') {
        const part=e.part?PART_NAMES[e.part]??e.part:null;
        this.push(id,{what:`用户${e.kind==='stroke'?'在摸':'点了'}你${part?`的${part}`:''}`});
      }
      else if (e.type==='discovered') this.push(id,{what:e.by==='return'?`用户回来了，撞见你${e.naked?'光着身子':'正在做的事'}`:e.by==='click'?'你躲着的时候被用户点到了':'你躲在窗口后面，窗口被挪开，被用户发现了'});
      else if (e.type==='state' && e.to==='dragged') {const a=this.present(id);if(a)this.thrown.set(id,this.gen(a));}
      else if (e.type==='landed') {const a=this.present(id),gen=this.thrown.get(id);this.thrown.delete(id);if(a&&gen===this.gen(a))this.push(id,{what:'你被用户拎起来、又扔了下来'});}
      else if (e.type==='duo' && e.what==='play' && typeof e.partner==='string') {
        // 双人：邀请方先写，对方看着她这一段再写自己的；两人各用自己的会话
        const partner=e.partner, scene=String(e.scene??''), other=this.present(partner), plan=a.plan, otherPlan=other?.plan;
        const duo=this.sim.duos.find(d=>d.stage==='play'&&d.inviter===id&&d.partner===partner);
        if (!duo || !other || !plan || !otherPlan) continue;
        const valid=()=>this.sim.duos.includes(duo)&&this.present(id)===a&&this.present(partner)===other&&a.plan===plan&&other.plan===otherPlan;
        this.box(id).job={kind:'duo',valid,plan,what:`你和${this.nameOf(partner)}开始做：${scene}（你主动邀请的）`,partner,
          then:kept=>{if(valid())this.box(partner).job={kind:'duo',valid,plan:otherPlan,what:`你和${this.nameOf(id)}开始做：${scene}（她邀请你的）`,partner:id,partnerScript:kept??undefined};}};
      }
      else if (e.type==='plan' && a.plan && !this.requested.has(a.plan) && !/^(duo|reaction|system):/.test(a.plan.behavior)) {
        // 没人触发的主动台词：很少说（proactive 的间隔），互动触发的为主
        const adult=!!c.brain.cfg.behaviors.find(b=>b.id===a.plan!.behavior)?.r18;
        const gap=adult?this.config.proactive.adultIntervalSec:this.config.proactive.intervalSec;
        if (now-(this.lastProactive.get(id)??-Infinity)>=gap && now-this.lastProactiveAny>=this.config.proactive.globalGapSec) {
          this.requested.add(a.plan); this.lastProactive.set(id,now); this.lastProactiveAny=now;
          this.box(id).job={kind:'line',what:`你开始做：${a.plan.behavior}`,plan:a.plan};
        }
      }
    }
    this.dispatch(now);
    this.waiting=this.waiting.filter(w=>{
      if(this.speechCurrent.get(w.ticket)?.()===false)return false;
      const speaker=this.sim.chars.get(w.ticket.speaker)?.actor;
      if (w.actors.some(a=>this.sim.chars.get(a.id)?.actor!==a) || !speaker || w.ticket.gen===undefined&&this.planId(speaker)!==w.ticket.binding.plan || now>w.ticket.expiresAt&&w.ticket.gen!==undefined) return false;
      if (this.valid(w.ticket)) { w.ticket.expiresAt=w.ticket.gen!==undefined?Math.min(w.ticket.expiresAt,now+8):now+8; this.speech.enqueue(w.ticket); return false; } return true;
    });
    if (this.active) {const reason=this.speechStopReason(now,events);if(reason)this.endSpeech(reason,now);}
    if (!this.active) {
      const t=this.speech.next(now,t=>this.valid(t));
      if (t) {
        const voice=this.voiceOf(t.speaker), units=textToUnits(t.text,voice);
        this.active={token:++this.speechSerial,ticket:t,units,voice,start:now,duration:units.reduce((n,u)=>Math.max(n,u.at+u.duration),0),
          actor:this.present(t.speaker)!,recipient:t.binding.to?this.present(t.binding.to):undefined,completedPlan:false};
        this.log({type:'llm-speech',what:'start',id:t.speaker,token:this.active.token,kind:t.kind,plan:t.binding.plan,phase:t.binding.phase,
          chars:Array.from(t.text).length,durationSec:+this.active.duration.toFixed(3)});
        this.spoken(t);
      }
    }
  }

  /** 说出口了：在场的其他角色都听到；说给某个角色的，她回一句（一来一回最多 talk.maxExchanges 句） */
  private spoken(t: SpeechTicket) {
    const line: HeardLine={from:t.speaker,fromName:this.nameOf(t.speaker),to:t.to??'user',toName:this.nameOf(t.to??'user'),text:t.text};
    for (const id of this.sim.chars.keys()) if (id!==t.speaker && this.present(id)) this.heard.set(id,[...(this.heard.get(id)??[]),line].slice(-8));
    const to=t.binding.to, depth=t.thread?.depth??1;
    if (t.kind!=='duo' && to && to!==t.speaker && this.present(to) && depth<this.config.talk.maxExchanges)
      this.push(to,{what:`${line.fromName}对你说：「${t.text}」`,thread:{id:t.thread?.id??++this.threadSerial,depth:depth+1}});
  }
  private box(id: string): Inbox {
    const actor=this.present(id);let b=this.inbox.get(id);
    if(!b || b.actor!==actor){b={actor,events:[],first:0,last:0,dropped:0,job:null};this.inbox.set(id,b);}return b;
  }
  /** 事件触发进收件箱：攒着等防抖，最多 maxTriggers 件，再多丢最早的（只记个数） */
  private push(id: string, ev: PendingTrigger) {
    const b=this.box(id), now=this.sim.now;
    if (!b.events.length) b.first=now;
    b.last=now; b.events.push(ev);
    while (b.events.length>this.config.debounce.maxTriggers) { b.events.shift(); b.dropped++; }
  }
  /** 每个 tick：没有请求在途的角色，攒够了的事件合成一次发；没有要发的事件就发跟计划走的那一件（计划还是那个才发） */
  private dispatch(now: number) {
    const d=this.config.debounce;
    for (const [id,b] of this.inbox) {
      if (!b.actor || b.actor!==this.present(id)) {this.inbox.delete(id);continue;}
      if (this.busy.has(id)) continue;
      if (b.events.length && (now-b.last>=d.quietSec || now-b.first>=d.maxWaitSec) && now-(this.lastEventTurn.get(id)??-Infinity)>=this.config.reactionIntervalSec) {
        const m=mergeTriggers(b.events,b.dropped); b.events=[]; b.dropped=0; this.lastEventTurn.set(id,now);
        this.run(id,{kind:m.thread?'talk':'reaction',what:m.what,...(m.thread?{thread:m.thread}:{})});
      } else if (b.job) {
        const job=b.job; b.job=null;
        if ((!job.plan || b.actor.plan===job.plan) && (!job.valid || job.valid())) this.run(id,job);
      }
    }
  }
  /** 同一个角色一次一个请求：在途时收件箱照样收，回来以后下一个 tick 再发 */
  private run(id: string, job: Trigger) {
    this.busy.add(id);
    void this.turn(id,job).then(kept=>{if(kept!==null)job.then?.(kept);},e=>this.log({type:'llm-turn-error',id,error:String(e)})).finally(()=>this.busy.delete(id));
  }

  private async tracked<T extends {usage:Usage|null}>(id:string,kind:RequestKind,provider:string,signal:AbortSignal,run:(signal:AbortSignal,send:Fetcher)=>Promise<T>, current?:()=>boolean, priority?:number): Promise<T> {
    const p=this.config.providers[provider]; if (!p || !this.hasKey(provider)) throw new LlmFailure('invalid');
    return this.queue.enqueue({account:p.account,key:`${id}:${kind}`,priority:priority??({vision:1,reply:5,reaction:4,talk:4,duo:3,decision:2,line:1,'adult-line':1,memory:0})[kind],signal,
      run:s=>this.calls.run({character:id,kind,provider,model:p.model,signal:s,current},run)});
  }
  private async decide(id:string) {
    const a=this.sim.chars.get(id)?.actor; if (!a || a.plan || a.state!=='idle') return;
    this.lastDecision.set(id,this.sim.now);
    const epoch=a.epoch, mode=this.mode(), memoryVersion=this.memoryVersion(id,mode), candidates=this.sim.llmCandidates(id), want=this.freshWant(id); this.wants.delete(id);
    const snapshot=this.sim.llmSnapshot(id);
    this.log({type:'llm-decision-options',id,epoch,stats:snapshot?.self.stats,behaviors:snapshot?.behaviors,candidates:candidates.map(c=>({behavior:c.behavior,target:c.target,scene:c.scene}))});
    if (!candidates.length) { if(!this.sim.hasLlmControl(id))this.sim.applyLlmIntent(id,epoch,null,a); return; }
    const controller=new AbortController(); this.pending.set(id,controller); this.lastDecision.set(id,this.sim.now);
    const provider=this.config.decision,p=this.config.providers[provider]; let picked: string[]=[],explicitRule=false;
    try {
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(p.timeoutMs)]);
      const state=this.decisionState(id,want);
      const current=()=>this.available()&&mode===this.mode()&&memoryVersion===this.memoryVersion(id,mode)&&this.present(id)===a&&a.epoch===epoch&&!a.plan&&a.state==='idle'&&
        this.sim.llmCandidates(id).length>0;
      const ask=(planned: string[])=>this.tracked(id,'decision',provider,signal,async(s,send)=>{
        const r=await new ClefProvider(p,this.keys.get(provider)??'',send).ask(state,decisionQuestions(candidates,planned.map(key=>candidates.find(c=>c.id===key)!)),s);
        if (!this.available() || mode!==this.mode() || memoryVersion!==this.memoryVersion(id,mode) || this.sim.chars.get(id)?.actor!==a || a.epoch!==epoch || a.plan || a.state!=='idle') throw new LlmFailure('stale',r.usage);
        const match=/^c(\d+)$/.exec(r.answers.intent.choice??'');
        if (match && !this.sim.llmCandidates(id).some(c=>c.id===candidates[Number(match[1])]?.id)) throw new LlmFailure('stale',r.usage);
        return r;
      },current);
      let result=await ask([]);explicitRule=result.answers.intent.choice==='rule';const size=Math.min(requestedPlanSize(result.answers), candidates.length);
      for(let index=0;index<size;index++){
        const next=selectedGoals(result.answers,candidates,this.config.minChoiceProbability)[0];
        if(!next || picked.includes(next))break;
        picked.push(next);
        if(candidates.find(c=>c.id===next)?.scene || picked.length>=size)break;
        result=await ask(picked);
      }
    } catch(e) { this.log({type:'llm-fallback',id,result:failureOf(e)}); }
    finally {
      if (want) this.log({type:'llm-want-decided',id,want:want.text,picked:picked.length?candidates.find(c=>c.id===picked[0])?.behavior:
        !explicitRule&&this.sim.hasLlmControl(id)?'hold':'rule'});
      if (picked.length>1) this.log({type:'llm-plan',id,goals:picked.map(key=>candidates.find(c=>c.id===key)?.behavior)});
      if (this.pending.get(id)===controller) this.pending.delete(id);
      if (!this.closed && !controller.signal.aborted && this.available() && (picked.length||explicitRule||!this.sim.hasLlmControl(id))) {
        const applied=this.sim.applyLlmPlan(id,epoch,picked,a);
        this.log({type:'llm-decision-result',id,applied,selected:picked.map(key=>candidates.find(c=>c.id===key)?.behavior),
          actual:applied?this.sim.chars.get(id)?.actor?.plan?.behavior??null:null,behaviors:this.sim.llmSnapshot(id)?.behaviors.filter(b=>picked.some(key=>candidates.find(c=>c.id===key)?.behavior===b.id))});
        if (!applied) this.log({type:'llm-stale',id,kind:'decision'});
      }
    }
  }
  /** Clef 的输入：人设、记忆摘要、最近几轮经历（和台词共用一段会话）、她刚才心里想做的（want），再加状态快照。Clef 输入不打缓存折扣，短一点 */
  private decisionState(id: string, want?: {text: string; at: number} | null): string {
    const win=this.memory.window(id,this.mode()), n=this.turnsOf(id).decisionTurns, recent=n?boundedHistory(win.turns,n,this.config.context.maxChars):[];
    return decisionMessage({shared:this.shared(),persona:this.persona(id),capabilities:this.capabilityContext(id),summary:win.summary,recent,
      want:want?{text:want.text,ageSec:this.sim.now-want.at}:null,snapshot:this.sim.llmSnapshot(id)??{},events:this.recentEvents.get(id)??[]});
  }
  private capabilityContext(id: string): string {
    const stats = this.sim.chars.get(id)?.brain.cfg.stats ?? {};
    return capabilitiesText(this.sim.llmCapabilities(id),stats);
  }
  private prompts(): Record<string,any> { try { return readJson(path.join(this.root,'config','prompts.local.json')); } catch { return {}; } }
  /** 公共前缀：所有角色共用（用户在面板里写，存 prompts.local.json 的 _shared） */
  private shared(): string { const v=this.prompts()._shared?.[this.sim.opts.r18?'adult':'sfw']; return typeof v==='string'?v.slice(0,12000):''; }
  private persona(id:string) {
    const file=path.join(this.root,this.sim.chars.get(id)?.pack.relDir??path.join('packs',id),this.sim.opts.r18?'persona.md':'persona-sfw.md');
    let base='你是一位成年的桌面伙伴。说话简短、自然、友善。';
    try { base=fs.readFileSync(file,'utf8').slice(0,12000); } catch { /* optional per-pack persona */ }
    const value=this.prompts()[id]?.[this.sim.opts.r18?'adult':'sfw']; if(typeof value==='string') base=value.slice(0,12000);
    return base;
  }

  /** 她这一轮：用她自己的会话请求、校验、排进说话队列、记进会话；返回留下的台词（双人时给对方看） */
  private async turn(id: string, t: Trigger): Promise<{phase:string;to:string;text:string}[] | null> {
    if (!this.available() || this.sim.userIdleSec>=1800) return null;
    if (t.valid && !t.valid()) return null;
    const c=this.sim.chars.get(id), a=this.present(id), other=t.partner?this.present(t.partner):undefined;
    if (!c || !a || a.state==='dragged' || a.state==='fall' || t.partner&&!other) return null;
    const kind: TextKind=t.kind==='line' && a.plan && c.brain.cfg.behaviors.find(b=>b.id===a.plan!.behavior)?.r18?'adult-line':t.kind;
    const provider=this.textProvider(id,kind), p=this.config.providers[provider];
    if (!p || !this.hasKey(provider) || !this.allowed(kind)) return null;
    // v 和计划实例在发请求这一刻记下来（回复回来时角色多半已经换了状态，不能那时再读）
    const visionRevision=this.visionRevision, characterVisionRevision=this.characterVisionRevisions.get(id)??0, contextRevision=this.contextRevision;
    if (t.frame && (p.images!==true || !t.frame.valid() || Date.now()-t.frame.capturedAt>30000))return null;
    const mode=this.mode(), binding=this.binding(a), v=a.epoch, gen=this.gen(a), event=EVENT_KINDS.has(kind), actors=other?[a,other]:[a];
    const movement=movementStamp(a),movingPlan=a.state==='walk'||a.state==='jump'?a.plan:null;
    const motionCurrent=()=>!event||movementStamp(a)===movement&&(!movingPlan||a.plan===movingPlan);
    const duo=t.kind==='duo'?this.sim.duos.find(d=>[d.inviter,d.partner].includes(id)&&[d.inviter,d.partner].includes(t.partner!)):undefined;
    const phases=event?['say']:duo?[...new Set(duo.scene.manifest.segments.map(s=>s.phase))]:phasesOf(a); if(!phases.length) phases.push('say');
    const heard=this.heard.get(id)??[]; this.heard.delete(id);
    const facts: TurnFacts={at:Date.now(),what:t.frame?`${t.what}（${t.frame.source}，捕获于 ${new Date(t.frame.capturedAt).toISOString()}，非持续实时画面）`:t.what,behavior:a.plan?.behavior??a.action,phases,heard,execution:this.recentEvents.get(id)??[],
      partnerScript:t.partnerScript&&t.partner?{name:this.nameOf(t.partner),lines:t.partnerScript}:undefined};
    const present=[...this.sim.chars.keys()].filter(o=>o!==id&&this.present(o)), win=this.memory.window(id,mode);
    const snap=this.sim.llmSnapshot(id), memoryVersion=this.memoryVersion(id,mode);
    const history=boundedHistory(win.turns,this.turnsOf(id).maxTurns,this.config.context.maxChars);
    let messages=buildMessages({shared:this.shared(),persona:this.persona(id),summary:win.summary,history,capabilities:this.capabilityContext(id),
      current:currentMessage({...facts,speaker:id,v,plan:binding.plan,state:{...snap},steps:stepsOf(a,this.sim.now),
        present:present.map(o=>`${o}（${this.nameOf(o)}）`)})});
    if(t.frame){const last=messages[messages.length-1];last.content=withImage(String(last.content)+'\n'+VISION_INSTRUCTIONS,t.frame);}
    const controller=new AbortController(), key=`text:${id}`; this.pending.set(key,controller);   // 同一角色一次一个（dispatch），不取消在途的
    const requested=this.sim.now; let usage:Usage|null=null;
    try {
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(p.timeoutMs)]);
      let attachmentsValid=()=>true;
      const stale=()=>!this.available() || contextRevision!==this.contextRevision || memoryVersion!==this.memoryVersion(id,mode) || mode!==this.mode() || this.textProvider(id,kind)!==provider || !this.present(id) ||
        !attachmentsValid() || !motionCurrent() ||
        !!t.valid&&!t.valid() || event&&this.sim.now-requested>(t.frame?60:EVENT_LINE_SEC) ||
        !!t.frame && (visionRevision!==this.visionRevision || characterVisionRevision!==(this.characterVisionRevisions.get(id)??0) || !this.config.vision.enabled || Date.now()-t.frame.capturedAt>60000 || !t.frame.valid()) || actors.some(x=>this.sim.chars.get(x.id)?.actor!==x) || !event&&this.planId(a)!==binding.plan;
      // Parse inside the tracked callback so malformed/refused output is charged and classified accurately.
      const audience=['user','self',...present], last: {broken: {code: string; message: string; text: string} | null}={broken:null};
      const ask=(msgs: ChatMessage[])=>this.tracked(id,kind,provider,signal,async(s,send)=>{
        last.broken=null;
        if(stale() || t.frame && Date.now()-t.frame.capturedAt>30000)throw new LlmFailure('stale');
        const prepared=p.images===true?this.images.prepare(msgs,id,mode,history.map(t=>t.seq)):{messages:msgs,valid:()=>true};
        attachmentsValid=prepared.valid;
        const actual=prepared.messages;
        const r=await new ChatCompletions(p,this.keys.get(provider)??'',send).chat({messages:actual,maxTokens:this.config.maxTokens[kind]},s);
        usage=r.usage;
        try {
          if (stale()) throw new LlmFailure('stale',r.usage);
          let observation='';
          if(t.frame){let raw:unknown;try{const json=extractJson(r.text);if(!json.wellFormed)throw new Error();raw=JSON.parse(json.text);}catch{throw new DialogueError('bad-json','观察回复不是 JSON');}
            const value=(raw as {observation?:unknown})?.observation;
            if(typeof value!=='string' || !value.trim() || Array.from(value).length>300)throw new DialogueError('invalid','observation 需要非空且不超过 300 字');
            observation=value.trim();this.visionStatus.set(provider,'verified');}
          return {...r,observation,dialogue:parseDialogue(r.text,{v,plan:binding.plan,speakers:[id],phases,defaultSpeaker:id,audience,optionalPhases:true})};
        }
        catch(e) {
          if (e instanceof DialogueError && (e.code==='bad-json' || e.code==='invalid')) last.broken={code:e.code,message:e.message,text:r.text};
          throw new LlmFailure(failureOf(e),r.usage);
        }
      },()=>!stale()&&(!t.frame||Date.now()-t.frame.capturedAt<=30000),kind==='vision'&&t.manual?5:undefined);
      // 模型回的台词结构坏了 / 字段不合法（2026-10-23 用户）：坏回复只记事件日志（不进会话、记忆、去重），带上错在哪重问一次；
      // 再坏就不问了。过期、拒答、超时、接口本身的错不重问；对事件的台词剩下的时间不到一半也不问（反正赶不上）
      const logBroken=(retry: boolean)=>{ const b=last.broken!; this.log({type:'llm-broken',id,kind,code:b.code,error:b.message,reply:b.text.slice(0,2000),retry}); };
      let result: Awaited<ReturnType<typeof ask>>;
      try { result=await ask(messages); }
      catch(e) {
        if (!last.broken) throw e;
        const retry=!stale() && !(event && this.sim.now-requested>EVENT_LINE_SEC/2);
        logBroken(retry); if (!retry) throw e;
        try { result=await ask([...messages,{role:'user',content:repairRequest(last.broken.message,phases,audience,!!t.frame)}]); }
        catch(e2) { if (last.broken) logBroken(false); throw e2; }
      }
      if (stale()) throw new LlmFailure('stale',usage);
      // 想做：记下来给她下一次决策用（不显示；会话里随这一轮回复一起记，见下面 replyRecord）
      const all=[...this.sim.chars.values()]; const absentNames=all.filter(x=>!x.actor||this.sim.isAbsent(x.pack.manifest.id)).flatMap(x=>[x.pack.manifest.name,...x.pack.manifest.aliases]);
      const cleaned: {phase:string;to:string;text:string;aside:string[]}[]=[], recent=this.said.map(s=>s.text);
      for(const line of result.dialogue.lines) {
        const clean=cleanLine(line.text,{banned:c.brain.cfg.dialogueBanned ?? [],absentNames,recent}); if(!clean) continue;
        cleaned.push({phase:line.phase,to:line.to??'user',...clean});recent.push(clean.text);
      }
      const limited=limitDialogueLines(cleaned,{reply:!!t.thread,scripted:kind==='duo',recipients:present});
      const kept=limited.map(({phase,to,text})=>({phase,to,text}));
      const tickets:SpeechTicket[]=limited.map(line=>{
        const {to}=line, b={...binding,phase:line.phase==='say'?null:line.phase,...(this.sim.chars.has(to)?{to}:{})};
        const ticket:SpeechTicket={speaker:id,kind,text:line.text,aside:line.aside,binding:b,expiresAt:event?requested+(t.frame?60:EVENT_LINE_SEC):this.sim.now+8,priority:event?4:kind==='duo'?3:1,to,
          ...(t.thread?{thread:t.thread}:{}),...(event?{gen}:{})};
        if(event)this.speechCurrent.set(ticket,motionCurrent);
        return ticket;
      });
      const saved=this.memory.append(id,mode,{at:facts.at,kind,user:turnRecord(facts)+(t.frame?`\n观察记录（模型描述）：${result.observation}`:''),reply:replyRecord(v,binding.plan,kept,result.dialogue.want??'')});
      this.waiting=[...this.waiting,...tickets.map(ticket=>({ticket,actors}))].slice(-128);
      this.said=[...this.said,...tickets.map(t=>({speaker:id,text:t.text}))].slice(-40);
      if (result.dialogue.want) {this.wants.set(id,{text:result.dialogue.want,at:this.sim.now,gen});this.log({type:'llm-want',id,kind,want:result.dialogue.want});}
      else this.wants.delete(id);
      if(t.frame){this.images.add(id,mode,saved.seq,t.frame);this.log({type:'vision-observed',id,source:t.frame.source,capturedAt:t.frame.capturedAt,width:t.frame.width,height:t.frame.height,manual:!!t.manual});}
      void this.compact(id,mode);
      return kept;
    } catch(e) {
      if(!this.closed && contextRevision===this.contextRevision && mode===this.mode() && memoryVersion===this.memoryVersion(id,mode) && this.sim.chars.get(id)?.actor===a)
        this.heard.set(id,[...heard,...(this.heard.get(id)??[])].slice(-8));
      if(t.frame && failureOf(e)==='http')this.visionStatus.set(provider,'failed');
      this.log({type:'llm-line-drop',id,kind,result:failureOf(e)}); return null;
    }
    finally { if(this.pending.get(key)===controller) this.pending.delete(key); }
  }

  /** 会话超过上限：用独立摘要提示整理最早批次和旧摘要；一直失败、到了 maxTurns + dropTurns 轮就直接归档。 */
  private async compact(id: string, mode: MemoryMode) {
    const cx=this.config.context, key=`${id}:${mode}`;
    if (this.compacting.has(key) || !this.available()) return;
    const {maxTurns,dropTurns}=this.turnsOf(id);
    this.compacting.add(key);
    let upTo=0,activeCount=0;const memoryVersion=this.memoryVersion(id,mode);
    try {
      const pending=this.memory.pending(id,mode,{maxTurns,keepTurns:maxTurns-dropTurns,maxChars:cx.maxChars});if(!pending)return;
      const drop=pending.slice(0,dropTurns);
      const provider=this.textProvider(id,'line'),p=this.config.providers[provider];if(!p || !this.hasKey(provider))return;
      const win=this.memory.window(id,mode);upTo=pending[pending.length-1].seq;activeCount=win.turns.length;
      if (this.sim.now<(this.compactRetryAt.get(key)??-Infinity)) {
        if (activeCount>=maxTurns+dropTurns)this.memory.archive(id,mode,upTo);
        return;
      }
      const history=boundedHistory(drop,maxTurns,cx.maxChars,true);
      if (!history.length) {this.memory.archive(id,mode,drop[0].seq);this.log({type:'llm-memory-oversized',id,mode});return;}
      const messages=buildSummaryMessages({shared:this.shared(),persona:this.persona(id),summary:win.summary,history,
        current:summaryRequest(history.length,history[0].at,history[history.length-1].at,cx.summaryChars)});
      const signal=AbortSignal.any([AbortSignal.timeout(Math.max(p.timeoutMs,30000))]);
      const current=()=>!this.closed&&mode===this.mode()&&memoryVersion===this.memoryVersion(id,mode);
      const text=await this.tracked(id,'memory',provider,signal,async(s,send)=>{
        const r=await new ChatCompletions(p,this.keys.get(provider)??'',send).chat({messages,maxTokens:this.config.maxTokens.memory},s);
        let memory: unknown;
        try { const json=extractJson(r.text);if(!json.wellFormed)throw new Error();memory=JSON.parse(json.text).memory; } catch { throw new LlmFailure('bad-json',r.usage); }
        if (typeof memory!=='string' || !memory.trim() || mode!==this.mode() || this.closed || memoryVersion!==this.memoryVersion(id,mode)) throw new LlmFailure(typeof memory==='string'?'stale':'invalid',r.usage);
        return {usage:r.usage,memory:Array.from(memory.trim()).slice(0,cx.summaryChars).join('')};
      },current);
      this.memory.compact(id,mode,history[history.length-1].seq,text.memory,Date.now());
      this.compactRetryAt.delete(key);this.log({type:'llm-memory',id,mode,folded:history.length});
    } catch(e) {
      this.log({type:'llm-memory-fail',id,mode,result:failureOf(e)});
      if(!this.closed&&memoryVersion===this.memoryVersion(id,mode))this.compactRetryAt.set(key,this.sim.now+MEMORY_RETRY_SEC);
      if (!this.closed && memoryVersion===this.memoryVersion(id,mode) && activeCount>=maxTurns+dropTurns) {
        try {this.memory.archive(id,mode,upTo);}catch{this.log({type:'llm-memory-archive-fail',id,mode});}
      }
    } finally { this.compacting.delete(key); }
  }
}
