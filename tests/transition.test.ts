// 动作衔接的单测（2026-10-22，docs/design.md §3.10）：
//   - 换动作 / 转身时按新旧两帧的髋骨位置挪脚底点（src/behavior/actor.ts 的 hipAt / keepHip），身体不跳，挪不出脚下那段线段；
//   - 计划换动作时先播角色包的过渡（transitionFor / Step.via）：现在这一帧是入口就播、循环动作等到入口帧、不循环动作等播完、
//     过渡动作在这身衣着下没有图就不接；外面打断换的计划（setPlan）第一步不等入口帧；衣着和特效只在过渡开始时做一次；
//   - 过渡到 loop 段时被发现“接着做完”（continueExposed）：真正的 loop 段留下、截短，后面的 loop 段跳过；
//   - 身体位置 bodyX（髋骨地面点）换动作时不变；
//   - 被拎起来（grabActor）的偏移按换动作挪过以后的脚底点算，拖到同一个光标位置不会跳回去；
//   - 角色包加载校验 hip 长度和过渡入口帧，actorSpec 把 hip / transitions 交给状态机（src/pack/index.ts）。
// 假角色在这个显示器上的高度 120 物理像素（makeWorld 的 heightPx = 120）；A = 1920×1080、任务栏 40 → 地面 y = 1040。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {DEFAULT_TUNING, bodyX, continueExposed, createActor, dragActor, grabActor, setPlan, stepActor} from '../src/behavior/index.ts';
import type {ActionInfo, Actor, ActorEvent, ActorSpec, Plan, Transition, Tuning} from '../src/behavior/index.ts';
import {loadPack} from '../src/pack/index.ts';
import type {Point, WinInfo} from '../src/shared/types.ts';
import {close, eq} from './helpers/assert.ts';
import {PROJECT, tempPack} from './helpers/temp-pack.ts';
import {makeDisplay, makeSpec, makeWindow, makeWorld, rect} from './helpers/fake-desktop.ts';
import type {FakeWorld} from './helpers/fake-desktop.ts';

const A = makeDisplay(1, rect(0, 0, 1920, 1080));
const FLOOR_Y = 1040;
const HEIGHT = 120;
const DT = 1 / 60;

/** 每帧同一个值的髋骨轨迹 */
function hipArray(frames: number, v: number): number[] {
  return Array.from({length: frames}, () => v);
}

interface RigOptions {
  at: Point;
  /** 额外的 / 覆盖的动作（和 makeSpec 的 actions 一样） */
  actions: Record<string, ActionInfo>;
  transitions?: readonly Transition[];
  windows?: WinInfo[];
  seed?: number;
  tuning?: Partial<Tuning>;
}

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

/**
 * 造一个站在 at 上的角色（先落地、经 land 进 idle）；桌面只有一个显示器和给的窗口。
 * 动作表里有 land：落地以后 idle 是换动作，从第 0 帧开始、actionStart = 现在的时刻。
 */
function makeRig(opts: RigOptions): Rig {
  const world = makeWorld({displays: [A], windows: opts.windows, seed: opts.seed ?? 5});
  const base = makeSpec({actions: {land: {frames: 1, fps: 12, loop: false}, ...opts.actions},
    tuning: {idleSec: [120, 120], walkOffEdgeChance: 0, ...opts.tuning}});
  const spec: ActorSpec = opts.transitions ? {...base, transitions: opts.transitions} : base;
  const a = createActor(spec, opts.at, world.ctx);
  const log: ActorEvent[] = [];
  const step = (dt = DT): ActorEvent[] => {
    world.ctx.now += dt;
    const ev = stepActor(a, spec, dt, world.ctx);
    log.push(...ev);
    return ev;
  };
  const until = (pred: () => boolean, what: string, max = 3000): void => {
    for (let i = 0; i < max; i++) {
      if (pred()) return;
      step();
    }
    throw new Error(`跑了 ${max} 步还没到${what}（状态 ${a.state} / 动作 ${a.action}）`);
  };
  until(() => a.state === 'idle', '落地后 idle');
  return {world, spec, a, log, step, until};
}

// ---------- 换动作 / 转身：按髋骨位置挪脚底点（keepHip） ----------

