import type {Intent} from '../llm/types.ts';
import {IntentControl, controlSeconds} from './intent-control.ts';
import {clock} from '../llm/context.ts';
import {populationAbsent, populationLimit} from './population.ts';
import {IntentPlans} from './intent-plans.ts';
import {capability, type Capability, type BehaviorStatus, type StateSnapshot, type ActorFacts} from '../llm/state.ts';
import {actorMotion} from '../llm/execution.ts';
// 世界模拟的组装层：桌面快照 → 支撑面 → 每个角色的行为系统和状态机 → 每一层要画什么。
// 不 import electron、不碰 Win32（平台和窗口由 main.ts 注入），可以在假桌面里跑。
//
// 阶段 2（2026-10-20）：
//   - 多个角色：packs/ 下每个角色包一个 Character（角色包、ActorSpec、Brain、在场的话一个 Actor）。没解锁的不在场，
//     解锁条件（behaviors.json 的 unlock，R3.3）每 5 秒查一次，解锁了就从屏幕上方掉下来，解锁进度进存档。
//   - 行为系统（R3.1–R3.4）：角色空下来时状态机调 choose()，Brain 按 behaviors.json 选一个行为（条件、权重、冷却、下一步），
//     这里把步骤模板按当时的世界解析成具体步骤（resolve()：找能躲的窗口、随机时长……）交给状态机。计划结束 / 中止时告诉 Brain
//     （效果、下一步限制）。状态值每 tick 随时间变；有条件的变化（StatDef.rates，如“待在一起欲望涨得快”）约每秒按 view() 重算
//     一次（Brain.observe）。view() 里 others.<id>.dist 是两人的距离（以自己身高为单位）；步骤 approach 走到对方身边。
//   - 层（docs/desktop-interaction.md §2.2）：front 的角色画在每个显示器的覆盖窗口里；behind:W 的角色单独画在一个插在 W
//     正下方的小窗口里（main.ts 管窗口，这里只给出每个 W 要画什么、在哪）。躲着的时候每次刷新桌面算一次被挡住的比例，
//     W 没了或者露出来了（挡住的不到 discoverBelow）就“被发现”（state-rules §2.1 discovered），换成反应计划、回到 front。
// （开源版省略）
//     穿回去、没有片段时一团烟挡一下。
//   - 特效：状态机的 fx 事件（换衣着的烟、被发现的感叹号）记下来，和角色画在同一层，播完就删。
//   - 双人（R1.6、R3.2、state-rules §2.4，Duo）：behaviors.json 里带 duo 的行为选中时，问对方（同一条线段上、空着、已解锁、
//     对方 accept 规则成立），挑一个放得下的场景（packs/_scenes/，pack/loadScenes）；被拒 / 放不下时这个行为冷却 declineCooldown。两个人各拿一个同 tag 的计划：走到场景第 0 帧
// （开源版省略）
//     按段播（loop 段可以多绕几圈），phase 跟着段走。播完：两人站回最后一帧各自的位置，一团烟分开。任一方的计划没了（被拎起来、
//     掉下去、被发现、全年龄切换）：另一方停在当前帧的位置，一团烟 + 被发现的反应（state-rules §2.4 第 6 步）。对方躲在窗口后面时
//     场景在那一层里做，被发现的判断按整个场景的范围。
//   - 音效（R2.8、R6.3，2026-10-20 用户问“声音呢”）：角色包 / 场景的 sfx.json 写着哪一帧有哪个 effect（原版片段的
//     sound_effects 关键帧，scripts/export-pack/export_sfx.py）。每 tick 看每个角色当前动作（双人场景看播放位置）从上次到现在
//     走过了哪些帧，有 effect 就记一条 SoundCue，main.ts 取走（takeCues）按规则（src/sound/）挑声音、交给舞台播。
//     卡住 / 暂停回来不补：最多补最近 0.25 秒的帧。躲在窗口后面照样响（R2.8），cue 带 behind，main.ts 决定要不要闷一点。
//   - 液体（2026-10-20 晚，design.md §3.7，状态在 src/fluid/）：场景播到帧表 floor 里的帧，那一滴落到场景所在的线段上积水洼
// （开源版省略）
//     掉到下面的线段上；场景里两个人的滴水已经烘在图里，不挂。做完以后往外流（scene.json / pack.json 动作的 after）交给 Fluids.after。
//     全年龄模式下都没有。滴多快、湿多少、怎么往外流都在 Fluids 里（这里只给它欲望、衣着、每个出口挂水珠的点、角色包的出口），
//     画的时候 Fluids.paint 给出按表面格子涂的层。
//   - 用户离开（N3.1，2026-10-21）：main.ts 判（away.ts：锁屏 / 屏保，或几分钟没碰键鼠），离开、回来时调 setAway，每秒给 userIdleSec。
//     behaviors.json 按 MindView.user.away / awaySec / locked 写更大胆的行为；离开期间开始的 R18 行为（和双人）记下来（awayDeeds、Duo.away），
// （开源版省略）
//   - 被点、被摸（R3.6、N1.3，2026-10-21）：舞台按部位图（导出的 .parts.png）判点中了哪个部位、是点一下还是来回摸，报给 poke()；
//     这里按 behaviors.json 的 reactions（click:<部位> → click）挑反应：角色空着就换成反应计划，在做 R18 / 双人 / 躲着时只叠加
//     （特效、声音、效果），state-rules §3。
// 画面节奏（R8.7）：像素动画按角色包的帧率换帧；走路、待机的位置也只在换帧时更新（一帧走一步，像素风的做法，也省 CPU）；
// 下落、跳（在空中，2026-10-22 以前漏了，跳的弧线按动作帧率一格一格跳）、被拖着、跟着窗口挪的时候每个 tick 都更新位置。画面没变就不发。
// 自写。JSON Logic 求值在 brain.ts（json-logic-js）；矩形遮挡在 world/visibility.ts。
import {computeSupports, coverAlong, coveredFraction, coversAbove, displayAt, findHideSpots, findRoute, hasExit, jumpTargets,
  type HideSpot, type NavGoal, type NavParams, type NavRoute, type Support} from '../world/index.ts';
import {FRONT, PHYSICAL_STATES, bodyX, continueExposed, createActor, currentFrame, dragActor, grabActor, heightPxOf, landsOn, releaseActor, setPlan, stepActor,
  type Actor, type ActorEvent, type ActorSpec, type ActorState, type Fx, type Metrics, type Plan, type Step, type Tuning,
  type WorldContext} from '../behavior/index.ts';
import {Brain, behaviorHasMaterials, planPlayable, isUnlocked, pickRange, type BehaviorDef, type MindConfig, type MindView, type ReactionDef, type StepTemplate, type UnlockView} from '../behavior/index.ts';
import type {DesktopSnapshot, DisplayInfo, Point, Rect} from '../shared/types.ts';
import type {Facing, Pack, PackVariant, SceneRole, ScenePack} from '../pack/index.ts';
import type {Layer, Phase} from '../behavior/index.ts';
import {shiftBlots, type DebugInfo, type DrawItem} from '../stage/protocol.ts';
import {cellOrigin} from '../shared/sheets.ts';
import {Fluids, type Blot, type DripAnchor} from '../fluid/index.ts';

export interface SimOptions {
  variant: string;
  heightLogical: number;
  /** false = 全年龄模式（R9.2） */
  r18: boolean;
}

/** 没有 behaviors.json 的角色包用这个：阶段 1 的走 / 坐 / 站 */
export const DEFAULT_MIND: MindConfig = {
  schema: 1,
  stats: {},
  behaviors: [
    {id: 'idle', weight: 2, steps: [{do: 'idle', sec: [3, 20]}]},
    {id: 'wander', weight: 5, steps: [{do: 'wander'}]},
    {id: 'sit', weight: 1, cooldown: 30, steps: [{do: 'sit', sec: [10, 90]}]},
  ],
};

/**
 * base 加上用到才算的字段（getter，第一次读时算、记住）：MindView 里贵的（找路、躲藏点），规则引用了才算。
 * 函数里的 this 是这个对象（dist 用 reachable）；可以 for…in、JSON.stringify（读的时候才算）
 */
function lazy<B extends object, L extends Record<string, (this: B & {[K in keyof L]: ReturnType<L[K]>}) => unknown>>(base: B, fields: L): B & {[K in keyof L]: ReturnType<L[K]>} {
  const out = base as B & {[K in keyof L]: ReturnType<L[K]>};
  for (const [k, fn] of Object.entries(fields)) {
    let done = false, v: unknown;
    Object.defineProperty(out, k, {enumerable: true, get() { if (!done) { v = fn.call(out); done = true; } return v; }});
  }
  return out;
}

/** 被发现时没配反应就用这个 */
const DEFAULT_DISCOVERED: readonly StepTemplate[] = [{do: 'play', action: 'idle', sec: 1.5, state: 'discovered', fx: 'alert'}];
/** 被发现那一类反应：discovered（躲着被发现）、returned（用户回来撞见，N3.1；没写、或一条都不成立时用 discovered）。挑法同别的反应（Sim.discoveredOf） */
type FoundKey = 'discovered' | 'returned';
/** （开源版省略） */
const EXPOSED_STATES: ReadonlySet<ActorState> = new Set(['masturbate', 'sex', 'strip']);
/** 被点 / 被摸时可以换成反应计划的状态（其余状态只叠加反应，state-rules §3 “点击叠加”） */
const POKE_INTERRUPTIBLE: ReadonlySet<ActorState> = new Set(['idle', 'walk', 'sit', 'act', 'react']);
/** 被拎着、掉着的时候点不到（舞台按下就拎了），来了也不理 */
const POKE_IGNORED: ReadonlySet<ActorState> = new Set(['dragged', 'fall']);
/** MindView.user.pokes 数最近多少秒 */
const POKE_WINDOW = 60;

/** 用户在角色身上点了一下（click）、来回摸（stroke）（舞台判的，src/stage/stage.ts） */
export type PokeKind = 'click' | 'stroke';

interface Character {
  pack: Pack;
  spec: ActorSpec;
  brain: Brain;
  actor: Actor | null;
  /** gotoHide 找到的窗口和遮挡比例区间，hide 步骤用；behavior = 哪个计划找的（它结束时还没躲进去就清掉，planEnded） */
  hideTarget: {hwnd: number; cover: readonly [number, number]; behavior: string} | null;
  /** 被别的窗口盖住（desktop-interaction §2.7）：现在盖住的比例、连续盖住一半以上从什么时候起、这一回起过反应没有 */
  cover: {frac: number; since: number | null; fired: boolean};
  /** hideHere 以后“就地躲着”：哪个计划（它结束就不算了）、当时主要盖住她的窗口 */
  coverHide: {behavior: string; hwnd: number} | null;
  /** （开源版省略） */
  awayDeeds: boolean;
}

interface Shown {
  sheet: string;
  frame: number;
  x: number;
  y: number;
}

interface ActiveFx {
  id: string;
  fx: Fx;
  start: number;
}

const FX_SEC: Record<Fx, number> = {puff: 0.6, alert: 1.2, heart: 1.2};
/** 躲着的时候挡住的比例低于它就算被发现 */
const DISCOVER_BELOW = 0.12;
/** gotoHide 默认的遮挡比例区间：露一部分（R2.4） */
const HIDE_COVER: readonly [number, number] = [0.35, 0.85];
/**
 * 被别的窗口盖住的反应（docs/desktop-interaction.md §2.7，2026-10-21 用户：主代理定）：包围盒被盖住 COVER_ON 以上算被盖住、掉到 COVER_OFF
 * 以下算露出来（中间一段防抖）；连续盖住 COVER_SEC 秒起一次反应——空着的时候马上重新挑行为，behaviors.json 里按 env.covered / coveredSec
 * 写的反应（走出来、探头、当成躲着做点什么）和平常的行为一起按权重随机挑（挑到平常的就是不理）
 */
const COVER_ON = 0.5, COVER_OFF = 0.3, COVER_SEC = 3;
/** emerge 找的“没被盖住”：盖住的比例不超过它 */
const EMERGE_MAX = 0.15;
/** peek 默认找的遮挡比例、探头多久 */
const PEEK_COVER: readonly [number, number] = [0.35, 0.65];
const PEEK_SEC: readonly [number, number] = [4, 10];
/** 被盖住时可以打断去重新挑的状态（自发的、不在 R18 / 双人 / 反应里） */
const COVER_INTERRUPTIBLE: ReadonlySet<ActorState> = new Set(['idle', 'walk', 'sit']);
/** 可以被邀请（state-rules §2.4 第 2 条） */
const FREE_STATES: ReadonlySet<ActorState> = new Set(['idle', 'walk', 'sit', 'hide']);
/** 双人：两人走到位最多等多久（秒），超了就取消 */
const DUO_APPROACH_MAX = 60;
/** 双人：loop 段默认多绕几圈 */
const DUO_LOOPS: readonly [number, number] = [0, 2];
/**
 * 双人：被拒 / 放不下时邀请方这个行为冷却几秒（DuoTemplate.declineCooldown 的默认）。2026-10-20 用户让主代理定：180。
 * 欲望每小时涨 12–15（待在一起再加 30 左右），3 分钟只差 1–2 点，问得更勤结果基本一样；600（做成以后的冷却）要白等最多 10 分钟。
 */
const DUO_DECLINE_COOLDOWN = 180;
/** approach 步骤默认：停在对方身边几个身高、站几秒 */
const APPROACH_GAP: readonly [number, number] = [0.8, 1.5];
const APPROACH_SEC: readonly [number, number] = [5, 12];
/** 行为系统重算有条件变化（StatDef.rates）的间隔（秒） */
const OBSERVE_SEC = 1;

/** 一次双人行为（state-rules §2.4）。两个人的计划 behavior 都是 tag；谁的计划不是 tag 了就算被打断 */
interface Duo {
  tag: string;
  def: BehaviorDef;
  inviter: string;
  partner: string;
  /** 角色 id → 场景里的角色 */
  roles: Record<SceneRole, string>;
  scene: ScenePack;
  /** 接受方的朝向 = 用哪张图集 */
  facing: Facing;
  variant: string;
  /** 每个渲染像素占几个物理像素（开始时按接受方所在的显示器定） */
  k: number;
  /** 场景锚点 = 接受方 x - offset（接受方跟着窗口挪，锚点一起挪） */
  offset: number;
  layer: Layer;
  stage: 'approach' | 'play';
  /** 这一阶段开始的时刻 */
  since: number;
  /** play：按顺序要播的精灵帧（loop 段多绕的圈已经展开） */
  program: number[];
  phase: Phase | null;
  /** 拆之前先钉住的锚点：拎接受方时要先把她挪到场景里的位置，之后再用 receiver.x - offset 算锚点就偏了（2026-10-20 单测发现） */
  pinned?: Point;
  /** play：音效已经触发到程序里第几个位置（-1 = 还没有） */
  sfxPos: number;
  /** play：落地的液体已经处理到程序里第几个位置 */
  floorPos: number;
  /** 开播时就被别的窗口盖着一半以上（当成躲着做，desktop-interaction §2.7）：主要盖住的窗口；盖住的挪开就被发现 */
  coverHide?: {hwnd: number};
  /** 用户离开期间邀请的（N3.1）：回来时还在明处做就两人都被撞见 */
  away?: true;
}

/** （开源版省略） */
export interface SoundCue {
  id: string;
  voice: string;
  effect: string;
  x: number;
  y: number;
  behind: boolean;
}

/** 补触发最多往回补几秒（卡住、暂停回来时不补一大串） */
const SFX_CATCHUP_SEC = 0.25;
/** 高清变体（style smooth）的特效、液体按这么高的渲染像素算一格（同 r120 的像素风，sim.artPx） */
const ART_REF_HEIGHT = 120;
/** 每个渲染像素 k 个物理像素的变体 v，特效、液体的一格是几个物理像素（Sim.artPx） */
const artOf = (k: number, v: Pick<PackVariant, 'style' | 'renderHeight'> | undefined): number => v?.style === 'smooth' ? k * v.renderHeight / ART_REF_HEIGHT : k;

