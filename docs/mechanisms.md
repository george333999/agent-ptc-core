# Mechanisms Overview: What Each Module Solves

This document answers four questions: **which mechanisms exist in the framework, why each was adopted, where it takes effect, and what effect it actually delivers**. A suggested reading order: start with "Design Constraints" and "Overall Results", then jump to specific mechanisms as needed.

All descriptions reflect the current `0.5.5` code; differences in older versions `0.1.0`–`0.5.0` are documented in `CHANGELOG.md` and the Gitee commit history. `0.5.1`–`0.5.4` mainly enhanced documentation; `0.5.5` synchronized the final phase and predictive compaction, and added the same-window ABBA benchmark.

## Design Constraints: Why These Mechanisms

These mechanisms are not an accumulation of features; they are forced by four hard constraints:

1. **Providers bill by common prefix**. The prefix cache hits only when "this request is a prefix of the previous request"; if any single byte in the middle changes, everything after it is re-billed. Therefore dynamic content may only be appended to the tail of the user message, and history may only be trimmed in a lagging manner, rather than sliding the window on every step.
2. **Each step's model call has a fixed first-token latency**. In the 500-turn benchmark of 2026-11-25, the optimized version took about 1.1–1.3 seconds of first-token latency per step, largely independent of prompt size; a turn averaged 4.3 model calls, so first-token latency alone accounted for 4.7–5.3 seconds. Therefore eliminating one tool round trip is usually worth more than continuing to compress a few hundred tokens.
3. **Tool results are the main cause of context bloat**. Dumping whole files back into context consumes the window and increases the prefill of every subsequent step. Therefore large results are written to disk, a summary enters history, and precise read-back happens when needed.
4. **Concurrency breaks correctness**. Write-over-write, reading half-written files, and stale verification conclusions are data problems, not performance problems. Locks provide mutual exclusion, version registration detects changes, and verification scheduling handles merging and re-runs.

In one sentence, the division of labor: **prefix stability determines the price per token, the context engine determines how many tokens each turn sends, PTC and tool scheduling determine how many steps to run, and locks and contracts determine whether results are trustworthy.**

## Overall Results (2026-11-26, 1000-turn same-window ABBA benchmark)

Model `deepseek-chat`, five groups of 10/20/50/70/100 turns, two runs per variant per group, alternating A-B-B-A, 500 turns each for the optimized and conventional versions. Amounts are recomputed uniformly at the off-peak price. Per-turn averages:

| Metric | Optimized | Conventional | Change |
| --- | ---: | ---: | ---: |
| total tokens | 108.6k | 360.1k | 69.8% fewer |
| wall-clock time | 6.60s | 7.75s | 14.8% less |
| amount at the same tier | ¥0.00916 | ¥0.01458 | 37.2% less |
| cache hit rate | ~97.0% | ~98.9% | ~1.9 pp lower |
| accuracy | 99.8% | 97.8% | 2.0 pp higher |

The optimized version's cache hit rate is still slightly lower, but its total send volume is only 30% of the conventional version, so the amount is 37.2% lower. This shows that the cost of long conversations is mainly determined by "how much context is sent each turn", not by hit rate alone. The accuracy gap comes from the conventional version's run at 03:41 in the long conversation, where 11 Excel tasks were generated and then converted to CSV with the xlsx deleted, leaving deliverables missing; the optimized version scored 99.3% in the same window. The same batch also confirms that: for very short conversations the amount is still 11.3% higher, but wall-clock time is already 11.7% faster.

The old batch (2026-11-25, single runs across different periods, 500 turns) had per-turn averages of 149.8k / 344.7k tokens, 6.34s / 8.05s, and ¥0.0131 / ¥0.0143, retained for historical comparison; because the two groups ran in different periods, the amount difference in the long-conversation group cannot be directly attributed to the framework.

## Performance Ceiling: Wall-clock Time Is Already Near the Model-Side Floor

After splitting each turn's `durationMs` into model calls, local tools, disk writes, and unattributed residual (the table below is the 2026-11-25 batch):

| Group | Optimized per-turn wall-clock time | Model-side share | Local-tool share | First token per step |
| --- | ---: | ---: | ---: | ---: |
| Very short, 10 turns | 6.27s | 94.3% | 4.6% | 1.21s |
| Short, 20 turns | 5.49s | 94.2% | 4.8% | 1.10s |
| Medium, 50 turns | 5.70s | 94.8% | 4.2% | 1.16s |
| Long, 70 turns | 6.53s | 94.3% | 4.8% | 1.27s |
| Extra-long, 100 turns | 6.70s | 92.9% | 6.3% | 1.25s |
| Conventional, overall | 8.05s | 89.8% | 9.4% | 1.48s |

