// world/：支撑面（computeSupports）和 displayAt 的单测。规则见 docs/state-rules.md §2.3、§3 和 src/world/supports.ts 开头。
import test from 'node:test';
import assert from 'node:assert/strict';

import {computeSupports, displayAt} from '../src/world/index.ts';
import type {Support} from '../src/world/index.ts';
import {
  MIN_WIDTH_DIP, SUPPORT_OPTIONS, heightPxOf, makeDisplay, makeSnapshot, makeWindow, rect,
} from './helpers/fake-desktop.ts';

// A：1920×1080、100% 缩放、底部 40 px 任务栏 → 地面 y = 1040
const A = makeDisplay(1, rect(0, 0, 1920, 1080));
// B：紧挨 A 的右边、200% 缩放（角色高 240 物理像素、最短线段 160）
const B = makeDisplay(2, rect(1920, 0, 3840, 1080), 2);
// C：和 A 之间留一条缝（1920..4000 是桌面外的空白）
const C = makeDisplay(3, rect(4000, 0, 5920, 1080));

const keyOf = (s: Support) => `${s.key}@${s.displayId}`;

function windowsOf(supports: readonly Support[]): Support[] {
  return supports.filter(s => s.kind === 'window');
}

test('computeSupports：每个显示器一段地面，y = 任务栏顶边', () => {
  const sup = computeSupports(makeSnapshot([A, B, C]), SUPPORT_OPTIONS);
  const floors = sup.filter(s => s.kind === 'floor');
  assert.equal(floors.length, 3);
  const a = floors.find(s => s.displayId === 1)!;
  assert.deepEqual({key: a.key, y: a.y, x0: a.x0, x1: a.x1, rect: a.rect}, {key: 'floor:1', y: 1040, x0: 0, x1: 1920, rect: null});
  const b = floors.find(s => s.displayId === 2)!;
  assert.equal(b.y, 1040);
  assert.deepEqual([b.x0, b.x1], [1920, 3840]);
  assert.equal(b.key, 'floor:2');
});

test('computeSupports：地面不受窗口遮挡影响', () => {
  const cover = makeWindow(90, rect(0, 0, 1920, 1080));   // 全屏窗口盖住整个 A
  const sup = computeSupports(makeSnapshot([A], [cover]), SUPPORT_OPTIONS);
  const floor = sup.find(s => s.kind === 'floor')!;
  assert.deepEqual([floor.y, floor.x0, floor.x1], [1040, 0, 1920]);
});

test('computeSupports：窗口顶边成一段可站线段', () => {
  const w = makeWindow(10, rect(100, 200, 500, 600));
  const sup = computeSupports(makeSnapshot([A], [w]), SUPPORT_OPTIONS);
  const win = windowsOf(sup);
  assert.equal(win.length, 1);
  const s = win[0];
  assert.equal(s.key, 'win:10');
  assert.equal(s.kind, 'window');
  assert.equal(s.y, 200);
  assert.deepEqual([s.x0, s.x1], [100, 500]);
  assert.equal(s.displayId, 1);
  assert.deepEqual(s.rect, rect(100, 200, 500, 600));
});

test('computeSupports：被 z 序更高的窗口盖住顶边的部分切掉，多段共用 key', () => {
  const target = makeWindow(10, rect(100, 200, 500, 600));
  const cover = makeWindow(11, rect(200, 150, 300, 900));   // z 序更高，盖住顶边那一行
  const sup = computeSupports(makeSnapshot([A], [cover, target]), SUPPORT_OPTIONS);
  const segs = windowsOf(sup).filter(s => s.key === 'win:10');
  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map(s => [s.x0, s.x1]), [[100, 200], [300, 500]]);
  // 同一窗口切出来的多段 key 相同、y 相同
  assert.ok(segs.every(s => s.key === 'win:10' && s.y === 200));
});

test('computeSupports：头顶空间被更高的窗口占住的部分也切掉', () => {
  const target = makeWindow(10, rect(100, 200, 500, 600));
  // 纵向只占头顶空间（y - headroom = 80 到 200 之间），没压到顶边那一行
  const above = makeWindow(11, rect(250, 150, 350, 190));
  const sup = computeSupports(makeSnapshot([A], [above, target]), SUPPORT_OPTIONS);
  const segs = windowsOf(sup).filter(s => s.key === 'win:10');
  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map(s => [s.x0, s.x1]), [[100, 250], [350, 500]]);
});

test('computeSupports：z 序更低的窗口不影响上面的窗口', () => {
  const target = makeWindow(10, rect(100, 200, 500, 600));
  const lower = makeWindow(11, rect(200, 150, 300, 900));    // 在 z 序下面
  const sup = computeSupports(makeSnapshot([A], [target, lower]), SUPPORT_OPTIONS);
  const segs = windowsOf(sup).filter(s => s.key === 'win:10');
  assert.equal(segs.length, 1);
  assert.deepEqual([segs[0].x0, segs[0].x1], [100, 500]);
});

