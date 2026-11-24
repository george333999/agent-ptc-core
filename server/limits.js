// 工具调用轮数：默认 200 轮（上限 200）。
// 上限用于打断“读几百个文件”的长循环；上下文守卫会把每步请求裁剪到窗口内，
// 因此轮数增加不会像以前那样把单步 prefill 拖成十几分钟。
export const MAX_TOOL_STEPS = 200;
export const DEFAULT_MAX_STEPS = 200;

export function normalizeMaxSteps(value) {
  const steps = Math.floor(Number(value));
  if (!Number.isFinite(steps) || steps <= 0) return DEFAULT_MAX_STEPS;
  return Math.min(steps, MAX_TOOL_STEPS);
}

export function resolveMaxSteps(value) {
  return normalizeMaxSteps(value);
}

/**
 * 轮次预算：40% 处提醒收敛探索；末尾预留少量轮次关闭工具、强制产出结果。
 * 预留不能吃掉整轮预算，小上限（如 1/2/4 步）至少要留 1 步用于实际工作。
 */
export function resolveStepBudget(maxSteps) {
  const steps = Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : 0;
  if (!steps) return { progressNudgeStep: 0, finalReserve: 0 };
  const progressNudgeStep = Math.floor(steps * 0.4);
  const finalReserve = Math.max(
    1,
    Math.min(12, Math.max(1, Math.floor(steps * 0.06)), Math.max(1, Math.floor(steps / 4)))
  );
  return { progressNudgeStep, finalReserve };
}
