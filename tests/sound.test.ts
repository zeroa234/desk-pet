// 原版 mod 音效的单测：
//   1. src/sound/index.ts 的 Voice（规则引擎，blocky-scene-sfx.py 里 Voice 的移植，规则含义见文件头注释）；
//   2. src/main/sim.ts 的音效 cue（takeCues / actorCues / duoCues，规则见 sim.ts “音效”一节的注释）。
// 不读 packs/_sfx/（导出生成物，别的机器上没有）：规则、声音文件、角色包、场景都在测试里自己造；
// rng 用固定值的队列（seq），结果只由测试自己的输入决定。
import test from 'node:test';
import assert from 'node:assert/strict';

import type {MindConfig, Tuning} from '../src/behavior/index.ts';
import {DEFAULT_TUNING, setPlan} from '../src/behavior/index.ts';
import {Sim, type SoundCue} from '../src/main/sim.ts';
import type {PackSfx, SceneSfx} from '../src/pack/index.ts';
import {Voice, type SfxFile, type SfxManifest, type VoiceRules} from '../src/sound/index.ts';
import {DT, FLOOR_Y, SCENE_VARIANT, drive, duoAnchorX, makeDuo, makePack, sceneCastX} from './helpers/fake-scene.ts';
import {makeDisplay, mulberry32, rect} from './helpers/fake-desktop.ts';
import {approx, eq} from './helpers/assert.ts';

// ---------- 小工具 ----------

/** 按顺序返回的 rng（Voice 每次放声音都要一个 pitch 随机数，所以队列要放够）；用完了报错，暴露调用次数不对。 */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error(`测试的 rng 只有 ${values.length} 个值，第 ${i + 1} 次调用没值了`);
    return values[i++];
  };
}

const file = (name: string, gainDb = 0): SfxFile => ({file: name, gainDb, sec: 1});

/** 一个声音组里两个文件，供“随机挑”的用例用 */
const TWO: SfxManifest['files'] = {g: [file('a.wav', -3), file('b.wav', -6)]};

// ---------- Voice：play ----------

test('Voice play 带 index：放那个文件，volume / pitch 没写是 1，delay 0', () => {
  const rules: VoiceRules = {events: {e: [{play: 'g', index: 1, volume: 0.5}]}};
  const v = new Voice(rules, TWO, seq(0.5));
  assert.deepEqual(v.run('e'), [{file: 'b.wav', gainDb: -6, volume: 0.5, pitch: 1, delay: 0}]);
  eq(v.knows('e'), true);
});

test("Voice play 不带 index：pick 'fresh' 连续两次不挑同一个；pick 'any' 可以重复", () => {
  const rules: VoiceRules = {events: {e: [{play: 'g'}]}};
  // 第一次 pick 0.1 → 第 0 个，pitch 0.9；第二次 pick 0.9 → 第 1 个，pitch 0.0
  const fresh = new Voice({...rules, pick: 'fresh'}, TWO, seq(0.1, 0.9, 0.9, 0.0));
  const first = fresh.run('e');
  const second = fresh.run('e');
  eq(first.length, 1);
  eq(second.length, 1);
  eq(first[0].file, 'a.wav');
  eq(second[0].file, 'b.wav');
  assert.notEqual(first[0].file, second[0].file, 'fresh 不该连着挑同一个');
  // 主代理补：第二次先抽到和上一次一样的（0.1 → 第 0 个），fresh 要重抽（0.9 → 第 1 个）；any 不重抽
  const retry = new Voice({...rules, pick: 'fresh'}, TWO, seq(0.1, 0.5, 0.1, 0.9, 0.5));
  eq(retry.run('e')[0].file, 'a.wav');
  eq(retry.run('e')[0].file, 'b.wav', 'fresh 抽到同一个要重抽');

  // pick 'any'：rng 一直是 0.49 → 每次都挑第 0 个（pick 一次、pitch 一次）
  const any = new Voice({...rules, pick: 'any'}, TWO, () => 0.49);
  eq(any.run('e')[0].file, 'a.wav');
  eq(any.run('e')[0].file, 'a.wav');
});

