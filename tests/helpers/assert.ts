// 单测的断言小工具（2026-10-22 审查 §3 “tests/” 那一行）：
// 以前 15 个测试文件各抄了一份 eq()、5 份 approx()、6 份 close()，这里收成一份。
// eq 不做类型收窄：node:assert 的 equal 带 `asserts actual is T` 签名，会把 Actor.state 之类的窄化成字面量
// （如 'fall'），后面再比较 `a.state === 'idle'` 就成了无意义比较（tsc 报错）。
import assert from 'node:assert/strict';

/** 断言相等，但不做类型收窄（理由见文件头） */
export function eq(actual: unknown, expected: unknown, message?: string): void {
  assert.equal(actual, expected, message);
}

/** 数值相近：|actual - expected| <= eps；报错里带上说明和差值。eps 默认 1e-6 */
export function approx(actual: number, expected: number, message = '数值', eps = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${message}：${actual} ≠ ${expected}（差 ${actual - expected}）`);
}

/**
 * 数值相近，另一种报错格式：|actual - expected| <= eps。
 * 收编前各份的差别只有两处：`<` / `<=`（正好等于 eps 那一点），以及有没有 message、eps 有没有默认值；
 * 这里统一成 `<=` + eps 默认 1e-6 + message 默认 '数值'（原来用 `<` 的测例照样过，只是边界那一点松了一点点）。
 */
export function close(actual: number, expected: number, eps = 1e-6, message = '数值'): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${message}：${actual} 和 ${expected} 差得超过 ${eps}`);
}
