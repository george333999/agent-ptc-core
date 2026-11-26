// Public API of Local-first Agent Workbench Core.
// Aggregate exports only, no runtime logic; all implementations live under server/.
//
// Minimal integration order:
// 1. Before a request: resolveLaggingWindow for the history window, buildRequestFingerprint to record the prefix hash.
// 2. After a tool returns: distillToolResult decides whether to persist; use readStoredToolResult when the model needs details.
// 3. For batch read-only operations: register ptc_run with buildPtcToolDefinition, execute sandboxed programs with runPtcTool.
// 4. After each model usage response: normalizeCacheUsage to normalize fields, recordCacheSample to log hits.

// History window and cache trimming
export {
  DEFAULT_HISTORY_LIMITS,
  resolveHistoryLimits,
  historyLimitsForContext,
  historyChars,
  overHistoryLimits,
  shouldTrimHistory,
  resolveLaggingWindow,
  applyHistoryWindow
} from './server/history-window.js';

// Stable serialization, prefix hash and common prefix ratio
export {
  stableStringify,
  hashText,
  buildCachePrefix,
  buildRequestFingerprint,
  commonPrefixChars,
  commonPrefixRatio
} from './server/prefix.js';

// Token optimization switches, budgets and conservative estimates
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

// Task contract, deliverable contract and turn budget
export {
  SOCRATIC_QUESTIONS,
  CONTRACT_LIST_MAX,
  CONTRACT_ITEM_MAX,
  shouldUseSocraticBrief,
  buildSocraticBrief,
  normalizeContract,
  deriveDefinitionOfDone,
  contractForOrchestration,
  renderDefinitionOfDone,
  renderAssumptions
} from './server/task-contract.js';

export {
  requiredDeliverableKinds,
  requiresWorkspaceDeliverable,
  extractDeliverablePath,
  deliverableExtensions
} from './server/deliverable.js';

export {
  MAX_TOOL_STEPS,
  DEFAULT_MAX_STEPS,
  normalizeMaxSteps,
  resolveMaxSteps,
  resolveStepBudget
} from './server/limits.js';

// Tool result distillation, redaction, persistence and read-back
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

// Stable task-type classification
export {
  CATEGORY_VERSION,
  TOOL_CATEGORY,
  toolCategory,
  attachmentKindFromFiles,
  pendingTaskType,
  createTaskTypeTracker
} from './server/task-type.js';

// Stable ordering of tool definitions
export {
  compareToolDefinitions,
  sortToolDefinitions
} from './server/tool-order.js';

// Cache hit log and multi-provider field normalization
export { cacheMetricsDir, recordCacheSample } from './server/cache-metrics.js';
export {
  normalizeCacheUsage,
  cacheSampleFields,
  supportsPrefixCache,
  cacheStrategyFor
} from './server/cache-usage.js';

// LLM request governance: adaptive concurrency, 429 backoff and circuit breaking
export {
  LlmGovernor,
  getLlmGovernor,
  setLlmGovernor,
  sleep,
  sleepWithSignal,
  parseRetryAfterMs,
  computeRetryDelay,
  fetchWithRetry
} from './server/llm-governor.js';

// Single-turn context assembly: prefetch, cold facts, artifact index and task memo (all appended after the stable prefix)
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

export { buildTurnContext, resetTurnContext, resolveTurnContextBudget } from './server/turn-context.js';

// History window persistence and summaries of evicted turns
export {
  appendEvictedSummary,
  restoreWindowHistory,
  createWindowContext
} from './server/window-context.js';

// Plan inlining, context trimming policy and worker prompts
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

// Context overflow fallback: detect provider 400 and compress the request view before retrying
export {
  isContextLengthError,
  contextLimitFromError,
  contextLengthMessage,
  planContextOverflow
} from './server/context-guard.js';

export {
  MIN_WORKER_PROMPT_CHARS,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  buildWorkerSystemPrompt,
  buildWorkerUserPrompt,
  workerAllowedTools,
  filterWorkerTools
} from './server/worker-prompt.js';

// Parallel batches of read-only tools and path-dependency-based concurrency scheduling
export {
  PARALLEL_SAFE_TOOLS,
  isParallelSafeTool,
  planToolBatches,
  runToolBatch
} from './server/parallel-tools.js';

export {
  MAX_CONCURRENT_TOOLS,
  toolConcurrencyEnabled,
  classifyToolCall,
  createToolScheduler
} from './server/tool-scheduler.js';

// Output directory isolation: Chat uses outputs/chat/, Agent uses outputs/
export {
  outputRelFor,
  resolveOutputPath,
  resolveWorkspacePath
} from './server/output-paths.js';

// Prefix drift attribution and scheduling/orchestration metrics
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

// Economics gate and result report for parallel orchestration
export {
  DEFAULT_TASK_SECONDS,
  DEFAULT_ORCHESTRATION_OVERHEAD_MS,
  MIN_BREAKEVEN_SPEEDUP,
  MAX_TOKEN_OVERHEAD_RATIO,
  estimateOrchestrationEconomics,
  evaluateEconomicsGate,
  buildOrchestrationSkipResult
} from './server/orchestration-economics.js';

export { formatOrchestrationReport } from './server/orchestration-report.js';

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

// Single-turn latency breakdown: model, tools, persistence, approval wait and PTC coverage
export { createTurnMetrics } from './server/latency-metrics.js';

// History fact compaction and net benefit calculation
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

// Workspace path constraints
export {
  realpathOrResolve,
  workspaceRoot,
  resolveWithinWorkspace,
  isWithinWorkspace,
  invalidatePathCache,
  pathCacheStats
} from './server/paths.js';

// Vector search configuration and requests
export {
  embeddingConfigFor,
  embedTexts,
  embedQuery,
  probeEmbedding
} from './server/embeddings.js';

// PTC programmatic tool calling
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

// Concurrent write locks, command scope and verification scheduling
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

// Lightweight per-key mutex: same resource serialized, different resources in parallel
export { KeyedMutex } from './server/locks.js';

export {
  tokenizeCommand,
  resolveCommandScope,
  planToolLocks
} from './server/command-scope.js';

export {
  VerifyScheduler,
  createVerifyScheduler
} from './server/verify-scheduler.js';
