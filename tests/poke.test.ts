// 被点 / 被摸（R3.6、N1.3）的单测：Brain.reaction 挑反应（单个 / 一串、when、weight、r18、冷却、_comment），
// Sim.poke 把反应接到角色上（换计划 / 只叠加、部位序号、fx / sound / effects、双人按光标近的人、拖拽和下落不理、
// 全年龄跳过 r18、user.pokes 的 60 秒窗口）。规则见 src/behavior/mind.ts 的 ReactionDef、src/behavior/brain.ts 的
// reaction()、src/main/sim.ts 的 poke()、docs/state-rules.md §2.1 / §3。
// 用假角色包 / 假场景（tests/helpers/fake-scene.ts），不读 packs/ 下的导出生成物；时间按 1/30 秒推进，rng 固定种子。
import test from 'node:test';
import assert from 'node:assert/strict';

import {Brain, DEFAULT_TUNING, REACTION_COOLDOWN, setPlan, type Actor, type MindConfig, type MindView, type ReactionDef, type Tuning} from '../src/behavior/index.ts';
import type {Pack, PackSfx} from '../src/pack/index.ts';
import {Sim, type SimEvent} from '../src/main/sim.ts';
import type {DisplayInfo, Point, WinInfo} from '../src/shared/types.ts';
import {DT, FLOOR_Y, SCENE_VARIANT, currentDuoFrame, drive, duoAnchorX, makeDuo, makePack} from './helpers/fake-scene.ts';
import {makeDisplay, makeWindow, mulberry32, rect} from './helpers/fake-desktop.ts';
import {eq} from './helpers/assert.ts';

type PokeEvent = Extract<SimEvent, {type: 'poke'}>;

/** 造一个够用的 MindView（只填 reaction 的 when / weight 会看的字段）。 */
function reactionView(opts: {mood?: number; r18?: boolean; pokes?: number} = {}): MindView {
  return {
    self: {id: 's', state: 'idle', outfit: 'clothed', layer: 'front', support: 'floor', phase: null, stepSec: 0, afterSexSec: Infinity,
      stats: {mood: opts.mood ?? 50}, relations: {}},
    time: {hour: 12, weekday: 0},
    mode: {r18: opts.r18 ?? true},
    env: {hideSpots: 0, covered: 0, coveredSec: 0},
    others: {},
    user: {idleSec: 0, away: false, locked: false, awaySec: 0, pokes: opts.pokes ?? 0},
    playMinutes: 0,
  };
}

/** 一个没配 behaviors 的脑子，只放 reactions（reaction 测试不选行为） */
function reactionBrain(reactions: MindConfig['reactions'], id = 'reaction'): Brain {
  return new Brain(id, {schema: 1, stats: {}, reactions, behaviors: []});
}

const IDLE_STEPS = [{do: 'play' as const, action: 'idle', sec: [10_000, 10_000] as const, state: 'idle' as const}];

// ---------- Brain.reaction ----------

test('reaction：单个值和一个数组；数组按 weight 用给定 rng 挑', () => {
  const single: ReactionDef = {effects: {'stats.mood': 1}};
  const light: ReactionDef = {weight: 1, effects: {'stats.mood': 2}};
  const heavy: ReactionDef = {weight: 3, effects: {'stats.mood': 3}};
  const b = reactionBrain({click: single, stroke: [light, heavy]});
  const view = reactionView();

  const one = b.reaction(['click'], view, 0, () => 0.5, {r18: true});
  eq(one?.key, 'click');
  eq(one?.def, single);

  // 总权重 4：r = 0.9 × 4 = 3.6 → 落在第二个（weight 3）
  const list = b.reaction(['stroke'], view, 10, () => 0.9, {r18: true});
  eq(list?.key, 'stroke');
  eq(list?.def, heavy);

  // 键不存在 / 数组是空的：返回 null
  eq(b.reaction(['touch'], view, 0, () => 0.5, {r18: true}), null);
  eq(b.reaction([], view, 0, () => 0.5, {r18: true}), null);
});

