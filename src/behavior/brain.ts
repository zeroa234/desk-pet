// behavior/ 的“脑子”：状态值、好感、冷却和“下一步”限制（R3.1–R3.5，state-rules.md §2.2）。纯逻辑，不碰时钟：
// now（秒）由调用方给，随机数由调用方给 rng。行为配置的类型、能引用的变量和规则见 mind.ts。
//
// 自写：tick / candidates / choose / effects / accepts / unlock。条件和权重用 json-logic-js 2.0.5（MIT）求值，
// 规则是数据，不执行代码。这个包是 CommonJS（package.json main = logic.js），项目的 module 是 nodenext
// （esModuleInterop 默认开），`import jsonLogic from 'json-logic-js'` 拿到的就是它的 module.exports；
// Node 24 的类型擦除下实测能跑，所以没用 createRequire。配置里的 Logic 是 unknown（JSON 是运行时数据），
// @types/json-logic-js 的 apply 只收它自己的 RulesLogic，下面收窄成 applyLogic，免得每个调用都 as。
//
// 冷却和“下一步”只在内存里（不进 save()）。规则写错（JSON Logic 抛异常）当作 false / 权重 0，console.warn 一次，
// 不让配置错误把桌宠弄崩。
import jsonLogic from 'json-logic-js';

import type {BehaviorDef, Effects, Logic, MindConfig, MindView, Range, ReactionDef, SavedMind, StatDef, UnlockView} from './mind.ts';

/** 反应默认冷却（秒）：同一个键（同一个部位、同一种碰法）2 秒内不再反应（state-rules §2.1 react 的“同部位 2”） */
export const REACTION_COOLDOWN = 2;

/** @types/json-logic-js 只接受它自己的 RulesLogic；配置里的规则是 unknown */
const applyLogic = jsonLogic.apply as (logic: unknown, data?: unknown) => unknown;

/** 已经警告过的规则（键带角色 id / 规则种类），同一处配置错误只刷一次屏 */
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 把规则打印成短字符串，只用在警告键和警告文字里 */
function describeRule(rule: Logic): string {
  try {
    const s = JSON.stringify(rule);
    if (s === undefined) return String(rule);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return String(rule);
  }
}

