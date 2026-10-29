// Physical HTTP accounting, including the providers' existing retry loop. No Sim or filesystem dependencies.
import {LlmFailure, failureOf, type Fetcher} from './providers.ts';
import {estimateCost} from './usage.ts';
import type {CallRecord, Price, RequestKind, Usage} from './types.ts';

interface Host {
  available(): boolean;
  allowed(kind: RequestKind): boolean;
  price(provider: string): Price | undefined;
  record(record: CallRecord): void;
}
interface Context {
  character: string; kind: RequestKind; provider: string; model: string;
  signal: AbortSignal; current?: () => boolean;
}

export class CallTracker {
  private host: Host;
  private activeRecords: CallRecord[] = [];
  get reservations(): readonly CallRecord[] { return this.activeRecords; }
  constructor(host: Host) { this.host = host; }

  async run<T extends {usage: Usage | null}>(ctx: Context, work: (signal: AbortSignal, send: Fetcher) => Promise<T>): Promise<T> {
    const slot: {active: {record: CallRecord; start: number} | null} = {active: null};
    const check = () => {
      if (ctx.signal.aborted) throw new LlmFailure(ctx.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted');
      if (ctx.current && !ctx.current()) throw new LlmFailure('stale');
      if (!this.host.available() || !this.host.allowed(ctx.kind)) throw new LlmFailure('budget');
    };
    const finish = () => {
      if (!slot.active) return;
      const {record, start} = slot.active; slot.active = null;
      record.latencyMs = performance.now() - start;
      record.costUsd = estimateCost(record.usage, this.host.price(ctx.provider));
      this.activeRecords = this.activeRecords.filter(r => r !== record);
      this.host.record(record);
    };
    check(); // A stale queued task does not start work or acquire a request slot.
    const send: Fetcher = async (url, init) => {
      check(); // Each physical retry rechecks lifecycle and the shared budget.
      if (init?.signal?.aborted) throw new LlmFailure('aborted');
      const record: CallRecord = {at: Date.now(), character: ctx.character, kind: ctx.kind, provider: ctx.provider,
        model: ctx.model, usage: null, costUsd: null, latencyMs: 0, result: 'ok'};
      slot.active = {record, start: performance.now()}; this.activeRecords.push(record);
      const response = await fetch(url, init);
      if (!response.ok) { record.result = 'http'; finish(); }
      return response;
    };
    try {
      const result = await work(ctx.signal, send);
      if (slot.active) slot.active.record.usage = result.usage;
      return result;
    } catch (error) {
      if (slot.active) {
        slot.active.record.result = failureOf(error);
        slot.active.record.usage = error instanceof LlmFailure ? error.usage : null;
      }
      throw error;
    } finally { finish(); }
  }
}
