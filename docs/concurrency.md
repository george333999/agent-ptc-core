# Concurrent Write Locks and Verification Scheduling

This document describes the responsibilities, semantics, and integration of `resource-locks.js`, `command-scope.js`, and `verify-scheduler.js`.

## The Problem

An agent triggers multiple tools concurrently within one task:

- Two `write_file` calls modify the same file at the same time; the one that finishes later overwrites the earlier content.
- A `read_file` and a `write_file` happen at the same time; the read may see a half-written file.
- Three edits each trigger the same `node --test`; the same verification runs three times.
- A verification has just finished when another tool modifies the source under test; the conclusion is immediately stale.

Locks provide mutual exclusion, version registration detects changes, and verification scheduling handles merging and re-runs. Only when the three work together does "edit, then verify" remain trustworthy under concurrency.

## 1. Resource Locks

`createResourceLocks()` returns an in-process lock manager; the core method is `acquire({ reads, writes }, { signal, timeoutMs, owner })`.

Lock keys have three granularities:

- `file:/abs/path`: a single file.
- `dir:/abs/path`: a directory and all of its descendants.
- `ws:/abs/path`: the entire workspace.

Semantics:

- Reads are compatible with reads, reads conflict with writes, and writes are mutually exclusive.
- Ancestors and descendants are treated as related: a directory lock blocks file locks inside that directory.
- Writer priority: readers do not jump ahead of an earlier conflicting writer in the queue.
- Unrelated resources can skip blocked requests, so one slow write does not block the whole queue.
- Not reentrant: if the same `owner` requests again while already holding a conflicting lock, it returns `LOCK_REENTRANT`, avoiding self-deadlock.
- Requesting both read and write on the same path in one request is automatically upgraded to a write lock instead of raising an error: this self-overlapping request occurs frequently when batch-modifying a directory in place.
- A timeout returns `LOCK_TIMEOUT` and cancellation returns `LOCK_ABORTED`; the error object carries `holders` to help locate the holders.

Paths are case-insensitive on Windows, so lock keys are uniformly lowercased to avoid treating the same file as two resources.

`acquire` returns `{ keys, waitMs, release }` on success; `release()` must be called in `finally`.

## 2. Version Registration

`VersionStore` records each file's version, size, modification time, and short hash:

- `bump(path)` or `bumpKeys(keys)`: called after a tool write succeeds; increments the version by one.
- `snapshot(paths)`: records the input fingerprint before verification starts.
- `changed(snapshot)`: returns the paths that changed after verification ends.
- `versionMap(paths)`: outputs which version of the input the verification is based on.

The fingerprint consists of version, size, modification time, and short hash. The short hash is computed only when the file is no larger than 2 MB; it can also detect cases where an external tool rewrites the content but keeps the mtime and size. Files above the limit compare metadata only, avoiding reading the entire file synchronously on every verification.

## 3. Command Scope

`planToolLocks(name, input, helpers)` produces a lock plan for one tool call:

```js
{
  reads: ['file:/abs/src/calc.js'],
  writes: [],
  verify: null | { key, inputFiles, outputFiles, cacheable }
}
```

- Read-only tools such as `read_file`, `list_files`, `search_files`, and `ppt_analyze` produce read locks; `ptc_run` produces no lock.
- `write_file`, `edit_file`, `delete_file`, and document conversion tools produce write locks.
- `run_command` resolves its scope through `resolveCommandScope`.

Scope has two sources:

- Explicit: `scope.paths`, `scope.dirs`, and `scope.outputs` are supplied by the caller and treated as a complete input set; `cacheable` is true.
- Inferred: recognizes commands such as `node --test`, `pytest`, `python -m pytest`, `go test ./pkg/...`, and `tsc -p`, infers the read/write directories or files, and sets `cacheable` to false.

When the scope cannot be determined, it falls back to a workspace-wide write lock, prioritizing correctness.

The reason inferred scopes cannot be cached is specific: `node --test tests/calc.test.js` actually imports `src/calc.js` and deeper dependencies, so the complete input cannot be enumerated from the command arguments alone. Once an inferred result is cached, a source change may still hit an old conclusion and misreport a failure as a pass.

## 4. Verification Scheduling

`createVerifyScheduler({ versions })` receives the version registry described above; the core method is `run()`.

- Merging: concurrent requests with the same `key` share one Promise, and the command does not run twice.
- Queueing: one verification concurrency per workspace by default; non-intersecting scopes may run in parallel up to `hardMax`, which defaults to 2.
- Debouncing: after a request arrives, waits `debounceMs`, which defaults to 80 milliseconds and is capped at 2000 milliseconds, leaving a merge window for a batch of writes.
- Stale-verification re-run: snapshots inputs before execution; if inputs changed after execution, marks the result `stale` and re-runs, up to `maxReruns` times, which defaults to 2.
- Caching: results are cached only when `cacheable` is true and the result is not stale; the cache holds at most 200 entries and evicts in insertion order.
- Return value: `{ result, stale, runs, cached, verifiedVersions, waitMs }`, where `waitMs` is the time spent waiting for a verification slot and can be attributed directly to single-turn latency.