function finite(v: number | undefined, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 状态的取值范围（StatDef.min / max，默认 0 / 100） */
function statRange(def: StatDef): readonly [number, number] {
  return [finite(def.min, 0), finite(def.max, 100)];
}

/** 一个角色的“脑子”：状态值、好感、冷却、上一个行为留下的“下一步”限制。 */
export class Brain {
  readonly id: string;
  readonly cfg: MindConfig;
  stats: Record<string, number>;
  relations: Record<string, {affection: number}>;
  /** 行为 id → 冷却结束时刻（秒）；只在内存里，不进存档 */
  private cooldowns: Record<string, number> = {};
  /** 上一个正常结束（done）的行为留下的下一步列表；null = 没有限制 */
  private nextIds: readonly string[] | null = null;
  /** 反应的键（click:chest……）→ 冷却结束时刻；只在内存里 */
  private reactionCooldowns: Record<string, number> = {};
  /** StatDef.rates 里当前成立的那些加起来：状态名 → 每小时；observe 时重算 */
  private activeRates: Record<string, number> = {};

  constructor(id: string, cfg: MindConfig, saved?: Partial<SavedMind>) {
    this.id = id;
    this.cfg = cfg;
    this.stats = initialStats(cfg, saved?.stats);
    this.relations = initialRelations(cfg, saved?.relations);
  }

  /**
   * 按当时的世界重算 StatDef.rates 哪些成立（sim.ts 大约每秒调一次）；view 为 null（角色不在场）时都不算。
   * 规则写错当作不成立，警告一次。
   */
  observe(view: MindView | null): void {
    const out: Record<string, number> = {};
    if (view) for (const [name, def] of Object.entries(this.cfg.stats)) {
      for (const [i, r] of (def.rates ?? []).entries()) {
        if (!Number.isFinite(r?.perHour) || !this.testRule(r.when, view, `stats.${name}.rates[${i}]`)) continue;
        out[name] = (out[name] ?? 0) + r.perHour;
      }
    }
    this.activeRates = out;
  }

  /** 当前成立的有条件变化（调试显示用） */
  rates(): Readonly<Record<string, number>> { return this.activeRates; }

  /**
   * 状态值随时间变：dtSec 秒（实际时间）。perHour 加上 observe 记下的有条件变化线性加；有 toward 时再往 toward 靠，但不越过；
   * 最后夹到范围里。
   */
  tick(dtSec: number): void {
    if (!Number.isFinite(dtSec) || dtSec <= 0) return;
    const hours = dtSec / 3600;
    for (const [name, def] of Object.entries(this.cfg.stats)) {
      let v = (Number.isFinite(this.stats[name]) ? this.stats[name] : finite(def.start)) + (finite(def.perHour) + (this.activeRates[name] ?? 0)) * hours;
      const toward = def.toward;
      if (toward !== undefined && Number.isFinite(toward)) {
        const step = Math.abs(finite(def.towardPerHour)) * hours;
        const delta = toward - v;
        if (step > 0 && delta !== 0) v = step >= Math.abs(delta) ? toward : v + Math.sign(delta) * step;
      }
      const [lo, hi] = statRange(def);
      this.stats[name] = clamp(v, lo, hi);
    }
  }

  /** 当前可选的行为和权重（只列权重大于 0 的）：顺序同 cfg.behaviors。 */
  candidates(view: MindView, now: number, opts: {r18: boolean}): {def: BehaviorDef; weight: number}[] {
    return this.availability(view, now, opts).filter(c => !c.blocked_by.length).map(({def, weight}) => ({def, weight}));
  }

  /** Same rule results for selection and diagnostics; never infer why a compound condition failed. */
  availability(view: MindView, now: number, opts: {r18: boolean; source?: 'rule'|'llm'}): {
    def: BehaviorDef; weight: number; rule_weight:number; preference_met:boolean; cooldown_remaining_s: number;
    blocked_by: ('mode_restricted' | 'condition_not_met' | 'preference_not_met' | 'cooldown' | 'weight_zero')[];
  }[] {
    return this.cfg.behaviors.map(def => {
      const blocked_by: ('mode_restricted' | 'condition_not_met' | 'preference_not_met' | 'cooldown' | 'weight_zero')[] = [];
      if (def.r18 && !opts.r18) blocked_by.push('mode_restricted');
      if (def.when != null && !this.testRule(def.when, view, `${def.id}.when`)) blocked_by.push('condition_not_met');
      const cooldown_remaining_s = Math.max(0, (this.cooldowns[def.id] ?? now) - now);
      if (cooldown_remaining_s > 0) blocked_by.push('cooldown');
      const preference_met=def.prefer==null||this.testRule(def.prefer,view,`${def.id}.prefer`);
      if(!preference_met&&opts.source!=='llm')blocked_by.push('preference_not_met');
      const rule_weight=this.weightOf(def, view);
      // Only explicitly marked preference behaviors can override a zero routine score.
      const weight=opts.source==='llm'&&def.prefer!=null?Math.max(1,rule_weight):rule_weight;
      if (!weight) blocked_by.push('weight_zero');
      return {def, weight, rule_weight, preference_met, cooldown_remaining_s, blocked_by};
    });
  }

  /**
   * 按权重随机选一个（rng 返回 [0,1)）；没有候选返回 null。
   * 上一个正常结束的行为有 next 时先只在 next 的候选里选，里面一个可选的都没有就照常从全部候选里选；
   * 选中后限制清掉。被中止的行为不留限制（见 ended）。
   */
  choose(view: MindView, now: number, rng: () => number, opts: {r18: boolean}): BehaviorDef | null {
    const all = this.candidates(view, now, opts);
    let pool = all;
    if (this.nextIds) {
      const allowed = new Set(this.nextIds);
      const restricted = all.filter(c => allowed.has(c.def.id));
      if (restricted.length) pool = restricted;
    }
    if (!pool.length) return null;
    let total = 0;
    for (const c of pool) total += c.weight;
    let r = rng() * total;
    if (!Number.isFinite(r)) r = 0;
    let picked = pool[pool.length - 1].def;
    for (const c of pool) {
      if (r < c.weight) { picked = c.def; break; }
      r -= c.weight;
    }
    this.nextIds = null;
    return picked;
  }

  /** 行为开始了：记冷却（now + cooldown），应用 effects.start（给了 partner 就替换 $partner） */
  started(def: BehaviorDef, now: number, partner?: string): void {
    this.cooldowns[def.id] = now + finite(def.cooldown);
    this.applyEffects(def.effects?.start, partner);
  }

  /**
   * 只记冷却、不算开始过（不应用效果）：选中了但按当时的世界解析不了（如找不到能躲的窗口），换一个之前调（主代理加）。
   * sec 给了就用它（双人被拒用 DuoTemplate.declineCooldown），否则用 def.cooldown
   */
  cooldown(def: BehaviorDef, now: number, sec?: number): void {
    this.cooldowns[def.id] = now + finite(sec ?? def.cooldown);
  }

  /**
   * 行为结束了：'done' 应用 effects.end 并记下 next；'aborted' 应用 effects.interrupt。
   * id 不在 cfg.behaviors 里（如 'builtin:xxx'、'reaction:discovered'）时什么都不做。
   */
  ended(behaviorId: string, outcome: 'done' | 'aborted', now: number, partner?: string): void {
    const def = this.cfg.behaviors.find(b => b.id === behaviorId);
    if (!def) return;
    if (outcome === 'done') {
      this.applyEffects(def.effects?.end, partner);
      this.nextIds = def.next && def.next.length ? [...def.next] : null;
    } else {
      this.applyEffects(def.effects?.interrupt, partner);
      this.nextIds = null;
    }
    // now 现在用不到（冷却在 started 时记）；留着是为了和 started / choose 的接口一致。
    void now;
  }

  /**
   * 应用效果：键 "stats.<名字>"（不存在的状态值忽略并警告一次）、"relations.<对象>.affection"
   * （对象可以是 user、角色 id、"$partner"；没有就从 50 起），加减后夹在范围里（好感 0..100）。
   */
  applyEffects(effects: Effects | undefined, partner?: string): void {
    if (!effects) return;
    for (const [key, value] of Object.entries(effects)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (key.startsWith('stats.')) {
        const name = key.slice('stats.'.length);
        const def = this.cfg.stats[name];
        if (!def) {
          warnOnce(`${this.id}:effect:stats:${name}`, `[brain ${this.id}] 效果里引用了不存在的状态值 "${name}"，忽略`);
          continue;
        }
        const [lo, hi] = statRange(def);
        this.stats[name] = clamp(finite(this.stats[name], finite(def.start)) + value, lo, hi);
      } else if (key.startsWith('relations.') && key.endsWith('.affection')) {
        let who = key.slice('relations.'.length, -'.affection'.length);
        if (!who) {
          warnOnce(`${this.id}:effect:key:${key}`, `[brain ${this.id}] 效果键 "${key}" 不完整，忽略`);
          continue;
        }
        if (who === '$partner') {
          // 单人执行的双人效果：没有另一方，整条忽略（不凭空造一个 "$partner" 关系）
          if (partner === undefined) continue;
          who = partner;
        }
        const current = this.relations[who]?.affection ?? 50;
        this.relations[who] = {affection: clamp(current + value, 0, 100)};
      } else {
        warnOnce(`${this.id}:effect:key:${key}`, `[brain ${this.id}] 看不懂的效果键 "${key}"，忽略`);
      }
    }
  }

  /** JSON Logic 求真假（真值判断照 JSON Logic 的 truthy 规则） */
  test(logic: Logic, view: MindView): boolean {
    return logic !== undefined && logic !== null && this.testRule(logic, view, `test:${describeRule(logic)}`);
  }

  /**
   * 被点 / 被摸时挑反应（R3.6，mind.ts ReactionDef）：keys 按顺序试（如 ['click:chest', 'click']）。一个键的反应（一个或一串）里
   * when 成立、全年龄时不是 r18、权重 > 0 的按权重随机挑一个，记这个键的冷却（def.cooldown，默认 REACTION_COOLDOWN）；
   * （开源版省略）
   * 都没有返回 null。
   */
  reaction(keys: readonly string[], view: MindView, now: number, rng: () => number, opts: {r18: boolean}): {key: string; def: ReactionDef | null} | null {
    for (const key of keys) {
      if (!this.cfg.reactions?.[key]) continue;
      if (now < (this.reactionCooldowns[key] ?? -Infinity)) return {key, def: null};
      const picked = this.pickReaction(key, view, rng, opts);
      if (!picked) continue;
      this.reactionCooldowns[key] = now + finite(picked.cooldown, REACTION_COOLDOWN);
      return {key, def: picked};
    }
    return null;
  }

  /** reactions[key]（一个或一串）里按 r18、when、weight 挑一个，不管冷却（被发现这类不能因为冷却就没反应，Sim.foundReaction）；没有成立的 null */
  pickReaction(key: string, view: MindView, rng: () => number, opts: {r18: boolean}): ReactionDef | null {
    const raw = this.cfg.reactions?.[key];
    if (!raw) return null;
    const list: readonly ReactionDef[] = Array.isArray(raw) ? raw : [raw as ReactionDef];
    const pool: {def: ReactionDef; weight: number}[] = [];
    for (const [i, def] of list.entries()) {
      if (def.r18 && !opts.r18) continue;
      if (def.when !== undefined && def.when !== null && !this.testRule(def.when, view, `reactions.${key}[${i}].when`)) continue;
      const w = def.weight === undefined ? 1 : typeof def.weight === 'number' ? def.weight : this.evalLogic(def.weight, view, `reactions.${key}[${i}].weight`);
      if (typeof w === 'number' && Number.isFinite(w) && w > 0) pool.push({def, weight: w});
    }
    if (!pool.length) return null;
    let r = rng() * pool.reduce((t, c) => t + c.weight, 0), picked = pool[pool.length - 1].def;
    for (const c of pool) { if (r < c.weight) { picked = c.def; break; } r -= c.weight; }
    return picked;
  }

  /** 接不接受 kind 类邀请（cfg.accept[kind]，没写 = 接受）；view.inviter 由调用方填 */
  accepts(kind: string, view: MindView): boolean {
    const rule = this.cfg.accept?.[kind];
    if (rule === undefined || rule === null) return true;
    return jsonLogic.truthy(this.evalLogic(rule, view, `accept.${kind}`));
  }

  /** 存档用（冷却和下一步限制不进存档） */
  save(): SavedMind {
    const relations: Record<string, {affection: number}> = {};
    for (const [who, rel] of Object.entries(this.relations)) relations[who] = {affection: rel.affection};
    return {stats: {...this.stats}, relations};
  }

  /** 行为定义的基础权重 / JSON Logic 权重；非有限数、负数、非数都当 0 */
  private weightOf(def: BehaviorDef, view: MindView): number {
    if (typeof def.weight === 'number') return Number.isFinite(def.weight) && def.weight > 0 ? def.weight : 0;
    if (def.weight === undefined || def.weight === null) return 0;
    const result = this.evalLogic(def.weight, view, `${def.id}.weight`);
    return typeof result === 'number' && Number.isFinite(result) && result > 0 ? result : 0;
  }

  /** when / weight 求值，规则写错时警告一次并返回 null（调用方按 false / 0 处理） */
  private testRule(rule: Logic, view: MindView, label: string): boolean {
    return jsonLogic.truthy(this.evalLogic(rule, view, label));
  }

  private evalLogic(rule: Logic, view: MindView, label: string): unknown {
    try {
      return applyLogic(rule, view);
    } catch (e) {
      warnOnce(`${this.id}:${label}`, `[brain ${this.id}] JSON Logic 规则 ${label} 求值出错，按 false / 0 处理：${errorText(e)}`);
      return null;
    }
  }
}

/** 状态值的初值：cfg.stats 的 start，saved 里有的覆盖（不在 cfg.stats 里的键丢掉，值夹到范围里） */
export function initialStats(cfg: MindConfig, saved?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, def] of Object.entries(cfg.stats)) {
    const start = finite(def.start);
    const override = saved?.[name];
    const [lo, hi] = statRange(def);
    out[name] = clamp(typeof override === 'number' && Number.isFinite(override) ? override : start, lo, hi);
  }
  return out;
}

