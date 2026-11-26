// Context prefetch: read files only when the user message contains an "explicit path" or a "unique symbol",
// avoiding blindly stuffing the whole workspace into the prompt. All prefetched content goes into the user message (after the prefix),
// not changing the stable system/tools prefix, so the cache is not broken.
//
// Hard constraints:
// - per-turn prefetch total ≤ maxChars (default 8000 chars);
// - excerpts may be incomplete and must be explicitly marked when rendered;
// - file fingerprint = path + mtime + size + hash; when unchanged, reuse the previous content directly and skip re-reading.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// On filesystems with coarse mtime precision, a just-written file may keep the same mtime/size; force re-read within this period.
const MTIME_RACY_MS = 2000;

const CODE_EXT = 'js|mjs|cjs|ts|tsx|jsx|json|md|markdown|txt|py|css|scss|html|yml|yaml|toml|go|rs|java|kt|sh|sql|xml|ini|env';
const PATH_PATTERN = new RegExp(
  `(?:^|[\\s"'\`(（\\[])((?:\\.{1,2}/)?(?:[\\w@.-]+/)*[\\w@.-]+\\.(?:${CODE_EXT}))(?=$|[\\s"'\`),，。；;:：\\]）])`,
  'g'
);
const BARE_FILE_PATTERN = new RegExp(`(?:^|[\\s"'\`(（])([\\w@.-]+\\.(?:${CODE_EXT}))(?=$|[\\s"'\`),，。；;:：])`, 'g');
const BACKTICK_SYMBOL_PATTERN = /`([A-Za-z_$][\w$]{2,})(?:\(\))?`/g;
const KEYWORD_SYMBOL_PATTERN = /(?:函数|方法|类|变量|符号|定义)\s*[`"'“]?([A-Za-z_$][\w$]{2,})[`"'”]?/g;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'true', 'false', 'null',
  'const', 'let', 'var', 'return', 'async', 'await', 'string', 'number', 'object',
  'function', 'import', 'export', 'default', 'class', 'type', 'interface'
]);

function normalizeRelative(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function isSafeRelative(value) {
  const normalized = normalizeRelative(value);
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false;
  if (normalized.split('/').includes('..')) return false;
  return normalized.length <= 300;
}

// Explicit paths: must have an extension, and must not be a URL or a version number.
export function extractExplicitPaths(text) {
  const source = String(text || '');
  const found = [];
  const push = (raw) => {
    const value = normalizeRelative(raw);
    if (!isSafeRelative(value)) return;
    if (/^https?:/i.test(value)) return;
    if (!found.includes(value)) found.push(value);
  };
  for (const pattern of [PATH_PATTERN, BARE_FILE_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) push(match[1]);
  }
  return found.slice(0, 8);
}

// Unique symbols: only accept backtick-wrapped identifiers, or explicit "function/method/class + identifier" phrasing.
export function extractExplicitSymbols(text) {
  const source = String(text || '');
  const found = [];
  const push = (raw) => {
    const value = String(raw || '').trim();
    if (value.length < 3 || value.length > 64) return;
    if (STOP_WORDS.has(value.toLowerCase())) return;
    if (!found.includes(value)) found.push(value);
  };
  for (const pattern of [BACKTICK_SYMBOL_PATTERN, KEYWORD_SYMBOL_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) push(match[1]);
  }
  return found.slice(0, 6);
}

export function extractContextTargets(text) {
  return {
    paths: extractExplicitPaths(text),
    symbols: extractExplicitSymbols(text)
  };
}

// Recognize explicit line ranges like "lines 1-120" or "1~120 lines", prefetching only that segment to avoid stuffing a whole long document into context.
export function extractLineRange(text) {
  const match = /(?:第\s*)?(\d{1,6})\s*行?\s*[-~—至到]\s*(\d{1,6})\s*行/.exec(String(text || ''));
  if (!match) return null;
  const from = Math.max(1, Number(match[1]));
  const to = Math.max(from, Number(match[2]));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > 2000) return null;
  return { from, to };
}

function tokenEstimate(text) {
  return Math.ceil(String(text ?? '').length / 2.5);
}

// With no explicit target, inject only a "path + size" workspace index, reading no file content.
export function buildWorkspaceIndex(entries, { maxTokens = 1000, maxEntries = 240 } = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      if (typeof entry === 'string') return { path: normalizeRelative(entry), size: 0 };
      return {
        path: normalizeRelative(entry?.path || entry?.name || ''),
        size: Math.max(0, Number(entry?.size) || 0)
      };
    })
    .filter((entry) => entry.path)
    .sort((left, right) => left.path.localeCompare(right.path));
  const lines = [];
  let used = 0;
  let included = 0;
  for (const entry of list) {
    const line = entry.size ? `- ${entry.path} (${entry.size}B)` : `- ${entry.path}`;
    const cost = tokenEstimate(line) + 1;
    if (included >= maxEntries || used + cost > maxTokens) break;
    lines.push(line);
    used += cost;
    included += 1;
  }
  if (!lines.length) return '';
  const omitted = list.length - included;
  if (omitted > 0) lines.push(`… (${list.length} files total, ${omitted} omitted)`);
  return lines.join('\n');
}

