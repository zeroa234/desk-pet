// 被别的窗口盖住的反应（docs/desktop-interaction.md §2.7，2026-10-21 主代理做的）的单测：
//   world/visibility.ts 的 coverAlong（采样、比例、线段太短）；main/sim.ts 的 trackCover（3 秒、只发一次、0.3–0.5 防抖、
//   空中 / behind 层算 0、front 层只认 overlayAbove、inside 层只认 W 上面的窗口）、view() 的 env.covered / coveredSec、
//   被打断 / 不打断（R18、反应计划、双人）、步骤模板 emerge / peek / hideHere、就地躲着被发现（挪开窗口 / 被点到）、
//   行为的 discovered 规则（接着做完、在窗口里面时层不变）、双人开播时被盖住。
// 规则见 src/behavior/mind.ts 的 StepTemplate 注释、src/main/sim.ts 的 coverInterruptible / trackCover。
// 用假角色包 + 假场景（tests/helpers/fake-scene.ts）、假桌面（tests/helpers/fake-desktop.ts），不读 packs/ 下的导出生成物；
// 显示器 1920×1080、任务栏 40 px（地面 y = 1040）、角色高 120、半宽 30；时间按 1/30 秒推进，rng 固定种子。
import test from 'node:test';
import assert from 'node:assert/strict';

import {Brain, DEFAULT_TUNING, setPlan, type Actor, type MindConfig, type Step, type StepTemplate, type Tuning} from '../src/behavior/index.ts';
import {Sim, type SimEvent} from '../src/main/sim.ts';
import type {DisplayInfo, Point, WinInfo} from '../src/shared/types.ts';
import {coverAlong, coveredFraction} from '../src/world/index.ts';
import {DT, FLOOR_Y, SCENE_VARIANT, drive, makeDuo, makePack} from './helpers/fake-scene.ts';
import {makeDisplay, makeWindow, mulberry32, rect} from './helpers/fake-desktop.ts';
import {close, eq} from './helpers/assert.ts';

// ---------- 公共夹具 ----------

/** 1920×1080、100% 缩放、任务栏 40 px（地面 y = 1040） */
const DISPLAY = makeDisplay(1, rect(0, 0, 1920, 1080));
/** 整个屏幕的置顶窗口：盖住任何站着的角色 */
const FULL = makeWindow(20, rect(0, 0, 1920, 1080), {topmost: true});
/** 地面上一块：x 300..800、底边伸到屏幕外，站在 x = 500 时整个身子被盖住 */
const PART = makeWindow(30, rect(300, 700, 800, 1080), {topmost: true});
/** 地面上一块：站在 x = 500 时正好盖住包围盒的一半（0.5） */
const HALF = makeWindow(40, rect(500, 800, 1500, 1080), {topmost: true});
/** 地面上一块：站在 x = 500 时盖住 0.4（落在 0.3–0.5 的防抖区间里） */
const PART04 = makeWindow(41, rect(506, 800, 1500, 1080), {topmost: true});
/** 一个能进人的窗口（里面底边 y = 698、x 102..898） */
const WIN = makeWindow(10, rect(100, 300, 900, 700));

/** 站着不动 100 秒的脑子 */
function idleMind(): MindConfig {
  return {schema: 1, stats: {}, behaviors: [{id: 'idle', weight: 1, steps: [{do: 'idle', sec: [100, 100]}]}]};
}

/** 空着的时候被盖住就换成的行为（只在 coveredSec ≥ 3 时可选）：就地躲着 100 秒 */
function coveredHideMind(id = 'go'): MindConfig {
  return {schema: 1, stats: {}, behaviors: [
    {id, weight: 1_000_000, when: {'>=': [{'var': 'env.coveredSec'}, 3]}, cooldown: 100_000, steps: [{do: 'hideHere', sec: [100, 100]}]},
    {id: 'idle', weight: 1, steps: [{do: 'idle', sec: [100, 100]}]},
  ]};
}

interface Solo {
  sim: Sim;
  a: Actor;
  display: DisplayInfo;
  brain: Brain;
  log: {t: number; id: string; e: SimEvent}[];
  /** 推进一帧（DT），把事件追加进 log 并返回 */
  frame(): {id: string; e: SimEvent}[];
  ticks(n?: number): void;
  /** 推进到条件成立（先看现在，再一帧一帧走）；超时抛错 */
  until(pred: () => boolean, what: string, maxFrames?: number): void;
}

/** 造一个单个角色的 Sim（假角色包 's'、1920×1080 显示器、固定种子）；windows / overlay 就是快照里的 */
function makeSolo(opts: {mind: MindConfig; windows?: WinInfo[]; overlay?: Record<number, readonly number[]>; at?: Point}): Solo {
  const tuning: Tuning = {...DEFAULT_TUNING, idleSec: [0, 0], walkMaxSec: 600};
  const pack = makePack({id: 's', mind: opts.mind});
  const sim = new Sim([pack], tuning, {variant: SCENE_VARIANT, heightLogical: 120, r18: true}, mulberry32(3),
    {unlocked: [], playSeconds: 0, chars: {s: {stats: {}, relations: {}}}}, new Map());
  sim.setDesktop({displays: [DISPLAY], windows: opts.windows ?? [], ...(opts.overlay ? {overlayAbove: opts.overlay} : {})});
  sim.spawn('s', opts.at ?? {x: 500, y: FLOOR_Y});
  const log: {t: number; id: string; e: SimEvent}[] = [];
  const frame = (): {id: string; e: SimEvent}[] => {
    const evs = sim.step(sim.now + DT, DT);
    for (const x of evs) log.push({t: sim.now, id: x.id, e: x.e});
    return evs;
  };
  const ticks = (n = 1): void => { for (let i = 0; i < n; i++) frame(); };
  const until = (pred: () => boolean, what: string, maxFrames = 600): void => {
    for (let i = 0; i < maxFrames; i++) {
      if (pred()) return;
      frame();
    }
    if (!pred()) throw new Error(`跑了 ${maxFrames} 帧还没到${what}（state ${a.state} / 计划 ${a.plan?.behavior ?? '—'} / 支持 ${a.support?.key ?? '—'}）`);
  };
  const a = sim.charOf('s')!.actor!;
  return {sim, a, display: DISPLAY, brain: sim.charOf('s')!.brain, log, frame, ticks, until};
}

