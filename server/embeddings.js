const DEFAULT_EMBEDDING_URL = 'http://127.0.0.1:11434';
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const QUERY_CACHE_LIMIT = 100;
const FAILURE_BACKOFF_MS = 30000;
const queryCache = new Map();
const failureState = { key: '', at: 0, message: '' };

function cleanUrl(value) {
  const raw = String(value || DEFAULT_EMBEDDING_URL).trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_EMBEDDING_URL;
  }
}

function cleanModel(value) {
  const model = String(value || DEFAULT_EMBEDDING_MODEL).trim().slice(0, 120);
  return model || DEFAULT_EMBEDDING_MODEL;
}

export function embeddingConfigFor(settings = {}) {
  const enabled = settings.knowledgeVector !== false;
  const weight = Math.max(0, Math.min(Number(settings.knowledgeVectorWeight), 1));
  return {
    enabled,
    url: cleanUrl(settings.embeddingUrl),
    model: cleanModel(settings.embeddingModel),
    weight: Number.isFinite(weight) ? weight : 0.5
  };
}

function normalize(vector) {
  const output = new Float32Array(vector.length);
  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = Number(vector[index]);
    if (!Number.isFinite(value)) throw new Error('Embedding returned an invalid value');
    output[index] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (!norm) throw new Error('Embedding returned a zero vector');
  for (let index = 0; index < output.length; index += 1) output[index] /= norm;
  return output;
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  try {
    return AbortSignal.any([signal, timeout]);
  } catch {
    return timeout;
  }
}

async function embedBatch(baseUrl, model, texts, options = {}) {
  const signal = requestSignal(options.signal, options.timeoutMs || 60000);
  let response;
  try {
    response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts, truncate: true }),
      signal
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error('Embedding service timed out; please confirm Ollama is running');
    }
    throw new Error(`Unable to connect to the Embedding service (${baseUrl}): ${error.message}`);
  }
  if (response.status === 404) return embedLegacy(baseUrl, model, texts, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Embedding service returned ${response.status}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
    throw new Error('Embedding service returned an invalid format');
  }
  return data.embeddings.map(normalize);
}

async function embedLegacy(baseUrl, model, texts, options = {}) {
  const results = [];
  for (const text of texts) {
    const signal = requestSignal(options.signal, options.timeoutMs || 60000);
    const response = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      signal
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Embedding service returned ${response.status}`);
    }
    const data = await response.json().catch(() => ({}));
    if (!Array.isArray(data.embedding)) throw new Error('Embedding service returned an invalid format');
    results.push(normalize(data.embedding));
  }
  return results;
}

export async function embedTexts(texts, config, options = {}) {
  const input = (texts || []).map((text) => String(text || '')).filter(Boolean);
  if (!input.length) return [];
  if (!config?.enabled) return [];
  const baseUrl = cleanUrl(config.url);
  const model = cleanModel(config.model);
  const batchSize = Math.max(1, Math.min(Number(options.batchSize) || 8, 32));
  const vectors = [];
  for (let index = 0; index < input.length; index += batchSize) {
    vectors.push(...await embedBatch(baseUrl, model, input.slice(index, index + batchSize), options));
  }
  return vectors;
}

export async function embedQuery(text, config, options = {}) {
  const query = String(text || '').trim();
  if (!query || !config?.enabled) return null;
  const baseUrl = cleanUrl(config.url);
  const model = cleanModel(config.model);
  const failureKey = `${baseUrl}|${model}`;
  if (failureState.key === failureKey && Date.now() - failureState.at < FAILURE_BACKOFF_MS) {
    throw new Error(failureState.message);
  }
  const key = `${failureKey}|${query}`;
  if (queryCache.has(key)) return queryCache.get(key);
  try {
    const [vector] = await embedTexts([query], config, {
      ...options,
      batchSize: 1,
      timeoutMs: options.timeoutMs || 6000
    });
    if (!vector) return null;
    failureState.key = '';
    failureState.at = 0;
    failureState.message = '';
    if (queryCache.size >= QUERY_CACHE_LIMIT) {
      const oldest = queryCache.keys().next().value;
      if (oldest) queryCache.delete(oldest);
    }
    queryCache.set(key, vector);
    return vector;
  } catch (error) {
    failureState.key = failureKey;
    failureState.at = Date.now();
    failureState.message = error.message;
    throw error;
  }
}

export async function probeEmbedding(config) {
  const startedAt = Date.now();
  const [vector] = await embedTexts(['knowledge base semantic search connectivity test'], config, { batchSize: 1, timeoutMs: 30000 });
  if (!vector) throw new Error('Embedding service returned no vector');
  failureState.key = '';
  failureState.at = 0;
  failureState.message = '';
  return { ok: true, dims: vector.length, model: cleanModel(config.model), url: cleanUrl(config.url), latency: Date.now() - startedAt };
}
