// 行为系统的配置和接口类型（接口由主代理定；实现在 brain.ts）。R3.1–R3.5、state-rules.md §2.2。
//
// 每个角色包有一份手写的 packs/<id>/behaviors.json（MindConfig，入库；pack.json 是导出脚本生成的，两者分开）：
//   状态值（欲望、体力、心情……）怎么随时间变、好感、解锁条件、接不接受邀请、偏好行为（条件、权重、冷却、下一步、步骤）。
// 条件和权重用 JSON Logic（json-logic-js，MIT；是数据，不执行代码），能引用的变量见 MindView。
// 行为选中后由 main/sim.ts 把步骤模板（StepTemplate）按当时的世界解析成具体步骤（behavior/types.ts 的 Step）交给状态机。
import type {ActorState, Fx, Phase} from './types.ts';

/** JSON Logic 表达式（https://jsonlogic.com/），如 {">=": [{"var": "self.stats.desire"}, 60]} */
export type Logic = unknown;
/** 一个数，或 [下限, 上限] 之间均匀随机 */
export type Range = number | readonly [number, number];

export interface StatDef {
  start: number;
  /** 默认 0 / 100 */
  min?: number;
  max?: number;
  /** 每小时自己变多少（可以是负数）；默认 0 */
  perHour?: number;
  /** 有 toward 时，每小时往 toward 靠 towardPerHour（不越过它），和 perHour 叠加 */
  toward?: number;
  towardPerHour?: number;
  /**
   * 有条件的变化：when（JSON Logic，看自己的 MindView）成立的期间每小时再变 perHour，和上面的叠加（2026-10-20 加快双人节奏：
   * （开源版省略）
   */
  rates?: readonly {when: Logic; perHour: number}[];
}

/** 效果：键是 "stats.<名字>" 或 "relations.<对象>.affection"（对象是 user、角色 id，或 "$partner" = 双人行为的另一方）；值是加减量，结果夹在范围内（好感 0..100） */
export type Effects = Readonly<Record<string, number>>;

/** 步骤模板（behaviors.json 里写的），sim.ts 按世界解析成 Step */
export type StepTemplate =
  /** 站着 */
  | {do: 'idle'; sec: Range}
  /** 在当前线段上随便走一段（可能故意走出端点掉下去，R2.1） */
  | {do: 'wander'; action?: string}
  /** 坐着 */
  | {do: 'sit'; sec: Range}
  /** 播一个动作：给了 sec 就播这么久，没给就播一遍（循环动作没给 sec 时一直播，一般不这么写）。state 默认 act */
  | {do: 'play'; action: string; sec?: Range; state?: ActorState; phase?: Phase; fx?: Fx}
  /** 找一个能躲的窗口（遮挡比例在 cover 里，默认 [0.35, 0.85]）并走过去（action 默认 walk，可以写 crouchwalk）；找不到就中止 */
  | {do: 'gotoHide'; cover?: readonly [number, number]; action?: string}
  /** 躲进刚才找到的窗口后面（层 = behind），播 action（默认 crouch）sec 秒 */
  | {do: 'hide'; action?: string; sec?: Range}
  /** 回到最前面的层 */
  | {do: 'unhide'}
  /** 换衣着（带一团烟挡住，state-rules §6） */
  | {do: 'outfit'; to: string}
  /**
   * 走到 who 身边（不在同一条线段上时按导航走、跳过去，world/nav.ts；到不了这个行为就做不了）：停在对方靠自己这一侧 gap 个身高（默认 [0.8, 1.5]）处，转向对方站 sec 秒
   * （默认 [5, 12]）。2026-10-20 加快双人节奏用：想对方了就凑过去，待在一起触发 StatDef.rates 里的“离得近”。
   */
  | {do: 'approach'; who: string; gap?: Range; sec?: Range; action?: string}
  /** 跳着玩（N2.5，2026-10-21）：跳到一跳能到的另一段（窗口顶边、地面；往上的权重翻倍），没有就做不了。在窗口里面时不用这个，用 leave */
  | {do: 'hop'}
  /** 跳进脚下这个窗口里面（N2.4，inside:W）：站在窗口顶边、这个窗口能进（够高够宽、不是置顶）才行 */
  | {do: 'enter'}
  /** 从窗口里面出来：从侧边跳出去（窗口矮的话也能跳回顶边），随机挑一个出口；出不去（最大化、贴着屏幕边）就做不了 */
  | {do: 'leave'}
  /**
   * 被盖住的反应（docs/desktop-interaction.md §2.7，2026-10-21）用的三种：
   * emerge：走到当前线段上没被盖住的地方（被盖住的比例 ≤ 0.15，最近的那个；action 默认 walk）；线段上没有、又在窗口里面，就从窗口里跳出来；都不行就做不了。
   * peek：走到被盖住 cover（默认 [0.35, 0.65]）的地方（最近的），朝露出来的那边，播 action（默认 idle）sec 秒（默认 [4, 10]）：探头。
   * hideHere：就在这里当成躲着（state hide，播 action 默认 idle，sec 默认 [1, 2]）：之后这个计划里的事都算“躲着做”——声音闷一点，
   *   盖住的窗口挪开（被盖住的比例掉到 0.12 以下）或者被点到就算被发现（和躲在窗口后面一样走 discovered 的规则）。计划结束就不算躲了。
   */
  | {do: 'emerge'; action?: string}
  | {do: 'peek'; action?: string; walkAction?: string; sec?: Range; cover?: readonly [number, number]}
  | {do: 'hideHere'; action?: string; sec?: Range};

