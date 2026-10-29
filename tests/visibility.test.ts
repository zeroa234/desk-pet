// world/visibility 的单测：矩形面积 / 求交 / 相减、遮挡比例、coversAbove、findHideSpots。
// 规则见 src/world/visibility.ts 开头、docs/desktop-interaction.md §2.1、§2.2、§2.5、§2.7。
import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';

import {
  rectArea, intersectRect, subtractRects, coveredFraction, coversAbove, findHideSpots,
} from '../src/world/index.ts';
import type {HideSpotQuery} from '../src/world/index.ts';
import type {Rect, WinInfo} from '../src/shared/types.ts';
import {makeWindow, rect} from './helpers/fake-desktop.ts';

/** 结果面积之和 */
function areaSum(rects: readonly Rect[]): number {
  let sum = 0;
  for (const r of rects) sum += rectArea(r);
  return sum;
}

/** 两两不重叠（贴边不算重叠） */
function assertNoOverlaps(rects: readonly Rect[]): void {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assert.equal(intersectRect(rects[i], rects[j]), null, `第 ${i} 块和第 ${j} 块重叠`);
    }
  }
}

test('rectArea：普通矩形、空矩形、负尺寸', () => {
  assert.equal(rectArea(rect(0, 0, 10, 20)), 200);
  assert.equal(rectArea(rect(-10, -20, 10, 20)), 800);
  // right<=left 或 bottom<=top 都是空矩形
  assert.equal(rectArea(rect(5, 5, 5, 10)), 0);
  assert.equal(rectArea(rect(5, 5, 10, 5)), 0);
  assert.equal(rectArea(rect(10, 10, 0, 0)), 0);
});

test('intersectRect：相交、包含、贴边、空矩形', () => {
  assert.deepEqual(intersectRect(rect(0, 0, 100, 100), rect(20, 30, 80, 90)), rect(20, 30, 80, 90));
  assert.deepEqual(intersectRect(rect(20, 30, 80, 90), rect(0, 0, 100, 100)), rect(20, 30, 80, 90));
  assert.deepEqual(intersectRect(rect(0, 0, 100, 100), rect(50, 50, 150, 150)), rect(50, 50, 100, 100));
  // 只贴边（right/bottom 不含）算不相交
  assert.equal(intersectRect(rect(0, 0, 10, 10), rect(10, 0, 20, 10)), null);
  assert.equal(intersectRect(rect(0, 0, 10, 10), rect(0, 10, 10, 20)), null);
  assert.equal(intersectRect(rect(0, 0, 10, 10), rect(20, 20, 30, 30)), null);
  assert.equal(intersectRect(rect(0, 0, 0, 10), rect(-10, 0, 10, 10)), null);
});

test('subtractRects：没有 cutter 或不相交时原样返回，不改输入', () => {
  const base = rect(10, 20, 110, 220);
  const snapshot = {...base};
  assert.deepEqual(subtractRects(base, []), [base]);
  assert.deepEqual(subtractRects(base, [rect(200, 200, 300, 300)]), [base]);
  assert.deepEqual(base, snapshot);
});

test('subtractRects：完全盖住返回 []', () => {
  assert.deepEqual(subtractRects(rect(10, 10, 110, 110), [rect(0, 0, 200, 200)]), []);
  // 和 base 一样大也算完全盖住
  assert.deepEqual(subtractRects(rect(10, 10, 110, 110), [rect(10, 10, 110, 110)]), []);
});

test('subtractRects：中间挖洞得到 4 块，面积对且互不重叠', () => {
  const base = rect(0, 0, 100, 100);
  const hole = rect(30, 40, 70, 60);
  const out = subtractRects(base, [hole]);
  assert.equal(out.length, 4);
  assert.equal(areaSum(out), rectArea(base) - rectArea(hole));
  assertNoOverlaps(out);
  for (const r of out) {
    assert.ok(rectArea(r) > 0);
    assert.ok(r.left >= base.left && r.right <= base.right);
    assert.ok(r.top >= base.top && r.bottom <= base.bottom);
  }
});

