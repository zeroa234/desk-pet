// LLM 适配层（src/llm/providers.ts）的单测。只用注入的 fetcher 和内存里的 Response，不联网、不读 key、不写文件。
// 覆盖：Chat Completions 的路径 / 请求体 / JSON 模式 / usage（缓存未知 vs 0）/ reasoning 不进正文 / 拒答 / content_filter /
// length 空正文 / 坏 JSON / HTTP 错误与重试 / body 不泄露 / 200 坏 JSON 不重试 / 超时与调用方取消 / URL 校验；
// Clef System One 的 state + questions 原生协议、choice / noul / score 校验、候选上限、usage、路径、本机 HTTP。
//
// 2026-10-22：审查时注意到一处 src 风险：
//   baseUrl 解析不出主机名时（如 "https://"）会被拼成 "https://chat/completions"，把 Bearer key 发到别的域名；
//   缺 scheme（"api.example.test/v1"）直接抛 TypeError。并行修改已经修掉（正则 + new URL + pathname），下面保留回归测试。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChatCompletions, ClefProvider, LlmFailure, type Fetcher, type Question} from '../src/llm/providers.ts';
import type {ProviderConfig} from '../src/llm/types.ts';

const encode = (s: string) => new TextEncoder().encode(s);
interface Call { url: string; init: RequestInit }
type Handler = (call: Call) => Response | Promise<Response>;

function recorder(handler: Handler) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {url: String(input), init: init ?? {}};
    calls.push(call);
    return handler(call);
  }) as Fetcher;
  return {calls, fetcher};
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
const textResponse = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, {status, headers});

/** 一个读到第二下才结束的响应体：记下被 pull / cancel 的次数，超限 / 读一半取消的用例用它。 */
function openResponse(body: string, status: number, headers: Record<string, string> = {}) {
  const stats = {reads: 0, cancels: 0};
  let sent = false;
  const res = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      stats.reads++;
      if (!sent) { sent = true; controller.enqueue(encode(body)); return; }
      // 第二下才关：被测代码读到一半就 cancel 时 cancel 回调仍会触发，代码若写错也不会永久挂住
      controller.close();
    },
    cancel() { stats.cancels++; },
  }, {highWaterMark: 0}), {status, headers}); // highWaterMark 0：避免 stream 预取第二下、先 close 掉，cancel 回调就不触发了
  return {res, stats};
}

/** 非 200 的响应：body 里带着 secret，但只允许 cancel；getReader 一旦被调用就记下来（错误响应体不应该被读）。 */
function guardedErrorResponse(secret: string, status: number, headers: Record<string, string> = {}) {
  const stats = {cancels: 0, readers: 0};
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(encode(secret)); controller.close(); },
    cancel() { stats.cancels++; },
  }, {highWaterMark: 0});
  const getReader = stream.getReader.bind(stream);
  Object.defineProperty(stream, 'getReader', {
    configurable: true,
    value: (options?: ReadableStreamGetReaderOptions) => {
      stats.readers++;
      return getReader(options);
    },
  });
  return {res: new Response(stream, {status, headers}), stats};
}

async function failure(p: Promise<unknown>): Promise<LlmFailure> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof LlmFailure, `应抛 LlmFailure，实际是 ${String(e)}`);
    return e;
  }
  assert.fail('应当失败，实际成功了');
}

const live = () => new AbortController().signal;

const CHAT: ProviderConfig = {
  baseUrl: 'https://api.example.test/v1', model: 'text-model', account: 'acct', keyEnv: 'TEST_KEY',
  secretName: 'test', concurrency: 1, jsonMode: 'none', cachedTokensField: null, timeoutMs: 5000,
};
const CLEF: ProviderConfig = {...CHAT, model: 'clef'};

const chatProvider = (fetcher: Fetcher, cfg: Partial<ProviderConfig> = {}, key = 'test-key') =>
  new ChatCompletions({...CHAT, ...cfg}, key, fetcher);
const clefProvider = (fetcher: Fetcher, cfg: Partial<ProviderConfig> = {}) =>
  new ClefProvider({...CLEF, ...cfg}, 'test-key', fetcher);

const CHAT_REQ = {system: '系统', user: '用户', maxTokens: 64};

interface ChatReplyOptions { message?: Record<string, unknown>; finish?: string; usage?: unknown; choices?: unknown }
const chatReply = (o: ChatReplyOptions = {}): Record<string, unknown> => ({
  choices: 'choices' in o ? o.choices : [{
    index: 0, message: {role: 'assistant', content: ' 你好 ', ...o.message}, finish_reason: o.finish ?? 'stop',
  }],
  usage: 'usage' in o ? o.usage : {prompt_tokens: 10, completion_tokens: 5},
});

async function chatFailure(body: unknown, cfg: Partial<ProviderConfig> = {}) {
  const {calls, fetcher} = recorder(() => jsonResponse(body));
  const err = await failure(chatProvider(fetcher, cfg).chat(CHAT_REQ, live()));
  return {err, calls};
}

