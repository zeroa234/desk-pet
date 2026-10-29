// 台词解析 / 清洗的业务边界（阶段 3）。
// 只测调用方依赖的行为：错误分类、白名单、阶段覆盖、思考不泄漏、整句丢弃、去重、截断。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanLine, DialogueError, parseDialogue} from '../src/llm/dialogue.ts';
import type {CleanLineContext, DialogueContext} from '../src/llm/dialogue.ts';

const CTX: DialogueContext = {
  v: 12,
  plan: 'duo#7',
  speakers: ['witch', 'silent'],
  phases: ['start', 'loop', 'end'],
};

test('a provider refusal wrapped in valid dialogue JSON is still a refusal',()=>{
  const ctx={v:1,plan:'p1',speakers:['a'],phases:['say']};
  assert.throws(()=>parseDialogue(JSON.stringify({v:1,plan:'p1',lines:[{speaker:'a',phase:'say',text:'抱歉，我无法生成这类内容。'}]}),ctx),e=>e instanceof DialogueError&&e.code==='refusal');
  assert.equal(parseDialogue(JSON.stringify({v:1,plan:'p1',lines:[{speaker:'a',phase:'say',text:'我不能飞。'}]}),ctx).lines[0].text,'我不能飞。');
});

test('ordinary character refusals remain dialogue, but addressing the speaker by their own id is invalid',()=>{
  const ctx={v:1,plan:'p1',speakers:['a'],phases:['say'],audience:['user','self','b']};
  for(const text of ['我不能告诉你呢。','我不能帮你。','我不能继续了。','我不能这么做。','对不起，我不能继续了。','抱歉，我不能帮你。']){
    assert.equal(parseDialogue(JSON.stringify({v:1,plan:'p1',lines:[{speaker:'a',phase:'say',to:'user',text}]}),ctx).lines[0].text,text);
  }
  assert.throws(()=>parseDialogue(JSON.stringify({v:1,plan:'p1',lines:[{speaker:'a',phase:'say',to:'a',text:'你好。'}]}),ctx),e=>e instanceof DialogueError&&e.code==='invalid');
});

function errorCode(run: () => unknown): string {
  try {
    run();
    return 'no-error';
  } catch (error) {
    return error instanceof DialogueError ? error.code : `wrong-error:${String(error)}`;
  }
}

