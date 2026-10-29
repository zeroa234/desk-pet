// 用户离开（N3.1，2026-10-21）Sim 那一侧的单测：src/main/sim.ts 的 setAway / markAway / catchOnReturn / view().user，
// 和 src/pack/index.ts 加载角色包时对 reactions 键 returned 的校验。判定模块 main/away.ts 在 tests/away.test.ts。
// 规则见 src/main/sim.ts “用户离开（N3.1）”一节的注释、src/behavior/mind.ts 的 MindView.user / ReactionDef / KeepOnDiscovered：
//   - view().user：away / locked / awaySec（从第一次离开算，换种类不重算）、idleSec 原样给；
//   - 离开期间 choose 选中的 R18 行为、双人行为记号（Character.awayDeeds、Duo.away）；回来时还在明处做就撞见：
// （开源版省略）
//     躲在窗口后面 / 就地躲着的不算；被拎着 / 掉着 / 跳着回来也不算；
// （开源版省略）
//   - seen = false（暂停、藏起来时回来）不撞见，但记号清掉；回来以后记号都清掉（第二次离开只算第二次的）。
// 用假角色包 + 假场景（tests/helpers/fake-scene.ts）、假桌面（tests/helpers/fake-desktop.ts），不读 packs/ 下的导出生成物；
// 显示器 1920×1080、任务栏 40 px（地面 y = 1040）、角色高 120、半宽 30；时间按 1/30 秒推进，rng 固定种子。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {DEFAULT_TUNING, setPlan, type Actor, type BehaviorDef, type Brain, type MindConfig, type Tuning} from '../src/behavior/index.ts';
import {Sim, type SimEvent} from '../src/main/sim.ts';
import {loadPack} from '../src/pack/index.ts';
import type {Point, WinInfo} from '../src/shared/types.ts';
import {DT, FLOOR_Y, SCENE_VARIANT, drive, makeDuo, makePack, type FakePackOptions} from './helpers/fake-scene.ts';
import {makeDisplay, makeWindow, mulberry32, rect} from './helpers/fake-desktop.ts';
import {close, eq} from './helpers/assert.ts';
import {PROJECT, tempPack} from './helpers/temp-pack.ts';

// ---------- 公共夹具 ----------

/** 1920×1080、100% 缩放、任务栏 40 px（地面 y = 1040） */
const DISPLAY = makeDisplay(1, rect(0, 0, 1920, 1080));

/** 站着 100 秒（兜底，不换行为） */
const IDLE: BehaviorDef = {id: 'idle', weight: 1, steps: [{do: 'idle', sec: [100, 100]}]};
/** 站着 0.5 秒：空下来就重新挑（看下一段离开里会不会再选到 R18 行为） */
const IDLE_SHORT: BehaviorDef = {id: 'idle', weight: 1, steps: [{do: 'idle', sec: [0.5, 0.5]}]};

/**
 * 两套分得开的被发现反应：returned 用 react 状态 + heart，discovered 用 act 状态 + wave + alert；
 * 效果也不同（mood −7 / −3），用来断言用的是哪一个（计划名都是 reaction:returned）。
 */
const REACTIONS: NonNullable<MindConfig['reactions']> = {
  returned: {steps: [{do: 'play', action: 'idle', sec: [0.5, 0.5], state: 'react', fx: 'heart'}], effects: {'stats.mood': -7}},
  discovered: {steps: [{do: 'play', action: 'wave', sec: [0.5, 0.5], state: 'act', fx: 'alert'}], effects: {'stats.mood': -3}},
};

/** （开源版省略） */
function masturbateAway(extra: Partial<BehaviorDef> = {}): BehaviorDef {
  return {id: 'mast', weight: 1_000_000, when: {'var': 'user.away'}, r18: true,
    steps: [{do: 'outfit', to: 'nude'}, {do: 'play', action: 'masturbate', state: 'masturbate', phase: 'loop', sec: [100, 100]}], ...extra};
}

/** 一个角色包的脑子：给行为表（默认只有 idle）+ 反应；mood 用来断言反应的效果 */
function mindOf(opts: {behaviors?: readonly BehaviorDef[]; reactions?: MindConfig['reactions']} = {}): MindConfig {
  return {schema: 1, stats: {desire: {start: 90}, mood: {start: 50}}, relations: {user: {affection: 50}},
    ...(opts.reactions ? {reactions: opts.reactions} : {}), behaviors: opts.behaviors ?? [IDLE]};
}

