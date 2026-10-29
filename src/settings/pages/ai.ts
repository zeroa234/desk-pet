// AI 对话、看屏幕、用量三页（以前在“LLM 统计与提示词”面板里，规则不变，见 src/main/llm-settings.ts）。
import type {Key} from '../../shared/i18n.ts';
import type {Msg} from '../../shared/msg.ts';
import {MAX_TURNS, turnsValid} from '../../llm/turns.ts';
import type {UsageSummary} from '../../llm/usage.ts';
import type {CharacterVision} from '../../vision/types.ts';
import type {LlmCharacterView, SettingsView, UsageView} from '../protocol.ts';
import {ICON, appList, button, chip, expander, h, icon, infobar, numberField, row, section, segmented, select, statusEl, subrow, type Ctx} from '../ui.ts';
import {selectRow, settingToggle, texts, toggleRow} from './common.ts';

type Mode = 'adult' | 'sfw';
const MODES: Mode[] = ['adult', 'sfw'];

/** 运行时消息里的请求类型、结果是原始 id（decision、ok……），显示前换成词条 */
export function statusText(ctx: Ctx, m: Msg): string {
  const p = {...m.params};
  if (typeof p.kind === 'string' && ctx.tr.has(`usage.kind.${p.kind}`)) p.kind = ctx.t(`usage.kind.${p.kind}` as Key);
  if (typeof p.result === 'string' && ctx.tr.has(`usage.result.${p.result}`)) p.result = ctx.t(`usage.result.${p.result}` as Key);
  return ctx.tr.has(m.key) ? ctx.tr.m({key: m.key, params: p}) : m.key;
}

function liveBar(ctx: Ctx, make: (v: SettingsView) => HTMLElement | null): HTMLElement {
  const box = h('div', {class: 'live-bar'});
  let key = '';
  ctx.onSync(v => { const el = make(v), k = el?.textContent ?? ''; if (k !== key) { key = k; box.replaceChildren(...(el ? [el] : [])); } });
  return box;
}

const unavailable = (ctx: Ctx) => [infobar('error', ctx.t('ai.unavailable.title'), ctx.t('ai.unavailable.desc'))];
const charOf = (v: SettingsView, id: string) => v.llm?.characters.find(c => c.id === id);

/** 没保存的提示词草稿：语言切换、角色变化时页面会重建，草稿留在这里（键 = 目标:模式） */
const drafts = new Map<string, string>();
export const promptDirty = () => drafts.size > 0;

export function aiPage(ctx: Ctx): HTMLElement[] {
  const t = ctx.t, v0 = ctx.view();
  if (!v0.llm) return unavailable(ctx);
  const enabled = settingToggle(ctx, 'llmEnabled', {id: 'llmEnabled', icon: ICON.ai, ...texts(ctx, 'ai.enabled')});
  const state = liveBar(ctx, v => v.llm!.limit ? infobar('warning', t('ai.limitTitle'), statusText(ctx, v.llm!.limit))
    : h('p', {class: 'section-desc', role: 'status'}, `${t('ai.latest')} `, statusText(ctx, v.llm!.latest)));
  const def = (x: string) => t('common.withDefault', {x});
  const hourly = selectRow(ctx, {id: 'hourly', icon: ICON.limit, ...texts(ctx, 'ai.hourly'),
    options: () => [['200', def('200')], ['500', '500'], ['1000', '1000'], ['', t('ai.hourly.unlimited')]],
    get: v => v.llm!.hourly === null ? '' : String(v.llm!.hourly),
    change: async (val, st) => (await ctx.act({type: 'llm.hourly', n: val === '' ? null : Number(val)}, st)).ok});
  const control = selectRow(ctx, {id: 'llmControlSec', icon: ICON.timer, ...texts(ctx, 'ai.control'),
    options: () => [['0', t('ai.control.off')], ...[15, 30, 60, 120].map(n => [String(n), n === 30 ? def(t('unit.secValue', {n})) : t('unit.secValue', {n})] as [string, string])],
    get: v => String(v.settings.llmControlSec), change: (val, st) => ctx.set({llmControlSec: Number(val)}, st)});
  const chars = v0.llm.characters.map(c => characterExpander(ctx, c));
  return [section(t('ai.section.main'), enabled, state, hourly, control), section(t('ai.section.characters'), h('p', {class: 'section-desc', text: t('ai.section.charactersDesc')}), ...chars),
    section(t('ai.section.prompt'), promptEditor(ctx))];
}

