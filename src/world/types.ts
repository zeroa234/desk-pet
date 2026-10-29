// world/ 的对外类型（接口由主代理定）。坐标是物理像素（shared/types.ts）。
import type {DisplayInfo, Rect} from '../shared/types.ts';

/**
 * 一段可以站的水平线。角色“站在上面”= 脚底点 y == support.y，x 在 [x0, x1) 里。
 * - 地面：每个显示器工作区的底边（任务栏顶边，任务栏自动隐藏时是屏幕底边）：y = workArea.bottom，x 范围 = workArea 左右。
 * - 窗口：窗口可见矩形的顶边：y = rect.top；被 z 序更高的窗口盖住的那几段要去掉（同一个窗口可能切成几段，共用 key）。
 * 约定：y 是“脚底下沿”，即角色最下面一行像素画在 y - 1 行，正好压在窗口第一行像素（rect.top）上面。
 */
export interface Support {
  /** 支撑面的主人：'floor:<displayId>'、'win:<hwnd>'（窗口顶边）或 'in:<hwnd>'（窗口里面的底边）。跟随窗口时按 key 找回同一个窗口的线段 */
  key: string;
  /**
   * inside（N2.4，2026-10-21）：窗口里面的底边（docs/desktop-interaction.md §2.2 的 inside:W），只给在这个窗口里面的角色
   * （层 inside:W）站；front 层的下落、导航不落在上面（导航从这个窗口的顶边跳进来，world/nav.ts）
   */
  kind: 'floor' | 'window' | 'inside';
  y: number;
  x0: number;
  x1: number;
  displayId: number;
  /** 窗口支撑面：算出这段时窗口的矩形（跟随时算位移用；inside 用它裁画面、判断出没出窗口）；地面为 null */
  rect: Rect | null;
}

export interface SupportOptions {
  /**
   * 站上窗口顶边时头顶要留的空间（物理像素，一般 = 角色在该显示器上的显示高度 + 一点余量）：
   * 顶边往上这么高都还在同一个显示器的 bounds 里才算可站（否则最大化窗口的顶边也能站，头就出屏了）。
   */
  headroom(display: DisplayInfo): number;
  /** 可站线段的最短长度（物理像素），短于这个的丢掉 */
  minWidth(display: DisplayInfo): number;
  /**
   * 窗口里面的底边（N2.4）：给了才算。inset = 底边、左右往里收多少（物理像素，窗口边框）。窗口要高过 headroom + inset、
   * 宽过 minWidth + 2 × inset，底边要在那个显示器的工作区里；置顶窗口不算（角色那一层插不到置顶窗口上面）
   */
  inside?: {inset(display: DisplayInfo): number};
}
