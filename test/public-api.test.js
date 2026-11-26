import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../index.js';

test('public API exports four categories of core capabilities', () => {
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
    assert.ok(name in core, `missing export ${name}`);
  }
  assert.equal(typeof core.PtcEngine, 'function');
  assert.equal(typeof core.runPtcTool, 'function');
});

test('public API history window and stable prefix can be combined directly', () => {
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
