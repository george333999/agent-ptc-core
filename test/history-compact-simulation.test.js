import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHistoryWindow, shouldTrimHistory } from '../server/history-window.js';
import { buildRequestFingerprint } from '../server/prefix.js';
import {
  applyCompaction,
  planPiggybackCompaction,
  validateCompaction
} from '../server/history-compact.js';

// End-to-end simulation: the effect of "window trim + piggyback compaction" on request size and cache prefix within a long task.
const LIMITS = { softMessages: 48, hardMessages: 64, softChars: 10_000_000, hardChars: 20_000_000 };
const SYSTEM = 'stable main system prompt';
const TOOLS = [{ type: 'function', function: { name: 'read_file' } }];
const POLICY = {
  phase1: true,
  phase2: false,
  schemaVersion: 1,
  minHistoryTokens: 1,
  phase1MinTokens: 1,
  phase1MinTokensShort: 1,
  phase2MinTokens: 1,
  summaryRatio: 0.5,
  summaryFloorTokens: 1,
  minRangeTokens: 1,
  minSavedRatio: 0.1,
  minStepsBetweenCompactions: 5,
  prices: { cacheHit: 2e-8, cacheMiss: 1e-6 }
};

function buildSession(turns = 90) {
  const messages = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ id: `u_${index}`, role: 'user', content: `please handle question ${index} ${'q'.repeat(80)}` });
    messages.push({
      id: `a_${index}`,
      role: 'assistant',
      content: `step ${index} conclusion`,
      toolCalls: [{
        id: `call_${index}`,
        name: 'read_file',
        args: { path: `src/module-${index}.js` },
        status: 'completed',
        result: `content of file ${index}: ` + 'r'.repeat(3000)
      }]
    });
  }
  return messages;
}

function indexOf(messages) {
  const map = new Map();
  messages.forEach((message, index) => map.set(message.id, index));
  return map;
}

function fingerprint(messages) {
  return buildRequestFingerprint({ system: SYSTEM, tools: TOOLS, messages }).text;
}

function simulate({ compact }) {
  const session = buildSession();
  const absIndexById = indexOf(session);
  let baseRaw = applyHistoryWindow(session.slice(0, 48), LIMITS);
  let baseView = baseRaw;
  let windowSession = baseRaw.slice();
  let appendedView = [];
  let baseLength = baseRaw.length;
  let compaction = null;
  let compactions = 0;
  let previousFingerprint = '';
  let prefixBreaks = 0;
  let compactionsSavedChars = 0;
  const requestSizes = [];

  for (let cursor = 48; cursor <= session.length; cursor += 2) {
    const appended = session.slice(cursor - 2, cursor);
    windowSession = [...windowSession, ...appended];
    appendedView = [...appendedView, ...appended];
    if (shouldTrimHistory(windowSession, baseLength, LIMITS)) {
      baseRaw = applyHistoryWindow(windowSession, LIMITS);
      baseView = baseRaw;
      if (compact) {
        const plan = planPiggybackCompaction({
          messages: session,
          windowMessages: baseRaw,
          absIndexById,
          compaction,
          taskType: 'task-type',
          taskClass: 'long',
          policy: POLICY,
          workspace: '',
          hitRatio: 0.9,
          usedSteps: cursor,
          taskId: 's',
          turnId: 'r'
        });
        if (plan.action === 'compact') {
          const before = JSON.stringify(baseRaw).length;
          compaction = plan.state;
          compactions += 1;
          baseView = applyCompaction(baseRaw, compaction, absIndexById).messages;
          compactionsSavedChars += before - JSON.stringify(baseView).length;
        }
      }
      windowSession = baseRaw.slice();
      appendedView = [];
      baseLength = baseRaw.length;
    }
    const view = [...baseView, ...appendedView];
    const request = fingerprint(view);
    requestSizes.push(request.length);
    if (previousFingerprint && !request.startsWith(previousFingerprint)) prefixBreaks += 1;
    previousFingerprint = request;
  }

  const average = requestSizes.reduce((total, value) => total + value, 0) / requestSizes.length;
  return { average, compactions, prefixBreaks, compactionsSavedChars, compaction };
}

test('Long-task simulation: piggyback compaction significantly reduces request size without extra prefix breaks', () => {
  const baseline = simulate({ compact: false });
  const optimized = simulate({ compact: true });

  assert.ok(optimized.compactions >= 1, `should compact at least once, actual ${optimized.compactions}`);
  assert.ok(optimized.average < baseline.average * 0.85, `average request size after compaction ${optimized.average} should be clearly less than ${baseline.average}`);
  assert.ok(optimized.compactionsSavedChars > 0);
  // Compaction only happens at trim points and creates no extra prefix breaks (allowing 1 boundary error).
  assert.ok(
    optimized.prefixBreaks <= baseline.prefixBreaks + 1,
    `compaction prefix breaks ${optimized.prefixBreaks} should not be clearly more than baseline ${baseline.prefixBreaks}`
  );
});

test('Compaction state boundary advances monotonically with trim and always passes validation', () => {
  const session = buildSession(60);
  const absIndexById = indexOf(session);
  let compaction = null;
  let lastEnd = 0;
  for (let cursor = 48; cursor <= session.length; cursor += 4) {
    const window = applyHistoryWindow(session.slice(0, cursor), LIMITS);
    const plan = planPiggybackCompaction({
      messages: session,
      windowMessages: window,
      absIndexById,
      compaction,
      taskType: 'task-type',
      taskClass: 'long',
      policy: POLICY,
      workspace: '',
      hitRatio: 0.9,
      usedSteps: cursor,
      taskId: 's',
      turnId: 'r'
    });
    if (plan.action !== 'compact') continue;
    compaction = plan.state;
    assert.ok(compaction.coveredEndIndex >= lastEnd);
    lastEnd = compaction.coveredEndIndex;
    assert.ok(validateCompaction(session, compaction));
  }
  assert.ok(lastEnd > 0);
});