In the 2026-11-25 batch, 93.8% of the optimized version's overall wall-clock time went to model calls (first token 83.1%, decoding 10.7%), local tools only 5.3%, disk writes close to 0, and unattributed 0.6%; in the 2026-11-26 same-window ABBA batch, the extra-long group still spent about 92% on the model side, and overall wall-clock time was 14.8% lower than the conventional version. This means:

- Even if local tool time were reduced to 0, the 2026-11-25 batch's per-turn wall-clock time could only drop from 6.34 seconds to about 6.0 seconds, a gain of less than 6%.
- The remaining time is mainly model first-token latency and decoding, which is provider-side cost that the client cannot eliminate.
- Each turn averages 3.7–4.3 model calls, each with at least 1.1 seconds of first-token latency; to reduce time further, the main levers are fewer model steps, fewer read-back round trips, and shorter output, rather than continuing to compress context.
- Very short conversations are the only amount exception: the ABBA batch was 11.3% more expensive, but still 11.7% faster in wall-clock time. PTC has fewer tool turns (27.0 vs 29.5); the gap comes from each `ptc_run`'s JS code argument being entirely new cache-miss tokens — about 10k extra cache-miss input within 10 turns, so the fixed overhead does not have time to amortize.

Therefore the current state can be understood as: **on the `deepseek-chat` model, wall-clock time is already near the floor of this framework; continuing to shrink context volume mainly improves the amount and helps little with time.**

## Cost Accounting: Estimated at DeepSeek Official Prices

Benchmark amounts are not invoices; they are estimates computed from token usage and DeepSeek's official unit prices. The RMB unit prices at collection time on 2026-11-25 (per 1 million tokens):

| Tier | Cache hit | Cache miss | Output |
| --- | ---: | ---: | ---: |
| Off-peak | ¥0.02 | ¥1 | ¥4 |
| Peak | ¥0.04 | ¥2 | ¥8 |

Formula:

```text
cost = cache-hit tokens / 1e6 * 0.02
     + cache-miss tokens / 1e6 * 1
     + output tokens / 1e6 * 4
```

Three accounting details:

- **Recompute uniformly at the off-peak price**. The two groups may run across peak and off-peak periods, where actual unit prices differ by 2x; the report recomputes both sides at the off-peak price to avoid treating the tier difference as an optimization difference. The 2026-11-25 batch's original runs were all in peak periods; the data files' `costCny` has been normalized to the off-peak price, while `peakCostCny` keeps the original peak cost; the 2026-11-26 same-window ABBA batch spans peak and off-peak, and both groups are recomputed at the off-peak price. Real invoices still lock the tier by each turn's send time.
- **Use only DeepSeek for same-basis comparison**. DeepSeek's usage reliably returns `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`, allowing separate billing at the cache-hit price and the cache-miss price; other providers lack unified cache fields and cannot be compared on the same basis.
- **Amounts are estimates**. They are derived from usage tokens and exclude taxes, discounts, retry-policy differences, or provider price changes; they are used to compare the relative cost of the two frameworks and do not equal the final invoice.

First look at where these mechanisms sit within a single request, then expand each one.

## Position in the Request Lifecycle

```text
User message
  │
  ├─ 1. Task contract (complex-task self-check, completion criteria, key assumptions)
  ├─ 2. Single-turn context assembly (prefetch / cold facts / artifact index / memo / short-session degradation)
  ├─ 3. History window (limit derived from the model window, lagging trim, user alignment)
  ├─ 4. Stable prefix (system + tools byte-stable, prefix fingerprint)
  │
  ├─ Model call (retry, rate limiting, context-overflow governance)
  │      │
  │      └─ Multiple tool calls
  │            ├─ 5. Same-turn tool scheduling (path dependency, barrier, concurrency limit)
  │            ├─ 6. PTC batch read-only (complete multiple reads/searches in one sandbox run)
  │            ├─ 7. Resource lock + command scope + verification scheduling
  │            └─ 8. Tool-result distillation / rate limiting / read-back
  │
  └─ 9. Deliverable acceptance (judge true completion by extension and artifact content)
        10. Latency attribution and cache metrics
        11. Grouped benchmark (offline reproduction)
```

The following sections describe each mechanism.

---

## 1. Stable Prefix and Cache Fingerprint

**Problem addressed**: A provider's prefix cache is billed by "common prefix". If any single byte in the system prompt, tool schemas, or the middle of history changes, content from the change point onward is re-priced.

**Key implementation**

- `server/prefix.js`: `stableStringify` serializes object keys in lexicographic order; `hashText`, `buildCachePrefix`, `buildRequestFingerprint`, and `commonPrefixRatio` record and compare prefixes.
- `server/tool-order.js`: tool definitions are sorted by tool-name byte order, so that different construction paths produce the same order.
- All dynamic content (time, progress, prefetch blocks, summaries) is appended only to the tail of the user message and never inserted into system/tools or the middle of history.

