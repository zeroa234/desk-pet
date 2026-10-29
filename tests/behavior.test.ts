// behavior/：主状态机 + 身体物理的单测。规则见 docs/state-rules.md §2.1、§2.3、§3、§7 和 src/behavior/actor.ts 开头。
// 物理参数用 DEFAULT_TUNING（scale = 1 的显示器上 1 DIP = 1 物理像素）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_FALLBACK, createActor, currentFrame, dragActor, grabActor, releaseActor, resolveAction, stepActor,
} from '../src/behavior/index.ts';
import type {Actor, ActorEvent, ActorSpec, Tuning, WorldContext} from '../src/behavior/index.ts';
import {makeDisplay, makeSpec, makeWindow, makeWorld, rect} from './helpers/fake-desktop.ts';
import {eq} from './helpers/assert.ts';

// A：1920×1080、100% 缩放、任务栏 40 px → 地面 y = 1040，角色高 120 物理像素
const A = makeDisplay(1, rect(0, 0, 1920, 1080));
// C：和 A 之间留一条缝（1920..4000 是桌面外的空白）
const C = makeDisplay(3, rect(4000, 0, 5920, 1080));
const FLOOR_Y = 1040;
const HEIGHT = 120;
const DT = 1 / 60;

function step(a: Actor, spec: ActorSpec, ctx: WorldContext, dt = DT): ActorEvent[] {
  ctx.now += dt;
  return stepActor(a, spec, dt, ctx);
}

interface StepUntilOptions {
  maxSteps?: number;
  dt?: number;
  onStep?: (ev: ActorEvent[]) => void;
  what?: string;
}

function stepUntil(a: Actor, spec: ActorSpec, ctx: WorldContext, pred: (a: Actor) => boolean, opts: StepUntilOptions = {}): void {
  const maxSteps = opts.maxSteps ?? 10000;
  for (let i = 0; i < maxSteps; i++) {
    if (pred(a)) return;
    const ev = step(a, spec, ctx, opts.dt ?? DT);
    if (opts.onStep) opts.onStep(ev);
  }
  throw new Error(`跑了 ${maxSteps} 步还没到${opts.what ?? '预期状态'}（现在是 ${a.state}）`);
}

/** 在窗口上站稳（createActor 直接放在窗口顶边上，第一步就落地，再走到 idle） */
function standOnWindow(winRect: ReturnType<typeof rect>, opts: {seed?: number; tuning?: Partial<Tuning>} = {}) {
  const world = makeWorld({displays: [A], windows: [makeWindow(10, winRect)], seed: opts.seed ?? 5});
  const spec = makeSpec({tuning: {idleSec: [120, 120], landSec: 0.02, ...opts.tuning}});
  const a = createActor(spec, {x: 300, y: winRect.top}, world.ctx);
  stepUntil(a, spec, world.ctx, x => x.state === 'idle', {what: '落地后 idle'});
  return {world, spec, a};
}

// ---------- 3. 下落 → 落地 ----------

test('fall：从空中落到下面最近的地面，y 恰好等于 support.y，先 land 再 idle', () => {
  const world = makeWorld({displays: [A], seed: 7});
  const spec = makeSpec({tuning: {idleSec: [120, 120], hardLandingSpeed: 900}})   // 测软着陆路径，不测阈值;
  const a = createActor(spec, {x: 500, y: 200}, world.ctx);
  eq(a.state, 'fall');
  eq(a.support, null);

  const events: ActorEvent[] = [];
  const states: string[] = [a.state];
  let lowest = -Infinity;
  for (let i = 0; i < 600 && a.state !== 'idle'; i++) {
    events.push(...step(a, spec, world.ctx));
    lowest = Math.max(lowest, a.y);
    if (states[states.length - 1] !== a.state) states.push(a.state);
  }

  eq(a.state, 'idle');
  eq(a.y, FLOOR_Y);
  eq(a.support?.key, 'floor:1');
  eq(a.x, 500);                       // 没有横向速度
  eq(lowest, FLOOR_Y);                // 没穿过地面
  assert.deepEqual(states.slice(0, 3), ['fall', 'land', 'idle']);
  const landed = events.find(e => e.type === 'landed');
  assert.ok(landed && landed.type === 'landed');
  eq(landed.supportKey, 'floor:1');
  assert.ok(landed.impactDip > 0 && landed.impactDip < spec.tuning.hardLandingSpeed);
});

