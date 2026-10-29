// 设置窗口的组件（2026-10-29）：卡片行、开关、下拉、滑杆、数字框、热键录制、程序名单、提示条、确认框、提示气泡。
// 原生控件 + Windows 11 的样式（settings.css）：键盘、读屏、表单行为都用浏览器自带的；每个控件都有标签（label / aria-labelledby）。
// 值的刷新：组件把“从快照取值”的函数登记到 Ctx.onSync，快照变了统一跑一遍；正在输入的控件（有焦点、改了没提交）不被覆盖。
// 自写（没有打包工具，不引 UI 框架；docs/design.md §18 有选型）。
import type {Key, Params, Translator} from '../shared/i18n.ts';
import type {PageId, Result, SettingsAction, SettingsPatch, SettingsView} from './protocol.ts';

export interface SearchEntry {page: PageId; el: HTMLElement; title: string; text: string; focus?: () => void}
export interface Ctx {
  tr: Translator;
  t(key: Key, params?: Params): string;
  view(): SettingsView;
  /** 改设置；失败时在 status 上显示原因。成功返回 true */
  set(patch: SettingsPatch, status?: StatusEl): Promise<boolean>;
  act<T = unknown>(action: SettingsAction, status?: StatusEl): Promise<Result<T>>;
  onSync(fn: (v: SettingsView) => void): void;
  register(entry: SearchEntry): void;
  toast(text: string, undo?: () => void): void;
  confirm(o: {title: string; body: string; confirm: string; danger?: boolean}): Promise<boolean>;
  page: PageId;
  /** 页面显示 / 隐藏（动画预览按需启停） */
  onShow(fn: (shown: boolean) => void): void;
}

type Child = Node | string | null | undefined | false;
/** 建元素：h('div', {class: 'x', onclick}, ...子节点)；属性里 class / text / 事件 / aria-* / data-* 分别处理 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el && !k.startsWith('aria-') && !k.startsWith('data-') && k !== 'role' && k !== 'for') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k === 'for' ? 'for' : k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Segoe Fluent Icons 的字形（Windows 11 自带；Windows 10 用 Segoe MDL2 Assets，码位一样） */
export const ICON = {
  general: '', characters: '', appearance: '', behavior: '', sound: '', quiet: '', ai: '',
  vision: '', usage: '', advanced: '', search: '', globe: '', pause: '', hide: '', keyboard: '',
  people: '', size: '', style: '', mode: '', away: '', hand: '', volume: '', sfx: '',
  muffle: '', speech: '', moon: '', windows: '', fullscreen: '', app: '', capture: '',
  shield: '', model: '', limit: '', timer: '', memory: '', prompt: '', eye: '', image: '',
  debug: '', perf: '', ram: '', unlock: '', tune: '', restart: '', info: '', warning: '',
  error: '', success: '', chevron: '', add: '', remove: '', play: '', stop: '', save: '',
  undo: '', refresh: '', check: '', delete: '', summon: '', power: '',
} as const;
export const icon = (glyph: string, cls = '') => h('span', {class: `icon ${cls}`.trim(), 'aria-hidden': 'true', text: glyph});

let uid = 0;
export const nextId = (prefix: string) => `${prefix}-${++uid}`;

/** 控件旁边的状态（已保存 / 出错），role=status，出错时换成 alert */
export interface StatusEl {el: HTMLElement; ok(text: string): void; error(text: string): void; clear(): void}
export function statusEl(): StatusEl {
  const el = h('span', {class: 'status', role: 'status', 'aria-live': 'polite'});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (kind: '' | 'ok' | 'error', text: string) => {
    clearTimeout(timer);
    el.className = `status ${kind}`.trim(); el.textContent = '';
    if (kind === 'error') el.setAttribute('role', 'alert'); else el.setAttribute('role', 'status');
    if (text) el.append(icon(kind === 'error' ? ICON.error : ICON.check), h('span', {text}));
    if (kind === 'ok') timer = setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 2500);
  };
  return {el, ok: t => set('ok', t), error: t => set('error', t), clear: () => set('', '')};
}

