import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyedMutex } from '../server/locks.js';

test('The same key runs serially; different keys may run in parallel', async () => {
  const mutex = new KeyedMutex();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = mutex.run('same', async () => {
    events.push('same:1:start');
    await firstGate;
    events.push('same:1:end');
  });
  const second = mutex.run('same', async () => {
    events.push('same:2:start');
  });
  const other = mutex.run('other', async () => {
    events.push('other:start');
  });
  await other;
  assert.deepEqual(events, ['same:1:start', 'other:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['same:1:start', 'other:start', 'same:1:end', 'same:2:start']);
  assert.equal(mutex.tails.size, 0);
});

test('A failed task does not block later tasks on the same key', async () => {
  const mutex = new KeyedMutex();
  await assert.rejects(() => mutex.run('k', async () => {
    throw new Error('boom');
  }), /boom/);
  const value = await mutex.run('k', async () => 'next');
  assert.equal(value, 'next');
  assert.equal(mutex.tails.size, 0);
});
