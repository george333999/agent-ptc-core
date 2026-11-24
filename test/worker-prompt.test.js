import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkerSystemPrompt,
  buildWorkerUserPrompt,
  filterWorkerTools,
  workerAllowedTools
} from '../server/worker-prompt.js';
import { buildPtcToolDefinition } from '../server/ptc/index.js';

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

test('DAG 级工具集规范固定：与是否写入/是否允许提问无关', () => {
  const definitions = [
    { type: 'function', function: { name: 'read_file' } },
    { type: 'function', function: { name: 'read_tool_result' } },
    { type: 'function', function: { name: 'write_file' } },
    { type: 'function', function: { name: 'ask_user' } },
    { type: 'function', function: { name: 'ptc_run' } }
  ];
  const readOnlyDag = filterWorkerTools(definitions, { hasWrites: false, allowAskUser: false, ptc: true });
  const writableDag = filterWorkerTools(definitions, { hasWrites: true, allowAskUser: true, ptc: true });
  // 规范工具集：只由 toolMode 决定，保证不同 DAG 的前缀字节完全一致。
  assert.deepEqual(readOnlyDag.map((item) => item.function.name), ['read_tool_result', 'write_file', 'ask_user', 'ptc_run']);
  assert.deepEqual(writableDag.map((item) => item.function.name), ['read_tool_result', 'write_file', 'ask_user', 'ptc_run']);
  const nativeDag = filterWorkerTools(definitions, { hasWrites: false, allowAskUser: false, ptc: false });
  assert.deepEqual(nativeDag.map((item) => item.function.name), ['read_file', 'read_tool_result', 'write_file', 'ask_user']);
});

test('system prompt 不含 allowAskUser/hasWrites 分支，跨 DAG 字节一致', () => {
  const a = buildWorkerSystemPrompt({ allowAskUser: true, hasWrites: true, ptc: true });
  const b = buildWorkerSystemPrompt({ allowAskUser: false, hasWrites: false, ptc: true });
  assert.equal(a, b);
  const native = buildWorkerSystemPrompt({ ptc: false });
  assert.notEqual(a, native);
});

test('Worker PTC 提示词与最新文件密集批读规则一致', () => {
  const prompt = buildWorkerSystemPrompt({ ptc: true });
  assert.match(prompt, /files\.readMany/);
  assert.match(prompt, /≤50/);
  assert.match(prompt, /24000/);
  assert.doesNotMatch(prompt, /最多读取 8 个文件/);
  assert.doesNotMatch(prompt, /1500 行或 60KB/);
});

test('PTC 工具描述包含分页、批量上限、超大文件与结果截断说明', () => {
  const description = buildPtcToolDefinition().function.description;
  assert.match(description, /nextOffset/);
  assert.match(description, /max 50 paths/);
  assert.match(description, /skippedLarge/);
  assert.match(description, /24000/);
  assert.doesNotMatch(description, /at most 8 files/);
});

test('只读任务在用户消息里显式声明只读，避免误调用写工具', () => {
  const prompt = buildWorkerUserPrompt(task(), plan, []);
  assert.match(prompt, /本子任务只读/);
  const writable = buildWorkerUserPrompt(task({ writeFiles: ['server/a.js'] }), plan, []);
  assert.match(writable, /# 允许修改/);
  assert.doesNotMatch(writable, /本子任务只读/);
});

test('尾部硬预算：超长简报与上游结果被截断且整体不超过预算', () => {
  const longTask = task({ brief: 'B'.repeat(9000), expectedOutput: 'E'.repeat(3000) });
  const upstream = Array.from({ length: 4 }, (_, index) => ({
    taskId: `t${index}`,
    title: '上游',
    status: 'completed',
    result: 'R'.repeat(5000),
    evidence: ['e'.repeat(2000)],
    confidence: 0.9
  }));
  const prompt = buildWorkerUserPrompt(longTask, plan, upstream, { maxChars: 3000 });
  assert.ok(prompt.length <= 3000, `len=${prompt.length}`);
  assert.ok(prompt.includes('# 子任务'));
  assert.ok(prompt.includes('# 期望输出'));

  const tight = buildWorkerUserPrompt(longTask, plan, upstream, { maxChars: 900 });
  assert.ok(tight.length <= 900, `len=${tight.length}`);
});

test('尾部长度的边界值：恰好等于预算不截断，多 1 字符即截断', () => {
  const baseTask = task({
    title: '边界',
    brief: 'b'.repeat(900),
    expectedOutput: 'out',
    constraints: [],
    readFiles: [],
    writeFiles: [],
    knownInfo: ''
  });
  const full = buildWorkerUserPrompt(baseTask, plan, [], { maxChars: 4000 });
  assert.ok(full.length > 600);
  const exact = buildWorkerUserPrompt(baseTask, plan, [], { maxChars: full.length });
  assert.equal(exact, full);
  const clipped = buildWorkerUserPrompt(baseTask, plan, [], { maxChars: full.length - 1 });
  assert.ok(clipped.length <= full.length - 1, `${clipped.length} vs ${full.length}`);
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
