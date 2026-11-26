import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTurnContext, resetTurnContext, resolveTurnContextBudget } from '../server/turn-context.js';
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

test('Legacy mode keeps only the raw message and injects no optimization blocks', () => {
  const session = { messages: [], artifacts: { 'a.md': { path: 'a.md', summary: 'A', chars: 1, fingerprint: 'f' } } };
  const result = buildTurnContext({
    session,
    message: 'continue from the last artifact',
    settings: { contextEngine: false },
    baseModelContent: 'raw message',
    webContext: 'WEB',
    knowledgeContext: 'KB'
  });
  assert.equal(result.modelContent, 'raw message\n\nWEB\n\nKB');
  assert.equal(result.prefetchPlan.mode, 'none');
  assert.equal(result.memoSignature, '');
});

test('Default mode injects explicit-path prefetch and records hit info', () => {
  const workspace = tmpWorkspace({ 'src/a.js': 'export const a = 1;\n' });
  const result = buildTurnContext({
    session: { messages: [] },
    message: 'read src/a.js and explain',
    settings: {},
    workspace,
    baseModelContent: 'raw message'
  });
  assert.equal(result.prefetchPlan.mode, 'targets');
  assert.equal(result.prefetchPlan.items.length, 1);
  assert.equal(result.prefetchPlan.items[0].hit, false);
  assert.match(result.modelContent, /may be incomplete/);
});

test('With no explicit target, injects only the workspace index, without file content', () => {
  const workspace = tmpWorkspace({ 'src/a.js': 'SECRET_CONTENT' });
  const result = buildTurnContext({
    session: { messages: [] },
    message: 'what is in the project',
    settings: {},
    workspace,
    baseModelContent: 'raw message'
  });
  assert.equal(result.prefetchPlan.mode, 'index');
  assert.match(result.modelContent, /Workspace index/);
  assert.ok(!result.modelContent.includes('SECRET_CONTENT'));
});

test('Prefetch cache is reused across turns: the second turn hits when the file is unchanged, without re-reading disk', () => {
  const workspace = tmpWorkspace({ 'src/a.js': 'export const a = 1;\n' });
  const session = { messages: [] };
  const first = buildTurnContext({
    session,
    message: 'read src/a.js and explain',
    settings: {},
    workspace,
    baseModelContent: 'raw message'
  });
  assert.equal(first.prefetchPlan.hits, 0);
  assert.equal(first.prefetchPlan.misses, 1);

  const second = buildTurnContext({
    session,
    message: 'read src/a.js again',
    settings: {},
    workspace,
    baseModelContent: 'raw message',
    messageId: 'u2'
  });
  assert.equal(second.prefetchPlan.hits, 1);
  assert.equal(second.prefetchPlan.misses, 0);
  // Option 1: the same-fingerprint body was already injected in this session; the second turn gives only a one-line reference, not the body again.
  assert.equal(second.prefetchPlan.reused, 1);
  assert.match(second.modelContent, /same-fingerprint body already injected/);
  assert.ok(!second.modelContent.includes('export const a = 1;'));

  // Caches are not shared between different sessions.
  const other = buildTurnContext({
    session: { messages: [] },
    message: 'read src/a.js and explain',
    settings: {},
    workspace,
    baseModelContent: 'raw message'
  });
  assert.equal(other.prefetchPlan.hits, 0);
  assert.equal(other.prefetchPlan.misses, 1);
});

test('Injects the artifact index and cold facts when referencing old artifacts, and not otherwise', () => {
  const session = {
    messages: [
      { role: 'assistant', toolCalls: [{ name: 'write_file', args: { path: 'reports/a.md', content: 'x' }, status: 'completed' }] }
    ],
    artifacts: {
      'reports/a.md': { path: 'reports/a.md', summary: 'report', chars: 1, fingerprint: 'abc', lines: 1 }
    }
  };
  const referenced = buildTurnContext({
    session,
    message: '基于上次的报告继续优化',
    settings: {},
    baseModelContent: 'raw message'
  });
  assert.match(referenced.modelContent, /Artifact index/);
  assert.match(referenced.modelContent, /Confirmed facts/);

  const fresh = buildTurnContext({
    session,
    message: 'write a brand-new page',
    settings: {},
    baseModelContent: 'raw message'
  });
  assert.ok(!fresh.modelContent.includes('Artifact index'));
  assert.ok(!fresh.modelContent.includes('Confirmed facts'));
});

