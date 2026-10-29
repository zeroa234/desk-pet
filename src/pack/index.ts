// pack/：角色包加载和校验（R1.2、design.md §4）。纯逻辑（只读文件，不 import electron）。别的模块只 import 这个文件。
// 角色包由 scripts/export-pack/ 生成（packs/<id>/pack.json + sprites/<变体>/<衣着>/<动作>-<朝向>.png|.json）；
// 手写的“脑子”在 packs/<id>/behaviors.json（行为系统，src/behavior/mind.ts 的 MindConfig；入库，导出不碰它）。
// packs/ 下以 _ 开头的目录不是角色：packs/_scenes/<场景>/ 是双人场景（scripts/export-pack/render-scenes.mjs 生成，scene.json +
// sprites/<变体>/<朝向>.png|.json；两个人画在同一张图里），loadScenes() 读。packs/_sfx/ 是原版 mod 的音效和规则（loadSfx()）。
// 音效什么时候响（scripts/export-pack/export_sfx.py 导出，可以没有）：角色包 sfx.json = 每个动作哪一帧有哪个 effect，
// 场景 sfx.json = 哪一帧哪个角色（receiver / giver）有哪个 effect；放什么声音由 src/sound/ 按规则定。
// 液体（2026-10-20，design.md §3.7，src/fluid/）：nude 图集的帧表 anchors（每个出口挂水珠的点）、ids（有编号图 <图集>.ids.png）；
// pack.json 的 surface（表面编号的 hash）、fluidSources（出口：arousal、往下流的路线 trail）和动作的 stains（这个动作做完身上沾上的
// 格子）、after（做完以后从哪个出口往外流）；scene.json 的 after 同；场景帧表的 floor（落地点）、scene.json 的 stains /
// （开源版省略）
// 部位图（2026-10-21，R3.6、N1.3，scripts/export-pack/parts.mjs）：图集帧表 parts: true = 有 <图集>.parts.png（像素 = 部位序号）；
// pack.json 的 parts 是序号对应的名字（序号 1 = parts[0]），behaviors.json 的 reactions 按名字写 click:<部位> / stroke:<部位>。
// 动作衔接（2026-10-22，design.md §3.10）：动作的 hip（髋骨轨迹）、带 transition 的过渡动作、pack.json 的 transitions（换到 to 时从哪些
// 动作的哪几帧能先播过渡），都交给状态机（src/behavior/actor.ts）。
import fs from 'node:fs';
import path from 'node:path';
import type {ActionInfo, ActorSpec, Phase, Transition, Tuning} from '../behavior/index.ts';
import type {MindConfig} from '../behavior/mind.ts';
import type {SfxManifest} from '../sound/index.ts';
import type {AfterFlow, FluidSource} from '../fluid/index.ts';
import {chunkCount, sheetFile} from '../shared/sheets.ts';

export type Facing = 'right' | 'left';

export interface PackVariant {
  id: string;
  renderHeight: number;
  /** 描边：full 外轮廓 + 内边，inner 只内边，none 不描（2026-10-22 高清变体） */
  outline: 'full' | 'inner' | 'none';
  /** smooth：高清、不像素化（边缘半透明，舞台平滑缩放、放大倍数可以是小数）；没有 = 像素风（整数倍、最近邻）。2026-10-22 */
  style?: 'smooth';
}

export interface PackManifest {
  schema: 1;
  /** 哪个导出器生成的（blocky、mmd……，docs/pack-format.md §2）；运行时不用，2026-10-22 以前的包没有 */
  producer?: string;
  id: string;
  name: string;
  /** 别的语言的显示名（2026-10-29 界面双语）：键是语言标签（en……），没有对应语言时显示 name（src/shared/i18n.ts displayName） */
  names?: Record<string, string>;
  aliases: string[];
  adult: boolean;
  restHeightModelPx: number;
  /** 自己的身高 / 基准角色身高（导出配置 scaleFrom）；旧包没有 = 1 */
  heightRatio?: number;
  halfWidthRatio: number;
  walkHeightsPerSec: number;
  /**
   * （开源版省略）
   * transition：这是导出时插出来的过渡（clip 为 null），从哪个动作到哪个动作
   */
  actions: Record<string, ActionInfo & {clip: string | null; anchor?: 'seat'; stains?: number[]; after?: AfterFlow[]; switchSec?: number;
    transition?: {from: string; to: string}}>;
  /** 动作之间的过渡（scripts/export-pack/bake_clips.py transitions）；旧包没有 */
  transitions?: Transition[];
  /** （开源版省略） */
  outfits: string[];
  /** 表面编号（scripts/export-pack/surface.mjs）：格子边长（模型像素）和方块表的 hash；nude 图集的编号图、所有 stains 按它 */
  surface?: {cell: number; hash: string};
  /** （开源版省略） */
  fluidSources?: Record<string, FluidSource>;
  /** 部位图的序号 → 名字（序号 1 = parts[0]）；旧包没有 = 不分部位 */
  parts?: string[];
  facings: Facing[];
  variants: PackVariant[];
  defaultVariant: string;
}

