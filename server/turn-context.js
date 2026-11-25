// 单轮上下文的统一装配：工作区索引/预取、冷事实、产出索引与任务备忘。
// 全部内容都追加在用户消息里（稳定前缀之后），不改变 system/tools 的缓存前缀。
//
// 方案 2：这些“索引类上下文”按内容签名去重——同一会话里内容未变、且上一条注入消息
// 仍在窗口内时，本轮只写一行引用，不再重复注入正文，从而降低每轮首请求的新增 token。

import crypto from 'node:crypto';
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

// 会话级缓存必须跨轮复用，否则 mtime/size/hash 短路永远不会命中。
// 本地 loopback 会话对象长期存活；云端会话每请求重建，因此优先用 session.id 作为键，
// 无 id 时退回对象身份（测试/临时会话），并限制键数量避免长跑内存膨胀。
const MAX_SESSION_CACHES = 64;
const prefetchCachesById = new Map();
const prefetchCachesByObject = new WeakMap();
const turnCachesById = new Map();
const turnCachesByObject = new WeakMap();

function sessionCacheKey(session) {
  const id = session && typeof session === 'object' ? String(session.id || '').trim() : '';
  return id ? `session:${id}` : '';
}

function lookupScoped(byId, byObject, session) {
  if (!session || typeof session !== 'object') return null;
  const key = sessionCacheKey(session);
  if (!key) return byObject.get(session) || null;
  const value = byId.get(key);
  if (value) {
    // LRU：命中后移到队尾。
    byId.delete(key);
    byId.set(key, value);
  }
  return value || null;
}

function storeScoped(byId, byObject, session, value) {
  const key = sessionCacheKey(session);
  if (!key) {
    byObject.set(session, value);
    return value;
  }
  byId.set(key, value);
  while (byId.size > MAX_SESSION_CACHES) {
    byId.delete(byId.keys().next().value);
  }
  return value;
}

function dropScoped(byId, byObject, session) {
  if (!session || typeof session !== 'object') return;
  const key = sessionCacheKey(session);
  if (key) byId.delete(key);
  else byObject.delete(session);
}

function prefetchCacheFor(session) {
  if (!session || typeof session !== 'object') return createPrefetchCache();
  let cache = lookupScoped(prefetchCachesById, prefetchCachesByObject, session);
  if (!cache) {
    cache = storeScoped(prefetchCachesById, prefetchCachesByObject, session, createPrefetchCache());
  }
  return cache;
}

function turnCacheFor(session) {
  if (!session || typeof session !== 'object') return { blocks: {} };
  let cache = lookupScoped(turnCachesById, turnCachesByObject, session);
  if (!cache) {
    cache = storeScoped(turnCachesById, turnCachesByObject, session, { blocks: {} });
  }
  return cache;
}

// 窗口裁剪/压缩后，之前注入的索引可能已被移出窗口，必须允许下一轮完整重新注入。
export function resetTurnContext(session) {
  if (!session || typeof session !== 'object') return;
  const prefetch = lookupScoped(prefetchCachesById, prefetchCachesByObject, session);
  if (prefetch && typeof prefetch.resetInjected === 'function') prefetch.resetInjected();
  dropScoped(turnCachesById, turnCachesByObject, session);
}

function blockSignature(text) {
  return crypto.createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 12);
}

// 上一次注入必须仍然可见：消息还在、id 对得上、且没有落在窗口起点之前。
function anchorAlive(session, entry) {
  if (!entry) return false;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const index = Number(entry.anchorIndex);
  if (!Number.isInteger(index) || index < 0 || index >= messages.length) return false;
  if (entry.anchorId && String(messages[index]?.id || '') !== entry.anchorId) return false;
  const windowStart = Number(session.historyWindowStartAbs);
  if (Number.isFinite(windowStart) && windowStart > 0 && index < windowStart) return false;
  return true;
}

const BLOCK_LABELS = {
  workspaceIndex: '工作区索引',
  artifact: '产出索引',
  coldFact: '已确认事实',
  memo: '同类任务提示'
};

// 短会话降级：前 3 轮还没有可复用的历史，索引/事实类上下文按大预算注入只会放大
// 每一步的首请求 token，复用收益要等后续轮次才出现。这里只下调预算，不改变注入结构。
export function resolveTurnContextBudget({ session = {}, settings = {}, maxPrefetchChars = 8000 } = {}) {
  const priorUserTurns = (Array.isArray(session.messages) ? session.messages : [])
    .filter((item) => item?.role === 'user').length;
  if (priorUserTurns >= 3) {
    return {
      shortSession: false,
      maxPrefetchChars,
      indexMaxEntries: 240,
      factMaxTokens: 1000,
      artifactMaxTokens: 1000,
      memoEnabled: settings.taskMemo === true
    };
  }
  return {
    shortSession: true,
    maxPrefetchChars: Math.min(maxPrefetchChars, 4000),
    indexMaxEntries: 120,
    factMaxTokens: 400,
    artifactMaxTokens: 400,
    // 备忘本身已按重复率启用，短会话保持原开关，避免丢失“上次怎么做的”提示。
    memoEnabled: settings.taskMemo === true
  };
}

