// 对话记忆：每个角色、每个模式（成人 / 全年龄）各自一段“对话会话”，给文本模型当多轮上下文。
// 最近若干轮存原文，较早的经历由调用方让模型摘要后 compact 成一段滚动摘要（不删，留给以后的全文检索）。
// 缓存友好的关键是“一次丢一大批”，不是每轮滑一格：丢多少由调用方给 policy，本模块只提供原语。
// 不存 key、不存原始请求；表 memory_turns / memory_summary，关掉再打开数据还在。
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export type MemoryMode = 'adult' | 'sfw';

export interface MemoryTurn {
  /** 全库自增，决定顺序 */
  seq: number;
  /** 毫秒时间戳 */
  at: number;
  /** 请求类型，如 'line' | 'reaction' | 'talk' | 'duo'，1–32 个字符 */
  kind: string;
  /** 这一轮“发生了什么”的简短文字（多轮上下文里的 user 消息） */
  user: string;
  /** 她这一轮说了什么（多轮上下文里的 assistant 消息） */
  reply: string;
}

export interface MemoryWindow {summary: string; summaryAt: number | null; turns: MemoryTurn[]}

export interface CompactionPolicy {maxTurns: number; keepTurns: number; maxChars: number}

/** 各字段上限：字符数一律按 Unicode 码点算（不按 UTF-16 长度），不静默截断，超了抛 TypeError。 */
const MAX_CHARACTER = 64;
const MAX_KIND = 32;
const MAX_TEXT = 4000;

const codePoints = (value: string): number => [...value].length;

function fail(message: string): never {
  throw new TypeError(message);
}

function asCharacter(value: unknown): string {
  if (typeof value !== 'string') fail('character 必须是字符串');
  if (value.length === 0) fail('character 不能为空');
  if (codePoints(value) > MAX_CHARACTER) fail(`character 最多 ${MAX_CHARACTER} 个字符`);
  return value;
}

function asMode(value: unknown): MemoryMode {
  if (value !== 'adult' && value !== 'sfw') fail("mode 只能是 'adult' 或 'sfw'");
  return value;
}