export function fingerprintText(text) {
  return crypto.createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

const INDEX_IGNORE = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.cache',
  '.venv', 'venv', '__pycache__', 'data', 'vendor'
]);

// Lightweight workspace index: collect only paths and sizes, no content; bounded by depth and count.
export function listWorkspaceEntries(workspace, { maxEntries = 240, maxDepth = 2 } = {}) {
  const root = path.resolve(String(workspace || ''));
  const results = [];
  if (!workspace) return results;
  const walk = (dir, depth) => {
    if (results.length >= maxEntries || depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (results.length >= maxEntries) return;
      if (entry.name.startsWith('.') || INDEX_IGNORE.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(absolute, depth + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try { size = fs.statSync(absolute).size; } catch { size = 0; }
        results.push({ path: relative, size });
      }
    }
  };
  walk(root, 0);
  return results;
}

function resolveSafeFile(workspace, relative) {
  if (!isSafeRelative(relative)) return null;
  const root = path.resolve(workspace);
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return null;
  return file;
}

export function fingerprintFile(workspace, relative) {
  const file = resolveSafeFile(workspace, relative);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const text = fs.readFileSync(file, 'utf8');
    return {
      path: normalizeRelative(relative),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: fingerprintText(text),
      text
    };
  } catch {
    return null;
  }
}

// Session-level cache: a direct hit when mtime + size are unchanged; when changed, compare the hash, still a hit if the content is the same.
// refs records how many times the same path is referenced in this session, used for the "inject body on demand" decision.
export function createPrefetchCache() {
  const entries = new Map();
  const refs = new Map();
  // path + fingerprint already injected: when the content is unchanged in the same session, give only a one-line reference, not the body again.
  const injected = new Map();
  return {
    get(relative) {
      return entries.get(normalizeRelative(relative)) || null;
    },
    set(fingerprint) {
      if (!fingerprint?.path) return;
      entries.set(fingerprint.path, fingerprint);
    },
    // Reference count: 1 on the first reference, 2 on the second, used to decide whether to expand the body.
    bumpRef(relative) {
      const key = normalizeRelative(relative);
      const next = (refs.get(key) || 0) + 1;
      refs.set(key, next);
      return next;
    },
    refCount(relative) {
      return refs.get(normalizeRelative(relative)) || 0;
    },
    wasInjectedBody(relative, hash) {
      if (!hash) return false;
      return injected.has(`${normalizeRelative(relative)}#${String(hash)}`);
    },
    markInjectedBody(relative, hash) {
      if (!hash) return;
      injected.set(`${normalizeRelative(relative)}#${String(hash)}`, true);
    },
    // After window trim/compaction the old body may no longer be in context; must allow re-injection in the next turn.
    resetInjected() {
      injected.clear();
    },
    injectedSize() {
      return injected.size;
    },
    read(workspace, relative) {
      const key = normalizeRelative(relative);
      const file = resolveSafeFile(workspace, key);
      if (!file) return { hit: false, found: false };
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        entries.delete(key);
        return { hit: false, found: false };
      }
      if (!stat.isFile()) return { hit: false, found: false };
      const cached = entries.get(key);
      // Some filesystems (including container overlay/tmpfs) have coarse mtime precision; writing equal-length content within the same
      // time slice leaves both mtime and size unchanged. Don't trust mtime for just-modified files; force re-read and compare the hash, avoiding a stale body.
      const racyMtime = Math.abs(Date.now() - stat.mtimeMs) < MTIME_RACY_MS;
      if (!racyMtime && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return { hit: true, found: true, ...cached };
      }
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return { hit: false, found: false };
      }
      const hash = fingerprintText(text);
      if (cached && cached.hash === hash) {
        const refreshed = { ...cached, mtimeMs: stat.mtimeMs, size: stat.size, text };
        entries.set(key, refreshed);
        return { hit: true, found: true, ...refreshed };
      }
      const fingerprint = {
        path: key,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        hash,
        text
      };
      entries.set(key, fingerprint);
      return { hit: false, found: true, ...fingerprint };
    },
    size() {
      return entries.size;
    }
  };
}

function clipWithLines(text, maxChars) {
  const value = String(text ?? '');
  const truncated = value.length > maxChars;
  return {
    excerpt: truncated ? value.slice(0, maxChars) : value,
    truncated,
    totalChars: value.length,
    totalLines: value.split('\n').length
  };
}

