// behavior/brain 的单测：状态值随时间变、行为候选（when / 冷却 / R18 / JSON Logic 权重）、按权重随机、
// “下一步”限制、效果（start / end / interrupt）、接受邀请、解锁、初始值。规则见 docs/state-rules.md §2.2、
// docs/requirements.md R3.1–R3.5、R3.3 和 src/behavior/mind.ts 的注释。
import test from 'node:test';
import assert from 'node:assert/strict';

import {Brain, initialStats, isUnlocked, pickRange} from '../src/behavior/brain.ts';
import type {MindConfig, MindView, UnlockView} from '../src/behavior/mind.ts';
import {mulberry32} from './helpers/fake-desktop.ts';

// ---------- 测试数据 ----------
// 一个够用的小角色：欲望（自己涨、驱动权重）、体力（自己掉）、心情（往 50 靠）、精力（perHour + toward 叠加）、
// 热量（顶到上限）、两个初始好感、两种邀请规则、五个行为（普通 / 有 when + 冷却 + next / R18 带效果 / 双人 / 小权重）。
const CFG: MindConfig = {
  schema: 1,
  stats: {
    desire: {start: 30, min: 0, max: 100, perHour: 6},
    stamina: {start: 80, min: 0, max: 100, perHour: -4},
    mood: {start: 40, min: 0, max: 100, toward: 50, towardPerHour: 5},
    energy: {start: 70, min: 0, max: 100, perHour: -10, toward: 60, towardPerHour: 5},
    heat: {start: 10, min: 0, max: 10, toward: 10, towardPerHour: 5},
  },
  relations: {user: {affection: 20}, witch: {affection: 70}},
  accept: {
    sex: {'>=': [{'var': 'self.stats.desire'}, 50]},
    hug: {'==': [{'var': 'inviter'}, 'witch']},
  },
  behaviors: [
    {id: 'idle', weight: 10, steps: []},
    {id: 'hide', weight: 5, when: {'>=': [{'var': 'self.stats.desire'}, 40]}, cooldown: 10, next: ['masturbate'], steps: []},
    {
      id: 'masturbate', weight: {'*': [{'var': 'self.stats.desire'}, 0.1]}, r18: true,
      effects: {
        start: {'stats.desire': 5},
        end: {'stats.stamina': -10, 'relations.$partner.affection': 3},
        interrupt: {'stats.mood': -5},
      },
      steps: [],
    },
    {id: 'duo', weight: 1, r18: true, when: {'>=': [{'var': 'self.relations.user.affection'}, 60]}, steps: []},
    {id: 'sleep', weight: 0.0001, steps: []},
  ],
};

interface ViewOptions {
  desire?: number;
  userAffection?: number;
  r18?: boolean;
  inviter?: string;
  stats?: Record<string, number>;
  playMinutes?: number;
}

/** 造一个 MindView（只填测试要用的字段） */
function makeView(opts: ViewOptions = {}): MindView {
  const view: MindView = {
    self: {
      id: 'witch', state: 'idle', outfit: 'clothed', layer: 'front', support: 'floor', phase: null, stepSec: 0, afterSexSec: Infinity,
      stats: {desire: opts.desire ?? 30, stamina: 80, mood: 40, energy: 70, heat: 10, ...opts.stats},
      relations: {user: {affection: opts.userAffection ?? 20}, witch: {affection: 70}},
    },
    time: {hour: 14, weekday: 2},
    mode: {r18: opts.r18 ?? true},
    env: {hideSpots: 2, covered: 0, coveredSec: 0},
    others: {},
    user: {idleSec: 0, away: false, locked: false, awaySec: 0, pokes: 0},
    playMinutes: opts.playMinutes ?? 0,
  };
  if (opts.inviter !== undefined) view.inviter = opts.inviter;
  return view;
}

/** 造一个 UnlockView */
function makeUnlockView(playMinutes = 0): UnlockView {
  return {
    chars: {witch: {stats: {desire: 60}, relations: {user: {affection: 80}}}},
    playMinutes,
    time: {hour: 14, weekday: 2},
    mode: {r18: true},
  };
}

const ids = (list: {def: {id: string}}[]) => list.map(c => c.def.id);

