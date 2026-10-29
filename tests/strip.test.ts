// （开源版省略）
// 或者是旧的一团烟；状态机按 Step.outfitAt 在步骤中途换衣着（src/behavior/actor.ts 的 stepActor），被拎起来就不再换；
// （开源版省略）
// 规则见 docs/state-rules.md §6、docs/features.md N1.5、src/main/sim.ts 的 outfitStep() / resolve() / inviteDuo() / setR18()。
// 用假角色包 + 假场景（tests/helpers/fake-scene.ts），不读 packs/ 下的导出生成物（现在的包还没导出 strip 片段）；
// 时间按 1/30 秒推进，rng 固定种子。
import test from 'node:test';
import assert from 'node:assert/strict';

import {DEFAULT_TUNING, type ActionInfo, type Actor, type MindConfig, type StepTemplate, type Tuning} from '../src/behavior/index.ts';
import type {Pack} from '../src/pack/index.ts';
import {Sim, type SimEvent} from '../src/main/sim.ts';
import type {DisplayInfo} from '../src/shared/types.ts';
import {
  DT, FLOOR_Y, SCENE_VARIANT, drive, makeDuo, makePack, type DuoDriver, type FakePackOptions, type LoggedEvent,
} from './helpers/fake-scene.ts';
import {makeDisplay, mulberry32, rect} from './helpers/fake-desktop.ts';
import {approx, eq} from './helpers/assert.ts';

/** 推进到条件成立（最多 maxSec 秒）；超时抛错 */
function runUntil(drv: DuoDriver, pred: () => boolean, what: string, maxSec = 30): void {
  const started = drv.now;
  while (!pred()) {
    if (drv.now - started > maxSec) throw new Error(`跑了 ${(drv.now - started).toFixed(1)} 秒还没到${what}`);
    drv.frame();
  }
}

/** log 里的 outfit 事件 */
function outfitEvents(log: readonly LoggedEvent[]): {t: number; id: string; outfit: string}[] {
  return log.flatMap(x => x.e.type === 'outfit' ? [{t: x.t, id: x.id, outfit: x.e.outfit}] : []);
}

// （开源版省略）

/** 衣着从穿得多到穿得少排（pack.json 的 outfits） */
const OUTFITS3 = ['clothed', 'topless', 'nude'] as const;

/** （开源版省略） */
const STRIP: ActionInfo & {clip: string; switchSec?: number} = {frames: 60, fps: 12, loop: false, clip: 'strip', r18: true, switchSec: 3};
/** （开源版省略） */
const STRIP_NO_SWITCH: ActionInfo & {clip: string} = {frames: 60, fps: 12, loop: false, clip: 'strip', r18: true};

const SWITCH_SEC = STRIP.switchSec!;             // 3
const STRIP_SEC = STRIP.frames / STRIP.fps;      // （开源版省略）
const PUFF_SEC = 0.6 * 0.6;                      // 烟挡 0.36 秒（sim.ts 的 FX_SEC.puff × 0.6）

interface SoloOptions {
  /** 唯一一个行为的步骤（id = test、权重 1、冷却 3600 秒：做完一次就不会再被选中，方便断言） */
  steps: readonly StepTemplate[];
  outfits?: readonly string[];
  extraActions?: FakePackOptions['extraActions'];
  /** R18 模式；默认开 */
  r18?: boolean;
  /** 出场时的衣着；默认 clothed */
  outfit?: string;
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
  const mind: MindConfig = {schema: 1, stats: {}, behaviors: [{id: 'test', weight: 1, cooldown: 3600, steps: opts.steps}]};
  const pack = makePack({id: 's', mind, ...(opts.outfits ? {outfits: opts.outfits} : {}),
    ...(opts.extraActions ? {extraActions: opts.extraActions} : {})});
  const sim = new Sim([pack], tuning, {variant: SCENE_VARIANT, heightLogical: 120, r18: opts.r18 ?? true}, mulberry32(3),
    {unlocked: [], playSeconds: 0, chars: {s: {stats: {}, relations: {}}}}, new Map());
  const display = makeDisplay(1, rect(0, 0, 1920, 1080));
  sim.setDesktop({displays: [display], windows: []});
  sim.spawn('s', {x: 800, y: FLOOR_Y}, opts.outfit);
  return {sim, pack, a: sim.charOf('s')!.actor!, display};
}