/** 换桌面快照（窗口 + 覆盖窗口上面的窗口）；overlay 不给 = 没有别的窗口压在上面 */
function setDesktop(fx: Solo, windows: WinInfo[], overlay?: Record<number, readonly number[]>): void {
  fx.sim.setDesktop({displays: [fx.display], windows, ...(overlay ? {overlayAbove: overlay} : {})});
}

/** 拎起来放进窗口里面（脚底 690）松手，等她落到 in:W 上（不一定是 idle：她可能马上去做别的） */
function putInside(fx: Solo, x = 500): void {
  fx.sim.grab('s', {x: fx.a.x, y: fx.a.y});
  fx.sim.drag({x, y: 690});
  fx.sim.release();
  fx.until(() => fx.a.support?.kind === 'inside', '落到窗口里面的底边', 300);
}

/** log 里某类事件的条数 */
function count(fx: Solo, type: SimEvent['type']): number {
  return fx.log.filter(x => x.e.type === type).length;
}

// ---------- 1. coverAlong（纯函数） ----------

test('coverAlong：从 x0+margin 采到 x1-margin，终点不在步长上也采一次，比例按包围盒算', () => {
  // 支撑线 [0, 100]、margin 10：采样点 10, 30, 50, 70, 90；box 是从 x 起 10 宽的方块，被 [0, 0, 10, 10] 盖住
  const support = {x0: 0, x1: 100};
  const box = (x: number) => rect(x, 0, x + 10, 10);
  const covers = [rect(0, 0, 10, 10)];
  const spots = coverAlong(support, box, covers, 20, 10);
  assert.deepEqual(spots.map(s => s.x), [10, 30, 50, 70, 90]);
  // x = 10 时 box 10..20 碰不到 cover（只贴边）→ 0；x = 0 才整个被盖住
  assert.deepEqual(spots.map(s => s.cover), [0, 0, 0, 0, 0]);
  assert.deepEqual(coverAlong({x0: -20, x1: 20}, box, covers, 10, 10).map(s => [s.x, s.cover]), [[-10, 0], [0, 1], [10, 0]]);

  // 终点不在步长上：支撑线 [0, 105]、margin 10 → 10..95，最后补一个 95（不是 90 就停）
  const end = coverAlong({x0: 0, x1: 105}, box, covers, 20, 10);
  assert.deepEqual(end.map(s => s.x), [10, 30, 50, 70, 90, 95]);

  // 比例：cover 是 [5, 0, 15, 10]，x = 10 时 box 10..20 有 5 宽在盖住范围里
  const half = coverAlong({x0: 0, x1: 30}, x => rect(x, 0, x + 10, 10), [rect(5, 0, 15, 10)], 10, 0);
  assert.deepEqual(half.map(s => [s.x, s.cover]), [[0, 0.5], [10, 0.5], [20, 0], [30, 0]]);
});

test('coverAlong：线段比 2×margin 短时只取线段中点算一次；step 不是正数时返回空', () => {
  const box = (x: number) => rect(x, 0, x + 10, 10);
  const covers = [rect(100, 0, 200, 10)];
  // [100, 105]、margin 10：x0+margin 110 > x1-margin 95，只取中点 102.5
  const short = coverAlong({x0: 100, x1: 105}, box, covers, 20, 10);
  assert.deepEqual(short.map(s => [s.x, s.cover]), [[102.5, 1]]);
  // 正好 2×margin 的还剩一个点
  assert.deepEqual(coverAlong({x0: 100, x1: 120}, box, covers, 20, 10).map(s => s.x), [110]);
  // 非法 step 不进死循环
  assert.deepEqual(coverAlong({x0: 0, x1: 100}, box, covers, 0, 10), []);
  assert.deepEqual(coverAlong({x0: 0, x1: 100}, box, covers, -5, 10), []);
});

// ---------- 2. trackCover ----------

test('trackCover：盖住不到 3 秒不发 covered；到了发一次，同一回不会再发', () => {
  const fx = makeSolo({mind: coveredHideMind(), windows: [FULL], overlay: {1: [20]}});
  fx.until(() => fx.a.state === 'idle', '站稳');
  const since = fx.sim.charOf('s')!.cover.since;
  assert.ok(since !== null, '站稳以后应该开始算被盖住的秒数');

  // 到 2.8 秒：一次都没发
  while (fx.sim.now - since! < 2.8) fx.frame();
  eq(count(fx, 'covered'), 0, '不到 3 秒就发了');
  eq(fx.a.plan?.behavior, 'idle', '不到 3 秒就换了计划');

  // 到 3 秒以后：发一次，cover 1、hwnd 是盖住她的窗口
  fx.until(() => count(fx, 'covered') > 0, 'covered 事件', 30);
  const first = fx.log.find(x => x.e.type === 'covered')!;
  const elapsed = first.t - since!;
  assert.ok(elapsed >= 3 - 1e-6 && elapsed <= 3 + 2 * DT, `第一回等了 ${elapsed.toFixed(3)} 秒，应该在 3 秒左右`);
  assert.deepEqual(first.e, {type: 'covered', cover: 1, hwnd: 20});

  // 继续盖着 5 秒：同一回只发一次
  fx.ticks(150);
  eq(count(fx, 'covered'), 1, '同一回发了不止一次');
});

