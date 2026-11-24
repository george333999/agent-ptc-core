// 单轮任务的延迟拆解：把墙钟时间归因到模型、工具、落盘、审批等待与编排开销。
// 只做观测，不改变任何执行逻辑。

const READ_TOOL_NAMES = new Set([
  'list_files',
  'read_file',
  'read_tool_result',
  'search_files',
  'knowledge_search',
  'fetch_url',
  'web_search'
]);

function readKey(name, args) {
  try {
    return `${name}:${JSON.stringify(args || {})}`;
  } catch {
    return `${name}:{}`;
  }
}

export function createTurnMetrics(now = () => Date.now()) {
  const startedAt = now();
  let llmMs = 0;
  let llmTtftMs = 0;
  let llmDecodeMs = 0;
  let toolMs = 0;
  let saveMs = 0;
  let approvalWaitMs = 0;
  let orchestrationMs = 0;
  let orchestrationWaitMs = 0;
  let orchestrationCalls = 0;
  let llmCalls = 0;
  let steps = 0;
  let toolCalls = 0;
  // PTC 覆盖率观测：有多少“工具轮次”用了 ptc_run 批处理。
  let toolRounds = 0;
  let ptcRounds = 0;
  let completionTokens = 0;
  let promptTokens = 0;
  let cacheHitTokens = 0;
  let cacheMissTokens = 0;
  let usageSteps = 0;
  let cacheReportedSteps = 0;
  let llmStartedAt = null;
  let firstTokenAt = null;
  let repeatedReads = 0;
  // 调用阶段归因：plan（本轮首个决策调用）/ execute（工具执行中的调用）/ finalize（收尾回答）。
  // 只用于观测，不参与任何调度决策。
  let currentPhase = 'execute';
  const phaseStats = new Map();
  let prefetchHits = 0;
  let prefetchMisses = 0;
  let prefetchChars = 0;
  let orchestration = null;
  // 资源锁等待与验证重跑：只用于观测并发改造是否真的缩短了墙钟时间。
  let lockWaitMs = 0;
  let verifyRuns = 0;
  let verifyStale = 0;
  const readCounts = new Map();

  const phaseEntry = (name) => {
    const key = String(name || 'execute');
    if (!phaseStats.has(key)) {
      phaseStats.set(key, {
        calls: 0,
        ttftMs: 0,
        decodeMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0
      });
    }
    return phaseStats.get(key);
  };

  return {
    setPhase(name) {
      currentPhase = String(name || 'execute');
      phaseEntry(currentPhase);
      return currentPhase;
    },
    getPhase() {
      return currentPhase;
    },
    startLlm() {
      if (llmStartedAt === null) {
        llmStartedAt = now();
        firstTokenAt = null;
      }
    },
    markFirstToken() {
      if (llmStartedAt === null || firstTokenAt !== null) return;
      firstTokenAt = now();
    },
    endLlm() {
      if (llmStartedAt === null) return;
      const endedAt = now();
      const elapsed = Math.max(0, endedAt - llmStartedAt);
      const entry = phaseEntry(currentPhase);
      if (firstTokenAt !== null) {
        const ttft = Math.max(0, firstTokenAt - llmStartedAt);
        const decode = Math.max(0, endedAt - firstTokenAt);
        llmTtftMs += ttft;
        llmDecodeMs += decode;
        entry.ttftMs += ttft;
        entry.decodeMs += decode;
      } else {
        // 非流式或没有可见增量时，全部时间计入首字等待。
        llmTtftMs += elapsed;
        entry.ttftMs += elapsed;
      }
      llmMs += elapsed;
      entry.calls += 1;
      llmStartedAt = null;
      firstTokenAt = null;
      llmCalls += 1;
    },
    addToolMs(ms) {
      toolMs += Math.max(0, Number(ms) || 0);
      toolCalls += 1;
    },
    addSaveMs(ms) {
      saveMs += Math.max(0, Number(ms) || 0);
    },
    addApprovalWaitMs(ms) {
      approvalWaitMs += Math.max(0, Number(ms) || 0);
    },
    addLockWaitMs(ms) {
      lockWaitMs += Math.max(0, Number(ms) || 0);
    },
    addVerify({ runs = 0, stale = 0 } = {}) {
      verifyRuns += Math.max(0, Number(runs) || 0);
      verifyStale += Math.max(0, Number(stale) || 0);
    },
    addOrchestrationMs({ computeMs = 0, waitMs = 0 } = {}) {
      orchestrationMs += Math.max(0, Number(computeMs) || 0);
      orchestrationWaitMs += Math.max(0, Number(waitMs) || 0);
      orchestrationCalls += 1;
    },
    addStep() {
      steps += 1;
    },
    addToolRound(usedPtc = false) {
      toolRounds += 1;
      if (usedPtc) ptcRounds += 1;
    },
    addUsage(usage, phase = currentPhase) {
      if (!usage) return;
      usageSteps += 1;
      if (usage.cache_reported === true) cacheReportedSteps += 1;
      const count = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      };
      const prompt = count(usage.prompt_tokens);
      const completion = count(usage.completion_tokens);
      let hit = count(usage.cache_hit_tokens);
      let miss = Math.max(0, Number(usage.cache_miss_tokens) || 0);
      if (prompt > 0) {
        // 命中与未命中之和不得超过输入 tokens，避免异常字段放大命中率分母。
        hit = Math.min(hit, prompt);
        miss = Math.min(miss, prompt - hit);
        if (hit > 0 && miss === 0 && hit < prompt) miss = prompt - hit;
      }
      promptTokens += prompt;
      completionTokens += completion;
      cacheHitTokens += hit;
      cacheMissTokens += miss;
      const entry = phaseEntry(phase);
      entry.promptTokens += prompt;
      entry.completionTokens += completion;
      entry.cacheHitTokens += hit;
      entry.cacheMissTokens += miss;
    },
    // 预取命中：命中表示本轮直接复用了缓存内容（至少省下一次读取）。
    addPrefetch({ hit = false, chars = 0 } = {}) {
      const size = Math.max(0, Number(chars) || 0);
      if (hit) prefetchHits += 1;
      else prefetchMisses += 1;
      prefetchChars += size;
    },
    setOrchestrationMetrics(metrics) {
      if (!metrics || typeof metrics !== 'object') return;
      orchestration = { ...metrics };
    },
    recordTool(name, args) {
      if (!READ_TOOL_NAMES.has(String(name || ''))) return false;
      const key = readKey(name, args);
      const count = (readCounts.get(key) || 0) + 1;
      readCounts.set(key, count);
      if (count > 1) repeatedReads += 1;
      return true;
    },
    snapshot() {
      const wallMs = Math.max(0, now() - startedAt);
      // 澄清提问、计划确认、工具审批都属于“等待用户操作”，这段时间不计入有效耗时。
      const userWaitMs = Math.min(wallMs, approvalWaitMs);
      const durationMs = Math.max(0, wallMs - userWaitMs);
      const totalReads = [...readCounts.values()].reduce((total, count) => total + count, 0);
      // 编排与工具是包含关系（orchestrationMs 是 toolMs 的一部分），
      // 这里只额外给出未归因残差，避免把同一段时间重复计价。
      const overheadMs = Math.max(0, durationMs - llmMs - toolMs - saveMs);
      const callsByPhase = {};
      const ttftByPhase = {};
      const missTokensByPhase = {};
      const promptTokensByPhase = {};
      for (const [phase, stat] of phaseStats) {
        if (!stat.calls && !stat.promptTokens && !stat.completionTokens) continue;
        callsByPhase[phase] = stat.calls;
        ttftByPhase[phase] = stat.ttftMs;
        missTokensByPhase[phase] = stat.cacheMissTokens;
        promptTokensByPhase[phase] = stat.promptTokens;
      }
      return {
        // durationMs 为有效耗时：已扣除用户思考/操作时间；wallMs 为原始墙钟。
        durationMs,
        wallMs,
        userWaitMs,
        llmMs,
        llmTtftMs,
        llmDecodeMs,
        toolMs,
        saveMs,
        approvalWaitMs,
        orchestrationMs,
        orchestrationWaitMs,
        orchestrationCalls,
        lockWaitMs,
        verifyRuns,
        verifyStale,
        overheadMs,
        llmCalls,
        steps,
        toolCalls,
        toolRounds,
        ptcRounds,
        ptcCoverage: toolRounds ? Number((ptcRounds / toolRounds).toFixed(4)) : 0,
        completionTokens,
        promptTokens,
        cacheHitTokens,
        cacheMissTokens,
        // 只要至少一步返回了有效缓存字段，命中/未命中汇总就是可用的；
        // 部分步骤未上报用 cachePartial 标记，不能再把整轮丢掉导致前端显示 0%。
        cacheReported: cacheReportedSteps > 0,
        cachePartial: cacheReportedSteps > 0 && cacheReportedSteps < usageSteps,
        repeatedReads,
        totalReads,
        repeatedReadRate: totalReads ? Number((repeatedReads / totalReads).toFixed(4)) : 0,
        callsByPhase,
        ttftByPhase,
        missTokensByPhase,
        promptTokensByPhase,
        prefetchHits,
        prefetchMisses,
        prefetchChars,
        prefetchHitRate: (prefetchHits + prefetchMisses)
          ? Number((prefetchHits / (prefetchHits + prefetchMisses)).toFixed(4))
          : 0,
        orchestration
      };
    }
  };
}
