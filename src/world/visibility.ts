// 可见性：矩形求交 / 相减、被遮挡比例、躲在窗口后面时的可选位置（R2.3、R2.4、R2.7，docs/desktop-interaction.md
// §2.1、§2.2、§2.5、§2.7）。纯函数，不 import electron、不碰 Win32、不用随机数。
//
// 坐标：src/shared/types.ts 的约定——物理像素，原点是 Windows 虚拟屏幕原点，y 轴向下；Rect 的 right/bottom 不含，
// 空矩形（right <= left 或 bottom <= top）面积为 0。窗口按 z 序从上到下（DesktopSnapshot.windows 的顺序），
// 数组里下标越小的窗口越靠上、越能挡住别人。
//
// 矩形相减（subtractRects）：从 base 开始，每来一个 cutter，就把剩下的每一块切成最多 4 块——cutter 上面一整条、
// 下面一整条、中间那段里 cutter 左边的、右边的。切出来的块互不重叠，也不含空块；多个 cutter 依次处理，
// 所以互相重叠的 cutter 不会重复扣面积。几十个窗口、几百个采样点都在毫秒级。
//
// findHideSpots 没有逐个窗口调用 coveredFraction（那样是 O(窗口数² × 采样点)），而是每个采样点沿 z 序扫一遍：
// 先把角色包围盒当成“还没被盖住的部分”，碰到一个窗口就从里面减掉它；减完第 i 个窗口时的剩余面积和
// coveredFraction(box(x), coversAbove(windows[i])) 的分子完全一样，于是每个窗口只花一次裁剪。整体
// O(窗口数 × 采样点)，不做逐像素计算。
//
// 自写：矩形裁剪、并集面积、采样分段都很简单，没有引库。
import type {Rect, WinInfo} from '../shared/types.ts';

/** 面积；空矩形（right<=left 或 bottom<=top）为 0 */
export function rectArea(r: Rect): number {
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  return w > 0 && h > 0 ? w * h : 0;
}

/** 交集；不相交（包括只贴边）返回 null */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  // 用 !(x > y) 而不是 x <= y：坐标是 NaN 时也当成不相交
  if (!(right > left) || !(bottom > top)) return null;
  return {left, top, right, bottom};
}

/** 两个矩形交集的面积（不相交、空矩形都是 0） */
function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 把 pieces（互不重叠）减去一个 cutter，返回新的互不重叠的块；不修改输入。
 * 每块最多切成 4 块：上、下、左、右。
 */
function subtractPiece(pieces: readonly Rect[], cutter: Rect): Rect[] {
  if (rectArea(cutter) <= 0) return pieces.slice();
  const out: Rect[] = [];
  for (const r of pieces) {
    const ix0 = Math.max(r.left, cutter.left);
    const iy0 = Math.max(r.top, cutter.top);
    const ix1 = Math.min(r.right, cutter.right);
    const iy1 = Math.min(r.bottom, cutter.bottom);
    if (!(ix1 > ix0) || !(iy1 > iy0)) {
      out.push(r);
      continue;
    }
    // 上：cutter 上面一整条
    if (r.top < iy0) out.push({left: r.left, top: r.top, right: r.right, bottom: iy0});
    // 下：cutter 下面一整条
    if (iy1 < r.bottom) out.push({left: r.left, top: iy1, right: r.right, bottom: r.bottom});
    // 左：只占交集那几行
    if (r.left < ix0) out.push({left: r.left, top: iy0, right: ix0, bottom: iy1});
    // 右：只占交集那几行
    if (ix1 < r.right) out.push({left: ix1, top: iy0, right: r.right, bottom: iy1});
  }
  return out;
}

/** base 减去所有 cutters 的并集，结果是互不重叠的矩形（顺序不限）；不改输入 */
export function subtractRects(base: Rect, cutters: readonly Rect[]): Rect[] {
  if (rectArea(base) <= 0) return [];
  // 从 base 的副本开始，保证返回的矩形不和调用方的对象共用（调用方改结果不会改到输入）
  let pieces: Rect[] = [{...base}];
  for (const cutter of cutters) {
    if (pieces.length === 0) break;
    pieces = subtractPiece(pieces, cutter);
  }
  return pieces;
}

