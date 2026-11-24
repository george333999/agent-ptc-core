// 输出路径解析：Chat 与 Agent 共用同一套工具，但交付目录隔离。
// 独立成模块，供 tools.js 与 tool-scheduler.js 共用，避免调度器依赖完整工具注册表。
import { resolveWithinWorkspace } from './paths.js';

export function outputRelFor(ctx) {
  const fallback = ctx?.mode === 'chat' ? 'outputs/chat' : 'outputs';
  return String(ctx?.outputRel || fallback).replace(/\\/g, '/').replace(/\/+$/, '') || fallback;
}

// 把模型写的 outputs/... 路径重定向到当前模式的输出目录。
// 只处理 outputs 前缀，源码路径（src/...、README.md 等）保持原样。
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
