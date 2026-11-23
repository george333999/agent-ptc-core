// 把不同供应商的缓存用量字段归一化为 cache_hit_tokens / cache_miss_tokens。
// 兼容 OpenAI（prompt_tokens_details.cached_tokens）、DeepSeek（prompt_cache_hit_tokens）
// 与 Anthropic（cache_read_input_tokens / cache_creation_input_tokens）。

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
  // 供应商可能完全不返回缓存字段；此时 miss 是本地推算值，不能当成“0% 命中”展示。
  const fieldsPresent = hasField(details, 'cached_tokens')
    || hasField(usage, 'prompt_cache_hit_tokens')
    || hasField(usage, 'prompt_cache_miss_tokens')
    || hasField(usage, 'cache_hit_tokens')
    || hasField(usage, 'cache_miss_tokens')
    || hasField(usage, 'cache_read_input_tokens')
    || hasField(usage, 'cache_creation_input_tokens')
    || hasField(usage, 'cached_tokens');
  // 字段存在但命中与未命中都为 0 时没有有效缓存信息，属于空上报。
  const hasSignal = hit + miss > 0;
  if (prompt > 0) {
    // 命中与未命中之和不得超过输入 tokens；供应商字段矛盾时按输入上限截断。
    hit = Math.min(hit, prompt);
    miss = Math.min(miss, prompt - hit);
    // 只上报命中时，剩余输入按未命中补齐。
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

// 供应商前缀缓存能力探测：只做静态能力判断，不改变请求策略。
// 返回 true 表示已知支持；false 表示已知不支持（如本地 Ollama、DashScope Qwen）；
// null 表示未知，需要靠实际返回的 cache 字段继续观察。
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
