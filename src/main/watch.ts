// 桌面什么时候要重新枚举（design.md §6；2026-10-21 起用窗口事件代替轮询，事件由 platform 的 watchWindows 给）。纯逻辑，main.ts 用。
//   - 切前台、显示、还原、uncloak：可能多出一个窗口、z 序也可能变了，都要重算
//   - 位置变化、隐藏、最小化、cloak、关闭：只管上次枚举到的窗口（子窗口、工具窗、看不见的窗口不影响桌面快照）
//   - 用户拖 / 拉窗口（move-size-start 到 end）：这段时间主循环照旧 30 Hz、每 tick 重算（被拖的窗口可能正盖过她、她可能站在上面、
//     要往上跳的窗口在动）；收不到 end（拖窗口的程序卡死、被杀）时被拖的窗口关了就结束，最长 MOVING_MAX 秒
//   - 兜底：主循环每隔一段时间照样全量枚举（没收事件的变化：不激活的 z 序调整、别的进程的窗口被程序挪动），见 take
// 自写。
import type {WinEvent} from '../shared/types.ts';

/** 拖窗口最长算多久（秒），收不到 move-size-end 时兜底 */
export const MOVING_MAX = 120;

export class DesktopWatch {
  /** 有变化，下一 tick 要重新枚举 */
  dirty = true;
  /** 用户正拖着 / 拉着的窗口 */
  moving: {hwnd: number; since: number} | null = null;

  /** 收到一个窗口事件；返回要不要马上叫醒主循环。listed：上次枚举到的窗口 */
  onEvent(e: WinEvent, listed: ReadonlySet<number>, now: number): boolean {
    switch (e.kind) {
      case 'move-size-start': this.moving = {hwnd: e.hwnd, since: now}; break;
      case 'move-size-end': this.moving = null; break;   // 系统同一时间只有一个拖窗口的循环
      case 'foreground': case 'show': case 'restore': case 'uncloak': break;
      default:
        if (e.kind === 'destroy' && this.moving?.hwnd === e.hwnd) this.moving = null;
        if (!listed.has(e.hwnd)) return false;
    }
    this.dirty = true;
    return true;
  }

  /** 用户在拖窗口（主循环要快速 tick、每 tick 重算） */
  isMoving(now: number): boolean {
    if (this.moving && now - this.moving.since > MOVING_MAX) this.moving = null;
    return !!this.moving;
  }

  /** 这一 tick 要不要重新枚举：有变化、在拖窗口、或者离上次枚举满 fallback 秒；要的话清掉 dirty */
  take(now: number, lastRefresh: number, fallback: number): boolean {
    if (!this.dirty && !this.isMoving(now) && now - lastRefresh < fallback) return false;
    this.dirty = false;
    return true;
  }
}
