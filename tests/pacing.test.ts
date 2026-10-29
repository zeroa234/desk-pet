// 阶段 2 的节奏机制单测：StatDef.rates（observe / tick）、Sim.view 的 others.dist、approach 步骤模板、
// 双人邀请被拒时的 declineCooldown。规则见 src/behavior/mind.ts、src/behavior/brain.ts、src/main/sim.ts 的注释，
// docs/requirements.md R3.1–R3.5、docs/state-rules.md §2.2 / §2.4。
// 假角色包 / 假桌面用 tests/helpers/ 里的；时间按 1/30 秒推进，rng 固定种子。
import test from 'node:test';
import assert from 'node:assert/strict';

import {Brain, DEFAULT_TUNING, heightPxOf, type Tuning} from '../src/behavior/index.ts';
import type {MindConfig, MindView, Range, StepTemplate} from '../src/behavior/mind.ts';
import {Sim} from '../src/main/sim.ts';
import type {DisplayInfo, Point, WinInfo} from '../src/shared/types.ts';
import {DT, FLOOR_Y, SCENE_VARIANT, drive, makeDuo, makePack, type DuoDriver} from './helpers/fake-scene.ts';
import {makeDisplay, makeWindow, mulberry32, rect} from './helpers/fake-desktop.ts';
import {approx as approxAny, eq} from './helpers/assert.ts';

// ---------- 小工具 ----------

/**
 * 这个文件的近似容差比别处紧：这里原来的默认 eps 是 1e-9（别的文件 1e-6）。统计值是逐帧累加的，
 * 容差放宽到 1e-6 会盖住累加误差，所以参数照原来的传。
 */
const approx = (actual: number, expected: number, message?: string): void => approxAny(actual, expected, message, 1e-9);

/** 造一个够用的 MindView（只填测试要用的字段；view 的 stats 可以和 Brain 自己的 stats 不同）。 */
function mindView(stats: Record<string, number> = {}, others: MindView['others'] = {}): MindView {
  return {
    self: {id: 'self', state: 'idle', outfit: 'clothed', layer: 'front', support: 'floor', phase: null, stepSec: 0, afterSexSec: Infinity, stats: {flag: 1, mood: 60, ...stats}, relations: {}},
    time: {hour: 12, weekday: 0},
    mode: {r18: true},
    env: {hideSpots: 0, covered: 0, coveredSec: 0},
    others,
    user: {idleSec: 0, away: false, locked: false, awaySec: 0, pokes: 0},
    playMinutes: 0,
  };
}

/** 推进到条件成立；超时抛错。条件在每帧前后各查一次。 */
function untilSim(drv: DuoDriver, pred: () => boolean, what: string, maxSec = 30): void {
  const started = drv.now;
  for (;;) {
    if (pred()) return;
    drv.frame();
    if (pred()) return;
    if (drv.now - started > maxSec) throw new Error(`跑了 ${(drv.now - started).toFixed(2)} 秒还没到${what}`);
  }
}

/** 只站着不动的脑子：idle 一步很长（测试里当固定靶子）。 */
function idleMind(sec = 10_000): MindConfig {
  return {schema: 1, stats: {}, behaviors: [{id: 'idle', weight: 1, steps: [{do: 'idle', sec: [sec, sec]}]}]};
}

/** 只有一个 approach 行为的脑子；冷却默认 30 秒。 */
function approachMind(opts: {gap?: Range; sec?: Range; cooldown?: number} = {}): MindConfig {
  const step: StepTemplate = {do: 'approach', who: 'b',
    ...(opts.gap === undefined ? {} : {gap: opts.gap}), ...(opts.sec === undefined ? {} : {sec: opts.sec})};
  return {schema: 1, stats: {}, behaviors: [{id: 'approach', weight: 1, cooldown: opts.cooldown ?? 30, steps: [step]}]};
}

