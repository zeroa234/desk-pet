// Fixed meanings for the model-facing state protocol. No filesystem, clock, navigation or model calls.
import type {BehaviorDef, StepTemplate} from '../behavior/index.ts';
import type {ActorState, Phase} from '../behavior/index.ts';
import type {Rect} from '../shared/types.ts';

export interface Capability { id: string; adult: boolean; steps: string[]; routine_preference?:unknown }
export interface BehaviorStatus {
  id: string; target?: string; scene?: string; available: boolean; cooldown_remaining_s: number; blocked_by: string[];
  preference_met?:boolean; rule_weight?:number;
  decision_selectable?:boolean;
}
export interface ActorFacts {
  id: string; name: string; state: ActorState; action: string; phase: Phase | null; outfit: string;
  position: {x: number; y: number}; display_id: number | null;
  body_position: {x:number;y:number}; facing: 'left'|'right'; behavior: string|null;
  motion: {kind:'walk'|'jump'|'fall'|'carried'|'stationary';direction:'left'|'right'|'none';destination_x?:number;body_destination_x?:number};
  place: string; layer: string; covered_fraction: number;
  routine_control?: {owner:string;remaining_s:number} | null;
  interaction?: {scene:string;role:'receiver'|'giver';partner:string;initiated_by:string;stage:'approach'|'play';phase:Phase|null};
}
export interface StateSnapshot {
  state_schema: 1; snapshot_v: number; time: string; mode: 'adult' | 'sfw';
  displays: {id: number; bounds: Rect}[];
  self: ActorFacts & {stats: Record<string, number>; relations: Record<string, {affection: number}>};
  others: ActorFacts[];
  user: {away: boolean; locked: boolean; idle_s: number};
  behaviors: BehaviorStatus[];
  pending_goals: {behavior: string; target?: string; scene?: string}[];
}

export const STATE_RULES = `【程序状态协议 v1】
状态和 recent_events/程序执行回执是程序事实；台词、私有 want、视觉观察各有来源，不能证明动作完成。aborted/cancelled=中断/取消。time 是本机本地时间，at_sim_s 是本进程模拟秒。
position=模型脚底点，body_position=身体中心正下方；判断左右、接近用后者。两者及 displays.bounds 均为虚拟桌面物理像素，主屏左上 (0,0)，x 右 y 下，副屏可为负；display_id=null 为不在屏内。截图缩放坐标、位移不等于这些坐标、步数或可达性。
facing 是面朝方向；motion.kind/direction 是实际运动，stationary 不在走。destination_x=当前路段模型原点终点，body_destination_x=身体终点。寻路可能先绕远，按实际方向说；walk 不等于已到达。behavior/action/phase/outfit 是当前计划/动作/阶段/衣着。
others 仅含实际在场者，不保证可见或同屏；不提供她们的私有愿望、数值和会话。layer: front/behind/inside=前层/窗口后/窗口内；place: floor/window/inside/air=支撑种类；covered_fraction=被窗口遮挡比例 0..1。interaction 若有：scene=双人场景，role=receiver/giver（场景接受方/给予方，非邀请方），partner=对方，initiated_by=邀请方，stage=approach/play（走位/播放），phase=场景阶段。不能从自个儿的 idle 动作名猜场景未播放。
self.stats、relations.affection 是数值，范围见量表；user.away/locked/idle_s=判定离开/锁屏/无键鼠输入秒数。
能力目录是素材与配置支持的行为，steps 是步骤含义；behaviors 是本次逐项可用性，available=true 才能现在开始，decision_selectable=false 表示未进入本轮有限选择表，target/scene 是具体绑定。routine_preference、preference_met、rule_weight 是算法的软偏好，LLM 可突破；不能把欲望低当硬禁止。when、体力底线、冷却、模式、素材、接受和导航仍为硬限制，返回后重查。
blocked_by：condition_not_met=复合条件未满足（不猜具体原因）；cooldown=行为冷却中；weight_zero=规则权重为零；mode_restricted=模式限制；actor_busy=当前计划未结束或非待机；actor_reserved=等候另一角色；no_support=无支撑；plan_unavailable=无法解析路线/步骤；materials_unavailable=动作/衣着不匹配；target_unavailable=目标不在；duo_unavailable=接受/场景/放置/可达性未通过，不等于对方口头拒绝。多个限制可并存，冷却归零不保证可用。
routine_control.owner/remaining_s 是暂挡普通自发行为的保护，自己的保护不挡下一次合法模型行动；其他 owner 表示等候对方。到期不截动作，拖拽/掉落/发现/模式仍可打断。当前步骤剩余、保护、行为冷却是三个独立计时，不能合为“还要等多久”，不在角色台词播报。
pending_goals 是待重查的后续目标，未开始、可能取消；已锁定步骤依序执行，仅当前阶段已在发生。want 不能当开始/完成记录，不能承诺候选以外或硬限制下的行动。`;

const MEANINGS: Record<StepTemplate['do'], string> = {
  idle: '站着等一会儿', wander: '在当前支撑面随机游走（不指定方向或角色，不能用于走向某人）', sit: '坐一会儿', play: '播放动作',
  gotoHide: '走到合适的窗口后', hide: '躲在窗口后', unhide: '回到前层', outfit: '换衣着',
  approach: '寻路靠近角色并面向她停留', hop: '跳到可达的支撑面', enter: '跳进脚下窗口',
  leave: '跳出所在窗口', emerge: '走出遮挡或跳出窗口', peek: '走到遮挡边缘探头', hideHere: '留在当前遮挡处躲藏',
};
export function capability(def: BehaviorDef): Capability {
  return {id: def.id, adult: !!def.r18 || !!def.duo, ...(def.prefer!=null?{routine_preference:def.prefer}:{}), steps: def.duo ? [`邀请指定角色参与场景（${def.duo.kind}）`] :
    (def.steps ?? []).map(t => MEANINGS[t.do] + (t.do === 'approach' ? `：${t.who}` : t.do === 'outfit' ? `：${t.to}` : 'action' in t && t.action ? `：${t.action}` : ''))};
}
export function capabilitiesText(catalog: Capability[], stats: Record<string,{min?:number;max?:number}> = {}): string {
  return `【你的能力目录】\n${JSON.stringify(catalog)}\n【角色量表范围】\n`+
    JSON.stringify(Object.fromEntries(Object.entries(stats).map(([name,def])=>[name,{min:def.min??0,max:def.max??100}])));
}
