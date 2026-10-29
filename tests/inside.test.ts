// “在窗口里面”（N2.4，2026-10-21）和跳着进出窗口的单测：
//   computeSupports 的 inside 选项（每个非置顶窗口一段 in:<hwnd>）、跳进窗口（层 inside:W）、在窗口里面跟着窗口挪 /
//   窗口没了回 front、front 层的下落不落到 in:* 上、拎起来和松手、计划中止时的层。
// 规则见 src/world/supports.ts、src/behavior/actor.ts（landable / leaveInsideIfOut / followSupport / releaseActor）、
// docs/desktop-interaction.md §2.2–§2.4。
// 坐标都是物理像素：显示器 1920×1080、任务栏 40 px（地面 y = 1040）、角色高 120、insideInset 2。
import test from 'node:test';
import assert from 'node:assert/strict';

import {DEFAULT_TUNING, grabActor, dragActor, releaseActor, createActor, setPlan, stepActor} from '../src/behavior/index.ts';
import type {Actor, ActorEvent, ActorSpec, MindConfig, StepTemplate, Tuning} from '../src/behavior/index.ts';
import {Fluids} from '../src/fluid/index.ts';
import {Sim} from '../src/main/sim.ts';
import type {Pack} from '../src/pack/index.ts';
import {computeSupports} from '../src/world/index.ts';
import type {Support, SupportOptions} from '../src/world/index.ts';
import type {DisplayInfo, Point, WinInfo} from '../src/shared/types.ts';
import {
  SUPPORT_OPTIONS, makeDisplay, makeSnapshot, makeSpec, makeWindow, makeWorld, mulberry32, rect,
} from './helpers/fake-desktop.ts';
import type {FakeWorld} from './helpers/fake-desktop.ts';
import {DT as SIM_DT, SCENE_VARIANT, makePack} from './helpers/fake-scene.ts';
import {close, eq} from './helpers/assert.ts';

// A：1920×1080、100% 缩放、任务栏 40 px → 地面 y = 1040
const A = makeDisplay(1, rect(0, 0, 1920, 1080));
// B：紧挨 A 右边的 200% 缩放显示器（角色高 240、最短线段 160）
const B = makeDisplay(2, rect(1920, 0, 3840, 1080), 2);
const FLOOR_Y = 1040;
const HEIGHT = 120;
const RELEASE_INSIDE = 0.3;   // 松手时脚比窗口顶边低这么多个身高才算放进窗口里
const DT = 1 / 60;
/** 带窗口里面底边的支撑面参数：inset = 2 逻辑像素（同 DEFAULT_TUNING.insideInset） */
const INSIDE: SupportOptions = {...SUPPORT_OPTIONS, inside: {inset: d => 2 * d.scale}};

const insideKey = (s: Support | null | undefined) => s?.key ?? null;

// ---------- computeSupports 的 inside 选项 ----------

test('computeSupports：每个非置顶窗口一段 in:<hwnd>，y = 底边 - inset，左右各收 inset', () => {
  const w = makeWindow(10, rect(100, 300, 900, 700));
  const sup = computeSupports(makeSnapshot([A], [w]), INSIDE);
  const ins = sup.filter(s => s.kind === 'inside');
  eq(ins.length, 1);
  assert.deepEqual({key: ins[0].key, y: ins[0].y, x0: ins[0].x0, x1: ins[0].x1, displayId: ins[0].displayId, rect: ins[0].rect},
    {key: 'in:10', y: 700 - 2, x0: 102, x1: 898, displayId: 1, rect: w.rect});
});

test('computeSupports：置顶窗口没有 in:*；不给 inside 选项时和以前一样没有', () => {
  const topmost = makeWindow(10, rect(100, 300, 900, 700), {topmost: true});
  eq(computeSupports(makeSnapshot([A], [topmost]), INSIDE).filter(s => s.kind === 'inside').length, 0);
  // 同一个窗口：给了选项有，没给就没有
  const normal = makeWindow(11, rect(100, 300, 900, 700));
  eq(computeSupports(makeSnapshot([A], [normal]), INSIDE).filter(s => s.kind === 'inside').length, 1);
  eq(computeSupports(makeSnapshot([A], [normal]), SUPPORT_OPTIONS).filter(s => s.kind === 'inside').length, 0);
});

test('computeSupports：窗口不够高（< headroom + inset）、不够宽、底边在工作区下面都没有 in:*', () => {
  const snapshot = (w: WinInfo) => computeSupports(makeSnapshot([A], [w]), INSIDE).filter(s => s.kind === 'inside');
  // 高 121 < 120 + 2；高 122 刚好
  eq(snapshot(makeWindow(10, rect(100, 300, 900, 421))).length, 0);
  assert.deepEqual(snapshot(makeWindow(11, rect(100, 300, 900, 422))).map(s => [s.key, s.y]), [['in:11', 420]]);
  // 去掉 inset 以后 79 < minWidth 80；80 刚好
  eq(snapshot(makeWindow(12, rect(100, 300, 183, 700))).length, 0);
  assert.deepEqual(snapshot(makeWindow(13, rect(100, 300, 184, 700))).map(s => [s.x0, s.x1]), [[102, 182]]);
  // 底边 - inset 在工作区（y ≤ 1040）下面
  eq(snapshot(makeWindow(14, rect(100, 300, 900, 1300))).length, 0);
});

