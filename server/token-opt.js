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
export const DEFAULT_TOOL_RESULT_BUDGETS = Object.freeze({
  read_file: 12000,
  search_files: 8000,
  list_files: 6000,
  ptc_run: 12000,
  run_command: 8000,
  knowledge_search: 6000,
  fetch_url: 8000,
  web_search: 6000,
  extract_text: 6000,
  pdf_to_xlsx: 4000,
  read_tool_result: TOOL_RESULT_READ_LIMIT,
  default: 10000
});

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function booleanFlag(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value !== '0' && value.toLowerCase() !== 'false';
  return Boolean(value);
}

export function resolveTokenOpt(settings = {}) {
  const raw = settings?.tokenOpt && typeof settings.tokenOpt === 'object' ? settings.tokenOpt : {};
  const env = process.env;
  const flag = (name, fallback) => {
    const envValue = env[`TOKEN_OPT_${name.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase()}`];
    if (envValue !== undefined && envValue !== '') return booleanFlag(envValue, fallback);
    return booleanFlag(raw[name], fallback);
  };
  const budgets = { ...DEFAULT_TOOL_RESULT_BUDGETS };
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
    toolResultDistill: flag('toolResultDistill', true),
    toolResultBudgets: flag('toolResultBudgets', true),
    toolBudgets: budgets,
    // 压缩预检查
    minHistoryTokens: positiveNumber(raw.minHistoryTokens, 5000),
    phase1MinTokens: positiveNumber(raw.phase1MinTokens, 20000),
    phase1MinTokensShort: positiveNumber(raw.phase1MinTokensShort, 10000),
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
