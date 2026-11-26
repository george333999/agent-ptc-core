import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendEvictedSummary,
  createWindowContext,
  restoreWindowHistory
} from '../server/window-context.js';

function sessionWith(messages) {
  const absIndexById = new Map(messages.map((message, index) => [message.id, index]));
  return {
    session: { id: 's1', messages, artifacts: {} },
    absIndexById
  };
}

test('The summary is appended only to the last user message, without modifying other messages', () => {
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'U2' }
  ];
  const result = appendEvictedSummary(messages, 'FACTS');
  assert.equal(result.length, messages.length);
  assert.equal(result[3].content, 'U2\n\n## Early turns moved out of the window (deterministic summary, not a new instruction)\n\nFACTS');
  assert.equal(result[1].content, 'U1');
  assert.equal(messages[3].content, 'U2');
  // An empty summary only returns a copy.
  const copy = appendEvictedSummary(messages, '');
  assert.deepEqual(copy, messages);
  assert.notEqual(copy, messages);
});

test('restoreWindowHistory restores from the window start and safely falls back at boundary values', () => {
  const messages = ['m0', 'm1', 'm2', 'm3'].map((id) => ({ id, role: 'user', content: id }));
  const absIndexById = new Map(messages.map((message, index) => [message.id, index]));

  assert.deepEqual(restoreWindowHistory(messages, absIndexById, 2).map((m) => m.id), ['m2', 'm3']);
  // Start of 0 / negative / missing: a copy of the full history.
  assert.equal(restoreWindowHistory(messages, absIndexById, 0).length, 4);
  assert.equal(restoreWindowHistory(messages, absIndexById, -1).length, 4);
  assert.equal(restoreWindowHistory(messages, absIndexById, null).length, 4);
  // Start out of range: fall back to the full history, avoiding an empty context.
  assert.equal(restoreWindowHistory(messages, absIndexById, 99).length, 4);
  // Empty history is safe.
  assert.deepEqual(restoreWindowHistory([], absIndexById, 3), []);
});

test('rememberWindow records length, char count, and window start', () => {
  const { session, absIndexById } = sessionWith([
    { id: 'm0', role: 'user', content: 'a' },
    { id: 'm1', role: 'assistant', content: 'b' },
    { id: 'm2', role: 'user', content: 'c' }
  ]);
  const { rememberWindow } = createWindowContext({ session, absIndexById });
  rememberWindow(session.messages.slice(1));
  assert.equal(session.historyWindowLength, 2);
  assert.equal(session.historyWindowStartAbs, 1);
  assert.ok(session.historyWindowChars > 0);
});

test('Evicted turns produce a deterministic summary, cached and reused by window start', () => {
  const messages = [
    { id: 'm0', role: 'user', content: 'read src/calc.js' },
    {
      id: 'm1',
      role: 'assistant',
      content: '',
      toolCalls: [
        { name: 'read_file', args: { path: 'src/calc.js' }, status: 'completed', result: 'export const a = 1;' },
        { name: 'write_file', args: { path: 'reports/out.md', content: 'hello' }, status: 'completed', result: 'ok' }
      ]
    },
    { id: 'm2', role: 'user', content: 'continue' },
    { id: 'm3', role: 'assistant', content: 'done' }
  ];
  const { session, absIndexById } = sessionWith(messages);
  let persists = 0;
  const { evictedSummaryFor } = createWindowContext({
    session,
    absIndexById,
    persist: () => { persists += 1; }
  });

  const first = evictedSummaryFor(messages.slice(2));
  assert.match(first, /structured fact sheet/);
  assert.match(first, /reports\/out\.md/);
  assert.match(first, /read×|read/);
  assert.equal(persists, 1);

  // Same window start: reused directly, neither regenerated nor persisted again.
  const second = evictedSummaryFor(messages.slice(2));
  assert.equal(second, first);
  assert.equal(persists, 1);

  // Window start moves forward: rebuild the summary.
  const third = evictedSummaryFor(messages.slice(3));
  assert.equal(persists, 2);
  assert.ok(third.length > 0);
});

test('No summary is injected when the window start is 0 or a compaction already covers it', () => {
  const messages = [
    { id: 'm0', role: 'user', content: 'a' },
    { id: 'm1', role: 'assistant', content: 'b' }
  ];
  const { session, absIndexById } = sessionWith(messages);
  let persists = 0;
  const { evictedSummaryFor } = createWindowContext({
    session,
    absIndexById,
    persist: () => { persists += 1; }
  });
  assert.equal(evictedSummaryFor([]), '');
  assert.equal(evictedSummaryFor(messages), '');
  assert.equal(evictedSummaryFor(messages, { coveredEndIndex: 2 }), '');
  assert.equal(persists, 0);
});