test('trackCover：露出来（不到 0.3）再盖住会再发一次', () => {
  const fx = makeSolo({mind: coveredHideMind(), windows: [FULL], overlay: {1: [20]}});
  fx.until(() => count(fx, 'covered') > 0, '第一次 covered');
  eq(count(fx, 'covered'), 1);

  // 拿掉覆盖窗口（front 层没有别的窗口压在上面）→ 比例 0，重来
  setDesktop(fx, [FULL]);
  fx.ticks(5);
  eq(fx.sim.charOf('s')!.cover.since, null, '露出来以后计时应该清掉');

  // 再盖住：3 秒后再发一次
  setDesktop(fx, [FULL], {1: [20]});
  fx.until(() => count(fx, 'covered') > 1, '第二次 covered', 150);
  eq(count(fx, 'covered'), 2, '第二回应该只再发一次');
  const second = fx.log.filter(x => x.e.type === 'covered')[1];
  assert.deepEqual(second.e, {type: 'covered', cover: 1, hwnd: 20});
});

test('trackCover：0.3–0.5 之间不重置计时（防抖），到 3 秒照样发，cover 是当时的比例', () => {
  const fx = makeSolo({mind: coveredHideMind(), windows: [FULL], overlay: {1: [20]}});
  fx.until(() => fx.a.state === 'idle', '站稳');
  const since = fx.sim.charOf('s')!.cover.since!;

  // 整个盖住 2 秒
  while (fx.sim.now - since < 2) fx.frame();
  eq(count(fx, 'covered'), 0);
  // 换成只盖 0.4 的窗口：0.3 ≤ 0.4 < 0.5，既不重置也不算“刚开始盖住”
  setDesktop(fx, [PART04], {1: [41]});
  fx.frame();
  close(fx.sim.charOf('s')!.cover.frac, 0.4, 1e-9, '换窗口以后盖住的比例');

  // 到 3 秒（从第一次盖住算起）就发，不是又等 3 秒
  fx.until(() => count(fx, 'covered') > 0, 'covered 事件', 60);
  const first = fx.log.find(x => x.e.type === 'covered')!;
  const elapsed = first.t - since;
  assert.ok(elapsed >= 3 - 1e-6 && elapsed <= 3 + 2 * DT, `防抖以后 ${elapsed.toFixed(3)} 秒才发，应该在 3 秒左右`);
  assert.deepEqual(first.e, {type: 'covered', cover: 0.4, hwnd: 41});
});

test('trackCover：在空中（fall / jump / dragged）算 0，即使包围盒在覆盖窗口里', () => {
  // fall：从半空掉下来
  const fall = makeSolo({mind: coveredHideMind(), windows: [FULL], overlay: {1: [20]}, at: {x: 500, y: 500}});
  for (let i = 0; i < 5; i++) {
    fall.frame();
    eq(fall.a.state, 'fall');
    eq(fall.sim.charOf('s')!.cover.frac, 0, '下落时不该算被盖住');
    eq(fall.sim.view(fall.sim.charOf('s')!).env.covered, 0);
  }
  eq(count(fall, 'covered'), 0);

  // dragged：站在覆盖窗口里被拎起来
  const drag = makeSolo({mind: coveredHideMind(), windows: [FULL], overlay: {1: [20]}});
  drag.until(() => drag.a.state === 'idle', '站稳');
  drag.sim.grab('s', {x: drag.a.x, y: drag.a.y - 60});
  for (let i = 0; i < 5; i++) {
    drag.frame();
    eq(drag.a.state, 'dragged');
    eq(drag.sim.charOf('s')!.cover.frac, 0, '被拎着时不该算被盖住');
  }
  eq(count(drag, 'covered'), 0);

  // jump：站在地面上原地跳一下（落点还是这条地面），空中不算被盖住
  const jump = makeSolo({mind: idleMind(), windows: [FULL], overlay: {1: [20]}});
  jump.until(() => jump.a.state === 'idle' && jump.a.support?.key === 'floor:1', '站稳');
  const c = jump.sim.charOf('s')!;
  setPlan(jump.a, c.spec, {behavior: 'j', steps: [{state: 'jump', jump: {key: 'floor:1', x: 500}}]}, jump.sim.ctx(), 'test');
  eq(jump.a.state, 'jump');
  let sawAir = false;
  for (let i = 0; i < 60 && jump.a.state === 'jump'; i++) {
    jump.frame();
    if (!jump.a.support) {
      sawAir = true;
      eq(jump.sim.charOf('s')!.cover.frac, 0, '跳在空中时不该算被盖住');
    }
  }
  assert.ok(sawAir, '没看到跳在空中的帧');
  eq(count(jump, 'covered'), 0, '跳一下不到 3 秒，不该发 covered');
});