// ---------------------------------------------------------------- Chat Completions

test('ChatCompletions：POST /chat/completions，Bearer、stream:false、默认 temperature 0.6，正文去首尾空白', async () => {
  const {calls, fetcher} = recorder(() => jsonResponse(chatReply()));
  const provider = chatProvider(fetcher);
  const r = await provider.chat(CHAT_REQ, live());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('authorization'), 'Bearer test-key');

  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, 'text-model');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 64);
  assert.equal(body.temperature, 0.6);
  assert.equal('response_format' in body, false, "jsonMode 'none' 不发 response_format");
  assert.deepEqual(body.messages, [{role: 'system', content: '系统'}, {role: 'user', content: '用户'}]);

  assert.equal(r.text, '你好');
  assert.equal(r.finishReason, 'stop');
  assert.ok(r.latencyMs >= 0);

  // temperature: 0 不能被 ?? 0.6 换掉
  await provider.chat({...CHAT_REQ, temperature: 0}, live());
  assert.equal(JSON.parse(String(calls[1].init.body)).temperature, 0);
});

test('ChatCompletions：json_object / json_schema / none 的 response_format 按配置和 schema 决定', async () => {
  const {calls, fetcher} = recorder(() => jsonResponse(chatReply()));
  const schema = {type: 'object', properties: {say: {type: 'string'}}, required: ['say'], additionalProperties: false};

  await chatProvider(fetcher, {jsonMode: 'json_object'}).chat(CHAT_REQ, live());
  assert.deepEqual(JSON.parse(String(calls[0].init.body)).response_format, {type: 'json_object'});

  await chatProvider(fetcher, {jsonMode: 'json_schema'}).chat({...CHAT_REQ, schema}, live());
  assert.deepEqual(JSON.parse(String(calls[1].init.body)).response_format,
    {type: 'json_schema', json_schema: {name: 'dialogue', strict: true, schema}});

  // 配了 json_schema 但这次没给 schema：不发 response_format（不擅自降成 json_object）
  await chatProvider(fetcher, {jsonMode: 'json_schema'}).chat(CHAT_REQ, live());
  assert.equal('response_format' in JSON.parse(String(calls[2].init.body)), false);

  await chatProvider(fetcher, {jsonMode: 'none'}).chat({...CHAT_REQ, schema}, live());
  assert.equal('response_format' in JSON.parse(String(calls[3].init.body)), false);
});

test('ChatCompletions usage：缓存未报告记 null、报告 0 记 0；token 数不合法整条 usage 为 null', async () => {
  const field = 'prompt_tokens_details.cached_tokens';
  const cases: {usage: unknown; field?: string | null; expected: unknown}[] = [
    {usage: {prompt_tokens: 10, completion_tokens: 4}, expected: {prompt: 10, cached: null, completion: 4, reasoning: null}},
    // 配置没写缓存字段：即使响应里有也不认（记未知，不冒充命中）
    {usage: {prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: {cached_tokens: 7}},
      expected: {prompt: 10, cached: null, completion: 4, reasoning: null}},
    // 有缓存字段但这次没报告：未知，不是 0
    {usage: {prompt_tokens: 10, completion_tokens: 4}, field, expected: {prompt: 10, cached: null, completion: 4, reasoning: null}},
    // 报告 0 就是 0
    {usage: {prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: {cached_tokens: 0},
      completion_tokens_details: {reasoning_tokens: 0}}, field,
    expected: {prompt: 10, cached: 0, completion: 4, reasoning: 0}},
    {usage: {prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: {cached_tokens: 7},
      completion_tokens_details: {reasoning_tokens: 2}}, field,
    expected: {prompt: 10, cached: 7, completion: 4, reasoning: 2}},
    // 缓存数比 prompt 大、思考数比 completion 大都当不可信
    {usage: {prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: {cached_tokens: 11}}, field,
      expected: {prompt: 10, cached: null, completion: 4, reasoning: null}},
    {usage: {prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: {reasoning_tokens: 5}}, field,
      expected: {prompt: 10, cached: null, completion: 4, reasoning: null}},
    // 计数必须是非负安全整数
    {usage: {prompt_tokens: 1.5, completion_tokens: 4}, expected: null},
    {usage: {prompt_tokens: -1, completion_tokens: 4}, expected: null},
    {usage: {prompt_tokens: '10', completion_tokens: 4}, expected: null},
    {usage: {prompt_tokens: 10}, expected: null},
    {usage: null, expected: null},
  ];
  for (const [i, c] of cases.entries()) {
    const {fetcher} = recorder(() => jsonResponse(chatReply({usage: c.usage})));
    const r = await chatProvider(fetcher, {cachedTokensField: c.field ?? null}).chat(CHAT_REQ, live());
    assert.deepEqual(r.usage, c.expected, `第 ${i} 个 usage 用例`);
    assert.equal(r.text, '你好');
  }
});

