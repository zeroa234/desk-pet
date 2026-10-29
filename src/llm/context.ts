// 文本模型的上下文拼装（阶段 3 续，2026-10-23）：每个角色一段自己的多轮会话，按“越稳定越靠前”排，前缀缓存才命中得了。
//
//   system   1 公共前缀（用户自己写的，所有角色共用；成人 / 全年龄各一份）
//            2 台词规则（本文件的 RULES，固定）              ← 1+2 所有角色逐字节相同：同一个模型时跨角色也能命中
//            3 人设（每个角色一份）
//            4 记忆摘要（较早经历；只在折叠旧对话时变）      ← 1–4 同一角色逐字节相同
//   history  5 最近若干轮：user = 那一轮发生了什么（简短记录），assistant = 她那一轮说的 JSON   ← 只往后追加，上一次请求整段都是前缀
//   user     6 这一次：时间、发生了什么、锁定的动作和阶段、接下来几步、期间听到的、在场的人、状态快照、v / plan   ← 每次都变，放最后
//
// 历史里存的是第 6 段的“简短记录”（不带状态快照），所以上一次请求只有最后一条 user 消息不在下一次的前缀里。
// 折叠旧对话（MemoryStore.pending → compact）一次丢一大批，丢的那一次前缀从第 4 段起变一次，之后又稳定。
// 纯函数：不读文件、不碰网络和 Sim。
import {createHash} from 'node:crypto';
import type {MemoryTurn} from './memory.ts';
import type {ImageContent} from './attachments.ts';
import {STATE_RULES} from './state.ts';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | ImageContent[] }

/** The exact same pure assembler is used by the runtime and the synthetic live probe. */
export function decisionMessage(p: {shared:string;persona:string;capabilities:string;summary:string;recent:Pick<MemoryTurn,'user'|'reply'>[];
  want?:{text:string;ageSec:number}|null;snapshot:object;events:object[]}): string {
  const spoken=(reply:string)=>{try{const r=JSON.parse(reply),said=(r.lines as {text:string}[]).map(l=>`「${l.text}」`).join('');
    return `她拟的台词（不证明已说出口或已执行）：${said||'（没有）'}${typeof r.want==='string'&&r.want?`；心里想：${r.want}`:''}`;}catch{return '她拟的台词：（没有）';}};
  return [p.shared,STATE_RULES,`persona: ${p.persona}`,p.capabilities,p.summary?`memory: ${p.summary}`:'',
    p.recent.length?`recent:\n${p.recent.map(t=>`${t.user}\n${spoken(t.reply)}`).join('\n')}`:'',
    Object.entries({...p.snapshot,recent_events:p.events}).map(([k,v])=>`${k}: ${JSON.stringify(v)}`).join('\n'),
    p.want?`want: ${Math.round(p.want.ageSec)} 秒前她心里想（没说出口）：${p.want.text}`:'want: 当前没有新的行动意愿；历史 want 不自动延续。'].filter(Boolean).join('\n');
}

export const RULES = `【桌宠台词规则】
- 你是成年桌面伙伴，按自己的人设回应。user 是屏幕前的用户；在场角色能互相听见，跨屏或遮挡不等于离场。
- 当前状态与程序执行回执优先于台词、愿望和历史草稿。只描述实际动作与阶段；想做、答应、开始、完成要分清，未锁定的行动不能承诺马上执行。
- lines 只写角色自然说出口的话。不要用计时器、冷却、候选、算法、程序限制、状态数值或剩余秒数解释自己的行动，也不要把行为 id 念出来。当前不能做就自然暂缓或换件事；不要把通用限制编成“你不喜欢她”或虚构身体不适。
- to 只能写 user（用户）、self（自言自语）或在场角色 id。回应刚对你说话的人；听到别人对第三者说话不等于在问你。不得代写对方台词或猜她的私有想法、数值。双人 interaction 的 role 是场景分工，与谁主动邀请分开。
- 每阶段最多两句，每句不超过 40 字；带对话链的回话整轮最多一句，普通一轮最多一句说给其他角色。不要复读或附和抄话；没有新内容可用 lines:[]。括号仅写与实际动作相容的神态、语气，不虚构走动或接触。
- 每轮写 want：第一人称完整短句、60 字以内，心里真实想接下来做的事，可以和嘴上说的不一样；不显示、不让别人知道。没有新的可执行目标就写空字符串 ""，不必每轮找事做。
- want 用自然语言说清行动含义，并附能力目录的行为 id、目标 id（如“我想用 linger 靠近 b，陪她待一会儿”）；不要只填 id 或 id:目标。最多三个不同目标按顺序写。仅选择 available=true 且 decision_selectable 不为 false 的目标；仅被 actor_busy 暂挡的目标可以留待当前行动结束后尝试。其余硬限制下不填该目标，不写“等冷却结束再做”，不替不存在的能力或不在场的对象排计划。preference_met=false 是软偏好，仍可真心想做。
- 保留明确意愿的最终目标；靠近某人用含 approach 的行为（如 linger），wander 是随机闲逛。正在执行或已在 pending_goals 里的目标不要再当新 want 提交。说出口的希望不等于新行动，want 也不保证执行。
- partner_draft 仅供同阶段衔接，是尚未说出口的对方剧本，不能当听闻或完成记录；对方后段台词不在当前阶段提前回应。
- 只输出 JSON，不输出思考过程：{"v":数字,"plan":"字符串","lines":[{"phase":"阶段","to":"对象","text":"台词"}],"want":"想做的事或空字符串"}。v、plan 照抄，phase 仅用本轮所列阶段。`;

