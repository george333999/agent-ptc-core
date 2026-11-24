// 主 Agent 的任务契约：苏格拉底式自检、可验证完成判据、关键假设。
// 位置约束：自检块只追加到当前用户消息尾部，不改 system/tools 前缀，避免破坏供应商前缀缓存。
// 分工约束：只由主 Agent 自检；子 Agent 不自问，只消费下发的完成判据与假设，避免重复推理成本。

export const SOCRATIC_QUESTIONS = Object.freeze([
  '真实目标是什么？什么算完成（可验证的结束条件）？',
  '已知什么、未知什么、默认了哪些假设？',
  '最可能失败、超时或返工的点是什么？',
  '哪种方法最优？为什么不用主要替代方案？',
  '下一步做什么？哪些要委托给子 Agent？'
]);

export const CONTRACT_LIST_MAX = 6;
export const CONTRACT_ITEM_MAX = 240;

export function shouldUseSocraticBrief({ mode = 'chat', complexTask = false, settings = {} } = {}) {
  // 只在 Agent 的复杂任务上做自检：Chat 是轻量问答，简单任务加自检只会增加首包延迟与 token。
  return mode === 'agent' && complexTask === true && settings?.socraticBrief !== false;
}

// 固定文本，不含时间、任务 ID 等易变内容；只进入当前轮用户消息尾部。
export function buildSocraticBrief() {
  return [
    '[任务自检 · 只在内部完成，不要输出过程]',
    '执行前先回答这 5 个问题，并把结论直接带进后续动作：',
    ...SOCRATIC_QUESTIONS.map((question, index) => `${index + 1}. ${question}`),
    '落地要求：复杂任务先用 propose_plan（goal=真实目标，steps[].detail 写完成判据，definitionOfDone 写可验证结束条件，assumptions 写关键假设，risks 写风险与取舍）；需要编排时把 definitionOfDone 与 assumptions 写入 orchestrate，子任务 brief 必须能让子 Agent 独立执行。',
    '约束：不要为自检额外调用工具；不要输出自检过程；不要因为自检扩大任务范围。',
    '澄清边界：任务已明确到具体文件/目录且能推断完成判据时，不要用 ask_user 重复确认；只有缺失会改变产物的关键信息时才提问。'
  ].join('\n');
}

function normalizeList(value, { max = CONTRACT_LIST_MAX, itemMax = CONTRACT_ITEM_MAX } = {}) {
  const raw = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value]);
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    const text = String(item ?? '').replace(/\s+/g, ' ').trim().slice(0, itemMax);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= max) break;
  }
  return result;
}

export function normalizeContract(input = {}) {
  return {
    definitionOfDone: normalizeList(input?.definitionOfDone ?? input?.done),
    assumptions: normalizeList(input?.assumptions)
  };
}

export function deriveDefinitionOfDone() {
  return ['所有子任务返回 completed，且每个子任务的 expectedOutput 均已产出'];
}

// 编排计划必须有可执行的完成判据：模型未给出时使用确定性兜底，而不是留空。
export function contractForOrchestration(input = {}) {
  const contract = normalizeContract(input);
  return {
    definitionOfDone: contract.definitionOfDone.length
      ? contract.definitionOfDone
      : deriveDefinitionOfDone(),
    assumptions: contract.assumptions
  };
}

function hardClip(text, limit) {
  const value = String(text ?? '');
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

export function renderDefinitionOfDone(list, { maxChars = 400 } = {}) {
  const items = normalizeList(list);
  if (!items.length) return '';
  return hardClip(`# 完成判据\n${items.map((item) => `- ${item}`).join('\n')}`, maxChars);
}

export function renderAssumptions(list, { maxChars = 400 } = {}) {
  const items = normalizeList(list);
  if (!items.length) return '';
  return hardClip(`# 关键假设\n${items.map((item) => `- ${item}`).join('\n')}`, maxChars);
}
