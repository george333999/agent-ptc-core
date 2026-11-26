import test from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile,
  summarizeTurns,
  estimateCostCny,
  computeTokenTimeTradeoff,
  DEFAULT_BENCHMARK_PRICING,
  DEEPSEEK_OFFICIAL_PRICING,
  isDeepSeekPeakTime,
  deepSeekOfficialPricing
} from '../server/benchmark-metrics.js';

test('percentile and empty input are safe', () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);
  assert.equal(percentile([1, 2, 3], -1), 1);
});

test('summarize wall-clock, output tokens, turns and accuracy', () => {
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

test('summarize PTC coverage: computed by tool rounds', () => {
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

test('summarize per-phase latency: time to first token, decode, tools, approval and orchestration', () => {
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

test('cost estimation and token-time tradeoff ratio', () => {
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
  assert.equal(estimateCostCny(base), 0.16);
  assert.equal(estimateCostCny(optimized), 0.18);
  const tradeoff = computeTokenTimeTradeoff(base, optimized, { timeCostCnyPerMinute: 0.01 });
  assert.equal(tradeoff.inputSavedCny, 0.06);
  assert.equal(tradeoff.outputAddedCny, 0.08);
  assert.ok(tradeoff.timeAddedCny > 0);
  assert.equal(typeof tradeoff.tradeoff, 'number');
});

test('default prices use DeepSeek official off-peak price: 0.02 / 1 / 4 CNY per million', () => {
  const perMillion = (value) => Number((value * 1e6).toFixed(6));
  assert.equal(perMillion(DEFAULT_BENCHMARK_PRICING.cacheHitPrice), 0.02);
  assert.equal(perMillion(DEFAULT_BENCHMARK_PRICING.cacheMissPrice), 1);
  assert.equal(perMillion(DEFAULT_BENCHMARK_PRICING.outputPrice), 4);
  assert.deepEqual(DEEPSEEK_OFFICIAL_PRICING.offPeak, { cacheHit: 0.02, cacheMiss: 1, output: 4 });
  assert.deepEqual(DEEPSEEK_OFFICIAL_PRICING.peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 });

  const summary = { cacheHitTokens: 1_000_000, cacheMissTokens: 1_000_000, completionTokens: 1_000_000 };
  assert.equal(estimateCostCny(summary), 5.02);
  assert.equal(estimateCostCny(summary, { cacheHitPrice: 0.3 / 1e6, cacheMissPrice: 3 / 1e6, outputPrice: 9 / 1e6 }), 12.3);
});

test('DeepSeek official peak/off-peak price switches on Beijing time Monday-Friday 9-12, 14-18', () => {
  // 2026-11-22 is Sunday; 2026-11-23 is Monday.
  assert.equal(isDeepSeekPeakTime(Date.parse('2026-11-22T10:00:00+08:00')), false);
  assert.equal(isDeepSeekPeakTime(Date.parse('2026-11-23T08:59:00+08:00')), false);
  assert.equal(isDeepSeekPeakTime(Date.parse('2026-11-23T09:00:00+08:00')), true);
  assert.equal(isDeepSeekPeakTime(Date.parse('2026-11-23T12:00:00+08:00')), false);
  assert.equal(isDeepSeekPeakTime(Date.parse('2026-11-23T14:30:00+08:00')), true);
  assert.equal(isDeepSeekPeakTime(Date.parse('2026-11-23T18:00:00+08:00')), false);

  const offPeak = deepSeekOfficialPricing(Date.parse('2026-11-22T14:30:00+08:00'));
  assert.equal(offPeak.tier, 'offPeak');
  assert.equal(Number((offPeak.outputPrice * 1e6).toFixed(6)), 4);
  const peak = deepSeekOfficialPricing(Date.parse('2026-11-23T14:30:00+08:00'));
  assert.equal(peak.tier, 'peak');
  assert.equal(Number((peak.cacheHitPrice * 1e6).toFixed(6)), 0.04);
  assert.equal(Number((peak.cacheMissPrice * 1e6).toFixed(6)), 2);
  assert.equal(Number((peak.outputPrice * 1e6).toFixed(6)), 8);
});

test('cost computed by official unit price matches token breakdown', () => {
  const prices = { cacheHitPrice: 0.02 / 1e6, cacheMissPrice: 1 / 1e6, outputPrice: 4 / 1e6 };
  const totals = { cacheHitTokens: 451968, cacheMissTokens: 35323, completionTokens: 6051 };
  const expected = (451968 / 1e6) * 0.02 + (35323 / 1e6) * 1 + (6051 / 1e6) * 4;
  assert.equal(estimateCostCny(totals, prices), Number(expected.toFixed(6)));

  const base = { cacheHitTokens: 500000, cacheMissTokens: 40000, completionTokens: 6000, wallClockMs: 60000 };
  const optimized = { cacheHitTokens: 450000, cacheMissTokens: 35000, completionTokens: 6000, wallClockMs: 60000 };
  const tradeoff = computeTokenTimeTradeoff(base, optimized, { prices });
  assert.equal(tradeoff.baseCostCny, estimateCostCny(base, prices));
  assert.equal(tradeoff.optimizedCostCny, estimateCostCny(optimized, prices));
  assert.equal(Number((tradeoff.baseCostCny - tradeoff.optimizedCostCny).toFixed(6)), tradeoff.inputSavedCny);
});

test('tradeoff ratio is infinite when there is no extra output or extra time', () => {
  const base = { cacheHitTokens: 1000, cacheMissTokens: 1000, completionTokens: 100, wallClockMs: 1000 };
  const optimized = { cacheHitTokens: 500, cacheMissTokens: 500, completionTokens: 100, wallClockMs: 1000 };
  const tradeoff = computeTokenTimeTradeoff(base, optimized, { timeCostCnyPerMinute: 0.01 });
  assert.equal(tradeoff.tradeoff, Infinity);
});