function characterExpander(ctx: Ctx, c0: LlmCharacterView): HTMLElement {
  const t = ctx.t, id = `ai-${c0.id}`, cur = () => charOf(ctx.view(), c0.id)!;
  const providerName = (v: SettingsView, p: string | null) => p ? `${p} · ${v.llm!.providers.find(x => x.id === p)?.model ?? ''}` : t('ai.char.modelDefault');
  // 文本模型
  const model = subrow({id: `${id}-model`, title: t('ai.char.model'), desc: t('ai.char.modelDesc'), control: []});
  model.el.querySelector('.row-control')!.append(select(ctx, {labelledBy: `${id}-model-title`,
    options: v => [['', t('ai.char.modelDefault')], ...v.llm!.providers.map(p => [p.id, `${p.id} · ${p.model}`] as [string, string])],
    get: v => charOf(v, c0.id)?.provider ?? '', change: async val => (await ctx.act({type: 'llm.character', id: c0.id, patch: {text: val || null}}, model.status)).ok}));
  // 会话长度：三个数互相约束（丢的轮数 < 上限，决策带的轮数 ≤ 上限），输入时就地提示
  const turns = subrow({id: `${id}-turns`, title: t('ai.turns.title'), desc: t('ai.turns.desc'), control: []});
  const fields: {max?: HTMLInputElement; drop?: HTMLInputElement; decide?: HTMLInputElement} = {};
  const values = () => ({maxTurns: Number(fields.max!.value), dropTurns: Number(fields.drop!.value), decisionTurns: Number(fields.decide!.value)});
  const crossError = (): string | null => {
    const v = values();
    if (turnsValid(v)) return null;
    return v.dropTurns >= v.maxTurns ? t('ai.turns.errDrop') : v.decisionTurns > v.maxTurns ? t('ai.turns.errDecision') : null;
  };
  const commit = async (): Promise<boolean> => {
    if (crossError()) return false;
    return (await ctx.act({type: 'llm.character', id: c0.id, patch: values()}, turns.status)).ok;
  };
  const field = (key: 'maxTurns' | 'dropTurns' | 'decisionTurns', min: number, label: string) => {
    const f = numberField(ctx, {labelledBy: `${id}-${key}-label`, min, max: MAX_TURNS, width: 72, get: v => charOf(v, c0.id)?.[key] ?? 0,
      valid: () => crossError(), change: () => commit()});
    return {f, el: h('label', {class: 'turn-field'}, h('span', {class: 'inline-label', id: `${id}-${key}-label`, text: label}), f.el)};
  };
  const max = field('maxTurns', 2, t('ai.turns.max')), drop = field('dropTurns', 1, t('ai.turns.drop')), decide = field('decisionTurns', 0, t('ai.turns.decision'));
  fields.max = max.f.input; fields.drop = drop.f.input; fields.decide = decide.f.input;
  const resetTurns = button({text: t('common.useDefault'), kind: 'subtle', icon: ICON.undo, onclick: async () => {
    await ctx.act({type: 'llm.character', id: c0.id, patch: {maxTurns: null, dropTurns: null, decisionTurns: null}}, turns.status); }});
  ctx.onSync(v => { resetTurns.hidden = !charOf(v, c0.id)?.customTurns; });
  turns.el.querySelector('.row-control')!.append(h('div', {class: 'turn-fields'}, max.el, drop.el, decide.el, resetTurns));
  // 记忆：明确选看哪个模式的（以前跟着页面顶上的下拉悄悄变）
  let mode: Mode = v0Mode(ctx);
  const memMode = segmented({label: t('ai.memory.modeLabel'), options: MODES.map(m => [m, t(`mode.${m}`)] as [string, string]),
    value: mode, change: m => { mode = m as Mode; paintMemory(); }});
  const counts = h('span', {class: 'row-desc'});
  const summary = h('div', {class: 'memory-summary', tabindex: 0});
  const forget = button({text: t('ai.memory.clear'), kind: 'danger', icon: ICON.delete, onclick: async () => {
    const c = cur();
    if (await ctx.confirm({title: t('ai.memory.clearTitle', {name: c.name, mode: t(`mode.${mode}`)}), body: t('ai.memory.clearBody'), confirm: t('ai.memory.clearConfirm'), danger: true}))
      if ((await ctx.act({type: 'llm.forget', id: c0.id, mode}, mem.status)).ok) mem.status.ok(t('ai.memory.cleared'));
  }});
  const mem = subrow({id: `${id}-memory`, title: t('ai.memory.title'), desc: t('ai.memory.desc'), control: [memMode.el]});
  function paintMemory(): void {
    const m = cur().memory[mode];
    counts.textContent = t('ai.memory.counts', {active: m.active, archived: m.archived});
    summary.textContent = m.summary || t('ai.memory.noSummary');
    summary.classList.toggle('is-empty', !m.summary);
    forget.disabled = !m.active && !m.archived && !m.summary;
  }
  ctx.onSync(() => paintMemory());
  mem.el.append(h('div', {class: 'memory-body'}, counts, h('details', {class: 'memory-details'}, h('summary', {text: t('ai.memory.summaryTitle')}), summary), h('div', {class: 'danger-zone'}, forget)));
  return expander(ctx, {id, icon: ICON.model, title: c0.name, keywords: `${t('ai.char.model')} ${t('ai.turns.title')} ${t('ai.memory.title')}`,
    summary: () => { const v = ctx.view(), c = charOf(v, c0.id)!; return t('ai.char.summary', {model: providerName(v, c.provider), max: c.maxTurns}); }},
    model.el, turns.el, mem.el);
}
const v0Mode = (ctx: Ctx): Mode => ctx.view().settings.r18 ? 'adult' : 'sfw';

