// behavior/ 的对外类型和常量（接口由主代理定）。坐标是物理像素（shared/types.ts），时间是秒。
//
// 阶段 1：自发的 idle / walk / sit，加上物理和拖拽：fall / land / downed / dragged。暂停（老板键、全屏）是全局的，
// 由 main/ 停掉 tick，不是角色状态。
// 阶段 2（2026-10-20）：主状态机改成“执行计划”——计划是一串步骤（Step），每步是一个语义状态 + 动作 + 时长 + 层 / 衣着变化；
// 计划由外面给（ctx.choose：行为系统按 behaviors.json 选，brain.ts），没给就用阶段 1 的内置选择（走 / 坐 / 站）。
// 物理状态（fall / land / downed / getup / dragged）不是计划步骤：进入它们就中止当前计划。
import type {Point} from '../shared/types.ts';
import type {Support} from '../world/index.ts';

/**
 * 主状态（state-rules.md §2.1）。物理类：fall land dragged downed getup；计划类：其余。
 *   act：一般的动作（挥手之类）  hide：躲在窗口后面（层 = behind）  discovered：被发现的反应
 * （开源版省略）
 *   jump：跳到另一段线段（N2.5，2026-10-21）：原地起跳 → 按重力走抛物线 → 落地动画；计划步骤，不是物理状态（落点没了才转下落）
 */
export type ActorState =
  | 'idle' | 'walk' | 'sit' | 'fall' | 'land' | 'dragged' | 'downed' | 'getup'
  | 'act' | 'hide' | 'discovered' | 'masturbate' | 'sex' | 'strip' | 'dress' | 'react' | 'jump';

export const PHYSICAL_STATES: ReadonlySet<ActorState> = new Set(['fall', 'land', 'dragged', 'downed', 'getup']);

/** R18 动作的阶段（state-rules §2.1） */
export type Phase = 'start' | 'loop' | 'climax' | 'end';

/**
 * 角色画在哪一层（docs/desktop-interaction.md §2.2）。
 *   front：每个显示器一个的置顶覆盖窗口（默认）；behind：单独的透明窗口插在窗口 hwnd 正下方（躲窗口，R2.3）；
 *   inside：在窗口 hwnd 里面（N2.4，2026-10-21）：透明窗口插在它正上方、画面裁到它的矩形里，站在它里面的底边（Support kind inside）。
 *   behind 跟着计划走（计划中止就回 front）；inside 跟着脚下走（站在窗口里面就一直是，出了窗口、被拎起来才回 front）。
 */
export type Layer = {kind: 'front'} | {kind: 'behind'; hwnd: number} | {kind: 'inside'; hwnd: number};
export const FRONT: Layer = {kind: 'front'};
export const sameLayer = (a: Layer, b: Layer) => a.kind === b.kind && (a.kind === 'front' || a.hwnd === (b as {hwnd: number}).hwnd);

/** 角色包里一个逻辑动作的帧信息（帧数和帧率跟画面变体无关） */
export interface ActionInfo {
  frames: number;
  fps: number;
  loop: boolean;
  /** 全年龄模式下不可选（R9.2） */
  r18?: boolean;
  /** 只在这几种衣着下有图（没写 = 角色包的全部衣着） */
  outfits?: readonly string[];
  /** 移动类动作（走、蹲着走）的地速：每秒走几个自己的身高；没写用 ActorSpec.walkHeightsPerSec */
  heightsPerSec?: number;
  /**
   * 髋骨轨迹（2026-10-22，design.md §3.10）：每个朝向逐帧，髋骨正下方的地面点在画面上相对脚底点（模型原点）的横向位置，
   * 单位是自己的身高，往右为正。换动作时按新旧两帧的差挪脚底点，身体不跳（actor.ts keepHip）。没写 = 全是 0
   */
  hip?: Readonly<Partial<Record<'right' | 'left', readonly number[]>>>;
}

/**
 * 过渡（2026-10-22，design.md §3.10；scripts/export-pack/bake_clips.py 的 transitions）：换到动作 to 的时候，现在的动作和帧在
 * entries 里（姿势和过渡的第 0 帧差不多），就先播 action（不循环，最后一帧 = to 的第 0 帧）。from 是导出时取起点姿势的动作。
 */
