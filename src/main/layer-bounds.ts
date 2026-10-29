// 躲藏层 / 窗口里面那一层的小窗口：什么时候重排（setBounds）、排多大。纯函数，不碰 electron。
// 2026-10-29 用户：桌宠在窗口里行走时轻微抽动。以前小窗口只比要画的东西四周宽一个边距（8 逻辑像素），她走出这个边距就整块重排——
// 用真的角色包（silent，r80，显示高度 160 逻辑像素，200% 缩放）在窗口里面走，一秒重排约 5.4 次，间隔中位 0.17 秒。
// 每次重排窗口挪位置、改大小，页面的画布跟着清空，再等下一帧画面才画回来（期间旧坐标按新窗口原点画，偏一小段），看上去就是抽一下。
// 现在重排时横向多留一段（pad，按要画的东西的宽度），她接着往一个方向走一段不用再排；重排次数从“每走几个像素”降到“每走几个身位”。
import type {Rect} from '../shared/types.ts';

export interface LayerBoundsOptions {
  /** 要画的东西四周的边距（物理像素） */
  margin: number;
  /** 重排时横向再多留的（物理像素，不小于 margin） */
  pad: number;
  /** 小窗口尽量不超出这个范围（所在显示器）；要画的东西自己超出去的部分照样盖住 */
  limit: Rect;
}

/**
 * need：要画的东西的范围（物理像素，含特效的地方）。current：小窗口现在的范围，没有 = 刚用上。
 * 现在的范围盖得住 need 就返回 null（不动它）；否则返回新的范围：need 四周留 margin，横向再多留到 pad，不超出 limit，
 * 但 need 加 margin 一定盖得住（need 在 limit 外面时以 need 为准）。
 */
export function layerBounds(current: Rect | null, need: Rect, opt: LayerBoundsOptions): Rect | null {
  if (current && need.left >= current.left && need.top >= current.top && need.right <= current.right && need.bottom <= current.bottom) return null;
  const m = opt.margin, pad = Math.max(opt.pad, m), lim = opt.limit;
  const near = {left: Math.floor(need.left) - m, top: Math.floor(need.top) - m, right: Math.ceil(need.right) + m, bottom: Math.ceil(need.bottom) + m};
  return {
    left: Math.min(Math.max(Math.floor(need.left) - pad, lim.left), near.left),
    top: near.top,
    right: Math.max(Math.min(Math.ceil(need.right) + pad, lim.right), near.right),
    bottom: near.bottom,
  };
}

/** 重排时横向多留多少：要画的东西宽度的一倍半，至少 margin */
export const layerPad = (need: Rect, margin: number): number => Math.max(margin, Math.round(1.5 * (need.right - need.left)));
