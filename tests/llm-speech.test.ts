// 说话音效单元和全局说话队列的业务边界（阶段 3）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_VOICE, SpeechQueue, textToUnits} from '../src/llm/speech.ts';
import type {SpeechTicket} from '../src/llm/types.ts';

function ticket(overrides: Partial<SpeechTicket> = {}): SpeechTicket {
  return {
    speaker: 'witch',
    text: '嗯。',
    aside: [],
    binding: {id: 'plan-a', epoch: 1, plan: 'idle', action: 'idle', phase: null},
    expiresAt: 10_000,
    priority: 0,
    ...overrides,
  };
}

test('SpeechQueue：一次 next 只出一条，按优先级出队', () => {
  const queue = new SpeechQueue();
  queue.enqueue(ticket({text: '低', priority: 1}));
  queue.enqueue(ticket({text: '高', priority: 9}));
  queue.enqueue(ticket({text: '中', priority: 5}));
  assert.equal(queue.size, 3);

  assert.equal(queue.next(0, () => true)?.text, '高');
  assert.equal(queue.size, 2);
  assert.equal(queue.next(0, () => true)?.text, '中');
  assert.equal(queue.next(0, () => true)?.text, '低');
  assert.equal(queue.next(0, () => true), null);
  assert.equal(queue.size, 0);
});

test('SpeechQueue：同优先级按入队顺序，不插队', () => {
  const queue = new SpeechQueue();
  queue.enqueue(ticket({text: '第一'}));
  queue.enqueue(ticket({text: '第二'}));
  queue.enqueue(ticket({text: '第三'}));
  assert.deepEqual(
    [queue.next(0, () => true)?.text, queue.next(0, () => true)?.text, queue.next(0, () => true)?.text],
    ['第一', '第二', '第三'],
  );
});

test('SpeechQueue：过期票直接丢掉，不挡后面的票', () => {
  const queue = new SpeechQueue();
  queue.enqueue(ticket({text: '过期', priority: 9, expiresAt: 100}));
  queue.enqueue(ticket({text: '有效', priority: 1, expiresAt: 101}));

  assert.equal(queue.next(100, () => true)?.text, '有效');
  assert.equal(queue.size, 0);

  const expiredOnly = new SpeechQueue();
  expiredOnly.enqueue(ticket({text: '过期', expiresAt: 500}));
  assert.equal(expiredOnly.next(500, () => true), null);
  assert.equal(expiredOnly.size, 0);
});

test('SpeechQueue：valid 校验实例和阶段，同名动作的旧绑定不能播', () => {
  const queue = new SpeechQueue();
  const oldInstance = ticket({
    text: '旧计划',
    priority: 9,
    binding: {id: 'plan-a', epoch: 1, plan: 'idle', action: 'idle', phase: 'start'},
  });
  const newInstance = ticket({
    text: '新计划',
    priority: 1,
    binding: {id: 'plan-a', epoch: 2, plan: 'idle', action: 'idle', phase: 'start'},
  });
  queue.enqueue(oldInstance);
  queue.enqueue(newInstance);

  // 动作名一样，但 epoch 不同：第一条无效，应当删除并继续找下一条。
  const picked = queue.next(0, item => item.binding.epoch === 2 && item.binding.phase === 'start');
  assert.equal(picked?.text, '新计划');
  assert.equal(queue.size, 0);

  const wrongPhase = new SpeechQueue();
  wrongPhase.enqueue(ticket({text: '阶段不对', binding: {id: 'x', epoch: 1, plan: 'p', action: 'a', phase: 'end'}}));
  assert.equal(wrongPhase.next(0, item => item.binding.phase === 'start'), null);
  assert.equal(wrongPhase.size, 0);
});

test('SpeechQueue：clear 只取消指定角色未开始的台词，clear() 清空全部', () => {
  const queue = new SpeechQueue();
  queue.enqueue(ticket({speaker: 'witch', text: 'dmg1'}));
  queue.enqueue(ticket({speaker: 'silent', text: 'silent1'}));
  queue.enqueue(ticket({speaker: 'witch', text: 'dmg2'}));

  queue.clear('witch');
  assert.equal(queue.size, 1);
  assert.equal(queue.next(0, () => true)?.text, 'silent1');
  assert.equal(queue.size, 0);

  queue.enqueue(ticket({speaker: 'witch'}));
  queue.enqueue(ticket({speaker: 'silent'}));
  queue.clear();
  assert.equal(queue.size, 0);
  assert.equal(queue.next(0, () => true), null);
});

test('SpeechQueue：最多 64 条，满了淘汰优先级最低的', () => {
  const queue = new SpeechQueue();
  for (let priority = 0; priority < 70; priority++) {
    queue.enqueue(ticket({text: `票${priority}`, priority}));
  }
  assert.ok(queue.size <= 64);
  assert.equal(queue.size, 64);

  const first = queue.next(0, () => true);
  assert.equal(first?.text, '票69');
});

