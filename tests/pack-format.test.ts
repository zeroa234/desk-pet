// 角色包格式约定的单测（2026-10-22，docs/pack-format.md）：
//   - 生产方共用的写法（scripts/export-pack/pack-format.ts）：排版、hip、地速、动作条目 / 帧表 / pack.json 的键顺序和必填检查、JSON 写法；
//   - 检查脚本（scripts/validate-pack.ts）：在临时目录里按 pack-format.ts 写一个最小的包（PNG 只写文件头，检查只读宽高），
//     合格的过、图集尺寸不对 / 缺部位图 / 画面变体和别的包不一样 / 衣着第一个不是 clothed 的报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildAction, buildManifest, buildSheetMeta, gridFor, heightsPerSec, hipOf, manifestVariants, sheetRel, stringifyPack} from '../scripts/export-pack/pack-format.ts';
import {chunkCount, fileSize, sheetFile} from '../src/shared/sheets.ts';
import type {ManifestInput} from '../scripts/export-pack/pack-format.ts';
import {validatePack} from '../scripts/validate-pack.ts';
import {loadPack} from '../src/pack/index.ts';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VARIANTS = [{id: 'r80-full', renderHeight: 80, outline: 'full' as const}];

test('排版：一行不超过 8192 像素（不拆块时整张一个文件）', () => {
  assert.deepEqual(gridFor(100, 90, 200), {cols: 81});
  assert.deepEqual(gridFor(9000, 10, 2), {cols: 1});
});

test('画面变体：角色包和双人场景都只写运行时认的键，style 照带（回归：场景以前手写、丢了 style）', () => {
  const vs = [{id: 'r80-full', renderHeight: 80, outline: 'full' as const, ss: 4}, {id: 'hd-none', renderHeight: 720, outline: 'none' as const, style: 'smooth' as const, outlinePx: 0}];
  assert.deepEqual(manifestVariants(vs as never), [{id: 'r80-full', renderHeight: 80, outline: 'full'}, {id: 'hd-none', renderHeight: 720, outline: 'none', style: 'smooth'}]);
});

test('hip：全帧都很小不写；其余三位小数', () => {
  assert.deepEqual(hipOf({right: [0.001, -0.0015], left: [0, 0]}), {});
  assert.deepEqual(hipOf({right: [0.12345, 0], left: [-0.2, 0]}), {hip: {right: [0.123, 0], left: [-0.2, 0]}});
  assert.equal(heightsPerSec(16, 0.8192, 41.15), 0.3185);
});

test('动作条目：键顺序固定，空的不写，hip 长度要对', () => {
  const a = buildAction('walk', {clip: 'walk', frames: 2, fps: 12, loop: true, r18: false, stains: [], after: [], heightsPerSec: 0.3, hip: {right: [0.1, 0.1], left: [0, 0]}});
  assert.deepEqual(Object.keys(a), ['clip', 'frames', 'fps', 'loop', 'heightsPerSec', 'hip']);
  assert.throws(() => buildAction('x', {clip: null, frames: 3, fps: 12, loop: false, hip: {right: [0, 0]}}), /hip\.right/);
  assert.throws(() => buildAction('x', {clip: null, frames: 0, fps: 12, loop: false}), /frames/);
});

const manifest = (over: Partial<ManifestInput> = {}): ManifestInput => ({
  producer: 'test', id: 'tst', name: '测试', aliases: [], adult: true, restHeightModelPx: 25, heightRatio: 1, halfWidthRatio: 0.2,
  walkHeightsPerSec: 0.3, actions: {idle: buildAction('idle', {clip: 'idle', frames: 2, fps: 12, loop: true})},
  outfits: ['clothed'], facings: ['right', 'left'], variants: VARIANTS, defaultVariant: 'r80-full', ...over,
});

