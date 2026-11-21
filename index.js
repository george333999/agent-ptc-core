// Local-first Agent Workbench Core 的公共 API。
// 这里只做聚合导出，不包含任何运行逻辑；所有实现都在 server/ 下。
//
// 最小接入顺序：
// 1. 请求前：resolveLaggingWindow 取历史窗口，buildRequestFingerprint 记录前缀哈希。
// 2. 工具返回后：distillToolResult 决定是否落盘，模型需要细节时用 readStoredToolResult。
// 3. 需要批量只读操作时：buildPtcToolDefinition 注册 ptc_run，runPtcTool 执行沙盒程序。
// 4. 每次模型返回 usage 后：normalizeCacheUsage 归一化字段，recordCacheSample 记录命中日志。

// 历史窗口与缓裁剪
export {
  DEFAULT_HISTORY_LIMITS,
  resolveHistoryLimits,
  historyChars,
  overHistoryLimits,
  shouldTrimHistory,
  resolveLaggingWindow,
  applyHistoryWindow
} from './server/history-window.js';

// 稳定序列化、前缀哈希与公共前缀比例
export {
  stableStringify,
  hashText,
  buildCachePrefix,
  buildRequestFingerprint,
  commonPrefixChars,
  commonPrefixRatio
} from './server/prefix.js';

// Token 优化开关、预算与保守估算
export {
  TOKEN_OPT_SCHEMA_VERSION,
  DEFAULT_CACHE_HIT_PRICE,
  DEFAULT_CACHE_MISS_PRICE,
  TOOL_RESULT_READ_LIMIT,
  DEFAULT_TOOL_RESULT_BUDGETS,
  resolveTokenOpt,
  estimateTokens,
  estimateMessagesChars,
  estimateMessagesTokens
} from './server/token-opt.js';

// 工具结果蒸馏、脱敏、落盘与回读
export {
  redactResultText,
  toolResultsDir,
  buildDistillSummary,
  distillToolResult,
  summarizeToolArguments,
  readStoredToolResult
} from './server/tool-result.js';

// 任务类型稳定归类
export {
  CATEGORY_VERSION,
  TOOL_CATEGORY,
  toolCategory,
  attachmentKindFromFiles,
  pendingTaskType,
  createTaskTypeTracker
} from './server/task-type.js';

// 工具定义稳定排序
export {
  compareToolDefinitions,
  sortToolDefinitions
} from './server/tool-order.js';

// 缓存命中日志与多供应商字段归一化
export { cacheMetricsDir, recordCacheSample } from './server/cache-metrics.js';
export { normalizeCacheUsage, cacheSampleFields } from './server/cache-usage.js';

// 历史事实压缩与净收益计算
export {
  hashText as hashFactText,
  sanitizeFactText,
  selectCompactionRange,
  buildFactSummary,
  createCompactionState,
  validateCompaction,
  applyCompaction,
  splitSavedTokens,
  computeNetBenefit,
  estimateRemainingSteps,
  compactionCandidateId,
  planPiggybackCompaction,
  planStandaloneCompaction,
  compactionEventWithId
} from './server/history-compact.js';

// 工作区路径约束
export {
  realpathOrResolve,
  workspaceRoot,
  resolveWithinWorkspace,
  isWithinWorkspace
} from './server/paths.js';

// 向量检索配置与请求
export {
  embeddingConfigFor,
  embedTexts,
  embedQuery,
  probeEmbedding
} from './server/embeddings.js';

// PTC 程序化工具调用
export {
  PTC_PROGRAMMATIC_TOOLS,
  PtcEngine,
  validatePtcCode,
  getPtcEngine,
  setPtcEngine,
  shutdownPtc,
  disposePtcRun,
  disposePtcScope,
  buildPtcToolDefinition,
  runPtcTool
} from './server/ptc/index.js';

export {
  PTC_CODE_MAX_CHARS,
  PTC_MAX_NODES,
  PTC_MAX_DEPTH,
  PTC_MAX_LINES,
  PTC_MAX_CALLS,
  PTC_MAX_LOOPS,
  PTC_MAX_SITE_CALLS,
  PTC_MAX_ERRORS,
  parsePtcSource
} from './server/ptc/ast-validator.js';

export {
  PTC_TOOL_SPECS,
  PTC_TOOL_NAMES,
  PTC_NAMESPACE_METHODS,
  PTC_RESERVED_BINDINGS
} from './server/ptc/specs.js';

export {
  PtcToolError,
  normalizePtcArgs,
  executePtcTool,
  ptcToolNames
} from './server/ptc/tools.js';

export {
  ptcLogDir,
  newPtcTraceId,
  appendPtcAudit,
  createPtcErrorHook,
  recordModelDebug
} from './server/ptc/trace.js';

export {
  compareNativeVsPtc,
  savingsRows
} from './server/ptc/metrics.js';