function assertMonotonic(units: ReturnType<typeof textToUnits>): void {
  let expectedAt = 0;
  for (const unit of units) {
    assert.equal(unit.at, expectedAt);
    assert.ok(Number.isFinite(unit.duration) && unit.duration > 0);
    assert.ok(Number.isFinite(unit.pitch) && unit.pitch > 0);
    expectedAt += unit.duration;
  }
  assert.ok(expectedAt <= 15 + 1e-9, `总时长 ${expectedAt} 超过上限`);
}

test('textToUnits：空文本不出单元', () => {
  assert.deepEqual(textToUnits(''), []);
  assert.deepEqual(textToUnits('   '), []);
});

test('textToUnits：中文一个汉字一个音节，at 累加单调，韵母给出共振峰', () => {
  const units = textToUnits('你好世界');
  assert.equal(units.length, 4);
  assert.equal(units.map(unit => unit.text).join(''), '你好世界');
  assertMonotonic(units);
  assert.ok(units[0]!.at === 0);
  for (const unit of units) {
    assert.ok(unit.formants);
    assert.ok(unit.formants[0]! > 0 && unit.formants[1]! > unit.formants[0]!);
    assert.ok(unit.formants[2]! > unit.formants[1]!);
  }
});

test('textToUnits：四声变成不同且合理的音高（三声低、一/四声高）', () => {
  const units = textToUnits('妈麻马骂');
  assert.deepEqual(units.map(unit => unit.text), ['妈', '麻', '马', '骂']);
  const [first, second, third, fourth] = units.map(unit => unit.pitch);
  assert.ok(first! > second! && second! > third!, '一声 > 二声 > 三声');
  assert.ok(fourth! > third!, '四声的起点/平均值高于三声');
  assert.equal(new Set(units.map(unit => unit.pitch)).size, 4);
});

test('textToUnits：标点占停顿时间，句号比逗号长，逗号比汉字长', () => {
  const plain = textToUnits('好');
  const comma = textToUnits('好，好');
  const stop = textToUnits('好。');
  assert.equal(comma.length, 3);
  assert.equal(stop.length, 2);
  assert.ok(comma[1]!.duration > plain[0]!.duration);
  assert.ok(stop[1]!.duration > comma[1]!.duration);
  assert.equal(comma[1]!.formants, null);
});

test('textToUnits：英文按字母，元音有共振峰、辅音没有', () => {
  const units = textToUnits('Hi');
  assert.deepEqual(units.map(unit => unit.text), ['H', 'i']);
  assert.equal(units[0]!.formants, null);
  assert.ok(units[1]!.formants);
  assertMonotonic(units);

  const mixed = textToUnits('好a');
  assert.equal(mixed.length, 2);
  assert.ok(mixed[0]!.formants);
  assert.ok(mixed[1]!.formants);
});

test('textToUnits：voice 的语速、音高生效，共振峰留给 renderer 缩放', () => {
  const normal = textToUnits('你好');
  const fast = textToUnits('你好', {speed: 2});
  assert.ok(Math.abs(fast[0]!.duration - normal[0]!.duration / 2) < 1e-9);
  assert.ok(Math.abs(fast[1]!.duration - normal[1]!.duration / 2) < 1e-9);

  const normalTone = textToUnits('妈')[0]!;
  const higher = textToUnits('妈', {pitch: 440})[0]!;
  assert.ok(Math.abs(higher.pitch / normalTone.pitch - 2) < 1e-9);

  // 共振峰由 renderer 用 SpeechVoice.formantScale 缩放；这里始终给基频表，避免缩放两次。
  const wide = textToUnits('妈', {formantScale: 2})[0]!;
  assert.deepEqual(wide.formants, normalTone.formants);
});

test('textToUnits：超长输入和超慢语速也不会产生无界时长', () => {
  const units = textToUnits('你'.repeat(5000));
  assert.ok(units.length > 0 && units.length <= 128);
  assertMonotonic(units);
  const last = units.at(-1)!;
  assert.ok(last.at + last.duration <= 15 + 1e-9);
});

test('textToUnits：同样输入同样声音，结果确定', () => {
  const a = textToUnits('你好，world！', {pitch: 1.2, speed: 1.1});
  const b = textToUnits('你好，world！', {pitch: 1.2, speed: 1.1});
  assert.deepEqual(a, b);
});

test('DEFAULT_VOICE 是可直接使用的完整声音参数', () => {
  assert.ok(DEFAULT_VOICE.pitch >= 60 && DEFAULT_VOICE.pitch <= 600);
  assert.ok(DEFAULT_VOICE.speed > 0);
  assert.ok(DEFAULT_VOICE.formantScale > 0);
  assert.ok(DEFAULT_VOICE.breath >= 0 && DEFAULT_VOICE.breath <= 1);
});
