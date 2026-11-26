// Unified configuration, estimation convention, and price parameters for token optimization.
// Notes:
// 1) all estimates use the "conservative" ratio chars / 2.5 (prefer over-estimating tokens, never under);
// 2) unit prices are parameterized, no hard-coded multipliers; defaults come from billing (cache miss / hit = 50);
// 3) each optimization item has an independent switch, individually rolled back via settings.tokenOpt or environment variables.

export const TOKEN_OPT_SCHEMA_VERSION = 1;

export const DEFAULT_CACHE_HIT_PRICE = 2e-8;
export const DEFAULT_CACHE_MISS_PRICE = 1e-6;

// Hard limit (chars) for a single tool-result return / read-back.
export const TOOL_RESULT_READ_LIMIT = 20000;

// Default result budget per tool; results over budget are persisted and only a structured summary stays in history.
// Why raise budgets: one tool round-trip costs about 1.8 seconds, while keeping a few thousand more cached input tokens is very cheap,
// so prefer letting the model read it all in one pass, avoiding extra turns from pagination/read-back.
export const DEFAULT_TOOL_RESULT_BUDGETS = Object.freeze({
  read_file: 20000,
  search_files: 12000,
  list_files: 10000,
  ptc_run: 16000,
  run_command: 10000,
  knowledge_search: 8000,
  fetch_url: 8000,
  web_search: 6000,
  extract_text: 8000,
  pdf_to_xlsx: 6000,
  read_tool_result: TOOL_RESULT_READ_LIMIT,
  default: 12000
});

// Per-call tool-result injection cap (chars): beyond it, keep only head and tail and persist the middle.
export const DEFAULT_TOOL_RESULT_INJECT_CAP = 8000;
export const DEFAULT_TOOL_RESULT_INJECT_HEAD = 4000;
export const DEFAULT_TOOL_RESULT_INJECT_TAIL = 2000;

// Worker-only tail budget: the shared prefix is about 5-6k chars; keeping the tail within 4k chars
// keeps the "prefix hit / total input" ratio above 60% on the first round and stably hitting as it warms up.
export const DEFAULT_WORKER_TAIL_CHARS = 4000;
export const DEFAULT_WORKER_PREFETCH_CHARS = 2000;
export const DEFAULT_WORKER_UPSTREAM_CHARS = 1000;
export const DEFAULT_WORKER_UPSTREAM_TOTAL_CHARS = 2000;

