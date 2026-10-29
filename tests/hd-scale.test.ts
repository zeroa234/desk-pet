// 高清变体（PackVariant.style smooth，2026-10-22）的放大倍数：每个角色按自己那套算；高清和同屏的像素风角色一样高、倍数可以是小数；
// 特效、液体的一格按同样高的 r120 的一个渲染像素（src/main/sim.ts spritePx / artPx）；没有高清变体的包用自己的默认变体
import test from 'node:test';
import assert from 'node:assert/strict';
import type {MindConfig} from '../src/behavior/index.ts';
import {DEFAULT_TUNING, setPlan} from '../src/behavior/index.ts';
import type {PackVariant} from '../src/pack/index.ts';
import {Sim} from '../src/main/sim.ts';
import {makeDisplay, mulberry32, rect} from './helpers/fake-desktop.ts';
import {FLOOR_Y, SCENE_VARIANT, makePack} from './helpers/fake-scene.ts';

const idleMind = (): MindConfig => ({schema: 1, stats: {}, behaviors: [{id: 'idle', weight: 1, steps: [{do: 'idle', sec: [10_000, 10_000]}]}]});
const HD: PackVariant = {id: 'hd', renderHeight: 720, outline: 'none', style: 'smooth'};

/** a 只有像素风的 v（renderHeight 40）；b 多一套高清 hd。托盘选了 variant */
function setup(variant: string, scale: number, heightLogical = 120, nude = false) {
  // （开源版省略）
  const drip = nude ? {drip: {nude: [12, 20, 1] as [number, number, 1]}} : {};
  const a = makePack({id: 'a', mind: idleMind(), ...drip}), b = makePack({id: 'b', mind: idleMind(), ...drip});
  const base = b.variant(SCENE_VARIANT);
  b.manifest.variants = [base, HD];
  b.variant = id => [base, HD].find(v => v.id === id) ?? (() => { throw new Error(id); })();
  const sim = new Sim([a, b], {...DEFAULT_TUNING, idleSec: [0, 0]}, {variant, heightLogical, r18: true}, mulberry32(3),
    {unlocked: ['b'], playSeconds: 0, chars: Object.fromEntries(['a', 'b'].map(id => [id, {stats: {desire: 90}, relations: {}}]))}, new Map());
  sim.setDesktop({displays: [makeDisplay(1, rect(0, 0, 1920 * scale, 1080 * scale), scale)], windows: []});
  sim.spawn('a', {x: 400, y: FLOOR_Y * scale}); sim.spawn('b', {x: 900, y: FLOOR_Y * scale});
  let t = 0;
  for (let i = 0; i < 60; i++) { t += 1 / 30; sim.step(t, 1 / 30); }   // 先落地
  if (nude) for (const [id, pack] of [['a', a], ['b', b]] as const) setPlan(sim.charOf(id)!.actor!, pack.actorSpec(sim.tuning), {behavior: 'nude', steps: [{state: 'idle', action: 'idle', outfit: 'nude', sec: 1000}]}, sim.ctx(), 'test');
  for (let i = 0; i < 120; i++) { t += 1 / 30; sim.step(t, 1 / 30); }
  if (nude) for (let i = 0; i < 600; i++) { t += 1 / 30; sim.step(t, 1 / 30); }   // （开源版省略）
  const d = sim.draws(new Set()), items = d.front.get(1)!;
  return {a: items.find(x => x.id === 'a')!, b: items.find(x => x.id === 'b')!, ground: d.ground.get(1) ?? []};
}

test('高清：选了高清的角色倍数是小数、和像素风的基准角色一样高，平滑缩放；没有高清的包照旧像素风', () => {
  // 200% 屏、120 逻辑像素：基准角色（像素风 40 高）放大 round(240 / 40) = 6 倍 = 240 物理像素；高清 720 高 → 240 / 720
  const {a, b} = setup('hd', 2);
  assert.equal(a.k, 6); assert.equal(a.smooth, undefined); assert.equal(a.u, undefined);
  assert.ok(Math.abs(b.k - 240 / 720) < 1e-9, `k ${b.k}`);
  assert.equal(b.smooth, true);
  assert.ok(Math.abs(b.u! - 2) < 1e-9, `u ${b.u}`);   // 一格 = 同样高的 r120 的一个渲染像素：240 / 120
  assert.ok(b.sheet.includes('/hd/') && a.sheet.includes(`/${SCENE_VARIANT}/`));
});

test('高清：基准角色是像素风、取整以后多高，高清角色就多高（144 逻辑像素 → 40 × 7 = 280）', () => {
  const {a, b} = setup('hd', 2, 144);
  assert.equal(a.k, 7);
  assert.ok(Math.abs(b.k * 720 - 280) < 1e-9);
});

test('高清：没选高清时两个人都是像素风', () => {
  const {a, b} = setup(SCENE_VARIANT, 1);
  assert.equal(a.k, 3); assert.equal(b.k, 3);
  assert.equal(b.smooth, undefined);
});