// ---------- 1. 往少了脱：播 strip，播到 switchSec 换衣着 ----------

test('脱衣：clothed → nude 解析成播 strip 的一步，switchSec 之前还是 clothed，过了换成 nude，之后接着走计划', () => {
  const fx = makeSolo({
    steps: [{do: 'outfit', to: 'nude'}, {do: 'play', action: 'idle', sec: [0.5, 0.5], state: 'idle'}],
    outfits: OUTFITS3, extraActions: {strip: STRIP},
  });
  const drv = drive(fx.sim);
  runUntil(drv, () => fx.a.state === 'strip', '开始脱衣');
  const a = fx.a;

  // 解析成播 strip 的一步：开始后衣着还没换、动作是 strip；后面跟着计划里的下一步
  eq(a.action, 'strip');
  eq(a.outfit, 'clothed');
  eq(a.step?.state, 'strip');
  eq(a.step?.action, 'strip');
  assert.deepEqual(a.step?.outfitAt, {sec: SWITCH_SEC, to: 'nude'});
  eq(a.step?.sec, undefined, '片段自己播完，不另给 sec');
  eq(a.plan?.behavior, 'test');
  eq(a.plan?.steps.length, 1);
  eq(a.plan?.steps[0].state, 'idle');
  eq(outfitEvents(drv.log).length, 0, '开始时不换衣着');

  // 3 秒前一刻（2.9 秒）还是 clothed
  const started = a.stateStart;
  drv.frames(Math.round(2.9 / DT));
  assert.ok(drv.now - started < SWITCH_SEC, '2.9 秒这一刻应该还没到 switchSec');
  eq(a.outfit, 'clothed');
  eq(a.state, 'strip');
  eq(outfitEvents(drv.log).length, 0);

  // 过了 3 秒换成 nude，只发一次 outfit 事件
  runUntil(drv, () => a.outfit === 'nude', '换成 nude', 1);
  const switched = drv.now;
  const frames = Math.round((switched - started) / DT);
  // 3 秒 = 90 帧；1/30 秒累加的浮点误差可能让第 91 帧才算到 3 秒
  assert.ok(frames === 90 || frames === 91, `应该在 3 秒（90 帧）左右换衣着，实际 ${frames} 帧`);
  assert.ok(switched - started >= SWITCH_SEC && switched - started <= SWITCH_SEC + DT + 1e-9,
    `换衣着的时刻 ${(switched - started).toFixed(4)} 秒，应该在 ${SWITCH_SEC}～${SWITCH_SEC + DT} 秒之间`);
  eq(a.state, 'strip', '片段还没播完');
  const outs = outfitEvents(drv.log);
  eq(outs.length, 1);
  eq(outs[0].id, 's');
  eq(outs[0].outfit, 'nude');
  approx(outs[0].t, switched, '事件时刻');
  assert.deepEqual(drv.log.find(x => x.e.type === 'outfit')?.e, {type: 'outfit', outfit: 'nude'}, '事件的样子');

  // 片段剩下 2 秒：播完才进计划的下一步
  eq(a.plan?.steps.length, 1);
  runUntil(drv, () => a.state === 'idle', '脱衣片段播完、接着 idle', STRIP_SEC);
  assert.ok(drv.now - started >= STRIP_SEC - 1e-9, `strip 片段应该播满 ${STRIP_SEC} 秒`);
  eq(a.action, 'idle');
  eq(a.outfit, 'nude');
  eq(a.step?.state, 'idle');
  eq(a.plan?.behavior, 'test');
  eq(outfitEvents(drv.log).length, 1, '只换一次，片段播完不再换');
});

// ---------- 2. 三档衣着之间往少了脱都走 strip ----------

