// 各页共用的“一行设置”写法：卡片 + 开关 / 下拉 / 滑杆，改动经 ctx.set 或 ctx.act，失败原因显示在这一行上。
import type {Key} from '../../shared/i18n.ts';
import type {EditableKey, SettingsPatch, SettingsView} from '../protocol.ts';
import {row, select, slider, toggle, type Ctx, type RowOpts, type StatusEl} from '../ui.ts';

type Base = Omit<RowOpts, 'control'>;

export function toggleRow(ctx: Ctx, o: Base & {get: (v: SettingsView) => boolean; change: (on: boolean, st: StatusEl) => Promise<boolean>;
  disabled?: (v: SettingsView) => boolean}): HTMLElement {
  let st: StatusEl | null = null;
  const control = toggle(ctx, {labelledBy: `${o.id}-title`, describedBy: o.desc ? `${o.id}-desc` : undefined, get: o.get, disabled: o.disabled,
    change: on => o.change(on, st!)});
  const r = row(ctx, {...o, control});
  st = r.status;
  return r.el;
}

/** 开关直接对应一个布尔设置（invert：开关开着 = 设置为 false，如“全年龄模式”对 r18） */
export function settingToggle(ctx: Ctx, key: EditableKey, o: Base & {invert?: boolean; disabled?: (v: SettingsView) => boolean}): HTMLElement {
  return toggleRow(ctx, {...o, get: v => (v.settings[key] as boolean) !== !!o.invert,
    change: (on, st) => ctx.set({[key]: on !== !!o.invert} as SettingsPatch, st)});
}

export function selectRow(ctx: Ctx, o: Base & {options: (v: SettingsView) => [string, string][]; get: (v: SettingsView) => string;
  change: (value: string, st: StatusEl) => Promise<boolean>; disabled?: (v: SettingsView) => boolean}): HTMLElement {
  let st: StatusEl | null = null;
  const control = select(ctx, {labelledBy: `${o.id}-title`, options: o.options, get: o.get, disabled: o.disabled, id: `${o.id}-select`,
    change: value => o.change(value, st!)});
  const r = row(ctx, {...o, control});
  st = r.status;
  return r.el;
}

export function sliderRow(ctx: Ctx, o: Base & {min: number; max: number; step: number; format: (n: number) => string; get: (v: SettingsView) => number;
  change: (n: number, st: StatusEl) => Promise<boolean>; input?: (n: number) => void; disabled?: (v: SettingsView) => boolean}): HTMLElement {
  let st: StatusEl | null = null;
  const control = slider(ctx, {labelledBy: `${o.id}-title`, min: o.min, max: o.max, step: o.step, format: o.format, get: o.get, input: o.input,
    disabled: o.disabled, change: n => o.change(n, st!)});
  const r = row(ctx, {...o, control});
  st = r.status;
  return r.el;
}

/** 词条 <prefix>.title / .desc / .keywords 组成一行的文字 */
export function texts(ctx: Ctx, prefix: string): {title: string; desc: string; keywords: string} {
  const k = (s: string) => `${prefix}.${s}` as Key;
  return {title: ctx.t(k('title')), desc: ctx.tr.has(k('desc')) ? ctx.t(k('desc')) : '', keywords: ctx.tr.has(k('keywords')) ? ctx.t(k('keywords')) : ''};
}
