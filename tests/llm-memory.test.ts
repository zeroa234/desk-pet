// 对话记忆（src/llm/memory.ts）的单测：隔离、顺序、pending 策略、compact / archive、回滚、
// forget、非法输入、关闭后抛错、文件库重开。`:memory:` 为主，另有一条临时文件库（temp/ 下，用完删掉）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {MemoryStore} from '../src/llm/memory.ts';
import type {CompactionPolicy, MemoryMode, MemoryTurn} from '../src/llm/memory.ts';
import {eq} from './helpers/assert.ts';

let clock = 1_700_000_000_000;

/** 追加一轮，at 用递增的假时间（同一文件里的测试顺序执行，不依赖真时钟） */
function add(store: MemoryStore, character: string, mode: MemoryMode, user: string, reply = '嗯'): MemoryTurn {
  return store.append(character, mode, {at: clock++, kind: 'line', user, reply});
}

/** 数组 / 对象用深比较：eq 是 strictEqual，比数组只看引用 */
function deep(actual: unknown, expected: unknown, message?: string): void {
  assert.deepEqual(actual, expected, message);
}

const POLICY: CompactionPolicy = {maxTurns: 5, keepTurns: 2, maxChars: 1000};

test('不同角色、不同模式互不串', () => {
  const store = new MemoryStore(':memory:');
  try {
    add(store, 'a', 'adult', 'a 成人 1');
    add(store, 'a', 'adult', 'a 成人 2');
    add(store, 'a', 'sfw', 'a 全年龄 1');
    add(store, 'b', 'adult', 'b 成人 1');

    deep(store.window('a', 'adult').turns.map(turn => turn.user), ['a 成人 1', 'a 成人 2']);
    deep(store.window('a', 'sfw').turns.map(turn => turn.user), ['a 全年龄 1']);
    deep(store.window('b', 'adult').turns.map(turn => turn.user), ['b 成人 1']);
    deep(store.window('b', 'sfw').turns, []);
    eq(store.counts('a', 'adult').active, 2);
    eq(store.counts('a', 'sfw').active, 1);
    eq(store.counts('b', 'adult').active, 1);
    eq(store.counts('b', 'sfw').active, 0);
  } finally { store.close(); }
});

test('window 按 seq 升序；没有摘要时 summary 是空串、summaryAt 是 null', () => {
  const store = new MemoryStore(':memory:');
  try {
    const first = store.append('a', 'adult', {at: 1000.4, kind: 'line', user: '第一轮', reply: '好'});
    const second = store.append('a', 'adult', {at: 2000.6, kind: 'reaction', user: '第二轮', reply: ''});
    const third = store.append('b', 'adult', {at: 3000, kind: 'talk', user: '别的角色', reply: '哦'});
    eq(first.at, 1000, 'at 存成整数（四舍五入）');
    eq(second.at, 2001);
    eq(first.seq < second.seq, true);
    eq(second.seq < third.seq, true, 'seq 是全库自增，不分角色 / 模式');

    const win = store.window('a', 'adult');
    eq(win.summary, '');
    eq(win.summaryAt, null);
    deep(win.turns.map(turn => turn.seq), [first.seq, second.seq]);
    deep(win.turns.map(turn => turn.user), ['第一轮', '第二轮']);
    eq(win.turns[1].reply, '', 'reply 可以是空串');
    eq(win.turns[1].kind, 'reaction');
    eq(win.turns[1].at, 2001);
  } finally { store.close(); }
});

