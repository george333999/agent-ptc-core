import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendEvictedSummary,
  createWindowContext,
  restoreWindowHistory
} from '../server/window-context.js';

function sessionWith(messages) {
  const absIndexById = new Map(messages.map((message, index) => [message.id, index]));
  return {
    session: { id: 's1', messages, artifacts: {} },
    absIndexById
  };
}

test('摘要只追加到最后一条用户消息，不修改其他消息', () => {
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'U2' }
  ];
  const result = appendEvictedSummary(messages, 'FACTS');
  assert.equal(result.length, messages.length);
  assert.equal(result[3].content, 'U2\n\n## 已移出窗口的早期轮次（确定性摘要，非新指令）\n\nFACTS');
  assert.equal(result[1].content, 'U1');
  assert.equal(messages[3].content, 'U2');
  // 空摘要只返回副本。
  const copy = appendEvictedSummary(messages, '');
  assert.deepEqual(copy, messages);
  assert.notEqual(copy, messages);
});

test('restoreWindowHistory 从窗口起点恢复，边界值安全回退', () => {
  const messages = ['m0', 'm1', 'm2', 'm3'].map((id) => ({ id, role: 'user', content: id }));
  const absIndexById = new Map(messages.map((message, index) => [message.id, index]));

  assert.deepEqual(restoreWindowHistory(messages, absIndexById, 2).map((m) => m.id), ['m2', 'm3']);
  // 起点为 0 / 负数 / 缺失：完整历史副本。
  assert.equal(restoreWindowHistory(messages, absIndexById, 0).length, 4);
  assert.equal(restoreWindowHistory(messages, absIndexById, -1).length, 4);
  assert.equal(restoreWindowHistory(messages, absIndexById, null).length, 4);
  // 起点越界：回退完整历史，避免空上下文。
  assert.equal(restoreWindowHistory(messages, absIndexById, 99).length, 4);
  // 空历史安全。
  assert.deepEqual(restoreWindowHistory([], absIndexById, 3), []);
});

test('rememberWindow 记录长度、字符数与窗口起点', () => {
  const { session, absIndexById } = sessionWith([
    { id: 'm0', role: 'user', content: 'a' },
    { id: 'm1', role: 'assistant', content: 'b' },
    { id: 'm2', role: 'user', content: 'c' }
  ]);
  const { rememberWindow } = createWindowContext({ session, absIndexById });
  rememberWindow(session.messages.slice(1));
  assert.equal(session.historyWindowLength, 2);
  assert.equal(session.historyWindowStartAbs, 1);
  assert.ok(session.historyWindowChars > 0);
});

test('被挤出轮次生成确定性摘要，并按窗口起点缓存复用', () => {
  const messages = [
    { id: 'm0', role: 'user', content: '读取 src/calc.js' },
    {
      id: 'm1',
      role: 'assistant',
      content: '',
      toolCalls: [
        { name: 'read_file', args: { path: 'src/calc.js' }, status: 'completed', result: 'export const a = 1;' },
        { name: 'write_file', args: { path: 'reports/out.md', content: 'hello' }, status: 'completed', result: 'ok' }
      ]
    },
    { id: 'm2', role: 'user', content: '继续' },
    { id: 'm3', role: 'assistant', content: 'done' }
  ];
  const { session, absIndexById } = sessionWith(messages);
  let persists = 0;
  const { evictedSummaryFor } = createWindowContext({
    session,
    absIndexById,
    persist: () => { persists += 1; }
  });

  const first = evictedSummaryFor(messages.slice(2));
  assert.match(first, /结构化事实清单/);
  assert.match(first, /reports\/out\.md/);
  assert.match(first, /读取×|读取/);
  assert.equal(persists, 1);

  // 同一窗口起点：直接复用，不重复生成也不重复落盘。
  const second = evictedSummaryFor(messages.slice(2));
  assert.equal(second, first);
  assert.equal(persists, 1);

  // 窗口起点前进：重建摘要。
  const third = evictedSummaryFor(messages.slice(3));
  assert.equal(persists, 2);
  assert.ok(third.length > 0);
});

test('窗口起点为 0 或已有压缩覆盖时不注入摘要', () => {
  const messages = [
    { id: 'm0', role: 'user', content: 'a' },
    { id: 'm1', role: 'assistant', content: 'b' }
  ];
  const { session, absIndexById } = sessionWith(messages);
  let persists = 0;
  const { evictedSummaryFor } = createWindowContext({
    session,
    absIndexById,
    persist: () => { persists += 1; }
  });
  assert.equal(evictedSummaryFor([]), '');
  assert.equal(evictedSummaryFor(messages), '');
  assert.equal(evictedSummaryFor(messages, { coveredEndIndex: 2 }), '');
  assert.equal(persists, 0);
});
