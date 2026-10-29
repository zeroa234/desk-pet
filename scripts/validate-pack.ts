// 检查一个角色包合不合约定（docs/pack-format.md §8.3）：导出器写完包跑一遍，过了才算导出完成。
//   node scripts/validate-pack.ts <包目录，相对项目根> [<包目录> …]     不给就查 packs/ 下所有的
// 先跑运行时的加载校验（src/pack/index.ts loadPack：adult、idle、衣着、帧数帧率、hip、过渡、行为和音效引用……），再查运行时不查的：
// 图集 PNG 的宽高和排版（src/shared/sheets.ts gridFor / fileSize，拆块的每个文件）、部位图 / 编号图标了就在且一样大、原点投影和脚底线在格子里、
// 尺寸字段的范围、画面变体和别的包一样（托盘统一切换；像素风那几套每个包都要有、要一样，高清这类 style 的变体可以只有部分包有，
// 有的话同名的要一样，没有的包运行时用默认变体，docs/pack-format.md §6）、拆块（src/shared/sheets.ts）的每个文件都在、尺寸对。有错退出码 1，只有警告退出码 0。自写。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadPack, loadPacks, loadScene} from '../src/pack/index.ts';
import type {Facing, Pack, SheetMeta} from '../src/pack/index.ts';
import {OUTFITS, gridFor} from './export-pack/pack-format.ts';
import {chunkCount, colsFor, fileSize, sheetFile} from '../src/shared/sheets.ts';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** PNG 的宽高（IHDR，签名 8 字节 + 长度 4 + 'IHDR' 4 之后两个大端 32 位数）；不是 PNG 返回 null */
function pngSize(file: string): [number, number] | null {
  const fd = fs.openSync(file, 'r'), b = Buffer.alloc(24);
  try { fs.readSync(fd, b, 0, 24, 0); } finally { fs.closeSync(fd); }
  if (b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

export interface Report {
  dir: string;
  id?: string;
  producer?: string;
  sheets: number;
  bytes: number;
  errors: string[];
  warnings: string[];
}

/**
 * 一张图集的文件（角色包、双人场景共用）：排版和拆块照 src/shared/sheets.ts gridFor（没拆却超过上限的是 2026-10-22 以前导的，运行时照样认，
 * 只是解码后占得多，重导会拆）；每个文件（没拆的 <图集>.png，拆块的 <图集>.c<i>.png）按排版的尺寸；部位图 / 编号图标了就每块都在、一样大
 */
function checkSheetFiles(r: Report, key: string, s: SheetMeta, base: string): void {
  const err = (x: string) => r.errors.push(x), [cw, ch] = s.cell, g = gridFor(cw, ch, s.frames);
  r.sheets++;
  if (s.chunk === undefined && g.chunk !== undefined) {
    if (s.cols !== colsFor(cw)) err(`${key}：cols ${s.cols} 不对`);
    r.warnings.push(`${key}：整张超过拆块上限（src/shared/sheets.ts），没拆（以前导的；重导会拆成每块 ${g.chunk} 帧）`);
  } else if (s.cols !== g.cols || s.chunk !== g.chunk) err(`${key}：cols ${s.cols} / chunk ${s.chunk}，按排版应该是 ${g.cols} / ${g.chunk}`);
  for (let i = 0; i < chunkCount(s); i++) {
    const c = s.chunk ? i : null, file = sheetFile(base, c), name = path.basename(file), want = fileSize(s, i);
    if (!fs.existsSync(file)) { err(`${key}：缺 ${name}`); continue; }
    const size = pngSize(file);
    r.bytes += fs.statSync(file).size;
    if (!size) { err(`${key}：${name} 不是 PNG`); continue; }
    if (size[0] !== want.width || size[1] !== want.height) err(`${key}：${name} 是 ${size[0]}×${size[1]}，按排版应该是 ${want.width}×${want.height}`);
    for (const kind of ['parts', 'ids'] as const) {
      if (!s[kind]) continue;
      const f2 = sheetFile(base, c, kind), other = fs.existsSync(f2) ? pngSize(f2) : null;
      if (!other) err(`${key}：帧表标了 ${kind}，缺 ${path.basename(f2)}`);
      else if (other[0] !== size[0] || other[1] !== size[1]) err(`${key}：${path.basename(f2)} 是 ${other[0]}×${other[1]}，和图集不一样大`);
    }
  }
  // foot[1] 是待机的脚底基准线，可以在格子外（坐在地上的动作身体比它低，靠逐帧的 footY）；原点的投影 foot[0] 在格子里
  if (!(s.foot[0] >= 0 && s.foot[0] <= cw)) err(`${key}：foot[0] ${s.foot[0]} 不在格子 0–${cw} 里`);
  if (s.footY && (s.footY.length !== s.frames || s.footY.some(y => !(y >= 0 && y <= ch)))) err(`${key}：footY 长度不对或不在格子里`);
}

/**
 * 查一个双人场景（packs/_scenes/<场景>/，2026-10-22 以前没有导出后检查）：运行时的 loadScene 校验（段连续、帧数、cast / footY 长度、
 * floor 帧号……），再查每张图集的文件（同角色包）、画面变体和角色包一样（托盘统一切换）
 */
export function validateScene(projectRoot: string, relDir: string, packs: readonly Pack[] = []): Report {
  const r: Report = {dir: relDir, sheets: 0, bytes: 0, errors: [], warnings: []};
  let sc;
  try { sc = loadScene(projectRoot, relDir); } catch (e) { r.errors.push(`加载校验：${(e as Error).message}`); return r; }
  const m = sc.manifest;
  r.id = m.id; r.producer = 'scene';
  const pixel = (vs: readonly {style?: string}[]) => JSON.stringify(vs.filter(v => !v.style));
  for (const p of packs) if (pixel(m.variants) !== pixel(p.manifest.variants)) r.errors.push(`像素风的画面变体和角色包 ${p.manifest.id} 不一样（托盘统一切换变体）`);
  for (const v of m.variants) for (const f of m.facings as Facing[]) {
    const base = path.join(projectRoot, sc.sheetPath(v.id, f));
    if (!fs.existsSync(base + '.json')) { r.errors.push(`${v.id}/${f}：缺帧表`); continue; }
    checkSheetFiles(r, `${v.id}/${f}`, sc.sheet(v.id, f), base);
  }
  return r;
}

/** 查一个包；others = 拿来比画面变体的别的包（同 id 的跳过） */
export function validatePack(projectRoot: string, relDir: string, others: readonly Pack[] = []): Report {
  const r: Report = {dir: relDir, sheets: 0, bytes: 0, errors: [], warnings: []};
  let pack: Pack;
  try { pack = loadPack(projectRoot, relDir); } catch (e) { r.errors.push(`加载校验：${(e as Error).message}`); return r; }
  const m = pack.manifest;
  r.id = m.id; r.producer = m.producer;
  const err = (s: string) => r.errors.push(s), warn = (s: string) => r.warnings.push(s);
  if (!m.producer) warn('pack.json 没有 producer（2026-10-22 以前的包；重导会补上）');
  for (const o of m.outfits) if (!(OUTFITS as readonly string[]).includes(o)) err(`不认识的衣着 ${o}`);
  if (!(m.restHeightModelPx > 0)) err(`restHeightModelPx ${m.restHeightModelPx} 要 > 0`);
  const hr = m.heightRatio ?? 1;
  if (!(hr >= 0.3 && hr <= 3)) err(`heightRatio ${hr} 不在 0.3–3 之间`);
  if (!(m.halfWidthRatio > 0 && m.halfWidthRatio < 1)) err(`halfWidthRatio ${m.halfWidthRatio} 不在 (0, 1) 里`);
  if (!(m.walkHeightsPerSec > 0)) err(`walkHeightsPerSec ${m.walkHeightsPerSec} 要 > 0（没有走路动作也要在导出配置里给）`);
  if (m.facings.length !== 2 || !m.facings.includes('right') || !m.facings.includes('left')) err('facings 要是 right、left 两个');
  for (const o of others) {
    if (o.manifest.id === m.id) continue;
    const base = (vs: typeof m.variants) => JSON.stringify(vs.filter(v => !v.style)), a = base(m.variants), b = base(o.manifest.variants);
    if (a !== b) err(`像素风的画面变体和 ${o.manifest.id} 不一样（托盘统一切换变体）：${a} / ${b}`);
    for (const v of m.variants) {
      const w = o.manifest.variants.find(x => x.id === v.id);
      if (w && JSON.stringify(w) !== JSON.stringify(v)) err(`画面变体 ${v.id} 和 ${o.manifest.id} 的同名变体不一样`);
    }
    if (m.defaultVariant !== o.manifest.defaultVariant) warn(`默认变体和 ${o.manifest.id} 不一样`);
  }
  for (const v of m.variants) for (const a of Object.keys(m.actions)) for (const o of m.outfits) {
    if (!pack.has(a, o)) continue;
    for (const f of m.facings as Facing[]) {
      const s = pack.sheet(v.id, o, a, f), key = `${v.id}/${o}/${a}-${f}`;
      checkSheetFiles(r, key, s, path.join(projectRoot, pack.sheetPath(v.id, o, a, f)));
      if (s.ids && !m.surface) err(`${key}：有编号图，pack.json 没有 surface`);
      if (s.parts && !m.parts?.length) err(`${key}：有部位图，pack.json 没有 parts`);
    }
  }
  return r;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2);
  const installed = loadPacks(PROJECT), scenesRoot = path.join(PROJECT, 'packs', '_scenes');
  // 不给参数：packs/ 下所有的角色包，加上 packs/_scenes/ 下导出过图集的场景（场景的 sprites/ 不入库，没导出过的跳过）
  const scenes = dirs.length || !fs.existsSync(scenesRoot) ? [] : fs.readdirSync(scenesRoot).map(d => `packs/_scenes/${d}`)
    .filter(d => fs.existsSync(path.join(PROJECT, d, 'scene.json')) && fs.existsSync(path.join(PROJECT, d, 'sprites')));
  const list = dirs.length ? dirs : [...installed.map(p => p.relDir), ...scenes];
  let bad = 0;
  for (const d of list) {
    const r = fs.existsSync(path.join(PROJECT, d, 'scene.json')) ? validateScene(PROJECT, d, installed) : validatePack(PROJECT, d, installed);
    console.log(`${r.errors.length ? '✗' : '✓'} ${r.dir}（${r.id ?? '?'}，生产方 ${r.producer ?? '没写'}）：${r.sheets} 张图集，${(r.bytes / 1048576).toFixed(1)} MB`);
    for (const e of r.errors) console.log('  错误：' + e);
    for (const w of r.warnings) console.log('  警告：' + w);
    if (r.errors.length) bad++;
  }
  process.exit(bad ? 1 : 0);
}
