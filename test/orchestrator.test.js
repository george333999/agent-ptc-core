import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOrchestration, validateOrchestrationPlan } from '../src/orchestrator.js';

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-core-orch-'));
}

function plan(overrides = {}) {
  return {
    goal: '并行分析两个目录',
    estimatedMinutes: 12,
    decompositionCostMinutes: 1,
    maxConcurrency: 2,
    subtasks: [
      { id: 't1', title: 'A', brief: 'a', expectedOutput: 'a' },
      { id: 't2', title: 'B', brief: 'b', expectedOutput: 'b' }
    ],
    ...overrides
  };
}

function done(task) {
  return {
    taskId: task.id,
    title: task.title,
    status: 'completed',
    result: `完成 ${task.id}`,
    evidence: [task.id],
    confidence: 0.9,
    open_questions: [],
    writes: [],
    durationMs: 10,
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    structured: true
  };
}

test('plan：拒绝低收益拆分和依赖环', () => {
  const root = workspace();
  try {
    assert.throws(
      () => validateOrchestrationPlan(plan({ estimatedMinutes: 2 }), { workspace: root }),
      /不值得扇出/
    );
    assert.throws(
      () => validateOrchestrationPlan(plan({
        subtasks: [
          { id: 't1', title: 'A', brief: 'a', expectedOutput: 'a', dependsOn: ['t2'] },
          { id: 't2', title: 'B', brief: 'b', expectedOutput: 'b', dependsOn: ['t1'] }
        ]
      }), { workspace: root }),
      /存在环/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('orchestrator：并行执行并汇总 worker usage', async () => {
  const root = workspace();
  try {
    const result = await runOrchestration({
      plan: plan(),
      workspace: root,
      settings: {},
      model: { name: 'demo' },
      workerRunner: async ({ task }) => done(task)
    });
    assert.equal(result.results.length, 2);
    assert.equal(result.meta.completed, 2);
    assert.equal(result.meta.usage.total_tokens, 240);
    assert.equal(result.metrics.workerUsage.total_tokens, 240);
    assert.match(result.text, /并行编排结果/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('orchestrator：熔断时已启动 worker 先落定', async () => {
  const root = workspace();
  try {
    const result = await runOrchestration({
      plan: plan({
        maxConcurrency: 3,
        subtasks: [
          { id: 't1', title: 'A', brief: 'a', expectedOutput: 'a' },
          { id: 't2', title: 'B', brief: 'b', expectedOutput: 'b' },
          { id: 't3', title: 'C', brief: 'c', expectedOutput: 'c' },
          { id: 't4', title: 'D', brief: 'd', expectedOutput: 'd' }
        ]
      }),
      workspace: root,
      settings: {},
      model: { name: 'demo' },
      workerRunner: async ({ task }) => {
        if (task.id === 't1' || task.id === 't2') {
          return { ...done(task), status: 'failed', result: 'boom', confidence: 0 };
        }
        if (task.id === 't3') {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return done(task);
        }
        return done(task);
      }
    });
    const byId = new Map(result.results.map((item) => [item.taskId, item]));
    assert.equal(byId.get('t3').status, 'completed');
    assert.equal(byId.get('t4').status, 'skipped');
    assert.equal(byId.get('t4').skipReason, 'CIRCUIT_OPEN');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
