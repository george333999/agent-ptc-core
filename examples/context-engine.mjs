// 单轮上下文示例：预取、冷事实、产出索引与任务备忘都追加在用户消息尾部。
// 稳定前缀（system / tools / 历史）保持不变，因此不会破坏缓存命中。
// 运行：npm run example:context
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
    { role: 'user', content: '先看 src/order.js 的实现。' },
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

const message = '继续改 src/order.js，把 id 改成订单号，参考第 1-2 行。';
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

// 第二次引用同一文件：mtime / size / hash 未变，预取缓存直接命中，不再重复读盘。
const again = buildTurnContext({
  session,
  message: '再看 src/order.js 第 1-2 行。',
  workspace,
  baseModelContent: '再看 src/order.js 第 1-2 行。',
  maxPrefetchChars: 4000
});
console.log(`[second] hits=${again.prefetchPlan.hits} misses=${again.prefetchPlan.misses}`);

fs.rmSync(workspace, { recursive: true, force: true });