export interface RowOpts {
  id: string;
  icon?: string;
  title: string;
  desc?: string;
  /** 只给搜索用的关键词 */
  keywords?: string;
  control?: Child | Child[];
  /** 行下方整行宽的内容（预览、子设置） */
  below?: Child | Child[];
  cls?: string;
}
/** 一张设置卡片：图标、标题、说明，右边是控件。标题的 id = `${id}-title`，控件用 aria-labelledby 指向它 */
export function row(ctx: Ctx, o: RowOpts): {el: HTMLElement; status: StatusEl; desc: HTMLElement; title: HTMLElement} {
  const status = statusEl();
  const title = h('div', {class: 'row-title', id: `${o.id}-title`, text: o.title});
  const desc = h('div', {class: 'row-desc', id: `${o.id}-desc`, text: o.desc ?? ''});
  const controls = Array.isArray(o.control) ? o.control : [o.control];
  const el = h('section', {class: `card row ${o.cls ?? ''}`.trim(), id: o.id, 'aria-labelledby': `${o.id}-title`},
    h('div', {class: 'row-main'},
      o.icon ? icon(o.icon, 'row-icon') : h('span', {class: 'row-icon-space'}),
      h('div', {class: 'row-text'}, title, desc, status.el),
      h('div', {class: 'row-control'}, ...controls)),
    ...(o.below ? [h('div', {class: 'row-below'}, ...(Array.isArray(o.below) ? o.below : [o.below]))] : []));
  if (!o.desc) desc.hidden = true;
  ctx.register({page: ctx.page, el, title: o.title, text: `${o.title} ${o.desc ?? ''} ${o.keywords ?? ''}`,
    focus: () => (el.querySelector('input,select,button,textarea') as HTMLElement | null)?.focus()});
  return {el, status, desc, title};
}

/** 可展开的卡片（<details>）：标题行 + 里面的子设置 */
export function expander(ctx: Ctx, o: {id: string; icon?: string; title: string; desc?: string; keywords?: string; summary?: () => string; open?: boolean}, ...body: Child[]): HTMLDetailsElement {
  const sum = h('span', {class: 'row-desc', id: `${o.id}-desc`, text: o.desc ?? ''});
  const el = h('details', {class: 'card expander', id: o.id, open: o.open},
    h('summary', {class: 'row-main'},
      o.icon ? icon(o.icon, 'row-icon') : h('span', {class: 'row-icon-space'}),
      h('span', {class: 'row-text'}, h('span', {class: 'row-title', id: `${o.id}-title`, text: o.title}), sum),
      icon(ICON.chevron, 'chevron')),
    h('div', {class: 'expander-body'}, ...body));
  if (o.summary) ctx.onSync(() => { sum.textContent = o.summary!(); });
  ctx.register({page: ctx.page, el, title: o.title, text: `${o.title} ${o.desc ?? ''} ${o.keywords ?? ''}`,
    focus: () => { el.open = true; (el.querySelector('summary') as HTMLElement).focus(); }});
  return el;
}

/** 子设置行（expander 里面，不再是独立卡片） */
export function subrow(o: {id: string; title: string; desc?: string; control: Child | Child[]}): {el: HTMLElement; status: StatusEl} {
  const status = statusEl();
  const controls = Array.isArray(o.control) ? o.control : [o.control];
  const el = h('div', {class: 'subrow', id: o.id},
    h('div', {class: 'row-text'}, h('div', {class: 'row-title', id: `${o.id}-title`, text: o.title}),
      o.desc ? h('div', {class: 'row-desc', id: `${o.id}-desc`, text: o.desc}) : null, status.el),
    h('div', {class: 'row-control'}, ...controls));
  return {el, status};
}

export const section = (title: string, ...children: Child[]) => h('div', {class: 'section'}, h('h2', {class: 'section-title', text: title}), ...children);

/** 开关：右边“开 / 关”文字 + role=switch 的复选框（Windows 11 的样子） */
export function toggle(ctx: Ctx, o: {labelledBy: string; describedBy?: string; get: (v: SettingsView) => boolean;
  change: (on: boolean) => Promise<boolean>; disabled?: (v: SettingsView) => boolean}): HTMLElement {
  const input = h('input', {type: 'checkbox', role: 'switch', 'aria-labelledby': o.labelledBy, 'aria-describedby': o.describedBy});
  const text = h('span', {class: 'toggle-text', 'aria-hidden': 'true'});
  const label = h('label', {class: 'toggle'}, text, input, h('span', {class: 'toggle-track', 'aria-hidden': 'true'}, h('span', {class: 'toggle-knob'})));
  const show = () => { text.textContent = ctx.t(input.checked ? 'common.on' : 'common.off'); };
  input.addEventListener('change', async () => {
    show(); input.disabled = true;
    const ok = await o.change(input.checked);
    input.disabled = !!o.disabled?.(ctx.view());
    if (!ok) { input.checked = !input.checked; show(); }
  });
  ctx.onSync(v => { input.checked = o.get(v); input.disabled = !!o.disabled?.(v); show(); });
  return label;
}

