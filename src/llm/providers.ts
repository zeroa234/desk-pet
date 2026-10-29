import type {Failure, ProviderConfig, Usage} from './types.ts';
import type {ChatMessage} from './context.ts';

export class LlmFailure extends Error {
  code: Failure;
  usage: Usage | null;
  constructor(code: Failure, usage: Usage | null = null) { super(code); this.code = code; this.usage = usage; }
}
/** Queue, parser and transport errors share these public failure codes. */
export const failureOf = (e: unknown): Failure => {
  const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
  return (['timeout','aborted','http','network','refusal','bad-json','invalid','stale','empty-thinking','superseded','budget'].includes(code) ? code : 'invalid') as Failure;
};
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function usageOf(raw: unknown, decision: boolean, cachedPath: string | null): Usage | null {
  if (!object(raw)) return null;
  const prompt = decision ? raw.input_tokens : raw.prompt_tokens, completion = decision ? raw.output_tokens : raw.completion_tokens;
  if (!count(prompt) || !count(completion)) return null;
  const cached = cachedPath?.split('.').reduce<unknown>((v, k) => object(v) ? v[k] : undefined, raw);
  const reasoning = raw.completion_tokens_details?.reasoning_tokens;
  return {prompt, completion, cached: count(cached) && cached <= prompt ? cached : null,
    reasoning: count(reasoning) && reasoning <= completion ? reasoning : null};
}
export type Fetcher = typeof fetch;
/** Shared configuration/transport URL validation: credentials only over HTTPS or local loopback HTTP. */
export function providerUrl(baseUrl: string): URL {
  try {
    if (!/^https?:\/\/[^/\\\s]+(?:\/[^\\\s]*)?$/i.test(baseUrl)) throw new Error();
    const url = new URL(baseUrl);
    if (!url.hostname || url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error();
    return url;
  } catch { throw new LlmFailure('invalid'); }
}
const abortFailure = (signal: AbortSignal) => new LlmFailure(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted');
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, ms);
    const cancel = () => { clearTimeout(timer); reject(abortFailure(signal)); };
    signal.addEventListener('abort', cancel, {once: true});
  });
}
async function post(config: ProviderConfig, endpoint: string, key: string, body: unknown, outer: AbortSignal, fetcher: Fetcher): Promise<unknown> {
  const signal = AbortSignal.any([outer, AbortSignal.timeout(config.timeoutMs)]);
  let url: URL;
  try {
    url = providerUrl(config.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint}`;
  } catch { throw new LlmFailure('invalid'); }
  for (let attempt = 0; ; attempt++) {
    try {
      signal.throwIfAborted();
      const res = await fetcher(url, {method: 'POST', signal, redirect: 'error', headers: {'content-type': 'application/json', ...(key ? {authorization: `Bearer ${key}`} : {})}, body: JSON.stringify(body)});
      if (!res.ok) {
        await res.body?.cancel();
        if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
          const retry = res.headers.get('retry-after');
          const wait = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 3000 * 2 ** attempt;
          await pause(Math.min(30000, Math.max(0, Number.isFinite(wait) ? wait : 3000 * 2 ** attempt)), signal);
          continue;
        }
        throw new LlmFailure('http');
      }
      // A successful body is never retried: the provider may already have charged for it.
      const chunks: Uint8Array[] = []; let size = 0;
      if (!res.body) throw new LlmFailure('bad-json');
      const reader = res.body.getReader();
      try { for (;;) { const {done, value} = await reader.read(); if (done) break; size += value.length;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new LlmFailure('invalid'); } chunks.push(value); } }
      finally { reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new LlmFailure('bad-json'); }
    } catch (e) {
      if (signal.aborted) throw abortFailure(signal);
      if (e instanceof LlmFailure) throw e;
      throw new LlmFailure('network');
    }
  }
}
/** 多轮会话传 messages（context.ts 拼好的，按原样发）；只有一问一答时可以只给 system + user */
export interface ChatRequest { system?: string; user?: string; messages?: ChatMessage[]; maxTokens: number; temperature?: number; schema?: Record<string, unknown> }
export class ChatCompletions {
  config: ProviderConfig; private key: string; private fetcher: Fetcher;
  constructor(config: ProviderConfig, key: string, fetcher: Fetcher = fetch) { this.config = config; this.key = key; this.fetcher = fetcher; }
  async chat(req: ChatRequest, signal: AbortSignal) {
    if (req.messages?.some(m=>Array.isArray(m.content) && m.content.some(p=>p.type==='image_url')) && this.config.images!==true) throw new LlmFailure('invalid');
    const start = performance.now();
    const format = this.config.jsonMode === 'json_object' ? {type: 'json_object'}
      : this.config.jsonMode === 'json_schema' && req.schema ? {type: 'json_schema', json_schema: {name: 'dialogue', strict: true, schema: req.schema}} : undefined;
    const raw = await post(this.config, 'chat/completions', this.key, {model: this.config.model, stream: false,
      messages: req.messages ?? [{role: 'system', content: req.system ?? ''}, {role: 'user', content: req.user ?? ''}],
      max_tokens: req.maxTokens, temperature: req.temperature ?? 0.6, ...(format ? {response_format: format} : {})}, signal, this.fetcher);
    const usage = usageOf(object(raw) ? raw.usage : null, false, this.config.cachedTokensField);
    const choice = object(raw) && Array.isArray(raw.choices) ? raw.choices[0] : null;
    if (!object(choice) || !object(choice.message)) throw new LlmFailure('invalid', usage);
    const text = typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
    if (choice.message.refusal || choice.finish_reason === 'content_filter') throw new LlmFailure('refusal', usage);
    if (!text) throw new LlmFailure(choice.finish_reason === 'length' ? 'empty-thinking' : 'refusal', usage);
    return {text, usage, latencyMs: performance.now() - start, finishReason: String(choice.finish_reason ?? '')};
  }
}
export type Question = {type: 'choice'; instructions: string; criteria: Record<string, string>}
  | {type: 'noul'; instructions: string; criteria?: {false: string; true: string}}
  | {type: 'score'; instructions: string; criteria: string[]};
export interface Answer { type: Question['type']; choice?: string; probabilities?: Record<string, number>; confidence?: number; noul?: number; score?: number }
export class ClefProvider {
  config: ProviderConfig; private key: string; private fetcher: Fetcher;
  constructor(config: ProviderConfig, key: string, fetcher: Fetcher = fetch) { this.config = config; this.key = key; this.fetcher = fetcher; }
  async ask(state: string, questions: Record<string, Question>, signal: AbortSignal) {
    if (typeof state !== 'string' || !state.trim() || !object(questions) || !Object.keys(questions).length || Object.keys(questions).length > 64) throw new LlmFailure('invalid');
    for (const [id, q] of Object.entries(questions)) {
      if (!object(q) || !['choice','noul','score'].includes(q.type) || !/^[A-Za-z0-9_.-]{1,100}$/.test(id) || typeof q.instructions !== 'string' || !q.instructions.trim()) throw new LlmFailure('invalid');
      if (q.type === 'choice' && (!object(q.criteria) || Object.values(q.criteria).some(v=>typeof v!=='string'||!v.trim()))) throw new LlmFailure('invalid');
      if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.some(v=>typeof v!=='string'||!v.trim()))) throw new LlmFailure('invalid');
      const n = q.type === 'noul' ? 2 : Object.keys(q.criteria).length;
      if (n < 2 || n > (q.type === 'score' ? 10 : 26)) throw new LlmFailure('invalid');
    }
    const start = performance.now();
    const raw = await post(this.config, 'systemone', this.key, {model: this.config.model, state, questions}, signal, this.fetcher);
    const usage = usageOf(object(raw) ? raw.usage : null, true, null);
    if (!object(raw) || !object(raw.answers)) throw new LlmFailure('invalid', usage);
    const answers: Record<string, Answer> = {};
    const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    for (const [id, q] of Object.entries(questions)) {
      const a = raw.answers[id];
      if (!object(a) || a.type !== q.type) throw new LlmFailure('invalid', usage);
      if (q.type === 'choice') {
        if (typeof a.choice !== 'string' || !Object.hasOwn(q.criteria, a.choice) || !object(a.probabilities) || !probability(a.confidence)) throw new LlmFailure('invalid', usage);
        const keys = Object.keys(q.criteria), probs = a.probabilities;
        if (Object.keys(probs).length !== keys.length || keys.some(k => !probability(probs[k])) || Math.abs(keys.reduce((s,k) => s + probs[k], 0) - 1) > 0.03) throw new LlmFailure('invalid', usage);
        answers[id] = {type: 'choice', choice: a.choice, probabilities: {...probs}, confidence: a.confidence};
      } else if (q.type === 'noul') {
        if (!probability(a.noul)) throw new LlmFailure('invalid', usage);
        answers[id] = {type: 'noul', noul: a.noul};
      } else {
        if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > q.criteria.length - 1 || !probability(a.confidence)) throw new LlmFailure('invalid', usage);
        answers[id] = {type: 'score', score: a.score, confidence: a.confidence};
      }
    }
    return {answers, usage, latencyMs: performance.now() - start};
  }
}
