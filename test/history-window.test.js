import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HISTORY_LIMITS,
  applyHistoryWindow,
  historyChars,
  historyLimitsForContext,
  overHistoryLimits,
  resolveHistoryLimits,
  resolveLaggingWindow,
  shouldTrimHistory
} from '../server/history-window.js';

const SMALL = { softMessages: 3, hardMessages: 5, softChars: 100000, hardChars: 200000 };

function message(role, index, size = 1) {
  return { role, content: `${role}-${index}-${'x'.repeat(size)}` };
}

test('未超过硬上限时原样返回副本，不修改输入', () => {
  const input = [message('user', 0), message('assistant', 1), message('user', 2)];
  const result = applyHistoryWindow(input, SMALL);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
});

test('正好等于硬上限时不裁剪，超过一条才开始裁剪', () => {
  const exact = [message('user', 0), message('assistant', 1), message('user', 2), message('assistant', 3), message('user', 4)];
  assert.equal(overHistoryLimits(exact, SMALL), false);
  assert.equal(applyHistoryWindow(exact, SMALL).length, 5);

  const over = [...exact, message('assistant', 5)];
  assert.equal(overHistoryLimits(over, SMALL), true);
  const window = applyHistoryWindow(over, SMALL);
  assert.ok(window.length >= SMALL.softMessages);
  assert.ok(window.length < over.length);
  assert.equal(window[0].role, 'user');
  assert.deepEqual(window[window.length - 1], over[over.length - 1]);
});

test('边界值：空历史与单条历史安全', () => {
  assert.deepEqual(applyHistoryWindow([], SMALL), []);
  assert.deepEqual(applyHistoryWindow([message('user', 0)], SMALL), [message('user', 0)]);
  const tight = { softMessages: 1, hardMessages: 1, softChars: 1, hardChars: 1 };
  const single = [message('user', 0)];
  assert.deepEqual(applyHistoryWindow(single, tight), single);
});

test('没有 user 消息时按软上限裁剪', () => {
  const input = Array.from({ length: 6 }, (_, index) => message('assistant', index));
  const window = applyHistoryWindow(input, SMALL);
  assert.equal(window.length, SMALL.softMessages);
});

