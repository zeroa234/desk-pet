// 用量 / 预算的单测（纯逻辑 + 临时 SQLite，不联网、不读 key）：费用估算、汇总口径、未知值、本地午夜、滚动小时。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {BudgetGate, UsageStore, estimateCost} from '../src/llm/usage.ts';
import type {CallRecord, Price, Usage} from '../src/llm/types.ts';
import {approx, eq} from './helpers/assert.ts';

const usage = (prompt: number, completion: number, cached: number | null = null, reasoning: number | null = null): Usage =>
  ({prompt, completion, cached, reasoning});

const call = (overrides: Partial<Omit<CallRecord, 'usage'>> & {usage?: Usage | null} = {}): CallRecord => ({
  at: 1000,
  character: 'witch',
  kind: 'line',
  provider: 'provider',
  model: 'model',
  usage: usage(100, 20, 10),
  costUsd: 0.001,
  latencyMs: 100,
  result: 'ok',
  ...overrides,
});

const PRICE: Price = {input: 0.30, cached: 0.006, output: 1.20};

test('pending reservations count toward hourly requests but do not poison daily known usage',()=>{
  const now=Date.now(),pending=[{at:now}];
  assert.equal(new BudgetGate({hourlyRequests:2,dailyUsd:1,dailyTokens:1000}).check([], 'reaction',now,pending),null);
  assert.equal(new BudgetGate({hourlyRequests:1,dailyUsd:1,dailyTokens:1000}).check([], 'reaction',now,pending)?.reason,'hourly');
});

test('budget time windows include calls beyond presentation pagination',()=>{
  const store=new UsageStore(':memory:');try{
    for(let i=0;i<10001;i++)store.record(call({at:1000+i}));
    assert.equal(store.recent(10000).length,10000);assert.equal(store.since(1000).length,10001);assert.equal(store.since(11000).length,1);
  }finally{store.close();}
});

test('UsageStore can report costs, tokens and cache separately by character and kind',()=>{
  const store=new UsageStore(':memory:');
  try{
    store.record(call({character:'a',kind:'line',usage:usage(100,20,50),costUsd:.001}));
    store.record(call({character:'a',kind:'decision',usage:usage(200,0,null),costUsd:.002}));
    store.record(call({character:'b',kind:'line',usage:usage(300,10,100),costUsd:.003}));
    assert.equal(store.summary('a').prompt,300);assert.equal(store.summary('a').cacheRate,null);
    assert.equal(store.summary(undefined,'line').prompt,400);assert.equal(store.summary(undefined,'line').cacheRate,150/400);
    assert.equal(store.summary('b','decision').total,0);
  }finally{store.close();}
});

test('estimateCost：缺 usage / 价格是未知；cached 已知扣 input，未知按全价；reasoning 不重复计', () => {
  eq(estimateCost(null, PRICE), null);
  eq(estimateCost(usage(100, 20), undefined), null);

  const uncached = estimateCost(usage(1000, 500, null), PRICE);
  assert.ok(uncached !== null);
  approx(uncached, 0.0009, 'cached 未知按全部 input 计', 1e-12);
  const cached = estimateCost(usage(1000, 500, 400), PRICE);
  assert.ok(cached !== null);
  approx(cached, 0.0007824, 'cached 已知扣 400 input', 1e-12);
  eq(estimateCost(usage(100, 20, null, 50), PRICE), estimateCost(usage(100, 20, null, null), PRICE));
  eq(estimateCost(usage(100, 20, 10), {input: 0, cached: 0, output: 0}), 0, '价格 0 是已知 0，不是未知');
});

test('UsageStore.summary：费用、未知费用、token、缓存未知和延迟分位', () => {
  const store = new UsageStore(':memory:');
  try {
    store.record(call({
      at: 1000, character: 'witch', kind: 'line',
      usage: usage(100, 20, 10), costUsd: 0.0001, latencyMs: 100, result: 'ok',
    }));
    store.record(call({
      at: 2000, character: 'silent', kind: 'decision',
      usage: null, costUsd: null, latencyMs: 300, result: 'http',
    }));

    const summary = store.summary();
    eq(summary.total, 2);
    approx(summary.costUsd, 0.0001);
    eq(summary.unknownCost, 1, '未知费用按条数报告');
    eq(summary.prompt, 100, '未知 usage 的调用不补 0');
    eq(summary.completion, 20);
    eq(summary.cached, null, '有一条缓存未知，总体不能显示 0');
    eq(summary.cacheRate, null);
    eq(summary.p50, 100);
    eq(summary.p95, 300);
    eq(summary.byCharacter.witch, 1);
    eq(summary.byCharacter.silent, 1);
    eq(summary.byKind.line, 1);
    eq(summary.byKind.decision, 1);
    eq(summary.failures.http, 1);
  } finally {
    store.close();
  }
});

