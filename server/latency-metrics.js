// Latency breakdown for a single turn: attribute wall-clock time to model, tools, persistence, approval wait and orchestration overhead.
// Observation only; does not change any execution logic.

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
  // PTC coverage observation: how many "tool rounds" used the ptc_run batch.
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
  // Call-phase attribution: plan (the first decision call of this turn) / execute (calls during tool execution) / finalize (closing answer).
  // Observation only; never used for scheduling decisions.
  let currentPhase = 'execute';
  const phaseStats = new Map();
  let prefetchHits = 0;
  let prefetchMisses = 0;
  let prefetchChars = 0;
  let orchestration = null;
  // Resource lock wait and verification reruns: only used to observe whether the concurrency changes really shortened wall-clock time.
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
        // Non-streaming, or no visible increments: all time counts as time to first token.
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
        // Hit plus miss must not exceed input tokens, so abnormal fields cannot inflate the hit-rate denominator.
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
    // Prefetch hits: a hit means this turn reused cached content directly (saving at least one read).
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
      // Clarifying questions, plan confirmation and tool approvals all count as "waiting for user action"; this time is not counted as productive latency.
      const userWaitMs = Math.min(wallMs, approvalWaitMs);
      const durationMs = Math.max(0, wallMs - userWaitMs);
      const totalReads = [...readCounts.values()].reduce((total, count) => total + count, 0);
      // Orchestration and tools are inclusive (orchestrationMs is part of toolMs);
      // only the unattributed residual is reported here, to avoid double-counting the same span.
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
        // durationMs is productive latency: user thinking/action time already deducted; wallMs is the raw wall-clock time.
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
        // As long as at least one step returned valid cache fields, the hit/miss totals are usable;
        // steps that did not report are flagged by cachePartial, instead of discarding the whole turn and showing 0% in the UI.
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
