// Phase 3 shared contracts. No credentials or renderer dependencies belong here.
// talk = 别的角色对她说了话、她回一句（2026-10-23）；memory = 把旧对话折叠成记忆摘要
export type RequestKind = 'decision' | 'line' | 'adult-line' | 'reaction' | 'duo' | 'talk' | 'reply' | 'memory' | 'vision';
export type TextKind = Exclude<RequestKind, 'decision' | 'memory'>;
export interface Usage { prompt: number; cached: number | null; completion: number; reasoning: number | null }
export type Failure = 'timeout' | 'aborted' | 'http' | 'network' | 'refusal' | 'bad-json' | 'invalid' | 'stale' | 'empty-thinking' | 'superseded' | 'budget';
export interface Price { input: number; cached: number; output: number }
export interface CallRecord {
  at: number; character: string; kind: RequestKind; provider: string; model: string;
  usage: Usage | null; costUsd: number | null; latencyMs: number; result: 'ok' | Failure;
}
export interface ProviderConfig {
  /** Explicit capability declaration for this exact provider/model; never infer from model names. */
  images?: boolean;
  baseUrl: string; model: string; account: string; keyEnv: string; secretName: string;
  concurrency: number; jsonMode: 'json_object' | 'json_schema' | 'none';
  cachedTokensField: string | null; timeoutMs: number;
}
export interface Intent { id: string; behavior: string; target?: string; scene?: string; weight: number; adult: boolean; description?:string }
export interface Binding { id: string; epoch: number; plan: string; action: string; phase: string | null; to?: string }
export interface DialogueLine { speaker: string; phase: string; text: string; to?: string }
/** want：她心里真实想接下来做的事（一句话，空 = 暂时没有；不显示，只进她自己的会话，给 Clef 选下一个动作时参考，2026-10-23） */
export interface Dialogue { v: number; plan: string; lines: DialogueLine[]; want?: string }
export interface SpeechUnit { text: string; at: number; duration: number; pitch: number; formants: [number, number, number] | null; tone?: number }
export interface SpeechVoice { pitch: number; speed: number; formantScale: number; breath: number }
/** to：'user' / 'self' / 在场角色 id（binding.to 只在说给角色时才有，出队时查她还在不在）；thread：角色之间你一句我一句的第几句；
 *  gen：对事件的台词（被点、被发现、回话）绑定的是“这个角色这一次出场”，不绑计划和阶段（反应动作往往只有一两秒，比请求还短） */
export interface SpeechTicket { speaker: string; text: string; aside: string[]; binding: Binding; expiresAt: number; priority: number; to?: string; thread?: {id: number; depth: number}; gen?: number; kind?: TextKind }
