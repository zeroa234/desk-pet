// 假角色包 + 假双人场景 + 双人测试的驱动（只给单测用）。
// 不读 packs/ 下的文件：图集是导出生成物，别的机器上没有。角色包、场景都按 src/pack/index.ts 的接口在内存里造。
// 尺度：变体 renderHeight 40、显示高度 120 逻辑像素、显示器 scale = 1 → k = 120 / 40 = 3；
// 假角色包的动作表、图集帧表都很小，只有双人流程用得到的东西（idle / walk / fall / dragged / wave）。
import type {ActionInfo, Tuning} from '../../src/behavior/index.ts';
import {DEFAULT_TUNING} from '../../src/behavior/index.ts';
import type {MindConfig} from '../../src/behavior/mind.ts';
import type {Facing, Pack, PackManifest, PackSfx, SceneManifest, ScenePack, SceneRole, SceneSegment, SceneSheetMeta, SceneSfx, SheetMeta} from '../../src/pack/index.ts';
import type {AfterFlow, FluidSource} from '../../src/fluid/index.ts';
import type {SimEvent} from '../../src/main/sim.ts';
import {Sim} from '../../src/main/sim.ts';
import type {DisplayInfo, Point, WinInfo} from '../../src/shared/types.ts';
import {makeDisplay, mulberry32, rect} from './fake-desktop.ts';

/** 时间步长（秒）：正式单测和 main/ 一样 30 Hz */
export const DT = 1 / 30;
/** 显示器 1 的地面 y（1080 高、底部 40 px 任务栏） */
export const FLOOR_Y = 1040;
/** 假场景的帧率 */
export const SCENE_FPS = 15;
/** 假角色包 / 假场景共用的变体 */
export const SCENE_VARIANT = 'v';
/** 每个渲染像素占几个物理像素（120 逻辑像素 / renderHeight 40） */
export const K = 3;

const VARIANTS = [{id: SCENE_VARIANT, renderHeight: 40, outline: 'full' as const}];

// ---------- 假角色包 ----------

/** 假角色包的动作表：帧数 / 帧率随便但合理；walk 有地速 */
const ACTIONS: Readonly<Record<string, ActionInfo & {clip: string}>> = {
  idle: {frames: 24, fps: 12, loop: true, clip: 'idle'},
  walk: {frames: 8, fps: 12, loop: true, clip: 'walk'},
  fall: {frames: 6, fps: 12, loop: true, clip: 'fall'},
  dragged: {frames: 6, fps: 12, loop: true, clip: 'dragged'},
  wave: {frames: 12, fps: 12, loop: false, clip: 'wave'},
};
const DEFAULT_OUTFITS = ['clothed', 'nude'];

export interface FakePackOptions {
  id: string;
  mind: MindConfig;
  /** 每秒走几个自己的身高；默认 1.5 */
  walkHeightsPerSec?: number;
  /** sfx.json（音效规则里的角色 + 每个动作哪一帧有哪个 effect）；不写 = 不出声（null） */
  sfx?: PackSfx | null;
  /**
   * （开源版省略）
   * 和导出的帧表一样，只给 nude 这类会滴水的衣着。
   */
  drip?: Partial<Record<string, [number, number, 0 | 1]>>;
  /** （开源版省略） */
  ids?: readonly string[];
  /** 动作的 stains（pack.json 的 actions.<动作>.stains：不循环的动作播到最后一帧时沾上的表面格子编号） */
  stains?: Record<string, number[]>;
  /** （开源版省略） */
  wet?: number[][];
  /** 帧表的 anchors：按衣着给每个出口的点，每一帧同一个点 */
  anchors?: Partial<Record<string, Record<string, [number, number, 0 | 1]>>>;
  /** pack.json 的 fluidSources */
  sources?: Record<string, FluidSource>;
  /** 动作的 after（pack.json 的 actions.<动作>.after：不循环的动作播到最后一帧时从哪个出口往外流） */
  after?: Record<string, AfterFlow[]>;
  /** pack.json 的部位图序号 → 名字（序号 1 = parts[0]）；不写 = 这个包没有部位图（旧包） */
  parts?: readonly string[];
  /** （开源版省略） */
  floor?: Record<string, [number, number, 0 | 1, number][]>;
  /** 衣着（从穿得多到穿得少排）；默认 ['clothed', 'nude'] */
  outfits?: readonly string[];
  /** （开源版省略） */
  extraActions?: Readonly<Record<string, ActionInfo & {clip: string; switchSec?: number}>>;
}

