import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextRatio,
  shouldDistillToolResult,
  shouldTrimAtStep,
  degradeOldestToolResults,
  planTurnBoundaryDegrade,
  effectiveContextWindow,
  shrinkToTokenBudget,
  FALLBACK_CONTEXT_WINDOW
} from '../server/context-policy.js';

test('上下文比例被限制在 0 到 1，缺少窗口时为 0', () => {
  assert.equal(contextRatio({ promptTokens: 50, contextWindow: 100 }), 0.5);
  assert.equal(contextRatio({ promptTokens: 150, contextWindow: 100 }), 1);
  assert.equal(contextRatio({ promptTokens: 150, contextWindow: 0 }), 0);
  assert.equal(contextRatio(), 0);
});

test('轮内默认不蒸馏，只有接近 80% 才降级', () => {
  const base = { enabled: true, turnActive: true, outputChars: 50000, minChars: 1000 };
  assert.equal(shouldDistillToolResult({ ...base, contextRatio: 0.5 }), false);
  assert.equal(shouldDistillToolResult({ ...base, contextRatio: 0.8 }), true);
  assert.equal(shouldDistillToolResult({ ...base, contextRatio: 0.85 }), true);
  assert.equal(shouldDistillToolResult({ ...base, turnActive: false, contextRatio: 0.1 }), true);
  assert.equal(shouldDistillToolResult({ ...base, enabled: false, contextRatio: 0.95 }), false);
  assert.equal(shouldDistillToolResult({ ...base, outputChars: 10, contextRatio: 0.95 }), false);
});

test('裁剪只在轮边界或轮内 97% 紧急阈值触发', () => {
  assert.equal(shouldTrimAtStep({ step: 0, overHard: true, contextRatio: 0.95 }), true);
  assert.equal(shouldTrimAtStep({ step: 3, overHard: true, contextRatio: 0.96 }), false);
  assert.equal(shouldTrimAtStep({ step: 3, overHard: true, contextRatio: 0.97 }), true);
  assert.equal(shouldTrimAtStep({ step: 3, overHard: false, contextRatio: 0.99 }), false);
});

function toolMessage(id, size) {
  return { id, role: 'tool', content: 'x'.repeat(size) };
}

test('降级最旧工具结果，保留最近 N 条，且不改原数组', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    toolMessage('t1', 2000),
    toolMessage('t2', 2000),
    toolMessage('t3', 2000),
    { role: 'assistant', content: 'ok' }
  ];
  const result = degradeOldestToolResults(messages, { keepRecent: 1, degradeChars: 200 });
  assert.equal(result.degraded, 2);
  assert.equal(messages[1].content.length, 2000);
  assert.ok(result.messages[1].content.length < 2000);
  assert.match(result.messages[1].content, /已降级/);
  assert.equal(result.messages[3].content.length, 2000);
  assert.equal(result.messages.length, messages.length);
});

test('少于保护条数或无超长结果时不做任何降级', () => {
  const shortMessages = [toolMessage('t1', 10), toolMessage('t2', 10)];
  assert.equal(degradeOldestToolResults(shortMessages, { keepRecent: 4 }).degraded, 0);
  const result = degradeOldestToolResults([{ role: 'assistant', content: 'nothing' }], { keepRecent: 0 });
  assert.equal(result.degraded, 0);
});

test('轮边界降级受阈值控制', () => {
  const messages = [toolMessage('t1', 5000), toolMessage('t2', 5000)];
  const below = planTurnBoundaryDegrade(messages, { contextRatio: 0.5 });
  assert.equal(below.degraded, 0);
  const above = planTurnBoundaryDegrade(messages, { contextRatio: 0.85, keepRecent: 0, degradeChars: 100 });
  assert.equal(above.degraded, 2);
});

test('模型未配置上下文窗口时使用保守兜底值', () => {
  assert.equal(effectiveContextWindow(0), FALLBACK_CONTEXT_WINDOW);
  assert.equal(effectiveContextWindow(null), FALLBACK_CONTEXT_WINDOW);
  assert.equal(effectiveContextWindow(undefined), FALLBACK_CONTEXT_WINDOW);
  assert.equal(effectiveContextWindow(32768), 32768);
  assert.equal(effectiveContextWindow(0, 64000), 64000);
  // 兜底下限 8000，避免异常配置把窗口压到不可用。
  assert.equal(effectiveContextWindow(0, 1000), 8000);
});

test('上下文超限时先降级工具结果，再按轮丢弃最旧历史并保留当前轮', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'old turn 1' },
    { role: 'assistant', content: 'a1' },
    { role: 'tool', content: 'x'.repeat(20000) },
    { role: 'user', content: 'old turn 2' },
    { role: 'assistant', content: 'a2' },
    { role: 'tool', content: 'y'.repeat(20000) },
    { role: 'user', content: 'current question' },
    { role: 'assistant', content: 'working' },
    { role: 'tool', content: 'z'.repeat(20000) }
  ];
  const result = shrinkToTokenBudget(messages, { targetTokens: 5000, keepRecentTools: 1, degradeChars: 300 });
  assert.ok(result.degraded > 0);
  assert.ok(result.trimmed > 0);
  assert.equal(result.messages[0].role, 'system');
  assert.ok(result.messages.length < messages.length);
  assert.ok(result.messages.some((message) => message.content === 'current question'));
  // 原数组不被修改。
  assert.equal(messages.length, 10);
  assert.equal(messages[3].content.length, 20000);
  // 只剩当前轮时不再继续丢弃。
  const onlyTurn = shrinkToTokenBudget([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'only' },
    { role: 'assistant', content: 'a' }
  ], { targetTokens: 10 });
  assert.equal(onlyTurn.trimmed, 0);
  assert.equal(onlyTurn.messages.length, 3);
});

test('未超预算时不降级也不裁剪', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok' }
  ];
  const result = shrinkToTokenBudget(messages, { targetTokens: 100000 });
  assert.equal(result.degraded, 0);
  assert.equal(result.trimmed, 0);
  assert.equal(result.messages.length, 3);
});
