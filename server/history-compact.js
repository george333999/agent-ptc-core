import crypto from 'node:crypto';
import { estimateTokens } from './token-opt.js';
import { toolCategory } from './task-type.js';

// History compaction:
// - Phase 1 (piggyback): runs only within the same request that triggered windowTrimmed, riding an existing rebuild point;
// - Phase 2 (standalone): standalone compaction candidate, executes only when the net-benefit inequality holds;
// - The summary form is fixed as a "structured fact sheet", with no model call, no timestamps/random IDs, so the same input is byte-identical.

const CATEGORY_ORDER = ['read', 'edit', 'command', 'web', 'mcp', 'other'];
const CATEGORY_LABELS = {
  read: 'read',
  edit: 'write',
  command: 'command',
  web: 'web',
  mcp: 'MCP',
  other: 'other'
};

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]'],
  [/\b(?:sk|ak|rk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{12,}\b/g, '[REDACTED]'],
  [/\bLTAI[0-9A-Za-z]{8,}\b/g, '[REDACTED]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]'],
  [/(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;"']{4,}/gi, '$1=[REDACTED]']
];

const DYNAMIC_PATTERNS = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '[DYNAMIC]'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[DYNAMIC]']
];

export function hashText(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);
}

export function sanitizeFactText(text, workspace = '') {
  let value = String(text ?? '');
  if (workspace) {
    const normalized = String(workspace).replace(/\\/g, '/');
    value = value.split(workspace).join('');
    value = value.split(normalized).join('');
  }
  value = value.replace(/[A-Za-z]:[\\/][^\s"'`,;)]+/g, '[PATH]');
  for (const [pattern, replacement] of SECRET_PATTERNS) value = value.replace(pattern, replacement);
  for (const [pattern, replacement] of DYNAMIC_PATTERNS) value = value.replace(pattern, replacement);
  return value.replace(/\s+/g, ' ').trim();
}

function clip(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

function messageChars(message) {
  try {
    return JSON.stringify(message)?.length || 0;
  } catch {
    return 0;
  }
}

function isSafeBoundary(message) {
  if (!message) return false;
  if (message.role !== 'assistant') return false;
  const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  if (!calls.length) return true;
  return calls.every((call) => call.status !== 'running');
}

// The current user turn must be kept verbatim: the compaction range ends at most at the message before it.
function latestUserAbs(messages, absIndexById) {
  let latest = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'user') continue;
    const abs = absIndexById?.get?.(message.id);
    if (!Number.isInteger(abs)) continue;
    latest = latest === null ? abs : Math.max(latest, abs);
  }
  return latest;
}

// Pick the first 50% (by chars) within the window as the compaction range:
// - the boundary only retreats to the nearest complete assistant message, never compacting an in-flight tool round-trip;
// - give up when the saved amount is below minSavedRatio, avoiding compaction for compaction's sake.
export function selectCompactionRange({
  messages,
  absIndexById,
  startAbs = 0,
  targetRatio = 0.5,
  minSavedRatio = 0.3,
  maxEndAbs = null
} = {}) {
  const entries = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const abs = absIndexById?.get?.(message.id);
    if (!Number.isInteger(abs) || abs < startAbs) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    entries.push({ message, abs, chars: messageChars(message) });
  }
  if (entries.length < 2) return null;

  const totalChars = entries.reduce((total, entry) => total + entry.chars, 0);
  if (totalChars <= 0) return null;
  const target = totalChars * Math.min(0.9, Math.max(0.1, Number(targetRatio) || 0.5));
  // The current user turn is the anchor of "forward intent" and must not enter the compaction range;
  // only look for a safe boundary in the history before it.
  const eligible = Number.isInteger(maxEndAbs)
    ? entries.filter((entry) => entry.abs < maxEndAbs)
    : entries;
  if (eligible.length < 2) return null;

  let index = 0;
  let accumulated = 0;
  while (index < eligible.length && accumulated < target) {
    accumulated += eligible[index].chars;
    index += 1;
  }
  if (index <= 0) return null;

  let boundaryIndex = index - 1;
  while (boundaryIndex >= 0 && !isSafeBoundary(eligible[boundaryIndex].message)) {
    boundaryIndex -= 1;
  }
  if (boundaryIndex < 0) return null;
  const endAbs = eligible[boundaryIndex].abs + 1;

  const startAbsEffective = eligible[0].abs;
  const rangeEntries = entries.filter((entry) => entry.abs >= startAbsEffective && entry.abs < endAbs);
  const rangeChars = rangeEntries.reduce((total, entry) => total + entry.chars, 0);
  if (!rangeChars) return null;
  if (rangeChars / totalChars < Math.min(0.9, Math.max(0, Number(minSavedRatio) || 0))) return null;

  return {
    startAbs: startAbsEffective,
    endAbs,
    chars: rangeChars,
    messageCount: rangeEntries.length,
    totalChars
  };
}

