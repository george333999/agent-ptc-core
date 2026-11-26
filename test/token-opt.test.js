import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOKEN_OPT_SCHEMA_VERSION,
  applyRoundPolicy,
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

test('Default switches: Phase 1 on, Phase 2 off, distillation and budgets on', () => {
  const policy = withEnv('TOKEN_OPT_PHASE1', undefined, () => resolveTokenOpt({}));
  assert.equal(policy.schemaVersion, TOKEN_OPT_SCHEMA_VERSION);
  assert.equal(policy.phase1, true);
  assert.equal(policy.phase2, false);
  assert.equal(policy.toolResultDistill, true);
  assert.equal(policy.toolResultBudgets, true);
  assert.ok(policy.phase1MinTokens > 0);
  assert.ok(policy.prices.cacheMiss > policy.prices.cacheHit);
});

test('Settings and environment variables can override each switch independently', () => {
  const fromSettings = resolveTokenOpt({ tokenOpt: { phase1: false, phase2: true, toolBudgets: { read_file: 1234 } } });
  assert.equal(fromSettings.phase1, false);
  assert.equal(fromSettings.phase2, true);
  assert.equal(fromSettings.toolBudgets.read_file, 1234);

  const fromEnv = withEnv('TOKEN_OPT_PHASE1', '0', () => resolveTokenOpt({ tokenOpt: { phase1: true } }));
  assert.equal(fromEnv.phase1, false);

  const enabled = withEnv('TOKEN_OPT_PHASE2', '1', () => resolveTokenOpt({}));
  assert.equal(enabled.phase2, true);
});

test('The mid-run prefix lease is off by default and can be enabled via settings or env vars', () => {
  const fallback = withEnv('TOKEN_OPT_SUPPRESS_MID_RUN_COMPACTION', undefined, () => resolveTokenOpt({}));
  assert.equal(fallback.suppressMidRunCompaction, false);
  const fromSettings = resolveTokenOpt({ tokenOpt: { suppressMidRunCompaction: true } });
  assert.equal(fromSettings.suppressMidRunCompaction, true);
  const fromEnv = withEnv('TOKEN_OPT_SUPPRESS_MID_RUN_COMPACTION', '1', () => resolveTokenOpt({}));
  assert.equal(fromEnv.suppressMidRunCompaction, true);
});

test('The history-compaction high watermark is off by default and can be enabled via settings or env vars', () => {
  const fallback = withEnv('TOKEN_OPT_PHASE1_OVERFLOW_TOKENS', undefined, () => resolveTokenOpt({}));
  assert.equal(fallback.phase1OverflowTokens, 0);
  const fromSettings = resolveTokenOpt({ tokenOpt: { phase1OverflowTokens: 90000 } });
  assert.equal(fromSettings.phase1OverflowTokens, 90000);
  const fromEnv = withEnv('TOKEN_OPT_PHASE1_OVERFLOW_TOKENS', '75000', () => resolveTokenOpt({}));
  assert.equal(fromEnv.phase1OverflowTokens, 75000);
});

test('Parameterized unit prices: overridable per billing, invalid values fall back to defaults', () => {
  const policy = resolveTokenOpt({ tokenOpt: { cacheHitPrice: 0.00000004, cacheMissPrice: 0.000002 } });
  assert.equal(policy.prices.cacheHit, 0.00000004);
  assert.equal(policy.prices.cacheMiss, 0.000002);

  const fallback = resolveTokenOpt({ tokenOpt: { cacheHitPrice: -1 } });
  assert.ok(fallback.prices.cacheHit > 0);
});

test('Token estimation uses a conservative ratio and is safe for empty input', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcde'), 2);
  assert.ok(estimateTokens('中'.repeat(100)) >= 40);
  assert.equal(estimateMessagesTokens([]), 0);
  assert.ok(estimateMessagesTokens([{ role: 'user', content: 'x'.repeat(100) }]) > 0);
});

test('Default budgets prioritize avoiding read-back: read_file budget raised and distillation has a minimum length', () => {
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

test('The larger the context window, the higher the distillation threshold and single-read budget', () => {
  const small = resolveTokenOpt({}, { contextWindow: 32000 });
  const large = resolveTokenOpt({}, { contextWindow: 128000 });
  assert.ok(large.toolBudgets.read_file > small.toolBudgets.read_file);
  assert.ok(large.distillMinChars >= small.distillMinChars);
});

test('Conversation-length tiers: short conversations allow compaction; medium/long keep only no-extra-turn optimizations', () => {
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
  assert.equal(long.distillMinChars, 24000);
  assert.equal(resolveRoundPolicy(0).tier, 'short');
});

test('All tiers use 70% as the compaction trigger; medium/long additionally disable Phase 2', () => {
  const longPolicy = resolveTokenOpt({});
  applyRoundPolicy(longPolicy, resolveRoundPolicy(100), 128000);
  assert.equal(longPolicy.phase1, true);
  assert.equal(longPolicy.phase2, false);
  assert.equal(longPolicy.phase1OverflowTokens, Math.floor(128000 * 0.7));

  // Scenarios like 200 steps in one turn ("few user messages but a large total") also need the 70% trigger.
  const shortPolicy = resolveTokenOpt({});
  applyRoundPolicy(shortPolicy, resolveRoundPolicy(5), 128000);
  assert.equal(shortPolicy.phase1, true);
  assert.equal(shortPolicy.phase1OverflowTokens, Math.floor(128000 * 0.7));

  // An explicitly configured overflow threshold takes precedence and is not overridden.
  const custom = resolveTokenOpt({ tokenOpt: { phase1OverflowTokens: 200000 } });
  applyRoundPolicy(custom, resolveRoundPolicy(30), 128000);
  assert.equal(custom.phase1OverflowTokens, 200000);
});

test('Large tool-result injection cap: 8k by default, head + tail never exceed the cap', () => {
  const policy = resolveTokenOpt({});
  assert.equal(policy.toolResultInjectCap, true);
  assert.equal(policy.toolResultInjectCapChars, 8000);
  assert.equal(policy.toolResultInjectHeadChars, 4000);
  assert.equal(policy.toolResultInjectTailChars, 2000);

  const custom = resolveTokenOpt({
    tokenOpt: { toolResultInjectCapChars: 12000, toolResultInjectHeadChars: 6000, toolResultInjectTailChars: 3000 }
  });
  assert.equal(custom.toolResultInjectCapChars, 12000);
  assert.equal(custom.toolResultInjectHeadChars, 6000);
  assert.equal(custom.toolResultInjectTailChars, 3000);

  // Boundary: a too-small cap is raised to 2000; head/tail budgets converge automatically and their sum stays within the cap.
  const tiny = resolveTokenOpt({ tokenOpt: { toolResultInjectCapChars: 10 } });
  assert.equal(tiny.toolResultInjectCapChars, 2000);
  assert.ok(tiny.toolResultInjectHeadChars + tiny.toolResultInjectTailChars <= 2000);

  // Boundary: when head + tail exceed the cap, the tail budget is reduced.
  const overflow = resolveTokenOpt({
    tokenOpt: { toolResultInjectCapChars: 6000, toolResultInjectHeadChars: 5900, toolResultInjectTailChars: 5900 }
  });
  assert.ok(overflow.toolResultInjectHeadChars + overflow.toolResultInjectTailChars <= 6000);

  const disabled = resolveTokenOpt({ tokenOpt: { toolResultInjectCap: false } });
  assert.equal(disabled.toolResultInjectCap, false);
});
