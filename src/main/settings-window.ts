// 设置窗口（R8.8，2026-10-29 用户：设置界面“不是很符合 HCI & UX 的基本要求”，重做 + 双语）。
// 一个窗口放全部设置（以前分在托盘菜单和“LLM 统计与提示词”面板两处），按 Windows 11“设置”的样子：左边分类、右边卡片、Mica 背景、
// 自绘标题栏（系统的最小化 / 最大化 / 关闭按钮用 titleBarOverlay）。页面在 src/settings/，约定在 src/settings/protocol.ts。
// 这里只管窗口和 IPC；读快照、改设置、动作由宿主（main.ts，验收脚本里是假的宿主）实现。
// 用的都是 Electron 自带的 API（BrowserWindow 的 backgroundMaterial、titleBarOverlay，nativeTheme）。
import {BrowserWindow, ipcMain, nativeTheme, type NativeImage} from 'electron';
import path from 'node:path';
import {PAGES, type PageId, type Result} from '../settings/protocol.ts';

export interface SettingsHost {
  view(): unknown;
  set(patch: unknown): Result | Promise<Result>;
  act(action: unknown): Result | Promise<Result>;
  /** 窗口标题（按界面语言） */
  title(): string;
}

export interface SettingsWindow {
  open(page?: PageId): BrowserWindow;
  /** 有东西变了（托盘、热键、勿扰状态……）：通知页面重读，合并成每 120 毫秒最多一次 */
  changed(): void;
  /** 语言变了：改窗口标题 */
  retitle(): void;
  readonly window: BrowserWindow | null;
}

const TITLEBAR_HEIGHT = 48;
const overlay = () => ({color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#1a1a1a', height: TITLEBAR_HEIGHT});
/** Mica 要 Windows 11 22H2（10.0.22621）起；更早的系统页面用不透明底色 */
export const micaSupported = (version = process.getSystemVersion()) => {
  const [major, , build] = version.split('.').map(Number);
  return process.platform === 'win32' && (major > 10 || major === 10 && build >= 22621);
};

export function createSettingsWindow(root: string, host: SettingsHost, opts: {show?: boolean; icon?: () => NativeImage} = {}): SettingsWindow {
  const show = opts.show ?? true;
  let win: BrowserWindow | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const valid = (e: Electron.IpcMainInvokeEvent) => !!win && !win.isDestroyed() && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame;
  const guard = <T>(fn: () => T | Promise<T>) => async (e: Electron.IpcMainInvokeEvent): Promise<T | Result> => {
    if (!valid(e)) return {ok: false, error: 'error.invalid'};
    try { return await fn(); } catch (err) { console.error('设置窗口出错', err); return {ok: false, error: 'error.internal'}; }
  };
  ipcMain.handle('settings:view', (e) => guard(() => host.view())(e));
  ipcMain.handle('settings:set', (e, patch: unknown) => guard(() => host.set(patch))(e));
  ipcMain.handle('settings:act', (e, action: unknown) => guard(() => host.act(action))(e));
  // 主题变了换标题栏按钮的颜色；第一次打开时才挂（main.ts 在 app ready 之前就建了这个对象）
  let themed = false;
  const onTheme = () => { if (win && !win.isDestroyed()) win.setTitleBarOverlay(overlay()); };

  const api: SettingsWindow = {
    get window() { return win && !win.isDestroyed() ? win : null; },
    open(page) {
      const target = page && (PAGES as readonly string[]).includes(page) ? page : null;
      if (win && !win.isDestroyed()) {
        if (target) win.webContents.send('settings:page', target);
        if (show) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
        return win;
      }
      if (!themed) { themed = true; nativeTheme.on('updated', onTheme); }
      const mica = micaSupported();
      win = new BrowserWindow({width: 1080, height: 760, minWidth: 640, minHeight: 480, show: false, title: host.title(), icon: opts.icon?.(),
        titleBarStyle: 'hidden', titleBarOverlay: overlay(), backgroundMaterial: mica ? 'mica' : 'none',
        backgroundColor: mica ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3'),
        webPreferences: {preload: path.join(root, 'src', 'settings', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true}});
      // 提示词、记忆摘要在这个窗口里：截图、录屏时不出现（和桌宠的“截图、录屏时不出现”无关，一直开着）
      win.setContentProtection(true);
      win.removeMenu();
      win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
      win.webContents.on('will-navigate', e => e.preventDefault());
      const w = win;
      w.once('ready-to-show', () => { if (show) w.show(); });
      w.on('closed', () => { if (win === w) win = null; });
      void w.loadURL(`pet://app/src/settings/index.html?mica=${mica ? 1 : 0}${target ? `#${target}` : ''}`);
      return w;
    },
    changed() {
      if (!win || win.isDestroyed() || timer) return;
      timer = setTimeout(() => { timer = null; if (win && !win.isDestroyed()) win.webContents.send('settings:changed'); }, 120);
    },
    retitle() { if (win && !win.isDestroyed()) win.setTitle(host.title()); },
  };
  return api;
}