test('computeSupports：in:* 按窗口的 z 序排，排在窗口顶边后面；inset 按显示器缩放', () => {
  const ws = [
    makeWindow(10, rect(100, 300, 900, 700)),
    makeWindow(20, rect(1000, 300, 1800, 700)),
    makeWindow(30, rect(300, 500, 700, 800)),
  ];
  const sup = computeSupports(makeSnapshot([A], ws), INSIDE);
  assert.deepEqual(sup.filter(s => s.kind === 'inside').map(s => s.key), ['in:10', 'in:20', 'in:30']);
  const firstInside = sup.findIndex(s => s.kind === 'inside');
  assert.ok(sup.slice(0, firstInside).every(s => s.kind !== 'inside'));
  assert.ok(sup.slice(firstInside).every(s => s.kind === 'inside'));
  // 200% 缩放的显示器：inset 4、headroom 240、minWidth 160
  const wide = makeWindow(40, rect(2100, 300, 2600, 700));
  const supB = computeSupports(makeSnapshot([B], [wide]), INSIDE).filter(s => s.kind === 'inside');
  assert.deepEqual(supB.map(s => [s.key, s.y, s.x0, s.x1, s.displayId]), [['in:40', 696, 2104, 2596, 2]]);
});

// ---------- 跳进窗口 ----------

interface Rig {
  world: FakeWorld;
  spec: ActorSpec;
  a: Actor;
  log: ActorEvent[];
  step(dt?: number): ActorEvent[];
  until(pred: () => boolean, what: string, max?: number): void;
}

/** 造一个站在 at 上的角色（先落地、进 idle），桌面只有一个显示器 A 和给的窗口 */
function makeRig(opts: {windows: WinInfo[]; at: Point; tuning?: Partial<Tuning>; supportOptions?: SupportOptions}): Rig {
  const world = makeWorld({displays: [A], windows: opts.windows, seed: 5, supportOptions: opts.supportOptions ?? INSIDE});
  const spec = makeSpec({tuning: {idleSec: [120, 120], walkOffEdgeChance: 0, ...opts.tuning}});
  const a = createActor(spec, opts.at, world.ctx);
  const log: ActorEvent[] = [];
  const step = (dt = DT): ActorEvent[] => {
    world.ctx.now += dt;
    const ev = stepActor(a, spec, dt, world.ctx);
    log.push(...ev);
    return ev;
  };
  const until = (pred: () => boolean, what: string, max = 6000): void => {
    for (let i = 0; i < max; i++) {
      if (pred()) return;
      step();
    }
    if (!pred()) throw new Error(`跑了 ${max} 步还没到${what}（state ${a.state} / 层 ${a.layer.kind} / 支持 ${a.support?.key ?? '—'}）`);
  };
  until(() => a.state === 'idle', '落地后 idle');
  return {world, spec, a, log, step, until};
}

/** 把角色拎起来放进窗口里面松手（脚底 690，比窗口顶边 200 低得多、比 in:W 高），等她落到 in:W 上 */
function putInside(rig: Rig, x = 500): void {
  const {a, spec, world} = rig;
  grabActor(a, spec, {x: a.x, y: a.y}, world.ctx);
  dragActor(a, {x, y: 690}, world.ctx);
  releaseActor(a, spec, world.ctx);
  rig.until(() => a.support?.kind === 'inside', '落到窗口里面的底边', 240);
  rig.until(() => a.state === 'idle', '窗口里面站稳', 240);
}

test('跳进窗口：从 W 的顶边往下跳过顶边时层变成 inside:W（出 layer 事件），落在 in:W 上', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));   // 顶边 200、里面底边 698
  const rig = makeRig({windows: [W1], at: {x: 500, y: 200}});
  const {a, spec, world} = rig;
  eq(insideKey(a.support), 'win:10');
  setPlan(a, spec, {behavior: 'enter', steps: [{state: 'jump', jump: {key: 'in:10', x: 500}}]}, world.ctx, 'test');
  eq(a.layer.kind, 'front');
  eq(a.state, 'jump');

  // 往下落过窗口顶边（vy > 0、y ≥ 200）时换到 inside:10
  rig.until(() => a.layer.kind === 'inside', '下落时换到 inside 层', 240);
  eq((a.layer as {kind: string; hwnd: number}).hwnd, 10);
  const layerEv = rig.log.filter(e => e.type === 'layer').at(-1)!;
  assert.deepEqual(layerEv.type === 'layer' && layerEv.layer, {kind: 'inside', hwnd: 10});
  eq(a.support, null);   // 换层的时候还在空中
  assert.ok(a.vy > 0);

  rig.until(() => a.support !== null, '落地', 240);
  eq(insideKey(a.support), 'in:10');
  eq(a.support?.kind, 'inside');
  eq(a.x, 500);
  eq(a.y, 698);
  eq(a.layer.kind, 'inside');
  const landed = rig.log.filter(e => e.type === 'landed').at(-1)!;
  eq(landed.type === 'landed' && landed.supportKey, 'in:10');
});

// ---------- 在窗口里面 ----------