/** 提示词编辑：要显式保存（长文本）；没保存时有标记，Ctrl+S 保存，换目标前、关窗口前问一句 */
function promptEditor(ctx: Ctx): HTMLElement {
  const t = ctx.t, v0 = ctx.view(), llm = v0.llm!;
  const status = statusEl();
  const target = h('select', {class: 'select', id: 'prompt-target', 'aria-labelledby': 'prompt-target-label'},
    h('option', {value: llm.shared, text: t('ai.prompt.shared')}), ...llm.characters.map(c => h('option', {value: c.id, text: c.name})));
  let mode: Mode = v0Mode(ctx), key = '';
  const modeSeg = segmented({label: t('ai.prompt.modeLabel'), options: MODES.map(m => [m, t(`mode.${m}`)] as [string, string]), value: mode, change: () => {}});
  const area = h('textarea', {class: 'textarea', id: 'prompt-text', rows: 14, maxLength: llm.promptMax, spellcheck: false,
    'aria-labelledby': 'prompt-title', 'aria-describedby': 'prompt-count prompt-help-text'});
  const count = h('span', {class: 'row-desc', id: 'prompt-count', 'aria-live': 'off'});
  const dirtyChip = chip(t('common.unsaved'), 'warning');
  const save = button({text: t('common.save'), icon: ICON.save, kind: 'accent', onclick: () => void doSave()});
  const discard = button({text: t('common.discard'), onclick: () => { drafts.delete(key); load(); }});
  const saved = () => ctx.view().llm!.prompts[target.value]?.[mode] ?? '';
  const paint = () => {
    const dirty = drafts.has(key);
    count.textContent = t('ai.prompt.count', {n: area.value.length, max: llm.promptMax});
    dirtyChip.hidden = !dirty; save.disabled = !dirty; discard.disabled = !dirty;
  };
  function load(): void { key = `${target.value}:${mode}`; area.value = drafts.get(key) ?? saved(); paint(); }
  async function doSave(): Promise<void> {
    const text = area.value;
    if ((await ctx.act({type: 'llm.prompt', id: target.value, mode, text}, status)).ok) { drafts.delete(key); status.ok(t('ai.prompt.saved')); paint(); }
  }
  async function leave(): Promise<boolean> {
    return !drafts.has(key) || ctx.confirm({title: t('common.discardTitle'), body: t('ai.prompt.discardBody'), confirm: t('common.discard')}).then(ok => { if (ok) drafts.delete(key); return ok; });
  }
  area.addEventListener('input', () => { if (area.value === saved()) drafts.delete(key); else drafts.set(key, area.value); paint(); });
  area.addEventListener('keydown', e => { if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (drafts.has(key)) void doSave(); } });
  let prevTarget = target.value;
  target.addEventListener('change', async () => { const next = target.value; target.value = prevTarget; if (await leave()) { target.value = prevTarget = next; load(); } });
  modeSeg.el.addEventListener('change', async e => {
    const next = (e.target as HTMLInputElement).value as Mode;
    if (await leave()) { mode = next; load(); } else modeSeg.set(mode);
  });
  ctx.onSync(() => { if (!drafts.has(key)) { area.value = saved(); } paint(); });
  load();
  const help = h('details', {class: 'help'}, h('summary', {text: t('ai.prompt.helpTitle')}), h('p', {id: 'prompt-help-text', text: t('ai.prompt.help')}));
  const card = h('section', {class: 'card prompt-card', id: 'prompt', 'aria-labelledby': 'prompt-title'},
    h('div', {class: 'row-main'}, icon(ICON.prompt, 'row-icon'),
      h('div', {class: 'row-text'}, h('div', {class: 'row-title', id: 'prompt-title'}, t('ai.prompt.title'), ' ', dirtyChip),
        h('div', {class: 'row-desc', text: t('ai.prompt.desc')}), status.el)),
    h('div', {class: 'prompt-bar'}, h('label', {class: 'inline-label', id: 'prompt-target-label', for: 'prompt-target', text: t('ai.prompt.target')}), target, modeSeg.el),
    area, h('div', {class: 'prompt-foot'}, count, h('span', {class: 'grow'}), discard, save), help);
  ctx.register({page: ctx.page, el: card, title: t('ai.prompt.title'), text: `${t('ai.prompt.title')} ${t('ai.prompt.desc')} ${t('ai.prompt.keywords')}`, focus: () => area.focus()});
  return card;
}

