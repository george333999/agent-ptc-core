import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractExplicitPaths,
  extractExplicitSymbols,
  extractContextTargets,
  extractLineRange,
  buildWorkspaceIndex,
  fingerprintText,
  fingerprintFile,
  createPrefetchCache,
  planPrefetch,
  renderPrefetchBlock
} from '../server/context-prefetch.js';

function makeWorkspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prefetch-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return root;
}

test('只抽取明确路径，忽略 URL 与越界路径', () => {
  const paths = extractExplicitPaths('读取 src/calc.js 和 docs/notes.md，顺便看 package.json；不要访问 https://a.com/x.js 或 ../secret.js');
  assert.deepEqual(paths, ['src/calc.js', 'docs/notes.md', 'package.json']);
  assert.deepEqual(extractExplicitPaths('帮我看看这个项目'), []);
});

test('只抽取明确符号，忽略停用词与短标识符', () => {
  const symbols = extractExplicitSymbols('检查 `sum` 函数和 sum 方法，还有 `const` 与 `ab`，函数 `formatBytes`');
  assert.ok(symbols.includes('sum'));
  assert.ok(symbols.includes('formatBytes'));
  assert.ok(!symbols.includes('const'));
  assert.ok(!symbols.includes('ab'));
  assert.deepEqual(extractContextTargets('没有目标').symbols, []);
});

test('工作区索引受 token 上限约束并给出省略计数', () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({ path: `src/file-${index}.js`, size: 100 + index }));
  const full = buildWorkspaceIndex(entries, { maxTokens: 10000 });
  assert.ok(full.includes('src/file-0.js'));
  assert.ok(full.split('\n').length >= 30);
  const small = buildWorkspaceIndex(entries, { maxTokens: 25 });
  assert.ok(small.split('\n').length < 30);
  assert.match(small, /已省略/);
  assert.equal(buildWorkspaceIndex([]), '');
});

test('文件指纹包含 mtime + size + hash，且内容未变时缓存命中', () => {
  const root = makeWorkspace({ 'src/a.js': 'export const a = 1;\n' });
  const first = fingerprintFile(root, 'src/a.js');
  assert.equal(first.path, 'src/a.js');
  assert.equal(first.hash, fingerprintText('export const a = 1;\n'));
  assert.ok(first.mtimeMs > 0);
  assert.equal(fingerprintFile(root, '../outside.js'), null);
  assert.equal(fingerprintFile(root, 'not-exist.js'), null);

  const cache = createPrefetchCache();
  const read1 = cache.read(root, 'src/a.js');
  assert.equal(read1.hit, false);
  const read2 = cache.read(root, 'src/a.js');
  assert.equal(read2.hit, true);
  // 只 touch 不改内容：hash 相同 → 仍然命中。
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'src/a.js'), future, future);
  const read3 = cache.read(root, 'src/a.js');
  assert.equal(read3.hit, true);
  // 内容变化 → 不命中。
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = 2;\n');
  const read4 = cache.read(root, 'src/a.js');
  assert.equal(read4.hit, false);
});

test('无目标时只注入索引，不读取文件内容', () => {
  const root = makeWorkspace({ 'src/a.js': 'x'.repeat(5000) });
  const plan = planPrefetch({
    message: '帮我看看这个项目',
    workspace: root,
    fileIndex: [{ path: 'src/a.js', size: 5000 }]
  });
  assert.equal(plan.mode, 'index');
  assert.equal(plan.items.length, 0);
  assert.ok(plan.index.includes('src/a.js'));
  assert.ok(!plan.index.includes('xxxx'));
});

test('大文件首次引用只注入路径/指纹/行数，不展开正文', () => {
  const root = makeWorkspace({
    'src/a.js': 'A'.repeat(6000),
    'src/b.js': 'B'.repeat(6000)
  });
  const cache = createPrefetchCache();
  const plan = planPrefetch({
    message: '读取 src/a.js 和 src/b.js 并总结',
    workspace: root,
    cache,
    maxChars: 4000
  });
  assert.equal(plan.mode, 'targets');
  assert.equal(plan.items.length, 2);
  assert.ok(plan.items.every((item) => item.headerOnly));
  assert.ok(plan.items.every((item) => item.excerpt === ''));
  assert.ok(plan.items.every((item) => item.totalLines === 1 && item.refCount === 1));
  assert.ok(plan.chars <= 4000);
  const block = renderPrefetchBlock(plan);
  assert.match(block, /未展开正文/);
  assert.match(block, /src\/a\.js/);
  assert.match(block, /src\/b\.js/);
});

test('小文件边界：1500 字符首引注入正文，1501 字符默认只给路径', () => {
  const root = makeWorkspace({
    'src/edge1500.js': 'a'.repeat(1500),
    'src/edge1501.js': 'b'.repeat(1501)
  });
  const plan = planPrefetch({
    message: '读取 src/edge1500.js 和 src/edge1501.js',
    workspace: root,
    cache: createPrefetchCache(),
    maxChars: 4000
  });
  const byPath = new Map(plan.items.map((item) => [item.path, item]));
  assert.equal(byPath.get('src/edge1500.js').headerOnly, undefined);
  assert.equal(byPath.get('src/edge1500.js').excerpt.length, 1500);
  assert.equal(byPath.get('src/edge1501.js').headerOnly, true);
  assert.equal(byPath.get('src/edge1501.js').excerpt, '');
});

