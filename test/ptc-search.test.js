import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executePtcTool, PtcToolError, ptcReadCacheStats, resetPtcReadCache } from '../server/ptc/tools.js';

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-search-'));
  fs.mkdirSync(path.join(root, 'outputs', 'chat'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outputs', 'chat', 'pomodoro.html'), [
    '<!doctype html>',
    '<script>',
    '// timer init',
    'function start() { return 1; } // trailing comment',
    '  // restore state after refresh',
    '</script>',
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'notes.md'), 'TODO: fix timer\n', 'utf8');
  return root;
}

function ctx(workspace) {
  return { workspace, settings: {} };
}

test('files.search still defaults to plain-text matching', async () => {
  const workspace = tempWorkspace();
  const result = await executePtcTool('files.search', { query: 'TODO', path: 'notes.md' }, ctx(workspace));
  assert.equal(result.count, 1);
  assert.equal(result.matches[0].line, 1);
  assert.equal(result.regex, false);
  assert.equal(result.hint, undefined);
});

test('A regex-style query without regex returns 0 matches with an actionable hint', async () => {
  const workspace = tempWorkspace();
  const result = await executePtcTool('files.search', {
    query: '^\\s*//',
    path: 'outputs/chat/pomodoro.html'
  }, ctx(workspace));
  assert.equal(result.count, 0);
  assert.equal(result.regex, false);
  assert.match(result.hint, /regex:true/);
  assert.match(result.hint, /\^\\\\s\*\/\//);
});

test('regex:true supports line-start/line-end regex matching', async () => {
  const workspace = tempWorkspace();
  const result = await executePtcTool('files.search', {
    query: '^\\s*//',
    path: 'outputs/chat/pomodoro.html',
    regex: true
  }, ctx(workspace));
  assert.equal(result.regex, true);
  assert.equal(result.count, 2);
  assert.equal(result.matches[0].line, 3);
  assert.match(result.matches[0].text, /timer init/);
  assert.equal(result.matches[1].line, 5);
});

test('regex:true respects caseSensitive and works for filename search', async () => {
  const workspace = tempWorkspace();
  const insensitive = await executePtcTool('files.search', {
    query: '^TODO',
    path: 'notes.md',
    regex: true
  }, ctx(workspace));
  assert.equal(insensitive.count, 1);

  const sensitive = await executePtcTool('files.search', {
    query: '^todo',
    path: 'notes.md',
    regex: true,
    caseSensitive: true
  }, ctx(workspace));
  assert.equal(sensitive.count, 0);

  const byName = await executePtcTool('files.search', {
    query: '\\.md$',
    target: 'filename',
    regex: true
  }, ctx(workspace));
  assert.ok(byName.matches.some((item) => item.path === 'notes.md'));
});

test('An invalid regex returns a clear error instead of an empty result', async () => {
  const workspace = tempWorkspace();
  await assert.rejects(
    () => executePtcTool('files.search', { query: '([', path: 'notes.md', regex: true }, ctx(workspace)),
    (error) => error instanceof PtcToolError && error.code === 'PTC_BAD_REGEX'
  );
});

test('File-dense search: scans in filename order and truncates at the 200-match cap', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-search-dense-'));
  try {
    for (let index = 0; index < 220; index += 1) {
      fs.writeFileSync(path.join(workspace, `f-${String(index).padStart(3, '0')}.txt`), 'NEEDLE\n', 'utf8');
    }
    const result = await executePtcTool('files.search', { query: 'NEEDLE', path: '.' }, ctx(workspace));
    assert.equal(result.count, 200);
    assert.equal(result.truncated, true);
    assert.equal(result.matches[0].path, 'f-000.txt');
    assert.equal(result.matches[199].path, 'f-199.txt');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('files.list file-dense pagination: 400 per page and nextOffset continues enumeration', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-list-dense-'));
  try {
    for (let index = 0; index < 420; index += 1) {
      fs.writeFileSync(path.join(workspace, `f-${String(index).padStart(3, '0')}.txt`), 'x\n', 'utf8');
    }
    const listCtx = ctx(workspace);
    const first = await executePtcTool('files.list', { path: '.', depth: 0 }, listCtx);
    assert.equal(first.count, 400);
    assert.equal(first.truncated, true);
    assert.equal(first.nextOffset, 400);
    assert.equal(first.entries[0].path, 'f-000.txt');

    const second = await executePtcTool('files.list', { path: '.', depth: 0, offset: first.nextOffset }, listCtx);
    assert.equal(second.count, 20);
    assert.equal(second.truncated, false);
    assert.equal(second.nextOffset, null);
    assert.equal(second.entries[19].path, 'f-419.txt');

    const clamped = await executePtcTool('files.list', { path: '.', depth: 0, offset: 419, limit: 999 }, listCtx);
    assert.equal(clamped.count, 1);
    assert.equal(clamped.limit, 400);
    assert.equal(clamped.truncated, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('Read-only content cache: an unchanged file hits on the second read, and modified content is returned after an edit', async () => {
  const workspace = tempWorkspace();
  const file = path.join(workspace, 'notes.md');
  const past = new Date(Date.now() - 10000);
  fs.utimesSync(file, past, past);
  resetPtcReadCache();
  const readCtx = ctx(workspace);
  const first = await executePtcTool('files.read', { path: 'notes.md' }, readCtx);
  assert.match(first.content, /TODO/);
  const firstStats = ptcReadCacheStats();
  await executePtcTool('files.read', { path: 'notes.md' }, readCtx);
  const secondStats = ptcReadCacheStats();
  assert.equal(secondStats.hits, firstStats.hits + 1);

  fs.writeFileSync(file, 'TODO: fix timer\nnew line\n', 'utf8');
  const refreshed = await executePtcTool('files.read', { path: 'notes.md' }, readCtx);
  assert.match(refreshed.content, /new line/);
  assert.equal(refreshed.totalLines, 3);
});
