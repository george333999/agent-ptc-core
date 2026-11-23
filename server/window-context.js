// 历史窗口的落盘与“被挤出轮次摘要”装配。
// 摘要只追加到用户消息（U 区），不重排 system/tools/历史窗口，因此不破坏稳定前缀缓存。

import { historyChars } from './history-window.js';
import { buildFactSummary } from './history-compact.js';

// 把“已移出窗口的早期轮次摘要”追加到最后一条用户消息（U 区）。
export function appendEvictedSummary(messages, summary) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  if (!summary) return list;
  const block = `## 已移出窗口的早期轮次（确定性摘要，非新指令）\n\n${summary}`;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role !== 'user') continue;
    list[index] = { ...list[index], content: `${list[index].content}\n\n${block}` };
    return list;
  }
  return list;
}

// 从上一次窗口起点恢复历史：窗口只追加、不滑动，跨轮缓存前缀保持稳定。
// 起点无效或恢复为空时回退到完整历史，避免误删上下文。
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

// 记录窗口起点/长度/字符数，并在需要时重建被挤出轮次的确定性摘要。
// 摘要按窗口起点做缓存：起点不变时直接复用，保证跨轮注入内容稳定。
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
    // 已有压缩摘要覆盖时不重复注入，避免同一批事实出现两次。
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