export class Sim {
  readonly chars = new Map<string, Character>();
  readonly tuning: Tuning;
  opts: SimOptions;
  desktop: DesktopSnapshot = {displays: [], windows: []};
  supports: Support[] = [];
  now = 0;
  playSeconds = 0;
  unlocked: string[];
  private shown = new Map<string, Shown>();
  private fx: ActiveFx[] = [];
  private rng: () => number;
  private lastUnlockCheck = -Infinity;
  private lastObserve = -Infinity;
  readonly scenes: ReadonlyMap<string, ScenePack>;
  duos: Duo[] = [];
  /** 这一 tick 里状态机以外产生的事件（解锁、被发现……），step() 一起返回 */
  private extra: {id: string; e: SimEvent}[] = [];
  /** 音效：还没被 main.ts 取走的 cue；每个角色当前动作触发到第几帧 */
  private cues: SoundCue[] = [];
  private sfxSeen = new Map<string, {action: string; start: number; last: number}>();
  private sceneKeys = new Map<ScenePack, Map<number, [SceneRole, string][]>>();
  /** （开源版省略） */
  readonly fluids: Fluids;
  /** （开源版省略） */
  private stainedAction = new Map<string, number>();
  /** 上一次做完 R18 行为的时刻（MindView.self.afterSexSec） */
  private afterSex = new Map<string, number>();
  /** 单人动作落地的液体（帧表 floor）：每个角色当前动作处理到第几帧（同 sfxSeen） */
  private floorSeen = new Map<string, {action: string; start: number; last: number}>();
  /** 每个角色最近被点 / 摸的时刻（MindView.user.pokes） */
  private pokeTimes = new Map<string, number[]>();
  /** 用户多少秒没碰键鼠（MindView.user.idleSec；main.ts 每秒给，解锁那一刻算一次输入，away.ts） */
  userIdleSec = 0;
  /** 用户离开了（N3.1）：哪一种、从什么时候起（sim 的时钟）；在的时候 null。main.ts 调 setAway */
  away: {kind: 'locked' | 'idle'; since: number} | null = null;

  constructor(packs: readonly Pack[], tuning: Tuning, opts: SimOptions, rng: () => number,
    saved: {unlocked: string[]; chars: Record<string, {stats: Record<string, number>; relations: Record<string, {affection: number}>; outfit?: string}>; playSeconds: number},
    scenes: ReadonlyMap<string, ScenePack> = new Map()) {
    this.tuning = tuning; this.opts = opts; this.rng = rng; this.playSeconds = saved.playSeconds; this.scenes = scenes;
    for (const pack of packs) {
      const mind = pack.mind ?? DEFAULT_MIND;
      this.chars.set(pack.manifest.id, {pack, spec: pack.actorSpec(tuning), brain: new Brain(pack.manifest.id, mind, saved.chars[pack.manifest.id]),
        actor: null, hideTarget: null, cover: {frac: 0, since: null, fired: false}, coverHide: null, awayDeeds: false});
    }
    this.fluids = new Fluids(rng);
    // 一开始就有的（unlock 没写）+ 存档里解锁过的
    this.unlocked = [...new Set([...[...this.chars.values()].filter(c => c.brain.cfg.unlock == null).map(c => c.pack.manifest.id),
      ...saved.unlocked.filter(id => this.chars.has(id))])];
  }

  // ---------- 尺度 ----------
  variantOf(c: Character): string {
    return c.pack.manifest.variants.some(v => v.id === this.opts.variant) ? this.opts.variant : c.pack.manifest.defaultVariant;
  }
  /** 这个角色现在用的那套画面变体（托盘选的，这个包没有就用它的默认变体） */
  private charVariant(c: Character): PackVariant {
    return c.pack.variant(this.variantOf(c));
  }
  /** 角色脚底点在 p 时用的那套变体（v 不给 = 它现在的）和倍数：k = 每个渲染像素几个物理像素，u = 特效、液体的一格（artPx） */
  private scaleAt(c: Character, p: Point, v: PackVariant = this.charVariant(c)): {v: PackVariant; k: number; u: number} {
    const d = displayAt(this.desktop.displays, {x: p.x, y: p.y - 1});
    return {v, k: this.spritePx(d, v), u: this.artPx(d, v)};
  }
  /** 单人这一帧画哪张图集的哪一帧（这身衣着没有这个动作时画 idle 第 0 帧）；水珠挂点和画用同一个 */
  private soloFrame(c: Character, a: Actor) {
    let cf = currentFrame(a, c.spec, this.now);
    if (!c.pack.has(cf.action, a.outfit)) cf = {action: 'idle', frame: 0};
    const variant = this.variantOf(c), facing: Facing = a.facing > 0 ? 'right' : 'left';
    return {frame: cf.frame, sheet: c.pack.sheetPath(variant, a.outfit, cf.action, facing), meta: c.pack.sheet(variant, a.outfit, cf.action, facing)};
  }
  /** 基准角色（第一个包）现在用的那套；世界尺度（支撑面的净空、导航）按它 */
  private baseVariant(): PackVariant {
    return this.charVariant(this.chars.values().next().value!);
  }
  /** 渲染高度（基准角色的） */
  private renderHeight(): number {
    return this.baseVariant().renderHeight;
  }
  /**
   * 每个渲染像素占几个物理像素（design.md §3.4）。像素风的变体整数倍放大，让角色在这个显示器上约 heightLogical 逻辑像素高；
   * 高清变体（style smooth，2026-10-22）可以是小数：和基准角色一样高（基准角色是像素风时取整到多高它就多高，同屏几个人身高对得上；
   * 基准角色自己是高清时正好 heightLogical）。v 不给 = 基准角色那套
   */
  spritePx(d: DisplayInfo, v: PackVariant = this.baseVariant()): number {
    const b = this.baseVariant(), want = this.opts.heightLogical * d.scale;
    const kb = b.style === 'smooth' ? want / b.renderHeight : Math.max(1, Math.round(want / b.renderHeight));
    if (v.style === 'smooth') return kb * b.renderHeight / v.renderHeight;
    return !b.style && v.renderHeight === b.renderHeight ? kb : Math.max(1, Math.round(want / v.renderHeight));
  }
  /**
   * 特效（心、感叹号、烟）、液体（水珠、水洼）的一格是几个物理像素：像素风 = 一个渲染像素；高清 = 同样高的 r120 的一个渲染像素
   * （ART_REF_HEIGHT），不然在 720 高的图上小得看不见
   */
  private artPx(d: DisplayInfo, v: PackVariant): number {
    return artOf(this.spritePx(d, v), v);
  }
  metricsAt = (p: Point): Metrics => {
    const d = displayAt(this.desktop.displays, p);
    return {displayId: d.id, scale: d.scale, heightPx: this.renderHeight() * this.spritePx(d)};
  };
  private maxHeightRatio(): number {
    return Math.max(1, ...[...this.chars.values()].filter(c => c.actor).map(c => c.spec.heightRatio ?? 1));
  }
  /**
   * 角色的包围盒（物理像素）：身体所在的地面点往上一个身高、左右各半宽。没给 x 时按她现在的身体（bodyX：髋骨正下方，2026-10-22；
   * 脚底点 a.x 是模型原点，跪坐这种动作身体离它 20 多个模型像素）；给了 x（规划时试的位置）就按它
   */
  boxOf(c: Character, a: Actor, x = bodyX(a, c.spec, this.ctx()), y = a.y): Rect {
    const h = heightPxOf(a, c.spec, this.ctx()), hw = c.spec.halfWidthRatio * h;
    return {left: x - hw, right: x + hw, top: y - h, bottom: y};
  }

  setDesktop(snap: DesktopSnapshot): void {
    this.desktop = snap;
    const rh = this.renderHeight(), hr = this.maxHeightRatio();
    const halfW = Math.max(...[...this.chars.values()].map(c => c.spec.halfWidthRatio * (c.spec.heightRatio ?? 1)));
    const all = computeSupports(snap, {
      headroom: d => rh * hr * this.spritePx(d) + 4 * d.scale,
      minWidth: d => Math.ceil(2 * halfW * rh * this.spritePx(d)),
      inside: {inset: d => this.tuning.insideInset * d.scale},   // 窗口里面的底边（N2.4）
    });
    // 出不来的窗口不当房间（2026-10-21 用户选的 C：最大化窗口里出不来，躲、双人都断了）：哪个角色从里面跳不出去就去掉这段
    // （松手不落进去、跳不进去；已经在里面的窗口变成这样——比如被最大化——脚下没了，照“窗口关了”掉出来）
    this.supports = all.filter(s => s.kind !== 'inside' || [...this.chars.values()].every(c => {
      const d = snap.displays.find(x => x.id === s.displayId) ?? snap.displays[0];
      return hasExit(all, s, this.navParamsOf(c, rh * this.spritePx(d) * (c.spec.heightRatio ?? 1), d.scale));
    }));
    this.explainLostSupports(all);
    this.fluids.follow(this.supports);
    this.checkHidden();
  }

  /**
   * 脚下的窗口顶边 / 窗口里面的底边这次没了：记一条 support-lost（下一步她就照“窗口关了”掉下来），写清为什么，排查用
   * （2026-10-21 晚用户拖着窗口时两人从窗口里面掉出来，日志只有 support-gone，查不出是哪条规则）。
   * why：window-gone = 窗口不在快照里了（关了、最小化、藏了、cloak）；no-exit = 算出来了、但有角色从里面跳不出去（出不来的窗口不当房间）；
   * dropped = 没算出来（窗口里面：比她矮、底边到了任务栏下面、太窄、置顶；顶边：被别的窗口挡住、到了屏幕外面）。rect / workArea 照记
   */
  private explainLostSupports(all: readonly Support[]): void {
    for (const c of this.chars.values()) {
      const a = c.actor, key = a?.support?.key;
      if (!a || !key || a.support!.kind === 'floor' || this.supports.some(s => s.key === key)) continue;
      const hwnd = Number(key.slice(key.indexOf(':') + 1)), w = this.desktop.windows.find(x => x.hwnd === hwnd);
      const why = !w ? 'window-gone' : all.some(s => s.key === key) ? 'no-exit' : 'dropped';
      const d = displayAt(this.desktop.displays, {x: a.x, y: a.y - 1});
      this.extra.push({id: a.id, e: {type: 'support-lost', key, why, rect: w?.rect ?? null, workArea: d.workArea,
        heightPx: Math.round(heightPxOf(a, c.spec, this.ctx()))}});
    }
  }

  /** 点上最上面的窗口（desktop.windows 按 z 序从上到下，置顶的也在里面；Rect 的 right / bottom 不含）；没有 = null */
  private windowAt = (p: Point): number | null =>
    this.desktop.windows.find(w => p.x >= w.rect.left && p.x < w.rect.right && p.y >= w.rect.top && p.y < w.rect.bottom)?.hwnd ?? null;

  ctx(): WorldContext {
    return {now: this.now, supports: this.supports, metricsAt: this.metricsAt, rng: this.rng, windowAt: this.windowAt,
      displayBounds: this.desktop.displays.map(d => ({displayId: d.id, ...d.bounds})),
      choose: a => this.choose(a), guard: (a, s) => this.guard(a, s), ended: (a, behavior, outcome) => this.planEnded(a, behavior, outcome)};
  }

  get actors(): Actor[] {
    return [...this.chars.values()].flatMap(c => c.actor ? [c.actor] : []);
  }
  charOf(id: string): Character | undefined { return this.chars.get(id); }

  // ---------- 在不在桌面上（2026-10-22 用户：可以自选场景内角色；托盘、设置 onDesktop，main.ts） ----------
  /** 不在桌面上的角色：不出现、不参与双人（别人看它 present = false）；解锁了照样解锁，状态值照常随时间变 */
  private absent = new Set<string>();
  private requestedAbsent = new Set<string>();
  maxOnDesktop: number | null = null;
  isRequestedAbsent(id: string): boolean { return this.requestedAbsent.has(id); }
  setPopulationLimit(value: number | null, drop = true): void {
    this.maxOnDesktop = populationLimit(value);
    this.setAbsent(this.requestedAbsent, drop);
  }
  isAbsent(id: string): boolean { return this.absent.has(id); }
  /** 设哪些角色不在桌面上：新关掉的离开（despawn），新打开的、已解锁的从第一个显示器顶上掉下来（drop = false：不掉，调用方自己 spawn，如召唤） */
  setAbsent(ids: Iterable<string>, drop = true): void {
    this.requestedAbsent = new Set(ids);
    const next = populationAbsent([...this.chars.keys()], this.unlocked, this.requestedAbsent, this.actors.map(a=>a.id), this.maxOnDesktop);
    for (const id of next) if (!this.absent.has(id)) this.despawn(id);
    const back = [...this.absent].filter(id => !next.has(id));
    this.absent = next;
    if (drop) for (const id of back) if (this.unlocked.includes(id) && !this.chars.get(id)?.actor) this.dropIn(id);
  }
  /** 让角色离开桌面：拆掉它参与的双人（对方收尾），清掉躲藏、液体、显示状态 */
  despawn(id: string): void {
    this.intentPlans.clear(id);
    this.intentControl.releaseActor(id);
    const c = this.chars.get(id);
    if (!c?.actor) return;
    for (const d of this.duos.filter(d => d.inviter === id || d.partner === id)) this.dissolveDuo(d, 'left-desktop');
    c.actor = null;
    c.hideTarget = null;
    c.coverHide = null;
    this.fluids.forget(id);
    this.shown.delete(id);
    this.extra.push({id, e: {type: 'desktop', present: false}});
  }
  /** 从第一个显示器顶上随机一处掉下来（解锁、重新放回桌面） */
  private dropIn(id: string): void {
    const d = this.desktop.displays[0];
    if (!d) return;
    this.spawn(id, {x: d.workArea.left + (0.2 + 0.6 * this.rng()) * (d.workArea.right - d.workArea.left), y: d.bounds.top});
    this.extra.push({id, e: {type: 'desktop', present: true}});
  }

  /** 让 id 角色出现在 at（脚底点），从 fall 开始；已经在场就重新放 */
  spawn(id: string, at: Point, outfit?: string): Actor | null {
    const c = this.chars.get(id);
    if (!c || this.isAbsent(id) || !this.unlocked.includes(id) || !c.actor && this.maxOnDesktop !== null && this.actors.length >= this.maxOnDesktop) return null;
    this.intentPlans.clear(id);
    this.intentControl.releaseActor(id);
    for (const d of this.duos.filter(d => d.inviter === id || d.partner === id)) this.dissolveDuo(d, 'respawn');
    c.actor = createActor(c.spec, at, this.ctx(), {outfit: outfit ?? 'clothed'});
    c.hideTarget = null;
    c.coverHide = null;
    c.awayDeeds = false;
    this.fluids.forget(id);
    this.shown.delete(id);
    return c.actor;
  }

  // ---------- 推进 ----------
  /** 推进 dt 秒，返回这一 tick 的事件（带角色 id） */
  step(now: number, dt: number): {id: string; e: SimEvent}[] {
    this.now = now;
    this.playSeconds += dt;
    if (now - this.lastObserve >= OBSERVE_SEC) {
      this.lastObserve = now;
      for (const c of this.chars.values()) c.brain.observe(c.actor && this.unlocked.includes(c.pack.manifest.id) ? this.view(c) : null);
    }
    for (const c of this.chars.values()) if (this.unlocked.includes(c.pack.manifest.id)) c.brain.tick(dt);
    const out: {id: string; e: SimEvent}[] = this.extra.splice(0);
    const ctx = this.ctx();
    this.intentControl.prune(this.playSeconds,id=>this.actorOf(id));
    for (const c of this.chars.values()) {
      const a = c.actor;
      if (!a) continue;
      if(PHYSICAL_STATES.has(a.state))this.intentControl.releaseActor(a.id);
      if(!a.plan&&a.state==='idle'&&this.intentControl.status(a,this.playSeconds))a.stateEnd=Math.min(a.stateEnd,now+0.2);
      const invalid = this.intentPlans.invalid(a, id=>this.goalTarget(id));
      if (invalid) {
        this.intentPlans.clear(a.id);
        this.intentControl.release(a.id);
        for (const e of setPlan(a,c.spec,{behavior:'system:plan-cancelled',steps:[{state:'idle',sec:0.2}]},ctx,'intent-'+invalid)) {this.onEvent(c,e);out.push({id:a.id,e});}
        out.push({id:a.id,e:{type:'intent-plan',what:'cancelled',reason:invalid}});
      }
      for (const e of stepActor(a, c.spec, dt, ctx)) { this.onEvent(c, e); out.push({id: a.id, e}); }
    }
    this.tickDuos();
    this.trackCover();
    this.actorCues();
    this.stepFluids(dt);
    out.push(...this.extra.splice(0));
    if (now - this.lastUnlockCheck >= 5) { this.lastUnlockCheck = now; this.checkUnlocks(); out.push(...this.extra.splice(0)); }
    this.fx = this.fx.filter(f => now - f.start < FX_SEC[f.fx]);
    return out;
  }

