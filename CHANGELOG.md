# Changelog

## 0.5.5 - 2026-11-26

Synced dynamic compaction's final-phase protection, pre-trim size watermark, and predictive skip; added the five-group same-window ABBA benchmark and an analysis of PTC fixed overhead in tiny conversations.

### Changed

- `server/history-compact.js`: `planPiggybackCompaction` adds `finalPhase` skip, a `contextTokens` watermark (preferring pre-trim size), and `predictiveCompaction` / `predictiveSafety` predictive skip; the Phase 1/2 target compaction ratio is now configurable via `phase1TargetRatio`.
- `server/token-opt.js`: adds `predictiveCompaction` (default `true`), `predictiveSafety` (default `1.1`), and `phase1TargetRatio` (default `0.5`).
- `test/history-compact.test.js`: adds 3 tests covering final-phase skip, predictive no-overflow skip, and the pre-trim size watermark.

### Docs

- `docs/compaction.md`: updated to the 11-step decision chain, adding `finalPhase`, `projectedNoOverflow`, default run, and forced-trim A/B data; adds risk assessments, rollout order, and acceptance thresholds for 5 follow-up improvements; documents the short-session PTC fixed overhead.
- `docs/guards-and-gates.md`: adds a unified description of guards and gates, covering the task contract, deliverable, context, PTC recovery, write, stale-verification, and idle-spin guards, as well as the plan gate, compaction gate, orchestration-economics gate, PTC budget decision, and short-session PTC gate.
- `README.md`: adds the "Documentation map" section and the "Dynamic compaction, guards, and gates" core-capability section, and completes the directory structure and mechanism entry points.
- `docs/mechanisms.md`: adds "Dynamic compaction" and "Layering of guards and gates" sections, reorders mechanism numbering, and syncs the 0.5.5 change notes.
- `benchmark/README.md`, `README.md`, `docs/mechanisms.md`, `docs/integration.md`: add the 2026-11-26 same-window ABBA five-group data (1000 turns, tokens -69.8%, wall-clock -14.8%, cost -37.2%, accuracy 99.8% versus 97.8%) and keep the 2026-11-25 cross-period data as a historical comparison.
- `benchmark/data/abba-2026-11-26/summary.json`, `benchmark/abba-report-2026-11-26.html`, `benchmark/abba-report-2026-11-26.png`: add the ABBA summary, the single-file HTML report, and the phone-friendly long image.

### Benchmark

- 2 runs per variant per group, alternating in A-B-B-A order, 500 turns per variant.
- The long-conversation group excludes two runs with obvious server stalls; the baseline's 11 Excel deliverable failures in the 03:41 run are all counted, with no favorable filtering.
- Tiny-conversation cost +11.3% comes from PTC's fixed cache-miss overhead, not from more calls (tool turns 27.0 versus 29.5, and wall-clock time is 11.7% faster); the short-session-specific gate is not enabled, avoiding session stickiness spilling into medium and long tasks.

### Tests

- All 337 tests pass (3 added).

## 0.5.4 - 2026-11-25

Documentation only; no API or runtime behavior changes.

### Docs

- `docs/compaction.md`: describes the dynamic compaction decision logic, including the layering of trim and compaction, the Phase 1 nine-step decision, the Phase 2 benefit inequality, a skip-reason quick reference, the emergency path, configuration defaults, and improvement directions.
- `docs/plan-gate.md`: adds an entry point pointing to the compaction documentation.
- `package.json`, `package-lock.json`: version bumped to 0.5.4.

## 0.5.3 - 2026-11-25

Documentation only; no API or runtime behavior changes.

### Docs

- `docs/plan-gate.md`: a standalone description of the plan gate, including its three components, the full decision chain, in-turn timing, the impact of the complexity threshold, configuration, its relationship to the history trim budget, measured results, typical scenarios, known costs, and a code index.
- `docs/plan-prompt-ab.md`, `benchmark/README.md`: add entry points pointing to the plan gate mechanism documentation.
- `package.json`, `package-lock.json`: version bumped to 0.5.3.

## 0.5.2 - 2026-11-25

Corrects only the benchmark report's cost accounting basis and adds A/B records; no API or runtime behavior changes.

### Fixed

