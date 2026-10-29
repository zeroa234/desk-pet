// 舞台页面该用什么光标样式（2026-10-29，用户：打开设置窗口，鼠标在界面里移动，光标在正常指针和抓手之间来回变）。
// 舞台窗口平时是穿透的（setIgnoreMouseEvents(true, {forward: true})），Electron 把鼠标移动转发给它的页面，页面却不管光标在不在
// 角色上，一直把 body 的光标设成主进程给的 grab（以前），而压在它下面的设置窗口和它在同一个进程里，各设各的光标。
// 现在只有“这块窗口正拥有鼠标”——光标压在角色的不透明像素上，或这块窗口正拎着角色——才用主进程给的 grab / grabbing，
// 其余时候一律 default：穿透着的窗口没有光标要显示。
// 为什么会来回变是按 Electron / Chromium 的做法推断的，没用真光标复现过（往两个窗口 PostMessage 模拟鼠标移动，读到的
// 系统光标一直是箭头，连设置窗口自己的手形都读不到，模拟不出来）；改法本身是“不属于它的光标不去设”，不依赖这个推断是否精确。
export type StageCursor = 'default' | 'grab' | 'grabbing';

/** frame：主进程给的样式（拎着时 grabbing，否则 grab）；owns：这块窗口现在拥有鼠标 */
export const stageCursor = (frame: StageCursor, owns: boolean): StageCursor => owns ? frame : 'default';
