import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextRatio,
  shouldDistillToolResult,
  shouldTrimAtStep,
  degradeOldestToolResults,
  planTurnBoundaryDegrade,
  effectiveContextWindow,
  shrinkToTokenBudget,
  FALLBACK_CONTEXT_WINDOW
} from '../server/context-policy.js';

test('The context ratio is clamped to 0..1, and 0 when the window is missing', () => {
  assert.equal(contextRatio({ promptTokens: 50, contextWindow: 100 }), 0.5);
  assert.equal(contextRatio({ promptTokens: 150, contextWindow: 100 }), 1);
  assert.equal(contextRatio({ promptTokens: 150, contextWindow: 0 }), 0);
  assert.equal(contextRatio(), 0);
});

test('No distillation in-turn by default; degrade only near 80%', () => {
  const base = { enabled: true, turnActive: true, outputChars: 50000, minChars: 1000 };
  assert.equal(shouldDistillToolResult({ ...base, contextRatio: 0.5 }), false);
  assert.equal(shouldDistillToolResult({ ...base, contextRatio: 0.8 }), true);
  assert.equal(shouldDistillToolResult({ ...base, contextRatio: 0.85 }), true);
  assert.equal(shouldDistillToolResult({ ...base, turnActive: false, contextRatio: 0.1 }), true);
  assert.equal(shouldDistillToolResult({ ...base, enabled: false, contextRatio: 0.95 }), false);
  assert.equal(shouldDistillToolResult({ ...base, outputChars: 10, contextRatio: 0.95 }), false);
});

test('Trim triggers only at turn boundaries or the in-turn 97% emergency threshold', () => {
  assert.equal(shouldTrimAtStep({ step: 0, overHard: true, contextRatio: 0.95 }), true);
  assert.equal(shouldTrimAtStep({ step: 3, overHard: true, contextRatio: 0.96 }), false);
  assert.equal(shouldTrimAtStep({ step: 3, overHard: true, contextRatio: 0.97 }), true);
  assert.equal(shouldTrimAtStep({ step: 3, overHard: false, contextRatio: 0.99 }), false);
});

function toolMessage(id, size) {
  return { id, role: 'tool', content: 'x'.repeat(size) };
}

test('Degrades the oldest tool results, keeps the most recent N, and leaves the original array untouched', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    toolMessage('t1', 2000),
    toolMessage('t2', 2000),
    toolMessage('t3', 2000),
    { role: 'assistant', content: 'ok' }
  ];
  const result = degradeOldestToolResults(messages, { keepRecent: 1, degradeChars: 200 });
  assert.equal(result.degraded, 2);
  assert.equal(messages[1].content.length, 2000);
  assert.ok(result.messages[1].content.length < 2000);
  assert.match(result.messages[1].content, /degraded/);
  assert.equal(result.messages[3].content.length, 2000);
  assert.equal(result.messages.length, messages.length);
});

test('No degradation when below the protected count or no oversized result exists', () => {
  const shortMessages = [toolMessage('t1', 10), toolMessage('t2', 10)];
  assert.equal(degradeOldestToolResults(shortMessages, { keepRecent: 4 }).degraded, 0);
  const result = degradeOldestToolResults([{ role: 'assistant', content: 'nothing' }], { keepRecent: 0 });
  assert.equal(result.degraded, 0);
});

test('Turn-boundary degradation is controlled by the threshold', () => {
  const messages = [toolMessage('t1', 5000), toolMessage('t2', 5000)];
  const below = planTurnBoundaryDegrade(messages, { contextRatio: 0.5 });
  assert.equal(below.degraded, 0);
  const above = planTurnBoundaryDegrade(messages, { contextRatio: 0.85, keepRecent: 0, degradeChars: 100 });
  assert.equal(above.degraded, 2);
});

test("Uses the conservative fallback when the model doesn't configure a context window", () => {
  assert.equal(effectiveContextWindow(0), FALLBACK_CONTEXT_WINDOW);
  assert.equal(effectiveContextWindow(null), FALLBACK_CONTEXT_WINDOW);
  assert.equal(effectiveContextWindow(undefined), FALLBACK_CONTEXT_WINDOW);
  assert.equal(effectiveContextWindow(32768), 32768);
  assert.equal(effectiveContextWindow(0, 64000), 64000);
  // The fallback floor is 8000, avoiding an abnormal config squeezing the window into an unusable state.
  assert.equal(effectiveContextWindow(0, 1000), 8000);
});

test('On context overflow, degrade tool results first, then drop the oldest history by turn while keeping the current turn', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'old turn 1' },
    { role: 'assistant', content: 'a1' },
    { role: 'tool', content: 'x'.repeat(20000) },
    { role: 'user', content: 'old turn 2' },
    { role: 'assistant', content: 'a2' },
    { role: 'tool', content: 'y'.repeat(20000) },
    { role: 'user', content: 'current question' },
    { role: 'assistant', content: 'working' },
    { role: 'tool', content: 'z'.repeat(20000) }
  ];
  const result = shrinkToTokenBudget(messages, { targetTokens: 5000, keepRecentTools: 1, degradeChars: 300 });
  assert.ok(result.degraded > 0);
  assert.ok(result.trimmed > 0);
  assert.equal(result.messages[0].role, 'system');
  assert.ok(result.messages.length < messages.length);
  assert.ok(result.messages.some((message) => message.content === 'current question'));
  // The original array is not modified.
  assert.equal(messages.length, 10);
  assert.equal(messages[3].content.length, 20000);
  // Stop dropping when only the current turn remains.
  const onlyTurn = shrinkToTokenBudget([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'only' },
    { role: 'assistant', content: 'a' }
  ], { targetTokens: 10 });
  assert.equal(onlyTurn.trimmed, 0);
  assert.equal(onlyTurn.messages.length, 3);
});

test('No degradation or trim when under budget', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok' }
  ];
  const result = shrinkToTokenBudget(messages, { targetTokens: 100000 });
  assert.equal(result.degraded, 0);
  assert.equal(result.trimmed, 0);
  assert.equal(result.messages.length, 3);
});
