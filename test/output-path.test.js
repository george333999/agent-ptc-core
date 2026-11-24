import test from 'node:test';
import assert from 'node:assert/strict';
import { outputRelFor, resolveOutputPath } from '../server/output-paths.js';

test('Chat 输出目录与 Agent 输出目录彼此隔离', () => {
  const chat = { mode: 'chat', outputRel: 'outputs/chat' };
  const agent = { mode: 'agent', outputRel: 'outputs' };

  assert.equal(outputRelFor(chat), 'outputs/chat');
  assert.equal(outputRelFor(agent), 'outputs');
  assert.equal(outputRelFor({ mode: 'chat' }), 'outputs/chat');
  assert.equal(outputRelFor({ mode: 'agent' }), 'outputs');

  assert.equal(resolveOutputPath(chat, 'outputs/report.md'), 'outputs/chat/report.md');
  assert.equal(resolveOutputPath(chat, 'outputs\\report.md'), 'outputs/chat/report.md');
  assert.equal(resolveOutputPath(chat, 'outputs/chat/report.md'), 'outputs/chat/report.md');
  assert.equal(resolveOutputPath(chat, 'src/app.js'), 'src/app.js');
  assert.equal(resolveOutputPath(agent, 'outputs/report.md'), 'outputs/report.md');
  assert.equal(resolveOutputPath(chat, ''), '');
});

test('输出路径重定向支持顶层 outputs 与重复调用', () => {
  const chat = { mode: 'chat', outputRel: 'outputs/chat' };
  assert.equal(resolveOutputPath(chat, 'outputs'), 'outputs/chat');
  const once = resolveOutputPath(chat, 'outputs/a.md');
  assert.equal(resolveOutputPath(chat, once), once);
});
