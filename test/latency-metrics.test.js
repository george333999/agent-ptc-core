import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnMetrics } from '../server/latency-metrics.js';

test('latency breakdown accumulates model, tools, persistence and token basis', () => {
  let clock = 0;
  const metrics = createTurnMetrics(() => clock);
  clock = 100;
  metrics.addStep();
  metrics.startLlm();
  clock = 350;
  metrics.endLlm();
  metrics.addToolMs(40);
  metrics.addSaveMs(5);
  metrics.addUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    cache_hit_tokens: 800,
    cache_miss_tokens: 200
  });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.durationMs, 350);
  assert.equal(snapshot.wallMs, 350);
  assert.equal(snapshot.userWaitMs, 0);
  assert.equal(snapshot.llmMs, 250);
  assert.equal(snapshot.toolMs, 40);
  assert.equal(snapshot.saveMs, 5);
  assert.equal(snapshot.steps, 1);
  assert.equal(snapshot.toolCalls, 1);
  assert.equal(snapshot.completionTokens, 200);
  assert.equal(snapshot.promptTokens, 1000);
  assert.equal(snapshot.cacheHitTokens, 800);
  assert.equal(snapshot.cacheMissTokens, 200);
});

test('repeated read rate counts only read-only tools, identified by tool+args', () => {
  const metrics = createTurnMetrics();
  assert.equal(metrics.recordTool('read_file', { path: 'a.js' }), true);
  assert.equal(metrics.recordTool('read_file', { path: 'a.js' }), true);
  assert.equal(metrics.recordTool('search_files', { query: 'x' }), true);
  assert.equal(metrics.recordTool('write_file', { path: 'a.js' }), false);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.totalReads, 3);
  assert.equal(snapshot.repeatedReads, 1);
  assert.equal(snapshot.repeatedReadRate, 0.3333);
});

test('empty metrics and unclosed model timer return safely', () => {
  let clock = 0;
  const metrics = createTurnMetrics(() => clock);
  metrics.startLlm();
  clock = 50;
  metrics.endLlm();
  metrics.endLlm();
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.llmMs, 50);
  assert.equal(snapshot.llmCalls, 1);
  assert.equal(snapshot.repeatedReadRate, 0);
});

test('break down time to first token, decode, approval wait and orchestration overhead', () => {
  let clock = 0;
  const metrics = createTurnMetrics(() => clock);
  metrics.startLlm();
  clock = 200;
  metrics.markFirstToken();
  clock = 500;
  metrics.endLlm();
  clock = 800;
  metrics.addApprovalWaitMs(300);
  clock = 900;
  metrics.addToolMs(100);
  metrics.addOrchestrationMs({ computeMs: 80, waitMs: 30 });
  clock = 950;
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.wallMs, 950);
  assert.equal(snapshot.userWaitMs, 300);
  assert.equal(snapshot.durationMs, 650);
  assert.equal(snapshot.llmMs, 500);
  assert.equal(snapshot.llmTtftMs, 200);
  assert.equal(snapshot.llmDecodeMs, 300);
  assert.equal(snapshot.approvalWaitMs, 300);
  assert.equal(snapshot.orchestrationMs, 80);
  assert.equal(snapshot.orchestrationWaitMs, 30);
  assert.equal(snapshot.orchestrationCalls, 1);
  assert.equal(snapshot.overheadMs, 50);
});

test('user thinking and action time is excluded from productive latency', () => {
  let clock = 0;
  const metrics = createTurnMetrics(() => clock);
  metrics.startLlm();
  clock = 1000;
  metrics.endLlm();
  // Simulate a clarifying question waiting 10 minutes for the user.
  clock = 601000;
  metrics.addApprovalWaitMs(600000);
  metrics.startLlm();
  clock = 601500;
  metrics.endLlm();
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.wallMs, 601500);
  assert.equal(snapshot.userWaitMs, 600000);
  assert.equal(snapshot.durationMs, 1500);
  assert.equal(snapshot.llmMs, 1500);
  assert.equal(snapshot.overheadMs, 0);
});

test('all model time counts as time to first token when there is no first-token increment', () => {
  let clock = 0;
  const metrics = createTurnMetrics(() => clock);
  metrics.startLlm();
  clock = 120;
  metrics.endLlm();
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.llmTtftMs, 120);
  assert.equal(snapshot.llmDecodeMs, 0);
  assert.equal(snapshot.llmMs, 120);
});

test('PTC coverage is counted by tool rounds; empty rounds safely return 0', () => {
  const metrics = createTurnMetrics();
  metrics.addToolRound(true);
  metrics.addToolRound(false);
  metrics.addToolRound(false);
  metrics.addToolRound();
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.toolRounds, 4);
  assert.equal(snapshot.ptcRounds, 1);
  assert.equal(snapshot.ptcCoverage, 0.25);

  const empty = createTurnMetrics().snapshot();
  assert.equal(empty.toolRounds, 0);
  assert.equal(empty.ptcCoverage, 0);
});

