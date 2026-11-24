import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planToolLocks,
  resolveCommandScope,
  tokenizeCommand
} from '../server/command-scope.js';

function probeFrom(tree) {
  return (rel) => {
    const value = tree[String(rel)];
    return value === 'dir' || value === 'file' ? value : false;
  };
}

test('分词保留引号内容并在 shell 操作符处截断', () => {
  assert.deepEqual(tokenizeCommand('node --test "test/a b.test.js"'), ['node', '--test', 'test/a b.test.js']);
  assert.deepEqual(tokenizeCommand('npm test && node x.js'), ['npm', 'test']);
  assert.deepEqual(tokenizeCommand("pytest -q 'tests/unit'"), ['pytest', '-q', 'tests/unit']);
});

test('显式 scope 同时给出读写资源', () => {
  const scope = resolveCommandScope({
    command: 'node build.js',
    scope: { paths: ['src/a.js'], dirs: ['src/lib'], outputs: ['dist'] }
  }, { probe: probeFrom({ src: 'dir', dist: 'dir' }) });
  assert.equal(scope.known, true);
  assert.equal(scope.source, 'explicit');
  assert.deepEqual(scope.reads, [
    { kind: 'file', path: 'src/a.js' },
    { kind: 'dir', path: 'src/lib' }
  ]);
  assert.deepEqual(scope.writes, [{ kind: 'dir', path: 'dist' }]);
});

test('node --test 按文件参数推断只读输入', () => {
  const scope = resolveCommandScope({
    command: 'node --test --test-reporter=spec test/a.test.js test/b.test.js'
  }, { probe: probeFrom({ test: 'dir' }) });
  assert.equal(scope.known, true);
  assert.equal(scope.source, 'inferred');
  assert.deepEqual(scope.reads, [
    { kind: 'file', path: 'test/a.test.js' },
    { kind: 'file', path: 'test/b.test.js' }
  ]);
  assert.deepEqual(scope.writes, []);
});

test('node --test 无文件参数时读取 test 目录，通配符退化为目录', () => {
  const noArgs = resolveCommandScope({ command: 'node --test' }, { probe: probeFrom({ test: 'dir' }) });
  assert.deepEqual(noArgs.reads, [{ kind: 'dir', path: 'test' }]);
  const glob = resolveCommandScope({ command: 'node --test "test/**/*.test.js"' }, { probe: probeFrom({ test: 'dir' }) });
  assert.deepEqual(glob.reads, [{ kind: 'dir', path: 'test' }]);
});

test('pytest 与 go test 的路径推断', () => {
  const pytest = resolveCommandScope({ command: 'python -m pytest -q tests/unit' }, { probe: probeFrom({ tests: 'dir', 'tests/unit': 'dir' }) });
  assert.deepEqual(pytest.reads, [{ kind: 'dir', path: 'tests/unit' }]);
  const fallback = resolveCommandScope({ command: 'pytest' }, { probe: probeFrom({ tests: 'dir' }) });
  assert.deepEqual(fallback.reads, [{ kind: 'dir', path: 'tests' }]);
  const go = resolveCommandScope({ command: 'go test ./pkg/... ./cmd/...' });
  assert.deepEqual(go.reads, [
    { kind: 'dir', path: 'pkg' },
    { kind: 'dir', path: 'cmd' }
  ]);
});

test('tsc -p 读取项目配置，无参数时读取 src', () => {
  const project = resolveCommandScope({ command: 'npx tsc -p tsconfig.json' }, { probe: probeFrom({ 'tsconfig.json': 'file' }) });
  assert.deepEqual(project.reads, [{ kind: 'file', path: 'tsconfig.json' }]);
  const plain = resolveCommandScope({ command: 'tsc' }, { probe: probeFrom({ src: 'dir' }) });
  assert.deepEqual(plain.reads, [{ kind: 'dir', path: 'src' }]);
});

test('cwd 会拼接到推断路径前', () => {
  const scope = resolveCommandScope({ command: 'node --test test/a.test.js', cwd: 'server' }, { probe: probeFrom({}) });
  assert.deepEqual(scope.reads, [{ kind: 'file', path: 'server/test/a.test.js' }]);
});

