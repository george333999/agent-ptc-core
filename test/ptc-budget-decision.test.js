import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PTC_BUDGET_OPTIONS,
  askPtcBudgetDecision,
  classifyPtcBudgetAnswer
} from '../server/ptc/budget-decision.js';

function makeDeps(response = { answered: true, answer: PTC_BUDGET_OPTIONS[0] }, assistantOverrides = {}) {
  const events = [];
  const assistant = { id: 'a1', toolCalls: [], content: 'budget exhausted', ...assistantOverrides };
  return {
    events,
    assistant,
    session: { id: 's1', messages: [] },
    deviceId: 'device-1',
    signal: new AbortController().signal,
    emit: (event, data) => events.push({ event, data }),
    persist: () => {},
    addApprovalWaitMs: () => {},
    waitForClarification: async () => ({ timeout: false, aborted: false, answer: '', ...response }),
    newId: (prefix) => `${prefix}1`,
    toolMeta: () => ({ label: 'PTC', icon: 'zap' })
  };
}

test('Budget exhaustion creates a clarification card; choosing continue returns continue and records the answer', async () => {
  const deps = makeDeps({ answered: true, answer: PTC_BUDGET_OPTIONS[0] });
  const result = await askPtcBudgetDecision(deps);
  assert.equal(result.action, 'continue');
  assert.equal(deps.assistant.toolCalls.length, 1);
  assert.equal(deps.assistant.toolCalls[0].name, 'ptc_budget');
  assert.equal(deps.assistant.toolCalls[0].virtual, true);
  assert.equal(deps.assistant.toolCalls[0].interaction.status, 'answered');
  assert.equal(deps.assistant.toolCalls[0].interaction.answer, PTC_BUDGET_OPTIONS[0]);
  const request = deps.events.find((item) => item.event === 'clarify_request');
  assert.equal(request.data.options.length, 3);
  assert.equal(request.data.allowFreeText, true);
  assert.ok(deps.events.some((item) => item.event === 'clarify_resolved' && item.data.answered === true));
});

test('Choosing to stop using PTC returns native', async () => {
  const deps = makeDeps({ answered: true, answer: PTC_BUDGET_OPTIONS[1] });
  const result = await askPtcBudgetDecision(deps);
  assert.equal(result.action, 'native');
});

test('An existing ptc_run call is reused as the card anchor', async () => {
  const deps = makeDeps(
    { answered: true, answer: 'continue' },
    { toolCalls: [{ id: 'c-existing', name: 'ptc_run', args: {}, status: 'error', result: 'PTC_TOOL_BUDGET' }] }
  );
  const result = await askPtcBudgetDecision(deps);
  assert.equal(result.action, 'continue');
  assert.equal(deps.assistant.toolCalls.length, 1);
  assert.equal(deps.assistant.toolCalls[0].id, 'c-existing');
  assert.equal(deps.assistant.toolCalls[0].interaction.status, 'answered');
});

test('Timeout or cancel returns stop and does not accidentally continue the task', async () => {
  const timeoutDeps = makeDeps({ answered: false, answer: '', timeout: true, aborted: false });
  const timeout = await askPtcBudgetDecision(timeoutDeps);
  assert.deepEqual(timeout, { action: 'stop', reason: 'timeout', answer: '' });
  assert.equal(timeoutDeps.assistant.toolCalls[0].interaction.status, 'timeout');

  const abortDeps = makeDeps({ answered: false, answer: '', timeout: false, aborted: true });
  const aborted = await askPtcBudgetDecision(abortDeps);
  assert.deepEqual(aborted, { action: 'stop', reason: 'aborted', answer: '' });
  assert.equal(abortDeps.assistant.toolCalls[0].interaction.status, 'aborted');
});

test('Free-form input defaults to continuing PTC; only an explicit stop switches to traditional tools', () => {
  assert.equal(classifyPtcBudgetAnswer('read only the key files first, then continue'), 'continue');
  assert.equal(classifyPtcBudgetAnswer('do not use eval again, keep using PTC'), 'continue');
  assert.equal(classifyPtcBudgetAnswer('别用 PTC 了，改用传统方式'), 'native');
});
