// System One protocol for a bounded sequence. The model chooses identifiers; Sim owns all execution checks.
import type {Question, Answer} from './providers.ts';
import type {Intent} from './types.ts';

export const DECISION_INSTRUCTIONS = '从本题已校验的候选选择行动，不生成台词。最新 want 优先按明确的 behavior、target 对应；历史愿望不自动延续。想重复可选同一行为，不为换花样改意愿。' +
  '候选均可执行，preference_met=false、rule_weight 仅是算法软偏好，不阻止明确意愿；候选外的冷却、接受、体力底线等硬限制不能突破，不安排等限制解除的目标。' +
  '接近某人选含 approach 的行为，wander 只会随机闲逛。新 want 无匹配或拿不准选 rule/stop；没有新 want 则按自己人设、当前状态与经历选择。说过同意不代表已执行。';

export function decisionQuestions(candidates: Intent[], planned: Intent[] = []): Record<string, Question> {
  const choices = Object.fromEntries(candidates.flatMap((c,i)=>planned.some(p=>p.id===c.id) ? [] : [[`c${i}`,`behavior: ${c.behavior}; target: ${c.target??'-'}; scene: ${c.scene??'-'}; weight: ${c.weight}; steps: ${c.description??c.behavior}`]]));
  if (planned.length) return {intent:{type:'choice',instructions:DECISION_INSTRUCTIONS+
    `这是同一计划的第 ${planned.length+1} 项。已经依次安排：${JSON.stringify(planned.map(p=>({behavior:p.behavior,target:p.target})))}。`+
    '按 want 的顺序选择尚未安排的下一项目标；已安排不等于已执行，此题假定前项成功后才开始。不因前项尚未执行就停止。没有剩余目标就 stop。',criteria:{stop:'结束计划，没有下一项目标',...choices}}};
  return {
    intent:{type:'choice',instructions:DECISION_INSTRUCTIONS+'选择 want 中按顺序要先做的第一个目标。',criteria:{rule:'按现有规则选择',...choices}},
    plan_size:{type:'choice',instructions:'want 明确要求依次完成多少个不同的候选行为？计算明确列出的目标数量，不把一个行为内部的动画片段或寻路步骤重复计数。没有 want、没有连续意图或无法对应候选时选 one。最多 three。',
      criteria:{one:'单个目标，或没有明确连续目标',two:'明确依次做两个候选行为',three:'明确依次做三个或更多候选行为'}},
  };
}

export function requestedPlanSize(answers: Record<string, Answer>): number {
  return answers.plan_size?.choice === 'three' ? 3 : answers.plan_size?.choice === 'two' ? 2 : 1;
}

export function selectedGoals(answers: Record<string, Answer>, candidates: Intent[], minProbability: number | null): string[] {
  const answer=answers.intent,match=/^c(\d+)$/.exec(answer?.choice??'');
  if(!match || minProbability!==null && (answer.probabilities?.[answer.choice!]??0)<minProbability)return [];
  const goal=candidates[Number(match[1])];return goal ? [goal.id] : [];
}
