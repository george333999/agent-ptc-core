# Benchmark data and reports

This directory keeps the raw grouped benchmark results and the report-generation script for the extracted core. It is not a marketing page, and the data includes unflattering parts; check the accounting basis and sample size first when reading.

## Data groups

| File prefix | Turns | Description |
| --- | --- | --- |
| tiny | 10 | Tiny conversation; validates fixed overhead and the first prefix |
| short | 20 | Short conversation; validates the first prefix and tool distillation |
| medium | 50 | Medium conversation; PTC and context-engine benefits start to show |
| long | 70 | Long conversation; approaches the window soft cap |
| xlong | 100 | Extra-long conversation; validates long-session stability and cost |

This directory keeps two batches of data:

- `data/*.json` (2026-11-25): cross-period single runs, 250 turns per variant and 500 turns of real conversation in total; overall per turn, tokens fall 56.5%, time falls 21.3%, and cost at a single tier falls 8.3%.
- `data/abba-2026-11-26/` (2026-11-26): the same-window ABBA re-test, 500 turns per variant and 1000 turns in total; overall tokens fall 69.8%, time falls 14.8%, and cost at a single tier falls 37.2%, with accuracy 99.8% versus 97.8%. For the method and full tables, see "Same-window ABBA re-test" below.

The previous version's four-group data is archived in `data/legacy-2026-11-23/`, and the earlier five-group data is archived in `data/legacy-2026-11-22/`; the report script reads top-level data files only.

Each group contains two variants, `opt` and `base`:

- `opt`: Programmatic Tool Calling (PTC), single-turn context engine, model-window-derived history budget, and tool-result distillation with adaptive budgets.
- `base`: the traditional framework — native function calling, full history, a single-loop ReAct — with prefetch, cold facts, artifact index, turn policy, plan inlining, task memo, distillation, and compaction disabled.

Both variants use the same model, the same task set, and the same prompts. Success is verified automatically from artifact files, not by comparing returned text.

## File structure

```text
benchmark/
  data/                 raw JSON, one file per group per variant (2026-11-25 batch)
  data/abba-2026-11-26/ same-window ABBA aggregates for the five groups
  data/legacy-2026-11-22/ previous five-group benchmark data, for historical comparison only
  data/legacy-2026-11-23/ previous four-group benchmark data, for historical comparison only
  abba-report-2026-11-26.html same-window ABBA single-file report
  abba-report-2026-11-26.png  same-window ABBA phone-friendly long image
  normalize-costs.mjs   normalizes the top-level data's costCny uniformly to off-peak prices
  report.mjs            aggregates and generates the mobile HTML report
  report-preview.html   pre-generated report, directly openable in StPage
  output/               generated after running report.mjs; ignored by .gitignore
```

Key fields of the raw JSON:

```text
group          group id
variant        opt or base
toolMode       ptc or native
model          model name
turns          planned turns
runs           number of runs
prices         unit price snapshot at collection time; the report recalculates at a single price tier and does not use this field directly
costBasis      the accounting basis of the current data; top-level data is uniformly offPeak
peakCostCny    peak cost before normalization, kept for reconciling against the original bill
results[]      details of each run
  totals       total tokens, time, cache hits, tool calls, cost, accuracy
  turns[]      per-turn time, steps, tool calls, tokens, whether validation passed
```

## Generating reports

```bash
npm run benchmark:normalize
npm run benchmark:report
```

`benchmark:normalize` normalizes each turn's `costCny` in the top-level data uniformly to off-peak prices and writes the pre-normalization peak cost into `peakCostCny`; the script is idempotent and will not rewrite repeatedly.

The script reads `benchmark/data/` and generates:

- `benchmark/output/benchmark-report.html`
- `benchmark/output/benchmark-summary.json`

The report is a single-file HTML document with no external library dependencies and can be opened directly on a phone. The repository's `report-preview.html` is a pre-generated version for viewing without a Node environment.

