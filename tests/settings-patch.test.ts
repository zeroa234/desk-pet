// 设置窗口发来的改动在主进程的校验（src/main/settings-patch.ts）：不认识的键、类型不对、超范围整条拒绝；名单规整；行为参数只存改过的；
// 热键写法；设置页的 import map 和 CSP 里的哈希对得上（改了 import map 忘了改哈希，页面会因为 CSP 白屏）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acceleratorValid, checkPatch, checkTuning, normalizeApps} from '../src/main/settings-patch.ts';
import {DEFAULT_TUNING} from '../src/behavior/index.ts';

const ctx = {variants: ['r80-full', 'hd-full']};
const ok = (raw: unknown) => { const r = checkPatch(raw, ctx); assert.ok(r.ok, JSON.stringify(r)); return r.ok ? r.value : null; };
const bad = (raw: unknown, error?: string) => { const r = checkPatch(raw, ctx); assert.equal(r.ok, false, JSON.stringify(raw)); if (error && !r.ok) assert.equal(r.error, error); };

test('布尔、数、语言、变体：合法的照收，别的整条拒绝', () => {
  assert.deepEqual(ok({paused: true, volume: 0.25, language: 'en', variant: 'hd-full'}), {paused: true, volume: 0.25, language: 'en', variant: 'hd-full'});
  assert.deepEqual(ok({variant: null, maxOnDesktop: null}), {variant: null, maxOnDesktop: null});
  bad({paused: 'yes'}, 'error.invalid');
  bad({volume: 1.5}, 'error.range');
  bad({heightLogical: 95}, 'error.range');
  bad({heightLogical: 120.5}, 'error.range');
  bad({language: 'fr'}, 'error.invalid');
  bad({variant: 'r120-full'}, 'error.invalid');
  bad({paused: true, absentChars: ['witch']}, 'error.invalid');   // 不在 EDITABLE 里的键
  bad({}, 'error.invalid');
  bad(null); bad([]);
});

test('程序名单：只认 exe 文件名，去空白、不分大小写去重', () => {
  assert.deepEqual(ok({dndApps: [' Zoom.exe', 'zoom.EXE', 'Teams.exe']}), {dndApps: ['Zoom.exe', 'Teams.exe']});
  bad({dndApps: ['C:\\Program Files\\Zoom.exe']}, 'error.exe');
  bad({dndApps: ['zoom']}, 'error.exe');
  assert.deepEqual(normalizeApps(['A.exe', 'a.exe', 'B.exe']), ['A.exe', 'B.exe']);
});

test('热键：要带修饰键（F 键可以单独用），两个热键不能一样', () => {
  for (const k of ['Control+Alt+H', 'Control+Shift+F12', 'Alt+Space', 'F9', 'Super+Alt+P']) assert.ok(acceleratorValid(k), k);
  for (const k of ['H', 'Control+', 'Control+Alt', '', 'Ctrl+Alt+Hello']) assert.ok(!acceleratorValid(k), k);
  bad({bossKey: 'H'}, 'error.hotkeyFormat');
  bad({bossKey: 'Control+Alt+K', debugKey: 'Control+Alt+K'}, 'error.hotkeySame');
});

test('行为参数：只认已有的键、区间前小后大、权重不能全 0；和默认一样的不存', () => {
  assert.deepEqual(checkTuning({gravity: 1300, idleSec: [3, 20], weights: {...DEFAULT_TUNING.weights}}), {gravity: 1300});
  assert.deepEqual(checkTuning({}), {});
  assert.equal(checkTuning({gravity: -1}), null);
  assert.equal(checkTuning({idleSec: [20, 3]}), null);
  assert.equal(checkTuning({weights: {walk: 0, sit: 0, idle: 0}}), null);
  assert.equal(checkTuning({weights: {walk: 1}}), null);
  assert.equal(checkTuning({nope: 1}), null);
  assert.deepEqual(ok({tuning: {gravity: 1250}}), {tuning: {}});
});

test('设置页的 import map 和 CSP 哈希对得上', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'settings', 'index.html'), 'utf8');
  const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1];
  const hash = crypto.createHash('sha256').update(map).digest('base64');
  assert.ok(html.includes(`'sha256-${hash}'`), `CSP 里要有 'sha256-${hash}'`);
  assert.ok(JSON.parse(map).imports.i18next.endsWith('node_modules/i18next/dist/esm/i18next.js'));
});