test('subtractRects：多个 cutter 互相重叠时按并集扣面积', () => {
  const base = rect(0, 0, 100, 100);
  const cutters = [rect(10, 10, 60, 60), rect(40, 40, 90, 90)];
  const snapshot = cutters.map(c => ({...c}));
  const out = subtractRects(base, cutters);
  // 两个 50×50 的洞，重叠 20×20
  const union = 50 * 50 + 50 * 50 - 20 * 20;
  assert.equal(areaSum(out), rectArea(base) - union);
  assertNoOverlaps(out);
  for (const r of out) {
    assert.ok(r.left >= 0 && r.right <= 100 && r.top >= 0 && r.bottom <= 100);
  }
  assert.deepEqual(cutters, snapshot);
});

test('coveredFraction：两个 cover 互相重叠不重复计面积', () => {
  const target = rect(0, 0, 100, 100);
  const covers = [rect(0, 0, 60, 60), rect(40, 40, 100, 100)];
  // 3600 + 3600 - 400 = 6800；重复计会得到 0.72
  assert.equal(coveredFraction(target, covers), 0.68);
});

test('coveredFraction：cover 超出 target 的部分不算，贴边不算', () => {
  const target = rect(0, 0, 100, 100);
  assert.equal(coveredFraction(target, [rect(-50, -50, 50, 50)]), 0.25);
  assert.equal(coveredFraction(target, [rect(-100, -100, 200, 200)]), 1);
  assert.equal(coveredFraction(target, [rect(100, 0, 200, 100)]), 0);
});

test('coveredFraction：结果在 [0,1]，空 target 返回 0', () => {
  const target = rect(0, 0, 100, 100);
  assert.equal(coveredFraction(target, []), 0);
  assert.equal(coveredFraction(rect(5, 5, 5, 100), [target]), 0);
  const f = coveredFraction(rect(10, 10, 40, 40), [rect(0, 0, 30, 30), rect(20, 20, 100, 100)]);
  assert.ok(f >= 0 && f <= 1);
});

test('coversAbove：返回 hwnd 自己和它上面的窗口，不在列表返回 null', () => {
  const a = makeWindow(1, rect(0, 0, 100, 100));
  const b = makeWindow(2, rect(10, 10, 110, 110));
  const c = makeWindow(3, rect(20, 20, 120, 120));
  const wins = [a, b, c];
  assert.deepEqual(coversAbove(wins, 2), [a.rect, b.rect]);
  assert.deepEqual(coversAbove(wins, 1), [a.rect]);
  assert.deepEqual(coversAbove(wins, 3), [a.rect, b.rect, c.rect]);
  assert.equal(coversAbove(wins, 99), null);
  assert.equal(coversAbove([], 1), null);
});

// ---- findHideSpots ----

const FOOT_Y = 1000;
const HALF_W = 10;

/** 脚底在 (x, FOOT_Y) 时角色包围盒：20 宽、200 高（物理像素） */
function boxAt(x: number): Rect {
  return rect(x - HALF_W, FOOT_Y - 200, x + HALF_W, FOOT_Y);
}

/** 默认：地面线段 [0,1000)，遮挡比例 [0.3,0.6]，采样步长 5，margin 0 */
function query(windows: WinInfo[], overrides: Partial<HideSpotQuery> = {}): HideSpotQuery {
  return {
    windows,
    support: {x0: 0, x1: 1000, y: FOOT_Y},
    box: boxAt,
    cover: [0.3, 0.6],
    stepPx: 5,
    margin: 0,
    ...overrides,
  };
}

test('findHideSpots：在窗口左边缘附近找到遮挡比例合适的点', () => {
  // 窗口底边 980 比脚底 1000 高一点；盒子纵向被盖住 180/200 = 0.9
  const w = makeWindow(10, rect(500, 700, 900, 980));
  // 线段只到 600，窗口右边缘（900）不在线段上，只留左边缘附近那一段
  const spots = findHideSpots(query([w], {support: {x0: 0, x1: 600, y: FOOT_Y}}));
  assert.equal(spots.length, 1);
  const s = spots[0];
  assert.equal(s.hwnd, 10);
  assert.equal(s.x, 500);
  assert.ok(Math.abs(s.cover - 0.45) < 1e-9, `cover=${s.cover}`);
  assert.ok(s.coverBySelf >= 0.1);
  assert.ok(Math.abs(s.coverBySelf - 0.45) < 1e-9, `coverBySelf=${s.coverBySelf}`);
});

