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

test('Extracts only explicit paths, ignoring URLs and out-of-bounds paths', () => {
  const paths = extractExplicitPaths('read src/calc.js and docs/notes.md, also check package.json; do not access https://a.com/x.js or ../secret.js');
  assert.deepEqual(paths, ['src/calc.js', 'docs/notes.md', 'package.json']);
  assert.deepEqual(extractExplicitPaths('take a look at this project'), []);
});

test('Extracts only explicit symbols, ignoring stop words and short identifiers', () => {
  const symbols = extractExplicitSymbols('检查 `sum` 函数和 sum 方法，还有 `const` 与 `ab`，函数 `formatBytes`');
  assert.ok(symbols.includes('sum'));
  assert.ok(symbols.includes('formatBytes'));
  assert.ok(!symbols.includes('const'));
  assert.ok(!symbols.includes('ab'));
  assert.deepEqual(extractContextTargets('no target').symbols, []);
});

test('The workspace index respects the token cap and reports the omitted count', () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({ path: `src/file-${index}.js`, size: 100 + index }));
  const full = buildWorkspaceIndex(entries, { maxTokens: 10000 });
  assert.ok(full.includes('src/file-0.js'));
  assert.ok(full.split('\n').length >= 30);
  const small = buildWorkspaceIndex(entries, { maxTokens: 25 });
  assert.ok(small.split('\n').length < 30);
  assert.match(small, /omitted/);
  assert.equal(buildWorkspaceIndex([]), '');
});

test('File fingerprint includes mtime + size + hash, and the cache hits when content is unchanged', () => {
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
  // Touch without changing content: same hash → still a hit.
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'src/a.js'), future, future);
  const read3 = cache.read(root, 'src/a.js');
  assert.equal(read3.hit, true);
  // Content changed → miss.
  fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = 2;\n');
  const read4 = cache.read(root, 'src/a.js');
  assert.equal(read4.hit, false);
});

test('With no target, injects only the index without reading file content', () => {
  const root = makeWorkspace({ 'src/a.js': 'x'.repeat(5000) });
  const plan = planPrefetch({
    message: 'take a look at this project',
    workspace: root,
    fileIndex: [{ path: 'src/a.js', size: 5000 }]
  });
  assert.equal(plan.mode, 'index');
  assert.equal(plan.items.length, 0);
  assert.ok(plan.index.includes('src/a.js'));
  assert.ok(!plan.index.includes('xxxx'));
});

