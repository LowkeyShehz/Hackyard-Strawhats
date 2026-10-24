// TTS_FALLBACK=none (Render): ElevenLabs speaks English and Hindi; Polly is never called, and a
// language without an ElevenLabs voice gets a text-only reply
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TTS_FALLBACK = 'none';
process.env.ELEVENLABS_API_KEY = 'el_fake';
process.env.ELEVENLABS_VOICE_IDS = JSON.stringify({ en: 'voice-en', hi: 'voice-hi' });
const H = await import('./helpers/harness.mjs');

let voice;
before(async () => {
  H.quiet();
  voice = await import('../src/services/voiceProcessor.js');
});
beforeEach(() => { H.elevenTts.calls.length = 0; H.elevenTts.fail = false; });
after(() => H.close());

test('English and Hindi replies are spoken by their ElevenLabs voices', async () => {
  assert.ok(await voice.generateAndUploadVoice('W-1', 'Attendance recorded', 'en', 'checkin'));
  assert.ok(await voice.generateAndUploadVoice('W-1', 'Hazri darj ho gayi', 'hi', 'checkin'));
  assert.deepEqual(H.elevenTts.calls.map((c) => c.voiceId), ['voice-en', 'voice-hi']);
});

test('without the Polly fallback, a failed or missing voice means a text-only reply', async () => {
  const pollyBefore = H.polly.calls.length;
  H.elevenTts.fail = true;
  assert.equal(await voice.generateAndUploadVoice('W-2', 'Namaskar again', 'hi', 'greeting'), null);
  H.elevenTts.fail = false;
  assert.equal(voice.hasVoice('kn'), false);
  assert.equal(await voice.generateAndUploadVoice('W-2', 'ನಮಸ್ಕಾರ', 'kn', 'greeting'), null);
  assert.equal(H.polly.calls.length, pollyBefore, 'Polly is never called');
});
