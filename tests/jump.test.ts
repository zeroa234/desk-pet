// behavior/actor.ts 的跳（N2.5，2026-10-21）的单测：计划步骤 state jump + Step.jump 的状态机——起跳动画、离地事件、
// 抛物线、落地（窗口挪了 / 落点没了）、落地动画、播完接着下一步；没有 jump_start / jump_land 动作时的回退；
// 被拎起来中断。规则见 src/behavior/actor.ts 的 startJump / launch / stepJump 和 docs/desktop-interaction.md §2.4。
// 假角色在这个显示器上的高度 120 物理像素（makeWorld 的 heightPx = 120），jumpArcHeights 0.35 → 弧 42 px。
import test from 'node:test';
import assert from 'node:assert/strict';

import {createActor, grabActor, releaseActor, setPlan, stepActor} from '../src/behavior/index.ts';
import type {ActionInfo, Actor, ActorEvent, ActorSpec, Tuning, WorldContext} from '../src/behavior/index.ts';
import type {Point, WinInfo} from '../src/shared/types.ts';
import {makeDisplay, makeSpec, makeWindow, makeWorld, rect} from './helpers/fake-desktop.ts';
import {close, eq} from './helpers/assert.ts';
import type {FakeWorld} from './helpers/fake-desktop.ts';

// A：1920×1080、100% 缩放、任务栏 40 px → 地面 y = 1040
const A = makeDisplay(1, rect(0, 0, 1920, 1080));
const FLOOR_Y = 1040;
const HEIGHT = 120;
const DT = 1 / 60;

/** 跳用的动作：起跳 0.5 秒（6 帧 @ 12 fps）、空中循环、落地 1/3 秒（4 帧 @ 12 fps） */
const JUMP_ACTIONS: Readonly<Record<string, ActionInfo>> = {
  jump_start: {frames: 6, fps: 12, loop: false},
  jump_air: {frames: 8, fps: 12, loop: true},
  jump_land: {frames: 4, fps: 12, loop: false},
};

interface Rig {
  world: FakeWorld;
  spec: ActorSpec;
  a: Actor;
  /** 到目前为止的所有事件 */
  log: ActorEvent[];
  /** 推进一帧，返回这一帧的事件 */
  step(dt?: number): ActorEvent[];
  /** 推进到条件成立（先看现在，再一帧一帧走）；超时抛错 */
  until(pred: () => boolean, what: string, max?: number): void;
}

/** 造一个站在 at 上的角色（先落地、进 idle），桌面只有一个显示器和给的窗口 */
function makeRig(opts: {windows: WinInfo[]; actions?: Readonly<Record<string, ActionInfo>>; at: Point; tuning?: Partial<Tuning>}): Rig {
  const world = makeWorld({displays: [A], windows: opts.windows, seed: 5});
  const spec = makeSpec({actions: opts.actions ? {...opts.actions} : undefined,
    tuning: {idleSec: [120, 120], walkOffEdgeChance: 0, ...opts.tuning}});
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
    if (!pred()) throw new Error(`跑了 ${max} 步还没到${what}（state ${a.state} / 计划 ${a.plan?.behavior ?? '—'}）`);
  };
  until(() => a.state === 'idle', '落地后 idle');
  return {world, spec, a, log, step, until};
}

/** 跳的计划：跳到 key / x，后面接一步 idle，看计划会不会接着往下走 */
const JUMP_PLAN = (key: string, x: number, behavior = 't') => ({behavior, steps: [
  {state: 'jump' as const, jump: {key, x}},
  {state: 'idle' as const, sec: 0.5},
]});

