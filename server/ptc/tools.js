import fs from 'node:fs';
import path from 'node:path';
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

// 文件密集场景：批量读取与内容搜索都走异步 I/O + 有界并发，
// 避免同步读盘阻塞主线程（HTTP/SSE 也会被一起卡住）。
const READ_CONCURRENCY = 8;
const SEARCH_READ_CONCURRENCY = 16;

// 只读正文缓存：同一任务在多轮 ptc_run 里重复读同一文件时不再重复读盘。
// 用 mtime + size 校验；刚写入的文件（mtime 精度可能不足）强制重读。
const MTIME_RACY_MS = 2000;
// 文件密集任务一次可能读 500+ 个文件；上限过小会让顺序扫描把缓存全部淘汰。
const CACHE_MAX_ENTRIES = 2000;
const CACHE_MAX_CHARS = 12 * 1024 * 1024;
const CACHE_MAX_FILE_CHARS = 1024 * 1024;

const textCache = new Map();
let textCacheChars = 0;
const cacheStats = { hits: 0, misses: 0 };

function dropCachedText(key) {
  const entry = textCache.get(key);
  if (!entry) return;
  textCache.delete(key);
  textCacheChars -= entry.text.length;
}

function cachedText(absolute, stat) {
  const entry = textCache.get(absolute);
  if (!entry) return null;
  if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
    dropCachedText(absolute);
    return null;
  }
  // 刚写入的文件 mtime 可能不可信：强制重读，避免返回旧正文。
  if (Math.abs(Date.now() - stat.mtimeMs) < MTIME_RACY_MS) return null;
  // LRU：命中后移到队尾。
  textCache.delete(absolute);
  textCache.set(absolute, entry);
  return entry.text;
}

function storeCachedText(absolute, stat, text) {
  dropCachedText(absolute);
  if (text.length > CACHE_MAX_FILE_CHARS) return;
  textCache.set(absolute, { mtimeMs: stat.mtimeMs, size: stat.size, text });
  textCacheChars += text.length;
  while (textCache.size > CACHE_MAX_ENTRIES || textCacheChars > CACHE_MAX_CHARS) {
    const oldest = textCache.keys().next().value;
    if (oldest === undefined) break;
    dropCachedText(oldest);
  }
}

async function readText(absolute, stat) {
  const cached = cachedText(absolute, stat);
  if (cached !== null) {
    cacheStats.hits += 1;
    return cached;
  }
  cacheStats.misses += 1;
  const text = await fs.promises.readFile(absolute, 'utf8');
  storeCachedText(absolute, stat, text);
  return text;
}

export function ptcReadCacheStats() {
  return { ...cacheStats, entries: textCache.size, chars: textCacheChars };
}

