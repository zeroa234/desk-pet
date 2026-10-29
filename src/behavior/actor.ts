// 单个角色的主状态机 + 身体（state-rules.md §2.1、§2.3、§3；design.md §5.3、§6）。纯逻辑，所有随机数来自 ctx.rng。
//
// 每次 stepActor：
//   1. 站着的（非 fall / dragged）先找回脚下的线段：同 key 的段没了 → fall；窗口挪动在阈值内就跟着挪，超了 → fall；
//      挪完脚下那块被别的窗口盖住了 → fall（state-rules §7 第 13 条：关窗后 1 帧内进入 fall）。
//   2. 推进状态：fall 用固定小步长积分，扫掠判落地；walk 朝目标走（没给目标就随便逛，窗口段上有一定概率故意走出端点掉下去，R2.1）；
//      其余状态到时结束。
// 计划（阶段 2）：角色空下来时问 ctx.choose 要一个计划（一串 Step），逐步执行；进入物理状态（掉下去、被拎起来）就中止计划、
// 回到 front 层。没有 ctx.choose 时用阶段 1 的内置选择：idle 到时按 Tuning.weights 选 walk / sit / idle。
// 外面（main/sim.ts：被发现、全年龄切换、双人场景）用 setPlan / interrupt 改计划；角色在物理状态里时先存着，落地后再执行。
// 被发现但行为说“接着做完”时用 continueExposed：计划不换，只回到前面的层、截短 loop 段。
// 物理参数（重力、空气阻力、跟随阈值）照 Shimeji-ee 的默认值换算（design.md §6，DEFAULT_TUNING 的注释）。
// 拖拽：grab 记脚底点和光标的偏移，drag 跟光标并记采样，release 用最近 100 ms 的光标速度抛出（Shimeji 的做法）。
// 跳（N2.5，2026-10-21）：计划步骤 state jump + Step.jump（落点线段的 key、x）：原地播 jump_start → 按重力走抛物线（顶点比两头较高的
// 那头再高 jumpArcHeights 个身高，不算阻力，正好落在落点上；空中播 jump_air）→ 落地播 jump_land，然后下一步。落点那段没了 → 转下落。
// 在窗口里面（层 inside:W，N2.4）：站在窗口里面的底边（Support kind inside）上，窗口挪了不管多远都跟着；下落、跳的时候脚出了窗口的
// 矩形就回 front；front 层下落时窗口里面的底边不算（只有跳进来的、在窗口上松手的才进去）。层 behind 跟着计划走，inside 跟着脚下走。
// （开源版省略）
//   - 换动作（含转身）时身体不跳：按新旧两帧的髋骨位置（ActionInfo.hip）挪脚底点（keepHip）。所有换动作的地方都走 setState / play。
//   - 计划换到下一步的动作时，角色包有接得上的过渡（ActorSpec.transitions）就先播过渡（transitionFor）：现在这一帧就是入口马上播，
//     循环动作没播到入口帧就多播一会儿等它（外面打断换的计划不等，没到入口就直接换）。过渡是插在真正那一步前面的一步（Step.via），
//     换层、衣着、特效在过渡开始时就做。
// 自写。
import type {Point} from '../shared/types.ts';
import type {Support} from '../world/index.ts';
import {ACTION_FALLBACK, FRONT, PHYSICAL_STATES, sameLayer,
  type Actor, type ActorEvent, type ActorSpec, type ActorState, type Fx, type Layer, type Plan, type Step, type WorldContext} from './types.ts';

const STEP = 1 / 120;          // 物理积分步长
const MAX_DT = 0.25;           // 单次 step 的 dt 上限（休眠唤醒时不至于穿模）
const SAMPLE_KEEP = 0.2;       // 拖拽采样保留多久
const THROW_WINDOW = 0.1;      // 抛出速度按最近多久的采样算
const RELEASE_INSIDE_HEIGHTS = 0.3;   // 松手时脚比窗口顶边低这么多个身高才算“放进窗口里”（贴着顶边放还是站到顶边上）

interface Hidden {
  grabOffset: Point;
  samples: {t: number; x: number; y: number}[];
  sitReadyAt: number;
  /** 物理状态里收到的计划（setPlan），落地空下来以后执行 */
  pending: Plan | null;
  /** 正在跳（state jump）：takeoff 原地起跳、air 空中、land 落地动画 */
  jump: Jump | null;
}
interface Jump {
  phase: 'takeoff' | 'air' | 'land';
  to: {key: string; x: number};
  /** 起跳时落点那段窗口的左上角（落地时按位移挪落点：窗口在她跳的时候挪了） */
  refLeft: number; refTop: number;
  takeoffEnd: number;
  x0: number; y0: number; vx: number; vy0: number; g: number; t0: number; T: number;
  /** 落点在窗口里面（kind inside）时那个窗口：下落过它的顶边就换到 inside 层 */
  into: number | null;
}
const hidden = new WeakMap<Actor, Hidden>();
function priv(a: Actor): Hidden {
  let h = hidden.get(a);
  if (!h) hidden.set(a, h = {grabOffset: {x: 0, y: 0}, samples: [], sitReadyAt: 0, pending: null, jump: null});
  return h;
}

const between = (ctx: WorldContext, [lo, hi]: readonly [number, number]) => lo + (hi - lo) * ctx.rng();

/** 动作在角色包里有，而且这身衣着下有图 */
export function actionAvailable(spec: ActorSpec, name: string, outfit?: string): boolean {
  const info = spec.actions[name];
  return !!info && (!outfit || !info.outfits || info.outfits.includes(outfit));
}

/**
 * 状态对应的动作：wanted（步骤指定的）能用就用它，否则按 ACTION_FALLBACK 取角色包里第一个能用的；都没有返回 null
 * （sit / getup 没有就不进）。outfit 给了时只认这身衣着下有图的。
 */
