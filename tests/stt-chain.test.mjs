// Speech-to-text provider chain: Nodus Whisper → ElevenLabs Scribe → Groq Whisper
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODUS_API_KEY = 'nodus_fake';
process.env.ELEVENLABS_API_KEY = 'el_fake';
const H = await import('./helpers/harness.mjs');

let transcribe;
const audio = Buffer.alloc(2048, 1);
const groqCalls = () => H.transcribe.jobs.length;

before(async () => {
  H.quiet();
  ({ transcribe } = await import('../src/providers/stt.js'));
});
beforeEach(() => { H.stt.calls.length = 0; H.stt.failProviders.clear(); });
after(() => H.close());

test('Nodus Whisper transcribes first, with the worker language', async () => {
  const groqBefore = groqCalls();
  const result = await transcribe(audio, 'kn');
  assert.deepEqual(result, { text: H.transcribe.text, provider: 'nodus' });
  assert.equal(H.stt.calls.length, 1);
  assert.equal(H.stt.calls[0].headers.Authorization, 'Bearer nodus_fake');
  assert.equal(H.stt.calls[0].form.model, 'openai/whisper-large-v3');
  assert.equal(H.stt.calls[0].form.language, 'kn');
  assert.equal(groqCalls(), groqBefore);
});

test('a Nodus failure falls through to ElevenLabs Scribe', async () => {
  H.stt.failProviders.add('nodus');
  const result = await transcribe(audio, 'hi');
  assert.equal(result.provider, 'elevenlabs');
  const el = H.stt.calls.at(-1);
  assert.equal(el.headers['xi-api-key'], 'el_fake');
  assert.equal(el.form.model_id, 'scribe_v1');
  assert.equal(el.form.language_code, 'hi');
});

test('Groq is the last resort, and total failure returns empty text', async () => {
  H.stt.failProviders.add('nodus');
  H.stt.failProviders.add('elevenlabs');
  assert.equal((await transcribe(audio, 'hi')).provider, 'groq');
  H.transcribe.fail = true;
  try {
    assert.deepEqual(await transcribe(audio, 'hi'), { text: '', provider: null });
  } finally {
    H.transcribe.fail = false;
  }
});
