import { Worker } from 'node:worker_threads';
import { validatePtcCode, PTC_CODE_MAX_CHARS } from './ast-validator.js';
import { executePtcTool, ptcToolNames, PtcToolError } from './tools.js';
import {
  appendPtcAudit,
  createPtcErrorHook,
  newPtcTraceId,
  ptcLogDir
} from './trace.js';

// PTC execution engine (main-thread side):
// - Each ptc_run generates a tr_ptc_ trace ID that all nested tool calls share
// - One worker per task namespace; I-PTC state is reused across ptc_run calls
// - The worker is forcibly terminated after the wall-clock timeout, so sandbox loops cannot stall the service
// - Tool errors all pass through the onToolError hook and are written to the audit log

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_CALLS = 100;
const DEFAULT_MAX_NAMESPACES = 16;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 24000;

const WORKER_LIMITS = {
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4
};

// Namespaces are partitioned by session|scope: the main Agent has no scope,
// while sub-agents/orchestration workers pass a unique scope to avoid sharing I-PTC state or queueing behind each other in parallel.
// runId is no longer part of the key, otherwise every user turn would cold-start a new worker;
// state is reused within the same run, and runNow sends a reset message to soft-clear the sandbox across runs.
function namespaceKey(ctx) {
  const sessionId = ctx?.session?.id || 'session';
  const scope = typeof ctx?.ptcScope === 'string' ? ctx.ptcScope.trim() : '';
  return scope ? `${sessionId}|${scope}` : sessionId;
}

function abortError() {
  const error = new Error('Task cancelled');
  error.code = 'PTC_ABORTED';
  return error;
}

function timeoutError(ms) {
  const error = new Error(`PTC execution timed out (${ms}ms)`);
  error.code = 'PTC_TIMEOUT';
  return error;
}