function collectFacts({ messages, absIndexById, startAbs, endAbs, workspace, previewChars, maxPreviews }) {
  const stats = new Map();
  for (const category of CATEGORY_ORDER) stats.set(category, { calls: 0, ok: 0, failed: 0, denied: 0 });
  const files = new Map();
  const artifacts = new Map();
  const previews = [];
  const failures = [];
  const refs = [];
  let userCount = 0;
  let assistantSteps = 0;
  let firstAbs = null;
  let lastAbs = null;

  const entries = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const abs = absIndexById?.get?.(message.id);
    if (!Number.isInteger(abs) || abs < startAbs || abs >= endAbs) continue;
    entries.push({ message, abs });
  }
  entries.sort((left, right) => left.abs - right.abs);

  for (const { message, abs } of entries) {
    if (firstAbs === null) firstAbs = abs;
    lastAbs = abs;
    if (message.role === 'user') {
      userCount += 1;
      continue;
    }
    if (message.role !== 'assistant') continue;
    assistantSteps += 1;
    const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    for (const call of calls) {
      const category = toolCategory(call.name);
      const stat = stats.get(category) || stats.get('other');
      stat.calls += 1;
      if (call.status === 'completed') stat.ok += 1;
      else if (call.status === 'denied') stat.denied += 1;
      else if (call.status === 'error') stat.failed += 1;

      const target = call.args?.path;
      if (target) {
        const key = sanitizeFactText(String(target), workspace).slice(0, 200);
        if (key) {
          const file = files.get(key) || { reads: 0, writes: 0 };
          if (call.name === 'write_file') {
            file.writes += 1;
            const chars = String(call.args?.content ?? '').length;
            artifacts.set(key, chars);
          } else if (call.name === 'edit_file') {
            file.writes += 1;
          } else if (call.name === 'read_file') {
            file.reads += 1;
          }
          files.set(key, file);
        }
      }
      if (call.resultRef?.resultId) {
        refs.push({
          resultId: call.resultRef.resultId,
          tool: call.name,
          bytes: Number(call.resultRef.bytes) || 0
        });
      }
      if (call.status === 'completed' && call.result && previews.length < 200) {
        previews.push({
          abs,
          tool: call.name,
          text: sanitizeFactText(clip(call.result, previewChars), workspace)
        });
      }
      if (call.status === 'error' && failures.length < 5) {
        failures.push({
          tool: call.name,
          text: sanitizeFactText(clip(call.result, 120), workspace)
        });
      }
    }
  }

  return {
    stats,
    files,
    artifacts,
    previews: previews.slice(-Math.max(0, maxPreviews)),
    failures,
    refs: refs.slice(-6),
    userCount,
    assistantSteps,
    firstAbs,
    lastAbs
  };
}