test('ChatCompletions：reasoning / reasoning_content 不当作正文；正文为空按 design 归到 refusal / empty-thinking', async () => {
  // 只有思考、正文空、finish stop：refusal（design §7.1：内容为空算拒答），且不能把思考内容带出来
  const onlyThinking = chatReply({
    message: {content: '', reasoning: 'THINK-SECRET-A', reasoning_content: 'THINK-SECRET-B'},
    finish: 'stop',
    usage: {prompt_tokens: 2, completion_tokens: 3, completion_tokens_details: {reasoning_tokens: 3}},
  });
  {
    const {err} = await chatFailure(onlyThinking);
    assert.equal(err.code, 'refusal');
    assert.deepEqual(err.usage, {prompt: 2, cached: null, completion: 3, reasoning: 3});
    const text = [String(err), err.stack ?? '', JSON.stringify(err)].join('\n');
    assert.ok(!text.includes('THINK-SECRET'), '思考内容不能进错误 / 日志');
  }
  // finish length + 正文空：思考耗尽
  {
    const {err} = await chatFailure(chatReply({
      message: {content: '   ', reasoning: 'THINK-SECRET-A'}, finish: 'length',
    }));
    assert.equal(err.code, 'empty-thinking');
    assert.ok(!String(err.stack).includes('THINK-SECRET-A'));
  }
  // 有正文也有思考：只返回正文
  {
    const {fetcher} = recorder(() => jsonResponse(chatReply({
      message: {content: '正文', reasoning: 'THINK-SECRET-A', reasoning_content: 'THINK-SECRET-B'},
    })));
    const r = await chatProvider(fetcher).chat(CHAT_REQ, live());
    assert.equal(r.text, '正文');
    assert.ok(!JSON.stringify(r).includes('THINK-SECRET'), '返回值里不能有 reasoning');
  }
});

test('ChatCompletions：refusal 字段 / content_filter 算拒答；length 空正文算思考耗尽，length 有正文照返回并带 finishReason', async () => {
  // message.refusal 为真，即使有正文也按拒答
  {
    const {err} = await chatFailure(chatReply({message: {refusal: 'no'}}));
    assert.equal(err.code, 'refusal');
  }
  // finish_reason=content_filter
  {
    const {err} = await chatFailure(chatReply({finish: 'content_filter'}));
    assert.equal(err.code, 'refusal');
  }
  // finish_reason=length 且正文空
  {
    const {err} = await chatFailure(chatReply({message: {content: ''}, finish: 'length'}));
    assert.equal(err.code, 'empty-thinking');
  }
  // finish_reason=stop 且正文空：design 把“内容为空”也算拒答
  {
    const {err} = await chatFailure(chatReply({message: {content: '   '}, finish: 'stop'}));
    assert.equal(err.code, 'refusal');
  }
  // length 但有正文：不丢这段，交给调用方按 finishReason 处理截断
  {
    const {fetcher} = recorder(() => jsonResponse(chatReply({message: {content: '半句'}, finish: 'length'})));
    const r = await chatProvider(fetcher).chat(CHAT_REQ, live());
    assert.equal(r.text, '半句');
    assert.equal(r.finishReason, 'length');
  }
});

test('ChatCompletions：choices / message 结构不对算 invalid，并带上已解析的 usage', async () => {
  const usage = {prompt_tokens: 3, completion_tokens: 2};
  const bodies = [
    chatReply({choices: undefined, usage}), // JSON.stringify 会丢掉 choices
    chatReply({choices: [], usage}),
    chatReply({choices: [{}], usage}),
    chatReply({choices: [{message: null, finish_reason: 'stop'}], usage}),
    chatReply({choices: [{message: 'x', finish_reason: 'stop'}], usage}),
  ];
  for (const body of bodies) {
    const {err} = await chatFailure(body);
    assert.equal(err.code, 'invalid');
    assert.deepEqual(err.usage, {prompt: 3, cached: null, completion: 2, reasoning: null});
  }
});

test('ChatCompletions：200 坏 JSON 不重试；JSON 不是对象算 invalid；都只请求一次', async () => {
  const cases: [string, string][] = [
    ['{oops', 'bad-json'],
    ['{"choices":', 'bad-json'],
    ['', 'bad-json'],
    ['null', 'invalid'],
    ['[]', 'invalid'],
    ['"text"', 'invalid'],
    ['42', 'invalid'],
  ];
  for (const [raw, code] of cases) {
    const {calls, fetcher} = recorder(() => textResponse(raw));
    const err = await failure(chatProvider(fetcher).chat(CHAT_REQ, live()));
    assert.equal(err.code, code, `响应体 ${JSON.stringify(raw)}`);
    assert.equal(calls.length, 1, '200 的坏响应不能重试（可能已经计费）');
  }
});

