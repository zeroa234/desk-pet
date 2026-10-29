// main/sim 双人（Duo）的单测：邀请 / 拒绝、完整流程、朝向、放不下、打断、超时、全年龄切换、
// 窗口后面做、刷新节奏、loop 段。规则见 docs/state-rules.md §2.4、docs/requirements.md R1.6 / R3.2，
// 实现在 src/main/sim.ts 的“双人（state-rules §2.4）”一节。
// 用假角色包 + 假场景（tests/helpers/fake-scene.ts），不读 packs/ 下的导出生成物；时间按 1/30 秒推进，rng 固定种子。
import test from 'node:test';
import assert from 'node:assert/strict';

import {setPlan} from '../src/behavior/index.ts';
import type {SimEvent} from '../src/main/sim.ts';
import {
  DT, FLOOR_Y, K, SCENE_FPS, currentDuoFrame, drive, duoAnchorX, makeDuo, sceneCastX, type DuoFixture, type LoggedEvent,
} from './helpers/fake-scene.ts';
import {makeWindow, rect} from './helpers/fake-desktop.ts';
import {approx, eq} from './helpers/assert.ts';

type DuoEvent = Extract<SimEvent, {type: 'duo'}>;

/** 这一帧里找 duo 事件（what 对得上）；没有就报错 */
function findDuo(evs: LoggedEvent[], what: string): LoggedEvent & {e: DuoEvent} {
  const found = evs.find(x => x.e.type === 'duo' && x.e.what === what);
  if (!found) throw new Error(`这一帧里没有 duo ${what}`);
  return found as LoggedEvent & {e: DuoEvent};
}

/** a 现在能选的行为 id（Brain.candidates；冷却中的行为不在里面） */
function aCandidates(fx: DuoFixture, now = fx.sim.now): string[] {
  const c = fx.sim.charOf('a')!;
  return c.brain.candidates(fx.sim.view(c), now, {r18: true}).map(x => x.def.id);
}

/** 跑到 'play'：返回驱动（事件都在 log 里） */
function runToPlay(fx: DuoFixture) {
  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'invite', 'invite');
  const playFrame = drv.until(e => e.type === 'duo' && e.what === 'play', 'play');
  return {drv, playFrame, play: findDuo(playFrame, 'play')};
}

// ---------- 1. 邀请被拒 ----------

test('邀请被拒：b 的 accept 不成立 → declined，b 计划不变，a 的 duo 行为按 declineCooldown 默认冷却 180 秒（不是行为的 cooldown 120）', () => {
  const fx = makeDuo({bDesire: 10});                        // b 的 accept 要 desire >= 40
  const b = fx.sim.charOf('b')!.actor!;
  // 给 b 一个 1000 秒的普通 idle 计划：邀请前后它的计划对象应当完全没被动过
  setPlan(b, fx.bPack.actorSpec(fx.tuning), {behavior: 'idle', steps: [{state: 'idle', sec: 1000}]}, fx.sim.ctx(), 'test');
  const bPlan = b.plan;
  eq(b.state, 'idle');

  const drv = drive(fx.sim);
  const firstFrame = drv.until(e => e.type === 'duo' && e.what === 'declined', 'declined', 5);
  const declined = findDuo(firstFrame, 'declined');

  eq(declined.id, 'a');                                    // 事件算在发起方头上
  eq(declined.e.partner, 'b');
  eq(drv.log.filter(x => x.e.type === 'duo' && x.e.what === 'invite').length, 0);
  eq(fx.sim.duos.length, 0);
  eq(b.plan, bPlan);                                       // 同一个计划对象，没被换掉
  eq(b.state, 'idle');
  eq(b.outfit, 'clothed');

  // a 的 duo 行为进了冷却：候选里没有；120 秒（行为自己的 cooldown）时还没有，180 秒（被拒的冷却）后又出现
  assert.ok(!aCandidates(fx).includes('sex'), `冷却中还能选 duo 行为：${aCandidates(fx).join(',')}`);
  assert.ok(!aCandidates(fx, fx.sim.now + 120).includes('sex'));
  assert.ok(aCandidates(fx, fx.sim.now + 180).includes('sex'));

  // 冷却期内不会再来问；冷却一到才再问一次（还是被拒）
  const secondFrame = drv.until(e => e.type === 'duo' && e.what === 'declined', '第二次 declined', 190);
  const again = findDuo(secondFrame, 'declined');
  eq(again.id, 'a');
  const gap = again.t - declined.t;
  assert.ok(gap >= 180 - 1e-9 && gap <= 181, `两次邀请间隔 ${gap.toFixed(3)} 秒，应该在 180 秒左右`);
  eq(drv.log.filter(x => x.e.type === 'duo' && x.e.what === 'declined').length, 2);
});

