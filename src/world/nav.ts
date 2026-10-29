// 导航（N2.5，2026-10-21；docs/desktop-interaction.md §2.4）：在能站的线段之间找路。纯函数。
// 走法只有两种：在同一段上走；跳到另一段（往上最多 jumpUpPx，起跳点和落点横着最多差 jumpSidePx，往下不限）。
// 往下也用跳（从端点跳下去），不用“走出端点掉下去”：掉下去是物理状态，会中止计划（behavior/actor.ts toFall）。
// 角色在 front 层，窗口都在她后面，空中不会被窗口挡住，所以只看两段的位置关系，不做碰撞。
// 窗口里面的底边（kind inside，key in:<hwnd>，docs/desktop-interaction.md §2.2 的 inside:W）：只能从这个窗口的顶边跳进去；
// 出来从侧边跳出去（落点在窗口外面），窗口矮的话也能跳回顶边。两个窗口里面之间不直接连。两种都出不去的窗口不当房间（hasExit，main/sim.ts 去掉它的 in:*）。
// 找路用 Dijkstra（节点 = 线段，几十个，毫秒级）；每段只记最先到的那一次（落点不同时后面走的路会差一点，够用）。自写。
import type {Support} from './types.ts';

export interface NavParams {
  /** 落点、起跳点离线段端点至少留这么宽（物理像素，角色半宽） */
  halfWidthPx: number;
  /** 一次跳最多往上多少（物理像素，脚底点） */
  jumpUpPx: number;
  /** 起跳点和落点横着最多差多少（物理像素） */
  jumpSidePx: number;
  /** 抛物线的顶点比两头较高的那头再高多少（物理像素） */
  arcPx: number;
  /** 重力（物理像素 / 秒²）：算空中时间 */
  gravityPx: number;
  /** 走路速度（物理像素 / 秒） */
  walkPxPerSec: number;
  /** 一次跳除了空中以外的固定时间（起跳 + 落地动画，秒） */
  jumpFixedSec: number;
}

export interface NavGoal {
  key: string;
  x: number;
}

export type NavMove =
  /** 在当前这段上走到 x */
  | {kind: 'walk'; x: number}
  /** 在 fromX 起跳，落到 to 那段的 to.x（to.y 是那段的高度，起跳时按 key 再找一次） */
  | {kind: 'jump'; fromX: number; to: {key: string; x: number; y: number}};

export interface NavRoute {
  moves: NavMove[];
  /** 估计用时（秒） */
  sec: number;
  /** 跳几次 */
  jumps: number;
}

/** 从 y0 跳到 y1（脚底，往下为正）空中要多久：先升到 min(y0, y1) - arc 再落到 y1 */
export function flightSec(y0: number, y1: number, p: NavParams): number {
  const apex = Math.min(y0, y1) - p.arcPx;
  return Math.sqrt(2 * (y0 - apex) / p.gravityPx) + Math.sqrt(2 * (y1 - apex) / p.gravityPx);
}

const hwndOf = (s: Support) => Number(s.key.slice(s.key.indexOf(':') + 1));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** 一段里脚底点能放的范围（两头各留半宽）；太短时取中点 */
function inner(s: Support, hw: number): [number, number] {
  const lo = s.x0 + hw, hi = s.x1 - hw;
  return lo <= hi ? [lo, hi] : [(s.x0 + s.x1) / 2, (s.x0 + s.x1) / 2];
}

/**
 * 从 A 段（现在在 entryX）跳到 B 段：起跳点、落点；跳不过去返回 null。规则见文件开头。
 * 往上 / 平着：两段的可站范围横着有重叠就在重叠里竖着跳（起跳点尽量靠近 entryX），没重叠就从近的一头跳到近的一头；
 * 往下：从 A 的一头跳下去，落点在 A 的范围外面（不从自己站的线段中间穿下去）。
 */
/** 竖着跳：起跳点 = entryX 夹到两段的重叠里，两段都包住它才行（不重叠时 null） */
function straightUp(entryX: number, a0: number, a1: number, b0: number, b1: number): {fromX: number; toX: number} | null {
  const x = clamp(entryX, Math.max(a0, b0), Math.min(a1, b1));
  return x >= a0 && x <= a1 && x >= b0 && x <= b1 ? {fromX: x, toX: x} : null;
}

export function jumpBetween(A: Support, B: Support, entryX: number, p: NavParams): {fromX: number; toX: number} | null {
  const hw = p.halfWidthPx;
  const [a0, a1] = inner(A, hw), [b0, b1] = inner(B, hw);
  const rise = A.y - B.y;
  if (A.kind === 'inside' && B.kind === 'inside') return null;
  if (B.kind === 'inside') {
    // 进窗口：只能从这个窗口的顶边跳进去
    if (A.key !== `win:${hwndOf(B)}`) return null;
    return straightUp(entryX, a0, a1, b0, b1);
  }
  if (A.kind === 'inside') {
    const r = A.rect!;
    if (B.key === `win:${hwndOf(A)}`) {
      // 窗口矮：跳回顶边（两段都要包住起跳点：顶边被别的窗口切得只剩离里面那段远的一截时跳不上去，2026-10-22 以前只查了顶边那段）
      if (rise > p.jumpUpPx) return null;
      return straightUp(entryX, a0, a1, b0, b1);
    }
    // 从侧边跳出去：落点在窗口外面
    if (rise > p.jumpUpPx) return null;
    let best: {fromX: number; toX: number} | null = null;
    for (const [fromX, toX] of [[a0, clamp(r.left - hw, b0, b1)], [a1, clamp(r.right + hw, b0, b1)]] as const) {
      if (toX > r.left - hw && toX < r.right + hw) continue;   // 落点还在窗口里
      if (Math.abs(toX - fromX) > p.jumpSidePx) continue;
      if (!best || Math.abs(fromX - entryX) < Math.abs(best.fromX - entryX)) best = {fromX, toX};
    }
    return best;
  }
  if (rise > p.jumpUpPx) return null;
  if (rise >= 0) {
    const lo = Math.max(a0, b0), hi = Math.min(a1, b1);
    if (lo <= hi) {
      const x = clamp(entryX, lo, hi);
      return {fromX: x, toX: x};
    }
    const fromX = b0 > a1 ? a1 : a0, toX = b0 > a1 ? b0 : b1;
    return Math.abs(toX - fromX) <= p.jumpSidePx ? {fromX, toX} : null;
  }
  // 往下：落点在 A 的范围外面
  let best: {fromX: number; toX: number} | null = null;
  for (const [fromX, toX] of [[a0, Math.min(b1, A.x0 - hw)], [a1, Math.max(b0, A.x1 + hw)]] as const) {
    if (toX < b0 || toX > b1 || (toX > A.x0 - hw && toX < A.x1 + hw)) continue;
    if (Math.abs(toX - fromX) > p.jumpSidePx) continue;
    if (!best || Math.abs(fromX - entryX) < Math.abs(best.fromX - entryX)) best = {fromX, toX};
  }
  return best;
}

