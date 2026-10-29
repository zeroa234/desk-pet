// 勿扰（N8.1，2026-10-21 用户要做）：这时候不出声。纯函数，main.ts 每秒按平台层读到的情况算一次。
// 哪些算勿扰（设置里分开开关，docs/design.md §13）：
//   - 手动开着；
//   - 跟着 Windows 的勿扰 / 专注助手（platform.quietHours ≥ 1：只要优先通知、只要闹钟都算），以及 Windows 自己的“安静时间”
//     （SHQueryUserNotificationState 的 quiet-time：新用户第一次登录后的一小时、系统升级后）；
//   - 全屏、演示时（busy / d3d-fullscreen / presentation，或者前台窗口盖满屏幕）：默认“全屏时自动隐藏”开着，桌宠已经藏起来、
//     声音停了；关掉自动隐藏以后靠这一条不出声；
//   - 名单里的程序在前台时（exe 文件名，不分大小写）。
// 自写。
import type {NotificationState} from '../shared/types.ts';
import {msg, type Msg} from '../shared/msg.ts';

export interface DndInput {
  manual: boolean;
  followSystem: boolean;
  fullscreen: boolean;
  apps: readonly string[];
  /** platform.quietHours()：0 关、1 只要优先通知、2 只要闹钟；读不到 null */
  quietHours: number | null;
  notification: NotificationState;
  /** 前台窗口盖满它所在的显示器（platform.foregroundIsFullscreen） */
  foregroundFull: boolean;
  /** 前台窗口的 exe 文件名；没有 / 读不到 null */
  foregroundExe: string | null;
  /** 前台窗口是桌宠自己的（托盘菜单、覆盖窗口）：不算全屏 */
  ours: boolean;
}

/** 为什么勿扰：manual / system / fullscreen / app:<exe>；不勿扰 null。几条都成立时按这个顺序取第一条 */
export function dndReason(i: DndInput): string | null {
  if (i.manual) return 'manual';
  if (i.followSystem && ((i.quietHours ?? 0) >= 1 || i.notification === 'quiet-time')) return 'system';
  if (i.fullscreen && !i.ours && (i.notification === 'busy' || i.notification === 'd3d-fullscreen' || i.notification === 'presentation' || i.foregroundFull)) return 'fullscreen';
  const exe = i.foregroundExe?.toLowerCase();
  if (exe && i.apps.some(a => a.toLowerCase() === exe)) return `app:${i.foregroundExe}`;
  return null;
}

/** 界面里显示的原因（词条 dnd.reason.*，界面按当前语言翻译） */
export function dndLabel(reason: string): Msg {
  if (reason === 'manual' || reason === 'system' || reason === 'fullscreen') return msg(`dnd.reason.${reason}`);
  return reason.startsWith('app:') ? msg('dnd.reason.app', {exe: reason.slice(4)}) : msg('dnd.reason.other', {reason});
}
