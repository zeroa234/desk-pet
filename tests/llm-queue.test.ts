// 请求队列的单测（纯逻辑，不联网、不读 key）：账户并发、优先级、合并、上限、取消、close、listener 清理。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {QueueError, RequestQueue} from '../src/llm/queue.ts';
import {eq} from './helpers/assert.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

async function rejection(promise: Promise<unknown>): Promise<QueueError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof QueueError, `应抛 QueueError，实际是 ${String(error)}`);
    return error;
  }
  assert.fail('应当失败，实际成功了');
}

test('同一账户共用并发，不同账户各自按 limit 执行', async () => {
  const queue = new RequestQueue({a: 1, b: 1});
  const gate = deferred<void>();
  const started: string[] = [];
  let activeA = 0;
  let maxA = 0;
  const run = (name: string, account: string) => async () => {
    if (account === 'a') { activeA++; maxA = Math.max(maxA, activeA); }
    started.push(name);
    if (name === 'a1') await gate.promise;
    if (account === 'a') activeA--;
    return name;
  };

  const a1 = queue.enqueue({account: 'a', key: 'a1', priority: 1, run: run('a1', 'a')});
  const a2 = queue.enqueue({account: 'a', key: 'a2', priority: 1, run: run('a2', 'a')});
  const b1 = queue.enqueue({account: 'b', key: 'b1', priority: 1, run: run('b1', 'b')});
  await tick();
  eq(started.join(','), 'a1,b1', 'a 的第一个和 b 各自开跑，a 的第二个必须等');
  eq(maxA, 1, '账户 a 同时只能有一个在跑');

  gate.resolve();
  const results = await Promise.all([a1, a2, b1]);
  eq(results.join(','), 'a1,a2,b1');
  eq(started.join(','), 'a1,b1,a2');
  eq(maxA, 1);
  queue.close();
});

test('数字大的 priority 先出队，相同 priority 按进入顺序', async () => {
  const queue = new RequestQueue({a: 1});
  const gate = deferred<void>();
  const started: string[] = [];
  const first = queue.enqueue({
    account: 'a', key: 'block', priority: 0,
    run: async () => { started.push('block'); await gate.promise; return 'block'; },
  });
  await tick();

  const low = queue.enqueue({account: 'a', key: 'low', priority: 1, run: async () => { started.push('low'); return 'low'; }});
  const high = queue.enqueue({account: 'a', key: 'high', priority: 10, run: async () => { started.push('high'); return 'high'; }});
  const mid = queue.enqueue({account: 'a', key: 'mid', priority: 5, run: async () => { started.push('mid'); return 'mid'; }});
  gate.resolve();
  await Promise.all([first, low, high, mid]);
  eq(started.join(','), 'block,high,mid,low');
  queue.close();
});

test('同账户同 key 未开始时合并：旧 promise 以 superseded 拒绝，旧 run 不执行', async () => {
  const queue = new RequestQueue({a: 1});
  const gate = deferred<void>();
  const started: string[] = [];
  const blocker = queue.enqueue({
    account: 'a', key: 'block', priority: 0,
    run: async () => { started.push('block'); await gate.promise; return 'block'; },
  });
  await tick();

  const oldPromise = queue.enqueue({account: 'a', key: 'same', priority: 1, run: async () => { started.push('old'); return 'old'; }});
  const newPromise = queue.enqueue({account: 'a', key: 'same', priority: 2, run: async () => { started.push('new'); return 'new'; }});
  const error = await rejection(oldPromise);
  eq(error.code, 'superseded');

  gate.resolve();
  eq(await newPromise, 'new');
  eq(await blocker, 'block');
  eq(started.join(','), 'block,new', '被合并掉的旧 run 不能再跑');
  queue.close();
});

test('同 key 已经开跑时不能再合并，后一个排队等待', async () => {
  const queue = new RequestQueue({a: 1});
  const gate = deferred<void>();
  const started: string[] = [];
  const first = queue.enqueue({
    account: 'a', key: 'same', priority: 1,
    run: async () => { started.push('first'); await gate.promise; return 'first'; },
  });
  await tick();
  const second = queue.enqueue({account: 'a', key: 'same', priority: 1, run: async () => { started.push('second'); return 'second'; }});
  gate.resolve();
  const results = await Promise.all([first, second]);
  eq(results.join(','), 'first,second');
  eq(started.join(','), 'first,second');
  queue.close();
});

test('等待队列最多 100；第 101 个以 budget 拒绝且不执行', async () => {
  const queue = new RequestQueue({a: 1});
  const gate = deferred<void>();
  const blocker = queue.enqueue({
    account: 'a', key: 'block', priority: 0,
    run: async () => { await gate.promise; return 'block'; },
  });
  await tick();

  const waiting: Promise<number>[] = [];
  for (let i = 0; i < 100; i++) {
    waiting.push(queue.enqueue({account: 'a', key: `k${i}`, priority: 1, run: async () => i}));
  }
  let extraRan = false;
  const extra = queue.enqueue({
    account: 'a', key: 'extra', priority: 100,
    run: async () => { extraRan = true; return 'extra'; },
  });
  const error = await rejection(extra);
  eq(error.code, 'budget');

  gate.resolve();
  eq((await Promise.all([blocker, ...waiting])).length, 101);
  eq(extraRan, false);
  queue.close();
});