test('pending：轮数上限、字符上限、只有 0 / 1 轮时不动', () => {
  const store = new MemoryStore(':memory:');
  try {
    for (let i = 1; i <= 5; i++) add(store, 'a', 'adult', `第 ${i} 轮`);
    eq(store.pending('a', 'adult', POLICY), null, '正好 maxTurns 轮不丢');
    eq(store.pending('none', 'adult', POLICY), null, '0 轮不丢');

    add(store, 'a', 'adult', '第 6 轮');
    const batch = store.pending('a', 'adult', POLICY);
    assert.ok(batch !== null, '超过 maxTurns 轮要丢');
    deep(batch.map(turn => turn.user), ['第 1 轮', '第 2 轮', '第 3 轮', '第 4 轮'], '丢掉最早 (6 - keepTurns) 轮');
    deep(batch.map(turn => turn.seq), store.window('a', 'adult').turns.slice(0, 4).map(turn => turn.seq));

    // 字符数超了也触发：三条各 4 个码点，maxChars 10
    const byChars: CompactionPolicy = {maxTurns: 10, keepTurns: 2, maxChars: 10};
    for (let i = 1; i <= 3; i++) store.append('chars', 'adult', {at: i, kind: 'line', user: 'abcd', reply: ''});
    const chars = store.pending('chars', 'adult', byChars);
    assert.ok(chars !== null, '字符串超 maxChars 要丢');
    eq(chars.length, 1, '3 轮丢掉最新 2 轮，剩最早 1 轮');
    eq(chars[0].user, 'abcd');

    // 只有 keepTurns 轮但字符超了：退成“除最新 1 轮”，不能返回空批
    for (let i = 1; i <= 2; i++) store.append('keep', 'adult', {at: i, kind: 'line', user: 'abcdef', reply: ''});
    const overflow = store.pending('keep', 'adult', {maxTurns: 5, keepTurns: 2, maxChars: 4});
    assert.ok(overflow !== null);
    eq(overflow.length, 1);

    store.append('one', 'adult', {at: 1, kind: 'line', user: 'x'.repeat(10), reply: ''});
    eq(store.pending('one', 'adult', {maxTurns: 5, keepTurns: 2, maxChars: 1}), null, '只有 1 轮时字符超了也不丢');
  } finally { store.close(); }
});

test('compact 归档早期、换上新摘要；archive 只归档、摘要不变', () => {
  const store = new MemoryStore(':memory:');
  try {
    for (let i = 1; i <= 6; i++) add(store, 'a', 'adult', `第 ${i} 轮`);
    const batch = store.pending('a', 'adult', POLICY);
    assert.ok(batch !== null);

    store.compact('a', 'adult', batch[batch.length - 1].seq, '前四轮的摘要', 5000);
    let win = store.window('a', 'adult');
    eq(win.summary, '前四轮的摘要');
    eq(win.summaryAt, 5000);
    deep(win.turns.map(turn => turn.user), ['第 5 轮', '第 6 轮'], '只留最新的 keepTurns 轮');
    eq(store.counts('a', 'adult').active, 2);
    eq(store.counts('a', 'adult').archived, 4);
    eq(store.pending('a', 'adult', POLICY), null, '剩下 keepTurns 轮，不再丢');

    // 再攒到超上限：只 archive，摘要和摘要时间保持原样
    for (let i = 7; i <= 10; i++) add(store, 'a', 'adult', `第 ${i} 轮`);
    const more = store.pending('a', 'adult', POLICY);
    assert.ok(more !== null);
    store.archive('a', 'adult', more[more.length - 1].seq);
    win = store.window('a', 'adult');
    eq(win.summary, '前四轮的摘要', 'archive 不写摘要');
    eq(win.summaryAt, 5000);
    deep(win.turns.map(turn => turn.user), ['第 9 轮', '第 10 轮']);
    eq(store.counts('a', 'adult').active, 2);
    eq(store.counts('a', 'adult').archived, 8);
  } finally { store.close(); }
});

test('compact：摘要超长在事务前就抛，摘要和轮都没动', () => {
  const store = new MemoryStore(':memory:');
  try {
    add(store, 'a', 'adult', '第一轮');
    add(store, 'a', 'adult', '第二轮');
    const first = store.window('a', 'adult').turns[0];

    assert.throws(() => store.compact('a', 'adult', first.seq, 'x'.repeat(4001), 10), TypeError);
    eq(store.window('a', 'adult').summary, '');
    eq(store.window('a', 'adult').summaryAt, null);
    eq(store.counts('a', 'adult').active, 2);
    eq(store.counts('a', 'adult').archived, 0);
  } finally { store.close(); }
});

