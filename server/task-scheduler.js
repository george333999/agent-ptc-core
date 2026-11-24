// 子任务调度策略：时长校准、粒度校验、写集合互斥、软截止与对冲决策。
// 全部为纯函数，便于单测；调度循环只读取返回值。

import { median, percentile } from './orchestration-metrics.js';

const DEFAULT_MIN_MS = 30000;
const DEFAULT_HARD_MS = 120000;

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// 校准耗时 = 0.5 × 历史中位数 + 0.5 × 模型预估。只有一边可用时退化为那一边。
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
        // 调度（LPT/关键路径）与快速通道都读 estimatedMinutes；
        // 用校准值覆盖它，历史偏慢的任务才会被优先启动，避免单点长尾拖慢整体。
        ...(calibratedMs > 0
          ? { estimatedMinutes: Math.round((calibratedMs / 60000) * 1000) / 1000 }
          : {}),
        calibratedMs
      };
    }),
    historySamples: (Array.isArray(historyMs) ? historyMs : []).filter((value) => positive(value)).length
  };
}

// 目标粒度 6-8 个任务；少于 6 个偏粗、多于 8 个偏细，只给建议不硬拒绝。
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
    reason = `只有 ${count} 个子任务，建议按文件/模块拆到 ${min}-${max} 个，减少单点长尾。`;
  } else if (count > Math.max(2, Number(max) || 8)) {
    code = 'TOO_FINE';
    reason = `有 ${count} 个子任务，超过 ${max} 个会增加调度与汇总开销，建议合并同类项。`;
  } else if (outliers.length) {
    code = 'DURATION_SKEW';
    reason = `子任务 ${outliers.join('、')} 的校准耗时超过中位数的 ${maxMultiple} 倍，建议拆小。`;
  }
  return { ok: code === 'OK', code, reason, count, medianMs, maxMs, outliers };
}

function normalizeWritePath(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

// 写集合互斥：同一文件多个写入者时，按任务出现顺序串行化（后者依赖前者），而不是直接拒绝。
// 追加依赖前先做可达性检查，避免引入环（plan 已通过校验，只能在无环前提下补边）。
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
        // 若 previous 已经（间接）依赖当前任务，再补边会成环，此时保持并行。
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

// 软截止：历史 p90 × 1.2，下限 30s、上限 120s。没有历史时直接用硬上限，避免误伤首轮。
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

// 对冲：只有明显长尾（最慢 / 中位数 > 2）且还没对冲过时才允许，每次最多 1 个。
export function shouldHedge({ stragglerRatio = 0, hedgeCount = 0, maxHedges = 1 } = {}) {
  return Number(stragglerRatio) > 2 && Number(hedgeCount) < Math.max(1, Number(maxHedges) || 1);
}

// 只对“可重试 + 部分/超时”的结果重派一次；写任务不重派，避免重复落盘。
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
