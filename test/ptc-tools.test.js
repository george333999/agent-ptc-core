import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executePtcTool, normalizePtcArgs } from '../src/ptc/tools.js';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ptc-tools-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const TODO = 1;\nconst answer = 42;\n');
  fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\nline two\n');
  fs.writeFileSync(path.join(root, 'image.png'), Buffer.from([0, 1, 2, 3]));
  const ctx = {
    workspace: root,
    settings: { disabledTools: [] },
    knowledge: {
      async search(query, options) {
        return [{
          docName: 'manual.pdf',
          location: '第 2 页',
          text: `关于 ${query} 的说明`,
          score: 0.812,
          mode: 'hybrid',
          collection: 'docs',
          sourcePath: 'docs/manual.pdf',
          shared: true,
          topK: options.topK
        }];
      }
    },
    skills: {
      read(name) {
        return name === 'demo' ? { name: 'demo', content: '# Demo', files: ['a.md'] } : null;
      }
    }
  };
  return {
    root,
    ctx,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}：${error.message}`);
    return true;
  });
}

test('PTC 工具：list/read/search 返回规范 JSON', async () => {
  const { root, ctx, cleanup } = setup();
  try {
    const listing = await executePtcTool('files.list', { path: '.', depth: 2 }, ctx);
    assert.equal(listing.path, '.');
    assert.ok(Array.isArray(listing.entries));
    assert.ok(listing.entries.some((entry) => entry.path === 'src/app.js' && entry.type === 'file' && entry.size > 0));

    const file = await executePtcTool('files.read', { path: 'notes.md', startLine: 2, endLine: 2 }, ctx);
    assert.equal(file.path, 'notes.md');
    assert.equal(file.totalLines, 3);
    assert.equal(file.startLine, 2);
    assert.equal(file.content, 'line two');

    const content = await executePtcTool('files.search', { query: 'TODO' }, ctx);
    assert.equal(content.target, 'content');
    assert.equal(content.count, 1);
    assert.deepEqual(content.matches[0], { path: 'src/app.js', line: 1, text: 'const TODO = 1;' });

    const filename = await executePtcTool('files.search', { query: 'app.js', target: 'filename' }, ctx);
    assert.equal(filename.matches[0].path, 'src/app.js');
    assert.equal(filename.matches[0].line, 0);

    const glob = await executePtcTool('files.search', { query: 'answer', glob: '*.js' }, ctx);
    assert.equal(glob.count, 1);
    assert.equal(glob.matches[0].path, 'src/app.js');
  } finally {
    cleanup();
  }
});

test('PTC 工具：参数校验、路径隔离与禁用工具', async () => {
  const { ctx, cleanup } = setup();
  try {
    await rejects(executePtcTool('files.read', { path: '../outside.txt' }, ctx), 'PTC_PATH_ESCAPE');
    await rejects(executePtcTool('files.list', { bogus: 1 }, ctx), 'PTC_UNKNOWN_ARG');
    await rejects(executePtcTool('files.list', { depth: 'two' }, ctx), 'PTC_ARG_TYPE');
    await rejects(executePtcTool('files.search', { query: '' }, ctx), 'PTC_ARG_TYPE');
    await rejects(executePtcTool('files.nope', {}, ctx), 'PTC_UNKNOWN_TOOL');
    await rejects(executePtcTool('files.read', { path: 'image.png' }, ctx), 'PTC_BINARY_FILE');
    await rejects(
      executePtcTool('files.list', { path: '.' }, { ...ctx, settings: { disabledTools: ['list_files'] } }),
      'PTC_TOOL_DISABLED'
    );
    assert.deepEqual(normalizePtcArgs('files.list', { depth: 99 }), { depth: 5 });
  } finally {
    cleanup();
  }
});

test('PTC 工具：知识库与技能使用类型化 mock', async () => {
  const { ctx, cleanup } = setup();
  try {
    const knowledge = await executePtcTool('knowledge.search', { query: '部署', topK: 3 }, ctx);
    assert.equal(knowledge.count, 1);
    assert.equal(knowledge.results[0].docName, 'manual.pdf');
    assert.equal(knowledge.results[0].shared, true);
    assert.equal(knowledge.results[0].score, 0.812);

    const skill = await executePtcTool('skills.read', { name: 'demo' }, ctx);
    assert.equal(skill.name, 'demo');
    assert.equal(skill.content, '# Demo');
    assert.deepEqual(skill.files, ['a.md']);

    await rejects(executePtcTool('skills.read', { name: 'missing' }, ctx), 'PTC_NOT_FOUND');
    await rejects(
      executePtcTool('knowledge.search', { query: 'x' }, { ...ctx, knowledge: null }),
      'PTC_UNAVAILABLE'
    );
  } finally {
    cleanup();
  }
});