// ---------- 4. 支撑没了 ----------

test('窗口关了：一次 stepActor 里进入 fall（state-rules §7 第 13 条）', () => {
  const {world, spec, a} = standOnWindow(rect(100, 200, 800, 600));
  eq(a.support?.key, 'win:10');
  const epochBefore = a.epoch;

  world.setWindows([]);                         // 新快照里窗口没了
  const ev = step(a, spec, world.ctx);

  eq(a.state, 'fall');
  eq(a.support, null);
  const st = ev.find(e => e.type === 'state');
  assert.ok(st && st.type === 'state');
  eq(st.to, 'fall');
  eq(st.reason, 'support-gone');
  eq(a.epoch, epochBefore + 1);
});

// ---------- 5. 窗口跟随 ----------

test('跟随窗口：小幅挪动后角色跟着走，x 变化 = dx、y = 新顶边，事件里有 followed', () => {
  const {world, spec, a} = standOnWindow(rect(100, 200, 800, 600));
  const epochBefore = a.epoch;

  world.setWindows([makeWindow(10, rect(140, 210, 840, 610))]);   // dx = +40, dy = +10
  const ev = step(a, spec, world.ctx);

  const f = ev.find(e => e.type === 'followed');
  assert.ok(f && f.type === 'followed');
  eq(f.supportKey, 'win:10');
  assert.deepEqual([f.dx, f.dy], [40, 10]);
  eq(a.state, 'idle');
  eq(a.x, 340);                       // 300 + dx
  eq(a.y, 210);
  eq(a.support?.y, 210);
  eq(a.epoch, epochBefore);           // 跟着走不算换状态
  assert.ok(!ev.some(e => e.type === 'state'));
});

test('跟随窗口：缩放时按宽度比例挪（Shimeji 的做法，2026-10-21）——在窗口里的相对位置不变，走路的目标点也跟着换算', () => {
  // 站在 300：离左边 200 / 宽 700。往右拉宽到 840（左边不动）→ 300 → 100 + 200 × 840 / 700 = 340
  const {world, spec, a} = standOnWindow(rect(100, 200, 800, 600));
  world.setWindows([makeWindow(10, rect(100, 200, 940, 600))]);
  const ev = step(a, spec, world.ctx);
  const f = ev.find(e => e.type === 'followed');
  assert.ok(f && f.type === 'followed');
  assert.deepEqual([f.dx, f.dy], [40, 0]);
  eq(a.x, 340);
  eq(a.state, 'idle');
  // 从右边往回缩：以前左边不动她就不动，窗口缩过她的位置时会掉下去；现在跟着往左挪
  world.setWindows([makeWindow(10, rect(100, 200, 380, 600))]);   // 宽 840 → 280：340 → 100 + 240 × 280 / 840 = 180
  step(a, spec, world.ctx);
  // 一下要挪 160 ≥ followMaxDx 80：不跟了，留在 340（Shimeji 同）；新窗口顶边是 [100, 380)，脚下还是它，接着站、不掉
  eq(a.x, 340);
  eq(a.state, 'idle');
  eq(a.support?.key, 'win:10');
  // 再缩到 220（宽 280 → 120）：按比例要挪到 100 + 240 × 120 / 280 ≈ 202.9（挪 137 ≥ 80）不跟，340 已经不在 [100, 220) 上 → 掉下来
  world.setWindows([makeWindow(10, rect(100, 200, 220, 600))]);
  const ev2 = step(a, spec, world.ctx);
  eq(a.state, 'fall');
  const st = ev2.find(e => e.type === 'state');
  eq(st?.type === 'state' && st.reason, 'moved-too-far');
});

test('跟随窗口：横着一下挪太远、但她脚下还是这个窗口 → 留在原地接着站（以前会掉一下马上落地）', () => {
  const {world, spec, a} = standOnWindow(rect(100, 200, 800, 600));
  world.setWindows([makeWindow(10, rect(200, 200, 900, 600))]);   // dx = +100 ≥ 80，300 还在 [200, 900) 里
  const ev = step(a, spec, world.ctx);
  eq(a.x, 300);
  eq(a.state, 'idle');
  assert.ok(!ev.some(e => e.type === 'state'));
});