test('reaction：when 选中的那个才进池；都不成立时试下一个键', () => {
  const low: ReactionDef = {when: {'<': [{'var': 'self.stats.mood'}, 60]}, effects: {'stats.mood': 1}};
  const high: ReactionDef = {when: {'>=': [{'var': 'self.stats.mood'}, 60]}, effects: {'stats.mood': 2}};
  const fallback: ReactionDef = {effects: {'stats.mood': 3}};
  const b = reactionBrain({click: [low, high], stroke: fallback});

  // mood 30：只有 low 成立
  eq(b.reaction(['click'], reactionView({mood: 30}), 0, () => 0.5, {r18: true})?.def, low);
  // mood 70：只有 high 成立；冷却已过
  eq(b.reaction(['click'], reactionView({mood: 70}), 10, () => 0.5, {r18: true})?.def, high);
  // mood 60：两个都成立时按权重（都是 1）由 rng 挑；r = 0.9 × 2 = 1.8 → high
  eq(b.reaction(['click'], reactionView({mood: 60}), 20, () => 0.9, {r18: true})?.def, high);
  // click 里一个都不成立 → 落到 stroke
  const none = reactionBrain({click: {when: {'>': [{'var': 'self.stats.mood'}, 1000]}}, stroke: fallback});
  const next = none.reaction(['click', 'stroke'], reactionView({mood: 50}), 0, () => 0.5, {r18: true});
  eq(next?.key, 'stroke');
  eq(next?.def, fallback);
});

test('reaction：weight 用 JSON Logic 求值（mood × 0.01 对 1），0 / 非数不进池', () => {
  const scaled: ReactionDef = {weight: {'*': [{'var': 'self.stats.mood'}, 0.01]}, effects: {'stats.mood': 1}};
  const fixed: ReactionDef = {weight: 1, effects: {'stats.mood': 2}};
  const b = reactionBrain({click: [scaled, fixed]});
  let next = 0.1;
  const rng = () => next;

  // mood 50：scaled 权重 0.5，fixed 1；r = 0.1 × 1.5 = 0.15 → scaled
  eq(b.reaction(['click'], reactionView({mood: 50}), 0, rng, {r18: true})?.def, scaled);
  // 冷却过了，r = 0.5 × 1.5 = 0.75 → 先减掉 scaled 的 0.5，再落到 fixed
  next = 0.5;
  eq(b.reaction(['click'], reactionView({mood: 50}), 10, rng, {r18: true})?.def, fixed);
  // 权重 0 的反应不进池：只剩 fixed
  const zero = reactionBrain({click: [{weight: 0, effects: {'stats.mood': 3}}, {weight: 1, effects: {'stats.mood': 4}}]});
  eq(zero.reaction(['click'], reactionView({mood: 50}), 0, () => 0, {r18: true})?.def?.effects?.['stats.mood'], 4);
});

test('reaction：全年龄模式下跳过 r18 的反应，落到下一个键', () => {
  const r18Def: ReactionDef = {r18: true, effects: {'stats.mood': 10}};
  const generic: ReactionDef = {effects: {'stats.mood': 1}};
  const b = reactionBrain({'click:head': r18Def, click: generic});
  const keys = ['click:head', 'click'];

  // 全年龄：click:head 没有能选的反应 → click
  const sfw = b.reaction(keys, reactionView({r18: false}), 0, () => 0.5, {r18: false});
  eq(sfw?.key, 'click');
  eq(sfw?.def, generic);
  // R18 模式：用部位键
  const adult = b.reaction(keys, reactionView({r18: true}), 10, () => 0.5, {r18: true});
  eq(adult?.key, 'click:head');
  eq(adult?.def, r18Def);
});

test('reaction：冷却期间返回 def: null，不落到下一个键；默认冷却 2 秒', () => {
  const head: ReactionDef = {effects: {'stats.mood': 1}};
  const generic: ReactionDef = {effects: {'stats.mood': 2}};
  const b = reactionBrain({'click:head': head, click: generic});
  const keys = ['click:head', 'click'];

  eq(b.reaction(keys, reactionView(), 10, () => 0.5, {r18: true})?.def, head);
  const cooling = b.reaction(keys, reactionView(), 10 + REACTION_COOLDOWN - 0.01, () => 0.5, {r18: true});
  eq(cooling?.key, 'click:head', '冷却时还是报这个键');
  eq(cooling?.def, null, '冷却时不该落到 click');
  // 到 2 秒整就能再反应
  eq(b.reaction(keys, reactionView(), 10 + REACTION_COOLDOWN, () => 0.5, {r18: true})?.def, head);
});

