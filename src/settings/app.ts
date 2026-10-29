// 设置窗口的页面入口（2026-10-29）：标题栏（搜索）、左边分类导航、右边当前页；提示气泡、确认框、重启提示条。
// 快照变了（settings:changed）：结构没变只刷新值（onSync），角色 / 模型列表或语言变了整个重建（停在原来那页）。
import {createTranslator, type Key, type Translator} from '../shared/i18n.ts';
import {PAGES, type PageId, type Result, type SettingsAction, type SettingsPatch, type SettingsView} from './protocol.ts';
import {ICON, button, h, icon, infobar, type Ctx, type SearchEntry} from './ui.ts';
import {appearancePage, behaviorPage, charactersPage, generalPage, quietPage, soundPage} from './pages/basic.ts';
import {aiPage, promptDirty, usagePage, visionPage} from './pages/ai.ts';
import {advancedPage} from './pages/advanced.ts';

interface Api {
  view(): Promise<SettingsView>;
  set(patch: SettingsPatch): Promise<Result>;
  act(action: SettingsAction): Promise<Result>;
  onChanged(cb: () => void): void;
  onPage(cb: (page: string) => void): void;
}
const api = (window as unknown as {petSettings: Api}).petSettings;
const BUILDERS: Record<PageId, (ctx: Ctx) => HTMLElement[]> = {
  general: generalPage, characters: charactersPage, appearance: appearancePage, behavior: behaviorPage, sound: soundPage, quiet: quietPage,
  ai: aiPage, vision: visionPage, usage: usagePage, advanced: advancedPage,
};
const NAV_ICONS: Record<PageId, string> = {general: ICON.general, characters: ICON.characters, appearance: ICON.appearance, behavior: ICON.behavior,
  sound: ICON.sound, quiet: ICON.quiet, ai: ICON.ai, vision: ICON.vision, usage: ICON.usage, advanced: ICON.advanced};
const isPage = (p: unknown): p is PageId => typeof p === 'string' && (PAGES as readonly string[]).includes(p);
/** 这些动作是“改了一项设置”：成功时控件旁边显示“已保存”（别的动作各自说结果） */
const SAVING_ACTIONS: ReadonlySet<SettingsAction['type']> = new Set(['hide', 'desktop', 'autostart', 'llm.character', 'llm.vision', 'llm.providerImages', 'llm.hourly']);

document.documentElement.classList.toggle('mica', new URLSearchParams(location.search).get('mica') === '1');

let view: SettingsView;
let tr: Translator;
let current: PageId = isPage(location.hash.slice(1)) ? location.hash.slice(1) as PageId : 'general';
let syncs: ((v: SettingsView) => void)[] = [];
let entries: SearchEntry[] = [];
let shows = new Map<PageId, ((shown: boolean) => void)[]>();
let pages = new Map<PageId, HTMLElement>();
let navLinks = new Map<PageId, HTMLAnchorElement>();
let structure = '';
const root = document.getElementById('app')!;

const structureOf = (v: SettingsView) => JSON.stringify([v.lang, v.characters.map(c => [c.id, c.name, c.unlocked]), v.variants.map(x => x.id),
  !!v.llm, v.llm?.providers.map(p => p.id), v.llm?.characters.map(c => [c.id, c.name])]);
const errorText = (key: string) => tr.has(key) ? tr.t(key as Key) : tr.t('error.internal');

async function refresh(): Promise<void> {
  const next = await api.view();
  view = next;
  if (structureOf(next) !== structure) build(); else sync();
}
function sync(): void {
  for (const fn of syncs) { try { fn(view); } catch (e) { console.error(e); } }
}

// ---------- 提示气泡（一次一个，6 秒；鼠标停在上面或有焦点时不消失） ----------
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, undo?: () => void): void {
  const host = document.getElementById('toast-host')!;
  clearTimeout(toastTimer);
  const el = h('div', {class: 'toast'}, h('span', {text}),
    undo ? button({text: tr.t('common.undo'), kind: 'subtle', icon: ICON.undo, onclick: () => { undo(); host.replaceChildren(); }}) : null);
  host.replaceChildren(el);
  const arm = () => { toastTimer = setTimeout(() => { if (!el.matches(':hover,:focus-within')) host.replaceChildren(); else arm(); }, 6000); };
  arm();
}

