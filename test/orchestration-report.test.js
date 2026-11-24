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
  goal: '并行分析三个模块',
  estimatedMinutes: 6,
  decompositionCostMinutes: 2
};

const results = [
  {
    taskId: 't1',
    title: '分析 A',
    status: 'completed',
    confidence: 0.9,
    durationMs: 2000,
    result: 'A 的结论',
    evidence: ['src/a.js:10'],
    open_questions: []
  },
  {
    taskId: 't2',
    title: '分析 B',
    status: 'partial',
    confidence: 0.5,
    durationMs: 2500,
    result: 'B 的部分结论',
    evidence: [],
    open_questions: ['B 的配置来源未知']
  }
];

test('报告包含目标、完成情况、子任务结果与资源使用', () => {
  const text = formatOrchestrationReport({
    plan,
    results,
    conflicts: [],
    needsArbitration: false,
    metrics: metrics()
  });
  assert.match(text, /## 并行编排结果/);
  assert.match(text, /并行分析三个模块/);
  assert.match(text, /2\/3 个子任务成功/);
  assert.match(text, /\[t1\] 分析 A — 完成/);
  assert.match(text, /\[t2\] 分析 B — 部分完成/);
  assert.match(text, /未解决疑问：B 的配置来源未知/);
  assert.match(text, /实际节省约 18000 tokens（60%）/);
  assert.match(text, /未发现需要仲裁的冲突/);
  assert.match(text, /不要重复执行已完成的子任务/);
});

test('存在冲突时按严重度展示，并要求主 Agent 二次裁决', () => {
  const text = formatOrchestrationReport({
    plan,
    results,
    conflicts: [
      { severity: 'high', message: '两个子任务修改了同一文件' },
      { severity: 'low', message: '命名风格不一致' }
    ],
    needsArbitration: true,
    metrics: metrics({ completed: 0 })
  });
  assert.match(text, /- \[高\] 两个子任务修改了同一文件/);
  assert.match(text, /- \[低\] 命名风格不一致/);
  assert.match(text, /需要主 Agent 二次裁决/);
});