test('computeSupports：最大化窗口（顶边在屏幕顶、头顶放不下）不可站', () => {
  const maxed = makeWindow(10, rect(0, 0, 1920, 1040));
  const sup = computeSupports(makeSnapshot([A], [maxed]), SUPPORT_OPTIONS);
  assert.equal(windowsOf(sup).length, 0);
  // 顶边往下挪一点，头顶刚好放得下（y - 120 >= 0）就可站
  const ok = makeWindow(11, rect(0, 120, 1920, 1040));
  const sup2 = computeSupports(makeSnapshot([A], [ok]), SUPPORT_OPTIONS);
  assert.equal(windowsOf(sup2).length, 1);
});

test('computeSupports：短于 minWidth 的线段丢掉', () => {
  const narrow = makeWindow(10, rect(100, 300, 100 + MIN_WIDTH_DIP - 1, 600));
  const sup = computeSupports(makeSnapshot([A], [narrow]), SUPPORT_OPTIONS);
  assert.equal(windowsOf(sup).length, 0);
  const exact = makeWindow(11, rect(100, 300, 100 + MIN_WIDTH_DIP, 600));
  const sup2 = computeSupports(makeSnapshot([A], [exact]), SUPPORT_OPTIONS);
  assert.equal(windowsOf(sup2).length, 1);
  // 被切得只剩窄条的那段也要丢掉：[100, 500) 被盖掉 [120, 500) 只剩 20 px
  const cover = makeWindow(12, rect(120, 150, 900, 900));
  const sup3 = computeSupports(makeSnapshot([A], [cover, makeWindow(13, rect(100, 200, 500, 600))]), SUPPORT_OPTIONS);
  assert.equal(sup3.filter(s => s.key === 'win:13').length, 0);
});

test('computeSupports：顶边在工作区外（任务栏里 / 屏幕外）不可站', () => {
  const inTaskbar = makeWindow(10, rect(100, 1050, 900, 1080));
  const offscreen = makeWindow(11, rect(100, -100, 900, 200));
  const sup = computeSupports(makeSnapshot([A], [inTaskbar, offscreen]), SUPPORT_OPTIONS);
  assert.equal(windowsOf(sup).length, 0);
});

test('computeSupports：跨两个显示器的窗口按显示器切开，displayId 对、key 相同', () => {
  const wide = makeWindow(20, rect(-100, 300, 2100, 900));
  const sup = computeSupports(makeSnapshot([A, B], [wide]), SUPPORT_OPTIONS);
  const segs = windowsOf(sup);
  assert.equal(segs.length, 2);
  const onA = segs.find(s => s.displayId === 1)!;
  const onB = segs.find(s => s.displayId === 2)!;
  assert.deepEqual([onA.x0, onA.x1], [0, 1920]);
  assert.deepEqual([onB.x0, onB.x1], [1920, 2100]);
  assert.equal(onA.key, 'win:20');
  assert.equal(onB.key, 'win:20');
  assert.equal(onA.y, 300);
  assert.equal(onB.y, 300);
});

test('computeSupports：窗口左右超出工作区时裁到工作区里', () => {
  const w = makeWindow(10, rect(-200, 300, 4000, 900));
  const sup = computeSupports(makeSnapshot([A], [w]), SUPPORT_OPTIONS);
  const seg = windowsOf(sup)[0];
  assert.deepEqual([seg.x0, seg.x1], [0, 1920]);
});

test('displayAt：点在显示器里返回它自己', () => {
  const displays = [A, C];
  assert.equal(displayAt(displays, {x: 500, y: 500}).id, 1);
  assert.equal(displayAt(displays, {x: 5000, y: 500}).id, 3);
});

test('displayAt：在两张显示器之间的缝里取最近的', () => {
  const displays = [A, C];
  // A: right = 1920（不含），C: left = 4000
  assert.equal(displayAt(displays, {x: 2100, y: 500}).id, 1);
  assert.equal(displayAt(displays, {x: 3900, y: 500}).id, 3);
  assert.equal(displayAt(displays, {x: 2000, y: 2000}).id, 1);
});

test('displayAt：屏幕外取最近的', () => {
  const displays = [A, C];
  assert.equal(displayAt(displays, {x: -500, y: 500}).id, 1);
  assert.equal(displayAt(displays, {x: 8000, y: 500}).id, 3);
  // y 向上/向下出屏也按矩形距离算
  assert.equal(displayAt(displays, {x: 500, y: -300}).id, 1);
  assert.equal(displayAt(displays, {x: 100, y: 3000}).id, 1);
  assert.equal(displayAt(displays, {x: 5800, y: 3000}).id, 3);
});
