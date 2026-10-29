// 用户设置：data/settings.json。设置窗口（R8.8，2026-10-29，src/main/settings-window.ts）和托盘改，改了就存。
// 写入用“先写临时文件再改名”，防止写一半断电（design.md §12）。
import fs from 'node:fs';
import path from 'node:path';
import type {Tuning} from '../behavior/index.ts';
import type {LangSetting} from '../shared/i18n.ts';

export interface Settings {
  /** 界面语言（2026-10-29）：system = 跟着 Windows 的显示语言；src/shared/i18n.ts */
  language: LangSetting;
  llmEnabled: boolean;
  /** Model activity protection / rendezvous wait in simulation seconds, 0 disables, maximum 300. */
  llmControlSec: number;
  speechSound: boolean;
  /** 画面变体（角色包 variants 的 id）；null = 角色包的 defaultVariant */
  variant: string | null;
  /** 角色站立高度，逻辑像素（R1.5：默认 120） */
  heightLogical: number;
  debug: boolean;
  /** 截图 / 录屏 / 共享屏幕时桌宠不出现（R8.6，setContentProtection）。agent 截图验收时要关掉（R14.3） */
  hideFromCapture: boolean;
  paused: boolean;
  /** 全局热键（Electron accelerator 写法） */
  bossKey: string;
  debugKey: string;
  /** 全屏应用、演示时自动隐藏（R8.5） */
  hideOnFullscreen: boolean;
  /** false = 全年龄模式（R9.2）：不选 R18 行为，正在做的换成穿衣 */
  r18: boolean;
  /** 覆盖 behavior 的 DEFAULT_TUNING（重力、待机时长、走 / 坐 / 站的权重……），只写要改的键；启动时读，改了要重启 */
  tuning: Partial<Tuning>;
  /** 每 10 秒往事件日志写一条 perf（各进程 CPU、事件循环占用、tick 耗时），R14.1 排查用 */
  perfLog: boolean;
  /**
   * 舞台每个窗口给解码后的图集留多少内存（MB，design.md §3.1）：超了就把最久没画过、这一帧也没在画的图集释放掉，下次要用再读。
   * 场景图集解码后一张 15–53 MB，不卸的话三个场景播完 r120 约 244 MB
   */
  sheetBudgetMB: number;
  /** 原版 mod 的音效（R2.8、R6.3；全年龄模式下一律不放，R6.6） */
  sound: boolean;
  /** 音量 0..1（乘在导出时统一好的电平上） */
  volume: number;
  /** 躲在窗口后面时声音闷一点（低通，N2.1；R2.8 只要求听得到，可关） */
  muffleHidden: boolean;
  /**
   * 在角色身上按住多久算“拎起来”（毫秒）；没到就松开算点了一下（R3.6）。按下以后拖动超过系统的拖动阈值（4 逻辑像素）马上拎。
   * 默认 300 = VPet 的默认长按时长（VPet-Simulator.Windows/Function/Setting.cs 的 presslength）
   */
  pressMs: number;
  /** 勿扰（N8.1，不出声；src/main/dnd.ts）：手动开着 */
  dndManual: boolean;
  /** 勿扰：跟着 Windows 的勿扰 / 专注助手 */
  dndSystem: boolean;
  /** 勿扰：全屏、演示时（“全屏时自动隐藏”开着时桌宠已经藏起来了，关掉自动隐藏以后才用得上） */
  dndFullscreen: boolean;
  /** 勿扰：这些程序在前台时（exe 文件名，不分大小写；托盘里“加上刚才在前台的”加） */
  dndApps: string[];
  /** 用户离开（N3.1，src/main/away.ts）：多少秒没碰键盘鼠标算离开；0 = 只算锁屏 / 屏保 / 切到别的用户。默认 300（5 分钟，design.md §17） */
  awayAfterSec: number;
  /**
   * 托盘里每个角色的“在桌面上”明确选过的（2026-10-22 用户：可以自选场景内角色）：id → 在不在；不在的不出现、不参与双人，状态值照常随时间变。
   * 没选过的角色（包括以后新装的）按各角色包 behaviors.json 的 desktopDefault（absentIds）
   */
  onDesktop: Record<string, boolean>;
  /** All displays together; null = unlimited. Selected overflow characters wait for a free slot. */
  maxOnDesktop: number | null;
  /**
   * 整组指定哪些角色不在桌面上：列了的不在，没列的都在（比 onDesktop 优先）。验收脚本经 DESK_PET_SET 用；2026-10-22 托盘也这么存过
   * （存的是当时全部角色的清单，以后新装的角色不在清单里就会直接出现），启动时换成 onDesktop（main.ts）
   */
  absentChars: string[] | null;
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'system',
  llmEnabled: false,
  llmControlSec: 30,
  speechSound: true,
  variant: null,
  heightLogical: 120,
  debug: false,
  hideFromCapture: true,
  paused: false,
  bossKey: 'Control+Alt+H',
  debugKey: 'Control+Alt+D',
  hideOnFullscreen: true,
  r18: false,
  tuning: {},
  perfLog: false,
  sheetBudgetMB: 150,
  sound: true,
  volume: 0.6,
  muffleHidden: true,
  pressMs: 300,
  dndManual: false,
  dndSystem: true,
  dndFullscreen: true,
  dndApps: [],
  awayAfterSec: 300,
  onDesktop: {},
  maxOnDesktop: null,
  absentChars: null,
};

/** 哪些角色不在桌面上：absentChars 给了就照它（整组指定）；否则 onDesktop 里选过的照选的，没选过的按 desktopDefault */
export function absentIds(s: Pick<Settings, 'onDesktop' | 'absentChars'>, packs: readonly {id: string; defaultAbsent: boolean}[]): string[] {
  return packs.filter(p => s.absentChars ? s.absentChars.includes(p.id) : !(s.onDesktop[p.id] ?? !p.defaultAbsent)).map(p => p.id);
}

export class SettingsStore {
  readonly file: string;
  value: Settings;
  private saved: Partial<Settings> = {};
  private readonly overrides: Partial<Settings>;
  /** overrides：命令行 --set 给的临时值（验收脚本用），只在内存里，不写回文件 */
  constructor(file: string, overrides: Partial<Settings> = {}) {
    this.file = file;
    this.overrides = overrides;
    try { this.saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 第一次运行没有文件 */ }
    this.value = {...DEFAULT_SETTINGS, ...this.saved, ...overrides};
  }
  /** 文件里存的（不算默认值和临时值）；没存过是 undefined */
  stored<K extends keyof Settings>(k: K): Settings[K] | undefined {
    return this.saved[k];
  }
  set<K extends keyof Settings>(k: K, v: Settings[K]): void {
    this.value[k] = v;
    this.persist(k, v);
  }
  /** 换掉旧写法存的值：写回文件；这次运行给了临时值（overrides）的键内存里照旧用临时值 */
  migrate<K extends keyof Settings>(k: K, v: Settings[K]): void {
    if (!(k in this.overrides)) this.value[k] = v;
    this.persist(k, v);
  }
  private persist<K extends keyof Settings>(k: K, v: Settings[K]): void {
    this.saved[k] = v;
    fs.mkdirSync(path.dirname(this.file), {recursive: true});
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({...DEFAULT_SETTINGS, ...this.saved}, null, 1));
    fs.renameSync(this.file + '.tmp', this.file);
  }
}