test('pack.json：必填检查', () => {
  const m = buildManifest(manifest());
  assert.deepEqual(Object.keys(m), ['schema', 'producer', 'id', 'name', 'aliases', 'adult', 'restHeightModelPx', 'heightRatio', 'halfWidthRatio',
    'walkHeightsPerSec', 'actions', 'outfits', 'facings', 'variants', 'defaultVariant', 'sprites']);
  assert.throws(() => buildManifest(manifest({outfits: ['nude', 'clothed']})), /clothed/);
  assert.throws(() => buildManifest(manifest({adult: false as unknown as true})), /adult/);
  assert.throws(() => buildManifest(manifest({actions: {}})), /idle/);
  assert.throws(() => buildManifest(manifest({walkHeightsPerSec: 0})), /walkHeightsPerSec/);
  assert.throws(() => buildManifest(manifest({facings: ['right']})), /facings/);
  assert.throws(() => buildManifest(manifest({id: 'Bad_ID'})), /id/);
  assert.throws(() => buildManifest(manifest({transitions: [{from: 'idle', to: 'idle', action: 'nope', entries: {}}]})), /过渡/);
});

test('帧表：逐帧数据长度、原点投影在格子里；foot[1] 可以在格子外', () => {
  const base = {action: 'idle', facing: 'right' as const, outfit: 'clothed', variant: 'r80-full', frames: 2, fps: 12, loop: true, cell: [10, 20] as [number, number], cols: 819};
  assert.deepEqual(Object.keys(buildSheetMeta({...base, foot: [5, 25], footY: [19, 20]}, {springs: 1})),
    ['action', 'facing', 'outfit', 'variant', 'frames', 'fps', 'loop', 'cell', 'cols', 'foot', 'footY', 'springs']);
  assert.throws(() => buildSheetMeta({...base, foot: [11, 10]}), /foot\[0\]/);
  assert.throws(() => buildSheetMeta({...base, foot: [5, 10], footY: [3]}), /footY/);
  assert.throws(() => buildSheetMeta({...base, cols: 3, foot: [5, 10]}), /cols/);
});

test('JSON 写法：全是数的数组一行', () => {
  assert.equal(stringifyPack({a: [1, 2.5], b: {c: 'x'}}), '{\n "a": [1,2.5],\n "b": {\n  "c": "x"\n }\n}\n');
});

/** 只有文件头的 PNG（检查只读 IHDR 的宽高） */
function fakePng(file: string, w: number, h: number): void {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, b);
}

type SheetOpt = {sizeFix?: number; dropParts?: boolean; cell?: [number, number]; frames?: number};
/** 在项目 temp/ 下按 pack-format.ts 写一个最小的包；mutate 改坏它（sheets：图集尺寸改坏、不写部位图、格子和帧数——大了会拆块） */
function writePack(name: string, mutate: (m: ManifestInput, sheets: SheetOpt) => void = () => {}): string {
  const rel = path.join('temp', 'test-pack-format', name), dir = path.join(PROJECT, rel);
  fs.rmSync(dir, {recursive: true, force: true});
  const m = manifest({id: name, parts: ['head']}), opt: SheetOpt = {};
  mutate(m, opt);
  const cell = opt.cell ?? [10, 20], frames = opt.frames ?? 2, g = {frames, cell, ...gridFor(cell[0], cell[1], frames)};
  m.actions = {...m.actions, idle: buildAction('idle', {clip: 'idle', frames, fps: 12, loop: true})};
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'pack.json'), stringifyPack({...m, schema: 1}));
  for (const v of m.variants) for (const f of ['right', 'left'] as const) for (const o of m.outfits) {
    const base = path.join(dir, sheetRel(v.id, o, 'idle', f));
    for (let i = 0; i < chunkCount(g); i++) {
      const {width, height} = fileSize(g, i), c = g.chunk ? i : null;
      fakePng(sheetFile(base, c), width + (opt.sizeFix ?? 0), height);
      if (!opt.dropParts) fakePng(sheetFile(base, c, 'parts'), width, height);
    }
    fs.writeFileSync(base + '.json', JSON.stringify(buildSheetMeta({action: 'idle', facing: f, outfit: o, variant: v.id, frames, fps: 12, loop: true,
      cell, cols: g.cols, chunk: g.chunk, foot: [5, 18], parts: true})));
  }
  return rel;
}