test("A large file's first reference injects only path/fingerprint/line count, not the body", () => {
  const root = makeWorkspace({
    'src/a.js': 'A'.repeat(6000),
    'src/b.js': 'B'.repeat(6000)
  });
  const cache = createPrefetchCache();
  const plan = planPrefetch({
    message: 'read src/a.js and src/b.js and summarize',
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
  assert.match(block, /body not expanded/);
  assert.match(block, /src\/a\.js/);
  assert.match(block, /src\/b\.js/);
});

test('Small-file boundary: a 1500-char first reference injects the body, 1501 chars default to path only', () => {
  const root = makeWorkspace({
    'src/edge1500.js': 'a'.repeat(1500),
    'src/edge1501.js': 'b'.repeat(1501)
  });
  const plan = planPrefetch({
    message: 'read src/edge1500.js and src/edge1501.js',
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

test('Worker prefetch allows inlining the body on the first reference, saving a tool round-trip', () => {
  const root = makeWorkspace({ 'src/a.js': 'A'.repeat(6000) });
  const plan = planPrefetch({
    message: 'audit src/a.js',
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
  assert.match(block, /Prefetch context/);
  assert.doesNotMatch(block, /body not expanded/);
});

test('The body is expanded only on the second reference to the same path in this session, and a single file stays within 1200 chars', () => {
  const root = makeWorkspace({ 'src/a.js': 'A'.repeat(6000) });
  const cache = createPrefetchCache();
  const first = planPrefetch({ message: 'read src/a.js', workspace: root, cache });
  assert.equal(first.items[0].headerOnly, true);

  const second = planPrefetch({ message: 'read src/a.js again', workspace: root, cache });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].headerOnly, undefined);
  assert.equal(second.items[0].excerpt.length, 1200);
  assert.equal(second.items[0].truncated, true);
  assert.ok(second.chars <= 8000);
});

test('A small file (≤1500 chars) injects the full body on the first reference', () => {
  const content = `export const a = 1;\n${'// note\n'.repeat(100)}`;
  assert.ok(content.length <= 1500);
  const root = makeWorkspace({ 'src/small.js': content });
  const plan = planPrefetch({
    message: 'read src/small.js',
    workspace: root,
    cache: createPrefetchCache()
  });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].headerOnly, undefined);
  assert.equal(plan.items[0].excerpt, content);
  assert.equal(plan.items[0].truncated, false);
});

test('Boundary: 1500 chars still counts as small, 1501 chars becomes header-only', () => {
  const root = makeWorkspace({
    'src/exact.js': 'a'.repeat(1500),
    'src/over.js': 'b'.repeat(1501)
  });
  const exact = planPrefetch({ message: 'read src/exact.js', workspace: root, cache: createPrefetchCache() });
  assert.equal(exact.items[0].excerpt.length, 1500);
  assert.equal(exact.items[0].headerOnly, undefined);

  const over = planPrefetch({ message: 'read src/over.js', workspace: root, cache: createPrefetchCache() });
  assert.equal(over.items[0].headerOnly, true);
  assert.equal(over.items[0].excerpt, '');
  assert.ok(over.chars < 300);
});

test('With an explicit line range, prefetch takes only that segment, avoiding injecting a whole long document', () => {
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

test('With only a symbol, locates it in the workspace index and returns an excerpt around the symbol', () => {
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
    message: 'where is `formatBytes` defined?',
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

test('Gives a clear note when the target file does not exist, without throwing', () => {
  const root = makeWorkspace({});
  const plan = planPrefetch({ message: 'read src/missing.js', workspace: root });
  assert.equal(plan.mode, 'targets');
  assert.equal(plan.items.length, 0);
  assert.match(renderPrefetchBlock(plan), /not found in the workspace/);
  assert.equal(renderPrefetchBlock(null), '');
  assert.equal(renderPrefetchBlock({ mode: 'index', index: '' }), '');
});

test('Option 1 marginal case: a third reference to the same-fingerprint large file gives only a reference, not the body again', () => {
  const root = makeWorkspace({ 'src/a.js': 'A'.repeat(6000) });
  const cache = createPrefetchCache();
  const first = planPrefetch({ message: 'read src/a.js', workspace: root, cache });
  assert.equal(first.items[0].headerOnly, true);
  assert.equal(first.reused, 0);

  const second = planPrefetch({ message: 'read src/a.js again', workspace: root, cache });
  assert.equal(second.items[0].headerOnly, undefined);
  assert.equal(second.items[0].excerpt.length, 1200);
  assert.equal(second.reused, 0);
  assert.equal(cache.injectedSize(), 1);

  const third = planPrefetch({ message: 'look at src/a.js once more', workspace: root, cache });
  assert.equal(third.reused, 1);
  assert.equal(third.items[0].headerOnly, true);
  assert.equal(third.items[0].reused, true);
  assert.equal(third.items[0].excerpt, '');
  const block = renderPrefetchBlock(third);
  assert.match(block, /same-fingerprint body already injected/);
  assert.match(block, /not re-injected/);
});

test('Re-injects the new body after content changes even if it was injected before', () => {
  const root = makeWorkspace({ 'src/small.js': 'export const value = 1;\n' });
  const cache = createPrefetchCache();
  const first = planPrefetch({ message: 'check src/small.js', workspace: root, cache });
  assert.match(first.items[0].excerpt, /value = 1/);

  fs.writeFileSync(path.join(root, 'src/small.js'), 'export const value = 2;\n');
  const second = planPrefetch({ message: 'check src/small.js again', workspace: root, cache });
  assert.equal(second.reused, 0);
  assert.match(second.items[0].excerpt, /value = 2/);
  assert.ok(!second.items[0].excerpt.includes('value = 1'));
});

test('Same-fingerprint files re-inject the body after resetInjected', () => {
  const root = makeWorkspace({ 'src/small.js': 'const answer = 42;\n' });
  const cache = createPrefetchCache();
  planPrefetch({ message: 'check src/small.js', workspace: root, cache });
  const reused = planPrefetch({ message: 'check src/small.js', workspace: root, cache });
  assert.equal(reused.reused, 1);

  cache.resetInjected();
  assert.equal(cache.injectedSize(), 0);
  const refilled = planPrefetch({ message: 'check src/small.js', workspace: root, cache });
  assert.equal(refilled.reused, 0);
  assert.match(refilled.items[0].excerpt, /answer = 42/);
});

test('An explicit line-range request does not omit the body due to session reuse', () => {
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

test('Boundary: a 0-byte file injects no empty body and does not error', () => {
  const root = makeWorkspace({ 'src/empty.js': '' });
  const plan = planPrefetch({ message: 'read src/empty.js', workspace: root, cache: createPrefetchCache() });
  assert.equal(plan.mode, 'targets');
  assert.equal(plan.items.length, 0);
  assert.equal(plan.reused, 0);
  assert.doesNotThrow(() => renderPrefetchBlock(plan));
});

test('Boundary: takes only the first 5 when explicit paths exceed maxFiles', () => {
  const files = {};
  for (let index = 0; index < 6; index += 1) files[`src/f${index}.js`] = `export const f${index} = ${index};\n`;
  const root = makeWorkspace(files);
  const plan = planPrefetch({
    message: 'read src/f0.js src/f1.js src/f2.js src/f3.js src/f4.js src/f5.js',
    workspace: root,
    cache: createPrefetchCache(),
    maxFiles: 5
  });
  assert.equal(plan.items.length, 5);
  assert.ok(!plan.items.some((item) => item.path === 'src/f5.js'));
});

test('Boundary: no more reference lines are appended once maxChars is exactly used up', () => {
  const root = makeWorkspace({
    'src/big.js': 'A'.repeat(6000),
    'src/small.js': 'B'.repeat(200)
  });
  const plan = planPrefetch({
    message: 'read src/big.js and src/small.js',
    workspace: root,
    cache: createPrefetchCache(),
    maxChars: 20
  });
  // Budget too small: better to inject nothing than produce pseudo context.
  assert.equal(plan.items.length, 0);
  assert.ok(plan.chars <= 20);
});
