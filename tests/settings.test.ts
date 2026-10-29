// 用户设置（src/main/settings.ts）：读写 data/settings.json（这里写到 temp/test-settings/）、临时值（DESK_PET_SET）不落盘、旧写法换成新写法、
// “在桌面上”怎么算（absentIds：选过的照选的，没选过的、以后新装的按 desktopDefault；2026-10-22 审查报告 A1）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_SETTINGS, SettingsStore, absentIds} from '../src/main/settings.ts';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'temp', 'test-settings');
const fileOf = (name: string, content?: string): string => {
  fs.mkdirSync(DIR, {recursive: true});
  const f = path.join(DIR, name);
  fs.rmSync(f, {force: true});
  if (content !== undefined) fs.writeFileSync(f, content);
  return f;
};
const onDisk = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('SettingsStore：没有文件、坏 JSON 都用默认值；文件里只存了一部分键的其余用默认值', () => {
  assert.deepEqual(new SettingsStore(fileOf('none.json')).value, DEFAULT_SETTINGS);
  assert.deepEqual(new SettingsStore(fileOf('bad.json', '{不是 JSON')).value, DEFAULT_SETTINGS);
  const s = new SettingsStore(fileOf('part.json', JSON.stringify({volume: 0.2})));
  assert.equal(s.value.volume, 0.2);
  assert.equal(s.value.heightLogical, DEFAULT_SETTINGS.heightLogical);
  assert.equal(s.stored('volume'), 0.2);
  assert.equal(s.stored('heightLogical'), undefined);
});

test('SettingsStore：临时值（overrides）只在内存里；set 写回文件时不带它', () => {
  const f = fileOf('ov.json', JSON.stringify({volume: 0.2}));
  const s = new SettingsStore(f, {volume: 0.9, debug: true});
  assert.equal(s.value.volume, 0.9);
  s.set('sound', false);
  const disk = onDisk(f);
  assert.equal(disk.volume, 0.2);
  assert.equal(disk.debug, false);
  assert.equal(disk.sound, false);
  assert.equal(fs.existsSync(f + '.tmp'), false, '先写临时文件再改名');
});

test('SettingsStore.migrate：写回文件；这次给了临时值的键内存里照旧用临时值', () => {
  const f = fileOf('mig.json', JSON.stringify({absentChars: ['witch']}));
  const s = new SettingsStore(f, {absentChars: ['silent']});
  s.migrate('absentChars', null);
  s.migrate('onDesktop', {witch: false});
  assert.deepEqual(s.value.absentChars, ['silent']);
  assert.deepEqual(s.value.onDesktop, {witch: false});
  assert.equal(onDisk(f).absentChars, null);
  assert.deepEqual(onDisk(f).onDesktop, {witch: false});
});

const PACKS = [{id: 'witch', defaultAbsent: false}, {id: 'silent', defaultAbsent: false}, {id: 'witch-hd', defaultAbsent: true}];

test('absentIds：没选过按 desktopDefault；选过的照选的；以后新装的（不在 onDesktop 里）照它自己的默认', () => {
  assert.deepEqual(absentIds({onDesktop: {}, absentChars: null}, PACKS), ['witch-hd']);
  assert.deepEqual(absentIds({onDesktop: {'witch-hd': true, witch: false}, absentChars: null}, PACKS), ['witch']);
  // 回归：以前存的是“当时全部角色里不在的”清单，新装一个默认不在的包会直接出现
  const later = [...PACKS, {id: 'nova', defaultAbsent: true}];
  assert.deepEqual(absentIds({onDesktop: {witch: false, silent: false, 'witch-hd': true}, absentChars: null}, later), ['witch', 'silent', 'nova']);
});

test('absentIds：absentChars（验收脚本整组指定）优先：列了的不在、没列的都在（默认不在的也打开）', () => {
  assert.deepEqual(absentIds({onDesktop: {witch: true}, absentChars: ['witch', 'silent']}, PACKS), ['witch', 'silent']);
  assert.deepEqual(absentIds({onDesktop: {}, absentChars: []}, PACKS), []);
});

test.after(() => fs.rmSync(DIR, {recursive: true, force: true}));