test('reaction：自定义 cooldown 覆盖默认的 2 秒', () => {
  const chest: ReactionDef = {cooldown: 5, effects: {'stats.mood': 1}};
  const b = reactionBrain({'stroke:chest': chest});
  eq(b.reaction(['stroke:chest'], reactionView(), 0, () => 0.5, {r18: true})?.def, chest);
  eq(b.reaction(['stroke:chest'], reactionView(), 4.99, () => 0.5, {r18: true})?.def, null);
  eq(b.reaction(['stroke:chest'], reactionView(), 5, () => 0.5, {r18: true})?.def, chest);
});

test('reaction：以 _ 开头的 _comment 字符串键不影响 click / stroke', () => {
  const generic: ReactionDef = {effects: {'stats.mood': 1}};
  // 配置是 JSON，_comment 是字符串（ReactionDef 没有这个键），按运行时数据绕过类型
  const reactions = {_commentPoke: '文字', click: generic} as unknown as NonNullable<MindConfig['reactions']>;
  const b = reactionBrain(reactions);
  const r = b.reaction(['click'], reactionView(), 0, () => 0.5, {r18: true});
  eq(r?.key, 'click');
  eq(r?.def, generic);
});

// ---------- Sim.poke：单人环境 ----------

/** 只站着不动的脑子（idle 一条 10000 秒的计划，测试里当固定靶子） */
function idleMind(reactions?: MindConfig['reactions']): MindConfig {
  return {schema: 1, stats: {mood: {start: 50, min: 0, max: 100}}, ...(reactions ? {reactions} : {}),
    relations: {user: {affection: 50}}, behaviors: [{id: 'idle', weight: 1, steps: IDLE_STEPS}]};
}

/** 反应里换计划用的一步：播 idle、state = react */
function reactSteps(sec = 0.2) {
  return [{do: 'play' as const, action: 'idle', sec: [sec, sec] as const, state: 'react' as const}];
}

interface SoloOptions {
  mind: MindConfig;
  r18?: boolean;
  parts?: readonly string[];
  sfx?: PackSfx | null;
  windows?: WinInfo[];
  outfit?: string;
  at?: Point;
}

interface SoloFixture {
  sim: Sim;
  pack: Pack;
  a: Actor;
  display: DisplayInfo;
}

/** 一个角色（id = s）、1920×1080 显示器、地面上；spawn 之后从 fall 开始，测试自己推进 */
function makeSolo(opts: SoloOptions): SoloFixture {
  const tuning: Tuning = {...DEFAULT_TUNING, idleSec: [0, 0], walkMaxSec: 600};
  const pack = makePack({id: 's', mind: opts.mind, ...(opts.parts ? {parts: opts.parts} : {}), ...(opts.sfx ? {sfx: opts.sfx} : {})});
  const sim = new Sim([pack], tuning, {variant: SCENE_VARIANT, heightLogical: 120, r18: opts.r18 ?? true}, mulberry32(3),
    {unlocked: [], playSeconds: 0, chars: {s: {stats: {}, relations: {}}}}, new Map());
  const display = makeDisplay(1, rect(0, 0, 1920, 1080));
  sim.setDesktop({displays: [display], windows: opts.windows ?? []});
  sim.spawn('s', opts.at ?? {x: 800, y: FLOOR_Y}, opts.outfit);
  const a = sim.charOf('s')!.actor!;
  return {sim, pack, a, display};
}

/** 推进 n 帧（30 Hz，和 main/ 一样） */
function tick(sim: Sim, n = 1): void {
  for (let i = 0; i < n; i++) sim.step(sim.now + DT, DT);
}

/** 推进到条件成立；超时抛错 */
function until(fx: SoloFixture, pred: () => boolean, what: string, maxFrames = 600): void {
  for (let i = 0; i < maxFrames; i++) {
    if (pred()) return;
    tick(fx.sim);
  }
  if (pred()) return;
  throw new Error(`跑了 ${maxFrames} 帧还没到${what}（state ${fx.a.state} / 计划 ${fx.a.plan?.behavior ?? '—'}）`);
}

/** 落地、选到 idle 行为 */
function settleIdle(fx: SoloFixture): void {
  until(fx, () => fx.a.state === 'idle' && fx.a.plan?.behavior === 'idle', 'idle 行为');
}

/** 下一帧的事件（poke 的事件在下一次 step 才出来） */
function nextEvents(fx: SoloFixture): {id: string; e: SimEvent}[] {
  return fx.sim.step(fx.sim.now + DT, DT);
}

