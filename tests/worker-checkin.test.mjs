// Regression tests for the daily check-in (triple verification) path.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/harness.mjs';

const { M, send } = H;
const { putItem, getItem } = await import('../src/utils/dynamodb.js');
const { default: config } = await import('../src/utils/config.js');
const { handler: att } = await import('../src/handlers/attendanceProcessor.js');
const { handler: notify } = await import('../src/handlers/notificationSender.js');

const M_PER_DEG = 111194.9; // metres per degree of latitude (R = 6371 km)
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

// Selfie + location + voice note
async function checkIn(phone) {
  await send(phone, M.image('c1'));
  await send(phone, M.location());
  return send(phone, M.audio('v1'));
}

let seq = 0;
async function seedWorker(extra = {}) {
  const worker_id = `w-seed-${++seq}`;
  await putItem(config.tables.workers, { worker_id, phone_number: `91800000${String(seq).padStart(4, '0')}`, profile_status: 'active', total_days_logged: 0, face_vector: 'f', ...extra });
  return worker_id;
}
const goodFace = { success: true, confidence: 95 };
const goodGeo = { success: true, confidence: 95, distance: 10, nearestSite: { site_id: 'S1', name: 'Metro', radius: 500 } };
const goodVoice = { success: true, confidence: 90, workDetails: { is_work_related: true } };

test('log_date is the IST calendar date, not the UTC date', async () => {
  const w = await onboard('919200000001');
  const realNow = Date.now;
  // 2026-09-26 20:30 UTC is 2026-09-27 02:00 IST
  Date.now = () => Date.UTC(2026, 8, 26, 20, 30);
  try {
    await checkIn('919200000001');
  } finally {
    Date.now = realNow;
  }
  const logs = logsFor(w.worker_id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].log_date, '2026-09-27');
});

test('two concurrent check-ins log once and increment total_days_logged once', async () => {
  const wid = await seedWorker();
  const run = () => att({ task: 'merge_decision', workerId: wid, faceResult: goodFace, geoResult: goodGeo, voiceResult: goodVoice });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['auto_approved', 'duplicate']);
  assert.equal(logsFor(wid).length, 1);
  assert.equal((await getItem(config.tables.workers, { worker_id: wid })).total_days_logged, 1);
});

test('a rejected log for today can still be replaced by a new check-in', async () => {
  const wid = await seedWorker();
  const first = await att({ task: 'merge_decision', workerId: wid, faceResult: { confidence: 10 }, geoResult: goodGeo, voiceResult: goodVoice });
  assert.equal(first.status, 'rejected');
  const second = await att({ task: 'merge_decision', workerId: wid, faceResult: goodFace, geoResult: goodGeo, voiceResult: goodVoice });
  assert.equal(second.status, 'auto_approved');
});

test('geo: a site whose fence contains the point wins over a closer site whose fence does not', async () => {
  const lat = 20, lng = 80;
  await putItem(config.tables.sites, { site_id: 'SMALL', site_name: 'Small', is_active: 'true', geo_location: { latitude: lat + 80 / M_PER_DEG, longitude: lng }, radius_meters: 50 });
  await putItem(config.tables.sites, { site_id: 'BIG', site_name: 'Big', is_active: 'true', geo_location: { latitude: lat - 300 / M_PER_DEG, longitude: lng }, radius_meters: 500 });
  const r = await att({ task: 'geo_verify', workerId: 'x', latitude: lat, longitude: lng });
  assert.equal(r.nearestSite.site_id, 'BIG');
  assert.equal(r.withinRadius, true);
  assert.ok(r.confidence >= 60);
});

test('geo: a point just outside the fence never gets confidence >= 60', async () => {
  const lat = 25, lng = 85;
  await putItem(config.tables.sites, { site_id: 'EDGE', site_name: 'Edge', is_active: 'true', geo_location: { latitude: lat + 550 / M_PER_DEG, longitude: lng }, radius_meters: 500 });
  const r = await att({ task: 'geo_verify', workerId: 'x', latitude: lat, longitude: lng });
  assert.equal(r.nearestSite.site_id, 'EDGE');
  assert.equal(r.withinRadius, false);
  assert.ok(r.confidence < 60, `confidence ${r.confidence}`);
});

