// 界面双语（src/shared/i18n.ts、src/locales/）：中英文词条一样多、插值参数一样；运行时拼出来的键（勿扰原因、请求类型、失败原因、
// 声音参数、行为参数、源码里 msg('…') 的键）都有词条；语言判断；角色显示名。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import zhCN from '../src/locales/zh-CN.ts';
import en from '../src/locales/en.ts';
import {createTranslator, displayName, resolveLang} from '../src/shared/i18n.ts';
import {VOICE_CONTROLS} from '../src/llm/voice.ts';
import {DEFAULT_TUNING} from '../src/behavior/index.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
type Tree = {[k: string]: string | Tree};
const flat = (t: Tree, p = ''): Map<string, string> => new Map(Object.entries(t).flatMap(([k, v]) => typeof v === 'string' ? [[p + k, v]] : [...flat(v, `${p}${k}.`)]));
const zh = flat(zhCN as unknown as Tree), eng = flat(en as unknown as Tree);
const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join(',');

test('中英文词条键一样、每条的插值参数一样、没有空词条', () => {
  assert.deepEqual([...eng.keys()].sort(), [...zh.keys()].sort());
  for (const [k, v] of zh) {
    assert.equal(vars(eng.get(k)!), vars(v), `插值参数不一致：${k}`);
    assert.ok(v.trim() && eng.get(k)!.trim(), `空词条：${k}`);
  }
});

test('运行时拼出来的键都有词条', () => {
  const need = [
    ...['manual', 'system', 'fullscreen', 'app', 'other'].map(x => `dnd.reason.${x}`),
    ...['decision', 'line', 'adult-line', 'reaction', 'duo', 'talk', 'reply', 'memory', 'vision'].map(x => `usage.kind.${x}`),
    ...['ok', 'timeout', 'aborted', 'http', 'network', 'refusal', 'bad-json', 'invalid', 'stale', 'empty-thinking', 'superseded', 'budget'].map(x => `usage.result.${x}`),
    ...VOICE_CONTROLS.flatMap(c => [`voice.${c.key}.label`, `voice.${c.key}.hint`, ...(c.unit ? [`unit.${c.unit}`] : [])]),
    ...Object.keys(DEFAULT_TUNING).map(k => `advanced.tuning.${k}`),
    ...['unsupported', 'unverified', 'verified', 'failed'].map(x => `vision.image.${x}`),
  ];
  for (const k of need) assert.ok(zh.has(k), `缺词条：${k}`);
  // 源码里 msg('键') 写死的键
  const files = fs.readdirSync(path.join(ROOT, 'src'), {recursive: true, encoding: 'utf8'}).filter(f => f.endsWith('.ts'));
  let n = 0;
  for (const f of files) for (const m of fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').matchAll(/\bmsg\(\s*'([\w.-]+)'/g)) { n++; assert.ok(zh.has(m[1]), `${f}：缺词条 ${m[1]}`); }
  assert.ok(n >= 10, `源码里的 msg 键太少（${n}），正则没对上？`);
});

test('设置窗口的错误码（error.*）都有词条', () => {
  const files = ['src/main/settings-patch.ts', 'src/main/llm-settings.ts', 'src/main/main.ts', 'src/main/settings-window.ts'];
  for (const f of files) for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/'(error\.\w+)'/g)) assert.ok(zh.has(m[1]), `${f}：缺词条 ${m[1]}`);
});

test('resolveLang：跟随系统时中文系统用中文、其余用英文；直接选的照选的', () => {
  assert.equal(resolveLang('system', ['zh-Hans-CN', 'en-US']), 'zh-CN');
  assert.equal(resolveLang('system', ['zh-TW']), 'zh-CN');
  assert.equal(resolveLang('system', ['en-GB']), 'en');
  assert.equal(resolveLang('system', ['ja-JP', 'zh-CN']), 'zh-CN');
  assert.equal(resolveLang('system', ['ja-JP']), 'en');
  assert.equal(resolveLang('system', []), 'en');
  assert.equal(resolveLang('en', ['zh-CN']), 'en');
  assert.equal(resolveLang('zh-CN', ['en-US']), 'zh-CN');
});

test('翻译：插值、运行时消息、查不到的键', () => {
  const t = createTranslator('en'), z = createTranslator('zh-CN');
  assert.equal(t.t('bubble.to', {name: 'Mage'}), 'to Mage');
  assert.equal(z.t('bubble.to', {name: '魔法师'}), '对魔法师说');
  assert.equal(t.m({key: 'dnd.reason.app', params: {exe: 'Zoom.exe'}}), 'Zoom.exe in front');
  assert.equal(z.m({key: 'status.llm.hourlyChanged', params: {n: 500}}), '每小时上限改成了 500 次');
  assert.equal(t.has('nav.general'), true);
  assert.equal(t.has('nav.nope'), false);
  // 插值不转义（界面一律 textContent），& < 原样
  assert.equal(t.t('bubble.to', {name: 'A&B <x>'}), 'to A&B <x>');
});

test('displayName：角色包有这种语言的名字用它，否则用 name', () => {
  const m = {name: '女巫', names: {en: 'Witch'}};
  assert.equal(displayName(m, 'en'), 'Witch');
  assert.equal(displayName(m, 'zh-CN'), '女巫');
  assert.equal(displayName({name: '魔法师'}, 'en'), '魔法师');
});
