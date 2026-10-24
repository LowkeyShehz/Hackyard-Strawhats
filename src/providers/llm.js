/**
 * Nirman Mitra — LLM Provider Interface
 * Single entry point for all LLM calls: complete({ system, prompt, json }).
 * Provider selected by LLM_PROVIDER (currently: 'groq'; default model openai/gpt-oss-120b). Responses cached in the
 * LLM response cache DynamoDB table.
 *
 * Usage:
 *   import { complete } from '../providers/llm.js';
 *   const text = await complete({ prompt, json: true, maxTokens: 200, cacheTtlSeconds: 3600 });
 */

import { createHash } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import config from '../utils/config.js';

const ddbDocClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: config.aws.region }),
);

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
    const result = await ddbDocClient.send(
      new GetCommand({ TableName: config.tables.bedrockCache, Key: { input_hash: hash } }),
    );
    if (result.Item && result.Item.ttl > Math.floor(Date.now() / 1000)) {
      return result.Item.response_text;
    }
  } catch (err) {
    console.warn('[LLM] Cache read failed:', err.message);
  }
  return null;
}

async function cachePut(hash, responseText, ttlSeconds) {
  try {
    await ddbDocClient.send(
      new PutCommand({
        TableName: config.tables.bedrockCache,
        Item: {
          input_hash: hash,
          response_text: responseText,
          ttl: Math.floor(Date.now() / 1000) + ttlSeconds,
          created_at: new Date().toISOString(),
        },
      }),
    );
  } catch (err) {
    console.warn('[LLM] Cache write failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────
// Providers
// ─────────────────────────────────────────────────────────

/** Groq — OpenAI-compatible chat completions */
async function groqComplete({ system, prompt, json, maxTokens, model }) {
  const apiKey = config.llm.groqApiKey;
  if (!apiKey || apiKey === 'PLACEHOLDER_FILL_ME') {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const reasons = model.startsWith('openai/gpt-oss');
  const body = {
    model,
    messages,
    max_tokens: maxTokens + (reasons ? REASONING_ALLOWANCE_TOKENS : 0),
    temperature: 0,
    ...(json && { response_format: { type: 'json_object' } }),
    // gpt-oss models reason before answering; keep reasoning short
    ...(reasons && { reasoning_effort: 'low' }),
  };

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    // Groq's error code and reason (never the prompt) so failures are diagnosable from the logs
    const error = await res.json().then((b) => b.error, () => null);
    const detail = error ? ` ${error.code || error.type}: ${error.failed_generation || error.message}` : '';
    throw new Error(`Groq request failed: HTTP ${res.status}${detail}`.slice(0, 300));
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

const PROVIDERS = {
  groq: groqComplete,
};

// ─────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────

/**
 * Run a chat completion with caching.
 * Throws on provider failure or timeout; callers handle fallback.
 * @param {object} args
 * @param {string} [args.system] - System prompt
 * @param {string} args.prompt - User prompt
 * @param {boolean} [args.json=false] - Request a JSON object response
 * @param {number} [args.maxTokens=500]
 * @param {number} [args.cacheTtlSeconds=0] - 0 = no caching
 * @returns {Promise<string>} Response text (JSON string when json=true)
 */
export async function complete({ system = '', prompt, json = false, maxTokens = 500, cacheTtlSeconds = 0 }) {
  const providerName = config.llm.provider;
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw new Error(`Unknown LLM_PROVIDER: ${providerName}`);
  }
  const model = config.llm.model;

  let cacheKey = null;
  if (cacheTtlSeconds > 0) {
    cacheKey = buildCacheKey([providerName, model, system, prompt, String(maxTokens), String(json)]);
    const cached = await cacheGet(cacheKey);
    if (cached) {
      console.log('[LLM] Cache HIT');
      return cached;
    }
  }

  const responseText = await provider({ system, prompt, json, maxTokens, model });

  if (cacheKey && responseText) {
    await cachePut(cacheKey, responseText, cacheTtlSeconds);
  }
  return responseText;
}

export default { complete };