test('跟随窗口：缩放时她被挪得少（离不动的那条边近）就跟着，走路的目标点也按比例换算', () => {
  const {world, spec, a} = standOnWindow(rect(100, 200, 800, 600));
  a.targetX = 700;
  // 从右边缩到 600（宽 700 → 500）：300 → 100 + 200 × 5 / 7 ≈ 242.9（挪 57 < 80），目标 700 → 100 + 600 × 5 / 7 ≈ 528.6
  world.setWindows([makeWindow(10, rect(100, 200, 600, 600))]);
  step(a, spec, world.ctx);
  assert.ok(Math.abs(a.x - (100 + 200 * 5 / 7)) < 1e-6, `x = ${a.x}`);
  assert.ok(a.targetX !== null && Math.abs(a.targetX - (100 + 600 * 5 / 7)) < 1e-6, `targetX = ${a.targetX}`);
  eq(a.support?.key, 'win:10');
});

test('跟随窗口：横向挪太远（超过 followMaxDx × scale）就掉下来', () => {
  const {world, spec, a} = standOnWindow(rect(100, 200, 800, 600));
  // 往右挪 400（≥ followMaxDx = 80），角色已经不在新窗口顶边上方了
  world.setWindows([makeWindow(10, rect(500, 200, 1200, 600))]);
  const ev = step(a, spec, world.ctx);
  eq(a.state, 'fall');
  eq(a.support, null);
  const st = ev.find(e => e.type === 'state');
  assert.ok(st && st.type === 'state');
  eq(st.to, 'fall');
  eq(st.reason, 'moved-too-far');

  // 下面没有窗口顶边，落到地面
  stepUntil(a, spec, world.ctx, x => x.state === 'land' || x.state === 'idle', {what: '落地'});
  eq(a.y, FLOOR_Y);
  eq(a.support?.key, 'floor:1');
});

test('跟随窗口：往下挪超过 followMaxDown 就掉下来', () => {
  const {world, spec, a} = standOnWindow(rect(100, 200, 800, 600));
  world.setWindows([makeWindow(10, rect(100, 220, 800, 620))]);   // dy = +20 = 阈值
  const ev = step(a, spec, world.ctx);
  eq(a.state, 'fall');
  assert.ok(ev.some(e => e.type === 'state' && e.reason === 'moved-too-far'));
});

test('跟随窗口：往上挪太多（dy < -followMaxUp）也掉下来', () => {
  const {world, spec, a} = standOnWindow(rect(100, 300, 800, 700));
  world.setWindows([makeWindow(10, rect(100, 210, 800, 610))]);   // dy = -90
  step(a, spec, world.ctx);
  eq(a.state, 'fall');
});

test('跟随窗口：脚下那块被新冒出来的更高窗口盖住 → fall', () => {
  const {world, spec, a} = standOnWindow(rect(100, 200, 800, 600));
  eq(a.x, 300);
  const cover = makeWindow(11, rect(250, 150, 350, 500));         // 盖住 x = 300 那一段
  world.setWindows([cover, makeWindow(10, rect(100, 200, 800, 600))]);
  const ev = step(a, spec, world.ctx);

  eq(a.state, 'fall');
  eq(a.support, null);
  assert.ok(ev.some(e => e.type === 'state' && e.reason === 'support-covered'));
  // 新快照里 win:10 确实被切成了两段，300 不在任何一段里
  const segs = world.supports().filter(s => s.key === 'win:10');
  assert.deepEqual(segs.map(s => [s.x0, s.x1]), [[100, 250], [350, 800]]);
});

// ---------- 6. walk ----------

