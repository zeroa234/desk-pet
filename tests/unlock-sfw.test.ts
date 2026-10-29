// 解锁（R3.3）和全年龄模式（R9.2）在 Sim 层的单测：解锁条件满足后 5 秒内检查到、从第一个显示器顶上掉下来；
// （开源版省略）
// 规则见 src/main/sim.ts 的 checkUnlocks / unlockAll / setR18 / choose，src/behavior/brain.ts 的 isUnlocked，
// docs/requirements.md R3.3 / R9.2。用假角色包 / 假场景，不读 packs/ 下的导出生成物；时间按 1/30 秒推进，rng 固定种子。
import test from 'node:test';
import assert from 'node:assert/strict';

import {DEFAULT_TUNING, type Logic, type MindConfig, type Tuning} from '../src/behavior/index.ts';
import {Sim, type SimEvent} from '../src/main/sim.ts';
import type {Pack} from '../src/pack/index.ts';
import type {DisplayInfo} from '../src/shared/types.ts';
import {DT, FLOOR_Y, SCENE_VARIANT, drive, makeDuo, makePack} from './helpers/fake-scene.ts';
import {makeDisplay, mulberry32, rect} from './helpers/fake-desktop.ts';
import {eq} from './helpers/assert.ts';

const IDLE_STEPS = [{do: 'idle' as const, sec: [10_000, 10_000] as const}];

/** 一个只会站着的脑子；unlock 不写 = 一开始就解锁（R3.3） */
function idleMind(unlock?: Logic | null): MindConfig {
  return {schema: 1, stats: {desire: {start: 20, min: 0, max: 100}}, ...(unlock === undefined ? {} : {unlock}),
    behaviors: [{id: 'idle', weight: 1, steps: IDLE_STEPS}]};
}

interface WorldOptions {
  r18?: boolean;
  unlocked?: string[];
  playSeconds?: number;
  chars?: Record<string, {stats: Record<string, number>; relations: Record<string, {affection: number}>; outfit?: string}>;
  seed?: number;
}

interface WorldFixture {
  sim: Sim;
  display: DisplayInfo;
  tuning: Tuning;
}

/** 一个 1920×1080 显示器、没有窗口的假世界 */
function makeWorld(packs: readonly Pack[], opts: WorldOptions = {}): WorldFixture {
  const tuning: Tuning = {...DEFAULT_TUNING, idleSec: [0, 0], walkMaxSec: 600};
  const sim = new Sim(packs, tuning, {variant: SCENE_VARIANT, heightLogical: 120, r18: opts.r18 ?? true}, mulberry32(opts.seed ?? 3),
    {unlocked: opts.unlocked ?? [], playSeconds: opts.playSeconds ?? 0, chars: opts.chars ?? {}}, new Map());
  const display = makeDisplay(1, rect(0, 0, 1920, 1080));
  sim.setDesktop({displays: [display], windows: []});
  return {sim, display, tuning};
}

/** 推进 n 帧（30 Hz，和 main/ 一样） */
function tick(sim: Sim, n = 1): void {
  for (let i = 0; i < n; i++) sim.step(sim.now + DT, DT);
}

/** 推进到条件成立；超时抛错（条件每帧之后查一次） */
function until(sim: Sim, pred: () => boolean, what: string, maxFrames = 600): void {
  for (let i = 0; i < maxFrames; i++) {
    if (pred()) return;
    tick(sim);
  }
  if (pred()) return;
  throw new Error(`跑了 ${maxFrames} 帧还没到${what}`);
}

// ---------- 解锁 ----------