/** 这一帧里的 poke 事件；没有就报错 */
function findPoke(evs: {id: string; e: SimEvent}[]): {id: string; e: PokeEvent} {
  const found = evs.find(x => x.e.type === 'poke');
  if (!found) throw new Error('这一帧里没有 poke 事件');
  return found as {id: string; e: PokeEvent};
}

/** 画面上这个角色的 DrawItem */
function drawItem(fx: SoloFixture) {
  const item = fx.sim.draws(new Set()).front.get(fx.display.id)!.find(x => x.id === 's');
  if (!item) throw new Error('画面上没有角色 s');
  return item;
}

test('poke：空着时点中头 → 换成 reaction:click:head 计划、state 是 react，播完回到行为系统', () => {
  const fx = makeSolo({mind: idleMind({'click:head': {steps: reactSteps(), effects: {'stats.mood': 3}}}), parts: ['head', 'chest']});
  settleIdle(fx);
  const mood0 = fx.sim.charOf('s')!.brain.stats.mood;

  const out = fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(out?.who, 's');
  eq(out?.part, 'head');
  eq(out?.reaction, 'click:head');
  eq(out?.overlay, false);
  eq(out?.cooling, false);
  eq(fx.a.state, 'react');
  eq(fx.a.plan?.behavior, 'reaction:click:head');
  eq(fx.sim.charOf('s')!.brain.stats.mood, mood0 + 3);

  const evs = nextEvents(fx);
  const p = findPoke(evs);
  eq(p.id, 's');
  eq(p.e.kind, 'click');
  eq(p.e.part, 'head');
  eq(p.e.reaction, 'click:head');
  eq(p.e.overlay, false);
  eq(p.e.cooling, false);

  // 反应计划 0.2 秒，播完以后空下来、行为系统给下一个 idle
  until(fx, () => fx.a.plan?.behavior === 'idle', '反应播完回到行为系统', 60);
  eq(fx.a.state, 'idle');
});

