import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCacheSamples, formatPrefixDiffReport } from '../server/prefix-diff.js';

function sample(step, overrides = {}) {
  return {
    ts: `2026-01-01T00:00:0${step}Z`,
    sessionId: 's1',
    workerId: 'main',
    step,
    systemHash: 'sys',
    toolsHash: 'tools',
    frozenPrefixHash: 'p1',
    prefixChars: 1000,
    cacheHitRate: 0.9,
    cacheReported: true,
    windowTrimmed: false,
    compactionApplied: false,
    ...overrides
  };
}

test('prefix drift attribution identifies system/tools/trim/compaction changes', () => {
  const analysis = analyzeCacheSamples([
    sample(1),
    sample(2),
    sample(3, { systemHash: 'sys2', frozenPrefixHash: 'p2', cacheHitRate: 0.4 }),
    sample(4, { systemHash: 'sys2', toolsHash: 'tools2', frozenPrefixHash: 'p3' }),
    sample(5, { systemHash: 'sys2', toolsHash: 'tools2', windowTrimmed: true, frozenPrefixHash: 'p4' }),
    sample(6, { systemHash: 'sys2', toolsHash: 'tools2', windowTrimmed: true, compactionApplied: true, frozenPrefixHash: 'p5' }),
    sample(7, { systemHash: 'sys2', toolsHash: 'tools2', windowTrimmed: true, compactionApplied: true, prefixChars: 900, frozenPrefixHash: 'p6' })
  ]);
  assert.equal(analysis.totalSamples, 7);
  assert.equal(analysis.totalChanges, 5);
  assert.equal(analysis.workers.length, 1);
  const worker = analysis.workers[0];
  assert.deepEqual(worker.changeDetails.map((item) => item.reasons), [
    ['system'],
    ['tools'],
    ['trim'],
    ['compaction'],
    ['prefixChars']
  ]);
  assert.equal(worker.changeDetails[0].hitRateBefore > worker.changeDetails[0].hitRateAfter, true);
});

test('identical prefixes produce no changes, multiple workers are counted separately', () => {
  const analysis = analyzeCacheSamples([
    sample(1),
    sample(2),
    sample(1, { workerId: 'worker:t1', frozenPrefixHash: 'w1' })
  ]);
  assert.equal(analysis.totalChanges, 0);
  assert.equal(analysis.workers.length, 2);
  const report = formatPrefixDiffReport(analysis);
  assert.match(report, /Prefix drift attribution/);
  assert.match(report, /worker:t1/);
});

test('empty samples and corrupted fields are safe', () => {
  const analysis = analyzeCacheSamples([null, {}, { sessionId: 's', workerId: 'w', step: 'x' }]);
  assert.equal(analysis.totalSamples, 2);
  assert.equal(analysis.totalChanges, 0);
});