  /** 计划结束的那一刻（状态机调，在挑下一个计划之前，见 WorldContext.ended）：结束效果、接续、冷却由 Brain 记；做完 R18 记时刻 */
  private planEnded(a: Actor, behavior: string, outcome: 'done' | 'aborted'): void {
    if(outcome==='aborted'&&this.intentPlans.active(a,behavior))this.intentControl.release(a.id);
    this.intentPlans.ended(a,behavior,outcome);
    const c = this.chars.get(a.id);
    if (!c) return;
    if (c.coverHide?.behavior === behavior) c.coverHide = null;
    // 去躲的路上被打断（拎、点、被发现）：层一直是 front，不会有回到 front 的事件，躲藏目标要在这里清（不然那个窗口一直算她跟着的）
    if (c.hideTarget?.behavior === behavior && a.layer.kind !== 'behind') c.hideTarget = null;
    c.brain.ended(behavior, outcome, this.now);
    if (outcome === 'done' && c.brain.cfg.behaviors.find(b => b.id === behavior)?.r18) this.afterSex.set(c.pack.manifest.id, this.now);
  }

  private onEvent(c: Character, e: ActorEvent): void {
    if (e.type === 'fx') this.fx.push({id: c.pack.manifest.id, fx: e.fx, start: this.now});
    else if (e.type === 'layer' && e.layer.kind === 'front') c.hideTarget = null;
  }

  /** Optional low frequency decision side channel. Returning true keeps the actor in ordinary idle. */
  decisionGate?: (id: string) => boolean;
  private intentPlans = new IntentPlans();
  private intentControl = new IntentControl();
  llmControlSec = 30;
  setLlmControlSeconds(value: unknown): void { this.llmControlSec=controlSeconds(value); }
  clearLlmControl(): void { this.intentControl.clear();this.intentPlans.cancelPending(); }
  hasLlmControl(id: string): boolean { const a=this.actorOf(id);return !!a&&!!this.intentControl.status(a,this.playSeconds); }

  /** Pure preview: uses fixed sampling and never starts cooldowns, plans, or partner reservations. */
  llmCandidates(id: string): Intent[] {
    return this.behaviorOptions(id).flatMap(o => o.intent && o.status.decision_selectable ? [o.intent] : []);
  }

  /** Static, mode-specific directory; never turn missing animations into advertised abilities. */
  llmCapabilities(id: string): Capability[] {
    const c = this.chars.get(id);
    return c ? c.brain.cfg.behaviors.filter(def => this.hasMaterials(c, def)).map(capability) : [];
  }

  private hasMaterials(c: Character, def: BehaviorDef): boolean {
    if (!behaviorHasMaterials(c.spec, def, c.pack.manifest.outfits, this.opts.r18)) return false;
    if (!def.duo) return true;
    return this.opts.r18 && def.duo.with.some(target => def.duo!.scenes.some(id => {
      const sc = this.scenes.get(id)?.manifest;
      return sc?.adult && [sc.roles.receiver, sc.roles.giver].sort().join() === [c.spec.id, target].sort().join();
    }));
  }

  /** Complete diagnostics and executable choices share this one preview. No System One option limit here. */
  private behaviorOptions(id: string, ready = false): {status: BehaviorStatus; intent?: Intent}[] {
    const c = this.chars.get(id), a = c?.actor;
    if (!c || !a || this.isAbsent(id) || !this.unlocked.includes(id)) return [];
    const out: {status: BehaviorStatus; intent?: Intent}[] = [];
    for (const check of c.brain.availability(this.view(c), this.now, {r18: this.opts.r18,source:'llm'})) {
      const {def, weight, rule_weight, preference_met, cooldown_remaining_s} = check;
      if (!this.hasMaterials(c, def)) continue;
      const blocked: string[] = [...check.blocked_by];
      if(this.intentControl.waiting(a,this.playSeconds))blocked.push('actor_reserved');
      if (!a.support) blocked.push('no_support');
      if (!ready && (a.plan || a.state !== 'idle') || this.duoOf(id)) blocked.push('actor_busy');
      const add = (target?: string, scene?: string, extra: string[] = []) => {
        const blocked_by = [...new Set([...blocked, ...extra])];
        const status = {id: def.id, ...(target ? {target} : {}), ...(scene ? {scene} : {}), available: !blocked_by.length,
          preference_met,rule_weight,
          cooldown_remaining_s: Math.round(cooldown_remaining_s * 100) / 100, blocked_by};
        const intent = {id: JSON.stringify(scene ? [def.id, target, scene] : [def.id, target ?? null]), behavior: def.id, target, scene, weight, adult: !!def.r18 || !!def.duo,
          description:capability(def).steps.join(' → ')};
        out.push({status, intent});
      };
      if (def.duo) {
        const targets = def.duo.with.filter(target => this.actorOf(target) && !this.isAbsent(target));
        if (!targets.length) add(undefined, undefined, ['target_unavailable']);
        for (const target of targets) for (const scene of def.duo.scenes) add(target, scene,
          a.support && this.inviteDuo(c, def, {partner: target, scene}, true) ? [] : ['duo_unavailable']);
      } else {
        const hide = def.steps?.find(t => t.do === 'gotoHide');
        const spot = hide?.do === 'gotoHide' ? this.pickHideSpot(c, a, hide.cover ?? HIDE_COVER) : null;
        const approach = def.steps?.find(t => t.do === 'approach');
        const target = hide ? (spot ? `window:${spot.hwnd}` : undefined) : approach?.do === 'approach' ? approach.who : undefined;
        const plan = a.support ? this.resolve(c, def, true, target) : null;
        add(target && !this.isAbsent(target) ? target : undefined, undefined, !plan?.steps.length ? ['plan_unavailable'] :
          planPlayable(c.spec, plan, a.outfit, c.pack.manifest.outfits, this.opts.r18) ? [] : ['materials_unavailable']);
      }
    }
    let selectedCount=0;
    for(const option of out) {
      option.status.decision_selectable=!!option.intent&&option.status.available&&selectedCount<25;
      if(option.status.decision_selectable)selectedCount++;
    }
    return out;
  }

  /** Apply only to the exact actor generation and epoch that requested this choice. */
  applyLlmIntent(id: string, epoch: number, intentId: string | null, expected: Actor): boolean {
    return this.applyLlmPlan(id, epoch, intentId ? [intentId] : [], expected);
  }

  /** Bounded ordered goals; every binding must come from the request's concrete candidate list. */
  applyLlmPlan(id: string, epoch: number, ids: string[], expected: Actor): boolean {
    const c = this.chars.get(id), a = c?.actor;
    if (!c || a !== expected || !a || a.epoch !== epoch || a.plan || a.state !== 'idle' || this.isAbsent(id) || this.intentControl.waiting(a,this.playSeconds)) return false;
    if (ids.length > 3 || new Set(ids).size !== ids.length) return false;
    const candidates = this.llmCandidates(id), goals = ids.map(key=>candidates.find(i=>i.id===key));
    const valid = goals.every((g,i)=>g && (!g.scene || i===goals.length-1));
    const intent = valid ? goals[0] : null;
    let plan: Plan | null = null;
    if (intent) {
      this.intentControl.acquire(a,this.playSeconds,this.llmControlSec);
      this.intentPlans.begin(a, goals as Intent[]);
      plan = this.startIntent(c, intent);
    }
    if (!plan) { this.intentPlans.clear(id); this.intentControl.release(id); plan = this.choose(a, false); }
    if (plan) for (const e of setPlan(a, c.spec, plan, this.ctx(), 'llm-choice')) { this.onEvent(c, e); this.extra.push({id, e}); }
    return true;
  }

  private startIntent(c: Character, intent: Intent): Plan | null {
    const a = c.actor!, def = c.brain.cfg.behaviors.find(b=>b.id===intent.behavior);
    if (!def) return null;
    const r = def.duo && intent.target && intent.scene ? this.inviteDuo(c, def, {partner:intent.target,scene:intent.scene}) :
      {plan:this.resolve(c,def,false,intent.target),partner:undefined};
    if (!r?.plan) return null;
    r.plan.strict = true;
    c.brain.started(def,this.now,r.partner);
    if (this.away && (def.r18 || def.duo)) this.markAway(c,r.partner);
    this.intentPlans.activate(a,r.plan.behavior,!def.duo && intent.target ? this.goalTarget(intent.target) : null);
    if(!def.duo&&intent.target)this.waitForTarget(a,intent.target);
    return r.plan;
  }

  /** Pause only ambient idle/walk/sit, never somebody else's explicit plan or a reaction/adult activity. */
  private waitForTarget(owner: Actor, id: string): void {
    const c=this.chars.get(id),a=c?.actor;
    if(!c||!a||!this.intentControl.status(owner,this.playSeconds)||this.intentControl.status(a,this.playSeconds)||this.intentPlans.controls(a)||
      !this.coverInterruptible(c,a))return;
    this.intentControl.waitFor(owner,a);
    if(a.plan||a.state!=='idle')for(const e of setPlan(a,c.spec,{behavior:'system:intent-wait',steps:[{state:'idle',sec:0.2}]},this.ctx(),'intent-wait')){
      this.onEvent(c,e);this.extra.push({id:a.id,e});
    }
    a.stateEnd=Math.min(a.stateEnd,this.now+0.2);
  }

  private goalTarget(id: string): {actor: Actor; position: Point} | null {
    const c=this.chars.get(id), actor=c?.actor;
    return c && actor ? {actor,position:{x:actor.x-(actor.poseOffsetX??0),y:actor.y}} : null;
  }

  /** Privacy reduced snapshot: no window titles, paths, screenshots, or credentials. */
  llmSnapshot(id: string): StateSnapshot | null {
    const c = this.chars.get(id), a = c?.actor;
    if (!c || !a) return null;
    const facts = (o: Actor): ActorFacts => {
      const ch = this.chars.get(o.id)!;
      const {box,layer,duo} = this.coverSubject(ch,o);
      const interaction=duo??this.duoOf(o.id);
      const role:SceneRole=interaction?.roles.receiver===o.id?'receiver':'giver',frame=duo?this.duoFrame(duo):0;
      const visibleX=duo?this.duoAnchor(duo).x+this.duoSheet(duo).cast[role].dx[frame]*duo.k:bodyX(o,ch.spec,this.ctx());
      const facing=duo?this.duoSheet(duo).cast[role].facing[frame]:o.facing;
      const display = this.desktop.displays.find(d => o.x >= d.bounds.left && o.x < d.bounds.right && o.y - 1 >= d.bounds.top && o.y - 1 < d.bounds.bottom);
      return {id: o.id, name: ch.pack.manifest.name, state: o.state, action: o.action, phase: o.phase, outfit: o.outfit,
        position: {x: Math.round(o.x), y: Math.round(o.y)}, display_id: display?.id ?? null,
        body_position:{x:Math.round(visibleX),y:Math.round(o.y)},facing:facing>0?'right':'left',behavior:o.plan?.behavior??null,
        motion:actorMotion(o),
        place: o.support?.kind ?? 'air', layer: layer.kind,
        routine_control:this.intentControl.status(o,this.playSeconds),
        ...(interaction?{interaction:{scene:interaction.scene.manifest.id,role,
          partner:interaction.inviter===o.id?interaction.partner:interaction.inviter,initiated_by:interaction.inviter,stage:interaction.stage,phase:interaction.phase}}:{}),
        covered_fraction: +(this.coverFrac(layer,box) ?? 0).toFixed(2)};
    };
    return {state_schema: 1, snapshot_v: a.epoch, time: clock(Date.now(),true), mode: this.opts.r18 ? 'adult' : 'sfw',
      displays: this.desktop.displays.map(d => ({id: d.id, bounds: {...d.bounds}})),
      self: {...facts(a), stats: {...c.brain.stats}, relations: structuredClone(c.brain.relations)},
      others: this.actors.filter(o => o.id !== id && !this.isAbsent(o.id)).map(facts),
      user: {away: !!this.away, locked: this.away?.kind === 'locked', idle_s: Math.round(this.userIdleSec)},
      behaviors: this.behaviorOptions(id).map(o=>o.status), pending_goals:this.intentPlans.pending(id)};
  }

  /** 角色要下一个计划（状态机的 ctx.choose） */
  private choose(a: Actor, useGate = true): Plan | null {
    const c = this.chars.get(a.id);
    if (!c) return null;
    // （开源版省略）
    if (!this.opts.r18 && a.outfit !== 'clothed') return {behavior: 'system:dress', steps: [this.outfitStep(c, 'clothed', a.outfit)]};
    const next = this.intentPlans.next(a);
    if (next) {
      const current = this.behaviorOptions(a.id, true).find(o=>o.intent?.id===next.id && o.status.available)?.intent;
      const continued = current && this.startIntent(c,current);
      if (continued) return continued;
      this.intentPlans.clear(a.id);
      this.intentControl.release(a.id);
      this.extra.push({id:a.id,e:{type:'intent-plan',what:'cancelled',reason:'goal-unavailable'}});
    }
    if(this.intentControl.waiting(a,this.playSeconds))return null;
    if (useGate && this.decisionGate?.(a.id)) return null;
    if(useGate&&this.intentControl.status(a,this.playSeconds))return null;
    const view = this.view(c);
    for (let tries = 0; tries < 4; tries++) {
      const def = c.brain.choose(view, this.now, this.rng, {r18: this.opts.r18});
      if (!def) return null;
      const r = def.duo ? this.inviteDuo(c, def) : {plan: this.resolve(c, def), partner: undefined};
      if (r?.plan) {
        c.brain.started(def, this.now, r.partner);
        if (this.away && (def.r18 || def.duo)) this.markAway(c, r.partner);
        return r.plan;
      }
      // 解析不了（比如找不到能躲的窗口）：只记冷却（不算开始过，不加减状态值），换一个。双人被拒 / 放不下用短的冷却
      c.brain.cooldown(def, this.now, def.duo ? def.duo.declineCooldown ?? DUO_DECLINE_COOLDOWN : undefined);
    }
    return null;
  }

  /**
   * 从衣着 from 换成 to 的一步（state-rules：衣着切档一律在遮挡特效或 strip 片段里换）。往少了脱（pack.json outfits 往后）、角色包有
   * （开源版省略）
   */
  private outfitStep(c: Character, to: string, from: string): Step {
    const order = c.pack.manifest.outfits, strip = c.pack.manifest.actions.strip;
    if (this.opts.r18 && strip?.switchSec !== undefined && order.indexOf(to) > order.indexOf(from) && order.indexOf(from) >= 0
      && c.pack.has('strip', from) && c.pack.has('strip', to)) {
      return {state: 'strip', action: 'strip', outfitAt: {sec: strip.switchSec, to}};
    }
    return {state: to === 'clothed' ? 'dress' : 'strip', action: 'idle', sec: FX_SEC.puff * 0.6, outfit: to, fx: 'puff'};
  }