/** 一张图集的帧表（render.mjs 写的 .json） */
export interface SheetMeta {
  action: string;
  facing: Facing;
  outfit: string;
  variant: string;
  frames: number;
  fps: number;
  loop: boolean;
  cell: [number, number];
  cols: number;
  /** 拆块时每个文件几帧（文件 <图集>.c<i>.png，src/shared/sheets.ts）；没有 = 一个文件 <图集>.png */
  chunk?: number;
  /** 格子里脚底点的位置（渲染像素）：画的时候把它对到角色的脚底点上 */
  foot: [number, number];
  /** （开源版省略） */
  footY?: number[];
  /** 每个出口逐帧挂水珠的点（格子里的渲染像素）和它没被身体挡住（1）/ 挡住（0）；0 = 这一帧没有 */
  anchors?: Record<string, ([number, number, 0 | 1] | 0)[]>;
  /** （开源版省略） */
  ids?: true;
  /** 有部位图 <图集>.parts.png（点到哪个部位，R3.6） */
  parts?: true;
  /** （开源版省略） */
  floor?: [number, number, 0 | 1, number][];
}

/** 角色包的 sfx.json：规则里的角色（packs/_sfx/sfx.json 的 voices）+ 每个动作 [精灵帧, effect]（同一帧可以有几个） */
export interface PackSfx {
  voice: string;
  actions: Record<string, [number, string][]>;
}

export interface Pack {
  manifest: PackManifest;
  /** behaviors.json；没有这个文件时为 null（只用内置的走 / 坐 / 站） */
  mind: MindConfig | null;
  /** sfx.json；没导出时为 null / 没有（不出声） */
  sfx?: PackSfx | null;
  /** 角色包目录相对项目根的路径（posix），舞台用 pet://app/<它>/... 取图 */
  relDir: string;
  variant(id: string): PackVariant;
  /** 这个动作在这身衣着下有没有图 */
  has(action: string, outfit: string): boolean;
  /** 图集相对项目根的路径（不带扩展名） */
  sheetPath(variant: string, outfit: string, action: string, facing: Facing): string;
  /** 帧表（加载时已全部读进来校验过） */
  sheet(variant: string, outfit: string, action: string, facing: Facing): SheetMeta;
  actorSpec(tuning: Tuning): ActorSpec;
}

const actionOutfits = (m: PackManifest, a: string) => m.actions[a].outfits ?? m.outfits;

