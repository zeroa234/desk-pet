// platform/desktop.ts —— 桌面图标那一层（docs/desktop-interaction.md §2.2 的 wallpaper 层、§2.5 躲在图标后面，2026-10-21）。
// 【待定，没接入】用户 2026-10-21：图标层先不做（没必要，以后想做再做），接口留着、功能先不接。main.ts / sim.ts 都没用这里的函数；
// 要接的时候照 desktop-interaction.md §2.2、§2.5 的做法（层 wallpaper、每个显示器一个挂在桌面里的窗口、按图标挪开判被发现）。
// 这份是当时正式功能开的头，从会话记录里原样找回来的；desktopIcons 当时在本机试过（43 个图标 5 毫秒），挂窗口的三个函数没在
// 正式窗口上跑过（最小样 scripts/probe-wallpaper.ts 里是同一套做法、自己的一份代码）。
//   1. 读桌面图标的位置：桌面图标是 explorer 里的 SysListView32（Progman → SHELLDLL_DefView → SysListView32；旧桌面 DefView 可能在
//      某个顶层 WorkerW 下面）。用公开的 list-view 消息 LVM_GETITEMCOUNT / LVM_GETITEMRECT（LVIR_ICON 图标、LVIR_LABEL 文字）
//      拿每个图标的矩形；消息的 RECT 要在 explorer 进程里，所以在它里面分配一小块内存来回读写（跨进程读 list-view 的常规做法，
//      只读，不改图标）。SendMessageTimeout 带 SMTO_ABORTIFHUNG，explorer 卡住不等。
//   2. 把桌宠的透明窗口挂到图标和壁纸之间：新桌面（Progman 带 WS_EX_NOREDIRECTIONBITMAP，Windows 11 24H2 起）照 Lively 的
//      TryAttachToDesktop（src/Lively/Lively/Core/WinDesktopCore.cs，GPL-3.0，只参考做法）：给 Progman 发 0x052C 生出画壁纸的
//      WorkerW 子窗口；窗口加 WS_EX_LAYERED + SetLayeredWindowAttributes(255)（在 SetParent 之前），WS_POPUP 换 WS_CHILD，
//      SetParent(Progman)，插在 DefView 下面，WorkerW 放到最下面。旧桌面挂到 0x052C 生出来的那个顶层 WorkerW（Lively 的另一条路，
//      本机没有旧桌面，没测）。2026-10-21 最小样实测见 scripts/probe-wallpaper.ts。
// 坐标都是物理像素（进程是每显示器 DPI 感知）。自写；FFI 用 koffi。
import koffi from 'koffi';
import type {Rect} from '../shared/types.ts';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const POINT = koffi.struct('DESK_POINT', {x: 'long', y: 'long'});
const findWindowW = user32.func('uintptr_t __stdcall FindWindowW(const char16_t *cls, const char16_t *title)');
const findWindowExW = user32.func('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, const char16_t *cls, const char16_t *title)');
const getWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t h, int i)');
const setWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(uintptr_t h, int i, intptr_t v)');
const setParent = user32.func('uintptr_t __stdcall SetParent(uintptr_t child, uintptr_t parent)');
const getParent = user32.func('uintptr_t __stdcall GetParent(uintptr_t h)');
const setWindowPos = user32.func('bool __stdcall SetWindowPos(uintptr_t h, intptr_t after, int x, int y, int cx, int cy, uint flags)');
const getWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t h, uint cmd)');
const isWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t h)');
const setLayeredWindowAttributes = user32.func('bool __stdcall SetLayeredWindowAttributes(uintptr_t h, uint32_t key, uint8_t alpha, uint32_t flags)');
const sendMessageTimeoutW = user32.func('intptr_t __stdcall SendMessageTimeoutW(uintptr_t h, uint msg, uintptr_t w, intptr_t l, uint flags, uint timeout, _Out_ uintptr_t *res)');
const getWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)');
const clientToScreen = user32.func('bool __stdcall ClientToScreen(uintptr_t h, _Inout_ DESK_POINT *p)');
const openProcess = kernel32.func('uintptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
const closeHandle = kernel32.func('bool __stdcall CloseHandle(uintptr_t h)');
const virtualAllocEx = kernel32.func('uintptr_t __stdcall VirtualAllocEx(uintptr_t proc, uintptr_t addr, size_t size, uint32_t type, uint32_t protect)');
const virtualFreeEx = kernel32.func('bool __stdcall VirtualFreeEx(uintptr_t proc, uintptr_t addr, size_t size, uint32_t type)');
const writeProcessMemory = kernel32.func('bool __stdcall WriteProcessMemory(uintptr_t proc, uintptr_t addr, const uint8_t *buf, size_t n, _Out_ size_t *done)');
const readProcessMemory = kernel32.func('bool __stdcall ReadProcessMemory(uintptr_t proc, uintptr_t addr, _Out_ uint8_t *buf, size_t n, _Out_ size_t *done)');

const num = (v: unknown) => typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
const WS_EX_NOREDIRECTIONBITMAP = 0x00200000, WS_EX_LAYERED = 0x00080000;
const WS_POPUP = 0x80000000, WS_CHILD = 0x40000000;
const SMTO_ABORTIFHUNG = 0x2, SMTO_BLOCK = 0x1;
const LVM_GETITEMCOUNT = 0x1004, LVM_GETITEMRECT = 0x100E, LVIR_ICON = 1, LVIR_LABEL = 2;
const PROCESS_VM_OPERATION = 0x8, PROCESS_VM_READ = 0x10, PROCESS_VM_WRITE = 0x20;
const MEM_COMMIT_RESERVE = 0x3000, MEM_RELEASE = 0x8000, PAGE_READWRITE = 4;

/** 桌面那几个窗口：Progman、图标的 SHELLDLL_DefView 和 SysListView32、是不是新桌面 */
function desktopWindows(): {progman: number; defView: number; listView: number; raised: boolean} | null {
  const progman = num(findWindowW('Progman', null));
  if (!progman) return null;
  let defView = num(findWindowExW(progman, 0, 'SHELLDLL_DefView', null));
  // 旧桌面（或者开了壁纸轮播）DefView 可能挂在某个顶层 WorkerW 下面
  for (let w = num(findWindowExW(0, 0, 'WorkerW', null)); !defView && w; w = num(findWindowExW(0, w, 'WorkerW', null))) {
    defView = num(findWindowExW(w, 0, 'SHELLDLL_DefView', null));
  }
  if (!defView) return null;
  return {progman, defView, listView: num(findWindowExW(defView, 0, 'SysListView32', null)),
    raised: (num(getWindowLongPtrW(progman, -20)) & WS_EX_NOREDIRECTIONBITMAP) !== 0};
}

export interface DesktopIcon {
  /** 图标图像的矩形（LVIR_ICON） */
  icon: Rect;
  /** 文字的矩形（LVIR_LABEL，没选中时最多两行） */
  label: Rect;
}

/**
 * 桌面图标的矩形（屏幕物理像素）。桌面图标隐藏了（list-view 不可见）返回 []；找不到桌面、打不开 explorer 进程、explorer 卡住返回 null。
 */
export function desktopIcons(): DesktopIcon[] | null {
  const d = desktopWindows();
  if (!d || !d.listView) return null;
  if (!isWindowVisible(d.listView)) return [];
  const res: [bigint] = [0n];
  if (!num(sendMessageTimeoutW(d.listView, LVM_GETITEMCOUNT, 0, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 200, res))) return null;
  const n = Math.min(num(res[0]), 2048);
  if (n <= 0) return [];
  const pid: [number] = [0];
  getWindowThreadProcessId(d.listView, pid);
  const proc = num(openProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE, false, pid[0]));
  if (!proc) return null;
  const size = n * 2 * 16;
  const remote = num(virtualAllocEx(proc, 0, size, MEM_COMMIT_RESERVE, PAGE_READWRITE));
  try {
    if (!remote) return null;
    // 每个图标两个 RECT：left 填 LVIR_ICON / LVIR_LABEL（LVM_GETITEMRECT 的约定），一次写过去，逐个发消息，一次读回来
    const buf = Buffer.alloc(size);
    for (let i = 0; i < n; i++) { buf.writeInt32LE(LVIR_ICON, i * 32); buf.writeInt32LE(LVIR_LABEL, i * 32 + 16); }
    const done: [bigint] = [0n];
    if (!writeProcessMemory(proc, remote, buf, size, done)) return null;
    for (let i = 0; i < n; i++) {
      for (const k of [0, 1]) {
        if (!num(sendMessageTimeoutW(d.listView, LVM_GETITEMRECT, i, remote + i * 32 + k * 16, SMTO_ABORTIFHUNG | SMTO_BLOCK, 200, res))) return null;
      }
    }
    if (!readProcessMemory(proc, remote, buf, size, done)) return null;
    // list-view 的客户区坐标 → 屏幕坐标
    const origin = {x: 0, y: 0};
    clientToScreen(d.listView, origin);
    const rectAt = (off: number): Rect => ({left: buf.readInt32LE(off) + origin.x, top: buf.readInt32LE(off + 4) + origin.y,
      right: buf.readInt32LE(off + 8) + origin.x, bottom: buf.readInt32LE(off + 12) + origin.y});
    const out: DesktopIcon[] = [];
    for (let i = 0; i < n; i++) out.push({icon: rectAt(i * 32), label: rectAt(i * 32 + 16)});
    return out;
  } finally {
    if (remote) virtualFreeEx(proc, remote, 0, MEM_RELEASE);
    closeHandle(proc);
  }
}

