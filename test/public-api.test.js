import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../index.js';

test('公共 API 导出四类核心能力', () => {
  const expected = [
    'resolveLaggingWindow',
    'applyHistoryWindow',
    'buildCachePrefix',
    'buildRequestFingerprint',
    'commonPrefixRatio',
    'distillToolResult',
    'readStoredToolResult',
    'resolveTokenOpt',
    'normalizeCacheUsage',
    'recordCacheSample',
    'sortToolDefinitions',
    'PtcEngine',
    'validatePtcCode',
    'runPtcTool',
    'buildPtcToolDefinition',
    'buildTurnContext',
    'planPrefetch',
    'extractColdFacts',
    'renderArtifactIndex',
    'createWindowContext',
    'resolveInlinePlan',
    'shouldDistillToolResult',
    'buildWorkerSystemPrompt',
    'analyzeCacheSamples',
    'calibrateTasks',
    'resolveWriteConflicts',
    'summarizeOrchestrationMetrics',
    'estimateCostCny',
    'DEFAULT_BENCHMARK_PRICING',
    'DEEPSEEK_OFFICIAL_PRICING',
    'isDeepSeekPeakTime',
    'deepSeekOfficialPricing'
  ];
  for (const name of expected) {
    assert.ok(name in core, `缺少导出 ${name}`);
  }
  assert.equal(typeof core.PtcEngine, 'function');
  assert.equal(typeof core.runPtcTool, 'function');
});

test('公共 API 的历史窗口与稳定前缀可直接组合使用', () => {
  const limits = {
    softMessages: 4,
    hardMessages: 6,
    softChars: 1_000_000,
    hardChars: 2_000_000
  };
  const messages = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: 'four' }
  ];
  const first = core.resolveLaggingWindow(messages, 0, limits);
  assert.equal(first.window.length, 4);
  assert.equal(first.trimmed, false);

  const system = 'stable system';
  const tools = [{ type: 'function', function: { name: 'read_file' } }];
  const before = core.buildRequestFingerprint({ system, tools, messages: first.window }).text;
  const next = core.buildRequestFingerprint({ system, tools, messages: [...first.window, { role: 'user', content: 'five' }] }).text;
  assert.equal(core.commonPrefixRatio(before, next), 1);

  const sorted = core.sortToolDefinitions([
    { function: { name: 'b' } },
    { function: { name: 'a' } }
  ]);
  assert.deepEqual(sorted.map((item) => item.function.name), ['a', 'b']);
});