test('换动作：现在这一帧 +0.1 身高、新动作第 0 帧 -0.1 → 脚底点挪 +24 px；两边都没有 hip 就不挪', () => {
  const frames = 24;
  const rig = makeRig({at: {x: 500, y: FLOOR_Y}, actions: {
    idle: {frames, fps: 12, loop: true, hip: {right: hipArray(frames, 0.1), left: hipArray(frames, 0.1)}},
    a2: {frames: 4, fps: 12, loop: true, hip: {right: hipArray(4, -0.1), left: hipArray(4, -0.1)}},
  }});
  const x0 = rig.a.x;
  setPlan(rig.a, rig.spec, {behavior: 't', steps: [{state: 'act', action: 'a2', sec: 0.5}]}, rig.world.ctx, 'test');
  eq(rig.a.action, 'a2');
  close(rig.a.x, x0 + 0.2 * HEIGHT, 1e-9);   // (0.1 - (-0.1)) × 120

  // 两个动作都没有 hip（= 0）：不挪
  const rig2 = makeRig({at: {x: 500, y: FLOOR_Y}, actions: {
    idle: {frames, fps: 12, loop: true},
    a2: {frames: 4, fps: 12, loop: true},
  }});
  const x1 = rig2.a.x;
  setPlan(rig2.a, rig2.spec, {behavior: 't', steps: [{state: 'act', action: 'a2', sec: 0.5}]}, rig2.world.ctx, 'test');
  eq(rig2.a.action, 'a2');
  eq(rig2.a.x, x1);
});

test('身体位置 bodyX：换动作时脚底点 a.x 挪了，bodyX 不变（Sim 的包围盒、特效按它算；2026-10-22 真机躲着跪坐时按 a.x 算被当成被发现）', () => {
  const frames = 24;
  const rig = makeRig({at: {x: 500, y: FLOOR_Y}, actions: {
    idle: {frames, fps: 12, loop: true, hip: {right: hipArray(frames, 0.1), left: hipArray(frames, 0.1)}},
    kneel: {frames: 4, fps: 12, loop: true, hip: {right: hipArray(4, -0.4), left: hipArray(4, -0.4)}},
  }});
  const {a, spec, world} = rig;
  const x0 = a.x, b0 = bodyX(a, spec, world.ctx);
  close(b0, x0 + 0.1 * HEIGHT, 1e-9);
  setPlan(a, spec, {behavior: 't', steps: [{state: 'act', action: 'kneel', sec: 0.5}]}, world.ctx, 'test');
  close(a.x, x0 + 0.5 * HEIGHT, 1e-9);            // 脚底点挪了 60
  close(bodyX(a, spec, world.ctx), b0, 1e-9);      // 身体没动
});

test('换动作：挪脚底点被脚下那段线段夹住（靠窗口右边时停在 x1 - 1，不挪出线段）', () => {
  const frames = 24;
  // 落到窗口上以后进 idle，idle 的 hip 是 +0.1 → 先按 keepHip 往左挪 12 px（895 → 883）
  const rig = makeRig({at: {x: 895, y: 200}, windows: [makeWindow(10, rect(500, 200, 900, 700))], actions: {
    idle: {frames, fps: 12, loop: true, hip: {right: hipArray(frames, 0.1), left: hipArray(frames, 0.1)}},
    a2: {frames: 4, fps: 12, loop: true, hip: {right: hipArray(4, -0.1), left: hipArray(4, -0.1)}},
  }});
  const {a, spec, world} = rig;
  eq(a.support?.key, 'win:10');
  eq(a.support?.x1, 900);
  close(a.x, 883, 1e-9);
  setPlan(a, spec, {behavior: 't', steps: [{state: 'act', action: 'a2', sec: 0.5}]}, world.ctx, 'test');
  eq(a.action, 'a2');
  eq(a.x, 899);   // 883 + 24 = 907 → 夹到线段右边 899
});

test('转身：步骤带 facing、左右髋骨轨迹不同 → 按新朝向挪脚底点，循环动作接着播（不从头开始）', () => {
  const frames = 24;
  const rig = makeRig({at: {x: 500, y: FLOOR_Y}, actions: {
    idle: {frames, fps: 12, loop: true, hip: {right: hipArray(frames, 0.2), left: hipArray(frames, -0.1)}},
  }});
  const {a, spec, world} = rig;
  a.facing = 1;
  const x0 = a.x, start = a.actionStart;
  setPlan(a, spec, {behavior: 't', steps: [{state: 'idle', action: 'idle', facing: -1, sec: 0.5}]}, world.ctx, 'test');
  eq(a.facing, -1);
  eq(a.action, 'idle');
  eq(a.actionStart, start);   // 同一个循环动作：帧号接着走
  close(a.x, x0 + 0.3 * HEIGHT, 1e-9);   // (0.2 - (-0.1)) × 120
});