function formatFacts(facts, { maxFiles = 20 } = {}) {
  const lines = [];
  const toolLine = CATEGORY_ORDER
    .map((category) => {
      const stat = facts.stats.get(category);
      return stat && stat.calls ? `${CATEGORY_LABELS[category]}×${stat.calls}` : '';
    })
    .filter(Boolean)
    .join('; ');
  const totals = CATEGORY_ORDER.reduce((acc, category) => {
    const stat = facts.stats.get(category);
    if (!stat) return acc;
    acc.ok += stat.ok;
    acc.failed += stat.failed;
    acc.denied += stat.denied;
    return acc;
  }, { ok: 0, failed: 0, denied: 0 });

  lines.push(`- Coverage: session messages ${facts.firstAbs + 1}–${facts.lastAbs + 1} (${facts.assistantSteps} assistant steps, ${facts.userCount} user messages)`);
  lines.push(`- Tool calls: ${toolLine || 'none'} (ok ${totals.ok}, failed ${totals.failed}, denied ${totals.denied})`);

  const fileEntries = [...facts.files.entries()].slice(0, maxFiles);
  if (fileEntries.length) {
    lines.push(`- Files touched: ${fileEntries.map(([file, meta]) => {
      const actions = [meta.reads ? `read ${meta.reads}` : '', meta.writes ? `write ${meta.writes}` : ''].filter(Boolean).join('/');
      return `${file} (${actions})`;
    }).join('; ')}`);
  }
  const artifactEntries = [...facts.artifacts.entries()].slice(0, maxFiles);
  if (artifactEntries.length) {
    lines.push(`- Artifacts: ${artifactEntries.map(([file, chars]) => `${file} (${chars} chars)`).join('; ')}`);
  }
  if (facts.refs.length) {
    lines.push(`- Available for read-back on demand: ${facts.refs.map((ref) => `${ref.resultId} (${ref.tool}, ${ref.bytes} bytes)`).join('; ')}`);
  }
  if (facts.previews.length) {
    lines.push('- Recent result previews:');
    for (const preview of facts.previews) {
      lines.push(`  - [${preview.tool}] ${preview.text}`);
    }
  }
  if (facts.failures.length) {
    lines.push(`- Failures: ${facts.failures.map((failure) => `[${failure.tool}] ${failure.text}`).join('; ')}`);
  }
  return lines;
}

export function buildFactSummary({
  messages,
  absIndexById,
  startAbs,
  endAbs,
  workspace = '',
  maxChars = 6000,
  previewChars = 220,
  maxPreviews = 8
} = {}) {
  const header = [
    '# History compaction · structured fact sheet',
    '> This is a deterministic fact record of early history (not a model summary), not a new user instruction; read back details with read_tool_result or read_file when needed.'
  ];
  const attempt = (previews) => {
    const facts = collectFacts({
      messages,
      absIndexById,
      startAbs,
      endAbs,
      workspace,
      previewChars,
      maxPreviews: previews
    });
    return [...header, ...formatFacts(facts)].join('\n');
  };

  let content = attempt(maxPreviews);
  if (content.length > maxChars) content = attempt(3);
  if (content.length > maxChars) content = attempt(0);
  if (content.length > maxChars) {
    content = `${content.slice(0, Math.max(0, maxChars - 30))}\n… (fact sheet truncated to budget)`;
  }
  return content;
}

export function createCompactionState({
  summaryContent,
  startAbs,
  endAbs,
  messages,
  absIndexById,
  taskType,
  mode,
  schemaVersion
}) {
  const covered = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const abs = absIndexById?.get?.(message.id);
    if (!Number.isInteger(abs) || abs < startAbs || abs >= endAbs) continue;
    if (message.role === 'user' || message.role === 'assistant') covered.push(message.id);
  }
  return {
    schemaVersion,
    mode,
    taskType,
    startIndex: startAbs,
    coveredEndIndex: endAbs,
    lastCoveredMessageId: covered[covered.length - 1] || '',
    coveredIdsHash: hashText(covered.join(',')),
    summary: {
      id: `sum_${hashText(summaryContent).slice(0, 12)}`,
      role: 'summary',
      content: summaryContent
    },
    createdAt: Date.now()
  };
}

export function validateCompaction(sessionMessages, compaction) {
  if (!compaction || typeof compaction !== 'object') return null;
  if (!compaction.summary?.content) return null;
  const boundary = Number(compaction.coveredEndIndex);
  if (!Number.isInteger(boundary) || boundary <= 0) return null;
  const last = Array.isArray(sessionMessages) ? sessionMessages[boundary - 1] : null;
  if (!last) return null;
  if (compaction.lastCoveredMessageId && last.id !== compaction.lastCoveredMessageId) return null;
  return compaction;
}

