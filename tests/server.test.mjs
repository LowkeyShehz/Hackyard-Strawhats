import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Must be set before the harness loads config.js
process.env.BACKGROUND_WEBHOOK = 'true';
const H = await import('./helpers/harness.mjs');
const { createServer } = await import('../src/server.js');
const { drainBackgroundWork } = await import('../src/handlers/messageHandler.js');

let server;
let base;

before(async () => {
  H.quiet();
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); H.close(); });

test('health check answers 200', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('webhook verification echoes the challenge through the server', async () => {
  const q = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': H.VERIFY_TOKEN, 'hub.challenge': '42' });
  const res = await fetch(`${base}/webhook/whatsapp?${q}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '42');
});

test('webhook POST acknowledges, then processes the message in the background', async () => {
  const phone = '919100000950';
  const raw = JSON.stringify(H.wrap(phone, H.M.text('Namaste')));
  const res = await fetch(`${base}/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': H.sign(raw) },
    body: raw,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'received');

  await drainBackgroundWork();
  assert.ok(H.worker(phone), 'the background work registers the worker');
});

test('a bad webhook signature is rejected', async () => {
  const raw = JSON.stringify(H.wrap('919100000951', H.M.text('hi')));
  const res = await fetch(`${base}/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'X-Hub-Signature-256': 'sha256=00' },
    body: raw,
  });
  assert.equal(res.status, 403);
  await drainBackgroundWork();
  assert.equal(H.worker('919100000951'), undefined);
});

test('API routes reach adminApi and unknown paths are 404', async () => {
  const unauthorized = await fetch(`${base}/api/admin/workers`);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('access-control-allow-origin'), '*');

  const missing = await fetch(`${base}/nope`);
  assert.equal(missing.status, 404);
});

test('on Render (RENDER=true) the real AWS code paths are used, not the in-memory demo store', () => {
  const script = "const { isDemoMode } = await import('./src/utils/config.js'); console.log(isDemoMode());";
  const env = { ...process.env, ENVIRONMENT: 'dev' };
  delete env.AWS_LAMBDA_FUNCTION_NAME;

  const onRender = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, RENDER: 'true' } });
  assert.equal(onRender.stdout.toString().trim(), 'false');

  const local = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env });
  assert.equal(local.stdout.toString().trim(), 'true');
});