/** 按 Pack 接口造一个内存里的角色包（不读文件、不碰 electron） */
export function makePack(opts: FakePackOptions): Pack {
  const id = opts.id, relDir = `packs/${id}`, walkHeightsPerSec = opts.walkHeightsPerSec ?? 1.5;
  const outfits = [...(opts.outfits ?? DEFAULT_OUTFITS)];
  const actions: Record<string, ActionInfo & {clip: string; stains?: number[]; switchSec?: number}> = {};
  for (const [name, a] of Object.entries({...ACTIONS, ...opts.extraActions})) {
    actions[name] = {...a, ...(name === 'walk' ? {heightsPerSec: walkHeightsPerSec} : {}),
      ...(opts.stains?.[name]?.length ? {stains: [...opts.stains[name]]} : {}), ...(opts.after?.[name]?.length ? {after: opts.after[name].map(f => ({...f}))} : {})};
  }
  const manifest: PackManifest = {
    schema: 1, id, name: `假角色 ${id}`, aliases: [], adult: true, restHeightModelPx: 32, heightRatio: 1,
    halfWidthRatio: 0.25, walkHeightsPerSec, actions, outfits, facings: ['right', 'left'],
    variants: VARIANTS, defaultVariant: SCENE_VARIANT,
    ...(opts.parts ? {parts: [...opts.parts]} : {}),
  };
  // （开源版省略）
  const sources: Record<string, FluidSource> = {...opts.sources};
  if (opts.drip || opts.wet) sources.labia = {...sources.labia, arousal: true, ...(opts.wet ? {trail: opts.wet.map(p => [...p])} : {})};
  if (Object.keys(sources).length) manifest.fluidSources = sources;
  const anchorsOf = (outfit: string): Record<string, [number, number, 0 | 1]> => ({...opts.anchors?.[outfit], ...(opts.drip?.[outfit] ? {labia: opts.drip[outfit]!} : {})});
  const sheet = (action: string, facing: Facing, outfit: string, variant: string): SheetMeta => {
    const a = actions[action], pts = anchorsOf(outfit);
    return {action, facing, outfit, variant, frames: a.frames, fps: a.fps, loop: a.loop,
      cell: [24, 32], cols: 4, foot: [12, 32], footY: Array.from({length: a.frames}, () => 31),
      ...(Object.keys(pts).length ? {anchors: Object.fromEntries(Object.entries(pts).map(([k, p]) => [k, Array.from({length: a.frames}, () => p)]))} : {}),
      ...(opts.ids?.includes(outfit) ? {ids: true as const} : {}),
      ...(opts.floor?.[action] ? {floor: opts.floor[action].map(f => [...f] as [number, number, 0 | 1, number])} : {})};
  };
  return {
    manifest,
    mind: opts.mind,
    sfx: opts.sfx ?? null,
    relDir,
    variant: vid => {
      const v = VARIANTS.find(x => x.id === vid);
      if (!v) throw new Error(`假角色包 ${id} 没有画面变体 ${vid}`);
      return v;
    },
    // 和 src/pack/index.ts 的 loadPack 一样：动作自己写了 outfits 就按它，没写按角色包的
    has: (action, outfit) => !!actions[action] && (actions[action].outfits ?? outfits).includes(outfit),
    sheetPath: (variant, outfit, action, facing) => `${relDir}/sprites/${variant}/${outfit}/${action}-${facing}`,
    sheet: (variant, outfit, action, facing) => sheet(action, facing, outfit, variant),
    actorSpec: tuning => ({
      id,
      actions: Object.fromEntries(Object.entries(actions).map(([name, a]) => [name,
        {frames: a.frames, fps: a.fps, loop: a.loop, ...(a.r18 ? {r18: true} : {}), ...(a.outfits ? {outfits: a.outfits} : {}),
          ...(a.heightsPerSec ? {heightsPerSec: a.heightsPerSec} : {}), ...(a.hip ? {hip:a.hip} : {})}])),
      walkHeightsPerSec, halfWidthRatio: 0.25, heightRatio: 1, tuning,
    }),
  };
}