**Effect**

- The common prefix ratio between adjacent turns approaches 1; old content is billed at the cache-hit price and only the added part is billed at the cache-miss price.
- In the benchmark, the optimized version has an overall hit rate of 95.5%; once the prefix drifts, `prefix-diff` can locate the specific turn.
- It does not reduce total tokens, but it determines the price at which each token is settled, which is the precondition for the amount reduction.

**Relationship to other mechanisms**: history trimming, the context engine, and tool-result distillation all change the message body; they must obey the "append-only, never rewrite" constraint, otherwise the earlier prefix optimization is invalidated.

**Cost and boundaries**: prefix stability does not reduce total tokens; it only guarantees that new content is billed at the cache-miss price and old content at the cache-hit price. It cannot fix provider-side cache-policy differences.

**Verification**: `test/prefix.test.js`, `test/tool-order.test.js`, `test/cache-simulation.test.js`.

---

## 2. History Window and Budget Derived from the Model Window

**Problem addressed**: A sliding window on every step keeps moving the window start forward, so the prefix changes every step; trimming too little at once causes trimming to be triggered again soon.

**Key implementation**

- `DEFAULT_HISTORY_LIMITS`: 48/64 entries and 60k/150k character windows compatible with legacy calls.
- `historyLimitsForContext(contextWindow)`: derives a "trim as little as possible" budget from the model window — the hard limit is 97% of the window (conservatively converted at 2.5 characters/token), and the soft limit is 50% of the hard limit. Trimming enough at once buys a longer interval to the next trim.
- `shouldTrimHistory`: trims only when the hard limit is exceeded and the `hard - soft` interval has elapsed since the last trim.
- `applyHistoryWindow`: aligns the trim start backward to the nearest user message, so that a turn is not cut in half.
- `resolveLaggingWindow`: reuses the previous trim baseline across turns, ensuring that the first request of a new turn is a prefix of the last request of the previous turn.

**Effect**

- Between two trims, history is append-only and the prefix is not rebuilt on every step.
- A single trim from the hard limit to the soft limit discards enough history that the next trim interval is longer; long and extra-long conversations still maintain a hit rate above 95%.
- The trim point aligns to a user message, leaving a complete boundary at the turn pushed out of the window, from which a summary can be rebuilt.

**Relationship to other mechanisms**: trimming triggers `window-context` to rebuild summaries of the turns pushed out of the window, and invalidates the reuse anchor of `turn-context`; therefore trimming should be kept to a minimum. `context-policy.shouldTrimAtStep` sets the in-turn emergency trim threshold to 97%, while regular turns trim only at turn boundaries.

**Cost and boundaries**: the larger the window, the larger each request; when the real model limit is exceeded, `context-guard` compacts as a fallback. Once a trim point occurs, the cache must be rebuilt once — an unavoidable cost.

**Verification**: `test/history-window.test.js`, `test/window-v4.test.js`, `test/context-policy.test.js`.

---

## 3. Dynamic Compaction: Piggyback, Final-Phase Protection, and Predictive Skip

**Problem addressed**: full history grows linearly with turns; if it is only trimmed and not compacted, the same batch of old tool results reappears in the window. Standalone compaction, in turn, proactively creates prefix rebuild points and drives the cache hit rate down.

**Key implementation**

- **Piggyback only**: compaction completes within the same request as the history trim, reusing the prefix rebuild point that has to happen anyway, without creating extra cache misses.
- **Phase 1 (enabled by default)**: the window reaches the tiered minimum, is ≥ `minHistoryTokens`, and the context volume before trimming is ≥ 70% of the window; a compactable range covering "from the end of the last coverage to the most recent user message" can be selected; the summary is applied only after its length and net benefit pass.
- **Final-phase skip**: `finalPhase` skips only piggyback compaction; trimming and the 98% emergency degradation still run as usual. The final phase has no new tools; compaction would only pay for a rebuild for nothing and might discard details the final answer needs.
- **Predictive skip**: within a turn, extrapolate the remaining context as "steps used × per-step increment"; when overflow of the hard limit is not expected (`projected × predictiveSafety < hardLimitTokens`), defer compaction, avoiding a pointless compaction near the end.
- **Phase 2 (disabled by default)**: standalone compaction must also satisfy the price inequality "remaining duplicate benefit > this rebuild cost"; it is forcibly disabled for medium/long conversations to avoid repeatedly breaking the prefix on the critical path.

**Effect**