test('解锁：playMinutes + 已解锁角色的 stats 满足后，5 秒内的检查解锁，从第一个显示器顶上掉下来', () => {
  const a = makePack({id: 'a', mind: idleMind()});
  const b = makePack({id: 'b', mind: idleMind({'and': [
    {'>=': [{'var': 'playMinutes'}, 1]},
    {'>=': [{'var': 'chars.a.stats.desire'}, 50]},
  ]})});
  // 已经玩了 59.5 秒：playMinutes 约 0.99，差半秒到 1 分钟；a 的欲望 60（从存档覆盖）满足 chars 那条
  const fx = makeWorld([a, b], {playSeconds: 59.5, chars: {a: {stats: {desire: 60}, relations: {}}}});
  eq(fx.sim.unlocked.includes('a'), true, 'a 没写 unlock，应该一开始就有');
  eq(fx.sim.unlocked.includes('b'), false, 'b 的条件还没满足');
  eq(fx.sim.charOf('b')!.actor, null, '没解锁的角色不在场');

  const drv = drive(fx.sim);
  const frame = drv.until(e => e.type === 'unlocked', 'unlocked', 7);
  const found = frame.find(x => x.e.type === 'unlocked');
  assert.ok(found, '这一帧里没有 unlocked');
  eq(found.id, 'b');
  eq(found.e.type, 'unlocked');
  eq(found.e.type === 'unlocked' && found.e.forced, false);
  // 第一次检查在第一帧，之后每 5 秒一次：约 5.03 秒时解锁
  assert.ok(found.t > 4.9 && found.t <= 5.2, `解锁事件在 ${found.t.toFixed(3)} 秒，应该约 5 秒`);

  eq(fx.sim.unlocked.includes('b'), true);
  const actor = fx.sim.charOf('b')!.actor;
  assert.ok(actor, '解锁以后应该出场');
  eq(actor.state, 'fall', '从屏幕上方掉下来');
  eq(actor.support, null);
  eq(actor.y, 0, '第一个显示器 bounds.top');
  // spawn 在第一个显示器工作区横向 20%–80% 的地方
  assert.ok(actor.x >= 1920 * 0.2 && actor.x <= 1920 * 0.8, `x = ${actor.x} 不在工作区里`);
});

test('unlockAll：不管解锁条件，立刻解锁、出场（事件 forced = true）', () => {
  const b = makePack({id: 'b', mind: idleMind({'==': [1, 0]})});   // 永远不成立
  const fx = makeWorld([b]);
  eq(fx.sim.unlocked.includes('b'), false);
  eq(fx.sim.charOf('b')!.actor, null);

  fx.sim.unlockAll();
  eq(fx.sim.unlocked.includes('b'), true, 'unlockAll 应该立刻写进 unlocked');
  const actor = fx.sim.charOf('b')!.actor;
  assert.ok(actor, 'unlockAll 应该立刻让角色出场');
  eq(actor.state, 'fall');
  eq(actor.y, 0);
  eq(actor.support, null);

  // 事件在下一次 step 才交出去
  const evs = fx.sim.step(fx.sim.now + DT, DT);
  const unlocked = evs.find(x => x.e.type === 'unlocked');
  assert.ok(unlocked, '没有 unlocked 事件');
  eq(unlocked.id, 'b');
  eq(unlocked.e.type === 'unlocked' && unlocked.e.forced, true);
  // 再调一次不会重复解锁 / 重复出场
  fx.sim.unlockAll();
  const again = fx.sim.step(fx.sim.now + DT, DT);
  eq(again.filter(x => x.e.type === 'unlocked').length, 0, '已经解锁的角色不该再发 unlocked');
  eq(fx.sim.charOf('b')!.actor, actor, '不该重新 spawn');
});

// ---------- 全年龄：正在播的双人 ----------

test('setR18(false)：正在播的双人拆掉（duo dissolved sfw），两人换成穿衣计划、outfit 变回 clothed', () => {
  const fx = makeDuo();
  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'invite', 'invite');
  drv.until(e => e.type === 'duo' && e.what === 'play', 'play');
  drv.frames(5);
  const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
  eq(a.outfit, 'nude');
  eq(b.outfit, 'nude');
  eq(fx.sim.duos.length, 1);

  fx.sim.setR18(false);
  eq(fx.sim.opts.r18, false);
  eq(fx.sim.duos.length, 0, '正在播的双人应该拆掉');
  // 两人立刻拿到穿衣计划：衣着当场切回 clothed，dress 片段用来放烟
  eq(a.plan?.behavior, 'system:sfw');
  eq(b.plan?.behavior, 'system:sfw');
  eq(a.state, 'dress');
  eq(b.state, 'dress');
  eq(a.outfit, 'clothed');
  eq(b.outfit, 'clothed');

  const frame = drv.frame();
  const dissolved = frame.find(x => x.e.type === 'duo' && x.e.what === 'dissolved');
  assert.ok(dissolved, '这一帧里没有 duo dissolved');
  eq(dissolved.id, 'a');
  eq(dissolved.e.type === 'duo' && dissolved.e.reason, 'sfw');
  eq(dissolved.e.type === 'duo' && dissolved.e.stage, 'play');

  // 穿衣计划播完以后空下来，按全年龄模式继续选普通行为
  drv.frames(35);
  eq(a.outfit, 'clothed');
  eq(b.outfit, 'clothed');
  eq(a.plan?.behavior, 'idle');
  eq(b.plan?.behavior, 'idle');
});

