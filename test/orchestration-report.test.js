import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOrchestrationReport } from '../server/orchestration-report.js';

function metrics(extra = {}) {
  return {
    completed: 2,
    tasks: 3,
    concurrency: 2,
    criticalPathTasks: 2,
    expectedSpeedup: 1.5,
    serialWorkerMs: 9000,
    wallMs: 6000,
    parallelSavedMs: 3000,
    workerTokens: 12000,
    baselineTokens: 30000,
    tokenSaved: 18000,
    tokenSavedPercent: 60,
    approvalWaitMs: 1000,
    humanWaitMs: 0,
    computeMs: 5000,
    economics: { speedup: 1.5, tokenOverheadRatio: 1.2, reason: '' },
    economicsGate: 'OK',
    ...extra
  };
}

const plan = {
  goal: 'analyze three modules in parallel',
  estimatedMinutes: 6,
  decompositionCostMinutes: 2
};

const results = [
  {
    taskId: 't1',
    title: 'Analyze A',
    status: 'completed',
    confidence: 0.9,
    durationMs: 2000,
    result: 'Conclusions for A',
    evidence: ['src/a.js:10'],
    open_questions: []
  },
  {
    taskId: 't2',
    title: 'Analyze B',
    status: 'partial',
    confidence: 0.5,
    durationMs: 2500,
    result: 'Partial conclusions for B',
    evidence: [],
    open_questions: ['Source of B configuration unknown']
  }
];

test('report contains goal, completion, subtask results and resource usage', () => {
  const text = formatOrchestrationReport({
    plan,
    results,
    conflicts: [],
    needsArbitration: false,
    metrics: metrics()
  });
  assert.match(text, /## Parallel orchestration results/);
  assert.match(text, /analyze three modules in parallel/);
  assert.match(text, /2\/3 subtasks succeeded/);
  assert.match(text, /\[t1\] Analyze A — completed/);
  assert.match(text, /\[t2\] Analyze B — partially completed/);
  assert.match(text, /Open questions: Source of B configuration unknown/);
  assert.match(text, /actual savings about 18000 tokens \(60%\)/);
  assert.match(text, /No conflicts requiring arbitration found/);
  assert.match(text, /do not re-execute completed subtasks/);
});

test('conflicts are shown by severity and main Agent arbitration is required', () => {
  const text = formatOrchestrationReport({
    plan,
    results,
    conflicts: [
      { severity: 'high', message: 'two subtasks modified the same file' },
      { severity: 'low', message: 'inconsistent naming style' }
    ],
    needsArbitration: true,
    metrics: metrics({ completed: 0 })
  });
  assert.match(text, /- \[high\] two subtasks modified the same file/);
  assert.match(text, /- \[low\] inconsistent naming style/);
  assert.match(text, /Main Agent arbitration required/);
});
