// Tool concurrency scheduling: decides which tools in the same turn may execute simultaneously, based on "path dependencies + barriers".
// Handles scheduling only and does not change tool semantics; writes to the same file are still serialized by the resource lock in tools.js.
//
// Rules:
// 1) Path writes (write_file/edit_file/delete_file) are keyed by normalized path; different paths may run concurrently;
// 2) Path reads (read_file) stay ordered with writes to the same path/ancestor path; different paths may run concurrently;
// 3) Full-scan reads (list_files/search_files) are ordered against writes by directory ancestor relations;
// 4) Independent reads (web/knowledge/tool_result, etc.) do not depend on files and run concurrently directly;
// 5) run_command with a definite scope is a verify node: it reads inputs and writes outputs, and may run concurrently with unrelated writes;
// 6) All other tools, unknown commands, argument parse failures, and calls needing approval are barriers, serialized before and after.

import fs from 'node:fs';
import path from 'node:path';
import { resolveOutputPath, resolveWorkspacePath } from './output-paths.js';
import { keysRelated } from './resource-locks.js';
import { resolveCommandScope } from './command-scope.js';

export const MAX_CONCURRENT_TOOLS = 4;

const PATH_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'write_xlsx']);
const PATH_READ_TOOLS = new Set(['read_file']);
const SCAN_READ_TOOLS = new Set(['list_files', 'search_files']);
const INDEPENDENT_READ_TOOLS = new Set([
  'read_tool_result',
  'knowledge_search',
  'fetch_url',
  'web_search',
  'read_skill',
  'task'
]);

// Rollback/control switch: when AGENT_TOOL_CONCURRENCY=0, fall back to the old "consecutive read-only concurrency only" behavior.
export function toolConcurrencyEnabled(env = process.env) {
  return String(env?.AGENT_TOOL_CONCURRENCY ?? '') !== '0';
}

function normalizePathKey(ctx, rawPath, scope) {
  const rel = resolveOutputPath(ctx, rawPath);
  if (!rel) return '';
  const resolved = path.resolve(resolveWorkspacePath(ctx.workspace, rel));
  // Windows filesystems are case-insensitive, so the key must be normalized the same way; otherwise the same file becomes two resources.
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return `${scope}:${normalized}`;
}

function probePath(ctx, rel) {
  try {
    const stat = fs.statSync(resolveWorkspacePath(ctx.workspace, rel));
    return stat.isDirectory() ? 'dir' : 'file';
  } catch {
    return false;
  }
}

// Multiple versions of the same script (e.g. _v43.py) must go through a barrier: pre-execution would bypass the version-explosion guard,
// and a version number usually means "the previous step failed", which does not suit concurrent writes.
const VERSIONED_SCRIPT_RE = /^(.*?)(?:[._-]?v(\d+))(\.[^./\\]+)$/i;
const SCRIPT_EXT_RE = /\.(?:py|js|mjs|cjs|ts|sh|ps1|bat)$/i;

function isVersionedScriptPath(value) {
  const name = String(value || '').replace(/\\/g, '/').split('/').pop() || '';
  return SCRIPT_EXT_RE.test(name) && VERSIONED_SCRIPT_RE.test(name);
}

function commandKeys(ctx, input) {
  const scope = resolveCommandScope(input, { probe: (rel) => probePath(ctx, rel) });
  if (!scope.known) return null;
  const toKey = (item, mode) => {
    try {
      const resolved = path.resolve(resolveWorkspacePath(ctx.workspace, item.path));
      const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      return { key: `${item.kind}:${normalized}`, mode };
    } catch {
      return null;
    }
  };
  const keys = [
    ...scope.reads.map((item) => toKey(item, 'read')),
    ...scope.writes.map((item) => toKey(item, 'write'))
  ].filter(Boolean);
  return keys.length ? keys : null;
}

export function classifyToolCall(name, args, ctx) {
  const tool = String(name || '');
  const input = args && typeof args === 'object' ? args : {};
  if (PATH_WRITE_TOOLS.has(tool)) {
    if (isVersionedScriptPath(input.path)) return { kind: 'barrier', key: '' };
    try {
      const key = normalizePathKey(ctx, input.path, 'file');
      return key ? { kind: 'write', key, keys: [{ key, mode: 'write' }] } : { kind: 'barrier', key: '' };
    } catch {
      return { kind: 'barrier', key: '' };
    }
  }
  if (PATH_READ_TOOLS.has(tool)) {
    try {
      const key = normalizePathKey(ctx, input.path, 'file');
      return key ? { kind: 'read', key, keys: [{ key, mode: 'read' }] } : { kind: 'scan', key: '' };
    } catch {
      return { kind: 'barrier', key: '' };
    }
  }
  if (SCAN_READ_TOOLS.has(tool)) {
    try {
      const key = normalizePathKey(ctx, input.path || '.', 'dir');
      return key ? { kind: 'scan', key, keys: [{ key, mode: 'read' }] } : { kind: 'scan', key: '' };
    } catch {
      return { kind: 'barrier', key: '' };
    }
  }
  if (INDEPENDENT_READ_TOOLS.has(tool)) return { kind: 'independent', key: '' };
  if (tool === 'run_command') {
    const keys = commandKeys(ctx, input);
    return keys
      ? { kind: 'verify', key: keys.map((item) => item.key).sort().join('|'), keys }
      : { kind: 'barrier', key: '' };
  }
  return { kind: 'barrier', key: '' };
}

