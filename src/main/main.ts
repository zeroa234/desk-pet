import {ScreenCapture} from './screen-capture.ts';
import {Observer} from '../vision/index.ts';
import {LlmRuntime, limitText} from '../llm/runtime.ts';
import {redact} from '../llm/redact.ts';
import {createLlmSettings} from './llm-settings.ts';
import {createSettingsWindow} from './settings-window.ts';
import {checkPatch} from './settings-patch.ts';
import {createTranslator, displayName, resolveLang, type Key, type Translator} from '../shared/i18n.ts';
import {msg} from '../shared/msg.ts';
import {EDITABLE, RESTART_KEYS, type EditableKey, type Result, type SettingsAction, type SettingsPatch, type SettingsView} from '../settings/protocol.ts';
import type {StageSpeech} from '../stage/speech.ts';
// desk-pet 主进程入口。
//   npm start（= electron src/main/main.ts）
// 组装：平台层（Win32）→ 桌面快照 → Sim（支撑面、行为系统、状态机）→ 每个显示器一个覆盖窗口（舞台）+ 躲藏层的小窗口。
// 主进程是唯一的状态来源（design.md §1）。
//   - 覆盖窗口：每个显示器一个，透明、无框、置顶、不进任务栏、不抢焦点、默认鼠标穿透（R8.2、design.md §5.2）。
//     高度比显示器少 1 个逻辑像素：2026-10-20 实测铺满整个显示器的置顶窗口会让 SHQueryUserNotificationState 变成 busy
//     （系统当它是全屏应用，压掉用户的通知，我们自己的全屏检测也会把自己藏起来），少 1 像素就是 accepts-notifications。
//     Electron 默认把窗口限制在工作区内，要 enableLargerThanScreen 才能盖到任务栏那一块
//   - 躲藏层（阶段 2，R2.3，docs/desktop-interaction.md §2.2 的 behind:W）：躲在窗口 W 后面的角色画在一个单独的透明小窗口里，
//     用 SetWindowPos 插在 W 正下方（会自动失去置顶，阶段 0 实测）。窗口按要画的范围摆，范围超出才挪（躲着时基本不动，
//     阶段 0 实测每帧挪窗口 dwm 要单核 11–12%）；用户点了 W 或别的窗口时 z 序会变，每次刷新桌面查一下还在不在 W 正下方，
//     不在就重新插。窗口用完不关，藏起来留着下次用（少开渲染进程）。
//   - 主循环：自己排下一次（setTimeout 链）；有角色在下落 / 被拖 / 在跳 / 有特效、用户在拖窗口时 30 Hz，否则只在下一帧该换时醒
//   - 窗口变化（design.md §6，2026-10-21 起代替轮询）：平台层的 watchWindows 收窗口事件（切前台、拖窗口、最小化、关闭、显示 / 隐藏、
//     cloak 全局收，位置变化只收角色跟着的窗口所在的进程），有关的事件来了就把下一 tick 提前、重新枚举桌面（watch.ts 判哪些有关）；
//     另外每 DESKTOP_REFRESH 秒全量枚举一次兜底
//   - 每秒查一次全屏 / 演示（R8.5）；老板键（R8.5）；托盘（R8.1）；显示器增减、缩放变化时重建覆盖窗口（R8.3）
//   - 存档 data/save.json（R8.9）：状态值、好感、解锁、累计时长、衣着；每 60 秒和退出时写，启动时按离线时长补状态值（最多 2 小时）
//   - 状态事件写 logs/events-YYYY-MM-DD.jsonl（R13.3 回放用）
//   - 用户离开（N3.1，2026-10-21）：每秒按 Electron powerMonitor（空闲秒数、锁屏 / 屏保）和 SHQueryUserNotificationState 的 not-present
//     判一次（away.ts），锁屏 / 解锁事件来了马上判；离开、回来时告诉 Sim（回来那一刻桌宠看得见才算撞见）
//   - 音效（R2.8、R6.3，2026-10-20）：Sim 每 tick 给出该响的 effect（SoundCue），这里按原版规则（src/sound/ 的 Voice，每个角色一个）
//     挑声音、算增益和左右声像，发给第一个覆盖窗口（audioSurface）播；藏起来、暂停、关声音、全年龄模式时不放，藏起来时停掉正在响的
// 自写；窗口、托盘、热键、屏幕都是 Electron 自带 API，Win32 走 src/platform/。
import {app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, systemPreferences, Tray, type MenuItemConstructorOptions} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {PROJECT, handleProtocol, setupPaths} from './env.ts';
import {DEFAULT_SETTINGS, SettingsStore, absentIds, type Settings} from './settings.ts';
import {dndLabel, dndReason} from './dnd.ts';
import {AwayTracker} from './away.ts';
import {DesktopWatch} from './watch.ts';
import {overlayOrderRepair} from './overlay-order.ts';
import {layerBounds, layerPad} from './layer-bounds.ts';
import {Sim, type SimEvent} from './sim.ts';
import {SimClock} from './sim-clock.ts';
import {createWin32Platform, type WindowWatch} from '../platform/index.ts';
import {loadPacks, loadScenes, loadSfx, type PackVariant} from '../pack/index.ts';
import {Voice} from '../sound/index.ts';
import {DEFAULT_TUNING} from '../behavior/index.ts';
import {OFFLINE_CAP_SEC, loadSave, offlineSeconds, writeSave} from '../store/index.ts';
import type {DisplayInfo, NotificationState, Point, Rect, WinEvent} from '../shared/types.ts';
import {shiftBlots, type DrawItem, type StageFrame, type StageInit, type StagePassive, type StagePoke, type StageSound, type StageStat} from '../stage/protocol.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAST_TICK = 1 / 30;      // 下落、拖拽、跳、有特效、用户在拖窗口、开着调试层时的 tick 间隔（秒）
const IDLE_TICK_MAX = 0.25;    // 慢速时最长多久醒一次（暂停、隐藏时也按这个查要不要恢复）
const STALL_SEC = 2;           // 两次 tick 隔了这么久以上（平时最多隔 IDLE_TICK_MAX）= 睡眠、合盖、主线程卡住，多出来的按关着程序算（tick）
// 没收到窗口事件时多久全量枚举一次兜底（秒）。2026-10-21 以前没有窗口事件，慢速时每 0.2 秒、站在窗口上 / 躲着时每 tick 枚举
const DESKTOP_REFRESH = 1;
const SAVE_EVERY = 60;         // 存档间隔（秒）

setupPaths();
if (!app.requestSingleInstanceLock()) app.exit(0);
// 已经在运行时再启动一次（双击快捷方式、开始菜单，scripts/make-shortcut.ps1）：不开第二个，把设置窗口拿到前面
app.on('second-instance', () => { if (app.isReady()) openSettings(); });
// 关掉 Chromium 的原生窗口遮挡检测（CalculateNativeWinOcclusion，默认开）：它判定窗口被别的窗口整个盖住时走 WasOccluded，
// 把页面接收点击的子窗口藏起来；页面设了 backgroundThrottling: false，盖住的窗口挪开以后不会放回，角色拎不起来
// （2026-10-20 实测：置顶全屏窗口盖 3 秒再挪开，子窗口一直不可见；关掉以后一直可见、能拎）。桌宠的窗口本来就要一直画
// （躲藏层就是故意插在别的窗口下面），遮挡检测对我们没用。见 hideSurface 和 platform/win32.ts 的 showInputChild。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// 音效：舞台页面没有用户手势也要能出声（Chromium 默认的自动播放策略会让 AudioContext 停在 suspended）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 临时改设置（不存盘，验收脚本用）：
//   环境变量 DESK_PET_SET='{"键": 值, …}'（JSON 对象，脚本都用这个）；
//   命令行 --set 键=值（手动用，只适合简单值；值按 JSON 解析，解析不了当字符串）。
//   对象类的值（如 tuning）不要放命令行：2026-10-20 实测，参数里有 {…:…} 而且后面还跟着别的非开关参数时，
//   electron.exe 在 JS 跑起来之前就以 -1 退出（原因没查）。
// --spawn=x,y：第一个角色出生的脚底点，物理像素。DESK_PET_SAVE：存档文件（验收脚本用临时存档，不动用户的；给了 DESK_PET_PACKS 没给它时默认
// temp/packs-test/save.json）。DESK_PET_PACKS=包目录,包目录：只加载这几个角色包（测新导出的包，docs/pack-format.md §8.4）。
// DESK_PET_SCENES=场景,场景：只加载这几个双人场景（验收脚本 probe-duo.ts --scene 用，指定看哪个场景）。
// （开源版省略）
const argv = process.argv.slice(2);
const overrides = {
  ...JSON.parse(process.env.DESK_PET_SET || '{}'),
  ...Object.fromEntries(argv.filter((a, i) => argv[i - 1] === '--set').map(kv => {
    const i = kv.indexOf('='), k = kv.slice(0, i), v = kv.slice(i + 1);
    try { return [k, JSON.parse(v)]; } catch { return [k, v]; }
  })),
};
const spawnArg = argv.find(a => a.startsWith('--spawn='))?.slice(8).split(',').map(Number);
const settings = new SettingsStore(path.join(PROJECT, 'data', 'settings.json'), overrides);
// 界面语言（托盘、提示、对话气泡上“对谁说”、设置窗口；src/shared/i18n.ts）。系统语言要 app ready 以后才读得准，whenReady 里 applyLanguage 再算一次
let tr: Translator = createTranslator(resolveLang(settings.value.language, []));
/** 角色的显示名（按界面语言；发给模型的照旧用 manifest.name） */
const nameOf = (id: string): string => { const p = packs.find(x => x.manifest.id === id); return p ? displayName(p.manifest, tr.lang) : id; };
const platform = createWin32Platform();
// DESK_PET_PACKS：只加载这几个包（逗号分隔，相对项目根；测试新导出的包用，docs/pack-format.md §8.4）
const packs = loadPacks(PROJECT, (process.env.DESK_PET_PACKS ?? '').split(',').filter(Boolean));
if (!packs.length) throw new Error('packs/ 下没有角色包（放一个角色包进去，格式见 docs/pack-format.md）');
const offBehaviors = (process.env.DESK_PET_OFF ?? '').split(',').filter(Boolean);
if (offBehaviors.length) for (const p of packs) if (p.mind) p.mind = {...p.mind, behaviors: p.mind.behaviors.filter(b => !offBehaviors.includes(b.id))};
// 画面变体：所有包的并集（像素风那几套每个包都有；高清这类 style 的变体可以只有部分包有，没有的包用自己的默认变体，docs/pack-format.md §6）
const allVariants = [...new Map(packs.flatMap(p => p.manifest.variants).map(v => [v.id, v])).values()];
const variantOk = (id: string | null) => !!id && allVariants.some(v => v.id === id);
// 只加载指定的包（DESK_PET_PACKS）又没给存档时，存到 temp/ 下：存档只写加载了的角色，写回 data/save.json 会把别的角色的进度冲掉
const saveFile = process.env.DESK_PET_SAVE ? path.resolve(PROJECT, process.env.DESK_PET_SAVE)
  : process.env.DESK_PET_PACKS ? path.join(PROJECT, 'temp', 'packs-test', 'save.json') : path.join(PROJECT, 'data', 'save.json');