test('jump：先原地播 jump_start；离地出 jumped、support 变 null；空中先升高再落下；落地出 landed、播 jump_land，播完接着下一步', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));   // 顶边 y = 200
  const rig = makeRig({windows: [W1], actions: JUMP_ACTIONS, at: {x: 300, y: 200}});
  const {a, spec, world} = rig;
  eq(a.support?.key, 'win:10');
  eq(a.y, 200);

  const tStart = world.ctx.now;
  const ev0 = setPlan(a, spec, JUMP_PLAN('floor:1', 700), world.ctx, 'test');
  rig.log.push(...ev0);
  eq(a.state, 'jump');
  eq(a.action, 'jump_start');            // 原地播起跳
  eq(a.support?.key, 'win:10');          // 还没离地
  eq(ev0.filter(e => e.type === 'jumped').length, 0);

  // 起跳动画（0.5 秒）里不动
  for (let i = 0; i < 25; i++) {
    rig.step();
    eq(a.x, 300);
    eq(a.y, 200);
    eq(a.support?.key, 'win:10');
  }
  // 离地：事件带落点线段和横 / 竖差，support 变 null，动作换成空中
  rig.until(() => a.support === null, '离地');
  const jumped = rig.log.find((e): e is Extract<ActorEvent, {type: 'jumped'}> => e.type === 'jumped')!;
  eq(jumped.supportKey, 'floor:1');
  eq(jumped.dx, 400);    // 700 - 300
  eq(jumped.dy, 840);    // 1040 - 200
  eq(a.action, 'jump_air');
  close(world.ctx.now - tStart, 0.5, DT + 1e-9);   // 起跳动画 0.5 秒
  const tJumped = world.ctx.now;

  // 空中：抛物线，先升到 200 - arc(42) 附近再落下来
  let minY = Infinity, firstAirY = NaN, landed: Extract<ActorEvent, {type: 'landed'}> | null = null;
  for (let i = 0; i < 600 && !landed; i++) {
    const ev = rig.step();
    if (a.state === 'jump' && a.support === null) {
      if (Number.isNaN(firstAirY)) firstAirY = a.y;
      minY = Math.min(minY, a.y);
    }
    for (const e of ev) if (e.type === 'landed') landed = e;
  }
  assert.ok(firstAirY < 200, `离地后第一帧 y 应该比起点高（${firstAirY}）`);
  close(minY, 200 - 0.35 * HEIGHT, 1);   // 顶点 = 两头较高的那头 - jumpArcHeights × 身高
  assert.ok(landed, '空中没有出 landed');
  const tLanded = world.ctx.now;
  // 落地：正好在落点的 x / y 上，support 是落点那段，播 jump_land（空中时间同 flightSec）
  eq(landed!.supportKey, 'floor:1');
  eq(landed!.impactDip, 0);
  eq(a.x, 700);
  eq(a.y, FLOOR_Y);
  eq(a.support?.key, 'floor:1');
  eq(a.state, 'jump');                   // 还在 jump 的落地动画阶段
  eq(a.action, 'jump_land');
  close(tLanded - tJumped, 1.4471691, DT + 1e-6);

  // 落地动画（1/3 秒）播完 → 计划接着往下走：下一步 idle 0.5 秒
  let leftLand = -1;
  for (let i = 0; i < 60 && leftLand < 0; i++) {
    rig.step();
    if (a.state !== 'jump') leftLand = world.ctx.now;
  }
  assert.ok(leftLand > 0, '落地动画没播完');
  close(leftLand - tLanded, 4 / 12, DT + 1e-9);
  eq(a.state, 'idle');
  eq(a.action, 'idle');
  eq(a.plan?.behavior, 't');
  eq(a.plan?.steps.length, 0);

  // idle 0.5 秒后计划完成
  rig.until(() => a.plan === null, '计划完成', 120);
  const end = rig.log.filter(e => e.type === 'plan-end').at(-1)!;
  eq(end.type === 'plan-end' && end.outcome, 'done');
  eq(a.state, 'idle');
});