// ---------- 2. 完整流程 ----------

test('完整流程：走到第 0 帧位置、换 nude → play（只画接受方的场景）→ 阶段 → done 两边都算 end 效果', () => {
  const fx = makeDuo();
  const drv = drive(fx.sim);
  const inviteFrame = drv.until(e => e.type === 'duo' && e.what === 'invite', 'invite');
  const invite = findDuo(inviteFrame, 'invite');
  eq(invite.id, 'a');
  eq(invite.e.scene, 's1');
  eq(invite.e.partner, 'b');
  eq(invite.e.facing, 'right');                            // b 在 a 右边（900 > 500）
  eq(invite.e.anchor, 628);                                // (500 + 900) / 2 - (0 + 48 × 3) / 2

  const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
  const playFrame = drv.until(e => e.type === 'duo' && e.what === 'play', 'play');
  const play = findDuo(playFrame, 'play');

  // 两个人都走到场景第 0 帧各自的位置，转向，换上场景要求的 nude
  eq(a.state, 'sex');
  eq(b.state, 'sex');
  eq(a.phase, 'start');
  eq(b.phase, 'start');
  eq(a.outfit, 'nude');
  eq(b.outfit, 'nude');
  eq(a.plan?.behavior, 'duo:sex');
  eq(b.plan?.behavior, 'duo:sex');
  approx(a.x, 628, 'a 第 0 帧位置');
  approx(b.x, 628 + 48 * K, 'b 第 0 帧位置');
  eq(a.facing, 1);
  eq(b.facing, -1);
  assert.deepEqual(drv.log.filter(x => x.e.type === 'outfit').map(x => x.id).sort(), ['a', 'b']);

  // 播放总帧数 / 秒数：四段一共 40 帧，15 fps
  eq(play.e.frames, 40);
  eq(play.e.sec, 2.7);

  // 画：接受方画场景图集（场景的 sheetPath），给予方不画
  const d = fx.sim.duos[0];
  const items = fx.sim.draws(new Set()).front.get(1)!;
  eq(items.length, 1);
  eq(items[0].id, 'a');
  eq(items[0].sheet, fx.scene.sheetPath('v', 'right'));
  eq(items[0].frame, 0);
  eq(items[0].k, K);

  // 阶段按段变：start → loop（loopA / loopB 都是 loop，只发一次）→ climax
  const loopFrame = drv.until(e => e.type === 'duo' && e.what === 'phase', 'phase loop');
  eq(findDuo(loopFrame, 'phase').e.phase, 'loop');
  eq(a.phase, 'loop');
  eq(b.phase, 'loop');
  const climaxFrame = drv.until(e => e.type === 'duo' && e.what === 'phase', 'phase climax');
  eq(findDuo(climaxFrame, 'phase').e.phase, 'climax');
  eq(a.phase, 'climax');
  eq(b.phase, 'climax');

  // 播完：站回最后一帧的位置，两团烟分开
  const doneFrame = drv.until(e => e.type === 'duo' && e.what === 'done', 'done');
  findDuo(doneFrame, 'done');
  const last = d.program[d.program.length - 1];
  eq(last, 39);
  approx(a.x, 628 + sceneCastX(fx.scene, 'right', 'receiver', last), 'a 最后一帧位置');
  approx(b.x, 628 + sceneCastX(fx.scene, 'right', 'giver', last), 'b 最后一帧位置');
  eq(a.facing, fx.scene.sheet('v', 'right').cast.receiver.facing[last]);
  eq(b.facing, fx.scene.sheet('v', 'right').cast.giver.facing[last]);
  eq(a.plan?.behavior, 'duo-end');
  eq(b.plan?.behavior, 'duo-end');
  eq(a.outfit, 'nude');                                    // 收尾不换衣着（由穿衣规则以后处理）
  eq(fx.sim.duos.length, 0);

  // effects.end：邀请方走 Brain.ended，另一方按同一份 end 效果算（$partner 换成对方）
  const ac = fx.sim.charOf('a')!, bc = fx.sim.charOf('b')!;
  eq(ac.brain.stats.desire, 70);                           // 90 - 20
  eq(ac.brain.relations.b.affection, 60);                  // 50 + 10
  eq(ac.brain.stats.mood, 55);                             // start 效果 +5
  eq(bc.brain.stats.desire, 30);                           // 50 - 20
  eq(bc.brain.relations.a.affection, 60);                  // 50 + 10
});