test('trackCover：躲在窗口后面（behind 层）算 0；front 层只认 overlayAbove 里的窗口', () => {
  // behind 层：本来就该被挡着，不算“被别的窗口盖住”
  const behind = makeSolo({mind: idleMind(), windows: [FULL], overlay: {1: [20]}});
  behind.until(() => behind.a.state === 'idle', '站稳');
  const bc = behind.sim.charOf('s')!;
  setPlan(behind.a, bc.spec, {behavior: 'hide', steps: [{state: 'hide', action: 'idle', sec: 1000, layer: {kind: 'behind', hwnd: 20}}]},
    behind.sim.ctx(), 'test');
  eq(behind.a.layer.kind, 'behind');
  behind.ticks(120);
  eq(count(behind, 'covered'), 0, 'behind 层不该发 covered');
  eq(bc.cover.frac, 0);

  // front：窗口 20 是置顶的、盖满整个屏幕，但不在 overlayAbove 里 → 不算
  const front = makeSolo({mind: coveredHideMind(), windows: [FULL]});
  front.ticks(150);
  eq(count(front, 'covered'), 0, '不在 overlayAbove 里的置顶窗口不该算盖住');
  eq(front.sim.charOf('s')!.cover.frac, 0);
  eq(front.sim.view(front.sim.charOf('s')!).env.covered, 0);

  // 同一个窗口加进 overlayAbove 以后才算
  setDesktop(front, [FULL], {1: [20]});
  front.until(() => count(front, 'covered') > 0, 'covered 事件', 150);
  assert.deepEqual(front.log.find(x => x.e.type === 'covered')!.e, {type: 'covered', cover: 1, hwnd: 20});
});

test('trackCover：在窗口里面（inside 层）只认 W 上面的窗口，W 下面的不算', () => {
  // W 上面压一个盖满屏幕的置顶窗口：算，盖住比例 1、hwnd 是上面那个
  const above = makeSolo({mind: coveredHideMind(), windows: [WIN]});
  putInside(above);
  above.until(() => above.a.state === 'idle', '在窗口里面站稳');
  eq(above.a.layer.kind, 'inside');
  setDesktop(above, [FULL, WIN]);
  above.until(() => count(above, 'covered') > 0, 'covered 事件', 150);
  assert.deepEqual(above.log.find(x => x.e.type === 'covered')!.e, {type: 'covered', cover: 1, hwnd: 20});

  // W 下面同样盖满屏幕的窗口：不算（inside:W 只被 z 序在 W 上面的窗口挡住）
  const below = makeSolo({mind: coveredHideMind(), windows: [WIN]});
  putInside(below);
  below.until(() => below.a.state === 'idle', '在窗口里面站稳');
  eq(below.a.layer.kind, 'inside');
  setDesktop(below, [WIN, FULL]);
  below.ticks(150);
  eq(count(below, 'covered'), 0, 'W 下面的窗口不该算盖住');
  eq(below.sim.charOf('s')!.cover.frac, 0);
  eq(below.a.layer.kind, 'inside');
});

// ---------- 3. view() 的 env.covered / coveredSec ----------

test('view().env.covered / coveredSec：比例和连续盖住的秒数都进了 view，行为按 coveredSec ≥ 3 才选得上', () => {
  // 盖住一半：covered 0.5，coveredSec 等于现在 - 开始盖住的时刻
  const half = makeSolo({mind: idleMind(), windows: [HALF], overlay: {1: [40]}});
  half.until(() => half.a.state === 'idle', '站稳');
  half.ticks(10);
  const hc = half.sim.charOf('s')!;
  assert.ok(hc.cover.since !== null, '没开始算被盖住的秒数');
  eq(half.sim.view(hc).env.covered, 0.5);
  close(half.sim.view(hc).env.coveredSec, half.sim.now - hc.cover.since!, 1e-9);

  // 整个盖住：2.8 秒时 coveredSec < 3，行为选不上；到 3 秒发 covered 的那一帧选上
  const full = makeSolo({mind: coveredHideMind(), windows: [FULL], overlay: {1: [20]}});
  full.until(() => full.a.state === 'idle', '站稳');
  const fc = full.sim.charOf('s')!;
  const since = fc.cover.since!;
  while (full.sim.now - since < 2.8) full.frame();
  eq(full.sim.view(fc).env.covered, 1);
  assert.ok(full.sim.view(fc).env.coveredSec < 3, '还没到 3 秒');
  eq(full.a.plan?.behavior, 'idle', 'coveredSec 不到 3 就选上了');
  full.until(() => count(full, 'covered') > 0, 'covered 事件', 30);
  assert.ok(full.sim.view(fc).env.coveredSec >= 3 - 1e-9);
  eq(full.a.plan?.behavior, 'go', '到了 3 秒没选上被盖住的行为');
});

// ---------- 4. 打断 / 不打断 ----------

test('打断：空着（idle 计划）被盖住 → covered 那一帧当场换成被盖住的行为', () => {
  const fx = makeSolo({mind: coveredHideMind(), windows: [FULL], overlay: {1: [20]}});
  fx.until(() => fx.a.plan?.behavior === 'idle', '先选到 idle');
  let frame: {id: string; e: SimEvent}[] = [];
  for (let i = 0; i < 150; i++) {
    frame = fx.frame();
    if (frame.some(x => x.e.type === 'covered')) break;
  }
  assert.ok(frame.some(x => x.e.type === 'covered'), '没等到 covered');
  // 同一帧里：旧的 idle 计划中止（reason covered）、新的被盖住的行为开始
  const ended = frame.find(x => x.e.type === 'plan-end')?.e;
  assert.ok(ended && ended.type === 'plan-end', '没有 plan-end 事件');
  eq(ended.behavior, 'idle');
  eq(ended.outcome, 'aborted');
  eq(ended.reason, 'covered');
  assert.ok(frame.some(x => x.e.type === 'plan' && x.e.behavior === 'go'), '同一帧里没有换计划');
  eq(fx.a.plan?.behavior, 'go');
  eq(fx.a.state, 'hide');
});

