// Consent before collection (PRD FR-1), the audit log (FR-7) and the officer decision API (FR-5)
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import * as H from './helpers/harness.mjs';

const { M, send, callApi } = H;
const { default: config } = await import('../src/utils/config.js');
const db = await import('../src/utils/dynamodb.js');

const auditFor = (subject) => [...H.table('AuditLog').values()].filter((e) => e.subject === subject);
const logsFor = (workerId) => [...H.table('AttendanceLogs').values()].filter((l) => l.worker_id === workerId);
const stepOf = (workerId) => H.states(workerId)[0]?.current_step;

let token;
let adminId;

before(async () => {
  H.quiet();
  const seed = await callApi('POST', '/api/auth/seed', {
    body: { email: 'officer@example.com', password: 'Str0ng-passw0rd!', name: 'Officer', seedSecret: 'test-seed-secret' },
  });
  assert.equal(seed.status, 201, JSON.stringify(seed.body));
  const login = await callApi('POST', '/api/auth/login', { body: { email: 'officer@example.com', password: 'Str0ng-passw0rd!' } });
  token = login.body.accessToken;
  adminId = jwt.decode(token).admin_id;

  await db.putItem(config.tables.certificates, { worker_id: 'W-CERT', certificate_id: 'cert-0001-abcd', verification_hash: 'h1' });
  await db.putItem(config.tables.certificates, { worker_id: 'W-CERT', certificate_id: 'cert-0002-abcd', verification_hash: 'h2' });
});
after(() => H.close());

// ── Consent ────────────────────────────────────────────

test('a new worker gets the purpose notice with an I agree button, read aloud, before anything else', async () => {
  const phone = '919600000001';
  const r = await send(phone, M.text('Namaste'));
  assert.deepEqual(r.replies.map((x) => x.split(' ')[0]), ['[buttons]', '[audio]']);
  assert.match(r.replies[0], /^\[buttons\] Nirman Mitra/);
  assert.ok(r.replies[0].length < 300, 'notice stays short');
  const button = H.wa.sent.find((m) => m.interactive).interactive.action.buttons[0].reply;
  assert.deepEqual(button, { id: 'consent_agree', title: 'Main sahmat hoon' });

  const w = H.worker(phone);
  assert.equal(w.consent_version, undefined);
  assert.equal(stepOf(w.worker_id), 'awaiting_consent');
});

test('photos and voice sent before agreeing are not stored or processed', async () => {
  const phone = '919600000002';
  await send(phone, M.text('Hello'));
  const w = H.worker(phone);
  const downloadsBefore = H.wa.mediaFetches;

  const r = await send(phone, M.image('a1'));
  assert.match(r.replies[0], /pehle|first/i, 'explains that nothing is saved');
  assert.match(r.replies[1], /^\[buttons\]/, 'shows the notice again');
  await send(phone, M.audio('v1'));

  assert.ok(![...H.s3.keys()].some((k) => k.includes(w.worker_id)), 'no media stored for the worker');
  assert.equal(H.wa.mediaFetches, downloadsBefore, 'media is not even downloaded from WhatsApp');
  assert.equal([...H.table('Documents').values()].filter((d) => d.worker_id === w.worker_id).length, 0);
  assert.equal(H.worker(phone).name, undefined);
  assert.equal(stepOf(w.worker_id), 'awaiting_consent');
});

test('agreeing records consent (version, language, time, channel) with an audit entry, then registration starts', async () => {
  const phone = '919600000003';
  await send(phone, M.text('Hello, good morning'));
  const r = await send(phone, M.text('I agree'));
  const w = H.worker(phone);

  assert.equal(w.consent_version, config.consentNoticeVersion);
  assert.equal(w.consent_language, 'en');
  assert.equal(w.consent_channel, 'whatsapp');
  assert.ok(!Number.isNaN(Date.parse(w.consent_at)));

  const [entry] = auditFor(`worker#${w.worker_id}`);
  assert.equal(entry.action, 'consent.given');
  assert.equal(entry.actor, `worker:${w.worker_id}`);
  assert.equal(entry.details.notice_version, config.consentNoticeVersion);

  assert.match(r.replies[0], /consent is recorded/);
  assert.ok(r.replies.some((reply) => /name/i.test(reply)), 'asks for the name next');
  assert.equal(stepOf(w.worker_id), 'awaiting_name');
});

test('an existing worker without consent must agree before the next check-in is taken', async () => {
  const phone = '919600000004';
  await db.putItem(config.tables.workers, {
    worker_id: 'W-LEGACY', phone_number: phone, name: 'Ravi', preferred_language: 'hi',
    profile_status: 'active', total_days_logged: 1,
  });

  const r = await send(phone, M.image('selfie'));
  assert.ok(r.replies.some((x) => x.startsWith('[buttons]')), 'notice shown');
  assert.equal(logsFor('W-LEGACY').length, 0);
  assert.equal(stepOf('W-LEGACY'), undefined, 'no check-in started');

  const agreed = await H.agree(phone);
  assert.equal(H.worker(phone).consent_version, config.consentNoticeVersion);
  assert.match(agreed.replies.at(-1), /selfie/i);
});

test('a language switch before agreeing re-sends the notice in that language', async () => {
  const phone = '919600000005';
  await send(phone, M.text('Namaste'));
  const r = await send(phone, M.text('ಕನ್ನಡ'));
  const { KN } = await import('../src/utils/i18n.js');
  assert.equal(H.worker(phone).preferred_language, 'kn');
  assert.deepEqual(r.replies, [`[buttons] ${KN.consentNotice}`]);
  assert.equal(H.worker(phone).consent_version, undefined, 'switching is not agreeing');
});

