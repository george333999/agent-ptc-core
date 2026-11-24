import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_CONCURRENT_TOOLS,
  classifyToolCall,
  createToolScheduler,
  toolConcurrencyEnabled
} from '../server/tool-scheduler.js';

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tool-scheduler-'));
}

function call(id, name, args = {}) {
  return { id, name, arguments: JSON.stringify(args) };
}

function ctxFor(workspace, mode = 'agent') {
  return { workspace, mode, outputRel: mode === 'chat' ? 'outputs/chat' : 'outputs' };
}

// 复刻 agent.js 主循环：并发调用直接 await，屏障调用先 drain 再串行执行。
async function runLoop(calls, scheduler, execute) {
  const results = [];
  for (const item of calls) {
    const early = scheduler.claim(item.id);
    if (early) {
      results.push(await early);
      continue;
    }
    await scheduler.drain(item.id);
    const args = item.arguments ? JSON.parse(item.arguments) : {};
    try {
      results.push({ call: item, ok: true, value: await execute(item, args) });
    } catch (error) {
      results.push({ call: item, ok: false, error });
    }
  }
  return results;
}

test('同脚本多版本写入走屏障，避免预执行绕过版本守卫', () => {
  const workspace = makeWorkspace();
  const ctx = ctxFor(workspace);
  assert.equal(classifyToolCall('write_file', { path: 'scripts/gen_v43.py' }, ctx).kind, 'barrier');
  assert.equal(classifyToolCall('write_file', { path: 'gen-v2.js' }, ctx).kind, 'barrier');
  assert.equal(classifyToolCall('write_file', { path: 'scripts/gen.py' }, ctx).kind, 'write');
  assert.equal(classifyToolCall('write_file', { path: 'outputs/report_v2.xlsx' }, ctx).kind, 'write');
});

test('无冲突的写操作可以并发执行', async () => {
  const workspace = makeWorkspace();
  let active = 0;
  let maxActive = 0;
  const executed = [];
  const execute = async (item, args) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    fs.writeFileSync(path.join(workspace, args.path), args.content);
    executed.push(args.path);
    active -= 1;
    return args.path;
  };
  const calls = [
    call('a', 'write_file', { path: 'a.md', content: 'A' }),
    call('b', 'write_file', { path: 'b.md', content: 'B' })
  ];
  const scheduler = createToolScheduler({ calls, ctx: ctxFor(workspace), execute });
  const startedAt = Date.now();
  const results = await runLoop(calls, scheduler, execute);
  assert.equal(results.every((item) => item.ok), true);
  assert.ok(maxActive >= 2, `应至少 2 个写并发，实际 ${maxActive}`);
  assert.ok(Date.now() - startedAt < 120, '两个写应重叠而不是各等 40ms');
  assert.deepEqual(executed.sort(), ['a.md', 'b.md']);
  assert.equal(fs.readFileSync(path.join(workspace, 'a.md'), 'utf8'), 'A');
  assert.equal(fs.readFileSync(path.join(workspace, 'b.md'), 'utf8'), 'B');
});

test('同一文件的多次写入按原顺序串行', async () => {
  const workspace = makeWorkspace();
  let active = 0;
  let maxActive = 0;
  const log = [];
  let content = '';
  const execute = async (item, args) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (item.name === 'edit_file') content = content.replace(args.old_string, args.new_string);
    else content += args.content;
    log.push(content);
    fs.writeFileSync(path.join(workspace, 'same.md'), content);
    active -= 1;
    return content;
  };
  const calls = [
    call('w1', 'write_file', { path: 'same.md', content: '1' }),
    call('w2', 'write_file', { path: 'same.md', content: '2' }),
    call('w3', 'edit_file', { path: 'same.md', old_string: '1', new_string: '3' })
  ];
  const scheduler = createToolScheduler({ calls, ctx: ctxFor(workspace), execute });
  await runLoop(calls, scheduler, execute);
  assert.equal(maxActive, 1);
  assert.deepEqual(log, ['1', '12', '32']);
  assert.equal(fs.readFileSync(path.join(workspace, 'same.md'), 'utf8'), '32');
});

