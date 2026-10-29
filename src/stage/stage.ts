import {SpeechDisplay, type StageSpeech} from './speech.ts';
// 舞台：一个显示器一个全屏透明覆盖窗口，这是它的页面（design.md §1、§5）。只负责画和判点，不做决定。
//   - 主进程每次画面有变化时发 StageFrame（角色画哪张图集的第几帧、脚底点在哪、放大几倍）。
//   - 画布是物理像素分辨率；每次只清掉上一帧角色占的矩形再画，不整屏重画（Chromium 只合成变化的区域）。
//   - 判点（R8.2）：窗口平时鼠标穿透（setIgnoreMouseEvents(true, {forward: true})，mousemove 照样转发进来），
//     查光标下那一帧图集的 alpha；在角色的不透明像素上就告诉主进程关掉穿透，按下左键就是抓起（R2.6）。
//   - 调试叠加层（R13.3）画在另一张画布上：窗口矩形、支撑面、角色状态。
//   - 特效（阶段 2）：角色身上的 fx（换衣着时挡住全身的一团烟、被发现时头顶的感叹号、心），按像素格子画（格子 = 2 个渲染像素），
//     和精灵的像素风一致；随 t（播了几秒）变化，主进程在特效播放期间按 30 Hz 发帧。
//   - 躲藏层的小窗口（阶段 2）也用这个页面，只是画的角色少、没有调试层。
//   - 音效（2026-10-20，R2.8、R6.3）：主进程只给一个覆盖窗口发 stage:sound（已经按规则挑好文件、算好增益），这里用 Web Audio 播：
//     解码后的声音用到才读、按最久没用的释放（AUDIO_BUDGET_MB）；变调用 playbackRate（和 Minecraft 一样长短跟着变）；左右声像；
//     躲着的闷一点（低通）；总线上一个压限器，叠在一起超过满幅时才起作用（视频那边混音也是“只在超过满幅处限幅”）。
//   - 图集用到才读、解码成 ImageBitmap 留着；解码后总量超过 StageInit.sheetBudgetMB 时，按最久没用的先释放（close()），
//     这一帧正在画的不放；放掉的下次用到再读（design.md §3.1）。判点用的 alpha 按帧格子取、用到才取，也算进总量。
//   - 液体（2026-10-20，design.md §3.7；要画什么由主进程的 src/fluid/ 定）：地上的水洼（StageFrame.ground）先画；每个角色
// （开源版省略）
//     涂层按单人 nude 图集的编号图（<sheet>.ids.png，每个像素的 RGB = 身体表面的格子编号，scripts/export-pack/surface.mjs）：这一帧
//     格子里编号在某一层列表里的像素涂成那一层的颜色，被挡住的格子本来就不在图里。编号图解码时不做颜色管理
//     （colorSpaceConversion: 'none'），也算进图集内存。
//   - 点、拎、摸（2026-10-21，R3.6、R2.6）：在角色身上按下左键先不拎——拖动超过 4 逻辑像素（Windows 默认的拖动阈值 SM_CXDRAG）
//     或按住 pressMs 毫秒（默认 300，VPet 的默认长按时长）才拎（stage:grab）；没到就松开算点了一下（stage:poke click）。
//     按着的时候 hover 不放（角色走开了也不让主进程设回穿透，不然松手那一下落到下面的窗口里）。不按键、光标在角色身上来回晃
//     算摸（stroke）：照 VPet 的 MainGrid_MouseWave（VPet-Simulator.Core/Display/Main.xaml.cs，Apache-2.0）——横向来回换方向
//     （每次往回走够 WAVE_DIP）满 WAVE_SWITCHES 次就算摸了一下，两次移动隔了 2 秒以上从头数；换方向按光标相对她脚底点的位置、
//     光标在她格子里的移动算（她在走时屏幕上的来回会被抵掉；摸的时候光标会晃出轮廓），其中至少三分之一要落在她身上。点到 / 摸到哪个部位查导出的部位图
//     （<图集>.parts.png，同编号图的读法，用到才读、算进图集内存），报序号，主进程换成名字。
// 自写（判法照 VPet、Windows 的默认值）；只用 DOM / Canvas 2D。
import {BLOT_ELLIPSE, type Blot, type DebugInfo, type DrawItem, type PaintLayer, type StageFrame, type StageInit, type StagePassive, type StagePoke, type StageSound, type StageStat} from './protocol.ts';
import {cellOrigin, chunkCount, frameAt, sheetFile} from '../shared/sheets.ts';
import {stageCursor, type StageCursor} from './cursor.ts';