test('a saved worker greeting in Hindi or Kannada gets the notice in that language', async () => {
  const phone = '919600000006';
  await db.putItem(config.tables.workers, {
    worker_id: 'W-LEGACY-EN', phone_number: phone, name: 'Asha', preferred_language: 'en', profile_status: 'active',
  });
  const { KN } = await import('../src/utils/i18n.js');

  const hi = await send(phone, M.text('namaste'));
  assert.equal(H.worker(phone).preferred_language, 'hi');
  assert.match(hi.replies[0], /Main sahmat hoon/);

  const kn = await send(phone, M.text('Namaskara'));
  assert.equal(H.worker(phone).preferred_language, 'kn');
  assert.equal(kn.replies[0], `[buttons] ${KN.consentNotice}`);

  await send(phone, M.text('hi'));
  assert.equal(H.worker(phone).preferred_language, 'kn', 'an English greeting keeps the saved language');
});

// ── Officer API ────────────────────────────────────────

test('officer view is audited and reports no decision yet', async () => {
  const res = await callApi('POST', '/api/officer/view', { token, body: { jti: 'cert-0001-abcd' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.decision, null);

  const [entry] = auditFor('credential#cert-0001-abcd').filter((e) => e.action === 'credential.view');
  assert.equal(entry.actor, `admin:${adminId}`);
  assert.equal(entry.outcome, 'ok');
});

test('viewing an unknown credential is audited as not_found and returns 404', async () => {
  const res = await callApi('POST', '/api/officer/view', { token, body: { jti: 'cert-9999-none' } });
  assert.equal(res.status, 404);
  assert.equal(auditFor('credential#cert-9999-none')[0].outcome, 'not_found');
});

test('approve records one decision with an audit entry; a second decision is refused', async () => {
  const first = await callApi('POST', '/api/officer/approve', {
    token, body: { jti: 'cert-0001-abcd', decision: 'approve', note: 'Days match <b>site</b> records' },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.decision, 'approve');

  const second = await callApi('POST', '/api/officer/approve', { token, body: { jti: 'cert-0001-abcd', decision: 'reject' } });
  assert.equal(second.status, 409);
  assert.equal(second.body.decision.decision, 'approve');

  const decisions = auditFor('credential#cert-0001-abcd').filter((e) => e.action === 'credential.decision' && e.entry_id !== 'decision');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, 'approve');
  assert.equal(decisions[0].details.note, 'Days match site records', 'note is sanitised');

  const view = await callApi('POST', '/api/officer/view', { token, body: { jti: 'cert-0001-abcd' } });
  assert.equal(view.body.decision.decision, 'approve', 'a later view shows the decision');
});

test('reject works with an optional note', async () => {
  const res = await callApi('POST', '/api/officer/approve', { token, body: { jti: 'cert-0002-abcd', decision: 'reject' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.decision, 'reject');
});

test('officer API validates input, auth and role', async () => {
  const bad = (body) => callApi('POST', '/api/officer/approve', { token, body });
  assert.equal((await bad({ jti: 'cert-0002-abcd', decision: 'maybe' })).status, 400);
  assert.equal((await bad({ decision: 'approve' })).status, 400);
  assert.equal((await bad({ jti: '../../etc', decision: 'approve' })).status, 400);
  assert.equal((await bad({ jti: 'cert-7777-none', decision: 'approve' })).status, 404);

  assert.equal((await callApi('POST', '/api/officer/approve', { body: { jti: 'cert-0002-abcd', decision: 'approve' } })).status, 401);
  const viewer = jwt.sign({ admin_id: 'v1', role: 'viewer' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  assert.equal((await callApi('POST', '/api/officer/view', { token: viewer, body: { jti: 'cert-0002-abcd' } })).status, 403);
  const officer = jwt.sign({ admin_id: 'o1', role: 'officer' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  assert.equal((await callApi('POST', '/api/officer/view', { token: officer, body: { jti: 'cert-0002-abcd' } })).status, 200);
  assert.equal((await callApi('GET', '/api/admin/dashboard', { token: officer })).status, 403, 'officers cannot use admin routes');
});

test('the credential audit trail lists views and decisions in time order', async () => {
  const res = await callApi('GET', '/api/officer/credential/cert-0001-abcd/audit', { token });
  assert.equal(res.status, 200);
  const actions = res.body.entries.map((e) => e.action);
  assert.deepEqual(actions, ['credential.view', 'credential.decision', 'credential.view']);
  const times = res.body.entries.map((e) => e.at);
  assert.deepEqual([...times].sort(), times);
});

// ── Admin views and decisions ──────────────────────────

test('an admin viewing a worker profile and deciding a review are both audited', async () => {
  await db.putItem(config.tables.workers, { worker_id: 'W-REV', phone_number: '919600000009', total_days_logged: 0 });
  await db.putItem(config.tables.attendance, { worker_id: 'W-REV', log_date: '2026-09-20', verification_status: 'pending_review', timestamp: 't' });

  assert.equal((await callApi('GET', '/api/admin/worker/W-REV', { token })).status, 200);
  const review = await callApi('PUT', `/api/admin/review/${encodeURIComponent('W-REV#2026-09-20')}`, {
    token, body: { action: 'reject', justification: 'Selfie does not match' },
  });
  assert.equal(review.status, 200, JSON.stringify(review.body));

  const entries = auditFor('worker#W-REV');
  assert.deepEqual(entries.map((e) => [e.action, e.outcome]), [['worker.view', 'ok'], ['attendance.decision', 'reject']]);
  assert.ok(entries.every((e) => e.actor === `admin:${adminId}`));
  assert.equal(H.table('AttendanceLogs').get(JSON.stringify(['W-REV', '2026-09-20'])).reviewed_by, adminId);
});
