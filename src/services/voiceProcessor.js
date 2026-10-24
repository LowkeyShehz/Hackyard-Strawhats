/**
 * Nirman Mitra — Voice Processor Service
 * Voice pipeline: Transcribe STT → language detection → Polly TTS.
 * Voice-first, zero literacy required.
 */

import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import config, { isDemoMode } from '../utils/config.js';
import { complete } from '../providers/llm.js';
import { uploadProcessedAudio, uploadWorkerMedia, downloadFromS3 } from '../utils/s3.js';
import { generatePresignedUrl } from '../utils/s3.js';
import { withRetry } from '../utils/retryHelper.js';
import { KN } from '../utils/i18n.js';

const pollyClient = new PollyClient({ region: config.aws.region });

// ─────────────────────────────────────────────────────────
// Language Detection
// ─────────────────────────────────────────────────────────

/**
 * Detect language of text (script + keyword heuristics)
 * @param {string} text - Input text (could be Hindi, English, or mixed)
 * @returns {Promise<string>} ISO 639-1 language code (hi, en, ta, te, kn, ml, bn, mr, gu)
 */
export async function detectLanguage(text) {
  // Simple keyword-based detection — no LLM call needed, faster and cheaper
  const lower = (text || '').toLowerCase();

  // A message naming a language ("English", "ಕನ್ನಡ") is an explicit choice
  const named = parseLanguageSwitch(text);
  if (named) return named;

  // Native scripts are unambiguous, so they are checked before any romanized keyword
  const scripts = {
    ta: /[\u0B80-\u0BFF]/,
    te: /[\u0C00-\u0C7F]/,
    kn: /[\u0C80-\u0CFF]/,
    ml: /[\u0D00-\u0D7F]/,
    bn: /[\u0980-\u09FF]/,
    gu: /[\u0A80-\u0AFF]/,
  };
  for (const [lang, pattern] of Object.entries(scripts)) {
    if (pattern.test(text || '')) return lang;
  }

  // Devanagari script (Hindi/Marathi)
  if (/[\u0900-\u097F]/.test(text || '')) {
    // Marathi-specific words
    if (/(^|\s)(मी|मला|आहे|काय)(\s|$)/.test(text)) return 'mr';
    return 'hi';
  }

  // Romanized greetings. "namaskar" / "namaste" are Hindi (the default), not Bengali.
  const keywords = {
    ta: /\b(vanakkam|nandri)\b/,
    te: /\bnamaskaram\b/,
    kn: /\bnamaskara\b/,
    ml: /\bnamaskkaram\b/,
    gu: /\bkem cho\b/,
    en: /\b(hello|hi|good morning|please|thank|work|site|name|my|the|is|am)\b/,
  };
  for (const [lang, pattern] of Object.entries(keywords)) {
    if (pattern.test(lower)) return lang;
  }

  // Default to Hindi for Indian construction workers
  return 'hi';
}

// Language names a worker can send to switch language, in English and in their own script
const LANGUAGE_NAMES = {
  en: ['english', 'angrezi', 'angreji', 'अंग्रेज़ी', 'अंग्रेजी'],
  hi: ['hindi', 'हिंदी', 'हिन्दी'],
  kn: ['kannada', 'ಕನ್ನಡ'],
  ta: ['tamil', 'தமிழ்'],
  te: ['telugu', 'తెలుగు'],
  ml: ['malayalam', 'മലയാളം'],
  bn: ['bengali', 'bangla', 'বাংলা'],
  mr: ['marathi', 'मराठी'],
  gu: ['gujarati', 'ગુજરાતી'],
};

/**
 * Detect an explicit language-switch message such as "English", "Hindi please", "ಕನ್ನಡ" or
 * "language: Kannada". Only a message that is essentially just a language name counts.
 * @param {string} text
 * @returns {string|null} ISO 639-1 code, or null if the message is not a language choice
 */