test('walk：在地面上走几千步，脚底点一直不出地面段（留 halfWidthRatio × 身高）', () => {
  const world = makeWorld({displays: [A], seed: 12345});
  const spec = makeSpec();                      // 默认权重 / 默认 idleSec 3–20
  const a = createActor(spec, {x: 960, y: FLOOR_Y}, world.ctx);
  stepUntil(a, spec, world.ctx, x => x.state === 'idle', {what: '落地后 idle'});

  const floor = world.supports().find(s => s.key === 'floor:1')!;
  const margin = spec.halfWidthRatio * HEIGHT;  // 0.25 × 120 = 30
  let walked = 0;
  for (let i = 0; i < 4000; i++) {
    step(a, spec, world.ctx, 1 / 30);
    assert.ok(a.state !== 'fall' && a.state !== 'downed', `第 ${i} 步掉下去了（${a.state}）`);
    eq(a.support?.key, 'floor:1');
    eq(a.y, FLOOR_Y);
    if (a.state === 'walk') {
      walked++;
      assert.ok(a.x >= floor.x0 + margin - 1e-9, `第 ${i} 步走出左端：x = ${a.x}`);
      assert.ok(a.x <= floor.x1 - margin + 1e-9, `第 ${i} 步走出右端：x = ${a.x}`);
    }
  }
  assert.ok(walked > 100, `只走了 ${walked} 步`);
});

test('walk：窗口段上故意走出端点 → fall → 落到下面的地面', () => {
  const winRect = rect(200, 400, 1000, 900);
  const world = makeWorld({displays: [A], windows: [makeWindow(10, winRect)], seed: 2});
  const spec = makeSpec({tuning: {hardLandingSpeed: 900,
    walkOffEdgeChance: 1,                       // 一定往外走
    weights: {walk: 1, sit: 0, idle: 0},
    idleSec: [0, 0],
    landSec: 0.02,
  }});
  const a = createActor(spec, {x: 600, y: winRect.top}, world.ctx);

  let fell = false;
  for (let i = 0; i < 2000; i++) {
    const ev = step(a, spec, world.ctx);
    if (!fell && a.state === 'fall') {
      fell = true;
      const st = ev.find(e => e.type === 'state');
      assert.ok(st && st.type === 'state');
      eq(st.reason, 'walked-off');
    }
    if (fell && a.state !== 'fall') break;
  }

  assert.ok(fell, '没有走出端点');
  eq(a.state, 'land');
  eq(a.y, FLOOR_Y);
  eq(a.support?.key, 'floor:1');
  assert.ok(a.x < winRect.left || a.x > winRect.right, `落点 x = ${a.x} 还在窗口范围内`);
});

// ---------- 7. 拖拽 ----------

/** 站在地面上的 idle 角色（idle 时长调长，避免测试中间自己走开） */
function actorOnFloor(seed: number, tuning: Partial<Tuning> = {}) {
  const world = makeWorld({displays: [A], seed});
  const spec = makeSpec({tuning: {idleSec: [120, 120], ...tuning}});
  const a = createActor(spec, {x: 500, y: FLOOR_Y}, world.ctx);
  stepUntil(a, spec, world.ctx, x => x.state === 'idle', {what: '落地后 idle'});
  return {world, spec, a};
}

test('拖拽：grab 进 dragged、epoch +1；匀速拖动后 release，初速度 ≈ 光标速度', () => {
  const {world, spec, a} = actorOnFloor(9);
  const epoch0 = a.epoch;

  grabActor(a, spec, {x: 500, y: 900}, world.ctx);
  eq(a.state, 'dragged');
  eq(a.epoch, epoch0 + 1);
  eq(a.support, null);
  eq(a.x, 500);
  eq(a.y, FLOOR_Y);                   // 脚底点 = 光标 + grab 偏移（这里偏移 140）

  // 匀速往右 6 px / (1/60 s) = 360 px/s
  let cursor = {x: 500, y: 900};
  for (let i = 0; i < 5; i++) {
    world.advance(DT);
    cursor = {x: cursor.x + 6, y: cursor.y};
    dragActor(a, cursor, world.ctx);
    eq(a.state, 'dragged');
    eq(a.x, cursor.x);
    eq(a.y, FLOOR_Y);
  }
  eq(a.x, 530);

  const ev = releaseActor(a, spec, world.ctx);
  eq(a.state, 'fall');
  assert.ok(ev.some(e => e.type === 'state' && e.to === 'fall' && e.reason === 'release'));
  assert.ok(Math.abs(a.vx - 360) < 1e-6, `vx = ${a.vx}`);
  assert.ok(Math.abs(a.vy) < 1e-9, `vy = ${a.vy}`);

  // 之后能落地
  stepUntil(a, spec, world.ctx, x => x.state === 'idle', {what: '抛出后落地'});
  eq(a.y, FLOOR_Y);
  eq(a.support?.key, 'floor:1');
});

