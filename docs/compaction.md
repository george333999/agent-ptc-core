# Context Compaction (Dynamic Compaction) Decision Rationale

This document explains the logic that decides when context compaction runs and when it does not, along with the origin of each threshold and where to tune it.

> This repository contains the compaction modules `history-compact.js`, `token-opt.js`, `history-window.js`, `context-policy.js`, and `context-guard.js`; the call sites in `server/agent.js` (piggyback after trim, 98% emergency fallback) and `server/compaction-log.js` reside in the AgentProject main repository, and the corresponding places are marked in the text.

## 1. In One Sentence

Compaction **only runs as a piggyback when the window already has to be trimmed**, and must pass six gates in order: final phase, the 70% watermark (measured on the pre-trim size), projected overflow, minimum size, compressible range, and summary budget. Standalone compaction (Phase 2) is off by default.

## 2. Two Layers: Trim and Compaction

| Layer | Role | When it happens | Implementation |
| --- | --- | --- | --- |
| Trim (history window) | Shortens overly long history | The window exceeds the hard limit and the lag interval is met | `server/history-window.js` |
| Compaction | Replaces old messages with a factual summary, retaining retrievable information | Only when a trim happens (Phase 1), or a standalone evaluation passes (Phase 2) | `server/history-compact.js` |

The core reason for separating them: a trim inevitably rebuilds the request prefix, so hanging compaction onto that rebuild point does not create an **extra** cache invalidation; if compaction decided its own timing, every compaction would break the prefix cache.

## 3. Prerequisite: Conditions That Trigger a Trim

`historyLimitsForContext` derives the character limits from the context window (`server/history-window.js`):

- `hardChars = max(150000, window × 0.97 × 2.5)`, `softChars = hardChars × 0.5`;
- At a 128k context this is about a hard limit of 310,400 characters and a soft limit of 155,200 characters; the message-count limits are 600 / 1200.

`shouldTrimHistory` uses **lagging trim**: after the hard limit is exceeded, it waits until the character count has grown by `hardChars − softChars` since the last trim before actually trimming. This keeps the request prefix between two trims append-only, instead of sliding the window every step.

`shouldTrimAtStep` further constrains the timing within a turn: `step 0` (the turn boundary) may trim normally; within a turn, emergency trimming is allowed only when context usage is ≥97%.

> Accounting basis: `historyBudget` excludes assistant messages that contain only `todo_write / propose_plan`, but the corresponding `tool` results are still counted; the window baseline is recorded on the same basis.

## 4. Phase 1: Piggyback Compaction (On by Default)

`planPiggybackCompaction` evaluates the checks in order; the first one that fails causes a skip and the reason is recorded:

| Order | Condition | reason when not met |
| --- | --- | --- |
| 0 | Not in the final phase (`finalPhase === false`) | `finalPhase` |
| 1 | `tokenOpt.phase1` enabled | `disabled` |
| 2 | Window tokens ≥ the tier minimum: long 20,000 / short 10,000 / type undetermined max(10,000, 12,000) | `tooSmall` |
| 3 | Window tokens ≥ `minHistoryTokens` (default 5,000) | `belowFloor` |
| 4 | Overflow watermark: prefer the caller-supplied `contextTokens` (full pre-trim history size), falling back to window tokens when absent; must be ≥ `phase1OverflowTokens` (when not explicitly configured, `applyRoundPolicy` fills it with **70%** of the context window; about 89,600 at 128k) | `belowOverflow` |
| 5 | No in-run lease is enabled, or the overflow watermark has been reached (`suppressMidRunCompaction` is off by default) | `midRunLease` |
| 6 | Predictive skip: within a turn (`usedSteps > 0`), when the hard limit is known and `predictiveCompaction !== false`, extrapolate from "window tokens + per-step increment × estimated remaining steps"; if `projected × predictiveSafety < hardLimitTokens`, the turn is not projected to hit the ceiling, so compaction is deferred to the next trim | `projectedNoOverflow` |
| 7 | A compressible range can be selected: from the end of the last coverage to the **most recent user message**, with a target saving of `phase1TargetRatio` (default 50%) and a minimum saving ratio of 30% | `noRange` |
| 8 | The range's original text ≥ `minRangeTokens` (default 5,000) | `rangeTooSmall` |
| 9 | Summary ≤ `max(original text × summaryRatio, summaryFloorTokens)` (default 0.15 / 1,200) | `qExceeds` |
| 10 | The summary is actually smaller than the original text | `netNegative` |

