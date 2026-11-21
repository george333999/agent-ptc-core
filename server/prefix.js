import crypto from 'node:crypto';

// 稳定序列化：对象键按字母序输出，用于比较“缓存前缀”的字节是否一致。
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function hashText(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);
}

// 可缓存前缀 = system prompt + 工具 schema（含顺序）。
export function buildCachePrefix({ system = '', tools = [] } = {}) {
  const text = stableStringify({ system, tools });
  return { text, hash: hashText(text), chars: text.length };
}

// 完整请求指纹：头部与每条消息分别序列化后顺序拼接，
// 这样“只追加消息”的请求天然是上一条请求的前缀。
export function buildRequestFingerprint({ system = '', tools = [], messages = [] } = {}) {
  const head = stableStringify({ system, tools });
  const body = (Array.isArray(messages) ? messages : [])
    .map((message) => stableStringify(message))
    .join('\n');
  const text = `${head}\n${body}`;
  return { text, hash: hashText(text), chars: text.length };
}

export function commonPrefixChars(previous, next) {
  const left = String(previous ?? '');
  const right = String(next ?? '');
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

export function commonPrefixRatio(previous, next) {
  const left = String(previous ?? '');
  if (!left.length) return 1;
  return commonPrefixChars(left, next) / left.length;
}
