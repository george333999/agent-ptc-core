import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInlinePlan,
  isDestructivePlan,
  shouldInlinePlan,
  resolveInlinePlan
} from '../server/plan-inline.js';

test('识别编号计划与复选框计划', () => {
  const numbered = parseInlinePlan('执行计划：\n1. 读取文件\n2. 修改函数\n3. 运行测试');
  assert.equal(numbered.isPlan, true);
  assert.equal(numbered.steps.length, 3);
  const checkbox = parseInlinePlan('- [ ] 读取\n- [x] 分析');
  assert.equal(checkbox.isPlan, true);
  assert.deepEqual(checkbox.steps, ['读取', '分析']);
  assert.equal(parseInlinePlan('好的，马上开始。').isPlan, false);
  assert.deepEqual(parseInlinePlan('').steps, []);
});

test('破坏性计划判定覆盖写入、命令与风险提示', () => {
  assert.equal(isDestructivePlan({ steps: ['读取并修改 src/a.js'] }), true);
  assert.equal(isDestructivePlan({ risks: ['会执行命令'] }), true);
  assert.equal(isDestructivePlan({ steps: [{ title: '分析', detail: '只读' }] }), false);
  assert.equal(isDestructivePlan(null), false);
});

test('非破坏性且已带工具调用时允许内联计划', () => {
  const plan = { steps: [{ title: '读取', detail: '只读分析' }] };
  assert.equal(shouldInlinePlan({
    plan,
    content: '1. 读取文件\n2. 汇总',
    toolCalls: [{ name: 'ptc_run' }]
  }), true);
  assert.equal(shouldInlinePlan({
    plan,
    content: '1. 读取文件\n2. 汇总',
    toolCalls: []
  }), false);
  assert.equal(shouldInlinePlan({
    plan: { steps: ['写入 reports/a.md'] },
    content: '1. 写入\n2. 校验',
    toolCalls: [{ name: 'write_file' }]
  }), false);
});

test('不支持并行工具调用时只保留第一个，其余延后', () => {
  const calls = [
    { name: 'read_file', arguments: '{"path":"a"}' },
    { name: 'read_file', arguments: '{"path":"b"}' },
    { name: 'search_files', arguments: '{"query":"x"}' }
  ];
  const result = resolveInlinePlan({
    content: '1. 并行读取\n2. 汇总',
    toolCalls: calls,
    supportsParallelToolCalls: false
  });
  assert.equal(result.fallback, 'serialize_tool_calls');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.deferred.length, 2);
  assert.match(result.content, /后续/);
});

test('支持并行时原样返回，不改变内容与调用', () => {
  const calls = [{ name: 'a' }, { name: 'b' }];
  const result = resolveInlinePlan({ content: '计划', toolCalls: calls, supportsParallelToolCalls: true });
  assert.equal(result.content, '计划');
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.deferred.length, 0);
  assert.equal(result.fallback, '');
  assert.equal(result.inlined, true);
});