  /** 把行为的步骤模板按当时的世界解析成具体步骤；做不了返回 null */
  private resolve(c: Character, def: BehaviorDef, preview = false, target?: string): Plan | null {
    const rng = preview ? () => 0.5 : this.rng;
    if (def.duo) return null;   // 双人行为走 inviteDuo
    const a = c.actor!, steps: Step[] = [];
    let hide: {hwnd: number; cover: readonly [number, number]; facing: 1 | -1} | null = null;
    let outfit = a.outfit;   // 计划里前面的步骤换过衣着时，按换过的算
    let hideHere = false;
    for (const t of def.steps ?? []) {
      switch (t.do) {
        case 'idle': steps.push({state: 'idle', sec: pickRange(t.sec, rng)}); break;
        case 'wander': steps.push({state: 'walk', action: t.action}); break;
        case 'sit': steps.push({state: 'sit', sec: pickRange(t.sec, rng)}); break;
        case 'play': steps.push({state: t.state ?? 'act', action: t.action, sec: t.sec === undefined ? undefined : pickRange(t.sec, rng),
          phase: t.phase, fx: t.fx}); break;
        case 'gotoHide': {
          const cover = t.cover ?? HIDE_COVER, spot = this.pickHideSpot(c, a, cover, target?.startsWith('window:') ? Number(target.slice(7)) : undefined);
          if (!spot) return null;
          // 背对窗口：露出来的那一侧是正面（躲在窗口左边缘就朝左）
          const w = this.desktop.windows.find(x => x.hwnd === spot.hwnd)!;
          hide = {hwnd: spot.hwnd, cover, facing: spot.x < (w.rect.left + w.rect.right) / 2 ? -1 : 1};
          steps.push({state: 'walk', action: t.action, targetX: spot.x});
          break;
        }
        case 'hide':
          if (!hide) return null;
          steps.push({state: 'hide', action: t.action, sec: t.sec === undefined ? undefined : pickRange(t.sec, rng),
            layer: {kind: 'behind', hwnd: hide.hwnd}, guard: 'hide', facing: hide.facing});
          break;
        case 'unhide': steps.push({state: 'idle', sec: 0.3, layer: FRONT}); break;
        case 'approach': {
          // 走到对方身边（靠自己这一侧），转向对方站一会儿；不在同一条线段上就按导航走、跳过去（N2.5），到不了就做不了
          const o = this.actorOf(t.who);
          if (!o || o === a || !a.support || !o.support || o.layer.kind === 'behind') return null;
          const h = heightPxOf(a, c.spec, this.ctx()), hw = c.spec.halfWidthRatio * h;
          const otherX=bodyX(o,this.chars.get(o.id)!.spec,this.ctx()),side=Math.sign(bodyX(a,c.spec,this.ctx())-otherX)||1;
          const x = Math.min(Math.max(otherX + side * pickRange(t.gap ?? APPROACH_GAP, rng) * h, o.support.x0 + hw), o.support.x1 - hw);
          const route = this.routeSteps(c, a, [{key: o.support.key, x}], t.action);
          if (!route) return null;
          // Only the final local walk uses body alignment; navigation and jumping retain their foot coordinates.
          if(route.at(-1)?.state==='walk')route[route.length-1]={...route.at(-1)!,targetBodyX:x};
          else route.push({state:'walk',action:t.action,targetX:x,targetBodyX:x});
          steps.push(...route);
          steps.push({state: 'idle', sec: pickRange(t.sec ?? APPROACH_SEC, rng), facing: otherX >= x ? 1 : -1});
          break;
        }
        case 'hop': {
          // 跳着玩（N2.5）：一跳能到的别的线段（不进窗口里面），往上的权重翻倍
          if (!a.support || a.support.kind === 'inside') return null;
          const ts = jumpTargets(this.supports, {key: a.support.key, x: a.x}, this.navParams(c, a)).filter(j => j.support.kind !== 'inside');
          if (!ts.length) return null;
          const w = ts.map(j => j.support.y < a.support!.y ? 2 : 1);
          let r = rng() * w.reduce((s, v) => s + v, 0), pick = ts[ts.length - 1];
          for (let i = 0; i < ts.length; i++) { if (r < w[i]) { pick = ts[i]; break; } r -= w[i]; }
          if (Math.abs(pick.fromX - a.x) > 0.5) steps.push({state: 'walk', targetX: pick.fromX});
          steps.push({state: 'jump', jump: {key: pick.support.key, x: pick.toX}});
          break;
        }
        case 'enter': {
          // 跳进脚下这个窗口里面（N2.4）
          const s = a.support;
          if (!s || s.kind !== 'window') return null;
          const inside = this.supports.find(x => x.key === `in:${s.key.slice(4)}`);
          if (!inside) return null;
          const hw = c.spec.halfWidthRatio * heightPxOf(a, c.spec, this.ctx());
          const x = Math.min(Math.max(a.x, inside.x0 + hw), inside.x1 - hw);
          steps.push({state: 'jump', jump: {key: inside.key, x}});
          break;
        }
        case 'leave': {
          // 从窗口里面出来（N2.4）：一跳能到的窗口外面的线段，随机挑
          if (!a.support || a.support.kind !== 'inside') return null;
          const ts = jumpTargets(this.supports, {key: a.support.key, x: a.x}, this.navParams(c, a));
          if (!ts.length) return null;
          const pick = ts[Math.floor(rng() * ts.length)];
          if (Math.abs(pick.fromX - a.x) > 0.5) steps.push({state: 'walk', targetX: pick.fromX});
          steps.push({state: 'jump', jump: {key: pick.support.key, x: pick.toX}});
          break;
        }
        case 'emerge': {
          // 被盖住的反应：走到当前线段上没被盖住的地方；线段上没有、又在窗口里面就跳出来（desktop-interaction §2.7）
          const s = a.support;
          if (!s) return null;
          const open = this.coverSpots(c, a, s).filter(p => p.cover <= EMERGE_MAX);
          if (open.length) {
            const x = open.reduce((b, p) => Math.abs(p.x - a.x) < Math.abs(b.x - a.x) ? p : b).x;
            if (Math.abs(x - a.x) > 0.5) steps.push({state: 'walk', action: t.action, targetX: x});
            steps.push({state: 'idle', sec: pickRange([1, 2], rng)});
            break;
          }
          if (s.kind !== 'inside') return null;
          const ts = jumpTargets(this.supports, {key: s.key, x: a.x}, this.navParams(c, a));
          if (!ts.length) return null;
          const pick = ts.reduce((b, j) => Math.abs(j.fromX - a.x) < Math.abs(b.fromX - a.x) ? j : b);
          if (Math.abs(pick.fromX - a.x) > 0.5) steps.push({state: 'walk', action: t.action, targetX: pick.fromX});
          steps.push({state: 'jump', jump: {key: pick.support.key, x: pick.toX}});
          break;
        }
        case 'peek': {
          // 探头：走到被盖住一部分的地方（最近的），朝露出来的那边
          const s = a.support;
          if (!s) return null;
          const [lo, hi] = t.cover ?? PEEK_COVER;
          const spots = this.coverSpots(c, a, s).filter(p => p.cover >= lo && p.cover <= hi);
          if (!spots.length) return null;
          const x = spots.reduce((b, p) => Math.abs(p.x - a.x) < Math.abs(b.x - a.x) ? p : b).x;
          const h = heightPxOf(a, c.spec, this.ctx()), covers = this.coversFor(a.layer, {x, y: s.y - 1}).map(w => w.rect);
          const side = (dx: number) => coveredFraction(this.boxOf(c, a, x + dx, s.y), covers);
          // 走过去用 walkAction（默认 walk；蹲着探头的写 crouchwalk，2026-10-22 以前按 action 名写死在这里）
          if (Math.abs(x - a.x) > 0.5) steps.push({state: 'walk', action: t.walkAction, targetX: x});
          steps.push({state: 'act', action: t.action ?? 'idle', sec: pickRange(t.sec ?? PEEK_SEC, rng), facing: side(-h / 2) < side(h / 2) ? -1 : 1});
          break;
        }
        case 'hideHere':
          // 就地当成躲着（被盖住的反应）：之后的计划算“躲着做”，盖住的挪开 / 被点到就被发现（trackCover、poke）
          if (!a.support) return null;
          steps.push({state: 'hide', action: t.action ?? 'idle', sec: pickRange(t.sec ?? [1, 2], rng)});
          hideHere = true;
          break;
        case 'outfit': if (t.to !== outfit) steps.push(this.outfitStep(c, t.to, outfit)); outfit = t.to; break;
      }
    }
    if (!preview) {
      c.hideTarget = hide && {hwnd: hide.hwnd, cover: hide.cover, behavior: def.id};
      if (hideHere) c.coverHide = {behavior: def.id, hwnd: this.mainCover(c, a)};
    }
    return {behavior: def.id, steps};
  }

  /**
   * 当前线段上能躲的位置（world/visibility.ts）。先找遮挡比例在 cover 里的（露一部分，R2.4）；一个都没有时退一步，
   * 接受整个被挡住的（[cover 上限, 1]）：桌面上常有最大化的窗口盖住整条地面，这时只能整个躲进去（声音照放 R2.8，
   * 窗口最小化 / 挪开时被发现）。2026-10-20 真机：用户的最大化窗口被提到测试窗口前面，地面上没有“露一部分”的位置。
   */
  private hideSpots(c: Character, a: Actor, cover: readonly [number, number]): HideSpot[] {
    const s = a.support;
    if (!s || s.kind === 'inside') return [];   // 在窗口里面不躲
    const h = heightPxOf(a, c.spec, this.ctx()), hw = c.spec.halfWidthRatio * h;
    const q = (cv: readonly [number, number]) => findHideSpots({windows: this.desktop.windows, support: s, box: x => this.boxOf(c, a, x, s.y), cover: cv,
      stepPx: Math.max(2, Math.round(h / 24)), margin: hw, near: a.x,
      eligible: w => !w.topmost && w.rect.right - w.rect.left >= 4 * hw && w.rect.bottom - w.rect.top >= h});
    const partial = q(cover);
    return partial.length ? partial : q([cover[1], 1]);
  }
  private pickHideSpot(c: Character, a: Actor, cover: readonly [number, number], hwnd?: number): HideSpot | null {
    const spots = this.hideSpots(c, a, cover).filter(s => hwnd === undefined || s.hwnd === hwnd);
    if (!spots.length) return null;
    const h = heightPxOf(a, c.spec, this.ctx()), mid = (cover[0] + cover[1]) / 2;
    // 离她现在的位置近的优先（2026-10-20 用户）：分数以“要走几个身高”为主，遮挡比例离区间中点的差只当零头（差 0.1 ≈ 多走 0.1 个身高）。
    // 以前反过来（每多走 10 个身高才抵遮挡比例差 0.1），而采样一步遮挡比例就差约 0.1，等于按采样的零头挑、离多远几乎不管
    const score = (s: HideSpot) => Math.abs(s.x - a.x) / h + Math.abs(Math.min(s.cover, cover[1]) - mid);
    return spots.reduce((b, s) => score(s) < score(b) ? s : b);
  }

  // ---------- 被别的窗口盖住（desktop-interaction §2.7，2026-10-21） ----------
  /**
   * 能盖住这一层的窗口：front = at 所在显示器的覆盖窗口上面压着的（DesktopSnapshot.overlayAbove，一般是别的程序的置顶窗口）；
   * inside:W = 比 W 高的窗口；behind 是躲着（本来就该被盖住），返回 []
   */
  private coversFor(layer: Layer, at: Point): {hwnd: number; rect: Rect}[] {
    const ws = this.desktop.windows;
    if (layer.kind === 'front') {
      const ids = this.desktop.overlayAbove?.[displayAt(this.desktop.displays, at).id];
      return ids?.length ? ws.filter(w => ids.includes(w.hwnd)).map(w => ({hwnd: w.hwnd, rect: w.rect})) : [];
    }
    if (layer.kind === 'inside') {
      const i = ws.findIndex(w => w.hwnd === layer.hwnd);
      return i < 0 ? [] : ws.slice(0, i).map(w => ({hwnd: w.hwnd, rect: w.rect}));
    }
    return [];
  }
  /** 当前线段 s 上每隔约 1/24 个身高的点被盖住的比例（按她现在的层） */
  private coverSpots(c: Character, a: Actor, s: Support): {x: number; cover: number}[] {
    const h = heightPxOf(a, c.spec, this.ctx()), hw = c.spec.halfWidthRatio * h;
    const covers = this.coversFor(a.layer, {x: a.x, y: s.y - 1}).map(w => w.rect);
    return coverAlong(s, x => this.boxOf(c, a, x, s.y), covers, Math.max(2, Math.round(h / 24)), hw);
  }
  /** 现在盖住她最多的那个窗口（没有 0） */
  private mainCover(c: Character, a: Actor, box: Rect = this.boxOf(c, a), layer: Layer = a.layer): number {
    let best = 0, most = 0;
    for (const w of this.coversFor(layer, {x: (box.left + box.right) / 2, y: box.bottom - 1})) {
      const f = coveredFraction(box, [w.rect]);
      if (f > most) { most = f; best = w.hwnd; }
    }
    return best;
  }
  /**
   * 每 tick：算每个角色被盖住多少（双人场景里按整个场景），连续盖住 COVER_SEC 秒起一次反应（空着就马上重新挑行为）；
   * 就地躲着的（hideHere）、开播时就被盖着的双人，盖住的挪开就被发现
   */
  /**
   * box 被盖住的比例：躲在窗口后面的（layer behind）按压在那个窗口上面的窗口算，那个窗口没了是 null；别的层按压在这一层上面的窗口
   * （coversFor，以 box 底边中间为准）。被盖住的反应、就地躲着 / 窗口后面被发现、躲藏步骤的检查都用它
   */
  private coverFrac(layer: Layer, box: Rect): number | null {
    if (layer.kind === 'behind') {
      const covers = coversAbove(this.desktop.windows, layer.hwnd);
      return covers ? coveredFraction(box, covers) : null;
    }
    return coveredFraction(box, this.coversFor(layer, {x: (box.left + box.right) / 2, y: box.bottom - 1}).map(w => w.rect));
  }

  private trackCover(): void {
    for (const c of this.chars.values()) {
      const a = c.actor, cv = c.cover;
      if (!a) continue;
      const {duo:d,layer,box} = this.coverSubject(c,a);
      const air = PHYSICAL_STATES.has(a.state) || a.state === 'jump' || !a.support;
      cv.frac = air || layer.kind === 'behind' ? 0 : this.coverFrac(layer, box)!;
      if (cv.frac >= COVER_ON) cv.since ??= this.now;
      else if (cv.frac < COVER_OFF) { cv.since = null; cv.fired = false; }
      if (c.coverHide && !d && !air && cv.frac < DISCOVER_BELOW) { this.discover(c, 'exposed', {hwnd: c.coverHide.hwnd, cover: +cv.frac.toFixed(3)}); continue; }
      if (cv.since === null || cv.fired || this.now - cv.since < COVER_SEC) continue;
      cv.fired = true;
      this.extra.push({id: a.id, e: {type: 'covered', cover: +cv.frac.toFixed(3), hwnd: this.mainCover(c, a, box, layer)}});
      if (!d && this.coverInterruptible(c, a)) {
        const plan = this.choose(a);
        if (plan) for (const e of setPlan(a, c.spec, plan, this.ctx(), 'covered')) { this.onEvent(c, e); this.extra.push({id: a.id, e}); }
      }
    }
    for (const d of this.duos.filter(x => x.stage === 'play' && x.coverHide)) {
      const frac = this.coverFrac(d.layer, this.duoBox(d))!;
      if (frac < DISCOVER_BELOW) this.discoverDuo(d, 'exposed', {hwnd: d.coverHide!.hwnd, cover: +frac.toFixed(3)});
    }
  }
  /** Same body/scene geometry for model facts and runtime occlusion checks. */
  private coverSubject(c: Character, a: Actor): {duo?: Duo; layer: Layer; box: Rect} {
    const duo = this.duos.find(d=>d.stage==='play' && (d.inviter===a.id || d.partner===a.id));
    return {duo, layer:duo?.layer ?? a.layer, box:duo ? this.duoBox(duo) : this.boxOf(c,a)};
  }
  /** 被盖住时能不能打断现在的事去重新挑：自发的 idle / walk / sit，计划是 behaviors.json 里的非 R18、非双人行为（反应、系统计划不打断） */
  private coverInterruptible(c: Character, a: Actor): boolean {
    if(this.intentControl.status(a,this.playSeconds)||this.intentPlans.controls(a))return false;
    if (!COVER_INTERRUPTIBLE.has(a.state) || a.layer.kind === 'behind' || this.duoOf(a.id)) return false;
    if (!a.plan) return true;
    const def = c.brain.cfg.behaviors.find(b => b.id === a.plan!.behavior);
    return !!def && !def.r18 && !def.duo;
  }