function resolveInjectBudget(raw = {}) {
  const cap = Math.max(2000, positiveNumber(raw.toolResultInjectCapChars, DEFAULT_TOOL_RESULT_INJECT_CAP));
  const head = Math.max(500, Math.min(positiveNumber(raw.toolResultInjectHeadChars, DEFAULT_TOOL_RESULT_INJECT_HEAD), cap - 500));
  const tail = Math.max(500, Math.min(positiveNumber(raw.toolResultInjectTailChars, DEFAULT_TOOL_RESULT_INJECT_TAIL), cap - head));
  return {
    toolResultInjectCapChars: cap,
    toolResultInjectHeadChars: head,
    toolResultInjectTailChars: tail
  };
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function booleanFlag(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value !== '0' && value.toLowerCase() !== 'false';
  return Boolean(value);
}

export function resolveTokenOpt(settings = {}, options = {}) {
  const raw = settings?.tokenOpt && typeof settings.tokenOpt === 'object' ? settings.tokenOpt : {};
  const env = process.env;
  const flag = (name, fallback) => {
    const envValue = env[`TOKEN_OPT_${name.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase()}`];
    if (envValue !== undefined && envValue !== '') return booleanFlag(envValue, fallback);
    return booleanFlag(raw[name], fallback);
  };
  const contextWindow = Math.max(8000, Number(options.contextWindow) || 128000);
  // Keep only the hard constraint "no extra turns": the distillation threshold is as high as possible, medium results kept verbatim;
  // also capped at 48k chars, avoiding a single large result slowing down the prefill of every subsequent step.
  const contextBudgetChars = Math.floor(contextWindow * 0.75 * 2.5);
  const distillFloor = Math.min(48000, Math.max(16000, contextBudgetChars));
  const readBudget = Math.min(48000, Math.max(20000, Math.floor(contextWindow * 0.25 * 2.5)));
  const budgets = {
    ...DEFAULT_TOOL_RESULT_BUDGETS,
    read_file: readBudget,
    search_files: Math.max(DEFAULT_TOOL_RESULT_BUDGETS.search_files, Math.floor(readBudget * 0.6)),
    list_files: Math.max(DEFAULT_TOOL_RESULT_BUDGETS.list_files, Math.floor(readBudget * 0.4)),
    ptc_run: Math.max(DEFAULT_TOOL_RESULT_BUDGETS.ptc_run, Math.floor(readBudget * 0.8)),
    default: Math.max(DEFAULT_TOOL_RESULT_BUDGETS.default, Math.floor(readBudget * 0.6))
  };
  if (raw.toolBudgets && typeof raw.toolBudgets === 'object') {
    for (const [key, value] of Object.entries(raw.toolBudgets)) {
      budgets[key] = positiveNumber(value, budgets[key] || budgets.default);
    }
  }
  return {
    schemaVersion: TOKEN_OPT_SCHEMA_VERSION,
    // Phase 1: structured-fact-sheet compaction riding windowTrimmed (on by default).
    phase1: flag('phase1', true),
    // Phase 2: standalone compaction (off by default; observe candidates via logs first).
    phase2: flag('phase2', false),
    // Agent-aware prefix lease: no compaction during task execution (usedSteps > 0) by default,
    // avoiding repeatedly breaking the prefix cache on the critical path; compaction is still allowed when the context is really near overflow.
    suppressMidRunCompaction: flag('suppressMidRunCompaction', false),
    toolResultDistill: flag('toolResultDistill', true),
    toolResultBudgets: flag('toolResultBudgets', true),
    toolBudgets: budgets,
    // Results below this char count are not distilled even if they exceed the per-tool budget: one read-back costs far more than keeping the raw input.
    distillMinChars: positiveNumber(raw.distillMinChars, distillFloor),
    // Preview cap for distilled summaries; too short a preview forces the model to read_tool_result for read-back.
    distillPreviewChars: positiveNumber(raw.distillPreviewChars, 1200),
    // Large tool-result injection throttling: past the cap, inject only "head + tail" and persist the middle for read-back.
    // Purpose: keep the per-step prompt increment controllable, avoiding the first large result amplifying every subsequent step's prefill and cache misses.
    toolResultInjectCap: flag('toolResultInjectCap', true),
    ...resolveInjectBudget(raw),
    // Worker-only hard tail budget (chars): the shorter the part outside the shared prefix, the higher the first-round hit rate.
    workerTailChars: Math.max(600, positiveNumber(raw.workerTailChars, DEFAULT_WORKER_TAIL_CHARS)),
    // Worker prefetch body cap; also bounded by workerTailChars, leaving at least 2000 chars for the task brief.
    workerPrefetchChars: Math.max(0, positiveNumber(raw.workerPrefetchChars, DEFAULT_WORKER_PREFETCH_CHARS)),
    workerUpstreamChars: Math.max(100, positiveNumber(raw.workerUpstreamChars, DEFAULT_WORKER_UPSTREAM_CHARS)),
    workerUpstreamTotalChars: Math.max(100, positiveNumber(raw.workerUpstreamTotalChars, DEFAULT_WORKER_UPSTREAM_TOTAL_CHARS)),
    // Compaction prechecks
    minHistoryTokens: positiveNumber(raw.minHistoryTokens, 5000),
    phase1MinTokens: positiveNumber(raw.phase1MinTokens, 20000),
    phase1MinTokensShort: positiveNumber(raw.phase1MinTokensShort, 10000),
    // 0 means keep the original threshold; when positive, compact only when history is near the context window (overflow risk),
    // reducing prefix rebuilds at trim points. Off by default, to avoid changing the existing token convention.
    phase1OverflowTokens: positiveNumber(raw.phase1OverflowTokens ?? env.TOKEN_OPT_PHASE1_OVERFLOW_TOKENS, 0),
    // Predictive skip: beyond the watermark, extrapolate the remaining context by "used steps × per-step increment",
    // skipping this compaction when the hard limit isn't expected to be hit (better saving compaction for trim points that really need it).
    // A safety factor > 1 means leaning toward compaction (skip only when clearly not overflowing).
    predictiveCompaction: flag('predictiveCompaction', true),
    predictiveSafety: positiveNumber(raw.predictiveSafety, 1.1),
    phase2MinTokens: positiveNumber(raw.phase2MinTokens, 30000),
    // History ratio covered by a single compaction (by chars): larger → fewer compactions, each more aggressive.
    // Default stays 0.5 (consistent with historical behavior); tune to 0.55-0.6 via A/B when prefix rebuilds need reducing.
    phase1TargetRatio: Math.min(0.9, Math.max(0.1, positiveNumber(raw.phase1TargetRatio, 0.5))),
    summaryRatio: Math.min(0.5, positiveNumber(raw.summaryRatio, 0.15)),
    // Absolute floor for the summary: prevents fixed fields (paths/counts) from exceeding the ratio and being rejected during small-range compaction.
    summaryFloorTokens: positiveNumber(raw.summaryFloorTokens, 1200),
    // Minimum original tokens for a single compaction; below it the benefit is insufficient, so skip directly.
    minRangeTokens: positiveNumber(raw.minRangeTokens, 5000),
    minSavedRatio: Math.min(0.9, positiveNumber(raw.minSavedRatio, 0.3)),
    // Phase 2 triggers and constraints
    phase2IntervalSteps: Math.max(1, Math.floor(positiveNumber(raw.phase2IntervalSteps, 10))),
    minStepsBetweenCompactions: Math.max(1, Math.floor(positiveNumber(raw.minStepsBetweenCompactions, 5))),
    // Unit prices (per token); daily accounting should override per actual billing tiers.
    prices: {
      cacheHit: positiveNumber(raw.cacheHitPrice, DEFAULT_CACHE_HIT_PRICE),
      cacheMiss: positiveNumber(raw.cacheMissPrice, DEFAULT_CACHE_MISS_PRICE)
    }
  };
}

// Tier by conversation length: short conversations can afford a little read-back; medium/long conversations keep only "no extra turns" optimizations.
// What is returned here are overrides; the caller takes the more conservative value with the base token policy.
export function resolveRoundPolicy(historyMessages = 0) {
  const count = Math.max(0, Math.floor(Number(historyMessages) || 0));
  if (count < 20) {
    return { tier: 'short', roundIncreasingCompaction: true, phase1: true, distillMinChars: 0 };
  }
  if (count <= 40) {
    return { tier: 'medium', roundIncreasingCompaction: false, phase1: false, distillMinChars: 32000 };
  }
  return { tier: 'long', roundIncreasingCompaction: false, phase1: false, distillMinChars: 24000 };
}

/**
 * Apply the conversation-tier policy (independent of the tool-round cap; takes effect for every tier):
 * - consistently set the Phase 1 compaction trigger at 70% of context: avoids history only growing,
 *   and doesn't repeatedly rebuild the prefix at low usage; an explicitly configured phase1OverflowTokens takes precedence.
 * - medium/long conversations additionally disable standalone compaction (phase2), avoiding repeatedly breaking the prefix cache on the critical path.
 */
export function applyRoundPolicy(tokenOpt, roundPolicy = {}, contextWindow = 0) {
  if (!tokenOpt) return tokenOpt;
  if (!(Number(tokenOpt.phase1OverflowTokens) > 0)) {
    const window = Math.max(8000, Number(contextWindow) || 128000);
    tokenOpt.phase1OverflowTokens = Math.max(1000, Math.floor(window * 0.7));
  }
  if (!roundPolicy.roundIncreasingCompaction) tokenOpt.phase2 = false;
  return tokenOpt;
}

// Conservative token estimate: Chinese is about 1.5-2 chars/token, code/JSON lower; 2.5 reduces under-estimation.
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 2.5);
}

export function estimateMessagesChars(messages) {
  let total = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    try {
      total += JSON.stringify(message)?.length || 0;
    } catch {
      // Ignore non-serializable messages
    }
  }
  return total;
}

export function estimateMessagesTokens(messages) {
  return Math.ceil(estimateMessagesChars(messages) / 2.5);
}
