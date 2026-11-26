import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkerSystemPrompt,
  buildWorkerUserPrompt,
  filterWorkerTools,
  workerAllowedTools
} from '../server/worker-prompt.js';

const plan = { goal: 'Complete a multi-step refactor' };

function task(overrides = {}) {
  return {
    id: 't1',
    title: 'Analyze entry',
    brief: 'Read the entry file and list the call chain',
    constraints: ['Do not modify files'],
    knownInfo: '',
    readFiles: ['server/index.js'],
    writeFiles: [],
    expectedOutput: 'Conclusion and evidence',
    ...overrides
  };
}

test('the system prompt is identical across different subtasks within the same DAG', () => {
  const first = buildWorkerSystemPrompt({ allowAskUser: true, ptc: true });
  const second = buildWorkerSystemPrompt({ allowAskUser: true, ptc: true });
  assert.equal(first, second);
});

test('Task ID, title, brief, and upstream results only appear in the user message', () => {
  const system = buildWorkerSystemPrompt({ allowAskUser: false, ptc: true });
  const taskA = task();
  const taskB = task({ id: 't2', title: 'Modify implementation', brief: 'Only modify server/agent.js' });
  const userA = buildWorkerUserPrompt(taskA, plan, []);
  const userB = buildWorkerUserPrompt(taskB, plan, [
    { taskId: 't1', title: 'Analyze entry', status: 'completed', result: 'The call chain is A -> B', evidence: ['server/index.js:1'], confidence: 0.9 }
  ]);
  assert.ok(!system.includes('t1'));
  assert.ok(!system.includes('Analyze entry'));
  assert.ok(userA.includes('[t1] Analyze entry'));
  assert.ok(userB.includes('[t2] Modify implementation'));
  assert.ok(userB.includes('The call chain is A -> B'));
  assert.ok(system.includes('Cache-friendly'));
});

test('DAG-level tool set is canonical and fixed: independent of writes/questions', () => {
  const definitions = [
    { type: 'function', function: { name: 'read_file' } },
    { type: 'function', function: { name: 'read_tool_result' } },
    { type: 'function', function: { name: 'write_file' } },
    { type: 'function', function: { name: 'ask_user' } },
    { type: 'function', function: { name: 'ptc_run' } }
  ];
  const readOnlyDag = filterWorkerTools(definitions, { hasWrites: false, allowAskUser: false, ptc: true });
  const writableDag = filterWorkerTools(definitions, { hasWrites: true, allowAskUser: true, ptc: true });
  // Canonical tool set: determined only by toolMode, ensuring the prefix bytes are identical across different DAGs.
  assert.deepEqual(readOnlyDag.map((item) => item.function.name), ['read_tool_result', 'write_file', 'ask_user', 'ptc_run']);
  assert.deepEqual(writableDag.map((item) => item.function.name), ['read_tool_result', 'write_file', 'ask_user', 'ptc_run']);
  const nativeDag = filterWorkerTools(definitions, { hasWrites: false, allowAskUser: false, ptc: false });
  assert.deepEqual(nativeDag.map((item) => item.function.name), ['read_file', 'read_tool_result', 'write_file', 'ask_user']);
});

test('Worker PTC prompt uses the new batch-read limits and no longer caps at 8 files', () => {
  const prompt = buildWorkerSystemPrompt({ ptc: true });
  assert.match(prompt, /files\.readMany/);
  assert.match(prompt, /≤50/);
  assert.match(prompt, /24000/);
  assert.doesNotMatch(prompt, /read at most 8 files/);
  assert.doesNotMatch(prompt, /1500 lines or 60KB/);
});

test('system prompt has no allowAskUser/hasWrites branches and is byte-identical across DAGs', () => {
  const a = buildWorkerSystemPrompt({ allowAskUser: true, hasWrites: true, ptc: true });
  const b = buildWorkerSystemPrompt({ allowAskUser: false, hasWrites: false, ptc: true });
  assert.equal(a, b);
  const native = buildWorkerSystemPrompt({ ptc: false });
  assert.notEqual(a, native);
});