test('face similarity 30-49 routes to pending review; reply has voice and days', async () => {
  const phone = '919200000002';
  await onboard(phone);
  H.rek.similarity = 45;
  const before = H.polly.calls.length;
  try {
    const r = await checkIn(phone);
    const w = H.worker(phone);
    assert.equal(logsFor(w.worker_id)[0].verification_status, 'pending_review');
    assert.match(r.replies[0], /review/);
    assert.match(r.replies[0], /0 din log hue, 3 din aur baaki/);
    assert.ok(r.replies.includes('[audio]'), 'spoken reply sent');
    assert.ok(H.polly.calls.length > before);
  } finally {
    H.rek.similarity = 95;
  }
});

test('Rekognition "no face" error gives a no_face face result, not a 500 envelope', async () => {
  const wid = await seedWorker();
  const { default: s3 } = await import('../src/utils/s3.js');
  await s3.uploadToS3(config.buckets.mediaRaw, s3.enrolledSelfieKey(wid), Buffer.from('ref'), 'image/jpeg');
  await s3.uploadToS3(config.buckets.mediaRaw, 'sel.jpg', Buffer.from('sel'), 'image/jpeg');
  H.rek.compareError = 'InvalidParameterException';
  try {
    const r = await att({ task: 'face_verify', workerId: wid, selfieKey: 'sel.jpg' });
    assert.equal(r.statusCode, undefined);
    assert.equal(r.reason, 'no_face');
    assert.equal(r.confidence, 0);
  } finally {
    H.rek.compareError = null;
  }
});

test('approved and duplicate replies carry voice and days logged / remaining', async () => {
  const phone = '919200000003';
  await onboard(phone);
  const ok = await checkIn(phone);
  assert.match(ok.replies[0], /Din 1 log hua. 2 din aur baaki/);
  
  // Use a different image ID 'c2' to bypass the new Phase 2 exact-image duplicate check,
  // so we can test the same-day duplicate check logic in attendanceProcessor.js
  const defaultMedia = H.wa.mediaBytes;
  H.wa.mediaBytes = Buffer.alloc(4096, 9);
  let dup;
  try {
    await send(phone, M.image('c2'));
    await send(phone, M.location());
    dup = await send(phone, M.text('ok'));
  } finally {
    H.wa.mediaBytes = defaultMedia;
  }

  assert.match(dup.replies[0] || '', /pehle se log/);
  assert.match(dup.replies[0] || '', /1 din log hue, 2 din aur baaki/);
  assert.ok(dup.replies.includes('[audio]'));
});

test('thresholds are compared before rounding', async () => {
  const w1 = await seedWorker();
  const r1 = await att({ task: 'merge_decision', workerId: w1, faceResult: { success: true, confidence: 59.5 }, geoResult: goodGeo, voiceResult: goodVoice });
  assert.equal(r1.status, 'pending_review', 'similarity 59.5 must not auto-approve');

  const w2 = await seedWorker();
  const farGeo = { success: false, confidence: 30, distance: 1000.4, nearestSite: { site_id: 'S1', name: 'Metro', radius: 500 } };
  const r2 = await att({ task: 'merge_decision', workerId: w2, faceResult: goodFace, geoResult: farGeo, voiceResult: goodVoice });
  assert.equal(r2.status, 'rejected', '1000.4 m is beyond 2x a 500 m radius');
});

test('LLM is_work_related "false" (string) is read as false', async () => {
  const prev = H.llm.responder;
  H.llm.responder = () => JSON.stringify({ is_work_related: 'false', activity: 'chatting', location_mention: null, confidence: 20 });
  try {
    const r = await att({ task: 'voice_verify', workerId: 'x', voiceTranscription: 'kuch nahi bas aise hi', language: 'hi' });
    assert.equal(r.success, false);
    assert.equal(r.workDetails.is_work_related, false);
  } finally {
    H.llm.responder = prev;
  }
});

test('geo_location is null when there is no geo result', async () => {
  const wid = await seedWorker();
  await att({ task: 'merge_decision', workerId: wid, faceResult: goodFace, geoResult: undefined, voiceResult: goodVoice });
  assert.equal(logsFor(wid)[0].geo_location, null);
});

