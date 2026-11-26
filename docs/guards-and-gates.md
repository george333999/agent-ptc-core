# Guards and Gates: Which Mechanisms Block Errors and Which Block Unprofitable Operations

This document collects the guards and gates scattered across modules and answers three questions for each: **what it blocks, when it blocks, and how it degrades when it cannot block**.

> Guards and gates are not locks. Locks solve mutual exclusion, i.e. concurrent writes to the same resource overwriting each other; guards address "the result cannot be trusted or the task is not really complete"; gates address "is this worth doing at all". The three often appear together but have different responsibilities.

## 1. At a Glance

| Name | Type | Trigger point | When not satisfied | Code | Details |
| --- | --- | --- | --- | --- | --- |
| Task contract self-check | Guard | Before a complex task starts | When completion criteria are missing, accept against `expectedOutput` and mark `partial` | `server/task-contract.js` | §3.1 in this document |
| Deliverable guard | Guard | At the end of each turn | Keeps reminding until the real artifact is written to disk; writing only a script does not count as done | `server/deliverable.js` | §3.2 in this document |
| Context guard | Guard | The vendor returns a context over-limit error | Tightens the view to the real limit and retries; if it still fails, returns a readable error | `server/context-guard.js` | §3.3 in this document |
| Plan gate | Gate | Agent step 0 | For complex tasks, expose only plan tools first, then release the real tools | main repo `server/agent.js` | [plan-gate.md](plan-gate.md) |
| Compaction gate | Gate | History trim point | Compacts only after passing the 70% watermark, final phase, projected overflow, range, and summary checks | `server/history-compact.js` | [compaction.md](compaction.md) |
| PTC static validation recovery | Guard | `ptc_run` syntax validation fails | The first 2 attempts get error correction with line numbers; the 3rd degrades to direct read-only tools | `server/ptc/validation.js`, `server/ptc/ast-validator.js` | [ptc.md](ptc.md) |
| PTC budget decision | Gate | A single `ptc_run` exhausts its 100 calls | Lets the user choose whether to continue with PTC, switch to direct calls, or add requirements | `server/ptc/budget-decision.js` | [ptc.md](ptc.md) |
| Write guard | Guard | `write_file` / `edit_file` | Hard limit of 8000 characters per write; 12000 characters is treated as truncation; rewriting identical content returns `unchanged`; at most 3 versions per script | main repo `server/agent.js` and the tool layer | §3.4 in this document |
| Tool scheduling barrier | Guard | Multiple tool calls in the same turn | Approvals, unknown commands, unknown tools, and version scripts act as barriers, so concurrency cannot bypass them | `server/tool-scheduler.js` | [concurrency.md](concurrency.md) |
| Stale-verification re-run | Guard | Inputs are modified while verification runs | Re-runs at most 2 times; if inputs still change, marks stale so old conclusions are never treated as a pass | `server/verify-scheduler.js` | [concurrency.md](concurrency.md) |
| Orchestration-economics gate | Gate | Before launching parallel sub-agents | Refuses parallelism and falls back to serial when the projected speedup is insufficient or the token-increment benefit is negative | `server/orchestration-economics.js` | §3.5 in this document |
| Short-session PTC gate | Gate (not enabled) | Projected ≤10 turns and ≤2 small files in the first turn | The plan is to switch to native read-only tools; currently not enabled, to avoid session stickiness affecting medium and long tasks | main repo `resolveTurnToolMode` | [ptc.md](ptc.md) |
| Idle-spin and repeated-call guard | Guard | Consecutive failures, repeated calls, incrementing reads, repeated writes | Stops tool calls first and gives the model a chance to wrap up; enters a recovery flow when necessary instead of throwing | main repo `server/agent.js` | §3.6 in this document |

## 2. Execution Order

```text
User message
  → Task contract: pin down the real goal and completion criteria
  → Plan gate: list a 3–6 step plan first for complex tasks
  → Single-turn context: prefetch, cold facts, artifact index, task memo
  → Model returns tool calls
      → Tool scheduling barrier: approvals / unknown commands / version scripts go serial first
      → Resource lock: three-level mutual exclusion for files, directories, and the workspace
      → Execute tool
      → PTC validation and budget: syntax correction, call-budget decision
  → Deliverable guard: check whether the product the user asked for actually exists
  → Verification scheduling: stale-verification re-run when inputs change, merge identical verifications
  → Final answer
```

When a guard fails there are only three outcomes: **block** (approvals, lock conflicts, PTC syntax errors), **repair** (error correction, stale-verification re-run, idle-spin recovery), or **degrade** (retry after compacting on a context over-limit, switch to direct calls after a PTC failure). Silent passes are not allowed.

## 3. Item-by-Item

### 3.1 Task Contract Self-Check

**What it blocks**: misreading the task goal, missing completion criteria, and sub-agents drifting apart on their own assumptions.

**How it works**: on complex tasks the main agent answers five fixed questions (real goal; knowns/unknowns/assumptions; most likely failure point; method trade-offs; next step and delegation), normalizes the completion criteria and key assumptions, and distributes them to sub-agents. The self-check block is appended only to the tail of the current user message and does not modify the system/tools prefix. Sub-agents no longer ask themselves and merely consume the contract.

**Degradation**: when there are no completion criteria, use `expectedOutput` as the acceptance standard and mark the task `partial` rather than pretending it is complete.

### 3.2 Deliverable Guard

**What it blocks**: the user wants an Excel file but the model only writes a generation script; the user specifies `reports/items.xlsx` but the model writes to another path; the model deletes the artifact after generating it.

