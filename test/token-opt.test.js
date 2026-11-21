import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOKEN_OPT_SCHEMA_VERSION,
  estimateMessagesTokens,
  estimateTokens,
  resolveTokenOpt
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