test('字符数超限时继续裁剪到软上限附近', () => {
  const limits = { softMessages: 10, hardMessages: 10, softChars: 250, hardChars: 300 };
  const input = Array.from({ length: 6 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', index, 100));
  assert.equal(overHistoryLimits(input, limits), true);
  const window = applyHistoryWindow(input, limits);
  assert.ok(window.length < input.length);
  assert.equal(window[0].role, 'user');
  // 按整轮裁剪，最小保留一轮（user + assistant）。
  assert.equal(window.length, 2);
  assert.ok(historyChars(window) < historyChars(input));
});

test('尾部没有 user 消息时窗口仍然有界', () => {
  const limits = { softMessages: 4, hardMessages: 6, softChars: 1000000, hardChars: 2000000 };
  const input = [
    message('user', 0),
    ...Array.from({ length: 19 }, (_, index) => message('assistant', index + 1))
  ];
  const window = applyHistoryWindow(input, limits);
  assert.ok(window.length <= limits.hardMessages);
  assert.equal(window.length, limits.softMessages);
});

test('滞后裁剪：两次裁剪之间至少间隔 hard - soft 条消息', () => {
  const limits = { softMessages: 48, hardMessages: 64, softChars: 1000000, hardChars: 2000000 };
  const window65 = Array.from({ length: 65 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', index));
  assert.equal(shouldTrimHistory(window65, 0, limits), true);
  assert.equal(shouldTrimHistory(window65, 50, limits), false);
  assert.equal(shouldTrimHistory(window65, 49, limits), true);
  assert.equal(shouldTrimHistory(window65.slice(0, 60), 0, limits), false);
  assert.equal(shouldTrimHistory(window65.slice(0, 60), 0, limits), false);
});

test('字符超限同样受滞后间隔约束', () => {
  const limits = { softMessages: 4, hardMessages: 6, softChars: 100, hardChars: 200 };
  const heavy = Array.from({ length: 6 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', index, 100));
  assert.equal(shouldTrimHistory(heavy, 0, limits), true);
  assert.equal(shouldTrimHistory(heavy, 5, limits), false);
});

test('v4 默认窗口按字符收敛到 60k / 150k', () => {
  assert.equal(DEFAULT_HISTORY_LIMITS.softChars, 60000);
  assert.equal(DEFAULT_HISTORY_LIMITS.hardChars, 150000);
  assert.ok(DEFAULT_HISTORY_LIMITS.hardChars > DEFAULT_HISTORY_LIMITS.softChars);
});

test('字符超限且提供 lastTrimChars 时按字符间隔滞后裁剪', () => {
  const limits = { softMessages: 48, hardMessages: 64, softChars: 100, hardChars: 200 };
  const heavy = Array.from({ length: 6 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', index, 100));
  const chars = historyChars(heavy);

  // 第一次：没有任何字符基准 → 允许裁剪。
  assert.equal(shouldTrimHistory(heavy, 0, limits, { lastTrimChars: 0 }), true);
  // 距离上次裁剪字符增量不足 hard - soft（100）→ 不裁剪，即使消息条数略增。
  assert.equal(shouldTrimHistory(heavy, 5, limits, { lastTrimChars: chars - 60 }), false);
  // 字符增量达到间隔 → 裁剪。
  assert.equal(shouldTrimHistory(heavy, 5, limits, { lastTrimChars: chars - 150 }), true);
});

test('边界值：字符数正好等于硬上限时不裁剪', () => {
  const single = [{ role: 'user', content: 'x' }];
  const chars = historyChars(single);
  const limits = { softMessages: 4, hardMessages: 6, softChars: Math.max(1, chars - 1), hardChars: chars };
  assert.equal(overHistoryLimits(single, limits), false);
  assert.equal(shouldTrimHistory(single, 0, limits, { lastTrimChars: 0 }), false);
});

test('软上限大于硬上限时自动纠正', () => {
  const limits = resolveHistoryLimits({ softMessages: 10, hardMessages: 5, softChars: 500, hardChars: 100 });
  assert.equal(limits.hardMessages, 10);
  assert.equal(limits.hardChars, 500);
});

test('跨轮滞后窗口：未到间隔不裁剪，保留上一轮末尾前缀', () => {
  const limits = { softMessages: 48, hardMessages: 64, softChars: 1000000, hardChars: 2000000 };
  const history = Array.from({ length: 70 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', index));

  // 上一轮最后一次裁剪长度为 60：刚过 1 条消息时不裁剪，保证新轮首个请求是上一轮前缀。
  const noTrim = resolveLaggingWindow(history.slice(0, 61), 60, limits);
  assert.equal(noTrim.trimmed, false);
  assert.equal(noTrim.window.length, 61);

  // 达到 hard - soft 间隔后裁剪。
  const trimmed = resolveLaggingWindow(history, 48, limits);
  assert.equal(trimmed.trimmed, true);
  assert.ok(trimmed.window.length <= limits.softMessages + 1);
  assert.equal(trimmed.windowLength, trimmed.window.length);

  // 空历史与缺失基准安全。
  assert.deepEqual(resolveLaggingWindow([], 0, limits), { window: [], trimmed: false, windowLength: 0 });
  assert.equal(resolveLaggingWindow(history.slice(0, 10), 0, limits).trimmed, false);
});

test('按模型上下文推导历史上限：裁剪推迟到窗口 97%，常规会话保持 append-only', () => {
  const limits = historyLimitsForContext(128000);
  assert.equal(limits.hardChars, 310400);
  assert.equal(limits.softChars, 155200);
  assert.ok(limits.hardMessages >= 600);
  // 60k 字符的旧默认窗口在 128k 上下文下不再触发裁剪。
  const history = Array.from({ length: 80 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', index, 800));
  assert.ok(historyChars(history) > 60000);
  assert.equal(shouldTrimHistory(history, 0, limits, { lastTrimChars: 0 }), false);

  // 更小的上下文窗口仍有 150k 字符下限，避免小模型被过早裁剪。
  const small = historyLimitsForContext(8000);
  assert.equal(small.hardChars, 150000);
  assert.ok(small.softChars < small.hardChars);
});