test('Voice repeat + gap：放 repeat 个，delay 依次 0 / gap / 2gap，pitch 落在 [lo, hi]', () => {
  const rules: VoiceRules = {events: {e: [{play: 'g', index: 0, repeat: 3, gap: 0.25, pitch: [0.8, 1.2]}]}};
  const out = new Voice(rules, TWO, seq(0, 0.5, 0.999)).run('e');
  eq(out.length, 3);
  assert.deepEqual(out.map(s => s.delay), [0, 0.25, 0.5]);
  for (const s of out) {
    eq(s.file, 'a.wav');
    eq(s.gainDb, -3);
    eq(s.volume, 1, 'volume 没写是 1');
    assert.ok(s.pitch >= 0.8 && s.pitch <= 1.2, `pitch ${s.pitch} 不在 [0.8, 1.2] 里`);
  }
  approx(out[0].pitch, 0.8, 'rng 0 → 下限');
  approx(out[1].pitch, 1, 'rng 0.5 → 中点');
  approx(out[2].pitch, 0.8 + 0.4 * 0.999, 'rng 0.999 → 接近上限');
});

// ---------- Voice：chance / oneOf / cycle ----------

test('Voice chance：rng < p 才执行 then（等于 p 不执行）', () => {
  const rules: VoiceRules = {events: {e: [{chance: 0.5, then: {play: 'g', index: 0}}]}};
  eq(new Voice(rules, TWO, seq(0.25, 0)).run('e').length, 1, 'rng 0.25 < 0.5 应该执行');
  eq(new Voice(rules, TWO, seq(0.5)).run('e').length, 0, 'rng = p 不该执行');
  eq(new Voice(rules, TWO, seq(0.75)).run('e').length, 0, 'rng 0.75 > 0.5 不该执行');
});

test('Voice oneOf：按权重选（固定 rng 值验证落在哪一项）', () => {
  // 权重 1 + 3 = 4：rng 0.1 → r = 0.4 < 1 选第一项；rng 0.3 → r = 1.2，减 1 再减 3 选第二项
  const rules: VoiceRules = {events: {e: [{oneOf: [[1, {play: 'ga', index: 0}], [3, {play: 'gb', index: 0}]]}]}};
  const files: SfxManifest['files'] = {ga: [file('a.wav')], gb: [file('b.wav')]};
  eq(new Voice(rules, files, seq(0.1, 0)).run('e')[0].file, 'a.wav');
  eq(new Voice(rules, files, seq(0.3, 0)).run('e')[0].file, 'b.wav');
});

test('Voice cycle：每次 +1，按 (计数 + start) % 长度 轮流；两个实例的计数器互不影响', () => {
  const rules: VoiceRules = {events: {e: [{cycle: 'c', start: 1, steps: [
    {play: 'g0', index: 0}, {play: 'g1', index: 0}, {play: 'g2', index: 0},
  ]}]}};
  const files: SfxManifest['files'] = {g0: [file('0.wav')], g1: [file('1.wav')], g2: [file('2.wav')]};
  const one = new Voice(rules, files, seq(0, 0, 0, 0, 0));
  const two = new Voice(rules, files, seq(0, 0));
  const pick = (v: Voice) => v.run('e')[0].file;
  // start 1：(0+1)%3=1 → 1，(1+1)%3=2 → 2，(2+1)%3=0 → 0，(3+1)%3=1 → 1
  assert.deepEqual([pick(one), pick(one), pick(one), pick(one)], ['1.wav', '2.wav', '0.wav', '1.wav']);
  eq(pick(two), '1.wav', '另一个 Voice 的计数器从 0 开始');
  eq(pick(one), '2.wav', '第一个 Voice 的计数器没有被第二个影响');
});

// ---------- Voice：认不出的 effect / 没文件 ----------

