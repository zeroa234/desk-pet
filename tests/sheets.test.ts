// 图集排版和拆块（src/shared/sheets.ts），2026-10-22 高清变体；像素后处理的高清选项在 pixel-post.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CHUNK_MAX_PIXELS, chunkCount, colsFor, fileSize, frameAt, framesInChunk, gridFor, sheetFile} from '../src/shared/sheets.ts';

test('排版：整张不超过上限不拆，一行排满', () => {
  assert.deepEqual(gridFor(40, 91, 196), {cols: colsFor(40)});
  assert.equal(colsFor(40), 204);
  assert.equal(frameAt({frames: 196, cell: [40, 91], cols: 204}, 205).sx, 40);
  assert.equal(sheetFile('packs/x/sprites/v/nude/idle-right', null), 'packs/x/sprites/v/nude/idle-right.png');
  assert.equal(sheetFile('a/b', null, 'ids'), 'a/b.ids.png');
});

test('拆块：够一行的取整行的倍数；每个文件都不超过上限', () => {
  const [cw, ch, frames] = [60, 150, 612], g = {frames, cell: [cw, ch] as [number, number], ...gridFor(cw, ch, frames)};
  assert.equal(g.cols, colsFor(cw));
  assert.ok(g.chunk! % g.cols === 0 && g.chunk! > 0);
  for (let i = 0; i < chunkCount(g); i++) { const s = fileSize(g, i); assert.ok(s.width * s.height <= CHUNK_MAX_PIXELS, `第 ${i} 块 ${s.width}×${s.height}`); }
  assert.equal(Array.from({length: chunkCount(g)}, (_, i) => framesInChunk(g, i)).reduce((a, b) => a + b), frames);
  const p = frameAt(g, g.chunk! + 1);
  assert.deepEqual(p, {chunk: 1, sx: cw, sy: 0});
  assert.equal(sheetFile('s', p.chunk, 'parts'), 's.c1.parts.png');
});

test('拆块：一块不够一行时一行只排这么多格（高清 720 高的格子，不留空格子）', () => {
  const [cw, ch, frames] = [342, 804, 196], gg = gridFor(cw, ch, frames), g = {frames, cell: [cw, ch] as [number, number], ...gg};
  assert.ok(gg.chunk! < colsFor(cw));
  assert.equal(gg.cols, gg.chunk);
  for (let i = 0; i < chunkCount(g); i++) { const s = fileSize(g, i); assert.ok(s.width * s.height <= CHUNK_MAX_PIXELS); }
  assert.deepEqual(frameAt(g, gg.chunk! + 2), {chunk: 1, sx: 2 * cw, sy: 0});
});
