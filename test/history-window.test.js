import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HISTORY_LIMITS,
  applyHistoryWindow,
  historyChars,
  historyLimitsForContext,
  overHistoryLimits,
  resolveHistoryLimits,
  resolveLaggingWindow,
  shouldTrimHistory
} from '../server/history-window.js';

const SMALL = { softMessages: 3, hardMessages: 5, softChars: 100000, hardChars: 200000 };

function message(role, index, size = 1) {
  return { role, content: `${role}-${index}-${'x'.repeat(size)}` };
}

test('Returns a copy unchanged when not over the hard limit, without modifying the input', () => {
  const input = [message('user', 0), message('assistant', 1), message('user', 2)];
  const result = applyHistoryWindow(input, SMALL);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
});

test('No trim at exactly the hard limit; trimming starts after one message over', () => {
  const exact = [message('user', 0), message('assistant', 1), message('user', 2), message('assistant', 3), message('user', 4)];
  assert.equal(overHistoryLimits(exact, SMALL), false);
  assert.equal(applyHistoryWindow(exact, SMALL).length, 5);

  const over = [...exact, message('assistant', 5)];
  assert.equal(overHistoryLimits(over, SMALL), true);
  const window = applyHistoryWindow(over, SMALL);
  assert.ok(window.length >= SMALL.softMessages);
  assert.ok(window.length < over.length);
  assert.equal(window[0].role, 'user');
  assert.deepEqual(window[window.length - 1], over[over.length - 1]);
});

test('Boundary: empty and single-message histories are safe', () => {
  assert.deepEqual(applyHistoryWindow([], SMALL), []);
  assert.deepEqual(applyHistoryWindow([message('user', 0)], SMALL), [message('user', 0)]);
  const tight = { softMessages: 1, hardMessages: 1, softChars: 1, hardChars: 1 };
  const single = [message('user', 0)];
  assert.deepEqual(applyHistoryWindow(single, tight), single);
});

test('Trims to the soft limit when there are no user messages', () => {
  const input = Array.from({ length: 6 }, (_, index) => message('assistant', index));
  const window = applyHistoryWindow(input, SMALL);
  assert.equal(window.length, SMALL.softMessages);
});