test('在窗口里面：W 挪很远（超过 followMaxDx）也跟着，不掉', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));
  const rig = makeRig({windows: [W1], at: {x: 500, y: 300}});
  putInside(rig, 500);
  const {a, world} = rig;
  eq(a.layer.kind, 'inside');
  eq(a.y, 698);

  // 往右挪 200 > followMaxDx 80：站在顶边上的话已经掉下去了，在窗口里面的照样跟着
  rig.world.setWindows([makeWindow(10, rect(300, 200, 1100, 700))]);
  rig.step();
  eq(insideKey(a.support), 'in:10');
  eq(a.layer.kind, 'inside');
  eq(a.x, 700);
  eq(a.y, 698);
  eq(a.state, 'idle');
  const followed = rig.log.filter(e => e.type === 'followed').at(-1)!;
  eq(followed.type === 'followed' && followed.dx, 200);

  // 再挪 300：还是跟着
  rig.world.setWindows([makeWindow(10, rect(600, 200, 1400, 700))]);
  rig.step();
  eq(a.x, 1000);
  eq(insideKey(a.support), 'in:10');
  eq(a.layer.kind, 'inside');
});

test('在窗口里面：W 没了 → 层回 front、掉到下面的地面', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));
  const rig = makeRig({windows: [W1], at: {x: 500, y: 300}});
  putInside(rig, 500);
  const {a} = rig;
  eq(a.layer.kind, 'inside');

  rig.world.setWindows([]);   // 窗口关了
  rig.step();
  eq(a.state, 'fall');
  eq(a.layer.kind, 'front');   // 下落时发现脚不在那个窗口里了
  eq(a.support, null);
  rig.until(() => a.support !== null, '落到地面', 1200);
  eq(insideKey(a.support), 'floor:1');
  close(a.y, FLOOR_Y, 1e-9);
});

test('front 层的下落不落到 in:* 上：从窗口上方 / 从窗口顶边走下去都落到地面', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));

  // 1) 从窗口里面那块的上方掉下来（front 层）：穿过窗口里面，落到地面
  {
    const world = makeWorld({displays: [A], windows: [W1], supportOptions: INSIDE});
    const spec = makeSpec({tuning: {idleSec: [120, 120]}});
    const a = createActor(spec, {x: 500, y: 400}, world.ctx);
    eq(a.layer.kind, 'front');
    const kinds = new Set<string>();
    const landed = () => a.support !== null;
    for (let i = 0; i < 1200 && !landed(); i++) {
      world.ctx.now += DT;
      stepActor(a, spec, DT, world.ctx);
      const sup = a.support;
      if (sup) kinds.add(sup.kind);
    }
    eq(insideKey(a.support), 'floor:1');
    assert.ok(!kinds.has('inside'));
    close(a.y, FLOOR_Y, 1e-9);
  }

  // 2) 站在窗口顶边上走出右端 → fall → 落到地面（不掉进窗口里面的底边）
  {
    const rig = makeRig({windows: [W1], at: {x: 500, y: 200}});
    const {a, spec, world} = rig;
    setPlan(a, spec, {behavior: 'w', steps: [{state: 'walk', targetX: 1200}]}, world.ctx, 'test');
    rig.until(() => a.state === 'fall', '走出窗口右端', 600);
    rig.until(() => a.support !== null, '落地', 1200);
    eq(insideKey(a.support), 'floor:1');
    eq(a.support?.kind, 'floor');
    close(a.y, FLOOR_Y, 1e-9);
  }
});

// ---------- 拎起来 / 松手 ----------

test('拎起来：从 inside 回 front；在窗口里面松手（脚比顶边低 0.3 个身高以上）→ 层 inside:W、落回 in:W', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));
  const rig = makeRig({windows: [W1], at: {x: 500, y: 300}});
  putInside(rig, 500);
  const {a, spec, world} = rig;

  const evGrab = grabActor(a, spec, {x: a.x, y: a.y}, world.ctx);
  eq(a.layer.kind, 'front');
  eq(a.state, 'dragged');
  assert.deepEqual(evGrab.filter(e => e.type === 'layer').at(-1), {type: 'layer', layer: {kind: 'front'}});

  // 拖到窗口中间（y = 500：比顶边低 300 > 0.3 × 120 = 36，比 in:W 的 698 高）松手
  dragActor(a, {x: 500, y: 500}, world.ctx);
  const evRelease = releaseActor(a, spec, world.ctx);
  eq(a.state, 'fall');
  eq(a.layer.kind, 'inside');
  assert.deepEqual(evRelease.filter(e => e.type === 'layer').at(-1), {type: 'layer', layer: {kind: 'inside', hwnd: 10}});
  rig.until(() => a.support !== null, '落到 in:W', 240);
  eq(insideKey(a.support), 'in:10');
  eq(a.y, 698);
  eq(a.x, 500);
});