- `benchmark/report.mjs`: the cost chart, group labels, and summary KPIs are changed uniformly to "estimated cost per turn", matching the README table; fixes the cost y-axis 0 tick displaying as `¥0.000000` and the cost curve being flattened by a fixed 0–1 lower bound.
- `benchmark/report-preview.html`: regenerated with the corrected script.
- `README.md`, `benchmark/README.md`: fix the statement that "the optimized variant costs less in all four groups, short, medium, long, and extra-long" — the long-conversation group's optimized variant costs ¥0.0138 per turn, higher than the baseline's ¥0.0132 (4.5% higher), while the other three groups are lower.

### Docs

- `benchmark/README.md`: adds the A/B record for the plan prompt and plan gate (long 70 turns, xlong 100 turns): after disabling planGate and removing the todo prompt, long cost is −13.2% and xlong −25.0%, with accuracy staying at 100%; raising only the forced-planning threshold falls within single-run variance.
- `docs/plan-prompt-ab.md`: a standalone description of the plan prompt and plan gate, including concept distinctions, benchmark setup, the full results table, mechanism interpretation, reproduction commands, and sample caveats.
- `package.json`, `package-lock.json`: version bumped to 0.5.2.

## 0.5.1 - 2026-11-25

Documentation only; no API or runtime behavior changes.

### Changed

- `README.md`, `docs/mechanisms.md`, `benchmark/README.md`: add mechanism design constraints, the measured effect of each mechanism, lock-mechanism scenario notes, the performance boundary, and the DeepSeek cost accounting basis.
- Clarify that 93.8% of the optimized variant's wall-clock time comes from model calls (first token 83.1%, decoding 10.7%) and 5.3% from local tools; even with local tool time at zero, each turn can only be about 6% faster.
- Clarify that cost is recalculated at official DeepSeek off-peak prices (cache hit 0.02 / cache miss 1 / output 4 CNY per million tokens), with peak prices at 2x; costs are estimates, not bills.
- `package.json` and `package-lock.json` version bumped to 0.5.1; tests remain at 45 files and 334 items, and the examples and benchmark scripts have been re-verified.

## 0.5.0 - 2026-11-25

The project name changed from `Local-first Agent Workbench` to `Cache-stable Agent Core`: the repository is in fact a core library that does not include the web workbench; the Gitee repository path temporarily keeps `local-first-agent-workbench` for compatibility with existing links. Syncs the core changes from AgentProject P1/P1.1 and refreshes the five-group benchmark and documentation.

### Added

- `server/history-window.js`: adds `historyLimitsForContext(contextWindow)`, deriving the hard cap from 97% of the model window and the soft cap from 50% of the hard cap; the legacy defaults of 48/64 messages and 60k/150k characters remain available for explicit limits.
- `server/turn-context.js`: adds `resolveTurnContextBudget()`, which for the first 3 user turns automatically changes index entries from 240 to 120, prefetch from 8000 to 4000 characters, and fact/artifact blocks from 1000 to 400 tokens.
- `docs/mechanisms.md`: the mechanism overview document, describing each mechanism's problem, where it takes effect, module interactions, cost boundaries, and verification files.
- `benchmark/data/legacy-2026-11-23/`: archives the previous version's four-group benchmark data.

### Changed

- `server/context-policy.js`: raises the in-turn emergency trim threshold from 90% to 97%, avoiding repeated prefix rebuilds on routine steps.
- `README.md`, `docs/integration.md`, `docs/cache-stability.md`, `benchmark/README.md`: sync the new budget, the five-group 500-turn benchmark, and the single-price-tier accounting basis; remove the "eleven capabilities" wording that no longer matched the actual number of sections.
- `benchmark/report.mjs`: groups changed to 10/20/50/70/100 turns; cost is recalculated uniformly at off-peak prices to avoid a 2x tier difference when the two groups straddle peak and off-peak periods.
- `package.json`: package name changed to `cache-stable-agent-core`, version 0.5.0, with description and keywords synced; the repository URL temporarily keeps the old path.
- Tests increased to 45 files and 334 items.

### Benchmark

