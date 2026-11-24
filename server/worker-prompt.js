// Worker 提示词与权限。
// 关键约束：system prompt 只包含 DAG 级信息，必须在一整个 DAG 内保持字节稳定；
// 任务 ID、标题、简报、约束、上游结果等易变内容全部放到用户消息（前缀之后）。

export const READ_TOOL_NAMES = new Set(['list_files', 'read_file', 'search_files', 'read_tool_result']);
export const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'delete_file']);

// 说明：system prompt 必须与 allowAskUser/hasWrites 无关。
// 否则同一台机器上不同 DAG 会生成不同字节的前缀，直接丢掉跨 DAG 的供应商前缀缓存命中。
// “是否允许提问/写入”属于执行期权限，由 workerAllowedTools 与 assertWriteScope 拦截。
export function buildWorkerSystemPrompt({ ptc = false } = {}) {
  return [
    '你是由主 Agent 派发的独立子 Agent，只负责一个子任务。',
    '你没有完整对话历史，只能依据用户消息中的任务简报、约束、已知信息和工具读取结果工作。',
    '权限以任务简报的「允许修改」为准：只能修改其中列出的文件；未列出任何文件时你是只读子 Agent。禁止修改未列出的文件，禁止运行终端命令。',
    '工具列表中的 ask_user 只有在本子任务允许提问时才真正可用；任务简报缺少关键信息且无法从工作区确认时，优先调用 ask_user，不要猜测。若调用被拒绝或不可用，把问题写入 open_questions 并把状态标为 partial。',
    ptc
      ? '当前开启 PTC 模式：只读检索请调用 ptc_run，用 await files.list({...}) / files.read({...}) / files.readMany({...}) / files.search({...}) 写一小段 async JavaScript 批量核实事实，再 return JSON 结果；同一子任务内 state 与会话内顶层变量可复用。数组遍历用 for...of，禁止 res[i] 这类动态下标。PTC 代码保持精简（建议不超过 40 行），不写注释，只读取必要字段。文件密集时先用 files.search/files.list 缩小范围，再用 files.readMany 按 ≤50 个路径分批读取（可多次批读）；大文件（超过 800 行或 40KB）不要整份读取，先搜后按行读；程序内完成计数、去重、排序和字段裁剪，不要 return 原始全文（结果超过 24000 字符会被截断）。写文件仍使用直连的 write_file/edit_file。结果被蒸馏时用 read_tool_result 回读，不要重复执行同一段代码。不要臆造文件内容或证据。'
      : '使用 list_files、read_file、search_files 核实事实；工具结果被蒸馏时用 read_tool_result 按需回读。不要臆造文件内容或证据。',
    '读取大文件时使用 start_line/end_line 按需读取，避免一次性拉取整份大文件。',
    '缓存友好：任务 ID、当前时间、随机数、运行时变量和绝对路径只写在工具参数或 ptc_run 代码内部，不要写进本提示词或重复发送的前缀。',
    '完成后只输出一个 JSON 对象，不要输出 Markdown 代码块或额外解释；result 不超过 800 token，evidence 最多 6 条且每条不超过 200 字符：',
    '{"status":"completed|partial|failed","result":"结论","evidence":["文件:行号 或 工具事实"],"confidence":0.0,"open_questions":["未解决的疑问"]}',
    'confidence 是 0 到 1 的数字；没有证据时不要给高置信度。用户消息里已带预取正文时，先基于预取内容作答；只有缺少关键行、需要交叉验证或预取被截断时才调用工具。工具结果已足够回答时立即输出 JSON，不要额外验证或复述。'
  ].join('\n');
}

// 每个 Worker 专属尾部的硬预算：前缀是共享的，尾部越短，首轮缓存命中率越高。
// 这些默认值都可以用 settings.tokenOpt 覆盖。
export const DEFAULT_WORKER_TAIL_CHARS = 4000;
export const DEFAULT_WORKER_UPSTREAM_CHARS = 1000;
export const DEFAULT_WORKER_UPSTREAM_TOTAL_CHARS = 2000;
export const MIN_WORKER_PROMPT_CHARS = 2000;

