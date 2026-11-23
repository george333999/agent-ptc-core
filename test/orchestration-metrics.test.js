import test from 'node:test';
import assert from 'node:assert/strict';
import {
  median,
  percentile,
  computeStragglerRatio,
  computeParallelEfficiency,
  summarizeOrchestrationMetrics
} from '../server/orchestration-metrics.js';

test('中位数与分位数对空值与非法值安全', () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([1, 'x', -1, 3]), 2);
  assert.equal(percentile([], 0.9), 0);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.9), 50);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.5), 30);
});

test('落后者比例 = 最慢 / 中位数，忽略 0 与非法值', () => {
  assert.equal(computeStragglerRatio([]), 0);
  assert.equal(computeStragglerRatio([0, 100]), 1);
  assert.equal(computeStragglerRatio([100, 100, 400]), 4);
  assert.equal(computeStragglerRatio([100, 200, 300]), 1.5);
});

test('并行效率被 1 封顶，缺少数据时为 0', () => {
  assert.equal(computeParallelEfficiency({ serialMs: 0, makespanMs: 100, concurrency: 4 }), 0);
  assert.equal(computeParallelEfficiency({ serialMs: 400, makespanMs: 0, concurrency: 4 }), 0);
  assert.equal(computeParallelEfficiency({ serialMs: 800, makespanMs: 200, concurrency: 4 }), 1);
  assert.equal(computeParallelEfficiency({ serialMs: 400, makespanMs: 200, concurrency: 4 }), 0.5);
  assert.equal(computeParallelEfficiency({ serialMs: 800, makespanMs: 200, concurrency: 1 }), 1);
  assert.equal(computeParallelEfficiency({ serialMs: 800, makespanMs: 200, concurrency: 0 }), 1);
});

test('汇总编排指标：完成/部分/失败、排队等待与重派对冲', () => {
  const summary = summarizeOrchestrationMetrics({
    results: [
      { status: 'completed', durationMs: 1000 },
      { status: 'partial', durationMs: 3000 },
      { status: 'failed', durationMs: 500 },
      { status: 'skipped', durationMs: 0 }
    ],
    makespanMs: 4000,
    concurrency: 2,
    queueWaitMs: 250,
    reDispatchCount: 1,
    hedgeCount: 2
  });
  assert.equal(summary.tasks, 4);
  assert.equal(summary.completedCount, 2);
  assert.equal(summary.partialCount, 1);
  assert.equal(summary.failedCount, 2);
  assert.equal(summary.makespanMs, 4000);
  assert.equal(summary.serialWorkerMs, 4500);
  assert.equal(summary.slowestWorkerMs, 3000);
  assert.equal(summary.queueWaitMs, 250);
  assert.equal(summary.reDispatchCount, 1);
  assert.equal(summary.hedgeCount, 2);
  assert.equal(summary.parallelEfficiency, 0.5625);
  assert.equal(summary.stragglerRatio, 3);
});

test('空结果返回全零，不产生 NaN', () => {
  const summary = summarizeOrchestrationMetrics();
  assert.equal(summary.tasks, 0);
  assert.equal(summary.parallelEfficiency, 0);
  assert.equal(summary.stragglerRatio, 0);
  assert.equal(summary.medianWorkerMs, 0);
  assert.equal(Number.isFinite(summary.parallelEfficiency), true);
});