test('Keeps trimming to around the soft limit when the char count is exceeded', () => {
  const limits = { softMessages: 10, hardMessages: 10, softChars: 250, hardChars: 300 };
  const input = Array.from({ length: 6 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', index, 100));
  assert.equal(overHistoryLimits(input, limits), true);
  const window = applyHistoryWindow(input, limits);
  assert.ok(window.length < input.length);
  assert.equal(window[0].role, 'user');
  // Trim by whole turn, keeping at least one turn (user + assistant).
  assert.equal(window.length, 2);
  assert.ok(historyChars(window) < historyChars(input));
});

test('The window stays bounded when there is no user message at the tail', () => {
  const limits = { softMessages: 4, hardMessages: 6, softChars: 1000000, hardChars: 2000000 };
  const input = [
    message('user', 0),
    ...Array.from({ length: 19 }, (_, index) => message('assistant', index + 1))
  ];
  const window = applyHistoryWindow(input, limits);
  assert.ok(window.length <= limits.hardMessages);
  assert.equal(window.length, limits.softMessages);
});

test('Lagging trim: at least hard - soft messages between two trims', () => {
  const limits = { softMessages: 48, hardMessages: 64, softChars: 1000000, hardChars: 2000000 };
  const window65 = Array.from({ length: 65 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', index));
  assert.equal(shouldTrimHistory(window65, 0, limits), true);
  assert.equal(shouldTrimHistory(window65, 50, limits), false);
  assert.equal(shouldTrimHistory(window65, 49, limits), true);
  assert.equal(shouldTrimHistory(window65.slice(0, 60), 0, limits), false);
  assert.equal(shouldTrimHistory(window65.slice(0, 60), 0, limits), false);
});

test('Char overflow is also subject to the lag gap', () => {
  const limits = { softMessages: 4, hardMessages: 6, softChars: 100, hardChars: 200 };
  const heavy = Array.from({ length: 6 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', index, 100));
  assert.equal(shouldTrimHistory(heavy, 0, limits), true);
  assert.equal(shouldTrimHistory(heavy, 5, limits), false);
});

test('v4 default window converges to 60k / 150k chars', () => {
  assert.equal(DEFAULT_HISTORY_LIMITS.softChars, 60000);
  assert.equal(DEFAULT_HISTORY_LIMITS.hardChars, 150000);
  assert.ok(DEFAULT_HISTORY_LIMITS.hardChars > DEFAULT_HISTORY_LIMITS.softChars);
});

test('Lagging trim by char gap when char overflow and lastTrimChars are provided', () => {
  const limits = { softMessages: 48, hardMessages: 64, softChars: 100, hardChars: 200 };
  const heavy = Array.from({ length: 6 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', index, 100));
  const chars = historyChars(heavy);

  // First time: no char baseline → trimming allowed.
  assert.equal(shouldTrimHistory(heavy, 0, limits, { lastTrimChars: 0 }), true);
  // Char increment since the last trim below hard - soft (100) → no trim, even if the message count grew slightly.
  assert.equal(shouldTrimHistory(heavy, 5, limits, { lastTrimChars: chars - 60 }), false);
  // Char increment reaches the gap → trim.
  assert.equal(shouldTrimHistory(heavy, 5, limits, { lastTrimChars: chars - 150 }), true);
});

test('Boundary: no trim when the char count exactly equals the hard limit', () => {
  const single = [{ role: 'user', content: 'x' }];
  const chars = historyChars(single);
  const limits = { softMessages: 4, hardMessages: 6, softChars: Math.max(1, chars - 1), hardChars: chars };
  assert.equal(overHistoryLimits(single, limits), false);
  assert.equal(shouldTrimHistory(single, 0, limits, { lastTrimChars: 0 }), false);
});

test('Automatically corrects when the soft limit exceeds the hard limit', () => {
  const limits = resolveHistoryLimits({ softMessages: 10, hardMessages: 5, softChars: 500, hardChars: 100 });
  assert.equal(limits.hardMessages, 10);
  assert.equal(limits.hardChars, 500);
});

test("Cross-turn lagging window: no trim before the gap, keeping the previous turn's tail prefix", () => {
  const limits = { softMessages: 48, hardMessages: 64, softChars: 1000000, hardChars: 2000000 };
  const history = Array.from({ length: 70 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', index));

  // The previous turn's last trim length was 60: no trim after just 1 more message, ensuring the new turn's first request is a prefix of the previous turn.
  const noTrim = resolveLaggingWindow(history.slice(0, 61), 60, limits);
  assert.equal(noTrim.trimmed, false);
  assert.equal(noTrim.window.length, 61);

  // Trim after reaching the hard - soft gap.
  const trimmed = resolveLaggingWindow(history, 48, limits);
  assert.equal(trimmed.trimmed, true);
  assert.ok(trimmed.window.length <= limits.softMessages + 1);
  assert.equal(trimmed.windowLength, trimmed.window.length);

  // Empty history and a missing baseline are safe.
  assert.deepEqual(resolveLaggingWindow([], 0, limits), { window: [], trimmed: false, windowLength: 0 });
  assert.equal(resolveLaggingWindow(history.slice(0, 10), 0, limits).trimmed, false);
});

test('Derives history limits from the model context: trim deferred to 97% of the window, regular sessions stay append-only', () => {
  const limits = historyLimitsForContext(128000);
  assert.equal(limits.hardChars, 310400);
  assert.equal(limits.softChars, 155200);
  assert.ok(limits.hardMessages >= 600);
  // The old 60k-char default window no longer triggers a trim under a 128k context.
  const history = Array.from({ length: 80 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', index, 800));
  assert.ok(historyChars(history) > 60000);
  assert.equal(shouldTrimHistory(history, 0, limits, { lastTrimChars: 0 }), false);

  // Smaller context windows still have a 150k-char floor, avoiding premature trims for small models.
  const small = historyLimitsForContext(8000);
  assert.equal(small.hardChars, 150000);
  assert.ok(small.softChars < small.hardChars);
});