interface PacingOptions {
  a: MindConfig;
  b?: MindConfig;
  aAt?: Point;
  bAt?: Point;
  /** 按 z 序从上到下 */
  windows?: WinInfo[];
  seed?: number;
}

interface PacingFixture {
  sim: Sim;
  display: DisplayInfo;
}

/**
 * 造一套两个角色的环境：a / b 两个假角色包和 1920×1080 显示器，rng 固定种子。
 * b 先出场并落地（b 的脑子默认只站着），a 后出场；a 出场后还没推进过时间，测试自己用 untilSim / drive 跑。
 */
function makePacing(opts: PacingOptions): PacingFixture {
  const tuning: Tuning = {...DEFAULT_TUNING, idleSec: [0, 0], walkMaxSec: 600};
  const aPack = makePack({id: 'a', mind: opts.a});
  const bPack = makePack({id: 'b', mind: opts.b ?? idleMind()});
  const sim = new Sim([aPack, bPack], tuning, {variant: SCENE_VARIANT, heightLogical: 120, r18: true},
    mulberry32(opts.seed ?? 7),
    {unlocked: [], playSeconds: 0, chars: {
      a: {stats: {}, relations: {}},
      b: {stats: {}, relations: {}},
    }});
  const display = makeDisplay(1, rect(0, 0, 1920, 1080));
  sim.setDesktop({displays: [display], windows: opts.windows ?? []});
  sim.spawn('b', opts.bAt ?? {x: 900, y: FLOOR_Y});
  let t = 0;
  for (let i = 0; i < 300 && sim.charOf('b')!.actor!.state !== 'idle'; i++) {
    t += DT;
    sim.step(t, DT);
  }
  sim.spawn('a', opts.aAt ?? {x: 500, y: FLOOR_Y});
  return {sim, display};
}

// ---------- Brain：StatDef.rates ----------

const RATE_CFG: MindConfig = {
  schema: 1,
  stats: {
    desire: {start: 20, min: 0, max: 100, perHour: 6,
      rates: [{when: {'>=': [{'var': 'self.stats.mood'}, 50]}, perHour: 30}]},
    mood: {start: 60},
  },
  behaviors: [],
};

test('rates：条件成立时在 perHour 上叠加，不成立时只有 perHour', () => {
  const b = new Brain('pacing-rates-basic', RATE_CFG);
  b.tick(3600);
  approx(b.stats.desire, 26, '还没 observe：只有 perHour 6');

  b.observe(mindView({mood: 60}));
  assert.deepEqual(b.rates(), {desire: 30});
  b.tick(3600);
  approx(b.stats.desire, 62, '条件成立：26 + 6 + 30');

  b.observe(mindView({mood: 40}));
  assert.deepEqual(b.rates(), {});
  b.tick(3600);
  approx(b.stats.desire, 68, '条件不成立：只有 perHour 6');
});

test('rates：多条同时成立时叠加', () => {
  const cfg: MindConfig = {
    schema: 1,
    stats: {
      desire: {start: 20, min: 0, max: 100, perHour: 6, rates: [
        {when: {'>=': [{'var': 'self.stats.mood'}, 50]}, perHour: 30},
        {when: {'==': [{'var': 'self.stats.flag'}, 1]}, perHour: 12},
      ]},
      mood: {start: 60},
      flag: {start: 1},
    },
    behaviors: [],
  };
  const b = new Brain('pacing-rates-stack', cfg);
  b.observe(mindView({mood: 60, flag: 1}));
  assert.deepEqual(b.rates(), {desire: 42});
  b.tick(3600);
  approx(b.stats.desire, 68, '20 + 6 + 30 + 12');
});

