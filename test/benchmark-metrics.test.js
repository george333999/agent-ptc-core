import test from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile,
  summarizeTurns,
  estimateCostCny,
  computeTokenTimeTradeoff
} from '../server/benchmark-metrics.js';

test('百分位与空输入安全', () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);
  assert.equal(percentile([1, 2, 3], -1), 1);
});

test('汇总墙钟、输出 token、轮次与准确率', () => {
  const summary = summarizeTurns([
    { durationMs: 1000, promptTokens: 100, completionTokens: 20, cacheHitTokens: 80, cacheMissTokens: 20, steps: 3, toolCalls: 2, passed: true },
    { durationMs: 3000, promptTokens: 200, completionTokens: 40, cacheHitTokens: 120, cacheMissTokens: 80, steps: 5, toolCalls: 4, passed: false }
  ]);
  assert.equal(summary.turns, 2);
  assert.equal(summary.wallClockMs, 4000);
  assert.equal(summary.wallClockP50, 1000);
  assert.equal(summary.wallClockP95, 3000);
  assert.equal(summary.completionTokens, 60);
  assert.equal(summary.outputTokensPerTask, 30);
  assert.equal(summary.turnsPerTask, 4);
  assert.equal(summary.accuracy, 0.5);
  assert.equal(summary.cacheHitRate, 0.6667);
  assert.equal(summary.totalTokens, 360);
});

test('汇总 PTC 覆盖率：按工具轮次计算', () => {
  const summary = summarizeTurns([
    { toolRounds: 4, ptcRounds: 2, passed: true },
    { toolRounds: 6, ptcRounds: 1, passed: true }
  ]);
  assert.equal(summary.toolRounds, 10);
  assert.equal(summary.ptcRounds, 3);
  assert.equal(summary.ptcCoverage, 0.3);

  const empty = summarizeTurns([]);
  assert.equal(empty.toolRounds, 0);
  assert.equal(empty.ptcCoverage, 0);
});

test('汇总分阶段耗时：首字、解码、工具、审批与编排', () => {
  const summary = summarizeTurns([
    {
      durationMs: 1000,
      llmMs: 800,
      llmTtftMs: 200,
      llmDecodeMs: 600,
      toolMs: 100,
      approvalWaitMs: 50,
      orchestrationMs: 30,
      passed: true
    },
    {
      durationMs: 3000,
      llmMs: 2000,
      llmTtftMs: 500,
      llmDecodeMs: 1500,
      toolMs: 500,
      approvalWaitMs: 0,
      orchestrationMs: 0,
      passed: true
    }
  ]);
  assert.equal(summary.llmMs, 2800);
  assert.equal(summary.llmTtftMs, 700);
  assert.equal(summary.llmDecodeMs, 2100);
  assert.equal(summary.toolMs, 600);
  assert.equal(summary.approvalWaitMs, 50);
  assert.equal(summary.orchestrationMs, 30);
  assert.equal(summary.llmTtftP50, 200);
  assert.equal(summary.llmTtftP95, 500);
  assert.equal(summary.llmShare, 0.7);
});

test('费用估算与 token-时间折价比值', () => {
  const base = {
    cacheHitTokens: 1000000,
    cacheMissTokens: 100000,
    completionTokens: 10000,
    wallClockMs: 60000
  };
  const optimized = {
    cacheHitTokens: 500000,
    cacheMissTokens: 50000,
    completionTokens: 30000,
    wallClockMs: 120000
  };
  assert.ok(estimateCostCny(base) > estimateCostCny(optimized));
  const tradeoff = computeTokenTimeTradeoff(base, optimized, { timeCostCnyPerMinute: 0.01 });
  assert.ok(tradeoff.inputSavedCny > 0);
  assert.ok(tradeoff.outputAddedCny > 0);
  assert.ok(tradeoff.timeAddedCny > 0);
  assert.equal(typeof tradeoff.tradeoff, 'number');
});

test('没有输出增加和耗时增加时，折价比值为无穷大', () => {
  const base = { cacheHitTokens: 1000, cacheMissTokens: 1000, completionTokens: 100, wallClockMs: 1000 };
  const optimized = { cacheHitTokens: 500, cacheMissTokens: 500, completionTokens: 100, wallClockMs: 1000 };
  const tradeoff = computeTokenTimeTradeoff(base, optimized, { timeCostCnyPerMinute: 0.01 });
  assert.equal(tradeoff.tradeoff, Infinity);
});
