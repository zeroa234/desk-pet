// 设置窗口（R8.8，2026-10-29）和主进程之间的数据约定。只有类型，主进程（src/main/settings-window.ts）和页面（src/settings/）都 import。
//   页面 → 主：settings:view（读一份完整快照）、settings:set（改设置，SettingsPatch）、settings:act（动作，SettingsAction）
//   主 → 页面：settings:changed（有东西变了，页面重读快照）、settings:page（打开时要显示哪一页）
// 改设置在主进程校验（src/main/settings-patch.ts），页面只做输入时的就地提示。key 等机密不进页面（docs/design.md §18）。
import type {Settings} from '../main/settings.ts';
import type {Lang, LangSetting} from '../shared/i18n.ts';
import type {Msg} from '../shared/msg.ts';
import type {SpeechVoice} from '../llm/types.ts';
import type {CharacterVision, VisionConfig} from '../vision/types.ts';
import type {UsageSummary} from '../llm/usage.ts';
import type {CallRecord} from '../llm/types.ts';
import type {PackVariant} from '../pack/index.ts';
import type {Tuning} from '../behavior/index.ts';

export const PAGES = ['general', 'characters', 'appearance', 'behavior', 'sound', 'quiet', 'ai', 'vision', 'usage', 'advanced'] as const;
export type PageId = typeof PAGES[number];

/** 设置窗口能改的键（其余的只能改 data/settings.json） */
export const EDITABLE = ['language', 'paused', 'bossKey', 'debugKey', 'maxOnDesktop', 'variant', 'heightLogical', 'r18', 'awayAfterSec', 'pressMs',
  'volume', 'sound', 'muffleHidden', 'speechSound', 'dndManual', 'dndSystem', 'dndFullscreen', 'dndApps', 'hideOnFullscreen', 'hideFromCapture',
  'llmEnabled', 'llmControlSec', 'debug', 'perfLog', 'sheetBudgetMB', 'tuning'] as const satisfies readonly (keyof Settings)[];
export type EditableKey = typeof EDITABLE[number];
export type SettingsPatch = Partial<Pick<Settings, EditableKey>>;
/** 改了要重启才生效的键 */
export const RESTART_KEYS: readonly EditableKey[] = ['tuning'];

export interface CharacterView {
  id: string;
  name: string;
  unlocked: boolean;
  /** 托盘 / 设置里勾了“在桌面上” */
  wanted: boolean;
  /** 现在真的在桌面上 */
  present: boolean;
  /** 勾了但同屏人数满了，等名额 */
  waiting: boolean;
  /** 角色包目录（相对项目根，pet://app/<dir>/sprites/… 读预览） */
  dir: string;
  variants: string[];
  defaultVariant: string;
  /** 能不能召唤（人数上限满了不能） */
  canSummon: boolean;
}

export interface VariantView extends PackVariant {
  /** 哪些角色有这个变体（别的角色用自己的默认变体） */
  chars: string[];
  isDefault: boolean;
}

export interface LlmCharacterView {
  id: string;
  name: string;
  provider: string | null;
  maxTurns: number;
  dropTurns: number;
  decisionTurns: number;
  /** 会话轮数是自己设的（不是默认） */
  customTurns: boolean;
  voice: SpeechVoice;
  voiceDefault: SpeechVoice;
  voiceCustom: boolean;
  vision: CharacterVision;
  imageStatus: 'unsupported' | 'unverified' | 'verified' | 'failed';
  memory: Record<'adult' | 'sfw', {active: number; archived: number; summary: string}>;
  /** 现在能不能让她看一次屏幕 */
  canLook: boolean;
}

export interface LlmView {
  latest: Msg;
  limit: Msg | null;
  hourly: number | null;
  providers: {id: string; model: string; images: boolean}[];
  /** 默认的会话轮数（config/llm.json 的 context） */
  defaultTurns: {maxTurns: number; dropTurns: number; decisionTurns: number};
  characters: LlmCharacterView[];
  /** 提示词：公共前缀的 id 和每个目标两种模式的文本（保存过的，或角色包的人设） */
  shared: string;
  prompts: Record<string, {adult: string; sfw: string}>;
  promptMax: number;
  vision: VisionConfig;
  visionLatest: Msg;
}

export interface SettingsView {
  lang: Lang;
  /** 系统语言（“跟随系统”旁边显示） */
  systemLang: Lang;
  /** Windows 的强调色 #rrggbb（读不到时 null，页面用默认紫色） */
  accent: string | null;
  settings: Pick<Settings, EditableKey>;
  defaults: Pick<Settings, EditableKey>;
  defaultTuning: Tuning;
  /** 改过、要重启才生效的键 */
  restartPending: EditableKey[];
  state: {
    hidden: boolean;
    hiddenByFullscreen: boolean;
    /** 勿扰的原因（null = 没勿扰） */
    dnd: Msg | null;
    away: 'idle' | 'locked' | null;
    /** 最近一次在前台的用户程序（exe） */
    lastApp: string;
    /** 热键注册成功没有（被别的程序占了是 false） */
    bossKeyOk: boolean;
    debugKeyOk: boolean;
    unlockedAll: boolean;
    /** 开机自动启动（当前用户的启动项里有没有这一条） */
    autostart: boolean;
  };
  characters: CharacterView[];
  variants: VariantView[];
  heightRange: {min: number; max: number; step: number};
  llm: LlmView | null;
}

export interface UsageView {
  summary: UsageSummary;
  byCharacter: Record<string, UsageSummary>;
  byKind: Record<string, UsageSummary>;
  recent: CallRecord[];
}

export type SettingsAction =
  | {type: 'hide'; on: boolean}
  | {type: 'desktop'; id: string; on: boolean}
  | {type: 'summon'; id: string}
  | {type: 'unlockAll'}
  | {type: 'autostart'; on: boolean}
  | {type: 'restart'}
  | {type: 'llm.prompt'; id: string; mode: 'adult' | 'sfw'; text: string}
  | {type: 'llm.character'; id: string; patch: Record<string, unknown>}
  | {type: 'llm.voicePreview'; id: string; voice: SpeechVoice; text: string}
  | {type: 'llm.vision'; patch: Partial<VisionConfig>}
  | {type: 'llm.providerImages'; id: string; images: boolean}
  | {type: 'llm.forget'; id: string; mode: 'adult' | 'sfw'}
  | {type: 'llm.hourly'; n: number | null}
  | {type: 'llm.look'; id: string}
  | {type: 'llm.usage'};

/** 改设置 / 动作的结果：失败时 error 是词条键（页面翻译后就地显示） */
export type Result<T = unknown> = {ok: true; value?: T} | {ok: false; error: string};