test('rates：和 toward、范围夹紧一起时按期望值变', () => {
  const cfg: MindConfig = {
    schema: 1,
    stats: {
      // mood：40 + (4 + 6) = 50 → 往 45 靠 2 → 48 → 夹到上限 46
      mood: {start: 40, min: 0, max: 46, perHour: 4, toward: 45, towardPerHour: 2,
        rates: [{when: {'==': [{'var': 'self.stats.flag'}, 1]}, perHour: 6}]},
      // stamina：5 + (-2 - 10) = -7 → 往 3 靠 1 → -6 → 夹到下限 0
      stamina: {start: 5, min: 0, max: 100, perHour: -2, toward: 3, towardPerHour: 1,
        rates: [{when: {'==': [{'var': 'self.stats.flag'}, 1]}, perHour: -10}]},
      flag: {start: 1},
    },
    behaviors: [],
  };
  const b = new Brain('pacing-rates-toward', cfg);
  b.observe(mindView({flag: 1}));
  assert.deepEqual(b.rates(), {mood: 6, stamina: -10});
  b.tick(3600);
  approx(b.stats.mood, 46, 'toward 之后夹到上限');
  approx(b.stats.stamina, 0, 'toward 之后夹到下限');
});

test('rates：observe(null) 清空，之后不再有额外变化', () => {
  const b = new Brain('pacing-rates-null', RATE_CFG);
  b.observe(mindView({mood: 60}));
  b.tick(3600);
  approx(b.stats.desire, 56, '20 + 6 + 30');

  b.observe(null);
  assert.deepEqual(b.rates(), {});
  b.tick(3600);
  approx(b.stats.desire, 62, '清空之后只有 perHour 6');
});

test('rates：规则写错（bad_op）不抛异常、当不成立，同一处只警告一次', () => {
  const cfg: MindConfig = {
    schema: 1,
    stats: {
      desire: {start: 10, min: 0, max: 100, perHour: 1, rates: [
        {when: {'bad_op': 1}, perHour: 100},
        {when: {'==': [{'var': 'self.stats.flag'}, 1]}, perHour: 2},
      ]},
      flag: {start: 1},
    },
    behaviors: [],
  };
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
  try {
    const b = new Brain('pacing-rates-bad-op', cfg);
    assert.doesNotThrow(() => b.observe(mindView({flag: 1})));
    assert.deepEqual(b.rates(), {desire: 2});            // 坏规则当不成立，好规则照常
    b.observe(mindView({flag: 1}));
    b.observe(mindView({flag: 1}));
    b.tick(3600);
    approx(b.stats.desire, 13, '10 + 1 + 2');
  } finally {
    console.warn = original;
  }
  assert.equal(warns.length, 1, warns.join('\n'));
  assert.ok(warns[0].includes('rates[0]'), warns[0]);
});

// ---------- Sim：view.others.dist + rates ----------

const DIST_RATE_CFG: MindConfig = {
  schema: 1,
  stats: {
    desire: {start: 20, min: 0, max: 100, perHour: 12,
      rates: [{when: {'<=': [{'var': 'others.b.dist'}, 3]}, perHour: 30}]},
  },
  behaviors: [{id: 'idle', weight: 1, steps: [{do: 'idle', sec: [10_000, 10_000]}]}],
};

