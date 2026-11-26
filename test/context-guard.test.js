import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextLengthMessage,
  contextLimitFromError,
  isContextLengthError,
  planContextOverflow
} from '../server/context-guard.js';

const PROVIDER_ERROR = "Model service returned 400: This model's maximum context length is 1048576 tokens. However, you requested 1049803 tokens (1049803 in the messages, 0 in the completion). Please reduce the length of the messages or completion. (request_id 31836de9)";

test('Recognizes provider context-overflow errors and parses the real limit', () => {
  assert.equal(isContextLengthError(PROVIDER_ERROR), true);
  assert.equal(isContextLengthError('socket hang up'), false);
  assert.equal(contextLimitFromError(PROVIDER_ERROR), 1048576);
  assert.equal(contextLimitFromError('context length of 32768 tokens exceeded'), 32768);
  assert.equal(contextLimitFromError('unknown error'), 0);
});

test('Non-context errors are not handled', () => {
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

test('On context overflow, compresses the request view and retries while tightening the window', () => {
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
  assert.match(plan.retryMessage, /retrying after compressing history/);
});

test('After retries are exhausted, returns a readable error without losing the original information', () => {
  const plan = planContextOverflow({
    contextWindow: 128000,
    messages: bigMessages(),
    errorMessage: PROVIDER_ERROR,
    retriesUsed: 2
  });
  assert.equal(plan.handled, true);
  assert.equal(plan.retry, false);
  assert.match(plan.error, /Context exceeds the model's processable length/);
  assert.match(plan.error, /Original error/);
});

test('Returns a readable error directly when there is nothing to compress, avoiding a no-op retry', () => {
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
  assert.match(plan.error, /Context exceeds the model's processable length/);
});

test('Still builds the hint when the readable error has no window', () => {
  assert.match(contextLengthMessage('boom', 0), /Context exceeds the model's processable length/);
  assert.match(contextLengthMessage('boom', 128000), /128k tokens/);
});
