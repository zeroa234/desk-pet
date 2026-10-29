// 主进程 ↔ 舞台（覆盖窗口的渲染进程）之间的消息格式（design.md §1：主进程是唯一的状态来源，舞台只是显示器）。
// 只放类型。坐标是物理像素，相对这个覆盖窗口的左上角。
//
// 主 → 舞台：'stage:init' StageInit，'stage:frame' StageFrame，'stage:passive' StagePassive，
//           'stage:sound' StageSound（只发给一个覆盖窗口，它负责出声），'stage:sound-stop'（藏起来、关声音时停掉正在响的）
// 舞台 → 主：'stage:ready'，'stage:hover' boolean（光标是否在某个角色的不透明像素上），'stage:grab' id（在角色身上按住左键拖动、
//           或按住不放 pressMs 毫秒：拎起来），'stage:poke' StagePoke（点一下、来回摸），'stage:stat' StageStat（每秒一次，页面看得见时）

/** 舞台每秒报一次：这一秒收到几次 mousemove、自己认为光标在不在角色上、要画几个角色、其中几个的图集已经读好 */
export interface StageStat {
  moves: number;
  hover: boolean;
  items: number;
  loaded: number;
}

/**
 * 主进程把这块窗口强制设回了穿透（重新显示、拖完松手、躲藏层收起）：页面记着的“光标在角色上”跟着清掉，两边才一致。
 * cursorStale：页面记着的光标位置也作废（窗口藏过，这期间光标去了哪不知道）；false 时页面按记着的位置马上重算一次。
 */
export interface StagePassive {
  cursorStale: boolean;
}

export interface StageInit {
  /** 覆盖窗口的物理像素尺寸（舞台用来核对 innerWidth × devicePixelRatio） */
  width: number;
  height: number;
  /** 解码后的图集最多占多少内存（MB），超了按最久没用的先释放（设置 sheetBudgetMB） */
  sheetBudgetMB: number;
  /** 按住多久算“拎起来”（毫秒，设置 pressMs）；没到就松开算点了一下 */
  pressMs: number;
}

/**
 * 用户碰了角色（R3.6，2026-10-21）：click = 在角色身上按下、没拖动、pressMs 以内松开；stroke = 不按键、光标在角色身上来回晃
 * （VPet 的“摸头 / 摸身体”判法）。part = 光标下部位图（<图集>.parts.png）的序号，1 起（主进程按 pack.json 的 parts 换成名字）；
 * 那张图没有部位图（双人场景）、还没读好、点在描边外面时为 null。
 */
export interface StagePoke {
  id: string;
  part: number | null;
  kind: 'click' | 'stroke';
}

/**
 * 画一个角色：sheet 是图集相对项目根的路径（不带扩展名，舞台用 pet://app/<sheet>.png|.json 取）；(x, y) 是脚底点；k 是每个渲染像素占几个物理像素。
 * fx：角色身上正在播的特效（t = 播了几秒，h = 角色身高物理像素）：puff 一团烟挡住全身（换衣着），alert 头顶感叹号，heart 头顶的心。
 * dx：特效相对 (x, y) 横向挪多少物理像素（双人场景只画一张图，两个人的烟各在自己的位置上）。
 * 双人场景（阶段 2）：sheet 是 packs/_scenes/<场景>/sprites/<变体>/<朝向>，id 是接受方，(x, y) 是场景锚点；给予方不单独画。
 */
export interface DrawItem {
  id: string;
  sheet: string;
  frame: number;
  x: number;
  y: number;
  k: number;
  /** 高清、不像素化的变体（PackVariant.style smooth，2026-10-22）：平滑缩放，k 可以是小数 */
  smooth?: true;
  /** 特效的一格（物理像素）：没有 = k（像素风一个渲染像素）；高清 = 同样高的 r120 的一个渲染像素（src/main/sim.ts artPx） */
  u?: number;
  fx?: {fx: 'puff' | 'alert' | 'heart'; t: number; h: number; dx?: number}[];
  /** 液体（design.md §3.7）：画在角色后面 / 前面的像素块（水珠） */
  under?: Blot[];
  over?: Blot[];
  /**
   * （开源版省略）
   * 像素涂成这一层的颜色，按顺序一层盖一层
   */
  paint?: PaintLayer[];
  /** 只画在这个矩形里（[x, y, 宽, 高]，和 x、y 同一个坐标系）：在窗口里面的角色裁到那个窗口（N2.4）；判点也只认这里面的 */
  clip?: [number, number, number, number];
}

/**
 * 一个像素块（液体用，src/fluid/ 产出）：[x, y, 宽, 高, 0xRRGGBB, 不透明度, 形状]，物理像素、绝对坐标。形状：没有 = 方块；
 * BLOT_ELLIPSE = 画成这个矩形的内切椭圆（2026-10-22 高清变体：水珠、水洼画成平滑的圆和扁椭圆，不是一格一格的方块）
 */
export type Blot = [number, number, number, number, number, number, typeof BLOT_ELLIPSE?];
export const BLOT_ELLIPSE = 1;
/** 像素块整组平移（换成别的窗口里的坐标）：宽高、颜色、形状照带 */
export const shiftBlots = (bs: readonly Blot[], ox: number, oy: number): Blot[] => bs.map(([x, y, ...rest]) => [x - ox, y - oy, ...rest] as Blot);
/** 按表面格子涂的一层：[0xRRGGBB, 不透明度, 格子编号（升序）] */
export type PaintLayer = [number, number, number[]];

export interface DebugInfo {
  windows: {rect: [number, number, number, number]; label: string}[];
  supports: {x0: number; x1: number; y: number; kind: 'floor' | 'window' | 'inside'}[];
  actors: {id: string; x: number; y: number; lines: string[]}[];
  lines: string[];
}

export interface StageFrame {
  items: DrawItem[];
  /** 地上的水洼（像素块，画在所有角色下面） */
  ground?: Blot[];
  /** 调试叠加层（R13.3）：null = 关；不带这个字段 = 保持上一次画的（调试层只 10 Hz 刷新） */
  debug?: DebugInfo | null;
  cursor: 'default' | 'grab' | 'grabbing';
}

/**
 * 放几个声音（原版 mod 音效，R2.8、R6.3；规则在主进程的 src/sound/ 里跑完了，这里只管播）。
 * url：pet://app/ 下的路径（packs/_sfx/sounds/…）；gain：线性增益，已经乘好电平、规则音量和用户音量；pitch：播放速度（变调同时变长短）；
 * delay：晚几秒开始；pan：左右声像 -1..1（按角色在屏幕上的位置）；muffled：躲在窗口后面，闷一点（低通）。
 */
export interface StageSound {
  sounds: {url: string; gain: number; pitch: number; delay: number; pan: number; muffled: boolean}[];
}