test('Sim：同线段时 others.b.dist = 横向距离 / 身高，3 个身高内 rates 生效；换到窗口顶边后 dist = Infinity、不再生效', () => {
  const fx = makePacing({a: DIST_RATE_CFG, aAt: {x: 500, y: FLOOR_Y}, bAt: {x: 800, y: FLOOR_Y}});
  const drv = drive(fx.sim);
  const ca = fx.sim.charOf('a')!, cb = fx.sim.charOf('b')!;
  const a = ca.actor!, b = cb.actor!;
  const h = heightPxOf(a, ca.spec, fx.sim.ctx());

  untilSim(drv, () => ca.brain.rates().desire === 30, '观察到同线段的 rate');
  assert.deepEqual(ca.brain.rates(), {desire: 30});
  const view = fx.sim.view(ca);
  eq(view.others.b.reachable, true);
  approx(view.others.b.dist, Math.abs(a.x - b.x) / h, 'dist = 横向距离 / 自己的身高');
  approx(view.others.b.dist, 2.5, '两人的脚底点相距 300 px、身高 120 px');

  const before = ca.brain.stats.desire;
  drv.frames(60);                                      // 2 秒，rate 不变
  approx(ca.brain.stats.desire - before, (12 + 30) * 60 * DT / 3600, '同线段 2 秒的增量');

  // b 换到窗口顶边上：和 a 不是同一条线段
  const win = makeWindow(10, rect(1200, 600, 1800, 1000));
  fx.sim.setDesktop({displays: [fx.display], windows: [win]});
  fx.sim.spawn('b', {x: 1500, y: win.rect.top});
  untilSim(drv, () => {
    const actor = fx.sim.charOf('b')!.actor!;
    return actor.state === 'idle' && actor.support?.key === 'win:10';
  }, 'b 站到窗口顶边');
  untilSim(drv, () => Object.keys(ca.brain.rates()).length === 0, 'rate 清空');

  const view2 = fx.sim.view(ca);
  eq(view2.others.b.reachable, false);
  eq(view2.others.b.dist, Infinity);
  eq(Number.isFinite(view2.others.b.dist), false);
  assert.deepEqual(ca.brain.rates(), {});

  const before2 = ca.brain.stats.desire;
  drv.frames(60);
  approx(ca.brain.stats.desire - before2, 12 * 60 * DT / 3600, '不同线段 2 秒只有 perHour');
});

// ---------- Sim：approach 步骤模板 ----------

test('approach：同线段上走到对方身边，停在默认 gap [0.8, 1.5] 身高内、靠对方一侧，最后朝向对方', () => {
  const fx = makePacing({a: approachMind({sec: [2, 2]}), aAt: {x: 500, y: FLOOR_Y}, bAt: {x: 900, y: FLOOR_Y}});
  const drv = drive(fx.sim);
  const ca = fx.sim.charOf('a')!, cb = fx.sim.charOf('b')!;
  const a = ca.actor!, b = cb.actor!;

  untilSim(drv, () => a.state === 'walk' && a.plan?.behavior === 'approach', 'a 开始走向 b');
  const h = heightPxOf(a, ca.spec, fx.sim.ctx());
  const target = a.targetX;
  assert.ok(target !== null, 'walk 步骤应该有 targetX');
  assert.ok(target < b.x, `a 在 b 左边，目标 ${target} 应该还在 b（${b.x}）左边`);
  assert.ok(b.x - target >= 0.8 * h - 1e-9, `gap ${(b.x - target) / h} 个身高，小于 0.8`);
  assert.ok(b.x - target <= 1.5 * h + 1e-9, `gap ${(b.x - target) / h} 个身高，大于 1.5`);
  eq(a.plan!.steps.length, 1);
  const idleStep = a.plan!.steps[0];
  eq(idleStep.state, 'idle');
  eq(idleStep.sec, 2);
  eq(idleStep.facing, 1);

  untilSim(drv, () => a.state === 'idle' && a.plan?.behavior === 'approach', 'a 走到并开始面向 b 站着');
  approx(a.x, target, '走到 targetX 就停');
  eq(a.facing, 1);
  assert.ok(a.x < b.x, `a（${a.x}）应该还在 b（${b.x}）靠自己这一侧`);
  assert.ok(b.x - a.x >= 0.8 * h - 1e-9 && b.x - a.x <= 1.5 * h + 1e-9,
    `停下的距离 ${((b.x - a.x) / h).toFixed(3)} 个身高，不在 [0.8, 1.5] 里`);
});

