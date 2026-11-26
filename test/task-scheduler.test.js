import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrateDuration,
  calibrateTasks,
  validateGranularity,
  resolveWriteConflicts,
  resolveSoftDeadline,
  shouldHedge,
  shouldRedispatch,
  historyFromResults
} from '../server/task-scheduler.js';

test('Duration calibration weights the historical median and model estimate equally', () => {
  assert.equal(calibrateDuration({ historyMs: [1000, 3000], estimateMs: 5000 }), 3500);
  assert.equal(calibrateDuration({ historyMs: [2000], estimateMs: 0 }), 2000);
  assert.equal(calibrateDuration({ historyMs: [], estimateMs: 4000 }), 4000);
  assert.equal(calibrateDuration({ historyMs: [], estimateMs: 0 }), 0);
  assert.equal(calibrateDuration({ historyMs: [1000, 3000], estimateMs: 5000, weight: 0.3 }), 4100);
});

test('Task calibration accepts both minute and millisecond estimates', () => {
  const result = calibrateTasks([
    { id: 'a', estimatedMinutes: 1 },
    { id: 'b', estimatedMs: 120000 }
  ], { historyMs: [60000, 60000] });
  assert.equal(result.tasks[0].calibratedMs, 60000);
  assert.equal(result.tasks[0].estimateMs, 60000);
  assert.equal(result.tasks[1].estimateMs, 120000);
  assert.equal(result.tasks[1].calibratedMs, 90000);
  assert.equal(result.historySamples, 2);
});

test('Calibrated values are written back to estimatedMinutes so LPT/critical path actually use them', () => {
  const result = calibrateTasks([
    { id: 'a', estimatedMinutes: 1 },
    { id: 'b', estimatedMinutes: 1 }
  ], { historyMs: [30000, 30000] });
  // History 30s, model estimate 60s → calibrated 45s = 0.75 minutes.
  assert.equal(result.tasks[0].calibratedMs, 45000);
  assert.equal(result.tasks[0].estimatedMinutes, 0.75);
  // Non-positive estimates must not be written back, avoiding estimatedMinutes becoming 0 or negative.
  const empty = calibrateTasks([{ id: 'c' }]);
  assert.equal(empty.tasks[0].calibratedMs, 0);
  assert.equal(empty.tasks[0].estimatedMinutes, undefined);
  const bad = calibrateTasks([{ id: 'd', estimatedMinutes: -3 }]);
  assert.equal(bad.tasks[0].calibratedMs, 0);
  assert.equal(bad.tasks[0].estimatedMinutes, -3);
});

test('Granularity validation covers too coarse, too fine, and duration skew', () => {
  const six = Array.from({ length: 6 }, (_, index) => ({ id: `t${index}`, calibratedMs: 60000 }));
  assert.equal(validateGranularity(six).code, 'OK');
  assert.equal(validateGranularity([{ id: 'a', calibratedMs: 1000 }]).code, 'TOO_COARSE');
  const many = Array.from({ length: 10 }, (_, index) => ({ id: `t${index}`, calibratedMs: 50000 }));
  assert.equal(validateGranularity(many).code, 'TOO_FINE');
  const skewed = [...six.slice(1), { id: 'slow', calibratedMs: 300000 }];
  const skew = validateGranularity(skewed);
  assert.equal(skew.code, 'DURATION_SKEW');
  assert.deepEqual(skew.outliers, ['slow']);
  assert.match(skew.reason, /consider splitting/);
});

test('Write-set conflicts serialize by task order without duplicate dependencies', () => {
  const result = resolveWriteConflicts([
    { id: 'a', writeFiles: ['out/x.md'], dependsOn: [] },
    { id: 'b', writeFiles: ['out/y.md'], dependsOn: [] },
    { id: 'c', writeFiles: ['out/x.md'], dependsOn: [] },
    { id: 'd', writeFiles: ['./out/x.md', 'out/y.md'], dependsOn: ['a'] }
  ]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.tasks[2].dependsOn, ['a']);
  assert.deepEqual([...result.tasks[3].dependsOn].sort(), ['a', 'b', 'c']);
  assert.equal(result.tasks[3].writeFiles.length, 2);
  assert.deepEqual(result.tasks[0].dependsOn, []);
  assert.equal(result.conflicts.length, 3);
  // No conflict leaves dependencies unchanged
  const clean = resolveWriteConflicts([{ id: 'a', writeFiles: ['x'] }, { id: 'b', writeFiles: ['y'] }]);
  assert.equal(clean.changed, false);
});

test('Soft deadline uses p90×1.2 clamped to 30s-120s', () => {
  assert.equal(resolveSoftDeadline({ historyMs: [] }), 120000);
  const small = resolveSoftDeadline({ historyMs: [10000, 12000, 15000] });
  assert.equal(small, 30000);
  const mid = resolveSoftDeadline({ historyMs: [40000, 45000, 50000, 55000] });
  assert.equal(mid, 66000);
  assert.equal(resolveSoftDeadline({ historyMs: [200000] }), 120000);
  assert.equal(resolveSoftDeadline({ historyMs: [40000], minMs: 1000 }), 48000);
});

test('Hedging conditions are strict: straggler ratio > 2 and under the hedge count', () => {
  assert.equal(shouldHedge({ stragglerRatio: 2 }), false);
  assert.equal(shouldHedge({ stragglerRatio: 2.1 }), true);
  assert.equal(shouldHedge({ stragglerRatio: 3, hedgeCount: 1 }), false);
  assert.equal(shouldHedge({ stragglerRatio: 3, hedgeCount: 0, maxHedges: 2 }), true);
});

test('Redispatch only retryable partial/timeout read tasks', () => {
  assert.equal(shouldRedispatch({ result: { status: 'partial', retryable: true, writes: [] } }), true);
  assert.equal(shouldRedispatch({ result: { status: 'timeout', retryable: true, writes: [] }, attempt: 1 }), false);
  assert.equal(shouldRedispatch({ result: { status: 'partial', retryable: false } }), false);
  assert.equal(shouldRedispatch({ result: { status: 'completed', retryable: true } }), false);
  assert.equal(shouldRedispatch({ result: { status: 'partial', retryable: true, writes: ['a.md'] } }), false);
});

test('History keeps only valid durations and respects the limit', () => {
  const history = historyFromResults([
    { durationMs: 1000 }, { durationMs: 0 }, { durationMs: 'x' }, { durationMs: 2000 }
  ], { limit: 1 });
  assert.deepEqual(history, [2000]);
  assert.deepEqual(historyFromResults(null), []);
});
