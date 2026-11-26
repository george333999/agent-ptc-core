// Parallel execution strategy for read-only tools.
// Design principles:
// 1) Only side-effect-free, mutually independent read-only tools may run in parallel;
// 2) Consecutive read-only calls merge into one batch; a write tool/terminal/orchestration/question interrupts immediately to preserve semantic order;
// 3) Parallel results are returned in the original order; callers still handle UI, distillation, and failure counts in that order.

export const PARALLEL_SAFE_TOOLS = Object.freeze(new Set([
  'list_files',
  'read_file',
  'read_tool_result',
  'search_files',
  'knowledge_search',
  'fetch_url',
  'web_search',
  'read_skill',
  'task'
]));

export function isParallelSafeTool(name) {
  return PARALLEL_SAFE_TOOLS.has(String(name || ''));
}

// Return index batches of "consecutive safe calls"; a single call is also returned as a batch of length 1.
// For example, [read, read, write, read] -> [[0,1],[2],[3]].
export function planToolBatches(calls, isSafe = (call) => isParallelSafeTool(call?.name ?? call)) {
  const list = Array.isArray(calls) ? calls : [];
  const batches = [];
  let index = 0;
  while (index < list.length) {
    if (!isSafe(list[index], index)) {
      batches.push([index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < list.length && isSafe(list[end], end)) end += 1;
    const run = [];
    for (let cursor = index; cursor < end; cursor += 1) run.push(cursor);
    batches.push(run);
    index = end;
  }
  return batches;
}

// Run one batch in parallel; a single failing call never affects the others, and results keep input order.
export async function runToolBatch(calls, runner) {
  const list = Array.isArray(calls) ? calls : [];
  return Promise.all(list.map(async (call, index) => {
    const startedAt = Date.now();
    try {
      const value = await runner(call, index);
      return { call, index, ok: true, value, startedAt, finishedAt: Date.now() };
    } catch (error) {
      return { call, index, ok: false, error, startedAt, finishedAt: Date.now() };
    }
  }));
}
