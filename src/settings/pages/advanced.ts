// 高级：调试、性能日志、图集内存、解锁全部角色、物理与行为参数（重启后生效）、重启。
import type {Key} from '../../shared/i18n.ts';
import type {Tuning} from '../../behavior/types.ts';
import {ICON, button, expander, h, hotkeyField, infobar, numberField, row, section, statusEl, type Ctx} from '../ui.ts';
import {settingToggle, texts} from './common.ts';

/** 参数的单位（词条 unit.*）；区间是 [最短, 最长] 两个框，权重三个框 */
const TUNING_UNITS: Record<keyof Tuning, string> = {
  gravity: 'pxPerSec2', dragX: 'perSec', dragY: 'perSec', maxThrowSpeed: 'pxPerSec', hardLandingSpeed: 'pxPerSec', landSec: 'sec', downedSec: 'sec',
  idleSec: 'sec', sitSec: 'sec', sitCooldown: 'sec', weights: '', walkOffEdgeChance: '', walkMaxSec: 'sec', followMaxDx: 'px', followMaxDown: 'px',
  followMaxUp: 'px', jumpUpHeights: 'heights', jumpSideHeights: 'heights', jumpArcHeights: 'heights', insideInset: 'px',
};

export function advancedPage(ctx: Ctx): HTMLElement[] {
  const t = ctx.t, v0 = ctx.view();
  const debug = settingToggle(ctx, 'debug', {id: 'debug', icon: ICON.debug, ...texts(ctx, 'advanced.debug')});
  const debugKey = row(ctx, {id: 'debugKey', icon: ICON.keyboard, ...texts(ctx, 'advanced.debugKey'),
    control: hotkeyField(ctx, {labelledBy: 'debugKey-title', get: v => v.settings.debugKey, change: acc => ctx.set({debugKey: acc}, debugKey.status)})});
  ctx.onSync(v => { if (!v.state.debugKeyOk) debugKey.status.error(t('general.bossKey.taken')); });
  const perf = settingToggle(ctx, 'perfLog', {id: 'perfLog', icon: ICON.perf, ...texts(ctx, 'advanced.perf')});
  const budget = row(ctx, {id: 'sheetBudgetMB', icon: ICON.ram, ...texts(ctx, 'advanced.budget'), control: []});
  budget.el.querySelector('.row-control')!.append(numberField(ctx, {labelledBy: 'sheetBudgetMB-title', min: 32, max: 4096, step: 1, unit: 'MB', width: 96,
    get: v => v.settings.sheetBudgetMB, change: n => ctx.set({sheetBudgetMB: n!}, budget.status)}).el);
  const unlock = row(ctx, {id: 'unlockAll', icon: ICON.unlock, ...texts(ctx, 'advanced.unlock'), control: []});
  const unlockBtn = button({text: t('advanced.unlock.action'), onclick: async () => {
    if (await ctx.confirm({title: t('advanced.unlock.confirmTitle'), body: t('advanced.unlock.confirmBody'), confirm: t('advanced.unlock.action')}))
      if ((await ctx.act({type: 'unlockAll'}, unlock.status)).ok) unlock.status.ok(t('advanced.unlock.done'));
  }});
  unlock.el.querySelector('.row-control')!.append(unlockBtn);
  ctx.onSync(v => { unlockBtn.disabled = v.state.unlockedAll; });

  // 物理与行为参数：一组一起改（重启后生效），所以用“应用”按钮，不是改一个存一个
  const st = statusEl();
  const inputs = new Map<string, HTMLInputElement>();
  const def = v0.defaultTuning as unknown as Record<string, unknown>;
  const current = (): Record<string, unknown> => ({...def, ...ctx.view().settings.tuning});
  const numInput = (key: string, label: string) => {
    const i = h('input', {type: 'number', class: 'number', min: 0, step: 'any', 'aria-label': label});
    i.style.setProperty('width', '88px');
    inputs.set(key, i);
    return i;
  };
  const fields = (Object.keys(TUNING_UNITS) as (keyof Tuning)[]).map(k => {
    const label = t(`advanced.tuning.${k}` as Key), unit = TUNING_UNITS[k], d = def[k];
    const unitEl = unit ? h('span', {class: 'unit', text: t(`unit.${unit}` as Key)}) : null;
    const box = Array.isArray(d) ? h('span', {class: 'pair'}, numInput(`${k}.0`, `${label} ${t('advanced.tuning.min')}`), '–', numInput(`${k}.1`, `${label} ${t('advanced.tuning.max')}`), unitEl)
      : d && typeof d === 'object' ? h('span', {class: 'pair'}, ...Object.keys(d).map(w => h('label', {class: 'turn-field'},
        h('span', {class: 'inline-label', text: t(`advanced.tuning.weight.${w}` as Key)}), numInput(`${k}.${w}`, `${label} ${t(`advanced.tuning.weight.${w}` as Key)}`))))
      : h('span', {class: 'pair'}, numInput(k, label), unitEl);
    return h('div', {class: 'tuning-row'}, h('span', {class: 'tuning-label', text: label}), h('span', {class: 'tuning-def', text: t('advanced.tuning.default', {v: JSON.stringify(d).replace(/[{}"[\]]/g, '').replace(/,/g, ', ')})}), box);
  });
  const fill = (src: Record<string, unknown>) => {
    for (const [key, input] of inputs) {
      const [k, sub] = key.split('.');
      const v = sub === undefined ? src[k] : (src[k] as Record<string, unknown>)[sub];
      input.value = String(v);
      input.setAttribute('aria-invalid', 'false');
    }
  };
  const collect = (): Record<string, unknown> | null => {
    const out: Record<string, unknown> = {};
    let bad = false;
    for (const [key, input] of inputs) {
      const n = Number(input.value), okNum = input.value.trim() !== '' && Number.isFinite(n) && n >= 0;
      input.setAttribute('aria-invalid', okNum ? 'false' : 'true');
      if (!okNum) bad = true;
      const [k, sub] = key.split('.');
      if (sub === undefined) out[k] = n;
      else if (Array.isArray(def[k])) ((out[k] ??= [0, 0]) as number[])[Number(sub)] = n;
      else ((out[k] ??= {}) as Record<string, number>)[sub] = n;
    }
    for (const [k, v] of Object.entries(out)) if (Array.isArray(v) && v[0] > v[1]) { bad = true; inputs.get(`${k}.0`)!.setAttribute('aria-invalid', 'true'); }
    return bad ? null : out;
  };
  let editing = false;
  const form = h('div', {class: 'tuning'}, ...fields);
  form.addEventListener('input', () => { editing = true; });
  ctx.onSync(() => { if (!editing) fill(current()); });
  const apply = button({text: t('advanced.tuning.apply'), kind: 'accent', icon: ICON.save, onclick: async () => {
    const v = collect();
    if (!v) { st.error(t('advanced.tuning.invalid')); return; }
    if (await ctx.set({tuning: v as Partial<Tuning>}, st)) { editing = false; st.ok(t('advanced.tuning.applied')); }
  }});
  const reset = button({text: t('common.resetDefaults'), kind: 'subtle', icon: ICON.undo, onclick: async () => {
    if (await ctx.set({tuning: {}}, st)) { editing = false; fill(def); st.ok(t('advanced.tuning.applied')); } }});
  const tuning = expander(ctx, {id: 'tuning', icon: ICON.tune, ...texts(ctx, 'advanced.tuning')},
    infobar('info', t('advanced.tuning.restartNote')), form, h('div', {class: 'prompt-foot'}, st.el, h('span', {class: 'grow'}), reset, apply));

  const restart = row(ctx, {id: 'restart', icon: ICON.restart, ...texts(ctx, 'advanced.restart'), control: []});
  restart.el.querySelector('.row-control')!.append(button({text: t('advanced.restart.action'), onclick: async () => {
    if (await ctx.confirm({title: t('advanced.restart.confirmTitle'), body: t('advanced.restart.confirmBody'), confirm: t('advanced.restart.action')}))
      await ctx.act({type: 'restart'}, restart.status);
  }}));
  return [section(t('advanced.section.debug'), debug, debugKey.el, perf), section(t('advanced.section.performance'), budget.el),
    section(t('advanced.section.other'), unlock.el, tuning, restart.el)];
}
