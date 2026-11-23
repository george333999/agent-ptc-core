import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDistillSummary,
  distillToolResult,
  readStoredToolResult,
  summarizeToolArguments
} from '../server/tool-result.js';

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tool-result-'));
}

test('低于预算的结果不蒸馏，保持原文', () => {
  const dataDir = tempDataDir();
  const result = distillToolResult({
    dataDir,
    sessionId: 's_1',
    callId: 'call_1',
    toolName: 'read_file',
    output: 'short output',
    budgets: { read_file: 100 }
  });
  assert.equal(result.distilled, false);
  assert.equal(result.content, 'short output');
  assert.equal(fs.existsSync(path.join(dataDir, 'tool-results')), false);
});

test('超过预算但低于最小蒸馏长度时保持原文，避免多一次回读', () => {
  const dataDir = tempDataDir();
  const output = 'x'.repeat(5000);
  const result = distillToolResult({
    dataDir,
    sessionId: 's_1',
    callId: 'call_1',
    toolName: 'read_file',
    output,
    budgets: { read_file: 1000 },
    minChars: 16000
  });
  assert.equal(result.distilled, false);
  assert.equal(result.content, output);
  assert.equal(fs.existsSync(path.join(dataDir, 'tool-results')), false);
});

test('超过最小蒸馏长度才落盘，预览长度受 previewChars 控制', () => {
  const dataDir = tempDataDir();
  const output = Array.from({ length: 800 }, (_, index) => `line-${index}-${'y'.repeat(30)}`).join('\n');
  const result = distillToolResult({
    dataDir,
    sessionId: 's_2',
    callId: 'call_2',
    toolName: 'read_file',
    output,
    budgets: { read_file: 20000 },
    minChars: 16000,
    previewChars: 1200
  });
  assert.equal(result.distilled, true);
  assert.match(result.content, /result_id: s_2\/call_2/);
  assert.ok(result.content.length > 1000);
  assert.equal(result.content.includes(output.slice(0, 1200)), true);
});

test('超过预算的结果落盘，并返回包含 result_id 的稳定摘要', () => {
  const dataDir = tempDataDir();
  const output = Array.from({ length: 300 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join('\n');
  const first = distillToolResult({
    dataDir,
    sessionId: 's_1',
    callId: 'call_1',
    toolName: 'read_file',
    output,
    budgets: { read_file: 100 }
  });
  assert.equal(first.distilled, true);
  assert.match(first.content, /result_id: s_1\/call_1/);
  assert.match(first.content, /read_tool_result/);
  assert.ok(first.ref.bytes > 0);
  assert.ok(fs.existsSync(path.join(dataDir, first.ref.path)));

  const second = distillToolResult({
    dataDir,
    sessionId: 's_1',
    callId: 'call_1',
    toolName: 'read_file',
    output,
    budgets: { read_file: 100 }
  });
  assert.equal(second.content, first.content);
});

test('按行 / 字符 / JSON path 回读，并遵守 20k 上限', () => {
  const dataDir = tempDataDir();
  const json = JSON.stringify({
    items: [
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
      { id: 3, name: 'gamma' }
    ],
    pad: 'z'.repeat(30000)
  });
  const output = json;
  const distilled = distillToolResult({
    dataDir,
    sessionId: 's_2',
    callId: 'call_2',
    toolName: 'ptc_run',
    output,
    budgets: { ptc_run: 100 }
  });
  assert.equal(distilled.distilled, true);

  const lines = readStoredToolResult({ dataDir, resultId: 's_2/call_2', mode: 'lines', startLine: 1, endLine: 1 });
  assert.match(lines.text, /"items"/);
  assert.equal(lines.totalLines, 1);

  const chars = readStoredToolResult({ dataDir, resultId: 's_2/call_2', mode: 'chars', offset: 0, length: 10 });
  assert.equal(chars.text.length, 10);
  assert.equal(chars.truncated, true);

  const jsonResult = readStoredToolResult({ dataDir, resultId: 's_2/call_2', mode: 'json', jsonPath: '$.items[1].name' });
  assert.equal(jsonResult.text, '"beta"');

  const allItems = readStoredToolResult({ dataDir, resultId: 's_2/call_2', mode: 'json', jsonPath: '$.items[*].id' });
  assert.deepEqual(JSON.parse(allItems.text), [1, 2, 3]);

  const capped = readStoredToolResult({ dataDir, resultId: 's_2/call_2', mode: 'chars', offset: 0, length: 50000 });
  assert.equal(capped.text.length, 20000);
  assert.equal(capped.truncated, true);
});

test('JSON 摘要包含结构信息，二进制/超长内容只给预览', () => {
  const summary = buildDistillSummary({
    toolName: 'ptc_run',
    text: JSON.stringify({ ok: true, items: [1, 2, 3] }),
    resultId: 's/c',
    bytes: 30,
    lines: 1,
    budget: 10
  });
  assert.match(summary, /JSON 结构/);
  assert.match(summary, /对象/);
});

test('非法 result_id 拒绝路径穿越，缺失/过期结果给出明确提示', () => {
  const dataDir = tempDataDir();
  assert.throws(() => readStoredToolResult({ dataDir, resultId: '../etc/passwd' }), /非法|格式/);
  assert.throws(() => readStoredToolResult({ dataDir, resultId: 's_1/../../x' }), /非法|格式/);

  const missing = readStoredToolResult({ dataDir, resultId: 's_1/call_missing' });
  assert.equal(missing.missing, true);

  const distilled = distillToolResult({
    dataDir,
    sessionId: 's_3',
    callId: 'call_3',
    toolName: 'read_file',
    output: 'q'.repeat(500),
    budgets: { read_file: 10 }
  });
  const file = path.join(dataDir, distilled.ref.path);
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
  const expired = readStoredToolResult({ dataDir, resultId: 's_3/call_3' });
  assert.equal(expired.expired, true);
});

test('工具参数历史视图：原样保留，避免模型模仿占位符污染产物', () => {
  const writeInput = {
    path: 'src/a.js',
    content: `const key = "sk-abcdefgh12345678";\n${'x'.repeat(5000)}`
  };
  const writeArgs = summarizeToolArguments('write_file', writeInput);
  assert.deepEqual(JSON.parse(writeArgs), writeInput);
  assert.doesNotMatch(writeArgs, /历史参数已省略/);

  const editInput = { path: 'a.js', old_string: 'old'.repeat(1000), new_string: 'new'.repeat(1000) };
  assert.deepEqual(JSON.parse(summarizeToolArguments('edit_file', editInput)), editInput);

  const ptcInput = { code: 'await files.list({});'.repeat(300), reset: false };
  assert.deepEqual(JSON.parse(summarizeToolArguments('ptc_run', ptcInput)), ptcInput);

  const small = summarizeToolArguments('list_files', { path: '.' });
  assert.equal(small, '{"path":"."}');

  const huge = summarizeToolArguments('mcp__x__y', { blob: 'q'.repeat(9000), n: 1 });
  assert.equal(JSON.parse(huge).blob.length, 9000);
});
