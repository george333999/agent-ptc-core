import crypto from 'node:crypto';

// Stable serialization: object keys are emitted in alphabetical order, used to compare whether the "cache prefix" bytes are identical.
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

// Cacheable prefix = system prompt + tool schemas (including order).
export function buildCachePrefix({ system = '', tools = [] } = {}) {
  const text = stableStringify({ system, tools });
  return { text, hash: hashText(text), chars: text.length };
}

// Full request fingerprint: header and each message are serialized separately, then concatenated in order,
// so a request that only appends messages is naturally a prefix of the previous request.
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