  // ---------- 导航（N2.5） ----------
  /** 这个角色现在的导航参数（物理像素，按脚下那个显示器） */
  navParams(c: Character, a: Actor): NavParams {
    const ctx = this.ctx();
    return this.navParamsOf(c, heightPxOf(a, c.spec, ctx), ctx.metricsAt({x: a.x, y: a.y - 1}).scale);
  }
  /** 身高 h（物理像素）、缩放 scale 时的导航参数 */
  private navParamsOf(c: Character, h: number, scale: number): NavParams {
    const t = c.spec.tuning;
    const secOf = (n: string) => { const i = c.spec.actions[n]; return i ? i.frames / i.fps : 0; };
    return {halfWidthPx: c.spec.halfWidthRatio * h, jumpUpPx: t.jumpUpHeights * h, jumpSidePx: t.jumpSideHeights * h, arcPx: t.jumpArcHeights * h,
      gravityPx: t.gravity * scale, walkPxPerSec: Math.max(1e-6, c.spec.walkHeightsPerSec * h),
      jumpFixedSec: secOf('jump_start') + (c.spec.actions.jump_land ? secOf('jump_land') : t.landSec)};
  }
  /** 从 a 现在的位置走、跳到 goals 里最近的一个的步骤（walk / jump）；到不了返回 null。action：走路用的动作 */
  routeSteps(c: Character, a: Actor, goals: readonly NavGoal[], action?: string): Step[] | null {
    if (!a.support) return null;
    const r: NavRoute | null = findRoute(this.supports, {key: a.support.key, x: a.x}, goals, this.navParams(c, a));
    if (!r) return null;
    return r.moves.map((m): Step => m.kind === 'walk' ? {state: 'walk', action, targetX: m.x} : {state: 'jump', jump: {key: m.to.key, x: m.to.x}});
  }

  /** 步骤开始前的检查（Step.guard） */
  private guard(a: Actor, s: Step): string | null {
    if (s.guard !== 'hide' || s.layer?.kind !== 'behind') return null;
    const c = this.chars.get(a.id)!, hwnd = s.layer.hwnd;
    const w = this.desktop.windows.find(x => x.hwnd === hwnd);
    if (!w) return 'hide-window-gone';
    if (w.topmost) return 'hide-window-topmost';
    const cover = this.coverFrac(s.layer, this.boxOf(c, a))!;
    const lo = c.hideTarget?.cover[0] ?? HIDE_COVER[0];
    return cover < lo / 2 ? 'hide-spot-lost' : null;
  }

  /**
   * 桌面刷新以后：躲着的角色挡住的比例掉到 DISCOVER_BELOW 以下（窗口挪开、最小化、关了）→ 被发现（R2.4、R2.7、state-rules §2.1）。
   * 反应用 behaviors.json 的 reactions.discovered（没有就站着冒个感叹号），回到 front 层。
   */
  checkHidden(): void {
    // 双人场景在窗口后面做：按整个场景的范围算（state-rules §2.4 第 6 步：两个人都被发现）
    for (const d of this.duos.filter(x => x.stage === 'play' && x.layer.kind === 'behind')) {
      const hwnd = (d.layer as {hwnd: number}).hwnd, cover = this.coverFrac(d.layer, this.duoBox(d));
      if (cover !== null && cover >= DISCOVER_BELOW) continue;
      this.discoverDuo(d, cover !== null ? 'exposed' : 'hide-window-gone', {hwnd, cover: +(cover ?? 0).toFixed(3)});
    }
    for (const c of this.chars.values()) {
      const a = c.actor;
      if (!a || a.layer.kind !== 'behind') continue;
      if (this.duos.some(d => d.stage === 'play' && (d.inviter === a.id || d.partner === a.id))) continue;
      const hwnd = a.layer.hwnd, cover = this.coverFrac(a.layer, this.boxOf(c, a));
      if (cover !== null && cover >= DISCOVER_BELOW) continue;
      this.discover(c, cover !== null ? 'exposed' : 'hide-window-gone', {hwnd, cover: +(cover ?? 0).toFixed(3)});
    }
  }

  /**
   * 躲着的 c 被发现了（挡的窗口挪开 / 关了，或者用户点到了露出来的部分，2026-10-21 用户定）：行为的 discovered 规则成立就原地接着做完，
   * 否则换成 reactions.discovered 的反应计划、回到 front 层。info 原样写进 discovered 事件（hwnd、cover 或 by）。
   */
  private discover(c: Character, reason: string, info: FoundInfo, key: FoundKey = 'discovered'): void {
    const a = c.actor!;
    c.coverHide = null;   // 就地躲着的（hideHere）不再算躲着；接着做完的计划也不会再被发现一次
    // （开源版省略）
    const keep = c.brain.cfg.behaviors.find(b => b.id === a.plan?.behavior)?.discovered;
    if (keep && c.brain.test(keep.when, this.view(c))) {
      c.brain.applyEffects(keep.effects);
      for (const e of continueExposed(a, this.ctx(), keep.fx ?? 'alert', keep.hurry === undefined ? null : pickRange(keep.hurry, this.rng))) {
        this.onEvent(c, e); this.extra.push({id: a.id, e});
      }
      this.extra.push({id: a.id, e: {type: 'discovered', ...info, continued: true}});
      return;
    }
    this.foundReaction(c, reason, info, key);
  }

  /** 被发现那一类反应：returned 先试（key 是它时），再 discovered；写成一串时按 r18、when、weight 挑（同别的反应，不管冷却）；都没有 undefined */
  private discoveredOf(c: Character, key: FoundKey = 'discovered'): ReactionDef | undefined {
    const opts = {r18: this.opts.r18}, view = this.view(c);
    return (key === 'returned' ? c.brain.pickReaction('returned', view, this.rng, opts) : null) ?? c.brain.pickReaction('discovered', view, this.rng, opts) ?? undefined;
  }

  /** 换成被发现那一类反应（reactions.discovered / returned）的计划，记 discovered 事件 */
  private foundReaction(c: Character, reason: string, info: FoundInfo, key: FoundKey): void {
    const a = c.actor!, r = this.discoveredOf(c, key);
    c.brain.applyEffects(r?.effects);
    const steps = this.templatesToSteps(c, r?.steps ?? DEFAULT_DISCOVERED);
    for (const e of setPlan(a, c.spec, {behavior: `reaction:${key}`, steps}, this.ctx(), reason)) {
      this.onEvent(c, e); this.extra.push({id: a.id, e});
    }
    this.extra.push({id: a.id, e: {type: 'discovered', ...info}});
  }

  /** 在窗口后面做的双人被发现（state-rules §2.4 第 6 步）：两个人都被发现，场景散了，各自放 reactions.discovered */
  private discoverDuo(d: Duo, reason: string, info: FoundInfo, key: FoundKey = 'discovered'): void {
    this.dissolveDuo(d, reason);
    for (const id of [d.inviter, d.partner]) {
      const c = this.chars.get(id)!, a = c.actor!, r = this.discoveredOf(c, key);
      c.brain.applyEffects(r?.effects);
      const steps = [{state: 'sex' as const, action: 'idle', phase: 'end' as const, sec: FX_SEC.puff, fx: 'puff' as const, layer: FRONT},
        ...this.templatesToSteps(c, r?.steps ?? DEFAULT_DISCOVERED)];
      for (const e of setPlan(a, c.spec, {behavior: `reaction:${key}`, steps}, this.ctx(), 'duo-discovered')) { this.onEvent(c, e); this.extra.push({id, e}); }
      this.extra.push({id, e: {type: 'discovered', ...info}});
    }
  }

  /** 反应之类不经过 Brain 的步骤模板（不能有 gotoHide / hide） */
  private templatesToSteps(c: Character, ts: readonly StepTemplate[]): Step[] {
    return this.resolve(c, {id: 'reaction', weight: 0, steps: ts.filter(t => t.do !== 'gotoHide' && t.do !== 'hide' && t.do !== 'hideHere')})?.steps ?? [];
  }

  // ---------- 双人（state-rules §2.4） ----------
  private actorOf(id: string): Actor | null { return this.chars.get(id)?.actor ?? null; }
  private inDuo(d: Duo, id: string): boolean { return this.actorOf(id)?.plan?.behavior === d.tag; }
  private duoOf(id: string): Duo | undefined { return this.duos.find(d => d.inviter === id || d.partner === id); }
  private sceneVariant(sc: ScenePack): string {
    return sc.manifest.variants.some(v => v.id === this.opts.variant) ? this.opts.variant : sc.manifest.defaultVariant;
  }
  private duoSheet(d: Duo) { return d.scene.sheet(d.variant, d.facing); }
  /** 场景锚点（物理像素）：接受方 x - offset */
  private duoAnchor(d: Duo): Point {
    if (d.pinned) return d.pinned;
    const r = this.actorOf(d.roles.receiver)!;
    return {x: r.x - d.offset, y: r.y};
  }
  /** play 时现在播到程序里第几个位置（超出 = 播完了） */
  private duoPos(d: Duo): number { return Math.floor((this.now - d.since) * d.scene.manifest.fps); }
  private duoFrame(d: Duo): number { return d.program[Math.min(Math.max(this.duoPos(d), 0), d.program.length - 1)]; }
  private segmentAt(sc: ScenePack, frame: number) { return sc.manifest.segments.find(s => frame >= s.start && frame < s.end) ?? sc.manifest.segments.at(-1)!; }
  private duoEvent(d: Duo, what: string, extra: Record<string, unknown> = {}): void {
    this.extra.push({id: d.inviter, e: {type: 'duo', what, scene: d.scene.manifest.id, partner: d.partner, ...extra}});
  }

  /**
   * 邀请（state-rules §2.4 第 1–3 步）：def.duo.with 里同一条线段上、在场、空着、已解锁、对方 accept 规则成立的角色，
   * 和 def.duo.scenes 里两个人正好是场景两个角色、这条线段放得下的场景，随机配一对。对方马上拿到“走过去”的计划；返回邀请方自己的计划。
   */
  private inviteDuo(c: Character, def: BehaviorDef, only?: {partner: string; scene: string}, preview = false): {plan: Plan; partner: string} | null {
    const a = c.actor!, duo = def.duo!, seg = a.support;
    if (!seg || seg.kind === 'inside' || this.duoOf(a.id)) return null;   // 在窗口里面不做（场景画在 front 层或躲藏层）
    const view = this.view(c);
    const shuffle = <T>(xs: T[]): T[] => xs.map(x => [preview ? 0.5 : this.rng(), x] as const).sort((p, q) => p[0] - q[0]).map(([, x]) => x);
    for (const pid of shuffle(duo.with.filter(id => (!only || id === only.partner) && view.others[id]?.present && view.others[id].free && view.others[id].reachable))) {
      const p = this.chars.get(pid)!, pa = p.actor!;
      const reserved=this.intentControl.waiting(pa,this.playSeconds);
      if(reserved&&reserved!==a.id)continue;
      if(pa.plan&&this.intentPlans.controls(pa))continue;
      if (this.duoOf(pid)) continue;
      // 对方躲着时场景在她那个窗口后面做，要在同一段上；不在同一段的对方按导航走、跳过来（N2.5）
      if (pa.layer.kind === 'behind' && pa.support?.key !== seg.key) continue;
      if (!p.brain.accepts(duo.kind, {...this.view(p), inviter: a.id})) {
        if (!preview) this.extra.push({id: a.id, e: {type: 'duo', what: 'declined', partner: pid}});
        continue;
      }
      const pair = [a.id, pid].sort().join();
      const scenes = shuffle(duo.scenes.filter(id => !only || id === only.scene).map(id => this.scenes.get(id)).filter((sc): sc is ScenePack => !!sc && sc.manifest.adult
        && [sc.manifest.roles.receiver, sc.manifest.roles.giver].sort().join() === pair));
      for (const sc of scenes) {
        const roles = sc.manifest.roles, rcv = this.actorOf(roles.receiver)!, gvr = this.actorOf(roles.giver)!;
        const place = this.placeDuo(sc, rcv, gvr, seg, pa.layer.kind === 'behind' ? pa : null);
        if (!place) continue;
        const d: Duo = {tag: `duo:${def.id}`, def, inviter: a.id, partner: pid, roles, scene: sc, facing: place.facing, variant: place.variant,
          k: place.k, offset: place.start.receiver.x - place.anchor, layer: pa.layer.kind === 'behind' ? pa.layer : FRONT,
          stage: 'approach', since: this.now, program: [], phase: null, sfxPos: -1, floorPos: -1};
        const go = (who: Actor, role: SceneRole): Step[] | null => who.support?.key === seg.key
          ? [{state: 'walk', targetX: place.start[role].x, layer: who.layer}]
          : this.routeSteps(this.chars.get(who.id)!, who, [{key: seg.key, x: place.start[role].x}]);
        if (!go(pa, roles.receiver === pid ? 'receiver' : 'giver')) continue;
        const approach = (who: Actor, role: SceneRole): Plan => ({behavior: d.tag, steps: [
          ...go(who, role)!,
          ...(who.outfit !== sc.manifest.outfit ? [{...this.outfitStep(this.chars.get(who.id)!, sc.manifest.outfit, who.outfit), layer: who.layer}] : []),
          {state: 'sex', action: 'idle', phase: 'start', facing: place.start[role].facing, layer: who.layer},
        ]});
        if (preview) return {plan: approach(a, roles.receiver === a.id ? 'receiver' : 'giver'), partner: pid};
        this.duos.push(d);
        const prole: SceneRole = roles.receiver === pid ? 'receiver' : 'giver';
        for (const e of setPlan(pa, p.spec, approach(pa, prole), this.ctx(), 'invited')) { this.onEvent(p, e); this.extra.push({id: pid, e}); }
        this.duoEvent(d, 'invite', {facing: d.facing, anchor: Math.round(place.anchor)});
        return {plan: approach(a, prole === 'receiver' ? 'giver' : 'receiver'), partner: pid};
      }
    }
    return null;
  }

  /**
   * 场景放在哪：两张图集（接受方朝右 / 朝左）里先试“给予方在接受方哪一边”和现在一样的那张；锚点让两人第 0 帧位置的中点
   * 落在两人现在的中点（对方躲着时让对方不用挪），再夹到线段里：所有帧的不透明范围（span）和两人的起点都要在线段上。
   */
  private placeDuo(sc: ScenePack, rcv: Actor, gvr: Actor, seg: Support, stay: Actor | null) {
    const variant = this.sceneVariant(sc), k = this.spritePx(displayAt(this.desktop.displays, {x: rcv.x, y: rcv.y - 1}), sc.manifest.variants.find(v => v.id === variant));
    const side = Math.sign(gvr.x - rcv.x) || 1;
    const score = (f: Facing) => { const sh = sc.sheet(variant, f); return Math.sign(sh.cast.giver.dx[0] - sh.cast.receiver.dx[0]) === side ? 0 : 1; };
    for (const facing of [...sc.manifest.facings].sort((f, g) => score(f) - score(g))) {
      const sh = sc.sheet(variant, facing), rdx = sh.cast.receiver.dx[0] * k, gdx = sh.cast.giver.dx[0] * k;
      const want = stay ? stay.x - (stay === rcv ? rdx : gdx) : (rcv.x + gvr.x) / 2 - (rdx + gdx) / 2;
      const lo = seg.x0 - Math.min(sh.span[0] * k, rdx, gdx), hi = seg.x1 - 1 - Math.max(sh.span[1] * k, rdx, gdx);
      if (lo > hi) continue;
      const anchor = Math.min(Math.max(want, lo), hi);
      const start: Record<SceneRole, {x: number; facing: 1 | -1}> = {
        receiver: {x: anchor + rdx, facing: sh.cast.receiver.facing[0]},
        giver: {x: anchor + gdx, facing: sh.cast.giver.facing[0]},
      };
      return {facing, variant, k, anchor, start};
    }
    return null;
  }

  /** 播放顺序：每段 [start, end) 播一遍；能绕圈的 loop 段再把最后一个周期多绕 loops 圈 */
  private buildProgram(d: Duo): number[] {
    const out: number[] = [], loops = d.def.duo?.loops ?? DUO_LOOPS;
    for (const s of d.scene.manifest.segments) {
      for (let f = s.start; f < s.end; f++) out.push(f);
      if (s.loop && s.loopable) for (let n = Math.round(pickRange(loops, this.rng)); n > 0; n--) for (let f = s.loop[0]; f < s.loop[1]; f++) out.push(f);
    }
    return out;
  }

