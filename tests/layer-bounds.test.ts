// 躲藏层 / 窗口里面那一层的小窗口重排策略（src/main/layer-bounds.ts，2026-10-29 用户：桌宠在窗口里行走时轻微抽动）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {layerBounds, layerPad} from '../src/main/layer-bounds.ts';
import type {Rect} from '../src/shared/types.ts';
import {eq} from './helpers/assert.ts';

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({left, top, right, bottom});
const DISPLAY = rect(0, 0, 2560, 1600);
/** 200% 缩放下的边距：8 逻辑像素 */
const MARGIN = 16;
const contains = (outer: Rect, inner: Rect) => inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;

test('现在的范围盖得住要画的东西就不动', () => {
  const need = rect(500, 400, 900, 800);
  eq(layerBounds(rect(480, 380, 920, 820), need, {margin: MARGIN, pad: 600, limit: DISPLAY}), null);
  eq(layerBounds(need, need, {margin: MARGIN, pad: 600, limit: DISPLAY}), null);   // 刚好贴边也算盖得住
});

test('刚用上（没有现成范围）：need 四周留边距，横向多留到 pad', () => {
  const need = rect(1000, 600, 1400, 1000);
  const b = layerBounds(null, need, {margin: MARGIN, pad: 300, limit: DISPLAY})!;
  assert.deepEqual(b, rect(700, 584, 1700, 1016));
  assert.ok(contains(b, need));
});

test('pad 比边距小也至少留边距', () => {
  const need = rect(1000, 600, 1400, 1000);
  assert.deepEqual(layerBounds(null, need, {margin: MARGIN, pad: 0, limit: DISPLAY}), rect(984, 584, 1416, 1016));
});

test('不超出所在显示器；要画的东西贴着显示器边或超出去时仍然盖得住（含边距）', () => {
  const opt = {margin: MARGIN, pad: 600, limit: DISPLAY};
  const atLeft = rect(10, 600, 410, 1000), b1 = layerBounds(null, atLeft, opt)!;
  eq(b1.left, 10 - MARGIN);   // 以 need 为准：显示器左边是 0，但 need 加边距在它外面
  assert.ok(contains(b1, atLeft));
  const outside = rect(-100, 600, 300, 1000), b2 = layerBounds(null, outside, opt)!;
  assert.ok(contains(b2, rect(outside.left - MARGIN, outside.top - MARGIN, outside.right + MARGIN, outside.bottom + MARGIN)));
  const nearRight = rect(2100, 600, 2500, 1000), b3 = layerBounds(null, nearRight, opt)!;
  eq(b3.right, 2560);          // 多留的部分被显示器右边截住
  assert.ok(contains(b3, nearRight));
});

test('需要重排时新范围一定盖得住 need（含边距），不管 need 在哪', () => {
  for (const need of [rect(0, 0, 400, 400), rect(2160, 1200, 2560, 1600), rect(1000.4, 600.6, 1399.2, 999.9), rect(-50, -50, 350, 350)]) {
    for (const pad of [0, MARGIN, 200, 5000]) {
      const b = layerBounds(rect(5000, 5000, 5001, 5001), need, {margin: MARGIN, pad, limit: DISPLAY})!;
      assert.ok(contains(b, rect(Math.floor(need.left) - MARGIN, Math.floor(need.top) - MARGIN, Math.ceil(need.right) + MARGIN, Math.ceil(need.bottom) + MARGIN)),
        `need ${JSON.stringify(need)} pad ${pad} → ${JSON.stringify(b)}`);
    }
  }
});

test('layerPad：要画的东西宽度的一倍半，至少边距', () => {
  eq(layerPad(rect(0, 0, 400, 400), MARGIN), 600);
  eq(layerPad(rect(0, 0, 4, 4), MARGIN), MARGIN);
});

// 实测的场景：真的角色包（silent）在窗口里面走，要画的东西约 400 × 480 物理像素、每秒约 100 物理像素（模拟里一秒重排 5.4 次，间隔中位 0.17 秒）
function relayouts(pad: (need: Rect) => number, seconds: number): number {
  const w = 400, h = 480, speed = 100, hz = 60;
  let current: Rect | null = null, n = 0;
  for (let i = 0; i < seconds * hz; i++) {
    const left = 200 + speed * i / hz, need = rect(left, 600, left + w, 600 + h);
    const next = layerBounds(current, need, {margin: MARGIN, pad: pad(need), limit: DISPLAY});
    if (next) { current = next; n++; assert.ok(contains(current, need)); }
  }
  return n;
}

test('一直往一个方向走：只留边距时每走十几个像素重排一次；按身位多留以后一路只排几次', () => {
  // 100 px/s × 18 s = 1800 px：要画的东西从 x = 200 走到右边缘在 2400，还在 2560 宽的显示器里面
  // （压到显示器边上以后回到只留边距，不让小窗口跨到别的显示器去，那一小段不在这里量）
  const seconds = 18;
  const old = relayouts(() => MARGIN, seconds), now = relayouts(need => layerPad(need, MARGIN), seconds);
  assert.ok(old >= 100, `只留边距的重排次数 ${old}`);
  assert.ok(now <= 4, `按身位多留的重排次数 ${now}`);
});
