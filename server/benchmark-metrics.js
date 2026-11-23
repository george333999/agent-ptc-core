// 基准报告口径：墙钟、输出 token、轮次与“省输入 / 多输出+多耗时”的换算。
// 纯函数，便于单测和跨版本对比。

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

// 价格默认值来自 DeepSeek 账单；输出单价若未知按 2e-6 估算。
export function estimateCostCny(summary, {
  cacheHitPrice = 2e-8,
  cacheMissPrice = 1e-6,
  outputPrice = 2e-6
} = {}) {
  return Number((
    (Number(summary?.cacheHitTokens) || 0) * cacheHitPrice
    + (Number(summary?.cacheMissTokens) || 0) * cacheMissPrice
    + (Number(summary?.completionTokens) || 0) * outputPrice
  ).toFixed(6));
}

// tokenTimeTradeoff = 输入节省的钱 / (输出增加的钱 + 时间增加折算的钱)。
// 比值 < 1 表示“省输入”不足以抵消“多输出 + 多耗时”，应回退该优化。
export function computeTokenTimeTradeoff(base, optimized, {
  timeCostCnyPerMinute = 0.01,
  prices = {}
} = {}) {
  const baseCost = estimateCostCny(base, prices);
  const optCost = estimateCostCny(optimized, prices);
  const inputBase = (Number(base?.cacheHitTokens) || 0) * (prices.cacheHitPrice ?? 2e-8)
    + (Number(base?.cacheMissTokens) || 0) * (prices.cacheMissPrice ?? 1e-6);
  const inputOpt = (Number(optimized?.cacheHitTokens) || 0) * (prices.cacheHitPrice ?? 2e-8)
    + (Number(optimized?.cacheMissTokens) || 0) * (prices.cacheMissPrice ?? 1e-6);
  const outputBase = (Number(base?.completionTokens) || 0) * (prices.outputPrice ?? 2e-6);
  const outputOpt = (Number(optimized?.completionTokens) || 0) * (prices.outputPrice ?? 2e-6);
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