test('findHideSpots：整段平手（窗口盖满线段）时取离 near 近的；没给 near 取 x 小的', () => {
  // 盖满线段的窗口：每个采样点 cover 都是 1，全部平手
  const w = makeWindow(10, rect(-100, 0, 1100, 1100));
  const q = query([w], {cover: [0.9, 1], margin: 20});
  assert.deepEqual(findHideSpots(q).map(s => s.x), [20]);                 // 以前的做法：线段最左端
  assert.deepEqual(findHideSpots({...q, near: 612}).map(s => s.x), [610]); // 采样点 20, 25, …，离 612 最近的是 610
  assert.deepEqual(findHideSpots({...q, near: 5000}).map(s => s.x), [980]); // 在线段外：取最近的端点
});

test('findHideSpots：置顶窗口默认不能躲', () => {
  const w = makeWindow(10, rect(500, 700, 900, 980), {topmost: true});
  const support = {x0: 0, x1: 600, y: FOOT_Y};
  assert.deepEqual(findHideSpots(query([w], {support})), []);
  // 显式 eligible 放行时还是能找到
  assert.equal(findHideSpots(query([w], {support, eligible: () => true})).length, 1);
});

test('findHideSpots：更高的窗口把那块完全盖住时 cover 变大（可能超出 hi）', () => {
  const w = makeWindow(10, rect(500, 700, 900, 980));
  // 盖住整个包围盒（横向全宽、纵向 800..1000），置顶所以自己不能躲，但会挡住 W
  const above = makeWindow(11, rect(0, 700, 1200, 1020), {topmost: true});
  const support = {x0: 0, x1: 600, y: FOOT_Y};

  assert.equal(findHideSpots(query([w], {support})).length, 1);
  // W 的 cover 从 0.45 变成 1，超出 hi=0.6 → 没有位置
  assert.deepEqual(findHideSpots(query([above, w], {support})), []);
  // 把区间放到 [0.95,1] 能看到 W 的 cover 已经是 1，而 coverBySelf 还是 W 自己的
  const spots = findHideSpots(query([above, w], {support, cover: [0.95, 1]}));
  assert.equal(spots.length, 1);
  assert.equal(spots[0].hwnd, 10);
  assert.equal(spots[0].cover, 1);
  assert.ok(spots[0].coverBySelf >= 0.1);
  // 没有 above 时 W 最多盖住 0.9，[0.95,1] 里没有点
  assert.deepEqual(findHideSpots(query([w], {support, cover: [0.95, 1]})), []);
});

test('findHideSpots：两个分开的窗口各出一段，平手按 z 序排', () => {
  // W1 的左边缘在线段外，右侧边缘落在 300；W2 的左边缘落在 700、右边缘在线段外
  const w1 = makeWindow(10, rect(-100, 700, 300, 980));
  const w2 = makeWindow(20, rect(700, 700, 1200, 980));
  const spots = findHideSpots(query([w1, w2]));
  assert.equal(spots.length, 2);
  assert.deepEqual(spots.map(s => s.hwnd), [10, 20]);
  assert.deepEqual(spots.map(s => s.x), [300, 700]);
  for (const s of spots) {
    assert.ok(Math.abs(s.cover - 0.45) < 1e-9, `cover=${s.cover}`);
    assert.ok(Math.abs(s.coverBySelf - 0.45) < 1e-9, `coverBySelf=${s.coverBySelf}`);
  }
});

test('findHideSpots：线段比 2 × margin 短时返回 []', () => {
  const w = makeWindow(10, rect(0, 700, 200, 980));
  assert.deepEqual(
    findHideSpots(query([w], {support: {x0: 0, x1: 100, y: FOOT_Y}, margin: 51})),
    [],
  );
  // 正好等于 2 × margin 时还剩一个点（边界不算“更短”）；这里盒子被盖住 0.9
  const spots = findHideSpots(query([w], {
    support: {x0: 0, x1: 100, y: FOOT_Y}, margin: 50, stepPx: 10, cover: [0.8, 1],
  }));
  assert.equal(spots.length, 1);
  assert.equal(spots[0].x, 50);
});