interface Solo {
  sim: Sim;
  a: Actor;
  brain: Brain;
  /** 推进一帧（DT），返回这一帧的事件 */
  frame(): {id: string; e: SimEvent}[];
  frames(n?: number): void;
  /** 推进到条件成立（先看现在，再一帧一帧走）；超时抛错 */
  until(pred: () => boolean, what: string, maxFrames?: number): void;
}

/** 造一个单个角色的 Sim（假角色包 's'、1920×1080 显示器、固定种子）；overlay 是“别的窗口压在她那一层上面” */
function makeSolo(opts: {mind?: MindConfig; windows?: WinInfo[]; overlay?: Record<number, readonly number[]>; at?: Point; outfit?: string;
  extraActions?: FakePackOptions['extraActions']} = {}): Solo {
  const tuning: Tuning = {...DEFAULT_TUNING, idleSec: [0, 0], walkMaxSec: 600};
  const pack = makePack({id: 's', mind: opts.mind ?? mindOf(), ...(opts.extraActions ? {extraActions: opts.extraActions} : {})});
  const sim = new Sim([pack], tuning, {variant: SCENE_VARIANT, heightLogical: 120, r18: true}, mulberry32(3),
    {unlocked: [], playSeconds: 0, chars: {s: {stats: {}, relations: {}}}}, new Map());
  sim.setDesktop({displays: [DISPLAY], windows: opts.windows ?? [], ...(opts.overlay ? {overlayAbove: opts.overlay} : {})});
  sim.spawn('s', opts.at ?? {x: 500, y: FLOOR_Y}, opts.outfit);
  const a = sim.charOf('s')!.actor!;
  const frame = (): {id: string; e: SimEvent}[] => sim.step(sim.now + DT, DT);
  const frames = (n = 1): void => { for (let i = 0; i < n; i++) frame(); };
  const until = (pred: () => boolean, what: string, maxFrames = 900): void => {
    for (let i = 0; i < maxFrames; i++) {
      if (pred()) return;
      frame();
    }
    if (!pred()) throw new Error(`跑了 ${maxFrames} 帧还没到${what}（state ${a.state} / 计划 ${a.plan?.behavior ?? '—'} / 层 ${a.layer.kind}）`);
  };
  return {sim, a, brain: sim.charOf('s')!.brain, frame, frames, until};
}

/** 用户离开（main.ts 的 AwayTracker 报的那一下）：之后 choose 选中的 R18 / 双人行为要记号 */
function leave(fx: {sim: Sim}, kind: 'idle' | 'locked' = 'idle'): void {
  fx.sim.setAway(kind, fx.sim.now);
}

/** 用户回来（seen 默认 true）：catchOnReturn 往 extra 里放的事件在下一 tick 开头给出 */
function back<F extends {sim: Sim; frame(): {id: string; e: SimEvent}[]}>(fx: F, seen = true): {id: string; e: SimEvent}[] {
  fx.sim.setAway(null, fx.sim.now, seen);
  return fx.frame();
}

type DiscoveredEvent = Extract<SimEvent, {type: 'discovered'}>;

/** 这一帧里的 discovered 事件（按角色 id 排好） */
function discovered(evs: readonly {id: string; e: SimEvent}[]): {id: string; e: DiscoveredEvent}[] {
  return evs.filter((x): x is {id: string; e: DiscoveredEvent} => x.e.type === 'discovered').sort((p, q) => p.id.localeCompare(q.id));
}

// ---------- 1. view().user ----------

test('view 的 user：在的时候 away / locked 都是 false、awaySec 0，idleSec 原样给', () => {
  const fx = makeSolo();
  fx.until(() => fx.a.state === 'idle', '站稳');
  fx.sim.userIdleSec = 42;
  const c = fx.sim.charOf('s')!;
  assert.deepEqual(fx.sim.view(c).user, {idleSec: 42, away: false, locked: false, awaySec: 0, pokes: 0});
});

test('setAway(idle) 后 away、awaySec 从离开那一刻算；换成 locked 不重算 since', () => {
  const fx = makeSolo();
  fx.until(() => fx.a.state === 'idle', '站稳');
  const c = fx.sim.charOf('s')!;
  leave(fx);
  let u = fx.sim.view(c).user;
  eq(u.away, true);
  eq(u.locked, false);
  eq(u.awaySec, 0, '刚离开时 awaySec 应该是 0');

  fx.frames(60);                                          // 2 秒
  u = fx.sim.view(c).user;
  close(u.awaySec, 2, DT + 1e-9, '离开 2 秒后的 awaySec');

  // 离开期间锁屏（main.ts 报 away-kind）：locked 变 true，awaySec 还是从第一次判离开算
  fx.sim.setAway('locked', fx.sim.now);
  u = fx.sim.view(c).user;
  eq(u.away, true);
  eq(u.locked, true);
  close(u.awaySec, 2, DT + 1e-9, '换种类以后的 awaySec');

  // 用户回来了：都清掉
  back(fx);
  u = fx.sim.view(c).user;
  eq(u.away, false);
  eq(u.locked, false);
  eq(u.awaySec, 0);
});

