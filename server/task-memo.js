// Memo for similar tasks: disabled by default. Enabled only when the real repeat rate > 30%,
// and it must simultaneously satisfy "exact signature match + file fingerprint match"; it only outputs a hint and does not draw conclusions directly.
// Purpose: prevent the model from applying the previous conclusion as a fact to a new task.

import { fingerprintText } from './context-prefetch.js';

const TASK_HINTS = /(?:修复|修改|优化|重构|实现|新增|添加|排查|调试|生成|编写|补全|迁移|升级|测试|分析|整理|总结|写一份|做一个)/;
const NOISE = /[\s，。,.!！?？;；:：、"'“”‘’()（）[\]【】<>《》]/g;

// Strict signature: must contain an explicit action word, and still carry enough information after removing digits/punctuation/whitespace.
export function taskSignature(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!TASK_HINTS.test(text)) return { signature: '', fingerprint: '' };
  const normalized = text
    .toLowerCase()
    // Qualifiers in parentheses such as "second time/supplement" do not change the task itself.
    .replace(/[（(][^）)]{0,20}[）)]/g, '')
    .replace(/\d+/g, '#')
    .replace(NOISE, '')
    .slice(0, 200);
  if (normalized.length < 8) return { signature: '', fingerprint: '' };
  return { signature: normalized, fingerprint: fingerprintText(normalized) };
}

export function shouldEnableMemo(repeatRate) {
  const rate = Number(repeatRate);
  return Number.isFinite(rate) && rate > 0.3;
}

export function createTaskMemo({ maxEntries = 50 } = {}) {
  const entries = new Map();
  const counts = new Map();
  return {
    // Count on every task arrival; return the current repeat rate for shouldEnableMemo to decide.
    track(signature) {
      if (!signature) return { count: 0, repeatRate: 0 };
      const count = (counts.get(signature) || 0) + 1;
      counts.set(signature, count);
      const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
      return { count, repeatRate: total ? Number(((count - 1) / total).toFixed(4)) : 0 };
    },
    record({ signature, path = '', fingerprint = '', hint = '' } = {}) {
      if (!signature || !hint) return null;
      if (entries.size >= maxEntries && !entries.has(signature)) return null;
      const entry = { signature, path, fingerprint, hint: String(hint).slice(0, 200) };
      entries.set(signature, entry);
      return entry;
    },
    lookup({ signature, fingerprint = '' } = {}) {
      const entry = entries.get(signature);
      if (!entry) return null;
      // The fingerprint must match; an empty fingerprint means there is no verifiable artifact, so do not use the memo.
      if (!fingerprint || entry.fingerprint !== fingerprint) return null;
      return entry;
    },
    size() {
      return entries.size;
    }
  };
}

export function renderMemoHint(entry, { maxChars = 200 } = {}) {
  if (!entry?.hint) return '';
  const hint = String(entry.hint).slice(0, Math.max(40, Number(maxChars) || 200));
  return [
    '## Similar task hint (historical experience, for reference only; do not treat as fact)',
    `- Last similar task: ${hint}`,
    'If the current file fingerprint has changed, rely on the current file contents.'
  ].join('\n');
}