**How it works**: it recognizes only the target fragment after an action verb; for example, "read a.xlsx and convert to csv" requires only csv, so an input file is not mistaken for a deliverable. It supports xlsx/pptx/docx/pdf/csv/html/json and extracts the output path specified by the user. Once a tool successfully writes to disk, completion is marked by extension; if not satisfied, it keeps reminding.

**Results**: in a same-window ABBA long conversation, the traditional version's run at 03:41 had all 11 Excel tasks follow "generate xlsx → convert to CSV → delete xlsx", leaving deliverables missing and accuracy at only 84.3%; the optimized version reached 99.3% in the same window. This was not a benchmark-script misjudgment but a real failure caused by the absence of a deliverable guard.

### 3.3 Context Guard

**What it blocks**: requests exceeding the vendor's context limit that return a 400 outright, making a long task fail at the last moment.

**How it works**: it recognizes `maximum context length` errors, parses the real limit from the error text, compresses the request view to a 70% target, and retries; when retries are exhausted or there is nothing compressible, it returns a readable error.

**Boundaries**: it is the last-resort safety net and does not replace the history budget or dynamic compaction; compaction loses detail, so it should rarely happen on the normal path.

### 3.4 Write Guard (Main Repository)

**What it blocks**: half-written files, repeated full rewrites, oversized single outputs that truncate JSON, and unlimited versions of the same script.

**How it works**:

- A temporary file plus `rename` for atomic replacement, with rollback on failure; both `write_file` and `edit_file` take the same path.
- When the content to write is identical to the existing file, it returns `unchanged` directly without writing to disk again; only 4 consecutive identical writes trigger a stop.
- A single write over 8000 characters is rejected outright, with a hint to segment using `append: true`; a single call whose arguments exceed 12000 characters is treated as truncated model output and is no longer retried as an ordinary JSON error.
- The same script body may have at most 3 versions in a turn; the 4th is blocked and enters the recovery flow.

**Boundaries**: these rules live in the agent loop and tool layer of the AgentProject main repository; the extracted kernel contains only locks, scheduling, and deliverable modules, not the `write_file` implementation.

### 3.5 Orchestration-Economics Gate

**What it blocks**: "parallelism for its own sake" — tasks split too finely, overlapping write sets, and prefix construction costing more than the time saved.

**How it works**: before launching workers it estimates the speedup ratio and the token increment; by default it is advisory only (`advisory`), and only under `mode: 'enforce'` does it return `allowed: false` when the trade is unprofitable. Write-set exclusion, soft deadlines, and hedging are coordinated by `task-scheduler.js`.

**Boundaries**: the benefit depends on calibration against historical durations; without history the estimate is conservative.

### 3.6 Idle-Spin and Repeated-Call Guard (Main Repository)

**What it blocks**: repeated calls with the same tool/arguments, reads that increment line by line, repeated full rewrites of the same file, and consecutive command failures.

**How it works**: on the 3rd repetition it prompts the model not to repeat; on the 5th it stops and enters the recovery flow. Once idle spinning is detected it does not throw immediately but first stops tool calls, gives the model one chance to wrap up, and finally returns a normal result containing the stop reason, files generated, failure information, and suggested next steps.

**Boundaries**: the guard only limits the damage; it does not make the task correct. The recovery flow still has to genuinely produce the deliverable.

## 4. Why Guards and Gates Are Separate

- **Guards are a correctness problem**: when the result cannot be trusted, it must be blocked, repaired, or degraded — never silently passed.
- **Gates are an economics problem**: the operation is possible but not worth doing; refusing or deferring does not make the result wrong.
- Both must be **cache-friendly**: reminders are appended only to the tail of the current user message and never rewrite system/tools; checks are idempotent and remind at most once per turn.
- Both must be **observable**: the plan gate records trigger/skip reasons, compaction records `belowOverflow / projectedNoOverflow / finalPhase`, the deliverable guard records gaps, and verification scheduling records stale cases and re-run counts.

## 5. Known Boundaries

1. The extracted kernel does not contain the main repository's `server/agent.js` agent loop, so the plan gate, write guard, and idle-spin guard are **reference implementations and documentation**, not logic enforced by the npm package.
2. The deliverable guard covers only common formats and action verbs; highly colloquial requests or ones that omit the target still need caller-supplied rules.
3. The plan gate depends on a complexity score; when the user has already given an explicit artifact path, it executes directly, which is the normal reason the gate rarely triggers.
4. Dynamic compaction cannot judge information value; it only controls the watermark, size, range, and summary length. The final-phase and predictive skips reduce unproductive compaction but cannot eliminate the risk of information loss.
5. The short-session PTC gate is currently not enabled; its absolute benefit is about ¥0.017 per 10-turn session, a lower priority than reducing LLM round trips and keeping the prefix stable.

## 6. Code and Test Index

| Content | Code | Test |
| --- | --- | --- |
| Task contract | `server/task-contract.js` | `test/task-contract.test.js` |
| Deliverable guard | `server/deliverable.js` | `test/deliverable.test.js` |
| Context guard | `server/context-guard.js` | `test/context-guard.test.js` |
| Compaction gate | `server/history-compact.js` | `test/history-compact.test.js`, `test/history-compact-simulation.test.js` |
| PTC budget decision | `server/ptc/budget-decision.js` | `test/ptc-budget-decision.test.js` |
| PTC validation recovery | `server/ptc/validation.js`, `server/ptc/ast-validator.js` | `test/ptc-recovery.test.js` |
| Tool scheduling barrier | `server/tool-scheduler.js` | `test/tool-scheduler.test.js` |
| Stale-verification re-run | `server/verify-scheduler.js` | `test/verify-scheduler.test.js` |
| Orchestration-economics gate | `server/orchestration-economics.js` | `test/orchestration-economics.test.js` |
| Turn and wrap-up budget | `server/limits.js` | `test/limits.test.js` |
