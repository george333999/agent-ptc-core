import fs from 'node:fs';
import path from 'node:path';

// Path resolution hot path:
// - Every tool call validates workspace boundaries, and repeatedly realpath-ing the workspace root is a fixed cost;
// - The workspace root is cached by resolved path, while user input paths are still realpath-ed each time, so security checks are not weakened;
// - Native realpath goes straight to the system call, avoiding per-segment resolution in JS.
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

// Resolve the deepest existing ancestor, then reattach the non-existent tail, preserving "new files can also be boundary-checked".
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
 * Real path of the workspace root. The cache key includes the normalized path, so switching workspaces never mixes entries;
 * explicit invalidation covers moved/recreated workspaces, and the TTL covers directory replacement during long runs.
 */
export function workspaceRoot(workspace) {
  const resolved = resolvedPath(workspace || '.');
  const key = cacheKey(resolved);
  const cached = rootCache.get(key);
  if (cached && Date.now() - cached.at < ROOT_CACHE_TTL_MS) {
    cacheStats.hits += 1;
    // LRU: move to the tail on a hit.
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
    throw new Error(`Path escapes the workspace: ${relative}`);
  }
  return canonical;
}

export function isWithinWorkspace(workspace, target) {
  const root = workspaceRoot(workspace);
  const rel = path.relative(root, realpathOrResolve(target));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Omitting workspace clears the whole cache; passing one invalidates only that workspace.
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