export interface SessionParts {
  /** 公共前缀（用户写的；可以为空） */
  shared: string;
  persona: string;
  /** 记忆摘要（可以为空） */
  summary: string;
  /** Stable per-character material/configuration directory, outside rolling history. */
  capabilities?: string;
  history: MemoryTurn[];
  /** 最后一条 user 消息 */
  current: string | ImageContent[];
}

export function systemPrompt(p: Pick<SessionParts, 'shared' | 'persona' | 'summary' | 'capabilities'>): string {
  return [p.shared.trim(), RULES, STATE_RULES, p.persona.trim(), p.capabilities ?? '', p.summary.trim() ? `【你记得的较早的事】\n${p.summary.trim()}` : '']
    .filter(Boolean).join('\n\n');
}

export function buildMessages(p: SessionParts): ChatMessage[] {
  const out: ChatMessage[] = [{role: 'system', content: systemPrompt(p)}];
  for (const t of p.history) out.push({role: 'user', content: t.user}, {role: 'assistant', content: t.reply || '{"lines":[]}'});
  out.push({role: 'user', content: p.current});
  return out;
}

/** Contiguous complete turns only. Persistence/summary failure must not enlarge subsequent model input. */
export function boundedHistory(turns: MemoryTurn[], maxTurns: number, maxChars: number, oldest = false): MemoryTurn[] {
  const kept: MemoryTurn[] = [];let chars = 0;
  for (const turn of oldest ? turns : [...turns].reverse()) {
    const size = Array.from(turn.user).length + Array.from(turn.reply).length;
    if (kept.length >= maxTurns || chars + size > maxChars) break;
    kept.push(turn);chars += size;
  }
  return oldest ? kept : kept.reverse();
}

/** 除最后一条以外的部分的哈希：同一角色连着两次请求，前一次的这个前缀 + 它的最后一轮记录 = 后一次的前缀（单测用、调试用） */
export function prefixHash(messages: ChatMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages.slice(0, -1))).digest('hex').slice(0, 16);
}

