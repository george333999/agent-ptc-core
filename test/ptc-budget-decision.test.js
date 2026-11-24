import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PTC_BUDGET_OPTIONS,
  askPtcBudgetDecision,
  classifyPtcBudgetAnswer
} from '../server/ptc/budget-decision.js';

function makeDeps(response = { answered: true, answer: PTC_BUDGET_OPTIONS[0] }, assistantOverrides = {}) {
  const events = [];
  const assistant = { id: 'a1', toolCalls: [], content: '预算用尽', ...assistantOverrides };
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

test('预算用尽时创建澄清卡片，选择继续返回 continue 并记录答案', async () => {
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

test('选择停止使用 PTC 时返回 native', async () => {
  const deps = makeDeps({ answered: true, answer: PTC_BUDGET_OPTIONS[1] });
  const result = await askPtcBudgetDecision(deps);
  assert.equal(result.action, 'native');
});

test('已有 ptc_run 调用时复用该调用作为卡片锚点', async () => {
  const deps = makeDeps(
    { answered: true, answer: '继续' },
    { toolCalls: [{ id: 'c-existing', name: 'ptc_run', args: {}, status: 'error', result: 'PTC_TOOL_BUDGET' }] }
  );
  const result = await askPtcBudgetDecision(deps);
  assert.equal(result.action, 'continue');
  assert.equal(deps.assistant.toolCalls.length, 1);
  assert.equal(deps.assistant.toolCalls[0].id, 'c-existing');
  assert.equal(deps.assistant.toolCalls[0].interaction.status, 'answered');
});

test('等待超时或取消时返回 stop，不会误继续任务', async () => {
  const timeoutDeps = makeDeps({ answered: false, answer: '', timeout: true, aborted: false });
  const timeout = await askPtcBudgetDecision(timeoutDeps);
  assert.deepEqual(timeout, { action: 'stop', reason: 'timeout', answer: '' });
  assert.equal(timeoutDeps.assistant.toolCalls[0].interaction.status, 'timeout');

  const abortDeps = makeDeps({ answered: false, answer: '', timeout: false, aborted: true });
  const aborted = await askPtcBudgetDecision(abortDeps);
  assert.deepEqual(aborted, { action: 'stop', reason: 'aborted', answer: '' });
  assert.equal(abortDeps.assistant.toolCalls[0].interaction.status, 'aborted');
});

test('自由输入默认继续 PTC，明确停用才切换传统工具', () => {
  assert.equal(classifyPtcBudgetAnswer('先只读关键文件，再继续'), 'continue');
  assert.equal(classifyPtcBudgetAnswer('不要再用 eval，继续用 PTC 处理'), 'continue');
  assert.equal(classifyPtcBudgetAnswer('别用 PTC 了，改用传统方式'), 'native');
});
