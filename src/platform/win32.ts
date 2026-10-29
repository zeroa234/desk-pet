// platform/win32.ts —— Platform 接口的 Win32 实现：用 koffi 调 user32 / dwmapi / shell32。
//
// 坐标全部是物理像素：进程按“每显示器 DPI 感知 v2”运行时，DWM 的扩展边框本来就不做 DPI 虚拟化，
// GetWindowRect 也不再被虚拟化（见 reports/research-2026-10-20/win32-platform.md §1）。
// 纯 Node 脚本要先调 ensurePerMonitorDpiAware()；Electron 里进程已经是这个模式，再调会返回 FALSE，忽略即可。
//
// 窗口过滤照 PowerToys FancyZones 的 DefineWindowType（同上 §2.2），矩形用 DWMWA_EXTENDED_FRAME_BOUNDS。
// 窗口事件（2026-10-21）：SetWinEventHook 用 WINEVENT_OUTOFCONTEXT，回调由装钩子的线程（Electron 主线程）的消息循环调进来，
// 做法和要注意的见 reports/research-2026-10-20/win32-platform.md §3.5–§3.6、index.ts 的 watchWindows。
// 勿扰（N8.1，2026-10-21）：Windows 的勿扰 / 专注助手没有公开接口，读的是未公开的 WNF 状态
// WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED（ntdll NtQueryWnfStateData，做法照 Rafael Rivera 的 gist
// https://gist.github.com/riverar/980120d7e3a13ed8b1d665cf974c8e31 ，Windows 10 1803 起；读不到就当没开）。
// 自写；FFI 用 koffi 3.3.2（MIT，https://koffi.dev/）。
import koffi from 'koffi';
import type {DisplayInfo, NotificationState, Point, Rect, WinEvent, WinInfo} from '../shared/types.ts';
import type {Platform, WindowWatch} from './index.ts';

// ---------------------------------------------------------------- koffi 声明
// 全部在模块加载时声明一次；函数和回调都复用，不在调用路径上重新声明。

const user32 = koffi.load('user32.dll');
const dwmapi = koffi.load('dwmapi.dll');
const shell32 = koffi.load('shell32.dll');
const kernel32 = koffi.load('kernel32.dll');
const ntdll = koffi.load('ntdll.dll');

const RECT = koffi.struct('RECT', {left: 'long', top: 'long', right: 'long', bottom: 'long'});
const POINT = koffi.struct('POINT', {x: 'long', y: 'long'});
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(uintptr_t hwnd, intptr_t lParam)');

const enumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)');
const isWindow = user32.func('bool __stdcall IsWindow(uintptr_t hwnd)');
const isWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hwnd)');
const isIconic = user32.func('bool __stdcall IsIconic(uintptr_t hwnd)');
const getAncestor = user32.func('uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint flags)');
const getWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)');
const getWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hwnd, _Out_ uint16_t *buf, int max)');
const getClassNameW = user32.func('int __stdcall GetClassNameW(uintptr_t hwnd, _Out_ uint16_t *buf, int max)');
const getWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)');
const getWindowRect = user32.func('bool __stdcall GetWindowRect(uintptr_t hwnd, _Out_ RECT *rect)');
const getCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *point)');
const getAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vk)');
const getSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');
const getForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
const getWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hwnd, uint cmd)');
const setWindowPos = user32.func('bool __stdcall SetWindowPos(uintptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint flags)');
const setProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t context)');
const findWindowExW = user32.func('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, const char16_t *cls, const char16_t *title)');
const showWindow = user32.func('bool __stdcall ShowWindow(uintptr_t hwnd, int cmd)');
const WinEventProc = koffi.proto('void __stdcall WinEventProc(uintptr_t hook, uint32_t event, uintptr_t hwnd, long idObject, long idChild, uint32_t thread, uint32_t time)');
const setWinEventHook = user32.func('uintptr_t __stdcall SetWinEventHook(uint32_t min, uint32_t max, uintptr_t mod, WinEventProc *cb, uint32_t pid, uint32_t tid, uint32_t flags)');
const unhookWinEvent = user32.func('bool __stdcall UnhookWinEvent(uintptr_t hook)');

// 同一个 DwmGetWindowAttribute 按输出类型声明两次：矩形（EXTENDED_FRAME_BOUNDS）和 DWORD（CLOAKED）。
const dwmGetRect = dwmapi.func('long __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint attr, _Out_ RECT *rect, uint size)');
const dwmGetU32 = dwmapi.func('long __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint attr, _Out_ uint32_t *value, uint size)');

