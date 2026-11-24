import fs from 'node:fs';
import path from 'node:path';

// 路径解析热路径：
// - 每个工具调用都会校验工作区边界，重复 realpath 工作区根是固定开销；
// - 工作区根按解析后的路径缓存，用户输入路径仍然逐次 realpath，安全检查不降级；
// - native realpath 直接走系统调用，避免 JS 层逐段解析。
const ROOT_CACHE_LIMIT = 64;
const ROOT_CACHE_TTL_MS = 30_000;

const rootCache = new Map();
const cacheStats = { hits: 0, misses: 0, invalidations: 0 };

function resolvedPath(target) {
  return path.resolve(String(target));
}

function cacheKey(resolved) {
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function nativeRealpath(target) {
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync;
    return realpath(target);
  } catch {
    return null;
  }
}

export function realpathOrResolve(target) {
  return nativeRealpath(target) ?? path.resolve(target);
}

// 解析最深的已存在祖先，再拼回不存在的尾部，保持“新建文件也能校验边界”的语义。
function canonicalize(target) {
  const absolute = path.resolve(target);
  let current = absolute;
  const missing = [];
  for (;;) {
    const resolved = nativeRealpath(current);
    if (resolved) {
      return missing.length ? path.join(resolved, ...missing.reverse()) : resolved;
    }
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    missing.push(path.basename(current));
    current = parent;
  }
}

function rememberRoot(key, root) {
  rootCache.set(key, { root, at: Date.now() });
  while (rootCache.size > ROOT_CACHE_LIMIT) {
    rootCache.delete(rootCache.keys().next().value);
  }
}

/**
 * 工作区根的真实路径。缓存键带上规范化路径，切换工作区不会串用；
 * 显式失效用于工作区被移动/重建的场景，TTL 兜底长期运行时的目录替换。
 */
export function workspaceRoot(workspace) {
  const resolved = resolvedPath(workspace || '.');
  const key = cacheKey(resolved);
  const cached = rootCache.get(key);
  if (cached && Date.now() - cached.at < ROOT_CACHE_TTL_MS) {
    cacheStats.hits += 1;
    // LRU：命中后移到队尾。
    rootCache.delete(key);
    rootCache.set(key, cached);
    return cached.root;
  }
  cacheStats.misses += 1;
  const root = realpathOrResolve(resolved);
  rememberRoot(key, root);
  return root;
}

export function resolveWithinWorkspace(workspace, relative) {
  const root = workspaceRoot(workspace);
  const raw = String(relative ?? '.').trim() || '.';
  const absolute = path.resolve(root, raw);
  const canonical = canonicalize(absolute);
  const rel = path.relative(root, canonical);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径超出工作区：${relative}`);
  }
  return canonical;
}

export function isWithinWorkspace(workspace, target) {
  const root = workspaceRoot(workspace);
  const rel = path.relative(root, realpathOrResolve(target));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// workspace 省略时清空全部缓存；传入时只失效该工作区。
export function invalidatePathCache(workspace) {
  if (workspace === undefined) {
    rootCache.clear();
  } else {
    rootCache.delete(cacheKey(workspace));
  }
  cacheStats.invalidations += 1;
}

export function pathCacheStats() {
  return { ...cacheStats, entries: rootCache.size };
}
