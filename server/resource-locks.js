// 分层资源锁：同一文件/目录的读写按“读-读兼容、写互斥”串行，读与写按祖先/后代关系冲突。
// 只提供资源互斥，不改变工具语义；文件版本登记用于验证调度判断“验证期间输入是否被改动”。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_CODES = {
  TIMEOUT: 'LOCK_TIMEOUT',
  ABORTED: 'LOCK_ABORTED',
  REENTRANT: 'LOCK_REENTRANT',
  UPGRADE: 'LOCK_UPGRADE'
};

export class LockError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LockError';
    this.code = code;
    Object.assign(this, details);
  }
}

function normalizePath(target) {
  const resolved = path.resolve(String(target));
  // Windows 文件系统大小写不敏感，锁 key 必须同样归一，否则同一文件会被当成两个资源。
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function fileKey(absPath) {
  return `file:${normalizePath(absPath)}`;
}

export function dirKey(absPath) {
  return `dir:${normalizePath(absPath)}`;
}

export function wsKey(workspace) {
  return `ws:${normalizePath(workspace)}`;
}

export function parseKey(key) {
  const text = String(key || '');
  const index = text.indexOf(':');
  if (index <= 0) return { kind: 'file', path: text };
  return { kind: text.slice(0, index), path: text.slice(index + 1) };
}

function isAncestor(parent, child) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function pathsRelated(a, b) {
  const left = normalizePath(a);
  const right = normalizePath(b);
  return left === right || isAncestor(left, right) || isAncestor(right, left);
}

// ws 覆盖工作区全部资源；目录/文件之间按路径祖先关系判断。
export function keysRelated(a, b) {
  const left = parseKey(a);
  const right = parseKey(b);
  if (left.kind === 'ws' || right.kind === 'ws') return true;
  return pathsRelated(left.path, right.path);
}

export function keysConflict(aMode, aKey, bMode, bKey) {
  if (aMode !== 'write' && bMode !== 'write') return false;
  return keysRelated(aKey, bKey);
}

function requestConflicts(left, right) {
  for (const [leftKey, leftMode] of left.keys) {
    for (const [rightKey, rightMode] of right.keys) {
      if (keysConflict(leftMode, leftKey, rightMode, rightKey)) return true;
    }
  }
  return false;
}

function requestHasWrite(request) {
  for (const mode of request.keys.values()) {
    if (mode === 'write') return true;
  }
  return false;
}

function uniqueKeys(keys) {
  return [...new Set((Array.isArray(keys) ? keys : []).filter(Boolean))];
}

function fingerprint(entry) {
  // 版本、大小、mtime 之外再带内容哈希前缀：外部工具可能改写内容后保留 mtime，
  // 仅比较元数据会把“输入已变”误判为未变。哈希在 observe 时本来就已计算，不增加额外读盘。
  const digest = entry.hash ? `:${entry.hash.slice(0, 12)}` : '';
  return `${entry.version}:${entry.size}:${Math.round(entry.mtimeMs)}${digest}`;
}

// 文件版本登记：工具写入后 version+1；验证调度用 snapshot/changed 判断“跑命令期间输入是否被改”。
export class VersionStore {
  constructor({ now = Date.now, hashLimit = 2 * 1024 * 1024 } = {}) {
    this.now = now;
    this.hashLimit = hashLimit;
    this.entries = new Map();
  }

  _stat(absPath) {
    try {
      const stat = fs.statSync(absPath);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  _hash(absPath, size) {
    if (size > this.hashLimit) return '';
    try {
      return crypto.createHash('sha1').update(fs.readFileSync(absPath)).digest('hex').slice(0, 16);
    } catch {
      return '';
    }
  }

  observe(absPath, { bump = false } = {}) {
    const key = normalizePath(absPath);
    const previous = this.entries.get(key);
    const stat = this._stat(absPath);
    const version = Math.max(0, Number(previous?.version) || 0) + (bump ? 1 : 0);
    const entry = stat
      ? { version, hash: this._hash(absPath, stat.size), mtimeMs: stat.mtimeMs, size: stat.size, updatedAt: this.now() }
      : { version, hash: '', mtimeMs: 0, size: 0, updatedAt: this.now(), missing: true };
    this.entries.set(key, entry);
    return entry;
  }

  bump(absPath) {
    return this.observe(absPath, { bump: true });
  }

  bumpKeys(keys) {
    for (const key of uniqueKeys(keys)) this.bump(parseKey(key).path);
  }

  versionOf(absPath) {
    return this.entries.get(normalizePath(absPath))?.version || 0;
  }

  snapshot(absPaths) {
    const map = new Map();
    for (const absPath of uniqueKeys(absPaths)) {
      map.set(normalizePath(absPath), fingerprint(this.observe(absPath)));
    }
    return map;
  }

  // 返回发生变化的路径；只比较版本/大小/修改时间，避免每次验证都重算大文件哈希。
  changed(snapshot) {
    const changes = [];
    for (const [key, value] of snapshot) {
      if (fingerprint(this.observe(key)) !== value) changes.push(key);
    }
    return changes;
  }

  versionMap(absPaths) {
    const map = {};
    for (const absPath of uniqueKeys(absPaths)) {
      const entry = this.observe(absPath);
      map[absPath] = entry.version;
    }
    return map;
  }
}

export class ResourceLocks {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.active = [];
    this.queue = [];
    this.seq = 0;
    this.versions = new VersionStore({ now });
    this.stats = { acquired: 0, waits: 0, waitMs: 0, maxWaitMs: 0, timeouts: 0, aborts: 0, queued: 0, active: 0 };
  }

  _conflictsWithActive(request) {
    for (const holder of this.active) {
      for (const [key, mode] of holder.keys) {
        for (const [reqKey, reqMode] of request.keys) {
          if (keysConflict(mode, key, reqMode, reqKey)) return holder;
        }
      }
    }
    return null;
  }

  _holderSummary(request) {
    const holders = [];
    for (const holder of this.active) {
      for (const key of holder.keys.keys()) {
        if ([...request.keys.keys()].some((reqKey) => keysRelated(key, reqKey))) {
          holders.push({ key, owner: holder.owner || null });
        }
      }
    }
    return holders.slice(0, 8);
  }

  _reentrant(request) {
    if (!request.owner) return null;
    for (const holder of this.active) {
      if (holder.owner !== request.owner) continue;
      for (const [key, mode] of holder.keys) {
        for (const [reqKey, reqMode] of request.keys) {
          if (keysConflict(mode, key, reqMode, reqKey)) return { key, mode, reqKey, reqMode };
        }
      }
    }
    return null;
  }

  _grant(request) {
    request.grantedAt = this.now();
    request.waitMs = request.immediate ? 0 : Math.max(0, request.grantedAt - request.enqueuedAt);
    this.stats.acquired += 1;
    this.stats.waits += 1;
    this.stats.waitMs += request.waitMs;
    this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, request.waitMs);
    if (request.onAbort) request.signal?.removeEventListener('abort', request.onAbort);
    if (request.timer) clearTimeout(request.timer);
    const holder = { owner: request.owner || null, keys: request.keys };
    this.active.push(holder);
    this.stats.active = this.active.length;
    let released = false;
    request.resolve({
      keys: [...request.keys.keys()],
      waitMs: request.waitMs,
      release: () => {
        if (released) return;
        released = true;
        this.active = this.active.filter((item) => item !== holder);
        this.stats.active = this.active.length;
        this._pump();
      }
    });
  }

  _remove(request) {
    this.queue = this.queue.filter((item) => item !== request);
    this.stats.queued = this.queue.length;
  }

  _pump() {
    // 写者优先：读者不能越过更早的冲突写者；但无关资源可以跳过被挡住的请求，避免队头阻塞。
    let index = 0;
    while (index < this.queue.length) {
      const request = this.queue[index];
      if (!this._conflictsWithActive(request)) {
        const earlierWriter = this.queue
          .slice(0, index)
          .some((other) => requestHasWrite(other) && requestConflicts(other, request));
        if (!earlierWriter) {
          this.queue.splice(index, 1);
          this._grant(request);
          continue;
        }
      }
      index += 1;
    }
    this.stats.queued = this.queue.length;
  }

  acquire({ reads = [], writes = [] } = {}, { signal = null, timeoutMs = Infinity, owner = null } = {}) {
    const keys = new Map();
    // 同一个命令可能原地读写同一目录/文件（例如批量修改 todos/ 下的文件）。
    // 这种请求按“写”处理即可：不能降级为读，也不该因为自重叠直接失败。
    const add = (list, mode) => {
      for (const key of uniqueKeys(list)) {
        const existing = keys.get(key);
        if (!existing) keys.set(key, mode);
        else if (mode === 'write') keys.set(key, 'write');
      }
    };
    add(reads, 'read');
    add(writes, 'write');

    if (signal?.aborted) {
      return Promise.reject(new LockError(LOCK_CODES.ABORTED, '任务已取消'));
    }
    if (!keys.size) return Promise.resolve({ keys: [], waitMs: 0, release: () => {} });

    const request = { seq: this.seq += 1, keys, owner, signal, enqueuedAt: this.now(), waitMs: 0 };
    const reentrant = this._reentrant(request);
    if (reentrant) {
      return Promise.reject(new LockError(LOCK_CODES.REENTRANT, `锁不可重入：${reentrant.reqKey}`, reentrant));
    }
    // 队列为空且无冲突时同步授予，避免纯并发读被微任务拖慢。
    if (!this.queue.length && !this._conflictsWithActive(request)) {
      return new Promise((resolve) => {
        request.resolve = resolve;
        request.immediate = true;
        this._grant(request);
      });
    }

    return new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
      if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
        request.timer = setTimeout(() => {
          this._remove(request);
          this.stats.timeouts += 1;
          reject(new LockError(LOCK_CODES.TIMEOUT, `等待资源锁超时（${timeoutMs}ms）`, {
            timeoutMs,
            holders: this._holderSummary(request)
          }));
        }, timeoutMs);
      }
      if (signal) {
        request.onAbort = () => {
          this._remove(request);
          this.stats.aborts += 1;
          reject(new LockError(LOCK_CODES.ABORTED, '任务已取消'));
        };
        signal.addEventListener('abort', request.onAbort, { once: true });
      }
      this.queue.push(request);
      this.stats.queued = this.queue.length;
      this._pump();
    });
  }
}

export function createResourceLocks(options = {}) {
  return new ResourceLocks(options);
}