export function parseLanguageSwitch(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !['in', 'language', 'bhasha', 'please', 'plz', 'mein', 'me', 'change', 'to', 'switch', 'बात', 'में', 'भाषा'].includes(w));
  if (words.length !== 1) return null;
  for (const [lang, names] of Object.entries(LANGUAGE_NAMES)) {
    if (names.includes(words[0])) return lang;
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// Voice Transcription
// ─────────────────────────────────────────────────────────

// Language mapping is simplified as Whisper generally accepts ISO 639-1 ('hi', 'en', 'kn', etc)
// Groq Whisper API endpoint will be used for fast processing.

/**
 * Transcribe a voice note to text using Groq Whisper.
 * Uploads audio to S3, then directly posts to Groq API.
 * @param {Buffer} audioBuffer - Audio file buffer (ogg/wav/mp3)
 * @param {string} language - ISO 639-1 code
 * @param {string} [workerId] - Worker ID for S3 path
 * @returns {Promise<string>} Transcribed text, or '' if nothing could be transcribed
 */
export async function transcribeVoice(audioBuffer, language = 'hi', workerId = 'temp') {
  // Demo mode: return mock transcription
  if (isDemoMode() && (!audioBuffer || audioBuffer.length < 100)) {
    console.log('[VoiceProcessor DEMO] Returning mock transcription');
    return 'Ram Kumar';
  }

  if (!audioBuffer || audioBuffer.length < 100) {
    return '';
  }

  try {
    // Step 1: Upload audio to S3 for auditing (don't block transcription on it though we await it)
    await uploadWorkerMedia(workerId, 'voice-note', audioBuffer, 'audio/ogg').catch(e => console.error('[S3] Upload failed:', e));

    // Step 2: Use native fetch + FormData for Node to hit Groq Whisper
    const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
    const formData = new FormData();
    formData.append('file', blob, 'audio.ogg');
    formData.append('model', 'whisper-large-v3-turbo'); 
    formData.append('language', language);
    formData.append('response_format', 'json');

    const groqKey = config.llm.groqApiKey;
    if (!groqKey) throw new Error('GROQ_API_KEY is not set');

    const result = await withRetry(async () => {
      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKey}`
        },
        body: formData
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq API error ${response.status}: ${errText}`);
      }
      return response.json();
    }, { label: 'Groq:Whisper' });

    const transcript = result?.text || '';

    if (transcript) {
      console.log(`[Whisper] Result: "${transcript.substring(0, 100)}"`);
    } else {
      console.warn('[Whisper] No transcript produced');
    }
    return transcript;
  } catch (err) {
    console.error('Whisper failed:', err.message);
    return '';
  }
}

// ─────────────────────────────────────────────────────────
// Polly TTS — Voice Response Generation
// ─────────────────────────────────────────────────────────

/**
 * Generate a voice response using Amazon Polly Neural TTS
 * @param {string} text - Text to speak
 * @param {string} languageCode - ISO 639-1 code (hi, en, etc.)
 * @returns {Promise<Buffer>} Audio buffer (MP3); empty when the language has no Polly voice
 */
export async function generateVoiceResponse(text, languageCode = 'hi') {
  const voiceConfig = config.pollyVoices[languageCode];
  // No Polly voice for this language: speaking it with another language's voice would be
  // unintelligible, so the reply goes out as text only
  if (!voiceConfig) return Buffer.alloc(0);

  try {
    const result = await withRetry(
      () => pollyClient.send(
        new SynthesizeSpeechCommand({
          Text: text,
          OutputFormat: 'mp3',
          VoiceId: voiceConfig.voiceId,
          Engine: voiceConfig.engine,
          LanguageCode: voiceConfig.languageCode,
        }),
      ),
      { label: 'Polly:SynthesizeSpeech' },
    );

    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of result.AudioStream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    console.error('Polly TTS failed:', err.message);
    // Return empty buffer — caller should handle gracefully
    return Buffer.alloc(0);
  }
}

/** Whether Amazon Polly has a voice for this language (see config.pollyVoices) */
export function hasPollyVoice(languageCode) {
  return Boolean(config.pollyVoices[languageCode]);
}

/**
 * Generate voice response, upload to S3, and return a pre-signed URL
 * @param {string} workerId
 * @param {string} text - Text to speak
 * @param {string} languageCode
 * @param {string} label - e.g. 'greeting', 'confirmation'
 * @returns {Promise<string|null>} Pre-signed URL to the audio file, or null when there is no
 *   voice for the language or Polly failed
 */
