# Cost Impact of Plan Prompts and the Plan Gate (A/B Record)

> Conclusion first: on this benchmark the cost difference comes mainly from the **persistent todo instruction** in the system prompt, not from the **plan gate** that "exposes only the plan tool in the first step". Raising the forced-plan threshold from 3 to 5 points yielded almost no net gain (long −4.1%, xlong +7.9%, within single-run variance); fully disabling the plan gate and removing the todo instruction cut long cost by 13.2% and xlong by 25.0%, with accuracy staying at 100%. But the sample consists of structured one-off delivery tasks, so changing the default behavior on this basis is not recommended for now.

## 1. Two concepts

There are two plan-related behaviors in the kernel, often conflated:

1. **Persistent todo prompt**: a line in the system prompt, sent with every request each turn, suggesting the model plan proactively.

   ```text
   - For multi-step tasks, first list a 3-6 step plan with todo_write; mark each item completed when
     done, and once all are complete, immediately consolidate the output without adding unrelated steps.
   ```

2. **Plan gate**: a temporary constraint active only at step 0 of a complex task — appends a user reminder that "the first step exposes only the plan tool" and temporarily exposes only `todo_write / ask_user / propose_plan`; when the model builds no plan it also appends a "no plan has been built yet" reminder. Trigger conditions include: agent guards enabled, the task classified as complex, no plan built yet, and the user **not** giving an explicit deliverable path (`explicitDeliverable` false).

`settings.planGate = false` (benchmark flag `--planGate=0`) removes both at once: it no longer emits the persistent todo instruction, and it no longer trims tools or appends plan reminders at step 0. The switch therefore measures "the total cost of plan-related prompts", not the gate cost alone.

> Note: this file records an experiment in the AgentProject main repository; the current open-source kernel has not yet merged the `planGate` switch or the threshold change and still keeps the default plan behavior. See [plan-gate.md](plan-gate.md) for the gate's decision chain, timing, and configuration.

## 2. Benchmark setup

- Model `deepseek-chat`, agent mode, real tool calls; a fresh workspace per group, and artifacts validated by file content.
- long 70 turns, xlong 100 turns; each configuration run once.
- Costs use the DeepSeek off-peak price basis (CNY per 1M tokens: cache hit ¥0.02 / cache miss ¥1 / output ¥4); table values are total cost for the whole group.
- Three configurations: baseline (threshold 3 points), threshold raised only (5 points), gate off with the todo instruction removed.

## 3. Results

**long (70 turns)**

| Configuration | Steps | Cache-miss tokens | Miss per step | Output tokens | Cost | Time | Accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Baseline (threshold 3 points) | 295 | 488,226 | 1,655 | 67,085 | ¥0.9659 | 456.9s | 70/70 |
| Threshold 5 points | 278 | 473,902 | 1,705 | 64,231 | ¥0.9261 | 463.9s | 70/70 |
| Gate off + todo removed | 305 | 337,649 | 1,107 | 70,989 | ¥0.8386 | 504.9s | 70/70 |

**xlong (100 turns)**

| Configuration | Steps | Cache-miss tokens | Miss per step | Output tokens | Cost | Time | Accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Baseline (threshold 3 points) | 440 | 742,017 | 1,686 | 97,493 | ¥1.4468 | 669.7s | 100/100 |
| Threshold 5 points | 436 | 805,243 | 1,847 | 106,731 | ¥1.5617 | 700.0s | 99/100 |
| Gate off + todo removed | 394 | 442,839 | 1,124 | 90,789 | ¥1.0855 | 707.4s | 100/100 |

Cost change versus baseline: threshold 5 points gives long −4.1% and xlong +7.9%; gate off gives long −13.2% and xlong −25.0%.

## 4. Mechanism reading

- **The gate rarely triggers in this batch.** Most benchmark prompts specify the deliverable path explicitly (e.g. `reports/verify-1.md`, `reports/items-6.xlsx`), so `explicitDeliverable` is true and the gate condition fails. Checking the six base prompts one by one, only `reports/stats-3.json` was not recognized as a deliverable path, and its complexity is 4 points — the baseline triggers the gate there, and threshold 5 points no longer does.
- **todo calls come from the persistent instruction, not the gate.** In the baseline, `todo_write` calls for long / xlong are 24 / 34; raising the threshold to 5 points leaves them at 24 / 34; turning the gate off and removing the todo instruction drops them to 0. This explains why "raising the threshold only" saves almost nothing: the model still plans on its own following the system prompt.
- **Cache-miss tokens are the main cost item.** With the gate off, misses per step drop from about 1.66k to about 1.11k: there are fewer extra model calls from plan steps, and plan messages occupy less of the history window; but cache-hit tokens cost only ¥0.02 per million, so their volume does not make up a major cost either way.
- **The threshold-5-point difference is noise.** In same-day same-config baseline runs, long misses varied between 488k and 699k, and xlong was in the 400k–800k range; this run's +7.9% does not support a directional conclusion.
- **xlong's 99/100 is unrelated to the plan configuration.** The failure is the Excel artifact check at turn 6: that turn occurs before any history trimming, the prompt specifies the path explicitly, and the gate is not active; the same turn passes in both the baseline and gate-off configurations.

## 5. Conclusions and recommendations

- **Keep the todo prompt as the default.** A plan is a user-visible progress feature and is more valuable for real multi-turn tasks with vague goals that need mid-course adjustment; this benchmark cannot capture that benefit.
- **Keep the ≥5 threshold.** It removes the artificial "first step exposes only the plan tool" restriction for 3–4 point tasks, with no observed regression.
- **Do not disable default planning on this basis yet.** To cut cost, first try weakening "for multi-step tasks, list a 3-6 step plan with todo_write" to "complex tasks may plan first", and run ≥3 A/B rounds on a multi-step task set without explicit deliverable paths before deciding whether to change the default.
- **Do not read "disable the plan gate" as "disable the gate only".** The switch also removes the persistent todo instruction, and the gain comes mainly from the latter.

## 6. Reproduction

Run in the AgentProject main repository (`scripts/benchmark-turns.mjs` supports `--planGate=0`):

```bash
node scripts/benchmark-turns.mjs --group=long --variant=opt --runs=1
node scripts/benchmark-turns.mjs --group=long --variant=opt --runs=1 --planGate=0
node scripts/benchmark-turns.mjs --group=xlong --variant=opt --runs=1
node scripts/benchmark-turns.mjs --group=xlong --variant=opt --runs=1 --planGate=0
```

Data files for this run: `data/benchmarks/long-opt-2026-11-25T12-45-20-919Z.json`, `xlong-opt-2026-11-25T12-53-13-691Z.json` (threshold 5 points), `long-opt-2026-11-25T12-05-52-887Z.json`, `xlong-opt-2026-11-25T12-14-31-115Z.json` (gate off); the baseline is `local-first-agent-workbench/benchmark/data/long-opt.json`, `xlong-opt.json`.

## 7. Limitations

- Each configuration has only 1 run, and single-run variance can reach ±20%–40%; treat conclusions as directional, not as precise ratios.
- The task set consists of structured one-off deliveries and cannot represent real workflows that are multi-turn, ambiguous, or require user confirmation.
- Costs are estimated from usage tokens at official unit prices; they are not a bill and exclude taxes, discounts, and retry differences.
- Only `deepseek-chat` was tested; other models may have different cache fields and pricing.