export function resolveAction(spec: ActorSpec, state: ActorState, wanted?: string, outfit?: string): string | null {
  if (wanted && actionAvailable(spec, wanted, outfit)) return wanted;
  return ACTION_FALLBACK[state].find(n => actionAvailable(spec, n, outfit)) ?? null;
}

/** 当前动作播完一遍要几秒 */
const actionSeconds = (spec: ActorSpec, action: string) => {
  const info = spec.actions[action];
  return info ? info.frames / info.fps : 0;
};

/** 现在这一帧髋骨在画面上相对脚底点的横向位置（自己的身高；ActionInfo.hip，没有 = 0） */
function hipAt(a: Actor, spec: ActorSpec, now: number): number {
  const {action, frame} = currentFrame(a, spec, now);
  return spec.actions[action]?.hip?.[a.facing > 0 ? 'right' : 'left']?.[frame] ?? 0;
}

/**
 * （开源版省略）
 * 两段离原点 20 多个模型像素），不挪的话换动作那一下人横着跳一截。站着的不挪出脚下那段线段
 */
function keepHip(a: Actor, spec: ActorSpec, ctx: WorldContext, before: number): void {
  const d = (before - hipAt(a, spec, ctx.now)) * heightPxOf(a, spec, ctx);
  if (Math.abs(d) < 0.5) return;
  const beforeX = a.x;
  a.x += d;
  if (a.support) a.x = Math.min(Math.max(a.x, a.support.x0), a.support.x1 - 1);
  a.poseOffsetX = (a.poseOffsetX ?? 0) + a.x - beforeX;
}

/**
 * 身体在哪（物理像素）：髋骨正下方的地面点。脚底点 a.x 是模型原点，各动作里身体离它不一样远（跪坐的两段 20 多个模型像素），
 * （开源版省略）
 * 按 a.x 算的包围盒离开了窗口，被当成被发现）
 */
export function bodyX(a: Actor, spec: ActorSpec, ctx: WorldContext): number {
  return a.x + hipAt(a, spec, ctx.now) * heightPxOf(a, spec, ctx);
}

/** 换成 action 从第 0 帧播（不换状态：跳的起跳 → 空中 → 落地） */
function play(a: Actor, spec: ActorSpec, ctx: WorldContext, action: string): void {
  const before = hipAt(a, spec, ctx.now);
  a.action = action; a.actionStart = ctx.now;
  keepHip(a, spec, ctx, before);
}

function setState(a: Actor, spec: ActorSpec, to: ActorState, ctx: WorldContext, reason: string, ev: ActorEvent[],
  duration = Infinity, wanted?: string, facing?: 1 | -1): void {
  const from = a.state, before = hipAt(a, spec, ctx.now);
  if (facing) a.facing = facing;
  a.state = to;
  a.epoch++;
  a.stateStart = ctx.now;
  a.stateEnd = ctx.now + duration;
  if (to !== 'walk') a.targetX = null;
  const action = resolveAction(spec, to, wanted, a.outfit) ?? 'idle';
  // 同一个循环动作接着播（idle → idle）不从头开始；换了动作或不循环的动作从第 0 帧开始
  if (action !== a.action || !spec.actions[action]?.loop) { a.action = action; a.actionStart = ctx.now; }
  keepHip(a, spec, ctx, before);
  ev.push({type: 'state', from, to, reason});
}

/**
 * 换到步骤 s 的动作之前要不要先播过渡（见文件开头）：角色包里有一条 to = 新动作、entries 里有现在的动作，这身衣着下有图。
 * 现在这一帧就是入口 → 返回过渡和它的时长；循环动作没播到入口帧 → 返回还要等几秒（最多一圈）；不循环的动作只有最后一帧能是
 * 入口，没播完就等它播完。走、跳、物理状态不接过渡（entries 里本来就没有走路、空中的动作）。
 */
function transitionFor(a: Actor, spec: ActorSpec, s: Step, ctx: WorldContext): {action: string; sec: number} | {wait: number} | null {
  if (!spec.transitions?.length || s.state === 'walk' || s.state === 'jump' || PHYSICAL_STATES.has(a.state)) return null;
  const outfit = s.outfit ?? a.outfit, to = resolveAction(spec, s.state, s.action, outfit), cur = spec.actions[a.action];
  if (!to || to === a.action || !cur) return null;
  const f = Math.max(0, Math.floor((ctx.now - a.actionStart) * cur.fps));   // 播到第几帧（循环的不取模）
  let best: {action: string; ahead: number} | null = null;
  // 循环动作离入口帧 e 还有几帧；刚过去一帧也算到了（主循环醒晚了一点，差一帧的动作在 entryTolPx 以内），不然要再等一圈
  const n = cur.frames, toEntry = (e: number) => { const d = (e - f % n + n) % n; return d === n - 1 ? 0 : d; };
  for (const t of spec.transitions) {
    const at = t.to === to && actionAvailable(spec, t.action, outfit) ? t.entries[a.action] : undefined;
    if (!at?.length) continue;
    const ahead = cur.loop ? Math.min(...at.map(toEntry)) : at.includes(n - 1) ? Math.max(0, n - 1 - f) : Infinity;
    if (ahead < (best?.ahead ?? Infinity)) best = {action: t.action, ahead};
  }
  if (!best) return null;
  if (!best.ahead) return {action: best.action, sec: actionSeconds(spec, best.action)};
  // 等到那一帧的正中间（帧号向下取整，正好落在边界上会差一帧）
  return {wait: a.actionStart + (f + best.ahead + 0.5) / cur.fps - ctx.now};
}

// ---------- 计划 ----------
function abortPlan(a: Actor, ctx: WorldContext, ev: ActorEvent[], reason: string): void {
  if (a.plan) { ev.push({type: 'plan-end', behavior: a.plan.behavior, outcome: 'aborted', reason}); ctx.ended?.(a, a.plan.behavior, 'aborted'); }
  a.plan = null; a.step = null; a.phase = null;
  priv(a).jump = null;
  // 躲（behind）跟着计划走；在窗口里面（inside）跟着脚下走，计划中止了也还在窗口里面
  if (a.layer.kind === 'behind') { a.layer = FRONT; ev.push({type: 'layer', layer: FRONT}); }
}

