import test from 'node:test';
import assert from 'node:assert/strict';
import {
  median,
  percentile,
  computeStragglerRatio,
  computeParallelEfficiency,
  summarizeOrchestrationMetrics,
  summarizeWorkerCache
} from '../server/orchestration-metrics.js';

test('median and percentile are safe for empty and invalid values', () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([1, 'x', -1, 3]), 2);
  assert.equal(percentile([], 0.9), 0);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.9), 50);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.5), 30);
});

test('straggler ratio = slowest / median, ignoring 0 and invalid values', () => {
  assert.equal(computeStragglerRatio([]), 0);
  assert.equal(computeStragglerRatio([0, 100]), 1);
  assert.equal(computeStragglerRatio([100, 100, 400]), 4);
  assert.equal(computeStragglerRatio([100, 200, 300]), 1.5);
});

test('parallel efficiency is capped at 1 and is 0 without data', () => {
  assert.equal(computeParallelEfficiency({ serialMs: 0, makespanMs: 100, concurrency: 4 }), 0);
  assert.equal(computeParallelEfficiency({ serialMs: 400, makespanMs: 0, concurrency: 4 }), 0);
  assert.equal(computeParallelEfficiency({ serialMs: 800, makespanMs: 200, concurrency: 4 }), 1);
  assert.equal(computeParallelEfficiency({ serialMs: 400, makespanMs: 200, concurrency: 4 }), 0.5);
  assert.equal(computeParallelEfficiency({ serialMs: 800, makespanMs: 200, concurrency: 1 }), 1);
  assert.equal(computeParallelEfficiency({ serialMs: 800, makespanMs: 200, concurrency: 0 }), 1);
});

test('summarize orchestration metrics: completed/partial/failed, queue wait and re-dispatch hedging', () => {
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

test('empty results return all zeros without NaN', () => {
  const summary = summarizeOrchestrationMetrics();
  assert.equal(summary.tasks, 0);
  assert.equal(summary.parallelEfficiency, 0);
  assert.equal(summary.stragglerRatio, 0);
  assert.equal(summary.medianWorkerMs, 0);
  assert.equal(Number.isFinite(summary.parallelEfficiency), true);
});

test('Worker cache aggregation: first-round hit rate only counts provider-reported fields', () => {
  const summary = summarizeWorkerCache({
    results: [
      { tailChars: 2000, frozenPrefixHash: 'h1', durationMs: 100, firstStepUsage: { prompt_tokens: 3000, prompt_cache_hit_tokens: 2000, prompt_cache_miss_tokens: 1000 } },
      { tailChars: 1000, frozenPrefixHash: 'h1', durationMs: 200, firstStepUsage: { prompt_tokens: 3000, prompt_cache_hit_tokens: 2500, prompt_cache_miss_tokens: 500 } },
      // A Worker without cache fields does not enter the hit rate, but still counts toward tail and hash.
      { tailChars: 500, frozenPrefixHash: 'h1', durationMs: 300, firstStepUsage: { prompt_tokens: 3000 } },
      // A Worker with no first-round usage at all only contributes duration.
      { tailChars: 0, durationMs: 400 }
    ],
    usage: { cache_hit_tokens: 4500, cache_miss_tokens: 1500 },
    prices: { cacheHit: 2e-8, cacheMiss: 1e-6 },
    completed: 2
  });
  assert.equal(summary.firstCallHitRate, 0.75);
  assert.equal(summary.uniqueTailTokens, Math.ceil((2000 + 1000 + 500) / 2.5));
  assert.equal(summary.prefixHashCount, 1);
  assert.equal(summary.p95WorkerMs, 400);
  assert.ok(Math.abs(summary.estimatedCost - (1500 * 1e-6 + 4500 * 2e-8)) < 1e-12);
  assert.ok(Math.abs(summary.costPerSuccess - summary.estimatedCost / 2) < 1e-12);
});

test('Worker cache aggregation boundaries: empty input and no cache reporting', () => {
  const empty = summarizeWorkerCache();
  assert.equal(empty.firstCallHitRate, null);
  assert.equal(empty.uniqueTailTokens, 0);
  assert.equal(empty.prefixHashCount, 0);
  assert.equal(empty.costPerSuccess, 0);

  const unreported = summarizeWorkerCache({
    results: [{ firstStepUsage: { prompt_tokens: 100 } }],
    completed: 0
  });
  assert.equal(unreported.firstCallHitRate, null);
  assert.equal(unreported.costPerSuccess, 0);
});
