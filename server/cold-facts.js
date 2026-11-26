// Cold facts: deterministically extract "objective results that already happened" from tool events, such as which file was written or what command was run.
// Use: when this round's task needs to reference previous rounds, inject a small set of facts to prevent the model from re-reading files or re-executing.
// Constraints:
// - Extraction results are independent of input order (sorted by type + path), so the same input yields the same text;
// - No timestamps, random numbers, or absolute paths;
// - Total injection ≤ maxTokens (default 1000 tokens).

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

// Recover completed tool events from the message history, for deterministic cold-fact extraction.
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
  if (fact.type === 'file_written') return `- Wrote ${fact.path} (${fact.chars} characters)`;
  if (fact.type === 'file_edited') return `- Edited ${fact.path} (${fact.chars} characters)`;
  if (fact.type === 'file_read') return `- Read ${fact.path}`;
  if (fact.type === 'command_run') return `- Ran command: ${fact.command}`;
  if (fact.type === 'search') return `- Searched: ${fact.query}`;
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
  if (kept.length < lines.length) kept.push(`...(${lines.length} facts total, ${lines.length - kept.length} omitted)`);
  return kept.join('\n');
}

// Inject only when this round explicitly references previous rounds, to avoid consuming context every round.
export function buildColdFactBlock({ facts, message, maxTokens = 1000 } = {}) {
  if (!isOldTurnReference(message)) return '';
  const body = formatColdFacts(facts, { maxTokens });
  if (!body) return '';
  return [
    '## Confirmed facts (from earlier tool results in this session; reuse directly, no need to re-read)',
    body
  ].join('\n');
}
