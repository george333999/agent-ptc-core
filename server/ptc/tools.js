import fs from 'node:fs';
import path from 'node:path';
import { embeddingConfigFor } from '../embeddings.js';
import { workspaceRoot } from '../paths.js';
import { PTC_TOOL_SPECS } from './specs.js';

// PTC typed read-only tool layer.
// Unlike native tools: validated canonical JSON values are returned here, not rendered strings for humans;
// arguments are validated one by one (type, range, unknown keys, path escape), and no shell, generic filesystem, or database access is exposed.

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

// File-dense scenarios: batch reads and content search both use async I/O + bounded concurrency,
// avoiding synchronous disk reads that block the main thread (HTTP/SSE would be blocked along with it).
const READ_CONCURRENCY = 8;
const SEARCH_READ_CONCURRENCY = 16;

// Read-only content cache: reading the same file again across multiple ptc_run calls in the same task does not re-read from disk.
// Validated with mtime + size; a just-written file (mtime precision may be insufficient) is forcibly re-read.
const MTIME_RACY_MS = 2000;
// A file-dense task may read 500+ files at once; too small a limit would let a sequential scan evict the whole cache.
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
  // A just-written file's mtime may be unreliable: force a re-read to avoid returning stale content.
  if (Math.abs(Date.now() - stat.mtimeMs) < MTIME_RACY_MS) return null;
  // LRU: move to the tail on a hit.
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
  if (typeof value !== 'string') fail('PTC_ARG_TYPE', `${name} must be a string`);
  const trimmed = value.trim();
  if (spec.required && !trimmed) fail('PTC_ARG_TYPE', `${name} must not be empty`);
  if (spec.maxLength && trimmed.length > spec.maxLength) {
    fail('PTC_ARG_TYPE', `${name} must not exceed ${spec.maxLength} characters`);
  }
  return trimmed;
}

function integerValue(value, name, spec) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || !Number.isInteger(number)) {
    fail('PTC_ARG_TYPE', `${name} must be an integer`);
  }
  if (spec.min !== undefined && number < spec.min) return spec.min;
  if (spec.max !== undefined && number > spec.max) return spec.max;
  return number;
}

export function normalizePtcArgs(apiName, rawArgs) {
  const spec = PTC_TOOL_SPECS[apiName];
  if (!spec) fail('PTC_UNKNOWN_TOOL', `Unknown PTC tool: ${apiName}`);
  if (rawArgs === undefined || rawArgs === null) rawArgs = {};
  if (!isPlainObject(rawArgs)) fail('PTC_ARG_TYPE', `${apiName} arguments must be an object`);
  const args = {};
  for (const key of Object.keys(rawArgs)) {
    if (!spec.args[key]) fail('PTC_UNKNOWN_ARG', `${apiName} does not support argument ${key}`);
    const argSpec = spec.args[key];
    const value = rawArgs[key];
    if (value === undefined) continue;
    if (argSpec.type === 'string') {
      args[key] = textValue(value, key, argSpec);
    } else if (argSpec.type === 'integer') {
      args[key] = integerValue(value, key, argSpec);
    } else if (argSpec.type === 'boolean') {
      if (typeof value !== 'boolean') fail('PTC_ARG_TYPE', `${key} must be a boolean`);
      args[key] = value;
    } else if (argSpec.type === 'enum') {
      if (!argSpec.values.includes(value)) fail('PTC_ARG_TYPE', `${key} must be one of ${argSpec.values.join(' / ')}`);
      args[key] = value;
    } else if (argSpec.type === 'array') {
      if (!Array.isArray(value)) fail('PTC_ARG_TYPE', `${key} must be an array`);
      const maxItems = Math.max(1, Number(argSpec.maxItems) || 20);
      if (value.length > maxItems) fail('PTC_ARG_TYPE', `${key} allows at most ${maxItems} items`);
      const itemSpec = argSpec.item || { type: 'string', maxLength: 500 };
      args[key] = value.map((item, index) => {
        if (itemSpec.type === 'string') return textValue(item, `${key}[${index}]`, itemSpec);
        if (itemSpec.type === 'integer') return integerValue(item, `${key}[${index}]`, itemSpec);
        if (itemSpec.type === 'boolean') {
          if (typeof item !== 'boolean') fail('PTC_ARG_TYPE', `${key}[${index}] must be a boolean`);
          return item;
        }
        fail('PTC_ARG_TYPE', `${key}[${index}] has an unsupported type`);
        return null;
      });
    }
  }
  for (const [key, argSpec] of Object.entries(spec.args)) {
    if (argSpec.required && args[key] === undefined) fail('PTC_ARG_TYPE', `Missing argument ${key}`);
  }
  return args;
}

function assertEnabled(apiName, settings = {}) {
  const spec = PTC_TOOL_SPECS[apiName];
  if (Array.isArray(settings.disabledTools) && settings.disabledTools.includes(spec.native)) {
    fail('PTC_TOOL_DISABLED', `Tool is disabled: ${spec.native}`);
  }
}

