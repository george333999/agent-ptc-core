# Integration Guide

This repository is not a web app you can talk to directly; it is a set of kernel modules that can be embedded into an existing agent loop. The minimal integration order is given below; for complete runnable versions see `examples/minimal-agent.mjs` and `examples/ptc-batch.mjs`.

If you care about "when compaction happens, which checks stop errors, which gates reject unprofitable operations", read [compaction.md](compaction.md) and [guards-and-gates.md](guards-and-gates.md) first; this document covers integration order only.

## 1. Before the request: resolve the history window and record the prefix

```js
import {
  historyLimitsForContext,
  resolveLaggingWindow,
  buildRequestFingerprint,
  commonPrefixRatio
} from 'cache-stable-agent-core';

// Recommended for long sessions: derive the budget from the model window (hard limit 97%, soft limit = 50% of the hard limit).
// For legacy behavior, pass { softMessages: 48, hardMessages: 64, softChars: 60000, hardChars: 150000 } explicitly.
const limits = historyLimitsForContext(model.contextWindow || 128000);

let lastTrimLength = session.historyWindowLength || 0;
const { window, trimmed, windowLength } = resolveLaggingWindow(
  allHistory,
  lastTrimLength,
  limits,
  { lastTrimChars: session.historyWindowChars }
);
if (trimmed) {
  session.historyWindowLength = windowLength;
}

const fingerprint = buildRequestFingerprint({ system, tools, messages: window });
// Write fingerprint.hash to the log; next turn, use commonPrefixRatio to check whether the prefix changed.
```

Key points:

- `system` and `tools` must be byte-stable. Object key order is handled by `stableStringify`, tool definitions by `sortToolDefinitions`.
- Do not insert timestamps, progress, or temporary summaries into the middle of the history. All volatile information is appended to the message tail only.
- Update the window length only when `trimmed` is true, so a sliding window is not triggered on every turn.

## 2. Task contract and deliverables

For complex tasks, the main agent runs one fixed self-check first. The self-check block is appended to the tail of the current user message only; `system` and `tools` are not modified:

```js
import { buildSocraticBrief, shouldUseSocraticBrief } from 'cache-stable-agent-core';

if (shouldUseSocraticBrief({ mode: 'agent', complexTask })) {
  messages[messages.length - 1].content += `\n\n${buildSocraticBrief()}`;
}
```

The completion criteria and key assumptions produced by the self-check are normalized with `normalizeContract` and sent with the task brief when dispatching sub-agents:

```js
import {
  normalizeContract,
  renderDefinitionOfDone,
  renderAssumptions
} from 'cache-stable-agent-core';

const contract = normalizeContract(planInput);
const doneSection = renderDefinitionOfDone(contract.definitionOfDone);
const assumptionSection = renderAssumptions(contract.assumptions);
```

Boundaries:

- The self-check belongs to the main agent only. Sub-agents lack the full conversation, and repeating the questions would fragment assumptions; when completion criteria are missing, accept against `expectedOutput`, mark `partial`, and write to `open_questions`.
- The self-check block must stay byte-stable and contain no time, task ID, or random numbers.

The deliverable contract is used for acceptance, not as a substitute for execution:

```js
import {
  requiredDeliverableKinds,
  requiresWorkspaceDeliverable,
  deliverableExtensions
} from 'cache-stable-agent-core';

const kinds = requiredDeliverableKinds(userMessage); // e.g. ['xlsx']
const extensions = deliverableExtensions(kinds);     // ['.xlsx']
const needsFile = requiresWorkspaceDeliverable(userMessage);
```

After a tool writes successfully to disk, mark completion by extension. If the user asked for an Excel file but only a script was written, keep reminding or keep executing; the script must not be treated as the deliverable. The check looks only at the target fragment after the action word, so an input file is not mistaken for the target artifact.

## 3. After a tool returns: decide whether to distill

```js
import { distillToolResult, readStoredToolResult, resolveTokenOpt } from 'cache-stable-agent-core';

const tokenOpt = resolveTokenOpt(settings, { contextWindow: model.contextWindow });
const distilled = distillToolResult({
  dataDir,
  sessionId: session.id,
  callId: toolCall.id,
  toolName: toolCall.name,
  output: fullOutput,
  budgets: tokenOpt.toolBudgets,
  enabled: tokenOpt.toolResultDistill,
  minChars: tokenOpt.distillMinChars,
  previewChars: tokenOpt.distillPreviewChars
});

// distilled.content is what goes into the model history; the UI still shows fullOutput.
history.push({ role: 'tool', content: distilled.content });

// When the model asks for details:
const slice = readStoredToolResult({
  dataDir,
  resultId: distilled.ref.resultId,
  startLine: 1,
  endLine: 200
});
```

