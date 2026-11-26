// Verification scheduling: run "test/build" commands with concurrency controlled by scope, and detect whether inputs changed during verification.
// States: idle → running → passed/failed; when input versions change, mark stale and rerun at most 2 times.
// This module does not execute commands itself; it only handles merging, queueing, snapshots, and rerun decisions.

import { pathsRelated } from './resource-locks.js';

function normalizeFiles(files) {
  return [...new Set((Array.isArray(files) ? files : []).filter(Boolean).map(String))];
}

function sameSnapshot(left, right) {
  if (!left || !right || left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function scopesOverlap(left, right) {
  for (const a of left) {
    for (const b of right) {
      if (pathsRelated(a, b)) return true;
    }
  }
  return false;
}

export class VerifyScheduler {
  constructor({
    versions,
    maxReruns = 2,
    perWorkspace = 1,
    hardMax = 2,
    debounceMs = 80,
    maxDebounceMs = 2000,
    cacheLimit = 200,
    now = Date.now
  } = {}) {
    if (!versions) throw new Error('VerifyScheduler requires versions (VersionStore)');
    this.versions = versions;
    this.maxReruns = Math.max(0, Number(maxReruns) || 0);
    this.perWorkspace = Math.max(1, Number(perWorkspace) || 1);
    this.hardMax = Math.max(this.perWorkspace, Number(hardMax) || 2);
    this.debounceMs = Math.max(0, Number(debounceMs) || 0);
    this.maxDebounceMs = Math.max(this.debounceMs, Number(maxDebounceMs) || 2000);
    this.cacheLimit = Math.max(1, Number(cacheLimit) || 200);
    this.now = now;
    this.inflight = new Map();
    this.cache = new Map();
    this.active = new Map();
    this.queue = [];
    this.timer = null;
    this.hardTimer = null;
    this.stats = { runs: 0, stale: 0, cached: 0, merged: 0, waitMs: 0, maxWaitMs: 0, queued: 0 };
  }

  _workspaceActive(workspace) {
    if (!this.active.has(workspace)) this.active.set(workspace, []);
    return this.active.get(workspace);
  }

  _hasSlot(job) {
    const active = this._workspaceActive(job.workspace);
    if (active.length < this.perWorkspace) return true;
    if (active.length >= this.hardMax) return false;
    // Verifications with disjoint scopes may run in parallel up to hardMax; overlapping scopes serialize to avoid invalidating each other's results.
    return !active.some((item) => scopesOverlap(item.keys, job.keys));
  }

  _grant(job) {
    this._workspaceActive(job.workspace).push(job.slot);
    this.stats.queued = this.queue.length;
    job.waitMs = Math.max(0, this.now() - job.enqueuedAt);
    this.stats.waitMs += job.waitMs;
    this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, job.waitMs);
    if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort);
    job.resolve(job.waitMs);
  }

  _release(job) {
    const active = this._workspaceActive(job.workspace);
    this.active.set(job.workspace, active.filter((item) => item !== job.slot));
    this._pump();
  }

  _pump() {
    for (let index = 0; index < this.queue.length;) {
      const job = this.queue[index];
      if (this._hasSlot(job)) {
        this.queue.splice(index, 1);
        job.slot = { keys: job.keys };
        this._grant(job);
      } else {
        index += 1;
      }
    }
    this.stats.queued = this.queue.length;
    if (!this.queue.length) this._clearTimers();
  }

  _clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.timer = null;
    this.hardTimer = null;
  }

  _schedule() {
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this._pump();
      }, this.debounceMs);
    }
    if (!this.hardTimer) {
      // Debounce at most 2 seconds: continuously arriving requests must not postpone the earliest one indefinitely.
      this.hardTimer = setTimeout(() => {
        this.hardTimer = null;
        this._pump();
      }, this.maxDebounceMs);
    }
  }

  _acquireSlot(job) {
    if (job.signal?.aborted) return Promise.reject(new Error('Task cancelled'));
    return new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
      job.enqueuedAt = this.now();
      if (job.signal) {
        job.onAbort = () => {
          this.queue = this.queue.filter((item) => item !== job);
          reject(new Error('Task cancelled'));
        };
        job.signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.queue.push(job);
      this.stats.queued = this.queue.length;
      this._schedule();
    });
  }

  _remember(job, snapshot, result) {
    this.cache.set(job.id, { snapshot, result });
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }

  async _run(job) {
    const before = this.versions.snapshot(job.inputFiles);
    const cached = job.cacheable ? this.cache.get(job.id) : null;
    if (cached && sameSnapshot(cached.snapshot, before)) {
      this.stats.cached += 1;
      return { ...cached.result, cached: true, stale: false, waitMs: 0 };
    }
    await this._acquireSlot(job);
    try {
      let runs = 0;
      let stale = false;
      let result = null;
      let snapshot = before;
      for (;;) {
        result = await job.execute();
        runs += 1;
        this.stats.runs += 1;
        const changed = this.versions.changed(snapshot);
        if (!changed.length) break;
        stale = true;
        this.stats.stale += 1;
        if (runs > this.maxReruns) break;
        snapshot = this.versions.snapshot(job.inputFiles);
      }
      const verifiedVersions = this.versions.versionMap(job.inputFiles);
      const value = { result, stale, runs, cached: false, verifiedVersions, waitMs: job.waitMs };
      // stale results are not cached: the next call must re-verify. Inferred scopes are not cacheable.
      if (!stale && job.cacheable) this._remember(job, this.versions.snapshot(job.inputFiles), value);
      return value;
    } finally {
      this._release(job);
    }
  }

  /**
   * Run one verification. Concurrent requests with the same command+scope merge into a single Promise.
   * @returns {Promise<{result:any, stale:boolean, runs:number, cached:boolean, verifiedVersions:Object, waitMs:number}>}
   */
  run({ key, workspace = '', inputFiles = [], outputFiles = [], cacheable = true, signal = null, execute } = {}) {
    if (typeof execute !== 'function') throw new Error('VerifyScheduler.run requires execute');
    const files = [...normalizeFiles(inputFiles), ...normalizeFiles(outputFiles)];
    const id = String(key || `verify:${workspace}:${files.join('|')}`);
    if (this.inflight.has(id)) {
      this.stats.merged += 1;
      return this.inflight.get(id);
    }
    const job = {
      id,
      workspace: String(workspace || ''),
      inputFiles: normalizeFiles(inputFiles),
      outputFiles: normalizeFiles(outputFiles),
      keys: normalizeFiles(files),
      cacheable: cacheable !== false,
      signal,
      execute
    };
    const promise = this._run(job).finally(() => {
      this.inflight.delete(id);
    });
    this.inflight.set(id, promise);
    return promise;
  }

  snapshot() {
    return { ...this.stats, active: [...this.active.values()].reduce((total, list) => total + list.length, 0) };
  }
}

export function createVerifyScheduler(options = {}) {
  return new VerifyScheduler(options);
}