test('setAway 给的时刻比 sim.now 晚（两个时钟差半拍）：awaySec 是 0，不是负数', () => {
  const fx = makeSolo();
  fx.until(() => fx.a.state === 'idle', '站稳');
  fx.sim.setAway('idle', fx.sim.now + 30);
  const u = fx.sim.view(fx.sim.charOf('s')!).user;
  eq(u.away, true);
  eq(u.awaySec, 0);
});

// ---------- 2. 离开期间选中的行为记号 ----------

test('离开期间选中的 R18 行为记号（awayDeeds）', () => {
  const fx = makeSolo({mind: mindOf({behaviors: [masturbateAway(), IDLE]})});
  leave(fx);                                              // 一出生就离开：落地后第一次 choose 就在离开期间
  fx.until(() => fx.a.plan?.behavior === 'mast', '选到只在离开时做的 R18 行为');
  eq(fx.sim.charOf('s')!.awayDeeds, true);
  eq(fx.a.state, 'strip', '第一步是换衣着的过渡（一团烟）');
});

test('不在的时候选中的 R18 行为、离开期间选中的非 R18 行为都不记号', () => {
  // 不在的时候：同一个 R18 行为（去掉 when）照常可选，但不该记号
  const notAway = makeSolo({mind: mindOf({behaviors: [{...masturbateAway(), when: undefined}, IDLE]})});
  notAway.until(() => notAway.a.plan?.behavior === 'mast', '选到 R18 行为');
  eq(notAway.sim.charOf('s')!.awayDeeds, false);

  // 离开期间：选中的行为不是 R18，也不该记号
  const nonR18 = makeSolo({mind: mindOf({behaviors: [
    {id: 'look-around', weight: 1_000_000, when: {'var': 'user.away'}, steps: [{do: 'idle', sec: [100, 100]}]}, IDLE]})});
  leave(nonR18);
  nonR18.until(() => nonR18.a.plan?.behavior === 'look-around', '选到非 R18 行为');
  eq(nonR18.sim.charOf('s')!.awayDeeds, false);
});

// ---------- 3a. 回来撞见（reactions.returned / 没写用 discovered） ----------

test('回来撞见：离开期间开始的 R18 行为还在做，有 reactions.returned 就用它（计划 reaction:returned、by:return、没有 hwnd）', () => {
  const fx = makeSolo({mind: mindOf({behaviors: [masturbateAway(), IDLE], reactions: REACTIONS})});
  leave(fx);
  fx.until(() => fx.a.state === 'masturbate', '光着自慰');
  eq(fx.a.outfit, 'nude');
  const mood0 = fx.brain.stats.mood;

  const evs = back(fx);
  const found = discovered(evs);
  eq(found.length, 1, '应该正好一条 discovered');
  eq(found[0].id, 's');
  eq(found[0].e.by, 'return');
  eq(found[0].e.hwnd, undefined, '回来撞见没有窗口');
  eq(found[0].e.cover, undefined);
  eq(found[0].e.continued, undefined);
  eq(found[0].e.naked, undefined);

  // 换成 reactions.returned 的计划；旧计划按 reason 'returned' 中止
  eq(fx.a.plan?.behavior, 'reaction:returned');
  eq(fx.a.state, 'react');
  eq(fx.a.action, 'idle');
  assert.ok(evs.some(x => x.e.type === 'fx' && x.e.fx === 'heart'), 'returned 的 fx 没放');
  eq(fx.brain.stats.mood, mood0 - 7, 'returned 的效果');
  const ended = evs.find(x => x.e.type === 'plan-end' && x.e.behavior === 'mast')?.e;
  assert.ok(ended && ended.type === 'plan-end', '旧计划没有中止');
  eq(ended.outcome, 'aborted');
  eq(ended.reason, 'returned');
  // 记号清掉
  eq(fx.sim.charOf('s')!.awayDeeds, false);
  eq(fx.sim.away, null);
});