// Apply compaction at the view layer: drop original messages already covered by the summary and put the summary first.
export function applyCompaction(historyMessages, compaction, absIndexById) {
  const list = Array.isArray(historyMessages) ? historyMessages : [];
  if (!compaction?.summary?.content) return { messages: list.slice(), applied: false, dropped: 0 };
  const kept = [];
  let dropped = 0;
  for (const message of list) {
    const abs = absIndexById?.get?.(message.id);
    if (Number.isInteger(abs) && abs < compaction.coveredEndIndex) {
      dropped += 1;
      continue;
    }
    kept.push(message);
  }
  const summaryMessage = {
    id: compaction.summary.id,
    role: 'summary',
    content: compaction.summary.content,
    mode: compaction.mode
  };
  return { messages: [summaryMessage, ...kept], applied: true, dropped };
}

export function splitSavedTokens(savedTokens, hitRatio) {
  const saved = Math.max(0, Math.floor(Number(savedTokens) || 0));
  const ratio = Number.isFinite(Number(hitRatio)) ? Math.min(1, Math.max(0, Number(hitRatio))) : 0;
  const savedHitTokens = Math.round(saved * ratio);
  return { savedHitTokens, savedMissTokens: Math.max(0, saved - savedHitTokens) };
}

// Token accounting and cost accounting are separate: netSavingTokens verifies "does it really save tokens",
// netBenefitCNY drives the compaction decision (multiplied by unit price, including rebuild and read-back costs).
export function computeNetBenefit({
  savedTokens,
  hitRatio = 0,
  readbackTokens = 0,
  rebuildTokens = 0,
  prices = {}
} = {}) {
  const saved = Math.max(0, Math.floor(Number(savedTokens) || 0));
  const readback = Math.max(0, Math.floor(Number(readbackTokens) || 0));
  const rebuild = Math.max(0, Math.floor(Number(rebuildTokens) || 0));
  const cacheHit = Number(prices.cacheHit) || 0;
  const cacheMiss = Number(prices.cacheMiss) || 0;
  const { savedHitTokens, savedMissTokens } = splitSavedTokens(saved, hitRatio);
  const grossCNY = savedHitTokens * cacheHit + savedMissTokens * cacheMiss;
  const readbackCNY = readback * cacheMiss;
  const rebuildCNY = rebuild * Math.max(0, cacheMiss - cacheHit);
  const netBenefitCNY = grossCNY - readbackCNY - rebuildCNY;
  const netSavingTokens = saved - readback - rebuild;
  return {
    savedTokens: saved,
    savedHitTokens,
    savedMissTokens,
    readbackTokens: readback,
    rebuildTokens: rebuild,
    netSavingTokens,
    netBenefitCNY,
    qualifies: netSavingTokens > 0 && netBenefitCNY > 0
  };
}

// R estimation for Phase 2: prefer the same-task-type median, fall back to "used steps" when missing, and explicitly label the fallback.
export function estimateRemainingSteps({ usedSteps = 0, typeMedianSteps = null, maxSteps = 50 } = {}) {
  const used = Math.max(0, Math.floor(Number(usedSteps) || 0));
  if (Number.isFinite(Number(typeMedianSteps)) && Number(typeMedianSteps) > 0) {
    const remaining = Math.round(Number(typeMedianSteps) - used);
    return { value: Math.max(0, Math.min(maxSteps, remaining)), fallback: 'typeMedian' };
  }
  return { value: Math.max(0, Math.min(maxSteps, used)), fallback: 'usedSteps' };
}

export function compactionCandidateId({
  taskId = '',
  turnId = '',
  startAbs = 0,
  endAbs = 0,
  coveredIdsHash = '',
  schemaVersion = 1
} = {}) {
  return hashText(JSON.stringify([
    'compact',
    schemaVersion,
    String(taskId),
    String(turnId),
    Number(startAbs) || 0,
    Number(endAbs) || 0,
    String(coveredIdsHash)
  ]));
}

function summarizeRangeTokens(messages, absIndexById, startAbs, endAbs) {
  let chars = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    const abs = absIndexById?.get?.(message.id);
    if (!Number.isInteger(abs) || abs < startAbs || abs >= endAbs) continue;
    chars += messageChars(message);
  }
  return { chars, tokens: Math.ceil(chars / 2.5) };
}

