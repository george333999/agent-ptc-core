import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCompaction,
  buildFactSummary,
  compactionCandidateId,
  computeNetBenefit,
  estimateRemainingSteps,
  planPiggybackCompaction,
  planStandaloneCompaction,
  sanitizeFactText,
  selectCompactionRange,
  splitSavedTokens,
  validateCompaction
} from '../server/history-compact.js';

const POLICY = {
  phase1: true,
  phase2: true,
  schemaVersion: 1,
  minHistoryTokens: 1,
  phase1MinTokens: 1,
  phase1MinTokensShort: 1,
  phase2MinTokens: 1,
  summaryRatio: 0.5,
  summaryFloorTokens: 1,
  minRangeTokens: 1,
  minSavedRatio: 0.1,
  phase2IntervalSteps: 10,
  minStepsBetweenCompactions: 5,
  prices: { cacheHit: 2e-8, cacheMiss: 1e-6 }
};

function makeMessages(count = 6, resultSize = 4000) {
  const messages = [];
  for (let index = 0; index < count; index += 1) {
    if (index % 2 === 0) {
      messages.push({ id: `u_${index}`, role: 'user', content: `问题 ${index}` });
      continue;
    }
    messages.push({
      id: `a_${index}`,
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: `call_${index}_1`,
          name: 'read_file',
          args: { path: `src/file-${index}.js` },
          status: 'completed',
          result: `第 ${index} 步结果 ` + 'x'.repeat(resultSize)
        },
        {
          id: `call_${index}_2`,
          name: 'write_file',
          args: { path: `outputs/report-${index}.md`, content: 'y'.repeat(2000) },
          status: 'completed',
          result: `已写入 outputs/report-${index}.md（2000 字符）`
        }
      ]
    });
  }
  return messages;
}

function indexOf(messages) {
  return new Map(messages.map((message, index) => [message.id, index]));
}

test('事实清单：同一输入两次生成字节完全一致', () => {
  const messages = makeMessages(6);
  const absIndexById = indexOf(messages);
  const first = buildFactSummary({ messages, absIndexById, startAbs: 0, endAbs: 4, workspace: 'E:\\work' });
  const second = buildFactSummary({ messages, absIndexById, startAbs: 0, endAbs: 4, workspace: 'E:\\work' });
  assert.equal(first, second);
  assert.match(first, /结构化事实清单/);
  assert.match(first, /src\/file-1\.js|src\/file-3\.js/);
  assert.doesNotMatch(first, /\d{4}-\d{2}-\d{2}T/);
});

test('事实清单：脱敏密钥、折叠动态内容、隐藏绝对路径', () => {
  const text = sanitizeFactText(
    'path=E:\\Users\\me\\a.js key=sk-abcdefgh12345678 time=2026-11-19T10:00:00Z uuid=123e4567-e89b-12d3-a456-426614174000 password=hunter2',
    'E:\\Users\\me'
  );
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /\[DYNAMIC\]/);
  assert.doesNotMatch(text, /sk-abcdefgh/);
  assert.doesNotMatch(text, /hunter2/);
  assert.doesNotMatch(text, /E:\\Users\\me/);
});

test('压缩范围：只切在已完成的助手消息之后，不压缩进行中的工具往返', () => {
  const messages = [
    { id: 'u0', role: 'user', content: 'q0' },
    { id: 'a1', role: 'assistant', toolCalls: [{ id: 'c1', name: 'read_file', status: 'running', result: '' }] },
    { id: 'a2', role: 'assistant', toolCalls: [{ id: 'c2', name: 'read_file', status: 'completed', result: 'x'.repeat(4000) }] },
    { id: 'u3', role: 'user', content: 'q3' },
    { id: 'a4', role: 'assistant', toolCalls: [{ id: 'c4', name: 'read_file', status: 'completed', result: 'y'.repeat(4000) }] }
  ];
  const absIndexById = indexOf(messages);
  const range = selectCompactionRange({
    messages,
    absIndexById,
    startAbs: 0,
    targetRatio: 0.5,
    minSavedRatio: 0.1
  });
  assert.ok(range);
  assert.equal(range.endAbs, 3);
  assert.ok(messages[range.endAbs - 1].toolCalls.every((call) => call.status !== 'running'));
});

