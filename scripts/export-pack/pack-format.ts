// 角色包的写法（生产方共用，docs/pack-format.md §8.2）：pack.json、帧表、动作条目的键和顺序、必填项检查、图集排版、
// JSON 的写法。所有导出器（方块 render.mjs、MMD mmd/render.mjs、以后的 VRM / Spine / 2D）都只经这里拼包，格式只在一处定。
// 纯函数，不碰 DOM、three、fs：Node（单测、validate-pack.ts）直接 import；导出页面经 bench:// 协议去类型以后 import
// （scripts/render-bench/electron-env.mjs）。运行时那一侧的类型和加载校验在 src/pack/index.ts，这里只 import 类型。
// 自写。
import type {Facing, PackManifest, PackVariant, SheetMeta} from '../../src/pack/index.ts';
import type {Transition} from '../../src/behavior/index.ts';
import {ATLAS_MAX_WIDTH, gridFor} from '../../src/shared/sheets.ts';

export const SCHEMA = 1;
/** 图集一行最多排到这么宽（渲染像素）；排版和拆块的规则在 src/shared/sheets.ts（运行时共用） */
export {ATLAS_MAX_WIDTH, gridFor};
/** 认得的衣着，从穿得多到穿得少（docs/pack-format.md §5）；第一个必须是 clothed */
export const OUTFITS = ['clothed', 'topless', 'nude'] as const;
/** 全帧都不到这么多个身高时 hip 不写（当 0） */
const HIP_EPS = 0.002;

type Action = PackManifest['actions'][string];
type Fail = (msg: string) => never;
const failer = (what: string): Fail => msg => { throw new Error(`${what}：${msg}`); };
/** 去掉值是 undefined 的键（可选字段没有就不写） */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** pack.json / scene.json 的画面变体：只留运行时认的键（id、renderHeight、outline、style）；角色包和双人场景都经它写（场景以前手写、丢了 style） */
export function manifestVariants(vs: readonly PackVariant[]): PackVariant[] {
  return vs.map(v => defined({id: v.id, renderHeight: v.renderHeight, outline: v.outline, style: v.style}));
}

/** pack.json 动作的 hip：{hip: {right: [...], left: [...]}}，三位小数；全帧都不到 HIP_EPS 个身高时不写（当 0） */
export function hipOf(byFacing: Partial<Record<Facing, readonly number[]>> | undefined): {hip?: Partial<Record<Facing, number[]>>} {
  if (!byFacing || Object.values(byFacing).every(xs => xs!.every(x => Math.abs(x) < HIP_EPS))) return {};
  return {hip: Object.fromEntries(Object.entries(byFacing).map(([f, xs]) => [f, xs!.map(x => +x.toFixed(3))]))};
}

/**
 * 地速（模型前方的、世界单位 / 秒）→ 屏幕上每秒走几个自己的身高：× 模型前方投到屏幕横向的系数（四分之三侧视 sin 55° ≈ 0.82）÷ 身高
 * （同一个单位）。脚才不打滑（design.md §3.3 第 6 条）
 */
export function heightsPerSec(groundSpeed: number, screenForward: number, height: number): number {
  return +(groundSpeed * screenForward / height).toFixed(4);
}

export interface ActionInput {
  clip: string | null;
  frames: number;
  fps: number;
  loop: boolean;
  r18?: boolean;
  outfits?: readonly string[];
  anchor?: 'seat';
  switchSec?: number;
  stains?: readonly number[];
  after?: Action['after'];
  /** 移动类动作的地速（已经换算成每秒几个身高，见 heightsPerSec） */
  heightsPerSec?: number;
  transition?: {from: string; to: string};
  /** 每个朝向逐帧的髋骨横向位置（身高），按 hipOf 写 */
  hip?: Partial<Record<Facing, readonly number[]>>;
}

/** pack.json 的一条动作（键的顺序固定；空的 stains / after、false 的 r18 不写） */
export function buildAction(name: string, a: ActionInput): Action {
  const fail = failer(`动作 ${name}`);
  if (!(Number.isInteger(a.frames) && a.frames > 0)) fail(`frames ${a.frames} 不对`);
  if (!(a.fps > 0)) fail(`fps ${a.fps} 不对`);
  for (const [f, xs] of Object.entries(a.hip ?? {})) if (xs?.length !== a.frames) fail(`hip.${f} 有 ${xs?.length} 帧，动作 ${a.frames} 帧`);
  return defined({
    clip: a.clip, frames: a.frames, fps: a.fps, loop: a.loop,
    r18: a.r18 ? true as const : undefined,
    outfits: a.outfits ? [...a.outfits] : undefined,
    anchor: a.anchor,
    switchSec: a.switchSec,
    stains: a.stains?.length ? [...a.stains] : undefined,
    after: a.after?.length ? a.after : undefined,
    heightsPerSec: a.heightsPerSec,
    transition: a.transition ? {from: a.transition.from, to: a.transition.to} : undefined,
    ...hipOf(a.hip),
  }) as Action;
}

export type ManifestInput = Omit<PackManifest, 'schema'> & {
  producer: string;
  /** 生产方记的出处、视角、后处理（运行时不用） */
  source?: unknown;
  view?: unknown;
  post?: unknown;
  screenForward?: number;
};

/**
 * pack.json（docs/pack-format.md §2）。键按固定顺序写，必填项和运行时会拒绝的情况在这里先查（导出失败比加载失败早）：
 * adult、idle 每档衣着都有、衣着第一个是 clothed、默认变体、两个朝向、尺寸都是正数、过渡和动作表对得上
 */