function setLayer(a: Actor, layer: Layer, ev: ActorEvent[]): void {
  if (!sameLayer(a.layer, layer)) { a.layer = layer; ev.push({type: 'layer', layer}); }
}

/** 窗口里面的底边（key in:<hwnd>）现在的样子；窗口没了返回 undefined */
const insideOf = (ctx: WorldContext, hwnd: number) => ctx.supports.find(s => s.key === `in:${hwnd}`);

/**
 * 下落 / 跳的时候：在窗口里面的，脚出了窗口的矩形（左右、顶上，或者低过窗口里面的底边——从底下掉出去了）或者窗口没了就回 front
 * （2026-10-21 子代理单测发现：以前没管底下，掉出去落到地面上还算在窗口里，画面裁到窗口里就看不见了）
 */
function leaveInsideIfOut(a: Actor, ctx: WorldContext, ev: ActorEvent[]): void {
  if (a.layer.kind !== 'inside') return;
  const s = insideOf(ctx, a.layer.hwnd), r = s?.rect;
  if (!s || !r || a.x < r.left || a.x >= r.right || a.y < r.top || a.y > s.y) setLayer(a, FRONT, ev);
}

/** 这个角色现在能落在哪些线段上：front 层不算窗口里面的底边，在窗口里面的只算自己那个窗口的 */
function landable(a: Actor, ctx: WorldContext): readonly Support[] {
  return ctx.supports.filter(s => landsOn(a.layer, s));
}
/** 线段 s 在这一层上能不能落（人、水珠都按它）：在窗口里面的只算那个窗口里面的底边，别的层不算任何窗口里面的底边 */
export function landsOn(l: Layer, s: Support): boolean {
  return l.kind === 'inside' ? s.key === `in:${l.hwnd}` : s.kind !== 'inside';
}

/** urgent：外面打断换的计划（setPlan），第一步不等过渡的入口帧（applyStep） */
function startPlan(a: Actor, spec: ActorSpec, plan: Plan, ctx: WorldContext, ev: ActorEvent[], urgent = false): void {
  a.plan = {...plan, steps: [...plan.steps]};
  ev.push({type: 'plan', behavior: plan.behavior, steps: plan.steps.length});
  nextStep(a, spec, ctx, ev, urgent);
}

/** 开始计划里的下一步；没有了就算计划完成，角色空下来 */
function nextStep(a: Actor, spec: ActorSpec, ctx: WorldContext, ev: ActorEvent[], urgent = false): void {
  for (let guard = 0; guard < 64; guard++) {
    const plan = a.plan;
    if (!plan) return becomeFree(a, spec, ctx, ev);
    const s = plan.steps.shift();
    if (!s) {
      ev.push({type: 'plan-end', behavior: plan.behavior, outcome: 'done', reason: 'done'});
      ctx.ended?.(a, plan.behavior, 'done');   // 先记账再挑下一个（WorldContext.ended）
      a.plan = null; a.step = null; a.phase = null;
      return becomeFree(a, spec, ctx, ev);
    }
    const why = s.guard && ctx.guard ? ctx.guard(a, s) : null;
    if (why) { abortPlan(a, ctx, ev, why); return becomeFree(a, spec, ctx, ev); }
    if (applyStep(a, spec, s, ctx, ev, urgent)) return;
    if (plan.strict) { abortPlan(a, ctx, ev, 'step-unavailable'); return becomeFree(a, spec, ctx, ev); }
    // 这一步做不了（没有这个动作、没有可走的线段）：跳过，接着下一步
  }
  abortPlan(a, ctx, ev, 'too-many-skipped-steps');
  toIdle(a, spec, ctx, 'plan-skipped', ev);
}

/**
 * 开始一步；做不了返回 false。urgent（外面打断换的计划：被发现、被点、全年龄切换……）要马上反应：现在这一帧正好是入口才接过渡，
 * 不等入口帧，没到就直接换（身体照样对齐）
 */
function applyStep(a: Actor, spec: ActorSpec, s: Step, ctx: WorldContext, ev: ActorEvent[], urgent = false): boolean {
  let tr = transitionFor(a, spec, s, ctx);
  if (tr && 'wait' in tr && urgent) tr = null;
  if (tr && 'wait' in tr) {
    // 现在的动作还没播到过渡的入口帧：这一步放回去，现在这个动作接着播（不换状态、不从头播），到入口帧再来
    a.plan!.steps.unshift(s);
    if (!a.step) a.step = {state: a.state, action: a.action};   // 计划刚开始（空着的时候）：占住，别让状态机当成空下来
    a.stateEnd = ctx.now + tr.wait;
    return true;
  }
  if (tr) {
    // 先播过渡：换层、衣着、特效、转向在过渡开始时做，真正的这一步接在后面（同样的状态和阶段，这些不再做一遍）
    a.plan!.steps.unshift({...s, layer: undefined, outfit: undefined, fx: undefined, facing: undefined, guard: undefined});
    s = {state: s.state, action: tr.action, sec: tr.sec, phase: s.phase, layer: s.layer, outfit: s.outfit, fx: s.fx, facing: s.facing, via: true};
  }
  // 层跟着脚下走：站在窗口里面的，步骤让回 front（收尾、被发现的模板）不管；步骤要进某个窗口里面、脚下却不是那个窗口的底边也不管
  // （双人走位的每一步带着出发时的层，人从窗口里跳出来以后还是 inside，2026-10-22 以前会把层设回去、被裁到窗口里画不出来）
  const footless = s.layer && (s.layer.kind === 'front' ? a.support?.kind === 'inside' : s.layer.kind === 'inside' && a.support?.key !== `in:${s.layer.hwnd}`);
  if (s.layer && !sameLayer(s.layer, a.layer) && !footless) { a.layer = s.layer; ev.push({type: 'layer', layer: s.layer}); }
  if (s.outfit && s.outfit !== a.outfit) { a.outfit = s.outfit; ev.push({type: 'outfit', outfit: s.outfit}); }
  if (s.fx) ev.push({type: 'fx', fx: s.fx});
  a.step = s; a.phase = s.phase ?? null;
  if (s.state === 'walk') return startWalk(a, spec, ctx, ev, s.targetX, s.action, s.targetBodyX);
  if (s.state === 'jump') return startJump(a, spec, s, ctx, ev);
  const action = resolveAction(spec, s.state, s.action, a.outfit);
  if (!action) return false;
  const info = spec.actions[action];
  const duration = s.sec ?? (info && !info.loop ? actionSeconds(spec, action) : Infinity);
  setState(a, spec, s.state, ctx, 'step', ev, duration, action, s.facing);
  return true;
}

