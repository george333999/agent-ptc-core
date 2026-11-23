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
        '- await files.list({ path?, depth? }) -> { path, entries:[{path,type,size?}], truncated }',
        '- await files.read({ path, startLine?, endLine? }) -> { path, totalLines, startLine, endLine, content, truncated }',
        '- await files.readMany({ paths:[...], startLine?, endLine? }) -> { results:[{path,ok,file|code,message}], count, okCount }',
        '- await files.search({ query, path?, glob?, target?:"content"|"filename", caseSensitive? }) -> { query, matches:[{path,line,text}], count, truncated }',
        '',
        'Batch reads: use files.readMany for independent files, or Promise.all([...]) inside one ptc_run; both run concurrently so wall time is near the slowest read, not the sum.',
        '- await knowledge.search({ query, topK?, docName?, collection?, fileType? }) -> { query, count, results:[{docName,location,text,score,...}] }',
        '- await skills.read({ name }) -> { name, content, files }',
        '',
        'I-PTC state: across ptc_run calls in the same task, a persistent `state` object and top-level variables/functions are reused. Use `state.foo = ...`; pass reset:true to clear.',
        'Return a JSON-serializable value with `return`. Logs via log()/console.log() are collected.',
        'Limits: 60 tool calls, 40k code chars, 8s, no network/writes/shell, no new/class/import/this/process/dynamic property access. Write, edit, run_command, MCP and sub-agent tools remain direct tools.'
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
