// 通用、角色、外观、行为、声音、免打扰与隐私六页。
import type {LangSetting} from '../../shared/i18n.ts';
import type {SettingsView} from '../protocol.ts';
import {SpritePreview} from '../sprite-preview.ts';
import {voiceEditor} from '../voice-editor.ts';
import {ICON, appList, button, chip, expander, h, hotkeyField, icon, infobar, row, section, statusEl, toggle, type Ctx} from '../ui.ts';
import {selectRow, settingToggle, sliderRow, texts, toggleRow} from './common.ts';

/** 语言名用它自己的文字写（不随界面语言变），方便看不懂当前语言的人找到自己的 */
const LANG_NAMES = {'zh-CN': '中文（简体）', en: 'English'} as const;

/** 跟着快照显示 / 隐藏的提示条 */
function liveBar(ctx: Ctx, make: (v: SettingsView) => HTMLElement | null): HTMLElement {
  const box = h('div', {class: 'live-bar'});
  let key = '';
  ctx.onSync(v => { const el = make(v), k = el?.textContent ?? ''; if (k !== key) { key = k; box.replaceChildren(...(el ? [el] : [])); } });
  return box;
}

export function generalPage(ctx: Ctx): HTMLElement[] {
  const t = ctx.t;
  const fullscreen = liveBar(ctx, v => v.state.hiddenByFullscreen
    ? infobar('info', t('general.fullscreenHidden.title'), t('general.fullscreenHidden.desc'), button({text: t('general.fullscreenHidden.action'), kind: 'subtle', onclick: () => location.hash = 'quiet'}))
    : null);
  const lang = selectRow(ctx, {id: 'language', icon: ICON.globe, ...texts(ctx, 'general.language'),
    options: v => [['system', t('general.language.system', {lang: LANG_NAMES[v.systemLang]})], ['zh-CN', LANG_NAMES['zh-CN']], ['en', LANG_NAMES.en]],
    get: v => v.settings.language, change: (val, st) => ctx.set({language: val as LangSetting}, st)});
  const pause = settingToggle(ctx, 'paused', {id: 'paused', icon: ICON.pause, ...texts(ctx, 'general.paused')});
  const hide = toggleRow(ctx, {id: 'hidden', icon: ICON.hide, ...texts(ctx, 'general.hidden'), get: v => v.state.hidden,
    change: async (on, st) => (await ctx.act({type: 'hide', on}, st)).ok});
  const autostart = toggleRow(ctx, {id: 'autostart', icon: ICON.power, ...texts(ctx, 'general.autostart'), get: v => v.state.autostart,
    change: async (on, st) => (await ctx.act({type: 'autostart', on}, st)).ok});
  const boss = row(ctx, {id: 'bossKey', icon: ICON.keyboard, ...texts(ctx, 'general.bossKey'),
    control: hotkeyField(ctx, {labelledBy: 'bossKey-title', get: v => v.settings.bossKey, change: acc => ctx.set({bossKey: acc}, boss.status)})});
  ctx.onSync(v => { if (!v.state.bossKeyOk) boss.status.error(t('general.bossKey.taken')); });
  return [fullscreen, section(t('general.section.basic'), lang, pause, hide, boss.el), section(t('general.section.startup'), autostart)];
}

