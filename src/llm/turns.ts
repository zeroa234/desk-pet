// 会话轮数、每小时上限的合法范围：运行时（src/llm/runtime.ts）和设置窗口（输入时就地提示）共用一份。纯函数，不 import Node 的东西。
export type Turns = {maxTurns: number; dropTurns: number; decisionTurns: number};
export const MAX_TURNS = 500;
const posInt = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
/** 超过 maxTurns 轮时丢最早 dropTurns 轮：至少留 1 轮，最多 MAX_TURNS 轮；决策带最近 decisionTurns 轮（0 = 不带），不超过 maxTurns */
export const turnsValid = (t: Partial<Record<keyof Turns, unknown>>) => posInt(t.maxTurns) && posInt(t.dropTurns) && (t.dropTurns as number) < (t.maxTurns as number) &&
  (t.maxTurns as number) <= MAX_TURNS && Number.isInteger(t.decisionTurns) && (t.decisionTurns as number) >= 0 && (t.decisionTurns as number) <= (t.maxTurns as number);
/** 每小时上限：正整数或 null（不限） */
export const hourlyValid = (n: unknown): n is number | null => n === null || posInt(n) && (n as number) <= 100000;
