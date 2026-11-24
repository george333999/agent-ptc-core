import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResourceLocks } from '../server/resource-locks.js';
import { createVerifyScheduler } from '../server/verify-scheduler.js';

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-scheduler-'));
  fs.writeFileSync(path.join(root, 'a.md'), 'alpha');
  fs.writeFileSync(path.join(root, 'b.md'), 'beta');
  return root;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeScheduler(options = {}) {
  const locks = createResourceLocks();
  return {
    locks,
    scheduler: createVerifyScheduler({
      versions: locks.versions,
      debounceMs: 0,
      maxDebounceMs: 0,
      ...options
    })
  };
}

test('相同 command+scope 的并发请求合并为一个 Promise', async () => {
  const { scheduler } = makeScheduler();
  let calls = 0;
  const execute = async () => {
    calls += 1;
    await delay(30);
    return { exitCode: 0 };
  };
  const job = {
    key: 'same',
    workspace: 'ws',
    inputFiles: [],
    outputFiles: [],
    execute
  };
  const [first, second] = await Promise.all([scheduler.run(job), scheduler.run(job)]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(scheduler.snapshot().merged, 1);
});

test('输入版本未变化时命中缓存，不再重复执行', async () => {
  const { scheduler, locks } = makeScheduler();
  const workspace = tmp();
  const file = path.join(workspace, 'a.md');
  let calls = 0;
  const execute = async () => {
    calls += 1;
    return { exitCode: 0 };
  };
  const job = { key: 'cache', workspace, inputFiles: [file], outputFiles: [], execute };
  const first = await scheduler.run(job);
  assert.equal(first.cached, false);
  assert.ok(typeof first.waitMs === 'number');
  const second = await scheduler.run(job);
  assert.equal(second.cached, true);
  assert.equal(second.waitMs, 0);
  assert.equal(calls, 1);

  locks.versions.bump(file);
  const third = await scheduler.run(job);
  assert.equal(third.cached, false);
  assert.equal(calls, 2);
});

test('验证期间输入被改动会标记 stale 并重跑一次', async () => {
  const { scheduler } = makeScheduler();
  const workspace = tmp();
  const file = path.join(workspace, 'a.md');
  let calls = 0;
  const execute = async () => {
    calls += 1;
    if (calls === 1) {
      fs.writeFileSync(file, 'changed');
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(file, future, future);
    }
    return { exitCode: 0 };
  };
  const outcome = await scheduler.run({
    key: 'stale',
    workspace,
    inputFiles: [file],
    outputFiles: [],
    execute
  });
  assert.equal(outcome.stale, true);
  assert.equal(outcome.runs, 2);
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed');
  // stale 结果不进入缓存。
  assert.equal(scheduler.snapshot().stale, 1);
});

test('持续变化的输入最多重跑 2 次（共执行 3 次）', async () => {
  const { scheduler } = makeScheduler({ maxReruns: 2 });
  const workspace = tmp();
  const file = path.join(workspace, 'a.md');
  let calls = 0;
  const execute = async () => {
    calls += 1;
    fs.writeFileSync(file, `run-${calls}`);
    const future = new Date(Date.now() + 5000 + calls * 1000);
    fs.utimesSync(file, future, future);
    return { exitCode: 0 };
  };
  const outcome = await scheduler.run({ key: 'always', workspace, inputFiles: [file], execute });
  assert.equal(outcome.stale, true);
  assert.equal(outcome.runs, 3);
  assert.equal(calls, 3);
});

test('默认每个 workspace 只跑一个验证，第二个排队', async () => {
  const { scheduler } = makeScheduler({ perWorkspace: 1, hardMax: 1 });
  let active = 0;
  let maxActive = 0;
  const execute = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(30);
    active -= 1;
    return { exitCode: 0 };
  };
  const [first, second] = await Promise.all([
    scheduler.run({ key: 'one', workspace: 'ws', inputFiles: ['C:/ws/a.md'], execute }),
    scheduler.run({ key: 'two', workspace: 'ws', inputFiles: ['C:/ws/b.md'], execute })
  ]);
  assert.equal(maxActive, 1);
  // 排队等待可归因：第二个任务必须等第一个释放验证槽位。
  assert.ok(first.waitMs >= 0);
  assert.ok(second.waitMs >= 20, `第二个验证应记录排队等待，实际 ${second.waitMs}`);
});

test('scope 不相交时允许并行到 hardMax', async () => {
  const { scheduler } = makeScheduler({ perWorkspace: 1, hardMax: 2 });
  let active = 0;
  let maxActive = 0;
  const execute = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(40);
    active -= 1;
    return { exitCode: 0 };
  };
  await Promise.all([
    scheduler.run({ key: 'left', workspace: 'ws', inputFiles: ['C:/ws/src/a.md'], execute }),
    scheduler.run({ key: 'right', workspace: 'ws', inputFiles: ['C:/ws/test/b.md'], execute })
  ]);
  assert.equal(maxActive, 2);
});

test('scope 相交的验证仍然串行执行', async () => {
  const { scheduler } = makeScheduler({ perWorkspace: 1, hardMax: 2 });
  let active = 0;
  let maxActive = 0;
  const execute = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(30);
    active -= 1;
    return { exitCode: 0 };
  };
  await Promise.all([
    scheduler.run({ key: 'parent', workspace: 'ws', inputFiles: ['C:/ws/src'], execute }),
    scheduler.run({ key: 'child', workspace: 'ws', inputFiles: ['C:/ws/src/a.md'], execute })
  ]);
  assert.equal(maxActive, 1);
});

test('排队中的验证可以被取消', async () => {
  const { scheduler } = makeScheduler({ perWorkspace: 1, hardMax: 1 });
  const controller = new AbortController();
  const first = scheduler.run({
    key: 'hold',
    workspace: 'ws',
    inputFiles: ['C:/ws/a.md'],
    execute: () => delay(50).then(() => ({ exitCode: 0 }))
  });
  await delay(5);
  const queued = scheduler.run({
    key: 'cancelled',
    workspace: 'ws',
    inputFiles: ['C:/ws/b.md'],
    signal: controller.signal,
    execute: async () => ({ exitCode: 0 })
  });
  controller.abort();
  await assert.rejects(queued, /任务已取消/);
  await first;
});

test('不可缓存的验证每次都会重新执行', async () => {
  const { scheduler } = makeScheduler();
  let calls = 0;
  const job = {
    key: 'no-cache',
    workspace: 'ws',
    inputFiles: [],
    cacheable: false,
    execute: async () => {
      calls += 1;
      return { exitCode: 0 };
    }
  };
  await scheduler.run(job);
  await scheduler.run(job);
  assert.equal(calls, 2);
  assert.equal(scheduler.snapshot().cached, 0);
});

test('空输入文件也能正常执行并返回版本表', async () => {
  const { scheduler } = makeScheduler();
  const outcome = await scheduler.run({
    key: 'empty',
    workspace: 'ws',
    inputFiles: [],
    execute: async () => ({ exitCode: 0 })
  });
  assert.equal(outcome.stale, false);
  assert.equal(outcome.runs, 1);
  assert.deepEqual(outcome.verifiedVersions, {});
});
