import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARALLEL_SAFE_TOOLS,
  isParallelSafeTool,
  planToolBatches,
  runToolBatch
} from '../server/parallel-tools.js';

test('只读工具可并行，写工具与编排工具保持串行', () => {
  for (const name of ['list_files', 'read_file', 'read_tool_result', 'search_files', 'knowledge_search', 'fetch_url', 'web_search', 'read_skill', 'task']) {
    assert.equal(isParallelSafeTool(name), true, `${name} 应为并行安全`);
  }
  for (const name of ['write_file', 'edit_file', 'delete_file', 'run_command', 'orchestrate', 'ask_user', 'propose_plan', 'pdf_to_xlsx']) {
    assert.equal(isParallelSafeTool(name), false, `${name} 不应并行`);
  }
  assert.equal(PARALLEL_SAFE_TOOLS.size, 9);
  assert.equal(isParallelSafeTool(''), false);
  assert.equal(isParallelSafeTool(undefined), false);
});

test('连续只读调用合并为一批，遇到写工具立即打断', () => {
  const calls = [
    { name: 'read_file' },
    { name: 'read_file' },
    { name: 'write_file' },
    { name: 'read_file' }
  ];
  assert.deepEqual(planToolBatches(calls), [[0, 1], [2], [3]]);
});

test('全部只读时合并为一批；全部写时逐条串行', () => {
  assert.deepEqual(planToolBatches([{ name: 'read_file' }, { name: 'search_files' }, { name: 'task' }]), [[0, 1, 2]]);
  assert.deepEqual(planToolBatches([{ name: 'write_file' }, { name: 'edit_file' }]), [[0], [1]]);
  assert.deepEqual(planToolBatches([]), []);
  assert.deepEqual(planToolBatches(null), []);
});

test('并行批次保持输入顺序，并隔离单个调用失败', async () => {
  const calls = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const result = await runToolBatch(calls, async (call) => {
    if (call.id === 'b') throw new Error('boom');
    if (call.id === 'a') await new Promise((resolve) => setTimeout(resolve, 20));
    return `ok-${call.id}`;
  });
  assert.deepEqual(result.map((item) => item.call.id), ['a', 'b', 'c']);
  assert.equal(result[0].ok, true);
  assert.equal(result[0].value, 'ok-a');
  assert.equal(result[1].ok, false);
  assert.match(result[1].error.message, /boom/);
  assert.equal(result[2].ok, true);
  assert.equal(result[2].value, 'ok-c');
  assert.ok(result[0].startedAt <= result[0].finishedAt);
});

test('空批次与非法输入安全返回', async () => {
  assert.deepEqual(await runToolBatch([], async () => 'x'), []);
  assert.deepEqual(await runToolBatch(undefined, async () => 'x'), []);
});
