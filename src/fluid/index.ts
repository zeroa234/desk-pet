// fluid/: runtime fluid effects. The open-source edition ships this module as a no-op with the same interface:
// the simulation calls it, nothing is drawn. Packs without fluid sources never use it anyway.
import type {Rect, WinInfo} from '../shared/types.ts';
import type {Support} from '../world/index.ts';
import {BLOT_ELLIPSE as ELLIPSE, type Blot, type PaintLayer} from '../stage/protocol.ts';

export {ELLIPSE, type Blot, type PaintLayer};

export const FLUID = {} as const;

export interface Puddle {
  key: string;
  ref: Rect | null;
  x: number;
  y: number;
  k: number;
  smooth?: boolean;
  ring?: boolean;
  vol: number;
  semen: number;
  behind: number | null;
  last: number;
  covered: boolean;
}

export interface DripAnchor {
  x: number;
  y: number;
  front: boolean;
  k: number;
  pxPerModel: number;
  smooth?: boolean;
  ring?: boolean;
}

export interface FluidLook {
  smooth?: boolean;
  ring?: boolean;
}

export interface FluidSource {
  arousal?: boolean;
  trail?: number[][];
}

export interface AfterFlow {
  source: string;
  sec: number;
  hang: [number, number];
  trail?: boolean;
}

export class Fluids {
  puddles: Puddle[] = [];
  constructor(_rng: () => number) {}
  land(_s: Support, _x: number, _k: number, _size: number, _semen: number, _behind: number | null, _look: FluidLook = {}): void {}
  follow(_supports: readonly Support[]): void {}
  dry(_dt: number): void {}
  puddleBlots(_windows: readonly WinInfo[], _ringDefault: boolean): Blot[] { return []; }
  stepDrip(_id: string, _anchor: DripAnchor | null, _now: number, _dt: number, _o: unknown): void {}
  stepActor(_id: string, _now: number, _dt: number, _o: unknown): void {}
  after(_id: string, _now: number, _flows: readonly AfterFlow[]): void {}
  creampie(_id: string, _now: number, _o: {hold: number; fade: number}): void {}
  semenOf(_id: string, _now: number): number { return 0; }
  paint(_id: string, _outfit: string): PaintLayer[] { return []; }
  dropsOf(_id: string, _anchors: unknown, _ring: boolean): {front: boolean; blots: Blot[]}[] { return []; }
  dripBlots(_id: string, _anchors: unknown, _ring: boolean): {over: Blot[]; under: Blot[]} | null { return null; }
  falling(): boolean { return false; }
  secondsToNextChange(_now: number): number { return Infinity; }
  forget(_id: string): void {}
  dropDrip(_id: string): void {}
  stain(_id: string, _outfit: string, _ids: readonly number[]): void {}
  wear(_id: string, _outfit: string): void {}
  stains(_id: string, _outfit: string): number[] { return []; }
}
