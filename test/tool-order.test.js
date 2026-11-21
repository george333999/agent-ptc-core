import test from 'node:test';
import assert from 'node:assert/strict';
import { sortToolDefinitions } from '../server/tool-order.js';
import { PTC_NAMESPACE_METHODS, PTC_TOOL_NAMES, PTC_TOOL_SPECS } from '../server/ptc/specs.js';

function definition(name) {
  return { type: 'function', function: { name, description: `${name} tool` } };
}

test('工具定义按名称字节序排序', () => {
  const sorted = sortToolDefinitions([
    definition('write_file'),
    definition('ask_user'),
    definition('read_file'),
    definition('ptc_run')
  ]);
  assert.deepEqual(
    sorted.map((item) => item.function.name),
    ['ask_user', 'ptc_run', 'read_file', 'write_file']
  );
});

test('输入顺序变化不改变输出字节', () => {
  const input = [definition('search_files'), definition('edit_file'), definition('list_files')];
  const forward = JSON.stringify(sortToolDefinitions(input));
  const backward = JSON.stringify(sortToolDefinitions([...input].reverse()));
  assert.equal(forward, backward);
  assert.equal(forward, JSON.stringify(sortToolDefinitions(input)));
});

test('空输入与非法输入安全', () => {
  assert.deepEqual(sortToolDefinitions(undefined), []);
  assert.deepEqual(sortToolDefinitions(null), []);
  assert.deepEqual(sortToolDefinitions([]), []);
});

test('PTC 规格与命名空间顺序固定', () => {
  assert.deepEqual([...PTC_TOOL_NAMES], Object.keys(PTC_TOOL_SPECS).sort());
  assert.deepEqual(Object.keys(PTC_NAMESPACE_METHODS), Object.keys(PTC_NAMESPACE_METHODS).slice().sort());
  for (const methods of Object.values(PTC_NAMESPACE_METHODS)) {
    assert.deepEqual([...methods], [...methods].slice().sort());
  }
});
