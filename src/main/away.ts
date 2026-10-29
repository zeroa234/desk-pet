// 用户离开（N3.1，2026-10-21 用户：“离开这个按你说的做”，即 design.md §17 主代理建议的 ① + ②）：
//   ① 锁屏、屏保、切到别的用户：一定离开了（kind locked）；
//   ② afterSec 秒（默认 300）没碰键盘鼠标：大概离开了（kind idle）。开着窗口看视频、看长文不动鼠标也会被当成离开，
//      后果只是她胆子大一点、一动鼠标她就被抓到（用户接受的取舍，没做 ③“有媒体在播不算离开”）。
//   回来：锁屏的是解锁那一刻（屏保是屏保停的那一刻），没输入的是第一次碰键鼠（系统的空闲时间变小了）。
// 纯逻辑，main.ts 每秒按 Electron powerMonitor 读到的喂一次（getSystemIdleTime 是 GetLastInputInfo 换成的整秒；
// getSystemIdleState 的 locked 在 Windows 上是会话锁着或屏保在跑），锁屏 / 解锁事件来的时候也马上喂一次。自写。

export type AwayKind = 'locked' | 'idle';

export interface AwayInput {
  /** 现在（秒，单调时钟） */
  now: number;
  /** 多少秒没碰键盘鼠标（整秒） */
  idleSec: number;
  /** 锁屏、屏保、切到别的用户 */
  locked: boolean;
  /** 多少秒没输入算离开；0 = 只算锁屏 */
  afterSec: number;
}

export type AwayChange =
  /** 离开了：哪一种、那时已经多少秒没输入 */
  | {type: 'away'; kind: AwayKind; idleSec: number}
  /** 还没回来，换了一种（没输入的时候又锁了屏） */
  | {type: 'away-kind'; kind: AwayKind}
  /** 回来了：离开时是哪一种（最后的那种）、离开了几秒 */
  | {type: 'back'; kind: AwayKind; sec: number};

export class AwayTracker {
  /** 离开的方式、从什么时候起；在的时候 null */
  state: {kind: AwayKind; since: number} | null = null;
  /** 最后一次“有人”的时刻：输入，或者解锁那一刻（锁屏界面上输密码不一定算进系统的空闲时间，解锁以后不能马上又判成没输入） */
  private activeAt = -Infinity;
  private prevIdle = 0;

  /** 有效的空闲秒数（解锁那一刻算一次输入）；还没喂过时是 0 */
  idleSec(now: number): number {
    return Number.isFinite(this.activeAt) ? Math.max(0, now - this.activeAt) : 0;
  }

  update(i: AwayInput): AwayChange | null {
    const fresh = i.idleSec < this.prevIdle;   // 空闲时间变小 = 这一秒里有过输入
    this.prevIdle = i.idleSec;
    this.activeAt = Math.max(this.activeAt, i.now - i.idleSec);
    const s = this.state;
    if (s) {
      if (i.locked) {
        if (s.kind === 'locked') return null;
        s.kind = 'locked';
        return {type: 'away-kind', kind: 'locked'};
      }
      if (s.kind === 'locked') this.activeAt = Math.max(this.activeAt, i.now);   // 解锁 / 屏保停了
      else if (!fresh) return null;
      this.state = null;
      return {type: 'back', kind: s.kind, sec: i.now - s.since};
    }
    if (i.locked) { this.state = {kind: 'locked', since: i.now}; return {type: 'away', kind: 'locked', idleSec: this.idleSec(i.now)}; }
    if (i.afterSec > 0 && this.idleSec(i.now) >= i.afterSec) { this.state = {kind: 'idle', since: i.now}; return {type: 'away', kind: 'idle', idleSec: this.idleSec(i.now)}; }
    return null;
  }
}
