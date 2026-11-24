import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTurnContext, resetTurnContext } from '../server/turn-context.js';
import { taskSignature } from '../server/task-memo.js';

function pushTurn(session, result, message, id) {
  session.messages.push({ id, role: 'user', content: message, modelContent: result.modelContent });
}

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
    baseModelContent: '原始消息',
    messageId: 'u2'
  });
  assert.equal(second.prefetchPlan.hits, 1);
  assert.equal(second.prefetchPlan.misses, 0);
  // 方案 1：同一会话已注入同指纹正文，第二轮只给一行引用，不重复注入正文。
  assert.equal(second.prefetchPlan.reused, 1);
  assert.match(second.modelContent, /已注入同指纹正文/);
  assert.ok(!second.modelContent.includes('export const a = 1;'));

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

test('工作区索引按签名去重：未变化只引用，变化后重新注入', () => {
  const workspace = tmpWorkspace({ 'src/a.js': 'A' });
  const session = { messages: [] };
  const first = buildTurnContext({
    session,
    message: '项目里有什么',
    settings: {},
    workspace,
    baseModelContent: '第一问',
    messageId: 'u1'
  });
  assert.match(first.modelContent, /## 工作区索引/);
  assert.deepEqual(first.reusedBlocks, []);
  pushTurn(session, first, '项目里有什么', 'u1');

  const second = buildTurnContext({
    session,
    message: '再确认一次项目结构',
    settings: {},
    workspace,
    baseModelContent: '第二问',
    messageId: 'u2'
  });
  assert.deepEqual(second.reusedBlocks, ['workspaceIndex']);
  assert.match(second.modelContent, /会话内上下文复用/);
  assert.ok(!second.modelContent.includes('## 工作区索引'));
  assert.equal(second.prefetchPlan.index, '');
  pushTurn(session, second, '再确认一次项目结构', 'u2');

  // 新增文件导致索引内容变化 → 必须完整重新注入。
  fs.writeFileSync(path.join(workspace, 'src/b.js'), 'B');
  const third = buildTurnContext({
    session,
    message: '现在有哪些文件',
    settings: {},
    workspace,
    baseModelContent: '第三问',
    messageId: 'u3'
  });
  assert.deepEqual(third.reusedBlocks, []);
  assert.match(third.modelContent, /## 工作区索引/);
  assert.match(third.modelContent, /src\/b\.js/);
});

test('resetTurnContext 与窗口裁剪都会让复用失效，避免引用已消失的内容', () => {
  const workspace = tmpWorkspace({ 'src/a.js': 'A' });
  const session = { id: 's-reset', messages: [] };
  const first = buildTurnContext({
    session,
    message: '项目结构',
    settings: {},
    workspace,
    baseModelContent: 'q1',
    messageId: 'u1'
  });
  pushTurn(session, first, '项目结构', 'u1');

  resetTurnContext(session);
  const afterReset = buildTurnContext({
    session,
    message: '项目结构',
    settings: {},
    workspace,
    baseModelContent: 'q2',
    messageId: 'u2'
  });
  assert.deepEqual(afterReset.reusedBlocks, []);
  assert.match(afterReset.modelContent, /## 工作区索引/);
  pushTurn(session, afterReset, '项目结构', 'u2');

  // 直接模拟“锚点消息已被裁出窗口”。
  session.historyWindowStartAbs = session.messages.length;
  const afterTrim = buildTurnContext({
    session,
    message: '项目结构',
    settings: {},
    workspace,
    baseModelContent: 'q3',
    messageId: 'u3'
  });
  assert.deepEqual(afterTrim.reusedBlocks, []);
  assert.match(afterTrim.modelContent, /## 工作区索引/);
});

test('产出索引与冷事实只注入一次，第二轮改为一行引用并保留补回能力', () => {
  const session = {
    messages: [
      {
        id: 'a1',
        role: 'assistant',
        toolCalls: [{ name: 'write_file', args: { path: 'reports/a.md', content: 'x' }, status: 'completed' }]
      }
    ],
    artifacts: {
      'reports/a.md': { path: 'reports/a.md', summary: '报告', chars: 1, fingerprint: 'abc', lines: 1 }
    }
  };
  const first = buildTurnContext({
    session,
    message: '基于上次的报告继续优化',
    settings: {},
    baseModelContent: 'q1',
    messageId: 'u1'
  });
  assert.match(first.modelContent, /## 本会话产出索引/);
  assert.match(first.modelContent, /## 已确认事实/);
  assert.equal(first.mergeOnTrim, '');
  pushTurn(session, first, '基于上次的报告继续优化', 'u1');

  const second = buildTurnContext({
    session,
    message: '基于上次的报告继续优化',
    settings: {},
    baseModelContent: 'q2',
    messageId: 'u2'
  });
  assert.deepEqual(second.reusedBlocks.sort(), ['artifact', 'coldFact']);
  assert.ok(!second.modelContent.includes('## 本会话产出索引'));
  assert.ok(!second.modelContent.includes('## 已确认事实'));
  // 被复用块的完整正文随结果返回，窗口裁剪时可以补回。
  assert.match(second.mergeOnTrim, /## 本会话产出索引/);
  assert.match(second.mergeOnTrim, /## 已确认事实/);
});

test('首轮或空上下文不会产生复用引用块', () => {
  const session = { messages: [] };
  const result = buildTurnContext({
    session,
    message: '写一个全新的页面',
    settings: {},
    baseModelContent: 'q1',
    messageId: 'u1'
  });
  assert.deepEqual(result.reusedBlocks, []);
  assert.ok(!result.modelContent.includes('会话内上下文复用'));
  assert.equal(result.mergeOnTrim, '');
});