test('拎起来：在 W 顶边附近（低于顶边不到 0.3 个身高）松手 → front，落回 W 顶边', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));   // 0.3 × 120 = 36：脚底 210 离顶边 10，算“贴着顶边”
  const rig = makeRig({windows: [W1], at: {x: 500, y: 300}});
  putInside(rig, 500);
  const {a, spec, world} = rig;

  grabActor(a, spec, {x: a.x, y: a.y}, world.ctx);
  // 往上拖，最后 0.1 秒光标从 300 走到 210（vy = -900，往上抛），松手时脚底 210
  world.ctx.now += 0.1; dragActor(a, {x: 500, y: 400}, world.ctx);
  world.ctx.now += 0.1; dragActor(a, {x: 500, y: 300}, world.ctx);
  world.ctx.now += 0.1; dragActor(a, {x: 500, y: 210}, world.ctx);
  const evRelease = releaseActor(a, spec, world.ctx);
  eq(a.layer.kind, 'front');   // 没放进窗口里面
  eq(a.state, 'fall');
  assert.ok(a.vy < 0, '往上抛');
  eq(evRelease.filter(e => e.type === 'layer').length, 0);
  assert.ok(a.y - 200 < RELEASE_INSIDE * HEIGHT);

  // 飞过窗口顶边再落回来：站到 W 的顶边上（不是窗口里面的底边）
  rig.until(() => a.support !== null, '落回窗口顶边', 600);
  eq(insideKey(a.support), 'win:10');
  eq(a.support?.kind, 'window');
  eq(a.y, 200);
  eq(a.x, 500);
});

// ---------- 计划中止 ----------

test('计划中止：还在窗口里面的保持 inside 层（只有 behind 跟着计划走）', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));
  const rig = makeRig({windows: [W1], at: {x: 500, y: 300}});
  putInside(rig, 500);
  const {a, spec, world} = rig;
  const before = rig.log.length;

  setPlan(a, spec, {behavior: 'other', steps: [{state: 'idle', sec: 1}]}, world.ctx, 'replace');
  eq(a.layer.kind, 'inside');
  eq(a.plan?.behavior, 'other');
  eq(rig.log.slice(before).filter(e => e.type === 'layer').length, 0);
  eq(insideKey(a.support), 'in:10');
  rig.step();
  eq(a.layer.kind, 'inside');
  eq(insideKey(a.support), 'in:10');
});

test('计划中止：behind 层照样回 front', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));
  const rig = makeRig({windows: [W1], at: {x: 500, y: 300}});
  const {a, spec, world} = rig;
  setPlan(a, spec, {behavior: 'hide', steps: [{state: 'act', action: 'idle', layer: {kind: 'behind', hwnd: 10}, sec: 5}]},
    world.ctx, 'hide');
  eq(a.layer.kind, 'behind');
  const ev = setPlan(a, spec, null, world.ctx, 'stop');
  eq(a.layer.kind, 'front');
  eq(a.plan, null);
  assert.deepEqual(ev.filter(e => e.type === 'layer').at(-1), {type: 'layer', layer: {kind: 'front'}});
});

test('步骤要进窗口里面、脚下却不是那个窗口的底边：层不变（回归：双人走位的步骤带着出发时的 inside 层，跳出窗口后又被设回去）', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));
  const rig = makeRig({windows: [W1], at: {x: 1400, y: 300}});
  const {a, spec, world} = rig;
  eq(a.layer.kind, 'front');
  setPlan(a, spec, {behavior: 'duo:x', steps: [{state: 'idle', sec: 1, layer: {kind: 'inside', hwnd: 10}}]}, world.ctx, 'test');
  eq(a.layer.kind, 'front');
  // 站在那个窗口里面时照样设得上
  putInside(rig, 500);
  setPlan(a, spec, {behavior: 'duo:y', steps: [{state: 'idle', sec: 1, layer: {kind: 'inside', hwnd: 10}}]}, world.ctx, 'test');
  eq(a.layer.kind, 'inside');
});

// ---------- Sim 的模板：enter / leave / hop ----------

const SIM_FLOOR_Y = FLOOR_Y;

/** 只有一种模板行为（权重很大）：解析不了就没有计划，方便断言“做不了” */
function templateMind(id: string, step: StepTemplate): MindConfig {
  return {schema: 1, stats: {}, behaviors: [{id, weight: 1_000_000, steps: [step]}]};
}
/** 站着不动 100 秒的脑子（Sim 里只当背景角色用） */
function idleMind(): MindConfig {
  return {schema: 1, stats: {}, behaviors: [{id: 'idle', weight: 1, steps: [{do: 'idle', sec: [100, 100]}]}]};
}
/** 走到 b 身边的脑子（approach 跨线段时会规划 jump） */
function approachMind(): MindConfig {
  return {schema: 1, stats: {}, behaviors: [
    {id: 'go', weight: 1_000_000, steps: [{do: 'approach', who: 'b', gap: [1, 1], sec: [1, 1]}]},
  ]};
}

interface Solo {
  sim: Sim;
  pack: Pack;
  a: Actor;
  display: DisplayInfo;
}