test('检查脚本：合格的包过', () => {
  const r = validatePack(PROJECT, writePack('ok'));
  assert.deepEqual(r.errors, []);
  assert.equal(r.sheets, 2);
  assert.equal(r.producer, 'test');
});

test('检查脚本：图集尺寸不对、缺部位图、衣着第一个不是 clothed、画面变体和别的包不一样都报错', () => {
  assert.match(validatePack(PROJECT, writePack('size', (_, o) => { o.sizeFix = 1; })).errors.join(), /按排版应该是/);
  assert.match(validatePack(PROJECT, writePack('parts', (_, o) => { o.dropParts = true; })).errors.join(), /缺 .*\.parts\.png/);
  assert.match(validatePack(PROJECT, writePack('nude', m => { m.outfits = ['nude']; })).errors.join(), /clothed/);
  const other = loadPack(PROJECT, writePack('other', m => { m.variants = [{id: 'r80-full', renderHeight: 120, outline: 'full'}]; }));
  assert.match(validatePack(PROJECT, writePack('ok2'), [other]).errors.join(), /画面变体和 other 不一样/);
});

test('检查脚本：拆块的图集（2026-10-22 高清）每块都在、尺寸对就过；少一块报错', () => {
  const rel = writePack('chunked', (_, o) => { o.cell = [342, 804]; o.frames = 40; });
  const r = validatePack(PROJECT, rel);
  assert.deepEqual(r.errors, []);
  const meta = JSON.parse(fs.readFileSync(path.join(PROJECT, rel, sheetRel('r80-full', 'clothed', 'idle', 'right') + '.json'), 'utf8'));
  assert.ok(meta.chunk > 0 && meta.chunk < 40, `chunk ${meta.chunk}`);
  fs.rmSync(sheetFile(path.join(PROJECT, rel, sheetRel('r80-full', 'clothed', 'idle', 'right')), 1));
  assert.throws(() => loadPack(PROJECT, rel), /缺图集/);
});

test('检查脚本：高清这类 style 的变体可以只有部分包有；同名的要一样', () => {
  const hd = {id: 'hd', renderHeight: 720, outline: 'none' as const, style: 'smooth' as const};
  const plain = loadPack(PROJECT, writePack('plain'));
  const withHd = writePack('with-hd', m => { m.variants = [...VARIANTS, hd]; });
  assert.deepEqual(validatePack(PROJECT, withHd, [plain]).errors, []);
  const otherHd = loadPack(PROJECT, writePack('other-hd', m => { m.variants = [...VARIANTS, {...hd, outline: 'full'}]; }));
  assert.match(validatePack(PROJECT, withHd, [otherHd]).errors.join(), /画面变体 hd 和 other-hd 的同名变体不一样/);
  assert.equal(loadPack(PROJECT, withHd).manifest.variants[1].style, 'smooth');
});

test('检查脚本：packs/ 里现有的包都合格', t => {
  // packs/ 下所有的包（2026-10-22 加了 MMD 的 witch-hd 以后不再写死）。
  // 没导出过图集（sprites/ 不在）的包跳过：图集是导出生成物、不入库，新机器上可能一个都没有。
  // 审查 E2：跳过多少要记下来，一个都没查的时候用 t.skip 明说，不能静默通过。
  let checked = 0;
  for (const d of fs.readdirSync(path.join(PROJECT, 'packs')).filter(x => !x.startsWith('_')).map(x => `packs/${x}`)) {
    if (!fs.existsSync(path.join(PROJECT, d, 'sprites'))) continue;   // 换了机器还没导出（图集不入库）
    assert.deepEqual(validatePack(PROJECT, d).errors, [], d);
    checked++;
  }
  t.diagnostic(`检查了 ${checked} 个包`);
  if (checked === 0) t.skip('packs/ 下没有导出过图集的包（都不带 sprites/），什么都没查');
});

test.after(() => fs.rmSync(path.join(PROJECT, 'temp', 'test-pack-format'), {recursive: true, force: true}));