test('回来撞见：没写 reactions.returned 就用 reactions.discovered（计划名还是 reaction:returned）', () => {
  const fx = makeSolo({mind: mindOf({behaviors: [masturbateAway(), IDLE], reactions: {discovered: REACTIONS.discovered}})});
  leave(fx);
  fx.until(() => fx.a.state === 'masturbate', '光着自慰');
  const mood0 = fx.brain.stats.mood;

  const evs = back(fx);
  eq(discovered(evs).length, 1);
  eq(fx.a.plan?.behavior, 'reaction:returned');
  eq(fx.a.state, 'act', '用的是 discovered 的步骤（act / wave）');
  eq(fx.a.action, 'wave');
  assert.ok(evs.some(x => x.e.type === 'fx' && x.e.fx === 'alert'), 'discovered 的 fx 没放');
  eq(fx.brain.stats.mood, mood0 - 3, 'discovered 的效果');
});

test('回来撞见：行为的 discovered 规则成立就接着做完（continued、计划不换、loop 段截短）', () => {
  const mast = masturbateAway({discovered: {when: {'>=': [{var: 'self.stepSec'}, 1]}, hurry: [2, 2], fx: 'alert', effects: {'stats.mood': -5}}});
  const fx = makeSolo({mind: mindOf({behaviors: [mast, IDLE], reactions: REACTIONS})});
  leave(fx);
  fx.until(() => fx.a.state === 'masturbate' && fx.sim.now - fx.a.stateStart >= 2, '自慰两秒');
  const mood0 = fx.brain.stats.mood;

  const evs = back(fx);
  const found = discovered(evs);
  eq(found.length, 1);
  eq(found[0].e.continued, true);
  eq(found[0].e.by, 'return');
  eq(fx.a.plan?.behavior, 'mast', '接着做的时候不该换计划');
  eq(fx.a.state, 'masturbate');
  eq(fx.a.outfit, 'nude');
  assert.ok(evs.some(x => x.e.type === 'fx' && x.e.fx === 'alert'), '没冒感叹号');
  eq(fx.brain.stats.mood, mood0 - 5, 'discovered.effects 照算');
  assert.ok(fx.a.stateEnd - fx.sim.now <= 2 + 1e-9, `loop 段还剩 ${(fx.a.stateEnd - fx.sim.now).toFixed(2)} 秒，应该截到 2 秒以内`);
});

// ---------- 3c. 离开期间开始、回来还穿着走路 ----------

test('离开期间开始、回来时还穿着衣服在走（还没到脱衣那一步）：不撞见，计划不变', () => {
  const def: BehaviorDef = {id: 'walk-then-nude', weight: 1_000_000, when: {'var': 'user.away'}, r18: true, steps: [
    {do: 'wander', action: 'walk'},
    {do: 'outfit', to: 'nude'},
  ]};
  const fx = makeSolo({mind: mindOf({behaviors: [def, IDLE], reactions: REACTIONS})});
  leave(fx);
  fx.until(() => fx.a.plan?.behavior === 'walk-then-nude' && fx.a.state === 'walk', '开始走');
  eq(fx.sim.charOf('s')!.awayDeeds, true);
  eq(fx.a.outfit, 'clothed');

  const evs = back(fx);
  eq(discovered(evs).length, 0, '还穿着走路的不用撞见');
  eq(fx.a.plan?.behavior, 'walk-then-nude');
  eq(fx.a.state, 'walk');
  eq(fx.a.outfit, 'clothed');
});

test('离开期间正在脱（strip 状态、衣服还没换）也算在明处做：回来撞见', () => {
  // （开源版省略）
  const fx = makeSolo({mind: mindOf({behaviors: [masturbateAway(), IDLE], reactions: REACTIONS}),
    extraActions: {strip: {clip: 'strip', frames: 24, fps: 12, loop: false, switchSec: 0.5}}});
  leave(fx);
  fx.until(() => fx.a.state === 'strip', '开始脱');
  eq(fx.a.outfit, 'clothed', '脱衣片段还没播到换装那一下');
  eq(fx.sim.charOf('s')!.awayDeeds, true);

  const evs = back(fx);
  const found = discovered(evs);
  eq(found.length, 1, '正在脱也算撞见');
  eq(found[0].e.by, 'return');
  eq(fx.a.plan?.behavior, 'reaction:returned');
  eq(fx.brain.stats.mood, 43);                            // returned 的效果（mood 50 − 7）
});

// （开源版省略）

