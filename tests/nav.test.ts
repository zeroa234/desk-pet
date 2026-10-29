// world/nav.ts 的单测（N2.5，2026-10-21）：跳的规则（往上 / 平着 / 往下、进窗口里面、从窗口里面出来）、找路
// （用时最少、经过窗口顶边进窗口里面）、空中时间。规则见 src/world/nav.ts 开头和 docs/desktop-interaction.md §2.4。
// 坐标都是物理像素；参数用一组整数：半宽 10、往上最多 100、横着最多 60、弧 20、重力 1000、走速 100 px/s、起跳 + 落地 0.5 秒。
import test from 'node:test';
import assert from 'node:assert/strict';

import {findRoute, flightSec, hasExit, jumpBetween, jumpTargets} from '../src/world/index.ts';
import type {NavMove, NavParams, NavRoute, Support} from '../src/world/index.ts';
import type {Rect} from '../src/shared/types.ts';
import {close, eq} from './helpers/assert.ts';

const NAV: NavParams = {
  halfWidthPx: 10, jumpUpPx: 100, jumpSidePx: 60, arcPx: 20, gravityPx: 1000, walkPxPerSec: 100, jumpFixedSec: 0.5,
};
/** 一次只跳得上去 50：测“要跳两次” */
const NAV_LOW: NavParams = {...NAV, jumpUpPx: 50};

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({left, top, right, bottom});

function sup(key: string, kind: Support['kind'], y: number, x0: number, x1: number, r: Rect | null = null): Support {
  return {key, kind, y, x0, x1, displayId: 1, rect: r};
}
const floor = (y: number, x0: number, x1: number) => sup('floor:1', 'floor', y, x0, x1);
const win = (hwnd: number, y: number, x0: number, x1: number, r: Rect | null = null) => sup(`win:${hwnd}`, 'window', y, x0, x1, r);
/** 窗口里面的底边：按 SupportOptions.inside 的算法（底边、左右各往里收 inset） */
const insideOf = (hwnd: number, r: Rect, inset = 2) => sup(`in:${hwnd}`, 'inside', r.bottom - inset, r.left + inset, r.right - inset, r);

const kinds = (r: NavRoute): string[] => r.moves.map(m => m.kind);
const jumpKeys = (r: NavRoute): string[] => r.moves.filter((m): m is Extract<NavMove, {kind: 'jump'}> => m.kind === 'jump')
  .map(m => m.to.key);

// ---------- jumpBetween：往前 / 往上 ----------

test('jumpBetween：往上在 jumpUpPx 以内、两段可站范围有重叠 → 竖着跳，起跳点尽量靠近 entryX', () => {
  const A = win(10, 500, 100, 500);
  const B = win(20, 400, 300, 800);   // 高 100 = jumpUpPx，可站范围 [310, 790] 和 A 的 [110, 490] 重叠在 [310, 490]
  assert.deepEqual(jumpBetween(A, B, 350, NAV), {fromX: 350, toX: 350});
  // entryX 在重叠范围外面：夹到重叠范围里（起跳点、落点同一个 x，竖着跳）
  assert.deepEqual(jumpBetween(A, B, 100, NAV), {fromX: 310, toX: 310});
  assert.deepEqual(jumpBetween(A, B, 800, NAV), {fromX: 490, toX: 490});
  // 高一点点就跳不上去
  eq(jumpBetween(A, win(21, 399, 300, 800), 350, NAV), null);
  // 平着也算“往上”这一支：同一个 y、范围重叠 → 竖着跳
  assert.deepEqual(jumpBetween(win(10, 500, 100, 1000), win(20, 500, 400, 600), 100, NAV), {fromX: 410, toX: 410});
});

test('jumpBetween：没重叠、横向间隔 ≤ jumpSidePx → 近端到近端；间隔超过 → null', () => {
  const A = win(10, 500, 100, 500);   // 可站 [110, 490]
  const B = win(20, 450, 530, 900);   // 可站 [540, 890]，离 A 的右端 50
  assert.deepEqual(jumpBetween(A, B, 300, NAV), {fromX: 490, toX: 540});
  // 从左边看：A 在 B 右边、B 在 A 左边，近端是 a0 / b1
  assert.deepEqual(jumpBetween(B, A, 700, NAV), {fromX: 540, toX: 490});
  // 间隔 120 > jumpSidePx
  eq(jumpBetween(A, win(21, 450, 600, 900), 300, NAV), null);
});

test('jumpBetween：往上超过 jumpUpPx → null（平着不受限制）', () => {
  eq(jumpBetween(floor(1040, 0, 1920), win(10, 500, 100, 900), 500, NAV), null);
  // 往下多少都行：地面 → 更高的那一支不管，往下没有限制（见下一个测试）
  assert.notEqual(jumpBetween(win(10, 500, 100, 900), floor(1040, 0, 1920), 500, NAV), null);
});

