// 工具并发调度：按“路径依赖 + 屏障”决定同一轮内哪些工具可以同时执行。
// 只负责调度，不改变工具语义；同一文件的写入仍由 tools.js 的资源锁串行保护。
//
// 规则：
// 1) 路径写（write_file/edit_file/delete_file）按规范化路径，不同路径可并发；
// 2) 路径读（read_file）与同路径/祖先路径的写保持先后，不同路径可并发；
// 3) 全量扫描读（list_files/search_files）与写按目录祖先关系排序；
// 4) 独立读（web/knowledge/tool_result 等）不依赖文件，直接并发；
// 5) 带确定 scope 的 run_command 是 verify 节点：读输入、写输出，可与无关写并发；
// 6) 其余工具、未知命令、参数解析失败、需要审批的调用都是屏障，前后串行。

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

// 回滚/对照开关：AGENT_TOOL_CONCURRENCY=0 时退回“仅连续只读并发”的旧行为。
export function toolConcurrencyEnabled(env = process.env) {
  return String(env?.AGENT_TOOL_CONCURRENCY ?? '') !== '0';
}

function normalizePathKey(ctx, rawPath, scope) {
  const rel = resolveOutputPath(ctx, rawPath);
  if (!rel) return '';
  const resolved = path.resolve(resolveWorkspacePath(ctx.workspace, rel));
  // Windows 文件系统大小写不敏感，key 必须同样归一，否则同一文件会被判成两个资源。
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

// _v43.py 这类同脚本多版本写入必须走屏障：预执行会绕过版本爆炸守卫，
// 而且版本号通常意味着“上一步没成功”，不适合并发落盘。
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
 * 创建一轮工具调用的调度器。
 * - calls: assistant 返回的 toolCalls（arguments 为 JSON 字符串）
 * - ctx: { workspace, mode, outputRel }，用于路径归一化
 * - execute(call, args): 返回 Promise，与 executeTool 调用方保持一致
 * - isBlocked(call, args): 返回 true 表示需要审批/必须串行
 * - onStart(call, args): 调用真正开始并发执行时触发，用于发 tool_call 事件
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
    // 与之前所有已入段调用按资源冲突建立依赖：读读可并发，写与同路径/祖先/后代互斥。
    entry.deps = segment.entries.filter((previous) => entriesConflict(previous.keys, entry.keys));
    segment.entries.push(entry);
    byId.set(call.id, entry);
  }

  const startEntry = (entry) => {
    const deps = entry.deps.map((dep) => dep.promise).filter(Boolean);
    // 依赖失败不影响后续调用：与原串行行为一致，让后续工具自己报错。
    return Promise.all(deps.map((dep) => dep.catch(() => null))).then(() => limitTask(async () => {
      const startedAt = Date.now();
      try {
        if (signal?.aborted) throw new Error('任务已取消');
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
        // UI 事件失败不能影响工具执行。
      }
    }
    for (const entry of target.entries) entry.promise = startEntry(entry);
  };

  return {
    // 返回该调用的预执行 Promise；不在并发集合内（屏障/需审批）时返回 null。
    claim(callId) {
      const entry = byId.get(callId);
      if (!entry) return null;
      ensureSegment(entry.segment);
      return entry.promise;
    },
    // 执行屏障前调用，确保它之前的所有并发调用都已结算。
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
