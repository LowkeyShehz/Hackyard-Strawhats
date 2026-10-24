// Nodus inference as the primary LLM provider, with Groq as the automatic fallback
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_PROVIDER = 'nodus';
process.env.LLM_MODEL = 'nodus/gpt-oss-120b';
process.env.NODUS_API_KEY = 'nodus_fake';
const H = await import('./helpers/harness.mjs');

let complete;
before(async () => {
  H.quiet();
  ({ complete } = await import('../src/providers/llm.js'));
});
after(() => H.close());

test('chat completions go to Nodus inference with the Nodus key and model', async () => {
  const groqBefore = H.llm.calls.length;
  const text = await complete({ prompt: 'voice note: plaster on 3rd floor', json: true, maxTokens: 200 });
  assert.equal(JSON.parse(text).is_work_related, true);
  const req = H.nodus.requests.at(-1);
  assert.equal(req.headers.Authorization, 'Bearer nodus_fake');
  assert.equal(req.body.model, 'nodus/gpt-oss-120b');
  assert.deepEqual(req.body.response_format, { type: 'json_object' });
  assert.equal(req.body.max_tokens, 200 + 600, 'gpt-oss reasoning allowance applies on Nodus too');
  assert.equal(H.llm.calls.length, groqBefore, 'Groq not called when Nodus succeeds');
});

test('a Nodus failure falls back to Groq with the Groq model', async () => {
  H.nodus.fail = true;
  try {
    const text = await complete({ prompt: 'what can you do?', json: true });
    assert.equal(JSON.parse(text).intent, 'help');
    assert.equal(H.llm.requests.at(-1).model, 'openai/gpt-oss-120b');
  } finally {
    H.nodus.fail = false;
  }
});
