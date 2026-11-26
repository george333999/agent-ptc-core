import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOCK_CODES,
  VersionStore,
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

test('Read locks are mutually compatible: multiple readers can hold one at the same time', async () => {
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

test('Write locks on the same file serialize; the next writer proceeds only after release', async () => {
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
  assert.ok(next.waitMs >= 20, `Wait time should be recorded, actual ${next.waitMs}`);
  next.release();
});

test('A directory write lock blocks reads and writes of child files', async () => {
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
  // Grants follow queue order: while the earlier reader holds the lock, the writer keeps waiting.
  const readHandle = await pendingRead;
  assert.equal(readGranted, true);
  assert.equal(writeGranted, false);
  readHandle.release();
  const writeHandle = await pendingWrite;
  assert.equal(writeGranted, true);
  writeHandle.release();
});

test('A multi-key request leaves no half-held state after timeout', async () => {
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
  // A failed request must not leave b's write lock behind.
  const next = await locks.acquire({ writes: [b] }, { timeoutMs: 30 });
  assert.equal(next.waitMs, 0);
  next.release();
  holder.release();
});

test('An abort signal makes a queued request exit immediately', async () => {
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

test('Writer priority: a late reader cannot overtake a queued writer', async () => {
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

test('Reading and writing the same key in one request automatically upgrades to a write lock', async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const key = fileKey(path.join(workspace, 'a.md'));
  const holder = await locks.acquire({ reads: [key], writes: [key] });
  let readerGranted = false;
  const reader = locks.acquire({ reads: [key] }).then((handle) => {
    readerGranted = true;
    return handle;
  });
  await delay(20);
  assert.equal(readerGranted, false, 'A self-overlapping request must block other readers as a write lock');
  holder.release();
  const readerHandle = await reader;
  readerHandle.release();
});

test('Locks are not reentrant: the same owner requesting a conflicting lock again fails immediately', async () => {
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

test('An empty resource request completes immediately and holds no lock', async () => {
  const locks = createResourceLocks();
  const handle = await locks.acquire({});
  assert.deepEqual(handle.keys, []);
  handle.release();
  assert.equal(locks.stats.active, 0);
});

test('release is idempotent; repeated calls do not corrupt the active count', async () => {
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

test('Key relations: ancestors/descendants conflict; sibling paths do not affect each other', () => {
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

test('Version registry: version+1 after a write, and external modification is detected by changed', async () => {
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

test('Version registry: missing and newly created files both count as changes', async () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const file = path.join(workspace, 'new.md');
  const snapshot = locks.versions.snapshot([file]);
  fs.writeFileSync(file, 'created');
  assert.equal(locks.versions.changed(snapshot).length, 1);
});

test('Version registry: content changes with the same size and preserved mtime are detected by hash', () => {
  const locks = createResourceLocks();
  const workspace = tmp();
  const file = path.join(workspace, 'hash.md');
  fs.writeFileSync(file, 'abcd');
  const fixed = new Date('2026-01-02T03:04:05.000Z');
  fs.utimesSync(file, fixed, fixed);
  const snapshot = locks.versions.snapshot([file]);
  assert.deepEqual(locks.versions.changed(snapshot), []);

  // An external tool rewrites content while keeping size and mtime: metadata-only comparison misses it.
  fs.writeFileSync(file, 'abce');
  fs.utimesSync(file, fixed, fixed);
  const changed = locks.versions.changed(snapshot);
  assert.equal(changed.length, 1);
  assert.equal(changed[0], process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));
});

test('Version registry boundaries: empty files are detectable; files over the hash limit compare metadata only', () => {
  const workspace = tmp();
  const empty = path.join(workspace, 'empty.md');
  fs.writeFileSync(empty, '');
  const emptyStore = new VersionStore();
  const emptySnapshot = emptyStore.snapshot([empty]);
  assert.equal(emptySnapshot.size, 1);
  assert.deepEqual(emptyStore.changed(emptySnapshot), []);
  fs.writeFileSync(empty, 'x');
  assert.equal(emptyStore.changed(emptySnapshot).length, 1);

  // Files over hashLimit are not content-hashed; only version/size/mtime are compared, avoiding synchronous reads of large files during verification.
  const store = new VersionStore({ hashLimit: 4 });
  const big = path.join(workspace, 'big.md');
  fs.writeFileSync(big, 'abcdef');
  const fixed = new Date('2026-01-02T03:04:05.000Z');
  fs.utimesSync(big, fixed, fixed);
  const snapshot = store.snapshot([big]);
  fs.writeFileSync(big, 'abcdeg');
  fs.utimesSync(big, fixed, fixed);
  assert.deepEqual(store.changed(snapshot), []);
});

test('The same path differing only in case normalizes to one lock key on Windows', { skip: process.platform !== 'win32' }, async () => {
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
