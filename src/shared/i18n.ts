// 界面双语（2026-10-29 用户：“整个双语”“i18next”）：i18next 实例 + 中英词条（src/locales/）。
// 主进程（托盘、提示、对话气泡上“对谁说”）和设置窗口共用这一份；运行时模块只产出词条键（src/shared/msg.ts），不碰这里。
// 渲染页没有打包：'i18next' 经页面里的 import map 指向 node_modules/i18next/dist/esm/i18next.js（单文件、无依赖；pet:// 只放出这个目录）。
// 语言设置 system（默认，跟着 Windows 的显示语言）/ zh-CN / en；系统语言不是中文就用英文。
// 不翻译的：发给模型的提示词和模型写的台词、日志、开发用的调试叠加层、角色包加载报错（docs/design.md §18）。
// 用的现成库：i18next（插值、回退语言）；自写的只有语言判断、键的类型和角色显示名。
import i18next from 'i18next';
import zhCN from '../locales/zh-CN.ts';
import en from '../locales/en.ts';
import type {Msg} from './msg.ts';

export const LANGS = ['zh-CN', 'en'] as const;
export type Lang = typeof LANGS[number];
export type LangSetting = 'system' | Lang;
export const LANG_SETTINGS: readonly LangSetting[] = ['system', ...LANGS];

/** 词条的形状以中文为准；英文（src/locales/en.ts）声明成同一个形状，少一条、多一条类型检查都报错 */
export type Locale = typeof zhCN;
type Leaves<T, P extends string = ''> = {[K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>}[keyof T & string];
/** 所有词条键（点分路径） */
export type Key = Leaves<Locale>;
export type Params = Record<string, string | number>;

export interface Translator {
  readonly lang: Lang;
  t(key: Key, params?: Params): string;
  /** 运行时模块给的消息（键是运行时拼的，按字符串查） */
  m(message: Msg): string;
  /** 键在不在（运行时拼出来的键，查不到时界面退回原文） */
  has(key: string): boolean;
}

/** 语言设置 + 系统的首选语言列表（app.getPreferredSystemLanguages()，如 zh-Hans-CN、en-US）→ 用哪种 */
export function resolveLang(setting: LangSetting, preferred: readonly string[]): Lang {
  if (setting !== 'system') return setting;
  for (const tag of preferred) {
    const l = tag.toLowerCase();
    if (l.startsWith('zh')) return 'zh-CN';
    if (l.startsWith('en')) return 'en';
  }
  return 'en';
}

export const langValid = (v: unknown): v is LangSetting => typeof v === 'string' && (LANG_SETTINGS as readonly string[]).includes(v);

export function createTranslator(lang: Lang): Translator {
  const inst = i18next.createInstance();
  // 资源直接给，initAsync: false 让 init 同步完成；界面一律用 textContent / 原生菜单，不做 HTML 转义
  void inst.init({lng: lang, fallbackLng: 'zh-CN', resources: {'zh-CN': {translation: zhCN}, en: {translation: en}},
    initAsync: false, interpolation: {escapeValue: false}, returnEmptyString: false});
  const t = (key: string, params?: Params) => inst.t(key, params) as string;
  return {lang, t, m: x => t(x.key, x.params), has: key => inst.exists(key)};
}

/** 角色的显示名：角色包 names 里有这种语言（或同一语种，如 en-US → en）用它，没有用 name（docs/pack-format.md §2） */
export function displayName(m: {name: string; names?: Readonly<Record<string, string>>}, lang: Lang): string {
  return m.names?.[lang] ?? m.names?.[lang.split('-')[0]] ?? m.name;
}
