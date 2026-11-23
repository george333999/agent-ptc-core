// 冷事实：从工具事件里确定性抽取“已发生的客观结果”，例如写过哪个文件、跑过什么命令。
// 用途：当本轮任务需要引用旧轮次时，注入一小段事实，避免模型重新读文件或重复执行。
// 约束：
// - 抽取结果与输入顺序无关（按类型 + 路径排序），同一输入得到同一文本；
// - 不包含时间戳、随机数、绝对路径；
// - 注入总量 ≤ maxTokens（默认 1000 token）。

const OLD_TURN_PATTERNS = /(?:之前|上次|刚才|刚刚|前面|早先|此前|历史|上一轮|上一步|先前|刚才说|前面提到|继续之前|那个文件|那个结果)/;

function safePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .slice(0, 200);
}

function factKey(fact) {
  return `${fact.type}|${fact.path || fact.command || fact.query || ''}`;
}

export function extractColdFacts(toolCalls, { limit = 40 } = {}) {
  const facts = new Map();
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const name = String(call?.name || '');
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    const failed = call?.status === 'error' || call?.status === 'denied';
    if (failed) continue;
    if (name === 'write_file' || name === 'edit_file') {
      const path = safePath(args.path);
      if (!path) continue;
      const content = String(args.content ?? args.new_string ?? args.newText ?? '');
      const fact = {
        type: name === 'write_file' ? 'file_written' : 'file_edited',
        path,
        chars: content.length || Number(args.chars) || 0
      };
      facts.set(factKey(fact), fact);
    } else if (name === 'read_file') {
      const path = safePath(args.path);
      if (!path) continue;
      const fact = { type: 'file_read', path };
      facts.set(factKey(fact), fact);
    } else if (name === 'run_command') {
      const command = String(args.command || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!command) continue;
      const fact = { type: 'command_run', command };
      facts.set(factKey(fact), fact);
    } else if (name === 'search_files') {
      const query = String(args.query || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!query) continue;
      const fact = { type: 'search', query };
      facts.set(factKey(fact), fact);
    }
  }
  return [...facts.values()]
    .sort((left, right) => factKey(left).localeCompare(factKey(right)))
    .slice(0, Math.max(1, Number(limit) || 40));
}

export function isOldTurnReference(message) {
  return OLD_TURN_PATTERNS.test(String(message || ''));
}

// 从历史消息里回收已完成的工具事件，用于确定性抽取冷事实。
export function collectToolCallsFromMessages(messages) {
  const calls = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'assistant' || !Array.isArray(message.toolCalls)) continue;
    for (const call of message.toolCalls) {
      if (!call?.name) continue;
      if (call.status === 'running' || call.status === 'pending') continue;
      calls.push({ name: call.name, args: call.args, status: call.status || 'completed' });
    }
  }
  return calls;
}

function factLine(fact) {
  if (fact.type === 'file_written') return `- 已写入 ${fact.path}（${fact.chars} 字符）`;
  if (fact.type === 'file_edited') return `- 已编辑 ${fact.path}（${fact.chars} 字符）`;
  if (fact.type === 'file_read') return `- 已读取 ${fact.path}`;
  if (fact.type === 'command_run') return `- 已运行命令：${fact.command}`;
  if (fact.type === 'search') return `- 已搜索：${fact.query}`;
  return '';
}

export function formatColdFacts(facts, { maxTokens = 1000 } = {}) {
  if (!(Number(maxTokens) > 0)) return '';
  const lines = (Array.isArray(facts) ? facts : []).map(factLine).filter(Boolean);
  if (!lines.length) return '';
  const budgetChars = Math.max(200, Math.floor(Number(maxTokens) * 2.5));
  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budgetChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (!kept.length) return '';
  if (kept.length < lines.length) kept.push(`…（共 ${lines.length} 条事实，已省略 ${lines.length - kept.length} 条）`);
  return kept.join('\n');
}

// 只有本轮明确引用旧轮次时才注入，避免每轮都重复占用上下文。
export function buildColdFactBlock({ facts, message, maxTokens = 1000 } = {}) {
  if (!isOldTurnReference(message)) return '';
  const body = formatColdFacts(facts, { maxTokens });
  if (!body) return '';
  return [
    '## 已确认事实（来自本会话较早的工具结果，可直接复用，不必重新读取）',
    body
  ].join('\n');
}
