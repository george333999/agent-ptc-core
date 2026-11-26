import test from 'node:test';
import assert from 'node:assert/strict';
import { sortToolDefinitions } from '../server/tool-order.js';
import { PTC_NAMESPACE_METHODS, PTC_TOOL_NAMES, PTC_TOOL_SPECS } from '../server/ptc/specs.js';

function definition(name) {
  return { type: 'function', function: { name, description: `${name} tool` } };
}

test('tool definitions are sorted by name byte order', () => {
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

test('changing input order does not change output bytes', () => {
  const input = [definition('search_files'), definition('edit_file'), definition('list_files')];
  const forward = JSON.stringify(sortToolDefinitions(input));
  const backward = JSON.stringify(sortToolDefinitions([...input].reverse()));
  assert.equal(forward, backward);
  assert.equal(forward, JSON.stringify(sortToolDefinitions(input)));
});

test('empty and invalid inputs are safe', () => {
  assert.deepEqual(sortToolDefinitions(undefined), []);
  assert.deepEqual(sortToolDefinitions(null), []);
  assert.deepEqual(sortToolDefinitions([]), []);
});

test('PTC specs and namespace ordering are fixed', () => {
  assert.deepEqual([...PTC_TOOL_NAMES], Object.keys(PTC_TOOL_SPECS).sort());
  assert.deepEqual(Object.keys(PTC_NAMESPACE_METHODS), Object.keys(PTC_NAMESPACE_METHODS).slice().sort());
  for (const methods of Object.values(PTC_NAMESPACE_METHODS)) {
    assert.deepEqual([...methods], [...methods].slice().sort());
  }
});