test('reference selfie is enrolled under enrolled/ and legacy workers still match', async () => {
  const phone = '919200000004';
  const w = await onboard(phone);
  const enrolled = `${config.buckets.mediaRaw}/enrolled/${w.worker_id}/selfie.jpg`;
  assert.ok(H.s3.has(enrolled), 'enrolled reference selfie stored');

  // Legacy worker: only workers/{id}/selfie-latest.jpg exists
  H.s3.delete(enrolled);
  H.s3.set(`${config.buckets.mediaRaw}/workers/${w.worker_id}/selfie-latest.jpg`, Buffer.from('legacy-ref'));
  await checkIn(phone);
  assert.equal(logsFor(w.worker_id)[0].verification_status, 'auto_approved');
});

test('notification days remaining is clamped at 0', async () => {
  const wid = await seedWorker({ total_days_logged: 10, name: 'Ram' });
  const before = H.wa.sent.length;
  await notify({ workerId: wid, notificationType: 'attendance_confirmed', language: 'en' });
  const text = H.wa.sent.slice(before).find((m) => m.type === 'text').text.body;
  assert.match(text, /0 days remaining/);
});

test('skipping the voice note sends the check-in to review, never auto-approval', async () => {
  const phone = '919200000021';
  const w = await onboard(phone);
  await send(phone, M.image('c1'));
  await send(phone, M.location());
  await send(phone, M.text('ok'));
  const [log] = logsFor(w.worker_id);
  assert.equal(log.verification_status, 'pending_review');
  assert.match(log.flagged_reason, /Voice note skipped/);
});

test('a typed note instead of a voice note is sent to review', async () => {
  const phone = '919200000022';
  const w = await onboard(phone);
  await send(phone, M.image('c1'));
  await send(phone, M.location());
  await send(phone, M.text('aaj maine teesri manzil pe plaster kiya, number bhi bol diya'));
  const [log] = logsFor(w.worker_id);
  assert.equal(log.verification_status, 'pending_review');
  assert.match(log.flagged_reason, /Typed text instead of a voice note/);
});

test('a check-in expires if the location or voice comes more than 10 minutes after the selfie', async () => {
  const phone = '919200000023';
  const w = await onboard(phone);
  await send(phone, M.image('c1'));
  const state = H.states(w.worker_id).at(-1);
  state.pending_selfie_at = Date.now() - 11 * 60 * 1000;
  const r = await send(phone, M.location());
  assert.match(r.replies[0], /10 minute/);
  assert.equal(H.states(w.worker_id).at(-1).pending_selfie_key, undefined);
  assert.equal(logsFor(w.worker_id).length, 0);

  // A fresh selfie starts over and completes normally
  await send(phone, M.image('c3'));
  await send(phone, M.location());
  await send(phone, M.audio('v1'));
  assert.equal(logsFor(w.worker_id)[0].verification_status, 'auto_approved');
});

test('every voice request asks for the one-time number and does not advertise skipping', async () => {
  const phone = '919200000024';
  const w = await onboard(phone);
  await send(phone, M.image('c1'));
  const viaLocation = await send(phone, M.location());
  assert.match(viaLocation.replies[0], /number "\d{2}"/);
  assert.doesNotMatch(viaLocation.replies[0], /skip/i);

  // Skipping the location still asks for a number, and the check-in goes to review
  await putItem(config.tables.conversation, { ...H.states(w.worker_id).at(-1), current_step: 'awaiting_location', passcode: null });
  const viaSkip = await send(phone, M.text('skip'));
  const { passcode } = H.states(w.worker_id).at(-1);
  assert.ok(passcode >= 10 && passcode <= 99);
  assert.match(viaSkip.replies[0], new RegExp(`number "${passcode}"`));
  assert.doesNotMatch(viaSkip.replies[0], /skip/i);
});

test('voice checks leave the model room to reason before the JSON answer', async () => {
  await att({ task: 'voice_verify', workerId: 'x', voiceTranscription: 'ಇಂದು ನಾನು ಪೇಂಟಿಂಗ್ ಮಾಡಿದೆ ತೊಂಬತ್ತು', language: 'kn', passcode: 90 });
  const request = H.llm.requests.at(-1);
  assert.equal(request.reasoning_effort, 'low');
  assert.ok(request.max_tokens >= 800, `max_tokens ${request.max_tokens} leaves no room for reasoning`);
});