/** 角色空下来了：先执行物理状态里收到的计划，再问 ctx.choose；没有钩子时用内置选择 */
function becomeFree(a: Actor, spec: ActorSpec, ctx: WorldContext, ev: ActorEvent[]): void {
  const h = priv(a);
  if (h.pending) { const p = h.pending; h.pending = null; return startPlan(a, spec, p, ctx, ev); }
  if (!ctx.choose) return toIdle(a, spec, ctx, 'free', ev);
  const plan = ctx.choose(a);
  if (plan && plan.steps.length) return startPlan(a, spec, plan, ctx, ev);
  if (a.state === 'idle') a.stateEnd = ctx.now + between(ctx, spec.tuning.idleSec);   // 接着站，不算换状态
  else toIdle(a, spec, ctx, 'nothing-chosen', ev);
}

/** 当前这个状态结束了（时长到、走到了、播完了）：计划里的就下一步；物理状态按规则接；都不是就空下来 */
function finish(a: Actor, spec: ActorSpec, ctx: WorldContext, ev: ActorEvent[], reason: string): void {
  if (a.plan?.strict && (reason === 'walk-timeout' || reason === 'jump-lost')) {
    abortPlan(a, ctx, ev, reason); return becomeFree(a, spec, ctx, ev);
  }
  if (a.step) return nextStep(a, spec, ctx, ev);
  if (a.state === 'downed' && resolveAction(spec, 'getup', undefined, a.outfit)) {
    setState(a, spec, 'getup', ctx, reason, ev, actionSeconds(spec, resolveAction(spec, 'getup', undefined, a.outfit)!));
    return;
  }
  if (ctx.choose || priv(a).pending) return becomeFree(a, spec, ctx, ev);
  toIdle(a, spec, ctx, reason, ev);
}

function toFall(a: Actor, spec: ActorSpec, ctx: WorldContext, reason: string, ev: ActorEvent[], vx = 0): void {
  abortPlan(a, ctx, ev, reason);
  a.support = null;
  a.vx = vx; a.vy = 0;
  setState(a, spec, 'fall', ctx, reason, ev);
}

function toIdle(a: Actor, spec: ActorSpec, ctx: WorldContext, reason: string, ev: ActorEvent[]): void {
  setState(a, spec, 'idle', ctx, reason, ev, between(ctx, spec.tuning.idleSec));
}

const footMetrics = (a: Actor, ctx: WorldContext) => ctx.metricsAt({x: a.x, y: a.y - 1});
/** 这个角色在脚下那个显示器上的显示高度（物理像素） */
export const heightPxOf = (a: Actor, spec: ActorSpec, ctx: WorldContext) => footMetrics(a, ctx).heightPx * (spec.heightRatio ?? 1);

export function createActor(spec: ActorSpec, at: Point, ctx: WorldContext, opts: {outfit?: string} = {}): Actor {
  const outfit = opts.outfit ?? 'clothed';
  return {id: spec.id, state: 'fall', x: at.x, y: at.y, vx: 0, vy: 0, facing: ctx.rng() < 0.5 ? 1 : -1, support: null,
    action: resolveAction(spec, 'fall', undefined, outfit) ?? 'idle', actionStart: ctx.now, stateStart: ctx.now, stateEnd: Infinity,
    targetX: null, epoch: 0, plan: null, step: null, phase: null, layer: FRONT, outfit};
}

// ---------- 1. 找回脚下的线段 ----------
function followSupport(a: Actor, spec: ActorSpec, ctx: WorldContext, ev: ActorEvent[]): boolean {
  const old = a.support;
  if (!old) { toFall(a, spec, ctx, 'no-support', ev); return false; }
  const segs = ctx.supports.filter(s => s.key === old.key);
  if (!segs.length) { toFall(a, spec, ctx, 'support-gone', ev); return false; }
  let x = a.x, far = false;
  if (old.rect && segs[0].rect) {
    const o = old.rect, n = segs[0].rect, dy = n.top - o.top;
    // 窗口挪了、缩放了：按宽度比例挪（Shimeji-ee FloorCeiling.move 的做法，2026-10-21 用户要的“窗口缩放时按比例跟着挪”）——
    // 她在窗口里的相对位置不变；只挪的时候比例是 1，就是跟着平移
    const ratio = o.right > o.left ? (n.right - n.left) / (o.right - o.left) : 1;
    const map = (v: number) => n.left + (v - o.left) * ratio, dx = map(x) - x;
    if (dx || dy) {
      const s = footMetrics(a, ctx).scale, t = spec.tuning;
      // 在窗口里面的不管挪多远都跟着（她在窗口里面）。站在顶边上的超过阈值（按她自己被挪了多少算）就不跟了（Shimeji 同）：
      // 上下挪太多掉下来；横着挪太多留在原地，脚下还是这个窗口就接着站（窗口从她脚下滑过去），不在了才掉。
      // 以前横着挪太多一律掉下来，脚下还是窗口时下一帧就落地、多播一下落地动画
      if (old.kind !== 'inside' && (dy <= -t.followMaxUp * s || dy >= t.followMaxDown * s)) {
        toFall(a, spec, ctx, 'moved-too-far', ev); return false;
      }
      far = old.kind !== 'inside' && Math.abs(dx) >= t.followMaxDx * s;
      if (!far) {
        x = map(x);
        if (a.targetX !== null) a.targetX = map(a.targetX);
        if (a.step?.targetBodyX !== undefined) a.step.targetBodyX = map(a.step.targetBodyX);
      }
      ev.push({type: 'followed', supportKey: old.key, dx: x - a.x, dy});
    }
  }
  const seg = segs.find(s => x >= s.x0 && x < s.x1);
  if (!seg) { a.x = x; toFall(a, spec, ctx, far ? 'moved-too-far' : 'support-covered', ev); return false; }
  a.x = x; a.y = seg.y; a.support = seg;
  return true;
}

