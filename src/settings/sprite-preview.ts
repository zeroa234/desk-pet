// 设置窗口里的角色预览（2026-10-29）：读角色包导出的真实图集（pet://app/<包>/sprites/…），画在 canvas 上，脚底对齐底边中点。
// 排版和拆块规则用 src/shared/sheets.ts（和舞台同一份）。像素风最近邻、高清平滑；“减少动画”时只画第一帧；页面藏起来时停。
import {cellOrigin, frameAt, sheetFile, type SheetGrid} from '../shared/sheets.ts';

interface Meta extends SheetGrid {fps: number; foot: [number, number]; footY?: number[]}
const metaCache = new Map<string, Promise<Meta | null>>();
const imageCache = new Map<string, Promise<HTMLImageElement | null>>();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function loadMeta(url: string): Promise<Meta | null> {
  let p = metaCache.get(url);
  if (!p) metaCache.set(url, p = fetch(url).then(r => r.ok ? r.json() as Promise<Meta> : null).catch(() => null));
  return p;
}
function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = imageCache.get(url);
  if (!p) imageCache.set(url, p = new Promise(resolve => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = url; }));
  return p;
}

export interface PreviewOpts {
  /** 角色包目录（相对项目根） */
  dir: string;
  variant: string;
  /** 渲染高度（变体的 renderHeight）：站着的身高是多少个渲染像素 */
  renderHeight: number;
  smooth: boolean;
  /** 显示时站着的身高（CSS 像素） */
  height: number;
  action?: string;
  facing?: 'right' | 'left';
  animate?: boolean;
  label: string;
}

/** 一个预览：canvas 元素 + 改参数 / 启停 */
export class SpritePreview {
  readonly canvas: HTMLCanvasElement;
  private o: PreviewOpts;
  private meta: Meta | null = null;
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private token = 0;
  private loaded = false;
  /** 不马上读图：页面第一次显示（start）时才读，没打开的页不占内存 */
  constructor(o: PreviewOpts) {
    this.o = o;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sprite';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', o.label);
  }
  private base() { return `pet://app/${this.o.dir}/sprites/${this.o.variant}/clothed/${this.o.action ?? 'idle'}-${this.o.facing ?? 'right'}`; }
  private async load(): Promise<void> {
    const token = ++this.token;
    const meta = await loadMeta(this.base() + '.json');
    if (token !== this.token) return;
    this.meta = meta; this.frame = 0;
    await this.draw();
    if (this.running) this.schedule();
  }
  update(patch: Partial<PreviewOpts>): void {
    const reload = patch.dir !== undefined && patch.dir !== this.o.dir || patch.variant !== undefined && patch.variant !== this.o.variant;
    this.o = {...this.o, ...patch};
    if (patch.label) this.canvas.setAttribute('aria-label', patch.label);
    if (!this.loaded) return;
    if (reload) void this.load(); else void this.draw();
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.loaded) { this.loaded = true; void this.load(); } else this.schedule();
  }
  stop(): void { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const m = this.meta;
    if (!this.running || !m || !(this.o.animate ?? true) || reduceMotion.matches || m.frames < 2) return;
    this.timer = setTimeout(() => { this.frame = (this.frame + 1) % m.frames; void this.draw().then(() => this.schedule()); }, 1000 / (m.fps || 12));
  }
  private async draw(): Promise<void> {
    const m = this.meta, c = this.canvas;
    if (!m) return;
    const at = frameAt(m, this.frame), img = await loadImage(sheetFile(this.base(), at.chunk));
    if (!img || m !== this.meta) return;
    // 每个渲染像素占 k 个 CSS 像素；画布按设备像素比开大，CSS 尺寸 = 格子 × k
    const k = this.o.height / this.o.renderHeight, dpr = devicePixelRatio || 1;
    const cssW = Math.ceil(m.cell[0] * k), cssH = Math.ceil(m.cell[1] * k);
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
      c.style.setProperty('width', `${cssW}px`); c.style.setProperty('height', `${cssH}px`);
    }
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.imageSmoothingEnabled = this.o.smooth;
    g.imageSmoothingQuality = 'high';
    const kp = k * dpr;
    // 脚底点放在格子里原来的位置（整张画布 = 一格），这样每帧不跳
    const {left, top} = cellOrigin(m, this.frame, m.foot[0] * kp, m.foot[1] * kp, kp);
    g.drawImage(img, at.sx, at.sy, m.cell[0], m.cell[1], left, top, m.cell[0] * kp, m.cell[1] * kp);
  }
}
