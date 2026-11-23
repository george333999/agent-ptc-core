// 同类任务备忘：默认关闭。只有真实重复率 > 30% 才开启，
// 并且必须同时满足“严格签名一致 + 文件指纹一致”，只输出提示，不直接下结论。
// 目的：避免模型把上一次的结论当成事实硬套到新的任务上。

import { fingerprintText } from './context-prefetch.js';

const TASK_HINTS = /(?:修复|修改|优化|重构|实现|新增|添加|排查|调试|生成|编写|补全|迁移|升级|测试|分析|整理|总结|写一份|做一个)/;
const NOISE = /[\s，。,.!！?？;；:：、"'“”‘’()（）[\]【】<>《》]/g;

// 严格签名：必须包含明确动作词，去掉数字/标点/空白后仍有足够信息量。
export function taskSignature(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!TASK_HINTS.test(text)) return { signature: '', fingerprint: '' };
  const normalized = text
    .toLowerCase()
    // 括号里的“第二次/补充”等限定词不改变任务本身。
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
    // 每次任务到达都计数；返回当前重复率，供 shouldEnableMemo 决策。
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
      // 指纹必须一致；空指纹表示没有可验证的产出，直接不使用备忘。
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
    '## 同类任务提示（历史经验，仅供参考，不要当作事实）',
    `- 上次同类任务：${hint}`,
    '如果当前文件指纹已变化，请以当前文件内容为准。'
  ].join('\n');
}