export interface Transition {
  from: string;
  to: string;
  action: string;
  entries: Readonly<Record<string, readonly number[]>>;
}

/**
 * 状态 → 动作名。步骤没指定动作、或角色包没有某个动作时，按这里的顺序回退（第一个存在的）；idle 必须有。
 *   idle: idle    walk: walk → idle    sit: sit（没有就不进 sit）    fall: fall → idle
 *   land: land → idle    downed: downed → idle    dragged: dragged → fall → idle    getup: getup（没有就跳过）
 *   hide: crouch → idle    其余计划类状态默认 idle（一般由步骤指定动作）
 */
export const ACTION_FALLBACK: Readonly<Record<ActorState, readonly string[]>> = {
  idle: ['idle'],
  walk: ['walk', 'idle'],
  sit: ['sit'],
  fall: ['fall', 'idle'],
  land: ['land', 'idle'],
  downed: ['downed', 'idle'],
  dragged: ['dragged', 'fall', 'idle'],
  getup: ['getup'],
  act: ['idle'],
  hide: ['crouch', 'idle'],
  discovered: ['idle'],
  masturbate: ['masturbate', 'idle'],
  sex: ['idle'],
  strip: ['strip', 'idle'],
  dress: ['idle'],
  react: ['idle'],
  jump: ['jump_air', 'fall', 'idle'],
};

/** 可调参数。长度单位是逻辑像素（DIP），用的时候乘当前位置的 Metrics.scale 换成物理像素；时长是秒。 */
export interface Tuning {
  /** 重力，DIP/s²。Shimeji 默认每 40 ms 加 2 px → 1250 */
  gravity: number;
  /** 空气阻力，速度每秒乘 exp(-k)。Shimeji 每 40 ms ×0.95 / ×0.9 → x 1.28、y 2.63 */
  dragX: number;
  dragY: number;
  /** 抛出初速度上限，DIP/s */
  maxThrowSpeed: number;
  /** 落地竖直速度超过它（DIP/s）就摔倒（downed），否则只播 land */
  hardLandingSpeed: number;
  landSec: number;
  downedSec: readonly [number, number];
  idleSec: readonly [number, number];
  sitSec: readonly [number, number];
  sitCooldown: number;
  /** 内置选择（没有行为系统时）：走完一段后换下一个状态时，选 walk / sit / idle 的权重 */
  weights: Readonly<{walk: number; sit: number; idle: number}>;
  /** walk 没给目标时（随便逛），故意走出线段端点掉下去的概率（R2.1“会从窗口边掉下去”）；地面线段不往外走 */
  walkOffEdgeChance: number;
  /** 一次 walk 最长走多少秒（state-rules §2.1：最多 60） */
  walkMaxSec: number;
  /**
   * 站着的窗口挪动时：位移在阈值内就跟着走，超过就掉下来（state-rules §2.3，Shimeji 的阈值，DIP）。
   * |dx| < followMaxDx，且 -followMaxUp < dy < followMaxDown 才跟。
   */
  followMaxDx: number;
  followMaxDown: number;
  followMaxUp: number;
  /**
   * 跳（N2.5，2026-10-21；docs/desktop-interaction.md §2.4）：按自己的身高算。jumpUpHeights 一次最多往上（设想文档的 1.5，待按真实尺寸调），
   * jumpSideHeights 起跳点和落点横着最多差多少，jumpArcHeights 抛物线顶点比两头较高的那头再高多少。空中按 gravity 走（不算阻力）
   */
  jumpUpHeights: number;
  jumpSideHeights: number;
  jumpArcHeights: number;
  /** 窗口里面的底边离窗口下沿多高（DIP，窗口边框）；Support kind inside */
  insideInset: number;
}

