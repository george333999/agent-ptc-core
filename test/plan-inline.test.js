import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInlinePlan,
  isDestructivePlan,
  shouldInlinePlan,
  resolveInlinePlan
} from '../server/plan-inline.js';

test('detects numbered and checkbox plans', () => {
  const numbered = parseInlinePlan('执行计划：\n1. 读取文件\n2. 修改函数\n3. 运行测试');
  assert.equal(numbered.isPlan, true);
  assert.equal(numbered.steps.length, 3);
  const checkbox = parseInlinePlan('- [ ] Read\n- [x] Analyze');
  assert.equal(checkbox.isPlan, true);
  assert.deepEqual(checkbox.steps, ['Read', 'Analyze']);
  assert.equal(parseInlinePlan('Okay, starting right away.').isPlan, false);
  assert.deepEqual(parseInlinePlan('').steps, []);
});

test('destructive plan detection covers writes, commands, and risk notes', () => {
  assert.equal(isDestructivePlan({ steps: ['读取并修改 src/a.js'] }), true);
  assert.equal(isDestructivePlan({ risks: ['会执行命令'] }), true);
  assert.equal(isDestructivePlan({ steps: [{ title: 'Analyze', detail: 'Read-only' }] }), false);
  assert.equal(isDestructivePlan(null), false);
});

test('allows an inline plan for a non-destructive task that already carries tool calls', () => {
  const plan = { steps: [{ title: 'Read', detail: 'read-only analysis' }] };
  assert.equal(shouldInlinePlan({
    plan,
    content: '1. Read files\n2. Summarize',
    toolCalls: [{ name: 'ptc_run' }]
  }), true);
  assert.equal(shouldInlinePlan({
    plan,
    content: '1. Read files\n2. Summarize',
    toolCalls: []
  }), false);
  assert.equal(shouldInlinePlan({
    plan: { steps: ['写入 reports/a.md'] },
    content: '1. Write\n2. Verify',
    toolCalls: [{ name: 'write_file' }]
  }), false);
});

test('keeps only the first call and defers the rest when parallel tool calls are unsupported', () => {
  const calls = [
    { name: 'read_file', arguments: '{"path":"a"}' },
    { name: 'read_file', arguments: '{"path":"b"}' },
    { name: 'search_files', arguments: '{"query":"x"}' }
  ];
  const result = resolveInlinePlan({
    content: '1. Read in parallel\n2. Summarize',
    toolCalls: calls,
    supportsParallelToolCalls: false
  });
  assert.equal(result.fallback, 'serialize_tool_calls');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.deferred.length, 2);
  assert.match(result.content, /next step/);
});

test('returns as-is when parallel calls are supported, without changing content or calls', () => {
  const calls = [{ name: 'a' }, { name: 'b' }];
  const result = resolveInlinePlan({ content: 'Plan', toolCalls: calls, supportsParallelToolCalls: true });
  assert.equal(result.content, 'Plan');
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.deferred.length, 0);
  assert.equal(result.fallback, '');
  assert.equal(result.inlined, true);
});