test('打断：空着、没有计划时被盖住 → 那一帧选到被盖住的行为', () => {
  // 只有被盖住时才可选的行为：平常空着、没有计划（choose 每帧都返回 null）
  const mind: MindConfig = {schema: 1, stats: {}, behaviors: [
    {id: 'go', weight: 1_000_000, when: {'>=': [{'var': 'env.coveredSec'}, 3]}, cooldown: 100_000, steps: [{do: 'hideHere', sec: [100, 100]}]},
  ]};
  const fx = makeSolo({mind, windows: [FULL], overlay: {1: [20]}});
  fx.until(() => fx.a.state === 'idle' && fx.a.plan === null, '空下来、没有计划');
  let frame: {id: string; e: SimEvent}[] = [];
  for (let i = 0; i < 150; i++) {
    frame = fx.frame();
    if (frame.some(x => x.e.type === 'covered')) break;
  }
  assert.ok(frame.some(x => x.e.type === 'covered'), '没等到 covered');
  assert.ok(frame.some(x => x.e.type === 'plan' && x.e.behavior === 'go'), '同一帧里没有选计划');
  eq(fx.a.plan?.behavior, 'go');
  eq(fx.a.state, 'hide');
});

test('打断：在做 R18 行为（计划的 r18: true）时不打断', () => {
  const mind: MindConfig = {schema: 1, stats: {}, behaviors: [
    {id: 'r18idle', weight: 1, r18: true, steps: [{do: 'idle', sec: [100, 100]}]},
    {id: 'go', weight: 1_000_000, when: {'>=': [{'var': 'env.coveredSec'}, 3]}, cooldown: 100_000, steps: [{do: 'hideHere', sec: [100, 100]}]},
  ]};
  const fx = makeSolo({mind, windows: [FULL], overlay: {1: [20]}});
  fx.until(() => fx.a.plan?.behavior === 'r18idle', '选到 r18 行为');
  eq(fx.a.state, 'idle');
  fx.until(() => count(fx, 'covered') > 0, 'covered 事件', 150);
  eq(fx.a.plan?.behavior, 'r18idle', 'covered 不该打断 r18 行为');
  fx.ticks(30);
  eq(fx.a.plan?.behavior, 'r18idle');
});

test('打断：反应计划（reaction:*）不打断', () => {
  const fx = makeSolo({mind: coveredHideMind(), windows: [FULL], overlay: {1: [20]}});
  fx.until(() => fx.a.state === 'idle', '站稳');
  const c = fx.sim.charOf('s')!;
  setPlan(fx.a, c.spec, {behavior: 'reaction:click', steps: [{state: 'idle', sec: 100}]}, fx.sim.ctx(), 'test');
  fx.until(() => count(fx, 'covered') > 0, 'covered 事件', 150);
  eq(fx.a.plan?.behavior, 'reaction:click', 'covered 不该打断反应计划');
  fx.ticks(30);
  eq(fx.a.plan?.behavior, 'reaction:click');
});

// ---------- 5. emerge ----------

/** 只在 coveredSec ≥ 3 时可选的一种被盖住的行为（解析不了就没有计划，方便断言“做不了”） */
function coveredStepMind(id: string, step: StepTemplate): MindConfig {
  return {schema: 1, stats: {}, behaviors: [
    {id, weight: 1_000_000, when: {'>=': [{'var': 'env.coveredSec'}, 3]}, cooldown: 100_000, steps: [step]},
    {id: 'idle', weight: 1, steps: [{do: 'idle', sec: [100, 100]}]},
  ]};
}

test('emerge：线段上有没被盖住的地方 → 走到最近的那个（front 层）', () => {
  const fx = makeSolo({mind: coveredStepMind('emerge', {do: 'emerge'}), windows: [PART], overlay: {1: [30]}});
  fx.until(() => fx.a.plan?.behavior === 'emerge', '选到 emerge', 150);
  // 窗口左边 300、右边 800；她站在 500，最近的露出来的地方是左边缘外一点（包围盒 245..305 只被盖住 5 像素）
  eq(fx.a.step?.state, 'walk');
  close(fx.a.step?.targetX ?? NaN, 275, 1e-9, 'emerge 走向');
  fx.until(() => fx.a.state === 'idle', '走到露出来的地方', 200);
  // 到了以后盖住的比例 ≤ EMERGE_MAX（0.15）
  const c = fx.sim.charOf('s')!;
  const cover = coveredFraction(fx.sim.boxOf(c, fx.a), [PART.rect]);
  assert.ok(cover <= 0.15 + 1e-9, `走到 x = ${fx.a.x} 还被盖住 ${cover}`);
});

test('emerge：在窗口里面整个被盖住 → 从窗口里跳出来（jump 到窗口外的线段，层回 front）', () => {
  const fx = makeSolo({mind: coveredStepMind('emerge', {do: 'emerge'}), windows: [WIN]});
  putInside(fx);
  eq(fx.a.layer.kind, 'inside');
  setDesktop(fx, [FULL, WIN]);   // 整个窗口上面又盖了一个
  fx.until(() => fx.a.plan?.behavior === 'emerge', '选到 emerge', 200);
  // 窗口里面整条线段都被盖住、没有露出来的地方 → 计划里有跳到窗口外面（地面上 x < 窗口左边 100）的 jump
  const steps = [fx.a.step, ...(fx.a.plan?.steps ?? [])].filter((s): s is Step => !!s);
  const jump = steps.find(s => s.state === 'jump');
  assert.ok(jump, '计划里没有跳');
  eq(jump.jump?.key, 'floor:1');
  assert.ok((jump.jump?.x ?? Infinity) < 100, `跳到 ${jump.jump?.x}，应该在窗口左边外面`);
  // 跳出去以后层回 front、落在地面上
  fx.until(() => fx.a.support?.kind === 'floor' && fx.a.state === 'idle', '跳出来站稳', 500);
  eq(fx.a.layer.kind, 'front');
  eq(fx.a.support?.key, 'floor:1');
  close(fx.a.y, FLOOR_Y, 1e-9);
});