test('离开期间做完了 R18、回来光着在 idle：冒反应（by:return、naked:true、计划 reaction:returned）', () => {
  const short: BehaviorDef = {id: 'short-mast', weight: 1_000_000, when: {'var': 'user.away'}, r18: true, cooldown: 1000,
    steps: [{do: 'outfit', to: 'nude'}, {do: 'play', action: 'masturbate', state: 'masturbate', phase: 'loop', sec: [0.5, 0.5]}]};
  const fx = makeSolo({mind: mindOf({behaviors: [short, IDLE], reactions: REACTIONS})});
  leave(fx);
  fx.until(() => fx.a.plan?.behavior === 'idle' && fx.a.outfit === 'nude', '做完以后光着闲着');
  eq(fx.sim.charOf('s')!.awayDeeds, true);
  const mood0 = fx.brain.stats.mood;

  const evs = back(fx);
  const found = discovered(evs);
  eq(found.length, 1);
  eq(found[0].e.by, 'return');
  eq(found[0].e.naked, true);
  eq(found[0].e.hwnd, undefined);
  eq(found[0].e.continued, undefined);
  eq(fx.a.plan?.behavior, 'reaction:returned');
  eq(fx.a.state, 'react');
  eq(fx.brain.stats.mood, mood0 - 7);
  eq(fx.sim.charOf('s')!.awayDeeds, false);
});

test('离开前就光着、离开期间没做事：回来不冒反应', () => {
  const fx = makeSolo({mind: mindOf(), outfit: 'nude'});
  fx.until(() => fx.a.state === 'idle', '站稳');
  eq(fx.a.outfit, 'nude');
  leave(fx);
  fx.frames(10);
  const evs = back(fx);
  eq(discovered(evs).length, 0);
  eq(fx.a.plan?.behavior, 'idle');
  eq(fx.sim.charOf('s')!.awayDeeds, false);
});

// ---------- 3e. 躲在窗口后面 / 就地躲着 ----------

test('躲在窗口后面（layer behind）做的：回来不管（不撞见、计划不变）', () => {
  // 盖满地面的普通窗口（不置顶）：gotoHide 找得到“整个躲进去”的位置
  const MAX = makeWindow(10, rect(0, 0, 1920, FLOOR_Y));
  const hideMast: BehaviorDef = {id: 'hide-mast', weight: 1_000_000, when: {'var': 'user.away'}, r18: true, steps: [
    {do: 'gotoHide', action: 'walk'},
    {do: 'hide', sec: [0.3, 0.3]},
    {do: 'outfit', to: 'nude'},
    {do: 'play', action: 'masturbate', state: 'masturbate', phase: 'loop', sec: [100, 100]},
  ]};
  const fx = makeSolo({mind: mindOf({behaviors: [hideMast, IDLE], reactions: REACTIONS}), windows: [MAX]});
  leave(fx);
  fx.until(() => fx.a.state === 'masturbate', '在窗口后面光着自慰');
  eq(fx.a.layer.kind, 'behind');
  eq(fx.a.outfit, 'nude');
  eq(fx.sim.charOf('s')!.awayDeeds, true);
  eq(fx.sim.charOf('s')!.coverHide, null);

  const evs = back(fx);
  eq(discovered(evs).length, 0, '躲在窗口后面的不算撞见');
  eq(fx.a.plan?.behavior, 'hide-mast');
  eq(fx.a.state, 'masturbate');
  eq(fx.a.layer.kind, 'behind');
});

test('就地躲着（hideHere）做的：回来不管', () => {
  // 置顶窗口 + overlayAbove：front 层被她那个窗口整个盖住，hideHere 记下 coverHide
  const FULL = makeWindow(20, rect(0, 0, 1920, 1080), {topmost: true});
  const hereMast: BehaviorDef = {id: 'here-mast', weight: 1_000_000, when: {'var': 'user.away'}, r18: true, steps: [
    {do: 'hideHere', sec: [0.3, 0.3]},
    {do: 'outfit', to: 'nude'},
    {do: 'play', action: 'masturbate', state: 'masturbate', phase: 'loop', sec: [100, 100]},
  ]};
  const fx = makeSolo({mind: mindOf({behaviors: [hereMast, IDLE], reactions: REACTIONS}), windows: [FULL], overlay: {1: [20]}});
  leave(fx);
  fx.until(() => fx.a.state === 'masturbate', '就地躲着光着自慰');
  eq(fx.a.layer.kind, 'front', '就地躲着还在 front 层');
  eq(fx.sim.charOf('s')!.coverHide?.behavior, 'here-mast');
  eq(fx.a.outfit, 'nude');
  eq(fx.sim.charOf('s')!.awayDeeds, true);

  const evs = back(fx);
  eq(discovered(evs).length, 0, '就地躲着的（用户看不见）不算撞见');
  eq(fx.a.plan?.behavior, 'here-mast');
  eq(fx.a.state, 'masturbate');
});