test('compact：事务里失败会回滚（库被另一个连接锁住）', () => {
  // 另一个连接拿 RESERVED 锁 → compact 写摘要时等 busy_timeout（5 秒）后 SQLITE_BUSY → ROLLBACK。
  // 这条会慢 5 秒左右，是这条测试唯一能造出“事务内失败”的办法（表里没有别的约束可违反）。
  fs.mkdirSync('temp', {recursive: true});
  const root = fs.mkdtempSync(path.resolve('temp/llm-memory-'));
  const file = path.join(root, 'memory.sqlite');
  const store = new MemoryStore(file);
  const locker = new DatabaseSync(file);
  try {
    add(store, 'a', 'adult', '第一轮');
    add(store, 'a', 'adult', '第二轮');
    const first = store.window('a', 'adult').turns[0].seq;

    locker.exec('BEGIN IMMEDIATE');
    assert.throws(() => store.compact('a', 'adult', first, '新摘要', 42), /locked|busy/i);
    eq(store.window('a', 'adult').summary, '', '事务回滚了，摘要没写上');
    eq(store.counts('a', 'adult').active, 2);
    eq(store.counts('a', 'adult').archived, 0);
    locker.exec('ROLLBACK');

    // 解锁后同一批能正常 compact：连接没卡在失败的事务里
    store.compact('a', 'adult', first, '新摘要', 42);
    eq(store.window('a', 'adult').summary, '新摘要');
    eq(store.counts('a', 'adult').archived, 1);
  } finally {
    locker.close();
    store.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('forget 只删这个角色这个模式（含已归档和摘要）', () => {
  const store = new MemoryStore(':memory:');
  try {
    for (let i = 1; i <= 3; i++) add(store, 'a', 'adult', `a 成人 ${i}`);
    const first = store.window('a', 'adult').turns[0];
    store.compact('a', 'adult', first.seq, '要被清掉的摘要', 100);
    add(store, 'a', 'sfw', 'a 全年龄');
    add(store, 'b', 'adult', 'b 成人');

    store.forget('a', 'adult');
    const gone = store.window('a', 'adult');
    eq(gone.summary, '');
    eq(gone.summaryAt, null);
    deep(gone.turns, []);
    eq(store.counts('a', 'adult').active, 0);
    eq(store.counts('a', 'adult').archived, 0, '已归档的也一起删');

    deep(store.window('a', 'sfw').turns.map(turn => turn.user), ['a 全年龄']);
    deep(store.window('b', 'adult').turns.map(turn => turn.user), ['b 成人']);
    eq(store.counts('a', 'sfw').active, 1);
    eq(store.counts('b', 'adult').active, 1);
  } finally { store.close(); }
});

test('非法输入一律 TypeError，不静默截断', () => {
  const store = new MemoryStore(':memory:');
  try {
    const good = {at: 1, kind: 'line', user: '你好', reply: '嗯'};
    assert.throws(() => store.append('', 'adult', good), TypeError);
    assert.throws(() => store.append('x'.repeat(65), 'adult', good), TypeError);
    assert.throws(() => store.append(1 as any, 'adult', good), TypeError);
    assert.throws(() => store.append('a', 'r18' as any, good), TypeError);
    assert.throws(() => store.append('a', 'adult', {...good, at: Number.NaN}), TypeError);
    assert.throws(() => store.append('a', 'adult', {...good, at: Number.POSITIVE_INFINITY}), TypeError);
    assert.throws(() => store.append('a', 'adult', {...good, kind: ''}), TypeError);
    assert.throws(() => store.append('a', 'adult', {...good, kind: 'k'.repeat(33)}), TypeError);
    assert.throws(() => store.append('a', 'adult', {...good, user: ''}), TypeError);
    assert.throws(() => store.append('a', 'adult', {...good, user: 'x'.repeat(4001)}), TypeError);
    assert.throws(() => store.append('a', 'adult', {...good, user: 42 as any}), TypeError);
    assert.throws(() => store.append('a', 'adult', {...good, reply: null as any}), TypeError);
    assert.throws(() => store.append('a', 'adult', {...good, reply: 'x'.repeat(4001)}), TypeError);
    assert.throws(() => store.append('a', 'adult', null as any), TypeError);

    assert.throws(() => store.window('', 'adult'), TypeError);
    assert.throws(() => store.window('a', 'adult ' as any), TypeError);
    assert.throws(() => store.pending('a', 'adult', {maxTurns: 0, keepTurns: 1, maxChars: 10}), TypeError);
    assert.throws(() => store.pending('a', 'adult', {maxTurns: 5, keepTurns: 5, maxChars: 10}), TypeError);
    assert.throws(() => store.pending('a', 'adult', {maxTurns: 5, keepTurns: 2, maxChars: 0}), TypeError);
    assert.throws(() => store.pending('a', 'adult', null as any), TypeError);
    assert.throws(() => store.compact('a', 'adult', Number.NaN, '摘要', 1), TypeError);
    assert.throws(() => store.compact('a', 'adult', 1, 'x'.repeat(4001), 1), TypeError);
    assert.throws(() => store.compact('a', 'adult', 1, '摘要', Number.NaN), TypeError);
    assert.throws(() => store.archive('a', 'adult', Number.POSITIVE_INFINITY), TypeError);
    assert.throws(() => store.forget('', 'adult'), TypeError);

    // 长度按 Unicode 码点算：4000 个 emoji（每个 2 个 UTF-16 单元）合法，4001 个才抛
    store.append('a', 'adult', {at: 1, kind: 'k', user: '😀'.repeat(4000), reply: '😀'.repeat(4000)});
    eq(store.counts('a', 'adult').active, 1);
    assert.throws(
      () => store.append('a', 'adult', {at: 2, kind: 'k', user: '😀'.repeat(4001), reply: ''}),
      TypeError,
    );

    // 边界值本身是合法的：character 64、kind 32、summary 空串
    store.append('x'.repeat(64), 'sfw', {at: 3, kind: 'k'.repeat(32), user: '你好', reply: ''});
    store.compact('x'.repeat(64), 'sfw', 0, '', 0);
    eq(store.window('x'.repeat(64), 'sfw').summary, '');
    eq(store.window('x'.repeat(64), 'sfw').summaryAt, 0, '空摘要也算写过，摘要时间是 0');
  } finally { store.close(); }
});

test('关闭后调用抛错，close 幂等', () => {
  const store = new MemoryStore(':memory:');
  store.close();
  assert.throws(() => store.window('a', 'adult'), /closed/);
  assert.throws(() => store.append('a', 'adult', {at: 1, kind: 'line', user: '你好', reply: ''}), /closed/);
  assert.throws(() => store.pending('a', 'adult', POLICY), /closed/);
  assert.throws(() => store.compact('a', 'adult', 1, '摘要', 1), /closed/);
  assert.throws(() => store.archive('a', 'adult', 1), /closed/);
  assert.throws(() => store.counts('a', 'adult'), /closed/);
  assert.throws(() => store.forget('a', 'adult'), /closed/);
  store.close();
});

test('文件库重开以后数据还在（父目录自动创建）', () => {
  fs.mkdirSync('temp', {recursive: true});
  const root = fs.mkdtempSync(path.resolve('temp/llm-memory-'));
  const file = path.join(root, 'nested', 'memory.sqlite');
  try {
    const first = new MemoryStore(file);
    for (let i = 1; i <= 3; i++) add(first, 'a', 'adult', `第 ${i} 轮`);
    first.compact('a', 'adult', first.window('a', 'adult').turns[0].seq, '摘要', 777);
    add(first, 'a', 'sfw', '另一模式');
    first.close();

    const again = new MemoryStore(file);
    try {
      const win = again.window('a', 'adult');
      eq(win.summary, '摘要');
      eq(win.summaryAt, 777);
      deep(win.turns.map(turn => turn.user), ['第 2 轮', '第 3 轮']);
      eq(again.counts('a', 'adult').archived, 1);
      eq(again.counts('a', 'adult').active, 2);
      deep(again.window('a', 'sfw').turns.map(turn => turn.user), ['另一模式']);

      // seq 接着涨，不和归档的撞
      const next = add(again, 'a', 'adult', '第 4 轮');
      eq(next.seq > win.turns[win.turns.length - 1].seq, true);
    } finally { again.close(); }
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