/** 读 packs/<id>/，校验格式、成年标记（R9.1）、每张图集都在且和清单对得上；有问题直接抛错，不带病运行。 */
export function loadPack(projectRoot: string, relDir: string): Pack {
  const dir = path.join(projectRoot, relDir);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8')) as PackManifest;
  const fail = (msg: string): never => { throw new Error(`角色包 ${relDir}：${msg}`); };
  if (m.schema !== 1) fail(`不认识的 schema ${m.schema}`);
  if (m.adult !== true) fail('adult 不是 true，拒绝加载（R9.1）');
  if (!m.actions.idle) fail('缺 idle 动作');
  // 全年龄模式、穿回去、托盘图标都按 clothed（docs/pack-format.md §5）
  if (m.outfits[0] !== 'clothed') fail(`衣着第一个要是 clothed（现在是 ${m.outfits.join('、')}）`);
  for (const o of m.outfits) if (!actionOutfits(m, 'idle').includes(o)) fail(`idle 缺衣着 ${o}`);
  if (!m.variants.some(v => v.id === m.defaultVariant)) fail(`defaultVariant ${m.defaultVariant} 不在 variants 里`);
  // （开源版省略）
  for (const [a, info] of Object.entries(m.actions)) {
    if (info.switchSec !== undefined && !(info.switchSec >= 0 && info.switchSec < (info.loop ? Infinity : (info.frames - 1) / info.fps))) {
      fail(`动作 ${a} 的 switchSec ${info.switchSec} 不在片段里（${info.frames} 帧，${info.fps} fps）`);
    }
    for (const [f, xs] of Object.entries(info.hip ?? {})) if (xs?.length !== info.frames) fail(`动作 ${a} 的 hip.${f} 长度不对`);
  }
  // 过渡：动作都要有，过渡动作不循环，入口帧在那个动作里
  for (const t of m.transitions ?? []) {
    const tr = m.actions[t.action];
    if (!tr || tr.loop || tr.transition?.from !== t.from || tr.transition?.to !== t.to || !m.actions[t.to]) fail(`过渡 ${t.action} 和动作表对不上`);
    for (const [a, fs_] of Object.entries(t.entries)) {
      if (!m.actions[a] || fs_.some(f => !(f >= 0 && f < m.actions[a].frames))) fail(`过渡 ${t.action} 的入口 ${a} 不对`);
    }
  }
  const relPosix = relDir.split(path.sep).join('/');
  const sheets = new Map<string, SheetMeta>();
  const key = (v: string, o: string, a: string, f: string) => `${v}/${o}/${a}-${f}`;
  for (const v of m.variants) for (const a of Object.keys(m.actions)) for (const o of actionOutfits(m, a)) for (const f of m.facings) {
    const base = path.join(dir, 'sprites', v.id, o, `${a}-${f}`);
    if (!fs.existsSync(base + '.json')) fail(`缺图集 ${key(v.id, o, a, f)}（重跑 scripts/export-pack/）`);
    const s = JSON.parse(fs.readFileSync(base + '.json', 'utf8')) as SheetMeta;
    // 图：没拆的一个 <图集>.png，拆块的 <图集>.c<i>.png 每块都要有（src/shared/sheets.ts）
    for (let i = 0; i < chunkCount(s); i++) if (!fs.existsSync(sheetFile(base, s.chunk ? i : null))) fail(`缺图集 ${key(v.id, o, a, f)} 的图（重跑 scripts/export-pack/）`);
    if (s.frames !== m.actions[a].frames || s.fps !== m.actions[a].fps) fail(`${key(v.id, o, a, f)} 的帧数 / 帧率和 pack.json 不一致`);
    for (const [src, list] of Object.entries(s.anchors ?? {})) if (list.length !== s.frames) fail(`${key(v.id, o, a, f)} 的 anchors.${src} 长度不对`);
    if (s.floor?.some(([fr]) => fr < 0 || fr >= s.frames)) fail(`${key(v.id, o, a, f)} 的 floor 帧号超出范围`);
    sheets.set(key(v.id, o, a, f), s);
  }
  const mindFile = path.join(dir, 'behaviors.json');
  let mind: MindConfig | null = null;
  if (fs.existsSync(mindFile)) {
    mind = JSON.parse(fs.readFileSync(mindFile, 'utf8')) as MindConfig;
    if (mind.schema !== 1) fail(`behaviors.json 不认识的 schema ${mind.schema}`);
    if (mind.dialogueBanned!==undefined && (!Array.isArray(mind.dialogueBanned) || mind.dialogueBanned.some(w=>typeof w!=='string' || !w.trim()))) fail('behaviors.json dialogueBanned 必须是非空字符串数组');
    const ids = new Set<string>();
    for (const b of mind.behaviors) {
      if (ids.has(b.id)) fail(`behaviors.json 行为 id 重复：${b.id}`);
      ids.add(b.id);
      if (!b.steps === !b.duo) fail(`behaviors.json 行为 ${b.id}：steps 和 duo 要有且只有一个`);
      for (const s of b.steps ?? []) {
        for (const act of ['action' in s ? s.action : undefined, 'walkAction' in s ? s.walkAction : undefined]) {
          if (act && !m.actions[act]) fail(`behaviors.json 行为 ${b.id} 用了角色包里没有的动作 ${act}`);
        }
        if (s.do === 'outfit' && !m.outfits.includes(s.to)) fail(`behaviors.json 行为 ${b.id} 换成没有的衣着 ${s.to}`);
      }
    }
    for (const b of mind.behaviors) for (const id of b.next ?? []) if (!ids.has(id)) fail(`behaviors.json 行为 ${b.id} 的 next 里有没有的行为 ${id}`);
    // 反应：键是 discovered、returned（用户回来撞见，N3.1）、click / stroke，或 click:<部位> / stroke:<部位>（部位要在 pack.json 的 parts 里）；
    // （开源版省略）
    for (const [key, raw] of Object.entries(mind.reactions ?? {})) {
      if (key.startsWith('_')) continue;   // _comment
      const [kind, part, extra] = key.replace(/^sex:/, '').split(':');
      const whole = kind === 'discovered' || kind === 'returned';   // 只能整个写，不带部位、不加 sex:
      if (!['discovered', 'returned', 'click', 'stroke'].includes(kind) || extra !== undefined || (whole && key !== kind)
        || (part !== undefined && !m.parts?.includes(part))) {
        fail(`behaviors.json 的反应 ${key}：键要是 discovered、returned、click、stroke、click:<部位> / stroke:<部位>，或前面加 sex:（部位：${m.parts?.join('、') ?? '这个包没有部位图'}）`);
      }
      for (const r of Array.isArray(raw) ? raw : [raw]) for (const s of r.steps ?? []) {
        const act = 'action' in s ? s.action : undefined;
        if (act && !m.actions[act]) fail(`behaviors.json 的反应 ${key} 用了角色包里没有的动作 ${act}`);
        if (s.do === 'gotoHide' || s.do === 'hide' || s.do === 'hideHere') fail(`behaviors.json 的反应 ${key} 不能有 ${s.do} 步骤`);
      }
    }
  }
  const sfxFile = path.join(dir, 'sfx.json');
  let sfx: PackSfx | null = null;
  if (fs.existsSync(sfxFile)) {
    sfx = JSON.parse(fs.readFileSync(sfxFile, 'utf8')) as PackSfx & {schema: number};
    for (const [a, keys] of Object.entries(sfx.actions)) {
      if (!m.actions[a]) fail(`sfx.json 有角色包里没有的动作 ${a}（重跑 export_sfx.py）`);
      if (keys.some(([f]) => f < 0 || f >= m.actions[a].frames)) fail(`sfx.json 动作 ${a} 的帧号超出范围（重跑 export_sfx.py）`);
    }
  }
  return {
    manifest: m,
    mind,
    sfx,
    relDir: relPosix,
    variant: id => m.variants.find(v => v.id === id) ?? fail(`没有画面变体 ${id}`),
    has: (a, o) => !!m.actions[a] && actionOutfits(m, a).includes(o),
    sheetPath: (v, o, a, f) => `${relPosix}/sprites/${v}/${o}/${a}-${f}`,
    sheet: (v, o, a, f) => sheets.get(key(v, o, a, f)) ?? fail(`没有图集 ${key(v, o, a, f)}`),
    actorSpec: tuning => ({
      id: m.id,
      actions: Object.fromEntries(Object.entries(m.actions).map(([k, a]) => [k, {frames: a.frames, fps: a.fps, loop: a.loop,
        ...(a.r18 ? {r18: true} : {}), ...(a.outfits ? {outfits: a.outfits} : {}), ...(a.heightsPerSec ? {heightsPerSec: a.heightsPerSec} : {}),
        ...(a.hip ? {hip: a.hip} : {})}])),
      walkHeightsPerSec: m.walkHeightsPerSec,
      halfWidthRatio: m.halfWidthRatio,
      heightRatio: m.heightRatio ?? 1,
      ...(m.transitions?.length ? {transitions: m.transitions} : {}),
      tuning,
    }),
  };
}