test('在窗口里面（layer inside）做的算明处：回来照样撞见', () => {
  // 窗口 100..900 × 300..700，里面的底边 y = 698（N2.4）
  const WIN = makeWindow(10, rect(100, 300, 900, 700));
  const fx = makeSolo({mind: mindOf({behaviors: [masturbateAway(), IDLE], reactions: REACTIONS}), windows: [WIN]});
  leave(fx);
  fx.until(() => fx.a.state === 'masturbate', '光着自慰');
  // 拎起来放进窗口里面松手：落到窗口里面的底边，在离开期间重新选到 R18 行为
  fx.sim.grab('s', {x: fx.a.x, y: fx.a.y});
  fx.sim.drag({x: 500, y: 690});
  fx.sim.release();
  fx.until(() => fx.a.support?.kind === 'inside', '落到窗口里面的底边', 300);
  fx.until(() => fx.a.state === 'masturbate', '在窗口里面重新开始自慰', 300);
  eq(fx.a.layer.kind, 'inside');
  eq(fx.a.outfit, 'nude');
  eq(fx.sim.charOf('s')!.awayDeeds, true);

  const evs = back(fx);
  eq(discovered(evs).length, 1, '在窗口里面不算躲着，回来应该撞见');
  eq(fx.a.plan?.behavior, 'reaction:returned');
});

// ---------- 3f. 双人 ----------

/** 只在用户离开时邀请的双人行为（r18；desire 90 够 b 的 accept 门槛 40），反应两套都写 */
function awayDuoMind(): MindConfig {
  return {schema: 1, stats: {desire: {start: 90}, mood: {start: 50}}, relations: {b: {affection: 50}},
    reactions: REACTIONS,
    behaviors: [{id: 'sex', weight: 1_000_000, when: {'var': 'user.away'}, r18: true,
      duo: {kind: 'sex', with: ['b'], scenes: ['s1'], loops: [0, 0]}}, IDLE]};
}

test('双人：离开期间邀请的、回来时在播 → 两人都被撞见（场景散了，各一条 by:return、计划 reaction:returned）', () => {
  const fx = makeDuo({aMind: awayDuoMind()});
  leave(fx);
  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'play', 'play');
  eq(fx.sim.duos[0].away, true, '离开期间邀请的双人要记号（Duo.away）');
  eq(fx.sim.charOf('a')!.awayDeeds, true);
  eq(fx.sim.charOf('b')!.awayDeeds, true, '被邀请的对方也记号');

  const evs = back(drv);
  eq(fx.sim.duos.length, 0, '场景应该散了');
  assert.ok(evs.some(x => x.e.type === 'duo' && x.e.what === 'dissolved' && x.e.reason === 'returned'), '没有 duo dissolved returned');
  const found = discovered(evs);
  assert.deepEqual(found.map(x => x.id), ['a', 'b'], '两人各一条 discovered');
  for (const x of found) {
    eq(x.e.by, 'return');
    eq(x.e.hwnd, undefined);
    eq(x.e.continued, undefined);
  }
  const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
  eq(a.plan?.behavior, 'reaction:returned');
  eq(b.plan?.behavior, 'reaction:returned');
  // discoverDuo 先放一团烟（state sex / phase end，0.6 秒）再走反应步骤
  eq(a.state, 'sex');
  eq(a.phase, 'end');
  eq(b.state, 'sex');
  eq(b.phase, 'end');
  eq(fx.sim.charOf('a')!.awayDeeds, false);
  eq(fx.sim.charOf('b')!.awayDeeds, false);
});

test('双人：离开期间邀请的、回来时走过去阶段有人已经光着 → 两人都被撞见', () => {
  const fx = makeDuo({aMind: awayDuoMind()});
  leave(fx);
  const drv = drive(fx.sim);
  drv.until(() => fx.sim.duos[0]?.stage === 'approach'
    && (fx.sim.charOf('a')!.actor!.outfit !== 'clothed' || fx.sim.charOf('b')!.actor!.outfit !== 'clothed'), '走过去阶段有人光着', 10);
  const evs = back(drv);
  const found = discovered(evs);
  assert.deepEqual(found.map(x => x.id), ['a', 'b']);
  eq(fx.sim.duos.length, 0);
});

test('双人：离开期间邀请的、回来时两人还穿着走过去 → 不撞见，接着走到开播', () => {
  const fx = makeDuo({aMind: awayDuoMind()});
  leave(fx);
  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'invite', 'invite');
  const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
  eq(a.state, 'walk');
  eq(b.state, 'walk');
  eq(a.outfit, 'clothed');
  eq(b.outfit, 'clothed');

  const evs = back(drv);
  eq(discovered(evs).length, 0, '两人还穿着走过去的不撞见');
  eq(fx.sim.duos.length, 1);
  eq(fx.sim.duos[0].stage, 'approach');
  eq(a.plan?.behavior, 'duo:sex');
  // 记号清掉了，接着走到开播（这时才脱），没被再一次撞见
  drv.until(e => e.type === 'duo' && e.what === 'play', 'play', 10);
  eq(a.outfit, 'nude');
  eq(b.outfit, 'nude');
  eq(drv.log.filter(x => x.e.type === 'discovered').length, 0);
});