export const DEFAULT_TUNING: Tuning = {
  gravity: 1250,
  dragX: 1.28,
  dragY: 2.63,
  maxThrowSpeed: 2500,
  hardLandingSpeed: 420,   // 终端速度 ≈ gravity / dragY ≈ 475，取 420：自由落体约 2 个身高以上才摔倒（原来 900 永远摔不倒，单测发现）
  landSec: 0.35,
  downedSec: [2, 5],
  idleSec: [3, 20],
  sitSec: [10, 90],
  sitCooldown: 30,
  weights: {walk: 5, sit: 1, idle: 2},
  walkOffEdgeChance: 0.15,
  walkMaxSec: 60,
  followMaxDx: 80,
  followMaxDown: 20,
  followMaxUp: 80,
  jumpUpHeights: 1.5,
  jumpSideHeights: 3,
  jumpArcHeights: 0.35,
  insideInset: 2,
};

/** 一个角色的静态配置（main/ 从角色包组装） */
export interface ActorSpec {
  id: string;
  /** 逻辑动作名 → 帧信息 */
  actions: Readonly<Record<string, ActionInfo>>;
  /** 走路速度：每秒走几个“自己的身高”。导出时按走路片段的脚步算好（脚不打滑） */
  walkHeightsPerSec: number;
  /** 角色半宽 / 自己的身高：走到线段端点时脚底点离端点至少留这么宽（不故意走下去的时候） */
  halfWidthRatio: number;
  /** 自己的身高 / 基准角色的身高（角色包 heightRatio；所有角色共用一个比例尺，见 design.md §3.4）；没写 = 1 */
  heightRatio?: number;
  /** 动作之间的过渡（角色包 transitions）；没有 = 换动作一律硬切（身体照样按 hip 对齐） */
  transitions?: readonly Transition[];
  tuning: Tuning;
}

/** 某个位置上的尺度：在哪个显示器、DIP → 物理像素的倍数、基准角色在那里的显示高度（物理像素） */
export interface Metrics {
  displayId: number;
  scale: number;
  /** 基准角色的显示高度；某个角色自己的 = heightPx × spec.heightRatio */
  heightPx: number;
}

/**
 * 计划里的一步（具体的，已经按世界解析好了；模板见 brain.ts 的 StepTemplate）。
 * 开始时：换层（layer）、换衣着（outfit，带遮挡特效）、放特效（fx），再进 state 播 action。
 * 结束：walk 走到 targetX（没给就随便逛，见 Tuning.walkOffEdgeChance）；给了 sec 就到时结束；
 * 没给 sec 时，不循环的动作播完一遍结束，循环动作一直播（等外面结束，如双人场景由 duo 控制）。
 */
export interface Step {
  state: ActorState;
  /** 角色包的逻辑动作；没写按 ACTION_FALLBACK[state] */
  action?: string;
  sec?: number;
  targetX?: number;
  /** Final walking destination for the visible body center; targetX remains the navigation/model origin. */
  targetBodyX?: number;
  phase?: Phase;
  layer?: Layer;
  outfit?: string;
  fx?: Fx;
  /** 开始时转向（1 朝右、-1 朝左）；躲窗口时背对窗口，露出来的那一侧是正面 */
  facing?: 1 | -1;
  /** 开始前请 ctx.guard 检查（如躲的窗口还在、还挡得住）；不通过就中止计划 */
  guard?: string;
  /** state jump 的落点：线段 key 和脚底 x（起跳完按 key 找回那段，窗口挪了就跟着挪；没了这一步算做不了） */
  jump?: {key: string; x: number};
  /** （开源版省略） */
  outfitAt?: {sec: number; to: string};
  /** 状态机自己插的过渡（ActorSpec.transitions）：真正的那一步紧跟在计划开头；只在 actor.ts 里用 */
  via?: true;
}

/** 放在角色身上的一次性特效（舞台画）：puff = 一团烟（换衣着时挡住）、alert = 头顶感叹号、heart = 心 */
export type Fx = 'puff' | 'alert' | 'heart';

export interface Plan {
  /** Goal chains must fail on missing steps or movement timeout, never skip a prerequisite. */
  strict?: boolean;
  /** 来自哪个行为（behaviors.json 的 id；内置选择是 'builtin:<状态>'），结束 / 中止时报给行为系统 */
  behavior: string;
  steps: Step[];
}