- Default configuration for a long-conversation run: 3 compactions, saving 89,671 tokens (cache hit 89,298 / cache miss 373), cache hit rate 97.2%, accuracy 100%.
- In the same-window ABBA batch, the optimized version's accuracy was 99.8% (only 1 of 500 turns had a review that did not write valid content); there was no systematic loss of completeness due to compaction and trimming.
- Forced-trim control (60k history budget): compaction on vs off — tokens -1.6%, amount -10.4%, wall-clock time -3.6%, with the same accuracy.
- Final-phase and predictive skips are covered by unit tests, avoiding pointless compaction during the final phase and when "overflow is not expected".

**Relationship to other mechanisms**: compaction is bound to lagging trim; a trim point necessarily rebuilds the prefix, so compaction is only worthwhile when completed within the same request. The context guard is the last fallback and does not replace the watermark and budget judgments here; content that deliverable details and the final answer depend on should not enter the compactable range.

**Cost and boundaries**: compaction cannot judge information value; it only controls watermark, volume, range, and summary length; thresholds are still mostly fixed values; summary quality depends on the model. See [compaction.md](compaction.md) for the complete 11-step decision chain, skip reasons, configuration options, and the risk assessment of improvement proposals.

**Verification**: `test/history-compact.test.js`, `test/history-compact-simulation.test.js`.

---

## 4. Single-Turn Context Engine

**Problem addressed**: the cost of long conversations comes not only from history length, but also from file content, old facts, and indexes temporarily injected each turn.

**Key implementation** (unified entry point `server/turn-context.js`)

- **Prefetch** `context-prefetch.js`: reads file bodies only when the user message contains an explicit path, line range, or symbol; otherwise it provides only a workspace index of "path + fingerprint + line count". When a file is unchanged, it short-circuits by mtime/size/hash.
- **Cold facts** `cold-facts.js`: when the user refers to an earlier turn, extracts confirmed facts from historical tool calls and brings them back, preventing information loss after window trimming.
- **Artifact index** `artifact-index.js`: records summaries of files generated or modified in the current turn; later references reuse them directly without re-reading the full text.
- **Task memo** `task-memo.js`: when the same task signature recurs and the recurrence rate reaches a threshold, injects the previous conclusion summary.
- **Short-session degradation** `resolveTurnContextBudget`: for the first 3 user turns, reduces index entries 240→120, total prefetch 8000→4000 characters, and fact/artifact blocks 1000→400 tokens, so that fixed injection cost is not poorly amortized in short sessions.
- **Reuse deduplication**: when content is unchanged within the same session and the previously injected message is still in the window, the current turn writes only a one-line reference instead of re-injecting the body.
- **Window summary** `window-context.js`: when the window advances, rebuilds deterministic summaries of the turns pushed out and appends them to the last user message.

**Effect**

- Without an explicit path, only "path + fingerprint + line count" is injected, preventing whole files from entering context.
- The second reference to the same file hits by fingerprint and is not re-read; cross-turn reuse keeps the stable prefix effective.
- Short sessions degrade automatically, preventing fixed injection cost from being poorly amortized over 10–20 turns.

**Relationship to other mechanisms**: all injected blocks are appended after the stable prefix; after window trimming, `resetTurnContext` must be called, otherwise it will reference messages that have been trimmed away. When `contextEngine === false`, the whole thing degrades to the conventional full-history mode for benchmark comparison.

**Cost and boundaries**: injection benefit is limited in short sessions; prefetch reads have their own disk cost; the task memo needs an accumulated recurrence rate, so a single task will not trigger it.

**Verification**: `test/context-prefetch.test.js`, `test/cold-facts.test.js`, `test/task-memo.test.js`, `test/turn-context.test.js`, `test/window-context.test.js`.

---

## 5. Tool-Result Distillation, Rate Limiting, and Read-Back

**Problem addressed**: dumping tool output back verbatim fills the context, and the model needs several more turns to obtain the part it needs.

**Key implementation** (`server/tool-result.js`)

- Results exceeding the budget are written to disk in full, and history keeps only a structured summary and `result_id`: tool name, character count, line count, byte count, JSON structure, and a small preview.
- `read_tool_result` supports precise read-back by line, character range, and JSON Path.
- Injection rate limiting: when the single-step injection limit is exceeded, only the head and tail are injected and the middle is written to disk, preventing a single large result from inflating the prefill of every subsequent step.
- Security boundaries: masking of common secret formats, path-escape validation for the result directory, 30-day TTL, and automatic fallback to the full content when the disk write fails.

**Effect**

- A large result occupies only one summary in history and no longer brings the whole file into every subsequent step.
- When details are needed, read back by line, character range, or JSON Path, keeping location cost manageable.
- Secret masking, path-escape validation, 30-day TTL, and disk-write fallback ensure that distillation itself does not become a new point of failure.

**Relationship to other mechanisms**: distillation happens at the moment "the tool result is written to history"; old messages are never rewritten afterward, avoiding damage to the prefix cache. Read-back adds a model round trip, so short results are not distilled.

