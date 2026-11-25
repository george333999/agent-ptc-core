// 轮次内的上下文处理策略：只做决策与“请求视图”变换，不修改会话历史。
// 不变量：
// - 轮内不蒸馏当前工具结果（避免模型被迫回读，增加轮次）；
// - 裁剪只在轮边界；轮内只有接近溢出（≥90%）才紧急裁剪；
// - 超过 80% 上下文时，优先降级最旧的工具结果，而不是改写当前轮。

import { estimateTokens } from './token-opt.js';

const DEFAULT_KEEP_RECENT_TOOLS = 4;
const DEFAULT_DEGRADE_CHARS = 800;

// 模型未声明上下文窗口时的保守兜底值：避免 ratio 恒为 0，导致轮内降级/裁剪全部失效，
// 最终请求超过供应商真实上限（例如 1M）后直接 400、整轮没有结果。
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
  // 轮内默认不蒸馏：只有上下文真的接近上限才降级。
  if (turnActive && ratio < 0.8) return false;
  return true;
}

export function shouldTrimAtStep({ step = 0, overHard = false, contextRatio: ratio = 0, hardRatio = 0.97 } = {}) {
  if (!overHard) return false;
  // step 0 属于轮边界，允许按常规裁剪；轮内只在硬上限比例触发紧急裁剪。
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
 * 生成“降级请求视图”：把最旧的工具结果截断为短摘要，保留最近 keepRecent 条。
 * 返回新数组，不修改传入的消息对象。
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
      content: `${text.slice(0, limit)}\n…（较早的工具结果已降级，省略 ${remaining} 字符；需要时用原参数重新读取）`
    };
    degraded += 1;
  }
  return { messages: next, degraded };
}

// 轮边界的一次性压缩：只有超过阈值才降级，避免无谓改写前缀。
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
 * 把请求视图压到目标 token 预算内（供应商返回上下文超限时兜底）：
 * 1) 先把最旧的工具结果降级成短摘要；
 * 2) 仍超预算时按“用户轮”为单位丢弃最旧历史，保留 system 头部与最近消息，
 *    不拆分 assistant tool_calls 与其 tool 结果。
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
    // 只剩最后一轮时不丢，避免把当前问题一起删掉。
    if (end >= result.length) break;
    trimmed += end - start;
    result = result.slice(0, start).concat(result.slice(end));
  }
  return { messages: result, degraded: degraded.degraded, trimmed, tokens: size() };
}
