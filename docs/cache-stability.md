# Fixing the Cache Hit Rate from 15% to 93%

## Symptom

In a 40-turn real long-conversation regression, the cache hit rate swung wildly between 15.13% and 94.22%. With the same code and the same batch of tasks, the hit rate behaved like a random number, and token cost and response time swung along with it.

## Why the Prefix Cache Is Fragile

A model provider's automatic prefix cache bills by common prefix. Only when the token sequence of the current request has a historical request as its prefix is that leading segment billed at the cache-hit price. As soon as any single byte in the middle of the prefix changes, everything from the change point onward is treated as a cache miss.

This means several common practices in agent scenarios break the cache:

- Re-serializing tool schemas on every request, with unstable object key order.
- Putting timestamps, task IDs, progress, and other per-turn content in the system prompt.
- Inserting dynamic context into the middle of the history instead of appending it to the end.
- Applying a sliding window at every step, so the window start keeps moving forward.

## Diagnosis

1. Export the usage of every model call and record prompt tokens, cache hits, and cache misses turn by turn.
2. Stable-serialize the system and tool definitions of every request and record the prefix hash.
3. Compare adjacent turns: turns with a high hit rate share the same prefix hash, while turns where the rate collapses diverge in the middle of the hash.
4. Keep hit logs per worker to confirm which kind of subtask is creating new prefixes.

The test is straightforward: if two requests have different prefix hashes while the system and tool configuration have not changed, the problem must be in serialization order or mid-history insertion.

## The Six Fixes

### 1. Fix the Tool Schema Order

Different construction paths can produce different field orders. `server/tool-order.js` sorts by tool name in byte order, ensuring that the same set of tools serializes identically every time.

### 2. Freeze the Worker Static Header

For sub-agents and parallel workers, the system prompt, tool definitions, and role constraints are fixed in the header, while task descriptions and runtime variables go only in the tail. `buildCachePrefix` covers only the header, making it easy to verify separately whether the header was modified by accident.

### 3. Append Volatile Information Only to the Tail

Time, progress, and temporary summaries are always appended to the end of the messages, never inserted into the middle of the prefix. Appending does not change the existing prefix; inserting does.

### 4. Move PTC Dynamic Content Out of the Prefix

PTC batch execution results are appended to the history as ordinary tool results and do not participate in constructing the system or tool definitions. The sandbox execution logic is unchanged; only the prompt and message assembly order are adjusted.

### 5. Do Not Change Header Bytes Within a Subtask

Multiple turns of the same subtask reuse the same header and do not recompute the system prompt midway. When a change is needed, create a new subtask rather than modifying in place.

### 6. Lagging Trim Instead of a Sliding Window

`server/history-window.js` offers two budget profiles: the legacy-compatible default is a soft limit of 48 messages / 60,000 characters and a hard limit of 64 messages / 150,000 characters; for long sessions, `historyLimitsForContext(modelWindow)` is recommended, with a hard limit of 97% of the model window (converted at 2.5 characters/token) and a soft limit at 50% of the hard limit. Below the hard limit it returns as-is; above the hard limit it trims once down to the soft limit; two trims are at least the difference between the hard and soft limits apart. Trim enough at once, and the next trim will be far enough away.

When the character limit is exceeded, the character gap is used first for lag protection (pass `lastTrimChars`), avoiding a trim every turn in long-message scenarios; when there is no character baseline, it falls back to the message-count gap to stay compatible with older callers.

The trim start is also aligned backward to the nearest user message, so the history does not begin with an orphaned tool result and a turn is not cut in half, which would make the prefix change again on the next request.

## Verification

The repository provides tests in three areas:

- `test/prefix.test.js`: stable serialization, hashing, and common-prefix ratio.
- `test/history-window.test.js`: soft and hard limits, lagging trim, user-message alignment.
- `test/cache-simulation.test.js`: simulates multi-turn appends, asserts the common-prefix ratio between adjacent requests, and confirms trims happen only at expected positions.

The regression standard is not "average hit rate" but "the prefix of adjacent requests is append-only". As long as this property holds, the hit rate will not suddenly collapse.

## Results

- Across the five latest benchmarks (10 / 20 / 50 / 70 / 100 turns), the optimized version's hit rates are 90.7%, 95.0%, 96.0%, 95.5%, and 95.5%; long sessions stay above 95% with no more double-digit swings.
- The traditional version uses the full history and only appends without trimming, so its hit rate is higher (93.9%, 96.6%, 98.5%, 98.9%, 99.2%); but its per-turn context is much larger, and the resulting cost at the same tier is still higher than the optimized version (¥0.0143 vs ¥0.0131 per turn overall).
- Cache misses in very long conversations dropped from 1.42M in the previous version to 742k, nearly halved; the optimized version uses 165.8k tokens per turn versus 487.8k for the traditional version.
- Conclusion: cache stability is the foundation that makes long conversations usable, but "a higher hit rate" does not equal "cheaper". Cost must be judged on hit rate, cache-miss tokens, total context size, and output tokens together.

## Self-Check List

If your agent also suffers hit-rate swings, check in this order:

1. Whether tool definitions are rebuilt every time with unstable order.
2. Whether the system prompt contains times, random numbers, or absolute paths.
3. Whether dynamic context is inserted into the middle of the history.
4. Whether the history window slides at every step.
5. Whether history message objects are rewritten between requests.
6. Whether you can record and compare prefix hashes of adjacent requests.
