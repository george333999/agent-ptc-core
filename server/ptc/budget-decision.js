// User decision protocol after the PTC budget is exhausted: continue PTC, switch to traditional Agent tools, or type another request.
// Extracted into a standalone module to keep agent.js from growing further; events and wait functions are injected as parameters for unit testing.

export const PTC_BUDGET_DECISION_TIMEOUT_MS = 300000;
export const PTC_BUDGET_OPTIONS = [
  'Continue calling PTC as the model suggested',
  'Stop using PTC and switch to traditional Agent tools',
  'Other (enter your request below)'
];
export const PTC_CONTINUE_NUDGE = [
  'System reminder: the user chose to continue using PTC.',
  'Please continue with the unfinished parts: each ptc_run is still split into no more than 100 tool calls; prefer files.readMany for batch reads;',
  'do not repeat calls already confirmed complete; write cross-chunk progress into state or return it inside the successful chunk.'
].join('');
export const PTC_NATIVE_NUDGE = [
  'System reminder: the user chose to stop using PTC.',
  'From now on do not call ptc_run; switch to direct tools (read_file, search_files, list_files, edit_file, write_file, run_command, etc.) to finish the task,',
  'and provide the final result when done.'
].join('');

export function classifyPtcBudgetAnswer(answer = '') {
  const text = String(answer || '').trim();
  if (!text) return 'continue';
  if (text === PTC_BUDGET_OPTIONS[0]) return 'continue';
  if (text === PTC_BUDGET_OPTIONS[1]) return 'native';
  // When the text explicitly says "stop PTC" or "switch to traditional/native tools", switch to direct tools; other supplementary requests default to continuing PTC.
  const stopPtc = /(?:不用|不使用|停止|停用|关闭|禁用|放弃|别用)\s*(?:再)?\s*(?:使用)?\s*(?:ptc|程序化|工具调用)/i;
  const nativeMode = /(?:改用|换成|切换到|使用|用)\s*(?:传统|原生|直连工具|常规工具|native)/i;
  if (stopPtc.test(text) || nativeMode.test(text)) return 'native';
  return 'continue';
}

// Ask the user through a clarification card; the caller must provide runtime dependencies such as emit/persist/waitForClarification.
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
      meta: { ...toolMeta('ptc_run'), label: 'PTC budget' },
      result: 'The PTC single-run tool-call budget is exhausted; waiting for the user to choose how to proceed.',
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
  const question = 'The PTC tool-call budget for this run is exhausted, but the task is not finished. Choose how to proceed:';
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