test('npm test / npm run build / 任意脚本退回未知作用域', () => {
  for (const command of ['npm test', 'npm run build', 'node scripts/build.js', 'rm -rf dist']) {
    const scope = resolveCommandScope({ command }, { probe: () => false });
    assert.equal(scope.known, false, command);
  }
});

test('越界 scope 路径退回未知作用域而不是抛出', () => {
  const scope = resolveCommandScope({
    command: 'node build.js',
    scope: { paths: ['../secret.txt'] }
  }, { probe: () => false });
  assert.equal(scope.known, false);
});

test('planToolLocks：读工具加文件读锁，写工具加文件写锁', () => {
  const helpers = {
    workspace: 'C:/ws',
    resolveInput: (rel) => `C:/ws/${rel}`,
    resolveOutput: (rel) => `C:/ws/${rel}`,
    probe: () => false
  };
  const read = planToolLocks('read_file', { path: 'a.md' }, helpers);
  assert.deepEqual(read.writes, []);
  assert.equal(read.reads.length, 1);
  assert.match(read.reads[0], /^file:/);
  const write = planToolLocks('write_file', { path: 'a.md' }, helpers);
  assert.equal(write.reads.length, 0);
  assert.match(write.writes[0], /^file:/);
});

test('planToolLocks：PTC 与独立工具不加锁', () => {
  const helpers = { workspace: 'C:/ws', resolveInput: (rel) => `C:/ws/${rel}`, resolveOutput: (rel) => `C:/ws/${rel}` };
  assert.equal(planToolLocks('ptc_run', { code: 'return 1' }, helpers), null);
  assert.equal(planToolLocks('web_search', { query: 'x' }, helpers), null);
});

test('planToolLocks：未知命令使用工作区全局锁', () => {
  const helpers = { workspace: 'C:/ws', resolveInput: (rel) => `C:/ws/${rel}`, resolveOutput: (rel) => `C:/ws/${rel}`, probe: () => false };
  const plan = planToolLocks('run_command', { command: 'npm test' }, helpers);
  assert.equal(plan.verify, null);
  assert.equal(plan.writes.length, 1);
  assert.match(plan.writes[0], /^ws:/);
});

test('planToolLocks：确定 scope 的命令生成 verify 计划', () => {
  const helpers = {
    workspace: 'C:/ws',
    resolveInput: (rel) => `C:/ws/${rel}`,
    resolveOutput: (rel) => `C:/ws/${rel}`,
    probe: () => false
  };
  const plan = planToolLocks('run_command', {
    command: 'node --test',
    scope: { paths: ['test/a.test.js'], outputs: ['out/report.json'] }
  }, helpers);
  assert.ok(plan.verify);
  assert.match(plan.verify.key, /^verify:/);
  assert.deepEqual(plan.verify.inputFiles, ['C:/ws/test/a.test.js']);
  assert.deepEqual(plan.verify.outputFiles, ['C:/ws/out/report.json']);
  assert.equal(plan.verify.cacheable, true);
});

test('planToolLocks：推断作用域的验证不可缓存，避免漏掉被 import 的源码', () => {
  const helpers = {
    workspace: 'C:/ws',
    resolveInput: (rel) => `C:/ws/${rel}`,
    resolveOutput: (rel) => `C:/ws/${rel}`,
    probe: () => false
  };
  const plan = planToolLocks('run_command', { command: 'node --test test/a.test.js' }, helpers);
  assert.ok(plan.verify);
  assert.equal(plan.verify.cacheable, false);
});

test('planToolLocks：chat 模式写文件重定向到 outputs/chat', () => {
  const helpers = {
    workspace: 'C:/ws',
    outputRel: 'outputs/chat',
    resolveInput: (rel) => `C:/ws/${rel}`,
    resolveOutput: (rel) => `C:/ws/${rel.startsWith('outputs/') ? `outputs/chat/${rel.slice(8)}` : rel}`,
    probe: () => false
  };
  const plan = planToolLocks('write_file', { path: 'outputs/report.md' }, helpers);
  assert.ok(plan.writes[0].includes('outputs/chat/report.md'));
});
