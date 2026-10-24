// ElevenLabs text-to-speech: Kannada replies are spoken, audio is cached by content, and Polly
// remains the fallback for Hindi and English
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ELEVENLABS_API_KEY = 'el_fake';
process.env.ELEVENLABS_VOICE_IDS = JSON.stringify({ kn: 'voice-kn', hi: 'voice-hi' });
const H = await import('./helpers/harness.mjs');

let voice;
before(async () => {
  H.quiet();
  voice = await import('../src/services/voiceProcessor.js');
});
beforeEach(() => { H.elevenTts.calls.length = 0; H.elevenTts.fail = false; });
after(() => H.close());

test('a Kannada reply is spoken by the Kannada ElevenLabs voice', async () => {
  assert.equal(voice.hasVoice('kn'), true);
  const url = await voice.generateAndUploadVoice('W-1', 'ನಮಸ್ಕಾರ ರಾಮ್', 'kn', 'greeting');
  assert.ok(url, 'presigned audio URL returned');
  assert.equal(H.elevenTts.calls.length, 1);
  assert.equal(H.elevenTts.calls[0].voiceId, 'voice-kn');
  assert.equal(H.elevenTts.calls[0].body.model_id, 'eleven_v3');
  assert.equal(H.elevenTts.calls[0].headers['xi-api-key'], 'el_fake');
  assert.ok([...H.s3.keys()].some((k) => k.includes('/tts-cache/')), 'audio cached in S3');
});

test('the same text is synthesised once and served from the cache afterwards', async () => {
  await voice.generateAndUploadVoice('W-2', 'ಹಾಜರಾತಿ ದಾಖಲಾಗಿದೆ', 'kn', 'checkin');
  await voice.generateAndUploadVoice('W-3', 'ಹಾಜರಾತಿ ದಾಖಲಾಗಿದೆ', 'kn', 'checkin');
  assert.equal(H.elevenTts.calls.length, 1);
});

test('when ElevenLabs fails, Hindi falls back to Polly and Kannada goes out as text only', async () => {
  H.elevenTts.fail = true;
  const pollyBefore = H.polly.calls.length;
  assert.ok(await voice.generateAndUploadVoice('W-4', 'Namaskar fallback', 'hi', 'greeting'));
  assert.equal(H.polly.calls.length, pollyBefore + 1);
  assert.equal(await voice.generateAndUploadVoice('W-4', 'ಹೊಸ ಸಂದೇಶ', 'kn', 'greeting'), null);
  assert.equal(H.polly.calls.length, pollyBefore + 1, 'Kannada is never read by a Hindi Polly voice');
});

test('a language with no ElevenLabs voice and no Polly voice stays text-only', async () => {
  assert.equal(voice.hasVoice('ta'), false);
  assert.equal(await voice.generateAndUploadVoice('W-5', 'வணக்கம்', 'ta', 'greeting'), null);
  assert.equal(H.elevenTts.calls.length, 0);
});