// ---------- 3. 朝向 ----------

test('朝向：给予方在接受方右边选 right 图集，在左边选 left（锚点、站位、朝向都对）', () => {
  const cases = [
    {aX: 500, bX: 900, facing: 'right' as const, giverDx0: 48, aFacing: 1 as const, bFacing: -1 as const},
    {aX: 900, bX: 500, facing: 'left' as const, giverDx0: -48, aFacing: -1 as const, bFacing: 1 as const},
  ];
  for (const c of cases) {
    const fx = makeDuo({aAt: {x: c.aX, y: FLOOR_Y}, bAt: {x: c.bX, y: FLOOR_Y}});
    const drv = drive(fx.sim);
    const inviteFrame = drv.until(e => e.type === 'duo' && e.what === 'invite', `invite（${c.facing}）`);
    const invite = findDuo(inviteFrame, 'invite');
    eq(invite.e.facing, c.facing);
    eq(fx.sim.duos[0].facing, c.facing);
    // placeDuo：锚点让两人第 0 帧位置的中点落在两人现在的中点
    const want = (c.aX + c.bX) / 2 - (0 + c.giverDx0 * K) / 2;
    eq(invite.e.anchor, want);

    drv.until(e => e.type === 'duo' && e.what === 'play', `play（${c.facing}）`);
    const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
    approx(a.x, want, `${c.facing}：a 位置`);
    approx(b.x, want + c.giverDx0 * K, `${c.facing}：b 位置`);
    eq(a.facing, c.aFacing);
    eq(b.facing, c.bFacing);
    const items = fx.sim.draws(new Set()).front.get(1)!;
    eq(items[0]?.sheet, fx.scene.sheetPath('v', c.facing));
  }
});

// ---------- 4. 放不下 ----------

test('放不下：线段太短 → 不邀请，a 的 duo 行为进冷却', () => {
  // 窗口顶边 300 px 长（100..400）：场景 span × k 要 330 px，right / left 都放不下
  const fx = makeDuo({
    windows: [makeWindow(10, rect(100, 200, 400, 600))],
    aAt: {x: 150, y: 200}, bAt: {x: 350, y: 200},
  });
  const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
  // 还没落地时 when 条件已经成立、duo 行为可选（排除“根本没被选中”这种解释）
  assert.ok(aCandidates(fx).includes('sex'));

  const drv = drive(fx.sim);
  drv.frames(Math.round(3 / DT));
  eq(a.support?.key, 'win:10');
  eq(b.support?.key, 'win:10');
  eq(drv.log.filter(x => x.e.type === 'duo' && x.e.what === 'invite').length, 0);
  eq(drv.log.filter(x => x.e.type === 'duo' && x.e.what === 'declined').length, 0);
  eq(fx.sim.duos.length, 0);
  assert.ok(!a.plan?.behavior.startsWith('duo:'));
  // 试过一次、放不下 → 只记冷却，不进 duo
  assert.ok(!aCandidates(fx).includes('sex'), 'duo 行为应该进了冷却');
  // 冷却期内继续跑也不会邀请
  drv.frames(Math.round(10 / DT));
  eq(drv.log.filter(x => x.e.type === 'duo').length, 0);
});

// ---------- 5. 播到一半拎走一方 ----------

