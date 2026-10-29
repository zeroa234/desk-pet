// 设置窗口验收用的宿主（2026-10-29）：真的角色包、真的 Sim、真的 LlmRuntime 和设置校验，但设置、存档、LLM 配置都在一个临时目录里，
// 不碰用户的 data/、config/*.local.*；不起桌宠、不动光标、不发网络请求。快照的拼法照 main.ts 的 settingsView（桌面状态是假的）。
import fs from 'node:fs';
import path from 'node:path';
import {PROJECT} from '../../src/main/env.ts';
import {DEFAULT_SETTINGS, SettingsStore, type Settings} from '../../src/main/settings.ts';
import {checkPatch} from '../../src/main/settings-patch.ts';
import {createLlmSettings} from '../../src/main/llm-settings.ts';
import {Sim} from '../../src/main/sim.ts';
import {loadPacks} from '../../src/pack/index.ts';
import {DEFAULT_TUNING} from '../../src/behavior/index.ts';
import {LlmRuntime} from '../../src/llm/runtime.ts';
import {createTranslator, displayName, resolveLang, type Translator} from '../../src/shared/i18n.ts';
import {msg} from '../../src/shared/msg.ts';
import {EDITABLE, RESTART_KEYS, type Result, type SettingsAction, type SettingsView} from '../../src/settings/protocol.ts';
import {makeDisplay, mulberry32, rect} from '../../tests/helpers/fake-desktop.ts';

export interface FakeHost {
  view(): SettingsView;
  set(raw: unknown): Result;
  act(raw: unknown): Result;
  title(): string;
  settings: SettingsStore;
  runtime: LlmRuntime;
  close(): void;
  /** 调用记录（检查“动作有没有到主进程”） */
  calls: string[];
}

export function fakeHost(root: string, system: readonly string[] = ['zh-Hans-CN']): FakeHost {
  for (const d of ['config', 'data']) fs.mkdirSync(path.join(root, d), {recursive: true});
  for (const f of ['llm.json', 'pricing.json']) fs.copyFileSync(path.join(PROJECT, 'config', f), path.join(root, 'config', f));
  const settings = new SettingsStore(path.join(root, 'data', 'settings.json'));
  const packs = loadPacks(PROJECT);
  const ids = packs.map(p => p.manifest.id);
  const sim = new Sim(packs, {...DEFAULT_TUNING}, {variant: packs[0].manifest.defaultVariant, heightLogical: 120, r18: true}, mulberry32(7),
    {unlocked: ids.slice(0, 2), playSeconds: 0, chars: {}}, new Map());
  sim.setDesktop({displays: [makeDisplay(1, rect(0, 0, 1920, 1080))], windows: []});
  sim.setAbsent([]);
  ids.slice(0, 2).forEach((id, i) => sim.spawn(id, {x: 600 + i * 400, y: 0}));
  const runtime = new LlmRuntime(root, sim);
  let tr: Translator = createTranslator(resolveLang(settings.value.language, system));
  const nameOf = (id: string) => { const p = packs.find(x => x.manifest.id === id); return p ? displayName(p.manifest, tr.lang) : id; };
  const llm = createLlmSettings(root, runtime, packs.map(p => ({id: p.manifest.id, dir: p.relDir})), {
    nameOf, visionLatest: () => msg('status.vision.none'), canLook: () => false, look: () => false, volume: () => 0});
  const state = {hidden: false, autostart: false};   // 开机自启是假的：验收不写注册表
  const calls: string[] = [];
  const pick = (s: Settings) => Object.fromEntries(EDITABLE.map(k => [k, s[k]])) as SettingsView['settings'];
  const all = [...new Map(packs.flatMap(p => p.manifest.variants).map(v => [v.id, v])).values()];
  return {
    settings, runtime, calls,
    title: () => tr.t('app.title'),
    view: () => ({
      lang: tr.lang, systemLang: resolveLang('system', system), accent: null,
      settings: pick(settings.value), defaults: pick(DEFAULT_SETTINGS), defaultTuning: DEFAULT_TUNING,
      restartPending: RESTART_KEYS.filter(k => JSON.stringify(settings.value[k]) !== JSON.stringify(DEFAULT_SETTINGS[k])),
      state: {hidden: state.hidden, hiddenByFullscreen: false, dnd: settings.value.dndManual ? msg('dnd.reason.manual') : null, away: null, lastApp: 'Zoom.exe',
        bossKeyOk: true, debugKeyOk: true, unlockedAll: sim.unlocked.length >= packs.length, autostart: state.autostart},
      characters: packs.map(p => {
        const id = p.manifest.id, unlocked = sim.unlocked.includes(id);
        return {id, name: nameOf(id), unlocked, wanted: unlocked && !sim.isRequestedAbsent(id), present: unlocked && !sim.isAbsent(id), waiting: false,
          dir: p.relDir.replace(/\\/g, '/'), variants: p.manifest.variants.map(v => v.id), defaultVariant: p.manifest.defaultVariant, canSummon: unlocked};
      }),
      variants: all.map(v => ({...v, chars: packs.filter(p => p.manifest.variants.some(x => x.id === v.id)).map(p => p.manifest.id), isDefault: v.id === packs[0].manifest.defaultVariant})),
      heightRange: {min: 96, max: 320, step: 8},
      llm: llm.view(),
    }),
    set(raw) {
      calls.push(`set ${JSON.stringify(raw)}`);
      const r = checkPatch(raw, {variants: all.map(v => v.id)});
      if (!r.ok) return r;
      for (const [k, v] of Object.entries(r.value!)) settings.set(k as keyof Settings, v as never);
      tr = createTranslator(resolveLang(settings.value.language, system));
      return {ok: true};
    },
    act(raw) {
      const a = raw as SettingsAction;
      calls.push(`act ${a.type}`);
      switch (a.type) {
        case 'hide': state.hidden = a.on; return {ok: true};
        case 'autostart': state.autostart = a.on; return {ok: true};
        case 'desktop': sim.setAbsent(a.on ? [] : [a.id]); return {ok: true};
        case 'summon': case 'unlockAll': case 'restart': return {ok: true};
        default: return llm.act(a) ?? {ok: false, error: 'error.invalid'};
      }
    },
    close: () => runtime.close(),
  };
}
