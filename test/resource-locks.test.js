import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOCK_CODES,
  createResourceLocks,
  dirKey,
  fileKey,
  keysConflict,
  keysRelated,
  wsKey
} from '../server/resource-locks.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resource-locks-'));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('读锁互相兼容：多个读者可以同时持有', async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const key = fileKey(path.join(workspace, 'a.md'));
  const first = await locks.acquire({ reads: [key] });
  const second = await locks.acquire({ reads: [key] });
  assert.equal(first.waitMs, 0);
  assert.equal(second.waitMs, 0);
  assert.equal(locks.stats.active, 2);
  first.release();
  second.release();
  assert.equal(locks.stats.active, 0);
});

test('同一文件的写锁串行，释放后下一个写者才继续', async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const key = fileKey(path.join(workspace, 'a.md'));
  const holder = await locks.acquire({ writes: [key] });
  let granted = false;
  const waiting = locks.acquire({ writes: [key] }).then((handle) => {
    granted = true;
    return handle;
  });
  await delay(30);
  assert.equal(granted, false);
  holder.release();
  const next = await waiting;
  assert.equal(granted, true);
  assert.ok(next.waitMs >= 20, `应记录等待时间，实际 ${next.waitMs}`);
  next.release();
});

test('目录写锁会挡住子文件的读和写', async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const dir = dirKey(path.join(workspace, 'src'));
  const child = fileKey(path.join(workspace, 'src', 'a.js'));
  const holder = await locks.acquire({ writes: [dir] });
  let readGranted = false;
  let writeGranted = false;
  const pendingRead = locks.acquire({ reads: [child] }).then((handle) => {
    readGranted = true;
    return handle;
  });
  const pendingWrite = locks.acquire({ writes: [child] }).then((handle) => {
    writeGranted = true;
    return handle;
  });
  await delay(20);
  assert.equal(readGranted, false);
  assert.equal(writeGranted, false);
  holder.release();
  // 队列按顺序授予：先放行的读者持锁期间，写者继续等待。
  const readHandle = await pendingRead;
  assert.equal(readGranted, true);
  assert.equal(writeGranted, false);
  readHandle.release();
  const writeHandle = await pendingWrite;
  assert.equal(writeGranted, true);
  writeHandle.release();
});

test('多 key 请求超时后不留下半持有状态', async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const a = fileKey(path.join(workspace, 'a.md'));
  const b = fileKey(path.join(workspace, 'b.md'));
  const holder = await locks.acquire({ reads: [a] });
  await assert.rejects(
    () => locks.acquire({ writes: [a, b] }, { timeoutMs: 30 }),
    (error) => {
      assert.equal(error.code, LOCK_CODES.TIMEOUT);
      assert.ok(Array.isArray(error.holders) && error.holders.length >= 1);
      return true;
    }
  );
  // 失败请求不能残留 b 的写锁。
  const next = await locks.acquire({ writes: [b] }, { timeoutMs: 30 });
  assert.equal(next.waitMs, 0);
  next.release();
  holder.release();
});

test('取消信号会让排队中的请求立即退出', async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const key = fileKey(path.join(workspace, 'a.md'));
  const holder = await locks.acquire({ writes: [key] });
  const controller = new AbortController();
  const waiting = locks.acquire({ reads: [key] }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, (error) => error.code === LOCK_CODES.ABORTED);
  assert.equal(locks.queue.length, 0);
  holder.release();
});

test('写者优先：后到的读者不能越过排队中的写者', async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const key = fileKey(path.join(workspace, 'a.md'));
  const order = [];
  const reader = await locks.acquire({ reads: [key] });
  const writer = locks.acquire({ writes: [key] }).then((handle) => {
    order.push('write');
    return handle;
  });
  const lateReader = locks.acquire({ reads: [key] }).then((handle) => {
    order.push('read');
    return handle;
  });
  await delay(10);
  reader.release();
  const writerHandle = await writer;
  await delay(10);
  assert.deepEqual(order, ['write']);
  writerHandle.release();
  const readHandle = await lateReader;
  assert.deepEqual(order, ['write', 'read']);
  readHandle.release();
});

