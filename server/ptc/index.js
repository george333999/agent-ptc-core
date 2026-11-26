import { PtcEngine } from './engine.js';

// PTC external entry point: exposes only one narrow tool, ptc_run; all other read-only tools are called through typed APIs inside the sandbox.

export { PTC_PROGRAMMATIC_TOOLS } from './specs.js';
export { PtcEngine } from './engine.js';
export { validatePtcCode } from './ast-validator.js';

let engine = null;

export function getPtcEngine() {
  if (!engine) engine = new PtcEngine();
  return engine;
}

export function setPtcEngine(customEngine) {
  engine = customEngine || null;
}

export async function shutdownPtc() {
  if (!engine) return;
  const current = engine;
  engine = null;
  await current.shutdown();
}

export async function disposePtcRun(runId) {
  if (!engine || !runId) return;
  await engine.disposeRun(runId);
}

export async function disposePtcScope(scope) {
  if (!engine || !scope) return;
  await engine.disposeScope(scope);
}

// Asynchronously prewarm the sandbox at task start: overlaps with the first model call, avoiding a cold start when ptc_run arrives.
export async function prewarmPtc(ctx = {}) {
  try {
    return await getPtcEngine().prewarm(ctx);
  } catch {
    return null;
  }
}

export function buildPtcToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'ptc_run',
      description: [
        'Run ONE short async JavaScript program that orchestrates READ-ONLY workspace tools inside a sandbox. Prefer this over many separate list_files/read_file/search_files round-trips whenever the task can be expressed as a program (filter, map, aggregate, batch reads).',
        '',
        'Typed API (await every call; returns canonical JSON, not rendered text):',
        '- await files.list({ path?, depth?, offset?, limit? }) -> { path, entries:[{path,type,size?}], count, offset, limit, truncated, nextOffset? }; max 400 entries per page; pass nextOffset to enumerate larger folders',
        '- await files.read({ path, startLine?, endLine? }) -> { path, totalLines, startLine, endLine, content, truncated }; content capped at 500k chars',
        '- await files.readMany({ paths:[...], startLine?, endLine? }) -> { results:[{path,ok,file|code,message}], count, okCount }; max 50 paths, duplicate paths read once, one failed file does not fail the batch',
        '- await files.search({ query, path?, glob?, target?:"content"|"filename", caseSensitive?, regex? }) -> { query, matches:[{path,line,text}], count, skippedLarge, truncated, hint? }; max 200 matches over 4000 files; content search skips files over 1MB (2MB for a single file) and reports skippedLarge',
        '- await knowledge.search({ query, topK?, docName?, collection?, fileType? }) -> { query, count, results:[{docName,location,text,score,...}] }',
        '- await skills.read({ name }) -> { name, content, files }',
        '',
        'File-dense tasks: locate first with files.search or files.list, then read in batches with files.readMany (or Promise.all). I/O is async and bounded, so wall time is near the slowest batch, not the sum. You may call readMany several times inside one ptc_run (100-call budget). Map results to compact fields (path, line, count, matched text, short head) inside the program; never return full contents of many files. The ptc_run result is capped at 24000 chars, so bulk contents are cut.',
        'Large files: above ~800 lines or 40KB, do NOT read the whole file. Use files.search to locate lines, then files.read with startLine/endLine. Return at most ~20 full files per ptc_run; prefer search plus selective ranges for wide scans.',
        'Anti-pattern (forbidden): repeatedly reading the same file with endLine increasing by 1, or reading the same range twice. If a read is truncated or you need more context, request the full file once (endLine: 2000) or a clearly larger range, or use files.search to locate the exact lines. Plan one batch of files/ranges before calling; never use ptc_run as a line-by-line viewer.',
        'Once a deliverable is written, stop exploring: do not re-read the generated script line by line to check it. Run or validate the file, or return the final result.',
        '',
        'I-PTC state: across ptc_run calls in the same task, a persistent `state` object and top-level variables/functions are reused. Use `state.foo = ...`; pass reset:true to clear.',
        'Reuse results already available in the conversation (earlier tool outputs, summaries, previous turns) instead of re-reading the same files; only re-read when content is missing or may have changed.',
        'Return a JSON-serializable value with `return`. Logs via log()/console.log() are collected.',
        'Limits: 100 tool calls, 40k code chars, 8s wall clock, no network/writes/shell, no class/import/this/process/dynamic property access or absolute paths. Regex literals like /\\.md$/ are allowed; `new` is limited to standard built-ins (Set, Map, Date, RegExp, Error, Array, Object, Promise). Write, edit, run_command, MCP and sub-agent tools remain direct tools.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Async JavaScript body, e.g. "const r = await files.search({query:"TODO"}); return r.matches.slice(0,20);". Use return for the final value.'
          },
          reset: {
            type: 'boolean',
            description: 'Reset the persistent I-PTC namespace before running. Default false.'
          },
          label: {
            type: 'string',
            description: 'Optional short description of this orchestration for logs.'
          }
        },
        required: ['code']
      }
    }
  };
}

/**
 * Execute a ptc_run tool call.
 * @returns {Promise<{text:string, meta:Object}>}
 */
export async function runPtcTool(args = {}, ctx = {}) {
  const code = typeof args?.code === 'string' ? args.code : '';
  return getPtcEngine().run(code, ctx, {
    traceId: ctx.ptcTraceId || '',
    reset: args?.reset === true,
    timeoutMs: ctx.settings?.ptcTimeoutMs
  });
}

// Budget decisions and validation recovery are companion protocols of PTC, exposed together with the ./ptc subpath.
export {
  MAX_PTC_VALIDATION_NUDGES,
  MAX_PTC_VALIDATION_FAILURES,
  isPtcValidationFailure,
  ptcValidationAction,
  ptcFallbackAction,
  PTC_FALLBACK_NUDGE,
  ptcValidationHint,
  ptcValidationNudge,
  ptcValidationFinal
} from './validation.js';

export {
  PTC_BUDGET_DECISION_TIMEOUT_MS,
  PTC_BUDGET_OPTIONS,
  PTC_CONTINUE_NUDGE,
  PTC_NATIVE_NUDGE,
  classifyPtcBudgetAnswer,
  askPtcBudgetDecision
} from './budget-decision.js';