test('approach：靠线段端点时目标被夹到 x0 + 半宽', () => {
  const fx = makePacing({a: approachMind({gap: [1, 1], sec: [2, 2]}), aAt: {x: 50, y: FLOOR_Y}, bAt: {x: 100, y: FLOOR_Y}});
  const drv = drive(fx.sim);
  const ca = fx.sim.charOf('a')!;
  const a = ca.actor!;

  untilSim(drv, () => a.state === 'walk' && a.plan?.behavior === 'approach', 'a 开始走向 b');
  const h = heightPxOf(a, ca.spec, fx.sim.ctx()), hw = ca.spec.halfWidthRatio * h;
  const expected = a.support!.x0 + hw;                  // 100 - 1×120 = -20，夹到地面左边 + 半宽 = 30
  approx(a.targetX!, expected, 'targetX 夹到线段左端 + 半宽');
  approx(expected, 30, '地面 x0 = 0、半宽 = 30');

  untilSim(drv, () => a.state === 'idle' && a.plan?.behavior === 'approach', 'a 走到被夹住的目标');
  approx(a.x, expected, '停在夹住后的位置');
  eq(a.facing, 1);                                      // b（100）在 a（30）右边
});

test('approach：对方不在同一线段时解析失败，行为进冷却、原地 idle 不卡住', () => {
  const win = makeWindow(10, rect(1200, 600, 1800, 1000));
  const fx = makePacing({a: approachMind({gap: [1, 1]}), aAt: {x: 500, y: FLOOR_Y},
    bAt: {x: 1500, y: win.rect.top}, windows: [win]});
  const drv = drive(fx.sim);
  const ca = fx.sim.charOf('a')!;
  const a = ca.actor!;

  untilSim(drv, () => a.state === 'idle' && a.support?.key === 'floor:1', 'a 落地并尝试 approach');
  const failedAt = drv.now;
  const idsAt = (t: number) => ca.brain.candidates(fx.sim.view(ca), t, {r18: true}).map(c => c.def.id);
  eq(a.plan, null);                                     // 解析失败：没有换成别的计划，也没卡在 walk
  eq(a.x, 500);
  assert.ok(!idsAt(failedAt).includes('approach'), '解析失败后应该进冷却');
  assert.ok(!idsAt(failedAt + 29).includes('approach'), '29 秒时还在冷却');
  assert.ok(idsAt(failedAt + 30).includes('approach'), '30 秒时冷却结束');

  drv.frames(5 * 30);                                   // 冷却期内一直原地 idle
  eq(a.plan, null);
  eq(a.state, 'idle');
  eq(a.x, 500);

  drv.frames(26 * 30);                                  // 总共 31 秒：冷却结束后重试，仍然解析失败
  eq(a.plan, null);
  eq(a.state, 'idle');
  eq(a.x, 500);
  assert.ok(!idsAt(drv.now).includes('approach'), '重试失败后重新进冷却');
});

// ---------- Sim：双人被拒的 declineCooldown ----------

test('declineCooldown：写了 30 时被拒后约 30 秒再问，不是行为自己的 120 秒', () => {
  const fx = makeDuo({bDesire: 10, declineCooldown: 30});   // b 的 accept 要 desire >= 40，所以必拒
  const drv = drive(fx.sim);
  const ca = fx.sim.charOf('a')!;
  const idsAt = (t: number) => ca.brain.candidates(fx.sim.view(ca), t, {r18: true}).map(c => c.def.id);

  const firstFrame = drv.until(e => e.type === 'duo' && e.what === 'declined', '第一次 declined', 5);
  const first = firstFrame.find(x => x.e.type === 'duo' && x.e.what === 'declined')!;
  assert.ok(!idsAt(fx.sim.now + 29).includes('sex'), '29 秒时还在冷却（行为自己的 120 秒也没到）');
  assert.ok(idsAt(fx.sim.now + 30).includes('sex'), '30 秒时冷却结束');

  const secondFrame = drv.until(e => e.type === 'duo' && e.what === 'declined', '第二次 declined', 40);
  const second = secondFrame.find(x => x.e.type === 'duo' && x.e.what === 'declined')!;
  const gap = second.t - first.t;
  assert.ok(gap >= 30 - 1e-9 && gap <= 31, `两次 declined 间隔 ${gap.toFixed(3)} 秒，应该约 30 秒`);
  eq(drv.log.filter(x => x.e.type === 'duo' && x.e.what === 'declined').length, 2);
});
