# PTC (Programmatic Tool Calling)

## Why PTC

Traditional tool calling is one call at a time: list a directory, read a file, read another, search again. Each step feeds the full result back to the model, which then decides the next step. With many files two problems appear: turns grow linearly, and the context is filled with raw content.

PTC takes a different approach: the model writes a short program that performs batch read-only operations in a sandbox and returns only the aggregated result. The model shifts from "performing operations one by one" to "describing operations", and round trips drop from file order to task order.

## Call chain

```text
Model outputs ptc_run({ code })
        |
        v
AST static validation (syntax layer)
        |
        v
Worker thread + vm sandbox (execution layer)
        |
        v
Typed read-only tools (interface layer)
        |
        v
Return JSON result, appended to history
```

## Three-layer safety design

### Syntax layer

Built on acorn parsing, validating code size and disabled capabilities:

- `class`, `import`, `this`, and `process` are disallowed
- `new` is allowed only with standard built-ins: Set, Map, Date, RegExp, Error, Array, Object, Promise
- Dynamic property access such as `res[i]` is disallowed; array iteration must use `for...of`
- Limits: 40000 characters, 1200 lines, 5000 AST nodes, nesting depth 48
- Limits: 50 loops, 120 call sites, 100 actual tool calls

A validation failure returns diagnostics with line numbers; the model corrects the code from the hint without re-executing.

### Execution layer

- Dedicated worker thread running in a `node:vm` context
- No network, no file writes, no shell, no child processes
- Default 8-second timeout per execution; on timeout it is terminated
- Result capped at 24000 characters; longer output is truncated
- At most 16 namespaces by default, reclaimed after 10 minutes idle

### Interface layer

Exactly six read-only methods are exposed, with each parameter validated for type, range, unknown keys, and path traversal:

| Method | Returns |
| --- | --- |
| `files.list({ path, depth, offset, limit })` | Directory entries, type, size, `nextOffset`; at most 400 per page |
| `files.read({ path, startLine, endLine })` | Total lines, range, content, whether truncated; body at most 500k characters |
| `files.readMany({ paths, startLine, endLine })` | At most 50 paths, deduplicated, read with bounded concurrency; a single file failure does not affect the others |
| `files.search({ query, path, glob, target, caseSensitive, regex })` | At most 200 matches, scanning 4000 files; oversized files are counted in `skippedLarge` |
| `knowledge.search({ query, topK, docName, collection, fileType })` | Matched snippets and scores |
| `skills.read({ name })` | Skill body and attachment list |

File writes, edits, command execution, MCP, and sub-agents do not enter PTC; they are still executed directly by the main loop and go through approval.

## State reuse

Multiple `ptc_run` calls within the same task share a `state` object plus top-level variables and functions. This suits staged scanning: build an index first, then filter based on that index.

Pass `reset: true` to discard the state. State is released per scope when the task ends, preventing parallel workers from polluting each other.

## Example

```js
const files = await api.files.list({ path: 'src', depth: 3 });
const targets = files.entries.filter((item) => item.type === 'file' && item.path.endsWith('.js'));
const hits = [];
for (const item of targets) {
  const content = await api.files.read({ path: item.path });
  for (const line of content.content.split('\n')) {
    if (line.includes('TODO')) hits.push({ path: item.path, line: line.trim() });
  }
}
return { count: hits.length, sample: hits.slice(0, 20) };
```

The point: the loop runs inside the sandbox and returns only counts and a sample, instead of bringing every file's content back into the history.

## File-heavy tasks

When handling hundreds of files, do not call `files.read` one by one, and do not `return` the whole batch of contents directly:

1. Locate with `files.search` first, or enumerate with paged `files.list`; when there are more than 400 entries, continue with `nextOffset`.
2. Then read in batches of at most 50 paths with `files.readMany`; duplicate paths are read once, and a single file failure returns `ok:false` without sinking the batch.
3. Do counting, deduplication, sorting, and field projection inside the program, returning only paths, line numbers, counts, matched text, or short previews.
4. A single `ptc_run` result is capped at 24000 characters; returning multiple full texts gets truncated, leaving the model with incomplete results.
5. Files over 1MB are skipped in directory search and counted in `skippedLarge`; read them line by line with `files.read` when the content is needed.
6. Do not use `ptc_run` as a line-by-line viewer: do not repeatedly probe the same file with `endLine` incremented by 1, and do not read the same range again. When more content is needed, read the whole file at once (`endLine: 2000`) or a clearly larger range, or locate it directly with `files.search`.
7. Stop exploring once the deliverable is written: do not read the generated script line by line to check it; run or validate the artifact instead, then return the final result.

Batch reads and content search use asynchronous bounded I/O and do not block the main thread on synchronous disk reads. The same file is served from a read-only cache keyed by mtime and size across `ptc_run` calls; a file that was just written is force re-read to avoid stale content. The real workspace root path is cached centrally by `paths.js` with explicit invalidation, so PTC and direct tools never resolve two different roots for the same workspace.

## Exhausted budget and validation failures

A single `ptc_run` executes at most 100 tool calls. When the budget is exhausted but the task is incomplete, do not end the conversation outright; let the user choose through a clarification card:

1. Continue PTC as the model suggests: reset this budget, keep splitting into blocks of no more than 100, and write cross-block progress to `state`; this does not merely allow one more call.
2. Stop using PTC: switch to direct read-only tools to continue the task.
3. Other: the user supplies additional requirements; PTC continues by default.

A static validation failure is a writing error the model can correct: the first 2 failures return correction hints with line numbers and error codes; if the 3rd still fails, it degrades to direct read-only tools, so all steps are not spent on the same syntax error.

## Applicability

Suitable for: broad code scans, batch filtering, cross-directory aggregation, and keyword-based location followed by summarization.

Not suitable for: tasks requiring line-by-line verification of full text, changes requiring write operations, or retrieval that depends on the network.

Known limitation: batch code quality depends on model capability. `readMany` supports at most 50 paths, but a single result holds only 24000 characters; smaller models should return fewer full texts per call and prefer aggregating into counts or samples inside the program.

## Fixed overhead of short sessions (measured and proposal)

In the 2026-11-26 same-window ABBA benchmark, the 10-turn very short sessions showed the only cost disadvantage:

| Metric | Optimized (PTC) | Traditional (native) |
| --- | ---: | ---: |
| Wall-clock | 111.5s | 126.3s (PTC 11.7% faster) |
| Tool turns | 27.0 | 29.5 |
| Cache-miss tokens | 49.8k | 38.2k |
| Cost (off-peak) | ¥0.1652 | ¥0.1484 (PTC 11.3% higher) |

The cause is not "more PTC calls" but that the JavaScript code argument of each `ptc_run` is entirely new content that cannot hit the prefix cache; 8–11 PTC calls across 10 turns add roughly 10k cache-miss input tokens. The cache-miss price is 50 times the cache-hit price, so the fixed overhead cannot be amortized within 10 turns; by 20 turns cost is essentially break-even (-1.6%), and from 50 turns it becomes a clear saving.

Proposed optimization (currently not enabled):

1. Only when the session is expected to be ≤10 turns and the first turn reads ≤2 files under 8KB, switch to native read-only tools; otherwise continue with PTC.
2. The gate must be "short-session only" and must not extend the first-turn criterion to the whole session — otherwise a first turn that looks small would cost 50/100-turn tasks PTC for their entire duration.
3. The absolute gain is about ¥0.017 per 10-turn session, lower priority than reducing LLM round trips and keeping the prefix stable; if enabled, it must be A/B-tested in the same window per tiny/short group and must not be on by default globally.