/** 造一个单个角色的 Sim（假角色包、1920×1080 显示器、固定种子） */
function makeSolo(opts: {mind: MindConfig; windows?: WinInfo[]; at?: Point; drip?: [number, number, 0 | 1]; outfit?: string}): Solo {
  const tuning: Tuning = {...DEFAULT_TUNING, idleSec: [0, 0], walkMaxSec: 600};
  const pack = makePack({id: 's', mind: opts.mind, ...(opts.drip ? {drip: {nude: opts.drip}} : {})});
  const sim = new Sim([pack], tuning, {variant: SCENE_VARIANT, heightLogical: 120, r18: true}, mulberry32(3),
    {unlocked: [], playSeconds: 0, chars: {s: {stats: {}, relations: {}}}}, new Map());
  const display = makeDisplay(1, rect(0, 0, 1920, 1080));
  sim.setDesktop({displays: [display], windows: opts.windows ?? []});
  sim.spawn('s', opts.at ?? {x: 500, y: SIM_FLOOR_Y}, opts.outfit);
  return {sim, pack, a: sim.charOf('s')!.actor!, display};
}
function tick(sim: Sim, n = 1): void {
  for (let i = 0; i < n; i++) sim.step(sim.now + SIM_DT, SIM_DT);
}
/** 推进到条件成立（先看现在，再一帧一帧走）；超时抛错 */
function until(fx: Solo, pred: () => boolean, what: string, maxFrames = 600): void {
  for (let i = 0; i < maxFrames; i++) {
    if (pred()) return;
    tick(fx.sim);
  }
  if (!pred()) throw new Error(`跑了 ${maxFrames} 帧还没到${what}（state ${fx.a.state} / 计划 ${fx.a.plan?.behavior ?? '—'} / 支持 ${fx.a.support?.key ?? '—'}）`);
}
/** 从她现在的脚底点拎起来，拖到 (x, y)（脚底点）松手 */
function dropAt(fx: Solo, x: number, y: number): void {
  fx.sim.grab('s', {x: fx.a.x, y: fx.a.y});
  fx.sim.drag({x, y});
  fx.sim.release();
}
/** 把角色拎起来放进窗口里面（脚底 690）松手 */
function simPutInside(fx: Solo, x = 500): void {
  fx.sim.grab('s', {x, y: 690});
  fx.sim.release();
  until(fx, () => fx.a.support?.kind === 'inside', '落到窗口里面的底边', 240);
}

test('Sim 模板 enter：站在窗口顶边、窗口有 in:W 时变成一步 jump 到 in:W；站在地面时做不了', () => {
  const fx = makeSolo({mind: templateMind('enter', {do: 'enter'}), windows: [makeWindow(10, rect(100, 300, 900, 700))],
    at: {x: 500, y: 300}});
  until(fx, () => fx.a.plan?.behavior === 'enter', '选中 enter 行为');
  eq(fx.a.state, 'jump');
  eq(fx.a.step?.state, 'jump');
  eq(fx.a.step?.jump?.key, 'in:10');
  eq(fx.a.step?.jump?.x, 500);    // 夹在 in:W 的可站范围里（[132, 868]）
  eq(fx.a.plan?.steps.length, 0); // 计划就这一步

  // 站在地面（脚下不是窗口顶边）：做不了，没有计划
  const flat = makeSolo({mind: templateMind('enter', {do: 'enter'}), windows: [makeWindow(10, rect(100, 300, 900, 700))],
    at: {x: 500, y: SIM_FLOOR_Y}});
  until(flat, () => flat.a.state === 'idle', '站到地面', 120);
  tick(flat.sim, 10);
  eq(flat.a.support?.key, 'floor:1');
  eq(flat.a.plan, null);
});

test('Sim 模板 leave：在窗口里面时变成 walk + jump 到窗口外面的线段（地面）', () => {
  const fx = makeSolo({mind: templateMind('leave', {do: 'leave'}), windows: [makeWindow(10, rect(100, 300, 900, 700))],
    at: {x: 500, y: 690}});
  simPutInside(fx, 500);
  until(fx, () => fx.a.plan?.behavior === 'leave', '选中 leave 行为', 240);
  // 出口只有地面：先走到左边的起跳点 132，再跳到地面的 70（窗口矩形外面）
  eq(fx.a.step?.state, 'walk');
  eq(fx.a.step?.targetX, 132);
  eq(fx.a.plan?.steps.length, 1);
  const jump = fx.a.plan?.steps[0];
  eq(jump?.state, 'jump');
  eq(jump?.jump?.key, 'floor:1');
  eq(jump?.jump?.x, 70);
  // 跳出去以后层回到 front（不再是 inside）
  until(fx, () => fx.a.layer.kind !== 'inside', '跳出窗口', 300);
});

// 出不来的窗口不当房间（2026-10-21 用户选的 C，main/sim.ts setDesktop + world/nav.ts hasExit）。
// 以前这里测的是“最大化窗口里 leave 做不了”：进去了就出不来，躲、双人都断了
test('Sim：出不来的窗口（贴着屏幕两边、顶边放不下）没有 in:*，在上面松手落到地面、留在 front', () => {
  for (const r of [rect(0, 0, 1920, FLOOR_Y), rect(0, 0, 1920, 700)]) {
    const fx = makeSolo({mind: idleMind(), windows: [makeWindow(10, r)]});
    eq(fx.sim.supports.some(s => s.kind === 'inside'), false, `窗口 ${JSON.stringify(r)} 不该有 in:*`);
    until(fx, () => fx.a.state === 'idle', '先站稳', 240);
    dropAt(fx, 500, 600);
    until(fx, () => fx.a.state === 'idle', '落地站稳', 240);
    eq(fx.a.support?.key, 'floor:1');
    eq(fx.a.layer.kind, 'front');
  }
});

