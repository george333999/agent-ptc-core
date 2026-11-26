// Artifact index: records "which files were written in this session + content fingerprint + one-line summary".
// When later turns reference old artifacts, the index is provided directly, avoiding re-reading files just to confirm content.
// Only deterministic fields are stored; no timestamps or random numbers.

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
    summary: summary || '(empty file)',
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

// The artifact index is injected only when "referencing old artifacts"; one line per artifact, bounded by the token limit.
export function renderArtifactIndex(index, { maxTokens = 1000, message = '' } = {}) {
  if (!(Number(maxTokens) > 0)) return '';
  if (!OLD_TURN_PATTERNS.test(String(message || ''))) return '';
  const entries = listArtifacts(index);
  if (!entries.length) return '';
  const budgetChars = Math.max(200, Math.floor(Number(maxTokens) * 2.5));
  const lines = [];
  let used = 0;
  for (const entry of entries) {
    const line = `- ${entry.path}: ${entry.summary} (${entry.chars} chars, fingerprint ${entry.fingerprint})`;
    if (used + line.length + 1 > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  const omitted = entries.length - lines.length;
  if (omitted > 0) lines.push(`...(${entries.length} artifacts total, ${omitted} omitted)`);
  return [
    '## Artifact index for this session (reuse directly when the content fingerprint matches; no need to re-read)',
    ...lines
  ].join('\n');
}