test('jumpBetween：往下 → 落点在 A 的范围外面（两头各一个候选），挑离 entryX 近的；横向超过 → null', () => {
  const A = win(10, 300, 100, 500);   // 可站 [110, 490]
  const B = floor(1040, 0, 1920);
  // 左候选：从 a0 跳下去，落在 A.x0 - hw = 90；右候选：从 a1 落到 A.x1 + hw = 510
  assert.deepEqual(jumpBetween(A, B, 120, NAV), {fromX: 110, toX: 90});
  assert.deepEqual(jumpBetween(A, B, 480, NAV), {fromX: 490, toX: 510});
  // 落点正下方在 A 的范围里：不往下穿，两个候选都做不成
  eq(jumpBetween(A, win(20, 600, 200, 400), 300, NAV), null);
  // 下面的线段只在很右边：横向差 220 > jumpSidePx
  eq(jumpBetween(A, floor(1040, 700, 1000), 300, NAV), null);
});

// ---------- jumpBetween：窗口里面（inside） ----------

test('jumpBetween：进窗口里面只能从同一个窗口的顶边 jump 进去', () => {
  const r = rect(100, 300, 900, 700);
  const A = win(10, 300, 100, 900, r);
  const B = insideOf(10, r);   // y = 698，可站 [112, 888]
  assert.deepEqual(jumpBetween(A, B, 400, NAV), {fromX: 400, toX: 400});
  // entryX 在窗口里面底边的可站范围外面：夹进去
  assert.deepEqual(jumpBetween(A, B, 50, NAV), {fromX: 112, toX: 112});
  // 别的窗口的顶边、地面跳不进去
  eq(jumpBetween(win(11, 300, 100, 900), B, 400, NAV), null);
  eq(jumpBetween(floor(1040, 0, 1920), B, 400, NAV), null);
  // 窗口里面之间不直接连
  eq(jumpBetween(B, insideOf(11, rect(1200, 300, 1800, 700)), 400, NAV), null);
});

test('jumpBetween：从窗口里面回同窗口的顶边要 rise ≤ jumpUpPx', () => {
  const short = rect(100, 600, 900, 700);   // 顶边 600，里面底边 698 → 高 98
  assert.deepEqual(jumpBetween(insideOf(10, short), win(10, 600, 100, 900, short), 500, NAV), {fromX: 500, toX: 500});
  // 正常高度的窗口（顶边 300 → 里面底边 698）跳不上去
  const tall = rect(100, 300, 900, 700);
  eq(jumpBetween(insideOf(10, tall), win(10, 300, 100, 900, tall), 500, NAV), null);
});

test('jumpBetween：从窗口里面回顶边，顶边只剩和里面那段横着不重叠的一截 → null（起跳点两段都要包住；回归：以前给出里面那段外的起跳点）', () => {
  const short = rect(100, 600, 900, 700);
  // 里面那段左右各收 40（可站 150..850）；顶边被别的窗口切得只剩 100..130（可站 110..120）
  eq(jumpBetween(insideOf(10, short, 40), win(10, 600, 100, 130, short), 500, NAV), null);
});

test('jumpBetween：从窗口里面侧边出去，落点在窗口矩形外面（左右各一个候选）', () => {
  const r = rect(100, 300, 900, 700);
  const A = insideOf(10, r);   // 可站 [112, 888]
  const B = floor(1040, 0, 1920);
  assert.deepEqual(jumpBetween(A, B, 400, NAV), {fromX: 112, toX: 90});
  assert.deepEqual(jumpBetween(A, B, 800, NAV), {fromX: 888, toX: 910});
  // 落在别的窗口顶边（在窗口右边、跳得上去）：落点往 B 的可站范围里夹，夹完还在窗口外面就行
  assert.deepEqual(jumpBetween(A, win(20, 650, 920, 1400), 800, NAV), {fromX: 888, toX: 930});
  // 那个窗口太高（rise 198 > jumpUpPx）：出不去
  eq(jumpBetween(A, win(21, 500, 920, 1400), 800, NAV), null);
});

