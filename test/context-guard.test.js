import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextLengthMessage,
  contextLimitFromError,
  isContextLengthError,
  planContextOverflow
} from '../server/context-guard.js';

const PROVIDER_ERROR = "模型服务返回 400: This model's maximum context length is 1048576 tokens. However, you requested 1049803 tokens (1049803 in the messages, 0 in the completion). Please reduce the length of the messages or completion. (request_id 31836de9)";

test('识别供应商上下文超限错误并解析真实上限', () => {
  assert.equal(isContextLengthError(PROVIDER_ERROR), true);
  assert.equal(isContextLengthError('socket hang up'), false);
  assert.equal(contextLimitFromError(PROVIDER_ERROR), 1048576);
  assert.equal(contextLimitFromError('context length of 32768 tokens exceeded'), 32768);
  assert.equal(contextLimitFromError('unknown error'), 0);
});

test('非上下文错误不做处理', () => {
  const plan = planContextOverflow({ contextWindow: 128000, messages: [], errorMessage: 'socket hang up' });
  assert.equal(plan.handled, false);
  assert.equal(plan.retry, false);
});

function bigMessages() {
  const turn = (label) => ([
    { role: 'user', content: `${label} question` },
    { role: 'assistant', content: `${label} answer` },
    { role: 'tool', content: 'x'.repeat(120000) }
  ]);
  return [
    { role: 'system', content: 'sys' },
    ...turn('old 1'),
    ...turn('old 2'),
    ...turn('old 3'),
    ...turn('current')
  ];
}

test('上下文超限时压缩请求视图并重试，同时收紧窗口', () => {
  const messages = bigMessages();
  const plan = planContextOverflow({
    contextWindow: 128000,
    messages,
    errorMessage: PROVIDER_ERROR,
    retriesUsed: 0
  });
  assert.equal(plan.handled, true);
  assert.equal(plan.retry, true);
  assert.equal(plan.contextWindow, 128000);
  assert.ok(plan.messages.length <= messages.length);
  assert.ok(plan.messages.some((message) => message.content === 'current question'));
  assert.equal(plan.attempt, 1);
  assert.match(plan.retryMessage, /已压缩历史后重试/);
});

test('重试次数用尽后给出可读错误，且不丢失原始信息', () => {
  const plan = planContextOverflow({
    contextWindow: 128000,
    messages: bigMessages(),
    errorMessage: PROVIDER_ERROR,
    retriesUsed: 2
  });
  assert.equal(plan.handled, true);
  assert.equal(plan.retry, false);
  assert.match(plan.error, /上下文超出模型可处理长度/);
  assert.match(plan.error, /原始错误/);
});

test('无可压缩内容时直接返回可读错误，避免空转重试', () => {
  const plan = planContextOverflow({
    contextWindow: 128000,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'only question' }
    ],
    errorMessage: 'prompt is too long',
    retriesUsed: 0
  });
  assert.equal(plan.handled, true);
  assert.equal(plan.retry, false);
  assert.match(plan.error, /上下文超出模型可处理长度/);
});

test('可读错误缺少窗口时也能生成提示', () => {
  assert.match(contextLengthMessage('boom', 0), /上下文超出模型可处理长度/);
  assert.match(contextLengthMessage('boom', 128000), /128k tokens/);
});