test('拖拽：抛出速度超过 maxThrowSpeed × scale 时被限幅', () => {
  const {world, spec, a} = actorOnFloor(10);
  grabActor(a, spec, {x: 500, y: 900}, world.ctx);
  let cursor = {x: 500, y: 900};
  for (let i = 0; i < 5; i++) {
    world.advance(DT);
    cursor = {x: cursor.x + 100, y: cursor.y};   // 6000 px/s，远超 2500
    dragActor(a, cursor, world.ctx);
  }
  releaseActor(a, spec, world.ctx);
  const speed = Math.hypot(a.vx, a.vy);
  assert.ok(Math.abs(speed - spec.tuning.maxThrowSpeed) < 1e-6, `速度 = ${speed}`);
  assert.ok(a.vx > 0, '方向应该还是向右');
});

test('拖拽：fall / sit / walk 状态都能被抓起来，epoch 每次加 1', () => {
  // fall
  const w1 = makeWorld({displays: [A], seed: 1});
  const spec1 = makeSpec();
  const falling = createActor(spec1, {x: 500, y: 300}, w1.ctx);
  eq(falling.state, 'fall');
  const e1 = falling.epoch;
  grabActor(falling, spec1, {x: 500, y: 300}, w1.ctx);
  eq(falling.state, 'dragged');
  eq(falling.epoch, e1 + 1);

  // sit：只给 sit 权重，落地后立刻选 sit
  const w2 = makeWorld({displays: [A], seed: 2});
  const spec2 = makeSpec({tuning: {idleSec: [0, 0], landSec: 0.01, sitSec: [60, 60], weights: {walk: 0, sit: 1, idle: 0}}});
  const sitting = createActor(spec2, {x: 500, y: FLOOR_Y}, w2.ctx);
  stepUntil(sitting, spec2, w2.ctx, x => x.state === 'sit', {what: 'sit'});
  const e2 = sitting.epoch;
  grabActor(sitting, spec2, {x: 500, y: FLOOR_Y}, w2.ctx);
  eq(sitting.state, 'dragged');
  eq(sitting.epoch, e2 + 1);

  // walk：只给 walk 权重
  const w3 = makeWorld({displays: [A], seed: 3});
  const spec3 = makeSpec({tuning: {idleSec: [0, 0], landSec: 0.01, weights: {walk: 1, sit: 0, idle: 0}}});
  const walking = createActor(spec3, {x: 500, y: FLOOR_Y}, w3.ctx);
  stepUntil(walking, spec3, w3.ctx, x => x.state === 'walk', {what: 'walk'});
  const e3 = walking.epoch;
  grabActor(walking, spec3, {x: walking.x, y: walking.y}, w3.ctx);
  eq(walking.state, 'dragged');
  eq(walking.epoch, e3 + 1);
  eq(walking.targetX, null);          // 换状态时清掉走路目标
});

// ---------- 8. 落地：downed / land / impactDip ----------

test('高速落地 → downed，播完 downedSec 回 idle', () => {
  const {world, spec, a} = actorOnFloor(11);
  grabActor(a, spec, {x: 500, y: 1000}, world.ctx);   // 偏移 40
  let cursor = {x: 500, y: 1000};
  // 先快速往上拎（这段不计入抛出速度）
  for (let i = 0; i < 10; i++) {
    world.advance(DT);
    cursor = {x: cursor.x, y: cursor.y - 60};
    dragActor(a, cursor, world.ctx);
  }
  eq(a.y, 440);                             // 抬到光标 + 偏移 40
  // 再往下抛 40 px / 帧 = 2400 px/s（低于 maxThrowSpeed 2500）
  for (let i = 0; i < 6; i++) {
    world.advance(DT);
    cursor = {x: cursor.x, y: cursor.y + 40};
    dragActor(a, cursor, world.ctx);
  }
  releaseActor(a, spec, world.ctx);
  assert.ok(a.vy > spec.tuning.hardLandingSpeed, `抛出竖直速度 ${a.vy}`);

  const events: ActorEvent[] = [];
  stepUntil(a, spec, world.ctx, x => x.state !== 'fall', {what: '落地', onStep: ev => events.push(...ev)});
  eq(a.state, 'downed');
  eq(a.y, FLOOR_Y);
  const landed = events.find(e => e.type === 'landed');
  assert.ok(landed && landed.type === 'landed');
  assert.ok(landed.impactDip > spec.tuning.hardLandingSpeed, `impactDip = ${landed.impactDip}`);

  stepUntil(a, spec, world.ctx, x => x.state === 'idle', {what: 'downed 播完回 idle', maxSteps: 500});
  eq(a.y, FLOOR_Y);
});