export function visionPage(ctx: Ctx): HTMLElement[] {
  const t = ctx.t, v0 = ctx.view();
  if (!v0.llm) return unavailable(ctx);
  const privacy = infobar('info', t('vision.privacy.title'), t('vision.privacy.desc'));
  const vis = (v: SettingsView) => v.llm!.vision;
  const setVision = async (patch: Record<string, unknown>, st?: ReturnType<typeof statusEl>) => (await ctx.act({type: 'llm.vision', patch}, st)).ok;
  const enabled = toggleRow(ctx, {id: 'vision-enabled', icon: ICON.eye, ...texts(ctx, 'vision.enabled'), get: v => vis(v).enabled, change: (on, st) => setVision({enabled: on}, st)});
  const auto = toggleRow(ctx, {id: 'vision-auto', icon: ICON.refresh, ...texts(ctx, 'vision.auto'), get: v => vis(v).auto, change: (on, st) => setVision({auto: on}, st),
    disabled: v => !vis(v).enabled});
  const interval = row(ctx, {id: 'vision-interval', icon: ICON.away, ...texts(ctx, 'vision.interval'), control: []});
  interval.el.querySelector('.row-control')!.append(numberField(ctx, {labelledBy: 'vision-interval-title', min: 5, max: 86400, unit: t('unit.sec'), width: 96,
    get: v => vis(v).intervalSec, change: n => setVision({intervalSec: n}, interval.status)}).el);
  const stagger = row(ctx, {id: 'vision-stagger', icon: ICON.people, ...texts(ctx, 'vision.stagger'), control: []});
  stagger.el.querySelector('.row-control')!.append(numberField(ctx, {labelledBy: 'vision-stagger-title', min: 0, max: 3600, unit: t('unit.sec'), width: 96,
    get: v => vis(v).staggerSec, change: n => setVision({staggerSec: n}, stagger.status)}).el);
  const blacklist = expander(ctx, {id: 'vision-blacklist', icon: ICON.shield, ...texts(ctx, 'vision.blacklist'),
    summary: () => { const n = vis(ctx.view()).blacklist.length; return n ? t('vision.blacklist.count', {n}) : t('vision.blacklist.desc'); }},
    appList(ctx, {id: 'vision-blacklist', get: v => vis(v).blacklist, change: list => setVision({blacklist: list}), lastApp: v => v.state.lastApp, emptyText: t('vision.blacklist.empty')}));
  const latest = liveBar(ctx, v => h('p', {class: 'section-desc', role: 'status', text: t('vision.latest', {status: statusText(ctx, v.llm!.visionLatest)})}));
  const providers = v0.llm.providers.map(p => toggleRow(ctx, {id: `vision-provider-${p.id}`, icon: ICON.image, title: `${p.id} · ${p.model}`, desc: t('vision.provider.desc'),
    get: v => v.llm!.providers.find(x => x.id === p.id)?.images ?? false,
    change: async (on, st) => (await ctx.act({type: 'llm.providerImages', id: p.id, images: on}, st)).ok}));
  const chars = v0.llm.characters.map(c => {
    const id = `vision-char-${c.id}`;
    const r = row(ctx, {id, icon: ICON.eye, title: c.name, desc: '', control: []});
    const save = async (patch: CharacterVision) => (await ctx.act({type: 'llm.character', id: c.id, patch: {vision: patch}}, r.status)).ok;
    const autoSel = select(ctx, {labelledBy: `${id}-auto-label ${id}-title`, options: () => [['', t('vision.char.inherit')], ['true', t('common.on')], ['false', t('common.off')]],
      get: v => { const a = charOf(v, c.id)?.vision.auto; return a === undefined ? '' : String(a); },
      change: val => { const cur = charOf(ctx.view(), c.id)!.vision; const next: CharacterVision = {...cur}; if (val) next.auto = val === 'true'; else delete next.auto; return save(next); }});
    const iv = numberField(ctx, {labelledBy: `${id}-interval-label ${id}-title`, min: 5, max: 86400, empty: true, placeholder: t('vision.char.inheritShort'), unit: t('unit.sec'), width: 96,
      get: v => charOf(v, c.id)?.vision.intervalSec ?? null,
      change: n => { const next: CharacterVision = {...charOf(ctx.view(), c.id)!.vision}; if (n === null) delete next.intervalSec; else next.intervalSec = n; return save(next); }});
    const look = button({text: t('vision.char.look'), icon: ICON.eye, onclick: async () => {
      if ((await ctx.act({type: 'llm.look', id: c.id}, r.status)).ok) r.status.ok(t('vision.char.lookSent')); }});
    r.el.querySelector('.row-control')!.append(
      h('label', {class: 'turn-field'}, h('span', {class: 'inline-label', id: `${id}-auto-label`, text: t('vision.char.auto')}), autoSel),
      h('label', {class: 'turn-field'}, h('span', {class: 'inline-label', id: `${id}-interval-label`, text: t('vision.char.interval')}), iv.el), look);
    ctx.onSync(v => {
      const x = charOf(v, c.id);
      if (!x) return;
      r.desc.hidden = false;
      r.desc.textContent = t(`vision.image.${x.imageStatus}` as Key);
      look.disabled = !x.canLook;
      look.title = x.canLook ? '' : t('vision.char.lookUnavailable');
    });
    return r.el;
  });
  return [privacy, section(t('vision.section.main'), enabled, auto, interval.el, stagger.el, blacklist, latest),
    section(t('vision.section.providers'), h('p', {class: 'section-desc', text: t('vision.section.providersDesc')}), ...providers),
    section(t('vision.section.characters'), h('p', {class: 'section-desc', text: t('vision.section.charactersDesc')}), ...chars)];
}