Three key corrections:

- **No compaction in the final phase**: `finalPhase` skips only piggyback compaction; history trimming still runs as usual. The wrap-up phase adds no new tools, so compaction would only create one extra prefix rebuild and could lose details the final answer needs.
- **The watermark uses the pre-trim size**: a trim cuts down to the soft limit (about half the hard limit), so judging by the residual window after a trim would never reach the watermark; the caller must pass `contextTokens`.
- **Predictive skip applies only within a turn**: at the turn boundary (`usedSteps = 0`) it is unknown how many steps the turn will take, so the watermark check still applies, avoiding a misjudgment at the start of a turn.

## 5. Phase 2: Standalone Compaction (Off by Default)

Additional conditions for `planStandaloneCompaction`:

| Condition | Default |
| --- | --- |
| `tokenOpt.phase2` enabled | default `false` |
| Task type determined (not pending) | — |
| ≥ `minStepsBetweenCompactions` since the last compaction | 5 steps |
| Evaluation interval `phase2IntervalSteps` | every 10 steps |
| Window tokens ≥ `phase2MinTokens` | 30,000 |
| Range and summary checks | same as Phase 1 items 6–8 |

After passing these checks, the forward-looking benefit inequality must also hold:

```text
(original text tokens − summary tokens) × remaining steps  >  tokens after the compaction point × (cache-miss price / cache-hit price − 1)
```

- The left side is the tokens repeatedly saved across the remaining steps; the right side is the cost of rebuilding the prefix this one time;
- The price ratio `k` is derived from the configured prices by default (default 50);
- `remaining steps` prefers the median of comparable tasks, falling back to "steps already used" when unavailable. **The current caller does not pass `typeMedianSteps`, so the fallback is always taken**, which makes this estimate conservative.

`resolveRoundPolicy` also classifies by user-message count: fewer than 20 is short, 20–40 is medium, more than 40 is long; medium and long conversations **force Phase 2 off**, to avoid repeatedly breaking the prefix cache on the critical path.

## 6. Skip Reasons Quick Reference

| reason | Meaning | Common tuning direction |
| --- | --- | --- |
| `finalPhase` | The wrap-up phase has begun; piggyback compaction is skipped (trimming still runs as usual) | Usually no adjustment needed; emergency over-limit is still handled by the context guard |
| `belowOverflow` | The pre-trim context size has not reached the 70% watermark | Lower `phase1OverflowTokens` to compact earlier |
| `projectedNoOverflow` | The in-turn projection says the hard limit will not be hit, so compaction is deferred | Lower `predictiveSafety` to compact more aggressively; disable `predictiveCompaction` to return to pure watermark checks |
| `tooSmall` / `belowFloor` | The window is too small | Usually no adjustment needed; these are safeguards |
| `noRange` / `rangeTooSmall` | The compressible range is insufficient | Check `minSavedRatio`, `minRangeTokens` |
| `qExceeds` | The summary cannot be compressed to the target length | Adjust `summaryRatio` / `summaryFloorTokens` or the summary template |
| `netNegative` | The summary is not smaller than the original text, or (Phase 2) the inequality does not hold | Shorten the summary, reduce `afterTokens` |
| `midRunLease` | An in-run lease blocks compaction | Only occurs when `suppressMidRunCompaction` is enabled |
| `recentCompaction` | Too soon since the last compaction (Phase 2) | Adjust `minStepsBetweenCompactions` |

These events are all persisted by `recordCompactionEvent` (`server/compaction-log.js`, in the main repository), so the distribution of reasons can be counted directly to tune thresholds.

## 7. Emergency Path

- On a context-length error, `planContextOverflow` decides whether to degrade, trim, or compact (`server/context-guard.js`).
- When in-turn context usage is ≥98%, the oldest tool results are first degraded to short summaries (keeping the most recent 4, 800 characters each), and only then is trim/compaction considered (`server/context-policy.js`).
- The final phase (`finalPhase`) skips only piggyback compaction; history trimming and the 98% emergency fallback still run as usual. This avoids a pointless compaction during the wrap-up while keeping the "never exceed the limit" safety net.

