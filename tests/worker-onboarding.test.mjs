// Regression tests for onboarding: name, Aadhaar OCR, selfie enrollment, language.
import { test, after, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/harness.mjs';

const { M, send } = H;
const { default: config } = await import('../src/utils/config.js');
const { handler: docVerifier } = await import('../src/handlers/documentVerifier.js');

const DEFAULT_LINES = [...H.textract.lines];
const docsFor = (wid) => [...H.table('Documents').values()].filter((d) => d.worker_id === wid);
const step = (wid) => H.states(wid)[0];
const AADHAAR_LIKE = /\d{4}[ -]?\d{4}[ -]?\d{4}/;
// Record ids are random UUIDs, whose digit runs can look like an Aadhaar number by chance
const withoutUuids = (value) => JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');

before(() => H.quiet());
afterEach(() => {
  H.textract.lines = [...DEFAULT_LINES];
  H.textract.confidence = 95;
  H.textract.fail = false;
  H.rek.indexResult = null;
});
after(() => H.close());

async function toAadhaarStep(phone) {
  await send(phone, M.text('Namaste'));
  await H.agree(phone);
  await send(phone, M.text('Ram Kumar'));
  return H.worker(phone);
}

test('Aadhaar: picks the Verhoeff-valid number, skipping a VID and an invalid candidate', async () => {
  H.textract.lines = ['Government of India', 'Ram Kumar', 'VID : 9123 4567 8901 2345', '2830 7765 3455', '4918 3726 5103'];
  const w = await toAadhaarStep('919300000001');
  await send('919300000001', M.image('a1'));
  assert.equal(H.worker('919300000001').aadhaar_last4, '5103');
  assert.equal(step(w.worker_id).current_step, 'awaiting_selfie');
});

test('Aadhaar: an invalid-only number is not a success and counts as a retry', async () => {
  H.textract.lines = ['Government of India', 'Ram Kumar', '2830 7765 3455'];
  const w = await toAadhaarStep('919300000002');
  const r = await send('919300000002', M.image('a1'));
  assert.equal(H.worker('919300000002').aadhaar_last4, undefined);
  assert.equal(step(w.worker_id).current_step, 'awaiting_aadhaar');
  assert.equal(step(w.worker_id).retry_count, 1);
  assert.match(r.replies[0], /Aadhaar number/);
  assert.equal(docsFor(w.worker_id).length, 0);
});

test('Aadhaar: the card image is not stored and no full number lands in extracted data', async () => {
  H.textract.lines = ['Government of India', 'Ram Kumar', 'Address: 12 MG Road, Bengaluru 2830-7765-3450', 'Karnataka 560001'];
  const w = await toAadhaarStep('919300000003');
  await send('919300000003', M.image('a1'));
  assert.equal(H.worker('919300000003').aadhaar_last4, '3450');
  const [doc] = docsFor(w.worker_id);
  assert.equal(doc.extracted_data.address, '12 MG Road, Bengaluru');
  assert.doesNotMatch(withoutUuids(doc), AADHAAR_LIKE);
  assert.equal(doc.s3_key, undefined);
  assert.ok(![...H.s3.keys()].some((k) => k.startsWith(`${config.buckets.mediaRaw}/workers/${w.worker_id}/aadhaar`)), 'no Aadhaar image in S3');
});

test('Aadhaar: 3 failed photos flag for admin; flagged workers are not restarted', async () => {
  H.textract.confidence = 20;
  const phone = '919300000004';
  const w = await toAadhaarStep(phone);
  await send(phone, M.image('a1'));
  await send(phone, M.image('a2'));
  assert.equal(step(w.worker_id).current_step, 'awaiting_aadhaar');
  await send(phone, M.image('a3'));
  assert.equal(H.worker(phone).admin_flag, true);
  assert.equal(step(w.worker_id).current_step, 'admin_flagged');

  const r = await send(phone, M.text('Suresh'));
  assert.match(r.replies[0], /admin/);
  assert.equal(H.worker(phone).name, 'Ram Kumar', 'message not taken as a name');
  assert.equal(step(w.worker_id).current_step, 'admin_flagged');
});

test('Aadhaar: a text message re-prompts without consuming a retry', async () => {
  const phone = '919300000005';
  const w = await toAadhaarStep(phone);
  const r = await send(phone, M.text('card kal bhejunga'));
  assert.match(r.replies[0], /Aadhaar card ka photo/);
  assert.equal(step(w.worker_id).retry_count, 0);
});

test('Aadhaar: a Textract outage gets a temporary-problem reply and no retry is used', async () => {
  H.textract.fail = true;
  const phone = '919300000006';
  const w = await toAadhaarStep(phone);
  const r = await send(phone, M.image('a1'));
  assert.match(r.replies[0], /takleef|temporary/);
  assert.doesNotMatch(r.replies[0], /clear nahi/);
  assert.equal(step(w.worker_id).current_step, 'awaiting_aadhaar');
  assert.equal(step(w.worker_id).retry_count, 0);
});

test('selfie: more than one face is rejected and the indexed face deleted', async () => {
  const phone = '919300000007';
  const w = await toAadhaarStep(phone);
  await send(phone, M.image('a1'));
  H.rek.indexResult = {
    FaceRecords: [{ Face: { FaceId: 'face-multi' }, FaceDetail: { Quality: { Brightness: 80, Sharpness: 80 } } }],
    UnindexedFaces: [{ Reasons: ['EXCEEDS_MAX_FACES'] }],
  };
  const r = await send(phone, M.image('s1'));
  assert.match(r.replies[0], /ek se zyada/);
  assert.ok(H.rek.deletedFaces.includes('face-multi'));
  assert.equal(H.worker(phone).face_vector, undefined);
  assert.equal(step(w.worker_id).current_step, 'awaiting_selfie');
  assert.ok(!H.s3.has(`${config.buckets.mediaRaw}/enrolled/${w.worker_id}/selfie.jpg`));
});

test('selfie: a low-quality face is rejected and deleted', async () => {
  const phone = '919300000008';
  await toAadhaarStep(phone);
  await send(phone, M.image('a1'));
  H.rek.indexResult = { FaceRecords: [{ Face: { FaceId: 'face-dark' }, FaceDetail: { Quality: { Brightness: 10, Sharpness: 80 } } }] };
  const r = await send(phone, M.image('s1'));
  assert.match(r.replies[0], /quality/);
  assert.ok(H.rek.deletedFaces.includes('face-dark'));
  assert.equal(H.worker(phone).face_vector, undefined);
});

test('name: spoken / typed lead-ins are stripped', async () => {
  await send('919300000009', M.text('Namaste'));
  await H.agree('919300000009');
  await send('919300000009', M.text('mera naam Suresh Kumar hai'));
  assert.equal(H.worker('919300000009').name, 'Suresh Kumar');

  await send('919300000010', M.text('Hello'));
  await H.agree('919300000010');
  await send('919300000010', M.text('My name is Anil'));
  assert.equal(H.worker('919300000010').name, 'Anil');

  await send('919300000091', M.text('Hi'));
  await H.agree('919300000091');
  await send('919300000091', M.text("My name is Rajesh, and I've been working on the site all day laying bricks and mixing cement."));
  assert.equal(H.worker('919300000091').name, 'Rajesh');

  await send('919300000092', M.text('Namaste'));
  await H.agree('919300000092');
  await send('919300000092', M.text('mera naam Ramesh hai aur main mistri hoon'));
  assert.equal(H.worker('919300000092').name, 'Ramesh');
});

test('name: a long answer that is not a name is asked again', async () => {
  const phone = '919300000093';
  await send(phone, M.text('Hello'));
  await H.agree(phone);
  await send(phone, M.text('Kal subah saat baje site par aaunga kaam karne ke liye pakka'));
  assert.equal(H.worker(phone).name, undefined);
  await send(phone, M.text('Anand'));
  assert.equal(H.worker(phone).name, 'Anand');
});

test('name: a voice note is transcribed under the worker id and cleaned', async () => {
  const phone = '919300000011';
  await send(phone, M.text('Namaste'));
  await H.agree(phone);
  const wid = H.worker(phone).worker_id;
  H.transcribe.text = 'main Mohan Lal hoon';
  try {
    await send(phone, M.audio('n1'));
  } finally {
    H.transcribe.text = 'aaj maine teesri manzil pe plaster kiya';
  }
  assert.equal(H.worker(phone).name, 'Mohan Lal');
  // We can't strictly assert the AWS Transcribe job details because we replaced it with Whisper,
  // but we can check the audio was uploaded (which voiceProcessor still does)
  assert.ok([...H.s3.keys()].some((k) => k.includes(`workers/${wid}/`) && k.includes('voice-note')));
});

test('language: namaskar is Hindi, not Bengali', async () => {
  await send('919300000012', M.text('namaskar'));
  assert.equal(H.worker('919300000012').preferred_language, 'hi');
});

test('language: "English" / "ಕನ್ನಡ" switch language and are not saved as the name', async () => {
  const phone = '919300000013';
  await send(phone, M.text('Namaste'));
  await H.agree(phone);
  const wid = H.worker(phone).worker_id;
  const r = await send(phone, M.text('English'));
  assert.equal(H.worker(phone).preferred_language, 'en');
  assert.equal(H.worker(phone).name, undefined);
  assert.equal(step(wid).current_step, 'awaiting_name');
  assert.match(r.replies[0], /English/);

  await send(phone, M.text('ಕನ್ನಡ'));
  assert.equal(H.worker(phone).preferred_language, 'kn');
  await send(phone, M.text('Ram Kumar'));
  assert.equal(H.worker(phone).name, 'Ram Kumar');
});

test('documentVerifier selfie task uses the event language', async () => {
  H.s3.set(`${config.buckets.mediaRaw}/in/selfie.jpg`, Buffer.from('img'));
  const before = H.polly.calls.length;
  await docVerifier({ task: 'selfie', workerId: 'w-dv-1', imageKey: 'in/selfie.jpg', language: 'en' });
  const calls = H.polly.calls.slice(before);
  assert.ok(calls.length > 0);
  assert.match(calls.at(-1).Text, /Selfie saved/);
});
