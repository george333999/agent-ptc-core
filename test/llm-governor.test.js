import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LlmGovernor,
  computeRetryDelay,
  fetchWithRetry,
  parseRetryAfterMs
} from '../server/llm-governor.js';

test('Retry-After parses both seconds and HTTP dates', () => {
  assert.equal(parseRetryAfterMs('2'), 2000);
  assert.equal(parseRetryAfterMs('0.5'), 500);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:03 GMT', now), 3000);
  assert.equal(parseRetryAfterMs(''), 0);
  assert.equal(parseRetryAfterMs('not-a-date'), 0);
});

test('Use full jitter exponential backoff when there is no Retry-After', () => {
  assert.equal(computeRetryDelay(0, { baseMs: 100, maxMs: 1000, random: () => 0 }), 50);
  assert.equal(computeRetryDelay(0, { baseMs: 100, maxMs: 1000, random: () => 1 }), 100);
  assert.equal(computeRetryDelay(1, { baseMs: 100, maxMs: 1000, random: () => 1 }), 200);
  assert.equal(computeRetryDelay(5, { baseMs: 100, maxMs: 1000, random: () => 1 }), 1000);
  assert.equal(computeRetryDelay(0, { retryAfterMs: 1500, baseMs: 100 }), 1500);
});

test('adaptive concurrency halves on 429 and recovers after consecutive successes', async () => {
  let clock = 0;
  const governor = new LlmGovernor({ maxConcurrency: 8, now: () => clock });
  assert.equal(governor.snapshot().limit, 8);
  governor.recordThrottle(0);
  assert.equal(governor.snapshot().limit, 4);
  governor.recordThrottle(0);
  assert.equal(governor.snapshot().limit, 2);
  governor.recordThrottle(0);
  assert.equal(governor.snapshot().limit, 1);
  governor.recordThrottle(0);
  assert.equal(governor.snapshot().limit, 1);
  for (let index = 0; index < 8; index += 1) governor.recordSuccess();
  assert.equal(governor.snapshot().limit, 2);
});

test('queue when concurrency slots reach the limit and continue after release', async () => {
  const governor = new LlmGovernor({ maxConcurrency: 2, now: () => 0 });
  const release1 = await governor.acquire();
  const release2 = await governor.acquire();
  let third = false;
  const thirdPromise = governor.acquire().then((release) => {
    third = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(third, false);
  assert.equal(governor.snapshot().queued, 1);
  release1();
  const release3 = await thirdPromise;
  assert.equal(third, true);
  assert.equal(governor.snapshot().active, 2);
  release2();
  release3();
  assert.equal(governor.snapshot().active, 0);
});

test('slot handover does not over-issue within a concurrency window', async () => {
  const governor = new LlmGovernor({ maxConcurrency: 1, now: () => 0 });
  const release1 = await governor.acquire();
  const pending2 = governor.acquire();
  const pending3 = governor.acquire();
  let maxActive = governor.snapshot().active;
  release1();
  const release2 = await pending2;
  maxActive = Math.max(maxActive, governor.snapshot().active);
  release2();
  const release3 = await pending3;
  maxActive = Math.max(maxActive, governor.snapshot().active);
  release3();
  assert.equal(maxActive, 1);
  assert.equal(governor.snapshot().active, 0);
});

test('when the circuit opens, queued requests fail immediately instead of waiting', async () => {
  let clock = 0;
  const governor = new LlmGovernor({ maxConcurrency: 1, now: () => clock });
  const release = await governor.acquire();
  const pending = governor.acquire();
  governor.recordThrottle(120000);
  release();
  await assert.rejects(
    () => pending,
    (error) => error.code === 'LLM_CIRCUIT_OPEN'
  );
  assert.equal(governor.snapshot().active, 0);
});

test('a long Retry-After triggers the circuit breaker and subsequent requests fail immediately', async () => {
  let clock = 0;
  const governor = new LlmGovernor({ maxConcurrency: 4, now: () => clock });
  governor.recordThrottle(120000);
  assert.equal(governor.snapshot().coolDownMs, 120000);
  await assert.rejects(
    () => governor.acquire(),
    (error) => error.code === 'LLM_CIRCUIT_OPEN' && error.retryAfterMs === 120000
  );
  clock = 130000;
  const release = await governor.acquire();
  release();
});

test('fetchWithRetry retries 429 and records throttling only once', async () => {
  const governor = new LlmGovernor({ maxConcurrency: 4, now: () => 0 });
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response('busy', {
        status: 429,
        headers: { 'retry-after': '0.001' }
      });
    }
    return new Response('ok', { status: 200 });
  };
  const response = await fetchWithRetry('http://example.test', {}, {
    governor,
    retries: 2,
    fetchImpl
  });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.equal(governor.snapshot().throttleCount, 1);
  assert.equal(governor.snapshot().limit, 2);
});

test('fetchWithRetry returns non-retryable 4xx directly', async () => {
  const governor = new LlmGovernor({ maxConcurrency: 4, now: () => 0 });
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return new Response('bad request', { status: 400 });
  };
  const response = await fetchWithRetry('http://example.test', {}, { governor, retries: 2, fetchImpl });
  assert.equal(response.status, 400);
  assert.equal(attempts, 1);
  assert.equal(governor.snapshot().throttleCount, 0);
});
