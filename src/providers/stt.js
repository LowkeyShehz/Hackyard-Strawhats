/**
 * Nirman Mitra — Speech-to-Text Provider Chain
 * transcribe(audioBuffer, language) tries each provider in STT_PROVIDERS order until one returns
 * text: Nodus inference (Whisper large v3) → ElevenLabs Scribe → Groq Whisper. Providers without
 * a configured key are skipped.
 *
 * Usage:
 *   import { transcribe } from '../providers/stt.js';
 *   const { text, provider } = await transcribe(buffer, 'kn');
 */

import config from '../utils/config.js';
import { withRetry } from '../utils/retryHelper.js';

const TIMEOUT_MS = 15000;

function audioForm(audioBuffer, fields) {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'audio.ogg');
  for (const [key, value] of Object.entries(fields)) {
    if (value) form.append(key, value);
  }
  return form;
}

async function postTranscription(label, url, headers, form) {
  return withRetry(async () => {
    const res = await fetch(url, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`${label} API error ${res.status}: ${errText.slice(0, 200)}`);
    }
    return res.json();
  }, { label: `${label}:STT` });
}

/** Nodus inference — OpenAI-compatible /audio/transcriptions */
async function nodusTranscribe(audioBuffer, language) {
  const result = await postTranscription(
    'Nodus',
    `${config.llm.nodusBaseUrl}/audio/transcriptions`,
    { Authorization: `Bearer ${config.llm.nodusApiKey}` },
    audioForm(audioBuffer, { model: config.stt.nodusModel, language, response_format: 'json' }),
  );
  return result?.text || '';
}

/** ElevenLabs Scribe */
async function elevenLabsTranscribe(audioBuffer, language) {
  const result = await postTranscription(
    'ElevenLabs',
    'https://api.elevenlabs.io/v1/speech-to-text',
    { 'xi-api-key': config.elevenLabs.apiKey },
    audioForm(audioBuffer, { model_id: config.stt.elevenLabsModel, language_code: language }),
  );
  return result?.text || '';
}

/** Groq Whisper — OpenAI-compatible /audio/transcriptions */
async function groqTranscribe(audioBuffer, language) {
  const result = await postTranscription(
    'Groq',
    'https://api.groq.com/openai/v1/audio/transcriptions',
    { Authorization: `Bearer ${config.llm.groqApiKey}` },
    audioForm(audioBuffer, { model: 'whisper-large-v3-turbo', language, response_format: 'json' }),
  );
  return result?.text || '';
}

const PROVIDERS = {
  nodus: { run: nodusTranscribe, configured: () => Boolean(config.llm.nodusApiKey) },
  elevenlabs: { run: elevenLabsTranscribe, configured: () => Boolean(config.elevenLabs.apiKey) },
  groq: { run: groqTranscribe, configured: () => Boolean(config.llm.groqApiKey) },
};

/**
 * Transcribe a voice note, falling through the provider chain.
 * @param {Buffer} audioBuffer - Audio file buffer (WhatsApp sends ogg/opus)
 * @param {string} language - ISO 639-1 code
 * @returns {Promise<{text: string, provider: string|null}>} text is '' when every provider failed
 */
export async function transcribe(audioBuffer, language = 'hi') {
  for (const name of config.stt.providers) {
    const provider = PROVIDERS[name];
    if (!provider || !provider.configured()) continue;
    try {
      const text = await provider.run(audioBuffer, language);
      if (text) return { text, provider: name };
      console.warn(`[STT] ${name} returned no text`);
    } catch (err) {
      console.error(`[STT] ${name} failed:`, err.message);
    }
  }
  return { text: '', provider: null };
}

export default { transcribe };
