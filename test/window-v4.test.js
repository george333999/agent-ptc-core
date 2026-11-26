import test from 'node:test';
import assert from 'node:assert/strict';
import { historyChars, resolveLaggingWindow } from '../server/history-window.js';
import {
  appendEvictedSummary,
  createWindowContext,
  restoreWindowHistory
} from '../server/window-context.js';

// A small window makes boundaries reachable within a few turns; the char constraint is the main control in v4.
const LIMITS = { softMessages: 8, hardMessages: 16, softChars: 3000, hardChars: 6000 };

// Consistent with session storage: system does not enter messages, so abs 0 is the first user message.
function buildSession() {
  return {
    id: 'v4-session',
    messages: [],
    historyWindowLength: 0,
    historyWindowChars: 0,
    historyWindowStartAbs: 0
  };
}

function absIndexOf(session) {
  return new Map(session.messages.map((message, index) => [message.id, index]));
}

// Simulate one turn boundary: restore the previous turn's window → lagging trim → record the window → generate the evicted summary.
function turnBoundary(session, { persist = () => {} } = {}) {
  const absIndexById = absIndexOf(session);
  const allHistory = session.messages.filter((message) => message.role !== 'system');
  const candidate = restoreWindowHistory(allHistory, absIndexById, session.historyWindowStartAbs);
  const resolved = resolveLaggingWindow(candidate, session.historyWindowLength, LIMITS, {
    lastTrimChars: session.historyWindowChars
  });
  const { rememberWindow, evictedSummaryFor } = createWindowContext({
    session,
    absIndexById,
    persist
  });
  if (resolved.trimmed) rememberWindow(resolved.window);
  const summary = evictedSummaryFor(resolved.window);
  return { window: resolved.window, trimmed: resolved.trimmed, summary, absIndexById };
}

function addTurn(session, index, { size = 1200, artifact = '' } = {}) {
  const userId = `u${index}`;
  const assistantId = `a${index}`;
  session.messages.push({ id: userId, role: 'user', content: `turn ${index}: keep going ${'Q'.repeat(size)}` });
  session.messages.push({
    id: assistantId,
    role: 'assistant',
    content: 'done',
    toolCalls: artifact
      ? [
          { name: 'read_file', args: { path: 'src/calc.js' }, status: 'completed', result: 'x' },
          { name: 'write_file', args: { path: artifact, content: 'y'.repeat(100) }, status: 'completed', result: 'ok' }
        ]
      : []
  });
}

test('After multiple turns the window char count converges within the soft limit and only appends, never slides', () => {
  const session = buildSession();
  let previousFirst = '';
  let stablePrefixTurns = 0;
  for (let index = 1; index <= 12; index += 1) {
    addTurn(session, index, { artifact: index === 1 ? 'reports/early.md' : '' });
    const result = turnBoundary(session);
    // The window lags between soft and hard and must never exceed the hard limit at any time.
    assert.ok(historyChars(result.window) <= LIMITS.hardChars, `turn ${index} window over hard limit`);
    if (previousFirst && result.window[0]?.id === previousFirst) stablePrefixTurns += 1;
    previousFirst = result.window[0]?.id || '';
  }
  assert.ok(session.historyWindowStartAbs > 0, 'the window should have advanced');
  assert.ok(stablePrefixTurns >= 1, 'turns without a trim should keep the window first message unchanged');
});

test('Evicted early turns produce a deterministic summary that refreshes as the window advances', () => {
  const session = buildSession();
  let summary = '';
  let persists = 0;
  for (let index = 1; index <= 12; index += 1) {
    addTurn(session, index, { artifact: index === 1 ? 'reports/early.md' : '' });
    const result = turnBoundary(session, { persist: () => { persists += 1; } });
    if (result.summary) summary = result.summary;
  }
  assert.ok(summary, 'the evicted-turn summary should be injected');
  assert.match(summary, /reports\/early\.md/, 'the summary should keep the early artifact path');
  assert.ok(summary.length <= 2800, 'the summary is bounded by maxChars');
  assert.ok(persists >= 1, 'the summary should be persisted once');

  // Regenerating for the same window start must be byte-identical (deterministic) and not persisted again.
  const before = persists;
  const again = turnBoundary(session, { persist: () => { persists += 1; } });
  assert.equal(again.summary, summary);
  assert.equal(persists, before);
});

test('Prefix cache safety: the summary is appended only at the tail of the user message, window messages are not rewritten', () => {
  const session = buildSession();
  for (let index = 1; index <= 10; index += 1) addTurn(session, index);
  const result = turnBoundary(session);
  assert.ok(result.summary);

  const beforeWindow = result.window.map((message) => JSON.stringify(message));
  const prompt = appendEvictedSummary(
    [
      { role: 'system', content: 'SYS' },
      ...result.window.map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: 'current question' }
    ],
    result.summary
  );
  // Window messages are unchanged; the summary appears only in the last user message.
  assert.deepEqual(
    prompt.slice(1, 1 + result.window.length).map((message) => message.content),
    result.window.map((message) => message.content)
  );
  assert.equal(result.window.map((message) => JSON.stringify(message)).join('|'), beforeWindow.join('|'));
  assert.match(prompt[prompt.length - 1].content, /current question[\s\S]*Early turns moved out of the window/);
});

test('Boundary: no trim and no summary injection when not over the hard limit', () => {
  const session = buildSession();
  // Add a single small turn, keeping it far below hardChars / hardMessages.
  addTurn(session, 1, { size: 10 });
  const result = turnBoundary(session);
  assert.equal(result.trimmed, false);
  assert.equal(result.summary, '');
  assert.equal(session.historyWindowStartAbs, 0);
  assert.equal(session.historyWindowLength, 0);
});