test('脱衣：clothed → topless、topless → nude 也走 strip，各自换成目标衣着', () => {
  for (const c of [{from: 'clothed', to: 'topless'}, {from: 'topless', to: 'nude'}] as const) {
    const fx = makeSolo({
      steps: [{do: 'outfit', to: c.to}, {do: 'play', action: 'idle', sec: [0.3, 0.3], state: 'idle'}],
      outfits: OUTFITS3, extraActions: {strip: STRIP}, outfit: c.from,
    });
    const drv = drive(fx.sim), a = fx.a;
    runUntil(drv, () => a.state === 'strip', `${c.from} → ${c.to} 开始脱衣`);
    eq(a.action, 'strip', `${c.from} → ${c.to}：动作`);
    eq(a.outfit, c.from, `${c.from} → ${c.to}：开始后衣着还没换`);
    assert.deepEqual(a.step?.outfitAt, {sec: SWITCH_SEC, to: c.to}, `${c.from} → ${c.to}：换成的目标`);

    // 3 秒前不换（先推 2 秒）
    drv.frames(Math.round(2 / DT));
    eq(a.outfit, c.from, `${c.from} → ${c.to}：3 秒前不换`);

    runUntil(drv, () => a.outfit === c.to, `${c.from} → ${c.to} 换成目标衣着`, 3);
    eq(a.outfit, c.to);
    const outs = outfitEvents(drv.log);
    eq(outs.length, 1);
    eq(outs[0].outfit, c.to);

    // 片段播完 → 下一步；衣着停在目标
    runUntil(drv, () => a.state === 'idle', `${c.from} → ${c.to} 播完`, STRIP_SEC);
    eq(a.outfit, c.to);
    eq(outfitEvents(drv.log).length, 1);
  }
});

// ---------- 3. 穿回去：一团烟 ----------

test('穿回去：nude / topless → clothed 用一团烟，开始时马上换衣着、state 是 dress', () => {
  for (const from of ['nude', 'topless'] as const) {
    const fx = makeSolo({
      steps: [{do: 'outfit', to: 'clothed'}, {do: 'play', action: 'idle', sec: [0.3, 0.3], state: 'idle'}],
      outfits: OUTFITS3, extraActions: {strip: STRIP}, outfit: from,
    });
    const drv = drive(fx.sim), a = fx.a;
    runUntil(drv, () => a.plan?.behavior === 'test' && a.state === 'dress', `${from} → clothed 开始穿衣`);

    // 烟的一步：开始时衣着就换好，没有 outfitAt（不在步骤中途换），挡 0.36 秒
    eq(a.outfit, 'clothed', `${from} → clothed：开烟的时候就换好了`);
    eq(a.step?.state, 'dress');
    eq(a.step?.action, 'idle');
    eq(a.step?.outfitAt, undefined);
    eq(a.step?.fx, 'puff');
    approx(a.step?.sec ?? NaN, PUFF_SEC, '烟的时长');
    approx(a.stateEnd - a.stateStart, PUFF_SEC, '这一步的时长');

    // 事件：一次换衣着 + 一团烟；没有 strip 片段
    const outs = outfitEvents(drv.log);
    eq(outs.length, 1);
    eq(outs[0].outfit, 'clothed');
    eq(drv.log.filter(x => x.e.type === 'fx' && x.e.fx === 'puff').length, 1, '烟');
    eq(drv.log.filter(x => x.e.type === 'state' && x.e.to === 'strip').length, 0, '穿回去不播 strip');

    // 烟散了接着走计划
    runUntil(drv, () => a.state === 'idle', `${from} → clothed 烟散了`, 1);
    eq(a.outfit, 'clothed');
    eq(outfitEvents(drv.log).length, 1, '烟只换一次');
  }
});

// （开源版省略）

