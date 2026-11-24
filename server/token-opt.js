// Token 优化策略的统一配置、估算口径与价格参数。
// 说明：
// 1) 所有估算统一用“保守”比例 chars / 2.5（宁可高估 token，不低估）；
// 2) 单价参数化，不硬编码倍数；默认值来自账单（cache miss / hit = 50）；
// 3) 每个优化项都有独立开关，可用 settings.tokenOpt 或环境变量单独回滚。

export const TOKEN_OPT_SCHEMA_VERSION = 1;

export const DEFAULT_CACHE_HIT_PRICE = 2e-8;
export const DEFAULT_CACHE_MISS_PRICE = 1e-6;

// 单次工具结果返回 / 回读的硬上限（字符）。
export const TOOL_RESULT_READ_LIMIT = 20000;

// 各工具的默认结果预算；超过预算的结果落盘，历史里只保留结构化摘要。
// 预算上调的原因：一次工具往返约等于 1.8 秒，而多保留几千 token 的缓存输入成本极低，
// 因此优先让模型一次读完，避免分页/回读产生额外轮次。
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

// 单次工具结果注入上限（字符）：超过后只保留头部与尾部，中间落盘。
export const DEFAULT_TOOL_RESULT_INJECT_CAP = 8000;
export const DEFAULT_TOOL_RESULT_INJECT_HEAD = 4000;
export const DEFAULT_TOOL_RESULT_INJECT_TAIL = 2000;

// Worker 专属尾部预算：共享前缀约 5-6k 字符，尾部控制在 4k 字符以内，
// 首轮“前缀命中 / 总输入”可保持在 60% 以上，并随预热稳定命中。
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
  // 只保留“轮次不增”的硬约束：蒸馏阈值尽量高，中等结果原样保留；
  // 同时用 48k 字符封顶，避免单个大结果把后续每一步的 prefill 都拖慢。
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
    // Phase 1：搭 windowTrimmed 便车的结构化事实清单压缩（默认开）。
    phase1: flag('phase1', true),
    // Phase 2：独立压缩（默认关，先以日志形式观察候选）。
    phase2: flag('phase2', false),
    // Agent 感知前缀租约：任务执行中（usedSteps > 0）默认不压缩，
    // 避免在关键路径上反复破坏前缀缓存；上下文真正接近溢出时仍允许压缩。
    suppressMidRunCompaction: flag('suppressMidRunCompaction', false),
    toolResultDistill: flag('toolResultDistill', true),
    toolResultBudgets: flag('toolResultBudgets', true),
    toolBudgets: budgets,
    // 低于该字符数的结果即使超过单工具预算也不蒸馏：一次回读的耗时远高于保留原文的输入成本。
    distillMinChars: positiveNumber(raw.distillMinChars, distillFloor),
    // 蒸馏摘要的预览上限；预览太短会迫使模型 read_tool_result 回读。
    distillPreviewChars: positiveNumber(raw.distillPreviewChars, 1200),
    // 大工具结果注入限流：超过上限时只注入“头部 + 尾部”，中间内容落盘待回读。
    // 目的：单步 prompt 增量可控，避免首个大结果把后续每一步的 prefill 和缓存未命中都放大。
    toolResultInjectCap: flag('toolResultInjectCap', true),
    ...resolveInjectBudget(raw),
    // Worker 专属尾部硬预算（字符）：共享前缀之外的部分越短，首轮命中率越高。
    workerTailChars: Math.max(600, positiveNumber(raw.workerTailChars, DEFAULT_WORKER_TAIL_CHARS)),
    // Worker 预取正文上限；同时受 workerTailChars 约束，至少给任务简报留出 2000 字符。
    workerPrefetchChars: Math.max(0, positiveNumber(raw.workerPrefetchChars, DEFAULT_WORKER_PREFETCH_CHARS)),
    workerUpstreamChars: Math.max(100, positiveNumber(raw.workerUpstreamChars, DEFAULT_WORKER_UPSTREAM_CHARS)),
    workerUpstreamTotalChars: Math.max(100, positiveNumber(raw.workerUpstreamTotalChars, DEFAULT_WORKER_UPSTREAM_TOTAL_CHARS)),
    // 压缩预检查
    minHistoryTokens: positiveNumber(raw.minHistoryTokens, 5000),
    phase1MinTokens: positiveNumber(raw.phase1MinTokens, 20000),
    phase1MinTokensShort: positiveNumber(raw.phase1MinTokensShort, 10000),
    // 0 表示沿用原阈值；设置为正数时，只有历史接近上下文窗口（溢出风险）才压缩，
    // 用于减少 trim 点上的前缀重建次数。默认关闭，避免改变现有 token 口径。
    phase1OverflowTokens: positiveNumber(raw.phase1OverflowTokens ?? env.TOKEN_OPT_PHASE1_OVERFLOW_TOKENS, 0),
    phase2MinTokens: positiveNumber(raw.phase2MinTokens, 30000),
    summaryRatio: Math.min(0.5, positiveNumber(raw.summaryRatio, 0.15)),
    // 摘要的绝对下限：小范围压缩时避免因固定字段（路径/计数）超过比例而被误杀。
    summaryFloorTokens: positiveNumber(raw.summaryFloorTokens, 1200),
    // 单次压缩的最小原始 token；低于该值时收益不足，直接跳过。
    minRangeTokens: positiveNumber(raw.minRangeTokens, 5000),
    minSavedRatio: Math.min(0.9, positiveNumber(raw.minSavedRatio, 0.3)),
    // Phase 2 触发与约束
    phase2IntervalSteps: Math.max(1, Math.floor(positiveNumber(raw.phase2IntervalSteps, 10))),
    minStepsBetweenCompactions: Math.max(1, Math.floor(positiveNumber(raw.minStepsBetweenCompactions, 5))),
    // 单价（按 token 计）；日度核算应按实际账单档位覆盖。
    prices: {
      cacheHit: positiveNumber(raw.cacheHitPrice, DEFAULT_CACHE_HIT_PRICE),
      cacheMiss: positiveNumber(raw.cacheMissPrice, DEFAULT_CACHE_MISS_PRICE)
    }
  };
}

// 按对话长度分档：短对话可以承担少量回读；中/长对话只保留“不增加轮次”的优化。
// 这里返回的是覆盖项，调用方与基础 token 策略取更保守值。
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
 * 应用对话分档策略（与工具轮数上限无关，每一档都生效）：
 * - 统一把 Phase 1 的压缩触发线设为上下文 70%：既避免历史只增不减，
 *   又不会在低占用时反复重建前缀；显式配置的 phase1OverflowTokens 优先。
 * - 中/长对话额外关闭独立压缩（phase2），避免在关键路径上反复破坏前缀缓存。
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

// 保守 token 估算：中文约 1.5-2 chars/token，代码/JSON 更低；用 2.5 减少低估。
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 2.5);
}

export function estimateMessagesChars(messages) {
  let total = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    try {
      total += JSON.stringify(message)?.length || 0;
    } catch {
      // 忽略不可序列化的消息
    }
  }
  return total;
}

export function estimateMessagesTokens(messages) {
  return Math.ceil(estimateMessagesChars(messages) / 2.5);
}