// ---------- 过渡（transitionFor / Step.via） ----------

test('过渡：现在这一帧是入口 → 先播过渡动作，播完再到真正的步骤；衣着、特效只在过渡开始时做一次', () => {
  const rig = makeRig({at: {x: 500, y: FLOOR_Y}, actions: {
    idle: {frames: 12, fps: 12, loop: true},
    a2: {frames: 12, fps: 12, loop: true},
    tr: {frames: 6, fps: 12, loop: false},
  }, transitions: [{from: 'idle', to: 'a2', action: 'tr', entries: {idle: [0]}}]});
  const {a, spec, world, log} = rig;
  const ev0 = setPlan(a, spec, {behavior: 't', steps: [{state: 'act', action: 'a2', sec: 0.5, outfit: 'nude', fx: 'puff'}]}, world.ctx, 'test');
  log.push(...ev0);
  // 立刻进过渡：状态已经是那一步的状态，动作是过渡动作，真正的那一步排在计划开头
  eq(a.action, 'tr');
  eq(a.state, 'act');
  eq(a.outfit, 'nude');
  eq(a.step?.via, true);
  eq(a.plan?.steps.length, 1);
  eq(ev0.filter(e => e.type === 'outfit').length, 1);
  eq(ev0.filter(e => e.type === 'fx').length, 1);
  const st0 = ev0.filter(e => e.type === 'state').at(-1)!;
  eq(st0.type === 'state' && st0.from, 'idle');
  eq(st0.type === 'state' && st0.to, 'act');

  // 过渡播完（6 帧 @ 12 fps = 0.5 秒）换成真正的动作
  const t0 = world.ctx.now;
  rig.until(() => a.action === 'a2', '过渡播完、进真正的步骤');
  close(world.ctx.now - t0, 0.5, DT + 1e-6);
  eq(a.plan?.steps.length, 0);
  eq(a.step?.via, undefined);
  eq(a.outfit, 'nude');
  // 真正那一步不再换衣着、不再放特效
  eq(log.filter(e => e.type === 'outfit').length, 1);
  eq(log.filter(e => e.type === 'fx').length, 1);
  eq(log.filter(e => e.type === 'state' && e.to === 'act').length, 2);   // 过渡开始、真正那一步开始

  rig.until(() => a.plan === null, '计划完成');
  const end = log.filter(e => e.type === 'plan-end').at(-1)!;
  eq(end.type === 'plan-end' && end.outcome, 'done');
  eq(log.filter(e => e.type === 'outfit').length, 1);
  eq(log.filter(e => e.type === 'fx').length, 1);
});

test('过渡：循环动作还没到入口帧 → 接着播，到入口帧再插过渡（等的时间不到一圈）', () => {
  const rig = makeRig({at: {x: 500, y: FLOOR_Y}, actions: {
    idle: {frames: 8, fps: 12, loop: true},
    a2: {frames: 4, fps: 12, loop: true},
    tr: {frames: 3, fps: 12, loop: false},
  }, transitions: [{from: 'idle', to: 'a2', action: 'tr', entries: {idle: [3]}}]});
  const {a, spec, world, log} = rig;
  // setPlan 换的计划第一步不等（见下一个测试），所以先站 0.01 秒（同一个循环动作接着播），等的是计划里的第二步
  log.push(...setPlan(a, spec, {behavior: 't', steps: [{state: 'idle', action: 'idle', sec: 0.01}, {state: 'act', action: 'a2', sec: 0.2}]}, world.ctx, 'test'));
  rig.until(() => a.plan?.steps.length === 1 && a.stateEnd > world.ctx.now + 0.02, '第一步做完、第二步开始等入口帧');
  // 没到入口帧：这一步放回去，现在这个动作接着播；计划没空
  eq(a.action, 'idle');
  eq(a.step?.action, 'idle');
  const t0 = a.actionStart;
  rig.until(() => a.action === 'tr', '走到入口帧、开始过渡');
  close(world.ctx.now - t0, 3.5 / 12, DT + 1e-6);   // 等到第 3 帧的正中间
  assert.ok(world.ctx.now - t0 < 8 / 12, '等的时间不到一圈');
  eq(a.step?.via, true);
  rig.until(() => a.plan === null, '计划完成');
});

