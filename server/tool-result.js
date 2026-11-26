import fs from 'node:fs';
import path from 'node:path';
import { TOOL_RESULT_READ_LIMIT } from './token-opt.js';

// Tool result distillation:
// - Results over budget are fully persisted to disk, and only a structured summary + result_id are kept in history;
// - When the model needs details, it calls read_tool_result to read back by line / characters / JSON path;
// - The summary itself contains no timestamps or random numbers, ensuring "same input → same bytes".

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const RESULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PREVIEW_CHARS = 500;

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]'],
  [/\b(?:sk|ak|rk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{12,}\b/g, '[REDACTED]'],
  [/\bLTAI[0-9A-Za-z]{8,}\b/g, '[REDACTED]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]'],
  [/(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;"']{4,}/gi, '$1=[REDACTED]']
];

function clip(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

export function redactResultText(text) {
  let value = String(text ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) value = value.replace(pattern, replacement);
  return value;
}

function safeSegment(value, fallback) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  if (!text || text === '.' || text === '..') return fallback;
  return text;
}

export function toolResultsDir(dataDir) {
  return path.join(dataDir, 'tool-results');
}

function resolveStoredPath(dataDir, resultId) {
  const raw = String(resultId ?? '').trim();
  if (!raw) throw new Error('Missing result_id');
  const parts = raw.split('/');
  if (parts.length !== 2) throw new Error('result_id format should be "sessionSegment/callId"');
  const [sessionSegment, callSegment] = parts;
  if (!SAFE_SEGMENT.test(sessionSegment) || !SAFE_SEGMENT.test(callSegment)) {
    throw new Error('result_id contains illegal characters');
  }
  if (sessionSegment === '..' || callSegment === '..') throw new Error('illegal result_id');
  const base = toolResultsDir(dataDir);
  const file = path.join(base, sessionSegment, `${callSegment}.txt`);
  const resolved = path.resolve(file);
  const baseResolved = path.resolve(base);
  if (resolved !== baseResolved && !resolved.startsWith(`${baseResolved}${path.sep}`)) {
    throw new Error('result_id escapes the tool results directory');
  }
  return { file: resolved, sessionSegment, callSegment };
}

// Persist the full result to disk and return a reference usable by read_tool_result; return null on failure.
function persistResultText({ dataDir, sessionId, callId, toolName, text }) {
  if (!dataDir) return null;
  const sessionSegment = safeSegment(sessionId, 'session');
  const callSegment = safeSegment(callId, 'result');
  if (!SAFE_SEGMENT.test(sessionSegment) || !SAFE_SEGMENT.test(callSegment)) return null;
  const dir = path.join(toolResultsDir(dataDir), sessionSegment);
  const file = path.join(dir, `${callSegment}.txt`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch {
    return null;
  }
  return {
    ref: {
      resultId: `${sessionSegment}/${callSegment}`,
      path: path.relative(dataDir, file).split(path.sep).join('/'),
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: text.split('\n').length,
      tool: toolName
    }
  };
}

function looksLikeJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function jsonShape(text) {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return `Array, length ${value.length}`;
    if (value && typeof value === 'object') return `Object, fields [${Object.keys(value).slice(0, 8).join(', ')}]`;
  } catch {
    // ignore
  }
  return '';
}

export function buildDistillSummary({ toolName, text, resultId, bytes, lines, budget, previewChars = PREVIEW_CHARS }) {
  const previewLimit = Math.max(300, Math.min(previewChars, Math.floor(budget * 0.12) || previewChars));
  const preview = redactResultText(clip(text, previewLimit));
  const shape = looksLikeJson(text) ? jsonShape(text) : '';
  return [
    `[Tool result summary] ${toolName} returned ${text.length} characters (${lines} lines, ${bytes} bytes); the full content has been persisted to disk.`,
    shape ? `JSON shape: ${shape}` : '',
    `result_id: ${resultId}`,
    'Preview:',
    preview,
    'For details, call read_tool_result; you can read with start_line/end_line, offset/length, or json_path.'
  ].filter(Boolean).join('\n');
}

// Distillation entry: returns { distilled, content, ref }.
// content is what gets written into the model history; the full output is kept in the session (fullMessages) for the UI.
export function distillToolResult({
  dataDir,
  sessionId,
  callId,
  toolName,
  output,
  budgets = {},
  enabled = true,
  budget,
  minChars = 0,
  previewChars = PREVIEW_CHARS
} = {}) {
  const text = String(output ?? '');
  if (!enabled || !dataDir || !text) return { distilled: false, content: text };
  const limit = Number.isFinite(Number(budget))
    ? Number(budget)
    : Number(budgets?.[toolName] ?? budgets?.default ?? 10000);
  const floor = Math.max(0, Number(minChars) || 0);
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit || text.length < floor) {
    return { distilled: false, content: text };
  }

  const sessionSegment = safeSegment(sessionId, 'session');
  const callSegment = safeSegment(callId, 'result');
  if (!SAFE_SEGMENT.test(sessionSegment) || !SAFE_SEGMENT.test(callSegment)) {
    return { distilled: false, content: text };
  }

  const stored = persistResultText({ dataDir, sessionId, callId, toolName, text });
  if (!stored) {
    // If persisting to disk fails, fall back to the full content; never let distillation affect the main flow.
    return { distilled: false, content: text };
  }
  const { ref } = stored;
  return {
    distilled: true,
    content: buildDistillSummary({
      toolName,
      text,
      resultId: ref.resultId,
      bytes: ref.bytes,
      lines: ref.lines,
      budget: limit,
      previewChars
    }),
    ref
  };
}

// Injection throttling for large tool results: only the head and tail are written back to history; the middle is persisted and a result_id is given.
// Unlike "distillation", this does not change tool semantics; it only limits the single-step prompt increment to a controllable range.
// read_tool_result is itself the read-back entry and is not throttled a second time, so that users/models can still obtain details.
const INJECT_EXEMPT_TOOLS = new Set(['read_tool_result']);

export function throttleToolResultInjection({
  dataDir,
  sessionId,
  callId,
  toolName,
  output,
  enabled = true,
  capChars = 8000,
  headChars = 4000,
  tailChars = 2000
} = {}) {
  const text = String(output ?? '');
  const cap = Math.max(2000, Number(capChars) || 8000);
  if (!enabled || !dataDir || !text || text.length <= cap || INJECT_EXEMPT_TOOLS.has(toolName)) {
    return { throttled: false, content: text };
  }
  const headLimit = Math.max(200, Math.min(Number(headChars) || 4000, cap - 200));
  const tailLimit = Math.max(200, Math.min(Number(tailChars) || 2000, cap - headLimit));
  const stored = persistResultText({ dataDir, sessionId, callId, toolName, text });
  if (!stored) return { throttled: false, content: text };
  const { ref } = stored;
  const head = redactResultText(clip(text, headLimit));
  const tail = redactResultText(text.slice(text.length - tailLimit));
  const headLines = head.split('\n').length;
  const tailLines = tail.split('\n').length;
  const omitted = Math.max(0, text.length - head.length - tail.length);
  const content = [
    `[Tool result throttled] ${toolName} returned ${text.length} characters (${ref.lines} lines, ${ref.bytes} bytes), exceeding the single-step injection cap of ${cap} characters.`,
    `result_id: ${ref.resultId}`,
    `Injected: head lines 1-${headLines}, tail lines ${Math.max(1, ref.lines - tailLines + 1)}-${ref.lines}; about ${omitted} characters in the middle were not injected.`,
    'Head:',
    head,
    '... (middle omitted)',
    'Tail:',
    tail,
    'For middle content, call read_tool_result and read by start_line/end_line, offset/length, or json_path; do not re-execute the original tool.'
  ].join('\n');
  return { throttled: true, content, ref };
}

// Unified entry: distill first (when approaching the context limit), then throttle injection for results that are still too large.
// An empty returned summary means keep the original text.
export function shapeToolResultForHistory({
  dataDir,
  sessionId,
  callId,
  toolName,
  output,
  budgets,
  distillEnabled,
  minChars,
  previewChars,
  injectEnabled = true,
  injectCapChars = 8000,
  injectHeadChars = 4000,
  injectTailChars = 2000
} = {}) {
  const distilled = distillToolResult({
    dataDir,
    sessionId,
    callId,
    toolName,
    output,
    budgets,
    enabled: distillEnabled,
    minChars,
    previewChars
  });
  if (distilled.distilled) {
    return { mode: 'distilled', summary: distilled.content, ref: distilled.ref };
  }
  const throttled = throttleToolResultInjection({
    dataDir,
    sessionId,
    callId,
    toolName,
    output,
    enabled: injectEnabled,
    capChars: injectCapChars,
    headChars: injectHeadChars,
    tailChars: injectTailChars
  });
  if (throttled.throttled) {
    return { mode: 'throttled', summary: throttled.content, ref: throttled.ref };
  }
  return { mode: 'full', summary: null, ref: null };
}

// Historical view of tool arguments: large arguments of write_file/edit_file/ptc_run keep only path, length, and preview.
// Historical view of tool arguments: must be preserved verbatim.
// Observed risk: if write_file's content is replaced with a placeholder, the model will imitate the placeholder in later turns,
// writing "historical arguments omitted..." into new files and polluting real artifacts. Correctness takes priority over argument size.
export function summarizeToolArguments(name, args) {
  const input = args && typeof args === 'object' ? args : {};
  try {
    return JSON.stringify(input) || '{}';
  } catch {
    return '{}';
  }
}

function readLines(text, start, end) {
  const lines = text.split('\n');
  const from = Math.max(1, Math.floor(Number(start) || 1));
  const to = Number.isFinite(Number(end)) && Number(end) >= from
    ? Math.min(lines.length, Math.floor(Number(end)))
    : Math.min(lines.length, from + 400);
  const slice = lines.slice(from - 1, to);
  return {
    text: slice.join('\n'),
    totalLines: lines.length,
    returnedLines: slice.length,
    from,
    to
  };
}

function parseJsonPath(expression) {
  const raw = String(expression ?? '').trim();
  if (!raw.startsWith('$')) throw new Error('json_path must start with $, for example $.items[0].name');
  const normalized = raw.slice(1).replace(/\[['"]([^'"]+)['"]\]/g, '.$1');
  const tokens = [];
  for (const part of normalized.split('.')) {
    if (!part) continue;
    const match = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(part);
    if (!match) throw new Error('json_path format is not supported');
    if (match[1]) tokens.push({ type: 'key', value: match[1] });
    const brackets = match[2].match(/\[[^\]]*\]/g) || [];
    for (const bracket of brackets) {
      const inner = bracket.slice(1, -1).trim();
      if (inner === '*') tokens.push({ type: 'all' });
      else if (/^\d+$/.test(inner)) tokens.push({ type: 'index', value: Number(inner) });
      else throw new Error('json_path supports only keys, numeric indexes, and [*]');
    }
  }
  return tokens;
}