// ---------- 初值 ----------
test('initialStats：cfg.stats 的 start 为初值，saved 覆盖并夹范围，不在 cfg 里的键丢掉', () => {
  const b = new Brain('init', CFG, {stats: {desire: 999, stamina: 12, mood: -5, bogus: 50, heat: Number.NaN}});
  assert.deepEqual(b.stats, {desire: 100, stamina: 12, mood: 0, energy: 70, heat: 10});
  assert.equal('bogus' in b.stats, false);

  // 直接测函数（不经过 Brain），确认不依赖实例状态
  assert.deepEqual(initialStats(CFG), {desire: 30, stamina: 80, mood: 40, energy: 70, heat: 10});
  assert.deepEqual(initialStats(CFG, {stamina: -1}), {desire: 30, stamina: 0, mood: 40, energy: 70, heat: 10});
});

test('好感初值：cfg.relations 有的用它，saved 覆盖并夹 0..100，多出来的对象保留', () => {
  const b = new Brain('relations', CFG, {relations: {user: {affection: 250}, witch: {affection: -3}, extra: {affection: 61}}});
  assert.deepEqual(b.relations, {user: {affection: 100}, witch: {affection: 0}, extra: {affection: 61}});
  const fresh = new Brain('relations2', CFG);
  assert.deepEqual(fresh.relations, {user: {affection: 20}, witch: {affection: 70}});
});

// ---------- tick ----------
test('tick：perHour 线性增减，最后夹到 [min, max]', () => {
  const b = new Brain('tick', CFG);
  b.tick(3600);
  assert.equal(b.stats.desire, 36); // 30 + 6
  assert.equal(b.stats.stamina, 76); // 80 - 4

  b.tick(100 * 3600);
  assert.equal(b.stats.desire, 100); // 36 + 600 → 上限
  assert.equal(b.stats.stamina, 0); // 76 - 400 → 下限
  assert.equal(b.stats.heat, 10); // 已经在 toward / 上限上
});

test('tick：toward 往目标靠、不越过，和 perHour 叠加', () => {
  const b = new Brain('toward', CFG);
  b.tick(3600);
  assert.equal(b.stats.mood, 45); // 40 → 50，每小时 5
  assert.equal(b.stats.energy, 60); // 70 - 10 = 60，正好是 toward
  b.tick(3600);
  assert.equal(b.stats.mood, 50); // 到 50
  assert.equal(b.stats.energy, 55); // 60 - 10 = 50，再往 60 靠 5
  b.tick(3600);
  assert.equal(b.stats.mood, 50); // 不越过
  assert.equal(b.stats.energy, 50); // 55 - 10 = 45，再往 60 靠 5
});

test('tick：0 / 负数 / 非有限 dt 不动', () => {
  const b = new Brain('tick-noop', CFG);
  const before = {...b.stats};
  b.tick(0);
  b.tick(-60);
  b.tick(Number.NaN);
  b.tick(Number.POSITIVE_INFINITY);
  assert.deepEqual(b.stats, before);
});

// ---------- candidates ----------
test('candidates：按 when / R18 / 冷却过滤，权重用 JSON Logic 求值，顺序同 cfg.behaviors', () => {
  const b = new Brain('candidates', CFG);

  // （开源版省略）
  assert.deepEqual(
    b.candidates(makeView(), 0, {r18: true}).map(c => [c.def.id, c.weight]),
    [['idle', 10], ['masturbate', 3], ['sleep', 0.0001]],
  );

  // 全年龄模式去掉 r18
  assert.deepEqual(ids(b.candidates(makeView(), 0, {r18: false})), ['idle', 'sleep']);

  // 欲望 60、好感 70：全部可选，权重按顺序
  const hot = makeView({desire: 60, userAffection: 70});
  assert.deepEqual(
    b.candidates(hot, 0, {r18: true}).map(c => [c.def.id, c.weight]),
    [['idle', 10], ['hide', 5], ['masturbate', 6], ['duo', 1], ['sleep', 0.0001]],
  );

  // 冷却：started 记 now + cooldown，now < 冷却结束时不在候选里
  b.started(CFG.behaviors[1], 100);
  assert.deepEqual(ids(b.candidates(hot, 109.999, {r18: true})), ['idle', 'masturbate', 'duo', 'sleep']);
  assert.deepEqual(ids(b.candidates(hot, 110, {r18: true})), ['idle', 'hide', 'masturbate', 'duo', 'sleep']);
});

