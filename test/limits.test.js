import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_STEPS,
  MAX_TOOL_STEPS,
  normalizeMaxSteps,
  resolveMaxSteps,
  resolveStepBudget
} from '../server/limits.js';

test('Unset, 0, negative, and invalid values fall back to the default of 200 steps', () => {
  assert.equal(DEFAULT_MAX_STEPS, 200);
  assert.equal(normalizeMaxSteps(undefined), DEFAULT_MAX_STEPS);
  assert.equal(normalizeMaxSteps(null), DEFAULT_MAX_STEPS);
  assert.equal(normalizeMaxSteps(0), DEFAULT_MAX_STEPS);
  assert.equal(normalizeMaxSteps(-5), DEFAULT_MAX_STEPS);
  assert.equal(normalizeMaxSteps(Number.NaN), DEFAULT_MAX_STEPS);
  assert.equal(normalizeMaxSteps('abc'), DEFAULT_MAX_STEPS);
});

test('Positive values are floored to integers and capped at 200 steps', () => {
  assert.equal(normalizeMaxSteps(24), 24);
  assert.equal(normalizeMaxSteps('60'), 60);
  assert.equal(normalizeMaxSteps(3.9), 3);
  assert.equal(normalizeMaxSteps(300), MAX_TOOL_STEPS);
  assert.equal(MAX_TOOL_STEPS, 200);
});

test('Resolution always yields a concrete step count: default 200, max 200', () => {
  assert.equal(resolveMaxSteps(0), DEFAULT_MAX_STEPS);
  assert.equal(resolveMaxSteps(undefined), DEFAULT_MAX_STEPS);
  assert.equal(resolveMaxSteps(24), 24);
  assert.equal(resolveMaxSteps(999), 200);
});

test('Final-phase budget: a small cap does not consume the whole budget', () => {
  assert.deepEqual(resolveStepBudget(0), { progressNudgeStep: 0, finalReserve: 0 });
  assert.deepEqual(resolveStepBudget(Number.POSITIVE_INFINITY), { progressNudgeStep: 0, finalReserve: 0 });
  assert.deepEqual(resolveStepBudget(1), { progressNudgeStep: 0, finalReserve: 1 });
  assert.deepEqual(resolveStepBudget(2), { progressNudgeStep: 0, finalReserve: 1 });
  assert.deepEqual(resolveStepBudget(4), { progressNudgeStep: 1, finalReserve: 1 });
  assert.equal(resolveStepBudget(10).finalReserve, 1);
  assert.equal(resolveStepBudget(16).finalReserve, 1);
  assert.deepEqual(resolveStepBudget(60), { progressNudgeStep: 24, finalReserve: 3 });
  assert.deepEqual(resolveStepBudget(200), { progressNudgeStep: 80, finalReserve: 12 });
  // The reserved steps are always fewer than the total budget, guaranteeing at least one step of real work (except a budget of 1).
  for (const steps of [2, 3, 4, 5, 10, 16, 60, 200]) {
    const { finalReserve, progressNudgeStep } = resolveStepBudget(steps);
    assert.ok(finalReserve >= 1 && finalReserve < steps, `steps=${steps} reserve=${finalReserve}`);
    assert.ok(progressNudgeStep >= 0 && progressNudgeStep < steps);
  }
});