test('poke：部位序号换成 parts 里的名字；null / 越界落到 click 通用反应', () => {
  const fx = makeSolo({mind: idleMind({
    'click:chest': {cooldown: 0, effects: {'stats.mood': 2}},
    'stroke:chest': {cooldown: 0, effects: {'stats.mood': 4}},
    click: {cooldown: 0, effects: {'stats.mood': 1}},
  }), parts: ['head', 'chest']});
  settleIdle(fx);
  const brain = fx.sim.charOf('s')!.brain;
  const mood0 = brain.stats.mood;

  const chest = fx.sim.poke('s', 2, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(chest?.part, 'chest');
  eq(chest?.reaction, 'click:chest');
  eq(brain.stats.mood, mood0 + 2);

  const none = fx.sim.poke('s', null, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(none?.part, null);
  eq(none?.reaction, 'click');
  eq(brain.stats.mood, mood0 + 3);

  const stroke = fx.sim.poke('s', 2, 'stroke', {x: fx.a.x, y: fx.a.y - 60});
  eq(stroke?.part, 'chest');
  eq(stroke?.reaction, 'stroke:chest');
  eq(brain.stats.mood, mood0 + 7);

  const outOfRange = fx.sim.poke('s', 99, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(outOfRange?.part, null);
  eq(outOfRange?.reaction, 'click');
  eq(brain.stats.mood, mood0 + 8);
});

test('poke：没配反应 → reaction null、计划 / 状态 / 状态值都不变', () => {
  const fx = makeSolo({mind: idleMind(), parts: ['head']});
  settleIdle(fx);
  const c = fx.sim.charOf('s')!;
  const plan = fx.a.plan, epoch = fx.a.epoch, mood0 = c.brain.stats.mood;

  const out = fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(out?.who, 's');
  eq(out?.part, 'head');
  eq(out?.reaction, null);
  eq(out?.overlay, true);
  eq(out?.cooling, false);
  eq(fx.a.plan, plan, '没有反应时计划对象不该换');
  eq(fx.a.epoch, epoch);
  eq(fx.a.state, 'idle');
  eq(fx.a.outfit, 'clothed');
  eq(c.brain.stats.mood, mood0);
  eq(fx.sim.takeCues().length, 0);
  eq(drawItem(fx).fx, undefined);

  const p = findPoke(nextEvents(fx));
  eq(p.e.reaction, null);
  eq(p.e.overlay, true);
});

test('poke：反应的 effects 生效（stats 和 relations）', () => {
  const fx = makeSolo({mind: idleMind({'click:head': {effects: {'stats.mood': 3, 'relations.user.affection': 2}}}), parts: ['head']});
  settleIdle(fx);
  const c = fx.sim.charOf('s')!;
  const mood0 = c.brain.stats.mood, affection0 = c.brain.relations.user.affection;

  const out = fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(out?.reaction, 'click:head');
  eq(out?.overlay, true, '反应没写 steps，只叠加');
  eq(c.brain.stats.mood, mood0 + 3);
  eq(c.brain.relations.user.affection, affection0 + 2);
});

test('poke：fx 出现在 draws() 的 DrawItem.fx 里，播完消失', () => {
  const fx = makeSolo({mind: idleMind({'click:head': {fx: 'heart'}}), parts: ['head']});
  settleIdle(fx);
  const out = fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(out?.reaction, 'click:head');

  const item = drawItem(fx);
  assert.ok(item.fx?.some(f => f.fx === 'heart'), `DrawItem.fx 里没有 heart：${JSON.stringify(item.fx)}`);
  const heart = item.fx!.find(f => f.fx === 'heart')!;
  eq(heart.t, 0);
  assert.ok(heart.h > 0, `特效高度 ${heart.h}`);

  // 1.2 秒以后删掉
  tick(fx.sim, 40);
  eq(drawItem(fx).fx, undefined, '特效播完还在画');
});

test('poke：sound → takeCues() 多一条（effect / voice / 脚底点 / behind = false）', () => {
  const fx = makeSolo({mind: idleMind({'click:head': {sound: 'moan'}}), parts: ['head'], sfx: {voice: 'v', actions: {}}});
  settleIdle(fx);
  eq(fx.sim.takeCues().length, 0, '落地时没有 cue');

  const out = fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(out?.reaction, 'click:head');
  const cues = fx.sim.takeCues();
  eq(cues.length, 1);
  eq(cues[0].id, 's');
  eq(cues[0].voice, 'v');
  eq(cues[0].effect, 'moan');
  eq(cues[0].behind, false);
  eq(cues[0].x, fx.a.x);
  eq(cues[0].y, fx.a.y);
});

test('poke：同一个键冷却期间再来 → cooling true、不加状态值、计划不换', () => {
  const fx = makeSolo({mind: idleMind({'click:head': {effects: {'stats.mood': 5}, steps: reactSteps()}}), parts: ['head']});
  settleIdle(fx);
  const c = fx.sim.charOf('s')!;
  const mood0 = c.brain.stats.mood;

  eq(fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60})?.cooling, false);
  const plan = fx.a.plan;
  tick(fx.sim, 1);
  const second = fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(second?.reaction, 'click:head');
  eq(second?.cooling, true);
  eq(second?.overlay, true);
  eq(fx.a.plan, plan, '冷却时不该换计划');
  eq(c.brain.stats.mood, mood0 + 5, '冷却时不该再加效果');

  const p = findPoke(nextEvents(fx));
  eq(p.e.reaction, 'click:head');
  eq(p.e.cooling, true);
  eq(p.e.overlay, true);
});

test('poke：躲在窗口后面（layer behind）被点到算被发现（2026-10-21 用户定）：换成 discovered 反应、回到 front，不挑点的反应', () => {
  const W = makeWindow(10, rect(0, 0, 1920, 1080));
  const fx = makeSolo({mind: idleMind({'click:head': {effects: {'stats.mood': 2}, fx: 'alert', steps: reactSteps()},
    discovered: {effects: {'stats.mood': -5}, steps: [{do: 'play', action: 'idle', sec: 1, state: 'discovered', fx: 'alert'}]}}), parts: ['head'], windows: [W]});
  settleIdle(fx);
  setPlan(fx.a, fx.pack.actorSpec(fx.sim.tuning),
    {behavior: 'hide-test', steps: [{state: 'idle', action: 'idle', sec: 10_000, layer: {kind: 'behind', hwnd: 10}}]}, fx.sim.ctx(), 'test');
  eq(fx.a.layer.kind, 'behind');
  const mood0 = fx.sim.charOf('s')!.brain.stats.mood;

  const out = fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(out?.reaction, 'discovered');
  eq(out?.overlay, false);
  eq(fx.a.plan?.behavior, 'reaction:discovered');
  eq(fx.a.state, 'discovered');
  eq(fx.a.layer.kind, 'front', '被发现以后回到前面');
  eq(fx.sim.charOf('s')!.brain.stats.mood, mood0 - 5, '算 discovered 的效果，不算 click:head 的');
  const evs = nextEvents(fx);
  eq(findPoke(evs).e.reaction, 'discovered');
  const disc = evs.find(x => x.e.type === 'discovered')?.e as Extract<SimEvent, {type: 'discovered'}> | undefined;
  eq(disc?.by, 'click');
  eq(disc?.hwnd, 10);
});

test('poke：摸（stroke）躲着的她也算被发现', () => {
  const W = makeWindow(10, rect(0, 0, 1920, 1080));
  const fx = makeSolo({mind: idleMind({stroke: {effects: {'stats.mood': 2}}}), windows: [W]});
  settleIdle(fx);
  setPlan(fx.a, fx.pack.actorSpec(fx.sim.tuning),
    {behavior: 'hide-test', steps: [{state: 'idle', action: 'idle', sec: 10_000, layer: {kind: 'behind', hwnd: 10}}]}, fx.sim.ctx(), 'test');
  eq(fx.sim.poke('s', null, 'stroke', {x: fx.a.x, y: fx.a.y - 60})?.reaction, 'discovered');
  eq(fx.a.state, 'discovered', '没写 reactions.discovered 时用默认的（站着冒感叹号）');
  eq(fx.a.layer.kind, 'front');
});

test('poke：自己在做 R18（状态 masturbate）时找 sex: 前缀的键（sex:click:<部位> → sex:click），不落回平时的反应', () => {
  const base = idleMind({'click:head': {effects: {'stats.mood': 2}, steps: reactSteps()}, click: {effects: {'stats.mood': 3}},
    'sex:click': {effects: {'stats.mood': 7}, fx: 'heart'}});
  const mind: MindConfig = {...base, behaviors: [...base.behaviors, {id: 'solo', weight: 0, r18: true, steps: []}]};
  const fx = makeSolo({mind, parts: ['head']});
  settleIdle(fx);
  setPlan(fx.a, fx.pack.actorSpec(fx.sim.tuning),
    {behavior: 'solo', steps: [{state: 'masturbate', action: 'idle', sec: 10_000}]}, fx.sim.ctx(), 'test');
  const plan = fx.a.plan, mood0 = fx.sim.charOf('s')!.brain.stats.mood;
  const out = fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(out?.part, 'head');
  eq(out?.reaction, 'sex:click', '没写 sex:click:head，落到 sex:click');
  eq(out?.overlay, true);
  eq(fx.a.plan, plan);
  eq(fx.sim.charOf('s')!.brain.stats.mood, mood0 + 7);
  // 没写 sex:stroke：什么都不做（不落回平时的 stroke / click）
  const none = fx.sim.poke('s', 1, 'stroke', {x: fx.a.x, y: fx.a.y - 60});
  eq(none?.reaction, null);
  eq(fx.sim.charOf('s')!.brain.stats.mood, mood0 + 7);
});

test('poke：正在做 r18 行为（计划 r18）只叠加，不换计划', () => {
  const base = idleMind({'click:head': {effects: {'stats.mood': 2}, steps: reactSteps()}});
  const mind: MindConfig = {...base, behaviors: [...base.behaviors, {id: 'r18', weight: 0, r18: true, steps: []}]};
  const fx = makeSolo({mind, parts: ['head']});
  settleIdle(fx);
  // act 本来可以被点断，但计划是 r18 → 只叠加
  setPlan(fx.a, fx.pack.actorSpec(fx.sim.tuning),
    {behavior: 'r18', steps: [{state: 'act', action: 'idle', sec: 10_000}]}, fx.sim.ctx(), 'test');
  eq(fx.a.state, 'act');
  const plan = fx.a.plan, mood0 = fx.sim.charOf('s')!.brain.stats.mood;

  const out = fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(out?.reaction, 'click:head');
  eq(out?.overlay, true);
  eq(fx.a.plan, plan, '做 r18 时不该换计划');
  eq(fx.a.state, 'act');
  eq(fx.sim.charOf('s')!.brain.stats.mood, mood0 + 2);
});

test('poke：被拎着（dragged）、下落（fall）、不在场都返回 null', () => {
  const fx = makeSolo({mind: idleMind({'click:head': {effects: {'stats.mood': 2}, steps: reactSteps()}}), parts: ['head']});
  settleIdle(fx);
  const mood0 = fx.sim.charOf('s')!.brain.stats.mood;

  fx.sim.grab('s', {x: fx.a.x, y: fx.a.y - 60});
  eq(fx.a.state, 'dragged');
  eq(fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60}), null);
  eq(fx.sim.charOf('s')!.brain.stats.mood, mood0, '被拎着时不理');

  fx.sim.release();
  eq(fx.a.state, 'fall');
  eq(fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60}), null);

  // 角色包在、但还没出场
  const ghostPack = makePack({id: 'ghost', mind: idleMind({'click:head': {effects: {'stats.mood': 2}}}), parts: ['head']});
  const ghostSim = new Sim([ghostPack], fx.sim.tuning, {variant: SCENE_VARIANT, heightLogical: 120, r18: true}, mulberry32(4),
    {unlocked: [], playSeconds: 0, chars: {}}, new Map());
  ghostSim.setDesktop({displays: [fx.display], windows: []});
  eq(ghostSim.poke('ghost', 1, 'click', {x: 0, y: 0}), null);
});

