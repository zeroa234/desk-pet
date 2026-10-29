// 日志脱敏的单测（纯函数）：header、Bearer、sk- 形状、URL 查询 key、字段名、循环引用、不改输入。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {redact, redactText} from '../src/llm/redact.ts';
import {eq} from './helpers/assert.ts';

const assertNo = (value: string, ...secrets: string[]) => {
  for (const secret of secrets) assert.ok(!value.includes(secret), `不应包含 ${secret}：${value}`);
};

test('redactText：Authorization header 与 Bearer', () => {
  const out = redactText('Authorization: Bearer abc.def-123\nnext line');
  assertNo(out, 'abc.def-123');
  assert.ok(out.includes('Authorization: [REDACTED]'));
  assert.ok(out.includes('next line'));

  const prose = redactText('send Bearer sk-live-1234567890 now');
  assertNo(prose, 'sk-live-1234567890');
  assert.ok(prose.includes('Bearer [REDACTED]'));
});

test('redactText：sk- 形状的 key', () => {
  const out = redactText('a sk-proj-abc123456 b sk-ant-api03-xyz789 c');
  assertNo(out, 'abc123456', 'xyz789');
  eq(out, 'a [REDACTED] b [REDACTED] c');
  eq(redactText('sk-abc'), '[REDACTED]', '短 key 也按形状脱敏');
});

test('redactText：URL 查询里的 key / token / secret，只替换值', () => {
  const out = redactText('https://api.example.test/v1?api_key=SECRET123&foo=bar&access_token=TOK_SECRET_9#frag');
  assertNo(out, 'SECRET123', 'TOK_SECRET_9');
  assert.ok(out.includes('api_key=[REDACTED]'));
  assert.ok(out.includes('foo=bar'));
  assert.ok(out.includes('#frag'));

  const upper = redactText('https://x.test/?Key=UPPER_SECRET&normal=1');
  assertNo(upper, 'UPPER_SECRET');
  assert.ok(upper.includes('normal=1'));

  const url = redact(new URL('https://x.test/?token=URL_SECRET&normal=1')) as URL;
  assert.ok(url instanceof URL);
  assertNo(url.href, 'URL_SECRET');
  assert.ok(url.href.includes('normal=1'));

  const authQuery = redactText('https://x.test/?authorization=AUTH_SECRET&foo=bar');
  assertNo(authQuery, 'AUTH_SECRET');
  assert.ok(authQuery.includes('foo=bar'));
});

test('redactText：配置式 key=value / key: value 也脱敏', () => {
  const out = redactText('api_key=SECRET abc password: "two words" token=xyz');
  assertNo(out, 'SECRET', 'two words', 'xyz');
  assert.ok(out.includes('abc'), '普通文本保留');
  assert.ok(out.includes('password: [REDACTED]'));
});

test('redactText：正常文本不误伤', () => {
  const text = 'tokenizer ready, monkey business, max_tokens=512, token count 3';
  eq(redactText(text), text);
});

test('redact：敏感字段整体替换，嵌套字符串也过文本规则，输入不变', () => {
  const input = {
    Authorization: 'Bearer top-secret',
    headers: {'x-api-key': 'sk-abcdef123456'},
    apiKey: 'AKIA123',
    password: 'p',
    nested: {token: 't', safe: 'Bearer nested-secret'},
    max_tokens: 512,
    cachedTokens: 10,
    monkey: 'business',
  };
  const out = redact(input) as typeof input;

  eq(out.Authorization, '[REDACTED]');
  eq(out.headers['x-api-key'], '[REDACTED]');
  eq(out.apiKey, '[REDACTED]');
  eq(out.password, '[REDACTED]');
  eq(out.nested.token, '[REDACTED]');
  eq(out.nested.safe, 'Bearer [REDACTED]');
  eq(out.max_tokens, 512);
  eq(out.cachedTokens, 10);
  eq(out.monkey, 'business');

  eq(input.Authorization, 'Bearer top-secret', '输入对象不能被改');
  eq(input.headers['x-api-key'], 'sk-abcdef123456');
  eq(input.nested.token, 't');
});

test('redact：数组、字符串和原始值', () => {
  const out = redact(['Bearer abc123', {secret: 's'}, 7, null, true]) as unknown[];
  eq(out[0], 'Bearer [REDACTED]');
  eq((out[1] as {secret: string}).secret, '[REDACTED]');
  eq(out[2], 7);
  eq(out[3], null);
  eq(out[4], true);
  eq(redact('sk-abcdef123456'), '[REDACTED]');
  eq(redact(42), 42);
  eq(redact(null), null);
});

test('redact：循环引用保留结构，不死循环、不改输入', () => {
  const input: {name: string; Authorization: string; self?: unknown; list?: unknown[]} = {
    name: 'a',
    Authorization: 'Bearer circular-secret',
  };
  input.self = input;
  input.list = [input];

  const out = redact(input) as typeof input;
  eq(out.self, out);
  eq((out.list as unknown[])[0], out);
  eq(out.Authorization, '[REDACTED]');
  eq(input.self, input);
  eq(input.Authorization, 'Bearer circular-secret');
});

test('redact：Map / Set / Error 也处理，且不修改原对象', () => {
  const map = new Map<string, string>([['safe', 'Bearer map-secret']]);
  const set = new Set<string>(['sk-abcdef123456']);
  const error = new Error('Bearer error-secret');
  const outMap = redact(map) as Map<string, string>;
  const outSet = redact(set) as Set<string>;
  const outError = redact(error) as Error;
  eq(outMap.get('safe'), 'Bearer [REDACTED]');
  eq([...outSet][0], '[REDACTED]');
  assertNo(outError.message, 'error-secret');
  eq(map.get('safe'), 'Bearer map-secret');
  eq([...set][0], 'sk-abcdef123456');
  eq(error.message, 'Bearer error-secret');
});

test('image attachments echoed in malformed model output cannot enter event logs',()=>{
  const raw={reply:'echo data:image/jpeg;base64,VEVTVA== trailing text',nested:{url:'data:image/png;base64,QUJD'}};
  const safe=JSON.stringify(redact(raw));assertNo(safe,'VEVTVA==','QUJD','data:image');assert.ok(safe.includes('trailing text'));assert.ok(raw.reply.includes('VEVTVA=='));
});
