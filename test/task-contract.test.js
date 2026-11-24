import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_ITEM_MAX,
  CONTRACT_LIST_MAX,
  SOCRATIC_QUESTIONS,
  buildSocraticBrief,
  contractForOrchestration,
  normalizeContract,
  renderAssumptions,
  renderDefinitionOfDone,
  shouldUseSocraticBrief
} from '../server/task-contract.js';

test('自检五问完整且文本稳定，不含时间等易变内容', () => {
  assert.equal(SOCRATIC_QUESTIONS.length, 5);
  const first = buildSocraticBrief();
  const second = buildSocraticBrief();
  assert.equal(first, second);
  for (const question of SOCRATIC_QUESTIONS) {
    assert.ok(first.includes(question), `缺少问题：${question}`);
  }
  assert.match(first, /不要为自检额外调用工具/);
  assert.match(first, /definitionOfDone/);
  assert.ok(first.length < 1200, `自检块应保持紧凑，实际 ${first.length} 字符`);
});

test('自检只在复杂 Agent 任务启用，Chat、简单任务和显式关闭都不启用', () => {
  assert.equal(shouldUseSocraticBrief({ mode: 'agent', complexTask: true }), true);
  assert.equal(shouldUseSocraticBrief({ mode: 'agent', complexTask: false }), false);
  assert.equal(shouldUseSocraticBrief({ mode: 'chat', complexTask: true }), false);
  assert.equal(shouldUseSocraticBrief({ mode: 'agent', complexTask: true, settings: { socraticBrief: false } }), false);
});

test('契约规范化：去空、去重、裁剪条目长度与数量', () => {
  const contract = normalizeContract({
    definitionOfDone: ['  a  b  ', '', 'A B', 'x'.repeat(CONTRACT_ITEM_MAX + 50), null],
    assumptions: 'single-string'
  });
  assert.equal(contract.definitionOfDone.length, 2);
  assert.equal(contract.definitionOfDone[0], 'a b');
  assert.equal(contract.definitionOfDone[1], 'x'.repeat(CONTRACT_ITEM_MAX));
  assert.deepEqual(contract.assumptions, ['single-string']);
});

test('契约边界：空输入、非数组、超量条目都不会抛错', () => {
  assert.deepEqual(normalizeContract(), { definitionOfDone: [], assumptions: [] });
  assert.deepEqual(normalizeContract({ definitionOfDone: 42, assumptions: null }), {
    definitionOfDone: ['42'],
    assumptions: []
  });
  const many = Array.from({ length: 20 }, (_, index) => `item-${index}`);
  const contract = normalizeContract({ definitionOfDone: many, assumptions: many });
  assert.equal(contract.definitionOfDone.length, CONTRACT_LIST_MAX);
  assert.equal(contract.assumptions.length, CONTRACT_LIST_MAX);
});

test('编排契约：缺少完成判据时使用确定性兜底，已有判据保持不变', () => {
  const derived = contractForOrchestration({});
  assert.equal(derived.definitionOfDone.length, 1);
  assert.match(derived.definitionOfDone[0], /expectedOutput/);
  const explicit = contractForOrchestration({ definitionOfDone: ['产物文件存在且校验通过'] });
  assert.deepEqual(explicit.definitionOfDone, ['产物文件存在且校验通过']);
});

test('Worker 段落：完成判据与假设按预算裁剪，空内容不产生空段', () => {
  assert.equal(renderDefinitionOfDone([]), '');
  assert.equal(renderAssumptions(undefined), '');
  const done = renderDefinitionOfDone(['条件一', '条件二'], { maxChars: 400 });
  assert.match(done, /^# 完成判据/);
  assert.match(done, /条件一/);
  const clipped = renderDefinitionOfDone(
    Array.from({ length: 6 }, (_, index) => `判据 ${index} ${'很长的描述'.repeat(20)}`),
    { maxChars: 120 }
  );
  assert.ok(clipped.length <= 120);
  assert.ok(clipped.endsWith('…'));
  const assumptions = renderAssumptions(['假设 A'], { maxChars: 100 });
  assert.match(assumptions, /^# 关键假设/);
});