test('走烟：角色包没有 strip、strip 没有 switchSec、outfits 里没有目标衣着', () => {
  const cases: {name: string; to: string; outfits: readonly string[]; extraActions?: FakePackOptions['extraActions']}[] = [
    {name: '角色包没有 strip 动作', to: 'nude', outfits: OUTFITS3},
    {name: 'strip 没有 switchSec', to: 'nude', outfits: OUTFITS3, extraActions: {strip: STRIP_NO_SWITCH}},
    // 这个模板 loadPack 会拒绝（behaviors.json 换成没有的衣着），这里直接测 outfitStep 的守卫
    {name: 'outfits 里没有 topless', to: 'topless', outfits: ['clothed', 'nude'], extraActions: {strip: STRIP}},
  ];
  for (const c of cases) {
    const fx = makeSolo({
      steps: [{do: 'outfit', to: c.to}, {do: 'play', action: 'idle', sec: [0.3, 0.3], state: 'idle'}],
      outfits: c.outfits, ...(c.extraActions ? {extraActions: c.extraActions} : {}),
    });
    const drv = drive(fx.sim), a = fx.a;
    runUntil(drv, () => a.plan?.behavior === 'test', `${c.name}：计划开始`);
    eq(a.state, 'strip', `${c.name}：state（去 nude / topless 都不是 dress）`);
    eq(a.action, 'idle', `${c.name}：不播 strip 片段`);
    eq(a.step?.action, 'idle', `${c.name}：步骤用 idle`);
    eq(a.step?.outfitAt, undefined, `${c.name}：没有中途换衣着`);
    eq(a.step?.fx, 'puff', `${c.name}：烟`);
    eq(a.outfit, c.to, `${c.name}：开始时就换成目标衣着`);
    approx(a.step?.sec ?? NaN, PUFF_SEC, `${c.name}：烟的时长`);
    eq(drv.log.filter(x => x.e.type === 'fx' && x.e.fx === 'puff').length, 1, `${c.name}：烟的事件`);
    eq(outfitEvents(drv.log).length, 1, `${c.name}：一次换衣着`);
    eq(outfitEvents(drv.log)[0].outfit, c.to);
  }
});

// ---------- 5. 脱到一半被拎起来 ----------

test('脱到一半（switchSec 之前）被拎起来：衣着保持 clothed，之后不会自己变成 nude', () => {
  const fx = makeSolo({steps: [{do: 'outfit', to: 'nude'}], outfits: OUTFITS3, extraActions: {strip: STRIP}});
  const drv = drive(fx.sim), a = fx.a;
  runUntil(drv, () => a.state === 'strip', '开始脱衣');
  drv.frames(30);                                   // 1 秒（离 switchSec 还有 2 秒）
  eq(a.outfit, 'clothed');

  fx.sim.grab('s', {x: a.x, y: a.y - 60});
  eq(a.state, 'dragged');
  eq(a.plan, null, '拎起来时计划中止');
  eq(a.step, null, '步骤清掉，outfitAt 不会再来');
  eq(a.outfit, 'clothed');

  // 拖着过 10 秒（远超 switchSec）：没有任何换衣着
  drv.frames(300);
  eq(a.state, 'dragged');
  eq(a.outfit, 'clothed');
  eq(outfitEvents(drv.log).length, 0);

  // 松手落地以后也不会补上：行为还在冷却，不会再开始脱
  fx.sim.release();
  runUntil(drv, () => a.state === 'idle', '落地、空下来', 10);
  drv.frames(150);                                  // 再站 5 秒
  eq(a.outfit, 'clothed');
  eq(a.plan, null);
  eq(outfitEvents(drv.log).length, 0, '拎起来以后一直没换衣着');
});

// ---------- 6. 全年龄 ----------

