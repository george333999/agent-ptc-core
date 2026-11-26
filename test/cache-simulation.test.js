import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHistoryWindow, shouldTrimHistory } from '../server/history-window.js';
import { buildRequestFingerprint, commonPrefixRatio } from '../server/prefix.js';

// Simulate a long task of the main Agent along the message-count dimension: verify the request prefix stays stable between two trims.
const LIMITS = {
  softMessages: 48,
  hardMessages: 64,
  softChars: 10_000_000,
  hardChars: 20_000_000
};
const SYSTEM = 'stable system prompt for cache simulation';
const TOOLS = [{ type: 'function', function: { name: 'read_file' } }];

function fingerprint(messages) {
  return buildRequestFingerprint({ system: SYSTEM, tools: TOOLS, messages }).text;
}

test('prefix stability between adjacent requests in a long task is at least 80%', () => {
  const history = [];
  for (let index = 0; index < 40; index += 1) {
    history.push({ role: 'user', content: `question ${index} ${'q'.repeat(50)}` });
    history.push({ role: 'assistant', content: `answer ${index} ${'a'.repeat(120)}` });
  }

  let window = applyHistoryWindow(history, LIMITS);
  assert.equal(window.length, 48);
  let lastTrimLength = window.length;
  let previous = fingerprint(window);
  const ratios = [];
  const trimSteps = [];

  for (let step = 0; step < 120; step += 1) {
    const appended = [
      { role: 'assistant', content: `tool call ${step} ${'c'.repeat(80)}` },
      { role: 'tool', content: `result ${step} ${'r'.repeat(320)}` }
    ];
    const candidate = [...window, ...appended];
    if (shouldTrimHistory(candidate, lastTrimLength, LIMITS)) {
      window = applyHistoryWindow(candidate, LIMITS);
      lastTrimLength = window.length;
      trimSteps.push(step);
    } else {
      window = candidate;
    }
    const current = fingerprint(window);
    ratios.push(commonPrefixRatio(previous, current));
    previous = current;
  }

  const average = ratios.reduce((total, value) => total + value, 0) / ratios.length;
  assert.ok(average >= 0.8, `average prefix stability ${average.toFixed(3)} should be at least 0.8`);
  assert.ok(window.length <= LIMITS.hardMessages);
  assert.ok(trimSteps.length >= 1 && trimSteps.length <= 20, `trim count should be constrained by lagging trim, actual ${trimSteps.length}`);
});

test('the old step-by-step sliding window produces many misses (control)', () => {
  const history = [];
  for (let index = 0; index < 40; index += 1) {
    history.push({ role: 'user', content: `question ${index}` });
    history.push({ role: 'assistant', content: `answer ${index}` });
  }
  let previous = fingerprint(history.slice(-48));
  const ratios = [];
  for (let step = 0; step < 40; step += 1) {
    history.push({ role: 'assistant', content: `tool call ${step}` });
    history.push({ role: 'tool', content: `result ${step}` });
    const current = fingerprint(history.slice(-48));
    ratios.push(commonPrefixRatio(previous, current));
    previous = current;
  }
  const average = ratios.reduce((total, value) => total + value, 0) / ratios.length;
  assert.ok(average < 0.2, `old strategy average prefix stability ${average.toFixed(3)} should be clearly lower`);
});
