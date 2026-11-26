// Minimal integration example: history window, prefix fingerprint, tool-result distillation and read-back.
// Run: npm run example:minimal
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRequestFingerprint,
  commonPrefixRatio,
  distillToolResult,
  readStoredToolResult,
  resolveLaggingWindow,
  resolveTokenOpt
} from '../index.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfaw-demo-'));
const limits = {
  softMessages: 6,
  hardMessages: 8,
  softChars: 1_000_000,
  hardChars: 2_000_000
};
const system = 'You are a cache-stable coding agent. Keep the prefix byte-stable.';
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file' } }];

let history = [
  { role: 'user', content: 'First look at the entry point in src/app.js.' },
  { role: 'assistant', content: 'Entry point read, ready to continue.' },
  { role: 'user', content: 'Now look at the utils directory.' },
  { role: 'assistant', content: 'utils directory listed.' }
];
let lastTrimLength = 0;

const first = resolveLaggingWindow(history, lastTrimLength, limits);
lastTrimLength = first.trimmed ? first.windowLength : lastTrimLength;
const firstFingerprint = buildRequestFingerprint({ system, tools, messages: first.window }).text;

history = [
  ...history,
  { role: 'user', content: 'Merge the duplicate formatting functions.' },
  { role: 'assistant', content: 'Located the two duplicate functions.' }
];
const second = resolveLaggingWindow(history, lastTrimLength, limits);
const secondFingerprint = buildRequestFingerprint({ system, tools, messages: second.window }).text;

console.log(`[window] first=${first.window.length} second=${second.window.length} trimmed=${second.trimmed}`);
console.log(`[prefix] commonPrefixRatio=${commonPrefixRatio(firstFingerprint, secondFingerprint).toFixed(4)}`);

const tokenOpt = resolveTokenOpt({
  tokenOpt: {
    toolResultDistill: true,
    toolBudgets: { read_file: 800 }
  }
});
const bigOutput = Array.from({ length: 120 }, (_, index) => `line ${index} const value = ${index};`).join('\n');
const distilled = distillToolResult({
  dataDir,
  sessionId: 'demo-session',
  callId: 'call-1',
  toolName: 'read_file',
  output: bigOutput,
  budgets: tokenOpt.toolBudgets,
  enabled: tokenOpt.toolResultDistill
});

console.log(`[distill] distilled=${distilled.distilled} summaryChars=${distilled.content.length}`);
if (distilled.distilled) {
  const slice = readStoredToolResult({
    dataDir,
    resultId: distilled.ref.resultId,
    startLine: 1,
    endLine: 5
  });
  console.log(`[read] ${slice.text.split('\n').slice(0, 3).join(' | ')}`);
}

fs.rmSync(dataDir, { recursive: true, force: true });