function truncate(text, limit = MAX_OUTPUT_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n...(PTC output truncated, ${value.length} characters in total)`;
}

function validationText(traceId, validation) {
  const lines = validation.errors.map((item) => {
    const location = item.line ? `Line ${item.line}` : 'code';
    return `- ${location} [${item.code}] ${item.message}`;
  });
  return [
    `[PTC static validation failed] layer ${validation.layer} · ${traceId}`,
    ...lines,
    '',
    'Available read-only APIs: files.list({path?,depth?}), files.read({path,startLine?,endLine?}), files.readMany({paths,startLine?,endLine?}), files.search({query,path?,glob?,target?,caseSensitive?,regex?}), knowledge.search({query,topK?,docName?,collection?,fileType?}), skills.read({name}).',
    'Rules: only var/let/const declarations, ordinary functions, await, for...of; regex literals and new Set/Map/Date/RegExp/Error/Array/Object/Promise are allowed; class, import, this, process, eval, dynamic property access, and absolute paths are not; at most 100 tool calls per run.'
  ].join('\n');
}

function resultText({ traceId, message, toolCalls, durationMs }) {
  const payload = {
    traceId,
    result: message.hasValue ? message.value : null,
    logs: Array.isArray(message.logs) ? message.logs : [],
    state: Array.isArray(message.stateKeys) ? message.stateKeys : [],
    vars: Array.isArray(message.varKeys) ? message.varKeys : []
  };
  if (!message.hasValue) payload.note = 'Code did not return a value';
  let json = '';
  try {
    json = JSON.stringify(payload, null, 2);
  } catch {
    json = String(payload.result ?? '');
  }
  return truncate([
    `PTC execution complete · ${traceId} · ${toolCalls} tool calls · ${durationMs}ms`,
    json
  ].join('\n'));
}

export class PtcEngine {
  constructor(options = {}) {
    this.timeoutMs = Math.max(200, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.maxCalls = Math.max(1, Number(options.maxCalls) || DEFAULT_MAX_CALLS);
    this.maxNamespaces = Math.max(1, Number(options.maxNamespaces) || DEFAULT_MAX_NAMESPACES);
    this.idleMs = Math.max(1000, Number(options.idleMs) || DEFAULT_IDLE_MS);
    this.logDir = options.logDir || ptcLogDir();
    this.entries = new Map();
    this.queues = new Map();
    // I-PTC: record the top-level names already persisted per task namespace for the next static validation.
    this.boundNames = new Map();
    // Record the latest runId per namespace: soft-reset the sandbox across runs to avoid state leaking between turns.
    this.runIds = new Map();
    this.onToolError = typeof options.onToolError === 'function'
      ? options.onToolError
      : createPtcErrorHook({ logDir: this.logDir });
  }

  auditEnabled(ctx) {
    return ctx?.settings?.ptcAudit !== false;
  }

  audit(ctx, record) {
    if (!this.auditEnabled(ctx)) return '';
    return appendPtcAudit({
      ...record,
      sessionId: ctx?.session?.id || '',
      runId: ctx?.runId || ''
    }, { logDir: this.logDir });
  }

  async ensureEntry(key) {
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    this.sweep();
    if (this.entries.size >= this.maxNamespaces) this.evictOldest();
    const entry = {
      key,
      worker: null,
      active: null,
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    };
    entry.worker = new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module',
      // Do not inherit the parent's debug/input arguments, avoiding interference from test or CLI execArgv in the worker.
      execArgv: [],
      resourceLimits: WORKER_LIMITS
    });
    entry.worker.on('message', (message) => this.handleMessage(entry, message));
    entry.worker.on('error', (error) => this.failEntry(entry, error));
    entry.worker.on('exit', () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      this.boundNames.delete(key);
      this.runIds.delete(key);
      this.failEntry(entry, new Error('PTC sandbox exited'));
    });
    this.entries.set(key, entry);
    return entry;
  }

  // Prewarm: start the worker when the task begins and the model is still generating the first step,
  // overlapping sandbox cold start with the LLM's first-token wait. Failures do not affect the main flow.
  async prewarm(ctx = {}) {
    const key = namespaceKey(ctx);
    const existed = this.entries.has(key);
    const startedAt = Date.now();
    await this.ensureEntry(key);
    return {
      key,
      reused: existed,
      durationMs: Date.now() - startedAt
    };
  }

  failEntry(entry, error) {
    const active = entry.active;
    if (!active) return;
    entry.active = null;
    clearTimeout(active.timer);
    active.cleanup?.();
    active.reject(error);
  }

  async dropEntry(key) {
    const entry = this.entries.get(key);
    this.boundNames.delete(key);
    this.runIds.delete(key);
    if (!entry) return;
    this.entries.delete(key);
    this.failEntry(entry, new Error('PTC namespace reset'));
    try {
      await entry.worker.terminate();
    } catch {
      // ignore
    }
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.active) continue;
      if (now - entry.lastUsedAt <= this.idleMs) continue;
      this.entries.delete(key);
      this.boundNames.delete(key);
      this.runIds.delete(key);
      entry.worker.terminate().catch(() => {});
    }
  }

  evictOldest() {
    let oldest = null;
    for (const entry of this.entries.values()) {
      if (entry.active) continue;
      if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) oldest = entry;
    }
    if (!oldest) return;
    this.entries.delete(oldest.key);
    this.boundNames.delete(oldest.key);
    this.runIds.delete(oldest.key);
    oldest.worker.terminate().catch(() => {});
  }

  handleMessage(entry, message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'toolCall') {
      this.handleToolCall(entry, message).catch(() => {});
      return;
    }
    if (message.type === 'runResult') {
      const active = entry.active;
      if (!active || active.id !== message.id) return;
      entry.active = null;
      entry.lastUsedAt = Date.now();
      clearTimeout(active.timer);
      active.cleanup?.();
      active.resolve(message);
    }
  }

  async handleToolCall(entry, message) {
    const active = entry.active;
    const callId = message.callId;
    if (!active) {
      entry.worker.postMessage({
        type: 'toolResult',
        callId,
        payload: JSON.stringify({ ok: false, error: { code: 'PTC_NOT_RUNNING', message: 'PTC execution already finished' } })
      });
      return;
    }
    const ctx = active.ctx;
    const started = Date.now();
    let args = {};
    try {
      args = message.payload ? JSON.parse(message.payload) : {};
    } catch {
      args = {};
    }
    const tool = String(message.tool || '');
    const respond = (payload) => {
      try {
        entry.worker.postMessage({ type: 'toolResult', callId, payload: JSON.stringify(payload) });
      } catch {
        // worker has exited
      }
    };
    try {
      if (ctx.signal?.aborted) throw abortError();
      if (!ptcToolNames().includes(tool)) {
        throw new PtcToolError('PTC_UNKNOWN_TOOL', `Unknown PTC tool: ${tool || '(empty)'}`);
      }
      if (active.calls >= this.maxCalls) {
        throw new PtcToolError('PTC_TOOL_BUDGET', `A single run may call at most ${this.maxCalls} tools; merge calls or split the task`);
      }
      active.calls += 1;
      const value = await executePtcTool(tool, args, ctx);
      const durationMs = Date.now() - started;
      this.audit(ctx, {
        kind: 'tool_call',
        traceId: active.traceId,
        tool,
        ok: true,
        durationMs,
        args
      });
      respond({ ok: true, value });
    } catch (error) {
      const code = error?.code || 'PTC_TOOL_ERROR';
      const messageText = error?.message || 'Tool call failed';
      const durationMs = Date.now() - started;
      this.audit(ctx, {
        kind: 'tool_error',
        traceId: active.traceId,
        tool,
        ok: false,
        code,
        message: messageText,
        durationMs,
        args
      });
      try {
        const outcome = this.onToolError({
          traceId: active.traceId,
          sessionId: ctx?.session?.id || '',
          runId: ctx?.runId || '',
          tool,
          code,
          message: messageText,
          args,
          durationMs,
          layer: 3,
          emit: ctx?.emit
        });
        if (outcome && typeof outcome.catch === 'function') outcome.catch(() => {});
      } catch {
        // A hook failure must not affect the returned tool error.
      }
      respond({ ok: false, error: { code, message: messageText } });
    }
  }

  async runNow(key, code, traceId, ctx, options) {
    const entry = await this.ensureEntry(key);
    const runId = ctx?.runId || 'run';
    // The same worker is reused across user turns, but I-PTC state is isolated per run:
    // only a reset message is sent to soft-clear the vm context without destroying the worker, saving per-turn process/thread cold starts.
    if (options.reset || this.runIds.get(key) !== runId) {
      this.runIds.set(key, runId);
      this.boundNames.delete(key);
      entry.worker.postMessage({ type: 'reset' });
    }
    const timeoutMs = Math.max(200, Number(options.timeoutMs) || this.timeoutMs);
    const startedAt = Date.now();
    const id = `run_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;
    const resultPromise = new Promise((resolve, reject) => {
      entry.active = { id, traceId, ctx, calls: 0, resolve, reject, timer: null, cleanup: null, startedAt };
    });
    const active = entry.active;

    let cleanupAbort = null;
    const abortPromise = new Promise((_, reject) => {
      if (!ctx?.signal) return;
      const onAbort = () => reject(abortError());
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      cleanupAbort = () => ctx.signal.removeEventListener('abort', onAbort);
    });
    const timeoutPromise = new Promise((_, reject) => {
      active.timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
    });
    active.cleanup = () => cleanupAbort?.();

    try {
      entry.worker.postMessage({ type: 'run', id, code, traceId });
      const message = await Promise.race([resultPromise, timeoutPromise, abortPromise]);
      const durationMs = Date.now() - startedAt;
      if (!message.ok) {
        const error = message.error || {};
        this.audit(ctx, {
          kind: 'execution_error',
          traceId,
          tool: '',
          ok: false,
          code: error.code || 'PTC_RUNTIME_ERROR',
          message: error.message || 'Execution failed',
          durationMs,
          calls: active.calls
        });
        return {
          text: `[PTC execution failed] ${traceId}\n- [${error.code || 'PTC_RUNTIME_ERROR'}] ${error.message || 'Execution failed'}`,
          meta: { traceId, ptc: true, failed: true, toolCalls: active.calls, durationMs }
        };
      }
      this.audit(ctx, {
        kind: 'execution',
        traceId,
        tool: '',
        ok: true,
        durationMs,
        calls: active.calls,
        stateKeys: message.stateKeys || []
      });
      this.boundNames.set(key, new Set(
        (message.varKeys || []).filter((name) => typeof name === 'string' && name)
      ));
      return {
        text: resultText({ traceId, message, toolCalls: active.calls, durationMs }),
        meta: {
          traceId,
          ptc: true,
          toolCalls: active.calls,
          durationMs,
          stateKeys: (message.stateKeys || []).slice(0, 20)
        }
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const code = error?.code || 'PTC_RUNTIME_ERROR';
      if (code === 'PTC_TIMEOUT') {
        await this.dropEntry(key);
        this.audit(ctx, {
          kind: 'timeout',
          traceId,
          tool: '',
          ok: false,
          code,
          message: error.message,
          durationMs,
          calls: active.calls
        });
        return {
          text: `[PTC execution timed out] ${traceId}\n- Exceeded ${timeoutMs}ms; the sandbox was forcibly terminated and this task's persistent state has been cleared. Narrow or split the task and retry.`,
          meta: { traceId, ptc: true, timedOut: true, toolCalls: active.calls, durationMs }
        };
      }
      if (code === 'PTC_ABORTED') {
        await this.dropEntry(key);
        return {
          text: 'PTC execution cancelled.',
          meta: { traceId, ptc: true, aborted: true, toolCalls: active.calls, durationMs }
        };
      }
      // Worker crash: drop the namespace to avoid continuing with a corrupted context.
      await this.dropEntry(key);
      this.audit(ctx, {
        kind: 'worker_error',
        traceId,
        tool: '',
        ok: false,
        code,
        message: error?.message || 'Sandbox exited abnormally',
        durationMs,
        calls: active.calls
      });
      return {
        text: `[PTC sandbox error] ${traceId}\n- ${error?.message || 'Sandbox exited abnormally'}. This task's persistent state has been cleared.`,
        meta: { traceId, ptc: true, failed: true, toolCalls: active.calls, durationMs }
      };
    } finally {
      if (entry.active === active) entry.active = null;
      clearTimeout(active.timer);
      cleanupAbort?.();
    }
  }

  /**
   * Execute a piece of PTC code. Returns { text, meta }; user code/validation errors are never thrown as exceptions.
   */
  async run(code, ctx = {}, options = {}) {
    const traceId = options.traceId || newPtcTraceId();
    const source = typeof code === 'string' ? code : '';
    const key = namespaceKey(ctx);
    const runId = ctx?.runId || 'run';
    // The first call of a new run performs static validation as if there were no persistent variables; the actual reset happens in runNow after queuing.
    const newRun = this.runIds.has(key) && this.runIds.get(key) !== runId;
    const allowedBindings = (options.reset || newRun) ? [] : [...(this.boundNames.get(key) || [])];
    const validation = validatePtcCode(source, {
      maxChars: PTC_CODE_MAX_CHARS,
      allowedBindings
    });
    if (!validation.ok) {
      this.audit(ctx, {
        kind: 'rejected',
        traceId,
        tool: '',
        ok: false,
        code: validation.errors[0]?.code || 'PTC_REJECTED',
        message: validation.errors[0]?.message || 'Static validation failed',
        calls: 0
      });
      return {
        text: validationText(traceId, validation),
        meta: {
          traceId,
          ptc: true,
          rejected: true,
          layer: validation.layer,
          errors: validation.errors.map((item) => item.code)
        }
      };
    }

    const previous = this.queues.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.runNow(key, source, traceId, ctx, options));
    const chain = task.then(() => {}, () => {});
    this.queues.set(key, chain);
    try {
      return await task;
    } catch (error) {
      return {
        text: `[PTC execution error] ${traceId}\n- ${error?.message || 'Unknown error'}`,
        meta: { traceId, ptc: true, failed: true }
      };
    } finally {
      if (this.queues.get(key) === chain) this.queues.delete(key);
    }
  }

  async disposeRun(runId) {
    const matchesRun = (key) => this.runIds.get(key) === runId;
    const keys = [...this.entries.keys()].filter(matchesRun);
    for (const key of [...this.queues.keys()]) {
      if (matchesRun(key)) this.queues.delete(key);
    }
    await Promise.all(keys.map((key) => this.dropEntry(key)));
  }

  async disposeScope(scope) {
    if (!scope) return;
    const suffix = `|${scope}`;
    const keys = [...this.entries.keys()].filter((key) => key.endsWith(suffix));
    for (const key of [...this.queues.keys()]) {
      if (key.endsWith(suffix)) this.queues.delete(key);
    }
    await Promise.all(keys.map((key) => this.dropEntry(key)));
  }

  async shutdown() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.queues.clear();
    this.boundNames.clear();
    this.runIds.clear();
    await Promise.all(entries.map(async (entry) => {
      this.failEntry(entry, new Error('PTC engine shut down'));
      try {
        await entry.worker.terminate();
      } catch {
        // ignore
      }
    }));
  }
}