function payload(lines: Record<string, unknown>[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({v: CTX.v, plan: CTX.plan, lines, ...overrides});
}

function line(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {speaker: 'witch', phase: 'start', text: '嗯。', ...overrides};
}

function cleanCtx(overrides: Partial<CleanLineContext> = {}): CleanLineContext {
  return {banned: [], absentNames: [], recent: [], ...overrides};
}

test('parseDialogue：双人每阶段至少一句即可，不要求每个人都说话', () => {
  const dialogue = parseDialogue(payload([
    line({phase: 'start', text: '你来了。', to: 'silent'}),
    line({speaker: 'silent', phase: 'loop', text: '嗯。'}),
    line({phase: 'end', text: '结束了。'}),
  ]), CTX);

  assert.equal(dialogue.v, 12);
  assert.equal(dialogue.plan, 'duo#7');
  assert.deepEqual(dialogue.lines.map(item => `${item.speaker}:${item.phase}:${item.text}`), [
    'witch:start:你来了。',
    'silent:loop:嗯。',
    'witch:end:结束了。',
  ]);
  assert.equal(dialogue.lines[0]?.to, 'silent');
});

test('parseDialogue：接受整体 fenced JSON，拒绝前后夹带说明', () => {
  const body = payload([
    line({phase: 'start'}),
    line({phase: 'loop'}),
    line({phase: 'end'}),
  ]);
  assert.equal(parseDialogue('```json\n' + body + '\n```', CTX).lines.length, 3);
  assert.equal(parseDialogue('```\n' + body + '\n```', CTX).lines.length, 3);

  const wrapped = 'Here is the dialogue:\n```json\n' + body + '\n```';
  assert.equal(errorCode(() => parseDialogue(wrapped, CTX)), 'bad-json');
  const wrongLanguage = '```javascript\n' + body + '\n```';
  assert.equal(errorCode(() => parseDialogue(wrongLanguage, CTX)), 'bad-json');
});

test('parseDialogue：坏 JSON 是 bad-json，不是 invalid', () => {
  assert.equal(errorCode(() => parseDialogue('{v: 12, plan: "duo#7", lines: []}', CTX)), 'bad-json');
  assert.equal(errorCode(() => parseDialogue('', CTX)), 'bad-json');
});

test('parseDialogue：版本或计划实例对不上是 stale（同名动作的新实例也不能复用）', () => {
  const lines = [line({phase: 'start'}), line({phase: 'loop'}), line({phase: 'end'})];
  assert.equal(errorCode(() => parseDialogue(payload(lines, {v: 11}), CTX)), 'stale');
  assert.equal(errorCode(() => parseDialogue(payload(lines, {plan: 'duo#6'}), CTX)), 'stale');
  // 版本类型不对是 invalid，不能伪装成 stale。
  assert.equal(errorCode(() => parseDialogue(payload(lines, {v: '12'}), CTX)), 'invalid');
});

test('parseDialogue：说话人、to、阶段、字段类型都在白名单内', () => {
  assert.equal(errorCode(() => parseDialogue(payload([
    line({speaker: 'user'}), line({phase: 'loop'}), line({phase: 'end'}),
  ]), CTX)), 'invalid');

  assert.equal(errorCode(() => parseDialogue(payload([
    line({to: 'user'}), line({phase: 'loop'}), line({phase: 'end'}),
  ]), CTX)), 'invalid');

  assert.equal(errorCode(() => parseDialogue(payload([
    line({phase: 'middle'}), line({phase: 'loop'}), line({phase: 'end'}),
  ]), CTX)), 'invalid');

  assert.equal(errorCode(() => parseDialogue(payload([
    line({text: 123}), line({phase: 'loop'}), line({phase: 'end'}),
  ]), CTX)), 'invalid');

  assert.equal(errorCode(() => parseDialogue(payload([
    line({to: 42}), line({phase: 'loop'}), line({phase: 'end'}),
  ]), CTX)), 'invalid');
});

test('parseDialogue：漏阶段、空台词、0 句、超过 32 句都拒绝', () => {
  assert.equal(errorCode(() => parseDialogue(payload([
    line({phase: 'start'}), line({phase: 'loop'}),
  ]), CTX)), 'invalid');

  assert.equal(errorCode(() => parseDialogue(payload([
    line({phase: 'start', text: '   '}), line({phase: 'loop'}), line({phase: 'end'}),
  ]), CTX)), 'invalid');

  assert.equal(errorCode(() => parseDialogue(payload([]), CTX)), 'invalid');

  const phases = ['start', 'loop', 'end'];
  const lines32 = Array.from({length: 32}, (_, index) => line({phase: phases[index % 3], text: `第${index}句。`}));
  assert.equal(parseDialogue(payload(lines32), CTX).lines.length, 32);

  const lines33 = [...lines32, line({phase: 'end', text: '多出来的一句。'})];
  assert.equal(errorCode(() => parseDialogue(payload(lines33), CTX)), 'invalid');
});

test('parseDialogue：每句 text 最多 500 个字符', () => {
  assert.equal(parseDialogue(payload([
    line({phase: 'start', text: '字'.repeat(500)}),
    line({phase: 'loop'}),
    line({phase: 'end'}),
  ]), CTX).lines.length, 3);

  assert.equal(errorCode(() => parseDialogue(payload([
    line({phase: 'start', text: '字'.repeat(501)}),
    line({phase: 'loop'}),
    line({phase: 'end'}),
  ]), CTX)), 'invalid');
});

test('parseDialogue：拒答识别要准，普通台词“我不能飞”照常通过', () => {
  // 角色在 JSON 里说自己不会飞，不是模型拒答。
  const ordinary = parseDialogue(payload([
    line({phase: 'start', text: '我不能飞。'}),
    line({phase: 'loop'}),
    line({phase: 'end'}),
  ]), CTX);
  assert.equal(ordinary.lines[0]?.text, '我不能飞。');

  // 不是 JSON 的普通句子也不能被误判成拒答。
  assert.equal(errorCode(() => parseDialogue('我不能飞。', CTX)), 'bad-json');
  assert.equal(errorCode(() => parseDialogue('抱歉，我不能飞。', CTX)), 'bad-json');

  assert.equal(errorCode(() => parseDialogue('抱歉，我不能提供这类内容。', CTX)), 'refusal');
  assert.equal(errorCode(() => parseDialogue("I'm sorry, but I can't help with that.", CTX)), 'refusal');
  assert.equal(errorCode(() => parseDialogue(JSON.stringify({error: "I can't assist with this request."}), CTX)), 'refusal');
  assert.equal(errorCode(() => parseDialogue('```\nI cannot comply with that request.\n```', CTX)), 'refusal');
});

test('cleanLine：封闭和未闭合的思考块都不把内容漏进正文', () => {
  assert.deepEqual(cleanLine('<thinking>秘密计划</thinking>你好', cleanCtx()), {text: '你好', aside: []});
  assert.deepEqual(cleanLine('[THINK]秘密计划[/THINK]你好', cleanCtx()), {text: '你好', aside: []});
  // 未闭合：连后面看起来像台词的部分一起丢掉，避免把思考当台词。
  assert.deepEqual(cleanLine('你好<reasoning>还在想（不能让人看见）', cleanCtx()), {text: '你好', aside: []});
  assert.equal(cleanLine('<thinking>只有思考，没有台词', cleanCtx()), null);
});

test('cleanLine：思考里的禁用词不参与命中，正文和 aside 里的要拦', () => {
  assert.deepEqual(
    cleanLine('<thinking>禁词</thinking>你好', cleanCtx({banned: ['禁词']})),
    {text: '你好', aside: []},
  );
  assert.equal(cleanLine('我可是禁词哦', cleanCtx({banned: ['禁词']})), null);
  assert.equal(cleanLine('I am a FUTA', cleanCtx({banned: ['futa']})), null);
  assert.equal(cleanLine('你好（禁词）', cleanCtx({banned: ['禁词']})), null);
});

test('cleanLine：圆括号和星号舞台说明抽到 aside，不留在台词里', () => {
  assert.deepEqual(cleanLine('你来了（气音）…… *轻笑*', cleanCtx()), {
    text: '你来了……',
    aside: ['气音', '轻笑'],
  });
  assert.deepEqual(cleanLine('（靠近）Hello (softly) *sigh*', cleanCtx()), {
    text: 'Hello',
    aside: ['靠近', 'softly', 'sigh'],
  });
  // 只有舞台说明、没有可说的正文时整句不用。
  assert.equal(cleanLine('（只做了个手势）', cleanCtx()), null);
});

test('cleanLine：不在场的角色名命中整句丢弃，短英文名按词边界匹配', () => {
  assert.equal(cleanLine('魔法师在看我', cleanCtx({absentNames: ['魔法师']})), null);
  assert.equal(cleanLine('（看向魔法师）你好', cleanCtx({absentNames: ['魔法师']})), null);
  assert.equal(cleanLine('Al is here.', cleanCtx({absentNames: ['Al']})), null);
  // “Al” 不该命中 “Also”。
  assert.deepEqual(cleanLine('Also fine.', cleanCtx({absentNames: ['Al']})), {text: 'Also fine.', aside: []});
});

test('cleanLine：普通“我不能飞”不是拒答，也不会被清洗器丢掉', () => {
  assert.deepEqual(cleanLine('我不能飞。', cleanCtx()), {text: '我不能飞。', aside: []});
});

test('cleanLine：默认 40 个 Unicode 字符，尽量在句末截断', () => {
  const long = cleanLine('啊'.repeat(41), cleanCtx());
  assert.ok(long);
  assert.equal(Array.from(long.text).length, 40);

  const sentence = cleanLine('第一句。' + '二'.repeat(60), cleanCtx({maxChars: 20}));
  assert.ok(sentence);
  assert.equal(sentence.text, '第一句。');

  const noStop = cleanLine('啊'.repeat(50), cleanCtx({maxChars: 7}));
  assert.ok(noStop);
  assert.equal(Array.from(noStop.text).length, 7);
});

test('cleanLine：近期 20 句按规范化文本去重', () => {
  assert.equal(cleanLine('你好', cleanCtx({recent: ['你好！']})), null);
  assert.equal(cleanLine('你好', cleanCtx({recent: [' 你 好 ']})), null);
  // 不一样的内容照常通过。
  assert.deepEqual(cleanLine('你好呀', cleanCtx({recent: ['你好']})), {text: '你好呀', aside: []});

  // 只比较最近 20 句：列表最前面的旧句已经不在窗口里。
  const outsideWindow = ['重复', ...Array.from({length: 20}, (_, index) => `第${index}句`)];
  assert.deepEqual(cleanLine('重复', cleanCtx({recent: outsideWindow})), {text: '重复', aside: []});

  const insideWindow = [...Array.from({length: 19}, (_, index) => `第${index}句`), '重复'];
  assert.equal(cleanLine('重复！', cleanCtx({recent: insideWindow})), null);

  // 先截断再去重：recent 里存的是上次真正显示出来的 40 字，当前长句截成
  // 同样的 40 字时也要丢掉。
  const longDisplayed = '同'.repeat(40);
  const longNext = '同'.repeat(50) + '乙';
  assert.equal(cleanLine(longNext, cleanCtx({recent: [longDisplayed]})), null);
});

test('cleanLine：空白、控制字符和空输入', () => {
  assert.equal(cleanLine('   ', cleanCtx()), null);
  assert.equal(cleanLine('\u200B\u200B', cleanCtx()), null);
  assert.deepEqual(cleanLine('  你\u200B  好  ', cleanCtx()), {text: '你 好', aside: []});
});

test('parseDialogue：want 原样取出（合并空白、限长），空 / 没写 / 不是字符串 / 像拒答都只当没有，不连累台词',()=>{
  const ctx={v:1,plan:'p1',speakers:['a'],phases:['say'],optionalPhases:true};
  const reply=(want:unknown)=>JSON.stringify({v:1,plan:'p1',lines:[{speaker:'a',phase:'say',text:'才没有呢。'}],...(want===undefined?{}:{want})});
  const d=parseDialogue(reply('  其实\n想让你再摸摸头  '),ctx);
  assert.equal(d.want,'其实 想让你再摸摸头');assert.deepEqual(d.lines.map(l=>l.text),['才没有呢。']);
  assert.equal(Array.from(parseDialogue(reply('想'.repeat(100)),ctx).want!).length,60);
  for(const w of [undefined,'','   ',3,{x:1},'抱歉，我无法生成这类内容。']){
    const x=parseDialogue(reply(w),ctx);assert.equal(x.want,undefined,String(w));assert.equal(x.lines.length,1);
  }
});
