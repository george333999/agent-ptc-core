# Plan Gate (planGate) Mechanism

This document describes the design, decision conditions, execution flow, configuration, and measured results of the "plan gate" in `server/agent.js`. Full cost A/B data is in [plan-prompt-ab.md](plan-prompt-ab.md).

> This file documents the plan-gate implementation in the agent loop of the AgentProject main repository. This repository publishes the context-engine modules and does not include the `server/agent.js` agent loop; all code locations refer to paths in the main repository and are given for understanding and porting.

## 1. What it is

The plan gate means **the first turn of a complex task exposes only the plan tool**: the model first lists a 3–6 step plan with `todo_write`, and only then are real tools released. It consists of three coordinated parts:

| Component | Role | Code location |
| --- | --- | --- |
| Persistent todo instruction | A single line in the system prompt suggesting the model plan first for multi-step tasks | `server/agent.js` L951, L982-984 |
| First-step gate | At step 0, injects a "plan first" reminder and trims the tool set to `todo_write / ask_user / propose_plan` | `server/agent.js` L2057-2072, L2088-2093 |
| Recovery and wrap-up | Reminds once when the model builds no plan; reminds to wrap up when all plan items are complete | `server/agent.js` L2428-2432, L2081-2087 |

`settings.planGate = false` turns off all three parts, so it measures "the total cost of all plan-related prompts", not the cost of any single reminder.

## 2. Why it is needed, and why it is tiered

- **Why it is needed**: on long tasks the model tends to think while acting, skipping steps or wrapping up early; listing a plan first makes progress visible to the user and gives later steps a checklist to check against.
- **Why it is tiered**: the plan itself costs an extra model call and trims the tool set at step 0. For tasks just over the complexity line (3–4 points), this plan turn is often not worth it — the model could finish in one pass anyway.

The threshold was therefore moved from ">3 points" to "≥5 points": 3–4 points execute directly, and only 5 points and above force a plan first.

## 3. Decision chain

Whether step 0 triggers requires **all** of the following conditions (`agent.js` L2059):

```js
const planGateActive = agentGuardsEnabled
  && config.settings?.planGate !== false
  && !explicitDeliverable
  && shouldPlanFirst({
    step, complexTask,
    complexityScore: complexity.score,
    hasPlan,
    hasTodoTool: requestTools.some((tool) => tool?.function?.name === 'todo_write'),
    forcePptOptimize: step === 0 && canForcePptOptimize
  });
```

Explained one by one:

1. `agentGuardsEnabled`: `settings.agentGuards !== false`. The traditional control framework can disable guards as a whole.
2. `settings.planGate !== false`: enabled by default.
3. `!explicitDeliverable`: when the user already gave a deliverable path (`extractDeliverablePath(message)` matches, e.g. `reports/items-6.xlsx`), execute directly. **This is the main reason the gate rarely triggers in practice** — most current requests state the artifact path.
4. `shouldPlanFirst` (L540-554) then checks:
   - `complexTask` false → do not block. `complexTask = mode === 'agent' && complexity.tier === 'complex'`, and the `complex` threshold is 3 points (`server/task-complexity.js` L5-7, L83); Chat mode is never blocked.
   - `hasPlan` true → do not block. A plan already built this turn, or a continuation turn carrying unfinished todos, counts as having a plan.
   - `forcePptOptimize` true → do not block; the PPT optimization path is handled by a dedicated flow.
   - `!hasTodoTool` → do not block; without `todo_write` in the tool set the gate is meaningless.
   - Complexity score `< 5` → do not block.
   - Applies only to `step === 0`; later steps are released automatically.

## 4. Timing within one turn

```text
Step 0
  ├─ Evaluate planGateActive
  ├─ Append reminder: "System reminder: this is a multi-step task. The first step exposes only the plan tool..."
  ├─ Trim the tool set to todo_write / ask_user / propose_plan
  └─ Model call
        ├─ Called todo_write → planCreatedThisTurn = true
        │    Step 1: restore the full tool set, execute per the plan
        │    All plan items completed → append one "plan fully completed" wrap-up reminder
        └─ Did not call todo_write → inject one recovery reminder (at most once per turn)
              pendingPlanNudge: "System reminder: no plan has been built yet..."
              Full tool set restored from step 1
```

Related details:

- `planCreatedThisTurn` becomes true only when `todo_write` succeeds and writes a non-empty todo list (L3316-3319).
- The wrap-up reminder fires once only when a plan was built **this turn** and `isPlanComplete(session.todos)` is true, avoiding repeated nagging across turns.
- The recovery reminder is placed at the tail of the next turn's request, and `planNudgeUsed` ensures at most one per turn.

## 5. Complexity score and the impact of the threshold

`scoreTaskComplexity` returns `score` and `tier` from the message and attachments. Score distribution on the benchmark task set:

| Group | 3 points | 4 points | 5 points | 6 points | 7 points |
| --- | ---: | ---: | ---: | ---: | ---: |
| medium (50 turns) | 12 | 29 | 0 | 8 | 1 |
| long (70 turns) | 23 | 23 | 12 | 0 | 12 |
| xlong (100 turns) | 33 | 33 | 17 | 0 | 17 |

With a threshold of ≥5, the 4-point tasks — 23 turns in long and 33 in xlong — are no longer forced to plan first; 5/7-point tasks keep the previous behavior. medium is mostly 4-point tasks and is affected the most.

Note: the score is only a necessary condition; `!explicitDeliverable` must also pass. Most benchmark prompts include an artifact path, so far fewer turns actually trigger the gate than the table suggests.