/** 每次 tick 由 main/ 传进来的外部世界 */
export interface WorldContext {
  /** 单调时钟，秒 */
  now: number;
  /** 这一刻的全部支撑面（world.computeSupports 的结果） */
  supports: readonly Support[];
  /** 某点的尺度（点不在任何显示器里时用最近的显示器） */
  metricsAt(p: Point): Metrics;
  /**
   * 显示器 bounds 列表（物理像素）。身体不能飞出所有显示器：fall 时脚底点横向撞到“外面没有显示器”的边就反弹（vx 取反减半）；
   * 头顶可以短暂出屏；落到所有地面以下（比如从两个显示器的缝里掉出去）就放到离得最近的那个显示器的地面上。
   */
  displayBounds: readonly {displayId: number; left: number; top: number; right: number; bottom: number}[];
  /** [0, 1) 随机数；测试时注入固定种子 */
  rng(): number;
  /**
   * 点 p 上最上面的窗口的 hwnd（按 z 序，置顶窗口、不当房间的窗口也算；没有窗口 = null）。松手时用它认“光标下最上面的窗口”：
   * 它不是房间（比如最大化的窗口出不来，不当房间）就不落进它底下被盖住的窗口里
   * （用户 2026-10-29：把她透过最大化窗口放进了看不见的窗口）。没有这个钩子（单测里直接拼的 ctx）时不判，取第一个包含该点的房间。
   */
  windowAt?(p: Point): number | null;
  /**
   * 角色空下来（计划走完、或物理状态结束回到站着）时要下一个计划。返回 null 时站一会儿（idleSec）再问。
   * 没有这个钩子时用内置选择（Tuning.weights 的走 / 坐 / 站，阶段 1 的行为）。
   */
  choose?(a: Actor): Plan | null;
  /** 步骤开始前的检查（Step.guard）：返回中止原因，或 null 表示可以 */
  guard?(a: Actor, step: Step): string | null;
  /**
   * 计划结束（走完、中止）的那一刻马上调，在挑下一个计划（choose）之前：Sim 在这里算结束效果、接续（next）、记“刚做完 R18”的时刻。
   * 2026-10-21 以前这些只在 plan-end 事件里做，事件要等 stepActor 返回以后才处理，比同一步里挑下一个计划晚：
   * （开源版省略）
   */
  ended?(a: Actor, behavior: string, outcome: 'done' | 'aborted'): void;
}

export interface Actor {
  /** Accumulated pose alignment of the model origin, excluded when measuring locomotion. */
  poseOffsetX?: number;
  readonly id: string;
  state: ActorState;
  /** 脚底点（物理像素），见 world.Support 的约定 */
  x: number;
  y: number;
  /** 速度，物理像素 / 秒（fall 时用） */
  vx: number;
  vy: number;
  /** 1 = 朝右，-1 = 朝左 */
  facing: 1 | -1;
  /** 站着的线段；fall / dragged 时为 null */
  support: Support | null;
  /** 当前播的动作名（已经按 ACTION_FALLBACK 回退过）和它开始的时刻 */
  action: string;
  actionStart: number;
  /** 当前状态开始的时刻、计划结束的时刻（没有计划时为 Infinity） */
  stateStart: number;
  stateEnd: number;
  /** walk 的目标 x；其他状态为 null */
  targetX: number | null;
  /** 主状态每变一次加 1（state-rules §4.1 的 epoch） */
  epoch: number;
  /** 正在执行的计划（behavior）和剩下的步骤；step = 当前这一步（物理状态时为 null） */
  plan: Plan | null;
  step: Step | null;
  phase: Phase | null;
  layer: Layer;
  /** 衣着（角色包 outfits 之一），决定用哪套精灵 */
  outfit: string;
}

export type ActorEvent =
  | {type: 'state'; from: ActorState; to: ActorState; reason: string}
  | {type: 'landed'; supportKey: string; impactDip: number}
  | {type: 'followed'; supportKey: string; dx: number; dy: number}
  | {type: 'plan'; behavior: string; steps: number}
  | {type: 'plan-end'; behavior: string; outcome: 'done' | 'aborted'; reason: string}
  | {type: 'layer'; layer: Layer}
  | {type: 'outfit'; outfit: string}
  | {type: 'fx'; fx: Fx}
  /** 起跳离地（N2.5）：要落到哪段、横 / 竖差多少（物理像素） */
  | {type: 'jumped'; supportKey: string; dx: number; dy: number};