test('UsageStore.summary：部分缓存未知总体 null，但已知 token 仍汇总', () => {
  const store = new UsageStore(':memory:');
  try {
    store.record(call({at: 1, usage: usage(100, 20, 40), latencyMs: 10}));
    store.record(call({at: 2, usage: usage(100, 20, null), latencyMs: 20}));
    const summary = store.summary();
    eq(summary.prompt, 200);
    eq(summary.completion, 40);
    eq(summary.cached, null);
    eq(summary.cacheRate, null);
    eq(summary.p50, 10);
    eq(summary.p95, 20);
  } finally {
    store.close();
  }
});

test('UsageStore.summary：缓存全部已知时给合计和命中率', () => {
  const store = new UsageStore(':memory:');
  try {
    store.record(call({at: 1, usage: usage(100, 20, 40), latencyMs: 10}));
    store.record(call({at: 2, usage: usage(300, 30, 60), latencyMs: 20}));
    const summary = store.summary();
    eq(summary.cached, 100);
    eq(summary.prompt, 400);
    approx(summary.cacheRate ?? -1, 0.25);
    eq(summary.unknownCost, 0);
  } finally {
    store.close();
  }
});

test('UsageStore.recent：按时间倒序、limit 生效、记录能原样读回', () => {
  const store = new UsageStore(':memory:');
  try {
    for (let i = 0; i < 5; i++) {
      store.record(call({
        at: 1000 + i * 100,
        character: `c${i}`,
        kind: i % 2 === 0 ? 'line' : 'reply',
        usage: usage(10 + i, 2 + i, i),
        costUsd: i === 4 ? null : 0.001 * i,
        latencyMs: 10 + i,
        result: i === 3 ? 'timeout' : 'ok',
      }));
    }
    const latest = store.recent(3);
    eq(latest.map(r => r.at).join(','), '1400,1300,1200');
    eq(latest[0].character, 'c4');
    eq(latest[0].usage?.prompt, 14);
    eq(latest[0].usage?.cached, 4);
    eq(latest[0].costUsd, null, '未知费用读回仍是 null');
    eq(store.recent(100).length, 5);
    eq(store.recent(0).length, 0);
    eq(store.recent(-1).length, 0);
  } finally {
    store.close();
  }
});

test('UsageStore 支持 :memory:、自动建目录、关闭后可重开', t => {
  const root = path.join(process.cwd(), 'temp', `llm-usage-test-${process.pid}-${Date.now()}`);
  const file = path.join(root, 'nested', 'llm.sqlite');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));

  const store = new UsageStore(file);
  store.record(call({at: 12345}));
  store.close();
  assert.ok(fs.existsSync(file), '数据库文件应存在');
  assert.ok(fs.existsSync(path.dirname(file)), '父目录应自动建出来');

  const reopened = new UsageStore(file);
  try {
    eq(reopened.summary().total, 1);
  } finally {
    reopened.close();
  }
  reopened.close();
});

test('UsageStore 不存 prompt / 正文 / key，只存约定的数字和元数据', t => {
  const root = path.join(process.cwd(), 'temp', `llm-usage-secret-${process.pid}-${Date.now()}`);
  const file = path.join(root, 'llm.sqlite');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));

  const extra = {
    prompt: 'PROMPT_SENTINEL_123',
    text: 'TEXT_SENTINEL_123',
    key: 'sk-KEY_SENTINEL_123456',
  };
  const store = new UsageStore(file);
  store.record({...call(), ...extra} as unknown as CallRecord);
  store.close();

  const bytes = fs.readFileSync(file);
  for (const sentinel of ['PROMPT_SENTINEL_123', 'TEXT_SENTINEL_123', 'sk-KEY_SENTINEL_123456']) {
    assert.ok(!bytes.includes(Buffer.from(sentinel)), `数据库不应包含 ${sentinel}`);
  }

  const db = new DatabaseSync(file);
  try {
    const columns = (db.prepare('PRAGMA table_info(llm_calls)').all() as unknown as Array<{name: string}>)
      .map(column => column.name);
    eq(columns.includes('prompt'), false);
    eq(columns.includes('text'), false);
    eq(columns.includes('key'), false);
  } finally {
    db.close();
  }
});

test('BudgetGate：本地午夜重置日预算，80% 只 reply，100% 全挡', () => {
  const now = new Date(2026, 0, 2, 12, 0, 0).getTime();
  const midnight = new Date(2026, 0, 2, 0, 0, 0).getTime();
  const gate = new BudgetGate({hourlyRequests: 100, dailyUsd: 10, dailyTokens: null});

  const yesterday = call({at: midnight - 1, costUsd: 100, usage: usage(100000, 0)});
  eq(gate.allow([yesterday], 'line', now), true, '昨天的费用不算今天');

  const at80 = call({at: midnight, costUsd: 8, usage: usage(10, 0)});
  eq(gate.allow([yesterday, at80], 'line', now), false, '80% 不再接后台请求');
  eq(gate.allow([yesterday, at80], 'reply', now), true, '80% 仍回应用户说话');

  const at100 = call({at: now, costUsd: 2, usage: usage(10, 0)});
  eq(gate.allow([yesterday, at80, at100], 'reply', now), false, '100% 连 reply 也挡');
});