test('jump：没有 jump_start / jump_land 时马上起跳，落地用 landSec', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));
  const rig = makeRig({windows: [W1], actions: {jump_air: JUMP_ACTIONS.jump_air}, at: {x: 300, y: 200}});
  const {a, spec, world} = rig;

  const ev0 = setPlan(a, spec, JUMP_PLAN('floor:1', 700), world.ctx, 'test');
  // 没有起跳动画：setPlan 的那一下就已经离地了
  eq(a.state, 'jump');
  eq(a.action, 'jump_air');
  eq(a.support, null);
  eq(ev0.filter(e => e.type === 'jumped').length, 1);

  let tLanded = 0;
  for (let i = 0; i < 600 && !tLanded; i++) {
    const ev = rig.step();
    if (ev.some(e => e.type === 'landed')) tLanded = world.ctx.now;
  }
  assert.ok(tLanded > 0, '没有落地');
  // 没有 jump_land：用 tuning.landSec（0.35 秒），动作回退到 idle
  eq(a.state, 'jump');
  eq(a.action, 'idle');
  let tEnd = 0;
  for (let i = 0; i < 60 && !tEnd; i++) {
    rig.step();
    if (a.state !== 'jump') tEnd = world.ctx.now;
  }
  assert.ok(tEnd > 0, '落地阶段没结束');
  close(tEnd - tLanded, spec.tuning.landSec, DT + 1e-9);
  eq(a.state, 'idle');
  eq(a.y, FLOOR_Y);
});

test('jump：空中落点那段的窗口挪了 → 落在挪过以后的位置（跟着窗口的位移挪落点）', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));
  const rig = makeRig({windows: [W1], actions: JUMP_ACTIONS, at: {x: 300, y: 200}});
  const {a, spec, world} = rig;
  setPlan(a, spec, JUMP_PLAN('win:10', 600), world.ctx, 'test');
  rig.until(() => a.support === null, '离地');
  // 空中把落点那个窗口往右挪 100
  rig.world.setWindows([makeWindow(10, rect(200, 200, 1000, 700))]);
  eq(a.support, null);   // 空中的角色不会因为窗口挪动掉下来
  rig.until(() => a.support !== null, '落地');
  eq(a.support?.key, 'win:10');
  eq(a.support?.rect?.left, 200);
  eq(a.x, 700);          // 落点 600 + 位移 100
  eq(a.y, 200);
});

test('jump：空中落点那段没了 → 转 fall、计划中止，最后落到地面', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));
  const W2 = makeWindow(20, rect(1000, 400, 1800, 900));   // 顶边 y = 400
  const rig = makeRig({windows: [W1, W2], actions: JUMP_ACTIONS, at: {x: 300, y: 200}});
  const {a, spec, world} = rig;
  setPlan(a, spec, JUMP_PLAN('win:20', 1200), world.ctx, 'test');
  rig.until(() => a.support === null, '离地');
  rig.world.setWindows([W1]);   // 落点那个窗口关了
  let aborted: Extract<ActorEvent, {type: 'plan-end'}> | null = null;
  for (let i = 0; i < 600 && !aborted; i++) {
    const ev = rig.step();
    for (const e of ev) if (e.type === 'plan-end') aborted = e;
  }
  assert.ok(aborted, '计划没有中止');
  eq(aborted!.outcome, 'aborted');
  eq(aborted!.reason, 'jump-target-gone');
  eq(a.plan, null);
  eq(a.state, 'fall');
  rig.until(() => a.support !== null, '落到地面', 1200);
  eq(a.support?.key, 'floor:1');
  close(a.y, FLOOR_Y, 1e-9);
});