// ---------- 假双人场景 ----------

/**
 * 默认的段：start 0..10；loopA 10..20（能绕圈）；loopB 20..30（有 loop 区间但 loopable = false，不该多绕）；
 * climax 30..40。两段 loop 段都是 'loop' 阶段，所以阶段事件是 start → loop → climax。
 */
export const SCENE_SEGMENTS: readonly SceneSegment[] = [
  {clip: 'start', phase: 'start', start: 0, end: 10},
  {clip: 'loopA', phase: 'loop', start: 10, end: 20, loop: [10, 20], loopable: true},
  {clip: 'loopB', phase: 'loop', start: 20, end: 30, loop: [20, 30], loopable: false},
  {clip: 'climax', phase: 'climax', start: 30, end: 40},
];

export interface FakeSceneOptions {
  /** 场景 id；默认 s1 */
  id?: string;
  receiver: string;
  giver: string;
  /** 段；默认 SCENE_SEGMENTS */
  segments?: readonly SceneSegment[];
  /** sfx.json（两个角色各用哪个 voice + 哪一帧谁有哪个 effect）；不写 = 不出声（null） */
  sfx?: SceneSfx | null;
  /** （开源版省略） */
  floor?: [number, number, 0 | 1, number][];
  /** scene.json 的 stains（做完两个人身上沾上的表面格子编号） */
  stains?: Record<SceneRole, number[]>;
  /** scene.json 的 surface（两个角色表面编号的方块表 hash，和各自 pack.json 的 surface.hash 比） */
  surface?: Record<SceneRole, string>;
  /** （开源版省略） */
  creampie?: {role: SceneRole; hold: number; fade: number};
  /** scene.json 的 after（做完以后两个人各自从哪些出口往外流） */
  after?: Partial<Record<SceneRole, AfterFlow[]>>;
}

/**
 * 按 ScenePack 接口造一个内存里的双人场景。两张图集：
 *   right：给予方在接受方右边（giver.dx > receiver.dx），面朝左；left 是镜像。
 * dx 逐帧变（receiver f % 4，giver 48 + f % 5；left 取负），span / footY 每帧也都有。
 */
export function makeScene(opts: FakeSceneOptions): ScenePack {
  const id = opts.id ?? 's1', relDir = `packs/_scenes/${id}`;
  const segments = opts.segments ?? SCENE_SEGMENTS;
  const frames = segments.at(-1)!.end;
  const manifest: SceneManifest = {
    schema: 1, id, name: `假场景 ${id}`, r18: true, adult: true, roles: {receiver: opts.receiver, giver: opts.giver},
    outfit: 'nude', fps: SCENE_FPS, frames, segments: [...segments], variants: VARIANTS, defaultVariant: SCENE_VARIANT,
    facings: ['right', 'left'],
    ...(opts.stains ? {stains: {...opts.stains}} : {}), ...(opts.surface ? {surface: {...opts.surface}} : {}),
    ...(opts.creampie ? {creampie: {...opts.creampie}} : {}), ...(opts.after ? {after: {...opts.after}} : {}),
  };
  const sheet = (variant: string, facing: Facing): SceneSheetMeta => {
    // right 时两人都在锚点右边（dx 正），giver 更靠右；left 镜像
    const dir = facing === 'right' ? 1 : -1;
    const dx: Record<SceneRole, number[]> = {
      receiver: Array.from({length: frames}, (_, f) => dir * (f % 4)),
      giver: Array.from({length: frames}, (_, f) => dir * (48 + (f % 5))),
    };
    const facingArr = (v: 1 | -1): (1 | -1)[] => Array.from({length: frames}, () => v);
    return {
      action: 'scene', facing, outfit: 'nude', variant, frames, fps: SCENE_FPS, loop: true,
      cell: [80, 48], cols: 4, foot: [40, 48], footY: Array.from({length: frames}, (_, f) => 46 + (f % 2)),
      scene: id,
      span: facing === 'right' ? [-10, 100] : [-100, 10],
      cast: {
        receiver: {dx: dx.receiver, facing: facingArr(dir as 1 | -1)},
        giver: {dx: dx.giver, facing: facingArr(-dir as 1 | -1)},
      },
      ...(opts.floor ? {floor: opts.floor.map(f => [...f] as [number, number, 0 | 1, number])} : {}),
    };
  };
  return {
    manifest,
    relDir,
    sfx: opts.sfx ?? null,
    sheetPath: (variant, facing) => `${relDir}/sprites/${variant}/${facing}`,
    sheet,
  };
}

