// History window policy: trim only when over the hard limit, and in one pass down to the soft limit.
// This keeps the request prefix between two trims "append-only", so the cache isn't broken by a sliding window every step.

// The window policy has two tiers:
// - explicit limits or legacy-compatible defaults: soft 60k / hard 150k chars (48/64 messages);
// - historyLimitsForContext: push the hard limit to 97% of the model window and take the soft limit at 50% of hard,
//   keeping long sessions append-only as much as possible and trimming once only near overflow.
export const DEFAULT_HISTORY_LIMITS = Object.freeze({
  softMessages: 48,
  hardMessages: 64,
  softChars: 60000,
  hardChars: 150000
});

export function resolveHistoryLimits(limits = {}) {
  const softMessages = Math.max(1, Math.floor(Number(limits.softMessages) || DEFAULT_HISTORY_LIMITS.softMessages));
  const hardMessages = Math.max(softMessages, Math.floor(Number(limits.hardMessages) || DEFAULT_HISTORY_LIMITS.hardMessages));
  const softChars = Math.max(1, Math.floor(Number(limits.softChars) || DEFAULT_HISTORY_LIMITS.softChars));
  const hardChars = Math.max(softChars, Math.floor(Number(limits.hardChars) || DEFAULT_HISTORY_LIMITS.hardChars));
  return { softMessages, hardMessages, softChars, hardChars };
}

// Derive the "trim as little as possible" history limit from the model context: the default 60k/150k-char window
// rebuilds the prefix every turn in long sessions, repeatedly breaking the cache hit rate. P1.1 pushes the trigger to 97% of the window
// and trims down to the soft limit (50% of hard) in one pass, making the next trim interval as long as possible;
// the trim point is aligned by applyHistoryWindow to a user message, ensuring a conversation turn isn't cut in half.
export function historyLimitsForContext(contextWindow = 128000) {
  const window = Math.max(8000, Number(contextWindow) || 128000);
  const hardChars = Math.max(150000, Math.floor(window * 0.97 * 2.5));
  return {
    softMessages: 600,
    hardMessages: 1200,
    softChars: Math.floor(hardChars * 0.5),
    hardChars
  };
}

function messageChars(message) {
  try {
    return JSON.stringify(message)?.length || 0;
  } catch {
    return 0;
  }
}

export function historyChars(messages) {
  return (Array.isArray(messages) ? messages : []).reduce((total, message) => total + messageChars(message), 0);
}

export function overHistoryLimits(messages, limits = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const config = resolveHistoryLimits(limits);
  return list.length > config.hardMessages || historyChars(list) > config.hardChars;
}

// Lagging trim: at least (hard - soft) between two trims.
// - message count exceeded: judge by the message-count gap;
// - char count exceeded: prefer the char gap (when lastTrimChars is provided), otherwise fall back to the message-count gap.
// Otherwise the window would exceed again right after each append, changing the prefix every step and invalidating the whole cache.
export function shouldTrimHistory(windowMessages, lastTrimLength = 0, limits = {}, options = {}) {
  const list = Array.isArray(windowMessages) ? windowMessages : [];
  const config = resolveHistoryLimits(limits);
  const gap = Math.max(1, config.hardMessages - config.softMessages);
  const messages = list.length;
  const chars = historyChars(list);
  const overMessages = messages > config.hardMessages;
  const overChars = chars > config.hardChars;
  if (!overMessages && !overChars) return false;

  const lastLength = Math.max(0, Number(lastTrimLength) || 0);
  const messageLag = messages - lastLength;
  if (overMessages && messageLag >= gap) return true;

  if (overChars) {
    const lastChars = Number(options.lastTrimChars);
    if (Number.isFinite(lastChars) && lastChars >= 0) {
      const charGap = Math.max(1, config.hardChars - config.softChars);
      if (chars - lastChars >= charGap) return true;
    } else if (!overMessages && messageLag >= gap) {
      // Legacy compatibility: when there is no char baseline, still use the message gap for lag protection.
      return true;
    }
  }
  return false;
}

// Cross-turn lagging trim: relative to the last trim of the previous turn; don't trim until the soft/hard gap is reached.
// This way consecutive requests only append messages, and the new turn's first request is naturally a prefix of the previous turn's last request.
export function resolveLaggingWindow(messages, lastTrimLength = 0, limits = {}, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const lastLength = Math.max(0, Number(lastTrimLength) || 0);
  if (shouldTrimHistory(list, lastLength, limits, options)) {
    const window = applyHistoryWindow(list, limits);
    return { window, trimmed: true, windowLength: window.length };
  }
  return { window: list.slice(), trimmed: false, windowLength: lastLength };
}

// Return a copy unchanged when not over the hard limit; when over, start from the soft-limit position,
// preferring alignment to a user message, so history doesn't start with an orphaned tool result.
export function applyHistoryWindow(messages, limits = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const config = resolveHistoryLimits(limits);
  if (!overHistoryLimits(list, config)) return list.slice();

  let start = Math.max(0, list.length - config.softMessages);
  // Align backward to the nearest user message: keep at least softMessages while not cutting a conversation turn in half.
  for (let index = start; index >= 0; index -= 1) {
    if (list[index]?.role === 'user') {
      start = index;
      break;
    }
  }
  // If still over the hard limit after alignment (no user message at the tail), fall back to the soft-limit start to keep the window bounded.
  if (list.length - start > config.hardMessages) {
    start = Math.max(0, list.length - config.softMessages);
  }

  let window = list.slice(start);
  while (window.length > 1 && historyChars(window) > config.softChars) {
    let drop = 1;
    while (drop < window.length && window[drop]?.role !== 'user') drop += 1;
    if (drop >= window.length) break;
    window = window.slice(drop);
  }
  return window;
}