test('candidates：权重 0 / 负数 / Infinity / 非数都不列（非有限数或负数当 0）', () => {
  const cfg: MindConfig = {
    schema: 1,
    stats: {},
    behaviors: [
      {id: 'zero', weight: 0, steps: []},
      {id: 'negative', weight: -2, steps: []},
      {id: 'infinity', weight: {'/': [1, 0]}, steps: []},
      {id: 'null', weight: {'var': 'self.stats.missing'}, steps: []},
      {id: 'ok', weight: {'+': [1, 2]}, steps: []},
    ],
  };
  const b = new Brain('weights', cfg);
  assert.deepEqual(b.candidates(makeView(), 0, {r18: true}).map(c => [c.def.id, c.weight]), [['ok', 3]]);
});

// ---------- choose ----------
test('choose：按权重随机（固定 rng 序列）', () => {
  const cfg: MindConfig = {
    schema: 1,
    stats: {},
    behaviors: [{id: 'a', weight: 1, steps: []}, {id: 'b', weight: 3, steps: []}],
  };
  const b = new Brain('choose-fixed', cfg);
  // 总权重 4：r < 0.25 → a，否则 b
  const picks = [0.24, 0.26, 0.999, 0].map(r => b.choose(makeView(), 0, () => r, {r18: true})?.id);
  assert.deepEqual(picks, ['a', 'b', 'b', 'a']);
  assert.equal(b.choose(makeView(), 0, () => 0, {r18: true})?.id, 'a'); // 每次选完限制清掉，下一次照常
});

test('choose：1 万次带种子随机，选中比例接近权重比', () => {
  const cfg: MindConfig = {
    schema: 1,
    stats: {},
    behaviors: [{id: 'a', weight: 1, steps: []}, {id: 'b', weight: 3, steps: []}],
  };
  const b = new Brain('choose-stats', cfg);
  const rng = mulberry32(20261020);
  let a = 0;
  const rounds = 10_000;
  for (let i = 0; i < rounds; i++) if (b.choose(makeView(), 0, rng, {r18: true})?.id === 'a') a++;
  const ratio = a / rounds;
  assert.ok(Math.abs(ratio - 0.25) < 0.02, `a 的比例 ${ratio.toFixed(4)} 应接近 0.25`);
});

test('choose：没有候选返回 null', () => {
  const cfg: MindConfig = {schema: 1, stats: {}, behaviors: [{id: 'only-r18', weight: 1, r18: true, steps: []}]};
  const b = new Brain('choose-null', cfg);
  assert.equal(b.choose(makeView(), 0, () => 0, {r18: false}), null);
});

test('choose：done 后只在 next 里选，选中后限制清掉', () => {
  const b = new Brain('next', CFG);
  const hot = makeView({desire: 60, userAffection: 70});
  const hide = CFG.behaviors[1];
  b.started(hide, 0);
  b.ended('hide', 'done', 5); // （开源版省略）
  // （开源版省略）
  assert.equal(b.choose(hot, 100, () => 0, {r18: true})?.id, 'masturbate');
  // 限制已清：rng 0 选第一个候选 idle
  assert.equal(b.choose(hot, 100, () => 0, {r18: true})?.id, 'idle');
});

test('choose：next 里一个可选的都没有就照常从全部候选选', () => {
  const b = new Brain('next-fallback', CFG);
  const hot = makeView({desire: 60, userAffection: 70});
  b.started(CFG.behaviors[1], 0);
  b.ended('hide', 'done', 5); // （开源版省略）
  assert.equal(b.choose(hot, 100, () => 0, {r18: false})?.id, 'idle');
});

test('choose：aborted 的行为不留 next 限制', () => {
  const b = new Brain('next-abort', CFG);
  const hot = makeView({desire: 60, userAffection: 70});
  const hide = CFG.behaviors[1];
  b.started(hide, 0);
  b.ended('hide', 'done', 1); // （开源版省略）
  b.started(hide, 2);
  b.ended('hide', 'aborted', 3); // 中止后应该清掉
  assert.equal(b.choose(hot, 100, () => 0, {r18: true})?.id, 'idle');
});

