import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnMetrics } from '../server/latency-metrics.js';

test('延迟拆解累计模型、工具、落盘与 token 口径', () => {
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

test('重复读取率只统计只读工具，并按工具+参数识别重复', () => {
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

test('空指标与未闭合的模型计时安全返回', () => {
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

test('拆解首字等待、解码、审批等待与编排开销', () => {
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

test('用户思考与操作期间不计入有效耗时', () => {
  let clock = 0;
  const metrics = createTurnMetrics(() => clock);
  metrics.startLlm();
  clock = 1000;
  metrics.endLlm();
  // 模拟澄清提问等待用户 10 分钟。
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

test('没有首字增量时全部模型时间计入首字等待', () => {
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

test('PTC 覆盖率按工具轮次统计，空轮次安全返回 0', () => {
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

test('多次调用的首字等待和解码时间累加', () => {
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

test('按阶段归因调用次数、首字等待与 miss token', () => {
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

test('预取命中与编排指标通过快照暴露', () => {
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

test('缓存上报只认显式 cache_reported=true', () => {
  const metrics = createTurnMetrics();
  metrics.addUsage({ prompt_tokens: 100, completion_tokens: 1, cache_hit_tokens: 40 });
  assert.equal(metrics.snapshot().cacheReported, false);
  assert.equal(metrics.snapshot().cachePartial, false);
});

test('全部步骤显式上报缓存时 turnMetrics 标记已上报', () => {
  const metrics = createTurnMetrics();
  metrics.addUsage({ prompt_tokens: 100, completion_tokens: 1, cache_hit_tokens: 80, cache_miss_tokens: 20, cache_reported: true });
  metrics.addUsage({ prompt_tokens: 50, completion_tokens: 1, cache_hit_tokens: 0, cache_miss_tokens: 50, cache_reported: true });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.cacheReported, true);
  assert.equal(snapshot.cachePartial, false);
  assert.equal(snapshot.cacheHitTokens, 80);
  assert.equal(snapshot.cacheMissTokens, 70);
});

test('部分步骤未显式上报缓存时保留已上报数据并标记部分', () => {
  const metrics = createTurnMetrics();
  metrics.addUsage({ prompt_tokens: 100, completion_tokens: 1, cache_hit_tokens: 80, cache_miss_tokens: 20, cache_reported: true });
  metrics.addUsage({ prompt_tokens: 100, completion_tokens: 1 });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.cacheReported, true);
  assert.equal(snapshot.cachePartial, true);
  assert.equal(snapshot.cacheHitTokens, 80);
  assert.equal(snapshot.cacheMissTokens, 20);
});

test('异常用量字段不会污染缓存汇总', () => {
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