function symbolWindow(text, symbol, radius = 6) {
  const lines = String(text ?? '').split('\n');
  const pattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  for (let index = 0; index < lines.length; index += 1) {
    if (!pattern.test(lines[index])) continue;
    const from = Math.max(0, index - radius);
    const to = Math.min(lines.length, index + radius + 1);
    return {
      from: from + 1,
      to,
      excerpt: lines.slice(from, to).join('\n')
    };
  }
  return null;
}

/**
 * Build a prefetch plan. Return structure:
 * { mode: 'none' | 'index' | 'targets', items, chars, hits, misses, index, symbols, paths, note }
 * items: [{ path, reason, symbol, excerpt, truncated, totalLines, from, to, fingerprint, hit }]
 */
export function planPrefetch({
  message = '',
  workspace = '',
  fileIndex = [],
  cache = createPrefetchCache(),
  maxChars = 8000,
  maxFiles = 5,
  indexMaxTokens = 1000,
  // Workers have no history; on the first reference, giving only "path + line count" necessarily costs an extra tool round-trip;
  // allow them to inline a small body on the first reference (still bounded by maxChars / INLINE_MAX_CHARS).
  inlineFirstReference = false
} = {}) {
  const targets = extractContextTargets(message);
  if (!workspace) return { mode: 'none', items: [], chars: 0, hits: 0, misses: 0, reused: 0, index: '', ...targets };
  const hasTargets = targets.paths.length > 0 || targets.symbols.length > 0;
  if (!hasTargets) {
    return {
      mode: 'index',
      items: [],
      chars: 0,
      hits: 0,
      misses: 0,
      reused: 0,
      index: buildWorkspaceIndex(fileIndex, { maxTokens: indexMaxTokens }),
      ...targets
    };
  }

  // v4 on-demand injection: for a large file's first reference, give only "path + fingerprint + line count";
  // inject the body only for small files (≤1.5k chars), explicit line ranges, or the 2nd reference to the same path in this session.
  // The body is always truncated to ≤1200 chars, avoiding a single file eating the whole budget.
  const SMALL_FILE_CHARS = 1500;
  const INLINE_MAX_CHARS = 1200;
  const requestedRange = targets.paths.length === 1 ? extractLineRange(message) : null;
  const items = [];
  let used = 0;
  let hits = 0;
  let misses = 0;
  let reused = 0;
  const pushItem = (item, budgetCap = INLINE_MAX_CHARS) => {
    if (used >= maxChars || items.length >= maxFiles) return false;
    const budget = Math.min(budgetCap, maxChars - used);
    // Too small a budget makes prefetch meaningless; give up to avoid "pseudo context" of only a few chars;
    // but a small file shorter than 64 chars should still be fully injected.
    if (budget < Math.min(64, budgetCap)) return false;
    const clipped = clipWithLines(item.text, budget);
    if (!clipped.excerpt) return false;
    items.push({
      path: item.path,
      reason: item.reason,
      symbol: item.symbol || '',
      excerpt: clipped.excerpt,
      truncated: clipped.truncated || Boolean(item.symbolOnly),
      totalLines: clipped.totalLines,
      from: item.from || 1,
      to: item.to || Math.min(clipped.totalLines, clipped.excerpt.split('\n').length),
      fingerprint: item.fingerprint || '',
      hit: Boolean(item.hit)
    });
    used += clipped.excerpt.length;
    return true;
  };

  for (const relative of targets.paths.slice(0, maxFiles)) {
    if (used >= maxChars) break;
    const read = cache.read(workspace, relative);
    if (!read.found) continue;
    if (read.hit) hits += 1;
    else misses += 1;
    const refCount = typeof cache.bumpRef === 'function' ? cache.bumpRef(relative) : 1;
    const totalLines = read.text.split('\n').length;
    let text = read.text;
    let from = 1;
    let to = 0;
    if (requestedRange) {
      const lines = read.text.split('\n');
      from = Math.min(requestedRange.from, lines.length);
      to = Math.min(requestedRange.to, lines.length);
      if (to < from) continue;
      text = lines.slice(from - 1, to).join('\n');
    }
    const smallFile = read.text.length <= SMALL_FILE_CHARS;
    // Option 1: when the same-fingerprint body was already injected in this session (and the window is still valid), give only a one-line reference;
    // explicit line ranges are still injected on demand, so the model doesn't think it got new content.
    const alreadyInjected = !requestedRange
      && typeof cache.wasInjectedBody === 'function'
      && cache.wasInjectedBody(relative, read.hash);
    if (alreadyInjected) {
      const header = `- ${relative} (${totalLines} lines / ${read.text.length} chars, fingerprint ${read.hash.slice(0, 8)}, same-fingerprint body already injected in this session, unchanged)`;
      if (items.length >= maxFiles || used + header.length > maxChars) continue;
      items.push({
        path: relative,
        reason: 'reused',
        symbol: '',
        excerpt: '',
        headerOnly: true,
        reused: true,
        truncated: false,
        totalLines,
        totalChars: read.text.length,
        refCount,
        from: 1,
        to: totalLines,
        fingerprint: read.hash,
        hit: read.hit
      });
      used += header.length;
      reused += 1;
      continue;
    }
    // A large file's first reference doesn't expand the body; give only path/fingerprint/line count, read by line when the model actually needs it.
    if (!smallFile && !requestedRange && refCount < 2 && !inlineFirstReference) {
      const header = `- ${relative} (${totalLines} lines / ${read.text.length} chars, fingerprint ${read.hash.slice(0, 8)}, reference #${refCount} in this session)`;
      if (items.length >= maxFiles || used + header.length > maxChars) continue;
      items.push({
        path: relative,
        reason: 'path',
        symbol: '',
        excerpt: '',
        headerOnly: true,
        truncated: false,
        totalLines,
        totalChars: read.text.length,
        refCount,
        from: 1,
        to: totalLines,
        fingerprint: read.hash,
        hit: read.hit
      });
      used += header.length;
      continue;
    }
    const pushed = pushItem({
      path: relative,
      reason: 'path',
      text,
      fingerprint: read.hash,
      hit: read.hit,
      from,
      to: to || undefined
    }, smallFile && !requestedRange ? read.text.length : INLINE_MAX_CHARS);
    if (pushed && typeof cache.markInjectedBody === 'function') {
      cache.markInjectedBody(relative, read.hash);
    }
  }

  // Symbols only, no paths: find files containing the symbol in the workspace index, and on a hit take only a window around the symbol.
  if (targets.symbols.length && used < maxChars) {
    const candidates = (Array.isArray(fileIndex) ? fileIndex : [])
      .map((entry) => normalizeRelative(typeof entry === 'string' ? entry : entry?.path || ''))
      .filter(isSafeRelative)
      .filter((value) => !targets.paths.includes(value))
      .slice(0, 80);
    for (const symbol of targets.symbols) {
      if (used >= maxChars) break;
      for (const relative of candidates) {
        if (used >= maxChars) break;
        const read = cache.read(workspace, relative);
        if (!read.found) continue;
        const window = symbolWindow(read.text, symbol);
        if (!window) continue;
        if (read.hit) hits += 1;
        else misses += 1;
        pushItem({
          path: relative,
          reason: 'symbol',
          symbol,
          symbolOnly: true,
          text: window.excerpt,
          from: window.from,
          to: window.to,
          fingerprint: read.hash,
          hit: read.hit
        });
        break;
      }
    }
  }

  return {
    mode: 'targets',
    items,
    chars: used,
    hits,
    misses,
    reused,
    index: '',
    ...targets,
    note: items.length ? 'Prefetch excerpts may be incomplete' : 'Target files not found in the workspace'
  };
}