test('ended：id 不在 cfg.behaviors 里（builtin / reaction）什么都不做', () => {
  const b = new Brain('ended-unknown', CFG);
  const hot = makeView({desire: 60, userAffection: 70});
  b.started(CFG.behaviors[1], 0);
  b.ended('hide', 'done', 1); // （开源版省略）
  const before = b.save();
  b.ended('builtin:idle', 'done', 2, 'user');
  b.ended('reaction:discovered', 'aborted', 3);
  assert.deepEqual(b.save(), before);
  assert.equal(b.choose(hot, 100, () => 0, {r18: true})?.id, 'masturbate'); // next 限制还在
});

// ---------- effects ----------
test('effects：start / end / interrupt、$partner、好感默认 50、夹 0..100、未知状态值忽略', () => {
  const b = new Brain('effects', CFG);
  const mast = CFG.behaviors[2];

  b.started(mast, 0, 'silent');
  assert.equal(b.stats.desire, 35); // start: +5
  assert.equal(b.relations.silent, undefined); // start 里没有关系效果

  b.ended('masturbate', 'done', 60, 'silent');
  assert.equal(b.stats.stamina, 70); // end: -10
  assert.deepEqual(b.relations.silent, {affection: 53}); // 没写过 → 50 起，+3
  assert.deepEqual(b.relations.user, {affection: 20});

  b.started(mast, 120, 'silent');
  b.ended('masturbate', 'aborted', 180, 'silent');
  assert.equal(b.stats.mood, 35); // interrupt: -5

  // 夹范围；不存在的状态值忽略（只警告一次，不抛异常）
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
  try {
    b.applyEffects({'relations.user.affection': 500, 'stats.desire': 1000, 'stats.nope': 3});
    b.applyEffects({'stats.nope': 1});
  } finally {
    console.warn = original;
  }
  assert.equal(warns.length, 1, warns.join('\n'));
  assert.ok(warns[0].includes('nope'), warns[0]);
  assert.deepEqual(b.relations.user, {affection: 100});
  assert.equal(b.stats.desire, 100);
  assert.equal('nope' in b.stats, false);

  b.applyEffects({'relations.user.affection': -1000});
  assert.deepEqual(b.relations.user, {affection: 0});

  // 单人执行双人效果：没有 partner，$partner 整条忽略，不造一个 "$partner" 关系
  b.applyEffects({'relations.$partner.affection': 10});
  assert.equal('$partner' in b.relations, false);
});

test('effects：默认 50 起的好感（读没写过的对象）', () => {
  const b = new Brain('effects-default', CFG);
  b.applyEffects({'relations.stranger.affection': 1});
  assert.deepEqual(b.relations.stranger, {affection: 51});
});

// ---------- 规则 ----------
test('test：JSON Logic 真值判断照 jsonLogic.truthy', () => {
  const b = new Brain('test', CFG);
  const view = makeView({desire: 30, stats: {zero: 0}});
  assert.equal(b.test({'>=': [{'var': 'self.stats.desire'}, 30]}, view), true);
  assert.equal(b.test({'>': [{'var': 'self.stats.desire'}, 30]}, view), false);
  assert.equal(b.test({'var': 'self.stats.zero'}, view), false); // 0 是假
  assert.equal(b.test(0, view), false);
  assert.equal(b.test(1, view), true);
  assert.equal(b.test(undefined, view), false);
});

test('accepts：没写 = 接受，规则看自己的状态和 inviter', () => {
  const b = new Brain('accept', CFG);
  assert.equal(b.accepts('sex', makeView({desire: 30})), false);
  assert.equal(b.accepts('sex', makeView({desire: 50})), true);
  assert.equal(b.accepts('not-configured', makeView()), true);
  assert.equal(b.accepts('hug', makeView({inviter: 'witch'})), true);
  assert.equal(b.accepts('hug', makeView({inviter: 'silent'})), false);
  assert.equal(b.accepts('hug', makeView()), false); // 没填 inviter，取不到
});