- One run per group, 250 turns each for the optimized and baseline variants, 500 turns in total; accuracy is 100% throughout.
- Overall per turn: the optimized variant uses 150k tokens / 6.34s / ¥0.0131, the baseline 345k / 8.05s / ¥0.0143; tokens are 56.5% lower, time 21.3% lower, and cost at a single tier 8.3% lower.
- Tiny conversation (10 turns) is still the exception: the optimized variant uses 21.8% more tokens and costs 49% more, as fixed overhead cannot be amortized.
- About 93.8% of wall-clock time is model-side, with first-token latency per step of 1.10–1.48s and little relation to prompt size.

## 0.4.0 - 2026-11-24

Syncs with AgentProject's current refined core: completes the main-agent task contract, deliverable acceptance, same-turn concurrent tool scheduling, context-overflow fallback, LLM rate-limiting governance, single-turn latency attribution, and the parallel-orchestration economics gate.

### Added

- `server/task-contract.js`: main-agent five-question self-check, normalization of completion criteria and key assumptions, and sub-agent contract section rendering; the self-check block is appended only to the end of the current user message and does not break the prefix cache.
- `server/deliverable.js`: detects xlsx/pptx/docx/pdf/csv/html deliverables from the target fragment after an action word, extracts the output path specified by the user, and avoids mistaking an input file for the target artifact.
- `server/context-guard.js`: detects vendor context-overflow errors, parses the real limit, compacts the request view to a 70% target, and retries; returns a readable error when retries are exhausted.
- `server/parallel-tools.js`: parallel batches of read-only tools and isolation of single-call failures.
- `server/tool-scheduler.js`: same-turn tool scheduling by path dependency and scheduling barrier, covering read-after-write, directory scans, verify nodes, versioned-script barriers, and the concurrency limit.
- `server/output-paths.js`: Chat/Agent output-directory isolation and workspace path resolution, shared by the tool layer and the scheduler.
- `server/limits.js`: 200-turn tool cap, 40% progress reminders, and finalization reserve.
- `server/llm-governor.js`: adaptive concurrency, 429 jitter backoff, `Retry-After` parsing, and long-wait circuit breaking.
- `server/latency-metrics.js`: single-turn wall-clock breakdown, first token/decoding, phase attribution, PTC coverage, repeated-read rate, and cache-reporting status.
- `server/orchestration-economics.js` and `server/orchestration-report.js`: parallel benefit threshold, serial fallback result, and orchestration result report.
- `server/locks.js`: lightweight key-based mutual exclusion, `KeyedMutex`.
- Adds 13 test files covering the task contract, deliverables, context overflow, parallel tools, tool scheduling, output paths, turn budgets, LLM governance, latency metrics, orchestration economics, orchestration reports, path caching, and lightweight mutual exclusion; also updates the lock, verification scheduling, and worker prompt tests.

### Changed

- `server/paths.js`: the workspace root uses a native `realpath` cache (LRU + TTL), adds `invalidatePathCache` and `pathCacheStats`, and PTC and direct tools share the same root cache.
- `server/resource-locks.js`: the version fingerprint adds a short content hash, so rewrites by external tools that keep size and mtime can still be detected; reading and writing the same path within one request automatically upgrades to a write lock instead of throwing `LOCK_UPGRADE`.
- `server/verify-scheduler.js`: both cache hits and normal execution return `waitMs`, so verification queue time can be attributed to single-turn latency.
- `server/worker-prompt.js`: sub-agents explicitly do not self-check and only consume the completion criteria and assumptions issued by the main agent; when criteria are missing, they validate against `expectedOutput` and mark themselves `partial`.
- `server/command-scope.js`, `server/task-type.js`: the native Excel write tool `write_xlsx` is locked as a write tool and classified as `edit`.
- `server/ptc/index.js`, `server/ptc/tools.js`: add prompts to forbid probing line by line with endLine+1 and to stop exploring once the deliverable is written, and reuse the shared workspace root cache.
- `index.js` and `package.json` add subpath exports for the task contract, deliverables, context guard, tool scheduling, LLM governance, latency, economics, reports, paths, and mutual exclusion.
- Repository tests increased to 42 files and 331 items.

### Fixed

- Reading and writing the same file within one request was misjudged as an illegal upgrade, causing in-place batch edits to fail.
- Verification snapshots missed rewrites by external tools that preserved mtime and size.
- Verification queue time was not returned, so long-tail latency could not be attributed.
- PTC and direct tools cached the workspace root separately, which could resolve to different root paths in extreme cases.