// The workspace root shares the same cache as native tools: per-file realpath is the main bottleneck for file-dense tasks,
// and the cache and invalidation policy live in paths.js so two caches cannot return different roots for the same workspace.

// Async realpath: keeps symlink escape protection but does not block the main thread.
async function resolvePtcPath(workspace, relative) {
  try {
    const root = workspaceRoot(workspace);
    const absolute = path.resolve(root, relative || '.');
    let canonical = absolute;
    try {
      canonical = await fs.promises.realpath(absolute);
    } catch {
      canonical = absolute;
    }
    const rel = path.relative(root, canonical);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      fail('PTC_PATH_ESCAPE', `Path is outside the workspace: ${relative}`);
    }
    return canonical;
  } catch (error) {
    if (error?.code === 'PTC_PATH_ESCAPE') throw error;
    fail('PTC_PATH_ESCAPE', `Path is outside the workspace: ${relative}`);
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
    fail('PTC_NOT_FOUND', `Path does not exist: ${args.path || '.'}`);
  }
  if (!stat.isDirectory()) fail('PTC_NOT_DIRECTORY', `Not a directory: ${args.path || '.'}`);
  const offset = Math.max(0, Number(args.offset) || 0);
  const limit = Math.max(1, Math.min(LIST_LIMIT, Number(args.limit) || LIST_LIMIT));
  // Fetch one extra entry to detect whether another page exists, avoiding treating an exactly-full page as truncated.
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
    fail('PTC_NOT_FOUND', `File does not exist: ${args.path}`);
  }
  if (!stat.isFile()) fail('PTC_NOT_FILE', `Not a file: ${args.path}`);
  if (stat.size > READ_FILE_LIMIT) fail('PTC_FILE_TOO_LARGE', 'File exceeds 2MB; use search or ranged reads');
  let raw;
  try {
    raw = await readText(target, stat);
  } catch (error) {
    fail('PTC_READ_FAILED', `Read failed: ${error.message}`);
  }
  if (raw.includes('\u0000')) fail('PTC_BINARY_FILE', 'This is a binary file and cannot be read as text');
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

// Batch read: deduplicate first, then run with bounded concurrency; a single file failure returns ok:false without failing the whole batch.
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
        message: error?.message || 'Read failed'
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

// Only collect text file paths, not contents; contents are read by the bounded-concurrency batch later.
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
    // Do not stat here: per-file statSync in a large directory would block the main thread;
    // the size filter moves down into readSearchText and stats only files that will actually be read.
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
  // Very large files are not read, but are counted explicitly so callers do not mistake "skipped" for "no match".
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
    fail('PTC_NOT_FOUND', `Path does not exist: ${args.path || '.'}`);
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
      fail('PTC_BAD_REGEX', `Invalid regular expression: ${error?.message || String(error)}`);
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
    // Only the actual appearance of a 201st match counts as truncation; exactly 200 matches is a complete result.
    truncated: state.truncated
  };
  // When large files are skipped this must be surfaced explicitly; otherwise an empty result is misread as "the file has no content".
  if (!matches.length && state.skippedLarge > 0) {
    result.hint = `${state.skippedLarge} file(s) exceeded the size limit and were skipped; use files.read with line ranges or narrow the path scope.`;
  } else if (!matches.length && !useRegex && /[\\^$*+?()[\]{}|]/.test(rawQuery)) {
    // The most common cause of empty results is "plain-text search but a regex was passed"; surface it explicitly so the model does not misjudge that the file has no content.
    result.hint = 'query matches as plain text by default; to use regex/line-start matching pass regex:true, e.g. { query: "^\\\\s*//", regex: true }.';
  }
  return result;
}

async function searchKnowledge(args, ctx) {
  if (!ctx.knowledge) {
    fail('PTC_UNAVAILABLE', 'No knowledge base is available on this device yet');
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
  if (!ctx.skills) fail('PTC_UNAVAILABLE', 'No skills are available');
  const skill = ctx.skills.read(args.name);
  if (!skill) fail('PTC_NOT_FOUND', `No enabled skill found: ${args.name}`);
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
 * Execute one PTC narrow-interface tool and return a canonical JSON value.
 * Neither arguments nor return values pass through human rendering, ensuring intermediate values can fully cross the process boundary.
 */
export async function executePtcTool(apiName, rawArgs, ctx = {}) {
  const handler = HANDLERS[apiName];
  if (!handler) fail('PTC_UNKNOWN_TOOL', `Unknown PTC tool: ${apiName}`);
  assertEnabled(apiName, ctx.settings || {});
  if (!ctx.workspace) fail('PTC_UNAVAILABLE', 'No workspace is available');
  const args = normalizePtcArgs(apiName, rawArgs);
  return handler(args, ctx);
}

export function ptcToolNames() {
  return Object.keys(HANDLERS);
}