  /** 每 tick：谁的计划不是 tag 了 → 打断；approach 两人都等着了 → 开播；play 播完 → 收尾，否则更新阶段 */
  private tickDuos(): void {
    for (const d of [...this.duos]) {
      const gone = [d.inviter, d.partner].find(id => !this.inDuo(d, id));
      if (gone) { this.breakDuo(d, gone, 'interrupted'); continue; }
      const r = this.actorOf(d.roles.receiver)!, g = this.actorOf(d.roles.giver)!;
      if (d.stage === 'approach') {
        const waiting = (a: Actor) => a.state === 'sex' && !a.plan?.steps.length;
        if (waiting(r) && waiting(g)) this.startDuo(d);
        else if (this.now - d.since > DUO_APPROACH_MAX) this.dissolveDuo(d, 'approach-timeout');
        continue;
      }
      this.duoCues(d);
      this.duoFloor(d);
      if (this.duoPos(d) >= d.program.length) { this.finishDuo(d); continue; }
      const phase = this.segmentAt(d.scene, this.duoFrame(d)).phase;
      if (phase !== d.phase) {
        d.phase = phase; r.phase = phase; g.phase = phase;
        if (phase === 'climax') this.fx.push({id: d.roles.receiver, fx: 'heart', start: this.now});
        this.duoEvent(d, 'phase', {phase});
      }
    }
  }

  private startDuo(d: Duo): void {
    d.stage = 'play'; d.since = this.now; d.program = this.buildProgram(d);
    d.offset = this.duoSheet(d).cast.receiver.dx[0] * d.k;
    d.phase = this.segmentAt(d.scene, d.program[0]).phase;
    for (const id of [d.inviter, d.partner]) {
      const c = this.chars.get(id)!;
      for (const e of setPlan(c.actor!, c.spec, {behavior: d.tag, steps: [{state: 'sex', action: 'idle', phase: d.phase, layer: d.layer, fx: 'puff'}]}, this.ctx(), 'duo-play')) {
        this.onEvent(c, e); this.extra.push({id, e});
      }
    }
    // 开播时就被别的窗口盖着一半以上：当成躲着做（desktop-interaction §2.7），盖住的挪开就被发现
    if (d.layer.kind !== 'behind') {
      const box = this.duoBox(d), ic = this.chars.get(d.inviter)!;
      const covers = this.coversFor(d.layer, {x: (box.left + box.right) / 2, y: box.bottom - 1});
      if (coveredFraction(box, covers.map(w => w.rect)) >= COVER_ON) d.coverHide = {hwnd: this.mainCover(ic, ic.actor!, box, d.layer)};
    }
    const an = this.duoAnchor(d), sh = this.duoSheet(d);
    this.duoEvent(d, 'play', {frames: d.program.length, sec: +(d.program.length / d.scene.manifest.fps).toFixed(1), facing: d.facing,
      layer: d.layer.kind === 'front' ? 'front' : `behind:${d.layer.hwnd}`,
      anchor: [Math.round(an.x), Math.round(an.y)], k: d.k, span: [Math.round(an.x + sh.span[0] * d.k), Math.round(an.x + sh.span[1] * d.k)]});
  }

  /** play 中：两个人站回第 frame 帧各自的位置和朝向（收尾、被打断时）；only 给了就只动这几个 */
  private standFromScene(d: Duo, frame: number, only?: readonly string[]): void {
    const sh = this.duoSheet(d), anchor = this.duoAnchor(d);
    for (const role of ['receiver', 'giver'] as const) {
      const a = this.actorOf(d.roles[role]);
      if (!a || !a.support || (only && !only.includes(a.id))) continue;
      a.x = Math.min(Math.max(anchor.x + sh.cast[role].dx[frame] * d.k, a.support.x0), a.support.x1 - 1);
      a.facing = sh.cast[role].facing[frame];
    }
  }

  /** 播完：站回最后一帧的位置，一团烟分开；邀请方结算行为效果（effects.end），对方按同一份 end 效果算 */
  private finishDuo(d: Duo): void {
    this.duos = this.duos.filter(x => x !== d);
    this.standFromScene(d, d.program.at(-1)!);
    for (const id of [d.inviter, d.partner]) {
      const c = this.chars.get(id)!;
      const steps: Step[] = [{state: 'sex', action: 'idle', phase: 'end', sec: FX_SEC.puff, fx: 'puff', layer: d.layer},
        {state: 'idle', sec: pickRange([1, 2], this.rng), layer: d.layer}];
      if (d.layer.kind === 'behind') steps.push({state: 'idle', sec: 0.3, layer: FRONT});
      for (const e of setPlan(c.actor!, c.spec, {behavior: 'duo-end', steps}, this.ctx(), 'duo-done')) { this.onEvent(c, e); this.extra.push({id, e}); }
    }
    this.chars.get(d.inviter)!.brain.ended(d.def.id, 'done', this.now, d.partner);
    this.chars.get(d.partner)!.brain.applyEffects(d.def.effects?.end, d.inviter);
    // （开源版省略）
    const m = d.scene.manifest;
    if (this.opts.r18) for (const role of ['receiver', 'giver'] as const) {
      const a = this.actorOf(d.roles[role]);
      if (a && m.stains?.[role]?.length) this.fluids.stain(a.id, a.outfit, m.stains[role]);
    }
    if (m.creampie && this.opts.r18) this.fluids.creampie(d.roles[m.creampie.role], this.now, m.creampie);
    if (this.opts.r18) for (const role of ['receiver', 'giver'] as const) this.fluids.after(d.roles[role], this.now, m.after?.[role] ?? []);
    for (const id of [d.inviter, d.partner]) this.afterSex.set(id, this.now);
    this.duoEvent(d, 'done', {puddles: this.fluids.puddles.length,
      stains: Object.fromEntries((['receiver', 'giver'] as const).map(r => [r, this.fluids.stains(d.roles[r], this.actorOf(d.roles[r])?.outfit ?? '').length]))});
  }

  /**
   * 一方被打断（计划没了：被拎起来、掉下去……）：另一方停在当前帧的位置，一团烟 + 被发现的反应（state-rules §2.4 第 6 步）；
   * 效果按 effects.interrupt。走过去的阶段被打断：另一方站着，不算效果（冷却在开始时已经记了）。
   */
  private breakDuo(d: Duo, culprit: string, reason: string): void {
    this.duos = this.duos.filter(x => x !== d);
    const other = culprit === d.inviter ? d.partner : d.inviter, oc = this.chars.get(other)!, oa = oc.actor;
    if (d.stage === 'play') {
      this.standFromScene(d, this.duoFrame(d), [other]);
      this.chars.get(d.inviter)!.brain.ended(d.def.id, 'aborted', this.now, d.partner);
      this.chars.get(d.partner)!.brain.applyEffects(d.def.effects?.interrupt, d.inviter);
      if (oa && this.inDuo(d, other)) {
        const r = this.discoveredOf(oc);
        const steps: Step[] = [{state: 'sex', action: 'idle', phase: 'end', sec: FX_SEC.puff, fx: 'puff', layer: FRONT},
          ...this.templatesToSteps(oc, r?.steps ?? DEFAULT_DISCOVERED)];
        for (const e of setPlan(oa, oc.spec, {behavior: 'duo-broken', steps}, this.ctx(), 'partner-' + reason)) { this.onEvent(oc, e); this.extra.push({id: other, e}); }
      }
    } else if (oa && this.inDuo(d, other)) {
      for (const e of setPlan(oa, oc.spec, null, this.ctx(), 'partner-' + reason)) { this.onEvent(oc, e); this.extra.push({id: other, e}); }
    }
    this.duoEvent(d, 'broken', {by: culprit, reason, stage: d.stage});
  }

  /** 系统拆掉（全年龄切换、重新召唤、走过去超时）：play 时两人站回场景位置、放一团烟；之后的计划由调用方给（没给的站着） */
  private dissolveDuo(d: Duo, reason: string): void {
    this.duos = this.duos.filter(x => x !== d);
    if (d.stage === 'play') {
      this.standFromScene(d, this.duoFrame(d));
      this.chars.get(d.inviter)!.brain.ended(d.def.id, 'aborted', this.now, d.partner);
      this.chars.get(d.partner)!.brain.applyEffects(d.def.effects?.interrupt, d.inviter);
    }
    for (const id of [d.inviter, d.partner]) {
      const c = this.chars.get(id)!, a = c.actor;
      if (!a || a.plan?.behavior !== d.tag) continue;
      const plan: Plan | null = d.stage === 'play' ? {behavior: 'duo-end', steps: [{state: 'sex', action: 'idle', phase: 'end', sec: FX_SEC.puff, fx: 'puff', layer: FRONT}]} : null;
      for (const e of setPlan(a, c.spec, plan, this.ctx(), reason)) { this.onEvent(c, e); this.extra.push({id, e}); }
    }
    this.duoEvent(d, 'dissolved', {reason, stage: d.stage});
  }

  // ---------- 音效 ----------
  /** main.ts 每 tick 取走这一 tick 该响的音效 */
  takeCues(): SoundCue[] { return this.cues.splice(0); }

  /** 单人动作：当前动作从上次到现在走过的帧里有 effect 的记 cue（循环动作每圈都响，不循环的播到最后一帧为止） */
  private actorCues(): void {
    const inScene = new Set(this.duos.filter(d => d.stage === 'play').flatMap(d => [d.inviter, d.partner]));
    for (const c of this.chars.values()) {
      const a = c.actor, sfx = c.pack.sfx;
      if (!a) continue;
      const keys = sfx?.actions[a.action], info = c.spec.actions[a.action];
      if (!sfx || !keys || !info || inScene.has(a.id)) { this.sfxSeen.delete(a.id); continue; }
      let seen = this.sfxSeen.get(a.id);
      if (!seen || seen.action !== a.action || seen.start !== a.actionStart) this.sfxSeen.set(a.id, seen = {action: a.action, start: a.actionStart, last: -1});
      const abs = Math.floor((this.now - a.actionStart) * info.fps + 1e-6);
      for (let f = Math.max(seen.last + 1, abs - Math.ceil(SFX_CATCHUP_SEC * info.fps)); f <= abs; f++) {
        if (!info.loop && f >= info.frames) break;
        const frame = info.loop ? f % info.frames : f;
        for (const [kf, effect] of keys) if (kf === frame) this.cues.push({id: a.id, voice: sfx.voice, effect, x: a.x, y: a.y, behind: a.layer.kind === 'behind' || !!c.coverHide});
      }
      seen.last = Math.max(seen.last, abs);
    }
  }

  /** 双人场景 play：程序里从上次到现在走过的位置，对应的场景帧有 effect 的记 cue（谁的 effect 记在谁身上） */
  private duoCues(d: Duo): void {
    const sfx = d.scene.sfx;
    if (!sfx) return;
    let byFrame = this.sceneKeys.get(d.scene);
    if (!byFrame) {
      this.sceneKeys.set(d.scene, byFrame = new Map());
      for (const [f, role, effect] of sfx.keys) { const l = byFrame.get(f); if (l) l.push([role, effect]); else byFrame.set(f, [[role, effect]]); }
    }
    const pos = Math.min(this.duoPos(d), d.program.length - 1), sh = this.duoSheet(d), an = this.duoAnchor(d);
    for (let i = Math.max(d.sfxPos + 1, pos - Math.ceil(SFX_CATCHUP_SEC * d.scene.manifest.fps)); i <= pos; i++) {
      const frame = d.program[i];
      for (const [role, effect] of byFrame.get(frame) ?? []) this.cues.push({id: d.roles[role], voice: sfx.voices[role], effect,
        x: an.x + sh.cast[role].dx[frame] * d.k, y: an.y, behind: d.layer.kind === 'behind' || !!d.coverHide});
    }
    d.sfxPos = Math.max(d.sfxPos, pos);
  }

  /** 双人场景 play：程序里从上次到现在走过的位置，帧表 floor 里那一帧落地的液体落到场景所在的线段上（补帧上限同音效） */
  private duoFloor(d: Duo): void {
    const sh = this.duoSheet(d), r = this.actorOf(d.roles.receiver), seg = r?.support;
    const pos = Math.min(this.duoPos(d), d.program.length - 1);
    if (!sh.floor?.length || !seg || !this.opts.r18) { d.floorPos = pos; return; }
    const an = this.duoAnchor(d), behind = d.layer.kind === 'behind' ? d.layer.hwnd : null;
    for (let i = Math.max(d.floorPos + 1, pos - Math.ceil(SFX_CATCHUP_SEC * d.scene.manifest.fps)); i <= pos; i++) {
      const frame = d.program[i];
      for (const [f, dx, semen, w] of sh.floor) if (f === frame) {
        const x = Math.min(Math.max(an.x + dx * d.k, seg.x0), seg.x1 - 1), v = d.scene.manifest.variants.find(v => v.id === d.variant), u = artOf(d.k, v);
        // 帧表 floor 的宽是这套变体的渲染像素，水洼按画法的一格（artOf）量：换过去（像素风 u = k 不变）
        this.fluids.land(seg, x, u, w * d.k / u, semen, behind, {smooth: v?.style === 'smooth', ring: v?.outline === 'full'});
      }
    }
    d.floorPos = Math.max(d.floorPos, pos);
  }

  // ---------- 液体（src/fluid/） ----------
  /** （开源版省略） */
  private anchorsOf(c: Character, a: Actor, at: Point = {x: a.x, y: a.y}): Record<string, DripAnchor | null> {
    const out: Record<string, DripAnchor | null> = {};
    if (!this.opts.r18 || this.duos.some(d => d.stage === 'play' && (d.inviter === a.id || d.partner === a.id))) return out;
    const {meta, frame} = this.soloFrame(c, a);
    if (!meta.anchors) return out;
    // 位置按渲染像素 × k；水珠的大小按特效、液体的一格（artPx：高清变体的渲染像素太小）
    const {v, k, u} = this.scaleAt(c, at), {left, top} = cellOrigin(meta, frame, at.x, at.y, k);
    const pxPerModel = heightPxOf(a, c.spec, this.ctx()) / c.pack.manifest.restHeightModelPx;
    for (const [name, list] of Object.entries(meta.anchors)) {
      const p = list[frame];
      out[name] = p ? {x: left + p[0] * k, y: top + p[1] * k, front: p[2] === 1, k: u, pxPerModel, ring: v.outline === 'full', ...(v.style === 'smooth' ? {smooth: true} : {})} : null;
    }
    return out;
  }

  /** (x, y) 正下方最近的支撑线（水珠落到哪）；掉出屏幕返回 null */
  /** 水珠落到哪：front 层（和躲着的）不算窗口里面的底边，在窗口里面的只算自己那个窗口的（N2.4） */
  private groundBelowFor = (a: Actor) => (x: number, y: number): Support | null => {
    let best: Support | null = null;
    for (const s of this.supports) {
      if (!landsOn(a.layer, s)) continue;
      if (x >= s.x0 && x < s.x1 && s.y >= y - 1 && (!best || s.y < best.y)) best = s;
    }
    return best;
  };

  /** （开源版省略） */
  private stepFluids(dt: number): void {
    this.fluids.dry(dt);
    for (const c of this.chars.values()) {
      const a = c.actor;
      if (!a) continue;
      // （开源版省略）
      if (!this.opts.r18) { this.fluids.wear(a.id, a.outfit); this.fluids.dropDrip(a.id); continue; }
      const anchors = this.anchorsOf(c, a), inScene = this.duos.some(d => d.stage === 'play' && (d.inviter === a.id || d.partner === a.id));
      this.fluids.stepActor(a.id, this.now, dt, {anchors, sources: c.pack.manifest.fluidSources ?? {}, exposed: Object.values(anchors).some(Boolean) || inScene,
        desire: c.brain.stats.desire ?? 50, busy: a.state === 'masturbate' || a.state === 'sex', outfit: a.outfit,
        behind: a.layer.kind === 'behind' ? a.layer.hwnd : null, ground: this.groundBelowFor(a)});
      this.actorFloor(c, a);
      // （开源版省略）
      const info = c.pack.manifest.actions[a.action];
      if (this.opts.r18 && (info?.stains?.length || info?.after?.length) && !info.loop && this.stainedAction.get(a.id) !== a.actionStart
        && (this.now - a.actionStart) * info.fps >= info.frames - 1) {
        this.stainedAction.set(a.id, a.actionStart);
        this.fluids.stain(a.id, a.outfit, info.stains ?? []);
        this.fluids.after(a.id, this.now, info.after ?? []);
      }
    }
  }

