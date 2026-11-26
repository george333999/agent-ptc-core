import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractColdFacts,
  isOldTurnReference,
  formatColdFacts,
  buildColdFactBlock
} from '../server/cold-facts.js';

const calls = [
  { name: 'write_file', args: { path: './reports/a.md', content: 'hello' }, status: 'ok' },
  { name: 'read_file', args: { path: 'src/b.js' }, status: 'ok' },
  { name: 'read_file', args: { path: 'src/c.js' }, status: 'error' },
  { name: 'run_command', args: { command: 'npm  test' }, status: 'ok' },
  { name: 'search_files', args: { query: ' formatBytes ' }, status: 'ok' },
  { name: 'write_file', args: { path: 'reports/a.md', content: 'hello' }, status: 'ok' }
];

test('cold-fact extraction is deterministic, deduplicated, stably sorted, and skips failed calls', () => {
  const facts = extractColdFacts(calls);
  assert.deepEqual(facts, [
    { type: 'command_run', command: 'npm test' },
    { type: 'file_read', path: 'src/b.js' },
    { type: 'file_written', path: 'reports/a.md', chars: 5 },
    { type: 'search', query: 'formatBytes' }
  ]);
  assert.deepEqual(extractColdFacts(calls), extractColdFacts([...calls].reverse()));
  assert.deepEqual(extractColdFacts(null), []);
});

test('old-turn reference detection covers common Chinese and English expressions', () => {
  assert.equal(isOldTurnReference('基于上次的结果继续'), true);
  assert.equal(isOldTurnReference('刚才那个文件还有问题'), true);
  assert.equal(isOldTurnReference('继续之前的工作'), true);
  assert.equal(isOldTurnReference('帮我写一个新页面'), false);
  assert.equal(isOldTurnReference(''), false);
});

test('fact text is bounded by the token budget and shows an omission note when exceeded', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ type: 'file_read', path: `src/file-${index}.js` }));
  const text = formatColdFacts(many, { maxTokens: 30 });
  assert.ok(text.length <= 400);
  assert.match(text, /omitted/);
  assert.equal(formatColdFacts([]), '');
  assert.equal(formatColdFacts([{ type: 'unknown' }]), '');
});

test('cold-fact block is injected only when old turns are referenced', () => {
  const facts = extractColdFacts(calls);
  assert.equal(buildColdFactBlock({ facts, message: '帮我写个新页面' }), '');
  const block = buildColdFactBlock({ facts, message: '基于上次写好的报告继续优化' });
  assert.match(block, /Confirmed facts/);
  assert.match(block, /reports\/a\.md/);
  assert.ok(!block.includes('src/c.js'));
});