interface PetBridge {
  onSpeech(cb: (s:StageSpeech|null)=>void): void;
  onInit(cb: (v: StageInit) => void): void;
  onFrame(cb: (v: StageFrame) => void): void;
  onPassive(cb: (v: StagePassive) => void): void;
  onSound(cb: (v: StageSound) => void): void;
  onSoundStop(cb: () => void): void;
  ready(): void;
  hover(over: boolean): void;
  grab(id: string): void;
  poke(v: StagePoke): void;
  stat(v: StageStat): void;
}
interface SheetMeta {
  frames: number;
  cell: [number, number];
  cols: number;
  /** 拆块时每个文件几帧（src/shared/sheets.ts）；没有 = 一个文件 */
  chunk?: number;
  foot: [number, number];
  footY?: number[];
  /** 有部位图 <图集>.parts.png */
  parts?: true;
}
/** 一个图文件（没拆的图集一个，拆块的每块一个）：解码好的图 + 判点用的 alpha */
interface SheetImage {
  /** 哪张图集（不带扩展名的路径） */
  sheet: string;
  img: ImageBitmap;
  /** 判点用：（文件里的）帧号 → 这一格的 alpha（用到才取） */
  alpha: Map<number, Uint8Array>;
  /** 解码后大约占多少字节：图 RGBA + 已取的 alpha 格子 */
  bytes: number;
  /** 最近一次画 / 判点用到它的序号（越小越久没用） */
  used: number;
}
/** 一帧在哪：帧表、哪个文件、文件里的位置、文件里的帧号 */
interface FrameRef {
  meta: SheetMeta;
  image: SheetImage;
  sx: number;
  sy: number;
  local: number;
}

const pet = (window as unknown as {pet: PetBridge}).pet;
const sprites = document.getElementById('sprites') as HTMLCanvasElement;
const debugCanvas = document.getElementById('debug') as HTMLCanvasElement;
const ctx = sprites.getContext('2d')!;
const dctx = debugCanvas.getContext('2d')!;

let init: StageInit | null = null;
let items: DrawItem[] = [];
let ground: Blot[] = [];
let dirtyRects: [number, number, number, number][] = [];
let hover = false;
/** 这块窗口发起了拎（startGrab），到主进程把它设回穿透为止：拎着的时候光标可能滑出角色的不透明像素，样式仍然是 grabbing */
let grabbedHere = false;
/** 主进程最近一帧给的光标样式；真正用不用见 applyCursor */
let frameCursor: StageCursor = 'default';
let lastMouse: {x: number; y: number} | null = null;
/** 帧表（小，读了就一直留着）：图集路径 → 帧表 */
const metas = new Map<string, SheetMeta | 'loading'>();
/** 图（按文件记账、超预算释放）：文件路径（带 .png）→ 图 */
const images = new Map<string, SheetImage | 'loading'>();
/**
 * 每个角色上一次画出来的那一帧（和画它时的放大倍数、缩放方式）：要画的那一帧还在读时先停在这一帧——拆块的图集换块、换动作换到
 * 没在内存里的图集时不闪空（高清的图集一块解码后 16 MB，内存上限下待机一段就放不下，换动作多半要重读）
 */
const lastShown = new Map<string, {sheet: string; frame: number; k: number; smooth: boolean}>();
/**
 * （开源版省略）
 * 键 = 文件路径（<图集>[.c<i>].<种类>.png）→ 图 + 按（文件里的）帧取出来的编号
 */
type CodeKind = 'ids' | 'parts';
interface IdSheet {
  sheet: string;
  img: ImageBitmap;
  cells: Map<number, Uint32Array>;
  bytes: number;
  used: number;
}
const idSheets = new Map<string, IdSheet | 'loading' | 'missing'>();
let useSeq = 0;
/** 没收到 init 之前的默认值同 settings.ts */
const budgetBytes = () => (init?.sheetBudgetMB ?? 150) * 2 ** 20;