  /** 单人动作：从上次到现在走过的帧里帧表 floor 记着落地的，落到脚下的线段上（不循环的播到最后一帧为止，补帧上限同音效） */
  private actorFloor(c: Character, a: Actor): void {
    const info = c.spec.actions[a.action];
    const meta = info && c.pack.has(a.action, a.outfit) ? c.pack.sheet(this.variantOf(c), a.outfit, a.action, a.facing > 0 ? 'right' : 'left') : null;
    if (!meta?.floor?.length || !a.support || !this.opts.r18 || this.duos.some(d => d.stage === 'play' && (d.inviter === a.id || d.partner === a.id))) {
      this.floorSeen.delete(a.id); return;
    }
    let seen = this.floorSeen.get(a.id);
    if (!seen || seen.action !== a.action || seen.start !== a.actionStart) this.floorSeen.set(a.id, seen = {action: a.action, start: a.actionStart, last: -1});
    const abs = Math.floor((this.now - a.actionStart) * info.fps + 1e-6), seg = a.support;
    const {v, k, u} = this.scaleAt(c, a);
    const behind = a.layer.kind === 'behind' ? a.layer.hwnd : null;
    for (let f = Math.max(seen.last + 1, abs - Math.ceil(SFX_CATCHUP_SEC * info.fps)); f <= abs; f++) {
      if (!info.loop && f >= info.frames) break;
      const frame = info.loop ? f % info.frames : f;
      // 帧表 floor 的宽是这套变体的渲染像素，水洼按画法的一格（u）量：换过去（像素风 u = k 不变；2026-10-22 以前高清直接当 u 用，大了 6 倍）
      for (const [fr, dx, semen, w] of meta.floor) if (fr === frame) this.fluids.land(seg, Math.min(Math.max(a.x + dx * k, seg.x0), seg.x1 - 1), u, w * k / u, semen, behind, {smooth: v.style === 'smooth', ring: v.outline === 'full'});
    }
    seen.last = Math.max(seen.last, abs);
  }

  /** play 中的场景范围（物理像素），被发现的判断用 */
  private duoBox(d: Duo): Rect {
    const sh = this.duoSheet(d), an = this.duoAnchor(d), f = this.duoFrame(d);
    return {left: an.x + sh.span[0] * d.k, right: an.x + sh.span[1] * d.k, top: an.y - (sh.footY?.[f] ?? sh.foot[1]) * d.k, bottom: an.y};
  }

  // ---------- 解锁、全年龄 ----------
  private unlockView(): UnlockView {
    const chars: Record<string, UnlockView['chars'][string]> = {};
    for (const id of this.unlocked) { const b = this.chars.get(id)!.brain; chars[id] = {stats: b.stats, relations: b.relations}; }
    return {chars, playMinutes: this.playSeconds / 60, time: localTime(), mode: {r18: this.opts.r18}};
  }
  private checkUnlocks(force = false): void {
    const view = this.unlockView();
    for (const c of this.chars.values()) {
      const id = c.pack.manifest.id;
      if (this.unlocked.includes(id) || !(force || isUnlocked(c.brain.cfg, view))) continue;
      this.unlocked.push(id);
      this.setAbsent(this.requestedAbsent, false);
      this.extra.push({id, e: {type: 'unlocked', forced: force}});
      // 从主显示器上方掉下来；用户设了不在桌面上的只解锁、不出现
      if (!this.absent.has(id)) this.dropIn(id);
    }
  }
  /** 托盘“解锁全部角色（调试）” */
  unlockAll(): void { this.checkUnlocks(true); }

  /** 全年龄模式开关（R9.2）：关掉 R18 时，正在做 R18 的、没穿衣服的都换成穿衣计划 */
  /** 换画面变体 / 显示高度（托盘）：支撑面的头顶空间、最短长度跟着变，按现在的桌面重算（2026-10-22 以前托盘直接改 opts、靠调用方记得重算） */
  setVariant(id: string): void {
    this.opts.variant = id;
    this.setDesktop(this.desktop);
  }
  setHeightLogical(h: number): void {
    this.opts.heightLogical = h;
    this.setDesktop(this.desktop);
  }

  setR18(on: boolean): void {
    this.clearLlmControl();
    this.opts.r18 = on;
    if (on) return;
    for (const d of [...this.duos]) this.dissolveDuo(d, 'sfw');
    for (const c of this.chars.values()) {
      const a = c.actor;
      if (!a) continue;
      const def = c.brain.cfg.behaviors.find(b => b.id === a.plan?.behavior);
      // （开源版省略）
      const r18Now = !!def?.r18 || a.state === 'masturbate' || a.state === 'sex' || a.state === 'strip' || !!c.spec.actions[a.action]?.r18;
      if (!r18Now && a.outfit === 'clothed') continue;
      const steps = a.outfit === 'clothed' ? [] : [this.outfitStep(c, 'clothed', a.outfit)];
      for (const e of setPlan(a, c.spec, {behavior: 'system:sfw', steps}, this.ctx(), 'sfw')) { this.onEvent(c, e); this.extra.push({id: a.id, e}); }
    }
  }

  // ---------- 行为系统看到的世界 ----------
  view(c: Character): MindView {
    const a = c.actor!, others: Record<string, MindView['others'][string]> = {};
    for (const o of this.chars.values()) {
      if (o === c) continue;
      const b = o.actor, id = o.pack.manifest.id;
      // 够得着 = 同一段上，或者按导航走、跳得过去（N2.5）；dist 同一段上是横着差几个身高，不在同一段是直线距离。
      // 找路、躲藏点贵（observe 每秒每人一次，规则里多半用不到）：用到才算（lazy，JSON Logic 的 var 按属性读）
      const same = !!b && !!a.support && b.support?.key === a.support.key;
      const reachable = () => same || (!!b?.support && !!a.support && b.layer.kind !== 'behind'
        && !!findRoute(this.supports, {key: a.support.key, x: a.x}, [{key: b.support.key, x: b.x}], this.navParams(c, a)));
      const hpx = heightPxOf(a, c.spec, this.ctx());
      others[id] = lazy({present: !!b, free: !!b && FREE_STATES.has(b.state) && !b.plan?.behavior.startsWith('duo:'),
        state: b?.state ?? 'idle', outfit: b?.outfit ?? 'clothed', stats: o.brain.stats}, {
        reachable,
        dist: function (this: {reachable: boolean}) { return !this.reachable ? Infinity : same ? Math.abs(b!.x - a.x) / hpx : Math.hypot(b!.x - a.x, b!.y - a.y) / hpx; },
      });
    }
    return {
      self: {id: a.id, state: a.state, outfit: a.outfit, layer: a.layer.kind, support: a.support?.kind ?? null,
        phase: a.phase, stepSec: this.now - a.stateStart, afterSexSec: this.now - (this.afterSex.get(a.id) ?? -Infinity),
        stats: c.brain.stats, relations: c.brain.relations},
      time: localTime(), mode: {r18: this.opts.r18},
      env: lazy({covered: +c.cover.frac.toFixed(2), coveredSec: c.cover.since === null ? 0 : this.now - c.cover.since},
        {hideSpots: () => a.support ? this.hideSpots(c, a, HIDE_COVER).length : 0}),
      others, user: {idleSec: this.userIdleSec, away: !!this.away, locked: this.away?.kind === 'locked', awaySec: this.away ? Math.max(0, this.now - this.away.since) : 0,
        pokes: (this.pokeTimes.get(a.id) ?? []).filter(t => this.now - t < POKE_WINDOW).length}, playMinutes: this.playSeconds / 60,
    };
  }

  // ---------- 用户离开（N3.1，2026-10-21） ----------
  /**
   * main.ts 判出用户离开 / 换了离开的方式（kind）、回来（null）时调。回来时 seen（桌宠这时看得见：没暂停、没藏起来）才撞见：
   * （开源版省略）
   * 躲在窗口后面、就地躲着的不管（用户回来也看不见，照旧按窗口算）。不管撞没撞见，回来以后离开期间的记号都清掉。
   */
  setAway(kind: 'locked' | 'idle' | null, now: number, seen = true): void {
    if (kind) { this.away = this.away ? {...this.away, kind} : {kind, since: now}; return; }
    if (!this.away) return;
    this.away = null;
    if (seen) this.catchOnReturn();
    for (const c of this.chars.values()) c.awayDeeds = false;
    for (const d of this.duos) delete d.away;
  }

  /** 离开期间开始了 R18 行为：自己记上；双人的话对方和这次双人也记上 */
  private markAway(c: Character, partner?: string): void {
    c.awayDeeds = true;
    if (!partner) return;
    this.chars.get(partner)!.awayDeeds = true;
    const d = this.duoOf(c.pack.manifest.id);
    if (d) d.away = true;
  }

  private catchOnReturn(): void {
    const exposed = (a: Actor | null) => !!a && (EXPOSED_STATES.has(a.state) || a.outfit !== 'clothed');
    const caught = new Set<string>();
    for (const d of [...this.duos]) {
      if (!d.away || d.layer.kind === 'behind' || d.coverHide) continue;
      if (d.stage !== 'play' && !exposed(this.actorOf(d.inviter)) && !exposed(this.actorOf(d.partner))) continue;   // 还穿着走过去：当着你的面接着做
      caught.add(d.inviter); caught.add(d.partner);
      this.discoverDuo(d, 'returned', {by: 'return'}, 'returned');
    }
    for (const c of this.chars.values()) {
      const a = c.actor, id = c.pack.manifest.id;
      if (!a || !c.awayDeeds || caught.has(id) || this.duoOf(id) || a.layer.kind === 'behind' || c.coverHide) continue;
      if (PHYSICAL_STATES.has(a.state) || a.state === 'jump' || !exposed(a)) continue;
      const def = c.brain.cfg.behaviors.find(b => b.id === a.plan?.behavior);
      if (def?.r18) this.discover(c, 'returned', {by: 'return'}, 'returned');
      else if (POKE_INTERRUPTIBLE.has(a.state) && a.outfit !== 'clothed') this.foundReaction(c, 'returned', {by: 'return', naked: true}, 'returned');
    }
  }

  // ---------- 被点、被摸（R3.6，2026-10-21） ----------
  /**
   * 舞台报：用户在 id 身上点了一下 / 来回摸（part = 光标下部位图的序号，1 起，pack.json parts；没有部位图时为 null）。
   * 点中双人场景（id 是接受方）：按光标离谁近算谁，场景图没有部位图。
   * 躲在窗口后面的（自己躲着，或者两人在窗口后面做）：点到 / 摸到露出来的部分就算被发现（2026-10-21 用户定），和挡的窗口挪开一样
   * 走 discover / discoverDuo，不挑反应。
   * （开源版省略）
   * 挑到的反应（Brain.reaction）→ 算 effects、放 fx、sound；角色空着（POKE_INTERRUPTIBLE、在前面的层、不在双人里、
   * 计划不是 r18 的行为）而且反应写了 steps 时换成反应计划（行为名 reaction:<键>），否则只叠加（state-rules §3）。
   * 返回这次的结果（写事件日志用）；被拎着、掉着、不在场时返回 null。
   */
  poke(id: string, part: number | null, kind: PokeKind, cursor: Point): {who: string; part: string | null; reaction: string | null; overlay: boolean; cooling: boolean} | null {
    let who = id, partName: string | null = null;
    const d = this.duos.find(x => x.stage === 'play' && x.roles.receiver === id);
    if (d) {
      const sh = this.duoSheet(d), an = this.duoAnchor(d), f = this.duoFrame(d);
      const pos = (role: SceneRole) => an.x + sh.cast[role].dx[f] * d.k;
      who = Math.abs(cursor.x - pos('giver')) < Math.abs(cursor.x - pos('receiver')) ? d.roles.giver : d.roles.receiver;
    }
    const c = this.chars.get(who), a = c?.actor;
    if (!c || !a || POKE_IGNORED.has(a.state)) return null;
    if (!d && part) partName = c.pack.manifest.parts?.[part - 1] ?? null;
    const times = (this.pokeTimes.get(who) ?? []).filter(t => this.now - t < POKE_WINDOW);
    times.push(this.now);
    this.pokeTimes.set(who, times);
    const hidden = d ? d.layer : a.layer;
    // 躲着的被点到 = 被发现（躲在窗口后面的，和被盖住时就地躲着的、开播时就被盖着的双人，desktop-interaction §2.7）
    const hwnd = hidden.kind === 'behind' ? hidden.hwnd : (d ? d.coverHide?.hwnd : c.coverHide?.hwnd);
    if (hwnd !== undefined) {
      const out = {who, part: partName, reaction: 'discovered', overlay: false, cooling: false};
      this.extra.push({id: who, e: {type: 'poke', kind, ...out}});
      if (d) this.discoverDuo(d, 'clicked', {hwnd, by: 'click'});
      else this.discover(c, 'clicked', {hwnd, by: 'click'});
      return out;
    }
    const base = partName ? [`${kind}:${partName}`, kind] : [kind];
    const sex = !!d || a.state === 'sex' || a.state === 'masturbate';
    const r = c.brain.reaction(sex ? base.map(k => `sex:${k}`) : base, this.view(c), this.now, this.rng, {r18: this.opts.r18});
    const def = r?.def ?? null;
    const plan = c.brain.cfg.behaviors.find(b => b.id === a.plan?.behavior);
    const free = POKE_INTERRUPTIBLE.has(a.state) && a.layer.kind === 'front' && !this.duoOf(who) && !plan?.r18 && !a.plan?.behavior.startsWith('duo');
    const steps = def?.steps?.length && free ? this.templatesToSteps(c, def.steps) : [];
    const out = {who, part: partName, reaction: r?.key ?? null, overlay: !steps.length, cooling: !!r && !def};
    this.extra.push({id: who, e: {type: 'poke', kind, part: partName, reaction: out.reaction, overlay: out.overlay, cooling: out.cooling}});
    if (!def) return out;
    c.brain.applyEffects(def.effects);
    if (def.fx) this.fx.push({id: who, fx: def.fx, start: this.now});
    if (def.sound && c.pack.sfx) this.cues.push({id: who, voice: c.pack.sfx.voice, effect: def.sound, x: a.x, y: a.y, behind: false});
    if (steps.length) for (const e of setPlan(a, c.spec, {behavior: `reaction:${r!.key}`, steps}, this.ctx(), 'poked')) { this.onEvent(c, e); this.extra.push({id: who, e}); }
    return out;
  }

  // ---------- 拖拽 ----------
  grab(id: string, cursor: Point): void {
    // 点中双人场景（舞台报的是接受方的 id）：拎离光标近的那个人，先把他放到场景里自己的位置上
    const d = this.duos.find(x => x.stage === 'play' && x.roles.receiver === id);
    if (d) {
      const sh = this.duoSheet(d), an = this.duoAnchor(d), f = this.duoFrame(d);
      const pos = (role: SceneRole) => an.x + sh.cast[role].dx[f] * d.k;
      id = Math.abs(cursor.x - pos('giver')) < Math.abs(cursor.x - pos('receiver')) ? d.roles.giver : d.roles.receiver;
      d.pinned = an;
      this.standFromScene(d, f, [id]);
    }
    const c = this.chars.get(id), a = c?.actor;
    if (!c || !a) return;
    this.intentControl.releaseActor(id);
    for (const e of grabActor(a, c.spec, cursor, this.ctx())) { this.onEvent(c, e); this.extra.push({id, e}); }
    if (d) this.tickDuos();   // 马上拆，另一方这一帧就开始收尾（state-rules §7 第 15 条）
  }
  drag(cursor: Point): void {
    for (const a of this.actors) if (a.state === 'dragged') dragActor(a, cursor, this.ctx());
  }
  release(): void {
    for (const c of this.chars.values()) {
      const a = c.actor;
      if (a?.state === 'dragged') for (const e of releaseActor(a, c.spec, this.ctx())) this.extra.push({id: a.id, e});
    }
  }
  dragging(): boolean {
    return this.actors.some(a => a.state === 'dragged');
  }
  /**
   * 要不要 30 Hz 快速 tick：有角色在下落、被拖着、在跳（位置每 tick 都变），或者有特效、液体在落。
   * 站在窗口上、在窗口里面、躲在窗口后面不用（2026-10-21 以前要，靠每 tick 枚举窗口跟上）：窗口挪了由窗口事件叫醒主循环（main.ts、design.md §6）
   */
  needsFastTick(): boolean {
    return this.fx.length > 0 || this.fluids.falling() || this.actors.some(a => a.state === 'fall' || a.state === 'dragged' || a.state === 'jump');
  }
  /**
   * 角色跟着的窗口：站在顶边上、在里面、躲在后面（双人场景按场景的层）、正要去躲的、就地躲着时盖住她的。
   * main.ts 按这些窗口所在的进程收位置变化事件（platform 的 WindowWatch.followLocations），它们一挪马上重算
   */
  attachedWindows(): Set<number> {
    const out = new Set<number>();
    for (const c of this.chars.values()) {
      const a = c.actor;
      if (!a) continue;
      if (a.support && a.support.kind !== 'floor') out.add(Number(a.support.key.slice(a.support.key.indexOf(':') + 1)));
      if (a.layer.kind !== 'front') out.add(a.layer.hwnd);
      if (c.hideTarget) out.add(c.hideTarget.hwnd);
      if (c.coverHide?.hwnd) out.add(c.coverHide.hwnd);
    }
    for (const d of this.duos) {
      if (d.layer.kind !== 'front') out.add(d.layer.hwnd);
      if (d.coverHide?.hwnd) out.add(d.coverHide.hwnd);
    }
    return out;
  }

