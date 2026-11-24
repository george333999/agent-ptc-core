import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDistillSummary,
  distillToolResult,
  readStoredToolResult,
  shapeToolResultForHistory,
  summarizeToolArguments,
  throttleToolResultInjection
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

test('大工具结果注入限流：恰好等于上限不处理，超过 1 字符即头部 + 尾部并落盘', () => {
  const dataDir = tempDataDir();
  const exact = 'a'.repeat(8000);
  const untouched = throttleToolResultInjection({
    dataDir,
    sessionId: 's_1',
    callId: 'cap_exact',
    toolName: 'read_file',
    output: exact
  });
  assert.equal(untouched.throttled, false);
  assert.equal(untouched.content, exact);

  const output = `HEAD-${'h'.repeat(4000)}-MID-${'m'.repeat(4000)}-TAIL`;
  const throttled = throttleToolResultInjection({
    dataDir,
    sessionId: 's_1',
    callId: 'cap_over',
    toolName: 'read_file',
    output
  });
  assert.equal(throttled.throttled, true);
  assert.match(throttled.content, /工具结果已限流/);
  assert.match(throttled.content, /result_id: s_1\/cap_over/);
  assert.match(throttled.content, /HEAD-/);
  assert.match(throttled.content, /TAIL/);
  assert.doesNotMatch(throttled.content, /MID-/);
  assert.ok(throttled.content.length < output.length);
  assert.equal(fs.readFileSync(path.join(dataDir, throttled.ref.path), 'utf8'), output);
});

test('大工具结果限流边界：小于 2000 的上限被抬到 2000，头尾预算自动收敛', () => {
  const dataDir = tempDataDir();
  const output = 'x'.repeat(2500);
  const result = throttleToolResultInjection({
    dataDir,
    sessionId: 's_1',
    callId: 'cap_small',
    toolName: 'search_files',
    output,
    capChars: 10,
    headChars: 9999,
    tailChars: 9999
  });
  assert.equal(result.throttled, true);
  assert.match(result.content, /超过单步注入上限 2000 字符/);
  assert.ok(result.content.length < output.length);
});

test('大工具结果限流：回读工具豁免、禁用开关与空结果保持原文', () => {
  const dataDir = tempDataDir();
  const output = 'y'.repeat(9000);
  const exempt = throttleToolResultInjection({
    dataDir,
    sessionId: 's_1',
    callId: 'read_back',
    toolName: 'read_tool_result',
    output
  });
  assert.equal(exempt.throttled, false);
  assert.equal(exempt.content, output);

  const disabled = throttleToolResultInjection({
    dataDir,
    sessionId: 's_1',
    callId: 'disabled',
    toolName: 'read_file',
    output,
    enabled: false
  });
  assert.equal(disabled.throttled, false);

  const empty = throttleToolResultInjection({ dataDir, sessionId: 's_1', callId: 'empty', toolName: 'read_file', output: '' });
  assert.equal(empty.throttled, false);
  assert.equal(empty.content, '');
});

test('历史结果整形：蒸馏优先，未达到蒸馏阈值时再按 8k 限流', () => {
  const dataDir = tempDataDir();
  const small = shapeToolResultForHistory({
    dataDir,
    sessionId: 's_3',
    callId: 'small',
    toolName: 'read_file',
    output: 'x'.repeat(100),
    budgets: { read_file: 50 },
    distillEnabled: true,
    minChars: 1000,
    previewChars: 100
  });
  assert.equal(small.mode, 'full');
  assert.equal(small.summary, null);

  const large = shapeToolResultForHistory({
    dataDir,
    sessionId: 's_3',
    callId: 'large',
    toolName: 'read_file',
    output: 'y'.repeat(9000),
    budgets: { read_file: 20000 },
    distillEnabled: true,
    minChars: 16000,
    previewChars: 100
  });
  assert.equal(large.mode, 'throttled');
  assert.match(large.summary, /工具结果已限流/);
  assert.ok(large.ref.resultId);
});

test('大工具结果限流后可按 result_id 回读被省略的中间内容', () => {
  const dataDir = tempDataDir();
  const output = `${'A'.repeat(3000)}\n${'B'.repeat(5000)}\n${'C'.repeat(3000)}`;
  const throttled = throttleToolResultInjection({
    dataDir,
    sessionId: 's_2',
    callId: 'call_back',
    toolName: 'ptc_run',
    output
  });
  assert.equal(throttled.throttled, true);
  const middle = readStoredToolResult({
    dataDir,
    resultId: throttled.ref.resultId,
    mode: 'chars',
    offset: 3500,
    length: 100
  });
  assert.equal(middle.text, 'B'.repeat(100));
  assert.equal(middle.truncated, true);
});
