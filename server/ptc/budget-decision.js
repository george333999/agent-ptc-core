// PTC 预算用尽后的用户决策协议：继续 PTC、切换传统 Agent 工具，或输入其它要求。
// 抽成独立模块，避免 agent.js 继续膨胀；事件与等待函数通过参数注入，便于单测。

export const PTC_BUDGET_DECISION_TIMEOUT_MS = 300000;
export const PTC_BUDGET_OPTIONS = [
  '继续按模型建议调用 PTC',
  '停止使用 PTC，改用传统 Agent 工具',
  '其它（在下方输入要求）'
];
export const PTC_CONTINUE_NUDGE = [
  '系统提醒：用户选择继续使用 PTC。',
  '请继续完成未完成的部分：单次 ptc_run 仍按不超过 100 次工具调用拆分，优先使用 files.readMany 批量读取；',
  '不要重复已经确认完成的调用，跨块进度写入 state 或在成功块内返回。'
].join('');
export const PTC_NATIVE_NUDGE = [
  '系统提醒：用户已选择停止使用 PTC。',
  '从现在起不要再调用 ptc_run；请改用直连工具（read_file、search_files、list_files、edit_file、write_file、run_command 等）继续完成任务，',
  '并在完成后给出最终结果。'
].join('');

export function classifyPtcBudgetAnswer(answer = '') {
  const text = String(answer || '').trim();
  if (!text) return 'continue';
  if (text === PTC_BUDGET_OPTIONS[0]) return 'continue';
  if (text === PTC_BUDGET_OPTIONS[1]) return 'native';
  // 明确表达“停用 PTC”或“改用传统/原生工具”时切换到直连工具；其它补充要求默认继续 PTC。
  const stopPtc = /(?:不用|不使用|停止|停用|关闭|禁用|放弃|别用)\s*(?:再)?\s*(?:使用)?\s*(?:ptc|程序化|工具调用)/i;
  const nativeMode = /(?:改用|换成|切换到|使用|用)\s*(?:传统|原生|直连工具|常规工具|native)/i;
  if (stopPtc.test(text) || nativeMode.test(text)) return 'native';
  return 'continue';
}

// 通过澄清卡片询问用户；调用方需提供 emit/persist/waitForClarification 等运行时依赖。
export async function askPtcBudgetDecision({
  assistant,
  session,
  deviceId = '',
  signal,
  emit,
  persist,
  addApprovalWaitMs = () => {},
  waitForClarification,
  newId,
  toolMeta
}) {
  let anchor = [...(assistant.toolCalls || [])].reverse().find((call) => call?.name === 'ptc_run');
  if (!anchor) {
    anchor = {
      id: newId('c_'),
      name: 'ptc_budget',
      args: {},
      argsText: '{}',
      modelArgsText: '{}',
      status: 'completed',
      meta: { ...toolMeta('ptc_run'), label: 'PTC 预算' },
      result: 'PTC 单次工具调用预算已用尽，等待用户选择后续处理方式。',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      virtual: true
    };
    assistant.toolCalls = Array.isArray(assistant.toolCalls) ? assistant.toolCalls : [];
    assistant.toolCalls.push(anchor);
    emit('tool_call', {
      messageId: assistant.id,
      callId: anchor.id,
      name: anchor.name,
      args: anchor.args,
      meta: anchor.meta
    });
    emit('tool_result', {
      messageId: assistant.id,
      callId: anchor.id,
      status: 'completed',
      output: anchor.result,
      meta: anchor.meta
    });
  }
  const questionId = newId('ask_');
  const question = 'PTC 本次工具调用预算已用尽，但任务还没有完成。请选择后续处理方式：';
  const interaction = {
    type: 'question',
    questionId,
    question,
    options: PTC_BUDGET_OPTIONS,
    allowFreeText: true,
    status: 'pending',
    timeoutMs: PTC_BUDGET_DECISION_TIMEOUT_MS
  };
  anchor.interaction = interaction;
  emit('clarify_request', {
    messageId: assistant.id,
    callId: anchor.id,
    questionId,
    question,
    options: PTC_BUDGET_OPTIONS,
    allowFreeText: true,
    timeoutMs: PTC_BUDGET_DECISION_TIMEOUT_MS
  });
  const startedAt = Date.now();
  const response = await waitForClarification({
    questionId,
    deviceId,
    signal,
    timeoutMs: PTC_BUDGET_DECISION_TIMEOUT_MS
  });
  addApprovalWaitMs(Date.now() - startedAt);
  interaction.status = response.answered ? 'answered' : response.timeout ? 'timeout' : 'aborted';
  interaction.answer = response.answer || '';
  emit('clarify_resolved', {
    messageId: assistant.id,
    callId: anchor.id,
    questionId,
    answered: response.answered,
    answer: response.answer,
    timeout: Boolean(response.timeout),
    aborted: Boolean(response.aborted)
  });
  persist(session);
  if (response.aborted) return { action: 'stop', reason: 'aborted', answer: '' };
  if (!response.answered) return { action: 'stop', reason: 'timeout', answer: '' };
  return { action: classifyPtcBudgetAnswer(response.answer), answer: String(response.answer || '') };
}
