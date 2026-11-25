// 历史窗口策略：只在超过硬上限时裁剪，且一次裁剪到软上限。
// 这样两次裁剪之间的请求前缀保持“只追加”，缓存不会被每一步滑窗打断。

// 窗口策略有两档：
// - 显式 limits 或历史兼容默认值：soft 60k / hard 150k 字符（48/64 条）；
// - historyLimitsForContext：按模型窗口把硬上限推到 97%，软上限取硬上限的 50%，
//   让长会话尽量保持 append-only，只在接近溢出时裁一次。
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

// 按模型上下文推导“尽量不裁剪”的历史上限：默认 60k/150k 字符的窗口在长会话里
// 每轮都会重建前缀，缓存命中率被反复打断。P1.1 把触发线推迟到窗口 97%，
// 并一次裁到软上限（硬上限的 50%），让下一次裁剪间隔尽量长；
// 裁剪点由 applyHistoryWindow 对齐到 user 消息，保证不会拦腰截断一轮对话。
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

// 滞后裁剪：两次裁剪之间至少间隔 (hard - soft)。
// - 消息数超限：按消息条数间隔判断；
// - 字符数超限：优先按字符间隔判断（提供 lastTrimChars 时），否则退回消息条数间隔。
// 否则窗口会在每次追加后立刻再次超限，导致前缀每一步都变化，缓存全部失效。
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
      // 兼容旧调用：没有字符基准时仍用消息间隔做滞后保护。
      return true;
    }
  }
  return false;
}

// 跨轮滞后裁剪：以上一轮最后一次裁剪为基准，未达到 soft/hard 间隔时不裁剪。
// 这样连续两个请求之间只追加消息，新轮次的首个请求天然是上一轮末尾请求的前缀。
export function resolveLaggingWindow(messages, lastTrimLength = 0, limits = {}, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const lastLength = Math.max(0, Number(lastTrimLength) || 0);
  if (shouldTrimHistory(list, lastLength, limits, options)) {
    const window = applyHistoryWindow(list, limits);
    return { window, trimmed: true, windowLength: window.length };
  }
  return { window: list.slice(), trimmed: false, windowLength: lastLength };
}

// 未超过硬上限时原样返回副本；超过时从软上限位置开始，
// 优先对齐到 user 消息，避免历史以孤立的 tool 结果开头。
export function applyHistoryWindow(messages, limits = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const config = resolveHistoryLimits(limits);
  if (!overHistoryLimits(list, config)) return list.slice();

  let start = Math.max(0, list.length - config.softMessages);
  // 向前对齐到最近的 user 消息：保留至少 softMessages 条，同时不把一轮对话拦腰截断。
  for (let index = start; index >= 0; index -= 1) {
    if (list[index]?.role === 'user') {
      start = index;
      break;
    }
  }
  // 若对齐后仍超过硬上限（尾部没有 user 消息），退回软上限起点，保证窗口有界。
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