test('ChatCompletions：非 200 不泄露响应体；400 不重试；错误只有 http', async () => {
  const secret = 'BODY-SECRET-400';
  // body 里放着 secret；真去 getReader 会记下来
  const {res, stats} = guardedErrorResponse(secret, 400);
  const {calls, fetcher} = recorder(() => res);
  const err = await failure(chatProvider(fetcher).chat(CHAT_REQ, live()));

  assert.equal(err.code, 'http');
  assert.equal(err.message, 'http');
  assert.equal(err.usage, null);
  assert.equal(calls.length, 1);
  assert.equal(stats.cancels, 1, '错误响应体要取消，不能留着不关');
  assert.equal(stats.readers, 0, '错误响应体不能被读取');
  for (const s of [String(err), err.stack ?? '', JSON.stringify(err)]) {
    assert.ok(!s.includes(secret), '错误信息里不能出现响应体');
  }
});

test('ChatCompletions：429 / 5xx 按 Retry-After 退避重试，最多 4 次；重试耗尽只报 http 且不泄露 body', async () => {
  // 429 -> 200
  {
    let n = 0;
    const {calls, fetcher} = recorder(() => (++n === 1
      ? jsonResponse({error: 'slow down'}, 429, {'retry-after': '0'})
      : jsonResponse(chatReply())));
    const r = await chatProvider(fetcher).chat(CHAT_REQ, live());
    assert.equal(r.text, '你好');
    assert.equal(calls.length, 2);
  }
  // 500 -> 200
  {
    let n = 0;
    const {calls, fetcher} = recorder(() => (++n === 1
      ? jsonResponse({}, 503, {'retry-after': '0'})
      : jsonResponse(chatReply())));
    const r = await chatProvider(fetcher).chat(CHAT_REQ, live());
    assert.equal(r.text, '你好');
    assert.equal(calls.length, 2);
  }
  // Retry-After 用 HTTP 日期（过去的时间）也只等 0
  {
    let n = 0;
    const {calls, fetcher} = recorder(() => (++n === 1
      ? jsonResponse({}, 429, {'retry-after': new Date(Date.now() - 1000).toUTCString()})
      : jsonResponse(chatReply())));
    const r = await chatProvider(fetcher).chat(CHAT_REQ, live());
    assert.equal(r.text, '你好');
    assert.equal(calls.length, 2);
  }
  // 429 x4：首试 + 3 次重试，然后 http
  {
    const secret = 'BODY-SECRET-429';
    const seen: {cancels: number; readers: number}[] = [];
    const {calls, fetcher} = recorder(() => {
      const {res, stats} = guardedErrorResponse(secret, 429, {'retry-after': '0'});
      seen.push(stats);
      return res;
    });
    const err = await failure(chatProvider(fetcher).chat(CHAT_REQ, live()));
    assert.equal(err.code, 'http');
    assert.equal(calls.length, 4);
    assert.ok(seen.every(s => s.cancels === 1 && s.readers === 0), '每次错误响应体只能取消、不能读');
    assert.ok(!String(err).includes(secret));
  }
  // 429 后遇到 400：400 不重试
  {
    let n = 0;
    const {calls, fetcher} = recorder(() => (++n === 1
      ? jsonResponse({}, 429, {'retry-after': '0'})
      : jsonResponse({bad: true}, 400)));
    const err = await failure(chatProvider(fetcher).chat(CHAT_REQ, live()));
    assert.equal(err.code, 'http');
    assert.equal(calls.length, 2);
  }
});

test('ChatCompletions：超时 -> timeout；调用方取消 -> aborted；已取消的信号不发请求', async () => {
  const hang: Fetcher = (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal, '必须把 signal 传给 fetcher');
    const stop = () => reject(signal.reason);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, {once: true});
  });

  const timeout = await failure(chatProvider(hang, {timeoutMs: 20}).chat(CHAT_REQ, live()));
  assert.equal(timeout.code, 'timeout');

  const controller = new AbortController();
  const pending = chatProvider(hang, {timeoutMs: 5000}).chat(CHAT_REQ, controller.signal);
  setTimeout(() => controller.abort(), 5);
  assert.equal((await failure(pending)).code, 'aborted');

  const pre = new AbortController();
  pre.abort();
  const {calls, fetcher} = recorder(() => jsonResponse(chatReply()));
  assert.equal((await failure(chatProvider(fetcher).chat(CHAT_REQ, pre.signal))).code, 'aborted');
  assert.equal(calls.length, 0);
});

test('ChatCompletions：退避等待时调用方取消立即 aborted，不再发第二次', async () => {
  const {calls, fetcher} = recorder(() => jsonResponse({}, 429, {'retry-after': '30'}));
  const controller = new AbortController();
  const pending = chatProvider(fetcher).chat(CHAT_REQ, controller.signal);
  setTimeout(() => controller.abort(), 5);
  assert.equal((await failure(pending)).code, 'aborted');
  assert.equal(calls.length, 1);
});