test('Voice 不认识的 effect 返回空、knows 为 false；组里没有文件也返回空', () => {
  // 主代理补（子代理找到的）：原型链上的名字不算认识
  const proto = new Voice({events: {e: [{play: 'g', index: 0}]}}, TWO, () => 0);
  eq(proto.knows('toString'), false);
  assert.deepEqual(proto.run('toString'), []);
  assert.deepEqual(proto.run('constructor'), []);
  const v = new Voice({events: {e: [{play: 'empty'}]}}, {empty: []}, seq());
  assert.deepEqual(v.run('nope'), []);
  eq(v.knows('nope'), false);
  eq(v.knows('e'), true);
  assert.deepEqual(v.run('e'), []);
  // 组在 files 里根本没写
  const missing = new Voice({events: {e: [{play: 'missing'}]}}, {}, seq());
  assert.deepEqual(missing.run('e'), []);
});

// ---------- Sim：单人动作的音效 cue ----------

/** 只站着不动的脑子：一条 10000 秒的 idle 计划（测试里当固定靶子） */
function idleMind(): MindConfig {
  return {schema: 1, stats: {}, behaviors: [{id: 'idle', weight: 1, steps: [{do: 'idle', sec: [10_000, 10_000]}]}]};
}

/** 一个角色（id = s）、1920×1080 显示器、地面上；音效规则按 sfx 给 */
function makeSolo(sfx: PackSfx | null) {
  const tuning: Tuning = {...DEFAULT_TUNING, idleSec: [0, 0], walkMaxSec: 600};
  const pack = makePack({id: 's', mind: idleMind(), sfx});
  const sim = new Sim([pack], tuning, {variant: SCENE_VARIANT, heightLogical: 120, r18: true}, mulberry32(3),
    {unlocked: [], playSeconds: 0, chars: {}}, new Map());
  const display = makeDisplay(1, rect(0, 0, 1920, 1080));
  sim.setDesktop({displays: [display], windows: []});
  sim.spawn('s', {x: 800, y: FLOOR_Y});
  return {sim, pack, display};
}

/** 推进 n 帧（30 Hz） */
function tick(sim: Sim, n = 1): void {
  for (let i = 0; i < n; i++) sim.step(sim.now + DT, DT);
}

/** 一直推进到角色站在 idle、播 idle 动作 */
function settleToIdle(sim: Sim) {
  for (let i = 0; i < 300; i++) {
    const a = sim.charOf('s')!.actor!;
    if (a.state === 'idle' && a.action === 'idle') return a;
    tick(sim);
  }
  throw new Error('角色没有落到 idle');
}

test('单人循环动作：idle 每圈响一次（24 帧 12 fps，4 秒里 e0 / e5 各 2 次），takeCues 取走后不重复', () => {
  const {sim} = makeSolo({voice: 'v', actions: {idle: [[0, 'e0'], [5, 'e5']]}});
  const a = settleToIdle(sim);
  sim.takeCues();                                          // 落地时那一下不算
  const started = sim.now;
  tick(sim, 120);                                          // 4 秒 = 两圈
  approx(sim.now - started, 4, '推进了 4 秒');

  const cues = sim.takeCues();
  eq(cues.filter(c => c.effect === 'e0').length, 2, '每圈一次 e0');
  eq(cues.filter(c => c.effect === 'e5').length, 2, '每圈一次 e5');
  for (const c of cues) {
    eq(c.id, 's');
    eq(c.voice, 'v');
    eq(c.behind, false);
    approx(c.x, a.x, 'cue 的 x 是脚底点');
    approx(c.y, a.y, 'cue 的 y 是脚底点');
  }

  eq(sim.takeCues().length, 0, '取走以后不重复给');
  tick(sim, 1);                                            // 这一帧（4 秒刚过）还没有下一个 key
  eq(sim.takeCues().length, 0, '接着推进一帧也没有重复');
});