test('压缩范围：当前用户轮次之后的内容不会被卷入压缩', () => {
  const messages = [
    { id: 'u0', role: 'user', content: '旧问题' },
    { id: 'a1', role: 'assistant', content: '旧回答' },
    { id: 'u2', role: 'user', content: '当前问题：必须保留这个约束' },
    {
      id: 'a3',
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'c1', name: 'read_file', args: { path: 'a.js' }, status: 'completed', result: 'x'.repeat(5000) }
      ]
    }
  ];
  const absIndexById = indexOf(messages);
  const unguarded = selectCompactionRange({
    messages,
    absIndexById,
    startAbs: 0,
    targetRatio: 0.5,
    minSavedRatio: 0.1
  });
  assert.ok(unguarded.endAbs > absIndexById.get('u2'));
  const guarded = selectCompactionRange({
    messages,
    absIndexById,
    startAbs: 0,
    targetRatio: 0.5,
    minSavedRatio: 0.1,
    maxEndAbs: absIndexById.get('u2')
  });
  assert.equal(guarded, null);
});

test('压缩范围：压缩量不足 minSavedRatio 时放弃', () => {
  const messages = [
    { id: 'u0', role: 'user', content: 'small' },
    { id: 'a1', role: 'assistant', content: 'tiny' },
    { id: 'u2', role: 'user', content: 'z'.repeat(100000) },
    { id: 'a3', role: 'assistant', content: 'done' }
  ];
  const range = selectCompactionRange({
    messages,
    absIndexById: indexOf(messages),
    startAbs: 0,
    targetRatio: 0.5,
    minSavedRatio: 0.3
  });
  assert.equal(range, null);
});

test('Phase 1：生成压缩状态并通过校验', () => {
  const messages = makeMessages(8);
  const absIndexById = indexOf(messages);
  const plan = planPiggybackCompaction({
    messages,
    windowMessages: messages,
    absIndexById,
    compaction: null,
    taskType: 'task-1',
    taskClass: 'long',
    policy: POLICY,
    workspace: '',
    hitRatio: 0.8,
    usedSteps: 12,
    taskId: 's_1',
    turnId: 'run_1'
  });
  assert.equal(plan.action, 'compact');
  assert.ok(plan.state.coveredEndIndex > 0);
  assert.ok(plan.state.summary.content.length > 0);
  assert.equal(validateCompaction(messages, plan.state)?.coveredEndIndex, plan.state.coveredEndIndex);
  assert.equal(plan.event.applied, true);
  assert.ok(plan.event.netSavingTokens > 0);
});

test('Phase 1：历史太小或摘要超过 15% 预算时跳过', () => {
  const small = makeMessages(2, 10);
  const smallPlan = planPiggybackCompaction({
    messages: small,
    windowMessages: small,
    absIndexById: indexOf(small),
    policy: { ...POLICY, phase1MinTokens: 100000 },
    taskType: 'task',
    taskClass: 'long',
    taskId: 's',
    turnId: 'r'
  });
  assert.equal(smallPlan.action, 'skip');
  assert.equal(smallPlan.reason, 'tooSmall');

  const messages = makeMessages(4, 100);
  const qPlan = planPiggybackCompaction({
    messages,
    windowMessages: messages,
    absIndexById: indexOf(messages),
    policy: { ...POLICY, summaryRatio: 0.0001, summaryFloorTokens: 0.4, minRangeTokens: 1 },
    taskType: 'task',
    taskClass: 'long',
    taskId: 's',
    turnId: 'r'
  });
  assert.equal(qPlan.action, 'skip');
  assert.equal(qPlan.reason, 'qExceeds');
});

test('Phase 1：执行中前缀租约会跳过未溢出的压缩', () => {
  const messages = makeMessages(6);
  const plan = planPiggybackCompaction({
    messages,
    windowMessages: messages,
    absIndexById: indexOf(messages),
    policy: { ...POLICY, suppressMidRunCompaction: true },
    taskType: 'task',
    taskClass: 'long',
    usedSteps: 3,
    taskId: 's',
    turnId: 'r'
  });
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'midRunLease');
});