/** 毫秒时间戳：有限数字，存成整数。 */
function asTime(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} 必须是有限数字`);
  return Math.round(value);
}

function asKind(value: unknown): string {
  if (typeof value !== 'string') fail('kind 必须是字符串');
  const length = codePoints(value);
  if (length < 1 || length > MAX_KIND) fail(`kind 长度必须是 1–${MAX_KIND} 个字符`);
  return value;
}

function asText(value: unknown, name: string, allowEmpty: boolean): string {
  if (typeof value !== 'string') fail(`${name} 必须是字符串`);
  if (!allowEmpty && value.length === 0) fail(`${name} 不能为空`);
  if (codePoints(value) > MAX_TEXT) fail(`${name} 最多 ${MAX_TEXT} 个码点`);
  return value;
}

/** 只校验，不取整：和 INTEGER 列比较时带小数照样按数值比。 */
function asSeq(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('upToSeq 必须是有限数字');
  return value;
}

function asPolicy(value: CompactionPolicy): CompactionPolicy {
  if (typeof value !== 'object' || value === null) fail('policy 必须是对象');
  const positive = (number: unknown, name: string): number => {
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) fail(`${name} 必须是正整数`);
    return number;
  };
  const maxTurns = positive(value.maxTurns, 'maxTurns');
  const keepTurns = positive(value.keepTurns, 'keepTurns');
  const maxChars = positive(value.maxChars, 'maxChars');
  if (keepTurns >= maxTurns) fail('keepTurns 必须小于 maxTurns');
  return {maxTurns, keepTurns, maxChars};
}

interface TurnRow {
  seq: number;
  at: number;
  kind: string;
  user: string;
  reply: string;
}

function rowToTurn(row: TurnRow): MemoryTurn {
  return {seq: Number(row.seq), at: Number(row.at), kind: row.kind, user: row.user, reply: row.reply};
}

export class MemoryStore {
  private db: DatabaseSync | null;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true});
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_turns (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        character TEXT NOT NULL,
        mode TEXT NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        user TEXT NOT NULL,
        reply TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS memory_turns_active ON memory_turns(character, mode, archived, seq)');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_summary (
        character TEXT NOT NULL,
        mode TEXT NOT NULL,
        summary TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY(character, mode)
      )
    `);
  }

  /** 当前上下文：摘要（没有就 ''、summaryAt null）+ 未归档的轮，按 seq 升序 */
  window(character: string, mode: MemoryMode): MemoryWindow {
    const name = asCharacter(character);
    const target = asMode(mode);
    const db = this.database();
    const summary = db.prepare('SELECT summary, at FROM memory_summary WHERE character = ? AND mode = ?')
      .get(name, target) as unknown as {summary: string; at: number} | undefined;
    return {
      summary: summary?.summary ?? '',
      summaryAt: summary ? Number(summary.at) : null,
      turns: this.activeTurns(db, name, target),
    };
  }

  /** 追加一轮，返回带 seq 的记录 */
  append(
    character: string,
    mode: MemoryMode,
    turn: {at: number; kind: string; user: string; reply: string},
  ): MemoryTurn {
    const name = asCharacter(character);
    const target = asMode(mode);
    if (typeof turn !== 'object' || turn === null) fail('turn 必须是对象');
    const at = asTime(turn.at, 'turn.at');
    const kind = asKind(turn.kind);
    const user = asText(turn.user, 'turn.user', false);
    const reply = asText(turn.reply, 'turn.reply', true);
    const result = this.database().prepare(`
      INSERT INTO memory_turns (character, mode, at, kind, user, reply, archived)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(name, target, at, kind, user, reply);
    return {seq: Number(result.lastInsertRowid), at, kind, user, reply};
  }

  /**
   * 该折叠进摘要的最早几轮；不需要时返回 null。
   * 未归档轮数 > maxTurns，或 user+reply 的总码点数 > maxChars 时，返回除最新 keepTurns 轮以外的全部；
   * 这样算出来是空的（只有 keepTurns 轮但字符超了）就退成除最新 1 轮；只有 0 或 1 轮时返回 null。
   */
  pending(character: string, mode: MemoryMode, policy: CompactionPolicy): MemoryTurn[] | null {
    const name = asCharacter(character);
    const target = asMode(mode);
    const {maxTurns, keepTurns, maxChars} = asPolicy(policy);
    const turns = this.activeTurns(this.database(), name, target);
    if (turns.length <= 1) return null;

    let chars = 0;
    for (const turn of turns) chars += codePoints(turn.user) + codePoints(turn.reply);
    if (turns.length <= maxTurns && chars <= maxChars) return null;

    // 至少留下最新 1 轮，所以批量永远非空（最多 keepTurns 轮时就只丢最早那一轮）。
    const keep = Math.max(1, Math.min(keepTurns, turns.length - 1));
    return turns.slice(0, turns.length - keep);
  }

  /** 原子地（一个事务）：写新摘要（at 为摘要时间），把 seq <= upToSeq 的未归档轮标成归档 */
  compact(character: string, mode: MemoryMode, upToSeq: number, summary: string, at: number): void {
    const name = asCharacter(character);
    const target = asMode(mode);
    const seq = asSeq(upToSeq);
    const text = asText(summary, 'summary', true);
    const time = asTime(at, 'at');
    const db = this.database();
    this.transaction(db, () => {
      db.prepare(`
        INSERT INTO memory_summary (character, mode, summary, at) VALUES (?, ?, ?, ?)
        ON CONFLICT(character, mode) DO UPDATE SET summary = excluded.summary, at = excluded.at
      `).run(name, target, text, time);
      db.prepare(`
        UPDATE memory_turns SET archived = 1
        WHERE character = ? AND mode = ? AND archived = 0 AND seq <= ?
      `).run(name, target, seq);
    });
  }

  /** 不写摘要、只归档 seq <= upToSeq 的未归档轮（调用方摘要一直失败时的硬上限用），摘要不变 */
  archive(character: string, mode: MemoryMode, upToSeq: number): void {
    const name = asCharacter(character);
    const target = asMode(mode);
    const seq = asSeq(upToSeq);
    this.database().prepare(`
      UPDATE memory_turns SET archived = 1
      WHERE character = ? AND mode = ? AND archived = 0 AND seq <= ?
    `).run(name, target, seq);
  }

  /** 统计 */
  counts(character: string, mode: MemoryMode): {active: number; archived: number} {
    const name = asCharacter(character);
    const target = asMode(mode);
    const row = this.database().prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END), 0) AS active,
        COALESCE(SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END), 0) AS archived
      FROM memory_turns WHERE character = ? AND mode = ?
    `).get(name, target) as unknown as {active: number; archived: number};
    return {active: Number(row.active), archived: Number(row.archived)};
  }

  /** 用户“清空记忆”：删掉这个角色这个模式的所有轮（含已归档）和摘要 */
  forget(character: string, mode: MemoryMode): void {
    const name = asCharacter(character);
    const target = asMode(mode);
    const db = this.database();
    this.transaction(db, () => {
      db.prepare('DELETE FROM memory_turns WHERE character = ? AND mode = ?').run(name, target);
      db.prepare('DELETE FROM memory_summary WHERE character = ? AND mode = ?').run(name, target);
    });
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  private activeTurns(db: DatabaseSync, character: string, mode: MemoryMode): MemoryTurn[] {
    const rows = db.prepare(`
      SELECT seq, at, kind, user, reply FROM memory_turns
      WHERE character = ? AND mode = ? AND archived = 0
      ORDER BY seq
    `).all(character, mode) as unknown as TurnRow[];
    return rows.map(rowToTurn);
  }

  private transaction(db: DatabaseSync, body: () => void): void {
    db.exec('BEGIN');
    try {
      body();
      db.exec('COMMIT');
    } catch (error) {
      // 库里被别的连接锁住时 ROLLBACK 可能再抛（没有活动事务），以原始错误为准。
      try { db.exec('ROLLBACK'); } catch { /* 没有可回滚的事务 */ }
      throw error;
    }
  }

  private database(): DatabaseSync {
    if (!this.db) throw new Error('MemoryStore is closed');
    return this.db;
  }
}