test('过渡：外面打断换的计划（setPlan）第一步不等入口帧——没到入口就直接换（身体照样对齐），正好在入口才接过渡', () => {
  const actions = {
    idle: {frames: 8, fps: 12, loop: true},
    a2: {frames: 4, fps: 12, loop: true},
    tr: {frames: 3, fps: 12, loop: false},
  };
  const notYet = makeRig({at: {x: 500, y: FLOOR_Y}, actions, transitions: [{from: 'idle', to: 'a2', action: 'tr', entries: {idle: [3]}}]});
  setPlan(notYet.a, notYet.spec, {behavior: 't', steps: [{state: 'act', action: 'a2', sec: 0.2}]}, notYet.world.ctx, 'discovered');
  eq(notYet.a.action, 'a2');
  eq(notYet.a.step?.via, undefined);

  const atEntry = makeRig({at: {x: 500, y: FLOOR_Y}, actions, transitions: [{from: 'idle', to: 'a2', action: 'tr', entries: {idle: [0]}}]});
  setPlan(atEntry.a, atEntry.spec, {behavior: 't', steps: [{state: 'act', action: 'a2', sec: 0.2}]}, atEntry.world.ctx, 'discovered');
  eq(atEntry.a.action, 'tr');
  eq(atEntry.a.step?.via, true);
});

test('过渡：入口帧刚过去一帧也算到了 → 马上插过渡（不再等一圈）', () => {
  const rig = makeRig({at: {x: 500, y: FLOOR_Y}, actions: {
    idle: {frames: 8, fps: 12, loop: true},
    a2: {frames: 4, fps: 12, loop: true},
    tr: {frames: 3, fps: 12, loop: false},
  }, transitions: [{from: 'idle', to: 'a2', action: 'tr', entries: {idle: [0]}}]});
  const {a, spec, world, log} = rig;
  world.ctx.now += 1.5 / 12;   // 现在播到第 1 帧，入口帧 0 刚过去一帧
  log.push(...setPlan(a, spec, {behavior: 't', steps: [{state: 'act', action: 'a2', sec: 0.2}]}, world.ctx, 'test'));
  eq(a.action, 'tr');
  eq(a.step?.via, true);
});

test('过渡：现在是不循环动作、最后一帧才是入口 → 步骤 sec 比片段短也等它播到最后一帧', () => {
  const rig = makeRig({at: {x: 500, y: FLOOR_Y}, actions: {
    idle: {frames: 8, fps: 12, loop: true},
    anim: {frames: 6, fps: 12, loop: false},
    a2: {frames: 4, fps: 12, loop: true},
    tr: {frames: 4, fps: 12, loop: false},
  }, transitions: [{from: 'anim', to: 'a2', action: 'tr', entries: {anim: [5]}}]});
  const {a, spec, world, log} = rig;
  const t0 = world.ctx.now;
  log.push(...setPlan(a, spec, {behavior: 't', steps: [
    {state: 'act', action: 'anim', sec: 0.1},   // 片段 0.5 秒，这一步只停 0.1 秒
    {state: 'act', action: 'a2', sec: 0.3},
  ]}, world.ctx, 'test'));
  eq(a.action, 'anim');
  const animStart = a.actionStart;
  // 第一步 0.1 秒结束时还没播完：动作接着播，计划留着等最后一帧，不从头播
  rig.until(() => world.ctx.now - t0 > 0.2, '过了第一步的 sec');
  eq(a.action, 'anim');
  eq(a.actionStart, animStart);
  eq(a.plan?.behavior, 't');

  rig.until(() => a.action === 'tr', '播到最后一帧、开始过渡');
  const dt = world.ctx.now - t0;
  assert.ok(dt >= 5 / 12, `等到了最后一帧才开始（${dt} 秒）`);
  close(dt, 5.5 / 12, DT + 1e-6);
  eq(a.step?.via, true);
});