function applyJsonPath(value, tokens, depth = 0) {
  if (depth > 32) throw new Error('json_path is too deep');
  if (!tokens.length) return value;
  const [token, ...rest] = tokens;
  if (token.type === 'all') {
    if (!Array.isArray(value)) return undefined;
    return value
      .map((item) => applyJsonPath(item, rest, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (token.type === 'key') {
    if (value === null || typeof value !== 'object') return undefined;
    return applyJsonPath(value[token.value], rest, depth + 1);
  }
  if (token.type === 'index') {
    if (!Array.isArray(value)) return undefined;
    return applyJsonPath(value[token.value], rest, depth + 1);
  }
  return undefined;
}

// For the model to read back on demand. The returned structure is uniform, making it easy for the model to judge truncated / total.
export function readStoredToolResult({
  dataDir,
  resultId,
  mode = 'lines',
  startLine = 1,
  endLine,
  offset = 0,
  length,
  jsonPath,
  maxChars = TOOL_RESULT_READ_LIMIT,
  ttlMs = RESULT_TTL_MS
} = {}) {
  const { file, sessionSegment, callSegment } = resolveStoredPath(dataDir, resultId);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return {
      text: `Result does not exist or has been cleaned up: ${sessionSegment}/${callSegment}. Please re-execute the original tool.`,
      missing: true,
      truncated: false
    };
  }
  if (Number.isFinite(ttlMs) && ttlMs > 0 && Date.now() - stat.mtimeMs > ttlMs) {
    return {
      text: `Result has expired (over ${Math.round(ttlMs / 86400000)} days): ${sessionSegment}/${callSegment}. Please re-execute the original tool.`,
      expired: true,
      truncated: false
    };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { text: 'Failed to read the tool result; please re-execute the original tool.', missing: true, truncated: false };
  }

  const cap = Math.max(1, Math.min(Number(maxChars) || TOOL_RESULT_READ_LIMIT, TOOL_RESULT_READ_LIMIT));
  const normalizedMode = ['lines', 'chars', 'json'].includes(mode) ? mode : 'lines';

  if (normalizedMode === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        text: 'This result is not valid JSON; please read it using lines or chars mode instead.',
        truncated: false,
        totalChars: text.length
      };
    }
    let value = parsed;
    if (jsonPath) {
      const tokens = parseJsonPath(jsonPath);
      value = applyJsonPath(parsed, tokens);
      if (value === undefined) {
        return { text: 'json_path did not match any field.', truncated: false, totalChars: text.length };
      }
    }
    const serialized = JSON.stringify(value, null, 2);
    const totalCount = Array.isArray(value) ? value.length : undefined;
    const clipped = serialized.length > cap;
    return {
      text: clipped ? `${serialized.slice(0, cap)}\n... (truncated)` : serialized,
      truncated: clipped,
      totalChars: text.length,
      totalCount,
      returnedCount: Array.isArray(value) ? Math.min(value.length, 100) : undefined
    };
  }

  if (normalizedMode === 'chars') {
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const want = Number.isFinite(Number(length)) ? Math.max(1, Math.floor(Number(length))) : cap;
    const slice = text.slice(start, Math.min(text.length, start + Math.min(want, cap)));
    return {
      text: slice,
      truncated: start + slice.length < text.length,
      totalChars: text.length,
      offset: start,
      returnedChars: slice.length
    };
  }

  const ranged = readLines(text, startLine, endLine);
  const clipped = ranged.text.length > cap;
  return {
    text: clipped ? `${ranged.text.slice(0, cap)}\n... (truncated)` : ranged.text,
    truncated: clipped,
    totalChars: text.length,
    totalLines: ranged.totalLines,
    returnedLines: ranged.returnedLines,
    from: ranged.from,
    to: ranged.to
  };
}