function fitCanvas(): void {
  const w = Math.round(innerWidth * devicePixelRatio), h = Math.round(innerHeight * devicePixelRatio);
  for (const c of [sprites, debugCanvas]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  ctx.imageSmoothingEnabled = false;
  dirtyRects = [[0, 0, w, h]];
}
addEventListener('resize', () => { fitCanvas(); draw(); });

async function loadMeta(path: string): Promise<void> {
  metas.set(path, 'loading');
  try {
    metas.set(path, await fetch(`pet://app/${path}.json`).then(r => r.json() as Promise<SheetMeta>));
    draw();
  } catch (e) {
    metas.delete(path);
    console.error('帧表加载失败', path, e);
  }
}

async function loadImage(file: string, sheet: string): Promise<void> {
  images.set(file, 'loading');
  try {
    const img = await createImageBitmap(await fetch(`pet://app/${file}`).then(r => r.blob()));
    images.set(file, {sheet, img, alpha: new Map(), bytes: img.width * img.height * 4, used: ++useSeq});
    trimSheets();
    draw();
  } catch (e) {
    images.delete(file);
    console.error('图集加载失败', file, e);
  }
}

/** 帧表里的第 frame 帧：在哪个文件、文件里的位置和帧号；那个文件读好了才有 image */
function locate(sheet: string, meta: SheetMeta, frame: number): {file: string; image: SheetImage | 'loading' | undefined; sx: number; sy: number; local: number} {
  const at = frameAt(meta, frame), file = sheetFile(sheet, at.chunk);
  return {file, image: images.get(file), sx: at.sx, sy: at.sy, local: meta.chunk ? frame % meta.chunk : frame};
}

/** 拆块的图集画到一块的后一半时先读下一块（循环的最后一块接第一块），换块时不用等；kind = 编号图 / 部位图，不给 = 图 */
function prefetchNext(sheet: string, meta: SheetMeta, frame: number, kind?: CodeKind): void {
  if (!meta.chunk || (frame % meta.chunk) * 2 < meta.chunk) return;
  const file = sheetFile(sheet, (Math.floor(frame / meta.chunk) + 1) % chunkCount(meta), kind);
  if (kind) { if (!idSheets.has(file)) void loadIds(file, sheet); }
  else if (!images.has(file)) void loadImage(file, sheet);
}

/** 这张图集第 frame 帧在哪个文件、文件里的哪一格；帧表或那个文件还在读时返回 null（读好了 draw() 会再来） */
function frameRef(sheet: string, frame: number): FrameRef | null {
  const meta = metas.get(sheet);
  if (meta === undefined) void loadMeta(sheet);
  if (!meta || meta === 'loading') return null;
  const at = locate(sheet, meta, frame);
  if (at.image === undefined) void loadImage(at.file, sheet);
  prefetchNext(sheet, meta, frame);
  if (!at.image || at.image === 'loading') return null;
  at.image.used = ++useSeq;
  return {meta, image: at.image, sx: at.sx, sy: at.sy, local: at.local};
}

/** 超预算时从最久没用的开始释放（图和编号图一起算）；这一帧要画的文件不放（都在画还超就先超着） */
function trimSheets(): void {
  type Entry = {key: string; s: {img: ImageBitmap; bytes: number; used: number}; map: Map<string, unknown>};
  const all: Entry[] = [];
  for (const [key, s] of images) if (s !== 'loading') all.push({key, s, map: images});
  for (const [key, s] of idSheets) if (typeof s !== 'string') all.push({key, s, map: idSheets});
  let total = all.reduce((t, e) => t + e.s.bytes, 0);
  if (total <= budgetBytes()) return;
  // 在画的：这一帧每个角色所在的文件（和停在上一帧的那个），和它们的编号图、部位图
  const drawing = new Set<string>();
  for (const it of items) for (const [sheet, frame] of [[it.sheet, it.frame], [lastShown.get(it.id)?.sheet, lastShown.get(it.id)?.frame]] as const) {
    const meta = sheet === undefined ? undefined : metas.get(sheet);
    if (!meta || meta === 'loading' || frame === undefined) continue;
    const c = frameAt(meta, frame).chunk;
    for (const kind of [undefined, 'ids', 'parts'] as const) drawing.add(sheetFile(sheet!, c, kind));
  }
  for (const e of all.filter(e => !drawing.has(e.key)).sort((a, b) => a.s.used - b.s.used)) {
    if (total <= budgetBytes()) break;
    e.s.img.close();
    e.map.delete(e.key);
    total -= e.s.bytes;
    console.info(`释放${e.map === idSheets ? '编号图' : '图集'} ${e.key}（${(e.s.bytes / 2 ** 20).toFixed(1)} MB）`);
  }
}

/** 编号图：用到才读；没有这个文件（旧角色包、不是 nude）记 missing，不再试 */
async function loadIds(file: string, sheet: string): Promise<void> {
  idSheets.set(file, 'loading');
  try {
    const r = await fetch(`pet://app/${file}`);
    if (!r.ok) { idSheets.set(file, 'missing'); return; }
    const img = await createImageBitmap(await r.blob(), {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
    idSheets.set(file, {sheet, img, cells: new Map(), bytes: img.width * img.height * 4, used: ++useSeq});
    trimSheets();
    draw();
  } catch (e) {
    console.error('编号图加载失败', file, e);
    idSheets.set(file, 'missing');
  }
}

/** 第 frame 帧格子的编号（cw × ch）；kind 默认 ids（表面格子），parts = 部位序号 */
function idsOf(path: string, meta: SheetMeta, frame: number, kind: CodeKind = 'ids'): Uint32Array | null {
  const at = frameAt(meta, frame), file = sheetFile(path, at.chunk, kind), s = idSheets.get(file);
  if (s === undefined) void loadIds(file, path);
  // （开源版省略）
  prefetchNext(path, meta, frame, kind);
  if (!s || typeof s === 'string') return null;
  s.used = ++useSeq;
  const local = meta.chunk ? frame % meta.chunk : frame, hit = s.cells.get(local);
  if (hit) return hit;
  const [cw, ch] = meta.cell, c = new OffscreenCanvas(cw, ch), g = c.getContext('2d', {willReadFrequently: true})!;
  g.drawImage(s.img, at.sx, at.sy, cw, ch, 0, 0, cw, ch);
  const d = g.getImageData(0, 0, cw, ch).data, ids = new Uint32Array(cw * ch);
  for (let i = 0; i < ids.length; i++) if (d[i * 4 + 3] === 255) ids[i] = (d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2];
  s.cells.set(local, ids);
  s.bytes += ids.byteLength;
  return ids;
}

/**
 * 涂好的小图（格子大小）：按顺序一层盖一层（后面的层盖前面的）；每层四分之一的格子（按编号）颜色深 6%，不是一整块平涂。
 * 同一个角色同一张图、同一帧、同一组层只算一次。
 */
const paintCache = new Map<string, {key: string; img: OffscreenCanvas | null}>();
function paintLayer(it: DrawItem, meta: SheetMeta): OffscreenCanvas | null {
  const key = `${it.sheet}|${it.frame}|${JSON.stringify(it.paint)}`, hit = paintCache.get(it.id);
  if (hit?.key === key) return hit.img;
  const ids = idsOf(it.sheet, meta, it.frame);
  if (!ids) return null;   // 还在读：先不画，读好了 draw() 会再来
  const layers = (it.paint ?? []).map(([c, a, list]: PaintLayer) => ({set: new Set(list), rgb: [c >> 16, (c >> 8) & 255, c & 255], a: Math.round(a * 255)}));
  const [cw, ch] = meta.cell, im = new ImageData(cw, ch);
  let any = false;
  for (let i = 0; i < ids.length; i++) {
    const v = ids[i];
    if (!v) continue;
    for (let k = layers.length - 1; k >= 0; k--) {
      const L = layers[k];
      if (!L.set.has(v)) continue;
      const f = (Math.imul(v, 2654435761) >>> 30) === 0 ? 0.94 : 1;
      im.data.set([L.rgb[0] * f, L.rgb[1] * f, L.rgb[2] * f, L.a], i * 4);
      any = true;
      break;
    }
  }
  let img: OffscreenCanvas | null = null;
  if (any) { img = new OffscreenCanvas(cw, ch); img.getContext('2d')!.putImageData(im, 0, 0); }
  paintCache.set(it.id, {key, img});
  return img;
}

/** 小数的矩形往外取整（高清变体的放大倍数是小数，清掉的范围要盖住画过的每个像素） */
function outward(x: number, y: number, w: number, h: number): [number, number, number, number] {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  return [x0, y0, Math.ceil(x + w) - x0, Math.ceil(y + h) - y0];
}

function drawBlots(list: readonly Blot[] | undefined): void {
  for (const [x, y, w, h, c, a, shape] of list ?? []) {
    ctx.fillStyle = `rgba(${c >> 16},${(c >> 8) & 255},${c & 255},${a})`;
    if (shape === BLOT_ELLIPSE) {
      // 内切椭圆（高清变体的水珠、水洼）：抗锯齿的边会出矩形外一点，清的范围多留一像素
      ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI); ctx.fill();
      dirtyRects.push(outward(x - 1, y - 1, w + 2, h + 2));
    } else {
      ctx.fillRect(x, y, w, h);
      dirtyRects.push(outward(x, y, w, h));
    }
  }
}

/** 一个角色在画布上占的矩形（物理像素）；frame、k = 画的是哪一帧、按多大画（停在上一帧时不是 it.frame、it.k） */
function placement(it: DrawItem, meta: SheetMeta, frame: number, k = it.k): {dx: number; dy: number; w: number; h: number} {
  const [cw, ch] = meta.cell, o = cellOrigin(meta, frame, it.x, it.y, k);
  return {dx: o.left, dy: o.top, w: cw * k, h: ch * k};
}

/** 画出来的那一帧：要画的；还在读时上一次画的那帧（fresh = false，可能是别的图集、别的倍数） */
interface Shown { ref: FrameRef; frame: number; k: number; smooth: boolean; fresh: boolean }
function shownRef(it: DrawItem): Shown | null {
  const ref = frameRef(it.sheet, it.frame), smooth = !!it.smooth;
  if (ref) { lastShown.set(it.id, {sheet: it.sheet, frame: it.frame, k: it.k, smooth}); return {ref, frame: it.frame, k: it.k, smooth, fresh: true}; }
  const last = lastShown.get(it.id), meta = last && metas.get(last.sheet);
  if (!last || !meta || meta === 'loading') return null;
  const at = locate(last.sheet, meta, last.frame);
  if (!at.image || at.image === 'loading') return null;
  return {ref: {meta, image: at.image, sx: at.sx, sy: at.sy, local: at.local}, frame: last.frame, k: last.k, smooth: last.smooth, fresh: false};
}

function draw(): void {
  for (const [x, y, w, h] of dirtyRects) ctx.clearRect(x, y, w, h);
  dirtyRects = [];
  drawBlots(ground);
  for (const it of items) {
    if (it.clip) { ctx.save(); ctx.beginPath(); ctx.rect(...it.clip); ctx.clip(); }
    drawBlots(it.under);
    const shown = shownRef(it);
    if (shown) {
      const {ref, frame} = shown, p = placement(it, ref.meta, frame, shown.k), [cw, ch] = ref.meta.cell;
      // 像素风：最近邻整数倍；高清（smooth）：平滑缩放
      ctx.imageSmoothingEnabled = shown.smooth;
      if (shown.smooth) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(ref.image.img, ref.sx, ref.sy, cw, ch, p.dx, p.dy, p.w, p.h);
      dirtyRects.push(outward(p.dx, p.dy, p.w, p.h));
      const st = it.paint?.length && shown.fresh ? paintLayer(it, ref.meta) : null;
      if (st) ctx.drawImage(st, 0, 0, cw, ch, p.dx, p.dy, p.w, p.h);
      ctx.imageSmoothingEnabled = false;
    }
    drawBlots(it.over);
    // 图集还在读（第一次用、或者被释放过）时特效照画：换场景图时那团烟本来就是为了挡这一下
    for (const f of it.fx ?? []) drawFx(it, f);
    if (it.clip) ctx.restore();
  }
}

// ---------- 特效 ----------
// 像素图案（# = 填色，o = 描边色）
const GLYPH: Record<'alert' | 'heart', string[]> = {
  alert: ['ooo', 'o#o', 'o#o', 'o#o', 'o#o', 'ooo', 'o#o', 'ooo'],
  heart: ['.oo.oo.', 'o##o##o', 'o#####o', 'o#####o', '.o###o.', '..o#o..', '...o...'],
};
const FX_COLOR = {alert: ['#ff3b3b', '#2a0a0a'], heart: ['#ff6fae', '#3a0a1e']} as const;

/** 一团烟：几个圆，从身体中间往外长、最后变淡；格子大小 2k，像素风 */
function drawPuff(it: DrawItem, t: number, h: number, dx: number): void {
  const cell = 2 * (it.u ?? it.k), life = 0.6, u = Math.min(1, t / life);
  const cx = it.x + dx, cy = it.y - h * 0.5;
  const grow = 0.55 + 0.45 * Math.min(1, u * 2.5), alpha = u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4;
  // 圆心（相对身体中心，单位 = 身高）和半径：盖住身体（半宽约 0.2 身高）就够，不往外铺太多
  const blobs = [[0, 0, 0.3], [-0.13, -0.25, 0.2], [0.13, -0.27, 0.2], [-0.15, 0.18, 0.2], [0.15, 0.2, 0.2], [0, -0.4, 0.16], [0, 0.38, 0.16], [-0.24, 0, 0.14], [0.24, -0.02, 0.14]];
  ctx.globalAlpha = Math.max(0, alpha);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [pass, color] of [[1, '#9a9aae'], [0, '#ececf4']] as const) {
    ctx.fillStyle = color;
    for (const [bx, by, br] of blobs) {
      const r = (br * h * grow) + pass * cell, ox = cx + bx * h * grow, oy = cy + by * h * grow;
      for (let gy = Math.floor((oy - r) / cell); gy <= Math.ceil((oy + r) / cell); gy++) {
        for (let gx = Math.floor((ox - r) / cell); gx <= Math.ceil((ox + r) / cell); gx++) {
          const px = gx * cell + cell / 2, py = gy * cell + cell / 2;
          if ((px - ox) ** 2 + (py - oy) ** 2 > r * r) continue;
          ctx.fillRect(gx * cell, gy * cell, cell, cell);
          x0 = Math.min(x0, gx * cell); y0 = Math.min(y0, gy * cell); x1 = Math.max(x1, gx * cell + cell); y1 = Math.max(y1, gy * cell + cell);
        }
      }
    }
  }
  ctx.globalAlpha = 1;
  if (x1 > x0) dirtyRects.push([x0, y0, x1 - x0, y1 - y0]);
}

function drawFx(it: DrawItem, f: NonNullable<DrawItem['fx']>[number]): void {
  if (f.fx === 'puff') return drawPuff(it, f.t, f.h, f.dx ?? 0);
  const g = GLYPH[f.fx], [fill, line] = FX_COLOR[f.fx];
  const cell = 2 * (it.u ?? it.k), w = g[0].length * cell, hh = g.length * cell;
  // 头顶右上方；前 0.15 秒从下面弹上来，最后 0.3 秒变淡
  const life = 1.2, pop = Math.min(1, f.t / 0.15);
  const x = Math.round((it.x + (f.dx ?? 0) + f.h * 0.12) / cell) * cell, y = Math.round((it.y - f.h - hh * 0.6 - (1 - pop) * -hh * 0.5 - f.t * cell) / cell) * cell;
  ctx.globalAlpha = f.t > life - 0.3 ? Math.max(0, (life - f.t) / 0.3) : 1;
  g.forEach((row, j) => [...row].forEach((ch, i) => {
    if (ch === '.') return;
    ctx.fillStyle = ch === '#' ? fill : line;
    ctx.fillRect(x + i * cell, y + j * cell, cell, cell);
  }));
  ctx.globalAlpha = 1;
  dirtyRects.push([x, y, w, hh]);
}

// ---------- 判点：光标下是不是某个角色的不透明像素 ----------
/** 这一帧那一格的 alpha（cw × ch）：用到才从图里取这一格，记在这个文件的 alpha 里（整张图集取一遍，场景图要多占几十 MB） */
function alphaOf(ref: FrameRef): Uint8Array {
  const s = ref.image, hit = s.alpha.get(ref.local);
  if (hit) return hit;
  const [cw, ch] = ref.meta.cell, c = new OffscreenCanvas(cw, ch), g = c.getContext('2d', {willReadFrequently: true})!;
  g.drawImage(s.img, ref.sx, ref.sy, cw, ch, 0, 0, cw, ch);
  const rgba = g.getImageData(0, 0, cw, ch).data, a = new Uint8Array(cw * ch);
  for (let i = 0; i < a.length; i++) a[i] = rgba[i * 4 + 3];
  s.alpha.set(ref.local, a);
  s.bytes += a.length;
  return a;
}

/** 光标下最上面那个角色和那个像素的部位序号（这张图有部位图、已经读好时；否则 null） */
function hitAt(px: number, py: number): {id: string; part: number | null} | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i], shown = shownRef(it);
    if (!shown) continue;
    const {ref, frame} = shown, p = placement(it, ref.meta, frame, shown.k);
    if (px < p.dx || py < p.dy || px >= p.dx + p.w || py >= p.dy + p.h) continue;
    if (it.clip && (px < it.clip[0] || py < it.clip[1] || px >= it.clip[0] + it.clip[2] || py >= it.clip[1] + it.clip[3])) continue;
    const lx = Math.floor((px - p.dx) / shown.k), ly = Math.floor((py - p.dy) / shown.k), j = ly * ref.meta.cell[0] + lx;
    if (!(alphaOf(ref)[j] > 0)) continue;
    const parts = ref.meta.parts && shown.fresh ? idsOf(it.sheet, ref.meta, frame, 'parts') : null;
    return {id: it.id, part: parts?.[j] || null};
  }
  return null;
}
const hitTest = (px: number, py: number): string | null => hitAt(px, py)?.id ?? null;
// 只读的查询，给真机验收脚本（scripts/probe-poke.ts 经 CDP）用；页面自己不用：判点（按部位找点）、摸的计数（没触发时看卡在哪）
Object.assign(globalThis, {__petHit: hitAt, __petWave: () => (wave ? {...wave, parts: [...wave.parts]} : null)});