test('低速落地 → land → idle；impactDip 大于 0、随落差变大、不超过自由落体速度', () => {
  function dropDip(fromY: number): number {
    const world = makeWorld({displays: [A], seed: 3});
    const spec = makeSpec({tuning: {idleSec: [120, 120], hardLandingSpeed: 900}});
    const a = createActor(spec, {x: 500, y: fromY}, world.ctx);
    let dip = -1;
    stepUntil(a, spec, world.ctx, x => x.state !== 'fall', {
      what: '落地',
      onStep: ev => {
        const l = ev.find(e => e.type === 'landed');
        if (l && l.type === 'landed') dip = l.impactDip;
      },
    });
    eq(a.state, 'land');
    return dip;
  }

  const short = dropDip(FLOOR_Y - 20);
  const long = dropDip(FLOOR_Y - 400);
  assert.ok(short > 0, `impactDip = ${short}`);
  assert.ok(long > short, `${long} 应该大于 ${short}`);
  // 空气阻力让落地速度低于同高度的自由落体 sqrt(2 g h)
  assert.ok(short < Math.sqrt(2 * 1250 * 20) + 1e-9, `impactDip = ${short}`);
  assert.ok(long < Math.sqrt(2 * 1250 * 400));
  assert.ok(long < makeSpec({tuning: {hardLandingSpeed: 900}}).tuning.hardLandingSpeed);

  // land 播完（landSec = 0.35）回 idle
  const world = makeWorld({displays: [A], seed: 3});
  const spec = makeSpec({tuning: {idleSec: [120, 120], hardLandingSpeed: 900}});
  const a = createActor(spec, {x: 500, y: 200}, world.ctx);
  stepUntil(a, spec, world.ctx, x => x.state === 'land', {what: 'land'});
  const t0 = world.ctx.now;
  stepUntil(a, spec, world.ctx, x => x.state === 'idle', {what: 'land 播完'});
  assert.ok(world.ctx.now - t0 >= spec.tuning.landSec - 1e-9);
});

test('落地：DEFAULT_TUNING 下约 2 个身高以上自由落体会摔倒（阶段 1 留下的 todo，2026-10-21 补）', () => {
  // 阈值 hardLandingSpeed 420 DIP/s（原来 900，终端速度 gravity / dragY ≈ 475 永远到不了，阶段 1 单测发现）。物理按 DIP 算、不按身高：
  // 解析解 v = vt(1 − e^(−kt)) 到 420 要下落约 229 DIP，默认显示高度 120 逻辑像素时约 1.9 个身高。这里用真的步进（主循环下落时
  // 30 Hz，单测平常 60 Hz，两种都量）二分出摔倒的起始落差，核对“约 2 个身高”，再各从 1.5 个、3 个身高落一次看落地状态。
  const H = 120;   // 这块显示器 100% 缩放，身高 120 物理像素 = 120 DIP
  const dropState = (fall: number, dt: number): string => {
    const world = makeWorld({displays: [A], seed: 3});
    const spec = makeSpec({tuning: {idleSec: [120, 120]}});
    const a = createActor(spec, {x: 500, y: FLOOR_Y - fall}, world.ctx);
    stepUntil(a, spec, world.ctx, x => x.state !== 'fall', {what: '落地', dt});
    return a.state;
  };
  for (const dt of [1 / 60, 1 / 30]) {
    eq(dropState(1.5 * H, dt), 'land', `1.5 个身高（dt ${dt.toFixed(3)}）只播 land`);
    eq(dropState(3 * H, dt), 'downed', `3 个身高（dt ${dt.toFixed(3)}）摔倒`);
    let lo = 1.5 * H, hi = 3 * H;   // lo 落地、hi 摔倒
    while (hi - lo > 1) { const mid = (lo + hi) / 2; if (dropState(mid, dt) === 'downed') hi = mid; else lo = mid; }
    assert.ok(hi / H > 1.7 && hi / H < 2.2, `dt ${dt.toFixed(3)}：从 ${hi.toFixed(0)} DIP（${(hi / H).toFixed(2)} 个身高）起摔倒，应该在 2 个身高左右`);
  }
});

