import test from 'node:test';
import assert from 'node:assert/strict';
import { historyChars, resolveLaggingWindow } from '../server/history-window.js';
import {
  appendEvictedSummary,
  createWindowContext,
  restoreWindowHistory
} from '../server/window-context.js';

// 小窗口便于在少量轮次内触达边界；字符约束是 v4 的主控项。
const LIMITS = { softMessages: 8, hardMessages: 16, softChars: 3000, hardChars: 6000 };

// 与会话存储一致：system 不进入 messages，abs 0 就是第一条用户消息。
function buildSession() {
  return {
    id: 'v4-session',
    messages: [],
    historyWindowLength: 0,
    historyWindowChars: 0,
    historyWindowStartAbs: 0
  };
}

function absIndexOf(session) {
  return new Map(session.messages.map((message, index) => [message.id, index]));
}

// 模拟一次轮边界：恢复上一轮窗口 → 滞后裁剪 → 记录窗口 → 生成被挤出摘要。
function turnBoundary(session, { persist = () => {} } = {}) {
  const absIndexById = absIndexOf(session);
  const allHistory = session.messages.filter((message) => message.role !== 'system');
  const candidate = restoreWindowHistory(allHistory, absIndexById, session.historyWindowStartAbs);
  const resolved = resolveLaggingWindow(candidate, session.historyWindowLength, LIMITS, {
    lastTrimChars: session.historyWindowChars
  });
  const { rememberWindow, evictedSummaryFor } = createWindowContext({
    session,
    absIndexById,
    persist
  });
  if (resolved.trimmed) rememberWindow(resolved.window);
  const summary = evictedSummaryFor(resolved.window);
  return { window: resolved.window, trimmed: resolved.trimmed, summary, absIndexById };
}

function addTurn(session, index, { size = 1200, artifact = '' } = {}) {
  const userId = `u${index}`;
  const assistantId = `a${index}`;
  session.messages.push({ id: userId, role: 'user', content: `第 ${index} 轮：继续推进 ${'Q'.repeat(size)}` });
  session.messages.push({
    id: assistantId,
    role: 'assistant',
    content: 'done',
    toolCalls: artifact
      ? [
          { name: 'read_file', args: { path: 'src/calc.js' }, status: 'completed', result: 'x' },
          { name: 'write_file', args: { path: artifact, content: 'y'.repeat(100) }, status: 'completed', result: 'ok' }
        ]
      : []
  });
}

test('多轮后窗口字符数收敛在软上限内，且只追加不滑动', () => {
  const session = buildSession();
  let previousFirst = '';
  let stablePrefixTurns = 0;
  for (let index = 1; index <= 12; index += 1) {
    addTurn(session, index, { artifact: index === 1 ? 'reports/early.md' : '' });
    const result = turnBoundary(session);
    // 窗口在 soft 与 hard 之间滞后裁剪，任何时刻都不得超过硬上限。
    assert.ok(historyChars(result.window) <= LIMITS.hardChars, `turn ${index} window over hard limit`);
    if (previousFirst && result.window[0]?.id === previousFirst) stablePrefixTurns += 1;
    previousFirst = result.window[0]?.id || '';
  }
  assert.ok(session.historyWindowStartAbs > 0, '窗口应已推进');
  assert.ok(stablePrefixTurns >= 1, '未裁剪的轮次应保持窗口首消息不变');
});

test('被挤出早期轮次生成确定性摘要，并随窗口推进刷新', () => {
  const session = buildSession();
  let summary = '';
  let persists = 0;
  for (let index = 1; index <= 12; index += 1) {
    addTurn(session, index, { artifact: index === 1 ? 'reports/early.md' : '' });
    const result = turnBoundary(session, { persist: () => { persists += 1; } });
    if (result.summary) summary = result.summary;
  }
  assert.ok(summary, '应注入被挤出轮次摘要');
  assert.match(summary, /reports\/early\.md/, '摘要应保留早期产物路径');
  assert.ok(summary.length <= 2800, '摘要受 maxChars 约束');
  assert.ok(persists >= 1, '摘要应落盘一次');

  // 同一窗口起点重复生成必须字节一致（确定性），且不重复落盘。
  const before = persists;
  const again = turnBoundary(session, { persist: () => { persists += 1; } });
  assert.equal(again.summary, summary);
  assert.equal(persists, before);
});

test('前缀缓存安全：摘要只追加在用户消息尾部，窗口消息不被改写', () => {
  const session = buildSession();
  for (let index = 1; index <= 10; index += 1) addTurn(session, index);
  const result = turnBoundary(session);
  assert.ok(result.summary);

  const beforeWindow = result.window.map((message) => JSON.stringify(message));
  const prompt = appendEvictedSummary(
    [
      { role: 'system', content: 'SYS' },
      ...result.window.map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: '当前问题' }
    ],
    result.summary
  );
  // 窗口原消息不变，摘要只出现在最后一条用户消息里。
  assert.deepEqual(
    prompt.slice(1, 1 + result.window.length).map((message) => message.content),
    result.window.map((message) => message.content)
  );
  assert.equal(result.window.map((message) => JSON.stringify(message)).join('|'), beforeWindow.join('|'));
  assert.match(prompt[prompt.length - 1].content, /当前问题[\s\S]*已移出窗口的早期轮次/);
});

test('边界值：未超过硬上限时不裁剪也不注入摘要', () => {
  const session = buildSession();
  // 只放一轮小消息，确保远低于 hardChars / hardMessages。
  addTurn(session, 1, { size: 10 });
  const result = turnBoundary(session);
  assert.equal(result.trimmed, false);
  assert.equal(result.summary, '');
  assert.equal(session.historyWindowStartAbs, 0);
  assert.equal(session.historyWindowLength, 0);
});
