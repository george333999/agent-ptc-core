import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCachePrefix,
  buildRequestFingerprint,
  commonPrefixRatio,
  hashText,
  stableStringify
} from '../server/prefix.js';

test('稳定序列化忽略对象键顺序', () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 2, c: 3 } }),
    stableStringify({ a: { c: 3, d: 2 }, b: 1 })
  );
});

test('相同 system + tools 得到相同前缀哈希', () => {
  const first = buildCachePrefix({
    system: 'stable system',
    tools: [{ function: { name: 'read_file', parameters: { b: 1, a: 2 } } }]
  });
  const second = buildCachePrefix({
    system: 'stable system',
    tools: [{ function: { parameters: { a: 2, b: 1 }, name: 'read_file' } }]
  });
  assert.equal(first.hash, second.hash);
  assert.equal(first.text, second.text);
});

test('system 变化会改变前缀哈希', () => {
  const left = buildCachePrefix({ system: 'A', tools: [] });
  const right = buildCachePrefix({ system: 'B', tools: [] });
  assert.notEqual(left.hash, right.hash);
});

test('完整请求指纹包含消息，且能计算公共前缀比例', () => {
  const base = { system: 's', tools: [{ function: { name: 'x' } }] };
  const first = buildRequestFingerprint({ ...base, messages: [{ role: 'user', content: 'hello' }] });
  const growing = buildRequestFingerprint({
    ...base,
    messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }]
  });
  assert.equal(commonPrefixRatio(first.text, growing.text), 1);
  assert.equal(commonPrefixRatio('abc', 'xyz'), 0);
  assert.equal(commonPrefixRatio('abc', 'abc'), 1);
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
});
