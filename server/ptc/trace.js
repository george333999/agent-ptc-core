import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// PTC tracing and auditing: all nested tool calls within the same ptc_run share one traceId,
// making post-hoc investigation easy to aggregate by the tr_ptc_ prefix; errors uniformly land on disk through the onToolError hook.

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
    return '[unserializable]';
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
 * Audit one tool-call record. Both success and failure are written, correlated by traceId.
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
 * Structured error hook: by default writes the failure reason into security-logs/ptc-errors-*.jsonl,
 * and also exposes it to upper layers via emit (logs, error tracing, or audit rows), instead of a brief flash on stderr.
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
      message: text(event.message || 'Tool call failed', MAX_MESSAGE),
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
      // An event-send failure must not affect tool error handling.
    }
    return file;
  };
}

/**
 * In debug mode, retain the model's raw output (including logprobs) to distinguish "model generation issues" from "execution environment issues".
 * Not written into session history, avoiding stuffing large objects into sessions.json.
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
