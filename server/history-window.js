// 历史窗口策略：只在超过硬上限时裁剪，且一次裁剪到软上限。
// 这样两次裁剪之间的请求前缀保持“只追加”，缓存不会被每一步滑窗打断。

export const DEFAULT_HISTORY_LIMITS = Object.freeze({
  softMessages: 48,
  hardMessages: 64,
  softChars: 180000,
  hardChars: 260000
});

export function resolveHistoryLimits(limits = {}) {
  const softMessages = Math.max(1, Math.floor(Number(limits.softMessages) || DEFAULT_HISTORY_LIMITS.softMessages));
  const hardMessages = Math.max(softMessages, Math.floor(Number(limits.hardMessages) || DEFAULT_HISTORY_LIMITS.hardMessages));
  const softChars = Math.max(1, Math.floor(Number(limits.softChars) || DEFAULT_HISTORY_LIMITS.softChars));
  const hardChars = Math.max(softChars, Math.floor(Number(limits.hardChars) || DEFAULT_HISTORY_LIMITS.hardChars));
  return { softMessages, hardMessages, softChars, hardChars };
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

// 滞后裁剪：两次裁剪之间至少间隔 (hard - soft) 条消息。
// 否则窗口会在每次追加后立刻再次超限，导致前缀每一步都变化，缓存全部失效。
export function shouldTrimHistory(windowMessages, lastTrimLength = 0, limits = {}) {
  const list = Array.isArray(windowMessages) ? windowMessages : [];
  const config = resolveHistoryLimits(limits);
  const gap = Math.max(1, config.hardMessages - config.softMessages);
  if (list.length - Math.max(0, Number(lastTrimLength) || 0) < gap) return false;
  return overHistoryLimits(list, config);
}

// 跨轮滞后裁剪：以上一轮最后一次裁剪长度为基准，未达到 hard - soft 间隔时不裁剪。
// 这样连续两个请求之间只追加消息，新轮次的首个请求天然是上一轮末尾请求的前缀。
export function resolveLaggingWindow(messages, lastTrimLength = 0, limits = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const lastLength = Math.max(0, Number(lastTrimLength) || 0);
  if (shouldTrimHistory(list, lastLength, limits)) {
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
