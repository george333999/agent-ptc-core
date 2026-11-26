// Context overflow fallback: recognize a provider 400, tighten the window to the real limit, and retry after shrinking the request view.
// Kept in a separate file to stop runAgent from growing further; the logic itself does no IO, making unit testing easy.
import { effectiveContextWindow, shrinkToTokenBudget } from './context-policy.js';

const CONTEXT_LENGTH_RE = /maximum context length|context[_ ]length[_ ]exceeded|reduce the length of the messages|prompt is too long|input is too long/i;

export function isContextLengthError(message) {
  return CONTEXT_LENGTH_RE.test(String(message || ''));
}

export function contextLimitFromError(message) {
  const text = String(message || '');
  const match = text.match(/maximum context length is\s+(\d+)/i)
    || text.match(/context length of\s+(\d+)/i)
    || text.match(/limit of\s+(\d+)\s+tokens/i);
  const value = Number(match?.[1]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function contextLengthMessage(message, windowTokens = 0) {
  const window = Math.max(0, Number(windowTokens) || 0);
  const scope = window ? ` (limit ~${Math.round(window / 1000)}k tokens)` : '';
  const readable = `Context exceeds the model's processable length${scope}; history was auto-compressed but is still over the limit. Please create a new task, or reduce imported context files and retry.`;
  const raw = String(message || '').trim();
  return raw ? `${readable} Original error: ${raw}` : readable;
}

/**
 * Handle one failed model call: if it is a context overflow, return the compressed request view for retry.
 * - handled: whether it is a context overflow
 * - retry: whether to retry (use messages when true)
 * - contextWindow: window tightened per the provider error
 */
export function planContextOverflow({
  contextWindow = 0,
  messages = [],
  errorMessage = '',
  retriesUsed = 0,
  maxRetries = 2
} = {}) {
  if (!isContextLengthError(errorMessage)) return { handled: false, retry: false };
  const limit = contextLimitFromError(errorMessage);
  const window = Math.max(4000, Math.min(effectiveContextWindow(contextWindow), limit > 0 ? limit : Number.POSITIVE_INFINITY));
  const failed = () => ({
    handled: true,
    retry: false,
    contextWindow: window,
    error: contextLengthMessage(errorMessage, window)
  });
  if (retriesUsed >= maxRetries) return failed();
  const target = Math.max(4000, Math.floor(window * 0.7));
  const shrunk = shrinkToTokenBudget(messages, { targetTokens: target });
  if (!shrunk.degraded && !shrunk.trimmed) return failed();
  return {
    handled: true,
    retry: true,
    contextWindow: window,
    messages: shrunk.messages,
    attempt: retriesUsed + 1,
    maxRetries,
    tokens: shrunk.tokens,
    retryMessage: `Context exceeded the model limit; retrying after compressing history (~${Math.round(shrunk.tokens / 1000)}k tokens)`
  };
}