test('播到一半拎给予方：b 被拎、a 立刻停在当前帧收尾（broken by b）；拎接受方时 b 收尾', () => {
  // 第一轮：光标靠近给予方 → 拎 b
  {
    const fx = makeDuo();
    const {drv} = runToPlay(fx);
    const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
    const d = fx.sim.duos[0];
    drv.frames(15);                                        // 0.5 秒，播到第 7 帧左右
    const f = currentDuoFrame(fx.sim);
    const anchor = duoAnchorX(fx.sim);
    const rx = anchor + sceneCastX(fx.scene, d.facing, 'receiver', f);
    const gx = anchor + sceneCastX(fx.scene, d.facing, 'giver', f);
    assert.ok(gx - rx > 100, `给予方和接受方离得太近：${gx - rx}`);

    fx.sim.grab('a', {x: gx, y: a.y - 40});                // 舞台报的是接受方 id，按光标远近选人
    // 同一次 grab 调用里：b 被拎起，a 已经离开 duo、停在当前帧自己的位置上开始收尾
    eq(b.state, 'dragged');
    eq(b.support, null);
    eq(a.plan?.behavior, 'duo-broken');
    eq(a.phase, 'end');
    approx(a.x, rx, 'a 停在当前帧的位置');
    eq(fx.sim.duos.length, 0);

    const frame = drv.frame();
    const broken = findDuo(frame, 'broken');
    eq(broken.id, 'a');                                    // 事件记在发起方头上
    eq(broken.e.by, 'b');
    eq(broken.e.stage, 'play');
    eq(b.state, 'dragged');                                // 拎着不放，一直是 dragged

    // effects.interrupt：a（inviter 走 Brain.ended）和 b（partner 走 applyEffects）都算
    const ac = fx.sim.charOf('a')!, bc = fx.sim.charOf('b')!;
    eq(ac.brain.stats.mood, 45);                           // start +5，interrupt -10
    eq(ac.brain.relations.b.affection, 45);                // 50 - 5
    eq(bc.brain.stats.mood, 40);                           // 50 - 10
    eq(bc.brain.relations.a.affection, 45);                // 50 - 5
  }

  // 第二轮：光标靠近接受方 → 拎 a，b 收尾
  {
    const fx = makeDuo();
    const {drv} = runToPlay(fx);
    const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
    const d = fx.sim.duos[0];
    drv.frames(15);
    const f = currentDuoFrame(fx.sim);
    const anchor = duoAnchorX(fx.sim);
    const rx = anchor + sceneCastX(fx.scene, d.facing, 'receiver', f);

    fx.sim.grab('a', {x: rx, y: a.y - 40});
    eq(a.state, 'dragged');
    eq(b.plan?.behavior, 'duo-broken');
    eq(b.state, 'sex');
    eq(b.phase, 'end');
    eq(fx.sim.duos.length, 0);

    const frame = drv.frame();
    const broken = findDuo(frame, 'broken');
    eq(broken.e.by, 'a');
    eq(broken.e.stage, 'play');
    // b 站回当前帧自己的位置（锚点在 grab 时钉住，不随被挪到场景位置上的 a 漂）
    approx(b.x, anchor + sceneCastX(fx.scene, d.facing, 'giver', f), 'b 停在当前帧的位置');
  }
});

// 2026-10-20 pi 子代理写单测时发现：play 中拎接受方，另一方的收尾位置多了一次接受方的当前帧 dx（grab() 先把 a 挪到场景位置，
// breakDuo 再用 a.x - offset 算锚点）。主代理修了（Duo.pinned：grab 时先钉住锚点），上面第二轮的最后一条断言就是它。

// ---------- 6. 走过去的阶段被打断 ----------

test('走过去的阶段被打断（拎走 b）：a 站着、计划清掉，没有 end / interrupt 效果', () => {
  const fx = makeDuo();
  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'invite', 'invite');
  const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
  drv.frame();
  eq(b.state, 'walk');
  eq(a.plan?.behavior, 'duo:sex');

  const ac = fx.sim.charOf('a')!, bc = fx.sim.charOf('b')!;
  eq(ac.brain.stats.mood, 55);                             // 只有 effects.start（+5）

  fx.sim.grab('b', {x: b.x, y: b.y - 20});
  eq(b.state, 'dragged');
  const frame = drv.frame();
  const broken = findDuo(frame, 'broken');
  eq(broken.e.by, 'b');
  eq(broken.e.stage, 'approach');
  eq(fx.sim.duos.length, 0);
  eq(a.plan, null);                                        // 计划被清掉，站着
  eq(a.state, 'idle');
  // 没有 end / interrupt：心情、好感还是邀请时的值
  eq(ac.brain.stats.mood, 55);
  eq(ac.brain.relations.b.affection, 50);
  eq(bc.brain.stats.mood, 50);
  eq(bc.brain.relations.a.affection, 50);
  eq(drv.log.filter(x => x.e.type === 'duo' && x.e.what === 'phase').length, 0);
});

// ---------- 7. 走过去超时 ----------