test('同一请求内读写同一个 key 属于非法升级', async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const key = fileKey(path.join(workspace, 'a.md'));
  await assert.rejects(
    () => locks.acquire({ reads: [key], writes: [key] }),
    (error) => error.code === LOCK_CODES.UPGRADE
  );
});

test('锁不可重入：同一 owner 再次申请冲突锁会立即报错', async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const key = fileKey(path.join(workspace, 'a.md'));
  const owner = { id: 'agent-1' };
  const holder = await locks.acquire({ reads: [key] }, { owner });
  await assert.rejects(
    () => locks.acquire({ writes: [key] }, { owner }),
    (error) => error.code === LOCK_CODES.REENTRANT
  );
  holder.release();
});

test('空资源请求立即完成且不占用锁', async () => {
  const locks = createResourceLocks();
  const handle = await locks.acquire({});
  assert.deepEqual(handle.keys, []);
  handle.release();
  assert.equal(locks.stats.active, 0);
});

test('release 幂等，多次调用不会破坏活跃计数', async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const key = fileKey(path.join(workspace, 'a.md'));
  const handle = await locks.acquire({ writes: [key] });
  handle.release();
  handle.release();
  assert.equal(locks.stats.active, 0);
  const again = await locks.acquire({ writes: [key] });
  again.release();
});

test('key 关系：祖先/后代冲突，兄弟路径互不影响', () => {
  const root = path.resolve(os.tmpdir(), 'rel-root');
  const a = fileKey(path.join(root, 'src', 'a.js'));
  const b = fileKey(path.join(root, 'src', 'b.js'));
  const dir = dirKey(path.join(root, 'src'));
  const ws = wsKey(root);
  assert.equal(keysRelated(a, dir), true);
  assert.equal(keysRelated(a, b), false);
  assert.equal(keysRelated(a, ws), true);
  assert.equal(keysConflict('read', a, 'read', a), false);
  assert.equal(keysConflict('write', a, 'read', dir), true);
  assert.equal(keysConflict('read', a, 'read', dir), false);
});

test('版本登记：写入后 version+1，外部修改能被 changed 检出', async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const file = path.join(workspace, 'a.md');
  fs.writeFileSync(file, 'one');
  const before = locks.versions.snapshot([file]);
  assert.equal(locks.versions.versionOf(file), 0);
  locks.versions.bump(file);
  const after = locks.versions.snapshot([file]);
  assert.equal(locks.versions.versionOf(file), 1);
  assert.notDeepEqual([...after.values()], [...before.values()]);
  assert.deepEqual(locks.versions.changed(after), []);

  const modifiedAt = new Date(Date.now() + 5000);
  fs.writeFileSync(file, 'two');
  fs.utimesSync(file, modifiedAt, modifiedAt);
  const normalized = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  assert.deepEqual(locks.versions.changed(after), [normalized]);
});

test('版本登记：文件缺失与新建同样视为变化', async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const file = path.join(workspace, 'new.md');
  const snapshot = locks.versions.snapshot([file]);
  fs.writeFileSync(file, 'created');
  assert.equal(locks.versions.changed(snapshot).length, 1);
});

test('Windows 下大小写不同的同一路径归一为同一个锁 key', { skip: process.platform !== 'win32' }, async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const upper = fileKey(path.join(workspace, 'A.MD'));
  const lower = fileKey(path.join(workspace, 'a.md'));
  assert.equal(upper, lower);
  const holder = await locks.acquire({ writes: [upper] });
  let granted = false;
  const waiting = locks.acquire({ reads: [lower] }).then((handle) => {
    granted = true;
    return handle;
  });
  await delay(20);
  assert.equal(granted, false);
  holder.release();
  (await waiting).release();
});
