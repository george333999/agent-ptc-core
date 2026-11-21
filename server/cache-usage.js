// 把不同供应商的缓存用量字段归一化为 cache_hit_tokens / cache_miss_tokens。
// 兼容 OpenAI（prompt_tokens_details.cached_tokens）、DeepSeek（prompt_cache_hit_tokens）
// 与 Anthropic（cache_read_input_tokens / cache_creation_input_tokens）。

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function normalizeCacheUsage(usage) {
  if (!usage || typeof usage !== 'object') return usage ?? null;
  const details = usage.prompt_tokens_details || {};
  const hit = toCount(
    details.cached_tokens
      ?? usage.prompt_cache_hit_tokens
      ?? usage.cache_hit_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.cached_tokens
  );
  const explicitMiss = usage.prompt_cache_miss_tokens ?? usage.cache_miss_tokens;
  const prompt = toCount(usage.prompt_tokens);
  const miss = explicitMiss !== undefined && explicitMiss !== null
    ? toCount(explicitMiss)
    : Math.max(0, prompt - hit);
  const total = hit + miss;
  return {
    ...usage,
    cache_hit_tokens: hit,
    cache_miss_tokens: miss,
    cache_hit_rate: total > 0 ? Number((hit / total).toFixed(4)) : null
  };
}

export function cacheSampleFields(usage) {
  const normalized = normalizeCacheUsage(usage);
  return {
    promptTokens: Number(normalized?.prompt_tokens) || 0,
    completionTokens: Number(normalized?.completion_tokens) || 0,
    cacheHitTokens: Number(normalized?.cache_hit_tokens) || 0,
    cacheMissTokens: Number(normalized?.cache_miss_tokens) || 0,
    cacheHitRate: normalized?.cache_hit_rate ?? null
  };
}