/**
 * 把桌宠的窗口 hwnd 挂到图标和壁纸之间，摆到 rect（屏幕物理像素）。成功返回 true。
 * 新桌面：子窗口，坐标换成 Progman 客户区的；旧桌面：挂到 0x052C 生出来的顶层 WorkerW 下面（没测）。
 */
export function attachToDesktop(hwnd: number, rect: Rect): boolean {
  const d = desktopWindows();
  if (!d) return false;
  const res: [bigint] = [0n];
  sendMessageTimeoutW(d.progman, 0x052C, 0xD, 1, SMTO_ABORTIFHUNG, 1000, res);
  const ex = num(getWindowLongPtrW(hwnd, -20)), style = num(getWindowLongPtrW(hwnd, -16));
  setWindowLongPtrW(hwnd, -20, (ex | WS_EX_LAYERED) >>> 0);
  setLayeredWindowAttributes(hwnd, 0, 255, 2);   // LWA_ALPHA
  setWindowLongPtrW(hwnd, -16, ((style & ~WS_POPUP) | WS_CHILD) >>> 0);
  let parent = d.progman;
  if (!d.raised) {
    // 旧桌面：有 DefView 的那个顶层窗口后面的 WorkerW（Lively：EnumWindows 找 DefView 的父窗口，取它后面的 WorkerW）
    const host = num(getParent(d.defView));
    parent = num(findWindowExW(0, host, 'WorkerW', null)) || d.progman;
  }
  if (!num(setParent(hwnd, parent))) return false;
  placeInDesktop(hwnd, rect);
  return num(getParent(hwnd)) === parent;
}