test('findHideSpots：终点不在步长上也会采样', () => {
  const w = makeWindow(10, rect(101, 700, 500, 980));
  const spots = findHideSpots(query([w], {
    support: {x0: 0, x1: 103, y: FOOT_Y},
    cover: [0.5, 0.6],
    stepPx: 10,
  }));
  // 步长 10 只到 100（cover 0.405，不够）；终点 103 才满足（cover 0.54）
  assert.equal(spots.length, 1);
  assert.equal(spots[0].x, 103);
  assert.ok(Math.abs(spots[0].cover - 0.54) < 1e-9, `cover=${spots[0].cover}`);
});

test('findHideSpots：每段取最接近 prefer 的采样点', () => {
  const w = makeWindow(10, rect(500, 700, 900, 980));
  // 满足 [0.3,0.8] 的采样：x=500 (cover 0.45)、x=505 (cover 0.675)；prefer 0.7 取后者
  const spots = findHideSpots(query([w], {
    support: {x0: 0, x1: 600, y: FOOT_Y}, cover: [0.3, 0.8], prefer: 0.7,
  }));
  assert.equal(spots.length, 1);
  assert.equal(spots[0].x, 505);
  assert.ok(Math.abs(spots[0].cover - 0.675) < 1e-9, `cover=${spots[0].cover}`);
});

test('findHideSpots：50 个窗口、4000 px、step 4 的用时按窗口数线性增长（比小规模，不卡墙钟）', () => {
  // 审查 E1（2026-10-22）：以前直接卡“50 ms”，机器忙（比如同时在导出）时随机失败。
  // 改成相对：同一段 x 范围（采样点数一样），窗口数从 5 到 50（10 倍）——线性约 10 倍，退化成平方会到 30 倍以上。
  // 两边各量多次取最快的一次（机器忙时最快的那批最接近真实成本，比取比值稳定），上限 20 倍（线性 10 倍留 2 倍余量）。
  // 另留一个 300 ms 的绝对兜底，防“常数变慢几十倍”但比例没变的情况。
  const windowsOf = (n: number): WinInfo[] => {
    const list: WinInfo[] = [];
    for (let i = 0; i < n; i++) {
      const left = i * (4000 / n);
      list.push(makeWindow(100 + i, rect(left, 600 + (i % 5) * 20, left + 200, 980)));
    }
    return list;
  };
  const q = (n: number) => query(windowsOf(n), {support: {x0: 0, x1: 4000, y: FOOT_Y}, cover: [0.2, 0.8], stepPx: 4});
  const small = q(5);
  const big = q(50);
  assert.ok(findHideSpots(small).length > 0);
  const spots = findHideSpots(big);
  assert.ok(spots.length > 0);

  const timeOf = (x: HideSpotQuery, inner = 1): number => {
    const t0 = performance.now();
    for (let i = 0; i < inner; i++) findHideSpots(x);
    return (performance.now() - t0) / inner;
  };
  const minMs = (x: HideSpotQuery, inner: number, reps: number): number => {
    let best = Infinity;
    for (let i = 0; i < reps; i++) best = Math.min(best, timeOf(x, inner));
    return best;
  };
  timeOf(small); timeOf(big); // 预热，别把 JIT 算进时间
  // 小规模一次不到 1 毫秒，一批 10 次再平均，噪声小；两边都取多次里最快的一批（机器忙时最快的那批最接近真实成本）
  const smallMs = minMs(small, 10, 5);
  const bigMs = minMs(big, 1, 6);
  assert.ok(bigMs <= smallMs * 20, `50 个窗口比 5 个窗口慢 ${(bigMs / smallMs).toFixed(1)} 倍（线性约 10 倍，上限 20 倍）`);
  assert.ok(bigMs < 300, `findHideSpots 用时 ${bigMs.toFixed(1)} ms（绝对上限 300 ms）`);
});
