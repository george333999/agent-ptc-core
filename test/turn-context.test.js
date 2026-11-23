import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTurnContext } from '../server/turn-context.js';
import { taskSignature } from '../server/task-memo.js';

function tmpWorkspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-context-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return root;
}

test('传统模式只保留原始消息，不注入任何优化块', () => {
  const session = { messages: [], artifacts: { 'a.md': { path: 'a.md', summary: 'A', chars: 1, fingerprint: 'f' } } };
  const result = buildTurnContext({
    session,
    message: '基于上次的产出继续',
    settings: { contextEngine: false },
    baseModelContent: '原始消息',
    webContext: 'WEB',
    knowledgeContext: 'KB'
  });
  assert.equal(result.modelContent, '原始消息\n\nWEB\n\nKB');
  assert.equal(result.prefetchPlan.mode, 'none');
  assert.equal(result.memoSignature, '');
});

test('默认模式注入明确路径预取，并记录命中信息', () => {
  const workspace = tmpWorkspace({ 'src/a.js': 'export const a = 1;\n' });
  const result = buildTurnContext({
    session: { messages: [] },
    message: '读取 src/a.js 并解释',
    settings: {},
    workspace,
    baseModelContent: '原始消息'
  });
  assert.equal(result.prefetchPlan.mode, 'targets');
  assert.equal(result.prefetchPlan.items.length, 1);
  assert.equal(result.prefetchPlan.items[0].hit, false);
  assert.match(result.modelContent, /片段可能不完整/);
});

test('无明确目标时只注入工作区索引，不包含文件内容', () => {
  const workspace = tmpWorkspace({ 'src/a.js': 'SECRET_CONTENT' });
  const result = buildTurnContext({
    session: { messages: [] },
    message: '项目里有什么',
    settings: {},
    workspace,
    baseModelContent: '原始消息'
  });
  assert.equal(result.prefetchPlan.mode, 'index');
  assert.match(result.modelContent, /工作区索引/);
  assert.ok(!result.modelContent.includes('SECRET_CONTENT'));
});

test('预取缓存跨轮复用：文件未变时第二轮命中，不重复读盘', () => {
  const workspace = tmpWorkspace({ 'src/a.js': 'export const a = 1;\n' });
  const session = { messages: [] };
  const first = buildTurnContext({
    session,
    message: '读取 src/a.js 并解释',
    settings: {},
    workspace,
    baseModelContent: '原始消息'
  });
  assert.equal(first.prefetchPlan.hits, 0);
  assert.equal(first.prefetchPlan.misses, 1);

  const second = buildTurnContext({
    session,
    message: '再次读取 src/a.js',
    settings: {},
    workspace,
    baseModelContent: '原始消息'
  });
  assert.equal(second.prefetchPlan.hits, 1);
  assert.equal(second.prefetchPlan.misses, 0);
  assert.match(second.modelContent, /export const a = 1;/);

  // 不同会话之间不共享缓存。
  const other = buildTurnContext({
    session: { messages: [] },
    message: '读取 src/a.js 并解释',
    settings: {},
    workspace,
    baseModelContent: '原始消息'
  });
  assert.equal(other.prefetchPlan.hits, 0);
  assert.equal(other.prefetchPlan.misses, 1);
});

test('引用旧产出时注入产出索引与冷事实，未引用时不注入', () => {
  const session = {
    messages: [
      { role: 'assistant', toolCalls: [{ name: 'write_file', args: { path: 'reports/a.md', content: 'x' }, status: 'completed' }] }
    ],
    artifacts: {
      'reports/a.md': { path: 'reports/a.md', summary: '报告', chars: 1, fingerprint: 'abc', lines: 1 }
    }
  };
  const referenced = buildTurnContext({
    session,
    message: '基于上次的报告继续优化',
    settings: {},
    baseModelContent: '原始消息'
  });
  assert.match(referenced.modelContent, /产出索引/);
  assert.match(referenced.modelContent, /已确认事实/);

  const fresh = buildTurnContext({
    session,
    message: '写一个全新的页面',
    settings: {},
    baseModelContent: '原始消息'
  });
  assert.ok(!fresh.modelContent.includes('产出索引'));
  assert.ok(!fresh.modelContent.includes('已确认事实'));
});

test('任务备忘默认关闭，开启后重复任务才出现提示', () => {
  const message = '优化报告生成速度';
  const signature = taskSignature(message).signature;
  assert.ok(signature);
  const session = {
    messages: [],
    taskMemoEntries: {
      [signature]: { signature, path: 'a.md', fingerprint: 'f', hint: '上次先改解析器' }
    }
  };
  const off = buildTurnContext({ session, message, settings: {}, baseModelContent: 'x' });
  assert.ok(!off.modelContent.includes('同类任务提示'));
  assert.equal(off.memoSignature, '');

  // 第一次只计数；第二次达到 50% 重复率后启用。
  buildTurnContext({ session, message, settings: { taskMemo: true }, baseModelContent: 'x' });
  const second = buildTurnContext({ session, message, settings: { taskMemo: true }, baseModelContent: 'x' });
  assert.equal(second.memoSignature, signature);
  assert.match(second.modelContent, /同类任务提示/);
});