test('emerge：front 层整条线段都被盖住 → 做不了（计划解析失败，不会卡死）', () => {
  // 只有 emerge 一个行为：解析不了就没有计划（没有 idle 兜底）
  const mind: MindConfig = {schema: 1, stats: {}, behaviors: [
    {id: 'emerge', weight: 1_000_000, when: {'>=': [{'var': 'env.coveredSec'}, 3]}, cooldown: 100_000, steps: [{do: 'emerge'}]},
  ]};
  const fx = makeSolo({mind, windows: [FULL], overlay: {1: [20]}});
  fx.until(() => count(fx, 'covered') > 0, 'covered 事件', 150);
  fx.ticks(90);
  eq(fx.a.plan, null, '整条线段都被盖住时不该有计划');
  eq(fx.a.state, 'idle');
  // 还在继续跑（没有卡死）：时间往前走、没有新的 covered
  const now = fx.sim.now;
  fx.ticks(30);
  assert.ok(fx.sim.now > now);
  eq(count(fx, 'covered'), 1);
});

// ---------- 6. peek ----------

test('peek：走到盖住比例在区间里最近的点，朝露出来的那边', () => {
  const fx = makeSolo({mind: coveredStepMind('peek', {do: 'peek', sec: [1, 1]}), windows: [PART], overlay: {1: [30]}});
  fx.until(() => fx.a.plan?.behavior === 'peek', '选到 peek', 150);
  // 最近的点是 305（包围盒 275..335 被盖住 35/60 = 0.583）；再往左就低于 0.35 了
  eq(fx.a.step?.state, 'walk');
  eq(fx.a.step?.targetX, 305);
  // 下一步探头朝左（左边露出来）
  eq(fx.a.plan?.steps[0]?.state, 'act');
  eq(fx.a.plan?.steps[0]?.facing, -1);
  fx.until(() => fx.a.state === 'act', '开始探头', 200);
  eq(fx.a.action, 'idle');
  eq(fx.a.facing, -1);
  const c = fx.sim.charOf('s')!;
  const cover = coveredFraction(fx.sim.boxOf(c, fx.a), [PART.rect]);
  assert.ok(cover >= 0.35 - 1e-9 && cover <= 0.65 + 1e-9, `探头位置被盖住 ${cover}，不在 [0.35, 0.65] 里`);
});

test('peek：没有盖住比例在区间里的点 → 做不了', () => {
  // 整个屏幕都盖住：所有采样点都是 1，没有 [0.35, 0.65] 的地方；只有 peek 一个行为，解析不了就没有计划
  const mind: MindConfig = {schema: 1, stats: {}, behaviors: [
    {id: 'peek', weight: 1_000_000, when: {'>=': [{'var': 'env.coveredSec'}, 3]}, cooldown: 100_000, steps: [{do: 'peek'}]},
  ]};
  const fx = makeSolo({mind, windows: [FULL], overlay: {1: [20]}});
  fx.until(() => count(fx, 'covered') > 0, 'covered 事件', 150);
  fx.ticks(60);
  eq(fx.a.plan, null, '没有合适的点不该有计划');
  eq(fx.a.state, 'idle');
});

// ---------- 7. hideHere（就地躲着） ----------

/** 就地躲着：hideHere 一个步骤 + 被发现时换成 reaction:discovered 的反应；mood 初值 50 用来断言效果 */
function hideHereMind(sec: [number, number]): MindConfig {
  return {schema: 1, stats: {mood: {start: 50}}, reactions: {
    discovered: {steps: [{do: 'play', action: 'idle', sec: [0.5, 0.5], state: 'discovered', fx: 'alert'}], effects: {'stats.mood': -3}},
  }, behaviors: [
    {id: 'hide', weight: 1_000_000, cooldown: 100_000, steps: [{do: 'hideHere', sec}]},
    {id: 'idle', weight: 1, steps: [{do: 'idle', sec: [100, 100]}]},
  ]};
}

test('hideHere：盖住的窗口挪开（比例 < 0.12）→ 被发现（plan-end aborted exposed、reaction:discovered）', () => {
  const fx = makeSolo({mind: hideHereMind([100, 100]), windows: [FULL], overlay: {1: [20]}});
  fx.until(() => fx.a.plan?.behavior === 'hide', '选到 hideHere 行为');
  eq(fx.a.state, 'hide');
  eq(fx.sim.charOf('s')!.coverHide?.hwnd, 20);

  // 拿掉覆盖窗口 → 露出来（0 < 0.12）
  setDesktop(fx, [FULL]);
  const frame = fx.frame();
  const d = frame.find(x => x.e.type === 'discovered')?.e;
  assert.ok(d && d.type === 'discovered', '没有 discovered 事件');
  eq(d.hwnd, 20);
  eq(d.cover, 0);
  eq(d.by, undefined);
  eq(d.continued, undefined);
  const ended = frame.find(x => x.e.type === 'plan-end' && x.e.behavior === 'hide')?.e;
  assert.ok(ended && ended.type === 'plan-end', '旧计划没有中止');
  eq(ended.outcome, 'aborted');
  eq(ended.reason, 'exposed');
  // 换成反应计划，coverHide 清掉，反应效果照算
  eq(fx.a.plan?.behavior, 'reaction:discovered');
  eq(fx.a.state, 'discovered');
  eq(fx.sim.charOf('s')!.coverHide, null);
  eq(fx.brain.stats.mood, 47);
});

