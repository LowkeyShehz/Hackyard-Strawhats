import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';

// Must be set before the harness loads config.js
process.env.ASYNC_WEBHOOK = 'true';
const H = await import('./helpers/harness.mjs');
const { mockClient } = await import('aws-sdk-client-mock');
const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');

const invokes = [];
mockClient(LambdaClient).on(InvokeCommand).callsFake((input) => {
  invokes.push(input);
  return { StatusCode: 202 };
});

before(() => H.quiet());
after(() => H.close());

test('webhook POST acknowledges immediately and hands the payload to an async invocation', async () => {
  const phone = '919100000900';
  const res = await H.handler(H.postEvent(H.wrap(phone, H.M.text('Namaste'))));
  assert.equal(res.statusCode, 200);
  assert.equal(invokes.length, 1);
  assert.equal(invokes[0].InvocationType, 'Event');
  assert.equal(H.worker(phone), undefined, 'nothing is processed in the webhook call itself');

  const asyncEvent = JSON.parse(Buffer.from(invokes[0].Payload).toString('utf8'));
  await H.handler(asyncEvent);
  assert.ok(H.worker(phone), 'the async invocation registers the worker');
});

test('a bad signature is rejected without starting an async invocation', async () => {
  const before = invokes.length;
  const res = await H.handler(H.postEvent(H.wrap('919100000901', H.M.text('hi')), { sig: 'sha256=00' }));
  assert.equal(res.statusCode, 403);
  assert.equal(invokes.length, before);
});
