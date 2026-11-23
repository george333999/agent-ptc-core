// 计划内联：非破坏性任务允许模型在“同一条 assistant 消息”里同时给出计划文本与首批工具调用，
// 避免为了计划确认额外多跑一轮模型。破坏性（会写文件/执行命令）的计划仍然走审批。
//
// 兼容性回退：部分供应商/模型不支持一条消息多个 tool_calls 并行返回，
// 此时只保留第一个调用，其余调用转成文本提示，等下一轮再发，保证请求合法。

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

// 允许内联的充要条件：任务非破坏性、内容里确实有计划、且模型已开始调用工具。
export function shouldInlinePlan({ plan, content = '', toolCalls = [] } = {}) {
  if (isDestructivePlan(plan)) return false;
  const parsed = parseInlinePlan(content);
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  return parsed.isPlan && calls.length > 0;
}

/**
 * 兼容性归一：
 * - supportsParallelToolCalls 为 true 时原样返回；
 * - 为 false 且一次返回多个调用时，只保留第一个，其余转成 deferred。
 */
export function resolveInlinePlan({ content = '', toolCalls = [], supportsParallelToolCalls = true } = {}) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  if (supportsParallelToolCalls || calls.length <= 1) {
    return { content, toolCalls: calls, inlined: true, deferred: [], fallback: '' };
  }
  const [first, ...rest] = calls;
  const names = rest.map((call) => call?.name || 'tool').join('、');
  return {
    content: [
      content,
      rest.length ? `（当前模型不支持单条消息并行工具调用，已先执行 ${first?.name || '第一个工具'}，后续 ${names} 将在下一步继续。）` : ''
    ].filter(Boolean).join('\n'),
    toolCalls: first ? [first] : [],
    inlined: true,
    deferred: rest,
    fallback: 'serialize_tool_calls'
  };
}