export function charactersPage(ctx: Ctx): HTMLElement[] {
  const t = ctx.t, v0 = ctx.view();
  const max = selectRow(ctx, {id: 'maxOnDesktop', icon: ICON.people, ...texts(ctx, 'chars.max'),
    options: () => [['', t('chars.max.unlimited')], ...[1, 2, 3, 4, 8].map(n => [String(n), t('chars.max.n', {n})] as [string, string])],
    get: v => v.settings.maxOnDesktop === null ? '' : String(v.settings.maxOnDesktop),
    change: (val, st) => ctx.set({maxOnDesktop: val === '' ? null : Number(val)}, st)});
  const previews: SpritePreview[] = [];
  const cards = v0.characters.map(c => {
    const variant = (v: SettingsView) => { const want = v.settings.variant ?? c.defaultVariant; return c.variants.includes(want) ? want : c.defaultVariant; };
    const vinfo = (v: SettingsView) => v.variants.find(x => x.id === variant(v))!;
    const preview = new SpritePreview({dir: c.dir, variant: variant(v0), renderHeight: vinfo(v0).renderHeight, smooth: vinfo(v0).style === 'smooth', height: 96,
      label: t('chars.previewLabel', {name: c.name})});
    previews.push(preview);
    const status = h('span', {class: 'char-chip'});
    const desc = h('div', {class: 'row-desc', id: `char-${c.id}-desc`});
    const id = `char-${c.id}`;
    const desk = toggle(ctx, {labelledBy: `${id}-desk ${id}-title`, describedBy: `${id}-desc`, get: v => v.characters.find(x => x.id === c.id)?.wanted ?? false,
      disabled: v => !v.characters.find(x => x.id === c.id)?.unlocked, change: async on => (await ctx.act({type: 'desktop', id: c.id, on})).ok});
    const summon = button({text: t('chars.summon'), icon: ICON.summon, describedBy: `${id}-summon-hint`, onclick: async () => { await ctx.act({type: 'summon', id: c.id}); }});
    ctx.onSync(v => {
      const x = v.characters.find(y => y.id === c.id);
      if (!x) return;
      // 在不在桌面上开关已经说了；只有开关看不出来的（没解锁、排队）才加标签
      status.replaceChildren(...(!x.unlocked ? [chip(t('chars.status.locked'))] : x.waiting ? [chip(t('chars.status.waiting'), 'warning')] : []));
      desc.textContent = !x.unlocked ? t('chars.desc.locked') : x.waiting ? t('chars.desc.waiting') : '';
      desc.hidden = !desc.textContent;
      summon.disabled = !x.unlocked || !x.canSummon;
      preview.update({variant: variant(v), renderHeight: vinfo(v).renderHeight, smooth: vinfo(v).style === 'smooth'});
    });
    const el = h('section', {class: 'card char-card', id, 'aria-labelledby': `${id}-title`},
      h('div', {class: 'char-preview'}, preview.canvas),
      h('div', {class: 'char-info'}, h('div', {class: 'char-name'}, h('span', {class: 'row-title', id: `${id}-title`, text: c.name}), status), desc,
        h('span', {class: 'visually-hidden', id: `${id}-summon-hint`, text: t('chars.summonHint')})),
      h('div', {class: 'char-actions'}, h('div', {class: 'labeled-toggle'}, h('span', {class: 'inline-label', id: `${id}-desk`, text: t('chars.onDesktop')}), desk), summon));
    ctx.register({page: ctx.page, el, title: c.name, text: `${c.name} ${t('chars.onDesktop')} ${t('chars.summon')}`, focus: () => (el.querySelector('input') as HTMLElement).focus()});
    return el;
  });
  ctx.onShow(shown => { for (const p of previews) if (shown) p.start(); else p.stop(); });
  return [section(t('chars.section.desktop'), max), section(t('chars.section.list'), h('p', {class: 'section-desc', text: t('chars.summonHint')}), ...cards)];
}