test('ChatCompletions：baseUrl 只允许 https 或本机 http；拒绝凭据、查询、片段、远程明文和伪装的本机名', async () => {
  const {calls, fetcher} = recorder(() => jsonResponse(chatReply()));
  const bad = [
    'http://api.example.test/v1',
    'ftp://api.example.test/v1',
    'https://user:pass@api.example.test/v1',
    'https://api.example.test/v1?token=x',
    'https://api.example.test/v1#frag',
    'http://localhost.evil.test/v1',
  ];
  for (const baseUrl of bad) {
    const err = await failure(chatProvider(fetcher, {baseUrl}).chat(CHAT_REQ, live()));
    assert.equal(err.code, 'invalid', baseUrl);
  }
  assert.equal(calls.length, 0, 'URL 不合格时不能发请求');

  const good: [string, string][] = [
    ['http://localhost:11434/v1', 'http://localhost:11434/v1/chat/completions'],
    ['http://127.0.0.1:11434/v1/', 'http://127.0.0.1:11434/v1/chat/completions'],
    ['http://[::1]:11434/v1', 'http://[::1]:11434/v1/chat/completions'],
    ['https://api.example.test/v1/', 'https://api.example.test/v1/chat/completions'],
  ];
  for (const [baseUrl, expected] of good) {
    await chatProvider(fetcher, {baseUrl}).chat(CHAT_REQ, live());
    assert.equal(calls.at(-1)?.url, expected);
  }
  assert.equal(calls.length, good.length);

  // key 为空：不发 Authorization
  const {calls: c2, fetcher: f2} = recorder(() => jsonResponse(chatReply()));
  await chatProvider(f2, {}, '').chat(CHAT_REQ, live());
  assert.equal(new Headers(c2[0].init.headers).get('authorization'), null);
});

test('ChatCompletions：响应超过 2 MiB 算 invalid 并取消读取；网络异常算 network', async () => {
  const big = 'a'.repeat(2 * 1024 * 1024 + 1);
  const {res, stats} = openResponse(big, 200);
  const {fetcher} = recorder(() => res);
  const err = await failure(chatProvider(fetcher).chat(CHAT_REQ, live()));
  assert.equal(err.code, 'invalid');
  assert.equal(stats.cancels, 1, '超限以后要停止读');

  const {fetcher: failing} = recorder(() => { throw new TypeError('fetch failed'); });
  const network = await failure(chatProvider(failing).chat(CHAT_REQ, live()));
  assert.equal(network.code, 'network');
});

// 回归（2026-10-22 并行修改已修）：早先的 post() 把 baseUrl 末尾斜杠全删了再拼字符串，new URL 又在 try 外，
//   baseUrl = "https://"  -> "https:/chat/completions" -> https://chat/completions，带 Bearer 请求；
//   baseUrl = "https:///v1" -> https://v1/...；缺 scheme -> TypeError。
// 现在的写法是正则 + new URL + pathname，下面这些都必须 invalid 且不发请求。
test('ChatCompletions：baseUrl 解析不出主机名时必须 invalid 且不发请求（回归）', async () => {
  for (const baseUrl of ['https://', 'https:///v1', 'https:']) {
    const {calls, fetcher} = recorder(() => jsonResponse(chatReply()));
    const err = await failure(chatProvider(fetcher, {baseUrl}, 'SECRET-KEY').chat(CHAT_REQ, live()));
    assert.equal(err.code, 'invalid', baseUrl);
    assert.equal(calls.length, 0, `${baseUrl} 不能发请求`);
  }
  const {fetcher} = recorder(() => jsonResponse(chatReply()));
  await assert.rejects(
    chatProvider(fetcher, {baseUrl: 'api.example.test/v1'}).chat(CHAT_REQ, live()),
    (e: unknown) => e instanceof LlmFailure && e.code === 'invalid',
  );
});

// ---------------------------------------------------------------- Clef System One

const choiceQ = (keys: string[]): Question => ({
  type: 'choice', instructions: '挑一个',
  criteria: Object.fromEntries(keys.map(k => [k, `候选 ${k}`])),
});
const CHOICE_Q: Record<string, Question> = {pick: choiceQ(['a', 'b', 'c'])};
const NOUL_Q: Record<string, Question> = {yes: {type: 'noul', instructions: '要不要'}};
const SCORE_Q: Record<string, Question> = {level: {type: 'score', instructions: '几档', criteria: ['低', '中', '高']}};

const clefReply = (answers: Record<string, unknown>, usage: unknown = {input_tokens: 12, output_tokens: 3}) =>
  ({answers, usage});

async function clefFailure(questions: Record<string, Question>, body: unknown, cfg: Partial<ProviderConfig> = {}) {
  const {calls, fetcher} = recorder(() => jsonResponse(body));
  const err = await failure(clefProvider(fetcher, cfg).ask('快照', questions, live()));
  return {err, calls};
}