function setHover(over: boolean): void {
  // 按着还没拎 / 没松开的时候不放：角色走开了也要等松手（不然主进程设回穿透，松手那一下落到下面的窗口里）
  if (press && !over) return;
  if (over !== hover) { hover = over; applyCursor(); pet.hover(over); }
}
/** 光标样式只在这块窗口拥有鼠标时才不是 default，见 cursor.ts */
function applyCursor(): void {
  document.body.style.cursor = stageCursor(frameCursor, hover || grabbedHere);
}

// ---------- 点、拎、摸（R3.6、R2.6） ----------
/** Windows 默认的拖动阈值（SM_CXDRAG / SM_CYDRAG = 4，逻辑像素） */
const DRAG_DIP = 4;
/** 摸：往回走够这么远（逻辑像素）算换一次方向；换满几次算摸了一下；两次移动隔多久从头数（VPet：换方向 5 次以上、2 秒） */
const WAVE_DIP = 10, WAVE_SWITCHES = 5, WAVE_GAP_MS = 2000;
let press: {id: string; part: number | null; x: number; y: number; timer: ReturnType<typeof setTimeout>} | null = null;
function startGrab(): void {
  if (!press) return;
  clearTimeout(press.timer);
  pet.grab(press.id);
  press = null;
  grabbedHere = true;
  applyCursor();
}
function endPress(): void {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
  if (lastMouse) setHover(hitTest(lastMouse.x, lastMouse.y) !== null);
}
let wave: {id: string; dir: number; ext: number; switches: number; last: number; parts: Map<number, number>; samples: number; onBody: number} | null = null;
/** 光标在哪个角色的格子（这一帧精灵的矩形）里：摸的时候光标会晃出轮廓，只按像素判会漏掉来回的那几下 */
function cellAt(px: number, py: number): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i], shown = shownRef(it);
    if (!shown) continue;
    const p = placement(it, shown.ref.meta, shown.frame, shown.k);
    if (px >= p.dx && py >= p.dy && px < p.dx + p.w && py < p.dy + p.h) return it.id;
  }
  return null;
}
/**
 * 不按键时光标在角色的格子里动了一下（x = 光标相对她脚底点的横向位置；h = 落在她身上的像素时的判点结果）：横向来回换方向够次数、而且至少三分之一的移动落在
 * 她身上时报一次摸（部位按落在身上的那些里出现最多的）。换方向按格子里的所有移动算（VPet 按整个窗口算）。
 */