test('hideHere：被点到 → 被发现（by click）', () => {
  const fx = makeSolo({mind: hideHereMind([100, 100]), windows: [FULL], overlay: {1: [20]}});
  fx.until(() => fx.a.plan?.behavior === 'hide', '选到 hideHere 行为');
  // 点在没有部位图的地方：平时只是普通反应，躲着的时候算被发现
  const out = fx.sim.poke('s', null, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(out?.reaction, 'discovered');
  eq(out?.overlay, false);
  const frame = fx.frame();
  const d = frame.find(x => x.e.type === 'discovered')?.e;
  assert.ok(d && d.type === 'discovered', '没有 discovered 事件');
  eq(d.hwnd, 20);
  eq(d.by, 'click');
  eq(d.cover, undefined);
  eq(fx.a.plan?.behavior, 'reaction:discovered');
  eq(fx.sim.charOf('s')!.coverHide, null);
  eq(fx.brain.stats.mood, 47);
});

test('hideHere：计划正常做完以后 coverHide 清掉，再挪开窗口不会 discovered', () => {
  const fx = makeSolo({mind: hideHereMind([0.3, 0.3]), windows: [FULL], overlay: {1: [20]}});
  fx.until(() => fx.a.plan?.behavior === 'hide', '选到 hideHere 行为');
  eq(fx.sim.charOf('s')!.coverHide?.hwnd, 20);
  // 0.3 秒后正常做完（plan-end done），coverHide 清掉
  fx.until(() => fx.log.some(x => x.e.type === 'plan-end' && x.e.behavior === 'hide' && x.e.outcome === 'done'), 'hideHere 做完', 90);
  eq(fx.sim.charOf('s')!.coverHide, null);
  // 之后挪开覆盖窗口：不算被发现（已经不在躲了）
  setDesktop(fx, [FULL]);
  fx.ticks(30);
  eq(count(fx, 'discovered'), 0, '做完以后再挪开窗口不该被发现');
  eq(fx.sim.charOf('s')!.coverHide, null);
});

test('hideHere：行为的 discovered 规则成立、在窗口里面 → 接着做完，层保持 inside', () => {
  const mind: MindConfig = {schema: 1, stats: {mood: {start: 50}}, reactions: {
    discovered: {steps: [{do: 'play', action: 'idle', sec: [0.5, 0.5], state: 'discovered'}]},
  }, behaviors: [
    {id: 'hm', weight: 1_000_000, cooldown: 100_000, r18: true,
      steps: [{do: 'hideHere', action: 'idle', sec: [0.3, 0.3]}, {do: 'play', action: 'masturbate', state: 'masturbate', phase: 'loop', sec: [100, 100]}],
      discovered: {when: {'==': [{'var': 'self.layer'}, 'inside']}, hurry: [3, 3], fx: 'alert', effects: {'stats.mood': -5}}},
    {id: 'idle', weight: 1, steps: [{do: 'idle', sec: [100, 100]}]},
  ]};
  const fx = makeSolo({mind, windows: [WIN]});
  putInside(fx);
  eq(fx.a.layer.kind, 'inside');
  // 窗口上面再盖一个：hideHere 解析时记下主要盖住的窗口，播到 loop 段
  setDesktop(fx, [FULL, WIN]);
  fx.until(() => fx.a.state === 'masturbate' && fx.a.phase === 'loop', '播到 loop 段', 200);
  const c = fx.sim.charOf('s')!;
  eq(c.coverHide?.hwnd, 20);

  // 挪开上面的窗口 → 被发现；discovered 规则成立（self.layer == inside）→ 接着做完
  setDesktop(fx, [WIN]);
  const frame = fx.frame();
  const d = frame.find(x => x.e.type === 'discovered')?.e;
  assert.ok(d && d.type === 'discovered', '没有 discovered 事件');
  eq(d.continued, true);
  eq(d.hwnd, 20);
  eq(d.cover, 0);
  assert.ok(frame.some(x => x.e.type === 'fx' && x.e.fx === 'alert'), '没冒感叹号');
  eq(fx.a.plan?.behavior, 'hm', '接着做的时候不该换计划');
  eq(fx.a.layer.kind, 'inside', '在窗口里面接着做，层不该变');
  eq(fx.a.state, 'masturbate');
  assert.ok(fx.a.stateEnd - fx.sim.now <= 3 + 1e-9, `loop 段还剩 ${(fx.a.stateEnd - fx.sim.now).toFixed(2)} 秒，应该截到 3 秒以内`);
  eq(fx.brain.stats.mood, 45, 'discovered.effects 照算');
  eq(c.coverHide, null);

  // 接着做完：计划照常算完成
  fx.until(() => fx.log.some(x => x.e.type === 'plan-end' && x.e.behavior === 'hm' && x.e.outcome === 'done'), '把 hm 做完', 200);
});

// ---------- 8. 双人 ----------

test('双人：开播时场景被 overlayAbove 的窗口盖住一半以上 → 盖住的挪开就两人都 discovered', () => {
  const fx = makeDuo();
  const drv = drive(fx.sim);
  // 开播之前就把整个屏幕盖住：两人走到位、开播时 d.coverHide 记下主要盖住的窗口
  fx.sim.setDesktop({displays: [fx.display], windows: [FULL], overlayAbove: {1: [20]}});
  drv.until(e => e.type === 'duo' && e.what === 'play', 'play');
  eq(fx.sim.duos.length, 1);
  eq(fx.sim.duos[0].coverHide?.hwnd, 20);
  const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
  // 被盖住不打断双人（计划还是 duo:sex）
  drv.frames(5);
  eq(a.plan?.behavior, 'duo:sex');
  eq(b.plan?.behavior, 'duo:sex');

  // 挪开覆盖窗口 → 整个场景露出来 → 两人都 discovered、双人散了
  fx.sim.setDesktop({displays: [fx.display], windows: []});
  const frame = drv.frame();
  eq(fx.sim.duos.length, 0);
  assert.ok(frame.some(x => x.e.type === 'duo' && x.e.what === 'dissolved' && x.e.reason === 'exposed'), '没有 dissolved exposed');
  const disc = frame.filter(x => x.e.type === 'discovered').map(x => ({id: x.id, e: x.e as Extract<SimEvent, {type: 'discovered'}>}));
  assert.deepEqual(disc.map(x => x.id).sort(), ['a', 'b']);
  for (const x of disc) {
    eq(x.e.hwnd, 20);
    eq(x.e.cover, 0);
  }
  eq(a.plan?.behavior, 'reaction:discovered');
  eq(b.plan?.behavior, 'reaction:discovered');
  eq(a.layer.kind, 'front');
  eq(b.layer.kind, 'front');
});

test('双人：开播时没被盖住、之后才被盖住（3 秒以上）又挪开 → 不算被发现、不打断', () => {
  // 多绕几圈，让场景在盖住、挪开的过程中还没播完（40 + 6×10 = 100 帧，6.67 秒）
  const fx = makeDuo({loops: [6, 6]});
  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'play', 'play');
  eq(fx.sim.duos[0].coverHide, undefined);
  const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;

  // 开播以后才盖住：3.5 秒里两人各发一次 covered，但不该当成“躲着做”（coverHide 不设置），也不打断
  fx.sim.setDesktop({displays: [fx.display], windows: [FULL], overlayAbove: {1: [20]}});
  drv.frames(Math.ceil(3.5 / DT));
  assert.ok(drv.log.some(x => x.e.type === 'covered'), '盖住 3.5 秒应该发 covered 事件');
  eq(fx.sim.duos.length, 1);
  eq(fx.sim.duos[0].coverHide, undefined);
  eq(a.plan?.behavior, 'duo:sex');
  eq(b.plan?.behavior, 'duo:sex');

  // 挪开：露出来也不算被发现
  fx.sim.setDesktop({displays: [fx.display], windows: []});
  drv.frames(30);
  eq(fx.sim.duos.length, 1);
  eq(drv.log.filter(x => x.e.type === 'discovered').length, 0, '开播后才被盖住的不算被发现');
  eq(a.plan?.behavior, 'duo:sex');
});