// 松手认“光标下最上面的窗口”（actor.ts releaseActor，ctx.windowAt）。2026-10-29 用户：最大化窗口在前、底下盖着一个窗口，
// 透过最大化窗口能把她放进那个看不见的窗口。以前只在房间列表里找第一个包含该点的，最大化窗口出不来、不在列表里，就越过它进了底下的窗口
test('Sim：光标下最上面的窗口是出不来的最大化窗口 → 不越过它落进底下被盖住的窗口，落到地面、留在 front', () => {
  const maximized = makeWindow(20, rect(0, 0, 1920, FLOOR_Y)), covered = makeWindow(10, rect(100, 300, 900, 700));
  const fx = makeSolo({mind: idleMind(), windows: [maximized, covered]});   // windows 按 z 序从上到下：最大化窗口在前
  eq(fx.sim.supports.some(s => s.key === 'in:10'), true, '被盖住的窗口自己是个房间');
  eq(fx.sim.supports.some(s => s.key === 'in:20'), false, '最大化窗口出不来，不当房间');
  until(fx, () => fx.a.state === 'idle', '先站稳', 240);
  dropAt(fx, 500, 600);   // 光标在被盖住的窗口的范围里，也在最大化窗口里
  eq(fx.a.layer.kind, 'front');
  until(fx, () => fx.a.state === 'idle', '落地站稳', 240);
  eq(fx.a.support?.key, 'floor:1');
  eq(fx.a.layer.kind, 'front');
});

test('Sim：同一个窗口没被盖住时照样放得进去；盖住它一部分的置顶窗口只挡它被盖住的那一块', () => {
  const lone = makeSolo({mind: idleMind(), windows: [makeWindow(10, rect(100, 300, 900, 700))]});
  until(lone, () => lone.a.state === 'idle', '先站稳', 240);
  dropAt(lone, 500, 600);
  eq(lone.a.layer.kind, 'inside');
  // 置顶窗口 30 盖住 10 的右边（x 从 400 起）：松手点落在 30 里 → 前面是 30，它不是房间 → 不进 10；落在 10 没被盖住的左边 → 进
  const wins = [makeWindow(30, rect(400, 200, 1000, 800), {topmost: true}), makeWindow(10, rect(100, 300, 900, 700))];
  const covered = makeSolo({mind: idleMind(), windows: wins});
  until(covered, () => covered.a.state === 'idle', '先站稳', 240);
  dropAt(covered, 500, 600);
  eq(covered.a.layer.kind, 'front');
  const visible = makeSolo({mind: idleMind(), windows: wins});
  until(visible, () => visible.a.state === 'idle', '先站稳', 240);
  dropAt(visible, 200, 600);
  eq(visible.a.layer.kind, 'inside');
  until(visible, () => visible.a.support?.key === 'in:10', '落到窗口里面的底边', 240);
});

test('Sim：一边贴着屏幕边、另一边跳得出去的窗口照样能进；矮的铺满屏幕宽的窗口能跳回顶边，也能进', () => {
  const half = makeSolo({mind: idleMind(), windows: [makeWindow(10, rect(0, 300, 1200, FLOOR_Y))]});
  eq(half.sim.supports.some(s => s.key === 'in:10'), true);
  until(half, () => half.a.state === 'idle', '先站稳', 240);
  dropAt(half, 500, 600);
  until(half, () => half.a.support?.key === 'in:10', '落到窗口里面的底边', 240);
  eq(half.a.layer.kind, 'inside');
  // 窗口里面的底边 998，顶边 850：往上 148 ≤ jumpUpHeights 1.5 × 120 = 180
  const low = makeSolo({mind: idleMind(), windows: [makeWindow(10, rect(0, 850, 1920, 1000))]});
  eq(low.sim.supports.some(s => s.key === 'in:10'), true);
});

test('Sim：在窗口里面时窗口被最大化 → 照“窗口没了”掉出来，回 front、落到地面', () => {
  const fx = makeSolo({mind: idleMind(), windows: [makeWindow(10, rect(100, 300, 900, 700))], at: {x: 500, y: 690}});
  simPutInside(fx, 500);
  until(fx, () => fx.a.state === 'idle', '在窗口里面站稳', 240);
  eq(fx.a.layer.kind, 'inside');
  fx.sim.setDesktop({displays: [fx.display], windows: [makeWindow(10, rect(0, 0, 1920, FLOOR_Y))]});
  until(fx, () => fx.a.support?.kind === 'floor' && fx.a.state !== 'fall', '掉出来落到地面', 600);
  eq(fx.a.layer.kind, 'front');
});

test('Sim 模板 hop：有能跳上去的窗口顶边时变成 jump（跳到窗口顶边，不是 in:*）', () => {
  // 窗口顶边 900，比地面高 140 ≤ jumpUpHeights 1.5 × 120 = 180
  const fx = makeSolo({mind: templateMind('hop', {do: 'hop'}), windows: [makeWindow(10, rect(100, 900, 900, 1000))],
    at: {x: 500, y: SIM_FLOOR_Y}});
  until(fx, () => fx.a.plan?.behavior === 'hop', '选中 hop 行为');
  eq(fx.a.state, 'jump');
  eq(fx.a.step?.state, 'jump');
  eq(fx.a.step?.jump?.key, 'win:10');
  eq(fx.a.step?.jump?.x, 500);
  until(fx, () => fx.a.support?.key === 'win:10', '落在窗口顶边', 300);
  eq(fx.a.y, 900);

  // 站在有 in:W 的窗口顶边上（同一窗口的 in:W 也在一跳能到的里面）：hop 只挑地面，不跳进 in:W
  const onTop = makeSolo({mind: templateMind('hop', {do: 'hop'}), windows: [makeWindow(10, rect(100, 300, 900, 700))],
    at: {x: 500, y: 300}});
  until(onTop, () => onTop.a.plan?.behavior === 'hop', '选中 hop 行为');
  eq(onTop.a.step?.state, 'walk');
  eq(onTop.a.step?.targetX, 130);
  const jump = onTop.a.plan?.steps[0];
  eq(jump?.state, 'jump');
  eq(jump?.jump?.key, 'floor:1');
  eq(jump?.jump?.x, 70);
  assert.ok(!onTop.a.plan?.steps.some(s => s.jump?.key.startsWith('in:')));
});

