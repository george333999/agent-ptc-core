// Persistence of the history window and assembly of the "evicted-turn summary".
// The summary is appended only to the user message (U zone), without reordering system/tools/the history window, so the stable prefix cache isn't broken.

import { historyChars } from './history-window.js';
import { buildFactSummary } from './history-compact.js';

// Append the "summary of early turns already moved out of the window" to the last user message (U zone).
export function appendEvictedSummary(messages, summary) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  if (!summary) return list;
  const block = `## Early turns moved out of the window (deterministic summary, not a new instruction)\n\n${summary}`;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role !== 'user') continue;
    list[index] = { ...list[index], content: `${list[index].content}\n\n${block}` };
    return list;
  }
  return list;
}

// Restore history from the previous window start: the window only appends, never slides, keeping the cross-turn cache prefix stable.
// When the start is invalid or the restoration is empty, fall back to the full history, avoiding accidentally dropping context.
export function restoreWindowHistory(messages, absIndexById, startAbs) {
  const list = Array.isArray(messages) ? messages : [];
  const start = Math.max(0, Number(startAbs) || 0);
  if (start <= 0) return list.slice();
  const restored = list.filter((item) => {
    const abs = absIndexById?.get?.(item.id);
    return Number.isInteger(abs) && abs >= start;
  });
  return restored.length ? restored : list.slice();
}

// Record the window start/length/char count, and rebuild the deterministic summary of evicted turns when needed.
// The summary is cached by window start: reused directly when the start is unchanged, keeping cross-turn injected content stable.
export function createWindowContext({
  session,
  workspace = '',
  absIndexById,
  persist = () => {},
  maxSummaryChars = 2800
} = {}) {
  const rememberWindow = (windowMessages) => {
    const list = Array.isArray(windowMessages) ? windowMessages : [];
    session.historyWindowLength = list.length;
    session.historyWindowChars = historyChars(list);
    const startAbs = list.length ? absIndexById?.get?.(list[0].id) : 0;
    if (Number.isInteger(startAbs)) session.historyWindowStartAbs = startAbs;
  };

  const evictedSummaryFor = (windowMessages, compaction = null) => {
    const list = Array.isArray(windowMessages) ? windowMessages : [];
    if (!list.length) return '';
    const startAbs = absIndexById?.get?.(list[0].id);
    if (!Number.isInteger(startAbs) || startAbs <= 0) return '';
    // Don't inject again when a compaction summary already covers it, avoiding the same batch of facts appearing twice.
    if (compaction && Number(compaction.coveredEndIndex) >= startAbs) return '';
    if (session.historySummaryAbs !== startAbs || !session.historySummary) {
      session.historySummary = buildFactSummary({
        messages: session.messages,
        absIndexById,
        startAbs: 0,
        endAbs: startAbs,
        workspace,
        maxChars: maxSummaryChars
      });
      session.historySummaryAbs = startAbs;
      persist(session);
    }
    return session.historySummary || '';
  };

  return { rememberWindow, evictedSummaryFor };
}