export function usagePage(ctx: Ctx): HTMLElement[] {
  const t = ctx.t, v0 = ctx.view();
  if (!v0.llm) return unavailable(ctx);
  const tiles = h('div', {class: 'tiles'});
  const tables = h('div', {class: 'usage-tables'});
  const updated = h('span', {class: 'row-desc', role: 'status'});
  const refresh = button({text: t('usage.refresh'), icon: ICON.refresh, onclick: () => void load()});
  const nf = new Intl.NumberFormat(ctx.tr.lang), money = (n: number) => `$${n.toFixed(4)}`;
  const ms = (n: number | null) => n === null ? '—' : t('unit.msValue', {n: Math.round(n)});
  const pct = (n: number | null) => n === null ? '—' : `${(n * 100).toFixed(1)}%`;
  const nameOf = (id: string) => ctx.view().characters.find(c => c.id === id)?.name ?? id;
  const kindOf = (k: string) => ctx.tr.has(`usage.kind.${k}`) ? t(`usage.kind.${k}` as Key) : k;
  const resultOf = (r: string) => ctx.tr.has(`usage.result.${r}`) ? t(`usage.result.${r}` as Key) : r;
  const tile = (label: string, value: string, note = '') => h('div', {class: 'tile'}, h('div', {class: 'tile-label', text: label}), h('div', {class: 'tile-value', text: value}),
    note ? h('div', {class: 'tile-note', text: note}) : null);
  const table = (caption: string, head: string[], rows: string[][], numeric: number[]) => h('div', {class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': caption},
    h('table', {class: 'table'}, h('caption', {text: caption}),
      h('thead', {}, h('tr', {}, ...head.map((x, i) => h('th', {scope: 'col', class: numeric.includes(i) ? 'num' : '', text: x})))),
      h('tbody', {}, ...(rows.length ? rows.map(r => h('tr', {}, ...r.map((x, i) => h(i === 0 ? 'th' : 'td', {scope: i === 0 ? 'row' : undefined, class: numeric.includes(i) ? 'num' : '', text: x}))))
        : [h('tr', {}, h('td', {colSpan: head.length, class: 'empty', text: t('usage.empty')}))]))));
  const sumRow = (label: string, s: UsageSummary) => [label, nf.format(s.total), nf.format(s.prompt), nf.format(s.completion), pct(s.cacheRate), money(s.costUsd), ms(s.p50)];
  const sumHead = () => [t('usage.col.name'), t('usage.col.calls'), t('usage.col.input'), t('usage.col.output'), t('usage.col.cache'), t('usage.col.cost'), t('usage.col.p50')];
  async function load(): Promise<void> {
    const r = await ctx.act<UsageView>({type: 'llm.usage'});
    if (!r.ok || !r.value) return;
    const u = r.value, s = u.summary, failed = Object.values(s.failures).reduce((a, b) => a + b, 0);
    tiles.replaceChildren(
      tile(t('usage.tile.calls'), nf.format(s.total), failed ? t('usage.tile.failed', {n: failed}) : ''),
      tile(t('usage.tile.cost'), money(s.costUsd), s.unknownCost ? t('usage.tile.unknownCost', {n: s.unknownCost}) : ''),
      tile(t('usage.tile.cache'), pct(s.cacheRate)),
      tile(t('usage.tile.tokens'), `${nf.format(s.prompt)} / ${nf.format(s.completion)}`, t('usage.tile.tokensNote')),
      tile(t('usage.tile.latency'), `${ms(s.p50)} / ${ms(s.p95)}`, t('usage.tile.latencyNote')));
    const time = (at: number) => new Date(at).toLocaleTimeString(ctx.tr.lang, {hour12: false});
    tables.replaceChildren(
      table(t('usage.byCharacter'), sumHead(), Object.entries(u.byCharacter).map(([id, x]) => sumRow(nameOf(id), x)), [1, 2, 3, 4, 5, 6]),
      table(t('usage.byKind'), sumHead(), Object.entries(u.byKind).map(([k, x]) => sumRow(kindOf(k), x)), [1, 2, 3, 4, 5, 6]),
      table(t('usage.recent'), [t('usage.col.time'), t('usage.col.character'), t('usage.col.kind'), t('usage.col.result'), t('usage.col.latency'), t('usage.col.tokens'), t('usage.col.cost')],
        u.recent.map(x => [time(x.at), nameOf(x.character), kindOf(x.kind), resultOf(x.result), ms(x.latencyMs),
          x.usage ? `${nf.format(x.usage.prompt)} / ${nf.format(x.usage.completion)}` : '—', x.costUsd === null ? t('usage.unknown') : money(x.costUsd)]), [4, 5, 6]));
    updated.textContent = t('usage.updated', {time: time(Date.now())});
  }
  ctx.onShow(shown => { if (shown) void load(); });
  return [h('div', {class: 'toolbar'}, refresh, updated), section(t('usage.section.summary'), tiles), tables];
}