/**
 * 双人行为（R3.2、R1.6、state-rules §2.4）：邀请 with 里的某个角色，按 scenes 里的场景做（sim.ts 的 Duo：问对方 accept → 两人走到
 * （开源版省略）
 * 邀请方和对方，谁是接受方由场景定。
 */
export interface DuoTemplate {
  kind: 'sex';
  /** 可以邀请的角色 id（要已解锁、在场、空着、在同一条线段上） */
  with: readonly string[];
  /** 场景 id（packs/_scenes/ 里的），在这条线段上放得下的里面随机选一个 */
  scenes: readonly string[];
  /** 每个能绕圈的 loop 段（scene.json loopable）额外多绕几圈；默认 [0, 2] */
  loops?: Range;
  /** 被拒（对方 accept 不成立）或场景放不下时，这个行为冷却几秒（不用 BehaviorDef.cooldown，那是做成以后的）；默认 180 */
  declineCooldown?: number;
}

export interface BehaviorDef {
  id: string;
  /** 基础权重：数，或 JSON Logic 表达式（结果当数用，负数和非数当 0） */
  weight: number | Logic;
  /** 条件（JSON Logic，结果为真才可选）；没写 = 总是可选 */
  when?: Logic;
  /** Routine preference (physiology/personality). Rules require it; an explicit model choice may override it. */
  prefer?: Logic;
  /** 开始后多少秒内不再选它（默认 0） */
  cooldown?: number;
  /** R18 行为：全年龄模式下不可选（R9.2） */
  r18?: boolean;
  /** 正常结束后，下一个只能在这些行为里选（Shimeji 的 NextBehaviorList，串“走到窗边 → 躲进去 → 探头”）；里面都不可选时照常选 */
  next?: readonly string[];
  /** 步骤（和 duo 二选一） */
  steps?: readonly StepTemplate[];
  duo?: DuoTemplate;
  effects?: {start?: Effects; end?: Effects; interrupt?: Effects};
  /** 躲着做这个行为时被发现（用户回来撞见也算，N3.1），要不要接着做完（见 KeepOnDiscovered）；没写 = 照常走 reactions.discovered / returned */
  discovered?: KeepOnDiscovered;
}

