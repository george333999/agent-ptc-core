// PTC sandbox example: complete search and read in one programmatic call, avoiding per-file round trips.
// Run: npm run example:ptc
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPtcTool, shutdownPtc, validatePtcCode } from '../index.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lfaw-ptc-'));
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'src', 'a.js'), 'export const a = 1;\n// TODO: add tests\n', 'utf8');
fs.writeFileSync(path.join(workspace, 'src', 'b.js'), 'export const b = 2;\n', 'utf8');
fs.writeFileSync(path.join(workspace, 'README.md'), '# demo\n\nA tiny workspace for PTC.\n', 'utf8');

const code = `
const found = await files.search({ query: 'TODO', path: 'src', target: 'content' });
const readme = await files.read({ path: 'README.md' });
return {
  todos: found.count,
  matches: found.matches,
  readmeLines: readme.totalLines
};
`;

const validation = validatePtcCode(code);
console.log(`[validate] ok=${validation.ok} errors=${validation.errors.length}`);
if (!validation.ok) {
  console.log(validation.errors);
  process.exitCode = 1;
} else {
  const result = await runPtcTool(
    { code, label: 'demo batch scan' },
    {
      workspace,
      session: { id: 'demo-session' },
      runId: 'demo-run',
      settings: { ptcAudit: false, ptcTimeoutMs: 5000 }
    }
  );
  console.log(result.text);
}

await shutdownPtc();
fs.rmSync(workspace, { recursive: true, force: true });