/** 时间写到分钟，历史记录用；当前消息用到秒 */
export function clock(ms: number, seconds = false): string {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${seconds ? ':' + p(d.getSeconds()) : ''}`;
}

export interface HeardLine { from: string; fromName: string; to: string; toName: string; text: string }
const heardText = (h: HeardLine) => `${h.fromName}${h.to === 'user' ? '对用户' : h.to === 'self' ? '自言自语' : `对${h.toName}`}：「${h.text}」`;

export interface TurnFacts {
  at: number;
  /** 发生了什么（一句话，调用方按触发写） */
  what: string;
  /** 正在做的（程序锁定的）行为 id */
  behavior: string;
  phases: string[];
  heard: HeardLine[];
  execution?: object[];
  /** 双人时对方这一段的台词（她先写好了的） */
  partnerScript?: {name: string; lines: {phase:string;to:string;text:string}[]};
}

/** 写进历史的简短记录（第 5 段的 user 消息）：不带状态快照，只留以后还有用的 */
export function turnRecord(f: TurnFacts): string {
  const out = [`[${clock(f.at)}] ${f.what}`, `你在做：${f.behavior}（阶段 ${f.phases.join('、')}）`];
  if (f.heard.length) out.push(`听到：${f.heard.map(heardText).join('；')}`);
  if (f.execution?.length) out.push(`程序执行回执：${JSON.stringify(f.execution)}`);
  return out.join('\n');
}

/**
 * 写进历史的她那一轮回复（第 5 段的 assistant 消息），want 照原样留着：她自己的会话里记得自己心里真实想要什么
 * （2026-10-23 用户：说一套做一套的角色要记得；别的角色只听得到 lines，用户只看得到气泡）。want 传 null 时整个字段不写（探针对照用）。
 */
export function replyRecord(v: number, plan: string, lines: {phase: string; to: string; text: string}[], want: string | null): string {
  return JSON.stringify({v, plan, lines, ...(want !== null ? {want} : {})});
}

export interface StepInfo { phase?: string | null; state: string; action?: string; sec?: number; remainingSec?:number; outfit?: string; outfitAt?: {sec: number; to: string}; behind?: boolean }
/** 当前这一步和接下来几步（程序已锁定的计划），一行：让模型知道每个阶段在做什么、衣着什么时候变。只放最后一条消息，不进历史 */
export function stepsLine(steps: StepInfo[], max = 10): string {
  const one = (s: StepInfo) => [`${s.phase ? s.phase + '：' : ''}${s.action ?? s.state}`, s.remainingSec!==undefined?`当前剩余约${Math.ceil(s.remainingSec)}秒`:s.sec ? `计划时长约${Math.round(s.sec)}秒` : '',
    s.outfit ? `换成${s.outfit}` : '', s.outfitAt ? `${Math.round(s.outfitAt.sec)}秒时换成${s.outfitAt.to}` : '', s.behind ? '躲在窗口后面' : ''].filter(Boolean).join('，');
  return steps.slice(0, max).map(one).join(' → ') + (steps.length > max ? ' → …' : '');
}

/** 这一次的完整消息（第 6 段）：记录 + 接下来几步 + 在场的人 + 状态快照 + 回带用的 v / plan */
export function currentMessage(f: TurnFacts & {speaker: string; v: number; plan: string; present: string[]; state: Record<string, unknown>; steps?: StepInfo[]}): string {
  return [
    turnRecord({...f, at: f.at}).replace(/^\[[^\]]+\]/, `[现在 ${clock(f.at, true)}]`),
    f.steps?.length ? `这一步和接下来（程序已锁定，按顺序）：${stepsLine(f.steps)}` : '',
    f.partnerScript?.lines.length ? `partner_draft（${f.partnerScript.name}尚未说出口的分阶段剧本，仅供对应阶段衔接）：${JSON.stringify(f.partnerScript.lines)}` : '',
    `在场：${['user（用户，屏幕前）', ...f.present].join('；')}`,
    `你的状态：${JSON.stringify(f.state)}`,
    `speaker: ${f.speaker}`,
    `phases: ${JSON.stringify(f.phases)}`,
    `v: ${f.v}`,
    `plan: ${f.plan}`,
  ].filter(Boolean).join('\n');
}

export interface PendingTrigger { what: string; thread?: {id: number; depth: number} }
/**
 * 防抖期间攒下的触发合成一次请求的“发生了什么”：按先后，一样的合成“（N 次）”；超过上限丢掉的最早几件只报个数。
 * 有别的角色对她说话的，带上那条对话里最深的一句（回这一句，一来一回的句数接着数）。
 */
export function mergeTriggers(events: PendingTrigger[], dropped: number): {what: string; thread?: {id: number; depth: number}} {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.what, (counts.get(e.what) ?? 0) + 1);
  const parts = [...counts].map(([w, n]) => n > 1 ? `${w}（${n} 次）` : w);
  const thread = events.filter(e => e.thread).sort((a, b) => b.thread!.depth - a.thread!.depth)[0]?.thread;
  return {what: (dropped ? `（更早还有 ${dropped} 件）` : '') + parts.join('；'), ...(thread ? {thread} : {})};
}

/**
 * 台词回复结构坏了 / 字段不合法时，重问一次接在这一次消息后面的那条：只说错在哪、格式怎么写，不带坏回复
 * （2026-10-23 用户：坏回复只记日志，不进上下文）。
 */
export function repairRequest(reason: string, phases: string[], audience: string[], vision = false): string {
  return `（程序提示：你上一次的回复程序读不了——${reason}。请重写这一轮：只输出一个 JSON 对象，不要别的文字；v 和 plan 照抄上面消息里的；` +
    `lines 里每句的 phase 只能是 ${phases.join(' / ')}，to 只能是 ${audience.join(' / ')}；want 是一句话或空字符串。${vision ? '另须保留 observation：非空且不超过 300 字的截图事实观察。' : ''}）`;
}

/** 折叠旧对话：配合摘要专用 system，把本次待折叠 n 轮连同旧摘要整理成新记忆。 */
export function summaryRequest(n: number, firstAt: number, lastAt: number, maxChars: number): string {
  return `（这条不是对话，是整理记忆。）把上面最早的 ${n} 轮（${clock(firstAt)} 到 ${clock(lastAt)}），连同【你记得的较早的事】，` +
    `整理成你自己的记忆笔记：第一人称，按时间先后，只留以后还用得上的（发生过的事、你对用户和别的角色的感觉和关系、约定、用户的喜好）；` +
    `保留来源：愿望、承诺与台词草稿不是已执行事实，只有程序回执能确认行动完成；中断不能写成到达或成功。听闻只代表对方说过，不替她推断内心。` +
    `不写这次请求本身，不超过 ${maxChars} 字。只输出 JSON：{"memory":"……"}`;
}

/** A memory job has no dialogue/action output. Avoid contradictory dialogue rules and irrelevant live capabilities. */
export function buildSummaryMessages(p: Pick<SessionParts,'shared'|'persona'|'summary'|'history'> & {current:string}): ChatMessage[] {
  return [{role:'system',content:[p.shared.trim(),'你在整理该角色自己的记忆。只输出 {"memory":"记忆笔记"}，不写台词、want 或新计划。历史 assistant 是生成草稿；以程序事实为准，分清愿望、说过、做过。',
    p.persona.trim(),p.summary.trim()?`【你记得的较早的事】\n${p.summary.trim()}`:''].filter(Boolean).join('\n\n')},
    ...p.history.flatMap(t=>[{role:'user' as const,content:t.user},{role:'assistant' as const,content:t.reply}]),{role:'user',content:p.current}];
}