/**
 * 躲在窗口后面做某个行为时被发现（窗口挪开、最小化、关了）：when（JSON Logic，看 MindView；self.phase / self.stepSec 是当前这一步的
 * 阶段和做了几秒）成立就不停——回到前面的层、冒个特效（fx，默认 alert），当前 loop 段剩下的时间截到 hurry 秒以内（没写不截）、
 * 后面的 loop 段跳过，接着做完；计划照常算完成（end 效果照算），另加 effects。不成立照常走 reactions.discovered。
 * （开源版省略）
 */
export interface KeepOnDiscovered {
  when: Logic;
  hurry?: Range;
  fx?: Fx;
  effects?: Effects;
}

/**
 * 反应（事件 → 一串步骤 + 效果）。reactions 的键：
 *   discovered：躲着被发现（只用 steps、effects）；
 *   returned：用户回来撞见离开期间在明处做的事（N3.1，2026-10-21；只用 steps、effects，没写用 discovered）；
 *   click:<部位> / stroke:<部位>（R3.6，2026-10-21）：被点一下、被来回摸（部位名是 pack.json 的 parts，scripts/export-pack/parts.mjs）；
 *   click / stroke：没写那个部位的、或点在没有部位图的地方时用；
 * （开源版省略）
 *   没写就什么都不做（不落回平时的反应）。
 * 躲在窗口后面被点到 / 摸到不挑反应，算被发现（discovered，2026-10-21 用户定；sim.ts poke）。
 * 值可以是一个或一串：一串时在 when 成立、全年龄模式下不是 r18 的里面按 weight 随机挑一个（Brain.reaction）；一个都不成立就用下一个键
 * （click:chest → click）；这个键还在冷却（cooldown，默认 2 秒，state-rules §2.1 “同部位 2 秒”）时什么都不做。
 * 角色空着（站、走、坐、一般的动作、上一个反应）时按 steps 换成反应计划（state 写 react）；在做 R18、双人、被拎着、摔倒、换衣服时
 * 不换计划，只放 fx、sound、算 effects（state-rules §3 “点击叠加”）。steps 不写也只叠加。
 */
export interface ReactionDef {
  steps?: readonly StepTemplate[];
  effects?: Effects;
  when?: Logic;
  /** 默认 1 */
  weight?: number | Logic;
  r18?: boolean;
  cooldown?: number;
  /** 头顶特效（叠加和换计划都放） */
  fx?: Fx;
  /** 原版音效规则里这个角色的 effect 名（packs/_sfx/sfx.json 的 voices.<角色包 sfx.json 的 voice>.events），叠加和换计划都放 */
  sound?: string;
}

export interface MindConfig {
  /** Words excluded from generated dialogue; omitted preserves the built-in default, [] disables it for this pack. */
  dialogueBanned?: readonly string[];
  schema: 1;
  stats: Readonly<Record<string, StatDef>>;
  /** 初始好感（对象 → 0..100）；没写的对象按 50 */
  relations?: Readonly<Record<string, {affection: number}>>;
  /** 解锁条件（JSON Logic，看 UnlockView）；没写或 null = 一开始就有（R3.3） */
  unlock?: Logic | null;
  /**
   * 用户没在托盘里给这个角色选过“在桌面上”（设置 onDesktop 里没有它，src/main/settings.ts absentIds）时，它默认在不在桌面上
   * （2026-10-22 用户：可以自选场景内角色）；没写 = present。新加的角色写 absent，装进去以后桌面上不会突然多一个人
   */
  desktopDefault?: 'present' | 'absent';
  /** 接不接受别人的邀请：键是 DuoTemplate.kind（如 sex），JSON Logic 看自己的 MindView（others 里有邀请方）+ inviter；没写 = 接受 */
  accept?: Readonly<Record<string, Logic>>;
  /** 反应：discovered（躲着被发现）、returned（用户回来撞见）、click:<部位> / stroke:<部位>（被点、被摸）……，见 ReactionDef */
  reactions?: Readonly<Record<string, ReactionDef | readonly ReactionDef[]>>;
  behaviors: readonly BehaviorDef[];
}

