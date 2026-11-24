// LLM 请求治理：自适应并发、429 抖动退避与熔断。
// 只包裹“建立请求 + 读取响应头”这一段，SSE 开始后不再重试，避免重复计费或重复输出。

const DEFAULT_MAX_CONCURRENCY = 8;
const DEFAULT_MIN_CONCURRENCY = 1;
const DEFAULT_RECOVERY_SUCCESSES = 8;
const CIRCUIT_OPEN_MS = 60_000;

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('请求已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('请求已取消'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

// Retry-After 同时支持“秒数”和 HTTP 日期两种格式。
export function parseRetryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return 0;
  const text = String(value).trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(text);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return 0;
}

// 没有 Retry-After 时用 full jitter 指数退避：随机区间 [0, min(max, base*2^n)]。
export function computeRetryDelay(attempt, {
  retryAfterMs = 0,
  baseMs = 500,
  maxMs = 8000,
  random = Math.random
} = {}) {
  if (retryAfterMs > 0) return Math.min(Math.max(0, retryAfterMs), Math.max(maxMs, retryAfterMs));
  const ceiling = Math.min(maxMs, Math.max(0, baseMs) * (2 ** Math.max(0, attempt)));
  if (ceiling <= 0) return 0;
  return Math.max(50, Math.round(random() * ceiling));
}

export class LlmGovernor {
  constructor({
    maxConcurrency = envInt('LLM_MAX_CONCURRENCY', DEFAULT_MAX_CONCURRENCY),
    minConcurrency = DEFAULT_MIN_CONCURRENCY,
    recoverySuccesses = DEFAULT_RECOVERY_SUCCESSES,
    now = () => Date.now()
  } = {}) {
    this.maxConcurrency = Math.max(1, Number(maxConcurrency) || DEFAULT_MAX_CONCURRENCY);
    this.minConcurrency = Math.max(1, Math.min(Number(minConcurrency) || 1, this.maxConcurrency));
    this.limit = this.maxConcurrency;
    this.active = 0;
    this.waiters = [];
    this.recoverySuccesses = Math.max(1, Number(recoverySuccesses) || DEFAULT_RECOVERY_SUCCESSES);
    this.successStreak = 0;
    this.consecutiveThrottles = 0;
    this.coolDownUntil = 0;
    this.throttleCount = 0;
    this.waitMs = 0;
    this.now = now;
  }

  snapshot() {
    return {
      limit: this.limit,
      active: this.active,
      queued: this.waiters.length,
      coolDownMs: Math.max(0, this.coolDownUntil - this.now()),
      throttleCount: this.throttleCount,
      consecutiveThrottles: this.consecutiveThrottles,
      waitMs: this.waitMs
    };
  }

  async acquire(signal) {
    const waitStartedAt = this.now();
    const wait = async () => {
      if (this.coolDownUntil > this.now()) {
        const remaining = this.coolDownUntil - this.now();
        const error = new Error(`模型服务仍在限流冷却中，请约 ${Math.ceil(remaining / 1000)} 秒后重试。`);
        error.code = 'LLM_CIRCUIT_OPEN';
        error.retryAfterMs = remaining;
        throw error;
      }
      if (this.active < this.limit) {
        this.active += 1;
        return;
      }
      await new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        this.waiters.push(waiter);
        signal?.addEventListener?.('abort', () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason || new Error('请求已取消'));
        }, { once: true });
      });
      // 槽位由 release 直接转交，这里不再自增，避免并发窗口内超发。
    };
    await wait();
    this.waitMs += Math.max(0, this.now() - waitStartedAt);
    return () => this.release();
  }

  release() {
    // 熔断期间不再把槽位交给等待者，直接失败，避免冷却期内继续撞限流。
    if (this.coolDownUntil > this.now()) {
      this.active = Math.max(0, this.active - 1);
      const remaining = this.coolDownUntil - this.now();
      const error = new Error(`模型服务仍在限流冷却中，请约 ${Math.ceil(remaining / 1000)} 秒后重试。`);
      error.code = 'LLM_CIRCUIT_OPEN';
      error.retryAfterMs = remaining;
      while (this.waiters.length) this.waiters.shift().reject(error);
      return;
    }
    const next = this.waiters.shift();
    if (next) {
      // 直接把槽位交给下一个等待者，active 保持不变。
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  recordSuccess() {
    this.consecutiveThrottles = 0;
    this.successStreak += 1;
    if (this.successStreak >= this.recoverySuccesses && this.limit < this.maxConcurrency) {
      this.limit += 1;
      this.successStreak = 0;
    }
  }

  recordThrottle(retryAfterMs = 0) {
    this.throttleCount += 1;
    this.consecutiveThrottles += 1;
    this.successStreak = 0;
    this.limit = Math.max(this.minConcurrency, Math.floor(this.limit / 2));
    // 服务端明确给了较长等待时间时打开熔断，避免原地反复撞 429。
    if (retryAfterMs >= CIRCUIT_OPEN_MS) {
      this.coolDownUntil = Math.max(this.coolDownUntil, this.now() + retryAfterMs);
    }
  }
}

let governor = null;

export function getLlmGovernor() {
  if (!governor) governor = new LlmGovernor();
  return governor;
}

export function setLlmGovernor(custom) {
  governor = custom || null;
}

// 只对“请求尚未建立流”的错误重试；429/5xx 和网络错误可重试，其他 4xx 直接失败。
export async function fetchWithRetry(url, init, {
  signal,
  governor = getLlmGovernor(),
  retries = 2,
  baseMs = 500,
  maxMs = 8000,
  random = Math.random,
  fetchImpl = fetch
} = {}) {
  const releaseSlot = await governor.acquire(signal);
  let released = false;
  let throttleRecorded = false;
  const markThrottle = (retryAfterMs) => {
    if (throttleRecorded) return;
    throttleRecorded = true;
    governor.recordThrottle(retryAfterMs);
  };
  const release = () => {
    if (released) return;
    released = true;
    releaseSlot();
  };
  try {
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, { ...init, signal });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') {
          release();
          throw error;
        }
        if (attempt >= retries) {
          release();
          throw error;
        }
        await sleepWithSignal(computeRetryDelay(attempt, { baseMs, maxMs, random }), signal);
        continue;
      }
      if (response.ok) {
        governor.recordSuccess();
        // 成功建立流后释放并发槽：SSE 读取阶段不再占用“请求建立”额度。
        release();
        return response;
      }
      const retryable = response.status === 429 || response.status >= 500;
      const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'));
      if (!retryable || attempt >= retries) {
        if (response.status === 429) markThrottle(retryAfterMs);
        release();
        return response;
      }
      if (response.status === 429) markThrottle(retryAfterMs);
      try {
        await response.body?.cancel?.();
      } catch {
        // 忽略取消失败。
      }
      await sleepWithSignal(computeRetryDelay(attempt, { retryAfterMs, baseMs, maxMs, random }), signal);
    }
  } catch (error) {
    release();
    throw error;
  }
}