Notes:

- If persisting fails, `distilled` is false and `content` falls back to the full content; the main flow is unaffected.
- The summary redacts common secret formats, but do not hand secrets in unknown formats to an untrusted model.
- Read-back adds one model round trip. Do not distill short results; the benefit is clearer for tasks longer than 20 turns and limited within 10 turns.

## 4. Batch read-only operations: use PTC

```js
import { buildPtcToolDefinition, runPtcTool, shutdownPtc } from 'cache-stable-agent-core';

const toolDefinition = buildPtcToolDefinition();
// Register toolDefinition in the model's tools list and sort it together with the other tools.

const result = await runPtcTool(
  {
    code: `
      const found = await files.search({ query: 'TODO', path: 'src', target: 'content' });
      return { count: found.count, matches: found.matches.slice(0, 20) };
    `
  },
  {
    workspace,
    session: { id: session.id },
    runId,
    settings: { ptcAudit: true, ptcTimeoutMs: 8000 }
  }
);

await shutdownPtc();
```

PTC exposes read-only tools only. Writing files, editing, running commands, MCP, and sub-agents still go through direct tools, keeping side-effecting operations out of the sandbox.

For file-heavy work, page with `files.list` or narrow the range with `files.search` first, then call `files.readMany` with at most 50 paths. A single `ptc_run` result is capped at 24000 characters; do counting, deduplication, and field projection inside the program instead of returning multiple full texts.

## 5. After each model response: record a cache sample

```js
import { normalizeCacheUsage, recordCacheSample, cacheMetricsDir } from 'cache-stable-agent-core';

const usage = normalizeCacheUsage(response.usage);
await recordCacheSample(cacheMetricsDir(dataDir), {
  sessionId: session.id,
  runId,
  workerId,
  model: response.model,
  ...usage
});
```

Logs are written to JSONL per day and record only token counts, prefix hashes, and task identifiers, never prompt text. `normalizeCacheUsage` returns `cache_reported`: false when the provider reports no cache fields, in which case the hit rate should be shown as unknown rather than 0%.

## 6. Single-turn context: prefetch, cold facts, artifact index, and memos

```js
import { buildTurnContext } from 'cache-stable-agent-core';

const turn = buildTurnContext({
  session,
  message: userMessage,
  settings,
  workspace,
  baseModelContent: userMessage,
  knowledgeContext
});
// turn.modelContent is sent to the model as this turn's user message.
// All injected blocks are appended after the stable prefix and do not change system or tools.
```

- Prefetch file contents only when the message contains an explicit path, line range, or symbol; otherwise provide only the workspace index.
- The prefetch cache hangs off the session object and short-circuits on mtime/size/hash when a file is unchanged.
- Cold facts are injected only when the user refers to an earlier turn, so confirmed information is not lost after window trimming.
- The first 3 user turns automatically use the short-session budget (120 index entries, 4000 prefetch characters, 400 tokens for facts/artifacts); pass `maxPrefetchChars` explicitly to force a fixed larger budget.
- With `settings.contextEngine === false`, it degrades to the traditional full-history mode, used as a benchmark control.

See [mechanisms.md](mechanisms.md) for the complete mechanism.

## 7. Multi-agent scheduling and economics

```js
import {
  calibrateTasks,
  validateGranularity,
  resolveWriteConflicts,
  resolveSoftDeadline,
  estimateOrchestrationEconomics,
  evaluateEconomicsGate
} from 'cache-stable-agent-core';

const { tasks } = calibrateTasks(plan.tasks, { historyMs });
const granularity = validateGranularity(tasks);
const { tasks: ordered } = resolveWriteConflicts(tasks);
const softDeadlineMs = resolveSoftDeadline({ historyMs });
```

These functions are pure and do not start workers themselves. The scheduling loop uses their return values to decide how many tasks to split into, who depends on whom, and when to declare a long tail. `shouldHedge` and `shouldRedispatch` apply only to retryable results without writes, preventing duplicate writes.

