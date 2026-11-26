// Benchmark report basis: wall-clock time, output tokens, turns and the "input saved / more output + more time" tradeoff.
// Pure functions, for unit tests and cross-version comparison.

export function percentile(values, ratio) {
  const list = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!list.length) return 0;
  const position = Math.min(1, Math.max(0, Number(ratio) || 0));
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil(position * list.length) - 1));
  return list[index];
}

export function summarizeTurns(turns) {
  const list = Array.isArray(turns) ? turns : [];
  const durations = list.map((turn) => Number(turn.durationMs) || 0);
  const totalDurationMs = durations.reduce((total, value) => total + value, 0);
  const promptTokens = list.reduce((total, turn) => total + (Number(turn.promptTokens) || 0), 0);
  const completionTokens = list.reduce((total, turn) => total + (Number(turn.completionTokens) || 0), 0);
  const cacheHitTokens = list.reduce((total, turn) => total + (Number(turn.cacheHitTokens) || 0), 0);
  const cacheMissTokens = list.reduce((total, turn) => total + (Number(turn.cacheMissTokens) || 0), 0);
  const steps = list.reduce((total, turn) => total + (Number(turn.steps) || 0), 0);
  const toolCalls = list.reduce((total, turn) => total + (Number(turn.toolCalls) || 0), 0);
  const toolRounds = list.reduce((total, turn) => total + (Number(turn.toolRounds) || 0), 0);
  const ptcRounds = list.reduce((total, turn) => total + (Number(turn.ptcRounds) || 0), 0);
  const llmMs = list.reduce((total, turn) => total + (Number(turn.llmMs) || 0), 0);
  const llmTtftMs = list.reduce((total, turn) => total + (Number(turn.llmTtftMs) || 0), 0);
  const llmDecodeMs = list.reduce((total, turn) => total + (Number(turn.llmDecodeMs) || 0), 0);
  const toolMs = list.reduce((total, turn) => total + (Number(turn.toolMs) || 0), 0);
  const approvalWaitMs = list.reduce((total, turn) => total + (Number(turn.approvalWaitMs) || 0), 0);
  const orchestrationMs = list.reduce((total, turn) => total + (Number(turn.orchestrationMs) || 0), 0);
  const passed = list.filter((turn) => turn.passed).length;
  const count = list.length;
  return {
    turns: count,
    wallClockMs: totalDurationMs,
    wallClockP50: percentile(durations, 0.5),
    wallClockP95: percentile(durations, 0.95),
    avgTurnMs: count ? Number((totalDurationMs / count).toFixed(1)) : 0,
    promptTokens,
    completionTokens,
    cacheHitTokens,
    cacheMissTokens,
    totalTokens: promptTokens + completionTokens,
    outputTokensPerTask: count ? Number((completionTokens / count).toFixed(1)) : 0,
    promptTokensPerTask: count ? Number((promptTokens / count).toFixed(1)) : 0,
    turnsPerTask: count ? Number((steps / count).toFixed(2)) : 0,
    toolCallsPerTask: count ? Number((toolCalls / count).toFixed(2)) : 0,
    totalSteps: steps,
    totalToolCalls: toolCalls,
    toolRounds,
    ptcRounds,
    ptcCoverage: toolRounds ? Number((ptcRounds / toolRounds).toFixed(4)) : 0,
    llmMs,
    llmTtftMs,
    llmDecodeMs,
    toolMs,
    approvalWaitMs,
    orchestrationMs,
    llmTtftP50: percentile(list.map((turn) => Number(turn.llmTtftMs) || 0), 0.5),
    llmTtftP95: percentile(list.map((turn) => Number(turn.llmTtftMs) || 0), 0.95),
    llmShare: totalDurationMs > 0 ? Number((llmMs / totalDurationMs).toFixed(4)) : 0,
    accuracy: count ? Number((passed / count).toFixed(4)) : 0,
    cacheHitRate: (cacheHitTokens + cacheMissTokens) > 0
      ? Number((cacheHitTokens / (cacheHitTokens + cacheMissTokens)).toFixed(4))
      : 0
  };
}

// DeepSeek official pricing (CNY / million tokens).
// Off-peak price: cache hit 0.02, cache miss 1, output 4; peak price: cache hit 0.04, cache miss 2, output 8.
// Peak hours are Beijing time Monday to Friday 09:00-12:00 and 14:00-18:00; all other times use the off-peak price.
export const DEEPSEEK_OFFICIAL_PRICING = Object.freeze({
  currency: 'CNY',
  unit: 'per-1m-tokens',
  offPeak: Object.freeze({ cacheHit: 0.02, cacheMiss: 1, output: 4 }),
  peak: Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 })
});