export function appearancePage(ctx: Ctx): HTMLElement[] {
  const t = ctx.t, v0 = ctx.view();
  // 大小：拖滑杆时预览跟着变（逻辑像素 = 设置窗口里的 CSS 像素，看到的就是桌面上的大小）
  const shown = v0.characters.filter(c => c.unlocked).slice(0, 2);
  const variantOf = (v: SettingsView, c: SettingsView['characters'][number]) => { const want = v.settings.variant ?? c.defaultVariant; return c.variants.includes(want) ? want : c.defaultVariant; };
  const sizePreviews = shown.map(c => {
    const vid = variantOf(v0, c), vi = v0.variants.find(x => x.id === vid)!;
    return new SpritePreview({dir: c.dir, variant: vid, renderHeight: vi.renderHeight, smooth: vi.style === 'smooth', height: v0.settings.heightLogical, label: t('chars.previewLabel', {name: c.name})});
  });
  const stage = h('div', {class: 'size-stage', 'aria-hidden': 'true'}, ...sizePreviews.map(p => p.canvas), h('div', {class: 'size-ground'}));
  // 预览框跟着大小变高（小的时候不留一大片空白）；滑杆在框上面，框变高不会挪滑杆
  const fit = (n: number) => stage.style.setProperty('height', `${Math.max(160, Math.round(n * 1.25) + 40)}px`);
  const r = v0.heightRange;
  const size = sliderRow(ctx, {id: 'heightLogical', icon: ICON.size, ...texts(ctx, 'appearance.size'), min: r.min, max: r.max, step: r.step,
    format: n => t('appearance.size.value', {n}), get: v => v.settings.heightLogical, input: n => { fit(n); for (const p of sizePreviews) p.update({height: n}); },
    change: (n, st) => ctx.set({heightLogical: n}, st), below: stage});
  ctx.onSync(v => fit(v.settings.heightLogical));
  ctx.onSync(v => shown.forEach((c, i) => { const vid = variantOf(v, c), vi = v.variants.find(x => x.id === vid)!;
    sizePreviews[i].update({variant: vid, renderHeight: vi.renderHeight, smooth: vi.style === 'smooth', height: v.settings.heightLogical}); }));

  // 画面风格：单选卡片，每张带第一个有这个变体的角色的缩略图
  const head = texts(ctx, 'appearance.variant'), st = statusEl(), all = v0.characters.length;
  const selected = (v: SettingsView) => v.settings.variant ?? v.variants.find(x => x.isDefault)?.id;
  const thumbs: SpritePreview[] = [];
  const cards = v0.variants.map(v => {
    const owner = v0.characters.find(c => v.chars.includes(c.id))!;
    const thumb = new SpritePreview({dir: owner.dir, variant: v.id, renderHeight: v.renderHeight, smooth: v.style === 'smooth', height: 64, animate: false, label: owner.name});
    thumbs.push(thumb);
    const title = v.style === 'smooth' ? t('appearance.variant.hd') : v.renderHeight <= 96 ? t('appearance.variant.pixelLarge') : t('appearance.variant.pixelSmall');
    const input = h('input', {type: 'radio', name: 'variant', value: v.id, class: 'visually-hidden', 'aria-describedby': `variant-${v.id}-desc`});
    input.addEventListener('change', async () => { if (input.checked && !await ctx.set({variant: v.id}, st)) input.checked = selected(ctx.view()) === v.id; });
    ctx.onSync(s => { input.checked = selected(s) === v.id; });
    const notes = [t(`appearance.outline.${v.outline}`), t('appearance.variant.detail', {h: v.renderHeight})];
    if (v.chars.length < all) notes.push(t('appearance.variant.only', {names: v0.characters.filter(c => v.chars.includes(c.id)).map(c => c.name).join(t('common.listSep'))}));
    return h('label', {class: 'variant-card'}, input,
      h('span', {class: 'variant-thumb'}, thumb.canvas),
      h('span', {class: 'variant-text'}, h('span', {class: 'row-title'}, title, v.isDefault ? chip(t('common.default'), 'accent') : null),
        h('span', {class: 'row-desc', id: `variant-${v.id}-desc`, text: notes.join(' · ')})),
      h('span', {class: 'variant-check', 'aria-hidden': 'true'}, h('span', {class: 'icon', text: ICON.check})));
  });
  const styleCard = h('section', {class: 'card variant-section', id: 'variant', 'aria-labelledby': 'variant-title'},
    h('div', {class: 'row-main'}, icon(ICON.style, 'row-icon'),
      h('div', {class: 'row-text'}, h('div', {class: 'row-title', id: 'variant-title', text: head.title}), h('div', {class: 'row-desc', text: head.desc}), st.el)),
    h('div', {class: 'variant-grid', role: 'radiogroup', 'aria-labelledby': 'variant-title'}, ...cards));
  ctx.register({page: ctx.page, el: styleCard, title: head.title, text: `${head.title} ${head.desc} ${head.keywords}`,
    focus: () => ((styleCard.querySelector('input:checked') ?? styleCard.querySelector('input')) as HTMLElement | null)?.focus()});
  ctx.onShow(s => { for (const p of [...sizePreviews, ...thumbs]) if (s) p.start(); else p.stop(); });
  return [section(t('appearance.section.size'), size), section(t('appearance.section.style'), styleCard)];
}