test('单人换了动作从头算：不循环的 wave（12 帧）播完不再响，之后 idle 的帧 0 重新响', () => {
  const {sim, pack} = makeSolo({voice: 'v', actions: {idle: [[0, 'i0']], wave: [[0, 'w0'], [11, 'w11']]}});
  const a = settleToIdle(sim);
  sim.takeCues();                                          // 落地时的 i0
  setPlan(a, pack.actorSpec(sim.tuning), {behavior: 'wave-test', steps: [{state: 'act', action: 'wave'}]}, sim.ctx(), 'test');
  eq(a.action, 'wave');

  tick(sim, 35);                                           // 1.17 秒：wave 只播 1 秒，已经回到 idle 的第 0 帧附近
  eq(a.state, 'idle', 'wave 播完回到 idle');
  eq(a.action, 'idle');
  const cues = sim.takeCues();
  eq(cues.filter(c => c.effect === 'w0').length, 1, 'wave 第 0 帧响一次');
  eq(cues.filter(c => c.effect === 'w11').length, 1, 'wave 最后一帧（11）响一次');
  eq(cues.filter(c => c.effect === 'i0').length, 1, '换动作以后 idle 从第 0 帧重新算');

  tick(sim, 90);                                           // 再 3 秒：wave 早播完了
  const after = sim.takeCues();
  eq(a.action, 'idle');
  eq(after.filter(c => c.effect === 'w0' || c.effect === 'w11').length, 0, '不循环动作播完以后不再响');
});

test('单人补帧上限：一次 step 跳过 3 秒，只补最近 0.25 秒内的 key（不补前面整串）', () => {
  const {sim} = makeSolo({voice: 'v', actions: {idle: [[0, 'k0'], [6, 'k6'], [12, 'k12'], [18, 'k18']]}});
  const a = settleToIdle(sim);
  sim.takeCues();
  // 从 idle 的 actionStart 起跳 3 秒 = 36 帧（idle 24 帧，36 % 24 = 12）：整段里应有 0/6/12/18/0/6/12
  // 只补 abs-3..abs = 33..36 → 帧 9/10/11/12 → 只有 k12
  sim.step(a.actionStart + 3, 3);
  const cues = sim.takeCues();
  assert.deepEqual(cues.map(c => c.effect), ['k12'], `跳 3 秒后补的 cue：${cues.map(c => c.effect).join(',') || '（空）'}`);
  eq(cues[0].id, 's');
  eq(sim.takeCues().length, 0);
});

// ---------- Sim：双人场景的音效 cue ----------

test('双人 play：start 段第 0 帧和 climax 最后一帧的 key 各响一次（id / voice / x / y 都对，收尾前触发）', () => {
  const fx = makeDuo();
  fx.scene.sfx = {voices: {receiver: 'r-voice', giver: 'g-voice'}, keys: [
    [0, 'receiver', 'start-snd'],
    [39, 'giver', 'end-snd'],                              // 默认段 climax 30..40，最后一帧是 39
  ]};
  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'play', 'play');
  const d = fx.sim.duos[0];
  const facing = d.facing, anchor = duoAnchorX(fx.sim);
  eq(d.program.length, 40);
  eq(d.program.at(-1), 39);

  // 一帧一帧取 cue：最后一帧的 key 必须在 play 还没拆掉的时候触发（收尾之前）
  const cues: SoundCue[] = [];
  let endWhilePlaying = false, done = false;
  for (let i = 0; i < 30 * 10 && !done; i++) {
    const playing = fx.sim.duos.length > 0;
    const evs = drv.frame();
    const got = fx.sim.takeCues() as SoundCue[];
    cues.push(...got);
    if (playing && got.some(c => c.effect === 'end-snd')) endWhilePlaying = true;
    done = evs.some(x => x.e.type === 'duo' && x.e.what === 'done');
  }
  assert.ok(done, '没等到 done');
  assert.ok(endWhilePlaying, '最后一帧的 key 应该在收尾之前（play 还在）触发');

  const starts = cues.filter(c => c.effect === 'start-snd');
  eq(starts.length, 1, 'start 段的 key 响一次');
  eq(starts[0].id, 'a', '接受方');
  eq(starts[0].voice, 'r-voice');
  approx(starts[0].x, anchor + sceneCastX(fx.scene, facing, 'receiver', 0), 'x = 锚点 + 这一帧的 cast dx × k');
  eq(starts[0].y, FLOOR_Y);
  eq(starts[0].behind, false);

  const ends = cues.filter(c => c.effect === 'end-snd');
  eq(ends.length, 1, 'climax 最后一帧的 key 在收尾前响一次');
  eq(ends[0].id, 'b', '给予方');
  eq(ends[0].voice, 'g-voice');
  approx(ends[0].x, anchor + sceneCastX(fx.scene, facing, 'giver', 39), 'x = 锚点 + 这一帧的 cast dx × k');
  eq(ends[0].y, FLOOR_Y);

  // 场景只在 play 中出声：收尾以后不再有场景 cue
  eq(fx.sim.takeCues().length, 0);
});