  /**
   * 不需要快速 tick 时，离下一次“画面或状态会变”还有几秒：所有角色里最早的那个——当前动作换下一帧的时刻，
   * 或当前状态计划结束的时刻（stateEnd）。不循环的动作播到最后一帧以后不再换帧。
   */
  secondsToNextChange(now: number): number {
    let next = Infinity;
    for (const c of this.chars.values()) {
      const a = c.actor;
      if (!a) continue;
      const info = c.spec.actions[a.action] ?? c.spec.actions.idle;
      const elapsed = Math.max(0, now - a.actionStart), f = Math.floor(elapsed * info.fps);
      if (info.loop || f < info.frames - 1) next = Math.min(next, (f + 1) / info.fps - elapsed);
      next = Math.min(next, a.stateEnd - now);
    }
    // 双人场景按场景的帧率换帧
    for (const d of this.duos) if (d.stage === 'play') {
      const fps = d.scene.manifest.fps, el = Math.max(0, now - d.since);
      next = Math.min(next, (Math.floor(el * fps) + 1) / fps - el);
    }
    // 液体：挂着的水珠变大 / 掉下去、水洼窄一个像素
    next = Math.min(next, this.fluids.secondsToNextChange(now));
    return Math.min(next, 5 - (now - this.lastUnlockCheck));
  }

  // ---------- 画 ----------
  /**
   * 每一层要画的东西。front：按显示器（坐标相对显示器左上角）；behind：按目标窗口 hwnd（坐标是绝对物理像素，rect 是
   * 要画的东西的总范围，main.ts 据此摆小窗口再换算成窗口内坐标）。moved：这一 tick 里位置必须跟上的角色（跟着窗口挪了）。
   * 角色和哪个显示器相交就画到哪个覆盖窗口上（跨屏时两边各画一半）；放大倍数按脚底点所在的显示器。
   * （开源版省略）
   */
  draws(moved: ReadonlySet<string>): {front: Map<number, DrawItem[]>; behind: Map<number, {items: DrawItem[]; rect: Rect}>;
    inside: Map<number, {items: DrawItem[]; rect: Rect}>; ground: Map<number, Blot[]>} {
    const front = new Map<number, DrawItem[]>(this.desktop.displays.map(d => [d.id, []]));
    const behind = new Map<number, {items: DrawItem[]; rect: Rect}>();
    // 在窗口里面的（N2.4）：画在插到那个窗口正上方的小窗口里，裁到窗口的矩形（clip）；范围只要窗口里面那部分
    const inside = new Map<number, {items: DrawItem[]; rect: Rect}>();
    const ground = new Map<number, Blot[]>(this.desktop.displays.map(d => [d.id, []]));
    const ringOf = (c: Character) => c.pack.variant(this.variantOf(c)).outline === 'full';
    const first = this.chars.values().next().value;
    if (first && this.opts.r18) for (const b of this.fluids.puddleBlots(this.desktop.windows, ringOf(first))) {
      for (const d of this.desktop.displays) {
        const db = d.bounds;
        if (b[0] + b[2] <= db.left || b[0] >= db.right || b[1] + b[3] <= db.top || b[1] >= db.bottom) continue;
        ground.get(d.id)!.push(shiftBlots([b], db.left, db.top)[0]);
      }
    }
    // 双人场景在播：接受方画场景精灵（锚点、场景的帧），给予方不画；两个人的特效都挂在场景上、各在自己的位置
    const playing = this.duos.filter(d => d.stage === 'play' && this.inDuo(d, d.inviter) && this.inDuo(d, d.partner));
    const hidden = new Set(playing.map(d => d.roles.giver));
    for (const c of this.chars.values()) {
      const a = c.actor;
      if (!a || hidden.has(a.id)) continue;
      const duo = playing.find(d => d.roles.receiver === a.id);
      const fxOf = (who: Actor, ch: Character, dx: number) => this.fx.filter(f => f.id === who.id)
        .map(f => ({fx: f.fx, t: +(this.now - f.start).toFixed(3), h: Math.round(heightPxOf(who, ch.spec, this.ctx())), ...(dx ? {dx: Math.round(dx)} : {})}));
      let sheet: string, frame: number, meta: {foot: [number, number]; footY?: number[]; cell: [number, number]; ids?: true}, at: Point, kk: number | null = null;
      // 这个角色（在播场景时是场景）用的那套画面变体：放大倍数、平滑缩放、特效和液体的一格（spritePx、artPx）
      let vo: PackVariant = this.charVariant(c);
      let fxItems: NonNullable<DrawItem['fx']>, bodyDx = 0;
      if (duo) {
        sheet = duo.scene.sheetPath(duo.variant, duo.facing); frame = this.duoFrame(duo); meta = this.duoSheet(duo);
        at = this.duoAnchor(duo); kk = duo.k; vo = duo.scene.manifest.variants.find(v => v.id === duo.variant) ?? vo;
        const g = this.actorOf(duo.roles.giver)!, gc = this.chars.get(duo.roles.giver)!;
        fxItems = [...fxOf(a, c, a.x - at.x), ...fxOf(g, gc, g.x - at.x)];
      } else {
        ({sheet, frame, meta} = this.soloFrame(c, a));
        // 特效挂在身体上（bodyX），不挂在模型原点上
        at = {x: a.x, y: a.y}; bodyDx = bodyX(a, c.spec, this.ctx()) - a.x; fxItems = fxOf(a, c, bodyDx);
      }
      let s = this.shown.get(a.id);
      const smooth = a.state === 'fall' || a.state === 'jump' || a.state === 'dragged' || moved.has(a.id);
      if (!s || s.sheet !== sheet || s.frame !== frame || smooth) this.shown.set(a.id, s = {sheet, frame, x: at.x, y: at.y});
      // 场景用放场景时定的倍数（duo.k），特效、液体的一格按同一个倍数换（artOf）
      const sc = this.scaleAt(c, s, vo), k = kk ?? sc.k, u = kk === null ? sc.u : artOf(kk, vo), {left, top} = cellOrigin(meta, frame, s.x, s.y, k);
      const r: Rect = {left, top, right: left + meta.cell[0] * k, bottom: top + meta.cell[1] * k};
      const hPx = heightPxOf(a, c.spec, this.ctx());
      // （开源版省略）
      const under: Blot[] = [], over: Blot[] = [];
      for (const [who, ch] of duo ? [[a, c], [this.actorOf(duo.roles.giver)!, this.chars.get(duo.roles.giver)!]] as const : [[a, c]] as const) {
        const dr = this.fluids.dripBlots(who.id, duo ? null : this.anchorsOf(ch, who, {x: s.x, y: s.y}), ringOf(ch));
        if (dr) { over.push(...dr.over); under.push(...dr.under); }
      }
      // （开源版省略）
      const paint = !duo && meta.ids && this.opts.r18 ? this.fluids.paint(a.id, a.outfit) : [];
      const item = (ox: number, oy: number): DrawItem => ({id: a.id, sheet, frame, x: Math.round(s!.x) - ox, y: Math.round(s!.y) - oy, k,
        ...(vo.style === 'smooth' ? {smooth: true as const, u} : {}),
        ...(fxItems.length ? {fx: fxItems} : {}), ...(under.length ? {under: shiftBlots(under, ox, oy)} : {}), ...(over.length ? {over: shiftBlots(over, ox, oy)} : {}),
        ...(paint.length ? {paint} : {})});
      if (a.layer.kind === 'behind' || a.layer.kind === 'inside') {
        // 特效画在头顶上方，给它留出地方
        let rr: Rect = {...r, top: Math.min(r.top, s.y - hPx * 1.5), left: Math.min(r.left, s.x + bodyDx - hPx * 0.6), right: Math.max(r.right, s.x + bodyDx + hPx * 0.6)};
        let it = item(0, 0), into = behind;
        if (a.layer.kind === 'inside') {
          const w = this.supports.find(x => x.key === `in:${(a.layer as {hwnd: number}).hwnd}`)?.rect;
          if (!w) continue;   // 窗口刚没了：这一帧不画，下一 tick 状态机让她回 front
          rr = {left: Math.max(rr.left, w.left), top: Math.max(rr.top, w.top), right: Math.min(rr.right, w.right), bottom: Math.min(rr.bottom, w.bottom)};
          if (rr.right <= rr.left || rr.bottom <= rr.top) continue;
          it = {...it, clip: [w.left, w.top, w.right - w.left, w.bottom - w.top]};
          into = inside;
        }
        const b = into.get(a.layer.hwnd);
        if (b) { b.items.push(it); b.rect = union(b.rect, rr); } else into.set(a.layer.hwnd, {items: [it], rect: rr});
        continue;
      }
      for (const d of this.desktop.displays) {
        const db = d.bounds;
        if (r.right <= db.left || r.left >= db.right || r.bottom <= db.top || r.top >= db.bottom) continue;
        front.get(d.id)!.push(item(db.left, db.top));
      }
    }
    return {front, behind, inside, ground};
  }

  /** 调试叠加层的数据（坐标换成相对该显示器） */
  debugFor(d: DisplayInfo, extra: string[]): DebugInfo {
    const b = d.bounds, local = (x: number, y: number) => [x - b.left, y - b.top];
    const round = (o: Readonly<Record<string, number>>) => Object.entries(o).map(([k, v]) => `${k} ${Math.round(v)}`).join(' ');
    return {
      windows: this.desktop.windows.filter(w => w.rect.right > b.left && w.rect.left < b.right && w.rect.bottom > b.top && w.rect.top < b.bottom)
        .map(w => ({rect: [w.rect.left - b.left, w.rect.top - b.top, w.rect.right - w.rect.left, w.rect.bottom - w.rect.top],
          label: `${w.hwnd} ${w.className}${w.topmost ? ' [置顶]' : ''}`})),
      supports: this.supports.filter(s => s.displayId === d.id).map(s => ({x0: s.x0 - b.left, x1: s.x1 - b.left, y: s.y - b.top, kind: s.kind})),
      actors: [...this.chars.values()].filter(c => c.actor && displayAt(this.desktop.displays, {x: c.actor.x, y: c.actor.y - 1}).id === d.id).map(c => {
        const a = c.actor!, [x, y] = local(a.x, a.y);
        return {id: a.id, x, y, lines: [`${a.id} ${a.state}${a.phase ? '/' + a.phase : ''} · ${a.action} · ${a.outfit} · epoch ${a.epoch}`,
          `行为 ${a.plan?.behavior ?? '—'}（剩 ${a.plan?.steps.length ?? 0} 步）  层 ${a.layer.kind === 'front' ? 'front' : `${a.layer.kind}:${a.layer.hwnd}`}`,
          `${round(c.brain.stats)}  好感 ${Object.entries(c.brain.relations).map(([k, v]) => `${k} ${Math.round(v.affection)}`).join(' ')}` +
            (Object.keys(c.brain.rates()).length ? `  额外/时 ${round(c.brain.rates())}` : ''),
          `脚 ${Math.round(a.x)},${Math.round(a.y)}  支撑 ${a.support?.key ?? '—'}  v ${Math.round(a.vx)},${Math.round(a.vy)}`,
          ...this.duos.filter(x => x.inviter === a.id).map(x => `双人 ${x.scene.manifest.id} 和 ${x.partner} · ${x.stage}` +
            (x.stage === 'play' ? ` · 帧 ${this.duoFrame(x)}（${Math.min(this.duoPos(x), x.program.length)}/${x.program.length}）${x.phase ?? ''}` : ` · ${(this.now - x.since).toFixed(0)} 秒`))]};
      }),
      lines: [`显示器 ${d.id}  ${b.right - b.left}×${b.bottom - b.top} @${d.scale}x  工作区底 ${d.workArea.bottom - b.top}`,
        `窗口 ${this.desktop.windows.length}  支撑面 ${this.supports.length}  变体 ${this.opts.variant}  高 ${this.opts.heightLogical} 逻辑像素  ${this.opts.r18 ? 'R18' : '全年龄'}`,
        `已解锁 ${this.unlocked.join(', ')}  累计 ${(this.playSeconds / 60).toFixed(1)} 分钟`, ...extra],
    };
  }

  /** 存档用（store/save.ts 的 SaveData 的一部分） */
  saveState(): {unlocked: string[]; playSeconds: number; chars: Record<string, {stats: Record<string, number>; relations: Record<string, {affection: number}>; outfit?: string}>} {
    const chars: Record<string, {stats: Record<string, number>; relations: Record<string, {affection: number}>; outfit?: string}> = {};
    for (const [id, c] of this.chars) chars[id] = {...c.brain.save(), ...(c.actor ? {outfit: c.actor.outfit} : {})};
    return {unlocked: [...this.unlocked], playSeconds: this.playSeconds, chars};
  }
}

/** Sim 自己产生的、状态机以外的事件（写进事件日志） */
export type SimEvent = ActorEvent
  | {type:'intent-plan';what:'cancelled';reason:string}
  | {type: 'unlocked'; forced: boolean}
  /** 用户在托盘里让它离开 / 回到桌面（setAbsent） */
  | {type: 'desktop'; present: boolean}
  /** 被别的窗口盖住一半以上 COVER_SEC 秒（desktop-interaction §2.7）：cover = 比例，hwnd = 盖住最多的窗口 */
  | {type: 'covered'; cover: number; hwnd: number}
  /** 脚下的窗口顶边 / 窗口里面的底边没了，为什么（Sim.explainLostSupports）；之后照常 support-gone 掉下来 */
  | {type: 'support-lost'; key: string; why: 'window-gone' | 'no-exit' | 'dropped'; rect: Rect | null; workArea: Rect; heightPx: number}
  /**
   * continued：行为的 discovered 规则成立、接着做完了（没有反应计划）；by: 'click' = 用户点到 / 摸到了躲着的她（没有 cover）；
   * by: 'return' = 用户回来撞见（N3.1，没有 hwnd；naked = 没在做 R18，只是离开期间脱光了还光着）
   */
  | {type: 'discovered'; hwnd?: number; cover?: number; by?: 'click' | 'return'; continued?: boolean; naked?: true}
  /** 双人：invite / declined / play / phase / done / broken / dissolved（带 scene、partner、原因等） */
  | {type: 'duo'; what: string; [k: string]: unknown}
  /** 被点 / 被摸：reaction = 用了哪个键（没有配的为 null）；overlay = 只叠加没换计划；cooling = 这个键还在冷却、没反应 */
  | {type: 'poke'; kind: PokeKind; part: string | null; reaction: string | null; overlay: boolean; cooling: boolean};

/** 被发现的来由，原样写进 discovered 事件 */
type FoundInfo = {hwnd?: number; cover?: number; by?: 'click' | 'return'; naked?: true};

const union = (a: Rect, b: Rect): Rect => ({left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom)});

function localTime(): {hour: number; weekday: number} {
  const d = new Date();
  return {hour: d.getHours() + d.getMinutes() / 60, weekday: d.getDay()};
}