// ---------- 2. 状态 ----------
/** 内置选择（没有 ctx.choose 时，阶段 1 的行为） */
function chooseNext(a: Actor, spec: ActorSpec, ctx: WorldContext, ev: ActorEvent[]): void {
  const t = spec.tuning, h = priv(a);
  const opts: [ActorState, number][] = [['walk', t.weights.walk], ['idle', t.weights.idle]];
  if (resolveAction(spec, 'sit', undefined, a.outfit) && ctx.now >= h.sitReadyAt) opts.push(['sit', t.weights.sit]);
  const total = opts.reduce((s, [, w]) => s + w, 0);
  let r = ctx.rng() * total, pick: ActorState = 'idle';
  for (const [s, w] of opts) { if (r < w) { pick = s; break; } r -= w; }
  if (pick === 'walk' && startWalk(a, spec, ctx, ev)) return;
  if (pick === 'sit') {
    setState(a, spec, 'sit', ctx, 'chose-sit', ev, between(ctx, t.sitSec));
    h.sitReadyAt = a.stateEnd + t.sitCooldown;
    return;
  }
  if (a.state === 'idle') a.stateEnd = ctx.now + between(ctx, t.idleSec);   // 接着站，不算换状态
  else toIdle(a, spec, ctx, 'chose-idle', ev);
}

/**
 * 开始走：target 给了就走到那里（可以在线段外面，走出端点就掉下去）；没给就在当前线段上随便挑一个点
 * （窗口段上有 walkOffEdgeChance 的概率故意走出端点）。action 给了就用它（如蹲着走 crouchwalk），速度按它的地速。
 */
function startWalk(a: Actor, spec: ActorSpec, ctx: WorldContext, ev: ActorEvent[], target?: number, action?: string, targetBodyX?: number): boolean {
  const seg = a.support;
  if (!seg || !resolveAction(spec, 'walk', action, a.outfit)) return false;
  const hp = heightPxOf(a, spec, ctx), margin = spec.halfWidthRatio * hp, minDist = 0.5 * hp;
  if (target === undefined) {
    if (seg.kind === 'window' && ctx.rng() < spec.tuning.walkOffEdgeChance) {
      target = ctx.rng() < 0.5 ? seg.x0 - margin : seg.x1 + margin;   // 故意走出端点（R2.1）
    } else {
      const lo = seg.x0 + margin, hi = seg.x1 - margin;
      const left = Math.max(0, Math.min(hi, a.x - minDist) - lo), right = Math.max(0, hi - Math.max(lo, a.x + minDist));
      if (left + right <= 0) return false;
      const r = ctx.rng() * (left + right);
      target = r < left ? lo + r : Math.max(lo, a.x + minDist) + (r - left);
    }
  }
  const facing = targetBodyX !== undefined ? targetBodyX >= bodyX(a,spec,ctx) ? 1 : -1 : target >= a.x ? 1 : -1;
  setState(a, spec, 'walk', ctx, a.step ? 'step' : 'chose-walk', ev, spec.tuning.walkMaxSec, action, facing);
  a.targetX = targetBodyX !== undefined ? bodyWalkTarget(a,spec,ctx,targetBodyX) : target;
  return true;
}

function bodyWalkTarget(a: Actor, spec: ActorSpec, ctx: WorldContext, x: number): number {
  const origin = x - hipAt(a,spec,ctx.now) * heightPxOf(a,spec,ctx);
  return a.support ? Math.min(Math.max(origin,a.support.x0),a.support.x1-1) : origin;
}

function stepWalk(a: Actor, spec: ActorSpec, dt: number, ctx: WorldContext, ev: ActorEvent[]): void {
  if (a.step?.targetBodyX !== undefined) a.targetX=bodyWalkTarget(a,spec,ctx,a.step.targetBodyX);
  const seg = a.support!, target = a.targetX ?? a.x;
  const perSec = spec.actions[a.action]?.heightsPerSec ?? spec.walkHeightsPerSec;
  const speed = perSec * heightPxOf(a, spec, ctx), dir = target === a.x ? a.facing : target > a.x ? 1 : -1;
  a.facing = dir;
  if (Math.abs(target - a.x) <= speed * dt) a.x = target;
  else a.x += dir * speed * dt;
  if (a.x < seg.x0 || a.x >= seg.x1) { toFall(a, spec, ctx, 'walked-off', ev, dir * speed); return; }
  if (a.x === target) {
    if (a.step) finish(a, spec, ctx, ev, 'arrived');
    else toIdle(a, spec, ctx, 'arrived', ev);
  } else if (ctx.now >= a.stateEnd) {
    if (a.step) finish(a, spec, ctx, ev, 'walk-timeout');
    else toIdle(a, spec, ctx, 'walk-timeout', ev);
  }
}