// ---------- 双人测试的整套环境 ----------

/** a 的脑子：一个大权重的 duo 行为（条件看自己的欲望）+ 小权重的 idle */
function mindOfA(loops: readonly [number, number], declineCooldown?: number): MindConfig {
  return {
    schema: 1,
    stats: {desire: {start: 90, min: 0, max: 100}, mood: {start: 50, min: 0, max: 100}, stamina: {start: 80, min: 0, max: 100}},
    relations: {b: {affection: 50}, user: {affection: 50}},
    behaviors: [
      {
        id: 'sex', weight: 1_000_000, when: {'>=': [{'var': 'self.stats.desire'}, 60]}, cooldown: 120, r18: true,
        duo: {kind: 'sex', with: ['b'], scenes: ['s1'], loops, ...(declineCooldown === undefined ? {} : {declineCooldown})},
        effects: {
          start: {'stats.mood': 5},
          end: {'stats.desire': -20, 'relations.$partner.affection': 10},
          interrupt: {'stats.mood': -10, 'relations.$partner.affection': -5},
        },
      },
      {id: 'idle', weight: 1, steps: [{do: 'idle', sec: [0.5, 0.5]}]},
    ],
  };
}

/** b 的脑子：接受规则看自己的欲望；被发现时心情 -3（用来断言 reaction 效果） */
function mindOfB(): MindConfig {
  return {
    schema: 1,
    stats: {desire: {start: 50, min: 0, max: 100}, mood: {start: 50, min: 0, max: 100}, stamina: {start: 80, min: 0, max: 100}},
    relations: {a: {affection: 50}},
    accept: {sex: {'>=': [{'var': 'self.stats.desire'}, 40]}},
    reactions: {
      discovered: {
        steps: [{do: 'play', action: 'idle', sec: [0.5, 0.5], state: 'discovered', fx: 'alert'}],
        effects: {'stats.mood': -3},
      },
    },
    behaviors: [{id: 'idle', weight: 1, steps: [{do: 'idle', sec: [0.5, 0.5]}]}],
  };
}

