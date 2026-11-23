import test from 'node:test';
import assert from 'node:assert/strict';
import {
  taskSignature,
  shouldEnableMemo,
  createTaskMemo,
  renderMemoHint
} from '../server/task-memo.js';

test('严格签名要求明确动作词与足够信息量', () => {
  assert.equal(taskSignature('今天天气不错').signature, '');
  assert.equal(taskSignature('修复').signature, '');
  const first = taskSignature('修复登录页的样式错位问题');
  assert.ok(first.signature);
  assert.equal(first.signature, taskSignature('修复登录页的样式错位问题！').signature);
  assert.equal(first.signature, taskSignature('修复登录页的样式错位问题（第二次）').signature);
  assert.notEqual(first.signature, taskSignature('优化首页加载速度'));
});

test('重复率阈值严格大于 30% 才启用', () => {
  assert.equal(shouldEnableMemo(0.3), false);
  assert.equal(shouldEnableMemo(0.31), true);
  assert.equal(shouldEnableMemo('0.5'), true);
  assert.equal(shouldEnableMemo(null), false);
});

test('备忘必须同时匹配签名与文件指纹，空指纹不使用', () => {
  const memo = createTaskMemo();
  const signature = taskSignature('优化报告生成速度').signature;
  memo.record({ signature, path: 'a.md', fingerprint: 'fp1', hint: '先分析瓶颈再改' });
  assert.equal(memo.lookup({ signature, fingerprint: 'fp2' }), null);
  assert.equal(memo.lookup({ signature, fingerprint: '' }), null);
  assert.equal(memo.lookup({ signature, fingerprint: 'fp1' }).hint, '先分析瓶颈再改');
  assert.equal(memo.lookup({ signature: 'missing', fingerprint: 'fp1' }), null);
  assert.equal(memo.size(), 1);
});

test('重复计数与重复率计算', () => {
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

test('备忘提示只作为参考，并标注指纹变化', () => {
  const hint = renderMemoHint({ hint: '上次先改解析器' });
  assert.match(hint, /仅供参考/);
  assert.match(hint, /指纹已变化/);
  assert.equal(renderMemoHint(null), '');
});