// ---------- 确认框（原生 <dialog>，危险操作默认焦点在“取消”） ----------
function confirmDialog(o: {title: string; body: string; confirm: string; danger?: boolean}): Promise<boolean> {
  return new Promise(resolve => {
    const dlg = h('dialog', {class: 'dialog', 'aria-labelledby': 'dlg-title', 'aria-describedby': 'dlg-body'});
    const cancel = button({text: tr.t('common.cancel'), onclick: () => dlg.close('cancel')});
    const ok = button({text: o.confirm, kind: o.danger ? 'danger' : 'accent', onclick: () => dlg.close('ok')});
    dlg.append(h('h2', {id: 'dlg-title', class: 'dialog-title', text: o.title}), h('p', {id: 'dlg-body', class: 'dialog-body', text: o.body}),
      h('div', {class: 'dialog-actions'}, ok, cancel));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
    (o.danger ? cancel : ok).focus();
  });
}

function makeCtx(page: PageId): Ctx {
  const t = (key: Key, params?: Record<string, string | number>) => tr.t(key, params);
  return {
    tr, t, page, view: () => view,
    async set(patch, st) {
      const r = await api.set(patch);
      if (r.ok) st?.ok(tr.t('common.saved')); else if (st) st.error(errorText(r.error)); else toast(errorText(r.error));
      await refresh();
      return r.ok;
    },
    async act(action, st) {
      const r = await api.act(action);
      if (!r.ok) { if (st) st.error(errorText(r.error)); else toast(errorText(r.error)); }
      else if (st && SAVING_ACTIONS.has(action.type)) st.ok(tr.t('common.saved'));
      if (action.type !== 'llm.usage' && action.type !== 'llm.voicePreview') await refresh();
      return r as Result<never>;
    },
    onSync: fn => { syncs.push(fn); },
    register: e => { entries.push(e); },
    toast, confirm: confirmDialog,
    onShow: fn => { shows.get(page)!.push(fn); },
  };
}