test('time to first token and decode time accumulate across multiple calls', () => {
  let clock = 0;
  const metrics = createTurnMetrics(() => clock);
  metrics.startLlm();
  clock = 100;
  metrics.markFirstToken();
  clock = 300;
  metrics.endLlm();
  metrics.startLlm();
  clock = 400;
  metrics.markFirstToken();
  clock = 900;
  metrics.endLlm();
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.llmCalls, 2);
  assert.equal(snapshot.llmTtftMs, 200);
  assert.equal(snapshot.llmDecodeMs, 700);
});

test('attribute call count, time to first token and miss tokens by phase', () => {
  let clock = 0;
  const metrics = createTurnMetrics(() => clock);
  metrics.setPhase('plan');
  metrics.startLlm();
  clock = 100;
  metrics.endLlm();
  metrics.addUsage({ prompt_tokens: 100, completion_tokens: 10, cache_miss_tokens: 80 });
  metrics.setPhase('execute');
  metrics.startLlm();
  clock = 260;
  metrics.endLlm();
  metrics.addUsage({ prompt_tokens: 200, completion_tokens: 20, cache_miss_tokens: 30 });
  metrics.setPhase('finalize');
  metrics.startLlm();
  clock = 320;
  metrics.endLlm();
  metrics.addUsage({ prompt_tokens: 50, completion_tokens: 5, cache_miss_tokens: 5 });
  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.callsByPhase, { plan: 1, execute: 1, finalize: 1 });
  assert.deepEqual(snapshot.ttftByPhase, { plan: 100, execute: 160, finalize: 60 });
  assert.deepEqual(snapshot.missTokensByPhase, { plan: 80, execute: 30, finalize: 5 });
  assert.equal(snapshot.promptTokensByPhase.plan, 100);
  assert.equal(snapshot.getPhase, undefined);
});

test('prefetch hits and orchestration metrics are exposed through the snapshot', () => {
  const metrics = createTurnMetrics();
  metrics.addPrefetch({ hit: true, chars: 1200 });
  metrics.addPrefetch({ hit: false, chars: 400 });
  metrics.addPrefetch({ hit: true, chars: 800 });
  metrics.setOrchestrationMetrics({
    makespanMs: 900,
    parallelEfficiency: 0.75,
    stragglerRatio: 1.8,
    queueWaitMs: 120,
    partialCount: 1,
    reDispatchCount: 0,
    hedgeCount: 1
  });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.prefetchHits, 2);
  assert.equal(snapshot.prefetchMisses, 1);
  assert.equal(snapshot.prefetchChars, 2400);
  assert.equal(snapshot.prefetchHitRate, 0.6667);
  assert.deepEqual(snapshot.orchestration, {
    makespanMs: 900,
    parallelEfficiency: 0.75,
    stragglerRatio: 1.8,
    queueWaitMs: 120,
    partialCount: 1,
    reDispatchCount: 0,
    hedgeCount: 1
  });
  assert.equal(createTurnMetrics().snapshot().prefetchHitRate, 0);
});

test('cache reporting only accepts explicit cache_reported=true', () => {
  const metrics = createTurnMetrics();
  metrics.addUsage({ prompt_tokens: 100, completion_tokens: 1, cache_hit_tokens: 40 });
  assert.equal(metrics.snapshot().cacheReported, false);
  assert.equal(metrics.snapshot().cachePartial, false);
});

test('turnMetrics marks reported when all steps explicitly report cache', () => {
  const metrics = createTurnMetrics();
  metrics.addUsage({ prompt_tokens: 100, completion_tokens: 1, cache_hit_tokens: 80, cache_miss_tokens: 20, cache_reported: true });
  metrics.addUsage({ prompt_tokens: 50, completion_tokens: 1, cache_hit_tokens: 0, cache_miss_tokens: 50, cache_reported: true });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.cacheReported, true);
  assert.equal(snapshot.cachePartial, false);
  assert.equal(snapshot.cacheHitTokens, 80);
  assert.equal(snapshot.cacheMissTokens, 70);
});

test('keeps reported data and marks partial when some steps do not explicitly report cache', () => {
  const metrics = createTurnMetrics();
  metrics.addUsage({ prompt_tokens: 100, completion_tokens: 1, cache_hit_tokens: 80, cache_miss_tokens: 20, cache_reported: true });
  metrics.addUsage({ prompt_tokens: 100, completion_tokens: 1 });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.cacheReported, true);
  assert.equal(snapshot.cachePartial, true);
  assert.equal(snapshot.cacheHitTokens, 80);
  assert.equal(snapshot.cacheMissTokens, 20);
});

test('abnormal usage fields do not pollute cache totals', () => {
  const metrics = createTurnMetrics();
  metrics.addUsage({
    prompt_tokens: Infinity,
    completion_tokens: -5,
    cache_hit_tokens: -100,
    cache_miss_tokens: NaN,
    cache_reported: true
  });
  metrics.addUsage({
    prompt_tokens: 100,
    completion_tokens: 1,
    cache_hit_tokens: 50,
    cache_miss_tokens: 500,
    cache_reported: true
  });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.promptTokens, 100);
  assert.equal(snapshot.completionTokens, 1);
  assert.equal(snapshot.cacheHitTokens, 50);
  assert.equal(snapshot.cacheMissTokens, 50);
});