test('ClefProvider：POST /systemone，原生 state + questions；choice / noul / score 答案和 usage 原样映射', async () => {
  const questions: Record<string, Question> = {
    pick: {type: 'choice', instructions: '挑一个', criteria: {a: '待机', b: '走', c: '躲'}},
    yes: {type: 'noul', instructions: '要不要'},
    level: {type: 'score', instructions: '几档', criteria: ['低', '中', '高']},
  };
  const answers = {
    pick: {type: 'choice', choice: 'b', probabilities: {a: 0.2, b: 0.3, c: 0.5}, confidence: 0.5},
    yes: {type: 'noul', noul: 1},
    level: {type: 'score', score: 2, confidence: 0.8},
  };
  const {calls, fetcher} = recorder(() => jsonResponse(clefReply(answers)));
  const r = await clefProvider(fetcher).ask('快照 state', questions, live());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/systemone');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer test-key');
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
  assert.equal(body.model, 'clef');
  assert.equal(body.state, '快照 state');
  assert.deepEqual(body.questions, questions);

  assert.deepEqual(r.answers, answers);
  assert.deepEqual(r.usage, {prompt: 12, cached: null, completion: 3, reasoning: null});
  assert.ok(r.latencyMs >= 0);
});

test('ClefProvider usage：input / output 缺一即未知；0 保留；reasoning 0 保留；缓存路径没有报告记 null', async () => {
  const cases: {usage: unknown; expected: unknown}[] = [
    {usage: {input_tokens: 0, output_tokens: 0, completion_tokens_details: {reasoning_tokens: 0}},
      expected: {prompt: 0, cached: null, completion: 0, reasoning: 0}},
    {usage: {input_tokens: 5}, expected: null},
    {usage: {output_tokens: 5}, expected: null},
    {usage: null, expected: null},
    {usage: {input_tokens: 5, output_tokens: 2, completion_tokens_details: {reasoning_tokens: 3}},
      expected: {prompt: 5, cached: null, completion: 2, reasoning: null}},
    // 即使 provider 报了输入缓存，Clef 目前也固定记未知（config.cachedTokensField 被忽略）
    {usage: {input_tokens: 5, output_tokens: 2, input_tokens_details: {cached_tokens: 4}},
      expected: {prompt: 5, cached: null, completion: 2, reasoning: null}},
  ];
  for (const [i, c] of cases.entries()) {
    const {fetcher} = recorder(() => jsonResponse(clefReply({yes: {type: 'noul', noul: 0.5}}, c.usage)));
    const r = await clefProvider(fetcher).ask('s', NOUL_Q, live());
    assert.deepEqual(r.usage, c.expected, `第 ${i} 个 usage 用例`);
  }
});

test('ClefProvider choice：choice 必须是 criteria 的键；概率键齐全、各在 0..1、和≈1；confidence 也在 0..1', async () => {
  const ok = {pick: {type: 'choice', choice: 'a', probabilities: {a: 0.2, b: 0.3, c: 0.49}, confidence: 0.5}};
  {
    const {fetcher} = recorder(() => jsonResponse(clefReply(ok)));
    const r = await clefProvider(fetcher).ask('s', CHOICE_Q, live());
    assert.equal(r.answers.pick.choice, 'a');
  }

  const bad: Record<string, unknown>[] = [
    {pick: {type: 'choice', choice: 'z', probabilities: {a: 0.2, b: 0.3, c: 0.5}, confidence: 0.5}}, // 不在 criteria
    {pick: {type: 'choice', choice: 'a', probabilities: {a: 0.5, b: 0.5}, confidence: 0.5}}, // 少一个键
    {pick: {type: 'choice', choice: 'a', probabilities: {a: 0.2, b: 0.3, c: 0.5, d: 0}, confidence: 0.5}}, // 多一个键
    {pick: {type: 'choice', choice: 'a', probabilities: {a: 1.1, b: -0.1, c: 0}, confidence: 0.5}}, // 超出 0..1
    {pick: {type: 'choice', choice: 'a', probabilities: {a: 0.2, b: 0.3, c: 0.4}, confidence: 0.5}}, // 和 0.9
    {pick: {type: 'choice', choice: 'a', probabilities: {a: 0.4, b: 0.4, c: 0.3}, confidence: 0.5}}, // 和 1.1
    {pick: {type: 'choice', choice: 'a', probabilities: {a: 0.2, b: 0.3, c: '0.5'}, confidence: 0.5}}, // 概率不是数
    {pick: {type: 'choice', choice: 'a', confidence: 0.5}}, // 少 probabilities
    {pick: {type: 'choice', choice: 'a', probabilities: 'x', confidence: 0.5}}, // probabilities 不是对象
    {pick: {type: 'choice', choice: 'a', probabilities: {a: 0.2, b: 0.3, c: 0.5}}}, // 少 confidence
    {pick: {type: 'choice', choice: 'a', probabilities: {a: 0.2, b: 0.3, c: 0.5}, confidence: 1.1}}, // confidence 超范围
    {pick: {type: 'choice', choice: 'a', probabilities: {a: 0.2, b: 0.3, c: 0.5}, confidence: '0.5'}},
    {pick: {type: 'noul', noul: 0.5}}, // 类型不符
    {pick: {type: 'choice', probabilities: {a: 0.2, b: 0.3, c: 0.5}, confidence: 0.5}}, // 少 choice
  ];
  for (const [i, answers] of bad.entries()) {
    const {err, calls} = await clefFailure(CHOICE_Q, clefReply(answers));
    assert.equal(err.code, 'invalid', `第 ${i} 个 choice 用例`);
    assert.equal(calls.length, 1);
  }

  // Infinity 只能从原始 JSON 的 1e999 来（JSON.parse 会给出 Infinity）
  {
    const raw = '{"answers":{"pick":{"type":"choice","choice":"a","probabilities":{"a":1e999,"b":0,"c":0},"confidence":0.5}},"usage":{"input_tokens":1,"output_tokens":1}}';
    const {fetcher} = recorder(() => textResponse(raw));
    const err = await failure(clefProvider(fetcher).ask('s', CHOICE_Q, live()));
    assert.equal(err.code, 'invalid');
    assert.deepEqual(err.usage, {prompt: 1, cached: null, completion: 1, reasoning: null});
  }
});

