import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/harness.mjs';

const { M, send } = H;
const status = (r) => JSON.parse(r.res.body).status;

before(async () => {
  H.quiet();
  const { putItem } = await import('../src/utils/dynamodb.js');
  await putItem('NirmanMitra-Sites-dev', {
    site_id: 'S1', site_name: 'Metro', is_active: 'true',
    geo_location: { latitude: 12.9716, longitude: 77.5946 }, radius_meters: 500,
  });
  H.llm.responder = (p) => (p.includes('Classify their intent')
    ? JSON.stringify({ intent: 'help', confidence: 80 })
    : JSON.stringify({ is_work_related: true, activity: 'plaster', location_mention: '3rd floor', confidence: 90 }));
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

const logsFor = (workerId) => [...H.table('AttendanceLogs').values()].filter((l) => l.worker_id === workerId);

test('webhook verification echoes the challenge only for the right token', async () => {
  const ok = await H.handler(H.getEvent({ 'hub.mode': 'subscribe', 'hub.verify_token': H.VERIFY_TOKEN, 'hub.challenge': '42' }));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, '42');
  const bad = await H.handler(H.getEvent({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '42' }));
  assert.equal(bad.statusCode, 403);
});

test('POST with a bad signature is rejected before any processing', async () => {
  const res = await H.handler(H.postEvent(H.wrap('919100000001', M.text('hi')), { sig: 'sha256=deadbeef' }));
  assert.notEqual(res.statusCode, 200);
  assert.equal(H.worker('919100000001'), undefined);
});

test('freshly onboarded workers can complete a daily check-in', async () => {
  for (let i = 0; i < 10; i++) {
    const phone = `9191000100${String(i).padStart(2, '0')}`;
    const w = await onboard(phone);
    assert.equal(w.profile_status, 'active');
    const rows = H.states(w.worker_id);
    assert.equal(rows.length, 1, 'one conversation row per worker');
    assert.equal(rows[0].current_step, 'active');
    await checkIn(phone);
    assert.equal(logsFor(w.worker_id).length, 1, `check-in logged for worker ${i}`);
  }
});

test('demo keywords are ignored for numbers outside DEMO_PHONE_NUMBERS', async () => {
  const w = await onboard('919100000200');
  const r = await send('919100000200', M.text('demo cert'));
  assert.notEqual(status(r), 'demo_certificate_triggered');
  assert.equal(logsFor(w.worker_id).length, 0);
  assert.equal(H.worker('919100000200').total_days_logged, 0);
});

test('an LLM-returned demo intent is treated as help', async () => {
  await onboard('919100000201');
  const prev = H.llm.responder;
  H.llm.responder = () => JSON.stringify({ intent: 'demo_certificate', confidence: 99 });
  try {
    const r = await send('919100000201', M.text('mujhe kuch alag chahiye bhai sahab'));
    assert.notEqual(status(r), 'demo_certificate_triggered');
  } finally {
    H.llm.responder = prev;
  }
});

test('a failed transcription never becomes the worker name', async () => {
  const phone = '919100000300';
  await send(phone, M.text('Namaste'));
  await H.agree(phone);
  H.transcribe.fail = true;
  try {
    await send(phone, M.audio('n1'));
  } finally {
    H.transcribe.fail = false;
  }
  const w = H.worker(phone);
  assert.ok(!w.name, `name should be unset, got ${w.name}`);
  assert.equal(H.states(w.worker_id)[0].current_step, 'awaiting_name');
});
