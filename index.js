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
  DEFAULT_TOOL_RESULT_INJECT_CAP,
  DEFAULT_TOOL_RESULT_INJECT_HEAD,
  DEFAULT_TOOL_RESULT_INJECT_TAIL,
  DEFAULT_WORKER_TAIL_CHARS,
  DEFAULT_WORKER_PREFETCH_CHARS,
  DEFAULT_WORKER_UPSTREAM_CHARS,
  DEFAULT_WORKER_UPSTREAM_TOTAL_CHARS,
  resolveTokenOpt,
  resolveRoundPolicy,
  applyRoundPolicy,
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
  readStoredToolResult,
  throttleToolResultInjection,
  shapeToolResultForHistory
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
export {
  normalizeCacheUsage,
  cacheSampleFields,
  supportsPrefixCache,
  cacheStrategyFor
} from './server/cache-usage.js';

// 单轮上下文装配：预取、冷事实、产出索引与任务备忘（全部追加在稳定前缀之后）
export {
  extractExplicitPaths,
  extractExplicitSymbols,
  extractContextTargets,
  extractLineRange,
  buildWorkspaceIndex,
  fingerprintText,
  listWorkspaceEntries,
  fingerprintFile,
  createPrefetchCache,
  planPrefetch,
  renderPrefetchBlock
} from './server/context-prefetch.js';

export {
  extractColdFacts,
  isOldTurnReference,
  collectToolCallsFromMessages,
  formatColdFacts,
  buildColdFactBlock
} from './server/cold-facts.js';

export {
  summarizeArtifact,
  artifactEntry,
  recordArtifact,
  shouldReuseArtifact,
  listArtifacts,
  renderArtifactIndex
} from './server/artifact-index.js';

export {
  taskSignature,
  shouldEnableMemo,
  createTaskMemo,
  renderMemoHint
} from './server/task-memo.js';

export { buildTurnContext, resetTurnContext } from './server/turn-context.js';

// 历史窗口落盘与被挤出轮次摘要
export {
  appendEvictedSummary,
  restoreWindowHistory,
  createWindowContext
} from './server/window-context.js';

// 计划内联、上下文裁剪策略与 worker 提示词
export {
  parseInlinePlan,
  isDestructivePlan,
  shouldInlinePlan,
  resolveInlinePlan
} from './server/plan-inline.js';

export {
  FALLBACK_CONTEXT_WINDOW,
  effectiveContextWindow,
  contextRatio,
  shrinkToTokenBudget,
  shouldDistillToolResult,
  shouldTrimAtStep,
  degradeOldestToolResults,
  planTurnBoundaryDegrade
} from './server/context-policy.js';

export {
  MIN_WORKER_PROMPT_CHARS,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  buildWorkerSystemPrompt,
  buildWorkerUserPrompt,
  workerAllowedTools,
  filterWorkerTools
} from './server/worker-prompt.js';

// 前缀漂移归因与调度/编排指标
export { analyzeCacheSamples, formatPrefixDiffReport } from './server/prefix-diff.js';

export {
  calibrateDuration,
  calibrateTasks,
  validateGranularity,
  resolveWriteConflicts,
  resolveSoftDeadline,
  shouldHedge,
  shouldRedispatch,
  historyFromResults
} from './server/task-scheduler.js';

export {
  median,
  percentile,
  computeStragglerRatio,
  computeParallelEfficiency,
  summarizeWorkerCache,
  summarizeOrchestrationMetrics
} from './server/orchestration-metrics.js';

export {
  summarizeTurns,
  estimateCostCny,
  computeTokenTimeTradeoff,
  DEFAULT_BENCHMARK_PRICING,
  DEEPSEEK_OFFICIAL_PRICING,
  isDeepSeekPeakTime,
  deepSeekOfficialPricing
} from './server/benchmark-metrics.js';

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
  prewarmPtc,
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
  ptcToolNames,
  ptcReadCacheStats,
  resetPtcReadCache
} from './server/ptc/tools.js';

export {
  ptcLogDir,
  newPtcTraceId,
  appendPtcAudit,
  createPtcErrorHook,
  recordModelDebug
} from './server/ptc/trace.js';

export {
  MAX_PTC_VALIDATION_NUDGES,
  MAX_PTC_VALIDATION_FAILURES,
  isPtcValidationFailure,
  ptcValidationAction,
  ptcFallbackAction,
  PTC_FALLBACK_NUDGE,
  ptcValidationHint,
  ptcValidationNudge,
  ptcValidationFinal
} from './server/ptc/validation.js';

export {
  PTC_BUDGET_DECISION_TIMEOUT_MS,
  PTC_BUDGET_OPTIONS,
  PTC_CONTINUE_NUDGE,
  PTC_NATIVE_NUDGE,
  classifyPtcBudgetAnswer,
  askPtcBudgetDecision
} from './server/ptc/budget-decision.js';

export {
  compareNativeVsPtc,
  savingsRows
} from './server/ptc/metrics.js';

// 并发写锁、命令作用域与验证调度
export {
  LOCK_CODES,
  LockError,
  fileKey,
  dirKey,
  wsKey,
  parseKey,
  pathsRelated,
  keysRelated,
  keysConflict,
  VersionStore,
  ResourceLocks,
  createResourceLocks
} from './server/resource-locks.js';

export {
  tokenizeCommand,
  resolveCommandScope,
  planToolLocks
} from './server/command-scope.js';

export {
  VerifyScheduler,
  createVerifyScheduler
} from './server/verify-scheduler.js';