export function renderPrefetchBlock(plan) {
  if (!plan || plan.mode === 'none') return '';
  if (plan.mode === 'index') {
    if (!plan.index) return '';
    return [
      '## Workspace index (prefetch, paths only, no content read)',
      plan.index,
      'When you need file content, read it on demand with ptc_run or read_file.'
    ].join('\n');
  }
  if (!plan.items?.length) {
    return `## Prefetch context\n${plan.note || 'No prefetchable files found'}: ${[...(plan.paths || []), ...(plan.symbols || [])].join(', ')}`;
  }
  const blocks = plan.items.map((item) => {
    if (item.headerOnly) {
      if (item.reused) {
        return [
          `### ${item.path} — same-fingerprint body already injected in this session (${item.totalLines} lines / ${item.totalChars || 0} chars total, fingerprint ${String(item.fingerprint || '').slice(0, 8)}), not re-injected`,
          'Content unchanged; use read_file to read a specific line range or symbol when you need to review it.'
        ].join('\n');
      }
      return [
        `### ${item.path} — body not expanded (${item.totalLines} lines / ${item.totalChars || 0} chars total, fingerprint ${String(item.fingerprint || '').slice(0, 8)})`,
        'When you need content, use read_file to read a specific line range or symbol, avoiding the whole large file entering context.'
      ].join('\n');
    }
    const range = item.reason === 'symbol'
      ? `around symbol ${item.symbol} (lines ${item.from}-${item.to})`
      : `lines ${item.from}-${item.to}`;
    return [
      `### ${item.path} — ${range}${item.truncated ? ', truncated' : ''}`,
      '```',
      item.excerpt,
      '```'
    ].join('\n');
  });
  return [
    '## Prefetch context (excerpts may be incomplete; use tools to read the full content)',
    ...blocks
  ].join('\n\n');
}