const shQueryUserNotificationState = shell32.func('long __stdcall SHQueryUserNotificationState(_Out_ int *state)');

const openProcess = kernel32.func('uintptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
const queryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(uintptr_t process, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)');
const closeHandle = kernel32.func('bool __stdcall CloseHandle(uintptr_t handle)');
const ntQueryWnfStateData = ntdll.func('long __stdcall NtQueryWnfStateData(_In_ uint32_t *name, void *typeId, void *scope, _Out_ uint32_t *stamp, _Out_ uint32_t *buf, _Inout_ uint32_t *size)');

// ---------------------------------------------------------------- 常量

const GA_ROOT = 2;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;

const WS_POPUP = 0x80000000;
const WS_THICKFRAME = 0x00040000;
const WS_CAPTION = 0x00c00000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_TOPMOST = 0x00000008;

const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;

const SM_SWAPBUTTON = 23;
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOOWNERZORDER = 0x0200;
const SW_SHOWNA = 8;
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;

/**
 * 桌面、任务栏和系统的全屏浮层：不是可站 / 可躲的窗口，在前台时也不算“全屏应用”。
 * XamlExplorerHostIslandWindow：Win11 点任务栏切换窗口、Alt+Tab、任务视图时 explorer 弹出的整屏宿主窗口，会短暂当前台
 * （2026-10-20 本机实测：点任务栏时它 0,0,2560,1600 当了约 1 秒前台，桌宠被当成全屏隐藏、闪一下）。
 * MultitaskingViewFrame / TaskSwitcherWnd / ForegroundStaging 是 Win10 和经典 Alt+Tab、任务视图对应的窗口类，本机没出现过，一起排除。
 */
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'XamlExplorerHostIslandWindow', 'MultitaskingViewFrame', 'TaskSwitcherWnd', 'ForegroundStaging']);

// ---------------------------------------------------------------- 小工具

/** koffi 的句柄/指针类型可能返回 BigInt（超出安全整数范围时）或 null，统一成 JS number。 */
function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

/** 窗口样式是 DWORD；GetWindowLongPtrW 可能把它符号扩展成 64 位，截回 32 位无符号。 */
function asU32(value: unknown): number {
  return asNumber(value) >>> 0;
}

// 标题/类名缓冲区复用，避免每次 listWindows 给每个窗口分配内存。
const titleBuf = Buffer.alloc(1024); // 512 个 UTF-16 码元
const classBuf = Buffer.alloc(512); // 256 个

/**
 * 标题用 GetWindowTextW。官方 Remarks：只有窗口属于当前进程时才会发 WM_GETTEXT；属于别的进程时直接读
 * caption，“This behavior is by design. It allows applications to call GetWindowText without becoming
 * unresponsive if the process that owns the target window is not responding.”——所以对别人的窗口不会阻塞。
 * https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowtextw
 */
function readTitle(hwnd: number): string {
  const len = getWindowTextW(hwnd, titleBuf, 512);
  return len > 0 ? koffi.decode(titleBuf, 'char16', len) : '';
}

function readClassName(hwnd: number): string {
  const len = getClassNameW(hwnd, classBuf, 256);
  return len > 0 ? koffi.decode(classBuf, 'char16', len) : '';
}

function readPid(hwnd: number): number {
  const out: [number] = [0];
  return getWindowThreadProcessId(hwnd, out) ? out[0] : 0;
}

function readStyle(hwnd: number, index: number): number {
  return asU32(getWindowLongPtrW(hwnd, index));
}

/**
 * DWMWA_CLOAKED 非 0 即 cloaked（DWM_CLOAKED_APP/SHELL/INHERITED 是位掩码，组合值也可能出现）。
 * 查询失败（老系统）按“没被 cloak”处理，不要因此丢窗口。
 */
function isCloaked(hwnd: number): boolean {
  const value: [number] = [0];
  if (dwmGetU32(hwnd, DWMWA_CLOAKED, value, 4) < 0) return false;
  return value[0] !== 0;
}

/** 用户看到的窗口矩形：DWM 扩展边框（物理像素）；失败时退回 GetWindowRect。 */
function visibleRect(hwnd: number): Rect | null {
  const rect = {left: 0, top: 0, right: 0, bottom: 0};
  if (dwmGetRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, koffi.sizeof(RECT)) >= 0) {
    return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom};
  }
  if (!getWindowRect(hwnd, rect)) return null;
  return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom};
}

