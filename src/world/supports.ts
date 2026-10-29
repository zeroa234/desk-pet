// 支撑面：从桌面快照算出所有能站的水平线段（R2.1、R2.2，state-rules.md §2.3）。纯函数。
//   地面：每个显示器一段，y = 工作区底边（任务栏顶边），永远可站，不受窗口遮挡影响。
//   窗口顶边：y = 可见矩形的顶边。去掉 z 序更高的窗口盖住的部分——盖住顶边那一行的，以及占住头顶空间
//   [y - headroom, y) 的（state-rules §2.3“上方角色高 + 4 像素内没有别的窗口挡着”）；只留落在某个显示器工作区里、
//   头顶放得下（y - headroom ≥ 显示器上边）的部分；短于 minWidth 的丢掉。同一个窗口切出来的几段共用 key。
//   窗口里面的底边（2026-10-21，N2.4）：给了 inside 选项才算，每个非置顶窗口一段，排在最后（见下面）。
// 窗口数 n 时 O(n²) 次区间相减，200 个窗口以内是亚毫秒级。自写。
import type {DesktopSnapshot, DisplayInfo, Point} from '../shared/types.ts';
import type {Support, SupportOptions} from './types.ts';

type Span = [number, number];

function subtract(spans: Span[], a: number, b: number): Span[] {
  const out: Span[] = [];
  for (const [x0, x1] of spans) {
    if (b <= x0 || a >= x1) { out.push([x0, x1]); continue; }
    if (a > x0) out.push([x0, a]);
    if (b < x1) out.push([b, x1]);
  }
  return out;
}

export function computeSupports(snap: DesktopSnapshot, opt: SupportOptions): Support[] {
  const out: Support[] = [];
  for (const d of snap.displays) {
    out.push({key: `floor:${d.id}`, kind: 'floor', y: d.workArea.bottom, x0: d.workArea.left, x1: d.workArea.right, displayId: d.id, rect: null});
  }
  const wins = snap.windows;
  for (let i = 0; i < wins.length; i++) {
    const w = wins[i], y = w.rect.top;
    for (const d of snap.displays) {
      const wa = d.workArea, head = opt.headroom(d);
      if (y < wa.top || y >= wa.bottom || y - head < d.bounds.top) continue;
      let spans: Span[] = [[Math.max(w.rect.left, wa.left), Math.min(w.rect.right, wa.right)]];
      if (spans[0][1] <= spans[0][0]) continue;
      for (let j = 0; j < i && spans.length; j++) {
        const u = wins[j].rect;
        // 和 [y - head, y]（头顶空间 + 顶边那一行）有纵向重叠就挡住了
        if (u.top <= y && u.bottom > y - head) spans = subtract(spans, u.left, u.right);
      }
      const min = opt.minWidth(d);
      for (const [x0, x1] of spans) {
        if (x1 - x0 >= min) out.push({key: `win:${w.hwnd}`, kind: 'window', y, x0, x1, displayId: d.id, rect: w.rect});
      }
    }
  }
  // 窗口里面的底边（inside:W，N2.4，2026-10-21）：不管被谁盖住（角色在那个窗口那一层，被盖住就跟着被盖住），按 z 序从上到下排
  // （松手时按这个顺序找光标下最上面的窗口，behavior/actor.ts releaseActor）
  if (opt.inside) for (const w of wins) {
    if (w.topmost) continue;
    const r = w.rect, d = displayAt(snap.displays, {x: (r.left + r.right) / 2, y: r.bottom - 1});
    const inset = opt.inside.inset(d), y = r.bottom - inset;
    if (y > d.workArea.bottom || y <= d.bounds.top || r.bottom - r.top < opt.headroom(d) + inset) continue;
    const x0 = Math.max(r.left + inset, d.bounds.left), x1 = Math.min(r.right - inset, d.bounds.right);
    if (x1 - x0 >= opt.minWidth(d)) out.push({key: `in:${w.hwnd}`, kind: 'inside', y, x0, x1, displayId: d.id, rect: r});
  }
  return out;
}

/** 点所在的显示器；不在任何显示器里时取离它最近的（到矩形的距离） */
export function displayAt(displays: readonly DisplayInfo[], p: Point): DisplayInfo {
  let best = displays[0], bestDist = Infinity;
  for (const d of displays) {
    const b = d.bounds;
    const dx = p.x < b.left ? b.left - p.x : p.x >= b.right ? p.x - b.right + 1 : 0;
    const dy = p.y < b.top ? b.top - p.y : p.y >= b.bottom ? p.y - b.bottom + 1 : 0;
    const dist = dx * dx + dy * dy;
    if (dist === 0) return d;
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  return best;
}
