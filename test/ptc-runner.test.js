import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PtcEngine } from '../src/ptc/engine.js';

function setup(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ptc-run-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'app.js'), 'const answer = 42;\n');
  fs.writeFileSync(path.join(workspace, 'notes.md'), '# Notes\n');
  const logDir = path.join(root, 'logs');
  const engine = new PtcEngine({ logDir, timeoutMs: 5000, ...overrides });
  const ctx = {
    workspace,
    settings: { disabledTools: [], ptcAudit: true },
    session: { id: 'ptc-run-test' },
    runId: 'run-1'
  };
  return {
    root,
    workspace,
    logDir,
    engine,
    ctx,
    async cleanup() {
      await engine.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function findAudit(logDir) {
  const file = fs.readdirSync(logDir).find((name) => name.startsWith('ptc-audit-'));
  return file ? path.join(logDir, file) : '';
}

test('PTC 运行时：类型化返回值、traceId 聚合与审计', async () => {
  const { engine, ctx, logDir, cleanup } = setup();
  try {
    const traceId = 'tr_ptc_audit_test';
    const result = await engine.run(`
      const list = await files.list({ path: '.', depth: 2 });
      const file = await files.read({ path: 'src/app.js' });
      return { paths: list.entries.map((entry) => entry.path), content: file.content };
    `, ctx, { traceId });
    assert.match(result.text, /PTC 执行完成/);
    assert.equal(result.meta.traceId, traceId);
    assert.equal(result.meta.toolCalls, 2);
    const payload = JSON.parse(result.text.slice(result.text.indexOf('{')));
    assert.deepEqual(payload.result.paths.sort(), ['notes.md', 'src', 'src/app.js']);
    assert.match(payload.result.content, /answer = 42/);

    const audit = readJsonl(findAudit(logDir));
    const toolCalls = audit.filter((item) => item.kind === 'tool_call');
    assert.ok(toolCalls.length >= 2);
    assert.ok(toolCalls.every((item) => item.traceId === traceId));
    assert.ok(audit.some((item) => item.kind === 'execution' && item.traceId === traceId && item.ok === true));
  } finally {
    await cleanup();
  }
});

test('PTC 运行时：I-PTC 状态与函数复用，reset 后清空', async () => {
  const { engine, ctx, cleanup } = setup();
  try {
    const first = await engine.run(`
      const base = 40;
      function add(x) { return x + base; }
      state.tag = 'a';
      return base;
    `, ctx);
    assert.match(first.text, /"result": 40/);

    const second = await engine.run(`
      state.tag = state.tag + 'b';
      return { value: add(2), tag: state.tag };
    `, ctx);
    assert.match(second.text, /"value": 42/);
    assert.match(second.text, /"tag": "ab"/);

    // 对象身份与函数闭包在 I-PTC 中保持引用语义
    await engine.run(`
      const counter = { n: 1 };
      function bump() { counter.n += 1; return counter.n; }
      return 1;
    `, ctx);
    const identity = await engine.run('const next = bump(); return { n: counter.n, next };', ctx);
    assert.match(identity.text, /"n": 2/);
    assert.match(identity.text, /"next": 2/);

    const reset = await engine.run('return add(2);', ctx, { reset: true });
    assert.equal(reset.meta.rejected, true);
    assert.match(reset.text, /PTC_UNKNOWN_CALL/);

    const afterReset = await engine.run("return typeof state;", ctx);
    assert.match(afterReset.text, /"result": "object"/);
  } finally {
    await cleanup();
  }
});

test('PTC 运行时：不同任务命名空间互相隔离', async () => {
  const { engine, ctx, cleanup } = setup();
  try {
    await engine.run('const secret = 1; return secret;', ctx);
    const other = { ...ctx, runId: 'run-2' };
    const result = await engine.run('return secret;', other);
    assert.equal(result.meta.rejected, true);
    assert.match(result.text, /PTC_UNKNOWN_IDENTIFIER/);
  } finally {
    await cleanup();
  }
});

test('PTC 运行时：子 Agent scope 隔离状态，disposeRun 清理同一轮所有命名空间', async () => {
  const { engine, ctx, cleanup } = setup();
  try {
    await engine.run('const secret = 1; state.tag = "main"; return secret;', ctx);

    const workerCtx = { ...ctx, ptcScope: 'worker:call_1:t1' };
    const denied = await engine.run('return secret;', workerCtx);
    assert.equal(denied.meta.rejected, true);
    assert.match(denied.text, /PTC_UNKNOWN_IDENTIFIER/);

    const own = await engine.run(`
      const secret = 2;
      state.tag = 'worker';
      return { secret, tag: state.tag };
    `, workerCtx);
    assert.match(own.text, /"secret": 2/);

    const main = await engine.run('return { secret, tag: state.tag };', ctx);
    assert.match(main.text, /"secret": 1/);
    assert.match(main.text, /"tag": "main"/);

    assert.equal(engine.entries.size, 2);
    await engine.disposeScope('worker:call_1:t1');
    assert.equal(engine.entries.size, 1);
    const mainAfter = await engine.run('return secret;', ctx);
    assert.match(mainAfter.text, /"result": 1/);

    await engine.disposeRun('run-1');
    assert.equal(engine.entries.size, 0);
  } finally {
    await cleanup();
  }
});

test('PTC 运行时：onToolError 钩子收到结构化错误', async () => {
  const events = [];
  const { engine, ctx, cleanup } = setup({
    onToolError: (event) => events.push(event)
  });
  try {
    await engine.run('await files.read({ path: "missing.txt" }); return 1;', ctx);
    assert.equal(events.length, 1);
    assert.equal(events[0].tool, 'files.read');
    assert.equal(events[0].code, 'PTC_NOT_FOUND');
    assert.ok(events[0].traceId.startsWith('tr_ptc_'));

    // 用户代码可以捕获结构化错误并继续
    const caught = await engine.run(`
      try {
        await files.read({ path: 'missing.txt' });
      } catch (error) {
        return { code: error.code };
      }
      return {};
    `, ctx);
    assert.match(caught.text, /"code": "PTC_NOT_FOUND"/);
  } finally {
    await cleanup();
  }
});

test('PTC 运行时：默认错误钩子写入 ptc-errors 审计文件', async () => {
  const { engine, ctx, logDir, cleanup } = setup();
  try {
    await engine.run('await files.read({ path: "missing.txt" }); return 1;', ctx);
    const file = fs.readdirSync(logDir).find((name) => name.startsWith('ptc-errors-'));
    assert.ok(file, '应当生成 ptc-errors 日志');
    const lines = readJsonl(path.join(logDir, file));
    assert.ok(lines.some((item) => item.tool === 'files.read' && item.code === 'PTC_NOT_FOUND' && item.traceId.startsWith('tr_ptc_')));
  } finally {
    await cleanup();
  }
});

test('PTC 运行时：超时强制终止沙盒', async () => {
  const { engine, ctx, cleanup } = setup({ timeoutMs: 300 });
  try {
    const started = Date.now();
    const result = await engine.run(`
      let running = true;
      while (running) { state.ticks = (state.ticks || 0) + 1; }
      return 1;
    `, ctx);
    const elapsed = Date.now() - started;
    assert.equal(result.meta.timedOut, true);
    assert.match(result.text, /超时/);
    assert.ok(elapsed < 5000, `超时终止耗时过长：${elapsed}ms`);
  } finally {
    await cleanup();
  }
});

test('PTC 运行时：工具调用预算在循环中生效', async () => {
  const events = [];
  const { engine, ctx, cleanup } = setup({
    timeoutMs: 15000,
    onToolError: (event) => events.push(event)
  });
  try {
    const result = await engine.run(`
      for (let i = 0; i < 35; i += 1) {
        await files.list({ path: '.' });
      }
      return 1;
    `, ctx);
    assert.match(result.text, /PTC_TOOL_BUDGET/);
    assert.ok(events.some((event) => event.code === 'PTC_TOOL_BUDGET'));
  } finally {
    await cleanup();
  }
});

test('PTC 运行时：恰好 30 次工具调用不被预算拒绝', async () => {
  const { engine, ctx, cleanup } = setup({ timeoutMs: 20000 });
  try {
    const result = await engine.run(`
      for (let i = 0; i < 30; i += 1) {
        await files.list({ path: '.' });
      }
      return state.ok;
    `, ctx);
    assert.equal(result.meta.toolCalls, 30);
    assert.ok(!/PTC_TOOL_BUDGET/.test(result.text));
  } finally {
    await cleanup();
  }
});

test('PTC 运行时：沙箱拒绝逃逸并在执行前拦截', async () => {
  const { engine, ctx, cleanup } = setup();
  try {
    const result = await engine.run('return process.version;', ctx);
    assert.equal(result.meta.rejected, true);
    assert.equal(result.meta.layer, 2);
    assert.equal(engine.entries.size, 0);
  } finally {
    await cleanup();
  }
});

test('PTC 运行时：日志采集与输出截断', async () => {
  const { engine, ctx, cleanup } = setup();
  try {
    const logs = await engine.run(`
      log('hello', { a: 1 });
      console.log('world');
      return 1;
    `, ctx);
    assert.match(logs.text, /hello/);
    assert.match(logs.text, /world/);

    const huge = await engine.run(`
      let value = 'x';
      for (let i = 0; i < 15; i += 1) { value += value; }
      return value;
    `, ctx);
    assert.match(huge.text, /PTC 输出已截断/);
    assert.ok(huge.text.length < 26000, `输出长度 ${huge.text.length}`);
  } finally {
    await cleanup();
  }
});