/**
 * 弹出窗口规则，从 FancyZones 的“无粗边框弹窗”改来：菜单、开始菜单、托盘弹窗、提示条都是 WS_POPUP 且没有标题栏，过滤掉；
 * 带标题栏的弹出窗口（MessageBox 等对话框，本机实测 #32770 是 WS_POPUP|WS_CAPTION、无 thick frame）是用户看得见的真窗口，
 * 桌宠可以站在上面，保留（FancyZones 管的是吸附布局，它要求 thick frame，我们不需要）；有粗边框且带最小化/最大化按钮的也保留。
 */
function isFramelessPopup(style: number): boolean {
  if ((style & WS_POPUP) === 0) return false;
  const thickFrame = (style & WS_THICKFRAME) !== 0;
  const caption = (style & WS_CAPTION) === WS_CAPTION;
  const minMax = (style & (WS_MINIMIZEBOX | WS_MAXIMIZEBOX)) !== 0;
  return !(caption || (thickFrame && minMax));
}

// ---------------------------------------------------------------- 枚举与过滤

let enumSink: number[] | null = null;

// 持久注册的回调：EnumWindows 是同步的，回调只在调用期间被调用；注册一次、复用，避免每次调用都建 trampoline。
const enumCallback = koffi.register((hwnd: number | bigint): boolean => {
  enumSink?.push(asNumber(hwnd));
  return true;
}, 'EnumWindowsProc *');

/** EnumWindows 的顺序就是 z 序（从上到下）。 */
function enumTopLevel(): number[] {
  const hwnds: number[] = [];
  enumSink = hwnds;
  try {
    enumWindows(enumCallback, 0);
  } finally {
    enumSink = null;
  }
  return hwnds;
}

type FilterResult = {ok: true; win: WinInfo} | {ok: false; reason: string};

/**
 * 按 index.ts 注释里的顺序过滤。pid 在取标题之前比较（标题只对留下来的窗口取）；
 * 这里把 pid/类名放在 DWM 矩形之前，省掉对桌宠自己窗口和桌面/任务栏的几何查询。
 * 有 owner 的窗口（对话框）不检查 owner，保留——“桌宠可以站在对话框上”。
 */
function evaluate(hwnd: number, excludePids: ReadonlySet<number>): FilterResult {
  // EnumWindows 回调之后窗口可能已经销毁，先复核一遍（IsWindow 很便宜）。
  if (!isWindow(hwnd)) return {ok: false, reason: '已销毁'};
  if (!isWindowVisible(hwnd)) return {ok: false, reason: '不可见'};
  if (isIconic(hwnd)) return {ok: false, reason: '最小化'};
  if (isCloaked(hwnd)) return {ok: false, reason: 'cloaked'};

  const exStyle = readStyle(hwnd, GWL_EXSTYLE);
  if ((exStyle & WS_EX_TOOLWINDOW) !== 0) return {ok: false, reason: '工具窗'};
  if (asNumber(getAncestor(hwnd, GA_ROOT)) !== hwnd) return {ok: false, reason: '非根窗口'};
  if (isFramelessPopup(readStyle(hwnd, GWL_STYLE))) return {ok: false, reason: '无粗边框弹窗'};

  const pid = readPid(hwnd);
  if (excludePids.has(pid)) return {ok: false, reason: 'excludePids'};

  const className = readClassName(hwnd);
  if (SHELL_CLASSES.has(className)) return {ok: false, reason: '桌面/任务栏'};

  const rect = visibleRect(hwnd);
  if (!rect || rect.right <= rect.left || rect.bottom <= rect.top) return {ok: false, reason: '空矩形'};

  const title = readTitle(hwnd);
  return {ok: true, win: {hwnd, pid, title, className, rect, topmost: (exStyle & WS_EX_TOPMOST) !== 0}};
}

/** 调试用（不进 Platform 接口）：列出被过滤掉的可见顶层窗口和原因。 */
export interface WindowExplanation {
  hwnd: number;
  pid: number;
  className: string;
  title: string;
  reason: string;
}

