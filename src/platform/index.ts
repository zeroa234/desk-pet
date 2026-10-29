// platform/：唯一调 Win32 的地方（design.md §1）。别的模块只 import 这个文件。
// 坐标全部是物理像素（见 shared/types.ts）。实现在 win32.ts（koffi）；测试时用假实现替换。
import type {DisplayInfo, NotificationState, Point, Rect, WinEvent, WinInfo} from '../shared/types.ts';

/** watchWindows 装的钩子 */
export interface WindowWatch {
  /**
   * 换成只收这些进程的窗口位置 / 大小变化（kind 'location'，走 watchWindows 的 onEvent）；传空就不收。
   * 不全局收：光标每动一下系统都发一个位置变化事件，2026-10-21 实测每个事件约 36–68 微秒主进程 CPU
   * （temp/check/winevent-cost.ts），鼠标快速移动时一秒一两百个；所以只收角色跟着的窗口所在的进程
   */
  followLocations(pids: readonly number[]): void;
  /** 全卸掉 */
  stop(): void;
  /** 回调一共被调了几次（过滤之前：含光标、插入符这些不是窗口本身的事件）。调试层显示，看按进程收位置变化时光标事件漏不漏进来 */
  readonly raw: number;
}

export interface Platform {
  /**
   * 列出用户看得见、桌宠能互动的顶层窗口，按 z 序从上到下（EnumWindows 的顺序）。
   * 过滤（调研报告 §4.1、reports/research-2026-10-20/win32-platform.md §2 的 FancyZones 规则）：
   * 可见、非最小化、非 cloaked、非 WS_EX_TOOLWINDOW、是根窗口、不是“无粗边框的弹出窗口”（菜单、开始菜单、托盘弹窗）、
   * 可见矩形非空、不属于 excludePids（桌宠自己）、不是桌面和任务栏（Progman、WorkerW、Shell_TrayWnd、Shell_SecondaryTrayWnd）。
   * rect 用 DWMWA_EXTENDED_FRAME_BOUNDS。
   */
  listWindows(excludePids: readonly number[]): WinInfo[];
  /** 单个窗口当前的可见矩形；窗口没了、不可见、最小化、cloaked 时返回 null。站在窗口上时每帧调，要便宜。 */
  windowRect(hwnd: number): Rect | null;
  /** 光标位置（GetCursorPos，物理像素） */
  cursorPos(): Point;
  /** 鼠标左键现在是不是按着（GetAsyncKeyState(VK_LBUTTON)，按主按钮交换设置换算） */
  leftButtonDown(): boolean;
  /** 前台窗口句柄，没有返回 0 */
  foregroundWindow(): number;
  /** 前台窗口和它的进程：句柄、exe 文件名（打不开进程时空串）、pid、窗口类名；没有前台窗口 null（N8.1 勿扰名单） */
  foregroundApp(): {hwnd: number; exe: string; pid: number; className: string} | null;
  /** Windows 的勿扰 / 专注助手：0 关、1 只要优先通知、2 只要闹钟；读不到 null（未公开的 WNF 状态，见 win32.ts 开头；N8.1） */
  quietHours(): number | null;
  /** SHQueryUserNotificationState */
  notificationState(): NotificationState;
  /** 兜底的全屏检测：前台窗口的可见矩形盖满它所在显示器的 bounds（桌面、任务栏本身不算） */
  foregroundIsFullscreen(displays: readonly DisplayInfo[]): boolean;
  /** Read the native topmost flag; it does not guarantee the actual z order is correct. */
  isTopmost(hwnd:number):boolean;
  /** Reassert a window's native topmost ordering without activation, optionally below an existing topmost cover. */
  restoreTopmost(hwnd:number,below?:number|null):boolean;
  /** 把 pet 插到 target 正下方（SetWindowPos，SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE）。阶段 2 躲窗口用 */
  placeBelow(pet: number, target: number): boolean;
  /** z 序在 hwnd 上面的所有顶层窗口，最近的在前（被盖住的反应：覆盖窗口上面压着谁，docs/desktop-interaction.md §2.7） */
  windowsAbove(hwnd: number): number[];
  /** pet 是不是紧挨在 target 的 z 序下面（躲藏层窗口用：不是就重新 placeBelow） */
  isDirectlyBelow(pet: number, target: number): boolean;
  /**
   * 把 pet 插到 target 正上方（N2.4 在窗口里面那一层，2026-10-21）：插到 target 上面那个窗口的下面；target 上面没有窗口、
   * 或者是置顶窗口（target 已经是普通窗口里最上面的）时用 HWND_TOP（普通窗口的最上面）。不动 target 自己的 z 序
   */
  placeAbove(pet: number, target: number): boolean;
  /** pet 是不是紧挨在 target 的 z 序上面 */
  isDirectlyAbove(pet: number, target: number): boolean;
  /**
   * 桌宠自己的窗口 win 里接收点击的 Chromium 子窗口不可见时把它显示出来，返回动没动过。
   * 舞台要接收点击（光标在角色上、关掉穿透）时调：窗口藏过一次以后 Chromium 不会自己把它放出来，见 win32.ts。
   */
  showInputChild(win: number): boolean;
  /**
   * 收顶层窗口的变化（SetWinEventHook，WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS：桌宠自己进程的不收）：切前台、用户拖 / 拉窗口
   * 开始和结束、最小化 / 还原、关闭、显示 / 隐藏、cloak / uncloak 全局收；位置变化只收 followLocations 给的进程的。
   * 只给窗口本身的（idObject = OBJID_WINDOW、idChild = 0），关闭以外的只给根窗口（GetAncestor GA_ROOT 是它自己）。
   * onEvent 是主线程的消息循环直接调进来的，不在 libuv 的回调里：2026-10-21 实测（temp/check/winevent-wake.ts）回调里排的
   * setTimeout(0) 约 14 毫秒后执行、setImmediate 0.1 毫秒，Promise 要等到下一个 JS 任务（最长等了近 2 秒）——所以 onEvent 里只记一下、
   * 用定时器叫醒主循环，别做重活、别靠 Promise。要在有消息循环的线程上调（Electron 主进程可以）
   */
  watchWindows(onEvent: (e: WinEvent) => void): WindowWatch;
}

export {createWin32Platform, ensurePerMonitorDpiAware} from './win32.ts';
// 桌面图标那一层（R2.5 躲在图标后面）：【待定，没接入】用户 2026-10-21 定先不做，接口留着（desktop.ts 开头）
export {attachToDesktop, attachedToDesktop, desktopIcons, placeInDesktop, type DesktopIcon} from './desktop.ts';
