// Single-turn context example: prefetch, cold facts, artifact index and task memo are all appended at the tail of the user message.
// The stable prefix (system / tools / history) stays unchanged, so cache hits are not broken.
// Run: npm run example:context
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { artifactEntry, buildTurnContext } from '../index.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lfaw-context-'));
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.writeFileSync(
  path.join(workspace, 'src', 'order.js'),
  'export function createOrder(id) {\n  return { id, status: "created" };\n}\n',
  'utf8'
);
fs.writeFileSync(path.join(workspace, 'README.md'), '# demo\n\nA tiny workspace for context prefetch.\n', 'utf8');

const session = {
  id: 'demo-session',
  messages: [
    { role: 'user', content: 'First look at the implementation of src/order.js.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{"path":"src/order.js"}' } }]
    },
    {
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'export function createOrder(id) {\n  return { id, status: "created" };\n}'
    }
  ],
  artifacts: {
    'src/order.js': artifactEntry({
      path: 'src/order.js',
      content: 'export function createOrder(id) {\n  return { id, status: "created" };\n}'
    })
  }
};

const message = 'Continue editing src/order.js, change id to the order number, see lines 1-2.';
const turn = buildTurnContext({
  session,
  message,
  workspace,
  baseModelContent: message,
  maxPrefetchChars: 4000
});

console.log(`[prefetch] mode=${turn.prefetchPlan.mode} items=${turn.prefetchPlan.items.length} chars=${turn.prefetchPlan.chars}`);
console.log(`[cache] hits=${turn.prefetchPlan.hits} misses=${turn.prefetchPlan.misses}`);
console.log('--- modelContent ---');
console.log(turn.modelContent);

// Second reference to the same file: mtime / size / hash unchanged, so the prefetch cache hits directly and no re-read from disk.
const again = buildTurnContext({
  session,
  message: 'Now look at lines 1-2 of src/order.js.',
  workspace,
  baseModelContent: 'Now look at lines 1-2 of src/order.js.',
  maxPrefetchChars: 4000
});
console.log(`[second] hits=${again.prefetchPlan.hits} misses=${again.prefetchPlan.misses}`);

fs.rmSync(workspace, { recursive: true, force: true });
