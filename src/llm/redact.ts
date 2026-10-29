// 日志脱敏（R4.3）：字段、Bearer、sk- 形状、URL 查询参数。纯函数，不修改输入，循环引用也能处理。
const REDACTED = '[REDACTED]';

const EXACT_SENSITIVE = new Set([
  'authorization', 'auth', 'apikey', 'key', 'bearer', 'password', 'passwd', 'pwd',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken',
  'secret', 'clientsecret', 'apisecret', 'credential', 'credentials',
]);

function keyParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part.toLowerCase());
}

/** 字段名本身是不是“值不能进日志”的那类。 */
function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (EXACT_SENSITIVE.has(normalized)) return true;
  if (normalized.startsWith('authorization')) return true;
  if (/(?:password|passwd|secret|apikey|token)$/.test(normalized)) return true;
  if (/(?:access|refresh|private|secret|signing)key$/.test(normalized)) return true;

  const parts = keyParts(key);
  if (parts.length > 1 && parts[parts.length - 1] === 'key' && parts.some(p=>['api','access','secret','private','signing','auth','client','session','encryption'].includes(p))) return true;
  // accessKeyId / apiKeyId 这类：key 后面还有 Id，但仍是凭据。
  return parts.includes('key') && parts.some(part =>
    ['api', 'access', 'secret', 'private', 'signing', 'auth', 'bearer', 'openai', 'anthropic'].includes(part));
}

const SENSITIVE_NAMES = [
  'api[_-]?key', 'apikey', 'api[_-]?secret', 'x[_-]?api[_-]?key',
  'access[_-]?key', 'secret[_-]?key', 'private[_-]?key', 'signing[_-]?key',
  'auth[_-]?key', 'client[_-]?key', 'session[_-]?key', 'encryption[_-]?key',
  'access[_-]?token', 'refresh[_-]?token', 'id[_-]?token', 'auth[_-]?token',
  'session[_-]?token', 'bearer[_-]?token', 'client[_-]?secret',
  'authorization', 'password', 'passwd', 'pwd', 'token', 'secret', 'auth', 'key',
  'bearer', 'credentials?',
].join('|');
const QUERY_RE = new RegExp(`([?&](?:${SENSITIVE_NAMES})=)([^&#;\\s"'<>]*)`, 'gi');
const ASSIGNMENT_RE = new RegExp(`\\b(${SENSITIVE_NAMES})\\b(\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;&#]+)`, 'gi');
const AUTHORIZATION_RE = /\b(authorization)(\s*[:=]\s*)([^\r\n,;&#]+)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SK_RE = /\bsk-[A-Za-z0-9_-]{3,}\b/gi;

/**
 * 文本脱敏。先处理完整 header，避免 "Authorization: Bearer …" 只吃掉 Bearer 一词。
 */
export function redactText(text: string): string {
  if (typeof text !== 'string') return text;
  return text
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[IMAGE REDACTED]')
    .replace(AUTHORIZATION_RE, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(SK_RE, REDACTED)
    .replace(QUERY_RE, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(ASSIGNMENT_RE, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`);
}

function put(object: Record<string, unknown>, key: string, value: unknown): void {
  // 用 defineProperty 写，避免 JSON.parse 出来的 __proto__ 键改掉克隆对象的原型。
  Object.defineProperty(object, key, {value, enumerable: true, configurable: true, writable: true});
}

function redactObject(value: object, seen: WeakMap<object, unknown>): unknown {
  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(redactValue(item, seen));
    return out;
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof URL) {
    const safe = redactText(value.href);
    try { return new URL(safe); } catch { return safe; }
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    seen.set(value, out);
    for (const [key, item] of value) {
      const safeKey = typeof key === 'string' ? redactText(key) : redactValue(key, seen);
      out.set(safeKey, redactValue(item, seen));
    }
    return out;
  }
  if (value instanceof Set) {
    const out = new Set<unknown>();
    seen.set(value, out);
    for (const item of value) out.add(redactValue(item, seen));
    return out;
  }
  if (value instanceof Error) {
    const out = new Error(redactText(value.message)) as Error & Record<string, unknown>;
    seen.set(value, out);
    out.name = value.name;
    if (value.stack) out.stack = redactText(value.stack);
    if (value.cause !== undefined) out.cause = redactValue(value.cause, seen);
    for (const [key, item] of Object.entries(value)) {
      if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue;
      put(out, key, sensitiveKey(key) ? REDACTED : redactValue(item, seen));
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) {
    put(out, key, sensitiveKey(key) ? REDACTED : redactValue(item, seen));
  }
  return out;
}

function redactValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  return redactObject(value, seen);
}

/**
 * 递归脱敏对象 / 数组 / Map / Set / Error；保留循环引用，输入对象不变。
 * 敏感字段名（Authorization、api_key、password、token、secret、…）的值整体替换为 [REDACTED]。
 */
export function redact(value: unknown): unknown {
  return redactValue(value, new WeakMap<object, unknown>());
}