/** 下拉（原生 select；值一律字符串，get / change 自己换类型） */
export function select(ctx: Ctx, o: {labelledBy: string; options: (v: SettingsView) => [string, string][]; get: (v: SettingsView) => string;
  change: (value: string) => Promise<boolean>; disabled?: (v: SettingsView) => boolean; id?: string}): HTMLSelectElement {
  const el = h('select', {class: 'select', id: o.id, 'aria-labelledby': o.labelledBy});
  let last = '', key = '';
  el.addEventListener('change', async () => { const prev = last; last = el.value; if (!await o.change(el.value)) { last = prev; el.value = prev; } });
  ctx.onSync(v => {
    const opts = o.options(v), k = JSON.stringify(opts);
    if (k !== key) { key = k; el.textContent = ''; for (const [value, text] of opts) el.append(h('option', {value, text})); }
    if (document.activeElement !== el) el.value = last = o.get(v);
    el.disabled = !!o.disabled?.(v);
  });
  return el;
}

/** 滑杆 + 当前值；拖动时只更新显示（oninput 回调给预览），松手（change）才提交 */
export function slider(ctx: Ctx, o: {labelledBy: string; min: number; max: number; step: number; format: (n: number) => string;
  get: (v: SettingsView) => number; change: (n: number) => Promise<boolean>; input?: (n: number) => void; disabled?: (v: SettingsView) => boolean}): HTMLElement {
  const input = h('input', {type: 'range', class: 'slider', min: o.min, max: o.max, step: o.step, 'aria-labelledby': o.labelledBy});
  const out = h('output', {class: 'slider-value'});
  const paint = () => {
    const n = Number(input.value);
    out.textContent = o.format(n); input.setAttribute('aria-valuetext', o.format(n));
    input.style.setProperty('--fill', `${(n - o.min) / (o.max - o.min) * 100}%`);
  };
  let dragging = false, committed = 0;
  input.addEventListener('input', () => { dragging = true; paint(); o.input?.(Number(input.value)); });
  input.addEventListener('change', async () => {
    dragging = false;
    const n = Number(input.value);
    if (n !== committed && !await o.change(n)) input.value = String(committed); else committed = n;
    paint(); o.input?.(Number(input.value));
  });
  ctx.onSync(v => { if (!dragging) { committed = o.get(v); input.value = String(committed); paint(); } input.disabled = !!o.disabled?.(v); });
  return h('div', {class: 'slider-wrap'}, input, out);
}

/**
 * 数字框（带单位）：输入时就地检查（valid 返回错误文字或 null），不合法标红、不提交；失焦或回车提交。
 * empty = 允许清空（清空表示“跟随默认”，提交 null）
 */