Before parallelizing, also decide whether parallelism is actually worth it:

```js
const economics = estimateOrchestrationEconomics({
  taskCount: ordered.length,
  criticalPathTasks: granularity.criticalPathTasks,
  taskSeconds: 25,
  parentContextTokens: 60000,
  prefixTokens: 18000,
  tailTokens: 6000
});
const gate = evaluateEconomicsGate({ economics, mode: 'advisory' });
```

With `mode: 'enforce'`, an unprofitable plan returns `allowed: false` and the caller should switch to serial execution; the default `advisory` only warns, so long-tail tasks are not wrongly killed. `buildOrchestrationSkipResult` returns a structure consistent with normal orchestration, letting the main agent switch to serial directly. After execution, use `formatOrchestrationReport` to generate a readable report covering sub-task conclusions, conflicts, and resource usage.

## 8. Concurrent writes: lock, execute, verify

Reads may run concurrently; writes must be mutually exclusive. Run verification after a batch of writes completes, so verification does not read half-written files.

```js
import path from 'node:path';
import {
  createResourceLocks,
  planToolLocks,
  createVerifyScheduler
} from 'cache-stable-agent-core';

const locks = createResourceLocks();
const verify = createVerifyScheduler({ versions: locks.versions });
const helpers = {
  workspace,
  resolveInput: (rel) => path.join(workspace, rel),
  resolveOutput: (rel) => path.join(workspace, rel)
};

const plan = planToolLocks('write_file', { path: 'src/calc.js' }, helpers);
const lease = await locks.acquire(
  { reads: plan.reads, writes: plan.writes },
  { signal, timeoutMs: 30000 }
);
try {
  await writeFile(path.join(workspace, 'src/calc.js'), next);
  // After a successful write, bump the version so verification scheduling can detect stale inputs
  locks.versions.bumpKeys(plan.writes);
} finally {
  lease.release();
}

const verifyPlan = planToolLocks('run_command', {
  command: 'node --test tests/calc.test.js'
}, helpers);
const result = await verify.run({
  key: verifyPlan.verify.key,
  workspace,
  inputFiles: verifyPlan.verify.inputFiles,
  outputFiles: verifyPlan.verify.outputFiles,
  cacheable: verifyPlan.verify.cacheable,
  execute: () => runCommand('node --test tests/calc.test.js')
});
```

Three rules:

- `planToolLocks` covers read, list, search, write, edit, delete, and command tools; `ptc_run` is a read-only sandbox and needs no lock.
- When `scope` is passed explicitly, the input set is considered complete and the verification result can be cached; a scope inferred from `node --test`, `pytest`, `go test ./pkg/...`, or `tsc -p` is not cached, because it may miss imported source files.
- If input versions change during verification, the scheduler marks the result as stale and re-runs it, up to `maxRuns`; different scopes can run in parallel.

See [concurrency.md](concurrency.md) for detailed semantics and tests.

## 9. Same-turn concurrent tool scheduling

A single turn may return multiple tool calls. `createToolScheduler` splits them by path dependency into concurrently runnable and barrier groups:

```js
import { createToolScheduler } from 'cache-stable-agent-core';

const scheduler = createToolScheduler({
  calls,
  ctx: { workspace, mode, outputRel },
  execute: (call, args) => executeTool(call.name, args, ctx),
  isBlocked: (call) => needsApproval(call)
});

for (const call of calls) {
  const early = scheduler.claim(call.id);
  if (early) {
    handle(await early);
    continue;
  }
  await scheduler.drain(call.id);
  const args = JSON.parse(call.arguments || '{}');
  handle({ call, ok: true, value: await executeTool(call.name, args, ctx) });
}
```

Rules:

- Writes to different paths may run concurrently; writes to the same path run serially in their original order.
- A read of the same file after a write must wait for the write to finish; directory scans and child-file writes are ordered by ancestor relationships.
- A `run_command` with an explicit or inferable scope is a verify node; unknown commands and calls needing approval are barriers.
- Multi-version writes to the same script, such as `_v43.py`, are forced through the barrier so speculative execution cannot bypass the version-explosion guard.
- The default concurrency limit is 4; `AGENT_TOOL_CONCURRENCY=0` falls back to consecutive read-only concurrency only.

The scheduler decides order only; mutual exclusion is still enforced by resource locks. Only the combination is both fast and free of mutual overwrites.

