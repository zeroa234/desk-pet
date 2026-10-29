// 窗口事件代替轮询（design.md §6，2026-10-21）：src/main/watch.ts 的 DesktopWatch（哪些窗口事件要重新枚举桌面、拖窗口那段、兜底），
// 和 Sim 那一侧：站在窗口上 / 在窗口里面不再要 30 Hz（needsFastTick），attachedWindows 给出要跟位置的窗口。
// 平台层真的收不收得到事件在真机上验（temp/check/winevent-probe.ts、scripts/probe-geometry.ts）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {DEFAULT_TUNING} from '../src/behavior/index.ts';
import type {MindConfig, Tuning} from '../src/behavior/index.ts';
import {MOVING_MAX, DesktopWatch} from '../src/main/watch.ts';
import {Sim} from '../src/main/sim.ts';
import type {WinEvent} from '../src/shared/types.ts';
import {makeDisplay, makeWindow, mulberry32, rect} from './helpers/fake-desktop.ts';
import {DT, FLOOR_Y, SCENE_VARIANT, makePack} from './helpers/fake-scene.ts';

const ev = (kind: WinEvent['kind'], hwnd: number): WinEvent => ({kind, hwnd});

test('DesktopWatch：上次枚举到的窗口挪了 / 藏了 / 最小化 / cloak / 关了才算；别的窗口（子窗口、工具窗、看不见的）不算', () => {
  const w = new DesktopWatch(), listed = new Set([10, 11]);
  w.dirty = false;
  for (const kind of ['location', 'hide', 'minimize', 'cloak', 'destroy'] as const) {
    assert.equal(w.onEvent(ev(kind, 99), listed, 0), false, kind);
    assert.equal(w.dirty, false, kind);
    assert.equal(w.onEvent(ev(kind, 10), listed, 0), true, kind);
    assert.equal(w.dirty, true, kind);
    w.dirty = false;
  }
});

test('DesktopWatch：切前台、显示、还原、uncloak 不管是谁都算（可能多出窗口、z 序可能变了）', () => {
  const w = new DesktopWatch(), listed = new Set<number>();
  for (const kind of ['foreground', 'show', 'restore', 'uncloak'] as const) {
    w.dirty = false;
    assert.equal(w.onEvent(ev(kind, 99), listed, 0), true, kind);
    assert.equal(w.dirty, true, kind);
  }
});

test('DesktopWatch：拖窗口从 move-size-start 到 end 一直算在拖；被拖的窗口关了、或者超过 MOVING_MAX 秒也结束', () => {
  const w = new DesktopWatch(), listed = new Set([10]);
  assert.equal(w.onEvent(ev('move-size-start', 42), listed, 5), true);   // 被拖的窗口不在 listed 里也算（比如刚弹出来的）
  assert.equal(w.isMoving(6), true);
  assert.equal(w.onEvent(ev('move-size-end', 42), listed, 7), true);
  assert.equal(w.isMoving(7), false);

  w.onEvent(ev('move-size-start', 10), listed, 10);
  w.onEvent(ev('destroy', 77), listed, 11);   // 别的窗口关了：照拖
  assert.equal(w.isMoving(11), true);
  w.onEvent(ev('destroy', 10), listed, 12);
  assert.equal(w.isMoving(12), false);

  w.onEvent(ev('move-size-start', 10), listed, 100);
  assert.equal(w.isMoving(100 + MOVING_MAX - 1), true);
  assert.equal(w.isMoving(100 + MOVING_MAX + 1), false);
});

test('DesktopWatch.take：有变化、在拖窗口、满兜底间隔才枚举；枚举了就清掉 dirty', () => {
  const w = new DesktopWatch();
  assert.equal(w.take(0, -Infinity, 1), true);   // 一开始 dirty
  assert.equal(w.dirty, false);
  assert.equal(w.take(0.5, 0, 1), false);
  assert.equal(w.take(1, 0, 1), true);           // 兜底
  w.onEvent(ev('foreground', 1), new Set(), 1.2);
  assert.equal(w.take(1.2, 1, 1), true);
  assert.equal(w.take(1.3, 1.2, 1), false);
  w.onEvent(ev('move-size-start', 1), new Set(), 1.3);
  assert.equal(w.take(1.31, 1.3, 1), true);       // 拖着：每 tick 都枚举
  assert.equal(w.take(1.34, 1.31, 1), true);
  w.onEvent(ev('move-size-end', 1), new Set(), 1.35);
  assert.equal(w.take(1.36, 1.34, 1), true);       // end 本身也算一次变化
  assert.equal(w.take(1.4, 1.36, 1), false);
});

// ---------- Sim ----------

const IDLE: MindConfig = {schema: 1, stats: {}, behaviors: []};
function makeSim(windows: ReturnType<typeof makeWindow>[], at: {x: number; y: number}) {
  const tuning: Tuning = {...DEFAULT_TUNING, idleSec: [5, 5]};
  const sim = new Sim([makePack({id: 's', mind: IDLE})], tuning, {variant: SCENE_VARIANT, heightLogical: 120, r18: true}, mulberry32(3),
    {unlocked: [], playSeconds: 0, chars: {s: {stats: {}, relations: {}}}}, new Map());
  sim.setDesktop({displays: [makeDisplay(1, rect(0, 0, 1920, 1080))], windows});
  sim.spawn('s', at);
  const a = sim.charOf('s')!.actor!;
  const run = (pred: () => boolean, max = 300) => { for (let i = 0; i < max && !pred(); i++) sim.step(sim.now + DT, DT); assert.ok(pred()); };
  return {sim, a, run};
}

test('Sim：站在窗口顶边上待着不要 30 Hz（以前要，靠每 tick 枚举窗口跟上），attachedWindows 里有这个窗口；站在地面时没有', () => {
  const win = makeWindow(10, rect(100, 300, 900, 700));
  const {sim, a, run} = makeSim([win], {x: 500, y: 300});
  run(() => a.state === 'idle' && a.support?.key === 'win:10');
  assert.equal(sim.needsFastTick(), false);
  assert.deepEqual([...sim.attachedWindows()], [10]);

  // 窗口挪了（窗口事件叫醒主循环、重新枚举 → setDesktop）：下一步就跟上，还在这个窗口上
  sim.setDesktop({displays: sim.desktop.displays, windows: [{...win, rect: rect(160, 310, 960, 710)}]});
  sim.step(sim.now + DT, DT);
  assert.equal(a.support?.key, 'win:10');
  assert.equal(a.y, 310);
  assert.equal(a.x, 560);

  const floor = makeSim([win], {x: 1500, y: FLOOR_Y});
  floor.run(() => floor.a.state === 'idle' && floor.a.support?.key === 'floor:1');
  assert.equal(floor.sim.attachedWindows().size, 0);
});

test('Sim：在窗口里面（层 inside:W）待着也不要 30 Hz，attachedWindows 里有 W', () => {
  const {sim, a, run} = makeSim([makeWindow(10, rect(100, 300, 900, 700))], {x: 1500, y: FLOOR_Y});
  run(() => a.state === 'idle');
  sim.grab('s', {x: a.x, y: a.y});
  sim.drag({x: 500, y: 690});
  sim.release();
  run(() => a.state === 'idle' && a.support?.kind === 'inside');
  assert.equal(a.layer.kind, 'inside');
  assert.equal(sim.needsFastTick(), false);
  assert.deepEqual([...sim.attachedWindows()], [10]);
});
