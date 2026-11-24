import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executePtcTool, PtcToolError, resetPtcReadCache } from '../server/ptc/tools.js';

function tempWorkspace(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ctx(workspace) {
  return { workspace, settings: {} };
}

function errorCode(error) {
  return error instanceof PtcToolError ? error.code : '';
}

test('files.list 边界：400/401 条分页、offset 越界与 limit 钳制', async () => {
  const workspace = tempWorkspace('ptc-edge-list-');
  try {
    for (let index = 0; index < 401; index += 1) {
      fs.writeFileSync(path.join(workspace, `f-${String(index).padStart(3, '0')}.txt`), 'x\n', 'utf8');
    }
    const listCtx = ctx(workspace);

    const first = await executePtcTool('files.list', { path: '.', depth: 0 }, listCtx);
    assert.equal(first.count, 400);
    assert.equal(first.truncated, true);
    assert.equal(first.nextOffset, 400);

    const second = await executePtcTool('files.list', { path: '.', depth: 0, offset: 400 }, listCtx);
    assert.equal(second.count, 1);
    assert.equal(second.truncated, false);
    assert.equal(second.nextOffset, null);

    const marginal = await executePtcTool('files.list', { path: '.', depth: 0, offset: 399 }, listCtx);
    assert.equal(marginal.count, 2);
    assert.equal(marginal.truncated, false);

    const afterLast = await executePtcTool('files.list', { path: '.', depth: 0, offset: 401 }, listCtx);
    assert.equal(afterLast.count, 0);
    assert.equal(afterLast.truncated, false);

    const beyond = await executePtcTool('files.list', { path: '.', depth: 0, offset: 10000 }, listCtx);
    assert.equal(beyond.count, 0);
    assert.equal(beyond.truncated, false);
    assert.equal(beyond.nextOffset, null);

    const clamped = await executePtcTool('files.list', { path: '.', depth: 0, offset: 400, limit: 999 }, listCtx);
    assert.equal(clamped.limit, 400);
    assert.equal(clamped.count, 1);

    const minLimit = await executePtcTool('files.list', { path: '.', depth: 0, limit: 0 }, listCtx);
    assert.equal(minLimit.limit, 1);
    assert.equal(minLimit.count, 1);

    // 删掉一条后总量正好 400：不应再报告截断。
    fs.rmSync(path.join(workspace, 'f-400.txt'));
    const exact = await executePtcTool('files.list', { path: '.', depth: 0 }, listCtx);
    assert.equal(exact.count, 400);
    assert.equal(exact.truncated, false);
    assert.equal(exact.nextOffset, null);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('files.read 边界：行号钳制、反向区间、越界行与超长内容', async () => {
  const workspace = tempWorkspace('ptc-edge-read-');
  try {
    fs.writeFileSync(path.join(workspace, 'lines.txt'), 'L1\nL2\nL3', 'utf8');
    fs.writeFileSync(path.join(workspace, 'under.txt'), 'a'.repeat(499999), 'utf8');
    fs.writeFileSync(path.join(workspace, 'exact.txt'), 'a'.repeat(500000), 'utf8');
    fs.writeFileSync(path.join(workspace, 'over.txt'), 'a'.repeat(500001), 'utf8');
    fs.writeFileSync(path.join(workspace, 'binary.txt'), 'abc\u0000def', 'utf8');
    fs.writeFileSync(path.join(workspace, 'huge.txt'), '');
    fs.truncateSync(path.join(workspace, 'huge.txt'), 2 * 1024 * 1024 + 1);
    const readCtx = ctx(workspace);

    const zero = await executePtcTool('files.read', { path: 'lines.txt', startLine: 0, endLine: 0 }, readCtx);
    assert.equal(zero.startLine, 1);
    assert.equal(zero.endLine, 1);
    assert.equal(zero.content, 'L1');

    const reversed = await executePtcTool('files.read', { path: 'lines.txt', startLine: 3, endLine: 1 }, readCtx);
    assert.equal(reversed.startLine, 1);
    assert.equal(reversed.endLine, 3);
    assert.equal(reversed.content, 'L1\nL2\nL3');

    const overEnd = await executePtcTool('files.read', { path: 'lines.txt', startLine: 2, endLine: 999 }, readCtx);
    assert.equal(overEnd.startLine, 2);
    assert.equal(overEnd.endLine, 3);
    assert.equal(overEnd.content, 'L2\nL3');

    const startBeyond = await executePtcTool('files.read', { path: 'lines.txt', startLine: 99 }, readCtx);
    assert.equal(startBeyond.content, 'L3');

    const under = await executePtcTool('files.read', { path: 'under.txt' }, readCtx);
    assert.equal(under.content.length, 499999);
    assert.equal(under.truncated, false);

    const exact = await executePtcTool('files.read', { path: 'exact.txt' }, readCtx);
    assert.equal(exact.content.length, 500000);
    assert.equal(exact.truncated, false);

    const over = await executePtcTool('files.read', { path: 'over.txt' }, readCtx);
    assert.equal(over.content.length, 500000);
    assert.equal(over.truncated, true);

    await assert.rejects(
      () => executePtcTool('files.read', { path: 'binary.txt' }, readCtx),
      (error) => errorCode(error) === 'PTC_BINARY_FILE'
    );
    await assert.rejects(
      () => executePtcTool('files.read', { path: 'huge.txt' }, readCtx),
      (error) => errorCode(error) === 'PTC_FILE_TOO_LARGE'
    );
    await assert.rejects(
      () => executePtcTool('files.read', { path: 'missing.txt' }, readCtx),
      (error) => errorCode(error) === 'PTC_NOT_FOUND'
    );
    await assert.rejects(
      () => executePtcTool('files.read', { path: '.' }, readCtx),
      (error) => errorCode(error) === 'PTC_NOT_FILE'
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('files.readMany 边界：50 条中 1 条失败仍返回 49 条成功', async () => {
  const workspace = tempWorkspace('ptc-edge-readmany-');
  try {
    const names = Array.from({ length: 50 }, (_, index) => `f-${String(index).padStart(2, '0')}.txt`);
    for (const name of names) fs.writeFileSync(path.join(workspace, name), `${name}\n`, 'utf8');
    names[25] = 'missing.txt';
    const result = await executePtcTool('files.readMany', { paths: names }, ctx(workspace));
    assert.equal(result.count, 50);
    assert.equal(result.okCount, 49);
    assert.equal(result.results[25].ok, false);
    assert.equal(result.results[25].code, 'PTC_NOT_FOUND');
    assert.equal(result.results[49].ok, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('files.search 边界：超大文件跳过并显式提示，200 条命中截断', async () => {
  const workspace = tempWorkspace('ptc-edge-search-');
  try {
    fs.writeFileSync(path.join(workspace, 'small.txt'), 'NEEDLE\n', 'utf8');
    fs.writeFileSync(path.join(workspace, 'large.txt'), `ONLY_IN_LARGE\n${'x'.repeat(1024 * 1024)}`, 'utf8');
    fs.writeFileSync(path.join(workspace, 'huge.txt'), '');
    fs.truncateSync(path.join(workspace, 'huge.txt'), 2 * 1024 * 1024 + 1);
    const searchCtx = ctx(workspace);

    const mixed = await executePtcTool('files.search', { query: 'NEEDLE', path: '.' }, searchCtx);
    assert.equal(mixed.count, 1);
    assert.equal(mixed.matches[0].path, 'small.txt');
    assert.equal(mixed.skippedLarge, 2);

    const onlyLarge = await executePtcTool('files.search', { query: 'ONLY_IN_LARGE', path: '.' }, searchCtx);
    assert.equal(onlyLarge.count, 0);
    assert.equal(onlyLarge.skippedLarge, 2);
    assert.match(onlyLarge.hint, /已跳过/);

    const singleHuge = await executePtcTool('files.search', { query: 'NEEDLE', path: 'huge.txt' }, searchCtx);
    assert.equal(singleHuge.count, 0);
    assert.equal(singleHuge.skippedLarge, 1);
    assert.match(singleHuge.hint, /已跳过/);

    for (let index = 0; index < 220; index += 1) {
      fs.writeFileSync(path.join(workspace, `hit-${String(index).padStart(3, '0')}.txt`), 'NEEDLE\n', 'utf8');
    }
    const capped = await executePtcTool('files.search', { query: 'NEEDLE', path: '.', glob: 'hit-*.txt' }, searchCtx);
    assert.equal(capped.count, 200);
    assert.equal(capped.truncated, true);
    assert.equal(capped.matches[0].path, 'hit-000.txt');
    assert.equal(capped.matches[199].path, 'hit-199.txt');

    // 文件大小阈值：正好 1MB 可读，1MB+1 跳过。
    fs.writeFileSync(path.join(workspace, 'edge-1mb.txt'), `SIZEHIT\n${'x'.repeat(1024 * 1024 - 8)}`, 'utf8');
    fs.writeFileSync(path.join(workspace, 'edge-1mb1.txt'), `SIZEHIT\n${'x'.repeat(1024 * 1024 + 1 - 8)}`, 'utf8');
    const sizeEdge = await executePtcTool('files.search', { query: 'SIZEHIT', path: '.', glob: 'edge-1mb*' }, searchCtx);
    assert.equal(sizeEdge.count, 1);
    assert.equal(sizeEdge.matches[0].path, 'edge-1mb.txt');
    assert.equal(sizeEdge.skippedLarge, 1);

    // 命中数阈值：200 条是完整结果，201 条才标记截断。
    for (let index = 0; index < 201; index += 1) {
      fs.writeFileSync(path.join(workspace, `cap-${String(index).padStart(3, '0')}.txt`), 'CAPHIT\n', 'utf8');
    }
    const cap201 = await executePtcTool('files.search', { query: 'CAPHIT', path: '.', glob: 'cap-*.txt' }, searchCtx);
    assert.equal(cap201.count, 200);
    assert.equal(cap201.truncated, true);
    fs.rmSync(path.join(workspace, 'cap-200.txt'));
    const cap200 = await executePtcTool('files.search', { query: 'CAPHIT', path: '.', glob: 'cap-*.txt' }, searchCtx);
    assert.equal(cap200.count, 200);
    assert.equal(cap200.truncated, false);

    await assert.rejects(
      () => executePtcTool('files.search', { query: '', path: '.' }, searchCtx),
      (error) => errorCode(error) === 'PTC_ARG_TYPE'
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('路径与缓存边界：绝对路径越界拒绝，同尺寸改写不会被旧缓存命中', async () => {
  const workspace = tempWorkspace('ptc-edge-path-');
  try {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'AAAA\n', 'utf8');
    const readCtx = ctx(workspace);
    const absolute = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
    await assert.rejects(
      () => executePtcTool('files.read', { path: absolute }, readCtx),
      (error) => errorCode(error) === 'PTC_PATH_ESCAPE'
    );
    await assert.rejects(
      () => executePtcTool('files.read', { path: '../outside.txt' }, readCtx),
      (error) => errorCode(error) === 'PTC_PATH_ESCAPE'
    );

    resetPtcReadCache();
    const first = await executePtcTool('files.read', { path: 'a.txt' }, readCtx);
    assert.equal(first.content, 'AAAA\n');
    // 同尺寸改写：mtime 处于竞态窗口时必须强制重读，不能返回旧缓存。
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'BBBB\n', 'utf8');
    const second = await executePtcTool('files.read', { path: 'a.txt' }, readCtx);
    assert.equal(second.content, 'BBBB\n');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
