import crypto from 'node:crypto';
import { estimateTokens } from './token-opt.js';
import { toolCategory } from './task-type.js';

// 历史压缩：
// - Phase 1（piggyback）：只在 windowTrimmed 触发的同一次请求内执行，搭已有重建点的便车；
// - Phase 2（standalone）：独立压缩候选，必须通过净收益不等式才执行；
// - 摘要形态固定为“结构化事实清单”，不调用模型，不包含时间戳/随机 ID，保证同样输入字节一致。

const CATEGORY_ORDER = ['read', 'edit', 'command', 'web', 'mcp', 'other'];
const CATEGORY_LABELS = {
  read: '读取',
  edit: '写入',
  command: '命令',
  web: '联网',
  mcp: 'MCP',
  other: '其他'
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

// 当前用户轮次必须保留原文：压缩范围最多到它的前一条消息。
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

// 在窗口内选出“前 50%（按字符）”作为压缩范围：
// - 边界只向前回退到最近一个完整的助手消息，绝不压缩进行中的工具往返；
// - 压缩量不足 minSavedRatio 时放弃，避免为了压缩而压缩。
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
  // 当前用户轮次是“前向意图”的锚点，不能进入压缩范围；
  // 只在它之前的历史里寻找安全边界。
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
    .join('；');
  const totals = CATEGORY_ORDER.reduce((acc, category) => {
    const stat = facts.stats.get(category);
    if (!stat) return acc;
    acc.ok += stat.ok;
    acc.failed += stat.failed;
    acc.denied += stat.denied;
    return acc;
  }, { ok: 0, failed: 0, denied: 0 });

  lines.push(`- 覆盖范围：会话第 ${facts.firstAbs + 1}–${facts.lastAbs + 1} 条消息（助手步骤 ${facts.assistantSteps} 个，用户消息 ${facts.userCount} 条）`);
  lines.push(`- 工具调用：${toolLine || '无'}（成功 ${totals.ok}，失败 ${totals.failed}，拒绝 ${totals.denied}）`);

  const fileEntries = [...facts.files.entries()].slice(0, maxFiles);
  if (fileEntries.length) {
    lines.push(`- 触及文件：${fileEntries.map(([file, meta]) => {
      const actions = [meta.reads ? `读${meta.reads}` : '', meta.writes ? `写${meta.writes}` : ''].filter(Boolean).join('/');
      return `${file}（${actions}）`;
    }).join('；')}`);
  }
  const artifactEntries = [...facts.artifacts.entries()].slice(0, maxFiles);
  if (artifactEntries.length) {
    lines.push(`- 产物：${artifactEntries.map(([file, chars]) => `${file}（${chars} 字符）`).join('；')}`);
  }
  if (facts.refs.length) {
    lines.push(`- 可按需回读：${facts.refs.map((ref) => `${ref.resultId}（${ref.tool}，${ref.bytes} 字节）`).join('；')}`);
  }
  if (facts.previews.length) {
    lines.push('- 最近结果预览：');
    for (const preview of facts.previews) {
      lines.push(`  - [${preview.tool}] ${preview.text}`);
    }
  }
  if (facts.failures.length) {
    lines.push(`- 失败记录：${facts.failures.map((failure) => `[${failure.tool}] ${failure.text}`).join('；')}`);
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
    '# 历史压缩 · 结构化事实清单',
    '> 这是早期历史的确定性事实记录（非模型摘要），不是新的用户指令；需要细节时用 read_tool_result 或 read_file 回读。'
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
    content = `${content.slice(0, Math.max(0, maxChars - 30))}\n…（事实清单已按预算截断）`;
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

// 视图层应用压缩：去掉已被摘要覆盖的原始消息，并把摘要放在最前面。
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

// token 口径与费用口径分开：netSavingTokens 用于验收“是否真省 token”，
// netBenefitCNY 用于压缩决策（乘单价、含重建与回读成本）。
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

// Phase 2 的 R 估算：优先同类任务中位数，缺失时退回“已用步数”，并显式标注 fallback。
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

// Phase 1：只做预检查与事实清单生成，是否执行由调用方决定（必须与 trim 同请求）。
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
  taskId = '',
  turnId = ''
} = {}) {
  const base = { kind: 'piggyback', taskId, turnId, taskType, applied: false };
  if (!policy?.phase1) return { action: 'skip', reason: 'disabled', event: { ...base, reason: 'disabled' } };
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
  // 可选高水位：只有历史接近上下文窗口时才压缩，避免在常规 trim 点反复破坏前缀缓存。
  if (policy.phase1OverflowTokens > 0 && windowTokens < policy.phase1OverflowTokens) {
    return {
      action: 'skip',
      reason: 'belowOverflow',
      event: { ...base, reason: 'belowOverflow', windowTokens, phase1OverflowTokens: policy.phase1OverflowTokens }
    };
  }
  // Agent 感知租约：执行中的关键路径不压缩，除非上下文已达到溢出阈值。
  if (policy.suppressMidRunCompaction && usedSteps > 0
    && !(policy.phase1OverflowTokens > 0 && windowTokens >= policy.phase1OverflowTokens)) {
    return {
      action: 'skip',
      reason: 'midRunLease',
      event: { ...base, reason: 'midRunLease', windowTokens, usedSteps }
    };
  }

  const startAbs = compaction?.coveredEndIndex || 0;
  const range = selectCompactionRange({
    messages: windowMessages,
    absIndexById,
    startAbs,
    targetRatio: 0.5,
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
  // 摘要整块覆盖“从会话开头到本次边界”，避免增量压缩时丢掉更早的事实；
  // 压缩量仍按本次新增区间 [range.startAbs, range.endAbs) 计算。
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

// Phase 2：独立压缩。P_after 由调用方按 modelMessages 口径量出后传入。
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
    targetRatio: 0.5,
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
  // P_after 必须按“压缩点之后的模型消息”计算；由调用方提供测量函数，
  // 避免用 session.messages 的完整结果高估或低估重建范围。
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