export function resetPtcReadCache() {
  textCache.clear();
  textCacheChars = 0;
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

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
    } else if (argSpec.type === 'array') {
      if (!Array.isArray(value)) fail('PTC_ARG_TYPE', `${key} 必须是数组`);
      const maxItems = Math.max(1, Number(argSpec.maxItems) || 20);
      if (value.length > maxItems) fail('PTC_ARG_TYPE', `${key} 最多 ${maxItems} 项`);
      const itemSpec = argSpec.item || { type: 'string', maxLength: 500 };
      args[key] = value.map((item, index) => {
        if (itemSpec.type === 'string') return textValue(item, `${key}[${index}]`, itemSpec);
        if (itemSpec.type === 'integer') return integerValue(item, `${key}[${index}]`, itemSpec);
        if (itemSpec.type === 'boolean') {
          if (typeof item !== 'boolean') fail('PTC_ARG_TYPE', `${key}[${index}] 必须是布尔值`);
          return item;
        }
        fail('PTC_ARG_TYPE', `${key}[${index}] 类型不受支持`);
        return null;
      });
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

// 工作区根只解析一次：文件密集时逐文件 realpathSync 是主要瓶颈（500 个文件约 5 秒）。
const workspaceRootCache = new Map();

function cachedWorkspaceRoot(workspace) {
  const raw = path.resolve(String(workspace || '.'));
  const cached = workspaceRootCache.get(raw);
  if (cached) return cached;
  let root;
  try {
    root = fs.realpathSync(raw);
  } catch {
    root = raw;
  }
  workspaceRootCache.set(raw, root);
  if (workspaceRootCache.size > 32) {
    workspaceRootCache.delete(workspaceRootCache.keys().next().value);
  }
  return root;
}

// 异步 realpath：保留符号链接越界防护，但不阻塞主线程。
async function resolvePtcPath(workspace, relative) {
  try {
    const root = cachedWorkspaceRoot(workspace);
    const absolute = path.resolve(root, relative || '.');
    let canonical = absolute;
    try {
      canonical = await fs.promises.realpath(absolute);
    } catch {
      canonical = absolute;
    }
    const rel = path.relative(root, canonical);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      fail('PTC_PATH_ESCAPE', `路径超出工作区：${relative}`);
    }
    return canonical;
  } catch (error) {
    if (error?.code === 'PTC_PATH_ESCAPE') throw error;
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

async function listFiles(args, ctx) {
  const target = await resolvePtcPath(ctx.workspace, args.path || '.');
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    fail('PTC_NOT_FOUND', `路径不存在：${args.path || '.'}`);
  }
  if (!stat.isDirectory()) fail('PTC_NOT_DIRECTORY', `不是目录：${args.path || '.'}`);
  const offset = Math.max(0, Number(args.offset) || 0);
  const limit = Math.max(1, Math.min(LIST_LIMIT, Number(args.limit) || LIST_LIMIT));
  // 多取 1 条用于判断是否还有下一页，避免把“刚好一页”误判为截断。
  const collected = [];
  walkTree(target, ctx.workspace, args.depth ?? 2, collected, offset + limit + 1);
  const entries = collected.slice(offset, offset + limit);
  const truncated = collected.length > offset + limit;
  return {
    path: relativePath(ctx.workspace, target),
    entries,
    count: entries.length,
    offset,
    limit,
    truncated,
    nextOffset: truncated ? offset + entries.length : null
  };
}

async function readFile(args, ctx) {
  const target = await resolvePtcPath(ctx.workspace, args.path);
  let stat;
  try {
    stat = await fs.promises.stat(target);
  } catch {
    fail('PTC_NOT_FOUND', `文件不存在：${args.path}`);
  }
  if (!stat.isFile()) fail('PTC_NOT_FILE', `不是文件：${args.path}`);
  if (stat.size > READ_FILE_LIMIT) fail('PTC_FILE_TOO_LARGE', '文件超过 2MB，请使用搜索或分段读取');
  let raw;
  try {
    raw = await readText(target, stat);
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

// 批量读取：去重后按有界并发执行，单个文件失败以 ok:false 返回，不拖垮整批。
async function readManyFiles(args, ctx) {
  const requested = args.paths || [];
  const paths = [...new Set(requested)];
  const results = await mapWithConcurrency(paths, READ_CONCURRENCY, async (filePath) => {
    try {
      const file = await readFile({ path: filePath, startLine: args.startLine, endLine: args.endLine }, ctx);
      return { path: filePath, ok: true, file };
    } catch (error) {
      return {
        path: filePath,
        ok: false,
        code: error?.code || 'PTC_READ_FAILED',
        message: error?.message || '读取失败'
      };
    }
  });
  return {
    results,
    count: results.length,
    okCount: results.filter((item) => item.ok).length
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

// 只收集文本文件路径，不读正文；正文由后面的有界并发批读取。
function collectTextFiles(dir, workspace, state, out) {
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
      collectTextFiles(full, workspace, state, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (BINARY_EXT.has(ext)) continue;
    state.scanned += 1;
    // 这里不做 stat：目录很大时逐文件 statSync 会阻塞主线程；
    // 大小过滤下沉到 readSearchText，只对真正要读的文件做 stat。
    out.push({ absolute: full, relative: relativePath(workspace, full) });
  }
}

async function readSearchText(file, maxBytes = 1024 * 1024) {
  let stat;
  try {
    stat = await fs.promises.stat(file.absolute);
  } catch {
    return { text: null };
  }
  if (!stat.isFile()) return { text: null };
  // 超大文件不读正文，但显式计数，避免调用方把“被跳过”误判成“没有匹配”。
  if (stat.size > maxBytes) return { text: null, skippedLarge: true };
  try {
    return { text: await readText(file.absolute, stat) };
  } catch {
    return { text: null };
  }
}

async function searchFiles(args, ctx) {
  const target = await resolvePtcPath(ctx.workspace, args.path || '.');
  let stat;
  try {
    stat = await fs.promises.stat(target);
  } catch {
    fail('PTC_NOT_FOUND', `路径不存在：${args.path || '.'}`);
  }
  const targetType = args.target || 'content';
  const caseSensitive = args.caseSensitive === true;
  const useRegex = args.regex === true;
  const rawQuery = String(args.query || '');
  let pattern = null;
  if (useRegex) {
    try {
      pattern = new RegExp(rawQuery, caseSensitive ? '' : 'i');
    } catch (error) {
      fail('PTC_BAD_REGEX', `正则表达式无效：${error?.message || String(error)}`);
    }
  }
  const query = caseSensitive ? rawQuery : rawQuery.toLowerCase();
  const matchesText = (text) => {
    if (useRegex) return pattern.test(text);
    return (caseSensitive ? text : text.toLowerCase()).includes(query);
  };
  const matcher = globToRegex(args.glob);
  const matchesGlob = (relative) => !matcher
    || matcher.test(relative)
    || matcher.test(relative.split('/').pop() || '');
  const matches = [];
  const state = { scanned: 0, stopped: false, truncated: false, skippedLarge: 0 };
  const push = (item) => {
    if (matches.length >= SEARCH_MATCH_LIMIT) {
      state.stopped = true;
      state.truncated = true;
      return;
    }
    matches.push(item);
  };

  const singleFile = !stat.isDirectory();
  const maxBytes = singleFile ? READ_FILE_LIMIT : 1024 * 1024;
  const files = [];
  if (singleFile) {
    files.push({ absolute: target, relative: relativePath(ctx.workspace, target) });
  } else {
    collectTextFiles(target, ctx.workspace, state, files);
  }
  const candidates = files.filter((file) => matchesGlob(file.relative));

  if (targetType === 'filename') {
    for (const file of candidates) {
      if (state.stopped) break;
      if (matchesText(file.relative)) push({ path: file.relative, line: 0, text: file.relative });
    }
  } else {
    for (let index = 0; index < candidates.length && !state.stopped; index += SEARCH_READ_CONCURRENCY) {
      const chunk = candidates.slice(index, index + SEARCH_READ_CONCURRENCY);
      const contents = await Promise.all(chunk.map((file) => readSearchText(file, maxBytes)));
      for (let offset = 0; offset < chunk.length && !state.stopped; offset += 1) {
        const file = chunk[offset];
        const outcome = contents[offset];
        if (outcome?.skippedLarge) {
          state.skippedLarge += 1;
          continue;
        }
        const content = outcome?.text ?? null;
        if (content === null || content.includes('\u0000')) continue;
        const lines = content.split(/\r?\n/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          if (!matchesText(lines[lineIndex])) continue;
          push({
            path: file.relative,
            line: lineIndex + 1,
            text: lines[lineIndex].trim().slice(0, 500)
          });
          if (state.stopped) break;
        }
      }
    }
  }
  const result = {
    query: rawQuery,
    target: targetType,
    regex: useRegex,
    matches,
    count: matches.length,
    skippedLarge: state.skippedLarge,
    // 只有真的出现第 201 条命中才叫截断；正好 200 条是完整结果。
    truncated: state.truncated
  };
  // 超大文件被跳过时必须显式提示，否则空结果会被误判成“文件里没有内容”。
  if (!matches.length && state.skippedLarge > 0) {
    result.hint = `${state.skippedLarge} 个文件超过大小上限已跳过；请用 files.read 按行读取或缩小 path 范围。`;
  } else if (!matches.length && !useRegex && /[\\^$*+?()[\]{}|]/.test(rawQuery)) {
    // 空结果最常见的原因是“按纯文本查找却传了正则”，显式提示，避免模型误判文件里没有内容。
    result.hint = 'query 默认按纯文本匹配；要使用正则/行首匹配请传 regex:true，例如 { query: "^\\\\s*//", regex: true }。';
  }
  return result;
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
  'files.readMany': readManyFiles,
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
