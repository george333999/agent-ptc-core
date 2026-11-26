// Token savings prediction model (for pre-A/B magnitude estimation, not a replacement for real billing data).
// Assumption: in native mode each model reply issues only one tool call; in PTC mode one programmatic call completes N operations.
// The token estimate uses a mixed-text heuristic: CJK about 1.5 tokens/char, the rest about 4 chars/token.

export function estimateTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  let cjk = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk += 1;
  }
  const rest = value.length - cjk;
  return Math.ceil(cjk * 1.5 + rest / 4);
}

/**
 * Compute predicted token consumption for native per-call execution versus PTC orchestration.
 * @param {Object} input
 * @param {number} input.calls Number of tool operations
 * @param {number} [input.avgArgsTokens] Argument tokens per call
 * @param {number} [input.avgResultTokens] Tool result tokens per call
 * @param {number} [input.nativeSchemaTokens] Native tool schema tokens
 * @param {number} [input.ptcSchemaTokens] PTC tool schema tokens
 * @param {number} [input.systemTokens] System prompt tokens
 * @param {number} [input.userTokens] User message tokens
 * @param {number} [input.ptcCodeTokensPerCall] Tokens per operation in PTC code
 * @param {number} [input.ptcSummaryTokens] Summary tokens finally returned to the model
 * @param {number} [input.finalAnswerTokens] Final natural-language answer tokens
 */
export function compareNativeVsPtc(input = {}) {
  const calls = Math.max(1, Number(input.calls) || 1);
  const avgArgsTokens = Number.isFinite(input.avgArgsTokens) ? input.avgArgsTokens : 30;
  const avgResultTokens = Number.isFinite(input.avgResultTokens) ? input.avgResultTokens : 600;
  const nativeSchemaTokens = Number.isFinite(input.nativeSchemaTokens) ? input.nativeSchemaTokens : 900;
  const ptcSchemaTokens = Number.isFinite(input.ptcSchemaTokens) ? input.ptcSchemaTokens : 420;
  const systemTokens = Number.isFinite(input.systemTokens) ? input.systemTokens : 1500;
  const userTokens = Number.isFinite(input.userTokens) ? input.userTokens : 60;
  const codePerCall = Number.isFinite(input.ptcCodeTokensPerCall) ? input.ptcCodeTokensPerCall : 24;
  const summaryTokens = Number.isFinite(input.ptcSummaryTokens) ? input.ptcSummaryTokens : 320;
  const answerTokens = Number.isFinite(input.finalAnswerTokens) ? input.finalAnswerTokens : 180;
  const nativeCallsPerTurn = Math.max(1, Number(input.nativeCallsPerTurn) || 1);

  const nativeBase = systemTokens + userTokens + nativeSchemaTokens;
  const toolCallTokens = 12 + avgArgsTokens;
  const perCallRoundTokens = toolCallTokens + avgResultTokens;

  // Native: the model may issue multiple tool calls per turn; the default estimate is 1 per turn; pass 3 for a conservative comparison.
  const nativeTurns = Math.ceil(calls / nativeCallsPerTurn);
  let nativeInput = 0;
  for (let i = 0; i <= nativeTurns; i += 1) {
    nativeInput += nativeBase + i * nativeCallsPerTurn * perCallRoundTokens;
  }
  const nativeOutput = calls * toolCallTokens + answerTokens;

  // PTC: the first turn generates the program, the second reads the summary and answers (tool results do not enter the model context).
  const ptcBase = systemTokens + userTokens + ptcSchemaTokens;
  const ptcCodeTokens = 80 + calls * codePerCall;
  const ptcInput = ptcBase + (ptcBase + ptcCodeTokens + summaryTokens);
  const ptcOutput = ptcCodeTokens + answerTokens;

  const nativeTotal = nativeInput + nativeOutput;
  const ptcTotal = ptcInput + ptcOutput;
  return {
    calls,
    native: { input: nativeInput, output: nativeOutput, total: nativeTotal },
    ptc: { input: ptcInput, output: ptcOutput, total: ptcTotal },
    savedTokens: nativeTotal - ptcTotal,
    savedRatio: nativeTotal > 0 ? Number(((nativeTotal - ptcTotal) / nativeTotal).toFixed(4)) : 0,
    assumptions: {
      avgArgsTokens,
      avgResultTokens,
      nativeCallsPerTurn,
      nativeSchemaTokens,
      ptcSchemaTokens,
      systemTokens,
      userTokens,
      ptcCodeTokensPerCall: codePerCall,
      ptcSummaryTokens: summaryTokens,
      finalAnswerTokens: answerTokens,
      note: 'Heuristic estimate; actual values depend on the model, tool result sizes, and cache hits; smaller models may see reduced benefit due to weaker code-generation ability.'
    }
  };
}

export function savingsRows(callCounts = [3, 5, 10, 20, 30], overrides = {}) {
  return callCounts.map((calls) => compareNativeVsPtc({ ...overrides, calls }));
}
