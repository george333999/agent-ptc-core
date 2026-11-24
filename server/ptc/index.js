import { PtcEngine } from './engine.js';

// PTC 对外入口：只暴露一个窄工具 ptc_run，其余只读工具通过沙盒内的类型化 API 调用。

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

// 任务开始时异步预热沙盒：与第一次模型调用重叠，避免等到 ptc_run 才冷启。
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
 * 执行 ptc_run 工具调用。
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

// 预算决策与校验恢复属于 PTC 的配套协议，随 ./ptc 子路径一起暴露。
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
