import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkerSystemPrompt,
  buildWorkerUserPrompt,
  filterWorkerTools,
  workerAllowedTools
} from '../server/worker-prompt.js';

const plan = { goal: '完成一个多步骤重构' };

function task(overrides = {}) {
  return {
    id: 't1',
    title: '分析入口',
    brief: '阅读入口文件并列出调用链',
    constraints: ['不要修改文件'],
    knownInfo: '',
    readFiles: ['server/index.js'],
    writeFiles: [],
    expectedOutput: '结论与证据',
    ...overrides
  };
}

test('同一 DAG 内不同子任务的 system prompt 完全一致', () => {
  const first = buildWorkerSystemPrompt({ allowAskUser: true, ptc: true });
  const second = buildWorkerSystemPrompt({ allowAskUser: true, ptc: true });
  assert.equal(first, second);
});

test('任务 ID、标题、简报、上游结果只出现在用户消息里', () => {
  const system = buildWorkerSystemPrompt({ allowAskUser: false, ptc: true });
  const taskA = task();
  const taskB = task({ id: 't2', title: '修改实现', brief: '只改 server/agent.js' });
  const userA = buildWorkerUserPrompt(taskA, plan, []);
  const userB = buildWorkerUserPrompt(taskB, plan, [
    { taskId: 't1', title: '分析入口', status: 'completed', result: '调用链是 A -> B', evidence: ['server/index.js:1'], confidence: 0.9 }
  ]);
  assert.ok(!system.includes('t1'));
  assert.ok(!system.includes('分析入口'));
  assert.ok(userA.includes('[t1] 分析入口'));
  assert.ok(userB.includes('[t2] 修改实现'));
  assert.ok(userB.includes('调用链是 A -> B'));
  assert.ok(system.includes('缓存友好'));
});

test('DAG 级工具集固定，不随单个任务变化', () => {
  const definitions = [
    { type: 'function', function: { name: 'read_file' } },
    { type: 'function', function: { name: 'write_file' } },
    { type: 'function', function: { name: 'ask_user' } },
    { type: 'function', function: { name: 'ptc_run' } }
  ];
  const readOnlyDag = filterWorkerTools(definitions, { hasWrites: false, allowAskUser: false, ptc: true });
  const writableDag = filterWorkerTools(definitions, { hasWrites: true, allowAskUser: true, ptc: true });
  assert.deepEqual(readOnlyDag.map((item) => item.function.name), ['read_file', 'ptc_run']);
  assert.deepEqual(writableDag.map((item) => item.function.name), ['read_file', 'write_file', 'ask_user', 'ptc_run']);
});

test('边界输入安全：空任务与空工具列表', () => {
  const allowed = workerAllowedTools({}, {});
  assert.ok(allowed.has('read_file'));
  assert.ok(!allowed.has('write_file'));
  assert.deepEqual(filterWorkerTools(undefined, {}), []);
  assert.deepEqual(filterWorkerTools([], {}), []);
  assert.ok(workerAllowedTools(undefined, {}).has('read_file'));
});

test('执行期权限按子任务收敛，且与 PTC 暴露的 schema 一致', () => {
  const readOnly = workerAllowedTools(task(), { allowAskUser: false, ptc: true });
  assert.ok(!readOnly.has('read_file'));
  assert.ok(readOnly.has('ptc_run'));
  assert.ok(!readOnly.has('write_file'));
  assert.ok(!readOnly.has('ask_user'));

  const nativeRead = workerAllowedTools(task(), { allowAskUser: false, ptc: false });
  assert.ok(nativeRead.has('read_file'));
  assert.ok(!nativeRead.has('ptc_run'));

  const writable = workerAllowedTools(task({ writeFiles: ['server/agent.js'] }), { allowAskUser: true, ptc: false });
  assert.ok(writable.has('write_file'));
  assert.ok(writable.has('edit_file'));
  assert.ok(writable.has('ask_user'));
  assert.ok(!writable.has('ptc_run'));
});
