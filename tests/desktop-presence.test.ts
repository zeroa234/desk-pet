// 哪些角色在桌面上（2026-10-22 用户：可以自选场景内角色；src/main/sim.ts setAbsent / despawn，托盘“在桌面上”、设置 onDesktop，tests/settings.test.ts）：
// 关掉的离开桌面（双人拆掉、对方收尾），别人看它 present = false、不会邀请它；解锁了也不掉下来；再打开从第一个显示器顶上掉下来。
// 用假角色包 / 假场景（tests/helpers/fake-scene.ts），时间按 1/30 秒推进，rng 固定种子。
import test from 'node:test';
import assert from 'node:assert/strict';

import type {SimEvent} from '../src/main/sim.ts';
import {drive, makeDuo} from './helpers/fake-scene.ts';

test('关掉的角色离开桌面：actor 没了、记 desktop 事件，别人看它不在场；再打开从顶上掉下来', () => {
  const fx = makeDuo(), sim = fx.sim, d = drive(sim);
  sim.setAbsent(['b']);
  assert.equal(sim.charOf('b')!.actor, null);
  assert.ok(sim.isAbsent('b'));
  d.frames(2);
  assert.ok(d.log.some(l => l.id === 'b' && l.e.type === 'desktop' && (l.e as Extract<SimEvent, {type: 'desktop'}>).present === false));
  assert.equal(sim.view(sim.charOf('a')!).others.b.present, false);
  // a 欲望 90、只会找 b 做：b 不在，一直邀请不到
  d.frames(300);
  assert.equal(sim.duos.length, 0);
  sim.setAbsent([]);
  const b = sim.charOf('b')!.actor;
  assert.ok(b, '重新打开就出现');
  assert.equal(b!.y, fx.display.bounds.top, '从显示器顶上掉下来');
  assert.equal(b!.state, 'fall');
});

test('双人进行中把一方关掉：拆掉双人，另一方收尾', () => {
  const fx = makeDuo(), sim = fx.sim, d = drive(sim);
  d.until(e => e.type === 'duo' && e.what === 'invite', '邀请', 60);
  assert.equal(sim.duos.length, 1);
  sim.setAbsent(['b']);
  assert.equal(sim.duos.length, 0);
  assert.equal(sim.charOf('b')!.actor, null);
  assert.ok(sim.charOf('a')!.actor, 'a 还在');
});

test('不在桌面上的角色解锁时只解锁、不出现', () => {
  const fx = makeDuo(), sim = fx.sim;
  sim.setAbsent(['b']);
  sim.unlocked.splice(sim.unlocked.indexOf('b'), 1);   // 当它还没解锁
  sim.unlockAll();
  assert.ok(sim.unlocked.includes('b'));
  assert.equal(sim.charOf('b')!.actor, null);
});