**Cost and boundaries**: the summary must retain enough locating information; if the model ignores `result_id` and infers directly, it will produce wrong values, requiring constraints at both the prompt and acceptance layers.

**Verification**: `test/tool-result.test.js`, `test/token-opt.test.js`.

---

## 6. PTC Programmatic Read-Only Tools

**Problem addressed**: the model issues one tool call per file read; file-intensive tasks consume many round trips on "read—look—read again".

**Key implementation** (`server/ptc/`)

- The model writes a small piece of controlled JavaScript that, in one sandbox run, lists directories, batch-reads files, searches, retrieves from the knowledge base, and reads skills, returning only the aggregated result.
- Syntax layer: acorn-based AST validation prohibits `class`, `import`, `this`, `process`, and dynamic property access; `new` is allowed only for standard built-in objects.
- Execution layer: an isolated worker + `node:vm`, with no network, no file writes, and no shell; each run has a timeout and a call-count limit.
- Interface layer: exposes only typed read-only APIs (`files.list/read/readMany/search`, `knowledge.search`, `skills.read`), validating each argument's type, range, unknown keys, and path traversal.
- Budget and recovery: when the budget of 100 tool calls is exhausted, offers a three-way choice of continue / switch to native / user input; static validation failures are auto-corrected twice, and 3 consecutive failures degrade to direct read-only tools.

**Effect**

- File-intensive tasks collapse multiple "read—look—read again" cycles into one model round trip; the benchmark's optimized version has 3.30 tool calls per turn and 0.34 seconds of local tool time, versus 3.86 and 0.76 seconds for the conventional version.
- The read-only sandbox does not participate in write locks, so the security boundary is clear; write operations still go through direct tools and resource locks.
- Budget exhaustion and static validation failures both have recovery paths; the task is not terminated by a single failure.

**Relationship to other mechanisms**: PTC is a read-only sandbox and does not participate in resource locks; writing files, editing, commands, MCP, and sub-agents still use direct tools. PTC results enter the distillation/rate-limiting flow as ordinary tool results.

**Cost and boundaries**: batch code quality depends on model capability; the per-run result limit is 24,000 characters, so the program should aggregate before returning; small models should reduce the amount of full text per run.

**Verification**: `test/ptc-edge.test.js`, `test/ptc-search.test.js`, `test/ptc-budget-decision.test.js`, `test/ptc-recovery.test.js`.

---

## 7. Same-Turn Tool Concurrent Scheduling and Parallel Read-Only

**Problem addressed**: when the model returns multiple tool calls in one turn, running them all serially wastes wall-clock time; running them all concurrently lets "read after write" and same-path writes overwrite each other.

**Key implementation**

- `server/tool-scheduler.js`: splits calls into "concurrent" and "barrier" by path dependency. Writes to different paths can run concurrently, while writes to the same path run serially; a read after a write to the same file waits for the write; directory scans and writes to subfiles are ordered by ancestor relationships; `run_command` with a definite scope is a verify node; unknown commands, calls requiring approval, and unknown tools are barriers; multiple versioned writes of the same script such as `_v43.py` are forced through the barrier.
- `server/parallel-tools.js`: parallel batches of read-only tools and per-call failure isolation.
- The concurrency limit defaults to 4; `AGENT_TOOL_CONCURRENCY=0` falls back to concurrent read-only calls only.

**Effect**

- Writes to different paths can proceed simultaneously, shortening the wall-clock time of multi-file modifications; same-path writes run serially, preventing later writes from overwriting earlier ones.
- Read-after-write, directory scans, and subfile writes are ordered by dependency, so reads never see half-written state.
- Approvals, unknown commands, unknown tools, and version scripts act as barriers, ensuring that calls requiring human input or version guards cannot be bypassed by concurrency.

**Relationship to other mechanisms**: the scheduler only decides ordering; actual mutual exclusion is still guaranteed by resource locks; only the combination of the two is both fast and free of overwrites. PTC's internal batch reads do not go through the scheduler.

**Cost and boundaries**: concurrency amplifies instantaneous disk and memory pressure; when dependency inference is wrong, falling back to serial execution is preferable.

**Verification**: `test/tool-scheduler.test.js`, `test/parallel-tools.test.js`.

---

## 8. Resource Locks, Command Scope, and Verification Scheduling (Lock Mechanism in Detail)

**Problem addressed**: multiple tools reading and writing the same file at the same time cause write-over-write and reads of half-written content; verification may also read stale inputs.

**Why locks are mandatory**: concurrent agent writes are not "possible conflicts" but the norm. In one turn, the model may return multiple `write_file` calls, a `read_file`, and a `run_command` at the same time; without mutual exclusion, correctness breaks in three ways:

```text
Two write_file calls modify src/calc.js at the same time
  No lock: A writes → B writes and overwrites → A's change is silently lost
  With lock: A holds the write lock, B queues → both changes land in order

read_file and write_file happen at the same time
  No lock: may read a file that is only half written
  With lock: the read waits for the write to finish, or the write waits for the read to end, and sees a complete version

The same node --test is triggered by three tools at the same time
  No lock: the same verification runs three times, and conclusions may be based on different versions
  With lock + verification scheduling: merged into one run; if the input changes, it is marked stale and re-run
```

**Key implementation**

- `server/resource-locks.js`: reader-writer locks on files and directories keyed by workspace-relative paths. Read locks can run concurrently, write locks are mutually exclusive; directory locks cover descendant paths; writer priority means readers cannot jump ahead of an earlier conflicting writer; unrelated resources can skip blocked requests; a read and a write to the same path within one request automatically upgrade to a write lock, avoiding `LOCK_UPGRADE` self-deadlock; not reentrant, so the same call chain does not wait on itself.
- `server/command-scope.js`: infers read/write sets from commands such as `node --test`, `pytest`, `go test ./pkg/...`, and `tsc -p`; when it cannot determine them, falls back to a workspace-global lock; only an explicit scope is treated as complete input.
- `server/verify-scheduler.js`: merges concurrent verifications of the same command and scope; snapshots input versions before execution, increments versions on writes, and marks stale and re-runs when input changes are detected at verification end; different scopes can run in parallel; both cache hits and execution return `waitMs` for latency attribution.

**Effect**

- Writes do not overwrite and reads do not tear: modifications to the same path land in order, and reads see only complete versions.
- Directory locks and ancestor relationships ensure that "scanning a directory" and "modifying a file inside the directory" do not interleave.
- The same verification runs only once; if the source changes during verification, it is re-run, preventing an old conclusion from being taken as a new one.
- `lockWaitMs`, `verifyRuns`, `verifyCached`, and `stale` can be attributed to a single tool call, making tail latency and duplicate executions visible.

**Relationship to other mechanisms**: an inferred scope may miss imported source files, so only verification results with an explicit scope are allowed to be cached (`cacheable`). Same-turn tool scheduling only decides ordering; actual mutual exclusion is still guaranteed by resource locks. Locks are in-process locks and do not span processes or machines; PTC is a read-only sandbox and does not participate in write locks.

**Cost and boundaries**: finer lock granularity means higher concurrency but more complex conflict detection; cross-process scenarios require file locks or an external coordination service; version registration works by path string and does not resolve symbolic links.

**Verification**: `test/resource-locks.test.js`, `test/command-scope.test.js`, `test/verify-scheduler.test.js`, `test/locks.test.js`.

---

## 9. Task Contract and Deliverable Constraints

**Problem addressed**: long-task failures are often not because the model cannot do the work, but because it goes off track: interpreting "generate an Excel file" as "write a script", or treating the input file as the deliverable.

**Key implementation**

- `server/task-contract.js`: for complex tasks, first answers five fixed questions (true goal, known/unknown/assumptions, most likely failure point, method trade-offs, next step and delegation), normalizes completion criteria and key assumptions, and passes them down when dispatching sub-agents. The self-check block is appended only to the tail of the current user message; sub-agents do not self-question, avoiding divergent assumptions.
- `server/deliverable.js`: recognizes only the target fragment after an action word ("read a.xlsx and convert to csv" requires only csv), supports xlsx/pptx/docx/pdf/csv/html, and extracts the output path specified by the user.

**Effect**

- Complex tasks fix the goal and completion criteria first, reducing "rework after going off track"; sub-agents consume the same criteria, avoiding divergent assumptions.
- When the user wants xlsx but only a script is generated, the deliverable guard keeps reminding until the real artifact lands on disk.
- The self-check block is appended only at the tail of the user message and does not change the system/tools prefix.

**Relationship to other mechanisms**: the contract is used only for reminders and acceptance, not as a replacement for execution; once a tool successfully writes to disk, completion is marked by extension. Deliverable acceptance is independent of the context engine, avoiding "injection changed but no artifact generated".

**Cost and boundaries**: only common formats and action words are recognized; overly colloquial requests or ones that omit the target may still require the caller to supply additional rules.

**Verification**: `test/task-contract.test.js`, `test/deliverable.test.js`.

---

## 10. Context Overflow and LLM Rate-Limiting Governance

**Problem addressed**: long tasks may fail outright at the last moment by exceeding the provider's context limit; during peak periods, 429s cause concurrent requests to drag each other down.

**Key implementation**

- `server/context-guard.js`: recognizes errors of the `maximum context length` type, parses the real limit from the error text, compacts the request view to a 70% target and retries; when retries are exhausted or there is nothing to compact, returns a readable error.
- `server/llm-governor.js`: wraps only "establishing the request + reading response headers". Adaptive concurrency halves on 429 and gradually recovers after consecutive successes; without `Retry-After`, it uses full-jitter exponential backoff; when the server gives a long wait, it opens the circuit breaker. After SSE starts, no retries occur, avoiding duplicate billing or duplicate output.