test('poke：全年龄模式下 r18 反应不选，落到通用 click', () => {
  const fx = makeSolo({mind: idleMind({
    'click:head': {r18: true, effects: {'stats.mood': 10}, steps: reactSteps()},
    click: {cooldown: 0, effects: {'stats.mood': 1}},
  }), parts: ['head'], r18: false});
  settleIdle(fx);
  const mood0 = fx.sim.charOf('s')!.brain.stats.mood;

  const out = fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60});
  eq(out?.part, 'head');
  eq(out?.reaction, 'click', '全年龄下不能用 click:head 的 r18 反应');
  eq(fx.sim.charOf('s')!.brain.stats.mood, mood0 + 1);
});

test('poke：user.pokes 数最近 60 秒（含这一次），60 秒前的点不算', () => {
  const fx = makeSolo({mind: idleMind({
    click: {when: {'>=': [{'var': 'user.pokes'}, 3]}, effects: {'stats.mood': 5}, steps: reactSteps(0.1)},
  }), parts: ['head']});
  settleIdle(fx);
  const c = fx.sim.charOf('s')!;
  const mood0 = c.brain.stats.mood, t0 = fx.sim.now;

  // 前两次 user.pokes = 1 / 2，when 不成立；第三次 = 3，反应成立
  eq(fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60})?.reaction, null);
  eq(fx.sim.view(c).user.pokes, 1);
  eq(fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60})?.reaction, null);
  eq(fx.sim.view(c).user.pokes, 2);
  eq(fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60})?.reaction, 'click');
  eq(fx.sim.view(c).user.pokes, 3);
  eq(c.brain.stats.mood, mood0 + 5);

  // 60 秒以后旧的都不算了，这一次是窗口里的第 1 次
  for (let i = 0; i < Math.ceil(60.2 / DT); i++) tick(fx.sim);
  assert.ok(fx.sim.now - t0 > 60, `只推进了 ${(fx.sim.now - t0).toFixed(2)} 秒`);
  eq(fx.sim.poke('s', 1, 'click', {x: fx.a.x, y: fx.a.y - 60})?.reaction, null);
  eq(fx.sim.view(c).user.pokes, 1);
  eq(c.brain.stats.mood, mood0 + 5, '第四次 when 仍不成立，不该再加');
});