test('排队中 abort：立即以 aborted 拒绝、run 不执行、abort listener 清掉', async () => {
  const queue = new RequestQueue({a: 1});
  const gate = deferred<void>();
  const blocker = queue.enqueue({
    account: 'a', key: 'block', priority: 0,
    run: async () => { await gate.promise; return 'block'; },
  });
  await tick();

  const controller = new AbortController();
  let ran = false;
  const pending = queue.enqueue({
    account: 'a', key: 'later', priority: 1, signal: controller.signal,
    run: async () => { ran = true; return 'later'; },
  });
  eq(getEventListeners(controller.signal, 'abort').length, 1, '排队时挂一个 abort listener');
  controller.abort();
  const error = await rejection(pending);
  eq(error.code, 'aborted');
  eq(getEventListeners(controller.signal, 'abort').length, 0, '取消后 listener 必须清掉');

  gate.resolve();
  await blocker;
  await tick();
  eq(ran, false);
  queue.close();
});

test('在途 abort：外层立即拒绝，但并发槽位等 run 结束才释放', async () => {
  const queue = new RequestQueue({a: 1});
  const controller = new AbortController();
  const gate = deferred<void>();
  let firstRan = false;
  const first = queue.enqueue({
    account: 'a', key: 'run', priority: 1, signal: controller.signal,
    run: async () => { firstRan = true; await gate.promise; return 'first'; },
  });
  await tick();
  eq(firstRan, true);

  const started: string[] = [];
  const next = queue.enqueue({account: 'a', key: 'next', priority: 1, run: async () => { started.push('next'); return 'next'; }});
  controller.abort();
  const error = await rejection(first);
  eq(error.code, 'aborted');
  eq(getEventListeners(controller.signal, 'abort').length, 0);

  await tick();
  eq(started.length, 0, '旧 run 还占着槽位，不能提前发下一条');
  gate.resolve();
  eq(await next, 'next');
  eq(started.join(','), 'next');
  queue.close();
});

test('在途 timeout：外层 code=timeout，run 收到原始 TimeoutError reason', async () => {
  const queue = new RequestQueue({a: 1});
  const controller = new AbortController();
  const gate = deferred<void>();
  let reasonName = '';
  const pending = queue.enqueue({
    account: 'a', key: 'timeout', priority: 1, signal: controller.signal,
    run: async signal => {
      signal.addEventListener('abort', () => { reasonName = String(signal.reason?.name); gate.resolve(); }, {once: true});
      await gate.promise;
      return 'timeout';
    },
  });
  await tick();
  controller.abort(new DOMException('timed out', 'TimeoutError'));
  eq((await rejection(pending)).code, 'timeout');
  await tick();
  eq(reasonName, 'TimeoutError', '适配层靠 reason.name 区分 timeout 和 aborted');
  queue.close();
});

test('close 取消排队和在途；之后 enqueue 直接拒绝', async () => {
  const queue = new RequestQueue({a: 1});
  const gate = deferred<void>();
  let aborted = false;
  let queuedRan = false;
  const running = queue.enqueue({
    account: 'a', key: 'run', priority: 1,
    run: async signal => {
      signal.addEventListener('abort', () => { aborted = true; gate.resolve(); }, {once: true});
      await gate.promise;
      return 'run';
    },
  });
  await tick();
  const queued = queue.enqueue({
    account: 'a', key: 'queued', priority: 1,
    run: async () => { queuedRan = true; return 'queued'; },
  });

  queue.close();
  const runningError = await rejection(running);
  const queuedError = await rejection(queued);
  eq(runningError.code, 'aborted');
  eq(queuedError.code, 'aborted');
  eq(aborted, true, '在途 run 的 signal 应被 abort');
  eq(queuedRan, false);

  const late = queue.enqueue({account: 'a', key: 'late', priority: 1, run: async () => 'late'});
  eq((await rejection(late)).code, 'aborted');
  await tick();
  queue.close();
});

test('正常完成也清理 abort listener', async () => {
  const queue = new RequestQueue({a: 1});
  const controller = new AbortController();
  const done = queue.enqueue({
    account: 'a', key: 'ok', priority: 1, signal: controller.signal,
    run: async () => 'ok',
  });
  eq(await done, 'ok');
  eq(getEventListeners(controller.signal, 'abort').length, 0);
  queue.close();
});

test('被合并的旧 promise 不留下 unhandledRejection', async () => {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', listener);
  const queue = new RequestQueue({a: 1});
  const gate = deferred<void>();
  try {
    const blocker = queue.enqueue({
      account: 'a', key: 'block', priority: 0,
      run: async () => { await gate.promise; return 'block'; },
    });
    await tick();
    // 故意不 await 旧 promise：合并时它会被拒绝。
    queue.enqueue({account: 'a', key: 'same', priority: 1, run: async () => 'old'});
    const newer = queue.enqueue({account: 'a', key: 'same', priority: 2, run: async () => 'new'});
    await tick();
    await tick();
    eq(seen.length, 0, '队列内部不能遗留 unhandled rejection');
    gate.resolve();
    await blocker;
    eq(await newer, 'new');
  } finally {
    process.off('unhandledRejection', listener);
    queue.close();
  }
});