test('ClefProvider 缺字段：answers 整体缺失、少一个问题的答案、答案类型不符都算 invalid，且带 usage', async () => {
  const usage = {input_tokens: 4, output_tokens: 2};
  const questions: Record<string, Question> = {
    pick: choiceQ(['a', 'b']),
    yes: {type: 'noul', instructions: '要不要'},
  };
  const cases: unknown[] = [
    {usage},
    {answers: null, usage},
    {answers: [], usage},
    {answers: {pick: {type: 'choice', choice: 'a', probabilities: {a: 0.5, b: 0.5}, confidence: 0.5}}, usage}, // 少 yes
    {answers: {pick: {type: 'noul', noul: 0.5}, yes: {type: 'noul', noul: 0.5}}, usage}, // pick 类型不符
  ];
  for (const [i, body] of cases.entries()) {
    const {err} = await clefFailure(questions, body);
    assert.equal(err.code, 'invalid', `第 ${i} 个缺字段用例`);
    assert.deepEqual(err.usage, {prompt: 4, cached: null, completion: 2, reasoning: null});
  }
});

test('ClefProvider noul：概率 0 / 1 可用；越界、非数、缺字段都算 invalid', async () => {
  for (const value of [0, 1]) {
    const {fetcher} = recorder(() => jsonResponse(clefReply({yes: {type: 'noul', noul: value}})));
    const r = await clefProvider(fetcher).ask('s', NOUL_Q, live());
    assert.equal(r.answers.yes.noul, value);
  }
  for (const answers of [
    {yes: {type: 'noul', noul: -0.01}},
    {yes: {type: 'noul', noul: 1.01}},
    {yes: {type: 'noul', noul: '0.5'}},
    {yes: {type: 'noul'}},
    {yes: {type: 'noul', noul: null}},
    {yes: {type: 'score', score: 0, confidence: 0.5}},
  ]) {
    const {err} = await clefFailure(NOUL_Q, clefReply(answers));
    assert.equal(err.code, 'invalid');
  }
});

test('ClefProvider score：档位 0..criteria.length-1，confidence 0..1；越界、非数都算 invalid', async () => {
  for (const [score, confidence] of [[0, 0], [2, 1]] as const) {
    const {fetcher} = recorder(() => jsonResponse(clefReply({level: {type: 'score', score, confidence}})));
    const r = await clefProvider(fetcher).ask('s', SCORE_Q, live());
    assert.equal(r.answers.level.score, score);
  }
  for (const answers of [
    {level: {type: 'score', score: 3, confidence: 0.5}}, // == criteria.length
    {level: {type: 'score', score: -1, confidence: 0.5}},
    {level: {type: 'score', score: '2', confidence: 0.5}},
    {level: {type: 'score', score: 2}},
    {level: {type: 'score', score: 2, confidence: 1.01}},
    {level: {type: 'score', score: 2, confidence: '0.5'}},
    {level: {type: 'choice', choice: 'a', probabilities: {a: 1, b: 0}, confidence: 0.5}}, // 类型不符
  ]) {
    const {err} = await clefFailure(SCORE_Q, clefReply(answers));
    assert.equal(err.code, 'invalid');
  }
});

// score 是概率加权平均（官方文档例子 1.2 / 2），不是 criteria 的下标，必须允许小数并原样保留。
test('ClefProvider score：允许小数档位并原样保留（1.5）', async () => {
  const {fetcher} = recorder(() => jsonResponse(clefReply({level: {type: 'score', score: 1.5, confidence: 0.5}})));
  const r = await clefProvider(fetcher).ask('s', SCORE_Q, live());
  assert.equal(r.answers.level.score, 1.5);
  assert.equal(r.answers.level.confidence, 0.5);
});