// ---------- 跳（N2.5） ----------
/** 落点那段现在的样子：同 key、包含 x 的那段；窗口里面的底边或窗口顶边被切成几段时取离 x 最近的那段 */
function landingSeg(ctx: WorldContext, key: string, x: number): Support | null {
  let best: Support | null = null, bd = Infinity;
  for (const s of ctx.supports) {
    if (s.key !== key) continue;
    const d = x < s.x0 ? s.x0 - x : x >= s.x1 ? x - s.x1 + 1 : 0;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/** 开始跳：落点那段现在得在；有 jump_start 就先原地播它，没有马上起跳 */
function startJump(a: Actor, spec: ActorSpec, s: Step, ctx: WorldContext, ev: ActorEvent[]): boolean {
  if (!s.jump || !a.support) return false;
  const seg = landingSeg(ctx, s.jump.key, s.jump.x);
  if (!seg) return false;
  const take = actionAvailable(spec, 'jump_start', a.outfit) ? 'jump_start' : undefined;
  setState(a, spec, 'jump', ctx, 'step', ev, Infinity, take, Math.abs(s.jump.x - a.x) > 1 ? (s.jump.x > a.x ? 1 : -1) : s.facing);
  priv(a).jump = {phase: 'takeoff', to: {...s.jump}, refLeft: seg.rect?.left ?? 0, refTop: seg.rect?.top ?? 0,
    takeoffEnd: ctx.now + (take ? actionSeconds(spec, take) : 0), x0: 0, y0: 0, vx: 0, vy0: 0, g: 0, t0: 0, T: 0,
    into: seg.kind === 'inside' ? Number(seg.key.slice(3)) : null};
  if (!take) launch(a, spec, ctx, ev);
  return true;
}

/** 离地：落点按落点那段窗口的位移挪，再算一条正好落在那里的抛物线（顶点比两头较高的那头再高 jumpArcHeights 个身高） */
function launch(a: Actor, spec: ActorSpec, ctx: WorldContext, ev: ActorEvent[]): void {
  const j = priv(a).jump!;
  const seg = landingSeg(ctx, j.to.key, j.to.x);
  if (!seg) { abortPlan(a, ctx, ev, 'jump-target-gone'); toIdle(a, spec, ctx, 'jump-target-gone', ev); return; }
  const hw = spec.halfWidthRatio * heightPxOf(a, spec, ctx);
  const dx = (seg.rect?.left ?? 0) - j.refLeft;
  const lo = seg.x0 + Math.min(hw, (seg.x1 - seg.x0) / 2), hi = seg.x1 - Math.min(hw, (seg.x1 - seg.x0) / 2);
  const x1 = Math.min(hi, Math.max(lo, j.to.x + dx)), y1 = seg.y;
  const m = footMetrics(a, ctx), g = spec.tuning.gravity * m.scale, arc = spec.tuning.jumpArcHeights * heightPxOf(a, spec, ctx);
  const apex = Math.min(a.y, y1) - arc, vy0 = -Math.sqrt(2 * g * (a.y - apex));
  const T = -vy0 / g + Math.sqrt(2 * (y1 - apex) / g);
  Object.assign(j, {phase: 'air', to: {key: seg.key, x: x1}, refLeft: seg.rect?.left ?? 0, refTop: seg.rect?.top ?? 0,
    x0: a.x, y0: a.y, vx: (x1 - a.x) / T, vy0, g, t0: ctx.now, T});
  ev.push({type: 'jumped', supportKey: seg.key, dx: Math.round(x1 - a.x), dy: Math.round(y1 - a.y)});
  a.support = null;
  play(a, spec, ctx, resolveAction(spec, 'jump', undefined, a.outfit) ?? 'idle');
  j.x0 = a.x;   // 换成空中动作时身体对齐挪过脚底点：抛物线从挪过的位置起，落点不变
  j.vx = (x1 - a.x) / T;
}

function stepJump(a: Actor, spec: ActorSpec, ctx: WorldContext, ev: ActorEvent[]): void {
  const j = priv(a).jump;
  if (!j) { finish(a, spec, ctx, ev, 'jump-lost'); return; }
  if (j.phase === 'takeoff') { if (ctx.now >= j.takeoffEnd) launch(a, spec, ctx, ev); return; }
  if (j.phase === 'land') { if (ctx.now >= a.stateEnd) { priv(a).jump = null; finish(a, spec, ctx, ev, 'landed'); } return; }
  const t = Math.min(ctx.now - j.t0, j.T);
  a.x = j.x0 + j.vx * t; a.y = j.y0 + j.vy0 * t + 0.5 * j.g * t * t;
  a.vx = j.vx; a.vy = j.vy0 + j.g * t;
  // 跳进窗口：往下落过它的顶边就换到 inside 层（身子在顶边以上的部分被裁掉，像从顶上掉进去）；跳出窗口：脚出了矩形就回 front
  if (j.into !== null && a.layer.kind === 'front' && a.vy > 0) {
    const r = insideOf(ctx, j.into)?.rect;
    if (r && a.y >= r.top) setLayer(a, {kind: 'inside', hwnd: j.into}, ev);
  }
  leaveInsideIfOut(a, ctx, ev);
  if (t < j.T) return;
  // 落地：落点那段还在（窗口挪了就按位移挪）就站上去，否则从这里接着往下掉
  const seg = landingSeg(ctx, j.to.key, j.to.x);
  const x = seg ? j.to.x + ((seg.rect?.left ?? 0) - j.refLeft) : a.x;
  if (!seg || x < seg.x0 || x >= seg.x1) { toFall(a, spec, ctx, 'jump-target-gone', ev, a.vx); a.vy = j.vy0 + j.g * j.T; return; }
  if (seg.kind === 'inside') setLayer(a, {kind: 'inside', hwnd: Number(seg.key.slice(3))}, ev);
  a.x = x; a.y = seg.y; a.vx = 0; a.vy = 0; a.support = seg;
  ev.push({type: 'landed', supportKey: seg.key, impactDip: 0});
  j.phase = 'land';
  const land = actionAvailable(spec, 'jump_land', a.outfit) ? 'jump_land' : null;
  play(a, spec, ctx, land ?? resolveAction(spec, 'land', undefined, a.outfit) ?? 'idle');
  a.stateEnd = ctx.now + (land ? actionSeconds(spec, land) : spec.tuning.landSec);
}

function landOn(a: Actor, spec: ActorSpec, s: Support, x: number, ctx: WorldContext, ev: ActorEvent[]): void {
  const impactDip = Math.max(0, a.vy) / footMetrics(a, ctx).scale;
  a.x = x; a.y = s.y; a.vx = 0; a.vy = 0; a.support = s;
  ev.push({type: 'landed', supportKey: s.key, impactDip});
  const t = spec.tuning;
  if (impactDip > t.hardLandingSpeed) setState(a, spec, 'downed', ctx, 'hard-landing', ev, between(ctx, t.downedSec));
  else setState(a, spec, 'land', ctx, 'landed', ev, t.landSec);
}

function stepFall(a: Actor, spec: ActorSpec, dt: number, ctx: WorldContext, ev: ActorEvent[]): void {
  const t = spec.tuning, bounds = ctx.displayBounds;
  for (let left = dt; left > 1e-9; left -= STEP) {
    const h = Math.min(STEP, left), m = footMetrics(a, ctx);
    a.vy += t.gravity * m.scale * h;
    a.vx *= Math.exp(-t.dragX * h);
    a.vy *= Math.exp(-t.dragY * h);
    const px = a.x, py = a.y;
    let nx = px + a.vx * h;
    const ny = py + a.vy * h;
    // 横向：脚底那一行的显示器左右边界外面没有屏幕就反弹
    const row = bounds.filter(b => ny - 1 >= b.top && ny - 1 < b.bottom);
    if (row.length) {
      const lo = Math.min(...row.map(b => b.left)), hi = Math.max(...row.map(b => b.right));
      if (nx < lo) { nx = lo; a.vx = -a.vx / 2; } else if (nx >= hi) { nx = hi - 1; a.vx = -a.vx / 2; }
    }
    // 扫掠：这一小步里跨过的最上面那条线段
    if (a.vy > 0) {
      let best: Support | null = null, bx = 0;
      for (const s of landable(a, ctx)) {
        if (s.y < py || s.y > ny) continue;
        const xc = ny > py ? px + (nx - px) * (s.y - py) / (ny - py) : nx;
        if (xc < s.x0 || xc >= s.x1) continue;
        if (!best || s.y < best.y) { best = s; bx = xc; }
      }
      if (best) { landOn(a, spec, best, bx, ctx, ev); return; }
    }
    a.x = nx; a.y = ny;
    // 在窗口里面的，脚出了窗口就回 front（从侧边被甩出去、窗口没了），之后按 front 层找落点
    leaveInsideIfOut(a, ctx, ev);
    // 掉到所有显示器下面了（从缝里掉出去）：放到最近的那个显示器的地面上
    if (bounds.length && ny - 1 >= Math.max(...bounds.map(b => b.bottom))) {
      const d = ctx.metricsAt({x: nx, y: ny}).displayId, floor = ctx.supports.find(s => s.key === `floor:${d}`);
      if (floor) { a.vy = 0; landOn(a, spec, floor, Math.min(Math.max(nx, floor.x0), floor.x1 - 1), ctx, ev); return; }
    }
  }
}

/**
 * 推进 dt 秒：先找回脚下的线段（窗口挪了就跟、挪太远或没了就掉），再推进状态机和物理。
 * main/ 大约 30 Hz 调一次；dt 截到 MAX_DT，物理按 1/120 s 小步积分。
 */
export function stepActor(a: Actor, spec: ActorSpec, dt: number, ctx: WorldContext): ActorEvent[] {
  const ev: ActorEvent[] = [];
  dt = Math.min(Math.max(dt, 0), MAX_DT);
  const airborne = a.state === 'fall' || a.state === 'dragged' || (a.state === 'jump' && !a.support);
  if (!airborne && !followSupport(a, spec, ctx, ev)) {
    stepFall(a, spec, dt, ctx, ev);
    return ev;
  }
  // （开源版省略）
  const sw = a.step?.outfitAt;
  if (sw && a.outfit !== sw.to && ctx.now - a.stateStart >= sw.sec) { a.outfit = sw.to; ev.push({type: 'outfit', outfit: sw.to}); }
  switch (a.state) {
    case 'fall': stepFall(a, spec, dt, ctx, ev); break;
    case 'dragged': break;
    case 'walk': stepWalk(a, spec, dt, ctx, ev); break;
    case 'jump': stepJump(a, spec, ctx, ev); break;
    case 'idle':
      if (ctx.now < a.stateEnd) break;
      if (a.step) finish(a, spec, ctx, ev, 'done');
      else if (ctx.choose || priv(a).pending) becomeFree(a, spec, ctx, ev);
      else chooseNext(a, spec, ctx, ev);
      break;
    default: if (ctx.now >= a.stateEnd) finish(a, spec, ctx, ev, 'done');
  }
  return ev;
}

/**
 * 外面给角色一个新计划（被发现、全年龄切换、双人场景）：中止当前计划（reason），马上开始新的；
 * 角色在物理状态（下落、被拎着、摔倒……）里时先存着，空下来再执行。plan 为 null = 只中止、站着。
 */
export function setPlan(a: Actor, spec: ActorSpec, plan: Plan | null, ctx: WorldContext, reason: string): ActorEvent[] {
  const ev: ActorEvent[] = [];
  if (PHYSICAL_STATES.has(a.state)) { priv(a).pending = plan; return ev; }
  // 跳到半空：当前计划算中止，跳的物理不停（落地动画照播），落地以后再执行新计划（2026-10-21：以前新计划在半空直接开始，
  // 下一帧脚下没东西就掉下去、新计划也跟着中止，比如跳的时候切全年龄，穿衣服那一步就丢了）
  if (a.state === 'jump' && !a.support) {
    if (a.plan) { ev.push({type: 'plan-end', behavior: a.plan.behavior, outcome: 'aborted', reason}); ctx.ended?.(a, a.plan.behavior, 'aborted'); }
    a.plan = null; a.step = null; a.phase = null;
    priv(a).pending = plan;
    return ev;
  }
  abortPlan(a, ctx, ev, reason);
  if (plan && plan.steps.length) startPlan(a, spec, plan, ctx, ev, true);
  else toIdle(a, spec, ctx, reason, ev);
  return ev;
}

/**
 * 躲着被发现了但接着做（sim.ts：行为的 discovered 规则成立时调，KeepOnDiscovered）：计划不中止——回到 front 层、冒个特效；
 * （开源版省略）
 * 物理状态里（不该出现：被拎起来时计划已经中止、层已经回到 front）什么都不做。
 */
export function continueExposed(a: Actor, ctx: WorldContext, fx: Fx | undefined, hurrySec: number | null): ActorEvent[] {
  const ev: ActorEvent[] = [];
  if (PHYSICAL_STATES.has(a.state) || !a.plan) return ev;
  // 只从躲藏层回前面；在窗口里面的（被盖住时就地躲着，2026-10-21）还在窗口里面
  if (a.layer.kind === 'behind') { a.layer = FRONT; ev.push({type: 'layer', layer: FRONT}); }
  if (fx) ev.push({type: 'fx', fx});
  if (hurrySec !== null && a.phase === 'loop') {
    if (a.step?.via) {
      // 正在播进 loop 段的过渡：真正的 loop 段在计划开头，截它的时长（不能跳过，过渡的最后一帧就是它的第 0 帧）
      const [loop, ...rest] = a.plan.steps;
      a.plan.steps = [{...loop, sec: Math.min(loop.sec ?? Infinity, hurrySec)}, ...rest.filter(s => s.phase !== 'loop')];
    } else {
      a.stateEnd = Math.min(a.stateEnd, ctx.now + hurrySec);
      a.plan.steps = a.plan.steps.filter(s => s.phase !== 'loop');
    }
  }
  return ev;
}

/** 用户在角色身上按下：进 dragged（任何状态都能被拖拽打断，state-rules §3 第 1 级） */
export function grabActor(a: Actor, spec: ActorSpec, cursor: Point, ctx: WorldContext): ActorEvent[] {
  const ev: ActorEvent[] = [], h = priv(a);
  abortPlan(a, ctx, ev, 'grabbed');
  setLayer(a, FRONT, ev);   // 从窗口里面拎出来
  h.pending = null;
  h.samples = [{t: ctx.now, x: cursor.x, y: cursor.y}];
  a.support = null; a.vx = 0; a.vy = 0;
  setState(a, spec, 'dragged', ctx, 'grab', ev);
  h.grabOffset = {x: a.x - cursor.x, y: a.y - cursor.y};   // 换成被拎着的动作时脚底点按身体对齐挪过（keepHip），偏移按挪过的算
  return ev;
}

/** 拖拽中光标移动：脚底点 = 光标 + 偏移；记下采样算抛出速度 */
export function dragActor(a: Actor, cursor: Point, ctx: WorldContext): void {
  const h = priv(a);
  a.x = cursor.x + h.grabOffset.x;
  a.y = cursor.y + h.grabOffset.y;
  h.samples.push({t: ctx.now, x: cursor.x, y: cursor.y});
  while (h.samples.length > 2 && h.samples[0].t < ctx.now - SAMPLE_KEEP) h.samples.shift();
}

/** 松手：进 fall，初速度 = 最近 100 ms 光标采样的平均速度，限幅 maxThrowSpeed */
export function releaseActor(a: Actor, spec: ActorSpec, ctx: WorldContext): ActorEvent[] {
  const ev: ActorEvent[] = [], h = priv(a);
  const recent = h.samples.filter(s => s.t >= ctx.now - THROW_WINDOW);
  let vx = 0, vy = 0;
  if (recent.length >= 2) {
    const f = recent[0], l = recent[recent.length - 1], span = l.t - f.t;
    if (span > 1e-6) { vx = (l.x - f.x) / span; vy = (l.y - f.y) / span; }
  }
  const max = spec.tuning.maxThrowSpeed * footMetrics(a, ctx).scale, sp = Math.hypot(vx, vy);
  if (sp > max) { vx *= max / sp; vy *= max / sp; }
  h.samples = [];
  a.support = null;
  // 在某个窗口里面松手（脚比它的顶边低 releaseInsideHeights 个身高以上）：落到这个窗口里面的底边，不穿过窗口掉到下面
  // （docs/desktop-interaction.md §2.3，用户 2026-10-20 同意）。取光标下最上面的窗口：它自己是房间才进。
  // 以前只在房间列表里找第一个包含该点的，最大化窗口出不来、不在列表里，就越过它进了底下被盖住的窗口，用户看不见她（2026-10-29）
  const hp = heightPxOf(a, spec, ctx), top = ctx.windowAt?.({x: a.x, y: a.y});
  const win = ctx.supports.find(s => s.kind === 'inside' && s.rect && a.x >= s.x0 && a.x < s.x1
    && a.y >= s.rect.top + RELEASE_INSIDE_HEIGHTS * hp && a.y < s.y && (top === undefined || s.key === `in:${top}`));
  if (win) setLayer(a, {kind: 'inside', hwnd: Number(win.key.slice(3))}, ev);
  setState(a, spec, 'fall', ctx, 'release', ev);
  a.vx = vx; a.vy = vy;
  return ev;
}

/** 现在该画哪一帧：循环动作取模，不循环的停在最后一帧 */
export function currentFrame(a: Actor, spec: ActorSpec, now: number): {action: string; frame: number} {
  const info = spec.actions[a.action] ?? spec.actions.idle;
  const f = Math.max(0, Math.floor((now - a.actionStart) * info.fps));
  return {action: a.action in spec.actions ? a.action : 'idle', frame: info.loop ? f % info.frames : Math.min(f, info.frames - 1)};
}