export function buildManifest(m: ManifestInput): PackManifest & {producer: string} {
  const fail = failer(`角色包 ${m.id}`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.id)) fail('id 要是小写英文 / 数字 + 连字符');
  if (!m.producer) fail('缺 producer');
  if (m.adult !== true) fail('adult 不是 true（R9.1）');
  if (m.outfits[0] !== 'clothed') fail(`衣着第一个要是 clothed（现在是 ${m.outfits.join('、')}）`);
  for (const o of m.outfits) if (!(OUTFITS as readonly string[]).includes(o)) fail(`不认识的衣着 ${o}（认得 ${OUTFITS.join('、')}）`);
  const idle = m.actions.idle ?? fail('缺 idle 动作');
  for (const o of m.outfits) if (idle.outfits && !idle.outfits.includes(o)) fail(`idle 缺衣着 ${o}`);
  if (m.facings.length !== 2 || !m.facings.includes('right') || !m.facings.includes('left')) fail('facings 要是 right、left 两个');
  if (!m.variants.some(v => v.id === m.defaultVariant)) fail(`defaultVariant ${m.defaultVariant} 不在 variants 里`);
  for (const k of ['restHeightModelPx', 'heightRatio', 'halfWidthRatio', 'walkHeightsPerSec'] as const) if (!((m[k] ?? 0) > 0)) fail(`${k} 要 > 0（现在 ${m[k]}）`);
  for (const t of m.transitions ?? []) if (!m.actions[t.action]?.transition || !m.actions[t.to]) fail(`过渡 ${t.action} 和动作表对不上`);
  return defined({
    schema: SCHEMA as 1, producer: m.producer, id: m.id, name: m.name, names: m.names && Object.keys(m.names).length ? m.names : undefined, aliases: m.aliases, adult: true as const,
    source: m.source, view: m.view, post: m.post,
    restHeightModelPx: m.restHeightModelPx, heightRatio: m.heightRatio, halfWidthRatio: m.halfWidthRatio,
    walkHeightsPerSec: m.walkHeightsPerSec, screenForward: m.screenForward,
    actions: m.actions,
    transitions: m.transitions?.length ? m.transitions.map((t: Transition) => ({from: t.from, to: t.to, action: t.action, entries: t.entries})) : undefined,
    outfits: m.outfits, facings: m.facings,
    surface: m.surface, fluidSources: m.fluidSources && Object.keys(m.fluidSources).length ? m.fluidSources : undefined, parts: m.parts,
    variants: manifestVariants(m.variants),
    defaultVariant: m.defaultVariant,
    sprites: 'sprites/<variant>/<outfit>/<action>-<facing>.png|.json',
  }) as PackManifest & {producer: string};
}

export type SheetInput = SheetMeta & {
  /** （开源版省略） */
  anchor?: 'seat';
  /** 2D 来源镜像出来的朝向（docs/pack-format.md §3.4） */
  mirrored?: true;
};

/**
 * 一张图集的帧表（docs/pack-format.md §3.2）。extra = 生产方自己记的（如方块的 springs），写在最后、运行时不用。
 * 检查逐帧数据的长度、脚底点在格子里、cols 和排版一致
 */
export function buildSheetMeta(s: SheetInput, extra: Record<string, unknown> = {}): SheetMeta & Record<string, unknown> {
  const fail = failer(`图集 ${s.variant}/${s.outfit}/${s.action}-${s.facing}`);
  const [cw, ch] = s.cell;
  const g = gridFor(cw, ch, s.frames);
  if (s.cols !== g.cols || s.chunk !== g.chunk) fail(`cols ${s.cols} / chunk ${s.chunk} 和排版（${g.cols} / ${g.chunk}，src/shared/sheets.ts gridFor）不一致`);
  // foot[1] 是待机的脚底基准线，可以在格子外（坐在地上的动作身体比它低，靠逐帧的 footY）；原点的投影 foot[0] 在格子里
  if (!(s.foot[0] >= 0 && s.foot[0] <= cw)) fail(`foot[0] ${s.foot[0]} 不在格子 0–${cw} 里`);
  if (s.footY && (s.footY.length !== s.frames || s.footY.some(y => !(y >= 0 && y <= ch)))) fail('footY 长度不对或不在格子里');
  for (const [src, list] of Object.entries(s.anchors ?? {})) if (list.length !== s.frames) fail(`anchors.${src} 长度不对`);
  if (s.floor?.some(([f]) => f < 0 || f >= s.frames)) fail('floor 帧号超出范围');
  return defined({
    action: s.action, facing: s.facing, outfit: s.outfit, variant: s.variant, frames: s.frames, fps: s.fps, loop: s.loop,
    cell: [cw, ch] as [number, number], cols: s.cols, chunk: s.chunk, foot: s.foot, footY: s.footY, anchor: s.anchor, mirrored: s.mirrored,
    anchors: s.anchors, ids: s.ids, parts: s.parts, floor: s.floor, ...extra,
  }) as SheetMeta & Record<string, unknown>;
}

/** （开源版省略） */
export function stringifyPack(pack: object): string {
  return JSON.stringify(pack, null, 1).replace(/\[[\d\s.,eE+-]*\]/g, s => s.replace(/\s+/g, '')) + '\n';
}

/** 帧表的写法：一行 */
export const stringifySheet = (sheet: object): string => JSON.stringify(sheet);

/** 图集相对角色包目录的路径（不带扩展名） */
export const sheetRel = (variant: string, outfit: string, action: string, facing: Facing): string => `sprites/${variant}/${outfit}/${action}-${facing}`;