function trackStroke(x: number, id: string, h: {id: string; part: number | null} | null): void {
  const now = performance.now(), step = WAVE_DIP * devicePixelRatio;
  if (!wave || wave.id !== id || now - wave.last > WAVE_GAP_MS) wave = {id, dir: 0, ext: x, switches: 0, last: now, parts: new Map(), samples: 0, onBody: 0};
  wave.last = now;
  wave.samples++;
  if (h?.id === id) { wave.onBody++; if (h.part) wave.parts.set(h.part, (wave.parts.get(h.part) ?? 0) + 1); }
  if (wave.dir === 0) { if (Math.abs(x - wave.ext) >= step) { wave.dir = Math.sign(x - wave.ext); wave.ext = x; } return; }
  if ((x - wave.ext) * wave.dir > 0) { wave.ext = x; return; }
  if (Math.abs(x - wave.ext) < step) return;
  wave.dir = -wave.dir; wave.ext = x;
  if (++wave.switches < WAVE_SWITCHES) return;
  if (wave.onBody * 3 >= wave.samples) {
    let part: number | null = null, n = 0;
    for (const [p, c] of wave.parts) if (c > n) { n = c; part = p; }
    pet.poke({id: wave.id, part, kind: 'stroke'});
  }
  wave.switches = 0; wave.parts.clear(); wave.samples = 0; wave.onBody = 0;
}

