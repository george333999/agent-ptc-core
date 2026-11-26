// Unified assembly of single-turn context: workspace index/prefetch, cold facts, artifact index, and task memo.
// All content is appended to the user message (after the stable prefix), not changing the system/tools cache prefix.
//
// Option 2: these "index-type contexts" are deduplicated by content signature — when the content is unchanged in the same session and the previous injected message
// is still in the window, this turn writes only a one-line reference instead of re-injecting the body, lowering the added tokens of each turn's first request.

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

// Session-level caches must be reused across turns, otherwise the mtime/size/hash short-circuit would never hit.
// Local loopback session objects live long; cloud sessions are rebuilt per request, so prefer session.id as the key,
// falling back to object identity when there is no id (tests/temporary sessions), and bound the key count to avoid memory growth on long runs.
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
    // LRU: move to the tail on a hit.
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

// After window trim/compaction, previously injected indexes may have been moved out of the window; must allow full re-injection next turn.
export function resetTurnContext(session) {
  if (!session || typeof session !== 'object') return;
  const prefetch = lookupScoped(prefetchCachesById, prefetchCachesByObject, session);
  if (prefetch && typeof prefetch.resetInjected === 'function') prefetch.resetInjected();
  dropScoped(turnCachesById, turnCachesByObject, session);
}

function blockSignature(text) {
  return crypto.createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 12);
}

// The previous injection must still be visible: the message still exists, the id matches, and it isn't before the window start.
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
  workspaceIndex: 'workspace index',
  artifact: 'artifact index',
  coldFact: 'confirmed facts',
  memo: 'similar-task hint'
};

// Short-session degradation: the first 3 turns have no reusable history yet, so injecting index/fact contexts with a large budget only inflates
// each step's first-request tokens while reuse benefits appear only in later turns. Here only the budgets are lowered, not the injection structure.
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
    // The memo itself is already gated by repetition rate; short sessions keep the original switch, avoiding losing the "how it was done last time" hint.
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
  // Legacy mode (for baseline comparison): use only full history + the raw user message, no context optimization.
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
  // Return the full block (first time/content changed) or an empty string (reuse the previous turn's injection), and record this turn's newly injected anchor.
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

  // 1) Prefetch: read files only with explicit paths/symbols, otherwise give only the path index.
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
    // Prefetch failure must never affect the main flow.
  }
  // The workspace index is also deduplicated by signature: don't re-inject when the file list is unchanged.
  if (prefetchPlan.mode === 'index' && prefetchPlan.index) {
    const keptIndex = decide('workspaceIndex', prefetchPlan.index);
    if (!keptIndex) prefetchPlan = { ...prefetchPlan, index: '', indexReused: true };
  }

  // 2) Cold facts / artifact index / same-task memo: injected only when referencing old turns, each with a token cap.
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
        '## In-session context reuse (content identical to an earlier message in this session, not re-injected)',
        ...reused.map((item) => `- ${BLOCK_LABELS[item.kind] || item.kind}: reuses the same-named content from an earlier message in this session (fingerprint ${item.signature}), unchanged.`),
        'Use tools to re-read when you need the latest content.'
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
    // On window trim the caller restores the full block, avoiding "referencing a message that has been trimmed away".
    mergeOnTrim: deferredBlocks.join('\n\n'),
    reusedBlocks: reused.map((item) => item.kind)
  };
}