function entriesConflict(left, right) {
  for (const a of left) {
    for (const b of right) {
      if (keysRelated(a.key, b.key) && (a.mode === 'write' || b.mode === 'write')) return true;
    }
  }
  return false;
}

function createLimiter(limit) {
  const max = Math.max(1, Number(limit) || 1);
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const job = queue.shift();
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

/**
 * Create a scheduler for one turn of tool calls.
 * - calls: toolCalls returned by the assistant (arguments is a JSON string)
 * - ctx: { workspace, mode, outputRel }, used for path normalization
 * - execute(call, args): returns a Promise, consistent with executeTool callers
 * - isBlocked(call, args): returning true means approval is required / the call must be serialized
 * - onStart(call, args): fired when actual concurrent execution starts, used to emit tool_call events
 */
export function createToolScheduler({
  calls,
  ctx = {},
  execute,
  onStart = null,
  isBlocked = () => false,
  limit = MAX_CONCURRENT_TOOLS,
  signal = null
} = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const byId = new Map();
  const segments = [];
  const limitTask = createLimiter(limit);
  let segment = null;

  for (let index = 0; index < list.length; index += 1) {
    const call = list[index];
    let args = {};
    let parseable = true;
    try {
      args = call?.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      parseable = false;
    }
    const info = parseable ? classifyToolCall(call?.name, args, ctx) : { kind: 'barrier', key: '' };
    const early = Boolean(call?.id) && parseable && info.kind !== 'barrier' && !isBlocked(call, args);
    if (!early) {
      segment = null;
      continue;
    }
    if (!segment) {
      segment = { started: false, entries: [] };
      segments.push(segment);
    }
    const entry = {
      index,
      call,
      args,
      kind: info.kind,
      key: info.key,
      keys: Array.isArray(info.keys) ? info.keys : [],
      segment,
      deps: [],
      promise: null
    };
    // Establish dependencies against all previously enqueued calls by resource conflict: read-read may run concurrently, writes conflict with the same/ancestor/descendant paths.
    entry.deps = segment.entries.filter((previous) => entriesConflict(previous.keys, entry.keys));
    segment.entries.push(entry);
    byId.set(call.id, entry);
  }

  const startEntry = (entry) => {
    const deps = entry.deps.map((dep) => dep.promise).filter(Boolean);
    // A dependency failure does not affect later calls: same as the previous serial behavior, let later tools report their own errors.
    return Promise.all(deps.map((dep) => dep.catch(() => null))).then(() => limitTask(async () => {
      const startedAt = Date.now();
      try {
        if (signal?.aborted) throw new Error('Task cancelled');
        const value = await execute(entry.call, entry.args);
        return {
          call: entry.call,
          index: entry.index,
          ok: true,
          value,
          startedAt,
          finishedAt: Date.now()
        };
      } catch (error) {
        return {
          call: entry.call,
          index: entry.index,
          ok: false,
          error,
          startedAt,
          finishedAt: Date.now()
        };
      }
    }));
  };

  const ensureSegment = (target) => {
    if (!target || target.started) return;
    target.started = true;
    for (const entry of target.entries) {
      try {
        onStart?.(entry.call, entry.args);
      } catch {
        // A UI event failure must not affect tool execution.
      }
    }
    for (const entry of target.entries) entry.promise = startEntry(entry);
  };

  return {
    // Return the pre-execution Promise for this call; null when not in the concurrent set (barrier/needs approval).
    claim(callId) {
      const entry = byId.get(callId);
      if (!entry) return null;
      ensureSegment(entry.segment);
      return entry.promise;
    },
    // Called before executing a barrier to ensure all concurrent calls before it have settled.
    async drain(callId) {
      const boundary = byId.get(callId)?.index ?? list.length;
      const waits = [];
      for (const entry of byId.values()) {
        if (entry.index < boundary && entry.promise) waits.push(entry.promise.catch(() => null));
      }
      await Promise.all(waits);
    },
    entryCount() {
      return byId.size;
    }
  };
}
