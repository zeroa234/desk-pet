// 计划结束时先记账、再挑下一个（WorldContext.ended，2026-10-21）：以前结束效果、接续（next）、“刚做完 R18”的时刻只在 plan-end
// （开源版省略）
import test from 'node:test';
import assert from 'node:assert/strict';

import {DEFAULT_TUNING} from '../src/behavior/index.ts';
import type {MindConfig, Tuning} from '../src/behavior/index.ts';
import {Sim} from '../src/main/sim.ts';
import {makeDisplay, mulberry32, rect} from './helpers/fake-desktop.ts';
import {DT, FLOOR_Y, SCENE_VARIANT, makePack} from './helpers/fake-scene.ts';

/** r18 的 r 权重最大（一开始一定先选它），做完扣 60 欲望、冷却很长；dress 做完 R18 20 秒内权重 0、否则很大；want 欲望 50 以上权重很大；idle 兜底 */
const MIND: MindConfig = {
  schema: 1,
  stats: {desire: {start: 90}},
  behaviors: [
    {id: 'r', r18: true, weight: 1e12, cooldown: 100_000, steps: [{do: 'idle', sec: 0.5}], effects: {end: {'stats.desire': -60}}},
    {id: 'dress', weight: {if: [{'<': [{var: 'self.afterSexSec'}, 20]}, 0, 1_000_000_000]}, steps: [{do: 'idle', sec: 0.5}]},
    {id: 'want', weight: {if: [{'>=': [{var: 'self.stats.desire'}, 50]}, 1_000_000_000, 0]}, steps: [{do: 'idle', sec: 0.5}]},
    {id: 'idle', weight: 1, steps: [{do: 'idle', sec: 0.5}]},
  ],
};

test('R18 行为做完，紧接着挑下一个时已经算“刚做完”（不穿衣）、结束效果已经生效（欲望已扣，不选 want）', () => {
  const tuning: Tuning = {...DEFAULT_TUNING, idleSec: [0, 0]};
  const sim = new Sim([makePack({id: 's', mind: MIND})], tuning, {variant: SCENE_VARIANT, heightLogical: 120, r18: true}, mulberry32(5),
    {unlocked: [], playSeconds: 0, chars: {s: {stats: {desire: 90}, relations: {}}}}, new Map());
  sim.setDesktop({displays: [makeDisplay(1, rect(0, 0, 1920, 1080))], windows: []});
  sim.spawn('s', {x: 500, y: FLOOR_Y});
  const plans: string[] = [];
  for (let i = 0; i < 30 * 10 && plans.length < 4; i++) {
    for (const {e} of sim.step(sim.now + DT, DT)) if (e.type === 'plan') plans.push(e.behavior);
  }
  const at = plans.indexOf('r');
  assert.ok(at >= 0, `没选上 r：${plans.join(' ')}`);
  assert.equal(plans[at + 1], 'idle', `r 做完紧接着选的是 ${plans[at + 1]}（以前是 dress 或 want：还没记上刚做完、欲望还没扣）`);
});
