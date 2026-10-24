// Regression tests for webhook handling: dedup, batching, message types, intents, demo gating.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/harness.mjs';

const { M, send } = H;
const { putItem } = await import('../src/utils/dynamodb.js');
const { default: config, istDate } = await import('../src/utils/config.js');

const logsFor = (wid) => [...H.table('AttendanceLogs').values()].filter((l) => l.worker_id === wid);

before(async () => {
  H.quiet();
  await putItem(config.tables.sites, {
    site_id: 'S1', site_name: 'Metro', is_active: 'true',
    geo_location: { latitude: 12.9716, longitude: 77.5946 }, radius_meters: 500,
  });
  H.llm.responder = H.defaultLlmResponder;
});
after(() => H.close());

async function onboard(phone) {
  await send(phone, M.text('Namaste'));
  await H.agree(phone);
  await send(phone, M.text('Ram Kumar'));
  await send(phone, M.image('a1'));
  await send(phone, M.image('s1'));
  await send(phone, M.location());
  return H.worker(phone);
}

async function checkIn(phone) {
  await send(phone, M.image('c1'));
  await send(phone, M.location());
  return send(phone, M.audio('v1'));
}

test('a redelivered message id is processed only once', async () => {
  const phone = '919400000001';
  await send(phone, M.text('Namaste'));
  await H.agree(phone);
  const first = await send(phone, M.text('Ram Kumar'), { id: 'wamid.dup-1' });
  assert.equal(first.replies.length > 0, true);
  const again = await send(phone, M.text('Ram Kumar'), { id: 'wamid.dup-1' });
  assert.equal(again.replies.length, 0);
  assert.equal(H.states(H.worker(phone).worker_id)[0].current_step, 'awaiting_aadhaar');
});

test('every message in a batched payload is processed', async () => {
  const payload = H.wrap('919400000002', M.text('Namaste'));
  const second = H.wrap('919400000003', M.text('Hello')).entry[0];
  payload.entry.push(second);
  payload.entry[0].changes[0].value.messages.push({ from: '919400000004', id: 'wamid.batch-3', timestamp: '1', ...M.text('Namaste') });
  const res = await H.handler(H.postEvent(payload));
  assert.equal(res.statusCode, 200);
  for (const phone of ['919400000002', '919400000003', '919400000004']) {
    assert.ok(H.worker(phone), `worker ${phone} registered`);
  }
});

test('reactions, stickers, unsupported and system messages do not register a worker', async () => {
  const phone = '919400000005';
  const kinds = [
    { type: 'reaction', reaction: { message_id: 'wamid.x', emoji: '👍' } },
    { type: 'sticker', sticker: { id: 'st1', mime_type: 'image/webp' } },
    { type: 'unsupported', errors: [{ code: 131051 }] },
    { type: 'system', system: { body: 'changed number' } },
  ];
  for (const msg of kinds) {
    const r = await send(phone, msg);
    assert.equal(r.res.statusCode, 200);
    assert.equal(r.replies.length, 0);
  }
  assert.equal(H.worker(phone), undefined);
});

test('a consent notice that failed to send does not make the next "hello" the name', async () => {
  const phone = '919400000006';
  H.wa.failSend = true;
  try {
    const r = await send(phone, M.text('Hi'));
    assert.equal(r.res.statusCode, 200);
  } finally {
    H.wa.failSend = false;
  }
  const r = await send(phone, M.text('Hello'));
  assert.equal(H.worker(phone).name, undefined);
  assert.match(r.replies[0], /^\[buttons\]/, 'the consent notice is sent again');
  const agreed = await H.agree(phone);
  assert.ok(agreed.replies.some((reply) => /naam|name/i.test(reply)), `asks for the name: ${agreed.replies}`);
  await send(phone, M.text('Ram Kumar'));
  assert.equal(H.worker(phone).name, 'Ram Kumar');
});

test('"test review" never overwrites a real log for today', async () => {
  const phone = '919999999999'; // in DEMO_PHONE_NUMBERS
  const w = await onboard(phone);
  await checkIn(phone);
  const today = istDate();
  assert.equal(logsFor(w.worker_id).find((l) => l.log_date === today).verification_status, 'auto_approved');

  await send(phone, M.text('test review'));
  const logs = logsFor(w.worker_id);
  assert.equal(logs.find((l) => l.log_date === today).verification_status, 'auto_approved');
  const demo = logs.find((l) => l.verification_status === 'pending_review');
  assert.ok(demo, 'demo review log written');
  assert.equal(demo.log_date, istDate(Date.now() - 86400000));
});

test('"certificate status" / "certificate kab milega" route to the certificate intent', async () => {
  const phone = '919400000007';
  await onboard(phone);
  for (const text of ['certificate status', 'certificate kab milega']) {
    const r = await send(phone, M.text(text));
    assert.match(r.replies[0], /certificate ke liye \d+ din aur chahiye/);
  }
});

test('a bare "din" in a sentence is not a progress query', async () => {
  const phone = '919400000008';
  await onboard(phone);
  const calls = H.llm.calls.length;
  const r = await send(phone, M.text('aaj ka din accha tha'));
  assert.ok(H.llm.calls.slice(calls).some((p) => p.includes('Classify their intent')), 'falls through to the LLM');
  assert.doesNotMatch(r.replies[0], /mein se/);
});

test('an interactive button reply is handled as text', async () => {
  const phone = '919400000009';
  await onboard(phone);
  const r = await send(phone, M.button('progress', 'Progress'));
  assert.match(r.replies[0], /3 mein se 0 din log kiye/);
});
