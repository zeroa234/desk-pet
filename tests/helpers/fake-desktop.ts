// 假桌面（R13.3）：造显示器、窗口、快照、带种子的 rng、ActorSpec、WorldContext。
// 只给单测用，不 import electron、不碰 Win32。坐标是物理像素（src/shared/types.ts）。
// 尺度规则（自己定的简单版）：heightPx = 120 × 显示器 scale（= 240 × scale / 2），headroom 用它，
// 可站线段最短长度 = 80 × scale（DIP 80）。
import type {DesktopSnapshot, DisplayInfo, Point, Rect, WinInfo} from '../../src/shared/types.ts';
import {DEFAULT_TUNING} from '../../src/behavior/index.ts';
import type {ActionInfo, ActorSpec, Metrics, Tuning, WorldContext} from '../../src/behavior/index.ts';
import {computeSupports, displayAt} from '../../src/world/index.ts';
import type {Support, SupportOptions} from '../../src/world/index.ts';

/** 逻辑显示高度（DIP），design.md §0：默认 120 逻辑像素 */
export const LOGICAL_HEIGHT = 120;
/** 可站线段最短长度（DIP） */
export const MIN_WIDTH_DIP = 80;

export function rect(left: number, top: number, right: number, bottom: number): Rect {
  return {left, top, right, bottom};
}

/** 角色的显示高度（物理像素）：120 × scale（scale 可以不是整数，这里就按 120 × scale 算） */
export function heightPxOf(d: DisplayInfo): number {
  return LOGICAL_HEIGHT * d.scale;
}

/** 单元测试用的支撑面参数：头顶留一个角色高，最短 80 DIP */
export const SUPPORT_OPTIONS: SupportOptions = {
  headroom: (d: DisplayInfo) => heightPxOf(d),
  minWidth: (d: DisplayInfo) => MIN_WIDTH_DIP * d.scale,
};

/**
 * 造一个显示器。workArea 默认 = bounds 去掉底部 40 px 任务栏；传 workArea 可以自己定（如自动隐藏任务栏 = bounds）。
 */
export function makeDisplay(id: number, bounds: Rect, scale = 1, workArea?: Rect): DisplayInfo {
  return {id, bounds, workArea: workArea ?? {...bounds, bottom: bounds.bottom - 40}, scale};
}

export function makeWindow(hwnd: number, r: Rect, opts: {pid?: number; title?: string; className?: string; topmost?: boolean} = {}): WinInfo {
  return {
    hwnd,
    pid: opts.pid ?? 1000 + hwnd,
    title: opts.title ?? `窗口 ${hwnd}`,
    className: opts.className ?? 'FakeWindowClass',
    rect: r,
    topmost: opts.topmost ?? false,
  };
}

/** windows 按 z 序从上到下 */
export function makeSnapshot(displays: DisplayInfo[], windows: WinInfo[] = []): DesktopSnapshot {
  return {displays, windows};
}

/** mulberry32：带种子的 [0, 1) 随机数 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 假的帧信息（帧数 / 帧率 / 是否循环）；dragged 不在表里时可用 omit 去掉 */
const ACTION_FRAMES: Readonly<Record<string, ActionInfo>> = {
  idle: {frames: 96, fps: 12, loop: true},
  walk: {frames: 14, fps: 12, loop: true},
  sit: {frames: 49, fps: 12, loop: true},
  downed: {frames: 62, fps: 12, loop: false},
  fall: {frames: 10, fps: 12, loop: true},
  dragged: {frames: 10, fps: 12, loop: true},
};

export const ALL_ACTIONS: readonly string[] = ['idle', 'walk', 'sit', 'downed', 'fall', 'dragged'];

/** 角色包动作表；omit 里的动作当作“角色包没有” */
export function makeActions(omit: readonly string[] = []): Record<string, ActionInfo> {
  const out: Record<string, ActionInfo> = {};
  for (const name of ALL_ACTIONS) {
    if (omit.includes(name)) continue;
    out[name] = {...ACTION_FRAMES[name]};
  }
  return out;
}

export interface SpecOptions {
  id?: string;
  omit?: readonly string[];
  /** 额外的动作（覆盖同名） */
  actions?: Record<string, ActionInfo>;
  tuning?: Partial<Tuning>;
  walkHeightsPerSec?: number;
  halfWidthRatio?: number;
}

export function makeSpec(opts: SpecOptions = {}): ActorSpec {
  return {
    id: opts.id ?? 'test-actor',
    actions: {...makeActions(opts.omit), ...opts.actions},
    walkHeightsPerSec: opts.walkHeightsPerSec ?? 1.5,
    halfWidthRatio: opts.halfWidthRatio ?? 0.25,
    tuning: {...DEFAULT_TUNING, ...opts.tuning},
  };
}

export interface FakeWorldOptions {
  displays: DisplayInfo[];
  /** 按 z 序从上到下 */
  windows?: WinInfo[];
  seed?: number;
  now?: number;
  supportOptions?: SupportOptions;
}

export interface FakeWorld {
  ctx: WorldContext;
  snapshot(): DesktopSnapshot;
  /** 换一个快照（窗口关了 / 挪了 / 冒出新的）；同时重算 ctx.supports */
  setSnapshot(displays: DisplayInfo[], windows?: WinInfo[]): void;
  /** 换窗口，显示器不变 */
  setWindows(windows: WinInfo[]): void;
  supports(): readonly Support[];
  /** 时间往前走（stepActor 不推进 ctx.now，要调用方自己推） */
  advance(dt: number): void;
}

/** 造 WorldContext：metricsAt 按 displayAt 找显示器，heightPx = 120 × scale；rng 固定种子 */
export function makeWorld(opts: FakeWorldOptions): FakeWorld {
  let snap = makeSnapshot(opts.displays, opts.windows ?? []);
  const opt = opts.supportOptions ?? SUPPORT_OPTIONS;
  const ctx: WorldContext = {
    now: opts.now ?? 0,
    supports: computeSupports(snap, opt),
    metricsAt(p: Point): Metrics {
      const d = displayAt(snap.displays, p);
      return {displayId: d.id, scale: d.scale, heightPx: heightPxOf(d)};
    },
    displayBounds: snap.displays.map(d => ({displayId: d.id, left: d.bounds.left, top: d.bounds.top, right: d.bounds.right, bottom: d.bounds.bottom})),
    rng: mulberry32(opts.seed ?? 1),
    windowAt: p => snap.windows.find(w => p.x >= w.rect.left && p.x < w.rect.right && p.y >= w.rect.top && p.y < w.rect.bottom)?.hwnd ?? null,
  };
  const setSnapshot = (displays: DisplayInfo[], windows: WinInfo[] = []): void => {
    snap = makeSnapshot(displays, windows);
    ctx.supports = computeSupports(snap, opt);
    ctx.displayBounds = snap.displays.map(d => ({displayId: d.id, left: d.bounds.left, top: d.bounds.top, right: d.bounds.right, bottom: d.bounds.bottom}));
  };
  return {
    ctx,
    snapshot: () => snap,
    setSnapshot,
    setWindows: (windows: WinInfo[]) => setSnapshot(snap.displays, windows),
    supports: () => ctx.supports,
    advance: (dt: number) => { ctx.now += dt; },
  };
}
