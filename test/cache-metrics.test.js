import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordCacheSample } from '../server/cache-metrics.js';

test('write JSONL per day and keep worker dimension fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cache-'));
  try {
    await recordCacheSample(dir, {
      kind: 'main',
      workerId: 'main',
      frozenPrefixHash: 'abc123',
      cacheHitTokens: 800,
      cacheMissTokens: 200
    });
    await recordCacheSample(dir, {
      kind: 'worker',
      workerId: 'worker:t1',
      frozenPrefixHash: 'def456',
      cacheHitTokens: 0,
      cacheMissTokens: 500
    });
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.kind, 'main');
    assert.equal(first.workerId, 'main');
    assert.equal(first.frozenPrefixHash, 'abc123');
    assert.equal(first.cacheHitTokens, 800);
    assert.ok(first.ts);
    assert.equal(second.workerId, 'worker:t1');
    assert.equal(second.cacheMissTokens, 500);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent writes do not drop lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cache-'));
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => recordCacheSample(dir, {
      kind: 'worker',
      workerId: `worker:${index}`,
      step: index
    })));
    const file = fs.readdirSync(dir).find((name) => name.endsWith('.jsonl'));
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n');
    assert.equal(lines.length, 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid input does not throw', async () => {
  await assert.doesNotReject(recordCacheSample('', { kind: 'x' }));
  await assert.doesNotReject(recordCacheSample(null, null));
});