const saved = loadSave(saveFile);
const loadWarnings: string[] = [];   // 加载时的警告（场景和角色包的表面编号对不上等），事件日志开了以后写
const onlyScenes = <T>(m: Map<string, T>, only?: string) => only ? new Map([...m].filter(([id]) => only.split(',').includes(id))) : m;
const sim = new Sim(packs, {...DEFAULT_TUNING, ...settings.value.tuning}, {
  variant: variantOk(settings.value.variant) ? settings.value.variant! : packs[0].manifest.defaultVariant,
  heightLogical: settings.value.heightLogical,
  r18: settings.value.r18,
}, Math.random, saved, onlyScenes(loadScenes(PROJECT, packs, w => loadWarnings.push(w)), process.env.DESK_PET_SCENES));   // 双人场景 packs/_scenes/（没导出时为空，双人行为选不上）
sim.setLlmControlSeconds(settings.value.llmControlSec);
// 哪些角色不在桌面上（托盘“在桌面上”）：选过的照选的，没选过的（包括新装的）按各角色包 behaviors.json 的 desktopDefault。
// 2026-10-22 存的 absentChars 是当时全部角色的清单（以后新装的不在清单里就会直接出现），换成 onDesktop：清单上的这些角色各记一笔
const desktopPacks = packs.map(p => ({id: p.manifest.id, defaultAbsent: p.mind?.desktopDefault === 'absent'}));
const legacyAbsent = settings.stored('absentChars');
if (legacyAbsent && settings.stored('onDesktop') === undefined) {
  settings.migrate('onDesktop', Object.fromEntries(desktopPacks.map(p => [p.id, !legacyAbsent.includes(p.id)])));
  settings.migrate('absentChars', null);
}
sim.setAbsent(absentIds(settings.value, desktopPacks));
sim.setPopulationLimit(settings.value.maxOnDesktop, false);
// 原版 mod 的音效规则和文件（packs/_sfx/，没导出时为 null，不出声）；每个角色一个 Voice（计数器、“上一次放的”各自记）
const sfx = loadSfx(PROJECT);
const voices = new Map<string, Voice>();
// behaviors.json 的反应要放的声音（ReactionDef.sound）得是这个角色那套规则里有的 effect，没有就记警告（照样能跑，只是不出声）
if (sfx) for (const p of packs) for (const [key, raw] of Object.entries(p.mind?.reactions ?? {})) if (!key.startsWith('_')) for (const r of Array.isArray(raw) ? raw : [raw]) {
  const voice = p.sfx?.voice;
  if (r.sound && (!voice || !sfx.voices[voice]?.events[r.sound])) loadWarnings.push(`角色包 ${p.manifest.id} 的反应 ${key} 要放 ${r.sound}，规则 ${voice ?? '（没有 sfx.json）'} 里没有（重跑 export_sfx.py？）`);
}
// 离线追赶：上次存档到现在的状态值变化（最多 2 小时）；第一次运行（空存档，savedAt = 0）不补。开着时电脑睡眠回来也走这里（tick）
const catchUp = (sec: number) => { for (const id of sim.unlocked) sim.charOf(id)!.brain.tick(sec); };
const offline = saved.savedAt ? offlineSeconds(saved, Date.now()) : 0;
catchUp(offline);

// ---------- 事件日志 ----------
const logDir = path.join(PROJECT, 'logs');
fs.mkdirSync(logDir, {recursive: true});
function logEvent(rec: object): void {
  // 同步追加：事件很稀（每秒最多几条），同步写才能保证顺序
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(logDir, `events-${day}.jsonl`), JSON.stringify(redact({t: Date.now(), ...rec})) + '\n');
}
let llm: LlmRuntime | null = null;
try {
  llm = new LlmRuntime(PROJECT, sim, logEvent); llm.setEnabled(settings.value.llmEnabled);
  // 被上限挡下：托盘气泡提示（同一种上限一小时最多一次，不出声；Windows 勿扰开着时由系统处理），托盘悬停文字一直显示到恢复
  llm.onLimit = (block, notify) => {
    if (block && notify) tray?.displayBalloon({iconType: 'warning', noSound: true,
      title: tr.t(block.reason === 'hourly' ? 'balloon.hourlyTitle' : 'balloon.dailyTitle'),
      content: tr.t('balloon.limitBody', {status: tr.m(limitText(block))}) + (block.reason === 'hourly' ? ' ' + tr.t('balloon.limitHint') : '')});
    updateTray();
  };
}
catch { logEvent({type:'llm-unavailable', reason:'configuration-or-storage'}); }
const capture = llm ? new ScreenCapture(platform,()=>llm!.config.vision,()=>!quitting && !settings.value.paused && !isHidden() && sim.away?.kind!=='locked' && sim.userIdleSec<1800,(w,was)=>surfaces().some(s=>s.win===w)?settings.value.hideFromCapture:was) : null;
const observer = llm && capture ? new Observer({config:()=>llm!.config.vision,active:()=>llm!.visionActive(),
  characters:()=>llm!.visionCharacters(),target:()=>capture.target(),capture:target=>capture.capture(target),
  deliver:(id,generation,frame,manual)=>llm!.observe(id,generation,frame,manual)}) : null;
if(observer)observer.onStatus=(message,manual)=>{
  logEvent({type:'vision-status',manual,result:message});
  if(manual&&message.key.startsWith('status.vision.failed'))tray?.displayBalloon({iconType:'info',noSound:true,title:tr.t('balloon.visionFailedTitle'),content:tr.t('balloon.visionFailedBody',{status:tr.m(message)})});
  updateTray();
};
if(llm)llm.onVisionChange=id=>{observer?.reset(id);updateTray();};
/** 现在能不能让她看一次屏幕（托盘、设置窗口的“看一次”） */
const canLook = (id: string) => !!llm?.config.vision.enabled && settings.value.llmEnabled && !!llm?.visionCharacters().some(c => c.id === id && c.capable);
const llmSettings = llm ? createLlmSettings(PROJECT, llm, packs.map(p => ({id: p.manifest.id, dir: p.relDir})), {nameOf, canLook,
  visionLatest: () => observer?.latest ?? msg('status.vision.unavailable'), look: id => !!observer?.request(id), volume: () => settings.value.volume}) : null;
const speechSent = new Map<number,string>();
function sendSpeech(): void {
  const active = llm?.active;
  for (const o of overlays) {
    if (!o.ready || o.win.isDestroyed()) continue;
    const a = active && sim.chars.get(active.ticket.speaker)?.actor;
    const show = !!a && a.x>=o.display.bounds.left && a.x<o.display.bounds.right && a.y>o.display.bounds.top && a.y<=o.display.bounds.bottom;
    const play = !!active && audioSurface()?.win===o.win && settings.value.speechSound && !dnd && !isHidden() && !settings.value.paused;
    const key = active && a ? `${active.token}:${show}:${play}:${settings.value.volume}:${Math.round(a.x)}:${Math.round(a.y)}` : '-';
    const id=o.win.webContents.id; if(speechSent.get(id)===key)continue; speechSent.set(id,key);
    const speech: StageSpeech|null = active && a ? {token:active.token,speaker:a.id,text:active.ticket.text,aside:active.ticket.aside,
      units:active.units,voice:active.voice,x:a.x-o.display.bounds.left,y:a.y-o.display.bounds.top-settings.value.heightLogical*o.display.scale*(sim.chars.get(a.id)?.spec.heightRatio??1),
      show,play,volume:settings.value.volume,elapsed:Math.max(0,sim.now-active.start),
      toLabel:active.ticket.to==='self'?tr.t('bubble.toSelf'):active.ticket.to&&active.ticket.to!=='user'?tr.t('bubble.to',{name:nameOf(active.ticket.to)}):undefined} : null;
    o.win.webContents.send('stage:speech',speech);
  }
}
for (const msg of loadWarnings) { console.warn(msg); logEvent({type: 'load-warning', msg}); }
function save(): void {
  try { writeSave(saveFile, {schema: 1, savedAt: 0, ...sim.saveState()}, Date.now()); }
  catch (e) { console.error('存档失败', e); }
}