test('ClefProvider：choice 候选上限 26、score 档位上限 10；超限和只有 1 个候选都在发请求前 invalid', async () => {
  const keys = Array.from({length: 26}, (_, i) => `c${i}`);
  {
    const probabilities = Object.fromEntries(keys.map(k => [k, 1 / 26]));
    const {calls, fetcher} = recorder(() => jsonResponse(clefReply({
      pick: {type: 'choice', choice: 'c0', probabilities, confidence: 0.5},
    })));
    const r = await clefProvider(fetcher).ask('s', {pick: choiceQ(keys)}, live());
    assert.equal(r.answers.pick.choice, 'c0');
    assert.equal(calls.length, 1);
  }
  {
    const {calls, fetcher} = recorder(() => jsonResponse(clefReply({
      level: {type: 'score', score: 9, confidence: 0.5},
    })));
    const r = await clefProvider(fetcher).ask('s', {
      level: {type: 'score', instructions: '几档', criteria: Array.from({length: 10}, (_, i) => `第 ${i} 档`)},
    }, live());
    assert.equal(r.answers.level.score, 9);
    assert.equal(calls.length, 1);
  }

  const overLimit: Record<string, Question>[] = [
    {pick: choiceQ(keys.concat('c26'))}, // 27 个候选
    {level: {type: 'score', instructions: '几档', criteria: Array.from({length: 11}, (_, i) => `第 ${i} 档`)}}, // 11 档
    {pick: choiceQ(['a'])}, // 只有 1 个候选
    {level: {type: 'score', instructions: '几档', criteria: ['低']}},
  ];
  for (const [i, questions] of overLimit.entries()) {
    const {calls, fetcher} = recorder(() => { throw new Error('不应发请求'); });
    const err = await failure(clefProvider(fetcher).ask('s', questions, live()));
    assert.equal(err.code, 'invalid', `第 ${i} 个上限用例`);
    assert.equal(calls.length, 0);
  }
});

test('ClefProvider 输入校验：空 state、空 questions、id / instructions / criteria 不合格、超过 64 个问题都不发请求', async () => {
  const bad = (q: unknown): Record<string, Question> => ({q: q as Question});
  const cases: [string, Record<string, Question>][] = [
    ['', NOUL_Q],
    ['   \n', NOUL_Q],
    ['s', {}],
    ['s', {'bad id': {type: 'noul', instructions: '吗'}}],
    ['s', {['x'.repeat(101)]: {type: 'noul', instructions: '吗'}}],
    ['s', {'': {type: 'noul', instructions: '吗'}}],
    ['s', {'中文': {type: 'noul', instructions: '吗'}}],
    ['s', {yes: {type: 'noul', instructions: '   '}}],
    // 并行修改新增的输入校验：未知类型、criteria 形状不对、空标签
    ['s', bad(null)],
    ['s', bad({type: 'wat', instructions: '吗'})],
    ['s', bad({type: 'choice', instructions: '吗', criteria: {a: ''}})],
    ['s', bad({type: 'choice', instructions: '吗', criteria: {a: 1}})],
    ['s', bad({type: 'score', instructions: '吗', criteria: 'not-array'})],
    ['s', bad({type: 'score', instructions: '吗', criteria: ['低', '']})],
    ['s', Object.fromEntries(Array.from({length: 65}, (_, i) => [`q${i}`, {type: 'noul', instructions: '吗'} as Question]))],
  ];
  for (const [i, [state, questions]] of cases.entries()) {
    const {calls, fetcher} = recorder(() => { throw new Error('不应发请求'); });
    const err = await failure(clefProvider(fetcher).ask(state, questions, live()));
    assert.equal(err.code, 'invalid', `第 ${i} 个输入校验用例`);
    assert.equal(calls.length, 0);
  }
});

test('ClefProvider：本机 http 允许、远程明文不允许；200 坏 JSON 不重试；非 200 不泄露 body', async () => {
  // 本机 http 放行，路径是 /systemone
  {
    const {calls, fetcher} = recorder(() => jsonResponse(clefReply({yes: {type: 'noul', noul: 0.5}})));
    await clefProvider(fetcher, {baseUrl: 'http://127.0.0.1:11434/v1'}).ask('s', NOUL_Q, live());
    assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/systemone');
  }
  // 远程明文拒绝
  {
    const {calls, fetcher} = recorder(() => jsonResponse(clefReply({yes: {type: 'noul', noul: 0.5}})));
    const err = await failure(clefProvider(fetcher, {baseUrl: 'http://api.example.test/v1'}).ask('s', NOUL_Q, live()));
    assert.equal(err.code, 'invalid');
    assert.equal(calls.length, 0);
  }
  // 200 坏 JSON：只请求一次
  {
    const {calls, fetcher} = recorder(() => textResponse('{"answers":'));
    const err = await failure(clefProvider(fetcher).ask('s', NOUL_Q, live()));
    assert.equal(err.code, 'bad-json');
    assert.equal(calls.length, 1);
  }
  // 非 200：不读 body、不泄露、不重试
  {
    const secret = 'BODY-SECRET-CLEF';
    const {res, stats} = guardedErrorResponse(secret, 400);
    const {calls, fetcher} = recorder(() => res);
    const err = await failure(clefProvider(fetcher).ask('s', NOUL_Q, live()));
    assert.equal(err.code, 'http');
    assert.equal(err.message, 'http');
    assert.equal(calls.length, 1);
    assert.equal(stats.cancels, 1);
    assert.equal(stats.readers, 0, '错误响应体不能被读取');
    assert.ok(![String(err), err.stack ?? '', JSON.stringify(err)].join('\n').includes(secret));
  }
});
