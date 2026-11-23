import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheSampleFields,
  cacheStrategyFor,
  normalizeCacheUsage,
  supportsPrefixCache
} from '../server/cache-usage.js';

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

test('没有缓存字段时按全未命中计费，但标记为未上报', () => {
  const usage = normalizeCacheUsage({ prompt_tokens: 100, completion_tokens: 5 });
  assert.equal(usage.cache_hit_tokens, 0);
  assert.equal(usage.cache_miss_tokens, 100);
  assert.equal(usage.cache_hit_rate, 0);
  assert.equal(usage.cache_reported, false);
});

test('显式返回 0 命中时标记为已上报', () => {
  const usage = normalizeCacheUsage({
    prompt_tokens: 100,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 0 }
  });
  assert.equal(usage.cache_hit_rate, 0);
  assert.equal(usage.cache_reported, true);
});

test('空用量与缩略字段安全', () => {
  assert.equal(normalizeCacheUsage(null), null);
  assert.equal(normalizeCacheUsage(undefined), null);
  const empty = normalizeCacheUsage({});
  assert.equal(empty.cache_hit_tokens, 0);
  assert.equal(empty.cache_miss_tokens, 0);
  assert.equal(empty.cache_hit_rate, null);
  assert.equal(empty.cache_reported, false);
});

test('命中与未命中之和超过输入 tokens 时按 input 截断', () => {
  const usage = normalizeCacheUsage({
    prompt_tokens: 1000,
    prompt_cache_hit_tokens: 800,
    prompt_cache_miss_tokens: 300
  });
  assert.equal(usage.cache_hit_tokens, 800);
  assert.equal(usage.cache_miss_tokens, 200);
  assert.equal(usage.cache_hit_rate, 0.8);
  assert.equal(usage.cache_reported, true);
});

test('字段存在但命中与未命中都为 0 时视为未上报', () => {
  const usage = normalizeCacheUsage({
    prompt_tokens: 100,
    cache_hit_tokens: 0,
    cache_miss_tokens: 0
  });
  assert.equal(usage.cache_reported, false);
  assert.equal(usage.cache_hit_rate, null);
});

test('只上报缓存命中时，剩余输入补为未命中', () => {
  const usage = normalizeCacheUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 40 });
  assert.equal(usage.cache_hit_tokens, 40);
  assert.equal(usage.cache_miss_tokens, 60);
  assert.equal(usage.cache_hit_rate, 0.4);
  assert.equal(usage.cache_reported, true);
});

test('前缀缓存能力探测区分已知支持、已知不支持与未知', () => {
  assert.equal(supportsPrefixCache({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }), true);
  assert.equal(supportsPrefixCache({ provider: 'openai', baseUrl: 'https://api.deepseek.com/v1' }), true);
  assert.equal(supportsPrefixCache({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }), true);
  assert.equal(supportsPrefixCache({ provider: 'openai', baseUrl: 'http://localhost:11434/v1' }), null);
  assert.equal(supportsPrefixCache({ provider: 'ollama', baseUrl: 'http://localhost:11434' }), false);
  assert.equal(supportsPrefixCache({ provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }), false);
  assert.equal(cacheStrategyFor({ provider: 'ollama', baseUrl: 'http://localhost:11434' }), 'short-prompt');
  assert.equal(cacheStrategyFor({ provider: 'openai', baseUrl: 'https://api.deepseek.com' }), 'long-prefix');
  assert.equal(cacheStrategyFor({ provider: 'openai', baseUrl: 'https://unknown.example.com' }), 'observe');
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
    cacheHitRate: 0.8,
    cacheReported: true
  });
});
