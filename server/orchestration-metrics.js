// Parallel orchestration observation metrics: statistics only, never used for scheduling decisions.
// Definitions:
// - makespanMs: wall-clock from dispatching the first subtask to the end of the last subtask (human wait already deducted).
// - parallelEfficiency: total serial time / (makespan × concurrency limit); 1 means concurrency is fully utilized.
// - stragglerRatio: slowest subtask / median subtask duration, used to decide whether a soft deadline or hedging is needed.
// - queueWaitMs: sum of time subtasks wait from "ready" until actually acquiring a concurrency slot.

import { cacheSampleFields } from './cache-usage.js';

export function median(values) {
  const list = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (!list.length) return 0;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

export function percentile(values, ratio = 0.9) {
  const list = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (!list.length) return 0;
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil(list.length * Number(ratio)) - 1));
  return list[index];
}

export function computeStragglerRatio(durations) {
  const list = (Array.isArray(durations) ? durations : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!list.length) return 0;
  const middle = median(list);
  if (!middle) return 0;
  return Number((Math.max(...list) / middle).toFixed(3));
}

export function computeParallelEfficiency({ serialMs = 0, makespanMs = 0, concurrency = 1 } = {}) {
  const serial = Math.max(0, Number(serialMs) || 0);
  const makespan = Math.max(0, Number(makespanMs) || 0);
  const slots = Math.max(1, Math.floor(Number(concurrency) || 1));
  if (!serial || !makespan) return 0;
  return Number(Math.min(1, serial / (makespan * slots)).toFixed(4));
}

export function summarizeOrchestrationMetrics({
  results = [],
  makespanMs = 0,
  concurrency = 1,
  queueWaitMs = 0,
  reDispatchCount = 0,
  hedgeCount = 0
} = {}) {
  const list = Array.isArray(results) ? results : [];
  const durations = list.map((result) => Math.max(0, Number(result?.durationMs) || 0));
  const serialMs = durations.reduce((total, value) => total + value, 0);
  const statuses = list.map((result) => String(result?.status || ''));
  const partialCount = statuses.filter((status) => status === 'partial').length;
  const failedCount = statuses.filter((status) => ['failed', 'timeout', 'aborted', 'skipped'].includes(status)).length;
  const completedCount = statuses.filter((status) => ['completed', 'partial'].includes(status)).length;
  return {
    tasks: list.length,
    completedCount,
    partialCount,
    failedCount,
    makespanMs: Math.max(0, Number(makespanMs) || 0),
    serialWorkerMs: serialMs,
    concurrency: Math.max(1, Math.floor(Number(concurrency) || 1)),
    parallelEfficiency: computeParallelEfficiency({
      serialMs,
      makespanMs,
      concurrency
    }),
    stragglerRatio: computeStragglerRatio(durations),
    slowestWorkerMs: durations.length ? Math.max(...durations) : 0,
    medianWorkerMs: median(durations),
    queueWaitMs: Math.max(0, Number(queueWaitMs) || 0),
    reDispatchCount: Math.max(0, Math.floor(Number(reDispatchCount) || 0)),
    hedgeCount: Math.max(0, Math.floor(Number(hedgeCount) || 0))
  };
}

/**
 * Worker cache dimension aggregation.
 * Only first-round calls where the provider actually reported cache fields are counted; locally derived values do not enter the hit rate.
 * - firstCallHitRate: first-round hit tokens / (hit + miss)
 * - uniqueTailTokens: total tokens across all Workers' exclusive tails
 * - prefixHashCount: number of distinct prefix hashes seen (normally 1)
 * - p95WorkerMs: subtask duration p95
 * - costPerSuccess: estimated cost / successful subtasks
 */
export function summarizeWorkerCache({ results = [], usage = null, prices = {}, completed = 0 } = {}) {
  const list = Array.isArray(results) ? results : [];
  let hit = 0;
  let miss = 0;
  for (const result of list) {
    const fields = result?.firstStepUsage ? cacheSampleFields(result.firstStepUsage) : null;
    if (!fields || !fields.cacheReported) continue;
    hit += fields.cacheHitTokens;
    miss += fields.cacheMissTokens;
  }
  const firstCallHitRate = hit + miss > 0 ? Number((hit / (hit + miss)).toFixed(4)) : null;
  const uniqueTailTokens = Math.ceil(list.reduce((total, result) => total + (Number(result?.tailChars) || 0), 0) / 2.5);
  const prefixHashCount = new Set(list.map((result) => result?.frozenPrefixHash).filter(Boolean)).size;
  const p95WorkerMs = percentile(list.map((result) => result?.durationMs || 0), 0.95);
  const hitTokens = Number(usage?.cache_hit_tokens) || 0;
  const missTokens = Number(usage?.cache_miss_tokens) || 0;
  const estimatedCost = missTokens * (Number(prices?.cacheMiss) || 0)
    + hitTokens * (Number(prices?.cacheHit) || 0);
  const successCount = Math.max(0, Math.floor(Number(completed) || 0));
  return {
    firstCallHitRate,
    uniqueTailTokens,
    prefixHashCount,
    p95WorkerMs,
    estimatedCost,
    costPerSuccess: successCount > 0 ? Number((estimatedCost / successCount).toFixed(8)) : 0
  };
}
