// 各模块共用的数据类型（只放类型，不放逻辑）。
//
// 坐标约定（design.md §6）：world/、behavior/、platform/ 里的位置一律是**物理像素**，原点是 Windows 虚拟屏幕的原点
// （主显示器左上角），和 Win32（按每显示器 DPI 感知 v2 运行时）给的坐标一致。只有和 Electron 窗口 API 交界的地方
// （main/ 里）才换算成 DIP。y 轴向下。
//
// 写法限制：只用 Node 类型擦除支持的语法（不用 enum、namespace、参数属性），import 带 .ts 后缀。

/** 矩形，物理像素；right、bottom 不含（宽 = right - left）。 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 一个显示器。bounds、workArea 是物理像素；scale 是 Windows 缩放比（200% = 2）。 */
export interface DisplayInfo {
  id: number;
  bounds: Rect;
  /** 去掉任务栏后的工作区；任务栏自动隐藏时等于 bounds */
  workArea: Rect;
  scale: number;
}

/** 一个“用户看得见的”顶层窗口（platform 已经过滤过：可见、非最小化、非 cloaked、非工具窗、非桌宠自己……）。 */
export interface WinInfo {
  hwnd: number;
  pid: number;
  title: string;
  className: string;
  /** DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)：可见边界，物理像素 */
  rect: Rect;
  /** WS_EX_TOPMOST */
  topmost: boolean;
}

/** 某一时刻的桌面。windows 按 z 序从上到下排（EnumWindows 的顺序）。 */
export interface DesktopSnapshot {
  displays: DisplayInfo[];
  windows: WinInfo[];
  /**
   * 每个显示器的覆盖窗口（最前面那层）上面压着的别的窗口：显示器 id → hwnd（z 序在覆盖窗口上面的，一般是别的程序的置顶窗口）。
   * 被盖住的反应用（docs/desktop-interaction.md §2.7，2026-10-21）；没给当作没有
   */
  overlayAbove?: Readonly<Record<number, readonly number[]>>;
}

/**
 * 顶层窗口的一个变化（SetWinEventHook 收到的，design.md §6，2026-10-21 起代替轮询）。kind 对应的系统事件：
 * foreground EVENT_SYSTEM_FOREGROUND、move-size-start / end EVENT_SYSTEM_MOVESIZESTART / END（用户拖 / 拉窗口的那段）、
 * minimize / restore EVENT_SYSTEM_MINIMIZESTART / END、destroy / show / hide EVENT_OBJECT_DESTROY / SHOW / HIDE、
 * location EVENT_OBJECT_LOCATIONCHANGE、cloak / uncloak EVENT_OBJECT_CLOAKED / UNCLOAKED
 */
export interface WinEvent {
  kind: 'foreground' | 'move-size-start' | 'move-size-end' | 'minimize' | 'restore' | 'destroy' | 'show' | 'hide' | 'location' | 'cloak' | 'uncloak';
  hwnd: number;
}

/**
 * SHQueryUserNotificationState 的结果（design.md §6、调研报告 §4.1）。
 * busy / d3d-fullscreen / presentation 当作“全屏，隐藏桌宠”；app 不算全屏。
 */
export type NotificationState =
  | 'not-present'
  | 'busy'
  | 'd3d-fullscreen'
  | 'presentation'
  | 'accepts-notifications'
  | 'quiet-time'
  | 'app'
  | 'unknown';
