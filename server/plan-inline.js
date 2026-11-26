// Plan inlining: for non-destructive tasks the model may emit both the plan text and its first batch
// of tool calls in a single assistant message, avoiding an extra model round trip just to confirm the
// plan. Destructive plans (that write files / run commands) still go through approval.
//
// Compatibility fallback: some providers/models do not support returning multiple tool_calls in one
// message. In that case only the first call is kept; the remaining calls become a text note and are
// sent in the next round, keeping the request valid.

const WRITE_HINTS = /(?:write_file|edit_file|delete_file|run_command|写入|修改|删除|覆盖|移动|重命名|执行命令|运行命令)/i;

export function parseInlinePlan(content) {
  const text = String(content || '').trim();
  if (!text) return { isPlan: false, steps: [] };
  const lines = text.split('\n');
  const steps = [];
  for (const line of lines) {
    const match = /^\s*(?:[-*]\s*\[[ xX]\]|(?:第?\s*)?\d+[.、)）]\s*)(.+)$/.exec(line);
    if (match) steps.push(match[1].trim());
  }
  const isPlan = steps.length >= 2 || /(?:执行计划|计划如下|steps?)/i.test(text);
  return { isPlan, steps };
}

export function isDestructivePlan(plan) {
  if (!plan || typeof plan !== 'object') return false;
  const risks = Array.isArray(plan.risks) ? plan.risks.join(' ') : String(plan.risks || '');
  if (WRITE_HINTS.test(risks)) return true;
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  return steps.some((step) => {
    if (typeof step === 'string') return WRITE_HINTS.test(step);
    const detail = [step?.title, step?.detail, ...(Array.isArray(step?.files) ? step.files : [])]
      .filter(Boolean)
      .join(' ');
    return WRITE_HINTS.test(detail);
  });
}

// Inlining requires all of: a non-destructive task, an actual plan in the content, and the model having already started calling tools.
export function shouldInlinePlan({ plan, content = '', toolCalls = [] } = {}) {
  if (isDestructivePlan(plan)) return false;
  const parsed = parseInlinePlan(content);
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  return parsed.isPlan && calls.length > 0;
}

/**
 * Compatibility normalization:
 * - When supportsParallelToolCalls is true, return as-is;
 * - When it is false and multiple calls are returned at once, keep only the first and turn the rest into deferred.
 */
export function resolveInlinePlan({ content = '', toolCalls = [], supportsParallelToolCalls = true } = {}) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  if (supportsParallelToolCalls || calls.length <= 1) {
    return { content, toolCalls: calls, inlined: true, deferred: [], fallback: '' };
  }
  const [first, ...rest] = calls;
  const names = rest.map((call) => call?.name || 'tool').join(', ');
  return {
    content: [
      content,
      rest.length ? `(The current model does not support parallel tool calls in a single message, so ${first?.name || 'the first tool'} was executed first; the remaining ${names} will follow in the next step.)` : ''
    ].filter(Boolean).join('\n'),
    toolCalls: first ? [first] : [],
    inlined: true,
    deferred: rest,
    fallback: 'serialize_tool_calls'
  };
}
