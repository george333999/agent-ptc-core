// Token 节省预测模型（用于 A/B 前的量级评估，不替代真实计费数据）。
// 假设：原生模式每次模型回复只发起一个工具调用；PTC 模式一次程序化调用完成 N 个操作。
// token 估算采用混合文本启发式：CJK 约 1.5 token/字，其余约 4 字符/token。

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
 * 计算原生逐次调用与 PTC 编排的预测 token 消耗。
 * @param {Object} input
 * @param {number} input.calls 工具操作数量
 * @param {number} [input.avgArgsTokens] 每次调用的参数 token
 * @param {number} [input.avgResultTokens] 每次工具结果的 token
 * @param {number} [input.nativeSchemaTokens] 原生工具 schema token
 * @param {number} [input.ptcSchemaTokens] PTC 工具 schema token
 * @param {number} [input.systemTokens] 系统提示 token
 * @param {number} [input.userTokens] 用户消息 token
 * @param {number} [input.ptcCodeTokensPerCall] PTC 代码中每个操作的 token
 * @param {number} [input.ptcSummaryTokens] 最终返回给模型的摘要 token
 * @param {number} [input.finalAnswerTokens] 最终自然语言回答 token
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

  // 原生：模型可以一轮发起多个工具调用，默认按每轮 1 个估算；可传入 3 做保守对比。
  const nativeTurns = Math.ceil(calls / nativeCallsPerTurn);
  let nativeInput = 0;
  for (let i = 0; i <= nativeTurns; i += 1) {
    nativeInput += nativeBase + i * nativeCallsPerTurn * perCallRoundTokens;
  }
  const nativeOutput = calls * toolCallTokens + answerTokens;

  // PTC：首轮生成程序，第二轮读取摘要并回答（工具结果不进入模型上下文）。
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
      note: '启发式估算，实际值取决于模型、工具结果大小和缓存命中；小模型可能因生成代码能力不足而收益下降。'
    }
  };
}

export function savingsRows(callCounts = [3, 5, 10, 20, 30], overrides = {}) {
  return callCounts.map((calls) => compareNativeVsPtc({ ...overrides, calls }));
}