test('全年龄：r18 关着不播 strip（光着出场先穿衣）；切到全年龄时脱到一半的停住、已经光着的用烟穿回去', () => {
  // (1) r18 关着、出场就是 nude：先穿衣（system:dress，一团烟），不播 strip，之后不会自己脱
  const sfw = makeSolo({steps: [{do: 'play', action: 'idle', sec: [10, 10], state: 'idle'}],
    outfits: OUTFITS3, extraActions: {strip: STRIP}, r18: false, outfit: 'nude'});
  const drv1 = drive(sfw.sim), s = sfw.a;
  runUntil(drv1, () => s.state === 'dress', '全年龄模式下光着出场先穿衣');
  eq(s.plan?.behavior, 'system:dress');
  eq(s.outfit, 'clothed', '开烟的时候就穿好了');
  eq(s.step?.fx, 'puff');
  eq(s.step?.outfitAt, undefined);
  eq(drv1.log.filter(x => x.e.type === 'fx' && x.e.fx === 'puff').length, 1);
  eq(drv1.log.filter(x => x.e.type === 'state' && x.e.to === 'strip').length, 0, '全年龄不播 strip');
  runUntil(drv1, () => s.state === 'idle', '穿好以后空下来', 1);
  eq(s.outfit, 'clothed');
  drv1.frames(60);
  eq(s.outfit, 'clothed', '全年龄模式不会自己脱');
  eq(drv1.log.filter(x => x.e.type === 'state' && x.e.to === 'strip').length, 0);

  // (2) 脱到一半（switchSec 之前）切全年龄：计划中止，衣着不变，之后也不会补上
  const mid = makeSolo({steps: [{do: 'outfit', to: 'nude'}], outfits: OUTFITS3, extraActions: {strip: STRIP}});
  const drv2 = drive(mid.sim), m = mid.a;
  runUntil(drv2, () => m.state === 'strip', '开始脱衣');
  drv2.frames(30);                                  // 1 秒
  eq(m.outfit, 'clothed');
  const mark = drv2.log.length;
  mid.sim.setR18(false);
  eq(m.state, 'idle', '脱到一半切全年龄：计划中止');
  eq(m.plan, null);
  eq(m.outfit, 'clothed');
  drv2.frames(180);                                 // 再过 6 秒（远超 switchSec）
  eq(m.outfit, 'clothed');
  eq(outfitEvents(drv2.log).length, 0);
  eq(drv2.log.slice(mark).filter(x => x.e.type === 'state' && x.e.to === 'strip').length, 0, '切换以后不会再播 strip');

  // （开源版省略）
  const nude = makeSolo({steps: [{do: 'outfit', to: 'nude'}, {do: 'play', action: 'idle', sec: [10, 10], state: 'idle'}],
    outfits: OUTFITS3, extraActions: {strip: STRIP}, outfit: 'nude'});
  const drv3 = drive(nude.sim), n = nude.a;
  runUntil(drv3, () => n.plan?.behavior === 'test' && n.state === 'idle', '光着出场、空下来');
  eq(n.outfit, 'nude');
  nude.sim.setR18(false);
  eq(n.plan?.behavior, 'system:sfw');
  eq(n.state, 'dress', '穿回去是 dress');
  eq(n.outfit, 'clothed', '烟一点就穿好');
  eq(n.step?.fx, 'puff');
  eq(n.step?.outfitAt, undefined);
  eq(n.step?.action, 'idle', '不播 strip');
  runUntil(drv3, () => n.state === 'idle', '穿好以后空下来', 1);
  eq(n.outfit, 'clothed');
  eq(drv3.log.filter(x => x.e.type === 'state' && x.e.to === 'strip').length, 0);
});

// ---------- 7. 双人：走位后那一步是 strip ----------

test('双人：走位后那一步是 strip，两人都换成场景要的 nude 以后才开播', () => {
  const fx = makeDuo({outfits: OUTFITS3, extraActions: {strip: STRIP}});
  const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'invite', 'invite', 10);

  // （开源版省略）
  eq(a.state, 'walk');
  eq(b.state, 'walk');
  eq(a.outfit, 'clothed');
  eq(b.outfit, 'clothed');
  for (const who of [a, b]) {
    eq(who.plan?.steps.length, 2);
    eq(who.plan?.steps[0].state, 'strip');
    eq(who.plan?.steps[0].action, 'strip');
    assert.deepEqual(who.plan?.steps[0].outfitAt, {sec: SWITCH_SEC, to: 'nude'});
    eq(who.plan?.steps[1].state, 'sex');
  }

  // 走到位（场景第 0 帧的位置）以后开始脱：两人都还在 clothed
  runUntil(drv, () => a.state === 'strip' && b.state === 'strip', '两人开始脱衣', 10);
  approx(a.x, 628, 'a 走位到第 0 帧位置');
  approx(b.x, 628 + 48 * 3, 'b 走位到第 0 帧位置');
  eq(a.outfit, 'clothed');
  eq(b.outfit, 'clothed');
  eq(outfitEvents(drv.log).length, 0);

  // 3 秒以后两人都换成场景 manifest.outfit（nude），一人一次 outfit 事件
  runUntil(drv, () => a.outfit === 'nude' && b.outfit === 'nude', '两人换成 nude', 5);
  const outs = outfitEvents(drv.log);
  eq(outs.length, 2);
  assert.deepEqual(outs.map(x => x.id).sort(), ['a', 'b']);
  assert.deepEqual(outs.map(x => x.outfit), ['nude', 'nude']);

  // 双人照常开播：两人 state sex / phase start、衣着是场景要的 nude，接受方画场景
  drv.until(e => e.type === 'duo' && e.what === 'play', 'play', 10);
  eq(fx.sim.duos.length, 1);
  eq(fx.sim.duos[0].stage, 'play');
  eq(a.state, 'sex');
  eq(b.state, 'sex');
  eq(a.phase, 'start');
  eq(b.phase, 'start');
  eq(a.outfit, 'nude');
  eq(b.outfit, 'nude');
  eq(outfitEvents(drv.log).length, 2, '开播以后不再换衣着');
});