test('走过去超时（60 秒）：dissolved approach-timeout，两人站着，不算 end / interrupt', () => {
  // b 每秒只走 0.01 个身高（1.2 px）：128 px 要走 128 / 1.2 ≈ 107 秒，60 秒内到不了
  const fx = makeDuo({bWalkHeightsPerSec: 0.01});
  const drv = drive(fx.sim);
  const inviteFrame = drv.until(e => e.type === 'duo' && e.what === 'invite', 'invite', 5);
  const invite = findDuo(inviteFrame, 'invite');
  const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
  const ac = fx.sim.charOf('a')!, bc = fx.sim.charOf('b')!;
  const moodA = ac.brain.stats.mood, moodB = bc.brain.stats.mood, relAB = ac.brain.relations.b.affection;

  // a 先走到、脱完，在场景里等；b 还在走
  drv.frames(Math.round(2 / DT));
  eq(a.state, 'sex');
  eq(b.state, 'walk');

  const frame = drv.until(e => e.type === 'duo' && e.what === 'dissolved', 'approach-timeout', 70);
  const dissolved = findDuo(frame, 'dissolved');
  eq(dissolved.e.reason, 'approach-timeout');
  eq(dissolved.e.stage, 'approach');
  const waited = dissolved.t - invite.t;
  assert.ok(waited >= 60 && waited < 61, `等了 ${waited.toFixed(2)} 秒，应该在 60 秒刚过`);
  eq(fx.sim.duos.length, 0);
  eq(a.plan, null);
  eq(b.plan, null);
  eq(a.state, 'idle');
  eq(b.state, 'idle');
  // 走过去的阶段超时不算被打断：没有 end / interrupt 效果
  eq(ac.brain.stats.mood, moodA);
  eq(ac.brain.relations.b.affection, relAB);
  eq(bc.brain.stats.mood, moodB);
  assert.ok(!drv.log.some(x => x.e.type === 'duo' && x.e.what === 'broken'));
});

// ---------- 8. 全年龄切换 ----------

test('全年龄切换：play 中 setR18(false) → dissolved sfw，两人拿到穿衣计划，outfit 变回 clothed', () => {
  const fx = makeDuo();
  const {drv} = runToPlay(fx);
  drv.frames(15);
  const a = fx.sim.charOf('a')!.actor!, b = fx.sim.charOf('b')!.actor!;
  eq(a.outfit, 'nude');
  eq(b.outfit, 'nude');

  fx.sim.setR18(false);
  eq(fx.sim.opts.r18, false);
  eq(fx.sim.duos.length, 0);
  // 系统级拆掉：两人立刻拿到穿衣计划（衣着当场切回 clothed，dress 片段用来放烟）
  eq(a.plan?.behavior, 'system:sfw');
  eq(b.plan?.behavior, 'system:sfw');
  eq(a.state, 'dress');
  eq(b.state, 'dress');
  eq(a.outfit, 'clothed');
  eq(b.outfit, 'clothed');

  const frame = drv.frame();
  const dissolved = findDuo(frame, 'dissolved');
  eq(dissolved.e.reason, 'sfw');
  eq(dissolved.e.stage, 'play');
  // dissolveDuo 按 play 中被打断算 interrupt 效果
  eq(fx.sim.charOf('a')!.brain.stats.mood, 45);            // start +5，interrupt -10
  eq(fx.sim.charOf('b')!.brain.stats.mood, 40);            // 50 - 10

  drv.frames(Math.round(1 / DT));
  eq(a.outfit, 'clothed');
  eq(b.outfit, 'clothed');
  eq(a.plan?.behavior, 'idle');
  eq(b.plan?.behavior, 'idle');
  // 画的是角色包的 clothed 图集，不再是场景图集
  const items = fx.sim.draws(new Set()).front.get(1)!;
  assert.deepEqual(items.map(x => x.id).sort(), ['a', 'b']);
  assert.ok(items.every(x => !x.sheet.includes('_scenes') && x.sheet.includes('/clothed/')));
});

// ---------- 9. 在窗口后面做 ----------

