// store/：存档读写（R8.9、R9.4，design.md §12）。只有 JSON 读写和路径计算，不碰系统盘、不写死路径：
// 存档目录由调用方给（会是项目内 data/save.json）。
//
// 原子写：先写 <file>.tmp 再 rename（同一目录内；Windows 上 rename 覆盖已有文件是原子替换，写一半崩了也不会留半截存档）。
// 读不出来（文件不存在 / JSON 坏了 / schema 不对）不能让桌宠起不来：返回空存档；坏文件改名成 <file>.bad-<时间戳> 留着。
// 自写，只用 node:fs、node:path。
import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

import type {SavedMind} from '../behavior/mind.ts';

export interface SaveData {
  schema: 1;
  /** 上次写盘的时刻（Date.now() 毫秒） */
  savedAt: number;
  /** 累计玩了多少秒（桌宠开着、没暂停的时间） */
  playSeconds: number;
  /** 已解锁的角色 id（顺序 = 解锁顺序） */
  unlocked: string[];
  chars: Record<string, SavedMind & {outfit?: string}>;
}

/** 离线追赶的上限：2 小时（程序关着、开着但电脑睡眠时都按它补，main.ts） */
export const OFFLINE_CAP_SEC = 7200;

/** 空存档（没有文件 / 读不出来时用）。savedAt = 0 表示还没写过盘。 */
export function emptySave(): SaveData {
  return {schema: 1, savedAt: 0, playSeconds: 0, unlocked: [], chars: {}};
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 结构校验：schema 必须是 1，时间 / 解锁表 / 角色表都得是像样的东西 */
function isSaveData(v: unknown): v is SaveData {
  if (!isRecord(v) || v.schema !== 1) return false;
  if (!Number.isFinite(v.savedAt) || !Number.isFinite(v.playSeconds)) return false;
  if (!Array.isArray(v.unlocked) || !v.unlocked.every(id => typeof id === 'string')) return false;
  if (!isRecord(v.chars)) return false;
  for (const c of Object.values(v.chars)) {
    if (!isRecord(c) || !isRecord(c.stats) || !isRecord(c.relations)) return false;
    if (c.outfit !== undefined && typeof c.outfit !== 'string') return false;
  }
  return true;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 坏存档改名留着（改名失败也只警告，不往外抛） */
function quarantine(file: string, why: unknown): void {
  const bad = `${file}.bad-${Date.now()}`;
  try {
    renameSync(file, bad);
    console.warn(`存档 ${file} 读不出来（${messageOf(why)}），已改名为 ${bad}，用空存档继续`);
  } catch (e) {
    console.warn(`存档 ${file} 读不出来（${messageOf(why)}），改名失败（${messageOf(e)}），用空存档继续`);
  }
}

/** 读 file；不存在返回 emptySave()；JSON 坏了或 schema 不对：改名成 file + '.bad-<时间戳>' 留着，返回 emptySave() */
export function loadSave(file: string): SaveData {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    // 不存在是正常情况（第一次启动）；别的读错误也不能让桌宠起不来
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`读存档 ${file} 失败（${messageOf(e)}），用空存档继续`);
    }
    return emptySave();
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    quarantine(file, e);
    return emptySave();
  }
  if (!isSaveData(data)) {
    quarantine(file, new Error('schema 不对'));
    return emptySave();
  }
  return data;
}

/** 原子写：先写 file + '.tmp' 再 rename；自动建目录；写之前把 savedAt 设成 now（参数，毫秒） */
export function writeSave(file: string, data: SaveData, now: number): void {
  data.savedAt = now;
  mkdirSync(dirname(file), {recursive: true});
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, {force: true});
    } catch {
      // 临时文件清不掉就算了，把真正的错误抛给调用方
    }
    throw e;
  }
}

/**
 * 离线追赶：上次存档到现在过了多久（秒，按 savedAt 和 now 毫秒算；负数当 0），最多算 capSec（默认 7200，2 小时），
 * 返回要补给状态值 tick 的秒数。（状态值的变化由调用方用 Brain.tick 补，这里只算时长）
 */
export function offlineSeconds(data: SaveData, now: number, capSec = OFFLINE_CAP_SEC): number {
  if (!Number.isFinite(now) || !Number.isFinite(data.savedAt)) return 0;
  const elapsed = Math.max(0, (now - data.savedAt) / 1000);
  const cap = Number.isFinite(capSec) ? Math.max(0, capSec) : OFFLINE_CAP_SEC;
  return Math.min(elapsed, cap);
}
