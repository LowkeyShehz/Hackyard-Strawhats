/**
 * Nirman Mitra — ElevenLabs Text-to-Speech
 * Speaks replies in every language that has a voice in ELEVENLABS_VOICE_IDS, including Kannada,
 * which Amazon Polly cannot voice. voiceProcessor.js falls back to Polly (hi/en) when this fails.
 *
 * Usage:
 *   import { hasElevenLabsVoice, elevenLabsSpeak } from '../providers/tts.js';
 *   const mp3 = await elevenLabsSpeak('ನಮಸ್ಕಾರ', 'kn');
 */

import { createHash } from 'crypto';
import config from '../utils/config.js';
import { withRetry } from '../utils/retryHelper.js';

const TIMEOUT_MS = 15000;

function voiceFor(languageCode) {
  return config.elevenLabs.voiceIds[languageCode] || config.elevenLabs.voiceIds.default || null;
}

/** Whether ElevenLabs is configured with a voice for this language */
export function hasElevenLabsVoice(languageCode) {
  return Boolean(config.elevenLabs.apiKey && voiceFor(languageCode));
}

/**
 * Content-addressed cache key: the same text in the same voice and model is synthesised once,
 * which keeps fixed reply templates from spending ElevenLabs credits on every message.
 */
export function ttsCacheKey(text, languageCode) {
  const hash = createHash('sha256')
    .update([voiceFor(languageCode), config.elevenLabs.ttsModel, text].join('|'))
    .digest('hex');
  return `tts-cache/${hash}.mp3`;
}

/**
 * Synthesise speech with ElevenLabs.
 * @param {string} text
 * @param {string} languageCode - ISO 639-1
 * @returns {Promise<Buffer>} MP3 audio
 */
export async function elevenLabsSpeak(text, languageCode) {
  const voiceId = voiceFor(languageCode);
  if (!config.elevenLabs.apiKey || !voiceId) throw new Error(`No ElevenLabs voice for ${languageCode}`);

  return withRetry(async () => {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': config.elevenLabs.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text, model_id: config.elevenLabs.ttsModel }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`ElevenLabs TTS error ${res.status}: ${errText.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }, { label: 'ElevenLabs:TTS' });
}

export default { hasElevenLabsVoice, elevenLabsSpeak, ttsCacheKey };
