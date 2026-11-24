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
    '// 计时器初始化',
    'function start() { return 1; } // 行尾注释',
    '  // 刷新后恢复状态',
    '</script>',
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'notes.md'), 'TODO: 修复计时器\n', 'utf8');
  return root;
}

function ctx(workspace) {
  return { workspace, settings: {} };
}

test('files.search 默认仍是纯文本匹配', async () => {
  const workspace = tempWorkspace();
  const result = await executePtcTool('files.search', { query: 'TODO', path: 'notes.md' }, ctx(workspace));
  assert.equal(result.count, 1);
  assert.equal(result.matches[0].line, 1);
  assert.equal(result.regex, false);
  assert.equal(result.hint, undefined);
});

test('正则样式 query 未加 regex 时返回 0 条并给出可执行提示', async () => {
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

test('regex:true 支持行首/行尾正则匹配', async () => {
  const workspace = tempWorkspace();
  const result = await executePtcTool('files.search', {
    query: '^\\s*//',
    path: 'outputs/chat/pomodoro.html',
    regex: true
  }, ctx(workspace));
  assert.equal(result.regex, true);
  assert.equal(result.count, 2);
  assert.equal(result.matches[0].line, 3);
  assert.match(result.matches[0].text, /计时器初始化/);
  assert.equal(result.matches[1].line, 5);
});

test('regex:true 尊重 caseSensitive 并可用于文件名搜索', async () => {
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

test('无效正则会返回明确错误而不是空结果', async () => {
  const workspace = tempWorkspace();
  await assert.rejects(
    () => executePtcTool('files.search', { query: '([', path: 'notes.md', regex: true }, ctx(workspace)),
    (error) => error instanceof PtcToolError && error.code === 'PTC_BAD_REGEX'
  );
});

test('文件密集搜索：按文件名顺序扫描，并在 200 条命中上限处截断', async () => {
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

test('files.list 文件密集分页：400 条一页，nextOffset 可继续枚举', async () => {
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

test('只读正文缓存：未变化文件第二次读取命中，修改后返回新内容', async () => {
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

  fs.writeFileSync(file, 'TODO: 修复计时器\n新增一行\n', 'utf8');
  const refreshed = await executePtcTool('files.read', { path: 'notes.md' }, readCtx);
  assert.match(refreshed.content, /新增一行/);
  assert.equal(refreshed.totalLines, 3);
});
