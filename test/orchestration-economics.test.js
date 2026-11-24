import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrchestrationSkipResult,
  estimateOrchestrationEconomics,
  evaluateEconomicsGate
} from '../server/orchestration-economics.js';

test('四个独立任务：串行 4 倍工作量，并行约 1 倍 + 开销', () => {
  const economics = estimateOrchestrationEconomics({
    taskCount: 4,
    criticalPathTasks: 1,
    taskSeconds: 25,
    overheadMs: 2000
  });
  assert.equal(economics.ok, true);
  assert.equal(economics.serialMs, 100000);
  assert.equal(economics.parallelMs, 27000);
  assert.equal(economics.speedup, 3.704);
});

test('线性依赖链没有并行收益，门禁判定不划算', () => {
  const economics = estimateOrchestrationEconomics({
    taskCount: 4,
    criticalPathTasks: 4,
    taskSeconds: 25,
    overheadMs: 2000
  });
  assert.equal(economics.ok, false);
  assert.equal(economics.code, 'NOT_PROFITABLE');
  assert.equal(economics.speedup, 0.98);
  assert.match(economics.reason, /加速比/);
});

test('边界值：加速比恰好 1.2 通过，降到 1.199 被拒绝', () => {
  // serial = 3 × 10s = 30000ms；parallel = 2 × 10s + 5000ms = 25000ms → 1.2
  const exact = estimateOrchestrationEconomics({
    taskCount: 3,
    criticalPathTasks: 2,
    taskSeconds: 10,
    overheadMs: 5000
  });
  assert.equal(exact.speedup, 1.2);
  assert.equal(exact.ok, true);

  const below = estimateOrchestrationEconomics({
    taskCount: 3,
    criticalPathTasks: 2,
    taskSeconds: 10,
    overheadMs: 5100
  });
  assert.equal(below.ok, false);
  assert.ok(below.speedup < 1.2);
});

test('token 开销边界：恰好 2 倍通过，超过 2 倍拒绝', () => {
  const exact = estimateOrchestrationEconomics({
    taskCount: 4,
    criticalPathTasks: 1,
    taskSeconds: 25,
    parentContextTokens: 1000,
    prefixTokens: 1500,
    tailTokens: 500
  });
  assert.equal(exact.tokenOverheadRatio, 2);
  assert.equal(exact.ok, true);

  const over = estimateOrchestrationEconomics({
    taskCount: 4,
    criticalPathTasks: 1,
    taskSeconds: 25,
    parentContextTokens: 1000,
    prefixTokens: 1600,
    tailTokens: 500
  });
  assert.ok(over.tokenOverheadRatio > 2);
  assert.equal(over.ok, false);
  assert.match(over.reason, /token/);
});

test('空任务与非法输入不产生 NaN', () => {
  const none = estimateOrchestrationEconomics({});
  assert.equal(none.ok, false);
  assert.equal(none.code, 'NO_TASKS');
  assert.equal(none.speedup, 0);

  const messy = estimateOrchestrationEconomics({
    taskCount: 2,
    criticalPathTasks: 'x',
    taskSeconds: -5,
    overheadMs: 'bad'
  });
  assert.ok(Number.isFinite(messy.speedup));
  assert.ok(messy.speedup > 0);
});

test('门禁模式：advisory 永远放行，enforce 在不划算时拦截', () => {
  const economics = estimateOrchestrationEconomics({
    taskCount: 4,
    criticalPathTasks: 4,
    taskSeconds: 25
  });
  const advisory = evaluateEconomicsGate({ economics, mode: 'advisory' });
  assert.equal(advisory.allowed, true);
  assert.equal(advisory.code, 'NOT_PROFITABLE');

  const enforce = evaluateEconomicsGate({ economics, mode: 'enforce' });
  assert.equal(enforce.allowed, false);
  assert.equal(enforce.code, 'NOT_PROFITABLE');
  assert.equal(enforce.estimate.ok, false);
});

test('拒绝返回体结构完整，可直接被主 Agent 当作串行指令', () => {
  const result = buildOrchestrationSkipResult({
    plan: { tasks: [{ id: 't1' }, { id: 't2' }], maxConcurrency: 2 },
    gate: { allowed: false, code: 'TOO_FEW_TASKS', reason: '任务太少', parallelWidth: 2, maxParallelWidth: 2, criticalPathTasks: 1, criticalPathRatio: 0.5, expectedSpeedup: 2 },
    economics: estimateOrchestrationEconomics({ taskCount: 2, criticalPathTasks: 1 }),
    economicsGate: { allowed: true, code: 'OK' },
    startedAt: Date.now() - 30
  });
  assert.equal(result.meta.action, 'orchestration_skipped');
  assert.equal(result.meta.skipReason, 'TOO_FEW_TASKS');
  assert.equal(result.meta.gate, 'TOO_FEW_TASKS');
  assert.equal(result.metrics.tasks, 2);
  assert.match(result.text, /未启用并行编排/);
  assert.match(result.text, /任务太少/);
  assert.equal(result.results.length, 0);

  // 经济性门禁单独触发时，改用经济性原因。
  const economicsOnly = buildOrchestrationSkipResult({
    plan: { tasks: [{ id: 't1' }, { id: 't2' }], maxConcurrency: 2 },
    gate: { allowed: true, parallelWidth: 2, maxParallelWidth: 2, criticalPathTasks: 1, criticalPathRatio: 0.5, expectedSpeedup: 2 },
    economics: { ok: false, code: 'NOT_PROFITABLE', reason: '加速比不足', speedup: 1, tokenOverheadRatio: 1 },
    economicsGate: { allowed: false, code: 'NOT_PROFITABLE' },
    startedAt: Date.now()
  });
  assert.equal(economicsOnly.meta.skipReason, 'NOT_PROFITABLE');
  assert.match(economicsOnly.text, /并行编排不划算/);
});