export async function generateAndUploadVoice(workerId, text, languageCode, label) {
  if (!hasPollyVoice(languageCode)) return null; // text-only reply (e.g. Kannada)
  const audioBuffer = await generateVoiceResponse(text, languageCode);

  if (audioBuffer.length === 0) {
    console.warn('Empty audio buffer — Polly may have failed');
    return null;
  }

  const uploadResult = await uploadProcessedAudio(workerId, label, audioBuffer);
  const presignedUrl = await generatePresignedUrl(
    config.buckets.mediaProcessed,
    uploadResult.key,
    3600,
  );

  return presignedUrl;
}

// ─────────────────────────────────────────────────────────
// LLM Helper (backward-compat wrapper)
// ─────────────────────────────────────────────────────────

/**
 * @deprecated Use complete() from ../providers/llm.js directly
 */
export async function invokeLLM(prompt, maxTokens = 500) {
  return complete({ prompt, maxTokens });
}

// ─────────────────────────────────────────────────────────
// Greeting Messages per Language
// ─────────────────────────────────────────────────────────

/** Get greeting message in worker's language */
export function getGreetingMessage(language, workerName) {
  const greetings = {
    hi: workerName
      ? `Namaskar ${workerName}! Main Nirman Mitra hoon. Aapka registration ho gaya hai. Ab aap har din apna selfie aur voice note bhejkar attendance log kar sakte hain.`
      : `Namaskar! Main Nirman Mitra hoon — aapka digital saathi. Registration shuru karne ke liye, kripya apna naam boliye.`,
    en: workerName
      ? `Hello ${workerName}! I am Nirman Mitra. Your registration is complete. You can now log attendance daily by sending a selfie and voice note.`
      : `Hello! I am Nirman Mitra — your digital companion. To start registration, please say your name.`,
    kn: workerName ? KN.greetingRegistered(workerName) : KN.greetingNew,
  };
  return greetings[language] || greetings.hi;
}

/** Get step-specific prompt messages */
export function getStepPrompt(step, language = 'hi') {
  const prompts = {
    awaiting_name: {
      hi: 'Kripya apna poora naam boliye ya type kariye.',
      en: 'Please say or type your full name.',
      kn: KN.stepName,
    },
    awaiting_aadhaar: {
      hi: 'Dhanyavaad! Ab kripya apne Aadhaar card ka photo bhejiye.',
      en: 'Thank you! Now please send a photo of your Aadhaar card.',
      kn: KN.stepAadhaar,
    },
    awaiting_selfie: {
      hi: 'Aadhaar verified! Ab kripya apna ek selfie photo bhejiye.',
      en: 'Aadhaar verified! Now please send a selfie photo.',
      kn: KN.stepSelfie,
    },
    awaiting_passbook: {
      hi: 'Selfie saved! Ab kripya apne bank passbook ka photo bhejiye.',
      en: 'Selfie saved! Now please send a photo of your bank passbook.',
      kn: KN.stepPassbook,
    },
    registration_complete: {
      hi: 'Badhai ho! Aapka registration poora ho gaya. Ab aap har din selfie aur voice note bhejkar attendance log kar sakte hain.',
      en: 'Congratulations! Your registration is complete. You can now log attendance daily by sending a selfie and voice note.',
      kn: KN.stepRegistrationComplete,
    },
    retry_image: {
      hi: 'Photo clear nahi hai. Kripya achchi roshni mein dobara photo bhejiye.',
      en: 'The photo is not clear. Please send another photo in good lighting.',
      kn: KN.stepRetryImage,
    },
    error: {
      hi: 'Kuch problem ho gayi. Kripya thodi der baad dobara koshish karein.',
      en: 'Something went wrong. Please try again after some time.',
      kn: KN.stepError,
    },
  };
  return prompts[step]?.[language] || prompts[step]?.hi || prompts.error.hi;
}

export default {
  detectLanguage,
  parseLanguageSwitch,
  transcribeVoice,
  generateVoiceResponse,
  generateAndUploadVoice,
  hasPollyVoice,
  invokeLLM,
  getGreetingMessage,
  getStepPrompt,
};
