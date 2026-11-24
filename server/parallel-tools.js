// 只读工具并行执行策略。
// 设计原则：
// 1) 只有无副作用、彼此独立的只读工具允许并行；
// 2) 连续的只读调用合并为一批，遇到写工具/终端/编排/提问立即打断，保证语义顺序；
// 3) 并行结果按原顺序返回，调用方仍按原顺序处理 UI、蒸馏与失败计数。

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

// 返回“连续安全调用”的索引批次；单次调用也会作为长度为 1 的批次返回。
// 例如 [read, read, write, read] -> [[0,1],[2],[3]]。
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

// 并行执行一批调用；任何单个调用失败都不会影响其他调用，结果顺序与输入一致。
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