// ---------- 8. 计划里连着两个 outfit 步骤 ----------

test('计划里连着两个 outfit 步骤：第二步按计划里换过的衣着起算，一样的 outfit 步骤不出步骤', () => {
  const fx = makeSolo({
    steps: [
      {do: 'outfit', to: 'topless'},
      {do: 'outfit', to: 'nude'},
      {do: 'outfit', to: 'nude'},                    // 和上一步一样：不出步骤
      {do: 'play', action: 'idle', sec: [0.3, 0.3], state: 'idle'},
    ],
    outfits: OUTFITS3, extraActions: {strip: STRIP},
  });
  const drv = drive(fx.sim), a = fx.a;
  runUntil(drv, () => a.state === 'strip', '开始脱上衣');

  // 两步 strip + 一步 idle（重复的 nude 没有多出一步）：第一段 clothed → topless，第二段从 topless 到 nude
  eq(a.step?.action, 'strip');
  assert.deepEqual(a.step?.outfitAt, {sec: SWITCH_SEC, to: 'topless'});
  eq(a.plan?.steps.length, 2);
  eq(a.plan?.steps[0].state, 'strip');
  eq(a.plan?.steps[0].action, 'strip');
  assert.deepEqual(a.plan?.steps[0].outfitAt, {sec: SWITCH_SEC, to: 'nude'});
  eq(a.plan?.steps[1].state, 'idle');

  // 第一段：clothed → topless
  runUntil(drv, () => a.outfit === 'topless', '第一段脱到 topless', STRIP_SEC);
  eq(outfitEvents(drv.log).length, 1);
  eq(outfitEvents(drv.log)[0].outfit, 'topless');

  // 第二段开始：这时是 topless（按它起算，不是按出场的 clothed），3 秒后换成 nude
  runUntil(drv, () => a.step?.outfitAt?.to === 'nude', '第二段脱衣');
  eq(a.state, 'strip');
  eq(a.action, 'strip');
  eq(a.outfit, 'topless');
  runUntil(drv, () => a.outfit === 'nude', '第二段换成 nude', SWITCH_SEC);
  eq(a.outfit, 'nude');
  eq(outfitEvents(drv.log).length, 2);
  eq(outfitEvents(drv.log)[1].outfit, 'nude');

  // 第二段播完 → 计划的 idle；之后没有第三次换衣着
  runUntil(drv, () => a.state === 'idle', '第二段播完', STRIP_SEC);
  eq(a.outfit, 'nude');
  eq(a.plan?.behavior, 'test');
  eq(outfitEvents(drv.log).length, 2);
});