/** 盖住的比例，0..1；target 面积为 0 时返回 0。covers 互相重叠不会重复计面积 */
export function coveredFraction(target: Rect, covers: readonly Rect[]): number {
  const area = rectArea(target);
  if (area <= 0) return 0;
  let remaining = 0;
  for (const r of subtractRects(target, covers)) remaining += rectArea(r);
  return clamp01((area - remaining) / area);
}

/**
 * 角色躲在窗口 hwnd 后面（插在它正下方）时，能挡住角色的窗口：hwnd 自己和 z 序在它上面的全部窗口的 rect。
 * windows 按 z 序从上到下（DesktopSnapshot.windows）。hwnd 不在列表里返回 null。
 */
export function coversAbove(windows: readonly WinInfo[], hwnd: number): Rect[] | null {
  const out: Rect[] = [];
  for (const w of windows) {
    out.push(w.rect);
    if (w.hwnd === hwnd) return out;
  }
  return null;
}

/**
 * 一条线段上每 stepPx 采样（脚底 x 在 [x0 + margin, x1 - margin]，终点也采；线段比 2 × margin 短时只采中点），每个点包围盒被 covers 盖住的比例。
 * 被别的窗口盖住的反应用（docs/desktop-interaction.md §2.7，2026-10-21：走出来、探头找位置）。
 */
export function coverAlong(support: {x0: number; x1: number}, box: (x: number) => Rect, covers: readonly Rect[], stepPx: number, margin: number): {x: number; cover: number}[] {
  const start = support.x0 + margin, end = support.x1 - margin;
  if (!(stepPx > 0) || !Number.isFinite(start) || !Number.isFinite(end)) return [];
  if (end < start) { const x = (support.x0 + support.x1) / 2; return [{x, cover: coveredFraction(box(x), covers)}]; }
  const out: {x: number; cover: number}[] = [];
  for (let k = 0; ; k++) {
    const x = Math.min(start + k * stepPx, end);
    out.push({x, cover: coveredFraction(box(x), covers)});
    if (x >= end - EPS) break;
  }
  return out;
}

export interface HideSpot {
  hwnd: number;
  /** 脚底点 x（物理像素） */
  x: number;
  /** 这个 x 上角色包围盒被（hwnd 和它上面的窗口）盖住的比例 */
  cover: number;
  /** 其中只算 hwnd 自己盖住的比例 */
  coverBySelf: number;
}

export interface HideSpotQuery {
  /** z 序从上到下 */
  windows: readonly WinInfo[];
  /** 角色站的那条水平线段：脚底 y，x 范围 [x0, x1) */
  support: {x0: number; x1: number; y: number};
  /** 脚底点在 (x, support.y) 时角色的包围盒 */
  box(x: number): Rect;
  /** 可接受的遮挡比例 [lo, hi]（含两端） */
  cover: readonly [number, number];
  /** 在可接受区间里优先取接近这个比例的点；默认 (lo + hi) / 2 */
  prefer?: number;
  /** 采样间距（物理像素，>0） */
  stepPx: number;
  /** 脚底 x 只在 [x0 + margin, x1 - margin] 里取 */
  margin: number;
  /** hwnd 自己至少要盖住这么多（默认 0.1），否则不算“躲在它后面” */
  minSelf?: number;
  /** 哪些窗口可以躲（默认：非置顶 topmost === false 的都可以） */
  eligible?(w: WinInfo): boolean;
  /** 平手时取离这个 x 近的（一般是角色现在的脚底 x）；没给取 x 小的 */
  near?: number;
}

interface Sample {
  x: number;
  /** 采样序号：相邻序号都满足才算同一段 */
  k: number;
  cover: number;
  coverBySelf: number;
}

/** 采样点生成的浮点容差（物理像素）：x 落在终点前这么近时就直接当终点 */
const EPS = 1e-9;
/** 比较 |cover - prefer| 时的容差：小于它的差当作平手（浮点算出来的对称值可能差一两个 ulp） */
const DIFF_EPS = 1e-12;

/**
 * 在一条支撑线段上找能躲到某个窗口后面的位置。对每个 eligible 窗口 W：从 x0 + margin 起每 stepPx 采样到
 * x1 - margin（含终点，终点不在步长上也要采一次），算 cover = coveredFraction(box(x), coversAbove(W)) 和
 * coverBySelf = coveredFraction(box(x), [W.rect])；满足 lo ≤ cover ≤ hi 且 coverBySelf ≥ minSelf 的采样点
 * 按 x 连成段（相邻采样都满足就算同一段）；每段输出一个 HideSpot，取段里 |cover - prefer| 最小的那个采样点
 * （平手取离 near 近的；没给 near 取 x 小的）。全部结果按 |cover - prefer| 升序排（平手按 hwnd 在 z 序里靠上的在前，
 * 再按离 near 近 / x 小的在前）。线段比 2 × margin 还短时返回 []。
 * （开源版省略）
 * 以前取 x 小的 = 永远是线段最左端。
 */