/** 一个角色在 JSON Logic 里看到的世界（sim.ts 每次决策时现做）。变量写法：{"var": "self.stats.desire"} */
export interface MindView {
  self: {
    id: string;
    state: ActorState;
    outfit: string;
    /** inside：在某个窗口里面（N2.4，2026-10-21） */
    layer: 'front' | 'behind' | 'inside';
    /** 脚下是什么：地面、窗口顶边、窗口里面的底边；在空中为 null */
    support: 'floor' | 'window' | 'inside' | null;
    /** 当前计划这一步的阶段（R18 动作的 start / loop / climax / end，state-rules §2.1）；没有为 null */
    phase: Phase | null;
    /** 当前这一步（状态）开始了几秒 */
    stepSec: number;
    /** （开源版省略） */
    afterSexSec: number;
    stats: Readonly<Record<string, number>>;
    relations: Readonly<Record<string, {affection: number}>>;
  };
  /** 本地时间：hour 是 0..24 的小数（14.5 = 下午两点半），weekday 0 = 周日 */
  time: {hour: number; weekday: number};
  mode: {r18: boolean};
  env: {
    /** 当前线段上能躲的位置有几个（world/visibility.findHideSpots 的结果数） */
    hideSpots: number;
    /**
     * 被别的窗口盖住（docs/desktop-interaction.md §2.7，2026-10-21）：covered 是现在包围盒被盖住的比例（0..1；在最前面那层时只算 z 序在
     * 桌宠上面的置顶窗口，在窗口里面时算比那个窗口高的窗口；躲在窗口后面、在空中时是 0）；coveredSec 是连续被盖住一半以上几秒（没有就 0）
     */
    covered: number;
    coveredSec: number;
  };
  /** 其他角色（已解锁且在场的才有 present: true）；free = 可以被邀请（state-rules §2.4 第 2 条的状态） */
  others: Readonly<Record<string, {present: boolean; free: boolean; state: ActorState; outfit: string; stats: Readonly<Record<string, number>>;
    /** 够得着：在同一条线段上，或者按导航走、跳得过去（N2.5；对方躲在窗口后面不算） */
    reachable: boolean;
    /**
     * 两人脚底点的距离，以自己的身高为单位：同一条线段上是横向距离，不在同一段但够得着是直线距离，够不着（或不在场）是 Infinity
     * （2026-10-22 以前这里写“不在同一条线段上是 Infinity”，代码早就按够得着算了）
     */
    dist: number}>>;
  /**
   * 用户（N3.1，2026-10-21）：idleSec = 多少秒没碰键盘鼠标（解锁那一刻算一次输入）；away = 离开了（锁屏 / 屏保 / 切到别的用户，
   * 或者 5 分钟——设置 awayAfterSec——没碰键鼠，main/away.ts）；locked = 是锁屏那种（一定不在）；awaySec = 离开了几秒（在的时候 0）。
   * 离开期间开始的 R18 行为，回来时还在明处做就算被撞见（reactions.returned）。
   * pokes：最近 60 秒里用户点 / 摸了这个角色几次（含这一次；被点烦了可以按它换反应）
   */
  user: {idleSec: number; away: boolean; locked: boolean; awaySec: number; pokes: number};
  /** 这次存档累计玩了多少分钟 */
  playMinutes: number;
  /** 只在 accept 里有：邀请方 id */
  inviter?: string;
}

/** 解锁条件看到的（全局的，不属于哪个角色） */
export interface UnlockView {
  /** 已解锁角色的状态值和好感（没解锁的不在里面） */
  chars: Readonly<Record<string, {stats: Readonly<Record<string, number>>; relations: Readonly<Record<string, {affection: number}>>}>>;
  playMinutes: number;
  time: {hour: number; weekday: number};
  mode: {r18: boolean};
}

/** 存档里每个角色的部分（store/ 读写；冷却、“下一步”只在内存里） */
export interface SavedMind {
  stats: Record<string, number>;
  relations: Record<string, {affection: number}>;
}
