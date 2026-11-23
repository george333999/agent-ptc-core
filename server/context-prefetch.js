// 上下文预取：只在用户消息里出现“明确路径”或“唯一符号”时才读文件，
// 避免盲目把整个工作区塞进提示词。所有预取内容都放在用户消息（前缀之后），
// 不改变 system/tools 的稳定前缀，因此不会破坏缓存。
//
// 硬约束：
// - 单轮预取总量 ≤ maxChars（默认 8000 字符）；
// - 片段可能不完整，渲染时必须显式标注；
// - 文件指纹 = path + mtime + size + hash，未变化时直接复用上次内容，跳过重读。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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

// 明确路径：必须带扩展名，且不是 URL 或版本号。
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

// 唯一符号：只接受反引号包裹的标识符，或“函数/方法/类 + 标识符”的明确表述。
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

// 识别“第 1-120 行”“1~120 行”这类明确行范围，预取时只取该段，避免把长文档整份塞进上下文。
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

// 无明确目标时只注入“路径 + 大小”的工作区索引，不读取任何文件内容。
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
  if (omitted > 0) lines.push(`…（共 ${list.length} 个文件，已省略 ${omitted} 个）`);
  return lines.join('\n');
}

export function fingerprintText(text) {
  return crypto.createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

const INDEX_IGNORE = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.cache',
  '.venv', 'venv', '__pycache__', 'data', 'vendor'
]);

// 轻量工作区索引：只收集路径与大小，不读取内容；有深度和数量上限。
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

// 会话级缓存：mtime + size 未变直接命中；变了再比较 hash，内容相同仍然命中。
// refs 记录同一路径在本会话被引用的次数，用于“按需注入正文”的判定。
export function createPrefetchCache() {
  const entries = new Map();
  const refs = new Map();
  return {
    get(relative) {
      return entries.get(normalizeRelative(relative)) || null;
    },
    set(fingerprint) {
      if (!fingerprint?.path) return;
      entries.set(fingerprint.path, fingerprint);
    },
    // 引用计数：第一次引用返回 1，第二次返回 2，用于决定是否展开正文。
    bumpRef(relative) {
      const key = normalizeRelative(relative);
      const next = (refs.get(key) || 0) + 1;
      refs.set(key, next);
      return next;
    },
    refCount(relative) {
      return refs.get(normalizeRelative(relative)) || 0;
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
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
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
 * 生成预取计划。返回结构：
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
  indexMaxTokens = 1000
} = {}) {
  const targets = extractContextTargets(message);
  if (!workspace) return { mode: 'none', items: [], chars: 0, hits: 0, misses: 0, index: '', ...targets };
  const hasTargets = targets.paths.length > 0 || targets.symbols.length > 0;
  if (!hasTargets) {
    return {
      mode: 'index',
      items: [],
      chars: 0,
      hits: 0,
      misses: 0,
      index: buildWorkspaceIndex(fileIndex, { maxTokens: indexMaxTokens }),
      ...targets
    };
  }

  // v4 按需注入：大文件首次引用只给“路径 + 指纹 + 行数”，
  // 只有小文件（≤1.5k 字符）、明确行范围、或本会话第 2 次引用同一路径时才注入正文。
  // 正文一律截断到 ≤1200 字符，避免单文件把预算吃光。
  const SMALL_FILE_CHARS = 1500;
  const INLINE_MAX_CHARS = 1200;
  const requestedRange = targets.paths.length === 1 ? extractLineRange(message) : null;
  const items = [];
  let used = 0;
  let hits = 0;
  let misses = 0;
  const pushItem = (item, budgetCap = INLINE_MAX_CHARS) => {
    if (used >= maxChars || items.length >= maxFiles) return;
    const budget = Math.min(budgetCap, maxChars - used);
    // 预算过小时预取没有意义，直接放弃，避免产生只有几个字符的“伪上下文”；
    // 但小文件本身不足 64 字符时仍应完整注入。
    if (budget < Math.min(64, budgetCap)) return;
    const clipped = clipWithLines(item.text, budget);
    if (!clipped.excerpt) return;
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
    // 首次引用的大文件不展开正文，只给路径/指纹/行数，等模型真正需要时再按行读取。
    if (!smallFile && !requestedRange && refCount < 2) {
      const header = `- ${relative}（${totalLines} 行 / ${read.text.length} 字符，指纹 ${read.hash.slice(0, 8)}，本会话第 ${refCount} 次引用）`;
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
    pushItem({
      path: relative,
      reason: 'path',
      text,
      fingerprint: read.hash,
      hit: read.hit,
      from,
      to: to || undefined
    }, smallFile && !requestedRange ? read.text.length : INLINE_MAX_CHARS);
  }

  // 只给符号没给路径：在工作区索引里找包含该符号的文件，命中后只截取符号附近窗口。
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
    index: '',
    ...targets,
    note: items.length ? '预取片段可能不完整' : '未在工作区找到目标文件'
  };
}

export function renderPrefetchBlock(plan) {
  if (!plan || plan.mode === 'none') return '';
  if (plan.mode === 'index') {
    if (!plan.index) return '';
    return [
      '## 工作区索引（预取，仅路径，未读取内容）',
      plan.index,
      '需要文件内容时再用 ptc_run 或 read_file 按需读取。'
    ].join('\n');
  }
  if (!plan.items?.length) {
    return `## 预取上下文\n${plan.note || '未找到可预取的文件'}：${[...(plan.paths || []), ...(plan.symbols || [])].join('、')}`;
  }
  const blocks = plan.items.map((item) => {
    if (item.headerOnly) {
      return [
        `### ${item.path} — 未展开正文（共 ${item.totalLines} 行 / ${item.totalChars || 0} 字符，指纹 ${String(item.fingerprint || '').slice(0, 8)}）`,
        '需要内容时用 read_file 读取指定行范围或符号，避免整份大文件进入上下文。'
      ].join('\n');
    }
    const range = item.reason === 'symbol'
      ? `符号 ${item.symbol} 附近（第 ${item.from}-${item.to} 行）`
      : `第 ${item.from}-${item.to} 行`;
    return [
      `### ${item.path} — ${range}${item.truncated ? '，已截断' : ''}`,
      '```',
      item.excerpt,
      '```'
    ].join('\n');
  });
  return [
    '## 预取上下文（片段可能不完整，需要完整内容请用工具读取）',
    ...blocks
  ].join('\n\n');
}
