// FACE_PROVIDER=none (no face bridge, no AWS): workers still register, and every check-in goes to
// an officer instead of being rejected for a missing face match
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.FACE_PROVIDER = 'none';
const H = await import('./helpers/harness.mjs');

const { M, send } = H;
const { putItem } = await import('../src/utils/dynamodb.js');
const { default: config } = await import('../src/utils/config.js');

before(async () => {
  H.quiet();
  await putItem(config.tables.sites, {
    site_id: 'S1', site_name: 'Metro', is_active: 'true',
    geo_location: { latitude: 12.9716, longitude: 77.5946 }, radius_meters: 500,
  });
  H.llm.responder = H.defaultLlmResponder;
});
after(() => H.close());

test('registration and check-in work without any face model, routed to review', async () => {
  const phone = '919500000001';
  const rekBefore = H.rek.compareSources.length;
  await send(phone, M.text('Namaste'));
  await H.agree(phone);
  await send(phone, M.text('Ram Kumar'));
  await send(phone, M.image('a1'));
  await send(phone, M.image('s1'));
  await send(phone, M.location());
  assert.equal(H.worker(phone).face_vector, 'unverified');
  await send(phone, M.image('c1'));
  await send(phone, M.location());
  await send(phone, M.audio('v1'));
  const log = [...H.table('AttendanceLogs').values()].find((l) => l.worker_id === H.worker(phone).worker_id);
  assert.equal(log.verification_status, 'pending_review');
  assert.match(log.flagged_reason, /Face check unavailable/);
  assert.equal(H.rek.compareSources.length, rekBefore);
});
