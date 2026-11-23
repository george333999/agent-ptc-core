// Worker 提示词与权限。
// 关键约束：system prompt 只包含 DAG 级信息，必须在一整个 DAG 内保持字节稳定；
// 任务 ID、标题、简报、约束、上游结果等易变内容全部放到用户消息（前缀之后）。

export const READ_TOOL_NAMES = new Set(['list_files', 'read_file', 'search_files', 'read_tool_result']);
export const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'delete_file']);

export function buildWorkerSystemPrompt({ allowAskUser = false, ptc = false } = {}) {
  return [
    '你是由主 Agent 派发的独立子 Agent，只负责一个子任务。',
    '你没有完整对话历史，只能依据用户消息中的任务简报、约束、已知信息和工具读取结果工作。',
    '权限以任务简报的「允许修改」为准：只能修改其中列出的文件；未列出任何文件时你是只读子 Agent。禁止修改未列出的文件，禁止运行终端命令。',
    allowAskUser
      ? '如果任务简报缺少关键信息、无法从工作区确认，必须调用 ask_user 向用户提问；不要猜测。用户未回答时，把问题写入 open_questions 并把状态标为 partial。'
      : '如果任务简报缺少关键信息，不要猜测；把问题写入 open_questions 并把状态标为 partial。',
    ptc
      ? '当前开启 PTC 模式：只读检索请调用 ptc_run，用 await files.list({...}) / files.read({...}) / files.search({...}) 写一小段 async JavaScript 批量核实事实，再 return JSON 结果；同一子任务内 state 与会话内顶层变量可复用。数组遍历用 for...of，禁止 res[i] 这类动态下标。PTC 代码保持精简（建议不超过 40 行），不写注释，只读取必要字段。写文件仍使用直连的 write_file/edit_file。结果被蒸馏时用 read_tool_result 回读，不要重复执行同一段代码。不要臆造文件内容或证据。'
      : '使用 list_files、read_file、search_files 核实事实；工具结果被蒸馏时用 read_tool_result 按需回读。不要臆造文件内容或证据。',
    '读取大文件时使用 start_line/end_line 按需读取，避免一次性拉取整份大文件。',
    '缓存友好：任务 ID、当前时间、随机数、运行时变量和绝对路径只写在工具参数或 ptc_run 代码内部，不要写进本提示词或重复发送的前缀。',
    '完成后只输出一个 JSON 对象，不要输出 Markdown 代码块或额外解释；result 不超过 800 token，evidence 最多 6 条且每条不超过 200 字符：',
    '{"status":"completed|partial|failed","result":"结论","evidence":["文件:行号 或 工具事实"],"confidence":0.0,"open_questions":["未解决的疑问"]}',
    'confidence 是 0 到 1 的数字；没有证据时不要给高置信度。工具结果已足够回答时立即输出 JSON，不要额外验证或复述。'
  ].join('\n');
}

export function buildWorkerUserPrompt(task, plan, upstreamResults = []) {
  const constraints = Array.isArray(task.constraints) ? task.constraints : [];
  const readFiles = Array.isArray(task.readFiles) ? task.readFiles : [];
  const writeFiles = Array.isArray(task.writeFiles) ? task.writeFiles : [];
  const results = Array.isArray(upstreamResults) ? upstreamResults : [];
  const parts = [
    `# 总目标\n${plan.goal}`,
    `# 子任务\n[${task.id}] ${task.title}\n${task.brief}`,
    constraints.length ? `# 约束\n${constraints.map((item) => `- ${item}`).join('\n')}` : '',
    task.knownInfo ? `# 已知信息\n${task.knownInfo}` : '',
    readFiles.length ? `# 建议读取\n${readFiles.map((item) => `- ${item}`).join('\n')}` : '',
    writeFiles.length ? `# 允许修改\n${writeFiles.map((item) => `- ${item}`).join('\n')}` : '',
    `# 期望输出\n${task.expectedOutput}`,
    results.length
      ? `# 上游子任务结果\n${results.map((result) => [
          `## [${result.taskId}] ${result.title} — ${result.status}`,
          `结果：${clip(result.result, 1800)}`,
          result.evidence?.length ? `证据：${result.evidence.slice(0, 4).join('；')}` : '',
          typeof result.confidence === 'number' ? `置信度：${Math.round(result.confidence * 100)}%` : ''
        ].filter(Boolean).join('\n')).join('\n\n')}`
      : ''
  ];
  return parts.filter(Boolean).join('\n\n');
}

function clip(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（已截断，共 ${value.length} 字符）`;
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
export function filterWorkerTools(definitions, { hasWrites = false, allowAskUser = false, ptc = false } = {}) {
  const names = new Set(READ_TOOL_NAMES);
  if (hasWrites) {
    for (const name of WRITE_TOOL_NAMES) names.add(name);
  }
  if (allowAskUser) names.add('ask_user');
  if (ptc) names.add('ptc_run');
  return (Array.isArray(definitions) ? definitions : []).filter((definition) => names.has(definition?.function?.name));
}
