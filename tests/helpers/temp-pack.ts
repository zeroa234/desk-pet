// temp 下临时造一个最小角色包（只给单测用）。
// 2026-10-22 审查 §3：tests/pack-reactions.test.ts、away-sim.test.ts、transition.test.ts 各抄了一份同形的夹具，
// 三处的差别只有临时目录、动作表、要不要写 behaviors.json、parts、transitions，都做成参数。
// 包按 src/pack/index.ts 的 loadPack：只查图集文件在、帧数 / 帧率 / 循环对得上，图集内容不读。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** 项目根（tests/helpers/ 往上两层）：给 loadPack 和各自清理临时目录用 */
export const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 动作表里的一条：pack.json 的 actions 原样写进去，图集帧表只挑帧数 / 帧率 / 循环 */
export interface TempPackAction {
  /** 片段名（旧包都写；过渡动作是 null） */
  clip?: string;
  frames: number;
  fps: number;
  loop: boolean;
  /** （开源版省略） */
  switchSec?: number;
  /** 逐帧髋骨位置（模型身高比例），见 docs/pack-format.md */
  hip?: {right?: number[]; left?: number[]};
  /** 过渡动作的两头（动作 id） */
  transition?: {from: string; to: string};
}

export interface TempPackOptions {
  /** 动作表；默认只有 idle（2 帧 @ 12 fps 循环） */
  actions?: Record<string, TempPackAction>;
  /** 给了就写 behaviors.json（idle 一个行为），这份 reactions 原样写进去；不给就不写 behaviors.json */
  reactions?: unknown;
  /** 部位名（序号 1 = parts[0]），默认 ['head', 'chest'] */
  parts?: string[];
  /** 过渡表，原样写进 pack.json */
  transitions?: readonly unknown[];
}

/**
 * 在 <root>/<name>/ 下造一个最小角色包，返回相对项目根的路径（给 loadPack）。同名目录以前建过会先删掉。
 * 图集：sprites/v/clothed/<动作>-<朝向>.png + .json，两个朝向，一个变体。
 */
export function tempPack(root: string, name: string, opts: TempPackOptions = {}): string {
  const rel = path.join(root, name);
  const dir = path.join(PROJECT, rel);
  fs.rmSync(dir, {recursive: true, force: true});
  const sprites = path.join(dir, 'sprites', 'v', 'clothed');
  fs.mkdirSync(sprites, {recursive: true});
  const actions: Record<string, TempPackAction> = opts.actions ?? {idle: {frames: 2, fps: 12, loop: true}};
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    schema: 1, id: name, name, aliases: [], adult: true, restHeightModelPx: 32,
    halfWidthRatio: 0.25, walkHeightsPerSec: 1, actions, outfits: ['clothed'],
    ...(opts.transitions ? {transitions: opts.transitions} : {}),
    facings: ['right', 'left'], parts: opts.parts ?? ['head', 'chest'],
    variants: [{id: 'v', renderHeight: 40, outline: 'full'}], defaultVariant: 'v',
  }));
  for (const [action, a] of Object.entries(actions)) for (const f of ['right', 'left']) {
    fs.writeFileSync(path.join(sprites, `${action}-${f}.png`), '');
    fs.writeFileSync(path.join(sprites, `${action}-${f}.json`), JSON.stringify({action, facing: f, outfit: 'clothed', variant: 'v',
      frames: a.frames, fps: a.fps, loop: a.loop, cell: [8, 8], cols: 2, foot: [4, 8]}));
  }
  if (opts.reactions !== undefined) {
    fs.writeFileSync(path.join(dir, 'behaviors.json'), JSON.stringify({schema: 1, stats: {}, reactions: opts.reactions,
      behaviors: [{id: 'idle', weight: 1, steps: [{do: 'idle', sec: 1}]}]}));
  }
  return rel;
}