## Accounting basis and caveats

- The 2026-11-25 batch has 1 run per group, and the `runs` field states the actual number of runs; the 2026-11-26 ABBA batch has 2 runs per variant per group (A-B-B-A alternation). Single runs still fluctuate, so read trends.
- Accuracy is verified automatically from artifact files, not scored by hand; errors, missing files, and invalid files all count as failures.
- Total tokens include many cheap cache hits, so judge cost primarily by cache-miss tokens and estimated cost.
- Wall-clock breakdown: the optimized variant spends 93.8% on model calls (first token 83.1%, decoding 10.7%) and 5.3% on local tools, with near zero on disk writes; even with local tool time at zero, each turn can only be about 6% faster. Time is therefore close to the model-side lower bound, and further optimization should reduce model steps rather than compacting the context more.
- Pricing uniformly uses official DeepSeek off-peak prices (CNY / 1M tokens): cache hit 0.02 / cache miss 1 / output 4. All original 2026-11-25 batch runs fell in peak hours; `costCny` in the data has been normalized uniformly to off-peak prices, and `peakCostCny` retains the original peak cost. The 2026-11-26 ABBA batch straddles peak and off-peak, and both groups are recalculated at off-peak prices. The report and data use the same basis; for the real bill, compute separately based on when requests were actually sent.
- DeepSeek is used alone because its usage consistently returns `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`, allowing separate billing at cache-hit and cache-miss prices; other vendors lack uniform cache fields, so like-for-like comparison is not possible.
- The benchmark was collected on Windows with Node 20; other platforms have not been systematically verified.
- Tiny conversation is the only group whose cost is higher than the baseline (+11.3%), yet its wall-clock time is 11.7% faster. Per-turn data shows PTC uses fewer tool turns (27.0 versus 29.5); the real difference is that each `ptc_run`'s JavaScript code argument is entirely new cache-miss tokens: within 10 turns this adds about 10k cache-miss input tokens, and the cache-miss price is 50 times the cache-hit price, so the fixed overhead cannot be amortized. Short conversation is already roughly break-even (-1.6%), and from medium onward the savings are clear.
- Model reply length and tool-result length fluctuate between runs; when the baseline uses full history, that fluctuation accumulates across later turns, so the cost reduction for the same group may differ by a few percentage points between batches.

## Same-window ABBA re-test (2026-11-26)

On 2026-11-26, the two variants were run alternately in A-B-B-A order within the same time window, with 2 runs per variant per group, avoiding the time-of-day bias of "optimized during morning peak, control at dawn". The data is in `data/abba-2026-11-26/summary.json`, and the pre-generated reports are `benchmark/abba-report-2026-11-26.html` and `benchmark/abba-report-2026-11-26.png`.

| Group | Turns/run | Wall-clock opt / base | Wall-clock diff | Token opt / base | Token diff | Cost opt / base | Cost diff | Accuracy opt / base |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Extra-tiny | 10 | 111.5s / 126.3s | -11.7% | 1.23M / 1.27M | -3.2% | ¥0.1652 / ¥0.1484 | +11.3% | 100% / 100% |
| Short | 20 | 203.2s / 226.3s | -10.2% | 3.11M / 3.41M | -8.7% | ¥0.2754 / ¥0.2799 | -1.6% | 100% / 100% |
| Medium | 50 | 583.8s / 657.1s | -11.1% | 10.80M / 21.83M | -50.5% | ¥0.7633 / ¥1.0738 | -28.9% | 100% / 100% |
| Long | 70 | 957.8s / 1071.5s | -10.6% | 16.32M / 46.87M | -65.2% | ¥1.3963 / ¥1.9423 | -28.1% | 99.3% / 92.1% |
| Extra-long | 100 | 1444.2s / 1793.1s | -19.5% | 22.83M / 106.68M | -78.6% | ¥1.9800 / ¥3.8460 | -48.5% | 100% / 100% |
| **Total (2 runs)** | **250/run** | **3300.6s / 3874.2s** | **-14.8%** | **54.29M / 180.05M** | **-69.8%** | **¥4.5802 / ¥7.2904** | **-37.2%** | **99.8% / 97.8%** |