/** 好感初值：cfg.relations 里有的用它，saved.relations 覆盖；没写的对象读到时按 50（见 applyEffects） */
function initialRelations(cfg: MindConfig, saved?: Record<string, {affection: number}>): Record<string, {affection: number}> {
  const out: Record<string, {affection: number}> = {};
  for (const [who, rel] of Object.entries(cfg.relations ?? {})) {
    out[who] = {affection: clamp(finite(rel?.affection, 50), 0, 100)};
  }
  for (const [who, rel] of Object.entries(saved ?? {})) {
    if (typeof rel?.affection === 'number' && Number.isFinite(rel.affection)) out[who] = {affection: clamp(rel.affection, 0, 100)};
  }
  return out;
}

/** 解锁条件：cfg.unlock 没写或 null → true；否则 JSON Logic 真假（规则写错当作 false，警告一次） */
export function isUnlocked(cfg: MindConfig, view: UnlockView): boolean {
  if (cfg.unlock === undefined || cfg.unlock === null) return true;
  try {
    return jsonLogic.truthy(applyLogic(cfg.unlock, view));
  } catch (e) {
    warnOnce(`unlock:${describeRule(cfg.unlock)}`, `[brain] 解锁规则 ${describeRule(cfg.unlock)} 求值出错，当作未解锁：${errorText(e)}`);
    return false;
  }
}

/** Range 取值：数原样；[lo, hi] 均匀随机 lo + (hi - lo) × rng() */
export function pickRange(r: Range, rng: () => number): number {
  if (typeof r === 'number') return r;
  const [lo, hi] = r;
  return lo + (hi - lo) * rng();
}