## 0.3.1 - 2026-11-24

Completes PTC performance and boundary handling for file-intensive scenarios and removes local temporary paths from public benchmark data.

### Added

- `files.list` supports `offset` / `limit` / `nextOffset` pagination: up to 400 entries per page, so a flat directory of 500+ files can be enumerated completely.
- `files.search` returns `skippedLarge`: directory files over 1MB (a single file up to 2MB) are no longer skipped silently, and an actionable hint is given when the result is empty.
- PTC read-only body cache: reused by absolute path, mtime, and size, with recently written files forced to be re-read.
- Completes the PTC budget decision and validation recovery modules: when the budget is exhausted, three options are offered — continue / switch to direct tools / free input; static validation failures are auto-corrected twice before degrading.
- Adds PTC boundary, search, budget decision, and validation recovery tests covering pagination, 50 paths, the character cap, oversized files, path traversal, and cache invalidation.

### Changed

- `files.readMany` cap raised from 20 to 50; duplicate paths are read once, and reads internally use asynchronous bounded concurrency.
- `files.read`, `files.list`, and `files.search` now use asynchronous path resolution, with the workspace root resolved through realpath only once; directory search collects paths first, then reads bodies in chunks concurrently, avoiding synchronous stat blocking the main thread.
- PTC tool descriptions and the worker prompt are updated together: the old "at most 8 files at a time" constraint is removed, and pagination, the 50-path cap, the 24000-character result cap, and file-intensive task strategy are added.
- Repository tests increased to 32 files and 247 items.
- The local `workspace` field in benchmark JSON is uniformly redacted to `<benchmark-temp>`, and the benchmark generation script no longer writes real temporary paths.

### Fixed

- Search results with exactly 200 hits were incorrectly marked as `truncated`; now truncation is marked only when a 201st hit appears.
- Oversized files were skipped in directory search but returned 0 hits with no hint; this is now reported explicitly through `skippedLarge` and `hint`.
- Directory search blocked the main thread with per-file `statSync`; size filtering now moves down to the asynchronous read stage.

## 0.3.0 - 2026-11-23

Syncs with AgentProject's current optimized core, adding concurrent write locks, command scope, and verification scheduling, and updates the benchmark and documentation.

### Added

- `server/resource-locks.js`: reader-writer locks at file, directory, and workspace granularity, supporting writer priority, head-of-line skipping, timeouts, cancellation, and non-reentrancy detection.
- `server/command-scope.js`: infers command scope from `node --test`, `pytest`, `go test ./pkg/...`, and `tsc -p`, falling back to a workspace lock when it cannot tell; `planToolLocks` covers read-only, write, and command tools.
- `server/verify-scheduler.js`: merging of identical verifications, input version snapshots, stale-verification re-runs, per-workspace concurrency control, and result caching.
- `VersionStore`: records file version, size, modification time, and short hash so verification can tell whether inputs are stale.
- `docs/concurrency.md`: the semantics of locks, scope, and verification scheduling, integration examples, metrics, and caveats.
- Adds 3 test files; repository tests increased to 28 files and 224 items.

### Changed

- Syncs the current core's context window, turn policy, tool distillation, tool-result injection, PTC validation, and worker prompt implementations.
- Benchmark updated to short 10 turns, medium 30 turns, long 60 turns, and extra-long 100 turns, with 3 runs for the short group and 2 for the rest, totaling 820 turns across both variants; the previous five-group data is archived to `benchmark/data/legacy-2026-11-22/`.
- README, the integration guide, and the cache-stability document are aligned to the latest accounting basis; the public API adds exports for locks, scope, verification scheduling, turn policy, and tool injection.
- Version bumped to 0.3.0, adding `./locks`, `./scope`, and `./verify` subpath exports.

### Fixed

- Inferred scopes no longer cache verification results: inferred inputs can miss imported source files, and caching would misreport a failure as a pass; only explicit scopes may cache.
- Lock timeout timers no longer release references early, preventing the process from exiting when no other handles exist.
- Read requests can skip requests blocked by unrelated write locks while preserving writer priority, avoiding head-of-line blocking.

