// Normalize cache-usage fields from different providers into cache_hit_tokens / cache_miss_tokens.
// Compatible with OpenAI (prompt_tokens_details.cached_tokens), DeepSeek (prompt_cache_hit_tokens)
// and Anthropic (cache_read_input_tokens / cache_creation_input_tokens).

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function hasField(source, key) {
  return Boolean(source)
    && Object.prototype.hasOwnProperty.call(source, key)
    && source[key] !== undefined
    && source[key] !== null;
}

export function normalizeCacheUsage(usage) {
  if (!usage || typeof usage !== 'object') return usage ?? null;
  const details = usage.prompt_tokens_details || {};
  const prompt = toCount(usage.prompt_tokens);
  let hit = toCount(
    details.cached_tokens
      ?? usage.prompt_cache_hit_tokens
      ?? usage.cache_hit_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.cached_tokens
  );
  const explicitMiss = usage.prompt_cache_miss_tokens ?? usage.cache_miss_tokens;
  let miss = explicitMiss !== undefined && explicitMiss !== null
    ? toCount(explicitMiss)
    : Math.max(0, prompt - hit);
  // A provider may return no cache fields at all; then miss is a locally derived value and must not be shown as a "0% hit".
  const fieldsPresent = hasField(details, 'cached_tokens')
    || hasField(usage, 'prompt_cache_hit_tokens')
    || hasField(usage, 'prompt_cache_miss_tokens')
    || hasField(usage, 'cache_hit_tokens')
    || hasField(usage, 'cache_miss_tokens')
    || hasField(usage, 'cache_read_input_tokens')
    || hasField(usage, 'cache_creation_input_tokens')
    || hasField(usage, 'cached_tokens');
  // Fields present but both hit and miss are 0 means no valid cache information; this is an empty report.
  const hasSignal = hit + miss > 0;
  if (prompt > 0) {
    // Hit plus miss must not exceed input tokens; when provider fields contradict, truncate to the input cap.
    hit = Math.min(hit, prompt);
    miss = Math.min(miss, prompt - hit);
    // If only a hit is reported, fill the remaining input as misses.
    if (hit > 0 && miss === 0 && hit < prompt) miss = prompt - hit;
  }
  const total = hit + miss;
  const cacheReported = fieldsPresent && hasSignal;
  return {
    ...usage,
    cache_hit_tokens: hit,
    cache_miss_tokens: miss,
    cache_hit_rate: cacheReported
      ? (total > 0 ? Number((hit / total).toFixed(4)) : null)
      : (fieldsPresent || !total ? null : 0),
    cache_reported: cacheReported
  };
}

export function cacheSampleFields(usage) {
  const normalized = normalizeCacheUsage(usage);
  return {
    promptTokens: Number(normalized?.prompt_tokens) || 0,
    completionTokens: Number(normalized?.completion_tokens) || 0,
    cacheHitTokens: Number(normalized?.cache_hit_tokens) || 0,
    cacheMissTokens: Number(normalized?.cache_miss_tokens) || 0,
    cacheHitRate: normalized?.cache_hit_rate ?? null,
    cacheReported: normalized?.cache_reported ?? false
  };
}

// Provider prefix-cache capability probe: static capability check only, does not change the request strategy.
// true means known support; false means known unsupported (e.g. local Ollama, DashScope Qwen);
// null means unknown, so keep observing the cache fields actually returned.
export function supportsPrefixCache(model) {
  const provider = String(model?.provider || '').toLowerCase();
  const baseUrl = String(model?.baseUrl || '').toLowerCase();
  if (provider === 'anthropic') return true;
  if (provider === 'ollama') return false;
  if (/dashscope|aliyuncs/.test(baseUrl)) return false;
  if (/api\.deepseek\.com|api\.openai\.com|openai\.azure\.com|api\.moonshot\.cn|open\.bigmodel\.cn|api\.siliconflow\.cn/.test(baseUrl)) return true;
  if (!baseUrl) return null;
  return null;
}

export function cacheStrategyFor(model) {
  const support = supportsPrefixCache(model);
  if (support === true) return 'long-prefix';
  if (support === false) return 'short-prompt';
  return 'observe';
}