test('过渡：过渡动作在这身衣着下没有图（动作的 outfits 不含新衣着）→ 不接，直接换动作', () => {
  const rig = makeRig({at: {x: 500, y: FLOOR_Y}, actions: {
    idle: {frames: 8, fps: 12, loop: true},
    a2: {frames: 4, fps: 12, loop: true},
    tr: {frames: 4, fps: 12, loop: false, outfits: ['clothed']},   // 只在 clothed 下有图
  }, transitions: [{from: 'idle', to: 'a2', action: 'tr', entries: {idle: [0]}}]});
  const {a, spec, world, log} = rig;
  log.push(...setPlan(a, spec, {behavior: 't', steps: [{state: 'act', action: 'a2', sec: 0.2, outfit: 'nude'}]}, world.ctx, 'test'));
  eq(a.action, 'a2');   // 直接换，没插过渡
  eq(a.step?.via, undefined);
  eq(a.outfit, 'nude');
  eq(log.filter(e => e.type === 'outfit').length, 1);
});

// ---------- 从空闲开始的计划等入口帧 / 被发现接着做 ----------

test('从空闲开始的计划要等入口帧也不会丢：计划留着，到入口帧照样播，不重新挑', () => {
  const rig = makeRig({at: {x: 500, y: FLOOR_Y}, actions: {
    idle: {frames: 8, fps: 12, loop: true},
    a2: {frames: 4, fps: 12, loop: true},
    tr: {frames: 4, fps: 12, loop: false},
  }, transitions: [{from: 'idle', to: 'a2', action: 'tr', entries: {idle: [2]}}]});
  const {a, spec, world, log} = rig;
  // 空闲已经播到第 1 帧（入口在第 2 帧），让这一轮 idle 到期，状态机去要计划
  world.ctx.now = a.actionStart + 1 / 12;
  a.stateEnd = world.ctx.now;
  let calls = 0;
  const plan: Plan = {behavior: 'p', steps: [{state: 'act', action: 'a2', sec: 0.2}]};
  world.ctx.choose = () => (++calls === 1 ? plan : null);
  rig.step();
  eq(calls, 1);
  eq(a.plan?.behavior, 'p');
  eq(a.action, 'idle');   // 还没到入口帧：接着播 idle
  eq(a.step?.action, 'idle');

  rig.until(() => a.action === 'tr', '到入口帧、开始过渡');
  eq(calls, 1);           // 等的这段时间没有重新挑计划
  eq(a.plan?.behavior, 'p');
  rig.until(() => a.plan === null, '计划完成');
  const end = log.filter(e => e.type === 'plan-end').at(-1)!;
  eq(end.type === 'plan-end' && end.behavior, 'p');
  eq(end.type === 'plan-end' && end.outcome, 'done');
  eq(log.filter(e => e.type === 'plan' && e.behavior === 'p').length, 1);
});

test('接着做：正在播进 loop 段的过渡时，真正的 loop 段留下、截到 hurrySec，后面的 loop 段丢掉', () => {
  const rig = makeRig({at: {x: 500, y: FLOOR_Y}, actions: {
    idle: {frames: 8, fps: 12, loop: true},
    m2: {frames: 8, fps: 12, loop: true},
    later: {frames: 8, fps: 12, loop: true},
    end: {frames: 4, fps: 12, loop: false},
    tr: {frames: 4, fps: 12, loop: false},
  }, transitions: [{from: 'idle', to: 'm2', action: 'tr', entries: {idle: [0]}}]});
  const {a, spec, world, log} = rig;
  log.push(...setPlan(a, spec, {behavior: 't', steps: [
    {state: 'masturbate', action: 'm2', phase: 'loop', sec: 10},
    {state: 'masturbate', action: 'later', phase: 'loop', sec: 10},
    {state: 'act', action: 'end', sec: 0.2},
  ]}, world.ctx, 'test'));
  eq(a.action, 'tr');
  eq(a.step?.via, true);
  eq(a.phase, 'loop');

  log.push(...continueExposed(a, world.ctx, 'alert', 1));
  assert.ok(log.some(e => e.type === 'fx' && e.fx === 'alert'));
  // 真正的 loop 段还在计划开头，时长截到 1 秒；后面的 loop 段丢掉，收尾留着
  eq(a.plan?.steps.length, 2);
  eq(a.plan?.steps[0].action, 'm2');
  eq(a.plan?.steps[0].sec, 1);
  eq(a.plan?.steps[0].phase, 'loop');
  eq(a.plan?.steps[1].action, 'end');

  rig.until(() => a.action === 'm2', '过渡播完、进真正的 loop 段');
  close(a.stateEnd - a.stateStart, 1, 1e-9);
  eq(a.plan?.steps.length, 1);

  const seen = new Set<string>();
  for (let i = 0; i < 400 && a.plan; i++) { seen.add(a.action); rig.step(); }
  eq(a.plan, null);
  assert.ok(!seen.has('later'), '后面的 loop 段没播');
});

