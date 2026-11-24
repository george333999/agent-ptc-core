// 上下文超限兜底：识别供应商 400、按真实上限收紧窗口，并压缩请求视图后重试。
// 独立成文件，避免 runAgent 继续膨胀；逻辑本身不做 IO，便于单元测试。
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
  const scope = window ? `（上限约 ${Math.round(window / 1000)}k tokens）` : '';
  const readable = `上下文超出模型可处理长度${scope}，已自动压缩历史后仍超限。请新建任务，或减少导入的上下文文件后重试。`;
  const raw = String(message || '').trim();
  return raw ? `${readable} 原始错误：${raw}` : readable;
}

/**
 * 处理一次模型调用失败：若属于上下文超限，返回压缩后的请求视图供重试。
 * - handled：是否属于上下文超限
 * - retry：是否应重试（true 时使用 messages）
 * - contextWindow：按供应商报错收紧后的窗口
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
    retryMessage: `上下文超出模型上限，已压缩历史后重试（约 ${Math.round(shrunk.tokens / 1000)}k tokens）`
  };
}