test('双人 loop 段多绕：放在 loopA 里的 key 每绕一圈多响一次', () => {
  const fx = makeDuo({loops: [2, 2]});                     // loopA 播 1 + 2 遍
  fx.scene.sfx = {voices: {receiver: 'r-voice', giver: 'g-voice'}, keys: [[15, 'receiver', 'loop-snd']]};
  const drv = drive(fx.sim);
  drv.until(e => e.type === 'duo' && e.what === 'play', 'play');
  const d = fx.sim.duos[0];
  const facing = d.facing, anchor = duoAnchorX(fx.sim);
  eq(d.program.filter(f => f === 15).length, 3, 'loopA 里的第 15 帧在程序里出现 3 次');

  drv.until(e => e.type === 'duo' && e.what === 'done', 'done', 10);
  const cues = fx.sim.takeCues().filter(c => c.effect === 'loop-snd');
  eq(cues.length, 3, '绕几圈就响几次');
  for (const c of cues) {
    eq(c.id, 'a');
    eq(c.voice, 'r-voice');
    approx(c.x, anchor + sceneCastX(fx.scene, facing, 'receiver', 15), '每次都是这一帧的位置');
    eq(c.y, FLOOR_Y);
  }
});

test('双人 play 期间：两个角色自己动作上的 key 不响（走过去的时候还响）', () => {
  const fx = makeDuo();
  fx.aPack.sfx = {voice: 'a-voice', actions: {idle: [[0, 'a-idle']], walk: [[0, 'a-walk']]}};
  fx.bPack.sfx = {voice: 'b-voice', actions: {idle: [[0, 'b-idle']], walk: [[0, 'b-walk']]}};

  const drv = drive(fx.sim);
  const before: SoundCue[] = [];
  let played = false;
  for (let i = 0; i < 30 * 20 && !played; i++) {
    const evs = drv.frame();
    before.push(...fx.sim.takeCues());
    if (evs.some(x => x.e.type === 'duo' && x.e.what === 'play')) played = true;
  }
  assert.ok(played, '没进 play');
  assert.ok(before.some(c => c.id === 'a' && c.effect === 'a-walk'), '走过去的时候 a 自己的动作 key 应该响');
  assert.ok(before.some(c => c.id === 'b' && c.effect === 'b-walk'), '走过去的时候 b 自己的动作 key 应该响');

  // play 里跑 1 秒（play 全长 2.7 秒，还没结束）：两个角色的单人 cue 都不该有
  const during: SoundCue[] = [];
  for (let i = 0; i < 30; i++) {
    drv.frame();
    during.push(...fx.sim.takeCues());
  }
  eq(fx.sim.duos.length, 1, '应该还在 play 里');
  eq(during.filter(c => c.id === 'a' || c.id === 'b').length, 0,
    `play 期间不该有单人 cue：${during.map(c => c.effect).join(',') || '（空）'}`);
  assert.deepEqual(during, [], '这个场景没有 scene.sfx，play 里也不该有别的 cue');
});