test('在窗口后面做：场景画在 W 那一层；W 关掉后两人都 discovered、duo 没了', () => {
  const W = makeWindow(10, rect(0, 0, 1920, 1080));
  const fx = makeDuo({windows: [W]});
  const b = fx.sim.charOf('b')!.actor!;
  // b 躲到 W 后面（手动给一个 hide 步骤；层 = behind:10）
  setPlan(b, fx.bPack.actorSpec(fx.tuning),
    {behavior: 'hide', steps: [{state: 'hide', action: 'idle', sec: 1000, layer: {kind: 'behind', hwnd: 10}}]}, fx.sim.ctx(), 'test');
  eq(b.state, 'hide');
  eq(b.layer.kind, 'behind');

  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'invite', 'invite');
  drv.until(e => e.type === 'duo' && e.what === 'play', 'play');
  const a = fx.sim.charOf('a')!.actor!;
  const d = fx.sim.duos[0];
  eq(d.layer.kind, 'behind');
  eq((d.layer as {hwnd: number}).hwnd, 10);
  eq(a.layer.kind, 'behind');
  eq(b.layer.kind, 'behind');

  // 画：场景在接受方身上、在 behind:10 里；给予方不画，front 上什么都没有
  const draws = fx.sim.draws(new Set());
  eq(draws.front.get(1)!.length, 0);
  const behind = draws.behind.get(10);
  assert.ok(behind, 'behind:10 里没有东西');
  eq(behind.items.length, 1);
  eq(behind.items[0].id, 'a');
  eq(behind.items[0].sheet, fx.scene.sheetPath('v', d.facing));

  // 窗口还挡着的时候 checkHidden 不拆（双人按整个场景范围算遮挡）
  fx.sim.checkHidden();
  const still = drv.frame();
  eq(fx.sim.duos.length, 1);
  eq(still.filter(x => x.e.type === 'duo' || x.e.type === 'discovered').length, 0);

  // 关掉 W（新快照里没有窗口）→ setDesktop 里调 checkHidden：场景范围全露出来 → 两人都被发现
  fx.sim.setDesktop({displays: [fx.display], windows: []});
  eq(fx.sim.duos.length, 0);
  const frame = drv.frame();
  const dissolved = findDuo(frame, 'dissolved');
  eq(dissolved.e.reason, 'hide-window-gone');
  const discovered = frame.filter(x => x.e.type === 'discovered')
    .map(x => ({id: x.id, e: x.e as Extract<SimEvent, {type: 'discovered'}>}));
  assert.deepEqual(discovered.map(x => x.id).sort(), ['a', 'b']);
  for (const x of discovered) {
    eq(x.e.hwnd, 10);
    eq(x.e.cover, 0);                                      // 窗口没了，遮挡比例 0
  }
  eq(a.plan?.behavior, 'reaction:discovered');
  eq(b.plan?.behavior, 'reaction:discovered');
  eq(a.layer.kind, 'front');
  eq(b.layer.kind, 'front');
  // dissolveDuo 的 interrupt（两人）+ b 的 discovered 反应效果
  eq(fx.sim.charOf('a')!.brain.stats.mood, 45);            // start +5，interrupt -10
  eq(fx.sim.charOf('b')!.brain.stats.mood, 37);            // interrupt -10，reaction -3
  eq(fx.sim.charOf('a')!.brain.relations.b.affection, 45);
  eq(fx.sim.charOf('b')!.brain.relations.a.affection, 45);
});

// ---------- 10. 刷新节奏 ----------

test('secondsToNextChange：play 中返回值不超过场景一帧（1 / 15 秒）', () => {
  const fx = makeDuo();
  const {drv} = runToPlay(fx);
  for (let i = 0; i < 20; i++) {
    drv.frame();
    const s = fx.sim.secondsToNextChange(fx.sim.now);
    assert.ok(s > 0, `第 ${i} 帧：${s} 应该大于 0`);
    assert.ok(s <= 1 / SCENE_FPS + 1e-9, `第 ${i} 帧：${s} 超过 1 / ${SCENE_FPS}`);
  }
});

// ---------- 11. loop 段 ----------

test('loopable 段按 loops 多绕圈，loopable = false 的段不重复', () => {
  const fx = makeDuo({loops: [2, 2]});
  const {drv, playFrame, play} = runToPlay(fx);
  // 40 帧正片 + loopA 多绕 2 圈（每圈 10 帧）
  eq(play.e.frames, 60);
  eq(play.e.sec, 4);
  const d = fx.sim.duos[0];
  const range = (a: number, b: number) => Array.from({length: b - a}, (_, i) => a + i);
  const expected = [...range(0, 10), ...range(10, 20), ...range(10, 20), ...range(10, 20), ...range(20, 30), ...range(30, 40)];
  assert.deepEqual(d.program, expected);
  eq(d.program.filter(f => f === 15).length, 3);           // loopA 播了 1 + 2 遍
  eq(d.program.filter(f => f === 25).length, 1);           // loopB loopable = false，只播 1 遍
  // 总时长也按 60 帧算
  const doneFrame = drv.until(e => e.type === 'duo' && e.what === 'done', 'done', 10);
  const elapsed = (doneFrame.find(x => x.e.type === 'duo' && x.e.what === 'done')!).t - play.t;
  assert.ok(elapsed >= 4 - 1e-9 && elapsed <= 4 + DT + 1e-9, `播了 ${elapsed.toFixed(3)} 秒，应该是 4 秒左右`);
});