Basis and findings:

- Cost is recalculated uniformly at off-peak prices; the two groups alternate within the same window, avoiding peak/off-peak tier differences.
- The long-conversation group uses 2 opt + 2 base, four valid runs, after excluding two runs with obvious server stalls (one opt turn of 192s; base P95 of 22.6s); all other failed turns are counted, with no favorable filtering.
- In the baseline run at 03:41, all 11 Excel tasks failed: it generated an xlsx, converted it to CSV, then `delete_file` deleted the xlsx, leaving the deliverable missing. This is not a misjudgment by the evaluation script but a real failure caused by the traditional flow's lack of a deliverable guard, so accuracy is only 84.3% (that run); opt in the same window is 99.3%.
- The token and cost advantage grows quickly with conversation length; wall-clock time leads in all five groups, and the remaining gap is mainly model-side first-token latency and decoding rather than local tools.
- The tiny group's cost disadvantage comes from PTC fixed overhead, not from more PTC calls. If addressed in the future, the safe approach is a short-session-specific gate that routes to native when "an estimated ≤10 turns and ≤2 small files in the first turn" applies, not a global switch; it is not enabled now because session stickiness would affect medium and long tasks, and the absolute saving is only about ¥0.017 per 10-turn session.

## Cost of the plan prompt and plan gate (A/B record)

On 2026-11-25, two single-run A/B tests of the same core were done in the AgentProject main repository, long 70 turns and xlong 100 turns; cost is computed at the DeepSeek off-peak basis (cache hit ¥0.02 / cache miss ¥1 / output ¥4 per million tokens), and the table shows the total cost for the whole group:

| Configuration | long cost | xlong cost | Accuracy (long / xlong) |
| --- | ---: | ---: | --- |
| Baseline: todo prompt + plan gate (threshold 3) | ¥0.9659 | ¥1.4468 | 70/70 · 100/100 |
| Raise the forced-planning threshold to 5 only | ¥0.9261 | ¥1.5617 | 70/70 · 99/100 |
| Disable the plan gate and remove the todo prompt | ¥0.8386 | ¥1.0855 | 70/70 · 100/100 |

Conclusions:

- The cost comes mainly from the persistent todo instruction in the system prompt: once disabled, the model no longer calls `todo_write` on its own (long 24 times and xlong 34 times drop to 0), long cost falls 13.2% and xlong 25.0%.
- Raising only the forced-planning threshold from 3 to 5 has an effect within single-run variance (long −4.1%, xlong +7.9%). Most benchmark prompts specify a delivery path explicitly, so the plan gate itself rarely triggers.
- The 99/100 for xlong comes from the turn-6 Excel artifact failing validation, which occurs before any history trimming and is unrelated to the plan configuration.

The current open-source core still keeps the todo prompt and default planning behavior; this data is only for recording the cost source and does not change the defaults. For the full concept distinctions, mechanism interpretation, reproduction commands, and caveats, see [docs/plan-prompt-ab.md](../docs/plan-prompt-ab.md); for the gate's own decision chain and timing, see [docs/plan-gate.md](../docs/plan-gate.md).

## Adding a benchmark

1. Put JSON of the same structure in `data/`, with the filename starting with the group prefix.
2. Confirm that `results[].totals` contains `totalTokens`, `durationMs`, `cacheHitTokens`, `cacheMissTokens`, `toolCalls`, and `accuracy`.
3. If adding a group, add the group id, label, and turns to `GROUPS` in `report.mjs`.
4. Run `npm run benchmark:normalize` to normalize the new data's cost uniformly to off-peak prices.
5. Run `npm run benchmark:report` and check whether charts and aggregates are complete.
6. State the model, turns, number of runs, and collection environment in the commit description.