## 8. Configuration (`settings.tokenOpt`)

| Key | Default | Role |
| --- | --- | --- |
| `phase1` | `true` | Master switch for piggyback compaction |
| `phase2` | `false` | Master switch for standalone compaction |
| `suppressMidRunCompaction` | `false` | Disables compaction within a turn (except when the overflow threshold is reached) |
| `phase1OverflowTokens` | `0` (filled by `applyRoundPolicy` with 70% of the window) | Phase 1 watermark |
| `predictiveCompaction` | `true` | Projects the remaining context within a turn from steps used, skipping compaction when overflow is not expected |
| `predictiveSafety` | `1.1` | Predictive safety factor; >1 means skipping only when overflow is clearly impossible |
| `phase1TargetRatio` | `0.5` | Share of history covered by a single compaction (by characters); larger means fewer but heavier compactions |
| `phase1MinTokens` / `phase1MinTokensShort` | 20,000 / 10,000 | Tiered minimum window |
| `minHistoryTokens` | 5,000 | Global minimum history |
| `phase2MinTokens` | 30,000 | Phase 2 minimum window |
| `phase2IntervalSteps` | 10 | Phase 2 evaluation interval |
| `minStepsBetweenCompactions` | 5 | Minimum interval between two compactions |
| `minRangeTokens` | 5,000 | Lower bound of the compressible range |
| `minSavedRatio` | 0.3 | Minimum saving ratio |
| `summaryRatio` / `summaryFloorTokens` | 0.15 / 1,200 | Summary length ceiling |

## 9. Measured Results and Boundaries

Long-conversation run with default configuration (70 turns, deepseek-chat, 128k window):

| Metric | Result |
| --- | --- |
| Compaction evaluations / applied | 3 / 3 |
| Tokens saved | 89,671 (cache hit 89,298 / cache miss 373) |
| Cache hit | 97.2% |
| Accuracy | 100% |

Forced-trim control (60k history budget, used only to validate compaction itself, not a default configuration):

| Configuration | Wall-clock | Token | Cost (off-peak price) | Accuracy | Hit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Phase 1 on | 696.9s | 5.59M | ¥0.8873 | 98.6% | 92.8% |
| Phase 1 off | 722.8s | 5.68M | ¥0.9897 | 98.6% | 92.0% |

With compaction on, tokens are 1.6% lower, cost is 10.4% lower, and wall-clock time is 3.6% lower. The benefit comes mainly from fewer cache-miss input tokens being sent; when the history budget is ample and trims are rare, the compaction count drops naturally and the mechanism yields to prefix stability.

Strengths:

1. Compaction does not create rebuild points on its own, so it is cache-friendly;
2. Skipping in the final phase and when overflow is not projected reduces unproductive compactions;
3. The watermark is judged on the pre-trim size, so it is not unreachable after a trim;
4. The 70% watermark plus lagging trim avoids repeated compaction at low usage;
5. Phase 2 uses a price inequality of "repeated benefit vs one-time rebuild" rather than looking only at token counts;
6. Every skip reason is logged, providing the basis for closed-loop tuning.

Weaknesses:

1. **Predictive skip depends on remaining-step estimates**: without a median for comparable tasks it remains conservative;
2. **Phase 1 does not price the summary as additional input tokens or weigh the risk of information loss**, only limiting its length;
3. **Thresholds are still mostly fixed values** (70%, 20k/10k, 0.3) and do not vary with task type, model window, or actual unit prices;
4. **`typeMedianSteps` is still not passed by some callers**, so Phase 2's remaining-step estimate degrades to "steps already used";
5. The `chars / 2.5` token estimate runs high for English and code, which can trigger compaction early.

### 9.1 Risk Assessment of Proposed Improvements (No Code Changed)

Premise: the compaction summary is a **deterministic fact sheet** and does not trigger additional LLM calls. The proposals below therefore have little effect on wall-clock time; the real impact is on **cache-miss tokens, cache-hit rate, and cost**. Current hit rates for long and very long conversations are around 97%, and a 0.3pp hit loss corresponds to roughly a 7%–10% cost increase (the cache-miss unit price is 50× the cache-hit price), so acceptance must look at cost and hit rate first, not just at lower total token counts.