test('Phase 1：可选高水位未达到时跳过压缩', () => {
  const messages = makeMessages(6);
  const plan = planPiggybackCompaction({
    messages,
    windowMessages: messages,
    absIndexById: indexOf(messages),
    policy: { ...POLICY, phase1OverflowTokens: 10_000_000 },
    taskType: 'task',
    taskClass: 'long',
    taskId: 's',
    turnId: 'r'
  });
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'belowOverflow');
  assert.equal(plan.event.phase1OverflowTokens, 10_000_000);
});

test('Phase 1：结束阶段跳过压缩（裁剪仍照常）', () => {
  const messages = makeMessages(6);
  const plan = planPiggybackCompaction({
    messages,
    windowMessages: messages,
    absIndexById: indexOf(messages),
    policy: POLICY,
    taskType: 'task',
    taskClass: 'long',
    usedSteps: 18,
    finalPhase: true,
    hardLimitTokens: 10_000_000,
    taskId: 's',
    turnId: 'r'
  });
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'finalPhase');
});

test('Phase 1：预测不会溢出时跳过，预测会溢出时继续压缩', () => {
  const messages = makeMessages(6);
  const absIndexById = indexOf(messages);
  const base = {
    messages,
    windowMessages: messages,
    absIndexById,
    policy: { ...POLICY, predictiveCompaction: true },
    taskType: 'task',
    taskClass: 'long',
    usedSteps: 2,
    taskId: 's',
    turnId: 'r'
  };
  const safe = planPiggybackCompaction({ ...base, hardLimitTokens: 10_000_000 });
  assert.equal(safe.action, 'skip');
  assert.equal(safe.reason, 'projectedNoOverflow');
  assert.ok(safe.event.projectedTokens >= safe.event.windowTokens);
  assert.equal(safe.event.remainingSteps, 2);

  const risky = planPiggybackCompaction({ ...base, hardLimitTokens: 1 });
  assert.equal(risky.action, 'compact');

  const disabled = planPiggybackCompaction({
    ...base,
    policy: { ...POLICY, predictiveCompaction: false },
    hardLimitTokens: 10_000_000
  });
  assert.equal(disabled.action, 'compact');
});

test('Phase 1：水位按裁剪前体积判定，裁剪后的残留窗口不再误杀', () => {
  const messages = makeMessages(6);
  const base = {
    messages,
    windowMessages: messages,
    absIndexById: indexOf(messages),
    policy: { ...POLICY, phase1OverflowTokens: 1_000_000 },
    taskType: 'task',
    taskClass: 'long',
    usedSteps: 3,
    taskId: 's',
    turnId: 'r'
  };
  const compacted = planPiggybackCompaction({ ...base, contextTokens: 2_000_000 });
  assert.equal(compacted.action, 'compact');

  const below = planPiggybackCompaction({ ...base, contextTokens: 10 });
  assert.equal(below.action, 'skip');
  assert.equal(below.reason, 'belowOverflow');
  assert.equal(below.event.contextTokens, 10);

  // 未传 contextTokens 时退回裁剪后窗口口径，保持旧调用兼容。
  const fallback = planPiggybackCompaction(base);
  assert.equal(fallback.reason, 'belowOverflow');
});

test('压缩状态：校验失败时不应用，视图只保留摘要与边界之后的消息', () => {
  const messages = makeMessages(6);
  const absIndexById = indexOf(messages);
  const plan = planPiggybackCompaction({
    messages,
    windowMessages: messages,
    absIndexById,
    policy: POLICY,
    taskType: 'task',
    taskClass: 'long',
    taskId: 's',
    turnId: 'r'
  });
  assert.equal(plan.action, 'compact');
  const applied = applyCompaction(messages, plan.state, absIndexById);
  assert.equal(applied.applied, true);
  assert.equal(applied.messages[0].role, 'summary');
  assert.equal(applied.messages.length, messages.length - plan.state.coveredEndIndex + 1);

  const tampered = { ...plan.state, lastCoveredMessageId: 'missing' };
  assert.equal(validateCompaction(messages, tampered), null);
});