const SHANGHAI_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

export function isDeepSeekPeakTime(at = Date.now()) {
  const time = Number(at) || Date.now();
  const parts = SHANGHAI_TIME.formatToParts(new Date(time));
  const read = (type) => parts.find((part) => part.type === type)?.value || '';
  const weekday = read('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hour = Number(read('hour')) % 24;
  const minute = Number(read('minute'));
  const minutes = (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

// Convert official prices to per-token prices and pick the peak/off-peak tier by task send time.
export function deepSeekOfficialPricing(at = Date.now()) {
  const tier = isDeepSeekPeakTime(at) ? 'peak' : 'offPeak';
  const table = DEEPSEEK_OFFICIAL_PRICING[tier];
  return {
    tier,
    label: tier === 'peak' ? 'peak price' : 'off-peak price',
    cacheHitPrice: table.cacheHit / 1e6,
    cacheMissPrice: table.cacheMiss / 1e6,
    outputPrice: table.output / 1e6
  };
}

// Default to DeepSeek official off-peak price (per token). Callers can pass explicit prices to override.
export const DEFAULT_BENCHMARK_PRICING = Object.freeze({
  cacheHitPrice: DEEPSEEK_OFFICIAL_PRICING.offPeak.cacheHit / 1e6,
  cacheMissPrice: DEEPSEEK_OFFICIAL_PRICING.offPeak.cacheMiss / 1e6,
  outputPrice: DEEPSEEK_OFFICIAL_PRICING.offPeak.output / 1e6
});

function resolvePrices(prices = {}) {
  const pick = (key) => (Number.isFinite(Number(prices[key]))
    ? Number(prices[key])
    : DEFAULT_BENCHMARK_PRICING[key]);
  return {
    cacheHitPrice: pick('cacheHitPrice'),
    cacheMissPrice: pick('cacheMissPrice'),
    outputPrice: pick('outputPrice')
  };
}

export function estimateCostCny(summary, prices = {}) {
  const resolved = resolvePrices(prices);
  return Number((
    (Number(summary?.cacheHitTokens) || 0) * resolved.cacheHitPrice
    + (Number(summary?.cacheMissTokens) || 0) * resolved.cacheMissPrice
    + (Number(summary?.completionTokens) || 0) * resolved.outputPrice
  ).toFixed(6));
}
// tokenTimeTradeoff = money saved on input / (money added for output + money added for time).
// A ratio < 1 means "saving input" does not offset "more output + more time", so the optimization should be reverted.
export function computeTokenTimeTradeoff(base, optimized, {
  timeCostCnyPerMinute = 0.01,
  prices = {}
} = {}) {
  const resolved = resolvePrices(prices);
  const baseCost = estimateCostCny(base, resolved);
  const optCost = estimateCostCny(optimized, resolved);
  const inputBase = (Number(base?.cacheHitTokens) || 0) * resolved.cacheHitPrice
    + (Number(base?.cacheMissTokens) || 0) * resolved.cacheMissPrice;
  const inputOpt = (Number(optimized?.cacheHitTokens) || 0) * resolved.cacheHitPrice
    + (Number(optimized?.cacheMissTokens) || 0) * resolved.cacheMissPrice;
  const outputBase = (Number(base?.completionTokens) || 0) * resolved.outputPrice;
  const outputOpt = (Number(optimized?.completionTokens) || 0) * resolved.outputPrice;
  const inputSaved = Math.max(0, inputBase - inputOpt);
  const outputAdded = Math.max(0, outputOpt - outputBase);
  const timeAddedCny = Math.max(0, ((Number(optimized?.wallClockMs) || 0) - (Number(base?.wallClockMs) || 0)) / 60000)
    * (Number(timeCostCnyPerMinute) || 0);
  const denominator = outputAdded + timeAddedCny;
  return {
    baseCostCny: baseCost,
    optimizedCostCny: optCost,
    inputSavedCny: Number(inputSaved.toFixed(6)),
    outputAddedCny: Number(outputAdded.toFixed(6)),
    timeAddedCny: Number(timeAddedCny.toFixed(6)),
    tradeoff: denominator > 0 ? Number((inputSaved / denominator).toFixed(4)) : (inputSaved > 0 ? Infinity : 0)
  };
}