| Proposal | Affects default config | Expected benefit | Main risk | Prerequisite for landing |
| --- | --- | --- | --- | --- |
| 1. Extend predictive skip to the turn boundary | Yes | One fewer compaction, less information loss | The projection underestimates and the run goes long, hitting the ceiling again and requiring another trim/prefix rebuild; the cache loss from one wrong skip is usually more expensive than one extra compaction | Stable `typeMedianSteps`, a variance threshold, and a shadow-mode run first |
| 2. Phase 1 minimum-benefit threshold | Yes | Skips low-value compactions; cost stays flat or drops | The window grows, possibly triggering the next trim earlier; hit-rate volatility | Price the summary as additional cache-miss input and include the next trim's cost; same-window A/B |
| 3. Take the hit rate as the median of the last N runs and derive `k` from the real billing prices | No (Phase 2 is off by default) | Reduces erroneous compaction caused by noise | Applies only to users who enable Phase 2 manually; the median is distorted when samples are insufficient | Keep Phase 2 off by default; use real prices and recent samples |
| 4. Fill in the statistics source for `typeMedianSteps` | No (Phase 2 is off by default) | Improves the remaining-step estimate and provides the data foundation for proposal 1 | Task misclassification, stale historical data | Offline aggregation, bucketing by task type, fallback when stale |
| 5. Calibrate the 70% watermark to the actual task distribution | Yes | Reduces overflow trims for fast-growing tasks and avoids premature compaction for stable tasks | Misclassification leads to frequent trims or an oversized window, directly affecting cache hits and cost | Collect the distribution first; keep the 70% fallback; same-window A/B by long/xlong |

**Recommended landing order**: 4 (data foundation) first → 3 (affects only Phase 2, lowest risk) → 2 (most likely to reduce cost) → 5 (calibrate by distribution) → consider 1 last. For each step, first use shadow mode to record whether compaction or trimming would have happened, confirm that trim counts and cache-miss tokens do not increase, and then run same-window ABBA.

**Acceptance thresholds**:

- Cost drops or stays flat;
- Cache-hit rate drops by no more than 0.2pp;
- Accuracy does not drop;
- P95 wall-clock time does not worsen;
- Trim count and compaction count are not above the baseline;
- If any condition fails, revert; it does not enter the default configuration.

## 10. Code Index

| Content | Location |
| --- | --- |
| Trim limits and lag | `server/history-window.js` (`historyLimitsForContext`, `shouldTrimHistory`, `historyBudget`) |
| In-turn trim timing | `server/context-policy.js` (`shouldTrimAtStep`) |
| Phase 1 decision | `server/history-compact.js` (`planPiggybackCompaction`) |
| Final phase and predictive skip | `server/history-compact.js` (the `finalPhase` / `predictiveCompaction` branches of `planPiggybackCompaction`) |
| 70% watermark filling and tiering | `server/token-opt.js` (`applyRoundPolicy`) |
| Phase 2 decision | `server/history-compact.js` (`planStandaloneCompaction`) |
| Range selection | `server/history-compact.js` (`selectCompactionRange`) |
| Net benefit and remaining steps | `server/history-compact.js` (`computeNetBenefit`, `estimateRemainingSteps`) |
| Thresholds and tiering | `server/token-opt.js` (`resolveTokenOpt`, `resolveRoundPolicy`, `applyRoundPolicy`) |
| Emergency fallback | `server/context-guard.js`, `server/context-policy.js` |
| Call sites (piggyback after trim, 98% fallback) | the main loop of `server/agent.js` in the main repository |
| Event log | `server/compaction-log.js` in the main repository |

## 11. Change Log

- 2026-11-25: Added this document, recording the existing dynamic-compaction decision logic, thresholds, and tuning entry points.
- 2026-11-26: Added the final-phase skip (`finalPhase`), the pre-trim size watermark (`contextTokens`), and the predictive skip (`projectedNoOverflow`); added measured data for the default run and the forced-trim A/B; synced `history-compact.js`, `token-opt.js`, and 3 unit tests to the open-source repository.