test('净收益：token 口径与费用口径分离，回读/重建成本会压低收益', () => {
  const benefit = computeNetBenefit({
    savedTokens: 1000,
    hitRatio: 0.8,
    prices: POLICY.prices
  });
  assert.equal(benefit.netSavingTokens, 1000);
  assert.equal(benefit.savedHitTokens, 800);
  assert.equal(benefit.savedMissTokens, 200);
  assert.ok(benefit.netBenefitCNY > 0);
  assert.equal(benefit.qualifies, true);

  const heavyReadback = computeNetBenefit({
    savedTokens: 1000,
    hitRatio: 0.8,
    readbackTokens: 600,
    rebuildTokens: 500,
    prices: POLICY.prices
  });
  assert.equal(heavyReadback.netSavingTokens, -100);
  assert.equal(heavyReadback.qualifies, false);

  const split = splitSavedTokens(1000, 0.25);
  assert.equal(split.savedHitTokens, 250);
  assert.equal(split.savedMissTokens, 750);
});

test('R 估算：有同类中位数时优先，缺失时退回已用步数并标注 fallback', () => {
  assert.deepEqual(
    estimateRemainingSteps({ usedSteps: 10, typeMedianSteps: 26 }),
    { value: 16, fallback: 'typeMedian' }
  );
  assert.deepEqual(
    estimateRemainingSteps({ usedSteps: 10, typeMedianSteps: null }),
    { value: 10, fallback: 'usedSteps' }
  );
  assert.deepEqual(
    estimateRemainingSteps({ usedSteps: 80, typeMedianSteps: null }),
    { value: 50, fallback: 'usedSteps' }
  );
});

test('candidateId 对同一区间稳定，对区间变化敏感', () => {
  const first = compactionCandidateId({ taskId: 's', turnId: 'r', startAbs: 0, endAbs: 10, coveredIdsHash: 'abc', schemaVersion: 1 });
  const second = compactionCandidateId({ taskId: 's', turnId: 'r', startAbs: 0, endAbs: 10, coveredIdsHash: 'abc', schemaVersion: 1 });
  const third = compactionCandidateId({ taskId: 's', turnId: 'r', startAbs: 0, endAbs: 11, coveredIdsHash: 'abc', schemaVersion: 1 });
  assert.equal(first, second);
  assert.notEqual(first, third);
});

test('Phase 2：关闭时跳过；pending 任务跳过；净收益不等式不成立时跳过', () => {
  const messages = makeMessages(8);
  const absIndexById = indexOf(messages);
  const base = {
    messages,
    windowMessages: messages,
    absIndexById,
    taskType: 'task-1',
    workspace: '',
    usedSteps: 12,
    stepsSinceLastCompaction: 10,
    taskId: 's',
    turnId: 'r'
  };
  assert.equal(planStandaloneCompaction({ ...base, policy: { ...POLICY, phase2: false } }).reason, 'disabled');
  assert.equal(planStandaloneCompaction({ ...base, taskType: 'pending', policy: POLICY }).reason, 'pendingTask');

  const expensive = planStandaloneCompaction({
    ...base,
    policy: POLICY,
    measureAfterTokens: () => 100000000
  });
  assert.equal(expensive.action, 'skip');
  assert.equal(expensive.reason, 'netNegative');
  assert.equal(expensive.event.pAfterTokens, 100000000);
});

test('Phase 2：预算为正时执行并记录 rEstFallback 与 P_after', () => {
  const messages = makeMessages(10);
  const plan = planStandaloneCompaction({
    messages,
    windowMessages: messages,
    absIndexById: indexOf(messages),
    policy: POLICY,
    taskType: 'task-1',
    workspace: '',
    usedSteps: 20,
    stepsSinceLastCompaction: 10,
    measureAfterTokens: () => 10,
    taskId: 's',
    turnId: 'r'
  });
  assert.equal(plan.action, 'compact');
  assert.equal(plan.event.applied, true);
  assert.equal(plan.event.pAfterTokens, 10);
  assert.equal(plan.event.rEstFallback, 'usedSteps');
});
