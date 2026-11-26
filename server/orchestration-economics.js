// Economics gate for parallel orchestration: not just "can it run in parallel", but "is parallelism actually cheaper in time/cost".
//
// Inputs come from the DAG structure (critical path, parallel width) and local historical durations;
// the output gives the main Agent two choices: execute directly (serially) or keep orchestrating.
//
// All pure functions, for unit tests and boundary-value tests.

export const DEFAULT_TASK_SECONDS = 25;
export const DEFAULT_ORCHESTRATION_OVERHEAD_MS = 2000;
export const MIN_BREAKEVEN_SPEEDUP = 1.2;
export const MAX_TOKEN_OVERHEAD_RATIO = 2;

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Estimate whether parallelism is worthwhile.
 * @param {object} input
 * @param {number} input.taskCount number of subtasks
 * @param {number} input.criticalPathTasks number of critical-path nodes
 * @param {number} input.taskSeconds estimated duration of a single subtask (seconds)
 * @param {number} input.overheadMs fixed orchestration overhead (prewarm + summary)
 * @param {number} input.parentContextTokens input tokens per step of the parent session (serial baseline)
 * @param {number} input.prefixTokens shared prefix tokens
 * @param {number} input.tailTokens exclusive tail tokens per Worker
 */
export function estimateOrchestrationEconomics({
  taskCount = 0,
  criticalPathTasks = 0,
  taskSeconds = DEFAULT_TASK_SECONDS,
  overheadMs = DEFAULT_ORCHESTRATION_OVERHEAD_MS,
  parentContextTokens = 0,
  prefixTokens = 0,
  tailTokens = 0
} = {}) {
  const count = Math.max(0, Math.floor(Number(taskCount) || 0));
  if (!count) {
    return {
      ok: false,
      code: 'NO_TASKS',
      taskCount: 0,
      speedup: 0,
      serialMs: 0,
      parallelMs: 0,
      tokenOverheadRatio: 1,
      reason: 'No executable subtasks.'
    };
  }
  const seconds = positive(taskSeconds, DEFAULT_TASK_SECONDS);
  const path = Math.min(count, Math.max(1, Math.floor(Number(criticalPathTasks) || count)));
  const serialMs = Math.round(count * seconds * 1000);
  const parallelMs = Math.round(path * seconds * 1000 + positive(overheadMs, DEFAULT_ORCHESTRATION_OVERHEAD_MS));
  const speedup = Number((serialMs / Math.max(1, parallelMs)).toFixed(3));
  // Single-Worker input = shared prefix + exclusive tail; a serial parent turn is roughly parentContextTokens per step.
  const workerInputTokens = count * (Math.max(0, Number(prefixTokens) || 0) + Math.max(0, Number(tailTokens) || 0));
  const baselinePerTask = Math.max(
    0,
    Number(parentContextTokens) || (Math.max(0, Number(prefixTokens) || 0) + Math.max(0, Number(tailTokens) || 0))
  );
  const serialInputTokens = count * baselinePerTask;
  const tokenOverheadRatio = serialInputTokens > 0
    ? Number((workerInputTokens / serialInputTokens).toFixed(3))
    : 1;
  const reasons = [];
  if (speedup < MIN_BREAKEVEN_SPEEDUP) {
    reasons.push(`expected speedup is only ${speedup}× (below ${MIN_BREAKEVEN_SPEEDUP}×), parallel gains do not offset orchestration overhead`);
  }
  if (tokenOverheadRatio > MAX_TOKEN_OVERHEAD_RATIO) {
    reasons.push(`Worker input tokens are ${tokenOverheadRatio}× the serial baseline, exceeding the ${MAX_TOKEN_OVERHEAD_RATIO}× cap`);
  }
  return {
    ok: reasons.length === 0,
    code: reasons.length ? 'NOT_PROFITABLE' : 'OK',
    taskCount: count,
    criticalPathTasks: path,
    speedup,
    serialMs,
    parallelMs,
    workerInputTokens,
    serialInputTokens,
    tokenOverheadRatio,
    reason: reasons.join('; ')
  };
}

/**
 * Decide whether orchestration continues.
 * With mode = 'enforce' it returns allowed=false and the caller falls back to "execute directly";
 * with mode = 'advisory' it only advises and does not change the execution path (default, to avoid killing long-tail tasks).
 */
export function evaluateEconomicsGate({ economics, mode = 'advisory' } = {}) {
  const estimate = economics || estimateOrchestrationEconomics({});
  if (mode === 'enforce' && !estimate.ok) {
    return { allowed: false, mode, code: estimate.code, reason: estimate.reason, estimate };
  }
  return { allowed: true, mode, code: estimate.ok ? 'OK' : estimate.code, reason: estimate.reason, estimate };
}

// Unified response when the fast path is rejected: same structure as a normal orchestration result, so the main Agent can switch to serial execution directly.
export function buildOrchestrationSkipResult({ plan, gate, economics, economicsGate, startedAt }) {
  const wallMs = Math.max(0, Date.now() - (Number(startedAt) || Date.now()));
  const skipCode = gate.allowed ? economicsGate.code : gate.code;
  const skipReason = gate.allowed
    ? `Parallel orchestration is not worthwhile: ${economics.reason}. Execute directly; do not split into parallel subtasks.`
    : gate.reason;
  const profile = {
    parallelWidth: gate.parallelWidth,
    maxParallelWidth: gate.maxParallelWidth,
    criticalPathTasks: gate.criticalPathTasks,
    criticalPathRatio: gate.criticalPathRatio,
    expectedSpeedup: gate.expectedSpeedup,
    economics
  };
  return {
    text: `## Parallel orchestration not enabled\n${skipReason}`,
    meta: {
      action: 'orchestration_skipped',
      skipReason: skipCode,
      tasks: plan.tasks.length,
      ...profile,
      completed: 0,
      concurrency: plan.maxConcurrency,
      conflicts: 0,
      needsArbitration: false,
      durationMs: wallMs,
      approvalWaitMs: 0,
      humanWaitMs: 0,
      computeMs: wallMs,
      gate: skipCode,
      workerTokens: 0,
      baselineTokens: 0,
      tokenSavedPercent: 0
    },
    results: [],
    conflicts: [],
    metrics: {
      tasks: plan.tasks.length,
      ...profile,
      completed: 0,
      concurrency: plan.maxConcurrency,
      wallMs,
      approvalWaitMs: 0,
      humanWaitMs: 0,
      computeMs: wallMs,
      serialWorkerMs: 0,
      parallelSavedMs: 0,
      workerTokens: 0,
      baselineTokens: 0,
      tokenSaved: 0,
      tokenSavedPercent: 0,
      gate: skipCode
    }
  };
}