test('BudgetGate：每日 token 也按 80% / 100% 分档', () => {
  const now = new Date(2026, 0, 2, 12, 0, 0).getTime();
  const gate = new BudgetGate({hourlyRequests: 100, dailyUsd: null, dailyTokens: 1000});

  const at80 = call({at: now, usage: usage(500, 300)});
  eq(gate.allow([at80], 'line', now), false);
  eq(gate.allow([at80], 'reply', now), true);

  const at100 = call({at: now, usage: usage(100, 100)});
  eq(gate.allow([at80, at100], 'reply', now), false);
});

test('BudgetGate：null 表示该维度不限', () => {
  const now = new Date(2026, 0, 2, 12, 0, 0).getTime();
  const gate = new BudgetGate({hourlyRequests: 100, dailyUsd: null, dailyTokens: null});
  const expensive = call({at: now, costUsd: 1_000_000, usage: usage(100_000_000, 100_000_000)});
  eq(gate.allow([expensive], 'line', now), true);
});

test('BudgetGate：未知费用 / 未知 usage 不能当 0，最多只留 reply', () => {
  const now = new Date(2026, 0, 2, 12, 0, 0).getTime();
  const usd = new BudgetGate({hourlyRequests: 100, dailyUsd: 10, dailyTokens: null});
  const unknownCost = call({at: now, costUsd: null, usage: usage(10, 10)});
  eq(usd.allow([unknownCost], 'line', now), false, '费用未知时后台请求不能继续刷');
  eq(usd.allow([unknownCost], 'reply', now), true);

  const tokens = new BudgetGate({hourlyRequests: 100, dailyUsd: null, dailyTokens: 1000});
  const unknownUsage = call({at: now, usage: null, costUsd: 0.001});
  eq(tokens.allow([unknownUsage], 'line', now), false);
  eq(tokens.allow([unknownUsage], 'reply', now), true);

  const atLimit = call({at: now, costUsd: 10, usage: usage(10, 10)});
  eq(usd.allow([atLimit, unknownCost], 'reply', now), false, '已知部分已经到 100% 时全挡');
});

test('BudgetGate：滚动一小时跨本地午夜照样计数', () => {
  const now = new Date(2026, 0, 2, 0, 10, 0).getTime();
  const beforeMidnight = new Date(2026, 0, 1, 23, 50, 0).getTime();
  const gate = new BudgetGate({hourlyRequests: 2, dailyUsd: null, dailyTokens: null});
  eq(gate.allow([call({at: beforeMidnight})], 'line', now), true);
  eq(gate.allow([call({at: beforeMidnight}), call({at: now})], 'reply', now), false);
});

test('BudgetGate：滚动一小时，且小时上限连 reply 也挡', () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  const gate = new BudgetGate({hourlyRequests: 2, dailyUsd: null, dailyTokens: null});
  const outside = call({at: now - 3_600_001});
  const inside = call({at: now - 1000});
  eq(gate.allow([outside], 'line', now), true, '刚好超过一小时的不算');
  eq(gate.allow([outside, inside], 'line', now), true);
  const newest = call({at: now});
  eq(gate.allow([outside, inside, newest], 'line', now), false);
  eq(gate.allow([outside, inside, newest], 'reply', now), false, '小时上限是硬熔断');
});

test('BudgetGate.check：小时上限说清用了多少、几点恢复（最早那几条滚出一小时）；null 不限', () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  const gate = new BudgetGate({hourlyRequests: 2, dailyUsd: null, dailyTokens: null});
  const records = [call({at: now - 1000}), call({at: now - 50 * 60_000}), call({at: now - 20 * 60_000})];
  assert.deepEqual(gate.check(records, 'line', now), {reason: 'hourly', limit: 2, used: 3, until: now - 20 * 60_000 + 3_600_000},
    '用了 3 次、上限 2：最早两条都滚出去才回到上限以下');
  eq(gate.check(records.slice(0, 1), 'line', now), null);
  const unlimited = new BudgetGate({hourlyRequests: null, dailyUsd: null, dailyTokens: null});
  eq(unlimited.check(Array.from({length: 5000}, () => call({at: now})), 'line', now), null);
});

test('BudgetGate.check：每日上限挡下时到本地明天 0 点恢复，报更紧的那个维度', () => {
  const now = new Date(2026, 0, 2, 12, 0, 0).getTime();
  const gate = new BudgetGate({hourlyRequests: null, dailyUsd: 10, dailyTokens: 1000});
  const block = gate.check([call({at: now, costUsd: 1, usage: usage(800, 300)})], 'line', now);
  assert.deepEqual(block, {reason: 'daily', limit: 1000, used: 1100, until: new Date(2026, 0, 3).getTime()});
});
