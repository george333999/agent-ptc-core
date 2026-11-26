# Cache-stable Agent Core

**English** | [简体中文](https://gitee.com/george333999/local-first-agent-workbench)

> The open-source core of AgentProject: PTC batch read-only tools and a single-turn context engine reduce model round-trips; a history budget derived from the model window and prefix-cache engineering keep long-conversation hit rates above 90%; in-process write locks and verification scheduling keep concurrent modifications consistent; and main-agent self-checks, deliverable contracts, and same-turn tool scheduling ensure results actually land on disk as the user asked. In the latest five-group, 1000-turn same-window ABBA benchmark, tokens are 69.8% lower, wall-clock time 14.8% lower, and cost 37.2% lower, with 99.8% accuracy versus 97.8%; about 90% of wall-clock time is still model-side, so further optimization mainly comes from reducing model steps.

This repository is the extracted core of AgentProject and keeps a set of independently reusable capabilities: long-conversation cache stability, model-window-derived history budgets, dynamic compaction, a single-turn context engine, tool-result distillation and read-back, PTC Programmatic Tool Calling for read-only tools, sub-task scheduling and the orchestration-economics gate, concurrent write locks and verification scheduling, same-turn concurrent tool scheduling, task-contract/deliverable/context guards, and context-overflow and rate-limiting governance. It also includes single-turn latency attribution and reproducible grouped benchmark reports. The full workbench's web editor, multi-agent runtime, MCP, OCR, and document processing are not included in this repository.

**Mechanism overview**: for the problem each mechanism solves, why it is used, its measured effect, where it takes effect, and how it interacts with other mechanisms and what it costs, see [docs/mechanisms.md](docs/mechanisms.md). The "Performance boundary" and "Cost accounting basis" sections explain why time is already close to the model-side lower bound and why cost is estimated using DeepSeek pricing.

## Documentation map

Dynamic compaction, guards, and gates are not scattered fragments in the README; each has its own document, code location, and test index:

| Document | Questions it answers | Keywords |
| --- | --- | --- |
| [docs/mechanisms.md](docs/mechanisms.md) | Why each module exists, its measured effect, cost, and interactions | mechanism overview, performance boundary, cost accounting basis |
| [docs/compaction.md](docs/compaction.md) | When to compact and when not to, plus the risks of follow-up improvements | dynamic compaction, 70% watermark, `finalPhase`, `projectedNoOverflow`, improvement risks |
| [docs/guards-and-gates.md](docs/guards-and-gates.md) | What prevents errors and what prevents unprofitable operations | task contract, deliverable guard, context guard, plan gate, economics gate, write guard |
| [docs/plan-gate.md](docs/plan-gate.md) | The plan gate's decision chain, timing, and measured results | complexity ≥5, first-step tool trimming, explicit artifact path bypass |
| [docs/plan-prompt-ab.md](docs/plan-prompt-ab.md) | Cost A/B of the plan prompt and plan gate | todo prompt, long/xlong cost |
| [docs/ptc.md](docs/ptc.md) | PTC sandbox, budget, recovery, and short-session fixed overhead | read-only sandbox, 100-call budget, short-turn cost |
| [docs/concurrency.md](docs/concurrency.md) | How locks, command scope, and verification scheduling work together | reader-writer lock, writer priority, stale-verification re-run |
| [docs/cache-stability.md](docs/cache-stability.md) | Why the prefix cache is fragile and how to fix it | hit rate, schema ordering, lagging trim |
| [docs/integration.md](docs/integration.md) | How to integrate these modules in order | integration steps, common mistakes, verification method |
| [docs/release-gitee.md](docs/release-gitee.md) | How to release and maintain the repository | Gitee, version tags, what not to commit |

## Why this exists

Common agent frameworks do well on short tasks, but as conversations grow they expose three problems at once:

1. The full history is resent every turn, so token cost grows linearly with the number of turns.
2. A sliding-window trim runs on every step, so the request prefix keeps changing and the cache hit rate swings wildly.
3. Tool results are fed back verbatim, the context is flooded with file content, and the model still needs several extra turns to get the part it needs.

This core targets exactly these three problems. It does not depend on a specific model vendor and does not require uploading the project to the cloud: state, logs, and tool results all stay local.

## Core code

All core logic lives in `server/`, with no hidden runtime services. You can read it, replace it, and embed it directly into your own agent loop.

| Module | Purpose |
| --- | --- |
| `server/history-window.js` | Lagging trim, soft and hard caps, user-message alignment, model-window-derived budgets, and an append-only prefix between two trims |
| `server/prefix.js` | Stable serialization, prefix hashing, full request fingerprint, common-prefix ratio |
| `server/tool-result.js` | Tool-result distillation, secret redaction, persistence to disk, read-back by line or JSON Path |
| `server/token-opt.js` | Optimization switches, tool-result budget, unit prices, and conservative token estimation |
| `server/task-contract.js` | Main-agent five-question self-check, completion criteria and key assumptions, sub-agent contract section |
| `server/deliverable.js` | Deliverable type detection, output-path extraction, and extension toggles |
| `server/limits.js` | Tool-turn cap, progress reminders, and finalization budget |
| `server/history-compact.js` | History fact compaction, compaction range selection, net-benefit calculation |
| `server/task-type.js` | Stable classification of task types and tool categories |
| `server/tool-order.js` | Stable byte-order sorting of tool definitions by name |
| `server/cache-usage.js` | Normalization of OpenAI, DeepSeek, and Anthropic cache fields and vendor cache-capability detection |
| `server/cache-metrics.js` | Appends daily cache-hit logs; failures do not affect the main flow |
| `server/context-prefetch.js` | Single-turn prefetch: read files only for explicit paths or symbols; otherwise provide only a path index |
| `server/cold-facts.js` | Cold-fact extraction: restore key facts when earlier turns are referenced |
| `server/artifact-index.js` | Artifact index, summaries, and reuse decisions |
| `server/task-memo.js` | Memoization for repeated requests of the same task and reuse-rate decisions |
| `server/turn-context.js` | Unified single-turn context assembly; everything is appended only to the end of the user message |
| `server/window-context.js` | Deterministic summaries of evicted turns and window recovery |
| `server/context-policy.js` | Distillation, trim, and degradation policy decisions |
| `server/context-guard.js` | Vendor context-overflow detection, window tightening, and compaction retry |
| `server/parallel-tools.js` | Parallel batches of read-only tools and isolation of single-call failures |
| `server/tool-scheduler.js` | Same-turn tool scheduling by path dependency and scheduling barrier |
| `server/output-paths.js` | Chat/Agent output-directory isolation and workspace path resolution |
| `server/plan-inline.js` | Plan inlining and destructive-plan detection |
| `server/worker-prompt.js` | Sub-agent prompt, tool allowlist, and result return format |
| `server/prefix-diff.js` | Cache-hit sequence attribution to locate the turn where the prefix drifted |
| `server/task-scheduler.js` | Sub-task duration calibration, granularity checks, write-set mutual exclusion, soft deadlines, and hedging |
| `server/orchestration-economics.js` | Parallel benefit threshold: speedup, token overhead, and serial fallback result |
| `server/orchestration-report.js` | Readable report of orchestration results, conflicts, and resource usage |
| `server/orchestration-metrics.js` | Orchestration metrics: median, percentiles, tail ratio, parallel efficiency, and worker cache summary |
| `server/llm-governor.js` | Adaptive concurrency, 429 jitter backoff, and circuit breaking |
| `server/latency-metrics.js` | Single-turn latency breakdown, PTC coverage, and repeated-read rate |
| `server/locks.js` | Lightweight key-based mutual exclusion |
| `server/resource-locks.js` | File and directory reader-writer locks, version registration, conflict detection, timeouts, and cancellation |
| `server/command-scope.js` | Command-scope resolution, explicit scope validation, tool lock planning |
| `server/verify-scheduler.js` | Verification deduplication, input version checks, stale-verification re-runs, and per-workspace concurrency control |
| `server/benchmark-metrics.js` | Benchmark aggregation, cost estimation, and the token/time trade-off |
| `server/paths.js` | Workspace path constraints and out-of-bounds validation |
| `server/embeddings.js` | Vector search configuration and requests |
| `server/ptc/` | PTC syntax validation, worker sandbox, typed read-only tools, budget decisions, validation recovery, and audit trail |
| `index.js` | Aggregated public API exports |

## Public API

```js
import {
  resolveLaggingWindow,
  historyLimitsForContext,
  buildRequestFingerprint,
  buildTurnContext,
  resolveTurnContextBudget,
  distillToolResult,
  readStoredToolResult,
  buildPtcToolDefinition,
  runPtcTool,
  createResourceLocks,
  planToolLocks,
  createVerifyScheduler,
  shouldUseSocraticBrief,
  requiredDeliverableKinds,
  createToolScheduler,
  planContextOverflow,
  createTurnMetrics
} from 'cache-stable-agent-core';
```

You can also import through subpaths:

```js
import { resolveLaggingWindow } from 'cache-stable-agent-core/history';
import { buildTurnContext } from 'cache-stable-agent-core/context';
import { distillToolResult } from 'cache-stable-agent-core/tools';
import { runPtcTool } from 'cache-stable-agent-core/ptc';
import { createResourceLocks } from 'cache-stable-agent-core/locks';
import { planToolLocks } from 'cache-stable-agent-core/scope';
import { createVerifyScheduler } from 'cache-stable-agent-core/verify';
import { shouldUseSocraticBrief } from 'cache-stable-agent-core/contract';
import { requiredDeliverableKinds } from 'cache-stable-agent-core/deliverable';
import { createToolScheduler } from 'cache-stable-agent-core/tool-scheduler';
import { planContextOverflow } from 'cache-stable-agent-core/guard';
import { createTurnMetrics } from 'cache-stable-agent-core/latency';
```

For the full integration order, see [docs/integration.md](docs/integration.md).

## Core capabilities

### 1. Cache prefix stability

Model-side automatic prefix caching only hits when the current request is a prefix of the previous one. A single byte change in the system prompt, tool schema, or the middle of the history causes everything after it to be re-billed.

This core uses four layers to keep the prefix append-only and never rewritten:

- Stable serialization: object keys are emitted in lexicographic order, so the same configuration serializes to identical bytes.
- Fixed tool-definition ordering: tools are sorted by name so different construction paths cannot produce different orders.
- Lagging trim: history is trimmed in one go to the soft cap only when it exceeds the hard cap, and two trims are separated by at least one window difference, so appends do not trigger a sliding window each time.
- Trim boundary alignment: the trim start is aligned back to the nearest user message, so a conversation turn is never cut in half.

Two budget tiers are kept by default: the legacy-compatible default is a soft cap of 48 messages / 60k characters and a hard cap of 64 messages / 150k characters. For long sessions, `historyLimitsForContext(modelWindow)` is recommended: it pushes the hard cap to 97% of the model window (using a conservative 2.5 characters/token) and sets the soft cap to 50% of the hard cap. The latter makes each trim drop enough history that the next trim comes much later, avoiding a prefix rebuild every few turns. Once the hard cap is exceeded, history is trimmed to the soft cap and the trim start is aligned to the nearest user message. The effect is that consecutive turns only append messages, and the first request of a new turn is naturally a prefix of the last request of the previous turn.

### 2. Tool-result distillation and read-back

When a tool output exceeds the budget, the full content is persisted to disk and only a structured summary plus a `result_id` stay in the history: tool name, character count, line count, byte count, JSON structure, and a small preview. When the model needs details, it calls `read_tool_result`, which reads precisely by line, character range, or JSON Path.

The benefit is that the context keeps only what decisions need rather than an entire file; the cost is one extra read-back round-trip. The budget adapts to the context window, medium-sized results keep their original text, and only genuinely large results are distilled, so saving tokens does not end up adding turns.

The distillation implementation also handles security boundaries: secrets and tokens are redacted by regex, result directories are validated against out-of-bounds paths, result files carry a 30-day TTL, and a failed disk write automatically falls back to the full content without affecting the main flow.

### 3. Programmatic Tool Calling (PTC)

PTC stands for Programmatic Tool Calling. Traditionally the model issues one tool call per file read; PTC lets the model write a small piece of controlled JavaScript that lists directories, reads files, searches, queries the knowledge base, and reads skills in one sandbox execution, returning only the aggregated result at the end.

The security design has three layers:

- Syntax layer: acorn-based AST validation forbids `class`, `import`, `this`, `process`, dynamic property access, and similar capabilities; `new` is allowed only for the standard built-ins Set, Map, Date, RegExp, Error, Array, Object, and Promise.
- Execution layer: a separate worker thread plus `node:vm`, with no network, no file writes, and no shell; each run has a timeout and a tool-call cap.
- Interface layer: only typed read-only APIs are exposed, and parameters are validated one by one for type, range, unknown keys, and path traversal; the general file system is not exposed.

Available APIs:

```js
await files.list({ path, depth, offset, limit })       // up to 400 entries per page; continue with nextOffset
await files.read({ path, startLine, endLine })         // up to 500k characters of body text
await files.readMany({ paths, startLine, endLine })    // up to 50 paths; duplicate paths are read once
await files.search({ query, path, glob, target, caseSensitive, regex })
await knowledge.search({ query, topK })
await skills.read({ name })
```

For file-intensive tasks, narrow the scope with `search` or `list` first, then read in batches with `readMany`. Batch reads and content search use asynchronous bounded I/O, and the same file is reused from the read-only cache across `ptc_run` calls by mtime/size. A single result is capped at 24000 characters, so project only the fields you need inside the program and do not return multiple full texts. `search` returns at most 200 hits and scans at most 4000 files; files over 1MB are skipped and counted in `skippedLarge`.

Multiple `ptc_run` calls in the same task share `state` and top-level variables; pass `reset: true` to clear them. File writes, edits, command execution, MCP, and sub-agents still go through direct tools and do not enter PTC.

When a single `ptc_run` exhausts its 100 tool-call budget, the core offers a clarification decision protocol: continue with PTC, switch to direct tools, or have the user supply other requirements; choosing to continue grants a full new budget rather than allowing just one more call. Static validation failures allow 2 automatic corrections, and after 3 consecutive failures the run degrades to direct read-only tools.

### 4. Single-turn context engine

The cost of long conversations comes not only from history length but also from content injected fresh every turn. The context engine converges that content into four controllable blocks, all appended after the stable prefix:

- Prefetch: files are read only when the user message contains an explicit path, line range, or symbol; otherwise only a workspace index of "path + fingerprint + line count" is provided. Unchanged files are short-circuited by mtime/size/hash and not read again.
- Cold facts: when the user references an earlier turn, key facts are extracted from past tool calls and restored, so window trimming does not make the model lose already-confirmed information.
- Artifact index: records files generated or modified in this turn; later references reuse the summary directly instead of re-reading the full text.
- Task memo: when the same task signature recurs, the previous conclusion summary is injected.
- Short-session degradation: for the first 3 user turns, index entries go from 240 to 120, total prefetch from 8000 to 4000 characters, and fact/artifact blocks from 1000 to 400 tokens, so fixed injection cost is not spread too thin in short sessions.

`buildTurnContext` is the single entry point for these four blocks; when `contextEngine === false` it degrades to the traditional full-history mode, which makes controlled benchmarks easy.

### 5. Concurrent write locks and verification scheduling

When multiple tools read and write the same file at once, two problems appear: writes overwriting writes, and reads seeing half-written content. Three modules tie concurrent writes and verification together:

- Resource locks: keyed by workspace-relative path, providing file- and directory-granularity reader-writer locks. Read locks can run concurrently, write locks are exclusive, a directory lock covers its descendants, writers have priority so readers do not jump ahead of an earlier conflicting writer, and locks are non-reentrant to avoid self-locking within a call chain.
- Command scope: infers the read/write set from commands such as `node --test`, `pytest`, `go test ./pkg/...`, and `tsc -p`; when it cannot tell, it falls back to a workspace-wide lock. Only an explicitly declared scope counts as complete input.
- Verification scheduling: concurrent verifications of the same command and scope merge into a single Promise; input file versions are snapshotted before execution, writes increment versions, and a verification re-runs if it detects changed inputs at the end; different scopes can run in parallel.

An easily missed correctness detail: inferred scopes can miss imported source files, so only verification results from explicit scopes may be cached. `planToolLocks` passes `cacheable` to the scheduler so a lucky pass is not treated as a long-term conclusion.

Locks are in-process and do not span processes or machines; PTC is a read-only sandbox and does not participate in write locks. Cross-process scenarios require file locks or an external coordination service.

### 6. Reproducible grouped benchmarks

`benchmark/` keeps raw results and the report-generation script for tiny 10-turn, short 20-turn, medium 50-turn, long 70-turn, and extra-long 100-turn runs. The report is a single-file HTML document whose charts need no external libraries and can be opened directly on a phone. The previous four-group data is archived in `benchmark/data/legacy-2026-11-23/`, and the earlier five-group data is in `benchmark/data/legacy-2026-11-22/`.

Result basis:

- Optimized variant: Programmatic Tool Calling (PTC) + single-turn context engine + lagging trim + tool-result distillation with adaptive budgets.
- Baseline variant: native function calling + full history + a single-loop ReAct, with prefetch, cold facts, artifact index, turn policy, plan inlining, task memo, distillation, and compaction disabled.
- Same model, same tasks, same prompts; accuracy is verified automatically from artifact files, not by comparing returned text.

### 7. Task contract and deliverable constraints

Long tasks often fail not because the model cannot do the work but because it drifts: it reads "generate an Excel file" as "write a Python script", or treats an input file as the deliverable. Two pure-function modules pin down "what to do" and "what counts as done":

- `task-contract.js`: on complex tasks the main agent answers five fixed questions (true goal; known/unknown/assumptions; most likely failure point; method trade-offs; next step and delegation) and hands the completion criteria and key assumptions down to sub-agents. The self-check block is appended only to the end of the current user message and does not touch the system/tools prefix; sub-agents do not ask themselves, which avoids split assumptions.
- `deliverable.js`: only the target fragment after an action word is recognized; for example, "read a.xlsx and convert to csv" requires only csv, and "generate an analysis report" is not mistaken for Excel. It supports xlsx/pptx/docx/pdf/csv/html and extracts the output path specified by the user.

The contract is for reminders and acceptance only; it does not replace execution. After a tool successfully writes to disk, completion is marked by extension; if the user asked for Excel but only a script was written, the guard keeps reminding until the real artifact appears.

### 8. Same-turn concurrent tool scheduling

A model can return multiple tool calls in one turn. `tool-scheduler.js` splits them by path dependency into "parallelizable" and "barrier" groups:

- Writes to different paths can run in parallel; writes to the same path are serialized in their original order.
- A read of the same file after a write must wait for the write to finish; directory scans and writes to child files are ordered by ancestor relationship.
- A `run_command` with a definite scope is a verify node; unknown commands, calls that need approval, and unknown tools are barriers.
- Multiple-version writes to the same script, such as `_v43.py`, are forced through a barrier so pre-execution cannot bypass the version guard.

The concurrency limit defaults to 4; `AGENT_TOOL_CONCURRENCY=0` falls back to only consecutive read-only concurrency. The scheduler only decides order; actual mutual exclusion is still guaranteed by resource locks. Chat and Agent share the same output-path resolution: under Chat, `outputs/report.md` maps to `outputs/chat/report.md`, so reads and writes land on the same lock key.

### 9. Context overflow and request governance

`context-guard.js` recognizes vendor errors of the `maximum context length` kind, parses the real limit from the error text, compacts the request view to a 70% target, and retries; when retries are exhausted or nothing can be compacted, it returns a readable error instead of throwing the raw 400 at the user.

`llm-governor.js` wraps only "establish request + read response headers": adaptive concurrency halves on a 429 and recovers gradually after consecutive successes; without `Retry-After` it uses exponential backoff with full jitter; when the server asks for a long wait it opens the circuit breaker so queued requests fail immediately instead of hitting the rate limiter again. Once SSE has started, no retry happens, avoiding double billing or duplicate output.

### 10. Latency attribution and PTC coverage

`latency-metrics.js` breaks a turn's wall-clock time into model first-token wait, decoding, tools, disk writes, approval wait, orchestration, and unattributed residual; `durationMs` excludes the user's thinking and approval time. It also tracks PTC turn coverage, repeated-read rate, call and token attribution by plan/execute/finalize phase, and whether the cache was actually reported. All metrics are observational and do not feed scheduling decisions.

### 11. Dynamic compaction, guards, and gates

These three mechanism families are often conflated, but their responsibilities differ:

- **Dynamic compaction** solves "history is too long but we do not want to rebuild the prefix every turn". Compaction runs piggyback only when history must be trimmed and finishes within the same request as the trim; Phase 1 passes in order through the tiered minimum, `minHistoryTokens`, the 70% watermark of the pre-trim size, the compactable range, summary length, and net-benefit checks; `finalPhase` skips compaction but keeps the trim and the 98% emergency degradation; an in-turn prediction that the hard cap will not be reached also defers compaction. Phase 2 standalone compaction is off by default. In a default-configuration long-conversation run, 3 compactions saved 89,671 tokens with a 97.2% cache hit rate and 100% accuracy. The full 11-step decision chain is in [docs/compaction.md](docs/compaction.md).
- **Guards** solve "the result cannot be trusted". The task contract pins down the true goal and completion criteria; the deliverable guard checks whether the requested xlsx/pdf/pptx was actually written to disk rather than just a script; the context guard tightens the view and retries when the vendor reports overflow; PTC syntax failures are corrected first and then degraded; verification scheduling marks inputs stale and re-runs when they change; the write guard uses temp-file + rename atomic replacement and blocks repeated whole-file rewrites and oversized single writes; the idle-spin guard stops losses on consecutive failures or repeated calls and then gives the model a chance to wrap up.
- **Gates** solve "is this worth doing". The plan gate exposes the planning tool first only at Agent step 0, when complexity is ≥5, and when the user has not given an explicit artifact path; the compaction gate decides whether this trim should also compact; the orchestration-economics gate estimates speedup and token overhead before starting parallel workers and falls back to serial when it is not worthwhile; when the PTC budget is exhausted, the user chooses whether to continue, switch to direct tools, or add requirements; the short-session PTC gate is a documented but unenabled option.

A guard failure has only three outcomes: **block, repair, or degrade**, never a silent pass; a gate failure means **defer or reject**, which cannot make the result untrustworthy. Both families append reminders only to the end of the current user message and do not change the system/tools prefix, so checks do not break the cache. The full tables, execution order, and the boundary between the main repository and this core are in [docs/guards-and-gates.md](docs/guards-and-gates.md); the plan gate's decision chain is in [docs/plan-gate.md](docs/plan-gate.md).

## Benchmark results

The latest batch is the 2026-11-26 same-window ABBA re-test: model deepseek-chat, 2 runs per variant per group, alternating in A-B-B-A order, 500 turns per variant and 1000 turns of real conversation in total. Cost is recalculated uniformly at off-peak prices (CNY / 1M tokens: cache hit ¥0.02 / cache miss ¥1 / output ¥4) to avoid a 2x tier difference when the two groups straddle peak and off-peak periods.

| Group | Turns/run | Wall-clock opt / base | Wall-clock diff | Token opt / base | Token diff | Cost opt / base | Cost diff | Accuracy opt / base |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Tiny conversation | 10 | 111.5s / 126.3s | -11.7% | 1.23M / 1.27M | -3.2% | ¥0.1652 / ¥0.1484 | +11.3% | 100% / 100% |
| Short conversation | 20 | 203.2s / 226.3s | -10.2% | 3.11M / 3.41M | -8.7% | ¥0.2754 / ¥0.2799 | -1.6% | 100% / 100% |
| Medium conversation | 50 | 583.8s / 657.1s | -11.1% | 10.80M / 21.83M | -50.5% | ¥0.7633 / ¥1.0738 | -28.9% | 100% / 100% |
| Long conversation | 70 | 957.8s / 1071.5s | -10.6% | 16.32M / 46.87M | -65.2% | ¥1.3963 / ¥1.9423 | -28.1% | 99.3% / 92.1% |
| Extra-long conversation | 100 | 1444.2s / 1793.1s | -19.5% | 22.83M / 106.68M | -78.6% | ¥1.9800 / ¥3.8460 | -48.5% | 100% / 100% |
| **Total (2 runs)** | **250/run** | **3300.6s / 3874.2s** | **-14.8%** | **54.29M / 180.05M** | **-69.8%** | **¥4.5802 / ¥7.2904** | **-37.2%** | **99.8% / 97.8%** |

Five takeaways:

1. Wall-clock time leads the baseline in all five groups (-10.2% to -19.5%), -14.8% overall; tokens -69.8% and cost -37.2%. Same-window alternation rules out time-of-day load differences; the earlier "the optimized variant is slower" was an artifact of cross-period runs.
2. The token and cost advantage grows quickly with conversation length: medium conversation is -50.5% in tokens and extra-long is -78.6%. The reason is that PTC cuts tool round-trips while the model-window-derived history budget and the context engine lower per-turn injection; combined, they are not offset by the window cap.
3. Accuracy is 99.8% versus 97.8%. In the long-conversation run at 03:41, the baseline failed all 11 Excel tasks: it generated an xlsx, converted it to CSV, then `delete_file` deleted the xlsx, leaving the deliverable missing. This is not a misjudgment by the evaluation script but a real failure caused by the lack of a deliverable guard; the optimized variant in the same window scored 99.3% (1 of 140 turns had a review that did not write valid content).
4. Tiny conversation is the only group whose cost is higher than the baseline (+11.3%), yet its wall-clock time is 11.7% faster. PTC uses fewer tool turns (27.0 versus 29.5); the real difference is that each `ptc_run`'s JavaScript code argument is entirely new cache-miss tokens: within 10 turns this adds about 10k cache-miss input tokens, and the cache-miss price is 50 times the cache-hit price, so the fixed overhead cannot be amortized. Short conversation is already roughly break-even (-1.6%), and from medium conversation onward the savings are clear.
5. The long-conversation group uses 2 opt + 2 base, four valid runs, after excluding two runs with obvious server stalls (one opt turn of 192s; base P95 of 22.6s); all other failed turns are counted, with no favorable filtering. The full accounting basis, per-group charts, and a savable PNG are in [benchmark/README.md](benchmark/README.md) and [benchmark/abba-report-2026-11-26.html](benchmark/abba-report-2026-11-26.html).

The previous batch (2026-11-25, cross-period single runs, 500 turns) per-turn average table is kept for historical comparison. That batch's long-conversation group was affected by time of day, and its cost conclusion has been superseded by the same-window ABBA:

| Group | Turns | Optimized tokens | Baseline tokens | Token change | Optimized time | Baseline time | Accuracy (opt/base) | Cache hit (opt/base) | Cache miss (opt/base) | Cost (opt/base) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tiny conversation | 10 | 76.9k | 63.2k | +21.8% | 6.3s | 5.8s | 100% / 100% | 90.7% / 93.9% | 71k / 38k | ¥0.0112 / ¥0.0075 |
| Short conversation | 20 | 98.0k | 137.0k | -28.5% | 5.5s | 5.6s | 100% / 100% | 95.0% / 96.6% | 98k / 93k | ¥0.0091 / ¥0.0096 |
| Medium conversation | 50 | 142.2k | 251.9k | -43.5% | 5.7s | 8.1s | 100% / 100% | 96.0% / 98.5% | 284k / 183k | ¥0.0113 / ¥0.0123 |
| Long conversation | 70 | 157.5k | 306.0k | -48.5% | 6.5s | 7.3s | 100% / 100% | 95.5% / 98.9% | 488k / 244k | ¥0.0138 / ¥0.0132 |
| Extra-long conversation | 100 | 165.8k | 487.8k | -66.0% | 6.7s | 9.3s | 100% / 100% | 95.5% / 99.2% | 742k / 379k | ¥0.0145 / ¥0.0177 |

The previous batch's main conclusions were that tokens grow with turns and overall cost is 8.3% lower, but the long-conversation group costs slightly more; because the two groups ran in different periods, the long-group difference cannot be attributed directly to the framework. The latest conclusions are those in the same-window ABBA table above.

A separate cost A/B of the plan prompt and plan gate (long 70 turns, xlong 100 turns, with reproduction commands and caveats) is in [docs/plan-prompt-ab.md](docs/plan-prompt-ab.md).

### Performance boundary: wall-clock time is already close to the model-side lower bound

Breaking each turn's `durationMs` down by `latency-metrics` fields, in the 2026-11-25 batch the optimized variant spent 93.8% of wall-clock time on model calls (first token 83.1%, decoding 10.7%), 5.3% on local tools, close to 0 on disk writes, and 0.6% unattributed. In the 2026-11-26 ABBA batch the extra-long group is still about 92% model-side, with 3.7 model calls per turn on average; the baseline is 89.8% model-side overall, with 1.48 seconds to first token per step.

This means wall-clock time is already close to the lower bound for this model: even reducing local tool time to zero would only take the 2026-11-25 batch from 6.34 seconds to about 6.0 seconds per turn, a gain of under 6%; the ABBA batch's overall gap is -14.8%, driven mainly by fewer model round-trips and a smaller context. Compacting the context further mainly lowers cost and helps time only marginally; to cut time further, reduce model steps, read-back round-trips, and output length rather than compacting harder. Tiny conversation is the only cost exception: 10 turns cannot amortize PTC's fixed cache-miss overhead, so cost is 11.3% higher, but wall-clock time is still 11.7% faster. The full breakdown is in [docs/mechanisms.md](docs/mechanisms.md).

### Cost accounting basis: estimated with official DeepSeek prices

Benchmark cost is an estimate computed from token usage and official DeepSeek unit prices, not a bill. Unit prices (CNY / 1M tokens): off-peak cache hit ¥0.02, cache miss ¥1, output ¥4; peak is 2x (¥0.04 / ¥2 / ¥8). All original 2026-11-25 batch runs were during peak hours; data and reports have been normalized uniformly to off-peak prices, and `peakCostCny` retains the original peak cost. The 2026-11-26 ABBA batch straddles peak and off-peak, and both groups are recalculated at off-peak prices. For the real bill, compute separately based on when requests were actually sent.

The formula is `cost = hit/1e6*0.02 + miss/1e6*1 + output/1e6*4`. In the 2026-11-25 batch the optimized variant averaged about 142.1k cache-hit, 6.7k cache-miss, and 0.88k output tokens per turn, roughly ¥0.0131 in total; the baseline averaged about 340.0k cache-hit, 3.7k cache-miss, and 0.93k output tokens, roughly ¥0.0143. The same-window ABBA batch totals ¥4.5802 versus ¥7.2904 (-37.2%). DeepSeek alone is used for like-for-like comparison because it consistently returns `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`; other vendors lack uniform cache fields. Costs are estimates and exclude taxes, discounts, or vendor price changes.

## When to use it

This core fits best for ongoing work on the same codebase or the same document set:

- multi-file reading, cross-directory dependency analysis, taking over legacy systems;
- cross-file refactoring, batch edits, configuration migration, framework upgrades;
- continuous tasks that need multi-turn context, such as long reports, test completion, and migration plans;
- knowledge-base or office-document scenarios that repeatedly query fixed material;
- engineering tasks that need tool calls, approvals, and rollback-capable writes.

Less suitable for:

- one-off short Q&A and small single-file edits;
- hard real-time interaction and pure GUI operations;
- high-risk writes that cannot be approved;
- scenarios that need arbitrary cross-session semantic memory without RAG or knowledge-base backing.

For these tasks the framework overhead may outweigh the benefit, or a lighter approach should be used instead.

## Quick start

Requires Node.js 20 or later.

```bash
npm install
npm test
npm run example:minimal
npm run example:context
npm run example:ptc
npm run benchmark:report
```

`example:minimal` demonstrates the history window, prefix fingerprint, and tool-result distillation and read-back. `example:context` demonstrates the single-turn context engine: prefetch only for explicit paths, artifact index, and a second reference hitting the cache directly. `example:ptc` runs a PTC batch search in a temporary workspace. `benchmark:report` reads the raw JSON under `benchmark/data/` and generates `benchmark-report.html` and `benchmark-summary.json` in `benchmark/output/`. The repository ships a pre-generated report that can be opened directly at `benchmark/report-preview.html`. The earlier five-group data is in `benchmark/data/legacy-2026-11-22/`, and the report script reads top-level data files only.

Currently 45 test files and 334 tests all pass.

This repository is a core library and contains no web service entry point. Integration means calling these modules from your own agent loop: before a request, get the history window with `resolveLaggingWindow` and compute and record the prefix hash with `buildRequestFingerprint`; after a tool returns, use `distillToolResult` to decide whether to persist it to disk.

## Directory structure

```text
index.js              aggregated public API exports
server/               core modules
  prefix.js           stable serialization, prefix hashing, common-prefix ratio
  history-window.js   lagging trim, soft and hard caps, user-message alignment
  token-opt.js        optimization switches, budgets, unit prices, and conservative token estimation
  tool-result.js      tool-result distillation, redaction, persistence, segmented read-back
  history-compact.js  history fact compaction, net-benefit calculation
  task-type.js        stable classification of task types and tool categories
  tool-order.js       stable tool-definition ordering
  task-contract.js    main-agent self-check, completion criteria, and key assumptions
  deliverable.js      deliverable type detection and output-path extraction
  limits.js           tool-turn cap and finalization budget
  cache-metrics.js    daily append of cache-hit logs
  cache-usage.js      normalization of cache-usage fields across vendors and cache-capability detection
  context-prefetch.js single-turn prefetch and workspace index
  cold-facts.js       cold-fact extraction
  artifact-index.js   artifact index and reuse decisions
  task-memo.js        task memo
  turn-context.js     unified single-turn context assembly
  window-context.js   summaries of evicted turns and window recovery
  context-policy.js   distillation, trim, and degradation policy
  context-guard.js    context-overflow detection and compaction retry
  parallel-tools.js   parallel batches of read-only tools
  tool-scheduler.js   same-turn tool scheduling by path dependency
  output-paths.js     Chat/Agent output-directory isolation
  plan-inline.js      plan inlining
  worker-prompt.js    sub-agent prompt and tool allowlist
  prefix-diff.js      prefix-drift attribution
  task-scheduler.js   sub-task scheduling policy
  orchestration-economics.js parallel benefit threshold
  orchestration-report.js    orchestration result report
  orchestration-metrics.js orchestration metrics
  llm-governor.js     adaptive concurrency, backoff, and circuit breaking
  latency-metrics.js  single-turn latency breakdown and PTC coverage
  locks.js            lightweight key-based mutual exclusion
  resource-locks.js   file and directory reader-writer locks, version registration
  command-scope.js    command-scope resolution and tool lock planning
  verify-scheduler.js verification deduplication and stale-verification re-runs
  benchmark-metrics.js benchmark aggregation and cost estimation
  paths.js            workspace path constraints and root cache
  embeddings.js       vector search configuration and requests
  ptc/                PTC syntax validation, sandbox, typed tools, budget decisions, and tracing
test/                 45 core unit, boundary, and simulation tests
examples/             minimal integration, context engine, and PTC examples
benchmark/
  data/               raw results of the five real 2026-11-25 benchmark groups
  data/abba-2026-11-26/ same-window ABBA aggregates for the five groups
  data/legacy-2026-11-22/ previous five-group benchmark data
  data/legacy-2026-11-23/ previous four-group benchmark data
  abba-report-2026-11-26.html same-window ABBA report (single-file HTML)
  abba-report-2026-11-26.png  same-window ABBA long-image report (savable on phones)
  report.mjs          report generation script
  report-preview.html pre-generated report
  README.md           benchmark basis and data notes
docs/
  mechanisms.md       mechanism overview: role, interactions, and trade-offs of each mechanism
  compaction.md       the 11-step dynamic compaction decision chain, thresholds, and measurements
  guards-and-gates.md guards and gates: what is blocked, how it degrades, code and test index
  plan-gate.md        plan gate decision chain, timing, and measurements
  plan-prompt-ab.md   cost A/B of the plan prompt and plan gate
  cache-stability.md  the full process of fixing the cache hit rate
  concurrency.md      concurrent write locks, command scope, and verification scheduling
  ptc.md              PTC design, budget, recovery, and short-session overhead
  integration.md      integration guide
  release-gitee.md    steps for publishing to Gitee
```

## Known limitations

- Contains only the core; it cannot directly start a conversational web application.
- Benchmarks use 1 run per group; the sample size is limited, so read trends rather than decimals.
- Fully verified only on Windows with Node 20; Linux and macOS have not been systematically tested.
- PTC batch code quality depends on model capability. `readMany` supports up to 50 paths, but the body text returned at once is limited by the 24000-character result cap; smaller models should reduce the number of full texts per call and aggregate inside the program first.
- Concurrency locks are in-process and do not span processes or machines; when cross-process write protection is needed, replace them with file locks or an external coordination service.
- Benefits are limited on short conversations: in the tiny 10-turn scenario tokens are 21.8% higher and cost is 49% higher because initialization and scheduling overhead dominate; this scale is not suitable as a primary scenario.
- About 93.8% of wall-clock time is model-side: the fixed first-token latency per step is about 1.10–1.48 seconds and is not strongly related to prompt size; further reduction mainly comes from fewer model call steps rather than more context compaction.
- Inferred command scopes may be incomplete, so their verification results are not cached; only verifications with an explicitly declared read/write set hit the cache.
- The deliverable contract recognizes only common formats and action words; requests that are too colloquial or omit the target may still need caller-supplied rules.

## Roadmap

1. Batch read-back: read fragments of multiple `result_id`s at once to reduce read-back round-trips in long conversations.
2. Aggregation push-down: guide the model to count, deduplicate, sort, and project fields inside the PTC script and return only results.
3. Phase 2 compaction: roll out gradually by task type after offline evaluation confirms net benefit.
4. Multi-model evaluation: establish safe upper bounds for PTC batch size under different models.
5. Cross-platform validation and CI: add prefix-stability and accuracy regressions to continuous integration.

## Version and legacy source

The current public version is 0.5.5. 0.5.5 syncs dynamic compaction's final-phase skip, the pre-trim size watermark, and predictive skip; it adds the same-window ABBA benchmark (five groups, 1000 turns) and an analysis of PTC fixed overhead in tiny conversations, without changing the public API. 0.5.1–0.5.4 mainly enhanced documentation. On top of 0.4.0's task contract, deliverable constraints, and same-turn tool scheduling, 0.5.0 added a model-window-derived history budget (`historyLimitsForContext`) and short-session context budget degradation (`resolveTurnContextBudget`), raised the in-turn emergency trim threshold from 90% to 97%, and updated the benchmark to five groups of 500 turns recalculated at a single price tier. The project name was also changed to Cache-stable Agent Core: the repository is in fact a core library that does not include the web workbench; the Gitee repository path temporarily keeps `local-first-agent-workbench` for compatibility with existing links and can be changed to `cache-stable-agent-core` in the repository settings. Kernel source for 0.1.0 through 0.4.0 remains in the commit history of the Gitee repository https://gitee.com/george333999/local-first-agent-workbench, and legacy benchmark raw data is archived in `benchmark/data/legacy-2026-11-22/` and `benchmark/data/legacy-2026-11-23/`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately following the process in [SECURITY.md](SECURITY.md). See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the code of conduct.

The full commands and checklist for publishing to Gitee are in [docs/release-gitee.md](docs/release-gitee.md).

## License

[MIT](LICENSE)