/** 已经挂上去的窗口：摆到 rect（屏幕物理像素），z 序放回 DefView 下面（新桌面），WorkerW 放到最下面 */
export function placeInDesktop(hwnd: number, rect: Rect): void {
  const d = desktopWindows();
  if (!d) return;
  const parent = num(getParent(hwnd)), origin = {x: 0, y: 0};
  clientToScreen(parent, origin);
  const after = d.raised ? d.defView : 0;
  setWindowPos(hwnd, after, rect.left - origin.x, rect.top - origin.y, rect.right - rect.left, rect.bottom - rect.top, 0x0010 | 0x0040 | (d.raised ? 0 : 0x0004));
  if (d.raised) {
    const workerW = num(findWindowExW(d.progman, 0, 'WorkerW', null));
    if (workerW) setWindowPos(workerW, 1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);   // HWND_BOTTOM，SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
  }
}

/** 窗口还挂在桌面上、新桌面时紧挨在 DefView 下面（explorer 重启以后父窗口没了，窗口也跟着没了） */
export function attachedToDesktop(hwnd: number): boolean {
  const d = desktopWindows();
  if (!d) return false;
  const parent = num(getParent(hwnd));
  if (d.raised) return parent === d.progman && num(getWindow(d.defView, 2)) === hwnd;
  return parent !== 0 && parent !== d.progman;
}
