// Subtask scheduling policy: duration calibration, granularity validation, write-set mutual exclusion, soft deadline, and hedging decisions.
// All pure functions for easy unit testing; the scheduling loop only reads the return values.

import { median, percentile } from './orchestration-metrics.js';

const DEFAULT_MIN_MS = 30000;
const DEFAULT_HARD_MS = 120000;

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// Calibrated duration = 0.5 × historical median + 0.5 × model estimate. Degrades to whichever side is available.
export function calibrateDuration({ historyMs = [], estimateMs = 0, weight = 0.5 } = {}) {
  const history = (Array.isArray(historyMs) ? historyMs : [])
    .map((value) => positive(value))
    .filter(Boolean);
  const estimate = positive(estimateMs);
  const historyMedian = median(history);
  if (!historyMedian && !estimate) return 0;
  if (!historyMedian) return Math.round(estimate);
  if (!estimate) return Math.round(historyMedian);
  const ratio = Math.min(0.9, Math.max(0.1, Number(weight) || 0.5));
  return Math.round(historyMedian * ratio + estimate * (1 - ratio));
}

export function calibrateTasks(tasks, { historyMs = [], weight = 0.5 } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  return {
    tasks: list.map((task) => {
      const estimateMs = positive(task?.estimatedMs)
        || positive(Number(task?.estimatedMinutes) * 60000);
      const calibratedMs = calibrateDuration({ historyMs, estimateMs, weight });
      return {
        ...task,
        estimateMs,
        // Scheduling (LPT/critical path) and the fast channel both read estimatedMinutes;
        // overwrite it with the calibrated value so historically slow tasks start first, preventing a single long tail from dragging down the whole run.
        ...(calibratedMs > 0
          ? { estimatedMinutes: Math.round((calibratedMs / 60000) * 1000) / 1000 }
          : {}),
        calibratedMs
      };
    }),
    historySamples: (Array.isArray(historyMs) ? historyMs : []).filter((value) => positive(value)).length
  };
}

// Target granularity is 6-8 tasks; fewer than 6 is too coarse and more than 8 is too fine — advise only, never hard-reject.
export function validateGranularity(tasks, { min = 6, max = 8, maxMultiple = 2 } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const durations = list.map((task) => positive(task?.calibratedMs)).filter(Boolean);
  const medianMs = median(durations);
  const maxMs = durations.length ? Math.max(...durations) : 0;
  const outliers = medianMs
    ? list
      .filter((task) => positive(task?.calibratedMs) > medianMs * Math.max(1.5, Number(maxMultiple) || 2))
      .map((task) => task.id)
    : [];
  const count = list.length;
  let code = 'OK';
  let reason = '';
  if (count < Math.max(2, Number(min) || 6)) {
    code = 'TOO_COARSE';
    reason = `Only ${count} subtasks; split by file/module into ${min}-${max} to reduce a single long tail.`;
  } else if (count > Math.max(2, Number(max) || 8)) {
    code = 'TOO_FINE';
    reason = `${count} subtasks exceed ${max}, adding scheduling and aggregation overhead; merge similar items.`;
  } else if (outliers.length) {
    code = 'DURATION_SKEW';
    reason = `Subtask(s) ${outliers.join(', ')} have a calibrated duration over ${maxMultiple}× the median; consider splitting them.`;
  }
  return { ok: code === 'OK', code, reason, count, medianMs, maxMs, outliers };
}

function normalizeWritePath(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

// Write-set exclusion: when several writers target the same file, serialize by task order (later depends on earlier) instead of rejecting.
// Check reachability before adding a dependency to avoid cycles (the plan is already validated; edges may only be added while acyclic).
export function resolveWriteConflicts(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const writers = new Map();
  const conflicts = [];
  const dependencyOf = new Map(list.map((task) => [task.id, [...new Set(Array.isArray(task?.dependsOn) ? task.dependsOn : [])]]));
  const reachable = (from, to) => {
    const seen = new Set();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop();
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dependency of dependencyOf.get(id) || []) stack.push(dependency);
    }
    return false;
  };
  const nextTasks = list.map((task, index) => {
    const writes = [...new Set((Array.isArray(task?.writeFiles) ? task.writeFiles : [])
      .map(normalizeWritePath)
      .filter(Boolean))];
    const dependsOn = dependencyOf.get(task.id);
    for (const file of writes) {
      const previous = writers.get(file);
      if (previous && previous !== task.id) {
        // If previous already (indirectly) depends on the current task, adding an edge would create a cycle; keep them parallel.
        const wouldCycle = reachable(previous, task.id);
        if (!wouldCycle && !dependsOn.includes(previous)) {
          conflicts.push({ file, before: previous, after: task.id, index });
          dependsOn.push(previous);
        }
      }
      writers.set(file, task.id);
    }
    return { ...task, writeFiles: writes, dependsOn: [...dependsOn] };
  });
  return { tasks: nextTasks, conflicts, changed: conflicts.length > 0 };
}

// Soft deadline: historical p90 × 1.2, floored at 30s and capped at 120s. With no history, use the hard cap to avoid harming the first run.
export function resolveSoftDeadline({
  historyMs = [],
  minMs = DEFAULT_MIN_MS,
  hardMs = DEFAULT_HARD_MS,
  factor = 1.2
} = {}) {
  const history = (Array.isArray(historyMs) ? historyMs : []).map((value) => positive(value)).filter(Boolean);
  const hard = Math.max(DEFAULT_MIN_MS, positive(hardMs) || DEFAULT_HARD_MS);
  if (!history.length) return hard;
  const target = Math.ceil(percentile(history, 0.9) * Math.max(1, Number(factor) || 1.2));
  return Math.min(hard, Math.max(DEFAULT_MIN_MS, target));
}

// Hedging: allowed only with a clear long tail (slowest / median > 2) when not hedged yet, at most 1 at a time.
export function shouldHedge({ stragglerRatio = 0, hedgeCount = 0, maxHedges = 1 } = {}) {
  return Number(stragglerRatio) > 2 && Number(hedgeCount) < Math.max(1, Number(maxHedges) || 1);
}

// Redispatch only "retryable + partial/timeout" results once; never redispatch write tasks, to avoid duplicate writes.
export function shouldRedispatch({ result, attempt = 0, maxAttempts = 1 } = {}) {
  if (!result || attempt >= Math.max(0, Number(maxAttempts) || 1)) return false;
  if (!result.retryable) return false;
  if (Array.isArray(result.writes) && result.writes.length) return false;
  return ['partial', 'timeout'].includes(String(result.status || ''));
}

export function historyFromResults(results, { limit = 100 } = {}) {
  const durations = (Array.isArray(results) ? results : [])
    .map((result) => positive(result?.durationMs))
    .filter(Boolean);
  return durations.slice(-Math.max(1, Number(limit) || 100));
}