export function findHideSpots(q: HideSpotQuery): HideSpot[] {
  const [lo, hi] = q.cover;
  const step = q.stepPx;
  const margin = q.margin;
  const start = q.support.x0 + margin;
  const end = q.support.x1 - margin;
  // 非法输入直接返回（尤其 step <= 0 / NaN，不能进死循环）
  if (!(step > 0) || !Number.isFinite(step) || !Number.isFinite(start) || !Number.isFinite(end)) return [];
  // 比 2 × margin 短；正好相等时还剩一个点
  if (end < start) return [];
  // 区间反了就没人能满足
  if (lo > hi) return [];

  const windows = q.windows;
  const prefer = q.prefer ?? (lo + hi) / 2;
  const minSelf = q.minSelf ?? 0.1;
  const eligible = windows.map(w => (q.eligible ? q.eligible(w) : !w.topmost));
  // 没有能躲的窗口就不用采样了
  if (!eligible.some(Boolean)) return [];
  // 每个窗口满足条件的采样点，按 x 递增（采样点对每个窗口都一样，所以只扫一遍窗口）
  const samplesOf: Sample[][] = windows.map(() => []);

  for (let k = 0; ; k++) {
    let x = start + k * step;
    let last = false;
    if (!(x < end - EPS)) {
      x = end;
      last = true;
    }

    const box = q.box(x);
    const boxArea = rectArea(box);
    let pieces: Rect[] = boxArea > 0 ? [{...box}] : [];
    let remaining = boxArea;

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      let self = 0;
      if (boxArea > 0) {
        self = clamp01(intersectionArea(box, w.rect) / boxArea);
        // 不管能不能躲，W 都挡着比它低（后面）的窗口，所以要减掉
        pieces = subtractPiece(pieces, w.rect);
        remaining = 0;
        for (const r of pieces) remaining += rectArea(r);
      }
      if (!eligible[i]) continue;
      const cover = boxArea > 0 ? clamp01((boxArea - remaining) / boxArea) : 0;
      if (cover >= lo && cover <= hi && self >= minSelf) {
        samplesOf[i].push({x, k, cover, coverBySelf: self});
      }
    }

    if (last) break;
  }

  // 每个窗口把相邻采样点连成段，每段取最接近 prefer 的点（平手：给了 near 取离它近的，否则取 x 小的——只在严格更近时替换）
  const nearKey = (x: number) => (q.near === undefined ? x : Math.abs(x - q.near));
  const scored: Array<HideSpot & {z: number}> = [];
  for (let i = 0; i < windows.length; i++) {
    const list = samplesOf[i];
    if (list.length === 0) continue;
    const emit = (s: Sample): void => {
      scored.push({hwnd: windows[i].hwnd, x: s.x, cover: s.cover, coverBySelf: s.coverBySelf, z: i});
    };
    let prevK = -2;
    let best: Sample | null = null;
    let bestDiff = Infinity;
    for (const s of list) {
      if (s.k !== prevK + 1 && best) {
        emit(best);
        best = null;
        bestDiff = Infinity;
      }
      prevK = s.k;
      const diff = Math.abs(s.cover - prefer);
      if (!best || diff < bestDiff - DIFF_EPS || (Math.abs(diff - bestDiff) <= DIFF_EPS && nearKey(s.x) < nearKey(best.x))) {
        best = s;
        bestDiff = diff;
      }
    }
    if (best) emit(best);
  }

  scored.sort((a, b) => {
    const da = Math.abs(a.cover - prefer);
    const db = Math.abs(b.cover - prefer);
    if (Math.abs(da - db) > DIFF_EPS) return da - db;
    if (a.z !== b.z) return a.z - b.z;
    return nearKey(a.x) - nearKey(b.x);
  });
  return scored.map(s => ({hwnd: s.hwnd, x: s.x, cover: s.cover, coverBySelf: s.coverBySelf}));
}
