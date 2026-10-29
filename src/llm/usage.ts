// LLM 用量与预算（R12）：费用估算、SQLite 调用记录、每日 / 每小时闸门。
// 只存数字和元数据，不存 prompt、正文、key；usage 或价格未知时保持 null，不冒充 0。
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {CallRecord, Price, RequestKind, Usage} from './types.ts';

export interface UsageSummary {
  total: number;
  costUsd: number;
  /** 费用未知（costUsd === null）的调用条数；未知金额不能当作 0 计入 costUsd。 */
  unknownCost: number;
  /** 已知 usage 的 prompt token 合计；usage 为 null 的调用不计入，也不补 0。 */
  prompt: number;
  /** 已知 usage 的 completion token 合计。 */
  completion: number;
  /** 所有调用都报告了 cached 才有值；只要有一条未知就是 null。 */
  cached: number | null;
  /** cached / prompt；cached 未知或没有 prompt 时为 null。 */
  cacheRate: number | null;
  p50: number | null;
  p95: number | null;
  byCharacter: Record<string, number>;
  byKind: Record<string, number>;
  failures: Record<string, number>;
}

const finiteToken = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * usage × 每百万 token 价格。缺 usage 或价格 → null（未知，不是免费）。
 * cached 未知时按全价计 input；cached 已知时从 input 里扣掉，按缓存价计。
 * reasoning 已经包含在 completion 里，不重复计费。
 */
export function estimateCost(usage: Usage | null, price: Price | undefined): number | null {
  if (!usage || !price) return null;
  const prompt = finiteToken(usage.prompt);
  const completion = finiteToken(usage.completion);
  const cached = usage.cached === null ? null : finiteToken(usage.cached);
  const inputPrice = finiteToken(price.input);
  const cachedPrice = finiteToken(price.cached);
  const outputPrice = finiteToken(price.output);
  if (prompt === null || completion === null || (usage.cached !== null && cached === null) ||
    inputPrice === null || cachedPrice === null || outputPrice === null) return null;

  const cachedTokens = cached === null ? 0 : Math.min(cached, prompt);
  const fullPriceTokens = prompt - cachedTokens;
  return (fullPriceTokens * inputPrice + cachedTokens * cachedPrice + completion * outputPrice) / 1_000_000;
}

