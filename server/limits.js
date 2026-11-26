// Tool-call steps: 200 by default (cap 200).
// The cap interrupts long loops such as "read hundreds of files"; the context guard trims each step's request to the window,
// so a higher step count no longer stretches a single-step prefill into tens of minutes as before.
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
 * Step budget: nudge convergence at 40%; reserve a few steps at the end to close tools and force results.
 * The reserve must not eat the whole budget: small caps (e.g. 1/2/4 steps) must leave at least 1 step for real work.
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
