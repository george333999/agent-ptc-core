import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOKEN_OPT_SCHEMA_VERSION,
  estimateMessagesTokens,
  estimateTokens,
  resolveTokenOpt,
  resolveRoundPolicy
} from '../server/token-opt.js';

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('默认开关：Phase 1 开、Phase 2 关、蒸馏与预算开', () => {
  const policy = withEnv('TOKEN_OPT_PHASE1', undefined, () => resolveTokenOpt({}));
  assert.equal(policy.schemaVersion, TOKEN_OPT_SCHEMA_VERSION);
  assert.equal(policy.phase1, true);
  assert.equal(policy.phase2, false);
  assert.equal(policy.toolResultDistill, true);
  assert.equal(policy.toolResultBudgets, true);
  assert.ok(policy.phase1MinTokens > 0);
  assert.ok(policy.prices.cacheMiss > policy.prices.cacheHit);
});

test('设置与环境变量可以独立覆盖每个开关', () => {
  const fromSettings = resolveTokenOpt({ tokenOpt: { phase1: false, phase2: true, toolBudgets: { read_file: 1234 } } });
  assert.equal(fromSettings.phase1, false);
  assert.equal(fromSettings.phase2, true);
  assert.equal(fromSettings.toolBudgets.read_file, 1234);

  const fromEnv = withEnv('TOKEN_OPT_PHASE1', '0', () => resolveTokenOpt({ tokenOpt: { phase1: true } }));
  assert.equal(fromEnv.phase1, false);

  const enabled = withEnv('TOKEN_OPT_PHASE2', '1', () => resolveTokenOpt({}));
  assert.equal(enabled.phase2, true);
});

test('执行中前缀租约默认关闭，可通过设置或环境变量开启', () => {
  const fallback = withEnv('TOKEN_OPT_SUPPRESS_MID_RUN_COMPACTION', undefined, () => resolveTokenOpt({}));
  assert.equal(fallback.suppressMidRunCompaction, false);
  const fromSettings = resolveTokenOpt({ tokenOpt: { suppressMidRunCompaction: true } });
  assert.equal(fromSettings.suppressMidRunCompaction, true);
  const fromEnv = withEnv('TOKEN_OPT_SUPPRESS_MID_RUN_COMPACTION', '1', () => resolveTokenOpt({}));
  assert.equal(fromEnv.suppressMidRunCompaction, true);
});

test('历史压缩高水位默认关闭，可通过设置或环境变量开启', () => {
  const fallback = withEnv('TOKEN_OPT_PHASE1_OVERFLOW_TOKENS', undefined, () => resolveTokenOpt({}));
  assert.equal(fallback.phase1OverflowTokens, 0);
  const fromSettings = resolveTokenOpt({ tokenOpt: { phase1OverflowTokens: 90000 } });
  assert.equal(fromSettings.phase1OverflowTokens, 90000);
  const fromEnv = withEnv('TOKEN_OPT_PHASE1_OVERFLOW_TOKENS', '75000', () => resolveTokenOpt({}));
  assert.equal(fromEnv.phase1OverflowTokens, 75000);
});

test('单价参数化：可按账单覆盖，非法值回退默认', () => {
  const policy = resolveTokenOpt({ tokenOpt: { cacheHitPrice: 0.00000004, cacheMissPrice: 0.000002 } });
  assert.equal(policy.prices.cacheHit, 0.00000004);
  assert.equal(policy.prices.cacheMiss, 0.000002);

  const fallback = resolveTokenOpt({ tokenOpt: { cacheHitPrice: -1 } });
  assert.ok(fallback.prices.cacheHit > 0);
});

test('token 估算使用保守比例并对空输入安全', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcde'), 2);
  assert.ok(estimateTokens('中'.repeat(100)) >= 40);
  assert.equal(estimateMessagesTokens([]), 0);
  assert.ok(estimateMessagesTokens([{ role: 'user', content: 'x'.repeat(100) }]) > 0);
});

test('默认预算优先避免回读：read_file 预算上调且蒸馏有最小长度', () => {
  const policy = resolveTokenOpt({});
  assert.ok(policy.toolBudgets.read_file >= 20000);
  assert.ok(policy.toolBudgets.search_files >= 12000);
  assert.ok(policy.distillMinChars >= 16000);
  assert.ok(policy.distillPreviewChars >= 1000);
  const custom = resolveTokenOpt({ tokenOpt: { distillMinChars: 24000, distillPreviewChars: 1500 } });
  assert.equal(custom.distillMinChars, 24000);
  assert.equal(custom.distillPreviewChars, 1500);
  assert.ok(resolveTokenOpt({ tokenOpt: { distillMinChars: -1 } }).distillMinChars > 16000);
});

test('上下文窗口越大，蒸馏阈值与单次读取预算越高', () => {
  const small = resolveTokenOpt({}, { contextWindow: 32000 });
  const large = resolveTokenOpt({}, { contextWindow: 128000 });
  assert.ok(large.toolBudgets.read_file > small.toolBudgets.read_file);
  assert.ok(large.distillMinChars >= small.distillMinChars);
});

test('对话长度分档：短对话允许压缩，中/长对话只保留不增轮次的优化', () => {
  const short = resolveRoundPolicy(8);
  assert.equal(short.tier, 'short');
  assert.equal(short.roundIncreasingCompaction, true);
  assert.equal(short.phase1, true);

  const medium = resolveRoundPolicy(30);
  assert.equal(medium.tier, 'medium');
  assert.equal(medium.roundIncreasingCompaction, false);
  assert.equal(medium.phase1, false);
  assert.ok(medium.distillMinChars >= 32000);

  const long = resolveRoundPolicy(100);
  assert.equal(long.tier, 'long');
  assert.equal(long.roundIncreasingCompaction, false);
  assert.equal(long.phase1, false);
  assert.ok(long.distillMinChars >= 48000);
  assert.equal(resolveRoundPolicy(0).tier, 'short');
});