// ---------- Sim.view().others 的 reachable、approach 跨线段 ----------

/** 两个角色（a 的行为由 aMind 给，b 站着不动） */
function makePair(opts: {windows?: WinInfo[]; aMind: MindConfig; bAt: Point; aAt?: Point}): {sim: Sim; a: Actor; b: Actor} {
  const tuning: Tuning = {...DEFAULT_TUNING, idleSec: [0, 0], walkMaxSec: 600};
  const aPack = makePack({id: 'a', mind: opts.aMind});
  const bPack = makePack({id: 'b', mind: idleMind()});
  const sim = new Sim([aPack, bPack], tuning, {variant: SCENE_VARIANT, heightLogical: 120, r18: true}, mulberry32(7),
    {unlocked: [], playSeconds: 0, chars: {a: {stats: {}, relations: {}}, b: {stats: {}, relations: {}}}}, new Map());
  sim.setDesktop({displays: [makeDisplay(1, rect(0, 0, 1920, 1080))], windows: opts.windows ?? []});
  sim.spawn('b', opts.bAt);
  for (let i = 0; i < 120 && sim.charOf('b')!.actor!.support === null; i++) tick(sim);
  sim.spawn('a', opts.aAt ?? {x: 500, y: SIM_FLOOR_Y});
  for (let i = 0; i < 120 && sim.charOf('a')!.actor!.support === null; i++) tick(sim);
  return {sim, a: sim.charOf('a')!.actor!, b: sim.charOf('b')!.actor!};
}

test('Sim.view().others.<id>.reachable：不在同一段、但跳得过去 → true，dist 是直线距离 / 身高', () => {
  const {sim, a, b} = makePair({windows: [makeWindow(10, rect(100, 900, 900, 1000))], aMind: idleMind(), bAt: {x: 700, y: 900}});
  eq(a.support?.key, 'floor:1');
  eq(b.support?.key, 'win:10');
  const o = sim.view(sim.charOf('a')!).others.b;
  eq(o.reachable, true);
  // 直线距离 √((700-500)² + (900-1040)²) / 120
  close(o.dist, Math.hypot(200, 140) / HEIGHT, 1e-9);
});

test('Sim.view().others.<id>.reachable：跳不过去 → false，dist 是 Infinity；approach 也做不了', () => {
  // 顶边 700，比地面高 340 > 180，跳不上去
  const {sim, a, b} = makePair({windows: [makeWindow(10, rect(100, 700, 900, 900))], aMind: approachMind(), bAt: {x: 700, y: 700}});
  eq(b.support?.key, 'win:10');
  const o = sim.view(sim.charOf('a')!).others.b;
  eq(o.reachable, false);
  eq(o.dist, Infinity);
  tick(sim, 120);
  eq(a.state, 'idle');
  eq(a.plan, null);
});

test('Sim 的 approach 跨线段：计划里有 jump 步骤（先跳到对方的线段，再走过去）', () => {
  const {sim, a} = makePair({windows: [makeWindow(10, rect(100, 900, 900, 1000))], aMind: approachMind(), bAt: {x: 700, y: 900}});
  for (let i = 0; i < 240 && a.plan?.behavior !== 'go'; i++) tick(sim);
  assert.ok(a.plan?.behavior === 'go', `没选到 approach（state ${a.state} / 计划 ${a.plan?.behavior ?? '—'}）`);
  eq(a.step?.state, 'jump');
  eq(a.step?.jump?.key, 'win:10');
  eq(a.step?.jump?.x, 500);
  // 跳完还要走到对方身边
  eq(a.plan?.steps[0]?.state, 'walk');
});

// ---------- Sim.draws、水珠 ----------

test('Sim.draws：在窗口里面的角色画在 inside 图层（key = hwnd），item 带 clip = 窗口矩形，front 图层里没有她', () => {
  const fx = makeSolo({mind: idleMind(), windows: [makeWindow(10, rect(100, 300, 900, 700))], at: {x: 500, y: 690}});
  simPutInside(fx, 500);
  eq(fx.a.layer.kind, 'inside');
  const d = fx.sim.draws(new Set());
  eq(d.inside.size, 1);
  const bucket = d.inside.get(10);
  assert.ok(bucket, '没有 inside:10 这一层');
  const item = bucket!.items.find(i => i.id === 's');
  assert.ok(item, 'inside 图层里没有她');
  assert.deepEqual(item!.clip, [100, 300, 800, 400]);
  eq(item!.x, 500);
  eq(item!.y, 698);
  eq(d.behind.size, 0);
  assert.ok(!(d.front.get(1) ?? []).some(i => i.id === 's'));
  // 要画的范围裁在窗口矩形里
  assert.ok(bucket!.rect.left >= 100 && bucket!.rect.top >= 300);
  assert.ok(bucket!.rect.right <= 900 && bucket!.rect.bottom <= 700);
  assert.ok(bucket!.rect.right > bucket!.rect.left && bucket!.rect.bottom > bucket!.rect.top);
});