test('双人：不在的时候开始的双人（不是离开期间邀请的），回来不管', () => {
  const fx = makeDuo();                                   // makeDuo 默认 a 的 duo 行为不看 user.away
  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'play', 'play');
  eq(fx.sim.duos[0].away, undefined);
  leave(fx);
  const evs = back(drv);
  eq(discovered(evs).length, 0);
  eq(fx.sim.duos.length, 1, '不在的时候邀请的双人不算撞见');
  eq(fx.sim.charOf('a')!.actor!.plan?.behavior, 'duo:sex');
  eq(fx.sim.charOf('b')!.actor!.plan?.behavior, 'duo:sex');
});

test('双人：在窗口后面做的（d.layer behind），回来不管', () => {
  const W = makeWindow(10, rect(0, 0, 1920, 1080));
  const fx = makeDuo({aMind: awayDuoMind(), windows: [W]});
  const b = fx.sim.charOf('b')!.actor!;
  // b 躲到 W 后面（手动给一个 hide 计划，和 tests/duo.test.ts 的“在窗口后面做”一样）
  setPlan(b, fx.bPack.actorSpec(fx.tuning),
    {behavior: 'hide', steps: [{state: 'hide', action: 'idle', sec: 1000, layer: {kind: 'behind', hwnd: 10}}]}, fx.sim.ctx(), 'test');
  eq(b.layer.kind, 'behind');
  leave(fx);
  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'play', 'play');
  const d = fx.sim.duos[0];
  eq(d.layer.kind, 'behind');
  eq(d.away, true);

  const evs = back(drv);
  eq(discovered(evs).length, 0, '在窗口后面做的不算撞见');
  eq(fx.sim.duos.length, 1);
  eq(fx.sim.charOf('a')!.actor!.plan?.behavior, 'duo:sex');
});

// ---------- 3g / 3h. 回来以后记号清掉 ----------

test('setAway(null, now, false)（暂停 / 藏起来时回来）：不撞见，但记号清掉，之后离开、回来也不会再算之前那件事', () => {
  const fx = makeSolo({mind: mindOf({behaviors: [masturbateAway(), IDLE], reactions: REACTIONS})});
  leave(fx);
  fx.until(() => fx.a.state === 'masturbate', '光着自慰');
  const mood0 = fx.brain.stats.mood;

  const evs = back(fx, false);
  eq(discovered(evs).length, 0, 'seen = false 不撞见任何人');
  eq(fx.a.plan?.behavior, 'mast', '计划不该换');
  eq(fx.a.state, 'masturbate');
  eq(fx.brain.stats.mood, mood0, '不该算反应的效果');
  eq(fx.sim.away, null);
  eq(fx.sim.charOf('s')!.awayDeeds, false, '回来以后记号清掉');

  // （开源版省略）
  leave(fx);
  const evs2 = back(fx);
  eq(discovered(evs2).length, 0, '清掉的记号不该再算');
  eq(fx.a.plan?.behavior, 'mast');
});

test('第二次离开里没开始新的事不撞见，重新开始了才再撞见（只算这次离开期间的）', () => {
  const fx = makeSolo({mind: mindOf({behaviors: [masturbateAway(), IDLE_SHORT], reactions: REACTIONS})});
  // （开源版省略）
  leave(fx);
  fx.until(() => fx.a.state === 'masturbate', '第一次自慰中');
  eq(discovered(back(fx)).length, 1);
  eq(fx.a.plan?.behavior, 'reaction:returned');
  // 反应做完空下来（没在离开，挑的是 idle）
  fx.until(() => fx.a.plan?.behavior === 'idle', '反应做完空下来', 120);
  eq(fx.sim.charOf('s')!.awayDeeds, false);

  // 第二次离开、马上回来：期间没有新的 R18，不撞见
  leave(fx);
  eq(discovered(back(fx)).length, 0, '第二次离开期间没开始新的事，不该撞见');
  // 第三次离开：等她自己再选到 R18 行为，回来又撞见
  leave(fx);
  fx.until(() => fx.a.state === 'masturbate', '第二次自慰中', 120);
  eq(discovered(back(fx)).length, 1);
});

// ---------- 3i. 被拎着 / 掉着 / 跳着 ----------

