// Before Nodus access: LLM_PROVIDER=nodus with no NODUS_API_KEY runs on Groq directly, without a
// failed Nodus call on every request
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_PROVIDER = 'nodus';
process.env.LLM_MODEL = 'nodus/gpt-oss-120b';
delete process.env.NODUS_API_KEY;
const H = await import('./helpers/harness.mjs');

let complete;
before(async () => {
  H.quiet();
  ({ complete } = await import('../src/providers/llm.js'));
});
after(() => H.close());

test('without a Nodus key the Groq model is used and Nodus is never called', async () => {
  const text = await complete({ prompt: 'what can you do?', json: true });
  assert.equal(JSON.parse(text).intent, 'help');
  assert.equal(H.llm.requests.at(-1).model, 'openai/gpt-oss-120b');
  assert.equal(H.nodus.requests.length, 0);
});