let moves = 0;
addEventListener('mousemove', e => {
  moves++;
  lastMouse = {x: e.clientX * devicePixelRatio, y: e.clientY * devicePixelRatio};
  const h = hitAt(lastMouse.x, lastMouse.y);
  setHover(h !== null);
  if (press && (e.buttons & 1) && Math.hypot(lastMouse.x - press.x, lastMouse.y - press.y) > DRAG_DIP * devicePixelRatio) startGrab();
  else if (!press && !e.buttons) {
    // 来回按“光标相对她的脚底点”算：她在走、用户跟着她摸的时候，屏幕上的来回会被她走的那一段抵掉（2026-10-21 真机：
    // 跟着走着的她左右各晃 9 逻辑像素，按屏幕坐标一次都没算出换方向）
    const id = h?.id ?? cellAt(lastMouse.x, lastMouse.y), it = id ? items.find(x => x.id === id) : undefined;
    if (id && it) trackStroke(lastMouse.x - it.x, id, h);
  }
});
addEventListener('mouseleave', () => { lastMouse = null; setHover(false); });
// 每秒报一次收到几次 mousemove 等（主进程据此判断鼠标转发是不是断了，见 main.ts 'stage:stat'）
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  pet.stat({moves, hover, items: items.length, loaded: items.filter(it => frameRef(it.sheet, it.frame) !== null).length});
  moves = 0;
}, 1000);
// 主进程把窗口设回了穿透（重新显示、拖完松手、躲藏层收起）：hover 跟着清掉，不然页面以为光标还在角色上、下一次移上来不再报，
// 主进程那边却是穿透着的，点击直接穿过去。以前靠 visibilitychange，但页面设了 backgroundThrottling: false，窗口藏起来时
// 页面一直是 visible（Electron 文档），这个事件不会来。
pet.onPassive(v => {
  if (press) { clearTimeout(press.timer); press = null; }
  hover = false;
  grabbedHere = false;
  applyCursor();
  if (v.cursorStale) lastMouse = null;
  else if (lastMouse) setHover(hitTest(lastMouse.x, lastMouse.y) !== null);
});
addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const x = e.clientX * devicePixelRatio, y = e.clientY * devicePixelRatio, h = hitAt(x, y);
  if (!h) return;
  endPress();
  wave = null;
  // 光标出了这块窗口（躲藏层的小窗口）也要收到松手
  try { document.documentElement.setPointerCapture(e.pointerId); } catch { /* 不支持就算了 */ }
  press = {...h, x, y, timer: setTimeout(startGrab, init?.pressMs ?? 300)};
});
addEventListener('pointerup', e => {
  if (e.button !== 0 || !press) return;
  const {id, part} = press;
  endPress();
  pet.poke({id, part, kind: 'click'});
});
addEventListener('pointercancel', () => endPress());