## 6. Configuration

| Method | Usage | Effect |
| --- | --- | --- |
| Config field | `settings.planGate = false` | Disables the persistent todo instruction + first-step gate + both reminders |
| Benchmark flag | `node scripts/benchmark-turns.mjs --group=long --variant=opt --runs=1 --planGate=0` | Applies to the optimized variant only, for A/B |
| Default | Field omitted | Treated as enabled (`!== false`) |

Currently only a config-layer switch exists and it is not exposed in the frontend settings page; ordinary use need not care about it.

## 7. Relationship to history trimming

Plan tool calls (`todo_write` / `propose_plan`) are process records only:

- In the main repository implementation, these assistant messages are still sent to the model with the request, but `historyBudget` excludes them from the message-count/character budget (main repository `server/history-window.js` L49-77);
- The window benchmark records them on the same accounting basis (`server/window-context.js` L42-47), avoiding the chain of "plan message → triggers trimming → prefix rebuild";
- The `tool` result messages corresponding to plan calls still count toward the budget; they are usually only a few dozen bytes;
- Measured, this item has little effect on total cost (long cache misses 474k vs 488k baseline); it is kept because the risk is low, not because the gain is large.

See [compaction.md](compaction.md) for the full trimming and compaction decision logic (70% watermark, range selection, Phase 2 benefit inequality).

## 8. Measured results

Same kernel, long 70 turns / xlong 100 turns, DeepSeek off-peak price basis, single A/B run:

| Configuration | long cost | long steps | long accuracy | xlong cost | xlong steps | xlong accuracy |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| Baseline (threshold 3 points) | ¥0.9659 | 295 | 70/70 | ¥1.4468 | 440 | 100/100 |
| Threshold 5 points | ¥0.9261 | 278 | 70/70 | ¥1.5617 | 436 | 99/100 |
| Gate off + todo removed | ¥0.8386 | 305 | 70/70 | ¥1.0855 | 394 | 100/100 |

- Raising the threshold alone: long −4.1%, xlong +7.9%, within the same-day same-config variance band; this cannot be treated as a directional gain.
- Turning the gate off: long −13.2%, xlong −25.0%. The gain comes mainly from `todo_write` calls dropping from 24/34 to 0 once the persistent todo instruction is gone, not from the gate itself — the gate rarely triggers in this batch of tasks that carry deliverable paths.
- The only xlong failure is the Excel artifact check at turn 6, which happens before any trimming and with the gate not active, unrelated to the plan configuration.

## 9. Typical behavior

| Scenario | Blocked? | Reason |
| --- | --- | --- |
| 5 points + "generate reports/x.xlsx" | No | `explicitDeliverable` is true |
| 5 points + no path | Yes | Complex with an unclear deliverable; worth planning first |
| 4 points + no path | No | Under the new threshold 4 points executes directly (the old threshold would block) |
| Any task in Chat mode | No | Only agent tasks are constrained |
| Continuation with unfinished todos | No | `hasPlan` is true |
| todo_write already called this turn | No | The gate applies to step 0 only |

## 10. Known costs and tuning advice

- **A restricted first step can add a turn**: if the model ignores the reminder and calls another tool, it only finds the tool missing and retries, costing an extra call. The recovery reminder mitigates this, but the cost remains.
- **Reminders are appended at the request tail**: this changes the tail cache block, and the effect on prefix cache hits is concentrated in the first step of that turn.
- **Do not raise the threshold further**: if 6–7 point tasks are also not forced to plan, steps are easily lost on long tasks; lowering it returns to the old problem of "one extra turn for simple complex tasks".
- **Check the distribution before tuning**: use `scoreTaskComplexity` to count the score distribution in the target scenario, then choose the threshold; do not rely on a single A/B ratio.
- **Do not confuse the switch semantics**: `planGate = false` means "turn off all plan prompts", not "only disable first-step tool trimming".

## 11. Tests and code index

Related tests (all in the main repository):

- `test/unit/agent-guard.test.js`: boundaries of `shouldPlanFirst` (4 points not blocked, 5 points blocked, an existing plan or todo not blocked, etc.).
- `test/unit/history-window.test.js`: `historyBudget` and the trimming-threshold accounting basis.
- `test/integration/agent-ptc-budget-guard.test.js`: interaction between the gate and the PTC budget guard.

Code index (main repository):

| Item | Location |
| --- | --- |
| `shouldPlanFirst` | `server/agent.js` L540-554 |
| `isPlanComplete` | `server/agent.js` L535 |
| Conditional system prompt output | `server/agent.js` L951, L982-984 |
| Complexity and explicit-deliverable detection | `server/agent.js` L1566-1570 |
| Gate decision and reminders | `server/agent.js` L2057-2072 |
| Tool set trimming | `server/agent.js` L2088-2093 |
| Wrap-up reminder | `server/agent.js` L2081-2087 |
| Recovery reminder | `server/agent.js` L2428-2432 |
| `planCreatedThisTurn` | `server/agent.js` L3316-3319 |
| Plan message budget accounting | `server/history-window.js` L49-77 |
| Window benchmark on the same basis | `server/window-context.js` L42-47 |
| Benchmark switch | `scripts/benchmark-turns.mjs` L93 |

## 12. Changelog

- 2026-11-25: Added the `settings.planGate` switch (enabled by default, no behavior change); forced-plan threshold 3 points → 5 points; plan-type assistant messages excluded from the history trimming budget; the benchmark script supports `--planGate=0`.
