// 前缀漂移归因：比较相邻请求的 system/tools/prefix 哈希，
// 定位缓存命中率骤降时到底是哪一段字节发生了变化。
// 只读分析，不参与线上请求路径。

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hitRateOf(sample) {
  if (sample?.cacheHitRate === null || sample?.cacheHitRate === undefined) return null;
  const value = Number(sample.cacheHitRate);
  return Number.isFinite(value) ? value : null;
}

function averageHit(samples) {
  const values = samples.map(hitRateOf).filter((value) => value !== null && value !== undefined);
  if (!values.length) return null;
  return Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(4));
}

function shiftReasons(prev, current) {
  const reasons = [];
  if (String(prev.systemHash || '') !== String(current.systemHash || '')) reasons.push('system');
  if (String(prev.toolsHash || '') !== String(current.toolsHash || '')) reasons.push('tools');
  if (toNumber(prev.prefixChars) !== toNumber(current.prefixChars)) reasons.push('prefixChars');
  if (current.windowTrimmed && !prev.windowTrimmed) reasons.push('trim');
  if (current.compactionApplied && !prev.compactionApplied) reasons.push('compaction');
  if (!reasons.length) reasons.push('unknown');
  return reasons;
}

export function analyzeCacheSamples(samples, { windowSize = 5 } = {}) {
  const size = Math.max(1, Math.floor(Number(windowSize) || 5));
  const groups = new Map();
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (!sample || typeof sample !== 'object') continue;
    const workerId = String(sample.workerId || 'main');
    const sessionId = String(sample.sessionId || '');
    const key = `${sessionId}|${workerId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }

  const workers = [];
  const reasonCounts = {};
  for (const [key, list] of groups) {
    list.sort((left, right) => {
      const leftStep = toNumber(left.step, 0);
      const rightStep = toNumber(right.step, 0);
      if (leftStep !== rightStep) return leftStep - rightStep;
      return String(left.ts || '').localeCompare(String(right.ts || ''));
    });
    const changes = [];
    for (let index = 1; index < list.length; index += 1) {
      const prev = list[index - 1];
      const current = list[index];
      const changed = shiftReasons(prev, current).some((reason) => reason !== 'unknown');
      if (!changed) continue;
      const reasons = shiftReasons(prev, current);
      for (const reason of reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      const before = list.slice(Math.max(0, index - size), index);
      const after = list.slice(index, Math.min(list.length, index + size));
      changes.push({
        index,
        step: toNumber(current.step, 0),
        ts: current.ts || '',
        reasons,
        prefixCharsBefore: toNumber(prev.prefixChars),
        prefixCharsAfter: toNumber(current.prefixChars),
        hitRateBefore: averageHit(before),
        hitRateAfter: averageHit(after),
        cacheReportedBefore: prev.cacheReported !== false,
        cacheReportedAfter: current.cacheReported !== false
      });
    }
    workers.push({
      key,
      sessionId: key.slice(0, key.lastIndexOf('|')),
      workerId: key.slice(key.lastIndexOf('|') + 1),
      samples: list.length,
      reportedSamples: list.filter((sample) => sample.cacheReported !== false).length,
      averageHitRate: averageHit(list),
      changes: changes.length,
      changeDetails: changes
    });
  }

  return {
    windowSize: size,
    workers,
    reasonCounts,
    totalSamples: workers.reduce((total, worker) => total + worker.samples, 0),
    totalChanges: workers.reduce((total, worker) => total + worker.changes, 0)
  };
}

export function formatPrefixDiffReport(analysis, { limit = 20 } = {}) {
  const lines = [
    `# 前缀漂移归因`,
    '',
    `- 样本数：${analysis.totalSamples}`,
    `- 前缀变化次数：${analysis.totalChanges}`,
    `- 变化来源：${Object.entries(analysis.reasonCounts).map(([key, value]) => `${key}=${value}`).join('，') || '无'}`
  ];
  for (const worker of analysis.workers) {
    lines.push('', `## ${worker.workerId}（session ${worker.sessionId || '-'}）`);
    lines.push(`- 样本 ${worker.samples}，有缓存字段 ${worker.reportedSamples}，平均命中率 ${worker.averageHitRate === null ? '--' : `${(worker.averageHitRate * 100).toFixed(2)}%`}`);
    if (!worker.changeDetails.length) {
      lines.push('- 未检测到前缀漂移');
      continue;
    }
    for (const change of worker.changeDetails.slice(0, limit)) {
      const before = change.hitRateBefore === null ? '--' : `${(change.hitRateBefore * 100).toFixed(1)}%`;
      const after = change.hitRateAfter === null ? '--' : `${(change.hitRateAfter * 100).toFixed(1)}%`;
      lines.push(`- step ${change.step}：${change.reasons.join('+')}，prefix ${change.prefixCharsBefore}→${change.prefixCharsAfter}，命中 ${before}→${after}`);
    }
    if (worker.changeDetails.length > limit) {
      lines.push(`- ...另有 ${worker.changeDetails.length - limit} 次变化未展示`);
    }
  }
  return lines.join('\n');
}
