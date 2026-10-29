// 图集的排版和拆块（导出 scripts/export-pack/ 和运行时 src/pack、src/stage 共用一份；docs/pack-format.md §3.1）。纯函数，不 import Node 的东西
// （导出页面经 bench:// 协议直接加载这个文件）。
//   - 排版：一行 cols 格（不超过 ATLAS_MAX_WIDTH 像素宽），帧号从左到右、从上到下。
//   - 拆块（2026-10-22，高清变体）：整张图集超过 CHUNK_MAX_PIXELS 像素时按帧拆成几个文件，帧表写 chunk = 每个文件几帧（gridFor），
//     文件叫 <图集>.c<i>.png（编号图 .c<i>.ids.png、部位图 .c<i>.parts.png），每个文件里照帧表的 cols 排；没拆的照旧 <图集>.png。
//     为什么：720 高的一帧约 1 MB，一张待机图集不拆就两百多 MB（舞台解码后的内存上限默认 150 MB，按文件记账、用到才读），画布也放不下。
// 写法限制同 types.ts（只用 Node 类型擦除支持的语法）。

export const ATLAS_MAX_WIDTH = 8192;
/** 一个图集文件最多多少像素（解码后 × 4 字节 = 16 MB） */
export const CHUNK_MAX_PIXELS = 4 * 2 ** 20;

export interface SheetGrid {
  frames: number;
  cell: readonly [number, number];
  cols: number;
  /** 拆块时每个文件几帧；没有 = 不拆 */
  chunk?: number;
}

/** 一行最多几格（不超过 ATLAS_MAX_WIDTH） */
export function colsFor(cw: number): number {
  return Math.max(1, Math.floor(ATLAS_MAX_WIDTH / cw));
}

/**
 * 排版：一行几格、拆不拆（每块几帧）。整张不超过 CHUNK_MAX_PIXELS 不拆（一行排满 colsFor 格）；拆的话每块放得下多少帧放多少：
 * 够一行的取整行的倍数，不够一行的一行就排这么多格（不留空格子，每个文件都不超过上限）
 */
export function gridFor(cw: number, ch: number, frames: number): {cols: number; chunk?: number} {
  const full = colsFor(cw);
  if (Math.ceil(frames / full) * full * cw * ch <= CHUNK_MAX_PIXELS) return {cols: full};
  const per = Math.max(1, Math.floor(CHUNK_MAX_PIXELS / (cw * ch)));
  return per >= full ? {cols: full, chunk: Math.floor(per / full) * full} : {cols: per, chunk: per};
}

/** 第 i 个文件的宽高（像素） */
export function fileSize(g: SheetGrid, i: number): {width: number; height: number} {
  return {width: g.cols * g.cell[0], height: Math.ceil(framesInChunk(g, i) / g.cols) * g.cell[1]};
}

/** 几个文件 */
export function chunkCount(g: SheetGrid): number {
  return g.chunk ? Math.ceil(g.frames / g.chunk) : 1;
}

/** 第 i 个文件里有几帧 */
export function framesInChunk(g: SheetGrid, i: number): number {
  return g.chunk ? Math.min(g.chunk, g.frames - i * g.chunk) : g.frames;
}

/** 文件名（带 .png）：base 是图集的路径（不带扩展名），chunk 是第几个文件（没拆时传 null），kind 是编号图 / 部位图 */
export function sheetFile(base: string, chunk: number | null, kind?: 'ids' | 'parts'): string {
  return `${base}${chunk === null ? '' : `.c${chunk}`}${kind ? `.${kind}` : ''}.png`;
}

/**
 * 画在屏幕上时第 frame 帧的格子左上角（物理像素）：脚底点 (x, y)，每个渲染像素 k 个物理像素，脚底线按这一帧的 footY（没有用 foot[1]）。
 * 主进程（水珠挂在哪、液体落在哪、画在哪）和舞台页面（画、判点）都用它，两边逐像素一致
 */
export function cellOrigin(meta: {foot: readonly [number, number]; footY?: readonly number[]}, frame: number, x: number, y: number, k: number): {left: number; top: number} {
  return {left: x - meta.foot[0] * k, top: y - (meta.footY?.[frame] ?? meta.foot[1]) * k};
}

/** 第 frame 帧在哪个文件（没拆时 null）、文件里的左上角（像素） */
export function frameAt(g: SheetGrid, frame: number): {chunk: number | null; sx: number; sy: number} {
  const chunk = g.chunk ? Math.floor(frame / g.chunk) : null, j = g.chunk ? frame % g.chunk : frame;
  return {chunk, sx: (j % g.cols) * g.cell[0], sy: Math.floor(j / g.cols) * g.cell[1]};
}