test('setR18(false)：光着站着的换成穿衣计划，之后 outfit 变 clothed', () => {
  const fx = makeWorld([makePack({id: 's', mind: idleMind()})]);
  fx.sim.spawn('s', {x: 800, y: FLOOR_Y}, 'nude');
  const a = fx.sim.charOf('s')!.actor!;
  until(fx.sim, () => a.state === 'idle' && a.plan?.behavior === 'idle', '光着站着');
  eq(a.outfit, 'nude');

  fx.sim.setR18(false);
  eq(fx.sim.opts.r18, false);
  eq(a.plan?.behavior, 'system:sfw');
  eq(a.state, 'dress');
  eq(a.outfit, 'clothed', '穿衣步骤开始时就换衣着');

  tick(fx.sim, 40);
  eq(a.outfit, 'clothed');
  eq(a.state, 'idle');
  eq(a.plan?.behavior, 'idle');
});

test('setR18(false)：r18 行为不再被选，下一次 choose 选普通行为', () => {
  const mind: MindConfig = {
    schema: 1,
    stats: {desire: {start: 90, min: 0, max: 100}},
    behaviors: [
      {id: 'r18-act', weight: 1_000_000, r18: true, steps: [{do: 'play', action: 'idle', state: 'act', sec: [0.2, 0.2]}]},
      {id: 'idle', weight: 1, steps: [{do: 'idle', sec: [0.2, 0.2]}]},
    ],
  };
  const fx = makeWorld([makePack({id: 's', mind})]);
  fx.sim.spawn('s', {x: 800, y: FLOOR_Y});
  const a = fx.sim.charOf('s')!.actor!, c = fx.sim.charOf('s')!;
  until(fx.sim, () => a.plan?.behavior === 'r18-act', '先选中 r18 行为');
  eq(a.state, 'act');

  fx.sim.setR18(false);
  // 当前计划是 r18：换成 sfw 计划（衣着已经是 clothed，只中止、站着）；候选里不再有 r18 行为
  assert.ok(c.brain.candidates(fx.sim.view(c), fx.sim.now, {r18: false}).every(x => x.def.id !== 'r18-act'),
    '全年龄模式下还能选 r18-act');
  assert.ok(c.brain.candidates(fx.sim.view(c), fx.sim.now, {r18: true}).some(x => x.def.id === 'r18-act'),
    'R18 模式下应该还能选 r18-act');

  tick(fx.sim, 1);
  eq(a.plan?.behavior, 'idle', `下一次 choose 选了 ${a.plan?.behavior}`);
  // 多跑几秒也不会再选回 r18
  for (let i = 0; i < 120; i++) {
    tick(fx.sim);
    assert.notEqual(a.plan?.behavior, 'r18-act', `第 ${i} 帧又选中了 r18-act`);
  }
});

test('全年龄模式下 choose：光着的角色空下来时先选 system:dress 穿上，再选普通行为', () => {
  const fx = makeWorld([makePack({id: 's', mind: idleMind()})], {r18: false});
  fx.sim.spawn('s', {x: 800, y: FLOOR_Y}, 'nude');
  const a = fx.sim.charOf('s')!.actor!;
  until(fx.sim, () => a.plan?.behavior === 'system:dress', 'system:dress 计划', 300);
  eq(a.state, 'dress');
  eq(a.outfit, 'clothed');

  tick(fx.sim, 40);
  eq(a.outfit, 'clothed');
  eq(a.state, 'idle');
  eq(a.plan?.behavior, 'idle');
});
