// Face enrolment and matching on the face bridge (OpenCV SFace) instead of Amazon Rekognition
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.FRAUD_SERVICE_URL = 'https://fraud.test';
process.env.FRAUD_SERVICE_TOKEN = 'fraud-token';
const H = await import('./helpers/harness.mjs');

const { M, send } = H;
const { putItem } = await import('../src/utils/dynamodb.js');
const { default: config } = await import('../src/utils/config.js');

const logsFor = (wid) => [...H.table('AttendanceLogs').values()].filter((l) => l.worker_id === wid);
let rekCallsBefore;

before(async () => {
  H.quiet();
  await putItem(config.tables.sites, {
    site_id: 'S1', site_name: 'Metro', is_active: 'true',
    geo_location: { latitude: 12.9716, longitude: 77.5946 }, radius_meters: 500,
  });
  H.llm.responder = H.defaultLlmResponder;
});
beforeEach(() => {
  H.fraud.face = { problem: null, found: true, similarity: 95 };
  H.fraud.faceFail = false;
  rekCallsBefore = H.rek.compareSources.length;
});
after(() => H.close());

async function onboard(phone) {
  await send(phone, M.text('Namaste'));
  await H.agree(phone);
  await send(phone, M.text('Ram Kumar'));
  await send(phone, M.image('a1'));
  return send(phone, M.image('s1'));
}
async function checkIn(phone) {
  await send(phone, M.location());
  await send(phone, M.image('c1'));
  await send(phone, M.location());
  await send(phone, M.audio('v1'));
  return logsFor(H.worker(phone).worker_id)[0];
}

test('the bridge is the face provider when it is configured', () => {
  assert.equal(config.face.provider, 'bridge');
});

test('enrolment stores the SFace embedding, and a matching check-in auto-approves without Rekognition', async () => {
  await onboard('919400000001');
  const w = H.worker('919400000001');
  assert.equal(w.face_vector, 'sface');
  assert.equal(w.face_embedding, 'ENROLLED');
  const log = await checkIn('919400000001');
  assert.equal(log.verification_status, 'auto_approved');
  assert.equal(log.face_confidence, 95);
  const match = H.fraud.faceCalls.find((c) => c.path === '/face-match');
  assert.equal(match.body.enrolled_embedding, 'ENROLLED');
  assert.equal(match.headers.Authorization, 'Bearer fraud-token');
  assert.equal(H.rek.compareSources.length, rekCallsBefore, 'Rekognition not called');
});

test('the check-in selfie is linked on the log, so the review queue can show it', async () => {
  await onboard('919400000006');
  H.fraud.face.similarity = 50;
  const log = await checkIn('919400000006');
  assert.match(log.s3_media_keys.selfie, /checkin-selfie/);
  const token = (await H.callApi('POST', '/api/auth/seed', { body: { email: 'q@x.test', password: 'Pass-word-123', name: 'Q', seedSecret: 'test-seed-secret' } }), (await H.callApi('POST', '/api/auth/login', { body: { email: 'q@x.test', password: 'Pass-word-123' } })).body.accessToken);
  const queue = await H.callApi('GET', '/api/admin/review-queue', { token });
  const item = queue.body.items.find((i) => i.worker_id === log.worker_id);
  assert.ok(item.checkin_image_url, 'check-in selfie URL present');
});

test('a selfie with no face or two faces is refused at enrolment', async () => {
  H.fraud.face.problem = 'multiple_faces';
  const reply = await onboard('919400000002');
  assert.match(JSON.stringify(reply.replies), /More than one face|ek se zyada/);
  assert.equal(H.worker('919400000002').face_vector, undefined);
});

test('a weak match goes to review and a different face is rejected', async () => {
  await onboard('919400000003');
  H.fraud.face.similarity = 50;
  assert.equal((await checkIn('919400000003')).verification_status, 'pending_review');
  await onboard('919400000004');
  H.fraud.face.similarity = 10;
  assert.equal((await checkIn('919400000004')).verification_status, 'rejected');
});

test('a face service outage sends the day to an officer instead of rejecting it', async () => {
  await onboard('919400000005');
  H.fraud.faceFail = true;
  const log = await checkIn('919400000005');
  assert.equal(log.verification_status, 'pending_review');
  assert.match(log.flagged_reason, /Face check unavailable/);
});