function buildEventBase({
  kind,
  taskId,
  turnId,
  taskType,
  range,
  summaryTokens,
  originalTokens,
  hitRatio,
  prices,
  usedSteps
}) {
  const savedTokens = Math.max(0, originalTokens - summaryTokens);
  return {
    kind,
    taskId,
    turnId,
    taskType,
    startAbs: range.startAbs,
    endAbs: range.endAbs,
    coveredMessages: range.messageCount,
    originalTokens,
    summaryTokens,
    savedTokens,
    hitRatio,
    prices
  };
}

function finishEvent(event, benefit, extra = {}) {
  return {
    ...event,
    ...benefit,
    ...extra
  };
}

// Phase 1: only precheck and fact-sheet generation; whether to execute is decided by the caller (must be the same request as trim).
export function planPiggybackCompaction({
  messages,
  windowMessages,
  absIndexById,
  compaction = null,
  taskType = 'pending',
  taskClass = 'short',
  policy,
  workspace = '',
  hitRatio = 0,
  usedSteps = 0,
  finalPhase = false,
  contextTokens = 0,
  hardLimitTokens = 0,
  maxSteps = 50,
  typeMedianSteps = null,
  taskId = '',
  turnId = ''
} = {}) {
  const base = { kind: 'piggyback', taskId, turnId, taskType, applied: false };
  if (!policy?.phase1) return { action: 'skip', reason: 'disabled', event: { ...base, reason: 'disabled' } };
  // End phase has no new tool steps: compaction would only create an extra prefix rebuild and may drop details needed by the final answer.
  if (finalPhase) return { action: 'skip', reason: 'finalPhase', event: { ...base, reason: 'finalPhase' } };
  const windowTokens = estimateTokens(JSON.stringify(windowMessages || []));
  const minTokens = taskClass === 'long'
    ? policy.phase1MinTokens
    : taskClass === 'pending'
      ? Math.max(policy.phase1MinTokensShort, 12000)
      : policy.phase1MinTokensShort;
  if (windowTokens < minTokens) {
    return { action: 'skip', reason: 'tooSmall', event: { ...base, reason: 'tooSmall', windowTokens, minTokens } };
  }
  if (windowTokens < policy.minHistoryTokens) {
    return { action: 'skip', reason: 'belowFloor', event: { ...base, reason: 'belowFloor', windowTokens } };
  }
  // The watermark uses the "context size before trim is triggered": compaction rides the prefix rebuild of this trim,
  // so judging "whether close to overflow" must use the pre-trim size; if the post-trim residual window is used,
  // since one trim cuts down to the soft limit (about half of the hard limit), the watermark would never be reached.
  const overflowTokens = Number(contextTokens) > 0 ? Number(contextTokens) : windowTokens;
  if (policy.phase1OverflowTokens > 0 && overflowTokens < policy.phase1OverflowTokens) {
    return {
      action: 'skip',
      reason: 'belowOverflow',
      event: {
        ...base,
        reason: 'belowOverflow',
        windowTokens,
        contextTokens: overflowTokens,
        phase1OverflowTokens: policy.phase1OverflowTokens
      }
    };
  }
  // Agent-aware lease: no compaction on the critical path while executing, unless the context has reached the overflow threshold.
  if (policy.suppressMidRunCompaction && usedSteps > 0
    && !(policy.phase1OverflowTokens > 0 && overflowTokens >= policy.phase1OverflowTokens)) {
    return {
      action: 'skip',
      reason: 'midRunLease',
      event: { ...base, reason: 'midRunLease', windowTokens, contextTokens: overflowTokens, usedSteps }
    };
  }

  // Predictive skip: extrapolate by "used steps × average per-step increment"; if this turn is not expected to hit the hard limit,
  // defer compaction to the next trim point, avoiding a wasted compaction near the end.
  // Only applies within a turn (usedSteps > 0): the turn boundary doesn't know how many steps the new turn will add, so keep using the watermark.
  if (policy.predictiveCompaction !== false && Number(hardLimitTokens) > 0 && Number(usedSteps) > 0) {
    const remaining = estimateRemainingSteps({ usedSteps, typeMedianSteps, maxSteps });
    const perStepTokens = windowTokens / Math.max(1, Number(usedSteps) + 1);
    const projectedTokens = Math.round(windowTokens + perStepTokens * remaining.value);
    const safety = Number(policy.predictiveSafety) > 0 ? Number(policy.predictiveSafety) : 1;
    if (projectedTokens * safety < Number(hardLimitTokens)) {
      return {
        action: 'skip',
        reason: 'projectedNoOverflow',
        event: {
          ...base,
          reason: 'projectedNoOverflow',
          windowTokens,
          projectedTokens,
          remainingSteps: remaining.value,
          rEstFallback: remaining.fallback,
          hardLimitTokens: Number(hardLimitTokens),
          predictiveSafety: safety
        }
      };
    }
  }

  const startAbs = compaction?.coveredEndIndex || 0;
  const range = selectCompactionRange({
    messages: windowMessages,
    absIndexById,
    startAbs,
    targetRatio: Number(policy.phase1TargetRatio) || 0.5,
    minSavedRatio: policy.minSavedRatio,
    maxEndAbs: latestUserAbs(windowMessages, absIndexById)
  });
  if (!range) return { action: 'skip', reason: 'noRange', event: { ...base, reason: 'noRange' } };

  const original = summarizeRangeTokens(messages, absIndexById, range.startAbs, range.endAbs);
  if (!original.tokens) return { action: 'skip', reason: 'noOriginal', event: { ...base, reason: 'noOriginal' } };
  if (original.tokens < policy.minRangeTokens) {
    return {
      action: 'skip',
      reason: 'rangeTooSmall',
      event: { ...base, reason: 'rangeTooSmall', originalTokens: original.tokens }
    };
  }
  // The summary covers the whole block "from the conversation start to this boundary", avoiding losing earlier facts during incremental compaction;
  // the compaction amount is still computed over the newly added range [range.startAbs, range.endAbs).
  const summary = buildFactSummary({
    messages,
    absIndexById,
    startAbs: 0,
    endAbs: range.endAbs,
    workspace
  });
  const summaryTokens = estimateTokens(summary);
  const event = buildEventBase({
    kind: 'piggyback',
    taskId,
    turnId,
    taskType,
    range: { ...range, startAbs: range.startAbs },
    summaryTokens,
    originalTokens: original.tokens,
    hitRatio,
    prices: policy.prices,
    usedSteps
  });
  const qLimit = Math.max(original.tokens * policy.summaryRatio, policy.summaryFloorTokens || 0);
  if (summaryTokens > qLimit) {
    return { action: 'skip', reason: 'qExceeds', event: { ...event, reason: 'qExceeds', qLimit } };
  }
  const benefit = computeNetBenefit({
    savedTokens: original.tokens - summaryTokens,
    hitRatio,
    prices: policy.prices
  });
  if (!benefit.qualifies) {
    return { action: 'skip', reason: 'netNegative', event: { ...finishEvent(event, benefit), reason: 'netNegative' } };
  }
  const state = createCompactionState({
    summaryContent: summary,
    startAbs: 0,
    endAbs: range.endAbs,
    messages,
    absIndexById,
    taskType,
    mode: 'agent',
    schemaVersion: policy.schemaVersion
  });
  return {
    action: 'compact',
    state,
    event: finishEvent(event, benefit, { applied: true, coveredIdsHash: state.coveredIdsHash })
  };
}

