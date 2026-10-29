// 说话声音（每个角色一套：音高、语速、共振峰、气声）。逻辑照旧版面板（src/stage/voice-settings.ts，2026-10-29 换成新界面后删了）：
// 先试听再保存；草稿不进对话、不发给模型；试听和桌面上说话用同一套合成（src/stage/speech-preview.ts）。
// 改了没保存时显示提示条（保存 / 放弃），换角色前问一句。
import {VOICE_CONTROLS, voiceValid} from '../llm/voice.ts';
import type {SpeechVoice} from '../llm/types.ts';
import {SpeechPreview, type VoicePreview} from '../stage/speech-preview.ts';
import type {Key} from '../shared/i18n.ts';
import type {SettingsView} from './protocol.ts';
import {ICON, button, h, infobar, statusEl, type Ctx} from './ui.ts';

export function voiceEditor(ctx: Ctx): HTMLElement {
  const t = ctx.t;
  const player = new SpeechPreview();
  const status = statusEl();
  const charSel = h('select', {class: 'select', id: 'voice-char', 'aria-labelledby': 'voice-char-label'});
  const fields = new Map<keyof SpeechVoice, {range: HTMLInputElement; num: HTMLInputElement}>();
  const rows = VOICE_CONTROLS.map(c => {
    const id = `voice-${c.key}`;
    const range = h('input', {type: 'range', class: 'slider', id, min: c.min, max: c.max, step: c.step, 'aria-labelledby': `${id}-label`, 'aria-describedby': `${id}-hint`});
    const num = h('input', {type: 'number', class: 'number', id: `${id}-number`, min: c.min, max: c.max, step: c.step, 'aria-labelledby': `${id}-label`});
    num.style.setProperty('width', '84px');
    const paint = () => range.style.setProperty('--fill', `${(Number(range.value) - c.min) / (c.max - c.min) * 100}%`);
    range.addEventListener('input', () => { num.value = range.value; paint(); changed(); });
    num.addEventListener('input', () => { if (Number.isFinite(num.valueAsNumber)) { range.value = num.value; paint(); } changed(); });
    fields.set(c.key, {range, num});
    return h('div', {class: 'voice-row'},
      h('label', {class: 'voice-label', id: `${id}-label`, for: id, text: t(`voice.${c.key}.label` as Key)}),
      h('div', {class: 'voice-slider'}, range, h('span', {class: 'row-desc', id: `${id}-hint`, text: t(`voice.${c.key}.hint` as Key)})),
      h('span', {class: 'number-wrap'}, num, c.unit ? h('span', {class: 'unit', text: t(`unit.${c.unit}` as Key)}) : null));
  });
  const text = h('input', {type: 'text', class: 'text', id: 'voice-text', maxLength: 80, value: t('voice.sample'), 'aria-labelledby': 'voice-text-label'});
  const play = button({text: t('voice.preview'), icon: ICON.play, onclick: () => void preview()});
  const stopBtn = button({text: t('voice.stop'), icon: ICON.stop, onclick: () => stop(true)});
  const reset = button({text: t('voice.reset'), icon: ICON.undo, kind: 'subtle', onclick: () => void save(true)});
  const saveBtn = button({text: t('common.save'), icon: ICON.save, kind: 'accent', onclick: () => void save(false)});
  const discard = button({text: t('common.discard'), onclick: () => { dirty = false; load(); }});
  const dirtyBar = infobar('warning', t('common.unsaved'), t('voice.unsavedHint'), h('div', {class: 'infobar-actions'}, saveBtn, discard));
  dirtyBar.hidden = true;
  let chars: NonNullable<SettingsView['llm']>['characters'] = [];
  let dirty = false, audition = 0, current = '';

  const selected = () => chars.find(c => c.id === charSel.value);
  const draft = (): SpeechVoice => Object.fromEntries([...fields].map(([k, f]) => [k, f.num.valueAsNumber])) as unknown as SpeechVoice;
  const buttons = () => {
    const valid = !!selected() && voiceValid(draft());
    play.disabled = !valid || !text.value.trim();
    saveBtn.disabled = !valid;
    reset.disabled = !selected() || !selected()!.voiceCustom && !dirty;
    dirtyBar.hidden = !dirty;
  };
  function changed(): void {
    stop(false); dirty = true; buttons();
    if (!voiceValid(draft())) status.error(t('voice.invalid')); else status.clear();
  }
  function load(): void {
    stop(false);
    const c = selected();
    if (c) for (const [k, f] of fields) f.range.value = f.num.value = String(c.voice[k]);
    for (const [k, f] of fields) { const ctl = VOICE_CONTROLS.find(x => x.key === k)!; f.range.style.setProperty('--fill', `${(Number(f.range.value) - ctl.min) / (ctl.max - ctl.min) * 100}%`); }
    current = charSel.value; buttons();
  }
  function stop(say: boolean): void { audition++; player.stop(); stopBtn.disabled = true; if (say) status.ok(t('voice.stopped')); }
  async function preview(): Promise<void> {
    stop(false);
    const c = selected(), voice = draft();
    if (!c || !voiceValid(voice)) return;
    const token = audition;
    stopBtn.disabled = false;
    const r = await ctx.act<VoicePreview>({type: 'llm.voicePreview', id: c.id, voice, text: text.value.trim()}, status);
    if (token !== audition || !r.ok || !r.value) { stopBtn.disabled = true; return; }
    const started = await player.play(r.value, () => { stopBtn.disabled = true; });
    if (token === audition && started && r.value.volume === 0) status.error(t('voice.muted'));
  }
  async function save(toDefault: boolean): Promise<void> {
    const c = selected();
    if (!c) return;
    const voice = toDefault ? null : draft();
    if (voice && !voiceValid(voice)) return;
    stop(false);
    if ((await ctx.act({type: 'llm.character', id: c.id, patch: {voice}}, status)).ok) {
      dirty = false;
      c.voice = {...(voice ?? c.voiceDefault)}; c.voiceCustom = !toDefault;
      load(); status.ok(t(toDefault ? 'voice.resetDone' : 'voice.saved'));
    }
  }
  charSel.addEventListener('change', async () => {
    if (dirty && !await ctx.confirm({title: t('common.discardTitle'), body: t('voice.discardBody'), confirm: t('common.discard')})) { charSel.value = current; return; }
    dirty = false; load();
  });
  text.addEventListener('input', buttons);
  window.addEventListener('pagehide', () => { audition++; player.close(); });
  ctx.onShow(shown => { if (!shown) stop(false); });
  ctx.onSync(v => {
    chars = v.llm?.characters ?? [];
    const ids = chars.map(c => `${c.id}:${c.name}`).join('\n');
    if (charSel.dataset.ids !== ids) {
      charSel.dataset.ids = ids; const prev = charSel.value; charSel.textContent = '';
      for (const c of chars) charSel.append(h('option', {value: c.id, text: c.name}));
      if (chars.some(c => c.id === prev)) charSel.value = prev;
    }
    if (!dirty) load(); else buttons();
  });
  const card = h('section', {class: 'card voice-card', id: 'voice', 'aria-labelledby': 'voice-title'},
    h('div', {class: 'voice-head'},
      h('div', {class: 'row-text'}, h('div', {class: 'row-title', id: 'voice-title', text: t('voice.title')}), h('div', {class: 'row-desc', text: t('voice.desc')}), status.el),
      h('label', {class: 'inline-label', id: 'voice-char-label', for: 'voice-char', text: t('voice.character')}), charSel),
    dirtyBar,
    h('div', {class: 'voice-grid'}, ...rows),
    h('div', {class: 'voice-try'}, h('label', {class: 'inline-label', id: 'voice-text-label', for: 'voice-text', text: t('voice.sampleLabel')}), text, play, stopBtn, reset));
  ctx.register({page: ctx.page, el: card, title: t('voice.title'), text: `${t('voice.title')} ${t('voice.desc')} ${t('voice.keywords')}`, focus: () => charSel.focus()});
  stopBtn.disabled = true;
  return card;
}