test('被拎着（dragged）回来：不撞见', () => {
  const fx = makeSolo({mind: mindOf({behaviors: [masturbateAway(), IDLE], reactions: REACTIONS})});
  leave(fx);
  fx.until(() => fx.a.state === 'masturbate', '光着自慰');
  fx.sim.grab('s', {x: fx.a.x, y: fx.a.y - 60});
  eq(fx.a.state, 'dragged');
  eq(fx.a.plan, null, '拎起来中止了自慰的计划');
  eq(fx.sim.charOf('s')!.awayDeeds, true, '拎起来不清记号');

  const evs = back(fx);
  eq(discovered(evs).length, 0, '被拎着的时候回来不算撞见');
  eq(fx.a.plan, null);
  eq(fx.a.state, 'dragged');
});

test('被扔出去、掉着（fall）回来：不撞见', () => {
  const fx = makeSolo({mind: mindOf({behaviors: [masturbateAway(), IDLE], reactions: REACTIONS})});
  leave(fx);
  fx.until(() => fx.a.state === 'masturbate', '光着自慰');
  // 拎起来甩到空中松手：进 fall
  fx.sim.grab('s', {x: fx.a.x, y: fx.a.y - 60});
  fx.sim.drag({x: 700, y: 400});
  fx.sim.drag({x: 900, y: 300});
  fx.sim.release();
  eq(fx.a.state, 'fall');
  eq(fx.sim.charOf('s')!.awayDeeds, true);

  const evs = back(fx);
  eq(discovered(evs).length, 0, '掉着的时候回来不算撞见');
  eq(fx.a.state, 'fall');
});

test('跳着（jump）回来：不撞见', () => {
  // 窗口顶边 y = 900 从地面跳得上去（jumpUpHeights 1.5 × 身高 120 = 180 > 140）
  const W = makeWindow(10, rect(100, 900, 900, 1080));
  const hop: BehaviorDef = {id: 'hop-nude', weight: 1_000_000, when: {'var': 'user.away'}, r18: true,
    steps: [{do: 'outfit', to: 'nude'}, {do: 'hop'}]};
  const fx = makeSolo({mind: mindOf({behaviors: [hop, IDLE], reactions: REACTIONS}), windows: [W]});
  leave(fx);
  fx.until(() => fx.a.state === 'jump', '跳起来');
  eq(fx.a.outfit, 'nude');
  eq(fx.sim.charOf('s')!.awayDeeds, true);
  eq(fx.sim.charOf('s')!.coverHide, null);

  const evs = back(fx);
  eq(discovered(evs).length, 0, '跳着的时候回来不算撞见');
  eq(fx.a.state, 'jump');
});

// ---------- 3j. 不在的时候 setAway(null) ----------

test('不在的时候 setAway(null) 什么都不做', () => {
  const fx = makeSolo({mind: mindOf({behaviors: [masturbateAway(), IDLE], reactions: REACTIONS})});
  fx.until(() => fx.a.state === 'idle', '站稳');
  const plan = fx.a.plan;
  fx.sim.setAway(null, fx.sim.now);                       // 没离开过
  const evs = fx.frame();
  eq(evs.length, 0, '不该有任何事件');
  eq(fx.a.plan, plan, '计划不该被动过');
  eq(fx.a.state, 'idle');
  eq(fx.sim.away, null);
});

// ---------- 4. loadPack 对 reactions.returned 的校验 ----------

/**
 * temp/test-packs-away/<名字>/：idle 一个动作、clothed 一种衣着、一个变体两个朝向，reactions 写进 behaviors.json。
 * 造包本身在 tests/helpers/temp-pack.ts（和 pack-reactions、transition 的夹具共用）。
 */
const makePackDir = (name: string, reactions: unknown): string => tempPack('temp/test-packs-away', name, {reactions});

const REACT = {steps: [{do: 'play', action: 'idle', sec: 1, state: 'react'}]};

test('loadPack：reactions.returned 合法；returned:head、sex:returned 拒绝', () => {
  const ok = loadPack(PROJECT, makePackDir('ok-returned', {returned: REACT, discovered: REACT}));
  assert.ok(ok.mind, '带 returned 的角色包应该加载得进来');
  // 只能整个写：带部位、加 sex: 都不行
  assert.throws(() => loadPack(PROJECT, makePackDir('bad-returned-part', {'returned:head': REACT})), /returned:head/);
  assert.throws(() => loadPack(PROJECT, makePackDir('bad-sex-returned', {'sex:returned': REACT})), /sex:returned/);
});

test.after(() => fs.rmSync(path.join(PROJECT, 'temp', 'test-packs-away'), {recursive: true, force: true}));
