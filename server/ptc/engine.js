import { Worker } from 'node:worker_threads';
import { validatePtcCode, PTC_CODE_MAX_CHARS } from './ast-validator.js';
import { executePtcTool, ptcToolNames, PtcToolError } from './tools.js';
import {
  appendPtcAudit,
  createPtcErrorHook,
  newPtcTraceId,
  ptcLogDir
} from './trace.js';

// PTC 执行引擎（主线程侧）：
// - 每次 ptc_run 生成 tr_ptc_ 追踪 ID，所有嵌套工具调用共享
// - 每个任务命名空间一个 worker，I-PTC 状态在多次 ptc_run 之间复用
// - 墙钟超时后强制终止 worker，沙盒内循环无法拖死服务
// - 工具错误统一经过 onToolError 钩子，并写入审计日志

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

// 命名空间按 session|scope 划分：主 Agent 不带 scope，
// 子 Agent/编排 worker 传入唯一 scope，避免并行时共享 I-PTC 状态或互相排队。
// runId 不再进入 key，否则每次用户轮次都会冷启一个新 worker；
// 同一 run 内复用状态，跨 run 时由 runNow 发 reset 消息软清空沙盒。
function namespaceKey(ctx) {
  const sessionId = ctx?.session?.id || 'session';
  const scope = typeof ctx?.ptcScope === 'string' ? ctx.ptcScope.trim() : '';
  return scope ? `${sessionId}|${scope}` : sessionId;
}

function abortError() {
  const error = new Error('任务已取消');
  error.code = 'PTC_ABORTED';
  return error;
}

function timeoutError(ms) {
  const error = new Error(`PTC 执行超时（${ms}ms）`);
  error.code = 'PTC_TIMEOUT';
  return error;
}

