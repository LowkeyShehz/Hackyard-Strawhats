// Nodus fraud signals on the check-in path: near-duplicate / recapture flags block auto-approval,
// selfie fingerprints are remembered, GPS is stored only as a cell + keyed hash, and a fraud
// service outage never blocks a check-in
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.FRAUD_SERVICE_URL = 'https://fraud.test';
process.env.FRAUD_SERVICE_TOKEN = 'fraud-token';
const H = await import('./helpers/harness.mjs');

const { M, send } = H;
const { putItem } = await import('../src/utils/dynamodb.js');
const { default: config } = await import('../src/utils/config.js');
const { gpsFingerprint } = await import('../src/services/fraudSignals.js');

const logsFor = (wid) => [...H.table('AttendanceLogs').values()].filter((l) => l.worker_id === wid);
const cleanResult = H.fraud.respond;

before(async () => {
  H.quiet();
  await putItem(config.tables.sites, {
    site_id: 'S1', site_name: 'Metro', is_active: 'true',
    geo_location: { latitude: 12.9716, longitude: 77.5946 }, radius_meters: 500,
  });
  H.llm.responder = H.defaultLlmResponder;
});
beforeEach(() => { H.fraud.respond = cleanResult; H.fraud.fail = false; });
after(() => H.close());

async function onboardAndCheckIn(phone) {
  await send(phone, M.text('Namaste'));
  await H.agree(phone);
  await send(phone, M.text('Ram Kumar'));
  await send(phone, M.image('a1'));
  await send(phone, M.image('s1'));
  await send(phone, M.location());
  await send(phone, M.image('c1'));
  await send(phone, M.location());
  await send(phone, M.audio('v1'));
  const w = H.worker(phone);
  return { w, log: logsFor(w.worker_id)[0] };
}

test('a clean Nodus analysis auto-approves and stores the selfie fingerprint', async () => {
  const { w, log } = await onboardAndCheckIn('919300000001');
  assert.equal(log.verification_status, 'auto_approved');
  const call = H.fraud.calls.at(-1);
  assert.equal(call.headers.Authorization, 'Bearer fraud-token');
  assert.ok(call.body.image_b64.length > 0);
  assert.deepEqual(log.fraud_signals, { source: 'local', near_duplicate_of: null, recapture_score: 0.1 });
  const worker = H.worker('919300000001');
  assert.equal(worker.selfie_history.length, 1);
  assert.equal(worker.selfie_history[0].phash, 'ab12');
  assert.equal(worker.face_embedding, 'ENROLLED', 'the enrolment embedding is kept, not replaced by a check-in');
  assert.ok(w.worker_id);
});

test('a near-duplicate selfie is flagged and routed to review instead of auto-approved', async () => {
  H.fraud.respond = () => ({ ...cleanResult(), near_duplicate: { date: '2026-10-20' }, flags: ['Near-duplicate of selfie from 2026-10-20 (phash distance 2)'] });
  const { log } = await onboardAndCheckIn('919300000002');
  assert.equal(log.verification_status, 'pending_review');
  assert.match(log.flagged_reason, /Nodus: Near-duplicate of selfie from 2026-10-20/);
  assert.equal(log.fraud_signals.near_duplicate_of, '2026-10-20');
});

test('a fraud service outage never blocks the check-in', async () => {
  H.fraud.fail = true;
  const { log } = await onboardAndCheckIn('919300000003');
  assert.equal(log.verification_status, 'auto_approved');
  assert.equal(log.fraud_signals, null);
});

test('GPS is stored as an ~11 m cell plus a keyed hash, never the exact fix', async () => {
  const { log } = await onboardAndCheckIn('919300000004');
  assert.ok(log.gps_cell && log.gps_hash, 'fingerprint stored');
  assert.equal(String(log.gps_cell.lat).split('.')[1]?.length <= 4, true);
  assert.equal(log.gps_hash.length, 64);
  const a = gpsFingerprint(12.97161234, 77.59461234);
  const b = gpsFingerprint(12.97161234, 77.59461234);
  const c = gpsFingerprint(12.97161299, 77.59461234);
  assert.equal(a.gps_hash, b.gps_hash, 'identical fixes hash the same');
  assert.notEqual(a.gps_hash, c.gps_hash, 'jittered fixes differ');
  assert.deepEqual(a.gps_cell, { lat: 12.9716, lng: 77.5946 });
});
