// Output path resolution: Chat and Agent share the same tools, but their deliverable directories are isolated.
// Kept as a separate module so tools.js and tool-scheduler.js can share it without the scheduler depending on the full tool registry.
import { resolveWithinWorkspace } from './paths.js';

export function outputRelFor(ctx) {
  const fallback = ctx?.mode === 'chat' ? 'outputs/chat' : 'outputs';
  return String(ctx?.outputRel || fallback).replace(/\\/g, '/').replace(/\/+$/, '') || fallback;
}

// Redirect model-written outputs/... paths to the output directory of the current mode.
// Only the outputs prefix is handled; source paths (src/..., README.md, etc.) are left untouched.
export function resolveOutputPath(ctx, value) {
  const rel = String(value || '').replace(/\\/g, '/');
  if (!rel || ctx?.mode !== 'chat') return rel;
  const root = outputRelFor(ctx);
  if (rel === root || rel.startsWith(`${root}/`)) return rel;
  if (rel === 'outputs') return root;
  if (rel.startsWith('outputs/')) return `${root}${rel.slice('outputs'.length)}`;
  return rel;
}

export function resolveWorkspacePath(workspace, relative) {
  return resolveWithinWorkspace(workspace, relative);
}