test('写后读同一文件必须等待写入完成并读到新内容', async () => {
  const workspace = makeWorkspace();
  const events = [];
  const execute = async (item, args) => {
    if (item.name === 'write_file') {
      events.push('write:start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      fs.writeFileSync(path.join(workspace, args.path), args.content);
      events.push('write:end');
      return 'written';
    }
    events.push('read:start');
    return fs.readFileSync(path.join(workspace, args.path), 'utf8');
  };
  const calls = [
    call('w', 'write_file', { path: 'x.md', content: 'fresh' }),
    call('r', 'read_file', { path: 'x.md' })
  ];
  const scheduler = createToolScheduler({ calls, ctx: ctxFor(workspace), execute });
  const results = await runLoop(calls, scheduler, execute);
  assert.deepEqual(events, ['write:start', 'write:end', 'read:start']);
  assert.equal(results[1].value, 'fresh');
});

test('不同文件的读与写可以并发', async () => {
  const workspace = makeWorkspace();
  let active = 0;
  let maxActive = 0;
  const execute = async (item, args) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    return item.name === 'read_file' ? 'content' : 'written';
  };
  const calls = [
    call('r', 'read_file', { path: 'a.md' }),
    call('w', 'write_file', { path: 'b.md', content: 'B' })
  ];
  const scheduler = createToolScheduler({ calls, ctx: ctxFor(workspace), execute });
  await runLoop(calls, scheduler, execute);
  assert.ok(maxActive >= 2, `读与写应并发，实际 ${maxActive}`);
});

test('命令是屏障：之前的写完成才执行，之后的读不提前启动', async () => {
  const workspace = makeWorkspace();
  const events = [];
  const execute = async (item, args) => {
    events.push(`${item.name}:start`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push(`${item.name}:end`);
    return 'ok';
  };
  const calls = [
    call('w', 'write_file', { path: 'a.js', content: 'x' }),
    call('c', 'run_command', { command: 'npm test' }),
    call('r', 'read_file', { path: 'a.js' })
  ];
  const scheduler = createToolScheduler({ calls, ctx: ctxFor(workspace), execute });
  await runLoop(calls, scheduler, execute);
  assert.deepEqual(events, [
    'write_file:start',
    'write_file:end',
    'run_command:start',
    'run_command:end',
    'read_file:start',
    'read_file:end'
  ]);
});

test('需要审批的写调用不进入并发预执行', async () => {
  const workspace = makeWorkspace();
  let executed = 0;
  const execute = async () => {
    executed += 1;
    return 'ok';
  };
  const calls = [
    call('w', 'write_file', { path: 'a.md', content: 'A' }),
    call('r', 'read_file', { path: 'a.md' })
  ];
  const scheduler = createToolScheduler({
    calls,
    ctx: ctxFor(workspace),
    execute,
    isBlocked: (item) => item.name === 'write_file'
  });
  const results = await runLoop(calls, scheduler, execute);
  assert.equal(scheduler.entryCount(), 1);
  assert.equal(results[0].ok, true);
  assert.equal(executed, 2);
});

test('单个调用失败不影响同段其他调用，结果保持输入顺序', async () => {
  const workspace = makeWorkspace();
  const execute = async (item) => {
    if (item.id === 'b') throw new Error('boom');
    return `ok-${item.id}`;
  };
  const calls = [
    call('a', 'write_file', { path: 'a.md', content: 'A' }),
    call('b', 'write_file', { path: 'b.md', content: 'B' }),
    call('c', 'write_file', { path: 'c.md', content: 'C' })
  ];
  const scheduler = createToolScheduler({ calls, ctx: ctxFor(workspace), execute });
  const results = await runLoop(calls, scheduler, execute);
  assert.deepEqual(results.map((item) => item.call.id), ['a', 'b', 'c']);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error.message, /boom/);
  assert.equal(results[2].ok, true);
});

test('并发上限生效', async () => {
  const workspace = makeWorkspace();
  let active = 0;
  let maxActive = 0;
  const execute = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    return 'ok';
  };
  const calls = Array.from({ length: MAX_CONCURRENT_TOOLS + 2 }, (_, index) => (
    call(`r${index}`, 'read_tool_result', { id: `t${index}` })
  ));
  const scheduler = createToolScheduler({ calls, ctx: ctxFor(workspace), execute });
  await runLoop(calls, scheduler, execute);
  assert.equal(maxActive, MAX_CONCURRENT_TOOLS);
});

test('chat 模式输出路径重定向后使用同一个资源 key', () => {
  const workspace = makeWorkspace();
  const first = classifyToolCall('write_file', { path: 'outputs/report.md' }, ctxFor(workspace, 'chat'));
  const second = classifyToolCall('read_file', { path: 'outputs/chat/report.md' }, ctxFor(workspace, 'chat'));
  assert.equal(first.kind, 'write');
  assert.equal(second.kind, 'read');
  assert.equal(first.key, second.key);
});