// ---------- 音效 ----------
const AUDIO_BUDGET_MB = 32;
let actx: AudioContext | null = null, bus: AudioNode | null = null;
const buffers = new Map<string, {buf: AudioBuffer | null; bytes: number; used: number} | Promise<AudioBuffer | null>>();
const playing = new Set<AudioBufferSourceNode>();
function audio(): {ctx: AudioContext; bus: AudioNode} {
  if (!actx) {
    actx = new AudioContext();
    // 压限：门限 -1 dBFS、比例 20、起 3 ms，单个声音（导出时峰值已压到 -1 dB 以下）基本不碰，几个叠在一起超了才压
    const lim = actx.createDynamicsCompressor();
    lim.threshold.value = -1; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.1;
    lim.connect(actx.destination);
    bus = lim;
  }
  return {ctx: actx, bus: bus!};
}
async function bufferOf(url: string): Promise<AudioBuffer | null> {
  const hit = buffers.get(url);
  if (hit instanceof Promise) return hit;
  if (hit) { hit.used = ++useSeq; return hit.buf; }
  const p = (async () => {
    try {
      const data = await (await fetch(`pet://app/${url}`)).arrayBuffer();
      const buf = await audio().ctx.decodeAudioData(data);
      buffers.set(url, {buf, bytes: buf.length * buf.numberOfChannels * 4, used: ++useSeq});
      trimAudio();
      return buf;
    } catch (e) {
      console.error('声音加载失败', url, e);
      buffers.set(url, {buf: null, bytes: 0, used: ++useSeq});
      return null;
    }
  })();
  buffers.set(url, p);
  return p;
}
function trimAudio(): void {
  const done = [...buffers].filter((e): e is [string, {buf: AudioBuffer | null; bytes: number; used: number}] => !(e[1] instanceof Promise));
  let total = done.reduce((s, [, b]) => s + b.bytes, 0);
  for (const [url, b] of done.sort((x, y) => x[1].used - y[1].used)) {
    if (total <= AUDIO_BUDGET_MB * 2 ** 20) break;
    buffers.delete(url); total -= b.bytes;   // 正在放的由声源节点自己引用着，放完才回收
  }
}
pet.onSound(v => {
  const {ctx, bus: out} = audio();
  // 主进程开了 autoplay-policy=no-user-gesture-required，正常是 running；还停着就记一条（事件日志 stage-console），没声音时好查
  if (ctx.state === 'suspended') void ctx.resume().then(() => { if (ctx.state !== 'running') console.warn(`AudioContext 没跑起来：${ctx.state}`); });
  for (const s of v.sounds) void bufferOf(s.url).then(buf => {
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.playbackRate.value = s.pitch;
    const gain = ctx.createGain(); gain.gain.value = s.gain;
    const pan = ctx.createStereoPanner(); pan.pan.value = s.pan;
    let node: AudioNode = src;
    if (s.muffled) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400; node.connect(lp); node = lp; }
    node.connect(gain); gain.connect(pan); pan.connect(out);
    src.onended = () => playing.delete(src);
    playing.add(src);
    src.start(ctx.currentTime + s.delay);
  });
});
pet.onSoundStop(() => { for (const src of playing) { try { src.stop(); } catch { /* 已经停了 */ } } playing.clear(); });