test('Worker 预取允许首引注入正文，减少一次工具往返', () => {
  const root = makeWorkspace({ 'src/a.js': 'A'.repeat(6000) });
  const plan = planPrefetch({
    message: '审计 src/a.js',
    workspace: root,
    cache: createPrefetchCache(),
    maxChars: 6000,
    inlineFirstReference: true
  });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].headerOnly, undefined);
  assert.equal(plan.items[0].excerpt.length, 1200);
  assert.equal(plan.items[0].truncated, true);
  const block = renderPrefetchBlock(plan);
  assert.match(block, /预取上下文/);
  assert.doesNotMatch(block, /未展开正文/);
});

test('同一路径本会话第二次引用才展开正文，且单文件不超过 1200 字符', () => {
  const root = makeWorkspace({ 'src/a.js': 'A'.repeat(6000) });
  const cache = createPrefetchCache();
  const first = planPrefetch({ message: '读取 src/a.js', workspace: root, cache });
  assert.equal(first.items[0].headerOnly, true);

  const second = planPrefetch({ message: '再次读取 src/a.js', workspace: root, cache });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].headerOnly, undefined);
  assert.equal(second.items[0].excerpt.length, 1200);
  assert.equal(second.items[0].truncated, true);
  assert.ok(second.chars <= 8000);
});

test('小文件（≤1500 字符）首次引用即注入完整正文', () => {
  const content = `export const a = 1;\n${'// note\n'.repeat(100)}`;
  assert.ok(content.length <= 1500);
  const root = makeWorkspace({ 'src/small.js': content });
  const plan = planPrefetch({
    message: '读取 src/small.js',
    workspace: root,
    cache: createPrefetchCache()
  });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].headerOnly, undefined);
  assert.equal(plan.items[0].excerpt, content);
  assert.equal(plan.items[0].truncated, false);
});

test('边界值：1500 字符仍算小文件，1501 字符转为仅头部', () => {
  const root = makeWorkspace({
    'src/exact.js': 'a'.repeat(1500),
    'src/over.js': 'b'.repeat(1501)
  });
  const exact = planPrefetch({ message: '读取 src/exact.js', workspace: root, cache: createPrefetchCache() });
  assert.equal(exact.items[0].excerpt.length, 1500);
  assert.equal(exact.items[0].headerOnly, undefined);

  const over = planPrefetch({ message: '读取 src/over.js', workspace: root, cache: createPrefetchCache() });
  assert.equal(over.items[0].headerOnly, true);
  assert.equal(over.items[0].excerpt, '');
  assert.ok(over.chars < 300);
});

test('明确行范围时预取只取该段，避免长文档整份注入', () => {
  const content = Array.from({ length: 300 }, (_, index) => `line-${index + 1}`).join('\n');
  const root = makeWorkspace({ 'docs/notes.md': content });

  assert.deepEqual(extractLineRange('读取 docs/notes.md 的 1-120 行并总结'), { from: 1, to: 120 });
  assert.deepEqual(extractLineRange('第 5~9 行'), { from: 5, to: 9 });
  assert.equal(extractLineRange('没有行范围'), null);
  assert.equal(extractLineRange('1-5000 行'), null);

  const plan = planPrefetch({
    message: '读取 docs/notes.md 的 1-120 行并总结',
    workspace: root
  });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].from, 1);
  assert.equal(plan.items[0].to, 120);
  assert.ok(plan.items[0].excerpt.includes('line-120'));
  assert.ok(!plan.items[0].excerpt.includes('line-121'));
});

test('只有符号时在工作区索引内定位并返回符号附近片段', () => {
  const target = [
    'export function other() {',
    '  return 1;',
    '}',
    '',
    'export function formatBytes(size) {',
    '  return `${size}B`;',
    '}'
  ].join('\n');
  const root = makeWorkspace({
    'src/util.js': target,
    'src/calc.js': 'export function sum(a, b) { return a + b; }\n'
  });
  const plan = planPrefetch({
    message: '`formatBytes` 在哪里定义？',
    workspace: root,
    fileIndex: [{ path: 'src/calc.js' }, { path: 'src/util.js' }],
    maxChars: 4000
  });
  assert.equal(plan.mode, 'targets');
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].path, 'src/util.js');
  assert.equal(plan.items[0].reason, 'symbol');
  assert.ok(plan.items[0].excerpt.includes('formatBytes'));
  assert.ok(!plan.items[0].excerpt.includes('function sum'));
});

test('目标文件不存在时给出明确说明且不抛错', () => {
  const root = makeWorkspace({});
  const plan = planPrefetch({ message: '读取 src/missing.js', workspace: root });
  assert.equal(plan.mode, 'targets');
  assert.equal(plan.items.length, 0);
  assert.match(renderPrefetchBlock(plan), /未在工作区找到/);
  assert.equal(renderPrefetchBlock(null), '');
  assert.equal(renderPrefetchBlock({ mode: 'index', index: '' }), '');
});