## 0.2.0 - 2026-11-23

Syncs with AgentProject's optimized core, completing the single-turn context engine and scheduling policy.

### Added

- Single-turn context assembly `buildTurnContext`: prefetch, cold facts, artifact index, and task memo are all appended after the stable prefix.
- Context prefetch: read body text only for explicit paths/symbols, otherwise provide only a workspace index; short-circuit by mtime/size/hash.
- Cold-fact extraction and earlier-turn reference detection, so confirmed information can be restored after window trimming.
- Artifact index and reuse decisions, avoiding repeated reads of the same artifact.
- Task signatures and memo hints, reusing the previous conclusion when the same task is requested again.
- Deterministic summaries of evicted turns, `createWindowContext`, and window recovery.
- Context policy `context-policy`: decides distillation, trimming, and degradation of old results based on the context ratio.
- Plan inlining `plan-inline` and destructive-plan detection.
- Sub-agent prompt and tool allowlist `worker-prompt`.
- Prefix-drift attribution `prefix-diff`, which locates the source of cache misses by turn.
- Scheduling policy `task-scheduler`: duration calibration, granularity checks, write-set mutual exclusion, soft deadlines, hedging, and reassignment.
- Orchestration metrics `orchestration-metrics` and benchmark cost estimation `benchmark-metrics`.
- Vendor cache-capability detection `supportsPrefixCache` / `cacheStrategyFor`.

### Changed

- Benchmark data updated to the five real 2026-11-22 groups (10 / 20 / 50 / 70 / 100 turns), and the control group changed to a traditional framework (native function calling + full history).
- Reports and benchmark scripts now price uniformly at official DeepSeek peak/off-peak rates: off-peak cache hit 0.02 / cache miss 1 / output 4, peak 0.04 / 2 / 8 (CNY / 1M tokens), with the tier locked at each run's start time; the custom unit prices in historical data are no longer used. The README and benchmark notes add the reason for pricing with DeepSeek usage only.
- History window defaults changed to a soft cap of 48 messages / 60k characters and a hard cap of 64 messages / 90k characters; when the character limit is exceeded, lagging trim by character interval is supported.
- `resolveTokenOpt` supports deriving the tool-result budget from the context window and adds `distillMinChars`, `distillPreviewChars`, `phase1OverflowTokens`, and `suppressMidRunCompaction`.
- `distillToolResult` adds `minChars` and `previewChars`; medium-sized results keep their original text to reduce read-back round-trips.
- `selectCompactionRange` supports `maxEndAbs`, so the current user turn is excluded from the compaction range.
- `normalizeCacheUsage` adds `cache_reported` to distinguish "0% hit" from "not reported by the vendor".
- PTC parsing, sandbox, spec, and tool layers are synced to the optimized implementation.

### Tests

- All 25 test files and 155 tests pass, adding tests for the context engine, scheduling policy, prefix attribution, orchestration metrics, and official peak/off-peak pricing.

## 0.1.0 - 2026-11-21

The first open-source core release.

### Added

- Lagging-trim history window, ensuring the request prefix is append-only between two trims.
- Stable serialization, tool-definition ordering, prefix hashing, and full request fingerprint.
- Tool-result distillation, secret redaction, persistence to disk, TTL, and read-back by line or JSON Path.
- PTC Programmatic read-only tool calling: AST validation, worker sandbox, typed API, audit trail, and state reuse.
- Normalization of multi-vendor cache fields and daily cache-hit logs.
- History fact compaction, compaction range selection, and net-benefit calculation.
- Public API aggregation entry `index.js`, supporting subpath imports.
- Minimal integration example and PTC example.
- Four groups of real model benchmark data, the report-generation script, and a pre-generated HTML report.
- Integration guide, cache-stability document, PTC design document, and Gitee release steps.

### Tests

- All 12 test files and 60 tests pass.

### Known limitations

- Contains only the core, not the web workbench or multi-agent orchestration.
- The benchmark control group runs only once in the medium, long, and extra-long groups.
- Extra-long conversation wall-clock time was still higher than the traditional approach, mainly due to read-back round-trips after distillation (as of 0.1.0; since 0.5.0 the extra-long group in the five-group benchmark is lower than the traditional approach).
- Fully verified only on Windows with Node 20.
