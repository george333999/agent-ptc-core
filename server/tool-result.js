import fs from 'node:fs';
import path from 'node:path';
import { TOOL_RESULT_READ_LIMIT } from './token-opt.js';

// 工具结果蒸馏：
// - 超过预算的结果完整落盘，历史里只保留结构化摘要 + result_id；
// - 模型需要细节时调用 read_tool_result 按行 / 字符 / JSON path 回读；
// - 摘要本身不包含时间戳、随机数，保证“同一输入 → 同一字节”。

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
  if (!raw) throw new Error('缺少 result_id');
  const parts = raw.split('/');
  if (parts.length !== 2) throw new Error('result_id 格式应为 "会话段/callId"');
  const [sessionSegment, callSegment] = parts;
  if (!SAFE_SEGMENT.test(sessionSegment) || !SAFE_SEGMENT.test(callSegment)) {
    throw new Error('result_id 含非法字符');
  }
  if (sessionSegment === '..' || callSegment === '..') throw new Error('result_id 非法');
  const base = toolResultsDir(dataDir);
  const file = path.join(base, sessionSegment, `${callSegment}.txt`);
  const resolved = path.resolve(file);
  const baseResolved = path.resolve(base);
  if (resolved !== baseResolved && !resolved.startsWith(`${baseResolved}${path.sep}`)) {
    throw new Error('result_id 越出了工具结果目录');
  }
  return { file: resolved, sessionSegment, callSegment };
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
    if (Array.isArray(value)) return `数组，长度 ${value.length}`;
    if (value && typeof value === 'object') return `对象，字段 [${Object.keys(value).slice(0, 8).join(', ')}]`;
  } catch {
    // ignore
  }
  return '';
}

export function buildDistillSummary({ toolName, text, resultId, bytes, lines, budget }) {
  const previewLimit = Math.max(120, Math.min(PREVIEW_CHARS, Math.floor(budget * 0.12) || PREVIEW_CHARS));
  const preview = redactResultText(clip(text, previewLimit));
  const shape = looksLikeJson(text) ? jsonShape(text) : '';
  return [
    `[工具结果摘要] ${toolName} 返回 ${text.length} 字符（${lines} 行，${bytes} 字节），完整内容已落盘。`,
    shape ? `JSON 结构：${shape}` : '',
    `result_id: ${resultId}`,
    '预览：',
    preview,
    '需要细节时调用 read_tool_result，可用 start_line/end_line、offset/length 或 json_path 读取。'
  ].filter(Boolean).join('\n');
}

// 蒸馏入口：返回 { distilled, content, ref }。
// content 是写入模型历史的内容；完整输出保留在 session（fullMessages）里供 UI 显示。
export function distillToolResult({
  dataDir,
  sessionId,
  callId,
  toolName,
  output,
  budgets = {},
  enabled = true,
  budget
} = {}) {
  const text = String(output ?? '');
  if (!enabled || !dataDir || !text) return { distilled: false, content: text };
  const limit = Number.isFinite(Number(budget))
    ? Number(budget)
    : Number(budgets?.[toolName] ?? budgets?.default ?? 10000);
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) {
    return { distilled: false, content: text };
  }

  const sessionSegment = safeSegment(sessionId, 'session');
  const callSegment = safeSegment(callId, 'result');
  if (!SAFE_SEGMENT.test(sessionSegment) || !SAFE_SEGMENT.test(callSegment)) {
    return { distilled: false, content: text };
  }

  const dir = path.join(toolResultsDir(dataDir), sessionSegment);
  const file = path.join(dir, `${callSegment}.txt`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch {
    // 落盘失败时退回完整内容，绝不让蒸馏影响主流程。
    return { distilled: false, content: text };
  }

  const bytes = Buffer.byteLength(text, 'utf8');
  const lines = text.split('\n').length;
  const resultId = `${sessionSegment}/${callSegment}`;
  const ref = {
    resultId,
    path: path.relative(dataDir, file).split(path.sep).join('/'),
    bytes,
    lines,
    tool: toolName
  };
  return {
    distilled: true,
    content: buildDistillSummary({ toolName, text, resultId, bytes, lines, budget: limit }),
    ref
  };
}

// 工具参数的历史视图：write_file/edit_file/ptc_run 等大参数只保留路径、长度与预览。
// 工具参数的历史视图：必须原样保留。
// 实测风险：如果把 write_file 的 content 换成占位符，模型会在后续轮次模仿占位符，
// 把“历史参数已省略…”写进新文件，造成真实产物污染。正确性优先于参数体积。
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
  if (!raw.startsWith('$')) throw new Error('json_path 必须以 $ 开头，例如 $.items[0].name');
  const normalized = raw.slice(1).replace(/\[['"]([^'"]+)['"]\]/g, '.$1');
  const tokens = [];
  for (const part of normalized.split('.')) {
    if (!part) continue;
    const match = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(part);
    if (!match) throw new Error('json_path 格式不支持');
    if (match[1]) tokens.push({ type: 'key', value: match[1] });
    const brackets = match[2].match(/\[[^\]]*\]/g) || [];
    for (const bracket of brackets) {
      const inner = bracket.slice(1, -1).trim();
      if (inner === '*') tokens.push({ type: 'all' });
      else if (/^\d+$/.test(inner)) tokens.push({ type: 'index', value: Number(inner) });
      else throw new Error('json_path 仅支持键名、数字下标和 [*]');
    }
  }
  return tokens;
}

function applyJsonPath(value, tokens, depth = 0) {
  if (depth > 32) throw new Error('json_path 过深');
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

// 供模型按需回读。返回结构统一，便于模型判断 truncated / total。
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
      text: `结果不存在或已被清理：${sessionSegment}/${callSegment}。请重新执行原工具。`,
      missing: true,
      truncated: false
    };
  }
  if (Number.isFinite(ttlMs) && ttlMs > 0 && Date.now() - stat.mtimeMs > ttlMs) {
    return {
      text: `结果已过期（超过 ${Math.round(ttlMs / 86400000)} 天）：${sessionSegment}/${callSegment}。请重新执行原工具。`,
      expired: true,
      truncated: false
    };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { text: '读取工具结果失败，请重新执行原工具。', missing: true, truncated: false };
  }

  const cap = Math.max(1, Math.min(Number(maxChars) || TOOL_RESULT_READ_LIMIT, TOOL_RESULT_READ_LIMIT));
  const normalizedMode = ['lines', 'chars', 'json'].includes(mode) ? mode : 'lines';

  if (normalizedMode === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        text: '该结果不是合法 JSON，请改用 lines 或 chars 模式读取。',
        truncated: false,
        totalChars: text.length
      };
    }
    let value = parsed;
    if (jsonPath) {
      const tokens = parseJsonPath(jsonPath);
      value = applyJsonPath(parsed, tokens);
      if (value === undefined) {
        return { text: 'json_path 未命中任何字段。', truncated: false, totalChars: text.length };
      }
    }
    const serialized = JSON.stringify(value, null, 2);
    const totalCount = Array.isArray(value) ? value.length : undefined;
    const clipped = serialized.length > cap;
    return {
      text: clipped ? `${serialized.slice(0, cap)}\n…（已截断）` : serialized,
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
    text: clipped ? `${ranged.text.slice(0, cap)}\n…（已截断）` : ranged.text,
    truncated: clipped,
    totalChars: text.length,
    totalLines: ranged.totalLines,
    returnedLines: ranged.returnedLines,
    from: ranged.from,
    to: ranged.to
  };
}
