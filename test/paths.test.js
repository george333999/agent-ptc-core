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

test('Workspace root is cached by real path; repeated resolution hits the cache', () => {
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

test('Not-yet-created files can be boundary-checked; out-of-bounds paths are rejected', () => {
  const root = tmp();
  const inside = resolveWithinWorkspace(root, 'new/dir/file.md');
  assert.ok(inside.startsWith(realpathOrResolve(root)));
  assert.throws(() => resolveWithinWorkspace(root, '../outside.md'));
  assert.equal(isWithinWorkspace(root, path.join(root, 'ok.md')), true);
  assert.equal(isWithinWorkspace(root, path.join(root, '..', 'outside.md')), false);
});

test('Switching workspaces does not mix cached roots', () => {
  const a = tmp();
  const b = tmp();
  invalidatePathCache();
  assert.notEqual(workspaceRoot(a), workspaceRoot(b));
  assert.equal(workspaceRoot(a), realpathOrResolve(a));
});
