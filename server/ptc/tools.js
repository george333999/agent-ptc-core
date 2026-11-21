import fs from 'node:fs';
import path from 'node:path';
import { resolveWithinWorkspace } from '../paths.js';
import { embeddingConfigFor } from '../embeddings.js';
import { PTC_TOOL_SPECS } from './specs.js';

// PTC 类型化只读工具层。
// 与原生工具不同：这里返回经过校验的规范 JSON 值，而不是给人读的渲染字符串；
// 参数逐个校验（类型、范围、未知键、路径穿越），不暴露 shell、通用文件系统或数据库访问。

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '.nuxt', 'target', 'build', 'coverage', '.idea', '.vscode', '__pycache__', '.venv', 'venv']);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.mp4', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.lock',
  '.pptx', '.docx', '.xlsx'
]);

const LIST_LIMIT = 400;
const SEARCH_MATCH_LIMIT = 200;
const SEARCH_SCAN_LIMIT = 4000;
const READ_FILE_LIMIT = 2 * 1024 * 1024;
const READ_CHAR_LIMIT = 500000;
const SKILL_CHAR_LIMIT = 200000;

export class PtcToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PtcToolError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message) {
  throw new PtcToolError(code, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value, name, spec) {
  if (typeof value !== 'string') fail('PTC_ARG_TYPE', `${name} 必须是字符串`);
  const trimmed = value.trim();
  if (spec.required && !trimmed) fail('PTC_ARG_TYPE', `${name} 不能为空`);
  if (spec.maxLength && trimmed.length > spec.maxLength) {
    fail('PTC_ARG_TYPE', `${name} 长度不能超过 ${spec.maxLength}`);
  }
  return trimmed;
}

function integerValue(value, name, spec) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || !Number.isInteger(number)) {
    fail('PTC_ARG_TYPE', `${name} 必须是整数`);
  }
  if (spec.min !== undefined && number < spec.min) return spec.min;
  if (spec.max !== undefined && number > spec.max) return spec.max;
  return number;
}

export function normalizePtcArgs(apiName, rawArgs) {
  const spec = PTC_TOOL_SPECS[apiName];
  if (!spec) fail('PTC_UNKNOWN_TOOL', `未知 PTC 工具：${apiName}`);
  if (rawArgs === undefined || rawArgs === null) rawArgs = {};
  if (!isPlainObject(rawArgs)) fail('PTC_ARG_TYPE', `${apiName} 的参数必须是对象`);
  const args = {};
  for (const key of Object.keys(rawArgs)) {
    if (!spec.args[key]) fail('PTC_UNKNOWN_ARG', `${apiName} 不支持参数 ${key}`);
    const argSpec = spec.args[key];
    const value = rawArgs[key];
    if (value === undefined) continue;
    if (argSpec.type === 'string') {
      args[key] = textValue(value, key, argSpec);
    } else if (argSpec.type === 'integer') {
      args[key] = integerValue(value, key, argSpec);
    } else if (argSpec.type === 'boolean') {
      if (typeof value !== 'boolean') fail('PTC_ARG_TYPE', `${key} 必须是布尔值`);
      args[key] = value;
    } else if (argSpec.type === 'enum') {
      if (!argSpec.values.includes(value)) fail('PTC_ARG_TYPE', `${key} 只能是 ${argSpec.values.join(' / ')}`);
      args[key] = value;
    }
  }
  for (const [key, argSpec] of Object.entries(spec.args)) {
    if (argSpec.required && args[key] === undefined) fail('PTC_ARG_TYPE', `缺少参数 ${key}`);
  }
  return args;
}

function assertEnabled(apiName, settings = {}) {
  const spec = PTC_TOOL_SPECS[apiName];
  if (Array.isArray(settings.disabledTools) && settings.disabledTools.includes(spec.native)) {
    fail('PTC_TOOL_DISABLED', `工具已被禁用：${spec.native}`);
  }
}

function resolvePtcPath(workspace, relative) {
  try {
    return resolveWithinWorkspace(workspace, relative || '.');
  } catch {
    fail('PTC_PATH_ESCAPE', `路径超出工作区：${relative}`);
  }
}

function relativePath(workspace, absolute) {
  return path.relative(workspace, absolute).split(path.sep).join('/') || '.';
}

function walkTree(dir, workspace, depth, out, limit) {
  if (out.length >= limit || depth < 0) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push({ path: relativePath(workspace, full), type: 'dir' });
      walkTree(full, workspace, depth - 1, out, limit);
    } else if (entry.isFile()) {
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* ignore */ }
      out.push({ path: relativePath(workspace, full), type: 'file', size });
    }
  }
}

function listFiles(args, ctx) {
  const target = resolvePtcPath(ctx.workspace, args.path || '.');
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    fail('PTC_NOT_FOUND', `路径不存在：${args.path || '.'}`);
  }
  if (!stat.isDirectory()) fail('PTC_NOT_DIRECTORY', `不是目录：${args.path || '.'}`);
  const entries = [];
  walkTree(target, ctx.workspace, args.depth ?? 2, entries, LIST_LIMIT);
  return {
    path: relativePath(ctx.workspace, target),
    entries,
    truncated: entries.length >= LIST_LIMIT
  };
}