export function behaviorPage(ctx: Ctx): HTMLElement[] {
  const t = ctx.t;
  const sfw = settingToggle(ctx, 'r18', {id: 'sfw', icon: ICON.mode, invert: true, ...texts(ctx, 'behavior.sfw')});
  const awayChip = h('span');
  const away = selectRow(ctx, {id: 'awayAfterSec', icon: ICON.away, ...texts(ctx, 'behavior.away'),
    options: () => [['0', t('behavior.away.lockOnly')], ...[180, 300, 600, 1200].map(s => [String(s), t('behavior.away.minutes', {n: s / 60})] as [string, string])],
    get: v => String(v.settings.awayAfterSec), change: (val, st) => ctx.set({awayAfterSec: Number(val)}, st), below: awayChip});
  ctx.onSync(v => awayChip.replaceChildren(h('span', {class: 'row-desc'}, t('behavior.away.now'), ' ',
    chip(v.state.away ? t(v.state.away === 'locked' ? 'behavior.away.awayLocked' : 'behavior.away.awayIdle') : t('behavior.away.here'), v.state.away ? 'warning' : 'success'))));
  const press = sliderRow(ctx, {id: 'pressMs', icon: ICON.hand, ...texts(ctx, 'behavior.press'), min: 100, max: 1000, step: 50,
    format: n => t('unit.msValue', {n}), get: v => v.settings.pressMs, change: (n, st) => ctx.set({pressMs: n}, st)});
  return [section(t('behavior.section.mode'), sfw, away), section(t('behavior.section.touch'), press)];
}

export function soundPage(ctx: Ctx): HTMLElement[] {
  const t = ctx.t;
  const volume = sliderRow(ctx, {id: 'volume', icon: ICON.volume, ...texts(ctx, 'sound.volume'), min: 0, max: 100, step: 5,
    format: n => `${n}%`, get: v => Math.round(v.settings.volume * 100), change: (n, st) => ctx.set({volume: n / 100}, st)});
  const sfx = settingToggle(ctx, 'sound', {id: 'sound', icon: ICON.sfx, ...texts(ctx, 'sound.sfx')});
  const sfwNote = liveBar(ctx, v => v.settings.r18 ? null : infobar('info', t('sound.sfx.sfwTitle'), t('sound.sfx.sfwDesc')));
  const muffle = settingToggle(ctx, 'muffleHidden', {id: 'muffleHidden', icon: ICON.muffle, ...texts(ctx, 'sound.muffle')});
  const speech = settingToggle(ctx, 'speechSound', {id: 'speechSound', icon: ICON.speech, ...texts(ctx, 'sound.speech')});
  const out: HTMLElement[] = [section(t('sound.section.output'), volume), section(t('sound.section.effects'), sfwNote, sfx, muffle, speech)];
  if (ctx.view().llm) out.push(section(t('sound.section.voice'), voiceEditor(ctx)));
  return out;
}

export function quietPage(ctx: Ctx): HTMLElement[] {
  const t = ctx.t;
  const now = liveBar(ctx, v => v.state.dnd
    ? infobar('warning', t('quiet.now.on', {reason: ctx.tr.m(v.state.dnd)}), t('quiet.now.onDesc'))
    : infobar('success', t('quiet.now.off')));
  const manual = settingToggle(ctx, 'dndManual', {id: 'dndManual', icon: ICON.moon, ...texts(ctx, 'quiet.manual')});
  const system = settingToggle(ctx, 'dndSystem', {id: 'dndSystem', icon: ICON.windows, ...texts(ctx, 'quiet.system')});
  const fullText = texts(ctx, 'quiet.fullscreen');
  const full = settingToggle(ctx, 'dndFullscreen', {id: 'dndFullscreen', icon: ICON.fullscreen, ...fullText, disabled: v => v.settings.hideOnFullscreen});
  // 用不上时把原因写在这一行的说明里（就近，不另起一段）
  ctx.onSync(v => { full.querySelector('.row-desc')!.textContent = v.settings.hideOnFullscreen ? t('quiet.fullscreen.disabledNote') : fullText.desc; });
  const apps = expander(ctx, {id: 'dndApps', icon: ICON.app, ...texts(ctx, 'quiet.apps'), summary: () => {
    const n = ctx.view().settings.dndApps.length; return n ? t('quiet.apps.count', {n}) : t('quiet.apps.desc'); }},
    appList(ctx, {id: 'dndApps', get: v => v.settings.dndApps, change: list => ctx.set({dndApps: list}), lastApp: v => v.state.lastApp, emptyText: t('quiet.apps.empty')}));
  const autoHide = settingToggle(ctx, 'hideOnFullscreen', {id: 'hideOnFullscreen', icon: ICON.hide, ...texts(ctx, 'quiet.autoHide')});
  const capture = settingToggle(ctx, 'hideFromCapture', {id: 'hideFromCapture', icon: ICON.capture, ...texts(ctx, 'quiet.capture')});
  return [now, section(t('quiet.section.dnd'), h('p', {class: 'section-desc', text: t('quiet.section.dndDesc')}), manual, system, full, apps),
    section(t('quiet.section.hide'), autoHide, capture)];
}