// ---------- 显示器和覆盖窗口 ----------
const rectOf = (r: Electron.Rectangle): Rect => ({left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height});
/** 显示器信息（物理像素）；list 给了就按它换（建覆盖窗口时和建窗口用同一次 getAllDisplays，不按下标配两次读的结果） */
function readDisplays(list = screen.getAllDisplays()): DisplayInfo[] {
  return list.map(d => ({id: d.id, scale: d.scaleFactor,
    bounds: rectOf(screen.dipToScreenRect(null, d.bounds)), workArea: rectOf(screen.dipToScreenRect(null, d.workArea))}));
}
const hwndOf = (w: BrowserWindow) => Number(w.getNativeWindowHandle().readBigUInt64LE(0));
const stageWebPrefs = {preload: path.join(HERE, '../stage/preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false};

/** 一块画布窗口：覆盖窗口（front，每个显示器一个）或躲藏层的小窗口 */
interface Surface {
  win: BrowserWindow;
  ready: boolean;
  last: string;
  hover: boolean;
}
interface Overlay extends Surface {
  display: DisplayInfo;
}
interface LayerWin extends Surface {
  /** 插在哪个窗口旁边；0 = 空闲（藏着） */
  target: number;
  /** below = 插在 target 正下方（躲窗口，behind）；above = 插在 target 正上方、画面裁到它里面（在窗口里面，inside，N2.4） */
  mode: 'below' | 'above';
  /** 窗口现在占的物理像素矩形（从 getBounds 换回来的，不是想要的） */
  phys: Rect | null;
  /** 上次插 z 序时的窗口顺序（变了就要查一次还在不在 target 下面） */
  order: string;
}
let overlays: Overlay[] = [];
const layers: LayerWin[] = [];

function createOverlays(): void {
  for (const o of overlays) o.win.destroy();
  // 每个覆盖窗口的转发统计（stage:stat）按窗口记，旧窗口的一起清掉
  lastCursorAt.clear(); quietSec.clear();
  const all = screen.getAllDisplays(), displays = readDisplays(all);
  overlays = all.map((d, i) => {
    const dip = {x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height - 1};
    const win = new BrowserWindow({...dip, enableLargerThanScreen: true, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, minimizable: false,
      maximizable: false, focusable: false, hasShadow: false, show: false, backgroundColor: '#00000000', title: 'desk-pet',
      webPreferences: stageWebPrefs});
    win.setIgnoreMouseEvents(true, {forward: true});
    win.setContentProtection(settings.value.hideFromCapture);
    win.once('show', () => win.setBounds(dip));
    void win.loadURL('pet://app/src/stage/stage.html');
    return {display: displays[i], win, ready: false, last: '', hover: false};
  });
  sim.setDesktop({displays, windows: sim.desktop.windows});
  watch.dirty = true;   // 覆盖窗口换了，上面压着谁要重查
  applyVisibility();
}

function createLayer(): LayerWin {
  const win = new BrowserWindow({width: 64, height: 64, transparent: true, frame: false, alwaysOnTop: false, skipTaskbar: true, resizable: false,
    movable: false, minimizable: false, maximizable: false, focusable: false, hasShadow: false, show: false, backgroundColor: '#00000000',
    title: 'desk-pet-layer', enableLargerThanScreen: true, webPreferences: stageWebPrefs});
  win.setIgnoreMouseEvents(true, {forward: true});
  win.setContentProtection(settings.value.hideFromCapture);
  void win.loadURL('pet://app/src/stage/stage.html');
  const l: LayerWin = {win, ready: false, last: '', hover: false, target: 0, mode: 'below', phys: null, order: ''};
  layers.push(l);
  return l;
}

const surfaces = (): Surface[] => [...overlays, ...layers];
/**
 * 藏起 / 再显示一块画布窗口。页面平时 backgroundThrottling: false（窗口藏着、被遮挡也照常画），但这样藏起来时页面不进“隐藏”，
 * 再显示时 Chromium 不走自己的恢复路径（RenderWidgetHostViewAura::UpdateLegacyWin），接收点击的子窗口
 * Chrome_RenderWidgetHostHWND 一直不可见、拎不起来（2026-10-20，原因见 platform/win32.ts 的 showInputChild）。
 * 所以藏之前临时打开节流（页面真的进“隐藏”，和 Chrome 切标签页一样），显示以后再关回去。
 * Electron 44.5.1 的 WebContents::SetBackgroundThrottling：页面看得见时打开、关上都不动可见状态；隐藏期间关掉才会碰到
 * PR #52844 的“显示后空白”，这里不在隐藏期间关。
 */
function hideSurface(s: Surface): void {
  if (!s.win.isVisible()) return;
  s.win.webContents.setBackgroundThrottling(true);
  s.win.hide();
}
function showSurface(s: Surface): void {
  s.win.showInactive();
  s.win.webContents.setBackgroundThrottling(false);
}
/** 把一块画布窗口设回穿透，并告诉页面（页面也记着光标在不在角色上，两边要一致；cursorStale 见 StagePassive） */
function makePassive(s: Surface, cursorStale: boolean): void {
  s.hover = false;
  s.win.setIgnoreMouseEvents(true, {forward: true});
  if (s.ready) s.win.webContents.send('stage:passive', {cursorStale} satisfies StagePassive);
}
// 舞台页面的报错记进事件日志（判点、画图出错时页面不会崩，只在控制台里，以前看不到）
app.on('web-contents-created', (_e, wc) => wc.on('console-message', e => {
  if ((e.level === 'error' || e.level === 'warning') && !String(e.message).includes('Electron Security Warning')) logEvent({type: 'stage-console', level: e.level, message: String(e.message).slice(0, 500)});
}));
const surfaceOf = (wc: Electron.WebContents) => surfaces().find(s => s.win.webContents === wc);
ipcMain.on('stage:ready', e => {
  const s = surfaceOf(e.sender);
  if (!s) return;
  s.ready = true; s.last = '';
  const o = overlays.find(x => x === s);
  const scale = o ? o.display.scale : screen.getDisplayMatching(s.win.getBounds()).scaleFactor, wb = s.win.getBounds();
  s.win.webContents.send('stage:init', {width: Math.round(wb.width * scale), height: Math.round(wb.height * scale),
    sheetBudgetMB: settings.value.sheetBudgetMB, pressMs: settings.value.pressMs} satisfies StageInit);
});
ipcMain.on('stage:hover', (e, over: boolean) => {
  const s = surfaceOf(e.sender);
  if (!s || sim.dragging()) return;
  const surface = overlays.includes(s as Overlay) ? 'overlay' : 'layer';
  // 要接收点击了：兜底确认 Chromium 接收点击的子窗口是可见的（2026-10-20 用户报的“藏起来再出来以后拖不动”就是它被藏了，
  // 原因见 platform/win32.ts）。会藏它的两条路已经从源头处理：自己藏窗口走 hideSurface / showSurface，遮挡检测启动时关掉；
  // 日志里再出现 input-child-shown 说明还有别的路在藏它，要查
  if (over && platform.showInputChild(hwndOf(s.win))) logEvent({type: 'input-child-shown', surface});
  s.hover = over;
  s.win.setIgnoreMouseEvents(!over, {forward: true});
  logEvent({type: 'hover', over, surface});
});

/**
 * 鼠标转发（setIgnoreMouseEvents 的 forward：Electron 在 Windows 上用一个全局低级鼠标钩子把 mousemove 转给穿透的窗口）重新装一遍：
 * 先把所有穿透着的窗口的 forward 关掉（Electron 在一个都不转发时摘掉钩子），再打开（重新装钩子）。
 * 防的是：低级鼠标钩子处理超时（主线程卡住超过 LowLevelHooksTimeout，Win10 1709 起最多 1 秒）时，Windows 7 起系统会悄悄摘掉钩子、
 * 不通知（微软 LowLevelMouseProc 文档 Remarks）。只在“光标在动、舞台却收不到 mousemove”时重装，并记日志（forward-lost）。
 * 2026-10-20 排查“藏起来再出来以后拖不动”时加的，但那个问题不是转发断了（悬停一直正常），原因见 stage:hover 和 platform/win32.ts；
 * 这里的“转发断了”本机没实测复现过（主线程卡 3 秒以后转发照常），留着兜底。
 */
function rearmForwarding(reason: string): void {
  const passive = surfaces().filter(s => !s.hover);
  for (const s of passive) s.win.setIgnoreMouseEvents(true, {forward: false});
  for (const s of passive) s.win.setIgnoreMouseEvents(true, {forward: true});
  logEvent({type: 'forward-rearm', reason, windows: passive.length});
}
// 舞台每秒的统计：光标在这个覆盖窗口的显示器里动了、页面却连续 2 秒一次 mousemove 都没收到（也不在角色上）→ 转发断了，重装
const lastCursorAt = new Map<Surface, Point>(), quietSec = new Map<Surface, number>();
ipcMain.on('stage:stat', (e, v: StageStat) => {
  const s = surfaceOf(e.sender), o = overlays.find(x => x === s);
  if (!s || !o || isHidden() || sim.dragging()) return;
  const c = platform.cursorPos(), prev = lastCursorAt.get(s), b = rectOf(screen.dipToScreenRect(o.win, o.win.getBounds()));
  lastCursorAt.set(s, c);
  const inside = c.x >= b.left && c.x < b.right && c.y >= b.top && c.y < b.bottom;
  const moved = !!prev && (prev.x !== c.x || prev.y !== c.y);
  const quiet = inside && moved && v.moves === 0 && !v.hover ? (quietSec.get(s) ?? 0) + 1 : 0;
  quietSec.set(s, quiet);
  if (quiet >= 2) {
    quietSec.set(s, 0);
    // 重装过 10 秒内又断：重装不管用，整个重建覆盖窗口（页面重读，角色状态在主进程里不受影响）
    const again = performance.now() - lastLost < 10_000;
    lastLost = performance.now();
    logEvent({type: 'forward-lost', display: o.display.id, cursor: c, stat: v, action: again ? 'recreate' : 'rearm'});
    if (again) createOverlays(); else rearmForwarding('no-mousemove');
  }
});
let lastLost = -Infinity;
// 暂停、隐藏时不拎（和点一样）。2026-10-21 用户暂停时试着拖：以前这里不拦，sim.grab 照样把计划中止、记成被拎着，
// （开源版省略）
ipcMain.on('stage:grab', (_e, id: string) => {
  if (settings.value.paused || isHidden()) { logEvent({type: 'grab-ignored', id, paused: settings.value.paused}); return; }
  sim.grab(id, platform.cursorPos());
  logEvent({type: 'grab', id});
});
// 点了一下 / 来回摸（R3.6）：Sim 挑反应（事件 poke 由 sim.step 带出来写日志）；有特效、换了计划的话下一 tick 就画
ipcMain.on('stage:poke', (_e, v: StagePoke) => {
  if (settings.value.paused || isHidden()) return;
  sim.poke(v.id, typeof v.part === 'number' ? v.part : null, v.kind === 'stroke' ? 'stroke' : 'click', platform.cursorPos());
});

/**
 * 躲藏层 / 窗口里面那一层：每个（目标窗口、上下）一块小窗口。范围（要画的东西 + 边距）超出窗口现在的范围才挪；第一次出现、或者
 * 窗口顺序变了而且不在目标正下方（正上方）时重新插 z 序（先插好再发画面，避免在别的窗口上面闪一帧）。不用的藏起来。
 * 在窗口里面那一层（above，N2.4）：用户点了目标窗口、它跳到最前面时，这块小窗口留在原处就跑到它后面去了；每帧查一次，不在它正上方就
 * 插回去（中间可能闪一帧，docs/desktop-interaction.md §2.2）。
 */
function syncLayers(behind: Map<number, {items: DrawItem[]; rect: Rect}>, inside: Map<number, {items: DrawItem[]; rect: Rect}>, cursor: StageFrame['cursor']): void {
  const order = sim.desktop.windows.map(w => w.hwnd).join(',');
  const want = (mode: LayerWin['mode']) => mode === 'below' ? behind : inside;
  for (const l of layers) if (l.target && !want(l.mode).has(l.target)) { hideSurface(l); makePassive(l, true); l.target = 0; l.last = ''; }
  const jobs = [...[...behind].map(([t, v]) => ({target: t, mode: 'below' as const, ...v})), ...[...inside].map(([t, v]) => ({target: t, mode: 'above' as const, ...v}))];
  for (const {target, mode, items, rect} of jobs) {
    const l = layers.find(x => x.target === target && x.mode === mode) ?? layers.find(x => !x.target) ?? createLayer();
    const fresh = l.target !== target || l.mode !== mode;
    l.target = target; l.mode = mode;
    if (!l.ready) continue;
    const d = sim.desktop.displays.find(x => rect.left < x.bounds.right && rect.right > x.bounds.left && rect.top < x.bounds.bottom && rect.bottom > x.bounds.top);
    const m = Math.round(8 * (d?.scale ?? 1));
    // 范围超出小窗口才重排；重排时横向多留一段，她接着走不用再排（以前只留一个边距，窗口里面走一秒重排约 5 次、画面抽动，layer-bounds.ts）
    const next = layerBounds(fresh ? null : l.phys, rect, {margin: m, pad: layerPad(rect, m), limit: d?.bounds ?? rect});
    if (next) {
      l.win.setBounds(screen.screenToDipRect(null, {x: next.left, y: next.top, width: next.right - next.left, height: next.bottom - next.top}));
      l.phys = rectOf(screen.dipToScreenRect(null, l.win.getBounds()));
      l.last = '';
    }
    const pet = hwndOf(l.win);
    if (!l.win.isVisible()) { showSurface(l); fresh || (l.order = ''); }
    // 窗口里面那一层每帧都查：用户点了目标窗口（或者别的程序把它提到前面）时它会盖到这块小窗口上面，而用户窗口的先后顺序不一定变
    // （它本来就在最前面），只看顺序会一直插不回去（2026-10-21 真机：测试窗口每秒提到最前面，她在窗口里面一直看不见）。
    // 查一次就是一个 GetWindow，很便宜；躲藏层照旧只在顺序变了时查（目标被提到前面时顺序一定变）
    if (fresh || l.order !== order || mode === 'above') {
      const placed = () => mode === 'below' ? platform.isDirectlyBelow(pet, target) : platform.isDirectlyAbove(pet, target);
      if (!placed()) {
        if (mode === 'below') platform.placeBelow(pet, target); else platform.placeAbove(pet, target);
        logEvent({type: 'layer-placed', target, mode, ok: placed()});
      }
      l.order = order;
    }
    const ox = l.phys!.left, oy = l.phys!.top;
    // 换成这块小窗口里的坐标：角色的脚底点、裁剪框、水珠（under / over 是画布上的绝对坐标；2026-10-21 以前躲藏层没挪水珠，
    // 躲着时滴的水画到了小窗口外面；2026-10-22 以前挪的时候丢了形状，高清的水珠在这一层画成方块）
    const local = items.map(it => ({...it, x: it.x - ox, y: it.y - oy, ...(it.clip ? {clip: [it.clip[0] - ox, it.clip[1] - oy, it.clip[2], it.clip[3]] as [number, number, number, number]} : {}),
      ...(it.under ? {under: shiftBlots(it.under, ox, oy)} : {}), ...(it.over ? {over: shiftBlots(it.over, ox, oy)} : {})}));
    const key = JSON.stringify(local) + cursor;
    if (key === l.last) continue;
    l.last = key;
    l.win.webContents.send('stage:frame', {items: local, cursor, debug: null} satisfies StageFrame);
  }
}

// ---------- 暂停、隐藏、全屏 ----------
let hiddenByBossKey = false;
let hiddenByFullscreen = false;
const isHidden = () => hiddenByBossKey || hiddenByFullscreen;
function applyVisibility(): void {
  if (isHidden()) stopSounds();
  for (const o of overlays) {
    if (isHidden()) hideSurface(o);
    else if (!o.win.isVisible()) { showSurface(o); o.win.setAlwaysOnTop(true); makePassive(o, true); }
  }
  // 躲藏层：隐藏时藏起来；恢复时由下一次 syncLayers 重新显示、重新插 z 序
  if (isHidden()) for (const l of layers) { hideSurface(l); makePassive(l, true); l.target = 0; l.last = ''; }
  updateTray();
}
/**
 * 每秒读一次的系统状态，全屏、勿扰、离开三个检查共用：SHQueryUserNotificationState（微软文档建议别频繁调，以前每秒调三次）、
 * 前台窗口是不是全屏（用到才查，查一次）。调试层也显示这一次读的
 */
interface Shell { notification: NotificationState; foregroundFull(): boolean }
let lastShell: NotificationState | null = null;
function readShell(): Shell {
  let full: boolean | undefined;
  const notification = lastShell = platform.notificationState();
  return {notification, foregroundFull: () => full ??= platform.foregroundIsFullscreen(sim.desktop.displays)};
}

function checkFullscreen(sh: Shell = readShell()): void {
  if (!settings.value.hideOnFullscreen) { if (hiddenByFullscreen) { hiddenByFullscreen = false; applyVisibility(); } return; }
  const fg = platform.foregroundWindow();
  const ours = surfaces().some(s => hwndOf(s.win) === fg);
  const state = sh.notification;
  const full = !ours && (state === 'busy' || state === 'd3d-fullscreen' || state === 'presentation' || sh.foregroundFull());
  if (full !== hiddenByFullscreen) {
    hiddenByFullscreen = full;
    logEvent({type: 'fullscreen', hidden: full, state});
    applyVisibility();
  }
}

// ---------- 勿扰（N8.1，2026-10-21）：不出声，原因见 dnd.ts ----------
let dnd: string | null = null;
/** 最近一次在前台的用户程序（前台窗口在桌面快照的窗口里：不是桌宠自己、任务栏、托盘弹窗），托盘“加上刚才在前台的”用 */
let lastApp = '';
function checkDnd(sh: Shell = readShell()): void {
  const s = settings.value, fg = platform.foregroundApp();
  const ours = !!fg && pids.includes(fg.pid);
  let trayDirty = false;
  if (fg?.exe && !ours && fg.exe !== lastApp && sim.desktop.windows.some(w => w.hwnd === fg.hwnd)) { lastApp = fg.exe; trayDirty = true; }
  const r = dndReason({manual: s.dndManual, followSystem: s.dndSystem, fullscreen: s.dndFullscreen, apps: s.dndApps,
    quietHours: s.dndSystem ? platform.quietHours() : null, notification: sh.notification,
    foregroundFull: s.dndFullscreen && !ours && sh.foregroundFull(), foregroundExe: fg?.exe || null, ours});
  if (r !== dnd) {
    dnd = r;
    if (r) stopSounds();
    logEvent({type: 'dnd', on: !!r, reason: r});
    trayDirty = true;
  }
  if (trayDirty) updateTray();
}

// ---------- 用户离开（N3.1，2026-10-21）：判法见 away.ts ----------
const away = new AwayTracker();
/** 锁屏 / 解锁事件记下的（powerMonitor 的 lock-screen / unlock-screen）；轮询时和 getSystemIdleState、not-present 一起算 */
let lockedByEvent = false;
function checkAway(sh: Shell = readShell()): void {
  const now = performance.now() / 1000;
  const locked = lockedByEvent || powerMonitor.getSystemIdleState(1) === 'locked' || sh.notification === 'not-present';
  const ch = away.update({now, idleSec: powerMonitor.getSystemIdleTime(), locked, afterSec: settings.value.awayAfterSec});
  sim.userIdleSec = away.idleSec(now);
  if (!ch) return;
  // 回来那一刻桌宠得看得见才算撞见（暂停、藏起来时只清掉离开期间的记号）；回来时撞见的 discovered 事件随下一 tick 写日志
  const seen = !settings.value.paused && !isHidden();
  if (ch.type === 'back') sim.setAway(null, sim.now, seen); else sim.setAway(ch.kind, sim.now);
  logEvent(ch.type === 'back' ? {...ch, sec: Math.round(ch.sec), seen} : ch);
  updateTray();
}
const awayLabel = () => away.state ? `你不在（${away.state.kind === 'locked' ? '锁屏' : '没动'}）` : '你在';

// 跟着窗口挪（followed）拖窗口时每 tick 都有，合并成每个角色每 0.5 秒最多一条（累计位移），不刷爆日志；firstAt 是这一条里第一次跟上的时刻
// （Date.now()，事件行的 t 是写的时刻，最多晚 0.5 秒；验收量“窗口挪了多久跟上”用 firstAt）
const followLog = {
  pending: new Map<string, {supportKey: string; dx: number; dy: number; since: number; firstAt: number}>(),
  add(id: string, supportKey: string, dx: number, dy: number, now: number): void {
    const p = this.pending.get(id);
    if (p && p.supportKey === supportKey) { p.dx += dx; p.dy += dy; }
    else { if (p) this.write(id, p); this.pending.set(id, {supportKey, dx, dy, since: now, firstAt: Date.now()}); }
  },
  /** only：只强制写掉这个角色的；不给就写掉攒了 0.5 秒以上的 */
  flush(now: number, only?: string): void {
    for (const [id, p] of this.pending) if (only ? id === only : now - p.since >= 0.5) { this.write(id, p); this.pending.delete(id); }
  },
  write(id: string, p: {supportKey: string; dx: number; dy: number; firstAt: number}): void {
    logEvent({id, type: 'followed', supportKey: p.supportKey, dx: p.dx, dy: p.dy, firstAt: p.firstAt});
  },
};

// ---------- tick ----------
const simClock = new SimClock(performance.now()/1000,{stallSec:STALL_SEC,recoveryStepSec:FAST_TICK});
let lastDesktop = 0;
let lastDebugSent = 0;
let lastSave = performance.now() / 1000;
const tickMs: number[] = [];
let perfTicks = 0;   // perf 事件里报这 10 秒跑了几个 tick（暂停、隐藏时不算）
let pids = [process.pid];   // 桌宠自己的进程（枚举窗口时排除）；samplePerf 每秒更新

// 窗口事件（见文件开头）：winWatch 在 app ready 以后装；listed 是上次枚举到的窗口（watch.onEvent 按它判事件有没有关系）
const watch = new DesktopWatch();
let winWatch: WindowWatch | null = null;
let listed = new Set<number>();
let followKey = '';
const winEvents = {all: 0, woke: 0};   // 平台层过滤以后的（窗口本身的）、其中叫醒主循环的；perfLog 开着时每 10 秒清零，没开时累计
let perfRaw = 0;   // 上一条 perf 事件时 winWatch.raw 是多少
/** 平台层的消息循环直接调进来（不在 libuv 回调里，见 Platform.watchWindows）：只记一下、排定时器。暂停、隐藏时不叫醒（tick 什么都不做），恢复后第一 tick 照样重算 */
function onWinEvent(e: WinEvent): void {
  winEvents.all++;
  if (watch.onEvent(e, listed, performance.now() / 1000) && !settings.value.paused && !isHidden()) { winEvents.woke++; wake(); }
}
/** 位置变化只收角色跟着的窗口（Sim.attachedWindows）所在的进程（platform 的 WindowWatch.followLocations） */
function syncFollow(): void {
  const hwnds = sim.attachedWindows();
  const ps = [...new Set(sim.desktop.windows.filter(w => hwnds.has(w.hwnd)).map(w => w.pid))].sort((a, b) => a - b);
  const key = ps.join(',');
  if (key === followKey || !winWatch) return;
  followKey = key;
  winWatch.followLocations(ps);
}

// Reuse desktop refresh / WinEvents; never add a separate topmost polling loop.
// Cap corrective calls at 1/s per overlay in case another application continuously rewrites its ordering.
const overlayRepairAt=new WeakMap<BrowserWindow,number>();
function refreshDesktop(): void {
  const windows = platform.listWindows(pids);
  listed = new Set(windows.map(w => w.hwnd));
  // 每个显示器的覆盖窗口上面压着的别的窗口（被盖住的反应，docs/desktop-interaction.md §2.7）：只留桌面快照里有的（用户看得见的）
  const overlayAbove: Record<number, number[]> = {};
  const known=new Map(windows.map(w=>[w.hwnd,w]));
  for (const o of overlays) if (o.win.isVisible()) {
    const hwnd=hwndOf(o.win);
    let above=platform.windowsAbove(hwnd).filter(h=>listed.has(h));
    const repair=overlayOrderRepair(platform.isTopmost(hwnd),above.map(h=>known.get(h)!)),now=performance.now();
    if(repair && now-(overlayRepairAt.get(o.win)??-Infinity)>=1000) {
      overlayRepairAt.set(o.win,now);
      const before=above,start=performance.now(),ok=platform.restoreTopmost(hwnd,repair.below);
      above=platform.windowsAbove(hwnd).filter(h=>listed.has(h));
      logEvent({type:'overlay-order-restored',display:o.display.id,reason:repair.reason,below:repair.below,ok,before,after:above,ms:performance.now()-start});
    }
    overlayAbove[o.display.id]=above;
  }
  const key = JSON.stringify(overlayAbove);
  if (key !== lastOverlayAbove) { lastOverlayAbove = key; logEvent({type: 'overlay-above', overlayAbove}); }
  sim.setDesktop({displays: sim.desktop.displays, windows, overlayAbove});
}
let lastOverlayAbove = '{}';

// 主循环：自己排下一次（setTimeout 链），不用固定 30 Hz 的 setInterval（R8.7、R14.1）。
//   快速（FAST_TICK）：Sim.needsFastTick()、用户在拖窗口或开着调试层。
//   慢速：只在下一帧该换、或某个状态该结束的时刻醒（Sim.secondsToNextChange），12 fps 的动画就是每秒 12 次。
//   窗口事件来了（wake）：下一 tick 提前到离上一 tick FAST_TICK 以后（拖窗口时事件一秒几百个，tick 最多 30 Hz）。
//   桌面：有关的窗口事件来过、在拖窗口时每 tick 重新枚举，否则每 DESKTOP_REFRESH 秒一次（watch.take）。
// 2026-10-20 实测固定 30 Hz 时单角色待机整棵进程树 CPU 约 6%（单核口径），见阶段 1 报告。
let loopTimer: ReturnType<typeof setTimeout> | undefined;
let loopAt = 0;
// 退出时（before-quit）停掉主循环：窗口关掉以后再 tick 会往已经销毁的窗口发帧（2026-10-21 日志里退出时三次 tick-error: Object has been destroyed）
let quitting = false;
function schedule(delay: number): void {
  clearTimeout(loopTimer);
  if (quitting) return;
  loopAt = performance.now() / 1000 + delay;
  loopTimer = setTimeout(loop, Math.max(4, Math.ceil(delay * 1000) + 1));   // +1 ms：宁可晚一点也别在帧边界前醒（醒早了画的还是上一帧）
}
function wake(): void {
  const now = performance.now() / 1000, at = Math.max(now, simClock.lastWall + FAST_TICK);
  if (at < loopAt - 0.004) schedule(at - now);
}
function loop(): void {
  let delay = IDLE_TICK_MAX;
  try {
    const now = performance.now() / 1000;
    if (tick()) delay = sim.needsFastTick() || settings.value.debug || watch.isMoving(now) ? FAST_TICK : Math.min(IDLE_TICK_MAX, sim.secondsToNextChange(sim.now));
  } catch (e) {
    console.error('tick 出错', e);
    logEvent({type: 'tick-error', error: String((e as Error)?.stack ?? e)});
  } finally {
    // tick 里调 Win32 时窗口事件也可能进来（wake 排的定时器在这里被换掉），没处理的变化留到 FAST_TICK 以后
    schedule(watch.dirty && !settings.value.paused && !isHidden() ? Math.min(delay, FAST_TICK) : delay);
  }
}

/** 推进一步。暂停、隐藏时什么都不做，返回 false */
function tick(): boolean {
  const t0 = performance.now(), now = t0 / 1000;
  const running=!settings.value.paused&&!isHidden(), time=simClock.step(now,running), dt=time.dt;
  if (now - lastSave >= SAVE_EVERY) { lastSave = now; save(); }
  capture?.rememberForeground();
  llm?.suspend(settings.value.paused || isHidden() || sim.away?.kind==='locked' || sim.userIdleSec>=1800);
  if (!running) { sendSpeech(); return false; }
  // 隔了 STALL_SEC 以上（睡眠、合盖、主线程卡住）：多出来的按关着程序算——状态值照离线追赶补（最多 2 小时），不算进玩了多久，
  // 动作、液体只走一步（2026-10-22 以前整段一次推进：开着桌宠睡一夜，状态值顶到头、累计时长 +8 小时，审查报告 A3）
  if (time.stalled) { catchUp(Math.min(time.stalled, OFFLINE_CAP_SEC)); logEvent({type: 'stall', sec: Math.round(time.stalled)}); }
  sim.now = time.now;
  if (watch.take(now, lastDesktop, DESKTOP_REFRESH)) { refreshDesktop(); lastDesktop = now; }
  if (sim.dragging()) {
    if (platform.leftButtonDown()) sim.drag(platform.cursorPos());
    else {
      sim.release();
      for (const s of surfaces()) makePassive(s, false);   // 松手时角色还在光标下面的，页面马上重算、接着能拎
      logEvent({type: 'release'});
    }
  }
  const events = sim.step(time.now, dt);
  llm?.step(time.now, events);
  sendSpeech();
  const moved = new Set<string>();
  for (const {id, e} of events) logSimEvent(id, e, now, moved);
  playCues();
  followLog.flush(now);
  send(sim.draws(moved), now);
  syncFollow();
  tickMs.push(performance.now() - t0);
  perfTicks++;
  if (tickMs.length > 300) tickMs.shift();
  return true;
}

/** 这一 tick 该响的音效 → 按规则挑声音 → 发给出声的那个覆盖窗口（R2.8：躲在窗口后面照样响，muffleHidden 时闷一点） */
function playCues(): void {
  const cues = sim.takeCues();
  const s = settings.value, out = audioSurface();
  if (!cues.length || !sfx || !s.sound || !s.r18 || dnd || !out) return;   // 勿扰时这一 tick 的音效直接丢掉（N8.1）
  const ds = sim.desktop.displays, left = Math.min(...ds.map(d => d.bounds.left)), right = Math.max(...ds.map(d => d.bounds.right));
  const sounds: StageSound['sounds'] = [];
  for (const c of cues) {
    const rules = sfx.voices[c.voice];
    if (!rules) continue;
    const key = `${c.id}:${c.voice}`;
    let v = voices.get(key);
    if (!v) voices.set(key, v = new Voice(rules, sfx.files, Math.random));
    const picked = v.run(c.effect);
    const pan = right > left ? Math.max(-1, Math.min(1, ((c.x - left) / (right - left)) * 2 - 1)) * 0.8 : 0;
    for (const p of picked) sounds.push({url: `packs/_sfx/sounds/${p.file}`, gain: 10 ** (p.gainDb / 20) * Math.min(1, p.volume) * s.volume,
      pitch: p.pitch, delay: p.delay, pan: +pan.toFixed(2), muffled: c.behind && s.muffleHidden});
    logEvent({id: c.id, type: 'sfx', effect: c.effect, files: picked.map(p => p.file), behind: c.behind});
  }
  if (sounds.length) out.win.webContents.send('stage:sound', {sounds} satisfies StageSound);
}
/** 出声的窗口：主显示器的覆盖窗口（没有就第一个准备好的） */
function audioSurface(): Overlay | undefined {
  const primary = screen.getPrimaryDisplay().id;
  return overlays.find(o => o.ready && o.display.id === primary) ?? overlays.find(o => o.ready);
}
function stopSounds(): void {
  for (const o of overlays) if (o.ready) o.win.webContents.send('stage:sound-stop');
}

function logSimEvent(id: string, e: SimEvent, now: number, moved: Set<string>): void {
  if (e.type === 'followed') { moved.add(id); followLog.add(id, e.supportKey, e.dx, e.dy, now); return; }
  followLog.flush(now, id);   // 先把这个角色攒着的 followed 写掉，保持日志顺序
  logEvent({id, ...e});
  if (e.type === 'unlocked') updateTray();
}

function send(d: ReturnType<Sim['draws']>, now: number): void {
  const debugDue = settings.value.debug && now - lastDebugSent > 0.1;
  if (debugDue) lastDebugSent = now;
  const cursor: StageFrame['cursor'] = sim.dragging() ? 'grabbing' : 'grab';
  for (const o of overlays) {
    if (!o.ready) continue;
    const items = d.front.get(o.display.id) ?? [], ground = d.ground.get(o.display.id) ?? [];
    const key = JSON.stringify(items) + JSON.stringify(ground) + cursor;
    if (key === o.last && !debugDue) continue;
    o.last = key;
    const frame: StageFrame = {items, ground, cursor};
    if (!settings.value.debug) frame.debug = null;
    else if (debugDue) frame.debug = sim.debugFor(o.display, debugExtra());
    o.win.webContents.send('stage:frame', frame);
  }
  syncLayers(d.behind, d.inside, cursor);
}

// ---------- 性能采样（调试叠加层显示；--set perfLog=true 时每 10 秒写一条 perf 事件，R14.1 排查用） ----------
// 每秒：各进程 CPU（app.getAppMetrics 的 percentCPUUsage）。它在 Windows 上是“占整机的百分比”，乘逻辑核数换成单核口径
// （100 = 一个逻辑核满载，和 scripts/render-bench/measure.ps1 一致）：2026-10-20 同一段 30 秒对比，measure.ps1 5.88%，
// percentCPUUsage 三个 10 秒均值的总和 0.39–0.56%，比值约 14，本机 16 个逻辑核。顺带更新桌宠自己的进程列表 pids。
// （Node 的 eventLoopUtilization 在 Electron 主进程里一直是 0，实测，不用。）
const CORES = os.availableParallelism();
let perf: Record<string, number> = {};
let perfAcc: {n: number; cpu: Record<string, number>} = {n: 0, cpu: {}};
function samplePerf(): void {
  const metrics = app.getAppMetrics();
  pids = [process.pid, ...metrics.map(m => m.pid)];
  const cpu: Record<string, number> = {};
  for (const m of metrics) cpu[m.type] = (cpu[m.type] ?? 0) + m.cpu.percentCPUUsage * CORES;
  perf = cpu;
  if (!settings.value.perfLog) return;
  perfAcc.n++;
  for (const [k, v] of Object.entries(cpu)) perfAcc.cpu[k] = (perfAcc.cpu[k] ?? 0) + v;
  if (perfAcc.n >= 10) {
    const r = (v: number) => Math.round(v / perfAcc.n * 100) / 100;
    const sorted = [...tickMs].sort((a, b) => a - b);
    const cpuPct = Object.fromEntries(Object.entries(perfAcc.cpu).map(([k, v]) => [k, r(v)]));
    logEvent({type: 'perf', seconds: perfAcc.n, cpuPct, cpuTotalPct: r(Object.values(perfAcc.cpu).reduce((a, b) => a + b, 0)),
      tickMedMs: sorted[sorted.length >> 1] ?? 0, tickP95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      ticks: perfTicks, winEvents: {...winEvents, raw: (winWatch?.raw ?? 0) - perfRaw}, followPids: followKey});   // 这 10 秒：回调被调的次数（raw，过滤前）、窗口本身的、叫醒主循环的
    perfAcc = {n: 0, cpu: {}};
    winEvents.all = winEvents.woke = perfTicks = 0;
    perfRaw = winWatch?.raw ?? 0;
  }
}
function debugExtra(): string[] {
  const sorted = [...tickMs].sort((a, b) => a - b);
  return [`LLM ${llm ? tr.m(llm.latest) : '不可用'} · 费用和 token 见设置 → 用量`, `tick 中位 ${(sorted[sorted.length >> 1] ?? 0).toFixed(2)} ms  p95 ${(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2)} ms`,
    `CPU（单核 %）${Object.entries(perf).map(([k, v]) => `${k} ${v.toFixed(1)}`).join('  ')}`,
    `通知状态 ${lastShell ?? '—'}  躲藏层 / 窗口里面窗口 ${layers.filter(l => l.target).length}/${layers.length}`,
    `窗口事件 收到 ${winWatch?.raw ?? 0}，窗口本身的 ${winEvents.all}，叫醒 ${winEvents.woke}  跟位置的进程 ${followKey || '无'}${watch.moving ? '  在拖窗口' : ''}`,
    `用户 ${awayLabel()}${away.state ? ` ${Math.round(performance.now() / 1000 - away.state.since)} 秒` : ''}  没碰键鼠 ${Math.round(sim.userIdleSec)} 秒`];
}

// ---------- 托盘、热键、设置窗口 ----------
// 2026-10-29 用户：设置界面不合 HCI / UX、要双语。托盘只留常用的（角色、暂停、隐藏、全年龄、勿扰、AI 对话、看一次屏幕、设置、退出），
// 其余都在设置窗口（src/main/settings-window.ts）。托盘和设置窗口改设置都走 changeSettings（存盘 + 下面 EFFECTS 里的副作用 + 刷新两边）。
let tray: Tray | null = null;
function trayIcon(): Electron.NativeImage {
  const p = packs[0], v = sim.variantOf(sim.charOf(p.manifest.id)!);
  const meta = p.sheet(v, 'clothed', 'idle', 'right');
  const img = nativeImage.createFromPath(path.join(PROJECT, p.sheetPath(v, 'clothed', 'idle', 'right') + '.png'));
  const side = meta.cell[0];
  return img.crop({x: 0, y: 0, width: side, height: side}).resize({width: 32, height: 32, quality: 'best'});
}
/**
 * “在桌面上”：记进设置 onDesktop（只记这一个角色；整组指定的 absentChars 这时不再管用），Sim 让它离开 / 掉下来
 * （drop = false：回来的不掉下来，召唤自己在光标处 spawn）
 */
function setOnDesktop(id: string, on: boolean, drop = true): void {
  const current = Object.fromEntries(desktopPacks.map(p => [p.id, !sim.isRequestedAbsent(p.id)]));
  settings.set('onDesktop', {...(settings.value.absentChars ? current : settings.value.onDesktop), [id]: on});
  if (settings.value.absentChars) settings.set('absentChars', null);
  sim.setAbsent(absentIds(settings.value, desktopPacks), drop);
  logEvent({type: 'desktop', id, present: on});
  updateTray();
}
const canSummon = (id: string) => sim.unlocked.includes(id) && (!sim.isAbsent(id) || sim.maxOnDesktop === null || sim.actors.length < sim.maxOnDesktop);
function summon(id: string): void {
  if (sim.isAbsent(id)) setOnDesktop(id, true, false);
  const c = platform.cursorPos();
  sim.spawn(id, c, sim.charOf(id)?.actor?.outfit);
  logEvent({type: 'summon', id, at: c});
}
/** 原生菜单里 & 是助记符，名字里的要写成 && */
const menuText = (s: string) => s.replace(/&/g, '&&');
function updateTray(): void {
  settingsWin.changed();
  if (!tray) return;
  const s = settings.value, t = tr.t;
  const chars: MenuItemConstructorOptions[] = packs.map(p => {
    const id = p.manifest.id, unlocked = sim.unlocked.includes(id), name = nameOf(id);
    return {label: menuText(!unlocked ? t('tray.locked', {name}) : sim.isAbsent(id) && !sim.isRequestedAbsent(id) ? t('tray.waiting', {name}) : name),
      type: 'checkbox', checked: unlocked && !sim.isRequestedAbsent(id), enabled: unlocked, click: m => setOnDesktop(id, m.checked)};
  });
  const summonable = packs.filter(p => canSummon(p.manifest.id));
  const lookable = packs.filter(p => !!sim.charOf(p.manifest.id)?.actor && !sim.isAbsent(p.manifest.id));
  const menu: MenuItemConstructorOptions[] = [
    {label: t('tray.characters'), submenu: [...chars, {type: 'separator'},
      {label: t('tray.summon'), enabled: summonable.length > 0, submenu: summonable.map(p => ({label: menuText(nameOf(p.manifest.id)), click: () => summon(p.manifest.id)}))}]},
    {type: 'separator'},
    {label: t('tray.pause'), type: 'checkbox', checked: s.paused, click: m => changeSettings({paused: m.checked})},
    {label: t('tray.hide', {key: s.bossKey.replace(/Control/g, 'Ctrl')}), type: 'checkbox', checked: hiddenByBossKey, click: () => toggleBoss()},
    {label: t('tray.sfw'), type: 'checkbox', checked: !s.r18, click: m => changeSettings({r18: !m.checked})},
    {label: dnd && !s.dndManual ? t('tray.dndAuto', {reason: tr.m(dndLabel(dnd))}) : t('tray.dnd'), type: 'checkbox', checked: s.dndManual,
      click: m => changeSettings({dndManual: m.checked})},
    ...(llm ? [{label: t('tray.ai'), type: 'checkbox' as const, checked: s.llmEnabled, click: (m: Electron.MenuItem) => changeSettings({llmEnabled: m.checked})}] : []),
    ...(llm?.config.vision.enabled && s.llmEnabled ? [{label: t('tray.look'), submenu: lookable.map(p => ({label: menuText(nameOf(p.manifest.id)), enabled: canLook(p.manifest.id),
      click: () => { if (!observer?.request(p.manifest.id)) tray?.displayBalloon({iconType: 'info', noSound: true, title: t('balloon.lookUnavailableTitle'), content: t('balloon.lookUnavailableBody')}); }}))}] : []),
    {type: 'separator'},
    {label: t('tray.settings'), click: () => openSettings()},
    {label: t('tray.quit'), click: () => app.quit()},
  ];
  tray.setContextMenu(Menu.buildFromTemplate(menu));
  const flags = [isHidden() && t('tray.tip.hidden'), s.paused && t('tray.tip.paused'), dnd && t('tray.tip.dnd'), !s.r18 && t('tray.tip.sfw'), away.state && t('tray.tip.away')].filter(Boolean);
  tray.setToolTip(`desk-pet${flags.length ? ` (${flags.join(', ')})` : ''}`
    + (llm?.config.vision.enabled ? '\n' + t('tray.tip.vision', {status: tr.m(observer?.latest ?? msg('status.vision.unavailable'))}) : '')
    + (llm?.limitHit ? '\n' + t('tray.tip.llm', {status: tr.m(limitText(llm.limitHit))}) : ''));
}
function toggleBoss(): void {
  hiddenByBossKey = !hiddenByBossKey;
  logEvent({type: 'bossKey', hidden: hiddenByBossKey});
  applyVisibility();
}
function toggleDebug(): void { changeSettings({debug: !settings.value.debug}); }

/** 改设置的副作用（存盘以外的）：托盘、设置窗口、热键改设置都只走这里 */
const EFFECTS: {[K in EditableKey]?: (v: Settings[K]) => void} = {
  language: () => applyLanguage(),
  paused: v => { if (v) stopSounds(); },
  r18: v => {
    if (!v) stopSounds();   // R6.6：全年龄模式下不放 R18 叫声
    sim.setR18(v);
    llm?.setEnabled(false); llm?.setEnabled(settings.value.llmEnabled); sendSpeech();
    logEvent({type: 'mode', r18: v});
  },
  variant: v => sim.setVariant(v ?? packs[0].manifest.defaultVariant),
  heightLogical: v => sim.setHeightLogical(v),
  maxOnDesktop: v => sim.setPopulationLimit(v),
  llmEnabled: v => { llm?.setEnabled(v); sendSpeech(); },
  llmControlSec: v => sim.setLlmControlSeconds(v),
  speechSound: () => sendSpeech(),
  volume: () => sendSpeech(),
  sound: v => { if (!v) stopSounds(); },
  dndManual: () => checkDnd(), dndSystem: () => checkDnd(), dndFullscreen: () => checkDnd(), dndApps: () => checkDnd(),
  awayAfterSec: () => checkAway(),
  hideOnFullscreen: () => checkFullscreen(),
  hideFromCapture: v => { for (const x of surfaces()) x.win.setContentProtection(v); },
  debug: () => { for (const o of overlays) o.last = ''; },
  pressMs: () => reinitStages(), sheetBudgetMB: () => reinitStages(),
};
function changeSettings(patch: SettingsPatch): void {
  for (const [k, v] of Object.entries(patch) as [EditableKey, never][]) {
    if (JSON.stringify(settings.value[k]) === JSON.stringify(v)) continue;
    settings.set(k, v);
    (EFFECTS[k] as ((v: unknown) => void) | undefined)?.(v);
    logEvent({type: 'setting', key: k});
  }
  updateTray();
}
/** 按住时长、图集内存是舞台初始化时给的：改了重新发一次（页面只换参数，不重建画布） */
function reinitStages(): void {
  for (const s of surfaces()) if (s.ready) {
    const o = overlays.find(x => x === s), scale = o ? o.display.scale : screen.getDisplayMatching(s.win.getBounds()).scaleFactor, wb = s.win.getBounds();
    s.win.webContents.send('stage:init', {width: Math.round(wb.width * scale), height: Math.round(wb.height * scale),
      sheetBudgetMB: settings.value.sheetBudgetMB, pressMs: settings.value.pressMs} satisfies StageInit);
  }
}
function applyLanguage(): void {
  tr = createTranslator(resolveLang(settings.value.language, app.getPreferredSystemLanguages()));
  speechSent.clear(); sendSpeech();   // 对话气泡上“对谁说”换语言
  settingsWin.retitle();
}

// 热键：老板键、调试键可在设置里改；注册不上（被别的程序占了）时留着旧的，设置窗口里提示
const hotkeyOk = {bossKey: false, debugKey: false};
const HOTKEYS = {bossKey: () => toggleBoss(), debugKey: () => toggleDebug()};
function registerKey(acc: string, fn: () => void): boolean { try { return globalShortcut.register(acc, fn); } catch { return false; } }
/** 换一个热键：先注销旧的再注册新的；新的注册不上就把旧的注册回去，返回 false */
function bindHotkey(k: 'bossKey' | 'debugKey', acc: string): boolean {
  const old = settings.value[k];
  if (hotkeyOk[k]) globalShortcut.unregister(old);
  if (registerKey(acc, HOTKEYS[k])) { hotkeyOk[k] = true; return true; }
  hotkeyOk[k] = acc !== old && registerKey(old, HOTKEYS[k]);
  return false;
}

// 开机自动启动（R8.4，2026-10-29）：写当前用户的启动项（注册表 HKCU\...\Run，Electron 的 setLoginItemSettings），默认不写；
// 这是 AGENTS.md 允许的“必须写系统盘才能工作”的例外。启动命令和快捷方式一样：electron.exe + main.ts 的绝对路径
const LOGIN_ITEM = {path: process.execPath, args: [path.join(PROJECT, 'src', 'main', 'main.ts')]};
function autostartOn(): boolean { try { return app.getLoginItemSettings(LOGIN_ITEM).openAtLogin; } catch { return false; } }

// 设置窗口：读快照、改设置、动作（约定见 src/settings/protocol.ts）
const startValues = Object.fromEntries(RESTART_KEYS.map(k => [k, JSON.stringify(settings.value[k])]));
const pick = (s: Settings) => Object.fromEntries(EDITABLE.map(k => [k, s[k]])) as SettingsView['settings'];
function accentColor(): string | null {
  try { const c = systemPreferences.getAccentColor(); return /^[0-9a-f]{6}/i.test(c) ? `#${c.slice(0, 6)}` : null; } catch { return null; }
}
function settingsView(): SettingsView {
  const s = settings.value, packsWith = (id: string) => packs.filter(p => p.manifest.variants.some(x => x.id === id)).map(p => p.manifest.id);
  return {
    lang: tr.lang, systemLang: resolveLang('system', app.getPreferredSystemLanguages()), accent: accentColor(),
    settings: pick(s), defaults: pick(DEFAULT_SETTINGS), defaultTuning: DEFAULT_TUNING,
    restartPending: RESTART_KEYS.filter(k => JSON.stringify(s[k]) !== startValues[k]),
    state: {hidden: hiddenByBossKey, hiddenByFullscreen, dnd: dnd ? dndLabel(dnd) : null, away: away.state?.kind ?? null, lastApp,
      bossKeyOk: hotkeyOk.bossKey, debugKeyOk: hotkeyOk.debugKey, unlockedAll: sim.unlocked.length >= packs.length, autostart: autostartOn()},
    characters: packs.map(p => {
      const id = p.manifest.id, unlocked = sim.unlocked.includes(id);
      return {id, name: nameOf(id), unlocked, wanted: unlocked && !sim.isRequestedAbsent(id), present: unlocked && !sim.isAbsent(id),
        waiting: unlocked && sim.isAbsent(id) && !sim.isRequestedAbsent(id), dir: p.relDir.replace(/\\/g, '/'),
        variants: p.manifest.variants.map(v => v.id), defaultVariant: p.manifest.defaultVariant, canSummon: canSummon(id)};
    }),
    variants: allVariants.map(v => ({...v, chars: packsWith(v.id), isDefault: v.id === packs[0].manifest.defaultVariant})),
    heightRange: {min: 96, max: 320, step: 8},
    llm: llmSettings?.view() ?? null,
  };
}
function setFromWindow(raw: unknown): Result {
  const r = checkPatch(raw, {variants: allVariants.map(v => v.id)});
  if (!r.ok) return r;
  const patch = r.value!;
  for (const k of ['bossKey', 'debugKey'] as const) {
    const acc = patch[k];
    if (acc === undefined || acc === settings.value[k]) continue;
    if (acc === (k === 'bossKey' ? patch.debugKey ?? settings.value.debugKey : patch.bossKey ?? settings.value.bossKey)) return {ok: false, error: 'error.hotkeySame'};
    if (!bindHotkey(k, acc)) return {ok: false, error: 'error.hotkeyTaken'};
  }
  changeSettings(patch);
  return {ok: true};
}
function actFromWindow(raw: unknown): Result {
  if (!raw || typeof raw !== 'object' || typeof (raw as {type?: unknown}).type !== 'string') return {ok: false, error: 'error.invalid'};
  const a = raw as SettingsAction, known = (id: unknown): id is string => typeof id === 'string' && packs.some(p => p.manifest.id === id);
  let r: Result = {ok: true};
  switch (a.type) {
    case 'hide': if (typeof a.on !== 'boolean') return {ok: false, error: 'error.invalid'}; if (a.on !== hiddenByBossKey) toggleBoss(); break;
    case 'desktop':
      if (!known(a.id) || typeof a.on !== 'boolean' || !sim.unlocked.includes(a.id)) return {ok: false, error: 'error.invalid'};
      setOnDesktop(a.id, a.on); break;
    case 'summon': if (!known(a.id) || !canSummon(a.id)) return {ok: false, error: 'error.invalid'}; summon(a.id); break;
    case 'unlockAll': sim.unlockAll(); save(); break;
    case 'autostart':
      if (typeof a.on !== 'boolean') return {ok: false, error: 'error.invalid'};
      try { app.setLoginItemSettings({...LOGIN_ITEM, openAtLogin: a.on, name: 'desk-pet'}); } catch { /* 下面按读回来的判 */ }
      logEvent({type: 'autostart', on: a.on});
      if (autostartOn() !== a.on) r = {ok: false, error: 'error.autostart'};
      break;
    case 'restart': save(); app.relaunch(); app.quit(); break;
    default: r = llmSettings?.act(a) ?? {ok: false, error: 'error.invalid'};
  }
  updateTray();
  return r;
}
const settingsWin = createSettingsWindow(PROJECT, {view: settingsView, set: setFromWindow, act: actFromWindow, title: () => tr.t('app.title')},
  {icon: () => trayIcon()});
function openSettings(page?: Parameters<typeof settingsWin.open>[0]): void { settingsWin.open(page); }

app.whenReady().then(() => {
  applyLanguage();
  handleProtocol(packs.map(p=>path.posix.join(p.relDir,'sprites')));
  createOverlays();
  samplePerf();
  refreshDesktop();
  const primary = sim.desktop.displays.find(d => d.id === screen.getPrimaryDisplay().id) ?? sim.desktop.displays[0];
  const wa = primary.workArea, w = wa.right - wa.left;
  // 已解锁、在桌面上的角色：第一个放在 --spawn 或屏幕中间偏上，其余左右错开
  sim.unlocked.filter(id => !sim.isAbsent(id)).forEach((id, i) => {
    const at = i === 0 && spawnArg?.length === 2 ? {x: spawnArg[0], y: spawnArg[1]}
      : {x: wa.left + w / 2 + (i === 0 ? 0 : (i % 2 ? -1 : 1) * Math.ceil(i / 2) * w * 0.2), y: wa.top + (wa.bottom - wa.top) / 3};
    sim.spawn(id, at, saved.chars[id]?.outfit);
  });
  tray = new Tray(trayIcon());
  tray.on('click', () => toggleBoss());
  tray.on('right-click',()=>{capture?.rememberForeground();updateTray();});
  updateTray();
  for (const k of ['bossKey', 'debugKey'] as const) {
    hotkeyOk[k] = registerKey(settings.value[k], HOTKEYS[k]);
    if (!hotkeyOk[k]) { console.warn(`热键注册失败（被别的程序占了？）：${k} ${settings.value[k]}`); logEvent({type: 'hotkey-failed', key: k}); }
  }
  systemPreferences.on('accent-color-changed', () => settingsWin.changed());
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed'] as const) screen.on(ev as 'display-added', () => {
    logEvent({type: 'displays-changed', ev});
    createOverlays();
  });
  winWatch = platform.watchWindows(onWinEvent);
  loop();
  powerMonitor.on('lock-screen', () => { lockedByEvent = true; checkAway(); });
  powerMonitor.on('unlock-screen', () => { lockedByEvent = false; checkAway(); });
  setInterval(() => { if (!quitting) { const sh = readShell(); checkFullscreen(sh); checkDnd(sh); checkAway(sh); samplePerf(); void observer?.tick(); } }, 1000);
  logEvent({type: 'start', variant: sim.opts.variant, height: sim.opts.heightLogical, r18: sim.opts.r18, unlocked: sim.unlocked,
    offlineSec: Math.round(offline), displays: sim.desktop.displays});
});
app.on('window-all-closed', () => { /* 覆盖窗口重建时会短暂全关，不退出 */ });
app.on('before-quit', () => { quitting = true; clearTimeout(loopTimer); observer?.close(); llm?.close(); });
app.on('will-quit', () => { save(); globalShortcut.unregisterAll(); winWatch?.stop(); });