**Effect**

- Context overflow changes from "failing outright" to "compact and retry", so long tasks still have a chance to finish.
- During peak-period 429s, concurrency automatically halves, with jittered backoff and a circuit breaker, preventing concurrent requests from dragging each other down.
- No retries after SSE starts, avoiding duplicate billing and duplicate output.

**Relationship to other mechanisms**: context governance is the last fallback and should not replace the history budget; rate limiting affects only request establishment and does not change agent decisions.

**Cost and boundaries**: compaction loses detail; while the circuit is open, requests fail fast, and the caller must decide whether to retry or degrade.

**Verification**: `test/context-guard.test.js`, `test/llm-governor.test.js`.

---

## 11. Subtask Scheduling and Economics Gate

**Problem addressed**: parallel sub-agents are not necessarily faster: splitting too finely increases prefix construction, scheduling, and aggregation costs.

**Key implementation**

- `server/task-scheduler.js`: task-duration calibration, granularity validation, write-set mutual exclusion, soft deadlines, and hedging.
- `server/orchestration-economics.js`: estimates the speedup ratio, token overhead, and serial fallback result; in `mode: 'enforce'`, an unprofitable orchestration returns `allowed: false`.
- `server/orchestration-report.js`: a readable report of orchestration results, conflicts, and resource usage.
- `server/orchestration-metrics.js`: median, percentiles, tail ratio, parallel efficiency, and worker cache summary.
- `server/worker-prompt.js`: sub-agent prompts, tool allowlists, and the result-return format.

**Effect**

- Unprofitable parallelism is rejected before launch, avoiding "the more you split, the slower it gets"; write-set mutual exclusion prevents sub-agents from overwriting each other.
- Soft deadlines and hedging control tail latency, and the orchestration report shows whether each parallel run actually saves time.

**Relationship to other mechanisms**: sub-agents reuse a byte-identical shared prefix; when completion criteria are missing, acceptance uses `expectedOutput` and marks `partial`. The economics gate runs before workers are actually launched.

**Cost and boundaries**: benefit estimates depend on historical data; when task granularity is too small or write sets overlap, serial execution is more profitable.

**Verification**: `test/task-scheduler.test.js`, `test/orchestration-economics.test.js`, `test/orchestration-report.test.js`, `test/worker-prompt.test.js`.

---

## 12. Latency Attribution, Cache Metrics, and Reproducible Benchmarks

**Problem addressed**: optimization needs observable metrics; otherwise provider fluctuations are easily misread as code gains.

**Key implementation**

- `server/latency-metrics.js`: splits a single turn's wall-clock time into first-token wait, decoding, tools, disk writes, approval wait, orchestration, and unattributed residual; `durationMs` deducts user thinking and approval time; computes PTC coverage, repeat-read rate, call and token attribution by plan/execute/finalize phase, and whether the cache was reported.
- `server/cache-usage.js`: normalizes the cache fields of OpenAI, DeepSeek, and Anthropic; marks unknown when not reported, rather than treating a locally inferred miss as a 0% hit rate.
- `server/cache-metrics.js`: appends JSONL cache logs daily; failures do not affect the main flow.
- `benchmark/`: five real benchmark groups (10/20/50/70/100 turns), with the optimized and conventional versions on the same model, same tasks, and same prompts, validating accuracy by artifact files.

**Effect**

- Each turn's wall-clock time can be split into model first token, decoding, tools, disk writes, approval, and unattributed residual, preventing provider fluctuations from being mistaken for code gains.
- Benchmarks are recomputed at the same tier price, eliminating the 2x peak/off-peak price difference; when the cache is not reported, it is marked unknown rather than fabricating a hit rate.
- The data in the "Performance Ceiling" and "Cost Accounting" sections of this page are computed from this metric suite.

**Relationship to other mechanisms**: metrics only observe and do not participate in scheduling decisions; the benchmark report recomputes amounts at the same tier price to avoid a 2x error from the two groups running across peak and off-peak periods.

**Cost and boundaries**: single runs still fluctuate; conclusions with limited samples should follow trends; amounts are token-based estimates and do not equal the final invoice.

**Verification**: `test/latency-metrics.test.js`, `test/cache-usage.test.js`, `test/cache-metrics.test.js`, `test/benchmark-metrics.test.js`.

---

## 13. Layering of Guards and Gates

Guards are responsible for **correctness**, and gates are responsible for **economics**. Neither is a lock: locks solve concurrent mutual exclusion, guards solve "the result is untrustworthy", and gates solve "whether this is worth doing".

