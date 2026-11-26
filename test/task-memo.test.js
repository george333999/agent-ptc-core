import test from 'node:test';
import assert from 'node:assert/strict';
import {
  taskSignature,
  shouldEnableMemo,
  createTaskMemo,
  renderMemoHint
} from '../server/task-memo.js';

test('strict signature requires an explicit action word and sufficient information', () => {
  assert.equal(taskSignature('今天天气不错').signature, '');
  assert.equal(taskSignature('修复').signature, '');
  const first = taskSignature('修复登录页的样式错位问题');
  assert.ok(first.signature);
  assert.equal(first.signature, taskSignature('修复登录页的样式错位问题！').signature);
  assert.equal(first.signature, taskSignature('修复登录页的样式错位问题（第二次）').signature);
  assert.notEqual(first.signature, taskSignature('优化首页加载速度'));
});

test('enabled only when the repeat-rate threshold is strictly greater than 30%', () => {
  assert.equal(shouldEnableMemo(0.3), false);
  assert.equal(shouldEnableMemo(0.31), true);
  assert.equal(shouldEnableMemo('0.5'), true);
  assert.equal(shouldEnableMemo(null), false);
});

test('memo must match both signature and file fingerprint; empty fingerprint is not used', () => {
  const memo = createTaskMemo();
  const signature = taskSignature('优化报告生成速度').signature;
  memo.record({ signature, path: 'a.md', fingerprint: 'fp1', hint: 'analyze the bottleneck first, then modify' });
  assert.equal(memo.lookup({ signature, fingerprint: 'fp2' }), null);
  assert.equal(memo.lookup({ signature, fingerprint: '' }), null);
  assert.equal(memo.lookup({ signature, fingerprint: 'fp1' }).hint, 'analyze the bottleneck first, then modify');
  assert.equal(memo.lookup({ signature: 'missing', fingerprint: 'fp1' }), null);
  assert.equal(memo.size(), 1);
});

test('repeat counting and repeat-rate calculation', () => {
  const memo = createTaskMemo();
  const signature = 'abc';
  assert.deepEqual(memo.track(signature), { count: 1, repeatRate: 0 });
  const second = memo.track(signature);
  assert.equal(second.count, 2);
  assert.equal(second.repeatRate, 0.5);
  memo.track('other');
  assert.equal(memo.track('other').repeatRate, 0.25);
  assert.deepEqual(memo.track(''), { count: 0, repeatRate: 0 });
});

test('memo hint is reference only and notes fingerprint changes', () => {
  const hint = renderMemoHint({ hint: 'modify the parser first next time' });
  assert.match(hint, /for reference only/);
  assert.match(hint, /fingerprint has changed/);
  assert.equal(renderMemoHint(null), '');
});