// ---------- 搜索（标题栏）：按标题、说明、关键词找设置，结果点了跳到那一页并高亮那一行 ----------
function search(q: string): void {
  const box = document.getElementById('search-results')!, query = q.trim().toLowerCase();
  const pageBox = document.getElementById('pages')!, title = document.getElementById('page-title')!;
  if (!query) { box.hidden = true; pageBox.hidden = false; title.textContent = tr.t(`nav.${current}` as Key); return; }
  const hits = entries.filter(e => e.text.toLowerCase().includes(query));
  pageBox.hidden = true; box.hidden = false;
  title.textContent = tr.t('search.title', {q: q.trim()});
  box.replaceChildren(hits.length
    ? h('ul', {class: 'results', 'aria-label': tr.t('search.results', {n: hits.length})}, ...hits.map(e => h('li', {},
        h('button', {type: 'button', class: 'result', onclick: () => reveal(e)},
          icon(NAV_ICONS[e.page], 'row-icon'),
          h('span', {class: 'row-text'}, h('span', {class: 'row-title', text: e.title}), h('span', {class: 'row-desc', text: tr.t(`nav.${e.page}` as Key)})),
          icon('', 'chevron')))))
    : h('p', {class: 'section-desc', text: tr.t('search.none')}));
}
function reveal(e: SearchEntry): void {
  const input = document.getElementById('search') as HTMLInputElement;
  input.value = '';
  search('');
  go(e.page);
  requestAnimationFrame(() => {
    e.el.scrollIntoView({block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    e.el.classList.remove('flash'); void e.el.offsetWidth; e.el.classList.add('flash');
    if (e.el instanceof HTMLDetailsElement) e.el.open = true;
    e.focus?.();
  });
}

function go(page: PageId, push = true): void {
  const prev = current;
  current = page;
  if (push && location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
  for (const [id, el] of pages) el.hidden = id !== page;
  for (const [id, a] of navLinks) { if (id === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  const title = document.getElementById('page-title');
  if (title) title.textContent = tr.t(`nav.${page}` as Key);
  document.getElementById('content')?.scrollTo({top: 0});
  if (prev !== page) for (const fn of shows.get(prev) ?? []) fn(false);
  for (const fn of shows.get(page) ?? []) fn(true);
}

function build(): void {
  for (const fns of shows.values()) for (const fn of fns) fn(false);
  tr = createTranslator(view.lang);
  structure = structureOf(view);
  document.documentElement.lang = view.lang;
  document.title = tr.t('app.title');
  applyAccent(view.accent);
  syncs = []; entries = []; shows = new Map(PAGES.map(p => [p, []])); pages = new Map(); navLinks = new Map();
  const focusedId = document.activeElement?.id;

  const searchInput = h('input', {type: 'search', id: 'search', class: 'search-input', placeholder: tr.t('search.placeholder'), 'aria-label': tr.t('search.label'),
    autocomplete: 'off', spellcheck: false});
  searchInput.addEventListener('input', () => search(searchInput.value));
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { searchInput.value = ''; search(''); }
    if (e.key === 'Enter') (document.querySelector('#search-results .result') as HTMLButtonElement | null)?.click();
  });
  const titlebar = h('header', {class: 'titlebar'},
    h('div', {class: 'brand'}, h('span', {class: 'brand-mark', 'aria-hidden': 'true', text: ''}), h('span', {class: 'brand-text', text: tr.t('app.title')})),
    h('div', {class: 'search', role: 'search'}, icon(ICON.search, 'search-icon'), searchInput));

  const nav = h('nav', {class: 'nav', 'aria-label': tr.t('nav.label')},
    h('ul', {}, ...PAGES.map(p => {
      const a = h('a', {href: `#${p}`, class: 'nav-item', title: tr.t(`nav.${p}` as Key)}, icon(NAV_ICONS[p], 'nav-icon'), h('span', {class: 'nav-text', text: tr.t(`nav.${p}` as Key)}));
      navLinks.set(p, a);
      return h('li', {}, a);
    })));
  // 上下键在导航里移动（Tab 照常）
  nav.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const links = [...navLinks.values()], i = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) return;
    e.preventDefault();
    links[(i + (e.key === 'ArrowDown' ? 1 : links.length - 1)) % links.length].focus();
  });

  const restartBar = h('div', {class: 'live-bar'});
  syncs.push(v => {
    restartBar.replaceChildren(...(v.restartPending.length ? [infobar('warning', tr.t('restart.title'), tr.t('restart.desc'),
      button({text: tr.t('advanced.restart.action'), icon: ICON.restart, onclick: () => void api.act({type: 'restart'})}))] : []));
  });
  const pageBox = h('div', {id: 'pages'});
  for (const p of PAGES) {
    const ctx = makeCtx(p);
    let children: HTMLElement[];
    try { children = BUILDERS[p](ctx); } catch (e) { console.error(e); children = [infobar('error', tr.t('error.internal'), String(e))]; }
    const el = h('div', {class: 'page', id: `page-${p}`, 'data-page': p, hidden: p !== current}, ...children);
    pages.set(p, el);
    pageBox.append(el);
  }
  const content = h('main', {class: 'content', id: 'content', tabindex: -1},
    h('div', {class: 'content-inner'}, restartBar, h('h1', {class: 'page-title', id: 'page-title', tabindex: -1}), pageBox, h('div', {id: 'search-results', hidden: true})));
  root.replaceChildren(titlebar, h('div', {class: 'shell'}, nav, content), h('div', {id: 'toast-host', class: 'toast-host', role: 'status', 'aria-live': 'polite'}));
  root.removeAttribute('aria-busy');
  sync();
  go(current, false);
  if (focusedId) document.getElementById(focusedId)?.focus();
}

/** Windows 强调色 → CSS 变量；按亮度挑按钮上的字色（白 / 黑），保证对比度 */
function applyAccent(hex: string | null): void {
  const s = document.documentElement.style;
  if (!hex) { s.removeProperty('--accent-base'); s.removeProperty('--on-accent'); return; }
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  s.setProperty('--accent-base', hex);
  s.setProperty('--on-accent', (1.05) / (lum + 0.05) >= (lum + 0.05) / 0.05 ? '#ffffff' : '#000000');
}

window.addEventListener('hashchange', () => { const p = location.hash.slice(1); if (isPage(p) && p !== current) go(p, false); });
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); (document.getElementById('search') as HTMLInputElement | null)?.focus(); }
});
// 关窗口前：有没保存的提示词就拦下来问（Electron 里 beforeunload 拦下就是不关）
let leaving = false;
window.addEventListener('beforeunload', e => {
  if (leaving || !promptDirty()) return;
  e.preventDefault();
  e.returnValue = '';
  void confirmDialog({title: tr.t('common.discardTitle'), body: tr.t('ai.prompt.discardBody'), confirm: tr.t('common.discardClose')})
    .then(ok => { if (ok) { leaving = true; window.close(); } });
});
api.onChanged(() => void refresh());
api.onPage(p => { if (isPage(p)) go(p); });

void api.view().then(v => { view = v; build(); });