// ---------- 调试叠加层 ----------
function drawDebug(d: DebugInfo | null): void {
  dctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
  if (!d) return;
  const fs = Math.round(11 * devicePixelRatio);
  dctx.font = `${fs}px Consolas, "Microsoft YaHei", monospace`;
  dctx.lineWidth = Math.max(1, Math.round(devicePixelRatio));
  const label = (text: string, x: number, y: number, color: string) => {
    const w = dctx.measureText(text).width;
    dctx.fillStyle = 'rgba(0,0,0,0.65)'; dctx.fillRect(x - 2, y - fs, w + 4, fs + 4);
    dctx.fillStyle = color; dctx.fillText(text, x, y);
  };
  dctx.strokeStyle = 'rgba(0,200,255,0.8)';
  for (const w of d.windows) {
    dctx.strokeRect(w.rect[0] + 0.5, w.rect[1] + 0.5, w.rect[2] - 1, w.rect[3] - 1);
    label(w.label, w.rect[0] + 4, w.rect[1] + fs + 4, '#7df');
  }
  for (const s of d.supports) {
    dctx.fillStyle = s.kind === 'floor' ? 'rgba(80,255,80,0.9)' : 'rgba(255,200,0,0.9)';
    dctx.fillRect(s.x0, s.y, s.x1 - s.x0, Math.max(2, Math.round(2 * devicePixelRatio)));   // 支撑线画在 y 下面（窗口第一行起）
  }
  for (const a of d.actors) {
    dctx.strokeStyle = '#f0f'; dctx.beginPath();
    dctx.moveTo(a.x - 8, a.y); dctx.lineTo(a.x + 8, a.y); dctx.moveTo(a.x, a.y - 8); dctx.lineTo(a.x, a.y + 8); dctx.stroke();
    a.lines.forEach((t, i) => label(t, a.x + 12, a.y - 12 - (a.lines.length - 1 - i) * (fs + 4), '#fcf'));
  }
  d.lines.forEach((t, i) => label(t, 12, 12 + (i + 1) * (fs + 4), '#ff8'));
}

pet.onInit(v => {
  init = v;
  fitCanvas();
  if (debugCanvas.width !== v.width || debugCanvas.height !== v.height)
    console.warn(`画布 ${debugCanvas.width}×${debugCanvas.height} 和显示器物理尺寸 ${v.width}×${v.height} 不一致`);
});
pet.onFrame(f => {
  items = f.items;
  ground = f.ground ?? [];
  draw();
  if (f.debug !== undefined) drawDebug(f.debug);
  frameCursor = f.cursor;
  applyCursor();
  // 光标不动、角色自己走过来或走开：没有 mousemove 也要重算（以前只算“走开”，角色走到静止的光标下面时点不到）
  if (lastMouse) setHover(hitTest(lastMouse.x, lastMouse.y) !== null);
});
fitCanvas();
new SpeechDisplay(pet, audio);
pet.ready();
