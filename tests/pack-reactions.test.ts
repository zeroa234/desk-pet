// 角色包加载时对 behaviors.json 里 reactions 的校验（src/pack/index.ts loadPack，R3.6，2026-10-21 主代理写）：
// （开源版省略）
// _ 开头的键（_comment）跳过。夹具在 tests/helpers/temp-pack.ts：temp 下临时造一个最小的角色包目录（图集只要文件在，loadPack 只查存在）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {loadPack} from '../src/pack/index.ts';
import {PROJECT, tempPack, type TempPackAction} from './helpers/temp-pack.ts';

/**
 * temp/test-packs/<名字>/：idle 一个动作、clothed 一种衣着、一个变体两个朝向；reactions 写进 behaviors.json。
 * extraActions 加别的动作（如带 switchSec 的 strip），图集也跟着写（loadPack 只查文件在、帧数 / 帧率对得上）。
 */
const makePackDir = (name: string, reactions: unknown, extraActions: Record<string, TempPackAction> = {}): string =>
  tempPack('temp/test-packs', name, {reactions, actions: {idle: {clip: 'idle', frames: 2, fps: 12, loop: true}, ...extraActions}});

const react = {steps: [{do: 'play', action: 'idle', sec: 1, state: 'react'}]};

test('loadPack：合法的 reactions（部位键、通用键、discovered、一串、_comment）能加载', () => {
  const p = loadPack(PROJECT, makePackDir('ok', {_commentPoke: '说明', discovered: react, click: [react, {fx: 'alert'}], 'click:head': react, 'stroke:chest': {fx: 'heart'},
    'sex:click': {fx: 'heart'}, 'sex:stroke:chest': {fx: 'heart'}}));
  assert.deepEqual(p.manifest.parts, ['head', 'chest']);
});

test('loadPack：部位不在 parts 里、键的种类不认识、discovered 带部位都拒绝', () => {
  assert.throws(() => loadPack(PROJECT, makePackDir('bad-part', {'click:butt': react})), /click:butt/);
  assert.throws(() => loadPack(PROJECT, makePackDir('bad-kind', {tap: react})), /tap/);
  assert.throws(() => loadPack(PROJECT, makePackDir('bad-discovered', {'discovered:head': react})), /discovered:head/);
  // （开源版省略）
  assert.throws(() => loadPack(PROJECT, makePackDir('bad-sex-discovered', {'sex:discovered': react})), /sex:discovered/);
  assert.throws(() => loadPack(PROJECT, makePackDir('bad-sex-part', {'sex:click:butt': react})), /sex:click:butt/);
  assert.throws(() => loadPack(PROJECT, makePackDir('bad-sex-extra', {'sex:click:head:x': react})), /sex:click:head:x/);
});

test('loadPack：反应步骤用了没有的动作、或者有 gotoHide / hide 都拒绝', () => {
  assert.throws(() => loadPack(PROJECT, makePackDir('bad-action', {click: {steps: [{do: 'play', action: 'wave'}]}})), /wave/);
  assert.throws(() => loadPack(PROJECT, makePackDir('bad-hide', {click: [{fx: 'alert'}, {steps: [{do: 'gotoHide'}]}]})), /gotoHide/);
});

// （开源版省略）

test('loadPack：动作的 switchSec 要在片段里（超出 / 负数拒绝，片段里、循环动作能加载）', () => {
  // 2 帧 @ 12 fps：片段 1/6 秒，能换衣着的上限是 (frames - 1) / fps ≈ 0.083 秒
  const strip = {clip: 'strip', frames: 2, fps: 12, loop: false};
  // 超出片段：步骤会在换装前就播完，衣着一直不换（报告里的静默失败）
  assert.throws(() => loadPack(PROJECT, makePackDir('bad-switch', {}, {strip: {...strip, switchSec: 3}})), /switchSec/);
  assert.throws(() => loadPack(PROJECT, makePackDir('neg-switch', {}, {strip: {...strip, switchSec: -1}})), /switchSec/);
  // 在片段里：能加载，switchSec 原样读进来
  const ok = loadPack(PROJECT, makePackDir('ok-switch', {}, {strip: {...strip, switchSec: 0.05}}));
  assert.equal(ok.manifest.actions.strip.switchSec, 0.05);
  // 循环动作会一直播，没有上限
  const loop = loadPack(PROJECT, makePackDir('loop-switch', {}, {strip: {...strip, loop: true, switchSec: 3}}));
  assert.equal(loop.manifest.actions.strip.switchSec, 3);
});

test.after(() => fs.rmSync(path.join(PROJECT, 'temp', 'test-packs'), {recursive: true, force: true}));