test('isUnlocked：没写 / null 一开始就有，规则照 JSON Logic 真假', () => {
  const base: MindConfig = {schema: 1, stats: {}, behaviors: []};
  assert.equal(isUnlocked(base, makeUnlockView(0)), true);
  assert.equal(isUnlocked({...base, unlock: null}, makeUnlockView(0)), true);
  const locked: MindConfig = {...base, unlock: {'>=': [{'var': 'playMinutes'}, 10]}};
  assert.equal(isUnlocked(locked, makeUnlockView(5)), false);
  assert.equal(isUnlocked(locked, makeUnlockView(10)), true);
});

test('规则写错：不抛异常，当作 false / 权重 0，同一处只警告一次', () => {
  const broken: MindConfig = {
    schema: 1,
    stats: {desire: {start: 50}},
    accept: {sex: {'bad-op': []}},
    behaviors: [
      {id: 'badWhen', weight: 10, when: {'bad-op': []}, steps: []},
      {id: 'badWeight', weight: {'bad-op': []}, steps: []},
      {id: 'infinityWeight', weight: {'/': [1, 0]}, steps: []}, // 不抛异常，只是非有限数 → 0
    ],
  };
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
  try {
    const b = new Brain('broken-rules-test', broken);
    const view = makeView();
    assert.deepEqual(b.candidates(view, 0, {r18: true}), []);
    assert.deepEqual(b.candidates(view, 0, {r18: true}), []); // 不重复警告
    assert.equal(b.choose(view, 0, () => 0, {r18: true}), null);
    assert.equal(b.test({'bad-op': []}, view), false);
    assert.equal(b.test({'bad-op': []}, view), false);
    assert.equal(b.accepts('sex', view), false);
    assert.equal(b.accepts('sex', view), false);
    const unlockCfg: MindConfig = {...broken, unlock: {'bad-op': []}};
    assert.equal(isUnlocked(unlockCfg, makeUnlockView()), false);
    assert.equal(isUnlocked(unlockCfg, makeUnlockView()), false);
  } finally {
    console.warn = original;
  }
  // badWhen.when、badWeight.weight、test 的规则、accept.sex、unlock 各一次
  assert.equal(warns.length, 5, warns.join('\n'));
  assert.ok(warns[0].includes('badWhen.when'), warns[0]);
  assert.ok(warns[1].includes('badWeight.weight'), warns[1]);
});

// ---------- 其他 ----------
test('pickRange：数原样，[lo, hi] 均匀随机', () => {
  assert.equal(pickRange(5, () => 0.5), 5);
  assert.equal(pickRange([10, 20] as const, () => 0), 10);
  assert.equal(pickRange([10, 20] as const, () => 0.5), 15);
  assert.equal(pickRange([10, 20] as const, () => 1), 20);
});

test('save：只存状态值和好感（深拷贝），构造回来能恢复，冷却和 next 不进存档', () => {
  const b = new Brain('save', CFG);
  b.tick(3600);
  b.applyEffects({'relations.user.affection': 10});
  b.started(CFG.behaviors[1], 100); // hide 冷却到 110
  const saved = b.save();
  assert.deepEqual(Object.keys(saved).sort(), ['relations', 'stats']);
  assert.deepEqual(saved.stats, b.stats);
  assert.deepEqual(saved.relations.user, {affection: 30});

  // 深拷贝：改存档不影响实例
  saved.stats.desire = 999;
  assert.equal(b.stats.desire, 36);

  const back = new Brain('save2', CFG, b.save());
  assert.deepEqual(back.stats, b.stats);
  assert.deepEqual(back.relations, b.relations);

  // 冷却不进存档：原实例在冷却中，恢复出来的不在
  const hot = makeView({desire: 60, userAffection: 70});
  assert.equal(b.candidates(hot, 100, {r18: true}).some(c => c.def.id === 'hide'), false);
  assert.equal(back.candidates(hot, 100, {r18: true}).some(c => c.def.id === 'hide'), true);

  // （开源版省略）
  b.started(CFG.behaviors[1], 200);
  b.ended('hide', 'done', 210);
  const back2 = new Brain('save3', CFG, b.save());
  assert.equal(b.choose(hot, 300, () => 0, {r18: true})?.id, 'masturbate');
  assert.equal(back2.choose(hot, 300, () => 0, {r18: true})?.id, 'idle');
});