test('jump：起跳前（takeoff 里）落点就没了 → 计划中止，不出现 jumped，回 idle', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));
  const W2 = makeWindow(20, rect(1000, 400, 1800, 900));
  const rig = makeRig({windows: [W1, W2], actions: JUMP_ACTIONS, at: {x: 300, y: 200}});
  const {a, spec, world} = rig;
  setPlan(a, spec, JUMP_PLAN('win:20', 1200), world.ctx, 'test');
  eq(a.state, 'jump');
  eq(a.action, 'jump_start');
  // 起跳动画还没播完（0.5 秒）就把落点的窗口关了
  rig.step();
  rig.world.setWindows([W1]);
  rig.until(() => a.state === 'idle', '起跳中止后回 idle', 120);
  eq(a.plan, null);
  eq(rig.log.filter(e => e.type === 'jumped').length, 0);
  const end = rig.log.filter(e => e.type === 'plan-end').at(-1)!;
  eq(end.type === 'plan-end' && end.outcome, 'aborted');
  eq(end.type === 'plan-end' && end.reason, 'jump-target-gone');
  // 站在原地（没被抛物线带走）
  eq(a.x, 300);
  eq(a.y, 200);
});

test('jump：被拎起来 → 计划中止、jump 状态清掉，松手按正常下落（不会接着跳到原来的落点）', () => {
  const W1 = makeWindow(10, rect(100, 200, 900, 700));
  const rig = makeRig({windows: [W1], actions: JUMP_ACTIONS, at: {x: 300, y: 200}});
  const {a, spec, world} = rig;
  setPlan(a, spec, JUMP_PLAN('floor:1', 700), world.ctx, 'test');
  rig.until(() => a.support === null, '离地');
  for (let i = 0; i < 6; i++) rig.step();
  const grabbedX = a.x, grabbedY = a.y;
  assert.ok(grabbedY < 200 - 20, '应该还在空中往上走');

  const evGrab = grabActor(a, spec, {x: a.x, y: a.y}, world.ctx);
  rig.log.push(...evGrab);
  eq(a.state, 'dragged');
  eq(a.support, null);
  eq(a.plan, null);   // 计划中止，不会落地后接着走下一步
  const end = evGrab.find(e => e.type === 'plan-end')!;
  eq(end.type === 'plan-end' && end.outcome, 'aborted');
  eq(end.type === 'plan-end' && end.reason, 'grabbed');

  // 拖一下再松手：正常下落，x 不再朝原来的落点 700 走
  world.ctx.now += 0.1;
  releaseActor(a, spec, world.ctx);
  eq(a.state, 'fall');
  eq(a.plan, null);
  rig.until(() => a.support !== null, '松手后落地', 1200);
  // 拎起来时在窗口顶边上面，落回窗口顶边（不是原来要跳的地面、也不是 700）
  eq(a.support?.key, 'win:10');
  eq(a.y, 200);
  eq(a.x, grabbedX);
  eq(a.plan, null);
  eq(rig.log.filter(e => e.type === 'jumped').length, 1);   // 只有起跳那一次
});

test('jump：跳到半空时外面换计划（setPlan，比如切全年龄）：当前计划算中止、照常落到落点上，落地以后再执行新计划（回归：以前新计划在半空开始，掉下去还丢了）', () => {
  const W1 = makeWindow(10, rect(500, 700, 1300, 1000));   // 顶边 y = 700
  const rig = makeRig({windows: [W1], actions: JUMP_ACTIONS, at: {x: 300, y: FLOOR_Y}});
  const {a, spec, world} = rig;
  setPlan(a, spec, JUMP_PLAN('win:10', 700), world.ctx, 'test');
  rig.until(() => a.state === 'jump' && a.support === null, '离地');
  const ev = setPlan(a, spec, {behavior: 'other', steps: [{state: 'idle', sec: 3}]}, world.ctx, 'sfw');
  assert.ok(ev.some(e => e.type === 'plan-end' && e.behavior === 't' && e.outcome === 'aborted' && e.reason === 'sfw'), '当前计划算中止');
  eq(a.state, 'jump', '还在空中');
  eq(a.plan, null);
  rig.until(() => a.plan?.behavior === 'other', '新计划开始');
  eq(a.support?.key, 'win:10', '照常落到落点上');
  eq(a.state, 'idle');
  assert.ok(!rig.log.some(e => e.type === 'state' && e.to === 'fall'), '没有掉下去');
});