export function explainWindows(excludePids: readonly number[] = []): WindowExplanation[] {
  const excluded = new Set(excludePids);
  const rows: WindowExplanation[] = [];
  for (const hwnd of enumTopLevel()) {
    const result = evaluate(hwnd, excluded);
    if (result.ok) continue;
    if (result.reason === '不可见' || result.reason === '已销毁') continue; // 只解释用户看得见、还活着的窗口
    const pid = readPid(hwnd);
    rows.push({
      hwnd,
      pid,
      className: readClassName(hwnd),
      title: excluded.has(pid) ? '' : readTitle(hwnd), // 和 listWindows 一致：pid 过滤在取标题之前
      reason: result.reason,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- Platform 方法

function listWindows(excludePids: readonly number[]): WinInfo[] {
  const excluded = new Set(excludePids);
  const wins: WinInfo[] = [];
  for (const hwnd of enumTopLevel()) {
    const result = evaluate(hwnd, excluded);
    if (result.ok) wins.push(result.win);
  }
  return wins;
}

// 站在窗口上时每帧都调：3 次 user32 查询 + 2 次 DWM 查询，失败早退，不碰标题/类名。
function windowRect(hwnd: number): Rect | null {
  if (!isWindow(hwnd) || !isWindowVisible(hwnd) || isIconic(hwnd)) return null;
  if (isCloaked(hwnd)) return null;
  return visibleRect(hwnd);
}

function cursorPos(): Point {
  const point = {x: 0, y: 0};
  if (!getCursorPos(point)) return {x: 0, y: 0};
  return {x: point.x, y: point.y};
}

/**
 * GetAsyncKeyState 查的是**物理**按键：“GetAsyncKeyState(VK_LBUTTON) always returns the state of the
 * left physical mouse button, regardless of whether it is mapped to the left or right logical mouse button.
 * You can determine the system's current mapping ... by calling GetSystemMetrics(SM_SWAPBUTTON), which
 * returns TRUE if the mouse buttons have been swapped.”（GetAsyncKeyState 官方文档 Remarks）
 * 所以主按钮 = 未交换时的物理左键、交换后的物理右键。
 * https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getasynckeystate
 */
function leftButtonDown(): boolean {
  const vk = getSystemMetrics(SM_SWAPBUTTON) !== 0 ? VK_RBUTTON : VK_LBUTTON;
  return (getAsyncKeyState(vk) & 0x8000) !== 0;
}

function foregroundWindow(): number {
  return asNumber(getForegroundWindow());
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const exeBuf = Buffer.alloc(1024 * 2);
/** 前台窗口和它的进程（N8.1 勿扰名单用）：句柄、exe 文件名、pid、窗口类名；没有前台窗口、或者打不开进程（权限更高的进程）时 exe 是空串 */
function foregroundApp(): {hwnd: number; exe: string; pid: number; className: string} | null {
  const hwnd = foregroundWindow();
  if (!hwnd) return null;
  const pid = readPid(hwnd), className = readClassName(hwnd);
  let exe = '';
  const h = pid ? asNumber(openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)) : 0;
  if (h) {
    const size: [number] = [1024];
    if (queryFullProcessImageNameW(h, 0, exeBuf, size)) exe = koffi.decode(exeBuf, 'char16', size[0]).split(/[\\/]/).pop() ?? '';
    closeHandle(h);
  }
  return {hwnd, exe, pid, className};
}

/** WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED（见文件开头）：0 关、1 只要优先通知、2 只要闹钟；读不到 null */
const WNF_QUIET_HOURS = [0xA3BF1C75, 0x0D83063E];
function quietHours(): number | null {
  const stamp: [number] = [0], buf: [number] = [0], size: [number] = [4];
  try {
    return ntQueryWnfStateData(WNF_QUIET_HOURS, null, null, stamp, buf, size) >= 0 ? buf[0] : null;
  } catch {
    return null;
  }
}

const NOTIFICATION_STATES: Record<number, NotificationState> = {
  1: 'not-present',
  2: 'busy',
  3: 'd3d-fullscreen',
  4: 'presentation',
  5: 'accepts-notifications',
  6: 'quiet-time',
  7: 'app',
};

function notificationState(): NotificationState {
  const state: [number] = [0];
  if (shQueryUserNotificationState(state) < 0) return 'unknown';
  return NOTIFICATION_STATES[state[0]] ?? 'unknown';
}

/**
 * 兜底全屏检测（调研报告 §7.2）：前台窗口的可见矩形盖满它中心所在显示器的 bounds。
 * 用 rcMonitor 而不是工作区（最大化普通窗口 = 工作区，不算全屏）；留 2px 容差处理圆角/边框。
 */
function foregroundIsFullscreen(displays: readonly DisplayInfo[]): boolean {
  const hwnd = foregroundWindow();
  if (!hwnd || isIconic(hwnd)) return false;
  if (SHELL_CLASSES.has(readClassName(hwnd))) return false;
  const rect = visibleRect(hwnd);
  if (!rect) return false;

  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  const display = displays.find(d => cx >= d.bounds.left && cx < d.bounds.right && cy >= d.bounds.top && cy < d.bounds.bottom);
  if (!display) return false;

  const tol = 2;
  const b = display.bounds;
  return rect.left <= b.left + tol && rect.top <= b.top + tol && rect.right >= b.right - tol && rect.bottom >= b.bottom - tol;
}

function isTopmost(hwnd:number):boolean {
  return !!isWindow(hwnd) && (readStyle(hwnd,GWL_EXSTYLE)&WS_EX_TOPMOST)!==0;
}
function restoreTopmost(hwnd:number,below:number|null=null):boolean {
  if(!isWindow(hwnd))return false;
  const anchor=below && below!==hwnd && isTopmost(below)?below:-1; // HWND_TOPMOST
  const flags=SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_NOOWNERZORDER;
  // Inserting a non-topmost window after a topmost HWND does not promote its band.
  // Reassert the topmost band first, then preserve the legitimate cover in the same synchronous call.
  if(anchor!==-1 && !setWindowPos(hwnd,-1,0,0,0,0,flags))return false;
  return !!setWindowPos(hwnd,anchor,0,0,0,0,flags);
}

function placeBelow(pet: number, target: number): boolean {
  return !!setWindowPos(pet, target, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

/**
 * z 序在 hwnd 上面的所有顶层窗口（GetWindow GW_HWNDPREV = 3 一路往上，最近的在前）。覆盖窗口是置顶的，它上面一般只有几个别的置顶窗口，
 * 很便宜；被盖住的反应用（docs/desktop-interaction.md §2.7）。最多走 512 个防止 z 序在走的时候变了绕圈
 */
function windowsAbove(hwnd: number): number[] {
  const out: number[] = [];
  for (let h = asNumber(getWindow(hwnd, 3)); h && out.length < 512; h = asNumber(getWindow(h, 3))) out.push(h);
  return out;
}

/** pet 是不是紧挨在 target 下面（GetWindow(target, GW_HWNDNEXT)，GW_HWNDNEXT = 2） */
function isDirectlyBelow(pet: number, target: number): boolean {
  return Number(getWindow(target, 2)) === pet;
}

/** 见 Platform.placeAbove；GW_HWNDPREV = 3，HWND_TOP = 0 */
function placeAbove(pet: number, target: number): boolean {
  const prev = Number(getWindow(target, 3));
  if (prev === pet) return true;
  const top = prev === 0 || (readStyle(prev, GWL_EXSTYLE) & WS_EX_TOPMOST) !== 0;
  return !!setWindowPos(pet, top ? 0 : prev, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

function isDirectlyAbove(pet: number, target: number): boolean {
  return Number(getWindow(target, 3)) === pet;
}

/**
 * Chromium 在 Windows 上给页面开的子窗口 Chrome_RenderWidgetHostHWND（LegacyRenderWidgetHostHWND，盖满客户区，真实点击落在它上面）
 * 不可见时把它显示出来；返回动没动过。
 * 为什么要这样（2026-10-20 实测 + 源码，Electron 44.5.1 / Chromium 152.0.7977.130）：页面设了 backgroundThrottling: false 时，
 * Electron 的 disable_hidden.patch 让窗口隐藏时页面不进“隐藏”状态；但 RenderWidgetHostViewAura::HideImpl() 末尾照样
 * legacy_render_widget_host_HWND_->Hide()，而重新显示时只有页面从“隐藏”恢复才走 UpdateLegacyWin() 把它 Show() 回来——
 * 于是窗口藏过一次（hide / showInactive，或被判遮挡 WasOccluded）以后这个子窗口一直不可见，点击落到外层 Chrome_WidgetWin_1，
 * 页面收不到 pointerdown。鼠标转发（setIgnoreMouseEvents 的 forward）是直接往这个子窗口 PostMessage，不管它可不可见，所以悬停照常。
 * LegacyRenderWidgetHostHWND::Show() 本身就只是 ::ShowWindow(hwnd, SW_SHOW)，这里用 SW_SHOWNA（不激活）做同一件事。
 * 主进程只拿它兜底：它不是 Chromium 完整的恢复路径（UpdateLegacyWin 还会重设父窗口和大小）；单靠它干净复测 6/6 能拎
 * （阶段 2 报告 §8）。正路是不让它被藏（src/main/main.ts 的 hideSurface、关遮挡检测）。
 */
function showInputChild(win: number): boolean {
  const child = asNumber(findWindowExW(win, 0, 'Chrome_RenderWidgetHostHWND', null));
  if (!child || isWindowVisible(child)) return false;
  showWindow(child, SW_SHOWNA);
  return true;
}

// ---------------------------------------------------------------- 窗口事件（design.md §6，2026-10-21 起代替轮询）

const WIN_EVENTS: Record<number, WinEvent['kind']> = {
  0x0003: 'foreground', 0x000A: 'move-size-start', 0x000B: 'move-size-end', 0x0016: 'minimize', 0x0017: 'restore',
  0x8001: 'destroy', 0x8002: 'show', 0x8003: 'hide', 0x800B: 'location', 0x8017: 'cloak', 0x8018: 'uncloak',
};
/** 全局收的几段（SetWinEventHook 一次收一段连续的事件号；分开装，免得把中间不要的焦点、选中、值变化之类的也收进来） */
const GLOBAL_RANGES: readonly [number, number][] = [[0x0003, 0x0003], [0x000A, 0x000B], [0x0016, 0x0017], [0x8001, 0x8003], [0x8017, 0x8018]];
const EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
const WINEVENT_OUTOFCONTEXT = 0x0000;
const WINEVENT_SKIPOWNPROCESS = 0x0002;
const OBJID_WINDOW = 0;

/** 见 Platform.watchWindows。回调注册一次（koffi.register），所有钩子共用，stop 时注销 */
function watchWindows(onEvent: (e: WinEvent) => void): WindowWatch {
  let raw = 0;
  const callback = koffi.register((_hook: unknown, event: number, hwnd: number | bigint, idObject: number, idChild: number): void => {
    raw++;
    try {
      const h = asNumber(hwnd), kind = WIN_EVENTS[event];
      if (!kind || !h || idObject !== OBJID_WINDOW || idChild !== 0) return;
      if (kind !== 'destroy' && asNumber(getAncestor(h, GA_ROOT)) !== h) return;   // 关掉的窗口已经查不了父窗口
      onEvent({kind, hwnd: h});
    } catch (e) {
      console.error('窗口事件回调出错', e);   // 异常不能抛回 koffi（这里不在 JS 调用里）
    }
  }, koffi.pointer(WinEventProc));
  const hook = (min: number, max: number, pid: number) => asNumber(setWinEventHook(min, max, 0, callback, pid, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS));
  const global = GLOBAL_RANGES.map(([min, max]) => hook(min, max, 0));
  if (global.some(h => !h)) console.warn('有的窗口事件钩子没装上（SetWinEventHook 返回 0），这几类变化只能等每秒一次的兜底枚举', GLOBAL_RANGES.filter((_, i) => !global[i]));
  const located = new Map<number, number>();   // pid → 钩子
  let stopped = false;
  return {
    get raw() { return raw; },
    followLocations(pids) {
      if (stopped) return;
      const want = new Set(pids.filter(p => p > 0));
      for (const [pid, h] of located) if (!want.has(pid)) { unhookWinEvent(h); located.delete(pid); }
      for (const pid of want) if (!located.has(pid)) { const h = hook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, pid); if (h) located.set(pid, h); }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const h of [...global, ...located.values()]) if (h) unhookWinEvent(h);
      located.clear();
      koffi.unregister(callback);
    },
  };
}

export function createWin32Platform(): Platform {
  return {
    listWindows,
    windowRect,
    cursorPos,
    leftButtonDown,
    foregroundWindow,
    foregroundApp,
    quietHours,
    notificationState,
    foregroundIsFullscreen,
    isTopmost,
    restoreTopmost,
    placeBelow,
    isDirectlyBelow,
    windowsAbove,
    placeAbove,
    isDirectlyAbove,
    showInputChild,
    watchWindows,
  };
}

/**
 * 设成 DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2。纯 Node 脚本必须在取坐标之前调用，否则
 * GetWindowRect / GetCursorPos 会被 DPI 虚拟化。Electron 进程已经是这个模式，调用会失败（FALSE），忽略。
 */
export function ensurePerMonitorDpiAware(): void {
  try {
    setProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  } catch {
    // Win10 1607 之前的系统没有这个 API；目标系统是 Win11，走不到这里。
  }
}