/**
 * packs/ 下所有角色包（不以 _ 开头、有 pack.json 的目录），按 id 排序。给了 dirs（相对项目根的包目录，环境变量 DESK_PET_PACKS，
 * docs/pack-format.md §8.4）就只读这几个，测试新导出的包时用户桌面上不多出角色
 */
export function loadPacks(projectRoot: string, dirs?: readonly string[]): Pack[] {
  if (dirs?.length) return dirs.map(d => loadPack(projectRoot, path.normalize(d))).sort((a, b) => a.manifest.id < b.manifest.id ? -1 : 1);
  const root = path.join(projectRoot, 'packs');
  return fs.readdirSync(root, {withFileTypes: true})
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && fs.existsSync(path.join(root, d.name, 'pack.json')))
    .map(d => d.name).sort()
    .map(n => loadPack(projectRoot, path.join('packs', n)));
}

// ---------- 双人场景（packs/_scenes/<场景>/，阶段 2） ----------

export type SceneRole = 'receiver' | 'giver';

/** 场景里的一段（一段原版片段）：精灵帧 [start, end)；loop 段的 loop = 最后一个周期，loopable = 首尾接得上、可以多绕几圈 */
export interface SceneSegment {
  clip: string;
  phase: Exclude<Phase, 'end'>;
  start: number;
  end: number;
  loop?: [number, number];
  loopable?: boolean;
}

