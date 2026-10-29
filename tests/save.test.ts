// store/save 的单测：存取往返、文件不存在、坏 JSON / schema 不对时改名留着并返回空存档、原子写、离线时长。
// 规则见 docs/design.md §12、docs/requirements.md R8.9 / R9.4、src/store/save.ts 开头。
// 临时文件只写项目的 temp/save-test/，跑完删掉；不碰系统临时目录。
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {emptySave, loadSave, offlineSeconds, writeSave} from '../src/store/index.ts';
import type {SaveData} from '../src/store/index.ts';

const ROOT = fileURLToPath(new URL('../temp/save-test/', import.meta.url));
let seq = 0;

/** 每个测试一个独立目录（同一个目录里检查 .tmp / .bad 残留） */
function tempDir(): string {
  const dir = join(ROOT, `case-${++seq}`);
  mkdirSync(dir, {recursive: true});
  return dir;
}

after(() => { rmSync(ROOT, {recursive: true, force: true}); });

function sample(): SaveData {
  return {
    schema: 1,
    savedAt: 0,
    playSeconds: 123.5,
    unlocked: ['witch', 'silent'],
    chars: {
      witch: {
        stats: {desire: 61, stamina: 12},
        relations: {user: {affection: 78}, silent: {affection: 45}},
        outfit: 'topless',
      },
      silent: {stats: {}, relations: {}},
    },
  };
}

test('emptySave：空存档', () => {
  assert.deepEqual(emptySave(), {schema: 1, savedAt: 0, playSeconds: 0, unlocked: [], chars: {}});
  assert.notEqual(emptySave().chars, emptySave().chars); // 每次新对象，不共享
});

test('存取往返：自动建目录，savedAt 设成 now，读回来一模一样', () => {
  const dir = tempDir();
  const file = join(dir, 'nested', 'save.json'); // 目录还不存在
  const data = sample();
  const now = 1_700_000_000_000;

  writeSave(file, data, now);
  assert.equal(data.savedAt, now); // 写之前改的是传进来的对象
  assert.equal(existsSync(file), true);
  assert.deepEqual(readdirSync(dirname(file)), ['save.json']); // 没有 .tmp 残留

  assert.deepEqual(loadSave(file), data);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).savedAt, now);
});

test('loadSave：文件不存在返回空存档，不建文件', () => {
  const dir = tempDir();
  const file = join(dir, 'save.json');
  assert.deepEqual(loadSave(file), emptySave());
  assert.equal(existsSync(file), false);
  assert.deepEqual(readdirSync(dir), []);
});

test('loadSave：坏 JSON 改名成 .bad-<时间戳> 留着，返回空存档', () => {
  const dir = tempDir();
  const file = join(dir, 'save.json');
  const bad = '{"schema": 1, "savedAt":';
  writeFileSync(file, bad, 'utf8');

  assert.deepEqual(loadSave(file), emptySave());
  assert.equal(existsSync(file), false);
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.ok(files[0].startsWith('save.json.bad-'), files[0]);
  assert.equal(readFileSync(join(dir, files[0]), 'utf8'), bad); // 原内容留着
});

test('loadSave：schema 不对（或结构不像存档）同样改名留着，返回空存档', () => {
  const dir = tempDir();
  const file = join(dir, 'save.json');

  // schema 版本不是 1
  writeFileSync(file, JSON.stringify({schema: 2, savedAt: 0, playSeconds: 0, unlocked: [], chars: {}}), 'utf8');
  assert.deepEqual(loadSave(file), emptySave());
  assert.equal(existsSync(file), false);
  assert.ok(readdirSync(dir).some(name => name.startsWith('save.json.bad-')));

  // schema 是 1，但缺 chars / unlocked
  writeFileSync(file, JSON.stringify({schema: 1, savedAt: 0, playSeconds: 0}), 'utf8');
  assert.deepEqual(loadSave(file), emptySave());
  assert.equal(existsSync(file), false);
});

test('writeSave：原子写，重复写覆盖旧内容，没有 .tmp 残留', () => {
  const dir = tempDir();
  const file = join(dir, 'save.json');

  writeSave(file, sample(), 1000);
  const second = sample();
  second.playSeconds = 999;
  second.unlocked = ['silent'];
  second.chars = {silent: {stats: {desire: 5}, relations: {user: {affection: 10}}}};
  writeSave(file, second, 2000);

  assert.deepEqual(readdirSync(dir), ['save.json']);
  assert.equal(existsSync(`${file}.tmp`), false);
  const loaded = loadSave(file);
  assert.equal(loaded.savedAt, 2000);
  assert.equal(loaded.playSeconds, 999);
  assert.deepEqual(loaded.unlocked, ['silent']);
  assert.deepEqual(loaded.chars, second.chars);
});

test('offlineSeconds：按毫秒差算秒，负数当 0，默认最多 2 小时', () => {
  const data = {...emptySave(), savedAt: 1_000_000};
  assert.equal(offlineSeconds(data, 1_000_000 + 10_000), 10);
  assert.equal(offlineSeconds(data, 1_000_000 + 500), 0.5);
  assert.equal(offlineSeconds(data, 1_000_000 - 5_000), 0);
  assert.equal(offlineSeconds(data, 1_000_000), 0);

  // 上限：默认 7200 秒，可覆盖
  assert.equal(offlineSeconds(data, 1_000_000 + 3 * 3600 * 1000), 7200);
  assert.equal(offlineSeconds(data, 1_000_000 + 3 * 3600 * 1000, 60), 60);
  assert.equal(offlineSeconds(data, 1_000_000 + 5_000, 0), 0);
  assert.equal(offlineSeconds(data, 1_000_000 + 5_000, -10), 0);

  // 空存档（savedAt = 0）也照规则算，被上限截住
  assert.equal(offlineSeconds(emptySave(), 10 * 3600 * 1000), 7200);
  assert.equal(offlineSeconds({...data, savedAt: Number.NaN}, 1_000_000), 0);
});
