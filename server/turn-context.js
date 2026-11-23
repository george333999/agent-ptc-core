// 单轮上下文的统一装配：工作区索引/预取、冷事实、产出索引与任务备忘。
// 全部内容都追加在用户消息里（稳定前缀之后），不改变 system/tools 的缓存前缀。

import {
  createPrefetchCache,
  extractContextTargets,
  listWorkspaceEntries,
  planPrefetch,
  renderPrefetchBlock
} from './context-prefetch.js';
import { buildColdFactBlock, collectToolCallsFromMessages, extractColdFacts } from './cold-facts.js';
import { renderArtifactIndex } from './artifact-index.js';
import { renderMemoHint, shouldEnableMemo, taskSignature } from './task-memo.js';

// 预取缓存必须跨轮复用，否则 mtime/size/hash 短路永远不会命中。
// 用 WeakMap 以会话对象为键，会话被回收时缓存一并释放，不额外占用内存。
const sessionPrefetchCaches = new WeakMap();

function prefetchCacheFor(session) {
  if (!session || typeof session !== 'object') return createPrefetchCache();
  let cache = sessionPrefetchCaches.get(session);
  if (!cache) {
    cache = createPrefetchCache();
    sessionPrefetchCaches.set(session, cache);
  }
  return cache;
}

export function buildTurnContext({
  session = {},
  message = '',
  settings = {},
  workspace = '',
  baseModelContent = '',
  webContext = '',
  knowledgeContext = '',
  maxPrefetchChars = 8000
} = {}) {
  // 传统模式（对照基准用）：只用全量历史 + 原始用户消息，不做任何上下文优化。
  if (settings.contextEngine === false) {
    return {
      modelContent: [baseModelContent, webContext, knowledgeContext].filter(Boolean).join('\n\n'),
      prefetchPlan: { mode: 'none', items: [], chars: 0, hits: 0, misses: 0, index: '' },
      memoSignature: '',
      prefetchCache: null
    };
  }
  // 1) 预取：明确路径/符号才读文件，否则只给路径索引。
  const prefetchCache = prefetchCacheFor(session);
  const targets = extractContextTargets(message);
  const fileIndex = targets.paths.length ? [] : listWorkspaceEntries(workspace, { maxEntries: 240, maxDepth: 2 });
  let prefetchPlan = { mode: 'none', items: [], chars: 0, hits: 0, misses: 0, index: '' };
  try {
    prefetchPlan = planPrefetch({
      message,
      workspace,
      fileIndex,
      cache: prefetchCache,
      maxChars: maxPrefetchChars
    });
  } catch {
    // 预取失败绝不影响主流程。
  }

  // 2) 冷事实 / 产出索引 / 同一任务备忘：只在引用旧轮次时注入，各有 token 上限。
  const coldFactBlock = buildColdFactBlock({
    facts: extractColdFacts(collectToolCallsFromMessages(session.messages)),
    message,
    maxTokens: 1000
  });
  const artifactBlock = renderArtifactIndex(session.artifacts, { message, maxTokens: 1000 });
  const memoSignature = settings.taskMemo === true ? taskSignature(message).signature : '';
  let memoBlock = '';
  if (memoSignature) {
    session.taskMemoCounts = session.taskMemoCounts && typeof session.taskMemoCounts === 'object'
      ? session.taskMemoCounts
      : {};
    const count = (Number(session.taskMemoCounts[memoSignature]) || 0) + 1;
    session.taskMemoCounts[memoSignature] = count;
    const total = Object.values(session.taskMemoCounts).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const repeatRate = total > 1 ? (count - 1) / total : 0;
    if (shouldEnableMemo(repeatRate)) {
      const entry = session.taskMemoEntries?.[memoSignature];
      if (entry) memoBlock = renderMemoHint(entry);
    }
  }

  const modelContent = [
    baseModelContent,
    artifactBlock,
    coldFactBlock,
    memoBlock,
    renderPrefetchBlock(prefetchPlan),
    webContext,
    knowledgeContext
  ].filter(Boolean).join('\n\n');

  return { modelContent, prefetchPlan, memoSignature, prefetchCache };
}