test('Task memo is off by default; the hint appears only for repeated tasks after enabling', () => {
  const message = '优化报告生成速度';
  const signature = taskSignature(message).signature;
  assert.ok(signature);
  const session = {
    messages: [],
    taskMemoEntries: {
      [signature]: { signature, path: 'a.md', fingerprint: 'f', hint: 'last time, change the parser first' }
    }
  };
  const off = buildTurnContext({ session, message, settings: {}, baseModelContent: 'x' });
  assert.ok(!off.modelContent.includes('Similar task hint'));
  assert.equal(off.memoSignature, '');

  // The first time only counts; the second time, after reaching a 50% repeat rate, it is enabled.
  buildTurnContext({ session, message, settings: { taskMemo: true }, baseModelContent: 'x' });
  const second = buildTurnContext({ session, message, settings: { taskMemo: true }, baseModelContent: 'x' });
  assert.equal(second.memoSignature, signature);
  assert.match(second.modelContent, /Similar task hint/);
});

test('The workspace index is deduplicated by signature: referenced only when unchanged, re-injected after changes', () => {
  const workspace = tmpWorkspace({ 'src/a.js': 'A' });
  const session = { messages: [] };
  const first = buildTurnContext({
    session,
    message: 'what is in the project',
    settings: {},
    workspace,
    baseModelContent: 'first question',
    messageId: 'u1'
  });
  assert.match(first.modelContent, /## Workspace index/);
  assert.deepEqual(first.reusedBlocks, []);
  pushTurn(session, first, 'what is in the project', 'u1');

  const second = buildTurnContext({
    session,
    message: 'confirm the project structure again',
    settings: {},
    workspace,
    baseModelContent: 'second question',
    messageId: 'u2'
  });
  assert.deepEqual(second.reusedBlocks, ['workspaceIndex']);
  assert.match(second.modelContent, /In-session context reuse/);
  assert.ok(!second.modelContent.includes('## Workspace index'));
  assert.equal(second.prefetchPlan.index, '');
  pushTurn(session, second, 'confirm the project structure again', 'u2');

  // A newly added file changes the index content → must fully re-inject.
  fs.writeFileSync(path.join(workspace, 'src/b.js'), 'B');
  const third = buildTurnContext({
    session,
    message: 'which files are there now',
    settings: {},
    workspace,
    baseModelContent: 'third question',
    messageId: 'u3'
  });
  assert.deepEqual(third.reusedBlocks, []);
  assert.match(third.modelContent, /## Workspace index/);
  assert.match(third.modelContent, /src\/b\.js/);
});

test('Both resetTurnContext and window trim invalidate reuse, avoiding references to content that has disappeared', () => {
  const workspace = tmpWorkspace({ 'src/a.js': 'A' });
  const session = { id: 's-reset', messages: [] };
  const first = buildTurnContext({
    session,
    message: 'project structure',
    settings: {},
    workspace,
    baseModelContent: 'q1',
    messageId: 'u1'
  });
  pushTurn(session, first, 'project structure', 'u1');

  resetTurnContext(session);
  const afterReset = buildTurnContext({
    session,
    message: 'project structure',
    settings: {},
    workspace,
    baseModelContent: 'q2',
    messageId: 'u2'
  });
  assert.deepEqual(afterReset.reusedBlocks, []);
  assert.match(afterReset.modelContent, /## Workspace index/);
  pushTurn(session, afterReset, 'project structure', 'u2');

  // Directly simulate "the anchor message has been trimmed out of the window".
  session.historyWindowStartAbs = session.messages.length;
  const afterTrim = buildTurnContext({
    session,
    message: 'project structure',
    settings: {},
    workspace,
    baseModelContent: 'q3',
    messageId: 'u3'
  });
  assert.deepEqual(afterTrim.reusedBlocks, []);
  assert.match(afterTrim.modelContent, /## Workspace index/);
});

test('The artifact index and cold facts are injected only once; the second turn switches to a one-line reference while keeping the restore capability', () => {
  const session = {
    messages: [
      {
        id: 'a1',
        role: 'assistant',
        toolCalls: [{ name: 'write_file', args: { path: 'reports/a.md', content: 'x' }, status: 'completed' }]
      }
    ],
    artifacts: {
      'reports/a.md': { path: 'reports/a.md', summary: 'report', chars: 1, fingerprint: 'abc', lines: 1 }
    }
  };
  const first = buildTurnContext({
    session,
    message: '基于上次的报告继续优化',
    settings: {},
    baseModelContent: 'q1',
    messageId: 'u1'
  });
  assert.match(first.modelContent, /## Artifact index for this session/);
  assert.match(first.modelContent, /## Confirmed facts/);
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
  assert.ok(!second.modelContent.includes('## Artifact index for this session'));
  assert.ok(!second.modelContent.includes('## Confirmed facts'));
  // The full body of the reused block is returned with the result, so it can be restored on window trim.
  assert.match(second.mergeOnTrim, /## Artifact index for this session/);
  assert.match(second.mergeOnTrim, /## Confirmed facts/);
});

test('The first turn or empty context produces no reuse reference block', () => {
  const session = { messages: [] };
  const result = buildTurnContext({
    session,
    message: 'write a brand-new page',
    settings: {},
    baseModelContent: 'q1',
    messageId: 'u1'
  });
  assert.deepEqual(result.reusedBlocks, []);
  assert.ok(!result.modelContent.includes('In-session context reuse'));
  assert.equal(result.mergeOnTrim, '');
});

test('Short-session degradation: compress index/fact budgets for the first 3 turns, then restore full budgets', () => {
  const short = resolveTurnContextBudget({
    session: { messages: [{ role: 'user' }, { role: 'assistant' }] },
    settings: {}
  });
  assert.equal(short.shortSession, true);
  assert.equal(short.maxPrefetchChars, 4000);
  assert.equal(short.indexMaxEntries, 120);
  assert.equal(short.factMaxTokens, 400);
  assert.equal(short.artifactMaxTokens, 400);

  const full = resolveTurnContextBudget({
    session: {
      messages: [
        { role: 'user' }, { role: 'assistant' },
        { role: 'user' }, { role: 'assistant' },
        { role: 'user' }
      ]
    },
    settings: {}
  });
  assert.equal(full.shortSession, false);
  assert.equal(full.maxPrefetchChars, 8000);
  assert.equal(full.indexMaxEntries, 240);
  assert.equal(full.factMaxTokens, 1000);

  // A smaller budget passed explicitly is not inflated.
  const explicit = resolveTurnContextBudget({
    session: { messages: [] },
    settings: {},
    maxPrefetchChars: 1200
  });
  assert.equal(explicit.maxPrefetchChars, 1200);
});

test('Short-session prefetch stays within 4000 chars; a regular session can reach 8000', () => {
  const files = {};
  for (let index = 1; index <= 5; index += 1) {
    files[`src/file-${index}.js`] = `export const value${index} = "${'x'.repeat(1400)}";\n`;
  }
  const workspace = tmpWorkspace(files);
  const paths = Object.keys(files).join(' ');
  const shortResult = buildTurnContext({
    session: { messages: [{ role: 'user' }] },
    message: `read ${paths} separately and summarize`,
    settings: {},
    workspace,
    baseModelContent: 'short session'
  });
  assert.ok(shortResult.prefetchPlan.chars <= 4000, `short-session prefetch ${shortResult.prefetchPlan.chars} chars`);

  const longResult = buildTurnContext({
    session: {
      messages: [
        { role: 'user' }, { role: 'assistant' },
        { role: 'user' }, { role: 'assistant' },
        { role: 'user' }
      ]
    },
    message: `read ${paths} separately and summarize`,
    settings: {},
    workspace,
    baseModelContent: 'regular session'
  });
  assert.ok(longResult.prefetchPlan.chars > 4000, `regular-session prefetch ${longResult.prefetchPlan.chars} chars`);
});
