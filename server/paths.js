import fs from 'node:fs';
import path from 'node:path';

export function realpathOrResolve(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function canonicalize(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(canonicalize(parent), path.basename(target));
  }
}

export function workspaceRoot(workspace) {
  return realpathOrResolve(path.resolve(workspace || '.'));
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
