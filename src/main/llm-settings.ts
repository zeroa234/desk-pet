// 设置窗口里 AI 对话、看屏幕、说话声音、用量这几页的数据和动作（2026-10-29 从旧的“LLM 统计与提示词”面板 llm-panel.ts 搬过来，规则不变）。
// 只经 LlmRuntime 的公开方法改配置；key、原始请求不进页面。提示词存 config/prompts.local.json（不入库）。
import fs from 'node:fs';
import path from 'node:path';
import {limitText, type LlmRuntime} from '../llm/runtime.ts';
import type {MemoryMode} from '../llm/memory.ts';
import {textToUnits} from '../llm/speech.ts';
import {voiceValid} from '../llm/voice.ts';
import type {Msg} from '../shared/msg.ts';
import type {LlmView, Result, SettingsAction, UsageView} from '../settings/protocol.ts';

/** 公共前缀在 prompts.local.json 里的键（所有角色共用，排在每个角色请求的最前面） */
export const SHARED = '_shared';
export const PROMPT_MAX = 12000;
/** 角色包没有人设文件时的默认人设（发给模型的，不翻译） */
const FALLBACK_PERSONA = '你是一位成年的桌面伙伴。说话简短、自然、友善。';

export interface LlmCharacter {id: string; dir?: string}
export interface LlmSettingsDeps {
  /** 角色的显示名（按界面语言） */
  nameOf(id: string): string;
  visionLatest(): Msg;
  /** 现在能不能让她看一次（看屏幕开着、模型能看图、她在桌面上） */
  canLook(id: string): boolean;
  look(id: string): boolean;
  volume(): number;
}

const modeOf = (m: unknown): MemoryMode | null => m === 'sfw' || m === 'adult' ? m : null;

export function createLlmSettings(root: string, runtime: LlmRuntime, chars: readonly LlmCharacter[], deps: LlmSettingsDeps) {
  const file = path.join(root, 'config', 'prompts.local.json');
  const read = (): Record<string, Record<string, string>> => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const known = (id: unknown): id is string => typeof id === 'string' && chars.some(c => c.id === id);

  function view(): LlmView {
    const custom = read();
    const prompts: LlmView['prompts'] = {[SHARED]: {adult: custom[SHARED]?.adult ?? '', sfw: custom[SHARED]?.sfw ?? ''}};
    for (const c of chars) {
      prompts[c.id] = {adult: '', sfw: ''};
      for (const mode of ['adult', 'sfw'] as const) {
        let text = FALLBACK_PERSONA;
        try { text = fs.readFileSync(path.join(root, c.dir ?? path.join('packs', c.id), mode === 'sfw' ? 'persona-sfw.md' : 'persona.md'), 'utf8'); } catch { /* 没有人设文件用默认 */ }
        prompts[c.id][mode] = typeof custom[c.id]?.[mode] === 'string' ? custom[c.id][mode] : text;
      }
    }
    const cfg = runtime.config;
    return {
      latest: runtime.latest, limit: runtime.limitHit ? limitText(runtime.limitHit) : null, hourly: cfg.hourlyRequests ?? null,
      providers: Object.entries(cfg.providers).filter(([id]) => id !== cfg.decision).map(([id, p]) => ({id, model: p.model, images: p.images === true})),
      defaultTurns: {maxTurns: cfg.context.maxTurns, dropTurns: cfg.context.dropTurns, decisionTurns: cfg.context.decisionTurns},
      characters: chars.map(c => ({
        id: c.id, name: deps.nameOf(c.id), provider: cfg.characters[c.id]?.text ?? null, ...runtime.turnsOf(c.id),
        customTurns: (['maxTurns', 'dropTurns', 'decisionTurns'] as const).some(k => cfg.characters[c.id]?.[k] !== undefined),
        voice: runtime.voiceOf(c.id), voiceDefault: runtime.defaultVoiceOf(c.id), voiceCustom: cfg.characters[c.id]?.voice !== undefined,
        vision: cfg.characters[c.id]?.vision ?? {}, imageStatus: runtime.imageStatus(c.id) as LlmView['characters'][number]['imageStatus'],
        memory: Object.fromEntries((['adult', 'sfw'] as const).map(m => [m, {...runtime.memory.counts(c.id, m), summary: runtime.memory.window(c.id, m).summary}])) as LlmView['characters'][number]['memory'],
        canLook: deps.canLook(c.id),
      })),
      shared: SHARED, prompts, promptMax: PROMPT_MAX, vision: cfg.vision, visionLatest: deps.visionLatest(),
    };
  }

  function usage(): UsageView {
    const summary = runtime.store.summary();
    return {summary, byCharacter: Object.fromEntries(Object.keys(summary.byCharacter).map(id => [id, runtime.store.summary(id)])),
      byKind: Object.fromEntries(Object.keys(summary.byKind).map(kind => [kind, runtime.store.summary(undefined, kind)])), recent: runtime.store.recent(50)};
  }

  const ok = (value?: unknown): Result => ({ok: true, value});
  const no = (error = 'error.invalid'): Result => ({ok: false, error});

  /** 动作（只处理 llm.* 的）；不认识返回 null */
  function act(a: SettingsAction): Result | null {
    switch (a.type) {
      case 'llm.prompt': {
        if (!(a.id === SHARED || known(a.id)) || !modeOf(a.mode) || typeof a.text !== 'string' || a.text.length > PROMPT_MAX) return no();
        const data = read(); data[a.id] = {...data[a.id], [a.mode]: a.text};
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2)); fs.renameSync(file + '.tmp', file);
        return ok();
      }
      case 'llm.character':
        return known(a.id) && !!a.patch && typeof a.patch === 'object' && !Array.isArray(a.patch)
          && runtime.setCharacter(a.id, a.patch as Parameters<LlmRuntime['setCharacter']>[1]) ? ok() : no('error.turns');
      // 试听：只在本地合成，不保存、不排进对话、不发给模型
      case 'llm.voicePreview':
        if (!known(a.id) || !voiceValid(a.voice) || typeof a.text !== 'string' || !a.text.trim() || Array.from(a.text).length > 80) return no();
        return ok({voice: {...a.voice}, units: textToUnits(a.text, a.voice), volume: Math.max(0, Math.min(1, deps.volume()))});
      case 'llm.vision':
        return !!a.patch && typeof a.patch === 'object' && !Array.isArray(a.patch) && runtime.setVision(a.patch) ? ok() : no('error.vision');
      case 'llm.providerImages':
        return typeof a.id === 'string' && typeof a.images === 'boolean' && runtime.setProviderImages(a.id, a.images) ? ok() : no();
      case 'llm.forget': {
        const m = modeOf(a.mode);
        if (!known(a.id) || !m) return no();
        runtime.forgetMemory(a.id, m); return ok();
      }
      case 'llm.hourly': return runtime.setHourlyLimit(a.n) ? ok() : no('error.range');
      case 'llm.look': return known(a.id) && deps.look(a.id) ? ok() : no('error.lookUnavailable');
      case 'llm.usage': return ok(usage());
      default: return null;
    }
  }

  return {view, act, usage};
}