test('read-only tasks explicitly declare read-only in the user message, avoiding accidental write calls', () => {
  const prompt = buildWorkerUserPrompt(task(), plan, []);
  assert.match(prompt, /This subtask is read-only/);
  const writable = buildWorkerUserPrompt(task({ writeFiles: ['server/a.js'] }), plan, []);
  assert.match(writable, /# Allowed modifications/);
  assert.doesNotMatch(writable, /This subtask is read-only/);
});

test('Tail hard budget: overly long brief and upstream results are truncated and the total stays within budget', () => {
  const longTask = task({ brief: 'B'.repeat(9000), expectedOutput: 'E'.repeat(3000) });
  const upstream = Array.from({ length: 4 }, (_, index) => ({
    taskId: `t${index}`,
    title: 'Upstream',
    status: 'completed',
    result: 'R'.repeat(5000),
    evidence: ['e'.repeat(2000)],
    confidence: 0.9
  }));
  const prompt = buildWorkerUserPrompt(longTask, plan, upstream, { maxChars: 3000 });
  assert.ok(prompt.length <= 3000, `len=${prompt.length}`);
  assert.ok(prompt.includes('# Subtask'));
  assert.ok(prompt.includes('# Expected output'));

  const tight = buildWorkerUserPrompt(longTask, plan, upstream, { maxChars: 900 });
  assert.ok(tight.length <= 900, `len=${tight.length}`);
});

test('Tail length boundary: exactly at budget is not truncated, one extra character is truncated', () => {
  const baseTask = task({
    title: 'Boundary',
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

test('sub-agent does not self-check and only consumes the definition of done and assumptions issued by the main agent', () => {
  const system = buildWorkerSystemPrompt({ ptc: true });
  assert.match(system, /Socratic self-questioning/);
  const contractPlan = {
    goal: 'Refactor the entry point',
    definitionOfDone: ['All tests pass', 'Produce a migration report'],
    assumptions: ['The legacy interface can be kept for one version']
  };
  const prompt = buildWorkerUserPrompt(task(), contractPlan, []);
  assert.match(prompt, /# /);
  assert.match(prompt, /All tests pass/);
  assert.match(prompt, /The legacy interface can be kept for one version/);
  // Self-check questions belong only to the main agent and must not be dispatched to the sub-agent for repeated reasoning.
  assert.doesNotMatch(prompt, /what is the real goal/i);

  const plain = buildWorkerUserPrompt(task(), plan, []);
  // When the main agent gives no definition of done, the worker must not pretend it has self-checked; instead it explicitly accepts the expected output and marks partial when information is missing.
  assert.match(plain, /No global definition of done provided/);
  assert.match(plain, /open_questions/);
  assert.doesNotMatch(buildWorkerSystemPrompt({ ptc: true }), /task self-check completed/);
});

test('definition of done does not crowd out the read-only permission statement under a tight budget', () => {
  const contractPlan = {
    goal: 'Boundary',
    definitionOfDone: Array.from({ length: 6 }, () => 'D'.repeat(200)),
    assumptions: []
  };
  const prompt = buildWorkerUserPrompt(task(), contractPlan, [], { maxChars: 2000 });
  assert.ok(prompt.length <= 2000, `len=${prompt.length}`);
  assert.match(prompt, /This subtask is read-only/);
});

test('boundary input safety: empty task and empty tool list', () => {
  const allowed = workerAllowedTools({}, {});
  assert.ok(allowed.has('read_file'));
  assert.ok(!allowed.has('write_file'));
  assert.deepEqual(filterWorkerTools(undefined, {}), []);
  assert.deepEqual(filterWorkerTools([], {}), []);
  assert.ok(workerAllowedTools(undefined, {}).has('read_file'));
});

test('execution-time permissions converge per subtask and stay consistent with the schema exposed by PTC', () => {
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
