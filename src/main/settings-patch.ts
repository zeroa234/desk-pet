// 设置窗口发来的改动（SettingsPatch）在主进程这里校验、规整（2026-10-29，R8.8）。纯函数：不碰 Electron，单测 tests/settings-patch.test.ts。
// 页面只做输入时的就地提示，这里是唯一的把关；不认识的键、类型不对、超出范围的整条拒绝（不改一半）。热键另外要看能不能注册（main.ts）。
import {DEFAULT_TUNING, type Tuning} from '../behavior/index.ts';
import {langValid} from '../shared/i18n.ts';
import {EDITABLE, type EditableKey, type Result, type SettingsPatch} from '../settings/protocol.ts';

export const LIMITS = {
  maxOnDesktop: [1, 20], heightLogical: [96, 320], awayAfterSec: [0, 3600], pressMs: [100, 2000], llmControlSec: [0, 300], sheetBudgetMB: [32, 4096],
} as const satisfies Partial<Record<EditableKey, readonly [number, number]>>;

const BOOLEAN_KEYS: readonly EditableKey[] = ['paused', 'r18', 'sound', 'muffleHidden', 'speechSound', 'dndManual', 'dndSystem', 'dndFullscreen',
  'hideOnFullscreen', 'hideFromCapture', 'llmEnabled', 'debug', 'perfLog'];
/** 程序名单只认 exe 文件名（不带路径），和勿扰判断时读到的前台程序一样 */
export const EXE_RE = /^[^\\/:*?"<>|]{1,250}\.exe$/i;
const ACCELERATOR_RE = /^(?:(?:Control|Ctrl|Alt|Shift|Super|Meta|CommandOrControl|CmdOrCtrl)\+)+(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|[`\-=[\]\\;',./])$|^F(?:[1-9]|1[0-9]|2[0-4])$/;

const int = (v: unknown, [lo, hi]: readonly [number, number]) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const fail = (error: string): Result<SettingsPatch> => ({ok: false, error});

/** Electron 快捷键写法（修饰键 + 一个键，或单独的 F 键）；能不能注册上另说 */
export const acceleratorValid = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && ACCELERATOR_RE.test(v);

/** 程序名单：去掉首尾空白、按不分大小写去重（留第一次的写法） */
export function normalizeApps(list: readonly string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const raw of list) { const exe = raw.trim(), k = exe.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(exe); } }
  return out;
}

/**
 * 物理和行为参数（Tuning）：只认 DEFAULT_TUNING 里有的键，数要有限、非负；区间 [小, 大]；权重至少一个大于 0。
 * 和默认值一样的键不存（settings.tuning 只记改过的）
 */
export function checkTuning(raw: unknown): Partial<Tuning> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULT_TUNING, k)) return null;
    const def = (DEFAULT_TUNING as unknown as Record<string, unknown>)[k];
    if (Array.isArray(def)) {
      if (!Array.isArray(v) || v.length !== 2 || !v.every(num) || v[0] > v[1]) return null;
    } else if (def && typeof def === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
      const keys = Object.keys(def), w = v as Record<string, unknown>;
      if (Object.keys(w).length !== keys.length || !keys.every(x => num(w[x])) || keys.every(x => w[x] === 0)) return null;
    } else if (!num(v)) return null;
    if (JSON.stringify(v) !== JSON.stringify(def)) out[k] = v;
  }
  return out as Partial<Tuning>;
}

/** 校验整条改动；ctx.variants = 现在加载的角色包的画面变体 id */
export function checkPatch(raw: unknown, ctx: {variants: readonly string[]}): Result<SettingsPatch> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) return fail('error.invalid');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(EDITABLE as readonly string[]).includes(k)) return fail('error.invalid');
    const key = k as EditableKey;
    if (BOOLEAN_KEYS.includes(key)) { if (typeof v !== 'boolean') return fail('error.invalid'); out[key] = v; continue; }
    switch (key) {
      case 'language': if (!langValid(v)) return fail('error.invalid'); break;
      case 'bossKey': case 'debugKey': if (!acceleratorValid(v)) return fail('error.hotkeyFormat'); break;
      case 'maxOnDesktop': if (v !== null && !int(v, LIMITS.maxOnDesktop)) return fail('error.range'); break;
      case 'variant': if (v !== null && !(typeof v === 'string' && ctx.variants.includes(v))) return fail('error.invalid'); break;
      case 'heightLogical': case 'awayAfterSec': case 'pressMs': case 'llmControlSec': case 'sheetBudgetMB':
        if (!int(v, LIMITS[key])) return fail('error.range'); break;
      case 'volume': if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) return fail('error.range'); break;
      case 'dndApps':
        if (!Array.isArray(v) || v.length > 100 || !v.every(x => typeof x === 'string' && EXE_RE.test(x.trim()))) return fail('error.exe');
        out[key] = normalizeApps(v); continue;
      case 'tuning': { const t = checkTuning(v); if (!t) return fail('error.invalid'); out[key] = t; continue; }
    }
    out[key] = v;
  }
  if (out.bossKey !== undefined && out.bossKey === out.debugKey) return fail('error.hotkeySame');
  return {ok: true, value: out as SettingsPatch};
}
