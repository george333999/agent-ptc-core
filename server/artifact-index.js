// 产出索引：记录“本会话写过哪些文件 + 内容指纹 + 一行摘要”，
// 后续轮次引用旧产出时直接给出索引，避免为了确认内容再读一遍文件。
// 只保存确定性字段，不含时间戳/随机数。

import { fingerprintText } from './context-prefetch.js';

function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .slice(0, 240);
}

function firstMeaningfulLine(content) {
  const lines = String(content ?? '').split('\n');
  for (const line of lines) {
    const text = line.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 120);
  }
  return '';
}

export function summarizeArtifact(content) {
  const text = String(content ?? '');
  const lineCount = text ? text.split('\n').length : 0;
  const summary = firstMeaningfulLine(text);
  return {
    summary: summary || '(空文件)',
    chars: text.length,
    lines: lineCount
  };
}

export function artifactEntry({ path, content = '' } = {}) {
  const normalized = normalizePath(path);
  if (!normalized) return null;
  return {
    path: normalized,
    fingerprint: fingerprintText(content),
    ...summarizeArtifact(content)
  };
}

export function recordArtifact(index, artifact) {
  const entry = artifactEntry(artifact);
  if (!entry) return { added: false, entry: null, replaced: false };
  const target = index && typeof index === 'object' ? index : {};
  const replaced = Boolean(target[entry.path]);
  target[entry.path] = entry;
  return { added: true, entry, replaced };
}

export function shouldReuseArtifact(index, { path, content = '' } = {}) {
  const normalized = normalizePath(path);
  const entry = index?.[normalized];
  if (!entry) return { reuse: false, entry: null };
  const fingerprint = fingerprintText(content);
  return { reuse: entry.fingerprint === fingerprint, entry, fingerprint };
}

export function listArtifacts(index) {
  return Object.values(index && typeof index === 'object' ? index : {})
    .filter((entry) => entry?.path)
    .sort((left, right) => left.path.localeCompare(right.path));
}

const OLD_TURN_PATTERNS = /(?:之前|上次|刚才|刚刚|前面|早先|此前|历史|上一轮|上一步|先前|那个文件|那个结果|继续)/;

// 产出索引只在“引用旧产出”时注入；每行一条，受 token 上限约束。
export function renderArtifactIndex(index, { maxTokens = 1000, message = '' } = {}) {
  if (!(Number(maxTokens) > 0)) return '';
  if (!OLD_TURN_PATTERNS.test(String(message || ''))) return '';
  const entries = listArtifacts(index);
  if (!entries.length) return '';
  const budgetChars = Math.max(200, Math.floor(Number(maxTokens) * 2.5));
  const lines = [];
  let used = 0;
  for (const entry of entries) {
    const line = `- ${entry.path}：${entry.summary}（${entry.chars} 字符，指纹 ${entry.fingerprint}）`;
    if (used + line.length + 1 > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  const omitted = entries.length - lines.length;
  if (omitted > 0) lines.push(`…（共 ${entries.length} 个产出，已省略 ${omitted} 个）`);
  return [
    '## 本会话产出索引（内容指纹一致时可直接复用，不必重读）',
    ...lines
  ].join('\n');
}