// ---------- 9. 音效：coverHide 时 cue 带 behind（main.ts 按它决定要不要闷一点） ----------

test('音效：就地躲着（coverHide）时单人动作的 cue 带 behind；平常不带', () => {
  const sfx = {voice: 'v', actions: {idle: [[0, 'moan']] as [number, string][]}};
  const pack = makePack({id: 's', mind: hideHereMind([100, 100]), sfx});
  const sim = new Sim([pack], {...DEFAULT_TUNING, idleSec: [0, 0]}, {variant: SCENE_VARIANT, heightLogical: 120, r18: true}, mulberry32(3),
    {unlocked: [], playSeconds: 0, chars: {s: {stats: {}, relations: {}}}}, new Map());
  sim.setDesktop({displays: [DISPLAY], windows: [FULL], overlayAbove: {1: [20]}});
  sim.spawn('s', {x: 500, y: FLOOR_Y});
  // 走到 hideHere 计划（coverHide 设好），把之前攒的 cue 清空
  for (let i = 0; i < 60 && sim.charOf('s')!.coverHide === null; i++) sim.step(sim.now + DT, DT);
  eq(sim.charOf('s')!.coverHide?.hwnd, 20);
  sim.takeCues();
  // 再播 3 秒：idle 每圈（2 秒）第 0 帧响一次，这几条都算躲着做
  for (let i = 0; i < 90; i++) sim.step(sim.now + DT, DT);
  const cues = sim.takeCues();
  assert.ok(cues.length > 0, '3 秒里应该有 cue');
  assert.ok(cues.every(c => c.behind), '就地躲着时的 cue 应该都带 behind');

  // 对照：同一个包、没躲着（front 层）的时候 behind 是 false
  const front = new Sim([makePack({id: 's', mind: idleMind(), sfx})], {...DEFAULT_TUNING, idleSec: [0, 0]},
    {variant: SCENE_VARIANT, heightLogical: 120, r18: true}, mulberry32(3),
    {unlocked: [], playSeconds: 0, chars: {s: {stats: {}, relations: {}}}}, new Map());
  front.setDesktop({displays: [DISPLAY], windows: []});
  front.spawn('s', {x: 500, y: FLOOR_Y});
  for (let i = 0; i < 120; i++) front.step(front.now + DT, DT);
  front.takeCues();
  for (let i = 0; i < 90; i++) front.step(front.now + DT, DT);
  const normal = front.takeCues();
  assert.ok(normal.length > 0, '对照的 3 秒里应该有 cue');
  assert.ok(normal.every(c => !c.behind), '没躲着的时候不该带 behind');
});