`status` is not maintained here; the caller decides pass or fail from `result`. The scheduler only guarantees that "the conclusion corresponds to the current input version".

## 5. Same-Turn Tool Concurrency Scheduling

When a single turn returns multiple tool calls, `createToolScheduler` decides which can run concurrently based on "path dependency + barrier":

- `write_file`, `edit_file`, `delete_file`, and `write_xlsx` produce write dependencies by normalized path; different paths can run concurrently.
- `read_file` keeps ordering with writes to the same path or an ancestor path; `list_files` / `search_files` are ordered by directory ancestor relation.
- `run_command` with a definite scope is a verify node; unknown commands, calls requiring approval, and unknown tools are barriers, running serially with what comes before and after.
- Multiple version writes of the same script such as `_v43.py` are forced through a barrier, preventing pre-execution from bypassing the version-explosion guard.
- The concurrency limit defaults to 4; `AGENT_TOOL_CONCURRENCY=0` reverts to the old behavior of "concurrent read-only only in consecutive batches".

The scheduler only decides execution order and does not change tool semantics; actual mutual exclusion is still guaranteed by resource locks. Chat and Agent share the same path resolution: Chat's `outputs/report.md` maps to `outputs/chat/report.md`, so reading and writing the same deliverable within one call lands on the same lock key.

For lightweight scenarios, `KeyedMutex` alone may suffice: the same key is serialized and different keys run in parallel, which suits adding mutual exclusion to a single file or a single task without a full reader-writer lock.

## 6. Integration Example

```js
import path from 'node:path';
import {
  createResourceLocks,
  planToolLocks,
  createVerifyScheduler
} from 'cache-stable-agent-core';

const locks = createResourceLocks();
const verify = createVerifyScheduler({ versions: locks.versions });
const helpers = {
  workspace,
  resolveInput: (rel) => path.join(workspace, rel),
  resolveOutput: (rel) => path.join(workspace, rel)
};

const writePlan = planToolLocks('write_file', { path: 'src/calc.js' }, helpers);
const lease = await locks.acquire(
  { reads: writePlan.reads, writes: writePlan.writes },
  { timeoutMs: 30000, signal }
);
try {
  await writeFile(path.join(workspace, 'src/calc.js'), next);
  locks.versions.bumpKeys(writePlan.writes);
} finally {
  lease.release();
}

const verifyPlan = planToolLocks('run_command', {
  command: 'node --test tests/calc.test.js'
}, helpers);
const outcome = await verify.run({
  key: verifyPlan.verify.key,
  workspace,
  inputFiles: verifyPlan.verify.inputFiles,
  outputFiles: verifyPlan.verify.outputFiles,
  cacheable: verifyPlan.verify.cacheable,
  execute: () => runCommand('node --test tests/calc.test.js')
});
```

If the task itself knows the complete inputs, it can pass `scope` explicitly in the `run_command` arguments:

```js
{
  command: 'node --test tests/calc.test.js',
  scope: {
    paths: ['tests/calc.test.js', 'src/calc.js'],
    outputs: ['reports/calc.json']
  }
}
```

In that case `cacheable` is true, and repeated verification can hit the cache directly while the inputs are unchanged.

## 7. Metrics

`locks.stats` records `acquired`, `waits`, `waitMs`, `maxWaitMs`, `timeouts`, `aborts`, `queued`, and `active`.

`verify.snapshot()` records `runs`, `stale`, `cached`, `merged`, `waitMs`, `maxWaitMs`, `queued`, and `active`.

It is recommended to include `lockWaitMs`, `verifyRuns`, `verifyCached`, and `stale` in tool return values, so long tails and duplicate executions can be attributed per tool call.

## 8. Tests

```bash
node --test test/resource-locks.test.js test/command-scope.test.js test/verify-scheduler.test.js test/tool-scheduler.test.js test/locks.test.js
```

Coverage:

- Concurrent reads, mutually exclusive writes, ancestor directory conflicts, writer priority, and queue-head skipping.
- Timeout, cancellation, non-reentrancy, and self-overlapping read/write automatically upgraded to a write lock.
- Version bump, snapshot, changed, and content changes with the same size and mtime detected by hash.
- Explicit and inferred scopes, unknown command fallback, and inferred scopes not being cacheable.
- Same-key merging, stale-verification re-runs, cache hits, parallel execution across disjoint scopes, the per-workspace concurrency limit, and attributable queue wait time.
- Same-turn concurrent scheduling, read-after-write ordering, version-script barrier, Chat output path redirection, and the concurrency switch.

## 9. Boundaries

- Locks are valid only within the current process and do not span processes or machines; multi-instance deployments need file locks, database locks, or a coordination service.
- PTC is a read-only sandbox and does not participate in write locks; what it reads may lag behind concurrent writes, so critical verification should still run after the write lock.
- Version registration uses path strings and does not resolve symlinks; the same real file accessed through different symlink paths is treated as different resources.
- The verification cache is held in memory and cleared when the process restarts; this is intentional, to avoid treating a previous process's conclusion as the current one.