/** 找路：从 from（某段上的一点）到 goals 里最近的一个。到不了返回 null；已经在目标那段上就只有一步 walk */
export function findRoute(supports: readonly Support[], from: NavGoal, goals: readonly NavGoal[], p: NavParams): NavRoute | null {
  const n = supports.length;
  const start = supports.findIndex(s => s.key === from.key && from.x >= s.x0 && from.x < s.x1);
  if (start < 0 || !goals.length) return null;
  /** 这一段上离进来的点最近的目标（同一段上可以有好几个） */
  const goalAt = (i: number, from: number): number | null => {
    let best: number | null = null;
    for (const g of goals) {
      const s = supports[i];
      if (g.key !== s.key || g.x < s.x0 || g.x >= s.x1) continue;
      if (best === null || Math.abs(g.x - from) < Math.abs(best - from)) best = g.x;
    }
    return best;
  };
  const cost = new Array<number>(n).fill(Infinity), entry = new Array<number>(n).fill(NaN);
  const prev = new Array<{i: number; fromX: number; toX: number} | null>(n).fill(null), jumps = new Array<number>(n).fill(0);
  const done = new Array<boolean>(n).fill(false);
  cost[start] = 0; entry[start] = from.x;
  let bestEnd = -1, bestCost = Infinity, bestX = 0;
  for (;;) {
    let i = -1;
    for (let k = 0; k < n; k++) if (!done[k] && cost[k] < Infinity && (i < 0 || cost[k] < cost[i])) i = k;
    if (i < 0 || cost[i] >= bestCost) break;
    done[i] = true;
    const gx = goalAt(i, entry[i]);
    if (gx !== null) {
      const c = cost[i] + Math.abs(gx - entry[i]) / p.walkPxPerSec;
      if (c < bestCost) { bestCost = c; bestEnd = i; bestX = gx; }
    }
    for (let k = 0; k < n; k++) {
      if (k === i || done[k]) continue;
      const j = jumpBetween(supports[i], supports[k], entry[i], p);
      if (!j) continue;
      const c = cost[i] + Math.abs(j.fromX - entry[i]) / p.walkPxPerSec + p.jumpFixedSec + flightSec(supports[i].y, supports[k].y, p);
      if (c < cost[k]) { cost[k] = c; entry[k] = j.toX; prev[k] = {i, fromX: j.fromX, toX: j.toX}; jumps[k] = jumps[i] + 1; }
    }
  }
  if (bestEnd < 0) return null;
  const moves: NavMove[] = [{kind: 'walk', x: bestX}];
  for (let k = bestEnd; prev[k]; k = prev[k]!.i) {
    const e = prev[k]!, s = supports[k];
    moves.unshift({kind: 'jump', fromX: e.fromX, to: {key: s.key, x: e.toX, y: s.y}});
    moves.unshift({kind: 'walk', x: e.fromX});
  }
  // 起点上原地不动的 walk 去掉
  const out = moves.filter((m, idx) => !(m.kind === 'walk' && idx === 0 && Math.abs(m.x - from.x) < 0.5));
  return {moves: out, sec: bestCost, jumps: jumps[bestEnd]};
}

/**
 * 窗口里面这段（kind inside）有没有出口：一跳能到窗口外面的某段（从侧边跳出去，或者跳回这个窗口的顶边）。
 * 没有出口的窗口（最大化、铺满屏幕宽又太高的）不当“房间”：用户 2026-10-21 选的 C——进去了出不来，躲、双人都断了。
 * 出口有没有和从哪儿起跳无关（侧边按两头算，顶边按横向重叠算），这里用中点。
 */
export function hasExit(supports: readonly Support[], inside: Support, p: NavParams): boolean {
  const mid = (inside.x0 + inside.x1) / 2;
  return supports.some(B => B !== inside && B.kind !== 'inside' && jumpBetween(inside, B, mid, p) !== null);
}

/** 一跳能到的别的线段（随便跳着玩用）：每段一个落点 */
export function jumpTargets(supports: readonly Support[], from: NavGoal, p: NavParams): {support: Support; fromX: number; toX: number}[] {
  const A = supports.find(s => s.key === from.key && from.x >= s.x0 && from.x < s.x1);
  if (!A) return [];
  const out: {support: Support; fromX: number; toX: number}[] = [];
  for (const B of supports) {
    if (B === A) continue;
    const j = jumpBetween(A, B, from.x, p);
    if (j) out.push({support: B, ...j});
  }
  return out;
}
