import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheSampleFields, normalizeCacheUsage } from '../server/cache-usage.js';

test('OpenAI 兼容格式：prompt_tokens_details.cached_tokens', () => {
  const usage = normalizeCacheUsage({
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110,
    prompt_tokens_details: { cached_tokens: 80 }
  });
  assert.equal(usage.cache_hit_tokens, 80);
  assert.equal(usage.cache_miss_tokens, 20);
  assert.equal(usage.cache_hit_rate, 0.8);
});

test('DeepSeek 格式：prompt_cache_hit_tokens / prompt_cache_miss_tokens', () => {
  const usage = normalizeCacheUsage({
    prompt_tokens: 100,
    prompt_cache_hit_tokens: 60,
    prompt_cache_miss_tokens: 40
  });
  assert.equal(usage.cache_hit_tokens, 60);
  assert.equal(usage.cache_miss_tokens, 40);
  assert.equal(usage.cache_hit_rate, 0.6);
});

test('Anthropic 格式：读取 cache_read / cache_creation', () => {
  const raw = normalizeCacheUsage({
    prompt_tokens: 100,
    completion_tokens: 10,
    cache_read_input_tokens: 60,
    cache_creation_input_tokens: 20
  });
  assert.equal(raw.cache_hit_tokens, 60);
  assert.equal(raw.cache_miss_tokens, 40);
  assert.equal(raw.cache_hit_rate, 0.6);

  const normalized = normalizeCacheUsage({
    prompt_tokens: 100,
    cache_hit_tokens: 60,
    cache_miss_tokens: 40
  });
  assert.equal(normalized.cache_hit_tokens, 60);
  assert.equal(normalized.cache_miss_tokens, 40);
  assert.equal(normalized.cache_hit_rate, 0.6);
});

test('没有缓存字段时按全未命中处理', () => {
  const usage = normalizeCacheUsage({ prompt_tokens: 100, completion_tokens: 5 });
  assert.equal(usage.cache_hit_tokens, 0);
  assert.equal(usage.cache_miss_tokens, 100);
  assert.equal(usage.cache_hit_rate, 0);
});

test('空用量与缩略字段安全', () => {
  assert.equal(normalizeCacheUsage(null), null);
  assert.equal(normalizeCacheUsage(undefined), null);
  const empty = normalizeCacheUsage({});
  assert.equal(empty.cache_hit_tokens, 0);
  assert.equal(empty.cache_miss_tokens, 0);
  assert.equal(empty.cache_hit_rate, null);
});

test('日志字段使用统一的 camelCase', () => {
  const fields = cacheSampleFields({
    prompt_tokens: 100,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 80 }
  });
  assert.deepEqual(fields, {
    promptTokens: 100,
    completionTokens: 10,
    cacheHitTokens: 80,
    cacheMissTokens: 20,
    cacheHitRate: 0.8
  });
});