// ---------- 被拎起来：偏移按挪过以后的脚底点算 ----------

test('被拎起来：grabOffset 按换动作挪过以后的脚底点算，拖到同一个光标位置不会跳回去', () => {
  const frames = 8;
  const rig = makeRig({at: {x: 500, y: FLOOR_Y}, actions: {
    idle: {frames, fps: 12, loop: true, hip: {right: hipArray(frames, 0.1), left: hipArray(frames, 0.1)}},
    m2: {frames, fps: 12, loop: true, hip: {right: hipArray(frames, 0.5), left: hipArray(frames, 0.5)}},
  }});
  const {a, spec, world} = rig;
  const x0 = a.x;
  setPlan(a, spec, {behavior: 't', steps: [{state: 'masturbate', action: 'm2', sec: 10}]}, world.ctx, 'test');
  close(a.x, x0 - 0.4 * HEIGHT, 1e-9);   // 换 m2：hip 0.1 → 0.5
  for (let i = 0; i < 5; i++) rig.step();
  const before = a.x;
  const cursor = {x: before, y: FLOOR_Y};   // 光标正好在脚底点上
  grabActor(a, spec, cursor, world.ctx);
  const after = a.x;
  close(after, before + 0.5 * HEIGHT, 1e-9);   // 换 dragged（hip 0）：再挪 +60
  assert.notEqual(after, before);
  eq(a.state, 'dragged');
  eq(a.action, 'dragged');
  // 光标没动：脚底点停在拎起来时挪到的位置，不跳回
  dragActor(a, cursor, world.ctx);
  eq(a.x, after);
});

// ---------- 角色包加载：hip / transitions ----------

const TMP = path.join(PROJECT, 'temp', 'test-packs-transition');

interface TestAction {
  frames: number;
  fps: number;
  loop: boolean;
  hip?: {right?: number[]; left?: number[]};
  transition?: {from: string; to: string};
}

/**
 * temp/test-packs-transition/<名字>/：一个动作一个变体两个朝向，图集只要文件在、帧数 / 帧率对得上。
 * 造包本身在 tests/helpers/temp-pack.ts（和 pack-reactions、away-sim 的夹具共用）。
 */
const makePackDir = (name: string, actions: Record<string, TestAction>, transitions?: readonly Transition[]): string =>
  tempPack('temp/test-packs-transition', name, {actions, transitions});

const OK_ACTIONS: Record<string, TestAction> = {
  idle: {frames: 4, fps: 12, loop: true, hip: {right: [0, 0.1, 0, 0], left: [0, 0, 0, 0]}},
  a2: {frames: 2, fps: 12, loop: true},
  tr: {frames: 3, fps: 12, loop: false, transition: {from: 'idle', to: 'a2'}},
};
const OK_TRANSITIONS: Transition[] = [{from: 'idle', to: 'a2', action: 'tr', entries: {idle: [0, 2]}}];

test('loadPack：hip 逐帧数组长度要和帧数一样、过渡入口帧要在动作里；合法包的 hip / transitions 进 actorSpec', () => {
  assert.throws(() => loadPack(PROJECT, makePackDir('bad-hip', {
    ...OK_ACTIONS, idle: {frames: 4, fps: 12, loop: true, hip: {right: [0, 0, 0]}},
  })), /hip/);
  assert.throws(() => loadPack(PROJECT, makePackDir('bad-entry', OK_ACTIONS,
    [{...OK_TRANSITIONS[0], entries: {idle: [9]}}])), /入口/);

  const pack = loadPack(PROJECT, makePackDir('ok', OK_ACTIONS, OK_TRANSITIONS));
  const spec = pack.actorSpec(DEFAULT_TUNING);
  assert.deepEqual(spec.actions.idle.hip, OK_ACTIONS.idle.hip);
  assert.deepEqual(spec.transitions, OK_TRANSITIONS);
});

test.after(() => fs.rmSync(TMP, {recursive: true, force: true}));