export interface SceneManifest {
  schema: 1;
  id: string;
  name: string;
  r18: true;
  adult: boolean;
  /** 角色 id：接受方（画场景精灵的那个）、给予方 */
  roles: Record<SceneRole, string>;
  /** 两个人在场景里穿的（角色包的衣着名） */
  outfit: string;
  fps: number;
  frames: number;
  segments: SceneSegment[];
  variants: PackVariant[];
  defaultVariant: string;
  facings: Facing[];
  /** （开源版省略） */
  stains?: Record<SceneRole, number[]>;
  surface?: Record<SceneRole, string>;
  /** （开源版省略） */
  creampie?: {role: SceneRole; hold: number; fade: number};
  /** （开源版省略） */
  after?: Partial<Record<SceneRole, AfterFlow[]>>;
}

/** 场景图集的帧表：SheetMeta（朝向 = 接受方的朝向）+ 两个人的位置 */
export interface SceneSheetMeta extends SheetMeta {
  scene: string;
  /** 所有帧不透明像素的横向范围（渲染像素，相对锚点 foot[0]）：放得下才在那条线段上做 */
  span: [number, number];
  /** 每帧两个人髋骨正下方地面点的横向位置（渲染像素，相对锚点）和朝向（1 右、-1 左） */
  cast: Record<SceneRole, {dx: number[]; facing: (1 | -1)[]}>;
}

/** 场景的 sfx.json：两个角色各用规则里的哪个角色 + [精灵帧, 谁, effect]（按帧排好） */
export interface SceneSfx {
  voices: Record<SceneRole, string>;
  keys: [number, SceneRole, string][];
}

export interface ScenePack {
  manifest: SceneManifest;
  relDir: string;
  /** sfx.json；没导出时为 null / 没有 */
  sfx?: SceneSfx | null;
  /** 图集相对项目根的路径（不带扩展名） */
  sheetPath(variant: string, facing: Facing): string;
  sheet(variant: string, facing: Facing): SceneSheetMeta;
}

