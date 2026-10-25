/**
 * Nirman Mitra — LLM Provider Interface
 * Single entry point for all LLM calls: complete({ system, prompt, json }).
 * Provider selected by LLM_PROVIDER ('nodus' or 'groq'). Both speak the OpenAI chat completions
 * API; when the primary fails the call is retried once on LLM_FALLBACK_PROVIDER. Responses cached
 * in the LLM response cache table.
 *
 * Usage:
 *   import { complete } from '../providers/llm.js';
 *   const text = await complete({ prompt, json: true, maxTokens: 200, cacheTtlSeconds: 3600 });
 */

import { createHash } from 'crypto';
import config from '../utils/config.js';
import { getItem, putItem } from '../utils/dynamodb.js';

const TIMEOUT_MS = 10000;
// gpt-oss reasoning tokens count against max_tokens (~200 even at low effort, more for Indic
// scripts), so they get their own allowance on top of the caller's answer budget
const REASONING_ALLOWANCE_TOKENS = 600;

// ─────────────────────────────────────────────────────────
// Cache helpers (LLM response cache table)
// ─────────────────────────────────────────────────────────

function buildCacheKey(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

async function cacheGet(hash) {
  try {
    const item = await getItem(config.tables.bedrockCache, { input_hash: hash });
    if (item && item.ttl > Math.floor(Date.now() / 1000)) {
      return item.response_text;
    }
  } catch (err) {
    console.warn('[LLM] Cache read failed:', err.message);
  }
  return null;
}

async function cachePut(hash, responseText, ttlSeconds) {
  try {
    await putItem(config.tables.bedrockCache, {
      input_hash: hash,
      response_text: responseText,
      ttl: Math.floor(Date.now() / 1000) + ttlSeconds,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[LLM] Cache write failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────
// Providers
// ─────────────────────────────────────────────────────────

/** Any OpenAI-compatible chat completions endpoint (Nodus inference, Groq) */
async function openAiCompatibleComplete({ label, url, apiKey, keyEnv, system, prompt, json, maxTokens, model }) {
  if (!apiKey || apiKey === 'PLACEHOLDER_FILL_ME') {
    throw new Error(`${keyEnv} is not configured`);
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const reasons = model.includes('gpt-oss');
  const body = {
    model,
    messages,
    max_tokens: maxTokens + (reasons ? REASONING_ALLOWANCE_TOKENS : 0),
    temperature: 0,
    ...(json && { response_format: { type: 'json_object' } }),
    // gpt-oss models reason before answering; keep reasoning short
    ...(reasons && { reasoning_effort: 'low' }),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    // The provider's error code and reason (never the prompt) so failures are diagnosable from the logs
    const error = await res.json().then((b) => b.error, () => null);
    const detail = error ? ` ${error.code || error.type}: ${error.failed_generation || error.message}` : '';
    throw new Error(`${label} request failed: HTTP ${res.status}${detail}`.slice(0, 300));
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/** Nodus inference — OpenAI-compatible, hosted on Nodus compute */
function nodusComplete(args) {
  return openAiCompatibleComplete({
    ...args,
    label: 'Nodus',
    url: `${config.llm.nodusBaseUrl}/chat/completions`,
    apiKey: config.llm.nodusApiKey,
    keyEnv: 'NODUS_API_KEY',
  });
}

/** Groq — OpenAI-compatible chat completions */
function groqComplete(args) {
  return openAiCompatibleComplete({
    ...args,
    label: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: config.llm.groqApiKey,
    keyEnv: 'GROQ_API_KEY',
  });
}

const PROVIDERS = {
  nodus: nodusComplete,
  groq: groqComplete,
};

const KEYS = {
  nodus: () => config.llm.nodusApiKey,
  groq: () => config.llm.groqApiKey,
};
const configured = (name) => Boolean(KEYS[name]?.());

/**
 * The provider and model to call: the primary when its key is set; otherwise the fallback, so a
 * deployment with LLM_PROVIDER=nodus runs on Groq until NODUS_API_KEY is added, then switches.
 */
function activeProvider() {
  const primary = config.llm.provider;
  const fallback = config.llm.fallbackProvider;
  if (!configured(primary) && fallback && fallback !== primary && configured(fallback)) {
    return { name: fallback, model: config.llm.fallbackModel, fallback: null };
  }
  return { name: primary, model: config.llm.model, fallback };
}

// ─────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────

/**
 * Run a chat completion with caching.
 * Throws when the provider (and the fallback provider, if any) fails or times out; callers
 * handle fallback.
 * @param {object} args
 * @param {string} [args.system] - System prompt
 * @param {string} args.prompt - User prompt
 * @param {boolean} [args.json=false] - Request a JSON object response
 * @param {number} [args.maxTokens=500]
 * @param {number} [args.cacheTtlSeconds=0] - 0 = no caching
 * @returns {Promise<string>} Response text (JSON string when json=true)
 */
export async function complete({ system = '', prompt, json = false, maxTokens = 500, cacheTtlSeconds = 0 }) {
  const { name: providerName, model, fallback: fallbackName } = activeProvider();
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw new Error(`Unknown LLM_PROVIDER: ${providerName}`);
  }

  let cacheKey = null;
  if (cacheTtlSeconds > 0) {
    cacheKey = buildCacheKey([providerName, model, system, prompt, String(maxTokens), String(json)]);
    const cached = await cacheGet(cacheKey);
    if (cached) {
      console.log('[LLM] Cache HIT');
      return cached;
    }
  }

  let responseText;
  try {
    responseText = await provider({ system, prompt, json, maxTokens, model });
  } catch (err) {
    if (!fallbackName || fallbackName === providerName || !PROVIDERS[fallbackName]) throw err;
    console.warn(`[LLM] ${providerName} failed, falling back to ${fallbackName}:`, err.message);
    responseText = await PROVIDERS[fallbackName]({
      system, prompt, json, maxTokens, model: config.llm.fallbackModel,
    });
  }

  if (cacheKey && responseText) {
    await cachePut(cacheKey, responseText, cacheTtlSeconds);
  }
  return responseText;
}

export default { complete };
