// 服务商请求队列（R12.2）：账户共用并发、数字大的优先、同账户同 key 未开始就合并。
// 纯逻辑模块：不联网、不读配置、不记录正文或 key；取消时只抛带 code 的错误，交给运行时分类。
import type {Failure} from './types.ts';

export interface QueueRequest<T> {
  account: string;
  key: string;
  /** 数字越大越先出队；相同优先级按进入顺序。 */
  priority: number;
  signal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
}

/** 队列自己的失败：code 与 types.ts 的 Failure 对齐，运行时可直接分类。 */
export class QueueError extends Error {
  readonly code: Failure;

  constructor(code: Failure, message: string = code) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
  }
}

interface Entry {
  account: string;
  key: string;
  priority: number;
  signal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<unknown>;
  seq: number;
  state: 'waiting' | 'running' | 'done';
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  controller?: AbortController;
  onAbort?: () => void;
}

const MAX_WAITING = 100;

function abortError(signal: AbortSignal): QueueError {
  const reason = signal.reason;
  const name = reason && typeof reason === 'object' && 'name' in reason ? String(reason.name) : '';
  return new QueueError(name === 'TimeoutError' ? 'timeout' : 'aborted',
    name === 'TimeoutError' ? 'request timed out' : 'request aborted');
}

export class RequestQueue {
  private readonly limits: Record<string, number>;
  private readonly waiting: Entry[] = [];
  private readonly running = new Set<Entry>();
  private readonly active = new Map<string, number>();
  private seq = 0;
  private closed = false;

  constructor(limits: Record<string, number>) {
    this.limits = {...limits};
  }

  enqueue<T>(request: QueueRequest<T>): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    // 合并时旧 promise、close 时的排队 promise 可能没人 await；内部先挂一个空处理器，
    // 调用方仍然能拿到 rejection，但不会留下 unhandledRejection。
    void promise.catch(() => {});

    if (this.closed) {
      reject(new QueueError('aborted', 'queue closed'));
      return promise;
    }
    if (request.signal?.aborted) {
      reject(abortError(request.signal));
      return promise;
    }

    // 只合并“还没开始”的同账户同 key；已经跑着的不能被替换，否则调用方拿到的结果会张冠李戴。
    const duplicate = this.waiting.findIndex(e => e.account === request.account && e.key === request.key);
    if (duplicate >= 0) {
      const old = this.waiting[duplicate];
      this.waiting.splice(duplicate, 1);
      this.rejectEntry(old, new QueueError('superseded', 'superseded by a newer request'));
    }
    if (this.waiting.length >= MAX_WAITING &&
      (this.active.get(request.account) ?? 0) >= this.limitOf(request.account)) {
      reject(new QueueError('budget', 'queue full'));
      return promise;
    }

    const entry: Entry = {
      account: request.account,
      key: request.key,
      priority: Number.isFinite(request.priority) ? request.priority : 0,
      signal: request.signal,
      run: request.run as (signal: AbortSignal) => Promise<unknown>,
      seq: this.seq++,
      state: 'waiting',
      settled: false,
      resolve: resolve as (value: unknown) => void,
      reject,
    };
    entry.onAbort = () => {
      if (entry.settled) return;
      if (entry.state === 'waiting') {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        this.rejectEntry(entry, abortError(request.signal!));
        this.dispatch();
        return;
      }
      if (entry.state === 'running') {
        const error = abortError(request.signal!);
        // 把调用方 signal 的原始 reason 传给 run（TimeoutError 要被适配层认成 timeout），
        // 外层仍用带 code 的 QueueError 拒绝。
        entry.controller?.abort(request.signal?.reason ?? error);
        // 外层立即取消；并发槽位仍等 run 真正结束后再释放，避免 abort 后立刻再发一条把并发顶破。
        this.rejectEntry(entry, error);
      }
    };
    request.signal?.addEventListener('abort', entry.onAbort, {once: true});
    this.waiting.push(entry);
    this.waiting.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    this.dispatch();
    return promise;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.waiting]) {
      this.rejectEntry(entry, new QueueError('aborted', 'queue closed'));
    }
    this.waiting.length = 0;
    for (const entry of this.running) {
      if (entry.settled) continue;
      const error = new QueueError('aborted', 'queue closed');
      entry.controller?.abort(error);
      this.rejectEntry(entry, error);
    }
  }

  private limitOf(account: string): number {
    const limit = Object.hasOwn(this.limits, account) ? this.limits[account] : undefined;
    if (limit === undefined) return Number.POSITIVE_INFINITY;
    if (!Number.isFinite(limit)) return limit > 0 ? Number.POSITIVE_INFINITY : 0;
    return Math.max(0, Math.floor(limit));
  }

  private rejectEntry(entry: Entry, error: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.state === 'waiting') entry.state = 'done';
    this.removeAbortListener(entry);
    entry.reject(error);
  }

  private resolveEntry(entry: Entry, value: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    this.removeAbortListener(entry);
    entry.resolve(value);
  }

  private removeAbortListener(entry: Entry): void {
    if (!entry.onAbort) return;
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entry.onAbort = undefined;
  }

  private dispatch(): void {
    if (this.closed) return;
    for (;;) {
      // 队列整体按优先级排；某个账户满了就跳过它，让别的账户先跑，不把后面的低优先级全堵死。
      const index = this.waiting.findIndex(e =>
        (this.active.get(e.account) ?? 0) < this.limitOf(e.account));
      if (index < 0) return;
      const [entry] = this.waiting.splice(index, 1);
      this.start(entry);
    }
  }

  private start(entry: Entry): void {
    entry.state = 'running';
    const controller = new AbortController();
    entry.controller = controller;
    this.running.add(entry);
    this.active.set(entry.account, (this.active.get(entry.account) ?? 0) + 1);

    // run 同步抛错也走 rejection 分支；then 的两个处理器保证不会留下 unhandled rejection。
    Promise.resolve()
      .then(() => entry.run(controller.signal))
      .then(
        value => {
          this.resolveEntry(entry, value);
          this.finish(entry);
        },
        error => {
          this.rejectEntry(entry, error);
          this.finish(entry);
        },
      );
  }

  private finish(entry: Entry): void {
    entry.state = 'done';
    entry.controller = undefined;
    this.running.delete(entry);
    const left = (this.active.get(entry.account) ?? 1) - 1;
    if (left > 0) this.active.set(entry.account, left);
    else this.active.delete(entry.account);
    this.dispatch();
  }
}
