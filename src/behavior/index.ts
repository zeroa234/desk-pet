// behavior/：单个角色的主状态机 + 身体（纯逻辑，不 import electron、不碰 Win32；design.md §1，state-rules.md §2）。
// 别的模块只 import 这个文件。坐标是物理像素（shared/types.ts），时间是秒。
export type {ActorState, ActionInfo, Tuning, ActorSpec, Metrics, WorldContext, Actor, ActorEvent, Phase, Layer, Step, Plan, Fx, Transition} from './types.ts';
export {ACTION_FALLBACK, DEFAULT_TUNING, PHYSICAL_STATES, FRONT, sameLayer} from './types.ts';
export {createActor, stepActor, grabActor, dragActor, releaseActor, currentFrame, resolveAction, actionAvailable, setPlan, continueExposed, heightPxOf, bodyX, landsOn} from './actor.ts';
export {Brain, isUnlocked, initialStats, pickRange, REACTION_COOLDOWN} from './brain.ts';
export {behaviorHasMaterials, planPlayable} from './availability.ts';
export type {MindConfig, BehaviorDef, KeepOnDiscovered, ReactionDef, StepTemplate, MindView, UnlockView, SavedMind, Effects, Logic, Range} from './mind.ts';
