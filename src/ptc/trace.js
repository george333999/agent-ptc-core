import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// PTC 追踪与审计：同一轮 ptc_run 内的所有嵌套工具调用共享同一个 traceId，
// 便于事后按 tr_ptc_ 前缀聚合排查；错误统一经过 onToolError 钩子落盘。

const TRACE_PREFIX = 'tr_ptc_';
const MAX_ARG_TEXT = 600;
const MAX_MESSAGE = 800;

export function ptcLogDir() {
  return process.env.AGENTPROJECT_PTC_LOG_DIR
    || path.join(process.cwd(), 'security-logs');
}

export function newPtcTraceId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${TRACE_PREFIX}${stamp}_${crypto.randomBytes(4).toString('hex')}`;
}

function text(value, limit) {
  const raw = String(value ?? '');
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

function safeJson(value, limit = MAX_ARG_TEXT) {
  try {
    const json = JSON.stringify(value);
    return text(json === undefined ? '' : json, limit);
  } catch {
    return '[无法序列化]';
  }
}

function dayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function appendJsonLine(dir, fileName, record) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, fileName), `${JSON.stringify(record)}\n`, 'utf8');
    return path.join(dir, fileName);
  } catch {
    return '';
  }
}

/**
 * 审计一行工具调用记录。成功与失败都写，用 traceId 关联。
 */
export function appendPtcAudit(record = {}, options = {}) {
  const dir = options.logDir || ptcLogDir();
  const line = {
    ts: new Date().toISOString(),
    kind: record.kind || 'tool_call',
    traceId: text(record.traceId, 80),
    sessionId: text(record.sessionId, 80),
    runId: text(record.runId, 80),
    tool: text(record.tool, 120),
    ok: record.ok !== false,
    durationMs: Number(record.durationMs) || 0,
    ...(record.calls !== undefined ? { calls: Number(record.calls) || 0 } : {}),
    ...(record.code ? { code: text(record.code, 80) } : {}),
    ...(record.message ? { message: text(record.message, MAX_MESSAGE) } : {}),
    ...(record.args !== undefined ? { args: safeJson(record.args) } : {}),
    ...(record.stateKeys ? { stateKeys: record.stateKeys.slice(0, 30).map((key) => text(key, 80)) } : {})
  };
  return appendJsonLine(dir, `ptc-audit-${dayStamp()}.jsonl`, line);
}

/**
 * 结构化错误钩子：默认把失败原因写入 security-logs/ptc-errors-*.jsonl，
 * 同时通过 emit 暴露给上层（日志、错误追踪或审计行），而不是只在 stderr 一闪而过。
 */
export function createPtcErrorHook(options = {}) {
  const dir = options.logDir || ptcLogDir();
  return function onToolError(event = {}) {
    const record = {
      ts: new Date().toISOString(),
      kind: 'tool_error',
      traceId: text(event.traceId, 80),
      sessionId: text(event.sessionId, 80),
      runId: text(event.runId, 80),
      tool: text(event.tool, 120),
      code: text(event.code || 'PTC_TOOL_ERROR', 80),
      message: text(event.message || '工具调用失败', MAX_MESSAGE),
      durationMs: Number(event.durationMs) || 0,
      ...(event.args !== undefined ? { args: safeJson(event.args) } : {}),
      ...(event.layer ? { layer: Number(event.layer) || 0 } : {})
    };
    const file = appendJsonLine(dir, `ptc-errors-${dayStamp()}.jsonl`, record);
    try {
      event.emit?.('ptc_tool_error', {
        traceId: record.traceId,
        tool: record.tool,
        code: record.code,
        message: record.message
      });
    } catch {
      // 事件发送失败不能影响工具错误处理。
    }
    return file;
  };
}

/**
 * 调试模式下保留模型原始输出（含 logprobs），用于区分“模型生成问题”和“执行环境问题”。
 * 不写入会话历史，避免把大对象塞进 sessions.json。
 */
export function recordModelDebug(record = {}, options = {}) {
  const dir = options.logDir || ptcLogDir();
  const logprobs = Array.isArray(record.logprobs) ? record.logprobs.slice(0, 800).map((item) => ({
    token: text(item?.token, 80),
    logprob: Number(item?.logprob),
    top: Array.isArray(item?.top)
      ? item.top.slice(0, 5).map((entry) => ({ token: text(entry?.token, 40), logprob: Number(entry?.logprob) }))
      : []
  })) : [];
  const line = {
    ts: new Date().toISOString(),
    kind: 'model_debug',
    sessionId: text(record.sessionId, 80),
    runId: text(record.runId, 80),
    agent: text(record.agent, 40),
    taskId: text(record.taskId, 80),
    step: Number(record.step) || 0,
    model: text(record.model, 120),
    traceIds: Array.isArray(record.traceIds) ? record.traceIds.slice(0, 10).map((id) => text(id, 80)) : [],
    finishReason: text(record.finishReason, 40),
    usage: record.usage || null,
    logprobsUnavailable: Boolean(record.logprobsUnavailable),
    content: text(record.content, 20000),
    toolCalls: Array.isArray(record.toolCalls)
      ? record.toolCalls.slice(0, 30).map((call) => ({
          name: text(call?.name, 80),
          arguments: text(call?.arguments, 4000)
        }))
      : [],
    logprobs
  };
  return appendJsonLine(dir, `ptc-debug-${dayStamp()}.jsonl`, line);
}