// ---------- Sim.poke：双人播放中 ----------

/** （开源版省略） */
function duoMindA(): MindConfig {
  return {
    schema: 1,
    stats: {desire: {start: 90, min: 0, max: 100}, mood: {start: 50, min: 0, max: 100}, stamina: {start: 80, min: 0, max: 100}},
    relations: {b: {affection: 50}, user: {affection: 50}},
    reactions: {click: {effects: {'stats.mood': 20}, steps: reactSteps(0.1)}, 'sex:click': {effects: {'stats.mood': 2}}},
    behaviors: [
      {id: 'sex', weight: 1_000_000, when: {'>=': [{'var': 'self.stats.desire'}, 60]}, cooldown: 120, r18: true,
        duo: {kind: 'sex', with: ['b'], scenes: ['s1'], loops: [0, 0]}},
      {id: 'idle', weight: 1, steps: IDLE_STEPS},
    ],
  };
}

/** （开源版省略） */
function duoMindB(): MindConfig {
  return {
    schema: 1,
    stats: {desire: {start: 50, min: 0, max: 100}, mood: {start: 50, min: 0, max: 100}, stamina: {start: 80, min: 0, max: 100}},
    relations: {a: {affection: 50}},
    accept: {sex: {'>=': [{'var': 'self.stats.desire'}, 40]}},
    reactions: {click: {effects: {'stats.mood': 10}, steps: reactSteps(0.1)}, 'sex:click': {effects: {'stats.mood': 1}}},
    behaviors: [{id: 'idle', weight: 1, steps: IDLE_STEPS}],
  };
}