function truncate(text, limit = MAX_OUTPUT_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n...（PTC 输出已截断，共 ${value.length} 字符）`;
}

function validationText(traceId, validation) {
  const lines = validation.errors.map((item) => {
    const location = item.line ? `第 ${item.line} 行` : '代码';
    return `- ${location} [${item.code}] ${item.message}`;
  });
  return [
    `【PTC 静态校验未通过】第 ${validation.layer} 层 · ${traceId}`,
    ...lines,
    '',
    '可用只读 API：files.list({path?,depth?})、files.read({path,startLine?,endLine?})、files.readMany({paths,startLine?,endLine?})、files.search({query,path?,glob?,target?,caseSensitive?,regex?})、knowledge.search({query,topK?,docName?,collection?,fileType?})、skills.read({name})。',
    '规则：只能使用 var/let/const 声明、普通函数、await、for...of；允许正则字面量和 new Set/Map/Date/RegExp/Error/Array/Object/Promise；不能使用 class、import、this、process、eval、动态属性访问或绝对路径；单次最多 100 次工具调用。'
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
  if (!message.hasValue) payload.note = '代码没有 return 值';
  let json = '';
  try {
    json = JSON.stringify(payload, null, 2);
  } catch {
    json = String(payload.result ?? '');
  }
  return truncate([
    `PTC 执行完成 · ${traceId} · ${toolCalls} 次工具调用 · ${durationMs}ms`,
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
    // I-PTC：记录每个任务命名空间已持久化的顶层名称，供下一次静态校验识别。
    this.boundNames = new Map();
    // 记录每个命名空间最近一次 runId：跨 run 时软重置沙盒，避免状态串轮次。
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
      // 不继承父进程的调试/输入参数，避免测试或 CLI 的 execArgv 干扰 worker。
      execArgv: [],
      resourceLimits: WORKER_LIMITS
    });
    entry.worker.on('message', (message) => this.handleMessage(entry, message));
    entry.worker.on('error', (error) => this.failEntry(entry, error));
    entry.worker.on('exit', () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      this.boundNames.delete(key);
      this.runIds.delete(key);
      this.failEntry(entry, new Error('PTC 沙盒已退出'));
    });
    this.entries.set(key, entry);
    return entry;
  }

  // 预热：在任务开始、模型还在生成第一步时就把 worker 启起来，
  // 让沙盒冷启与 LLM 首字等待重叠。失败不影响主流程。
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
    this.failEntry(entry, new Error('PTC 命名空间已重置'));
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
        payload: JSON.stringify({ ok: false, error: { code: 'PTC_NOT_RUNNING', message: 'PTC 执行已结束' } })
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
        // worker 已退出
      }
    };
    try {
      if (ctx.signal?.aborted) throw abortError();
      if (!ptcToolNames().includes(tool)) {
        throw new PtcToolError('PTC_UNKNOWN_TOOL', `未知 PTC 工具：${tool || '(空)'}`);
      }
      if (active.calls >= this.maxCalls) {
        throw new PtcToolError('PTC_TOOL_BUDGET', `单次执行最多调用 ${this.maxCalls} 次工具，请合并调用或拆分任务`);
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
      const messageText = error?.message || '工具调用失败';
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
        // 钩子失败不能影响工具错误返回。
      }
      respond({ ok: false, error: { code, message: messageText } });
    }
  }

  async runNow(key, code, traceId, ctx, options) {
    const entry = await this.ensureEntry(key);
    const runId = ctx?.runId || 'run';
    // 同一 worker 跨用户轮次复用，但 I-PTC 状态按 run 隔离：
    // 只发 reset 消息软清空 vm 上下文，不销毁 worker，省掉每轮进程/线程冷启。
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
          message: error.message || '执行失败',
          durationMs,
          calls: active.calls
        });
        return {
          text: `【PTC 执行失败】${traceId}\n- [${error.code || 'PTC_RUNTIME_ERROR'}] ${error.message || '执行失败'}`,
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
          text: `【PTC 执行超时】${traceId}\n- 已超过 ${timeoutMs}ms，沙盒已强制终止，本次任务的持久状态已清空。请缩小任务或拆分后重试。`,
          meta: { traceId, ptc: true, timedOut: true, toolCalls: active.calls, durationMs }
        };
      }
      if (code === 'PTC_ABORTED') {
        await this.dropEntry(key);
        return {
          text: 'PTC 执行已取消。',
          meta: { traceId, ptc: true, aborted: true, toolCalls: active.calls, durationMs }
        };
      }
      // worker 崩溃：丢弃命名空间，避免继续使用损坏的上下文。
      await this.dropEntry(key);
      this.audit(ctx, {
        kind: 'worker_error',
        traceId,
        tool: '',
        ok: false,
        code,
        message: error?.message || '沙盒异常退出',
        durationMs,
        calls: active.calls
      });
      return {
        text: `【PTC 沙盒异常】${traceId}\n- ${error?.message || '沙盒异常退出'}。本次任务的持久状态已清空。`,
        meta: { traceId, ptc: true, failed: true, toolCalls: active.calls, durationMs }
      };
    } finally {
      if (entry.active === active) entry.active = null;
      clearTimeout(active.timer);
      cleanupAbort?.();
    }
  }

  /**
   * 执行一段 PTC 代码。返回 { text, meta }，用户代码/校验错误不会以异常形式抛出。
   */
  async run(code, ctx = {}, options = {}) {
    const traceId = options.traceId || newPtcTraceId();
    const source = typeof code === 'string' ? code : '';
    const key = namespaceKey(ctx);
    const runId = ctx?.runId || 'run';
    // 新 run 的第一次调用按“无持久变量”做静态校验；真正清空在排队后的 runNow 里执行。
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
        message: validation.errors[0]?.message || '静态校验未通过',
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
        text: `【PTC 执行异常】${traceId}\n- ${error?.message || '未知错误'}`,
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
      this.failEntry(entry, new Error('PTC 引擎已关闭'));
      try {
        await entry.worker.terminate();
      } catch {
        // ignore
      }
    }));
  }
}