// Phase 2: standalone compaction. P_after is measured by the caller per modelMessages and passed in.
export function planStandaloneCompaction({
  messages,
  windowMessages,
  absIndexById,
  compaction = null,
  taskType = 'pending',
  policy,
  workspace = '',
  hitRatio = 0,
  usedSteps = 0,
  stepsSinceLastCompaction = 0,
  pAfterTokens = 0,
  measureAfterTokens = null,
  typeMedianSteps = null,
  taskId = '',
  turnId = ''
} = {}) {
  const base = { kind: 'standalone', taskId, turnId, taskType, applied: false };
  if (!policy?.phase2) return { action: 'skip', reason: 'disabled', event: { ...base, reason: 'disabled' } };
  if (taskType === 'pending') return { action: 'skip', reason: 'pendingTask', event: { ...base, reason: 'pendingTask' } };
  if (stepsSinceLastCompaction < policy.minStepsBetweenCompactions) {
    return { action: 'skip', reason: 'recentCompaction', event: { ...base, reason: 'recentCompaction', stepsSinceLastCompaction } };
  }
  const windowTokens = estimateTokens(JSON.stringify(windowMessages || []));
  if (windowTokens < policy.phase2MinTokens) {
    return {
      action: 'skip',
      reason: 'tooSmall',
      event: { ...base, reason: 'tooSmall', windowTokens, minTokens: policy.phase2MinTokens }
    };
  }

  const startAbs = compaction?.coveredEndIndex || 0;
  const range = selectCompactionRange({
    messages: windowMessages,
    absIndexById,
    startAbs,
    targetRatio: Number(policy.phase1TargetRatio) || 0.5,
    minSavedRatio: policy.minSavedRatio,
    maxEndAbs: latestUserAbs(windowMessages, absIndexById)
  });
  if (!range) return { action: 'skip', reason: 'noRange', event: { ...base, reason: 'noRange' } };
  const original = summarizeRangeTokens(messages, absIndexById, range.startAbs, range.endAbs);
  if (!original.tokens) return { action: 'skip', reason: 'noOriginal', event: { ...base, reason: 'noOriginal' } };
  if (original.tokens < policy.minRangeTokens) {
    return {
      action: 'skip',
      reason: 'rangeTooSmall',
      event: { ...base, reason: 'rangeTooSmall', originalTokens: original.tokens }
    };
  }
  // P_after must be computed from the model messages after the compaction point; the caller provides the measurement function,
  // avoiding over- or under-estimating the rebuild scope with the full session.messages result.
  const afterTokens = typeof measureAfterTokens === 'function'
    ? Math.max(0, Math.floor(Number(measureAfterTokens(range.endAbs)) || 0))
    : Math.max(0, Math.floor(Number(pAfterTokens) || 0));
  const summary = buildFactSummary({
    messages,
    absIndexById,
    startAbs: 0,
    endAbs: range.endAbs,
    workspace
  });
  const summaryTokens = estimateTokens(summary);
  const event = buildEventBase({
    kind: 'standalone',
    taskId,
    turnId,
    taskType,
    range,
    summaryTokens,
    originalTokens: original.tokens,
    hitRatio,
    prices: policy.prices,
    usedSteps
  });
  const qLimit = Math.max(original.tokens * policy.summaryRatio, policy.summaryFloorTokens || 0);
  if (summaryTokens > qLimit) {
    return { action: 'skip', reason: 'qExceeds', event: { ...event, reason: 'qExceeds', qLimit } };
  }
  const { value: remainingSteps, fallback: rEstFallback } = estimateRemainingSteps({
    usedSteps,
    typeMedianSteps
  });
  const benefit = computeNetBenefit({
    savedTokens: original.tokens - summaryTokens,
    hitRatio,
    rebuildTokens: afterTokens,
    prices: policy.prices
  });
  const k = policy.prices.cacheHit > 0
    ? policy.prices.cacheMiss / policy.prices.cacheHit
    : 50;
  const inequality = (original.tokens - summaryTokens) * Math.max(1, remainingSteps)
    > afterTokens * Math.max(0, k - 1);
  if (!benefit.qualifies || !inequality) {
    return {
      action: 'skip',
      reason: 'netNegative',
      event: finishEvent(event, benefit, {
        reason: 'netNegative',
        remainingSteps,
        rEstFallback,
        pAfterTokens: afterTokens,
        inequality
      })
    };
  }
  const state = createCompactionState({
    summaryContent: summary,
    startAbs: 0,
    endAbs: range.endAbs,
    messages,
    absIndexById,
    taskType,
    mode: 'agent',
    schemaVersion: policy.schemaVersion
  });
  return {
    action: 'compact',
    state,
    event: finishEvent(event, benefit, {
      applied: true,
      remainingSteps,
      rEstFallback,
      pAfterTokens: afterTokens,
      inequality,
      coveredIdsHash: state.coveredIdsHash
    })
  };
}

export function compactionEventWithId(event, policy = {}) {
  const candidateId = compactionCandidateId({
    taskId: event.taskId,
    turnId: event.turnId,
    startAbs: event.startAbs,
    endAbs: event.endAbs,
    coveredIdsHash: event.coveredIdsHash || hashText(JSON.stringify([event.startAbs, event.endAbs])),
    schemaVersion: policy.schemaVersion || 1
  });
  return { ...event, candidateId, schemaVersion: policy.schemaVersion || 1 };
}