test('方案 1 边际：第三次引用同指纹大文件只给引用，不重复注入正文', () => {
  const root = makeWorkspace({ 'src/a.js': 'A'.repeat(6000) });
  const cache = createPrefetchCache();
  const first = planPrefetch({ message: '读取 src/a.js', workspace: root, cache });
  assert.equal(first.items[0].headerOnly, true);
  assert.equal(first.reused, 0);

  const second = planPrefetch({ message: '再次读取 src/a.js', workspace: root, cache });
  assert.equal(second.items[0].headerOnly, undefined);
  assert.equal(second.items[0].excerpt.length, 1200);
  assert.equal(second.reused, 0);
  assert.equal(cache.injectedSize(), 1);

  const third = planPrefetch({ message: '再再看 src/a.js', workspace: root, cache });
  assert.equal(third.reused, 1);
  assert.equal(third.items[0].headerOnly, true);
  assert.equal(third.items[0].reused, true);
  assert.equal(third.items[0].excerpt, '');
  const block = renderPrefetchBlock(third);
  assert.match(block, /已注入同指纹正文/);
  assert.match(block, /未重复注入/);
});

test('内容变化后即使之前注入过也会重新注入新正文', () => {
  const root = makeWorkspace({ 'src/small.js': 'export const value = 1;\n' });
  const cache = createPrefetchCache();
  const first = planPrefetch({ message: '查看 src/small.js', workspace: root, cache });
  assert.match(first.items[0].excerpt, /value = 1/);

  fs.writeFileSync(path.join(root, 'src/small.js'), 'export const value = 2;\n');
  const second = planPrefetch({ message: '再次查看 src/small.js', workspace: root, cache });
  assert.equal(second.reused, 0);
  assert.match(second.items[0].excerpt, /value = 2/);
  assert.ok(!second.items[0].excerpt.includes('value = 1'));
});

test('resetInjected 后同指纹文件重新注入正文', () => {
  const root = makeWorkspace({ 'src/small.js': 'const answer = 42;\n' });
  const cache = createPrefetchCache();
  planPrefetch({ message: '查看 src/small.js', workspace: root, cache });
  const reused = planPrefetch({ message: '查看 src/small.js', workspace: root, cache });
  assert.equal(reused.reused, 1);

  cache.resetInjected();
  assert.equal(cache.injectedSize(), 0);
  const refilled = planPrefetch({ message: '查看 src/small.js', workspace: root, cache });
  assert.equal(refilled.reused, 0);
  assert.match(refilled.items[0].excerpt, /answer = 42/);
});

test('明确行范围请求不因会话复用而省略正文', () => {
  const content = Array.from({ length: 200 }, (_, index) => `line-${index + 1}`).join('\n');
  const root = makeWorkspace({ 'docs/notes.md': content });
  const cache = createPrefetchCache();
  planPrefetch({ message: '读取 docs/notes.md 的 1-20 行', workspace: root, cache });
  const ranged = planPrefetch({ message: '再看 docs/notes.md 的 50-60 行', workspace: root, cache });
  assert.equal(ranged.reused, 0);
  assert.equal(ranged.items.length, 1);
  assert.ok(ranged.items[0].excerpt.includes('line-55'));
  assert.ok(!ranged.items[0].excerpt.includes('line-1\n'));
});

test('边界值：0 字节文件不注入空正文也不报错', () => {
  const root = makeWorkspace({ 'src/empty.js': '' });
  const plan = planPrefetch({ message: '读取 src/empty.js', workspace: root, cache: createPrefetchCache() });
  assert.equal(plan.mode, 'targets');
  assert.equal(plan.items.length, 0);
  assert.equal(plan.reused, 0);
  assert.doesNotThrow(() => renderPrefetchBlock(plan));
});

test('边界值：显式路径超过 maxFiles 时只取前 5 个', () => {
  const files = {};
  for (let index = 0; index < 6; index += 1) files[`src/f${index}.js`] = `export const f${index} = ${index};\n`;
  const root = makeWorkspace(files);
  const plan = planPrefetch({
    message: '读取 src/f0.js src/f1.js src/f2.js src/f3.js src/f4.js src/f5.js',
    workspace: root,
    cache: createPrefetchCache(),
    maxFiles: 5
  });
  assert.equal(plan.items.length, 5);
  assert.ok(!plan.items.some((item) => item.path === 'src/f5.js'));
});

test('边界值：maxChars 正好用尽后不再追加引用行', () => {
  const root = makeWorkspace({
    'src/big.js': 'A'.repeat(6000),
    'src/small.js': 'B'.repeat(200)
  });
  const plan = planPrefetch({
    message: '读取 src/big.js 和 src/small.js',
    workspace: root,
    cache: createPrefetchCache(),
    maxChars: 20
  });
  // 预算过小，宁可不注入，也不产生伪上下文。
  assert.equal(plan.items.length, 0);
  assert.ok(plan.chars <= 20);
});