/** 最近秩（nearest-rank）：p50 取第 ceil(0.5n) 个，和统计面板的常见口径一致。 */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function bump(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

interface CallRow {
  at: number;
  character: string;
  kind: string;
  provider: string;
  model: string;
  prompt_tokens: number | null;
  cached_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  result: string;
}

const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

function rowToRecord(row: CallRow): CallRecord {
  const prompt = nullableNumber(row.prompt_tokens);
  const completion = nullableNumber(row.completion_tokens);
  const usage: Usage | null = prompt === null || completion === null ? null : {
    prompt,
    completion,
    cached: nullableNumber(row.cached_tokens),
    reasoning: nullableNumber(row.reasoning_tokens),
  };
  return {
    at: Number(row.at),
    character: row.character,
    kind: row.kind as RequestKind,
    provider: row.provider,
    model: row.model,
    usage,
    costUsd: nullableNumber(row.cost_usd),
    latencyMs: Number(row.latency_ms),
    result: row.result as CallRecord['result'],
  };
}

export class UsageStore {
  private db: DatabaseSync | null;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true});
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS llm_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        character TEXT NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER,
        cached_tokens INTEGER,
        completion_tokens INTEGER,
        reasoning_tokens INTEGER,
        cost_usd REAL,
        latency_ms REAL NOT NULL,
        result TEXT NOT NULL
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS llm_calls_at ON llm_calls(at)');
  }

  record(record: CallRecord): void {
    const db = this.database();
    const usage = record.usage;
    db.prepare(`
      INSERT INTO llm_calls
        (at, character, kind, provider, model, prompt_tokens, cached_tokens,
         completion_tokens, reasoning_tokens, cost_usd, latency_ms, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.at,
      record.character,
      record.kind,
      record.provider,
      record.model,
      usage?.prompt ?? null,
      usage?.cached ?? null,
      usage?.completion ?? null,
      usage?.reasoning ?? null,
      record.costUsd,
      record.latencyMs,
      record.result,
    );
  }

  summary(character?: string, kind?: string): UsageSummary {
    const rows = this.database().prepare(`
      SELECT at, character, kind, provider, model, prompt_tokens, cached_tokens,
             completion_tokens, reasoning_tokens, cost_usd, latency_ms, result
      FROM llm_calls
      WHERE (? IS NULL OR character = ?) AND (? IS NULL OR kind = ?)
    `).all(character??null,character??null,kind??null,kind??null) as unknown as CallRow[];

    let costUsd = 0;
    let unknownCost = 0;
    let prompt = 0;
    let completion = 0;
    let cachedTotal = 0;
    let cacheKnown = true;
    const latencies: number[] = [];
    const byCharacter: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    const failures: Record<string, number> = {};

    for (const row of rows) {
      if (row.cost_usd === null) unknownCost++;
      else costUsd += Number(row.cost_usd);

      const promptTokens = nullableNumber(row.prompt_tokens);
      const completionTokens = nullableNumber(row.completion_tokens);
      const cachedTokens = nullableNumber(row.cached_tokens);
      if (promptTokens === null || completionTokens === null) {
        cacheKnown = false;
      } else {
        prompt += promptTokens;
        completion += completionTokens;
        if (cachedTokens === null) cacheKnown = false;
        else cachedTotal += cachedTokens;
      }

      const latency = Number(row.latency_ms);
      if (Number.isFinite(latency)) latencies.push(latency);
      bump(byCharacter, row.character);
      bump(byKind, row.kind);
      if (row.result !== 'ok') bump(failures, row.result);
    }

    latencies.sort((a, b) => a - b);
    const cached = cacheKnown && rows.length > 0 ? cachedTotal : null;
    return {
      total: rows.length,
      costUsd,
      unknownCost,
      prompt,
      completion,
      cached,
      cacheRate: cached === null || prompt <= 0 ? null : cached / prompt,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      byCharacter,
      byKind,
      failures,
    };
  }

  recent(limit = 100): CallRecord[] {
    const count = Number.isFinite(limit) ? Math.floor(limit) : 0;
    if (count <= 0) return [];
    const rows = this.database().prepare(`
      SELECT at, character, kind, provider, model, prompt_tokens, cached_tokens,
             completion_tokens, reasoning_tokens, cost_usd, latency_ms, result
      FROM llm_calls
      ORDER BY at DESC, id DESC
      LIMIT ?
    `).all(count) as unknown as CallRow[];
    return rows.map(rowToRecord);
  }

  /** Full time window for budgets, independent of UI pagination. */
  since(at: number): CallRecord[] {
    return (this.database().prepare(`SELECT at, character, kind, provider, model, prompt_tokens, cached_tokens,
      completion_tokens, reasoning_tokens, cost_usd, latency_ms, result FROM llm_calls WHERE at >= ? ORDER BY at DESC, id DESC`)
      .all(at) as unknown as CallRow[]).map(rowToRecord);
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  private database(): DatabaseSync {
    if (!this.db) throw new Error('UsageStore is closed');
    return this.db;
  }
}

export interface BudgetOptions {
  /** null = 不限（2026-10-23 用户：测试时容易用满，做成托盘可选） */
  hourlyRequests: number | null;
  dailyUsd: number | null;
  dailyTokens: number | null;
}

/** 被挡下的原因（给提示用）：哪个上限、上限和已用多少、大约什么时候恢复（毫秒时间戳）。 */
export interface BudgetBlock {
  reason: 'hourly' | 'daily';
  limit: number;
  used: number;
  until: number;
}

const HOUR_MS = 60 * 60 * 1000;

/** 本地时间当天 0 点（跨月、跨年、夏令时都由 Date 的本地字段处理）。 */
function localMidnight(nowMs: number): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * 请求闸门：滚动一小时硬上限；每日费用 / token 到 80% 只留 reply，到 100% 全挡。
 * 当日有费用或 usage 未知的调用时，不把它当 0：最多只留 reply，避免后台继续刷。
 * null 表示该维度不限。
 */
export class BudgetGate {
  private readonly hourlyRequests: number;
  private readonly dailyUsd: number | null;
  private readonly dailyTokens: number | null;

  constructor(options: BudgetOptions) {
    this.hourlyRequests = options.hourlyRequests !== null && Number.isFinite(options.hourlyRequests)
      ? Math.max(0, Math.floor(options.hourlyRequests))
      : Number.POSITIVE_INFINITY;
    this.dailyUsd = options.dailyUsd;
    this.dailyTokens = options.dailyTokens;
  }

  allow(records: CallRecord[], kind: RequestKind, nowMs: number): boolean {
    return this.check(records, kind, nowMs) === null;
  }

  /** 放行返回 null；挡下返回原因和大约恢复的时间（小时上限：最早几条滚出一小时；每日：本地明天 0 点）。 */
  check(records: CallRecord[], kind: RequestKind, nowMs: number, pending: readonly {at: number}[] = []): BudgetBlock | null {
    const hourStart = nowMs - HOUR_MS;
    const dayStart = localMidnight(nowMs);
    const hourly: number[] = [];
    let usd = 0;
    let tokens = 0;
    let usdUnknown = false;
    let tokensUnknown = false;
    for (const record of pending) if(record.at>hourStart && record.at<=nowMs)hourly.push(record.at);

    for (const record of records) {
      if (record.at > hourStart && record.at <= nowMs) hourly.push(record.at);
      if (record.at < dayStart || record.at > nowMs) continue;

      if (this.dailyUsd !== null) {
        if (record.costUsd === null) usdUnknown = true;
        else usd += record.costUsd;
      }
      if (this.dailyTokens !== null) {
        if (record.usage === null) tokensUnknown = true;
        else tokens += record.usage.prompt + record.usage.completion;
      }
    }

    if (hourly.length >= this.hourlyRequests) {
      // 要滚出去 used - limit + 1 条才回到上限以下：按时间排好，第 used - limit 条（从 0 数）滚出一小时的那一刻
      hourly.sort((a, b) => a - b);
      const used = hourly.length, limit = this.hourlyRequests;
      return {reason: 'hourly', limit, used, until: (hourly[used - limit] ?? nowMs) + HOUR_MS};
    }

    // 费用和 token 两个维度取更紧的那个
    let level = 0, limit = 0, used = 0;
    for (const [value, max, unknown] of [[usd, this.dailyUsd, usdUnknown], [tokens, this.dailyTokens, tokensUnknown]] as const) {
      if (max === null) continue;
      const l = dailyLevel(value, max, unknown);
      if (l > level) { level = l; limit = max; used = value; }
    }

    if (level === 0 || level === 1 && kind === 'reply') return null;
    const now = new Date(nowMs);
    return {reason: 'daily', limit, used, until: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()};
  }
}

function dailyLevel(value: number, limit: number, unknown: boolean): 0 | 1 | 2 {
  if (value >= limit) return 2;
  if (unknown) return 1;
  if (value >= limit * 0.8) return 1;
  return 0;
}
