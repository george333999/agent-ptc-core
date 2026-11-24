// 并行编排的经济性门禁：不只问“能不能并行”，还问“并行是否真的更省时间/成本”。
//
// 输入来自 DAG 结构（关键路径、并行宽度）与本机历史耗时；
// 输出给主 Agent 两个选择：直接执行（串行）或继续编排。
//
// 全部是纯函数，便于单测与边界值测试。

export const DEFAULT_TASK_SECONDS = 25;
export const DEFAULT_ORCHESTRATION_OVERHEAD_MS = 2000;
export const MIN_BREAKEVEN_SPEEDUP = 1.2;
export const MAX_TOKEN_OVERHEAD_RATIO = 2;

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * 估算并行是否划算。
 * @param {object} input
 * @param {number} input.taskCount 子任务数
 * @param {number} input.criticalPathTasks 关键路径节点数
 * @param {number} input.taskSeconds 单个子任务预估耗时（秒）
 * @param {number} input.overheadMs 编排固定开销（预热 + 汇总）
 * @param {number} input.parentContextTokens 父会话每步的输入 token（串行基线）
 * @param {number} input.prefixTokens 共享前缀 token
 * @param {number} input.tailTokens 每个 Worker 的专属尾部 token
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
      reason: '没有可执行的子任务。'
    };
  }
  const seconds = positive(taskSeconds, DEFAULT_TASK_SECONDS);
  const path = Math.min(count, Math.max(1, Math.floor(Number(criticalPathTasks) || count)));
  const serialMs = Math.round(count * seconds * 1000);
  const parallelMs = Math.round(path * seconds * 1000 + positive(overheadMs, DEFAULT_ORCHESTRATION_OVERHEAD_MS));
  const speedup = Number((serialMs / Math.max(1, parallelMs)).toFixed(3));
  // 单 Worker 输入 = 共享前缀 + 专属尾部；父会话串行时每步约等于 parentContextTokens。
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
    reasons.push(`预计加速比只有 ${speedup}×（低于 ${MIN_BREAKEVEN_SPEEDUP}×），并行收益不足以抵消编排开销`);
  }
  if (tokenOverheadRatio > MAX_TOKEN_OVERHEAD_RATIO) {
    reasons.push(`Worker 输入 token 是串行基线的 ${tokenOverheadRatio} 倍，超过 ${MAX_TOKEN_OVERHEAD_RATIO} 倍上限`);
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
    reason: reasons.join('；')
  };
}

/**
 * 决定编排是否继续。
 * mode = 'enforce' 时返回 allowed=false 由调用方改成“直接执行”；
 * mode = 'advisory' 时只给出建议，不改变执行路径（默认，避免误杀长尾任务）。
 */
export function evaluateEconomicsGate({ economics, mode = 'advisory' } = {}) {
  const estimate = economics || estimateOrchestrationEconomics({});
  if (mode === 'enforce' && !estimate.ok) {
    return { allowed: false, mode, code: estimate.code, reason: estimate.reason, estimate };
  }
  return { allowed: true, mode, code: estimate.ok ? 'OK' : estimate.code, reason: estimate.reason, estimate };
}

// 快速通道拒绝时的统一返回体：与正常编排结果结构一致，主 Agent 可直接改用串行执行。
export function buildOrchestrationSkipResult({ plan, gate, economics, economicsGate, startedAt }) {
  const wallMs = Math.max(0, Date.now() - (Number(startedAt) || Date.now()));
  const skipCode = gate.allowed ? economicsGate.code : gate.code;
  const skipReason = gate.allowed
    ? `并行编排不划算：${economics.reason}。请直接执行，不要拆成并行子任务。`
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
    text: `## 未启用并行编排\n${skipReason}`,
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