export function buildTurnContext({
  session = {},
  message = '',
  settings = {},
  workspace = '',
  baseModelContent = '',
  webContext = '',
  knowledgeContext = '',
  maxPrefetchChars = 8000,
  messageId = ''
} = {}) {
  // 传统模式（对照基准用）：只用全量历史 + 原始用户消息，不做任何上下文优化。
  if (settings.contextEngine === false) {
    return {
      modelContent: [baseModelContent, webContext, knowledgeContext].filter(Boolean).join('\n\n'),
      prefetchPlan: { mode: 'none', items: [], chars: 0, hits: 0, misses: 0, reused: 0, index: '' },
      memoSignature: '',
      prefetchCache: null,
      mergeOnTrim: '',
      reusedBlocks: []
    };
  }
  const turnCache = turnCacheFor(session);
  const budget = resolveTurnContextBudget({ session, settings, maxPrefetchChars });
  const anchorIndex = Array.isArray(session.messages) ? session.messages.length : 0;
  const reused = [];
  const deferredBlocks = [];
  // 返回完整块（首次/内容变化）或空串（复用上一轮注入），并记录本轮新注入的锚点。
  const decide = (kind, block) => {
    if (!block) {
      delete turnCache.blocks[kind];
      return '';
    }
    const signature = blockSignature(block);
    const entry = turnCache.blocks[kind];
    if (entry && entry.signature === signature && anchorAlive(session, entry)) {
      reused.push({ kind, signature });
      deferredBlocks.push(block);
      return '';
    }
    turnCache.blocks[kind] = {
      signature,
      anchorIndex,
      anchorId: String(messageId || '')
    };
    return block;
  };

  // 1) 预取：明确路径/符号才读文件，否则只给路径索引。
  const prefetchCache = prefetchCacheFor(session);
  const targets = extractContextTargets(message);
  const fileIndex = targets.paths.length ? [] : listWorkspaceEntries(workspace, { maxEntries: budget.indexMaxEntries, maxDepth: 2 });
  let prefetchPlan = { mode: 'none', items: [], chars: 0, hits: 0, misses: 0, reused: 0, index: '' };
  try {
    prefetchPlan = planPrefetch({
      message,
      workspace,
      fileIndex,
      cache: prefetchCache,
      maxChars: budget.maxPrefetchChars
    });
  } catch {
    // 预取失败绝不影响主流程。
  }
  // 工作区索引同样按签名去重：文件列表未变时不再重复注入。
  if (prefetchPlan.mode === 'index' && prefetchPlan.index) {
    const keptIndex = decide('workspaceIndex', prefetchPlan.index);
    if (!keptIndex) prefetchPlan = { ...prefetchPlan, index: '', indexReused: true };
  }

  // 2) 冷事实 / 产出索引 / 同一任务备忘：只在引用旧轮次时注入，各有 token 上限。
  const coldFactBlock = buildColdFactBlock({
    facts: extractColdFacts(collectToolCallsFromMessages(session.messages)),
    message,
    maxTokens: budget.factMaxTokens
  });
  const artifactBlock = renderArtifactIndex(session.artifacts, { message, maxTokens: budget.artifactMaxTokens });
  const memoSignature = budget.memoEnabled ? taskSignature(message).signature : '';
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

  const artifactKept = decide('artifact', artifactBlock);
  const coldFactKept = decide('coldFact', coldFactBlock);
  const memoKept = decide('memo', memoBlock);
  const reusedBlock = reused.length
    ? [
        '## 会话内上下文复用（内容与本会话先前消息相同，未重复注入）',
        ...reused.map((item) => `- ${BLOCK_LABELS[item.kind] || item.kind}：沿用本会话先前消息中的同名内容（指纹 ${item.signature}），内容未变化。`),
        '需要最新内容时用工具重新读取。'
      ].join('\n')
    : '';

  const modelContent = [
    baseModelContent,
    artifactKept,
    coldFactKept,
    memoKept,
    reusedBlock,
    renderPrefetchBlock(prefetchPlan),
    webContext,
    knowledgeContext
  ].filter(Boolean).join('\n\n');

  return {
    modelContent,
    prefetchPlan,
    memoSignature,
    prefetchCache,
    // 窗口裁剪时由调用方补回完整块，避免“引用了一条已经被裁掉的消息”。
    mergeOnTrim: deferredBlocks.join('\n\n'),
    reusedBlocks: reused.map((item) => item.kind)
  };
}