// ---------- 回归（2026-10-21 报告 A：掉出窗口底面以后回 front，不再“站地面上还裁在窗口里、看不见”） ----------

test('回归（报告 A 复现 1）：在窗口左边缘 +1 px 松手（inset 带里）→ 还是 front 层、落到地面、front 图层里看得见', () => {
  const fx = makeSolo({mind: idleMind(), windows: [makeWindow(10, rect(100, 300, 900, 700))], at: {x: 101, y: 690}});
  fx.sim.grab('s', {x: 101, y: 690});
  fx.sim.release();
  eq(fx.a.layer.kind, 'front');   // in:W 的 x 从 102 起（inset 2），101 不算放进窗口里面
  // 松手的事件里没有换到 inside 层
  const evs = fx.sim.step(fx.sim.now + SIM_DT, SIM_DT);
  assert.ok(!evs.some(x => x.e.type === 'layer' && x.e.layer.kind === 'inside'));

  until(fx, () => fx.a.support !== null, '落到地面', 240);
  eq(fx.a.support?.key, 'floor:1');
  eq(fx.a.support?.kind, 'floor');
  close(fx.a.y, SIM_FLOOR_Y, 1e-9);
  eq(fx.a.layer.kind, 'front');
  const d = fx.sim.draws(new Set());
  assert.ok((d.front.get(1) ?? []).some(i => i.id === 's'), 'front 图层里没有她');
  eq(d.inside.size, 0);
});

test('回归（报告 A 复现 2）：跳进窗口途中窗口变窄、落点落在 inset 带里 → 掉出窗口底边后回 front，地面上看得见', () => {
  const fx = makeSolo({mind: idleMind(), windows: [makeWindow(10, rect(100, 300, 900, 700))], at: {x: 500, y: 300}});
  until(fx, () => fx.a.state === 'idle' && fx.a.support?.key === 'win:10', '站在窗口顶边');
  const c = fx.sim.charOf('s')!;
  setPlan(fx.a, c.spec, {behavior: 'enter', steps: [{state: 'jump', jump: {key: 'in:10', x: 500}}]}, fx.sim.ctx(), 'test');
  eq(fx.a.state, 'jump');
  eq(fx.a.support, null);   // 假包没有 jump_start：马上起跳
  // 空中把窗口右边收到 501：in:W 变成 [102, 499)，落点 500 落在 inset 带里
  fx.sim.setDesktop({displays: [fx.display], windows: [makeWindow(10, rect(100, 300, 501, 700))]});
  let sawInside = false, sawFront = false;
  for (let i = 0; i < 600 && fx.a.support === null; i++) {
    for (const {e} of fx.sim.step(fx.sim.now + SIM_DT, SIM_DT)) {
      if (e.type !== 'layer') continue;
      if (e.layer.kind === 'inside') sawInside = true;
      if (e.layer.kind === 'front') sawFront = true;
    }
  }
  assert.ok(sawInside, '下落过窗口顶边时应该先进 inside 层');
  assert.ok(sawFront, '掉过 in:W 的 y 以后应该回 front');
  eq(fx.a.layer.kind, 'front');
  eq(fx.a.support?.key, 'floor:1');
  close(fx.a.y, SIM_FLOOR_Y, 1e-9);
  const d = fx.sim.draws(new Set());
  assert.ok((d.front.get(1) ?? []).some(i => i.id === 's'), 'front 图层里没有她');
  eq(d.inside.size, 0);
});

// ---------- 脚下的线段没了：support-lost 写清为什么（2026-10-21 晚：用户拖着窗口时两人从窗口里面掉出来，日志只有 support-gone） ----------

test('在窗口里面时脚下的底边没了：support-lost 记 why（关了 window-gone / 变矮 dropped / 变成出不来的最大化窗口 no-exit），然后照常掉出来', () => {
  const cases: [string, WinInfo[]][] = [
    ['window-gone', []],
    ['dropped', [makeWindow(10, rect(100, 600, 900, 700))]],     // 高 100，比她矮
    ['no-exit', [makeWindow(10, rect(0, 0, 1920, 1040))]],         // 盖满工作区：两边是屏幕边、顶边太高，跳不出去
  ];
  for (const [why, windows] of cases) {
    const fx = makeSolo({mind: idleMind(), windows: [makeWindow(10, rect(100, 300, 900, 700))], at: {x: 500, y: 690}});
    simPutInside(fx, 500);
    fx.sim.setDesktop({displays: [fx.display], windows});
    const evs = fx.sim.step(fx.sim.now + SIM_DT, SIM_DT).map(x => x.e);
    const lost = evs.find(e => e.type === 'support-lost');
    assert.ok(lost && lost.type === 'support-lost', `${why}：没有 support-lost`);
    eq(lost.why, why);
    eq(lost.key, 'in:10');
    eq(lost.rect === null, why === 'window-gone');
    assert.ok(evs.some(e => e.type === 'state' && e.to === 'fall' && e.reason === 'support-gone'), `${why}：没有照常掉出来`);
  }
});