// ---------- 9. 大 dt ----------

test('大 dt（5 秒）不会穿过支撑面，落在第一段上', () => {
  const win = makeWindow(10, rect(0, 300, 1920, 900));
  const world = makeWorld({displays: [A], windows: [win], seed: 1});
  const spec = makeSpec();
  const a = createActor(spec, {x: 500, y: 100}, world.ctx);
  for (let i = 0; i < 100 && a.state === 'fall'; i++) {
    world.advance(5);
    stepActor(a, spec, 5, world.ctx);
    assert.ok(a.y <= 300, `第 ${i} 步穿到窗口顶边下面了：y = ${a.y}`);
  }
  eq(a.state, 'land');
  eq(a.y, 300);
  eq(a.support?.key, 'win:10');
});

// ---------- 10. 边界 ----------

test('fall：脚底横向撞到显示器外边会反弹（vx 变号）', () => {
  const world = makeWorld({displays: [A], seed: 1});
  const spec = makeSpec({tuning: {idleSec: [120, 120]}});
  const a = createActor(spec, {x: 100, y: 200}, world.ctx);
  a.vx = -800;
  a.vy = 200;

  let bounced = 0;
  for (let i = 0; i < 400 && a.state === 'fall'; i++) {
    const before = a.vx;
    step(a, spec, world.ctx);
    if (before < 0 && a.vx > 0) bounced++;
    assert.ok(a.x >= 0, `第 ${i} 步 x = ${a.x} 跑到屏幕左边外面了`);
    assert.ok(a.x < 1920, `第 ${i} 步 x = ${a.x} 跑到屏幕右边外面了`);
  }
  assert.ok(bounced >= 1, '没有反弹');
  assert.ok(Math.abs(a.vx) < 800, '反弹后速度应该变小');
  // 反弹后落到地面
  stepUntil(a, spec, world.ctx, x => x.state === 'idle', {what: '反弹后落地'});
  eq(a.y, FLOOR_Y);
});
test('fall：从显示器之间的缝里掉出去，会被放回最近的地面', () => {
  const world = makeWorld({displays: [A, C], seed: 1});
  const spec = makeSpec();
  const a = createActor(spec, {x: 2900, y: 100}, world.ctx);   // A 和 C 之间的空白处
  stepUntil(a, spec, world.ctx, x => x.state !== 'fall', {what: '被放回地面', maxSteps: 1000});
  eq(a.state, 'land');
  eq(a.y, FLOOR_Y);
  eq(a.support?.key, 'floor:1');      // 2900 离 A 更近
  assert.ok(a.x >= 0 && a.x < 1920, `x = ${a.x}`);
});

// ---------- 11. 确定性 ----------

function traceRun(seed: number): string[] {
  const world = makeWorld({displays: [A], windows: [makeWindow(10, rect(200, 400, 1400, 900))], seed});
  const spec = makeSpec({tuning: {walkOffEdgeChance: 0.3}});
  const a = createActor(spec, {x: 800, y: 200}, world.ctx);
  const out: string[] = [];
  for (let i = 0; i < 2000; i++) {
    const ev = step(a, spec, world.ctx, 1 / 30);
    out.push(`${a.state}|${a.action}|${a.x.toFixed(6)}|${a.y.toFixed(6)}|${a.epoch}|${ev.length}`);
  }
  return out;
}

test('同一个种子跑 2000 步，两次的状态序列完全一样', () => {
  const t1 = traceRun(42);
  const t2 = traceRun(42);
  assert.deepEqual(t1, t2);
  assert.notDeepEqual(t1, traceRun(43));         // 换个种子就不一样（否则说明 rng 没被用上）
});