test('hasExit：两边贴屏幕边、顶边放不下（最大化）→ 没出口；一边能跳出去、矮窗口能跳回顶边 → 有（2026-10-21 用户选的 C）', () => {
  const F = floor(1040, 0, 1920);
  // 最大化：窗口两边就是地面两头，侧边落点都在窗口里；顶边在屏幕顶，没有 win:10
  const max = rect(0, 0, 1920, 1040);
  eq(hasExit([F, insideOf(10, max)], insideOf(10, max), NAV), false);
  // 左边贴屏幕边、右边能落到地面
  const half = rect(0, 300, 1200, 1040);
  eq(hasExit([F, insideOf(10, half)], insideOf(10, half), NAV), true);
  // 铺满屏幕宽但矮：跳回顶边（rise 98 ≤ 100）
  const low = rect(0, 600, 1920, 700);
  eq(hasExit([F, win(10, 600, 0, 1920, low), insideOf(10, low)], insideOf(10, low), NAV), true);
  // 一样宽但高（rise 398）：没出口
  const tall = rect(0, 300, 1920, 700);
  eq(hasExit([F, win(10, 300, 0, 1920, tall), insideOf(10, tall)], insideOf(10, tall), NAV), false);
  // 别的窗口里面不算出口
  eq(hasExit([insideOf(10, max), insideOf(11, rect(100, 300, 900, 700))], insideOf(10, max), NAV), false);
});

// ---------- findRoute ----------

test('findRoute：同一段上只有一步 walk；已经在目标点就没有步骤', () => {
  const f = floor(1040, 0, 1920);
  const r = findRoute([f], {key: 'floor:1', x: 100}, [{key: 'floor:1', x: 300}], NAV)!;
  assert.deepEqual(r.moves, [{kind: 'walk', x: 300}]);
  eq(r.jumps, 0);
  close(r.sec, 2);   // 200 px / 100 px/s

  const at = findRoute([f], {key: 'floor:1', x: 300}, [{key: 'floor:1', x: 300}], NAV)!;
  assert.deepEqual(at.moves, []);
  close(at.sec, 0);
});

test('findRoute：要跳两次才到 → walk / jump / walk / jump / walk', () => {
  const supports = [floor(1000, 0, 300), win(10, 960, 300, 600), win(11, 920, 300, 600)];
  const r = findRoute(supports, {key: 'floor:1', x: 100}, [{key: 'win:11', x: 450}], NAV_LOW)!;
  assert.deepEqual(r.moves, [
    {kind: 'walk', x: 290},
    {kind: 'jump', fromX: 290, to: {key: 'win:10', x: 310, y: 960}},
    {kind: 'walk', x: 310},
    {kind: 'jump', fromX: 310, to: {key: 'win:11', x: 310, y: 920}},
    {kind: 'walk', x: 450},
  ]);
  eq(r.jumps, 2);
  // 走 1.9 + 跳 (0.5 + 空中 0.5464) + 走 0 + 跳 (0.5 + 0.5464) + 走 1.4
  close(r.sec, 5.392820323027551);
});

test('findRoute：两条路挑用时少的', () => {
  const supports = [
    floor(1000, 0, 1000),
    win(10, 960, 0, 200),      // 左边一条低的路：从地面起跳要走过去很远
    win(20, 960, 500, 1000),   // 右边一条：就在她现在站的附近
    win(30, 920, 100, 600),    // 目标
  ];
  const r = findRoute(supports, {key: 'floor:1', x: 500}, [{key: 'win:30', x: 500}], NAV_LOW)!;
  // 走右边：地面 → win:20 → win:30
  assert.deepEqual(jumpKeys(r), ['win:20', 'win:30']);
  eq(kinds(r).join(), 'walk,jump,walk,jump,walk');
  close(r.sec, 2.2928203230275512);   // 走 0.1 + 跳 1.0464 + 跳 1.0464 + 走 0.1
  // 地面直接跳 win:30 太高（rise 80 > jumpUpPx 50），所以必须先经过一条低的线段；
  // 把 jumpUpPx 再压低到 30，两条低线段也上不去 → 到不了
  eq(findRoute(supports, {key: 'floor:1', x: 500}, [{key: 'win:30', x: 500}], {...NAV_LOW, jumpUpPx: 30}), null);
});

test('findRoute：目标在窗口里面（in:W）时经过 W 的顶边跳进去', () => {
  const r = rect(100, 600, 900, 1000);
  const supports = [win(20, 650, 0, 1920), win(10, 600, 100, 900, r), insideOf(10, r), floor(1040, 0, 1920)];
  const route = findRoute(supports, {key: 'win:20', x: 500}, [{key: 'in:10', x: 500}], NAV)!;
  // win:20 → win:10 → in:10；不能从别的线段直接跳进窗口里面
  assert.deepEqual(jumpKeys(route), ['win:10', 'in:10']);
  eq(route.jumps, 2);
  close(route.sec, 2.688496094730391);
  // 站在地面（比窗口顶边低得多）到不了里面
  eq(findRoute(supports, {key: 'floor:1', x: 500}, [{key: 'in:10', x: 500}], NAV), null);
});