- **Correctness guards**: task-contract self-check, deliverable guard, context guard, PTC syntax recovery, write atomicity and duplicate-write protection, stale-verification re-run, and idle-spin and duplicate-call stop-loss.
- **Economics gates**: plan gate (complex tasks list a plan first), compaction gate (70% watermark, final phase, projected overflow), orchestration-economics gate (fall back to serial when the speedup ratio is insufficient), PTC budget decision, short-session PTC gate (design recorded, currently not enabled).

A guard failure has only three outcomes: block, repair, or degrade; silent passing is not allowed. The plan gate is enabled by default and is mandatory only when complexity ≥ 5 points; when the user has already given an explicit artifact path, it executes directly. The write guard and idle-spin guard live in the agent loop in `server/agent.js` in the main repository; the kernel-extracted edition provides reusable modules and reference notes.

For complete trigger conditions, degradation behavior, and code/test indexes see [guards-and-gates.md](guards-and-gates.md); for the plan gate's decision chain see [plan-gate.md](plan-gate.md); for the compaction gate's 11-step decision chain see [compaction.md](compaction.md).

---

## Default Switches and Applicable Scenarios

| Mechanism | Default | How to disable | Best-fit scenarios |
| --- | --- | --- | --- |
| Stable prefix | On | Not recommended to disable | All long conversations |
| History budget derived from the window | Chosen by the caller | Pass explicit legacy limits of 48/64 and 60k/150k | Windows above 128k, long sessions |
| Single-turn context engine | On | `contextEngine: false` | Multi-file, continuous tasks |
| Dynamic compaction Phase 1 | On (trim points only) | `tokenOpt.phase1: false` | Long sessions, history close to the window |
| Final-phase/predictive skip | On | `predictiveCompaction: false` | Final phase, in-turn prediction |
| Plan gate | On (≥5 points and no explicit artifact path) | `planGate: false` | Multi-step complex tasks |
| Deliverable guard | On | Custom rules | Office deliverables |
| Tool-result distillation | On (by budget) | `toolResultDistill: false` | Large file reads, logs |
| PTC | Optional | Use native tools | File-intensive, batch read-only |
| Same-turn tool scheduling | On | `AGENT_TOOL_CONCURRENCY=0` | Multiple tool calls per turn |
| Resource locks/verification scheduling | Wired in by the caller | Single-threaded read-only tasks | Concurrent writes, test verification |
| Context governance/rate limiting | On | Not recommended | Long tasks, peak periods |
| Subtask economics gate | advisory | `mode: 'enforce'` forces enforcement | Multi-agent orchestration |
| Metrics and benchmarks | On | In production, logs may be kept only | Optimization evaluation, regression |

## Common Misuse

- A sliding window on every turn: the prefix changes at every step, and the cache hit rate collapses.
- Concatenating a timestamp or task ID into the system prompt: every request's header differs.
- Replacing the historical arguments of `write_file` with placeholders: the model imitates the placeholders and corrupts real artifacts.
- Forcing distillation on short tool results too: one extra read-back round trip makes wall-clock time increase instead.
- Treating an inferred command scope as complete input and caching verification results: imported source files may be missed.
- Treating PTC as a write tool: PTC is a read-only sandbox, and write operations must go through direct tools and resource locks.
- Requesting a read lock and a write lock in two separate calls within the same request: declare both read and write in a single `acquire` so the kernel automatically upgrades to a write lock.

## Differences from Earlier Versions (0.5.5)

- **0.5.5 syncs dynamic compaction and benchmarks**: `planPiggybackCompaction` adds final-phase skip, pre-trim volume watermark, and predictive skip; adds [guards-and-gates.md](guards-and-gates.md); the benchmark is updated to a same-window ABBA of five groups and two variants × 500 turns each, 1000 turns in total.
- 0.5.1–0.5.4 mainly enhanced documentation and cost accounting, without changing APIs or runtime behavior.
- The behavioral differences of 0.5.0 are retained below:
  - Added `historyLimitsForContext`: the trim line is derived by default at 97% of the model window, with the soft limit at 50% of the hard limit.
  - The in-turn emergency trim threshold is raised from 90% to 97%; the turn-boundary degradation threshold is raised from 80% to 98% (the caller is responsible).
  - Added `resolveTurnContextBudget`: automatically lowers the index/prefetch/fact budgets for the first 3 user turns.
  - The benchmark is updated to five groups (10/20/50/70/100 turns), 250 turns per variant, 500 turns in total; old data is archived under `benchmark/data/legacy-2026-11-22` and `legacy-2026-11-23`.
  - The project name changed from `Local-first Agent Workbench` to `Cache-stable Agent Core`: the repository is actually a kernel library and does not include a web workbench; the Gitee repository path temporarily keeps `local-first-agent-workbench` for compatibility with historical links.
