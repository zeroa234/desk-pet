// 用户离开（N3.1，2026-10-21）的判断：src/main/away.ts 的 AwayTracker（锁屏一定离开、几分钟没输入大概离开；解锁 / 第一次输入算回来）。
// Sim 那一侧（离开期间开始的事、回来时撞见）在 tests/away-sim.test.ts。
import test from 'node:test';
import assert from 'node:assert/strict';

import {AwayTracker, type AwayInput} from '../src/main/away.ts';

const AFTER = 300;
/** 从 t0 起每秒喂一次：idle(t) 给出那一秒的空闲秒数、locked(t) 给出锁没锁；返回每次的变化（没变化的不要） */
function feed(tr: AwayTracker, from: number, to: number, idle: (t: number) => number, locked: (t: number) => boolean = () => false, afterSec = AFTER) {
  const out: {t: number; ch: NonNullable<ReturnType<AwayTracker['update']>>}[] = [];
  for (let t = from; t <= to; t++) {
    const ch = tr.update({now: t, idleSec: Math.floor(idle(t)), locked: locked(t), afterSec} satisfies AwayInput);
    if (ch) out.push({t, ch});
  }
  return out;
}

test('没输入：满 afterSec 秒算离开（kind idle）；第一次输入（空闲秒数变小）算回来，sec 是离开了几秒', () => {
  const tr = new AwayTracker();
  const ev = feed(tr, 1000, 1400, t => (t < 1350 ? t - 1000 : t - 1350));   // 1000 起不动，1350 动了一下
  assert.deepEqual(ev.map(e => [e.t, e.ch.type]), [[1300, 'away'], [1350, 'back']]);
  assert.deepEqual(ev[0].ch, {type: 'away', kind: 'idle', idleSec: 300});
  assert.deepEqual(ev[1].ch, {type: 'back', kind: 'idle', sec: 50});
  assert.equal(tr.state, null);
  assert.equal(tr.idleSec(1400), 50);
});

test('没输入：afterSec = 0 只算锁屏，多久没动都不算离开', () => {
  const tr = new AwayTracker();
  assert.deepEqual(feed(tr, 0, 2000, t => t, () => false, 0), []);
});

test('锁屏马上算离开（kind locked），解锁那一刻就回来，不等输入', () => {
  const tr = new AwayTracker();
  const ev = feed(tr, 0, 100, t => t, t => t >= 20 && t < 60);   // 一直没输入（空闲秒数一直涨），20–60 锁着
  assert.deepEqual(ev.map(e => [e.t, e.ch.type]), [[20, 'away'], [60, 'back']]);
  assert.deepEqual(ev[1].ch, {type: 'back', kind: 'locked', sec: 40});
});

test('解锁那一刻算一次输入：系统的空闲秒数没跟着清零（锁屏界面的输入不算进去）也不会马上又判成没输入', () => {
  const tr = new AwayTracker();
  // 0 起没输入，400 锁屏、500 解锁，系统空闲秒数一直涨（最坏的情况）
  const ev = feed(tr, 0, 900, t => t, t => t >= 400 && t < 500);
  // 300 先判成没输入离开；400 锁屏换成 locked；500 解锁回来；之后从 500 起再满 300 秒（800）才又离开
  assert.deepEqual(ev.map(e => [e.t, e.ch.type]), [[300, 'away'], [400, 'away-kind'], [500, 'back'], [800, 'away']]);
  assert.deepEqual(ev[1].ch, {type: 'away-kind', kind: 'locked'});
  assert.deepEqual(ev[2].ch, {type: 'back', kind: 'locked', sec: 200});   // 从 300 判离开算起
  assert.equal(tr.idleSec(600), 100);
});

test('离开期间锁着屏一直不动、空闲秒数照样涨：不重复报离开', () => {
  const tr = new AwayTracker();
  const ev = feed(tr, 0, 1000, t => t, t => t >= 10);
  assert.deepEqual(ev.map(e => e.ch.type), ['away']);
});

test('整秒读数在同一秒里读到两次（轮询抖动）不算输入', () => {
  const tr = new AwayTracker();
  feed(tr, 0, 300, t => t);
  assert.ok(tr.state);
  assert.equal(tr.update({now: 300.6, idleSec: 300, locked: false, afterSec: AFTER}), null);
  assert.ok(tr.state);
  assert.equal(tr.update({now: 301.5, idleSec: 0, locked: false, afterSec: AFTER})?.type, 'back');
});

test('还没喂过时空闲秒数是 0；刚启动时系统已经空闲很久，第一次喂就判成离开', () => {
  const tr = new AwayTracker();
  assert.equal(tr.idleSec(123), 0);
  assert.deepEqual(tr.update({now: 10, idleSec: 900, locked: false, afterSec: AFTER}), {type: 'away', kind: 'idle', idleSec: 900});
});
