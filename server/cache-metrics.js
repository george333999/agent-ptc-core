import fs from 'node:fs';
import path from 'node:path';

// Append JSONL per day, recording the cache hit situation of each model call.
// A failed log write must never affect the main flow.

const queues = new Map();

export function cacheMetricsDir(dataDir) {
  return path.join(dataDir, 'cache-metrics');
}

export function recordCacheSample(dir, sample) {
  if (!dir || !sample) return Promise.resolve();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `cache-${day}.jsonl`);
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...sample })}\n`;
    const previous = queues.get(file) || Promise.resolve();
    const next = previous
      .then(() => fs.promises.appendFile(file, line, 'utf8'))
      .catch(() => {});
    queues.set(file, next);
    next.finally(() => {
      if (queues.get(file) === next) queues.delete(file);
    });
    return next;
  } catch {
    return Promise.resolve();
  }
}
