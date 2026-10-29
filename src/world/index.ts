// world/：支撑面（纯逻辑，不 import electron、不碰 Win32；design.md §1、§6）。别的模块只 import 这个文件。
// 坐标是物理像素（shared/types.ts）。身体的物理在 behavior/（和状态机放在一起）。
export type {Support, SupportOptions} from './types.ts';
export type {HideSpot, HideSpotQuery} from './visibility.ts';
export {computeSupports, displayAt} from './supports.ts';
export type {NavParams, NavGoal, NavMove, NavRoute} from './nav.ts';
export {findRoute, hasExit, jumpBetween, jumpTargets, flightSec} from './nav.ts';
export {
  rectArea, intersectRect, subtractRects, coveredFraction, coversAbove, coverAlong, findHideSpots,
} from './visibility.ts';
