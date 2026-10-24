import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import * as H from './helpers/harness.mjs';
import { installDdbExtras } from './helpers/admin-extras.mjs';

const { callApi } = H;
const { default: config } = await import('../src/utils/config.js');
const db = await import('../src/utils/dynamodb.js');
const { withRetry, backoffDelay } = await import('../src/utils/retryHelper.js');

const SECRET = 'test-seed-secret';
const PASSWORD = 'Str0ng-passw0rd!';
let token;

installDdbExtras({ pageSize: 2 });

before(async () => {
  H.quiet();
});
after(() => H.close());

test('seed is a one-time bootstrap: concurrent seeds create one admin, later seeds get 403; email is normalised', async () => {
  const seed = (email) => callApi('POST', '/api/auth/seed', { body: { email, password: PASSWORD, name: 'Admin', seedSecret: SECRET } });
  const results = await Promise.all([seed('  Boss@Example.COM '), seed('other@example.com')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 403]);
  const admins = [...H.table('AdminUsers').values()].filter((a) => a.email);
  assert.equal(admins.length, 1);

  const again = await seed('third@example.com');
  assert.equal(again.status, 403);

  const winner = results.find((r) => r.status === 201).body.admin.email;
  assert.equal(winner, winner.trim().toLowerCase());
  const login = await callApi('POST', '/api/auth/login', { body: { email: ` ${winner.toUpperCase()} `, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  token = login.body.accessToken;
});

test('login for an unknown email still pays a bcrypt compare', async () => {
  // Assert on the work done, not wall-clock time (timing is noisy when test files run in parallel)
  const admin = [...H.table('AdminUsers').values()].find((a) => a.email);
  const realCompare = bcrypt.compare;
  const hashes = [];
  bcrypt.compare = (password, hash) => {
    hashes.push(hash);
    return realCompare.call(bcrypt, password, hash);
  };
  try {
    for (const email of [admin.email, 'nobody@example.com']) {
      const r = await callApi('POST', '/api/auth/login', { body: { email, password: 'wrong-password' } });
      assert.equal(r.status, 401);
    }
  } finally {
    bcrypt.compare = realCompare;
  }
  assert.equal(hashes.length, 2, 'both logins run a bcrypt compare');
  const cost = (hash) => bcrypt.getRounds(hash);
  assert.equal(cost(hashes[1]), cost(hashes[0]), 'the dummy hash has the same cost as a real one');
});

test('bad input is a generic 400; 500s carry no internal message; missing JWT secret is "Server misconfigured"', async () => {
  const raw = (path, body) => H.adminHandler({ ...H.apiEvent('POST', path), body }).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));
  assert.equal((await raw('/api/auth/login', '{"email":')).status, 400);
  assert.equal((await raw('/api/auth/refresh', 'not json')).status, 400);
  assert.equal((await callApi('POST', '/api/auth/login', { body: { email: 'a@b.c', password: 12345678 } })).status, 400);
  assert.equal((await callApi('POST', '/api/auth/refresh', { body: { refreshToken: { $ne: 1 } } })).status, 400);
  assert.equal((await callApi('POST', '/api/auth/logout', { body: { refreshToken: 7 } })).status, 400);
  for (const limit of ['abc', '0', '101', '1.5', '-3']) {
    assert.equal((await callApi('GET', '/api/admin/review-queue', { token, query: { limit } })).status, 400, limit);
    assert.equal((await callApi('GET', '/api/admin/workers', { token, query: { limit } })).status, 400, limit);
  }
  assert.equal((await callApi('GET', '/api/admin/workers', { token, query: { limit: '2', cursor: '!!' } })).status, 400);

  H.ddbFail.on = (op) => op === 'get';
  try {
    const r = await callApi('GET', '/api/admin/worker/W-any', { token });
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Internal server error' });
  } finally {
    H.ddbFail.on = null;
  }

  const saved = config.jwt.secret;
  config.jwt.secret = '';
  try {
    const r = await callApi('POST', '/api/auth/login', { body: { email: 'x@example.com', password: 'whatever' } });
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Server misconfigured' });
  } finally {
    config.jwt.secret = saved;
  }
});

test('review queue masks the phone and carries log_id; the path log id is authoritative', async () => {
  await db.putItem(config.tables.workers, { worker_id: 'RW1', name: 'Ravi', phone_number: '919812345678', total_days_logged: 0 });
  await db.putItem(config.tables.attendance, { worker_id: 'RW1', log_date: '2026-09-10', verification_status: 'pending_review', timestamp: 't10' });
  await db.putItem(config.tables.attendance, { worker_id: 'RW1', log_date: '2026-09-11', verification_status: 'pending_review', timestamp: 't11' });
  await db.putItem(config.tables.attendance, { worker_id: 'RW1', log_date: '2026-09-12', verification_status: 'pending_review', timestamp: 't12' });

  const q = await callApi('GET', '/api/admin/review-queue', { token });
  assert.equal(q.status, 200);
  const item = q.body.items.find((i) => i.log_date === '2026-09-10');
  assert.equal(item.worker_phone, '****5678');
  assert.equal(item.log_id, 'RW1#2026-09-10');
  assert.ok(!JSON.stringify(q.body).includes('919812345678'));

  // Body that disagrees with the path is refused, nothing changes
  const path10 = `/api/admin/review/${encodeURIComponent('RW1#2026-09-10')}`;
  const mismatch = await callApi('PUT', path10, { token, body: { action: 'approve', workerId: 'RW1', logDate: '2026-09-11' } });
  assert.equal(mismatch.status, 400);
  assert.equal(H.table('AttendanceLogs').get(JSON.stringify(['RW1', '2026-09-11'])).verification_status, 'pending_review');

  const ok = await callApi('PUT', path10, { token, body: { action: 'approve' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.log_id, 'RW1#2026-09-10');
  assert.equal(H.table('AttendanceLogs').get(JSON.stringify(['RW1', '2026-09-10'])).verification_status, 'approved');
  assert.equal((await callApi('PUT', path10, { token, body: { action: 'approve' } })).status, 409);

  // Legacy form: path worker id must match body workerId
  const legacyBad = await callApi('PUT', '/api/admin/review/OTHER', { token, body: { action: 'approve', workerId: 'RW1', logDate: '2026-09-11' } });
  assert.equal(legacyBad.status, 400);
  const legacy = await callApi('PUT', '/api/admin/review/RW1', { token, body: { action: 'approve', workerId: 'RW1', logDate: '2026-09-11' } });
  assert.equal(legacy.status, 200);
  assert.equal((await callApi('PUT', `/api/admin/review/${encodeURIComponent('RW1#1999-01-01')}`, { token, body: { action: 'approve' } })).status, 404);
});

test('reject needs a justification that survives sanitising; unterminated tags are stripped', async () => {
  const path = `/api/admin/review/${encodeURIComponent('RW1#2026-09-12')}`;
  for (const justification of ['<b></b>', '<img src=x onerror=alert(1)//', '   ']) {
    assert.equal((await callApi('PUT', path, { token, body: { action: 'reject', justification } })).status, 400, justification);
  }
  const r = await callApi('PUT', path, { token, body: { action: 'reject', justification: 'Blurry selfie <img src=x onerror=alert(1)//' } });
  assert.equal(r.status, 200);
  assert.equal(H.table('AttendanceLogs').get(JSON.stringify(['RW1', '2026-09-12'])).admin_justification, 'Blurry selfie');
});

test('worker profile returns an allow-list: no face vector, Aadhaar name or number; phone masked', async () => {
  await db.putItem(config.tables.workers, {
    worker_id: 'PW1', name: 'Priya', phone_number: '919800001234', preferred_language: 'kn', profile_status: 'active',
    total_days_logged: 4, aadhaar_last4: '3455', aadhaar_name: 'PRIYA K', aadhaar_encrypted: 'enc', aadhaar_number: '283077653455',
    face_vector: 'face-1', FaceId: 'face-1', registration_location: { lat: 1, lng: 2 }, registration_completed: '2026-09-01T00:00:00Z',
  });
  const r = await callApi('GET', '/api/admin/worker/PW1', { token });
  assert.equal(r.status, 200);
  const w = r.body.worker;
  for (const k of ['face_vector', 'FaceId', 'aadhaar_name', 'aadhaar_encrypted', 'aadhaar_number', 'registration_location']) assert.ok(!(k in w), k);
  assert.equal(w.phone_number, '****1234');
  assert.equal(w.aadhaar_last4, '3455');
  assert.equal(w.selfie_verified, true);
  assert.equal(w.aadhaar_verified, true);
  assert.equal(w.total_days_logged, 4);
  assert.ok(!JSON.stringify(r.body).includes('919800001234'));
});

test('scans follow LastEvaluatedKey; dashboard counts everything and exposes certificateThreshold; workers paginate', async () => {
  for (let i = 0; i < 7; i++) await db.putItem(config.tables.workers, { worker_id: `SW${i}`, name: `S${i}`, profile_status: 'active', total_days_logged: 1 });
  const expected = H.table('Workers').size;
  assert.ok(expected >= 9);
  assert.equal((await db.scanTable(config.tables.workers)).length, expected);
  assert.equal((await db.scanTable(config.tables.workers, {}, { maxItems: 3 })).length, 3);

  const d = await callApi('GET', '/api/admin/dashboard', { token });
  assert.equal(d.status, 200);
  assert.equal(d.body.totalWorkers, expected);
  assert.equal(d.body.certificateThreshold, config.certificateThreshold);
  const pending = [...H.table('AttendanceLogs').values()].filter((l) => l.verification_status === 'pending_review').length;
  assert.equal(d.body.pendingReviews, pending);

  const all = await callApi('GET', '/api/admin/workers', { token });
  assert.equal(all.body.workers.length, expected);
  const seen = [];
  let cursor;
  do {
    const page = await callApi('GET', '/api/admin/workers', { token, query: { limit: '3', ...(cursor && { cursor }) } });
    assert.equal(page.status, 200);
    assert.ok(page.body.workers.length <= 3);
    seen.push(...page.body.workers.map((w) => w.worker_id));
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, expected);
});

test('sites: validated create/update in the shape the geo check reads, and list', async () => {
  const post = (body, t = token) => callApi('POST', '/api/admin/sites', { token: t, body });
  const base = { name: 'Demo Site', latitude: 13.0108, longitude: 74.7943, radius_meters: 500 };
  assert.equal((await post({ ...base, latitude: 91 })).status, 400);
  assert.equal((await post({ ...base, longitude: -181 })).status, 400);
  assert.equal((await post({ ...base, radius_meters: 49 })).status, 400);
  assert.equal((await post({ ...base, radius_meters: 5001 })).status, 400);
  assert.equal((await post({ ...base, name: '' })).status, 400);
  assert.equal((await post({ ...base, latitude: 'north' })).status, 400);
  assert.equal((await post({ ...base, site_id: 'bad id!' })).status, 400);
  const viewer = jwt.sign({ admin_id: 'v', role: 'viewer' }, config.jwt.secret);
  assert.equal((await post(base, viewer)).status, 403);

  const created = await post({ ...base, site_id: 'DEMO-NITK' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const stored = H.table('Sites').get(JSON.stringify(['DEMO-NITK', null]));
  assert.deepEqual(
    { site_name: stored.site_name, geo_location: stored.geo_location, radius_meters: stored.radius_meters, is_active: stored.is_active },
    { site_name: 'Demo Site', geo_location: { latitude: 13.0108, longitude: 74.7943 }, radius_meters: 500, is_active: 'true' },
  );
  const active = await db.queryItems(config.tables.sites, 'is_active = :active', { ':active': 'true' }, 'ActiveSitesIndex');
  assert.ok(active.some((s) => s.site_id === 'DEMO-NITK'));

  const updated = await post({ ...base, site_id: 'DEMO-NITK', radius_meters: 800, is_active: false });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.site.is_active, false);
  assert.equal(H.table('Sites').get(JSON.stringify(['DEMO-NITK', null])).created_at, stored.created_at);
  assert.equal(H.table('Sites').get(JSON.stringify(['DEMO-NITK', null])).is_active, 'false');

  const auto = await post({ ...base, name: 'Second' });
  assert.equal(auto.status, 201);
  assert.match(auto.body.site.site_id, /^SITE-/);

  const list = await callApi('GET', '/api/admin/sites', { token });
  assert.equal(list.status, 200);
  const nitk = list.body.sites.find((s) => s.site_id === 'DEMO-NITK');
  assert.deepEqual({ ...nitk, created_at: undefined, updated_at: undefined },
    { site_id: 'DEMO-NITK', name: 'Demo Site', latitude: 13.0108, longitude: 74.7943, radius_meters: 800, is_active: false, created_at: undefined, updated_at: undefined });
});

test('certificate verify: HTTP API v2 events, trailing slash, name and Aadhaar last 4 from the certificate, no phone', async () => {
  await db.putItem(config.tables.workers, { worker_id: 'CW1', name: 'Live Name', phone_number: '919811112222' });
  await db.putItem(config.tables.certificates, {
    worker_id: 'CW1', certificate_id: 'C1', verification_hash: 'hash-abc', worker_name: 'Printed Name', aadhaar_last4: '9876',
    total_days: 3, date_from: '2026-09-01', date_to: '2026-09-03', sites: [], created_at: '2026-09-04T00:00:00Z',
  });
  await db.putItem(config.tables.certificates, { worker_id: 'CW1', certificate_id: 'C0', verification_hash: 'hash-old', total_days: 3 });

  const v2 = await H.adminHandler({
    version: '2.0', rawPath: '/api/certificate/hash-abc/verify/', headers: {}, requestContext: { http: { method: 'GET', path: '/api/certificate/hash-abc/verify/' } },
  });
  assert.equal(v2.statusCode, 200, v2.body);
  const body = JSON.parse(v2.body);
  assert.equal(body.certificate.worker_name, 'Printed Name');
  assert.equal(body.certificate.aadhaar_last4, '9876');
  assert.ok(!v2.body.includes('919811112222'));

  const old = await callApi('GET', '/api/certificate/hash-old/verify/');
  assert.equal(old.status, 200);
  assert.equal(old.body.certificate.worker_name, 'Live Name');
  assert.equal((await callApi('GET', '/api/certificate/nope/verify')).status, 404);
});

test('retry backoff is capped with jitter; non-retryable errors are not retried', async () => {
  for (let i = 0; i < 50; i++) {
    const d = backoffDelay(10, 1000, 5000);
    assert.ok(d >= 2500 && d <= 5000, String(d));
  }
  assert.ok(backoffDelay(0, 100, 5000) <= 100);

  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw Object.assign(new Error('bad'), { name: 'ValidationException' }); }, { baseDelayMs: 1 }));
  assert.equal(calls, 1);

  calls = 0;
  const out = await withRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    return 'ok';
  }, { baseDelayMs: 1, maxRetries: 3 });
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});