## 10. Context overflow and rate limiting

When a provider returns a 400 such as `maximum context length`, do not surface the raw error to the user:

```js
import { planContextOverflow } from 'cache-stable-agent-core';

try {
  return await request(messages);
} catch (error) {
  const plan = planContextOverflow({
    contextWindow,
    messages,
    errorMessage: error.message,
    retriesUsed
  });
  if (plan.handled && plan.retry) return request(plan.messages);
  if (plan.handled) throw new Error(plan.error);
  throw error;
}
```

`planContextOverflow` parses the real limit from the error text, compacts the request view toward a 70% target, and returns a readable error once retries are exhausted. When there is nothing to compact it fails immediately, avoiding idle retries.

The request-establishment phase can be delegated to `fetchWithRetry`: adaptive concurrency, 429 jitter backoff, and long `Retry-After` circuit breaking are all handled here.

```js
import { fetchWithRetry } from 'cache-stable-agent-core';

const response = await fetchWithRetry(url, init, { signal, retries: 2 });
```

It wraps only "establish request + read response headers"; once SSE starts it no longer retries, avoiding duplicate billing or duplicate output.

## 11. Latency attribution

```js
import { createTurnMetrics } from 'cache-stable-agent-core';

const latency = createTurnMetrics();
latency.startLlm();
// ...when the first delta arrives
latency.markFirstToken();
latency.endLlm();
latency.addToolMs(toolMs);
latency.addSaveMs(saveMs);
latency.addApprovalWaitMs(waitMs);
latency.addUsage(normalizedUsage);
const snapshot = latency.snapshot();
```

`snapshot()` returns `durationMs` (excluding user thinking/approval wait), `wallMs`, `llmTtftMs`, `llmDecodeMs`, `toolMs`, `saveMs`, `overheadMs`, PTC coverage, duplicate-read rate, per-phase attribution, and cache reporting status. It only observes; it does not change execution logic.

## 12. Provider field compatibility

`normalizeCacheUsage` already covers:

- OpenAI-compatible: `prompt_tokens_details.cached_tokens`
- DeepSeek: `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
- Anthropic: `cache_read_input_tokens` / `cache_creation_input_tokens`

If a provider returns no cache fields, do not treat a locally inferred miss as a 0% hit rate; mark it as unreported and display unknown.

## 13. Common mistakes

- Trimming with a sliding window on every turn: the prefix changes at every step and the cache hit rate swings wildly. Use lagging trim instead.
- Concatenating a timestamp into the system prompt: every request begins with different bytes and the cache is invalidated outright.
- Serializing tool schemas without ordering: the same set of tools comes out in a different order through different construction paths, changing the prefix hash.
- Replacing historical `write_file` arguments with placeholders: the model imitates the placeholders in later turns and pollutes real artifacts. Tool-argument history must be preserved verbatim.
- Forcing distillation on short tool results: one extra read-back round trip raises latency instead.

## 14. Verification

```bash
npm test
npm run example:minimal
npm run example:context
npm run example:ptc
npm run benchmark:report
node --test test/resource-locks.test.js test/command-scope.test.js test/verify-scheduler.test.js test/tool-scheduler.test.js test/locks.test.js
node --test test/task-contract.test.js test/deliverable.test.js test/context-guard.test.js test/llm-governor.test.js test/latency-metrics.test.js
```

Benchmark data lives in `benchmark/data/`; legacy data is archived in `benchmark/data/legacy-2026-11-22/` and `legacy-2026-11-23/`. Reports read top-level files only and are generated into `benchmark/output/`. The latest same-window ABBA batch covers 10/20/50/70/100 turns, with 2 runs per variant per group; each variant ran 500 turns, 1000 turns in total. The optimized version used 69.8% fewer tokens, 14.8% less time, and 37.2% lower same-tier cost, with accuracy of 99.8% versus 97.8%. The previous cross-period 500-turn data is kept for historical comparison (56.5% fewer tokens, 21.3% less time, 8.3% lower cost). In the report, the traditional version uses native function calling, full history, and single-loop ReAct, with prefetch, cold facts, artifact index, turn policy, plan inlining, task memos, distillation, and compaction disabled; the optimized version enables PTC, the single-turn context engine, and a history budget derived from the model window. This is the complete comparison of PTC and context optimization against a traditional agent framework.
