// LLM request governance: adaptive concurrency, 429 jitter backoff, and circuit breaking.
// Only the "establish request + read response headers" segment is wrapped; no retries after SSE begins, to avoid duplicate billing or duplicate output.

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
      reject(signal.reason || new Error('Request cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Request cancelled'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

// Retry-After supports both "seconds" and HTTP-date formats.
export function parseRetryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return 0;
  const text = String(value).trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(text);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return 0;
}

// Without Retry-After, use full jitter exponential backoff: random range [0, min(max, base*2^n)].
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
        const error = new Error(`The model service is still in rate-limiting cool-down; please retry in about ${Math.ceil(remaining / 1000)} seconds.`);
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
          reject(signal.reason || new Error('Request cancelled'));
        }, { once: true });
      });
      // The slot is handed over directly by release; do not increment here, to avoid over-issuing within a concurrency window.
    };
    await wait();
    this.waitMs += Math.max(0, this.now() - waitStartedAt);
    return () => this.release();
  }

  release() {
    // During the circuit-open period, stop handing slots to waiters and fail immediately, to avoid continuing to hit rate limits within the cool-down.
    if (this.coolDownUntil > this.now()) {
      this.active = Math.max(0, this.active - 1);
      const remaining = this.coolDownUntil - this.now();
      const error = new Error(`The model service is still in rate-limiting cool-down; please retry in about ${Math.ceil(remaining / 1000)} seconds.`);
      error.code = 'LLM_CIRCUIT_OPEN';
      error.retryAfterMs = remaining;
      while (this.waiters.length) this.waiters.shift().reject(error);
      return;
    }
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot directly to the next waiter; active stays unchanged.
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
    // Open the circuit breaker when the server explicitly gives a long wait time, to avoid repeatedly hitting 429 in place.
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

// Retry only errors where "the stream has not been established yet"; 429/5xx and network errors are retryable, other 4xx fail immediately.
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
        // Release the concurrency slot after the stream is established successfully: the SSE reading phase no longer occupies the "request establishment" quota.
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
        // Ignore cancellation failure.
      }
      await sleepWithSignal(computeRetryDelay(attempt, { retryAfterMs, baseMs, maxMs, random }), signal);
    }
  } catch (error) {
    release();
    throw error;
  }
}