test('计划里先脱到 nude 再写回 topless：按计划里换过的衣着算，是穿回去的烟（不是倒着播 strip）', () => {
  const fx = makeSolo({
    steps: [{do: 'outfit', to: 'nude'}, {do: 'outfit', to: 'topless'}, {do: 'play', action: 'idle', sec: [0.3, 0.3], state: 'idle'}],
    outfits: OUTFITS3, extraActions: {strip: STRIP},
  });
  const drv = drive(fx.sim), a = fx.a;
  runUntil(drv, () => a.state === 'strip', '开始脱衣');
  assert.deepEqual(a.step?.outfitAt, {sec: SWITCH_SEC, to: 'nude'});
  runUntil(drv, () => a.outfit === 'nude', '脱到 nude', STRIP_SEC);

  // 第二步：nude → topless 是穿回去，走烟；如果按出场的 clothed 起算，这里会变成 strip（衣着 3 秒后才换）
  runUntil(drv, () => a.step?.state === 'strip' && a.step?.action === 'idle', '第二步（烟）开始', 3);
  eq(a.outfit, 'topless', '烟一点就把衣着换了');
  eq(a.step?.fx, 'puff');
  eq(a.step?.outfitAt, undefined);
  approx(a.step?.sec ?? NaN, PUFF_SEC, '烟的时长');
  eq(outfitEvents(drv.log).length, 2);
  eq(outfitEvents(drv.log)[1].outfit, 'topless');
  assert.ok(drv.log.some(x => x.e.type === 'state' && x.e.from === 'strip' && x.e.to === 'strip'),
    '第二步是从 strip 直接开始的（strip→strip），没有重新进别的状态');

  // 烟散了接着 idle；衣着停在 topless
  runUntil(drv, () => a.state === 'idle', '烟散了', 1);
  eq(a.outfit, 'topless');
  eq(a.plan?.behavior, 'test');
});

test('outfit 步骤和当前衣着一样时不出步骤', () => {
  const fx = makeSolo({
    steps: [{do: 'outfit', to: 'clothed'}, {do: 'play', action: 'idle', sec: [0.3, 0.3], state: 'idle'}],
    outfits: OUTFITS3, extraActions: {strip: STRIP},
  });
  const drv = drive(fx.sim), a = fx.a;
  runUntil(drv, () => a.plan?.behavior === 'test', '计划开始');
  eq(a.step?.state, 'idle', '第一个步骤就是 idle，没有烟也没有 strip');
  eq(a.plan?.steps.length, 0);
  eq(a.outfit, 'clothed');
  eq(drv.log.filter(x => x.e.type === 'fx').length, 0);
  eq(outfitEvents(drv.log).length, 0);
});

// ---------- 9. 回归 ----------

test('回归：strip 片段没标 r18 时，脱到一半切全年龄也立刻中止（state strip 本身就算正在脱衣）', () => {
  // 2026-10-21 报告：setR18 的 r18Now 原来只看片段自己标没标 r18；没标时脱到一半切全年龄会继续播到 nude。
  // 现在 r18Now 也算 a.state === 'strip'（片段或烟），计划立刻换成 system:sfw 的空计划。
  const fx = makeSolo({steps: [{do: 'outfit', to: 'nude'}], outfits: OUTFITS3, extraActions: {strip: {...STRIP, r18: false}}});
  const drv = drive(fx.sim), a = fx.a;
  runUntil(drv, () => a.state === 'strip', '开始脱衣');
  drv.frames(30);                                   // 1 秒（离 switchSec 还有 2 秒）
  eq(a.outfit, 'clothed');

  fx.sim.setR18(false);
  // 立刻中止：衣着还是 clothed，state 回到 idle，计划没了（system:sfw 的空计划）
  eq(a.state, 'idle');
  eq(a.plan, null);
  eq(a.outfit, 'clothed');
  // 中止事件在下一个 tick 出来：plan-end（sfw）+ state → idle（sfw）
  const evs = drv.frame();
  assert.ok(evs.some(x => x.e.type === 'plan-end' && x.e.reason === 'sfw'), 'plan-end / sfw');
  assert.ok(evs.some(x => x.e.type === 'state' && x.e.to === 'idle' && x.e.reason === 'sfw'), 'state → idle / sfw');

  // 之后不会补上 nude：outfitAt 随步骤清掉了，片段也被中止
  drv.frames(180);                                  // 再过 6 秒（远超 switchSec）
  eq(a.outfit, 'clothed');
  eq(outfitEvents(drv.log).length, 0, '没有 outfit: nude');
  eq(drv.log.filter(x => x.e.type === 'state' && x.e.to === 'strip').length, 1, '只有切换前那一次进 strip');
});