// ---------- 12. currentFrame / ACTION_FALLBACK ----------

test('currentFrame：循环动作取模，不循环的停在最后一帧', () => {
  const world = makeWorld({displays: [A], seed: 1});
  const spec = makeSpec();
  const a = createActor(spec, {x: 500, y: FLOOR_Y}, world.ctx);

  a.action = 'idle';                            // 96 帧、12 fps、循环
  a.actionStart = 10;
  assert.deepEqual(currentFrame(a, spec, 10), {action: 'idle', frame: 0});
  assert.deepEqual(currentFrame(a, spec, 11), {action: 'idle', frame: 12});    // 1 秒
  assert.deepEqual(currentFrame(a, spec, 18), {action: 'idle', frame: 0});     // 8 秒 = 96 帧，绕回 0
  assert.deepEqual(currentFrame(a, spec, 18.01), {action: 'idle', frame: 0});
  assert.deepEqual(currentFrame(a, spec, 9), {action: 'idle', frame: 0});      // 时间倒退也不出负数

  a.action = 'downed';                          // 62 帧、不循环
  a.actionStart = 0;
  eq(currentFrame(a, spec, 1).frame, 12);
  eq(currentFrame(a, spec, 1000 / 12).frame, 61);

  a.action = 'walk';                            // 14 帧、循环
  a.actionStart = 0;
  eq(currentFrame(a, spec, 2).frame, 10);                            // 24 % 14
  eq(currentFrame(a, spec, 2.1).frame, 11);

  a.action = 'no-such-action';                  // 角色包里没有 → 用 idle 的帧信息
  a.actionStart = 0;
  assert.deepEqual(currentFrame(a, spec, 1), {action: 'idle', frame: 12});
});

test('ACTION_FALLBACK：没有 sit 动作时跑很久也不进 sit', () => {
  assert.deepEqual(ACTION_FALLBACK.sit, ['sit']);
  const spec = makeSpec({omit: ['sit'], tuning: {idleSec: [0, 0], weights: {walk: 1, sit: 5, idle: 1}}});
  eq(resolveAction(spec, 'sit'), null);

  const world = makeWorld({displays: [A], seed: 21});
  const a = createActor(spec, {x: 500, y: FLOOR_Y}, world.ctx);
  let sawWalk = false;
  for (let i = 0; i < 3000; i++) {
    step(a, spec, world.ctx, 1 / 30);
    assert.notEqual(a.state, 'sit', `第 ${i} 步进了 sit`);
    assert.notEqual(a.action, 'sit', `第 ${i} 步用了 sit 动作`);
    if (a.state === 'walk') sawWalk = true;
  }
  assert.ok(sawWalk, '状态机没有继续跑（一次 walk 都没有）');
});

test('ACTION_FALLBACK：没有 dragged 动作时 grab 后用 fall，fall 也没有就用 idle', () => {
  const cases: {omit: string[]; expected: string}[] = [
    {omit: ['dragged'], expected: 'fall'},
    {omit: ['dragged', 'fall'], expected: 'idle'},
  ];
  for (const c of cases) {
    const world = makeWorld({displays: [A], seed: 5});
    const spec = makeSpec({omit: c.omit});
    eq(resolveAction(spec, 'dragged'), c.expected);
    const a = createActor(spec, {x: 500, y: FLOOR_Y}, world.ctx);
    stepUntil(a, spec, world.ctx, x => x.state === 'idle', {what: '落地后 idle'});
    grabActor(a, spec, {x: 500, y: 900}, world.ctx);
    eq(a.state, 'dragged');
    eq(a.action, c.expected);
  }

  // 其他回退：walk → idle、land → idle、downed 没有 → idle
  eq(resolveAction(makeSpec(), 'walk'), 'walk');
  eq(resolveAction(makeSpec({omit: ['walk']}), 'walk'), 'idle');
  eq(resolveAction(makeSpec(), 'land'), 'idle');
  eq(resolveAction(makeSpec(), 'downed'), 'downed');
  eq(resolveAction(makeSpec({omit: ['downed']}), 'downed'), 'idle');
});