function hardClip(text, limit) {
  const value = String(text ?? '');
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

function buildUpstreamSection(results, { perResultChars, totalChars }) {
  if (!results.length || perResultChars <= 0 || totalChars <= 0) return '';
  const lines = [];
  let used = 0;
  for (const result of results) {
    const block = [
      `## [${result.taskId}] ${result.title} — ${result.status}`,
      `结果：${hardClip(result.result, perResultChars)}`,
      result.evidence?.length ? `证据：${hardClip(result.evidence.slice(0, 4).join('；'), 400)}` : '',
      typeof result.confidence === 'number' ? `置信度：${Math.round(result.confidence * 100)}%` : ''
    ].filter(Boolean).join('\n');
    const cost = block.length + 2;
    if (used + cost > totalChars) {
      if (used >= totalChars * 0.6) break;
      const remaining = Math.max(0, totalChars - used - 2);
      if (remaining < 120) break;
      lines.push(hardClip(block, remaining));
      used = totalChars;
      break;
    }
    lines.push(block);
    used += cost;
  }
  return lines.length ? `# 上游子任务结果\n${lines.join('\n\n')}` : '';
}

export function buildWorkerUserPrompt(task, plan, upstreamResults = [], options = {}) {
  const constraints = (Array.isArray(task?.constraints) ? task.constraints : []).slice(0, 8);
  const readFiles = (Array.isArray(task?.readFiles) ? task.readFiles : []).slice(0, 16);
  const writeFiles = (Array.isArray(task?.writeFiles) ? task.writeFiles : []).slice(0, 16);
  const results = Array.isArray(upstreamResults) ? upstreamResults : [];
  const maxChars = Math.max(600, Math.floor(Number(options.maxChars) || DEFAULT_WORKER_TAIL_CHARS));
  const upstreamPer = Math.max(0, Math.floor(Number(options.upstreamChars ?? DEFAULT_WORKER_UPSTREAM_CHARS)));
  const upstreamTotal = Math.max(0, Math.floor(Number(options.upstreamTotalChars ?? DEFAULT_WORKER_UPSTREAM_TOTAL_CHARS)));

  // 优先级从高到低：任务本身与写权限必须保留，其余按剩余预算贪心加入。
  const permissionLine = writeFiles.length
    ? `# 允许修改\n${writeFiles.map((item) => `- ${item}`).join('\n')}`
    : '# 权限\n本子任务只读：不要调用 write_file/edit_file/delete_file，写入会被拒绝。';
  const askLine = options.allowAskUser === false
    ? '# 提问\n本子任务不能调用 ask_user；信息不足时写入 open_questions 并标记 partial。'
    : '';
  const sections = [
    [
      `# 总目标\n${hardClip(plan?.goal, 300)}`,
      `# 子任务\n[${task?.id}] ${task?.title}\n${hardClip(task?.brief, 1200)}`,
      `# 期望输出\n${hardClip(task?.expectedOutput, 500)}`
    ].join('\n\n'),
    permissionLine,
    askLine,
    readFiles.length ? `# 建议读取\n${readFiles.map((item) => `- ${item}`).join('\n')}` : '',
    constraints.length ? `# 约束\n${constraints.map((item) => `- ${hardClip(item, 240)}`).join('\n')}` : '',
    task?.knownInfo ? `# 已知信息\n${hardClip(task.knownInfo, 800)}` : '',
    buildUpstreamSection(results, { perResultChars: upstreamPer, totalChars: upstreamTotal })
  ].filter(Boolean);

  const chunks = [];
  let used = 0;
  for (const section of sections) {
    const cost = (chunks.length ? 2 : 0) + section.length;
    if (used + cost <= maxChars) {
      chunks.push(section);
      used += cost;
      continue;
    }
    // 预算不足时只裁剪当前这一段；裁剪后剩余空间太小就停止追加。
    const remaining = maxChars - used - (chunks.length ? 2 : 0);
    if (remaining < 160) break;
    chunks.push(hardClip(section, remaining));
    used = maxChars;
  }
  // 极端情况（任务描述本身超长）保证总长度不超过预算。
  return hardClip(chunks.join('\n\n'), maxChars);
}

// 某个子任务真正允许调用的工具（执行期权限，与 schema 保持一致）。
// PTC 模式下只读工具不再直连暴露，必须走 ptc_run。
export function workerAllowedTools(task, { allowAskUser = false, ptc = false } = {}) {
  const names = new Set(ptc ? [] : READ_TOOL_NAMES);
  // read_tool_result 是回读按需蒸馏结果的直连工具，PTC 模式下也必须可用。
  names.add('read_tool_result');
  if ((task?.writeFiles || []).length) {
    for (const name of WRITE_TOOL_NAMES) names.add(name);
  }
  if (allowAskUser) names.add('ask_user');
  if (ptc) names.add('ptc_run');
  return names;
}

// DAG 级固定工具集：同一 DAG 内所有 Worker 共用同一份 schema 字节。
// 单个 Worker 没有写权限时，执行期仍由 workerAllowedTools 拦截，不影响安全边界。
// 规范工具集：只由 toolMode 决定，与本次 DAG 是否有写入、是否允许提问完全无关。
// 目的：让同一台机器上所有 Worker 请求共享完全相同的 tools 字节，从而跨 DAG 命中供应商前缀缓存。
// 权限边界仍在执行期：workerAllowedTools 决定“能调用什么”，assertWriteScope 校验写入路径。
// hasWrites / allowAskUser 参数仅为兼容旧调用保留，不参与 schema 过滤。
export function filterWorkerTools(definitions, { ptc = false } = {}) {
  // PTC 模式下只读工具通过 ptc_run 调用，schema 里只保留回读入口 read_tool_result；
  // 否则每个 Worker 的每一步都要为未使用的原生只读 schema 付 prefill 成本。
  const names = new Set(ptc ? ['read_tool_result'] : READ_TOOL_NAMES);
  for (const name of WRITE_TOOL_NAMES) names.add(name);
  names.add('ask_user');
  if (ptc) names.add('ptc_run');
  return (Array.isArray(definitions) ? definitions : []).filter((definition) => names.has(definition?.function?.name));
}
