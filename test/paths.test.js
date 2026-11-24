import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  invalidatePathCache,
  isWithinWorkspace,
  pathCacheStats,
  realpathOrResolve,
  resolveWithinWorkspace,
  workspaceRoot
} from '../server/paths.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'paths-'));
}

test('工作区根按真实路径缓存，重复解析命中缓存', () => {
  const root = tmp();
  invalidatePathCache();
  const first = workspaceRoot(root);
  const before = pathCacheStats();
  const second = workspaceRoot(root);
  const after = pathCacheStats();
  assert.equal(first, second);
  assert.equal(first, realpathOrResolve(root));
  assert.ok(after.hits >= before.hits + 1);
  invalidatePathCache(root);
  assert.ok(pathCacheStats().invalidations >= 1);
});

test('未创建的文件也能被边界校验，越界路径会被拒绝', () => {
  const root = tmp();
  const inside = resolveWithinWorkspace(root, 'new/dir/file.md');
  assert.ok(inside.startsWith(realpathOrResolve(root)));
  assert.throws(() => resolveWithinWorkspace(root, '../outside.md'));
  assert.equal(isWithinWorkspace(root, path.join(root, 'ok.md')), true);
  assert.equal(isWithinWorkspace(root, path.join(root, '..', 'outside.md')), false);
});

test('切换工作区不会串用缓存根', () => {
  const a = tmp();
  const b = tmp();
  invalidatePathCache();
  assert.notEqual(workspaceRoot(a), workspaceRoot(b));
  assert.equal(workspaceRoot(a), realpathOrResolve(a));
});