test('findRoute：到不了 → null；起点 key 不在、goals 空 → null', () => {
  const near = floor(1040, 0, 1920);
  const far = sup('floor:2', 'floor', 1040, 3000, 3840);   // 中间隔了 1100 px
  eq(findRoute([near, far], {key: 'floor:1', x: 500}, [{key: 'floor:2', x: 3400}], NAV), null);
  eq(findRoute([near], {key: 'win:99', x: 500}, [{key: 'floor:1', x: 300}], NAV), null);
  eq(findRoute([near], {key: 'floor:1', x: 500}, [], NAV), null);
});

// ---------- jumpTargets、flightSec ----------

test('jumpTargets：每段一个落点；站在窗口顶边时窗口里面也在一跳能到的里面，在窗口里面时只挑窗口外面的', () => {
  const r = rect(100, 300, 900, 700);
  const A = win(10, 300, 100, 900, r), B = insideOf(10, r), F = floor(1040, 0, 1920);
  const fromWin = jumpTargets([A, B, F], {key: 'win:10', x: 500}, NAV);
  assert.deepEqual(fromWin.map(j => j.support.key), ['in:10', 'floor:1']);
  assert.deepEqual(fromWin.map(j => [j.fromX, j.toX]), [[500, 500], [110, 90]]);
  // 在窗口里面：同窗口顶边 rise 198 > jumpUpPx 跳不上去，只剩地面；落点在窗口矩形外面（rect.left - hw = 90）
  const fromInside = jumpTargets([A, B, F], {key: 'in:10', x: 500}, NAV);
  assert.deepEqual(fromInside.map(j => [j.support.key, j.fromX, j.toX]), [['floor:1', 112, 90]]);
});

test('flightSec：上升 / 下降的算式（顶点比两头较高的那头再高 arcPx）', () => {
  // 同一个高度：升到 y-arc 再落回来 = 2 × √(2 × arc / g)
  close(flightSec(500, 500, NAV), 0.4);
  // 往下 100（200 → 300）：顶点 180，先升 20 再落 120
  close(flightSec(200, 300, NAV), 0.2 + Math.sqrt(0.24));
  // 往上 100（300 → 200）一样长
  close(flightSec(300, 200, NAV), 0.6898979485566356);
  // 落得远：100 → 1000，顶点 80，升 20 落 920
  close(flightSec(100, 1000, NAV), 0.2 + Math.sqrt(1.84));
  // arcPx = 0 时就是自由落体：从顶点直接开始
  close(flightSec(300, 500, {...NAV, arcPx: 0}), Math.sqrt(2 * 200 / NAV.gravityPx));
});

// ---------- 回归（2026-10-21 报告 B：findRoute 在同一段上有几个目标时取最近的） ----------

test('findRoute：同一段上有几个目标时走到离进入点最近的那个（回归：以前取第一个）', () => {
  const f = floor(1000, 0, 1920);
  // 报告里的复现：先走到 1900（18 秒）而不是 120（0.2 秒）
  const r = findRoute([f], {key: 'floor:1', x: 100}, [{key: 'floor:1', x: 1900}, {key: 'floor:1', x: 120}], NAV)!;
  assert.deepEqual(r.moves, [{kind: 'walk', x: 120}]);
  close(r.sec, 0.2);
  // 顺序反过来、最近的写在最后也一样
  const r2 = findRoute([f], {key: 'floor:1', x: 100}, [{key: 'floor:1', x: 120}, {key: 'floor:1', x: 1900}], NAV)!;
  assert.deepEqual(r2.moves, [{kind: 'walk', x: 120}]);
  close(r2.sec, 0.2);
});

test('findRoute：目标分在两段上时，按用时挑最近的那个（同一段上也要挑最近的目标）', () => {
  // 站在地面 500：地面上的 520 走 0.2 秒，win:10 上的 500 要先跳上去（0.5 + 空中）
  const supports = [floor(1000, 0, 1000), win(10, 960, 0, 1000)];
  const r = findRoute(supports, {key: 'floor:1', x: 500},
    [{key: 'win:10', x: 500}, {key: 'floor:1', x: 900}, {key: 'floor:1', x: 520}], NAV)!;
  assert.deepEqual(r.moves, [{kind: 'walk', x: 520}]);
  close(r.sec, 0.2);
  eq(r.jumps, 0);
  // 只留 win:10 上的目标时跳上去
  const up = findRoute(supports, {key: 'floor:1', x: 500}, [{key: 'win:10', x: 500}], NAV)!;
  assert.deepEqual(jumpKeys(up), ['win:10']);
});
