import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCachePrefix,
  buildRequestFingerprint,
  commonPrefixRatio,
  hashText,
  stableStringify
} from '../server/prefix.js';

test('stable serialization ignores object key order', () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 2, c: 3 } }),
    stableStringify({ a: { c: 3, d: 2 }, b: 1 })
  );
});

test('identical system + tools yield identical prefix hash', () => {
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

test('changing system changes the prefix hash', () => {
  const left = buildCachePrefix({ system: 'A', tools: [] });
  const right = buildCachePrefix({ system: 'B', tools: [] });
  assert.notEqual(left.hash, right.hash);
});

test('full request fingerprint includes messages and can compute common prefix ratio', () => {
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