/** 读一个场景目录，校验格式、成年标记、每张图集都在且帧数对得上 */
export function loadScene(projectRoot: string, relDir: string): ScenePack {
  const dir = path.join(projectRoot, relDir);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'scene.json'), 'utf8')) as SceneManifest;
  const fail = (msg: string): never => { throw new Error(`场景 ${relDir}：${msg}`); };
  if (m.schema !== 1) fail(`不认识的 schema ${m.schema}`);
  if (m.adult !== true) fail('adult 不是 true，拒绝加载（R9.1）');
  if (!m.roles?.receiver || !m.roles?.giver) fail('roles 要有 receiver 和 giver');
  let prev = 0;
  for (const s of m.segments) {
    if (s.start !== prev || s.end <= s.start) fail(`段 ${s.clip} 的范围 [${s.start}, ${s.end}) 不连续`);
    if (s.loop && (s.loop[0] < s.start || s.loop[1] > s.end || s.loop[1] <= s.loop[0])) fail(`段 ${s.clip} 的 loop 不在段内`);
    prev = s.end;
  }
  if (prev !== m.frames) fail(`段一共 ${prev} 帧，frames 是 ${m.frames}`);
  const relPosix = relDir.split(path.sep).join('/');
  const sheets = new Map<string, SceneSheetMeta>();
  for (const v of m.variants) for (const f of m.facings) {
    const base = path.join(dir, 'sprites', v.id, f);
    if (!fs.existsSync(base + '.json')) fail(`缺图集 ${v.id}/${f}（重跑 npm run export:scenes）`);
    const s = JSON.parse(fs.readFileSync(base + '.json', 'utf8')) as SceneSheetMeta;
    for (let i = 0; i < chunkCount(s); i++) if (!fs.existsSync(sheetFile(base, s.chunk ? i : null))) fail(`缺图集 ${v.id}/${f} 的图（重跑 npm run export:scenes）`);
    if (s.frames !== m.frames || s.fps !== m.fps) fail(`${v.id}/${f} 的帧数 / 帧率和 scene.json 不一致`);
    if (s.cast.receiver.dx.length !== m.frames || s.cast.giver.dx.length !== m.frames || s.footY?.length !== m.frames) fail(`${v.id}/${f} 的逐帧数据长度不对`);
    if (s.floor?.some(([fr]) => fr < 0 || fr >= m.frames)) fail(`${v.id}/${f} 的 floor 帧号超出范围`);
    sheets.set(`${v.id}/${f}`, s);
  }
  const sfxFile = path.join(dir, 'sfx.json');
  let sfx: SceneSfx | null = null;
  if (fs.existsSync(sfxFile)) {
    sfx = JSON.parse(fs.readFileSync(sfxFile, 'utf8')) as SceneSfx;
    if (sfx.keys.some(([f, r]) => f < 0 || f >= m.frames || (r !== 'receiver' && r !== 'giver'))) fail('sfx.json 的帧号或角色不对（重跑 export_sfx.py）');
  }
  return {
    manifest: m,
    relDir: relPosix,
    sfx,
    sheetPath: (v, f) => `${relPosix}/sprites/${v}/${f}`,
    sheet: (v, f) => sheets.get(`${v}/${f}`) ?? fail(`没有图集 ${v}/${f}`),
  };
}

/**
 * packs/_scenes/ 下所有场景（有 scene.json 的目录），按 id；没有这个目录时为空。给了 packs 时核对表面编号：场景的
 * surface.<角色> 和那个角色包的 surface.hash 不一样（只重导了一边）就去掉这个场景的 stains，warn 记一条。
 */
export function loadScenes(projectRoot: string, packs: readonly Pack[] = [], warn: (msg: string) => void = () => {}): Map<string, ScenePack> {
  const root = path.join(projectRoot, 'packs', '_scenes');
  if (!fs.existsSync(root)) return new Map();
  return new Map(fs.readdirSync(root, {withFileTypes: true})
    .filter(d => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'scene.json'))).map(d => d.name).sort()
    .map(n => {
      const s = loadScene(projectRoot, path.join('packs', '_scenes', n)), m = s.manifest;
      if (m.stains) for (const role of ['receiver', 'giver'] as const) {
        const pk = packs.find(p => p.manifest.id === m.roles[role]);
        if (pk && pk.manifest.surface?.hash !== m.surface?.[role]) {
          warn(`场景 ${m.id} 的表面编号和角色包 ${pk.manifest.id} 对不上（场景 ${m.surface?.[role]}，角色包 ${pk.manifest.surface?.hash}），不用这个场景的 stains；两边都重导`);
          delete m.stains;
          break;
        }
      }
      return [m.id, s] as const;
    }));
}

/** packs/_sfx/sfx.json（原版 mod 的音效规则和文件）；没导出时为 null。每个文件都要在 */
export function loadSfx(projectRoot: string): SfxManifest | null {
  const file = path.join(projectRoot, 'packs', '_sfx', 'sfx.json');
  if (!fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, 'utf8')) as SfxManifest;
  if (m.schema !== 1) throw new Error(`packs/_sfx/sfx.json：不认识的 schema ${m.schema}`);
  for (const [g, fs_] of Object.entries(m.files)) for (const f of fs_) {
    if (!fs.existsSync(path.join(projectRoot, 'packs', '_sfx', 'sounds', f.file))) throw new Error(`packs/_sfx：缺声音文件 ${f.file}（组 ${g}，重跑 export_sfx.py）`);
  }
  return m;
}