export interface DuoOptions {
  /** a 的欲望初值（默认 90，够触发 when 的 60） */
  aDesire?: number;
  /** b 的欲望初值（默认 50，够 accept 的 40）；给 10 就是拒绝 */
  bDesire?: number;
  /** b 的走路速度（身高 / 秒），默认 1.5；给 0.01 让它在 60 秒里走不到 */
  bWalkHeightsPerSec?: number;
  /** duo 行为额外绕圈的圈数，默认 [0, 0] */
  loops?: readonly [number, number];
  /** 被拒 / 放不下时这个 duo 行为的冷却秒数（DuoTemplate.declineCooldown）；不给 = Sim 默认 180 */
  declineCooldown?: number;
  /** 换掉的场景段（如测 loopable = false）；
   * 注意液体测试要用短一点的段：水洼每秒窄 2 渲染像素，玩得久就干了 */
  segments?: readonly SceneSegment[];
  /** 桌面上的窗口（按 z 序从上到下） */
  windows?: WinInfo[];
  /** a / b 出现的位置（脚底点），默认 a (500, 地面)、b (900, 地面) */
  aAt?: Point;
  bAt?: Point;
  seed?: number;
  r18?: boolean;
  /** 假场景帧表的 floor（落地的液体） */
  floor?: FakeSceneOptions['floor'];
  /** （开源版省略） */
  stains?: FakeSceneOptions['stains'];
  creampie?: FakeSceneOptions['creampie'];
  after?: FakeSceneOptions['after'];
  /** 两个角色包每个出口的点（nude）、出口 */
  anchors?: Record<string, [number, number, 0 | 1]>;
  sources?: Record<string, FluidSource>;
  /** （开源版省略） */
  drip?: [number, number, 0 | 1];
  /** （开源版省略） */
  ids?: readonly string[];
  /** 两个角色包动作的 stains（pack.json 的 actions.<动作>.stains） */
  actionStains?: Record<string, number[]>;
  /** 换掉 a / b 的脑子（默认 mindOfA / mindOfB；测试反应之类要用别的事件时用） */
  aMind?: MindConfig;
  bMind?: MindConfig;
  /** 两个角色包的部位图序号 → 名字（pack.json 的 parts） */
  parts?: readonly string[];
  /** 两个角色包的衣着（默认 ['clothed', 'nude']） */
  outfits?: readonly string[];
  /** 两个角色包额外（或覆盖同名）的动作，如带 switchSec 的 strip */
  extraActions?: FakePackOptions['extraActions'];
}

export interface DuoFixture {
  sim: Sim;
  tuning: Tuning;
  aPack: Pack;
  bPack: Pack;
  scene: ScenePack;
  display: DisplayInfo;
}

/**
 * 造一套双人测试环境：假角色包 a / b、假场景 s1、1920×1080 显示器、rng 固定种子。
 * b 先出场、落到 idle；a 后出场（a 先被 step 的话 b 还在 land，邀请不到，会误进冷却）。
 * a 出场后还没推进过时间，测试自己用 drive() 从邀请开始跑。
 */
export function makeDuo(opts: DuoOptions = {}): DuoFixture {
  // idleSec 0：落地后马上选行为；walkMaxSec 放大，让“走过去超时”测的是一方走得太慢而不是 walk 自己超时
  const tuning: Tuning = {...DEFAULT_TUNING, idleSec: [0, 0], walkMaxSec: 600};
  const packExtra = {
    ...(opts.drip ? {drip: {nude: opts.drip}} : {}), ...(opts.anchors ? {anchors: {nude: opts.anchors}} : {}), ...(opts.sources ? {sources: opts.sources} : {}),
    ...(opts.ids ? {ids: opts.ids} : {}),
    ...(opts.actionStains ? {stains: opts.actionStains} : {}),
    ...(opts.parts ? {parts: opts.parts} : {}),
    ...(opts.outfits ? {outfits: opts.outfits} : {}), ...(opts.extraActions ? {extraActions: opts.extraActions} : {}),
  };
  const aPack = makePack({id: 'a', mind: opts.aMind ?? mindOfA(opts.loops ?? [0, 0], opts.declineCooldown), walkHeightsPerSec: 1.5, ...packExtra});
  const bPack = makePack({id: 'b', mind: opts.bMind ?? mindOfB(), walkHeightsPerSec: opts.bWalkHeightsPerSec ?? 1.5, ...packExtra});
  const scene = makeScene({receiver: 'a', giver: 'b', segments: opts.segments,
    ...(opts.floor ? {floor: opts.floor} : {}), ...(opts.stains ? {stains: opts.stains} : {}),
    ...(opts.creampie ? {creampie: opts.creampie} : {}), ...(opts.after ? {after: opts.after} : {})});
  const sim = new Sim([aPack, bPack], tuning, {variant: SCENE_VARIANT, heightLogical: 120, r18: opts.r18 ?? true},
    mulberry32(opts.seed ?? 7),
    {unlocked: [], playSeconds: 0, chars: {
      a: {stats: {desire: opts.aDesire ?? 90}, relations: {}},
      b: {stats: {desire: opts.bDesire ?? 50}, relations: {}},
    }},
    new Map([[scene.manifest.id, scene]]));
  const display = makeDisplay(1, rect(0, 0, 1920, 1080));
  sim.setDesktop({displays: [display], windows: opts.windows ?? []});
  sim.spawn('b', opts.bAt ?? {x: 900, y: FLOOR_Y});
  let t = 0;
  for (let i = 0; i < 300 && sim.charOf('b')!.actor!.state !== 'idle'; i++) {
    t += DT;
    sim.step(t, DT);
  }
  sim.spawn('a', opts.aAt ?? {x: 500, y: FLOOR_Y});
  return {sim, tuning, aPack, bPack, scene, display};
}