export function numberField(ctx: Ctx, o: {labelledBy: string; min: number; max: number; step?: number; unit?: string; width?: number; placeholder?: string;
  get: (v: SettingsView) => number | null; change: (n: number | null) => Promise<boolean>; valid?: (n: number | null) => string | null;
  empty?: boolean; disabled?: (v: SettingsView) => boolean; id?: string}): {el: HTMLElement; input: HTMLInputElement; error: HTMLElement} {
  const id = o.id ?? nextId('num');
  const error = h('span', {class: 'field-error', id: `${id}-error`, role: 'alert'});
  const input = h('input', {type: 'number', class: 'number', id, min: o.min, max: o.max, step: o.step ?? 1, inputMode: 'numeric',
    placeholder: o.placeholder, 'aria-labelledby': o.labelledBy, 'aria-describedby': `${id}-error`});
  if (o.width) input.style.setProperty('width', `${o.width}px`);
  let committed: number | null = null, editing = false;
  const read = (): number | null => input.value.trim() === '' ? null : Number(input.value);
  const check = (): string | null => {
    const n = read();
    if (n === null) return o.empty ? null : ctx.t('error.required');
    if (!Number.isFinite(n) || n < o.min || n > o.max) return ctx.t('error.between', {min: o.min, max: o.max});
    if ((o.step ?? 1) >= 1 && !Number.isInteger(n)) return ctx.t('error.integer');
    return o.valid?.(n) ?? null;
  };
  const showError = (msg: string | null) => { error.textContent = msg ?? ''; input.setAttribute('aria-invalid', msg ? 'true' : 'false'); };
  input.addEventListener('input', () => { editing = true; showError(check()); });
  const commit = async () => {
    editing = false;
    const msg = check(); showError(msg);
    const n = read();
    if (msg || n === committed) return;
    if (await o.change(n)) committed = n; else { input.value = committed === null ? '' : String(committed); showError(null); }
  };
  input.addEventListener('change', () => void commit());
  input.addEventListener('keydown', e => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') { input.value = committed === null ? '' : String(committed); editing = false; showError(null); } });
  ctx.onSync(v => {
    if (!editing && document.activeElement !== input) { committed = o.get(v); input.value = committed === null ? '' : String(committed); showError(null); }
    input.disabled = !!o.disabled?.(v);
  });
  const el = h('span', {class: 'number-wrap'}, input, o.unit ? h('span', {class: 'unit', text: o.unit}) : null);
  return {el: h('span', {class: 'field'}, el, error), input, error};
}

export function button(o: {text: string; icon?: string; kind?: 'accent' | 'danger' | 'subtle' | 'standard'; onclick: () => void; id?: string;
  label?: string; describedBy?: string}): HTMLButtonElement {
  return h('button', {type: 'button', class: `btn ${o.kind ?? 'standard'}`, id: o.id, onclick: o.onclick, 'aria-label': o.label, 'aria-describedby': o.describedBy},
    o.icon ? icon(o.icon) : null, h('span', {text: o.text}));
}

/** 分段选择（单选按钮组，键盘左右键切换） */
export function segmented(o: {label: string; options: [string, string][]; value: string; change: (v: string) => void; name?: string}): {el: HTMLElement; set(v: string): void} {
  const name = o.name ?? nextId('seg');
  const inputs: HTMLInputElement[] = [];
  const el = h('div', {class: 'segmented', role: 'radiogroup', 'aria-label': o.label},
    ...o.options.map(([value, text]) => {
      const input = h('input', {type: 'radio', name, value, checked: value === o.value});
      input.addEventListener('change', () => { if (input.checked) o.change(value); });
      inputs.push(input);
      return h('label', {class: 'segment'}, input, h('span', {text}));
    }));
  return {el, set: v => { for (const i of inputs) i.checked = i.value === v; }};
}

/** 提示条（Windows 11 InfoBar）：info / warning / error / success */
export function infobar(kind: 'info' | 'warning' | 'error' | 'success', title: string, message = '', action?: HTMLElement): HTMLElement {
  const glyph = {info: ICON.info, warning: ICON.warning, error: ICON.error, success: ICON.success}[kind];
  return h('div', {class: `infobar ${kind}`, role: kind === 'error' || kind === 'warning' ? 'alert' : 'status'},
    icon(glyph, 'infobar-icon'), h('div', {class: 'infobar-text'}, h('strong', {text: title}), message ? h('span', {text: message}) : null),
    action ?? null);
}

export function chip(text: string, kind: 'neutral' | 'accent' | 'success' | 'warning' | 'error' = 'neutral'): HTMLElement {
  return h('span', {class: `chip ${kind}`, text});
}

/**
 * 热键录制：点按钮后按下新的组合键（要带 Ctrl / Alt / Shift / Win 之一，F1–F24 可以单独用）；Esc 取消。
 * 写成 Electron 的快捷键写法（Control+Alt+H），显示时换成 Ctrl + Alt + H
 */
export function hotkeyField(ctx: Ctx, o: {labelledBy: string; get: (v: SettingsView) => string; change: (acc: string) => Promise<boolean>}): HTMLElement {
  // 名字 = 行标题 + 现在的组合键（看得见的字要在名字里，WCAG 2.5.3）
  const keysId = nextId('keys');
  const btn = h('button', {type: 'button', class: 'btn standard hotkey', 'aria-labelledby': `${o.labelledBy} ${keysId}`});
  const keys = h('span', {class: 'keys', id: keysId});
  btn.append(icon(ICON.keyboard), keys);
  let recording = false, current = '';
  const render = (acc: string) => {
    keys.textContent = '';
    if (recording) { keys.append(h('span', {class: 'recording', text: ctx.t('hotkey.press')})); return; }
    for (const part of pretty(acc)) keys.append(h('kbd', {text: part}));
  };
  const stop = () => { recording = false; btn.classList.remove('is-recording'); btn.setAttribute('aria-pressed', 'false'); render(current); };
  btn.addEventListener('click', () => {
    recording = !recording;
    btn.classList.toggle('is-recording', recording); btn.setAttribute('aria-pressed', String(recording));
    render(current);
  });
  btn.addEventListener('blur', () => { if (recording) stop(); });
  btn.addEventListener('keydown', async e => {
    if (!recording) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stop(); return; }
    const acc = acceleratorOf(e);
    if (!acc) return;   // 只按了修饰键
    stop();
    if (acc !== current && await o.change(acc)) { current = acc; render(current); }
  });
  ctx.onSync(v => { if (!recording) { current = o.get(v); render(current); } });
  return btn;
}
const KEY_NAMES: Record<string, string> = {' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus'};
/** 键盘事件 → Electron 快捷键写法；不合规（没有修饰键、只按了修饰键）返回 null */
export function acceleratorOf(e: KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key)) return null;
  const code = e.code;
  let key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^F\d{1,2}$/.test(e.key) ? e.key : KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (['Tab', 'Enter', 'Escape', 'CapsLock'].includes(key)) return null;
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[];
  if (!mods.length && !/^F\d{1,2}$/.test(key)) return null;
  if (key.length === 1) key = key.toUpperCase();
  return [...mods, key].join('+');
}
export const pretty = (acc: string) => acc.split('+').map(p => ({Control: 'Ctrl', CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Super: 'Win', Meta: 'Win'} as Record<string, string>)[p] ?? p);