test('并发开关默认开启，AGENT_TOOL_CONCURRENCY=0 时关闭', () => {
  assert.equal(toolConcurrencyEnabled({}), true);
  assert.equal(toolConcurrencyEnabled({ AGENT_TOOL_CONCURRENCY: '0' }), false);
  assert.equal(toolConcurrencyEnabled({ AGENT_TOOL_CONCURRENCY: '1' }), true);
});

test('调度后的真实文件写入与读取内容正确', async () => {
  const workspace = makeWorkspace();
  const ctx = {
    workspace,
    mode: 'agent',
    outputRel: 'outputs'
  };
  const calls = [
    call('w1', 'write_file', { path: 'a.md', content: 'hello' }),
    call('w2', 'write_file', { path: 'b.md', content: 'world' }),
    call('r1', 'read_file', { path: 'a.md' }),
    call('r2', 'read_file', { path: 'b.md' })
  ];
  const execute = async (item, args) => {
    const target = path.join(workspace, args.path);
    if (item.name === 'write_file') {
      fs.writeFileSync(target, args.content);
      return { meta: { path: args.path } };
    }
    return fs.readFileSync(target, 'utf8');
  };
  const scheduler = createToolScheduler({ calls, ctx, execute });
  const results = await runLoop(calls, scheduler, execute);
  assert.equal(results.every((item) => item.ok), true);
  assert.match(results[2].value, /hello/);
  assert.match(results[3].value, /world/);
  assert.equal(fs.readFileSync(path.join(workspace, 'a.md'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(workspace, 'b.md'), 'utf8'), 'world');
});

test('带确定 scope 的 run_command 是 verify 节点，未知 scope 仍是屏障', () => {
  const workspace = makeWorkspace();
  const ctx = ctxFor(workspace);
  const scoped = classifyToolCall('run_command', {
    command: 'node --test',
    scope: { paths: ['test/a.test.js'], outputs: ['out/report.json'] }
  }, ctx);
  assert.equal(scoped.kind, 'verify');
  assert.ok(scoped.keys.some((item) => item.mode === 'read'));
  assert.ok(scoped.keys.some((item) => item.mode === 'write'));
  const unknown = classifyToolCall('run_command', { command: 'npm test' }, ctx);
  assert.equal(unknown.kind, 'barrier');
});

test('verify 与无关写并发，后续同输入写等待验证结束', async () => {
  const workspace = makeWorkspace();
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'a.js'), 'x');
  const events = [];
  const execute = async (item, args) => {
    events.push(`${args.path || 'verify'}:start`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    events.push(`${args.path || 'verify'}:end`);
    return 'ok';
  };
  const calls = [
    call('v', 'run_command', { command: 'node --test', scope: { paths: ['src/a.js'] } }),
    call('w1', 'write_file', { path: 'other.md', content: 'unrelated' }),
    call('w2', 'write_file', { path: 'src/a.js', content: 'changed' })
  ];
  const scheduler = createToolScheduler({ calls, ctx: ctxFor(workspace), execute });
  await runLoop(calls, scheduler, execute);
  // 无关写与 verify 重叠；同一输入的写必须排在 verify 之后。
  assert.ok(events.indexOf('other.md:start') < events.indexOf('verify:end'));
  assert.ok(events.indexOf('src/a.js:start') > events.indexOf('verify:end'));
});

test('目录读扫描会挡住子文件的写，但无关目录的写仍可并发', async () => {
  const workspace = makeWorkspace();
  const events = [];
  const execute = async (item, args) => {
    events.push(`${args.path}:start`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    events.push(`${args.path}:end`);
    return 'ok';
  };
  const calls = [
    call('scan', 'search_files', { path: 'src', query: 'needle' }),
    call('child', 'write_file', { path: 'src/a.js', content: 'A' }),
    call('other', 'write_file', { path: 'docs/b.md', content: 'B' })
  ];
  const scheduler = createToolScheduler({ calls, ctx: ctxFor(workspace), execute });
  await runLoop(calls, scheduler, execute);
  assert.ok(events.indexOf('src/a.js:start') > events.indexOf('src:end'));
  assert.ok(events.indexOf('docs/b.md:start') < events.indexOf('src:end'));
});