// ---------- 驱动 ----------

export interface LoggedEvent {
  /** 事件所在的那一帧的时刻（秒） */
  t: number;
  /** 事件带的角色 id（SimEvent 外面的那一层） */
  id: string;
  e: SimEvent;
}

export interface DuoDriver {
  sim: Sim;
  /** 到目前为止收到的事件（带时刻） */
  log: LoggedEvent[];
  /** 现在的模拟时刻 */
  readonly now: number;
  /** 推进一帧（DT），把这一帧的事件追加进 log 并返回 */
  frame(): LoggedEvent[];
  /** 推进 n 帧 */
  frames(n: number): void;
  /** 推进到出现某个事件（本帧事件里有就返回这一帧）；超时抛错 */
  until(match: (e: SimEvent) => boolean, what?: string, maxSec?: number): LoggedEvent[];
}

/** 用 sim.step(now, DT) 推进时间、收集事件（结果只由种子和步数决定） */
export function drive(sim: Sim): DuoDriver {
  let now = sim.now;
  const log: LoggedEvent[] = [];
  const frame = (): LoggedEvent[] => {
    now += DT;
    const evs = sim.step(now, DT).map(({id, e}) => ({t: now, id, e}));
    log.push(...evs);
    return evs;
  };
  const frames = (n: number): void => { for (let i = 0; i < n; i++) frame(); };
  const until = (match: (e: SimEvent) => boolean, what = '事件', maxSec = 120): LoggedEvent[] => {
    const started = now;
    for (;;) {
      const evs = frame();
      if (evs.some(x => match(x.e))) return evs;
      if (now - started > maxSec) throw new Error(`跑了 ${(now - started).toFixed(1)} 秒还没等到${what}`);
    }
  };
  return {sim, log, get now() { return now; }, frame, frames, until};
}

// ---------- 断言用的场景位置 ----------

/** 场景里某一帧某个角色相对锚点的 x（物理像素） */
export function sceneCastX(scene: ScenePack, facing: Facing, role: SceneRole, frame: number): number {
  return scene.sheet(SCENE_VARIANT, facing).cast[role].dx[frame] * K;
}

/** 现在 play 播到程序里的哪一帧（和 Sim.duoFrame 的算法一样） */
export function currentDuoFrame(sim: Sim): number {
  const d = sim.duos[0];
  if (!d) throw new Error('现在没有双人');
  const pos = Math.floor((sim.now - d.since) * d.scene.manifest.fps);
  return d.program[Math.min(Math.max(pos, 0), d.program.length - 1)];
}

/** 现在场景锚点的 x（接受方 x - offset），和 Sim.duoAnchor 一样 */
export function duoAnchorX(sim: Sim): number {
  const d = sim.duos[0];
  if (!d) throw new Error('现在没有双人');
  return sim.charOf(d.roles.receiver)!.actor!.x - d.offset;
}