/**
 * 程序名单（exe 文件名）：每条一行带“移除”，下面输入框 + 添加，可选“添加刚才在前台的 X”。
 * 移除给撤销（提示气泡）；添加前就地检查格式、重复
 */
export function appList(ctx: Ctx, o: {id: string; get: (v: SettingsView) => string[]; change: (list: string[]) => Promise<boolean>;
  lastApp?: (v: SettingsView) => string; emptyText: string}): HTMLElement {
  const list = h('ul', {class: 'app-list', 'aria-labelledby': `${o.id}-title`});
  const input = h('input', {type: 'text', class: 'text', id: `${o.id}-input`, placeholder: ctx.t('apps.placeholder'), spellcheck: false,
    'aria-label': ctx.t('apps.inputLabel'), 'aria-describedby': `${o.id}-error`});
  const error = h('span', {class: 'field-error', id: `${o.id}-error`, role: 'alert'});
  const addLast = button({text: '', icon: ICON.add, onclick: () => void add((o.lastApp?.(ctx.view())) ?? '')});
  let items: string[] = [];
  const has = (exe: string) => items.some(x => x.toLowerCase() === exe.toLowerCase());
  async function add(raw: string): Promise<void> {
    const exe = raw.trim();
    if (!/^[^\\/:*?"<>|]{1,250}\.exe$/i.test(exe)) { error.textContent = ctx.t('error.exe'); input.setAttribute('aria-invalid', 'true'); return; }
    if (has(exe)) { error.textContent = ctx.t('error.duplicate'); input.setAttribute('aria-invalid', 'true'); return; }
    error.textContent = ''; input.setAttribute('aria-invalid', 'false');
    if (await o.change([...items, exe])) { input.value = ''; ctx.toast(ctx.t('apps.added', {exe})); }
  }
  async function remove(exe: string): Promise<void> {
    const before = items;
    if (await o.change(items.filter(x => x !== exe))) ctx.toast(ctx.t('apps.removed', {exe}), () => void o.change(before));
  }
  input.addEventListener('input', () => { error.textContent = ''; input.setAttribute('aria-invalid', 'false'); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') void add(input.value); });
  ctx.onSync(v => {
    items = o.get(v);
    list.textContent = '';
    if (!items.length) list.append(h('li', {class: 'app-empty', text: o.emptyText}));
    for (const exe of items) list.append(h('li', {class: 'app-item'}, icon(ICON.app), h('span', {class: 'app-name', text: exe}),
      button({text: ctx.t('common.remove'), kind: 'subtle', icon: ICON.remove, label: ctx.t('apps.removeLabel', {exe}), onclick: () => void remove(exe)})));
    const last = o.lastApp?.(v) ?? '';
    addLast.hidden = !o.lastApp;
    (addLast.lastChild as HTMLElement).textContent = last ? ctx.t('apps.addLast', {exe: last}) : ctx.t('apps.addLastNone');
    addLast.disabled = !last || has(last);
  });
  return h('div', {class: 'app-editor'}, list,
    h('div', {class: 'app-add'}, h('span', {class: 'field'}, input, error), button({text: ctx.t('common.add'), icon: ICON.add, onclick: () => void add(input.value)})),
    addLast);
}