test('poke：在窗口后面做的双人被点到：两个人都被发现，场景散了', () => {
  const fx = makeDuo({aMind: duoMindA(), bMind: duoMindB(), parts: ['head', 'chest']});
  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'play', 'play', 60);
  const d = fx.sim.duos[0];
  d.layer = {kind: 'behind', hwnd: 77};   // 假装两人在窗口 77 后面做（这一帧没 step，checkHidden 还没跑）
  const out = fx.sim.poke('a', null, 'click', {x: duoAnchorX(fx.sim), y: FLOOR_Y});
  eq(out?.reaction, 'discovered');
  eq(fx.sim.duos.length, 0, '场景散了');
  for (const id of ['a', 'b']) {
    const a = fx.sim.charOf(id)!.actor!;
    eq(a.plan?.behavior, 'reaction:discovered', id);
    eq(a.layer.kind, 'front', id);
  }
  const evs = drv.frame().filter(x => x.e.type === 'discovered');
  eq(evs.length, 2);
  assert.ok(evs.every(x => (x.e as Extract<SimEvent, {type: 'discovered'}>).by === 'click'));
});

test('poke：双人播放中按光标离谁近算谁、part 为 null、用 sex:click，只叠加（计划不变）', () => {
  const fx = makeDuo({aMind: duoMindA(), bMind: duoMindB(), parts: ['head', 'chest']});
  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'play', 'play', 60);

  const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
  const aBrain = fx.sim.charOf('a')!.brain, bBrain = fx.sim.charOf('b')!.brain;
  const d = fx.sim.duos[0];
  const tag = d.tag;
  const aPlan = a.plan, bPlan = b.plan;
  const moodA = aBrain.stats.mood, moodB = bBrain.stats.mood;
  eq(a.outfit, 'nude');
  eq(b.outfit, 'nude');

  const posOf = (role: 'receiver' | 'giver') => {
    const f = currentDuoFrame(fx.sim), sh = d.scene.sheet(d.variant, d.facing);
    return duoAnchorX(fx.sim) + sh.cast[role].dx[f] * d.k;
  };

  // 光标在给予方（b）那边：虽然舞台报的是接受方 a 的 id，也算 b
  const outB = fx.sim.poke('a', 1, 'click', {x: posOf('giver'), y: FLOOR_Y});
  eq(outB?.who, 'b');
  eq(outB?.part, null, '双人场景没有部位图，part 当 null');
  eq(outB?.reaction, 'sex:click', '双人时用 sex: 前缀的键');
  eq(outB?.overlay, true);
  eq(bBrain.stats.mood, moodB + 1, 'b 的反应效果');
  eq(aBrain.stats.mood, moodA, 'a 没被点到');
  eq(fx.sim.duos.length, 1);
  eq(a.plan, aPlan, 'a 的计划不该换');
  eq(b.plan, bPlan, 'b 的计划不该换');
  const pB = findPoke(drv.frame());
  eq(pB.id, 'b');
  eq(pB.e.part, null);
  eq(pB.e.overlay, true);

  // 光标在接受方（a）那边：算 a
  const outA = fx.sim.poke('a', 1, 'click', {x: posOf('receiver'), y: FLOOR_Y});
  eq(outA?.who, 'a');
  eq(outA?.part, null);
  eq(outA?.reaction, 'sex:click', '部位键在双人里用不上，用 sex:click');
  eq(outA?.overlay, true);
  eq(aBrain.stats.mood, moodA + 2, 'a 的反应效果');
  eq(bBrain.stats.mood, moodB + 1, 'b 不再变');
  eq(a.plan, aPlan);
  eq(b.plan, bPlan);
  eq(a.plan?.behavior, tag);
  eq(b.plan?.behavior, tag);
  const pA = findPoke(drv.frame());
  eq(pA.id, 'a');
  eq(pA.e.kind, 'click');
  eq(pA.e.part, null);
});
