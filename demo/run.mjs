import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOrchestration } from '../src/orchestrator.js';
import { buildPtcToolDefinition, runPtcTool, shutdownPtc } from '../src/ptc/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-core-demo-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(path.join(workspace, 'corpus'), { recursive: true });

const files = [];
for (let index = 0; index < 6; index += 1) {
  const name = `part_${String(index + 1).padStart(2, '0')}.txt`;
  fs.writeFileSync(path.join(workspace, 'corpus', name), `NEEDLE_${index}: value_${index}\n`);
  files.push({ path: `corpus/${name}`, value: `value_${index}` });
}

const groups = [
  { id: 't1', files: files.slice(0, 3) },
  { id: 't2', files: files.slice(3) }
];
const groupByTask = new Map(groups.map((group) => [group.id, group.files]));

const plan = {
  goal: '并行读取 6 个文件的首行并汇总',
  estimatedMinutes: 12,
  decompositionCostMinutes: 1,
  maxConcurrency: 2,
  subtasks: groups.map((group) => ({
    id: group.id,
    title: `扫描 ${group.id}`,
    brief: `读取 ${group.files.map((file) => file.path).join('、')} 的首行`,
    constraints: ['只读，不修改文件'],
    knownInfo: '首行格式为 NEEDLE_n: value_n',
    expectedOutput: 'JSON，result 包含所有首行',
    readFiles: group.files.map((file) => file.path)
  }))
};

const settings = {
  disabledTools: [],
  toolMode: 'ptc',
  ptcAudit: false
};

function parsePtcResult(text) {
  const start = String(text || '').indexOf('{');
  if (start < 0) return [];
  const payload = JSON.parse(String(text).slice(start));
  return Array.isArray(payload.result) ? payload.result : [];
}

const chatRunner = async ({ messages }) => {
  const user = messages.find((message) => message.role === 'user')?.content || '';
  const taskId = user.match(/\[(t\d+)\]/)?.[1] || '';
  const taskFiles = groupByTask.get(taskId) || [];
  const toolMessage = messages.find((message) => message.role === 'tool');
  if (!toolMessage) {
    const code = [
      `const paths = ${JSON.stringify(taskFiles.map((file) => file.path))};`,
      'const out = [];',
      'for (const item of paths) {',
      '  const r = await files.read({ path: item });',
      "  out.push(r.content.split('\\n')[0]);",
      '}',
      'return out;'
    ].join('\n');
    return {
      content: '',
      toolCalls: [{ id: `call_${taskId}`, name: 'ptc_run', arguments: JSON.stringify({ code }) }]
    };
  }
  const lines = parsePtcResult(toolMessage.content);
  return {
    content: JSON.stringify({
      status: lines.length === taskFiles.length ? 'completed' : 'partial',
      result: lines.join('\n'),
      evidence: lines,
      confidence: lines.length === taskFiles.length ? 0.95 : 0.4,
      open_questions: lines.length === taskFiles.length ? [] : ['部分文件未读取']
    }),
    toolCalls: []
  };
};

const toolRunner = async (name, args, ctx) => {
  if (name === 'ptc_run') return runPtcTool(args, ctx);
  throw new Error(`demo 只支持 ptc_run，收到 ${name}`);
};

try {
  const result = await runOrchestration({
    plan,
    workspace,
    settings,
    model: { name: 'scripted-demo' },
    session: { id: 'demo-session' },
    runId: `demo-${Date.now()}`,
    chatRunner,
    toolRunner,
    buildWorkerTools: ({ ptc }) => (ptc ? [buildPtcToolDefinition()] : [])
  });
  console.log(result.text);
  console.log('\n--- metrics ---');
  console.log(JSON.stringify(result.metrics, null, 2));
} finally {
  await shutdownPtc();
  fs.rmSync(root, { recursive: true, force: true });
}
