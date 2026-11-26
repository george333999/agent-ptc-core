// In-turn context handling policy: only decisions and "request view" transforms, no modification of session history.
// Invariants:
// - don't distill the current tool result in-turn (avoiding forcing the model to read back, adding turns);
// - trim only at turn boundaries; in-turn, trim urgently only when close to overflow (≥90%);
// - above 80% context, prefer degrading the oldest tool results rather than rewriting the current turn.

import { estimateTokens } from './token-opt.js';

const DEFAULT_KEEP_RECENT_TOOLS = 4;
const DEFAULT_DEGRADE_CHARS = 800;

// Conservative fallback when the model doesn't declare a context window: avoid ratio staying 0, which would disable
// in-turn degradation/trim entirely, and the final request exceeding the provider's real limit (e.g. 1M) → 400, whole turn with no result.
export const FALLBACK_CONTEXT_WINDOW = 128000;

export function effectiveContextWindow(value, fallback = FALLBACK_CONTEXT_WINDOW) {
  const window = Math.max(0, Number(value) || 0);
  if (window > 0) return window;
  return Math.max(8000, Number(fallback) || FALLBACK_CONTEXT_WINDOW);
}

export function contextRatio({ promptTokens = 0, contextWindow = 0 } = {}) {
  const used = Math.max(0, Number(promptTokens) || 0);
  const window = Math.max(0, Number(contextWindow) || 0);
  if (!window) return 0;
  return Math.min(1, Number((used / window).toFixed(4)));
}

export function shouldDistillToolResult({
  enabled = true,
  turnActive = true,
  contextRatio: ratio = 0,
  outputChars = 0,
  minChars = 0
} = {}) {
  if (!enabled) return false;
  if (Number(outputChars) < Math.max(0, Number(minChars) || 0)) return false;
  // No distillation in-turn by default: degrade only when the context is really near the limit.
  if (turnActive && ratio < 0.8) return false;
  return true;
}

export function shouldTrimAtStep({ step = 0, overHard = false, contextRatio: ratio = 0, hardRatio = 0.97 } = {}) {
  if (!overHard) return false;
  // step 0 is a turn boundary, allowing regular trim; in-turn, only the hard-limit ratio triggers urgent trim.
  if (Number(step) <= 0) return true;
  return ratio >= hardRatio;
}

function toolMessageContent(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return '';
}

/**
 * Build a "degraded request view": truncate the oldest tool results into short summaries, keeping the most recent keepRecent.
 * Returns a new array; does not modify the passed message objects.
 */
export function degradeOldestToolResults(messages, {
  keepRecent = DEFAULT_KEEP_RECENT_TOOLS,
  degradeChars = DEFAULT_DEGRADE_CHARS
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const toolIndexes = [];
  for (let index = 0; index < list.length; index += 1) {
    if (list[index]?.role === 'tool') toolIndexes.push(index);
  }
  const protectedCount = Math.max(0, Math.floor(Number(keepRecent) || 0));
  const candidates = toolIndexes.slice(0, Math.max(0, toolIndexes.length - protectedCount));
  if (!candidates.length) return { messages: list.slice(), degraded: 0 };
  const limit = Math.max(120, Math.floor(Number(degradeChars) || DEFAULT_DEGRADE_CHARS));
  const next = list.slice();
  let degraded = 0;
  for (const index of candidates) {
    const original = next[index];
    const text = toolMessageContent(original);
    if (text.length <= limit) continue;
    const remaining = text.length - limit;
    next[index] = {
      ...original,
      content: `${text.slice(0, limit)}\n… (earlier tool result degraded, ${remaining} chars omitted; re-read with the original arguments if needed)`
    };
    degraded += 1;
  }
  return { messages: next, degraded };
}

// One-time compaction at the turn boundary: degrade only above the threshold, avoiding unnecessary prefix rewrites.
export function planTurnBoundaryDegrade(messages, {
  contextRatio: ratio = 0,
  threshold = 0.8,
  keepRecent = DEFAULT_KEEP_RECENT_TOOLS,
  degradeChars = DEFAULT_DEGRADE_CHARS
} = {}) {
  if (Number(ratio) < Number(threshold)) {
    return { degraded: 0, messages: Array.isArray(messages) ? messages.slice() : [] };
  }
  return degradeOldestToolResults(messages, { keepRecent, degradeChars });
}

/**
 * Shrink the request view into the target token budget (fallback when the provider reports context overflow):
 * 1) first degrade the oldest tool results into short summaries;
 * 2) if still over budget, drop the oldest history by "user turn", keeping the system header and recent messages,
 *    without splitting assistant tool_calls from their tool results.
 */
export function shrinkToTokenBudget(messages, {
  targetTokens = 0,
  keepRecentTools = 2,
  degradeChars = 400,
  keepTail = 6
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const target = Math.max(2000, Number(targetTokens) || 0);
  const degraded = degradeOldestToolResults(list, { keepRecent: keepRecentTools, degradeChars });
  let result = degraded.messages;
  let trimmed = 0;
  const size = () => estimateTokens(JSON.stringify(result));
  const minKeep = Math.max(1, Math.floor(Number(keepTail) || 0)) + 1;
  for (let guard = 0; guard < 50 && size() > target; guard += 1) {
    if (result.length <= minKeep) break;
    const start = result.findIndex((item, index) => index > 0 && item?.role === 'user');
    if (start <= 0) break;
    let end = start + 1;
    while (end < result.length && result[end]?.role !== 'user') end += 1;
    // Don't drop when only the last turn remains, avoiding deleting the current question as well.
    if (end >= result.length) break;
    trimmed += end - start;
    result = result.slice(0, start).concat(result.slice(end));
  }
  return { messages: result, degraded: degraded.degraded, trimmed, tokens: size() };
}