function readFile(args, ctx) {
  const target = resolvePtcPath(ctx.workspace, args.path);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    fail('PTC_NOT_FOUND', `文件不存在：${args.path}`);
  }
  if (!stat.isFile()) fail('PTC_NOT_FILE', `不是文件：${args.path}`);
  if (stat.size > READ_FILE_LIMIT) fail('PTC_FILE_TOO_LARGE', '文件超过 2MB，请使用搜索或分段读取');
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (error) {
    fail('PTC_READ_FAILED', `读取失败：${error.message}`);
  }
  if (raw.includes('\u0000')) fail('PTC_BINARY_FILE', '这是二进制文件，无法作为文本读取');
  const lines = raw.split(/\r?\n/);
  let start = Math.max(1, Number(args.startLine) || 1);
  let end = Math.min(lines.length, Number(args.endLine) || lines.length);
  if (start > end) [start, end] = [end, start];
  end = Math.min(end, lines.length);
  let content = lines.slice(start - 1, end).join('\n');
  let truncated = false;
  if (content.length > READ_CHAR_LIMIT) {
    content = content.slice(0, READ_CHAR_LIMIT);
    truncated = true;
  }
  return {
    path: relativePath(ctx.workspace, target),
    totalLines: lines.length,
    startLine: start,
    endLine: end,
    content,
    truncated
  };
}

function globToRegex(glob) {
  if (!glob) return null;
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0001/g, '.*');
  try {
    return new RegExp(`^${escaped}$`, 'i');
  } catch {
    return null;
  }
}

function walkTextFiles(dir, workspace, state, visit) {
  if (state.stopped) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (state.stopped) return;
    if (state.scanned >= SEARCH_SCAN_LIMIT) {
      state.truncated = true;
      return;
    }
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTextFiles(full, workspace, state, visit);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (BINARY_EXT.has(ext)) continue;
    state.scanned += 1;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > 1024 * 1024) continue;
    visit(full, relativePath(workspace, full));
  }
}

function searchFiles(args, ctx) {
  const target = resolvePtcPath(ctx.workspace, args.path || '.');
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    fail('PTC_NOT_FOUND', `路径不存在：${args.path || '.'}`);
  }
  const targetType = args.target || 'content';
  const caseSensitive = args.caseSensitive === true;
  const query = caseSensitive ? args.query : args.query.toLowerCase();
  const matcher = globToRegex(args.glob);
  const matchesGlob = (relative) => !matcher
    || matcher.test(relative)
    || matcher.test(relative.split('/').pop() || '');
  const matches = [];
  const state = { scanned: 0, stopped: false, truncated: false };
  const push = (item) => {
    if (matches.length >= SEARCH_MATCH_LIMIT) {
      state.stopped = true;
      state.truncated = true;
      return;
    }
    matches.push(item);
  };

  const checkFile = (absolute, relative) => {
    if (!matchesGlob(relative)) return;
    if (targetType === 'filename') {
      const haystack = caseSensitive ? relative : relative.toLowerCase();
      if (haystack.includes(query)) push({ path: relative, line: 0, text: relative });
      return;
    }
    let content;
    try { content = fs.readFileSync(absolute, 'utf8'); } catch { return; }
    if (content.includes('\u0000')) return;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const haystack = caseSensitive ? line : line.toLowerCase();
      if (!haystack.includes(query)) continue;
      push({
        path: relative,
        line: index + 1,
        text: line.trim().slice(0, 500)
      });
      if (state.stopped) return;
    }
  };

  if (stat.isDirectory()) {
    walkTextFiles(target, ctx.workspace, state, checkFile);
  } else {
    checkFile(target, relativePath(ctx.workspace, target));
  }
  return {
    query: args.query,
    target: targetType,
    matches,
    count: matches.length,
    truncated: state.truncated || matches.length >= SEARCH_MATCH_LIMIT
  };
}

async function searchKnowledge(args, ctx) {
  if (!ctx.knowledge) {
    fail('PTC_UNAVAILABLE', '当前设备还没有可用的知识库');
  }
  const results = await ctx.knowledge.search(args.query, {
    topK: args.topK ?? ctx.knowledgeTopK ?? 6,
    docName: args.docName || '',
    collection: args.collection || '',
    ext: args.fileType || '',
    embedding: embeddingConfigFor(ctx.settings || {})
  });
  return {
    query: args.query,
    count: results.length,
    results: results.map((item) => ({
      docName: item.docName,
      location: item.location || '',
      text: String(item.text || '').slice(0, 20000),
      score: item.score,
      mode: item.mode || 'keyword',
      collection: item.collection || 'default',
      sourcePath: item.sourcePath || '',
      shared: item.shared === true
    }))
  };
}

function readSkill(args, ctx) {
  if (!ctx.skills) fail('PTC_UNAVAILABLE', '当前没有可用的技能');
  const skill = ctx.skills.read(args.name);
  if (!skill) fail('PTC_NOT_FOUND', `未找到已启用的技能：${args.name}`);
  const content = String(skill.content || '');
  return {
    name: skill.name,
    content: content.slice(0, SKILL_CHAR_LIMIT),
    files: Array.isArray(skill.files) ? skill.files.slice(0, 500) : [],
    truncated: content.length > SKILL_CHAR_LIMIT
  };
}

const HANDLERS = {
  'files.list': listFiles,
  'files.read': readFile,
  'files.search': searchFiles,
  'knowledge.search': searchKnowledge,
  'skills.read': readSkill
};

/**
 * 执行一个 PTC 窄接口工具，返回规范 JSON 值。
 * 参数与返回值均不经过人读渲染，保证中间值可以完整跨越进程边界。
 */
export async function executePtcTool(apiName, rawArgs, ctx = {}) {
  const handler = HANDLERS[apiName];
  if (!handler) fail('PTC_UNKNOWN_TOOL', `未知 PTC 工具：${apiName}`);
  assertEnabled(apiName, ctx.settings || {});
  if (!ctx.workspace) fail('PTC_UNAVAILABLE', '当前没有工作区');
  const args = normalizePtcArgs(apiName, rawArgs);
  return handler(args, ctx);
}

export function ptcToolNames() {
  return Object.keys(HANDLERS);
}
