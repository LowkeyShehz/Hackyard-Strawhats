import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import * as H from './helpers/harness.mjs';

const { callApi } = H;
let token;

before(async () => {
  H.quiet();
  const seed = await callApi('POST', '/api/auth/seed', {
    body: { email: 'admin@example.com', password: 'Str0ng-passw0rd!', name: 'Admin', seedSecret: 'test-seed-secret' },
  });
  assert.equal(seed.status, 201, JSON.stringify(seed.body));
  const login = await callApi('POST', '/api/auth/login', { body: { email: 'admin@example.com', password: 'Str0ng-passw0rd!' } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  token = login.body.accessToken;
});
after(() => H.close());

test('protected routes need a token signed with the configured secret', async () => {
  assert.equal((await callApi('GET', '/api/admin/dashboard')).status, 401);
  const forged = jwt.sign({ admin_id: 'x', role: 'super_admin' }, 'dev-jwt-secret-change-me');
  assert.equal((await callApi('GET', '/api/admin/dashboard', { token: forged })).status, 401);
  assert.equal((await callApi('GET', '/api/admin/dashboard', { token })).status, 200);
});

test('a pending log can be reviewed once; repeats and non-pending logs are refused', async () => {
  const { putItem } = await import('../src/utils/dynamodb.js');
  await putItem('NirmanMitra-Workers-dev', { worker_id: 'W1', phone_number: '919100009999', total_days_logged: 2 });
  await putItem('NirmanMitra-AttendanceLogs-dev', { worker_id: 'W1', log_date: '2026-09-01', verification_status: 'pending_review', timestamp: 't1' });
  await putItem('NirmanMitra-AttendanceLogs-dev', { worker_id: 'W1', log_date: '2026-09-02', verification_status: 'auto_approved', timestamp: 't2' });

  const body = { action: 'approve', workerId: 'W1', logDate: '2026-09-01' };
  assert.equal((await callApi('PUT', '/api/admin/review/W1', { token, body })).status, 200);
  assert.equal((await callApi('PUT', '/api/admin/review/W1', { token, body })).status, 409);
  assert.equal(H.table('Workers').get(JSON.stringify(['W1', null])).total_days_logged, 3);

  const auto = await callApi('PUT', '/api/admin/review/W1', { token, body: { ...body, logDate: '2026-09-02' } });
  assert.equal(auto.status, 409);
  const missing = await callApi('PUT', '/api/admin/review/W1', { token, body: { ...body, logDate: '1999-01-01' } });
  assert.equal(missing.status, 404);
});

test('the worker hears about the decision on WhatsApp; a failed send does not fail the review', async () => {
  const { putItem } = await import('../src/utils/dynamodb.js');
  const phone = '919100008888';
  const sentTo = () => H.wa.sent.filter((m) => m.to === phone).map((m) => m.text?.body);
  await putItem('NirmanMitra-Workers-dev', { worker_id: 'W2', phone_number: phone, preferred_language: 'en', total_days_logged: 2 });
  for (const d of ['2026-09-03', '2026-09-04', '2026-09-05']) {
    await putItem('NirmanMitra-AttendanceLogs-dev', { worker_id: 'W2', log_date: d, verification_status: 'pending_review', timestamp: d });
  }

  await callApi('PUT', '/api/admin/review/W2', { token, body: { action: 'approve', workerId: 'W2', logDate: '2026-09-03' } });
  assert.match(sentTo().at(-1), /03\/09 was approved.*3 days logged, 0 remaining\.\nYou are eligible for your certificate/s);

  await callApi('PUT', '/api/admin/review/W2', {
    token, body: { action: 'reject', workerId: 'W2', logDate: '2026-09-04', justification: 'Selfie shows a screen' },
  });
  assert.match(sentTo().at(-1), /04\/09 could not be approved\. Reason: Selfie shows a screen\./);

  H.wa.failSend = true;
  try {
    const r = await callApi('PUT', '/api/admin/review/W2', { token, body: { action: 'approve', workerId: 'W2', logDate: '2026-09-05' } });
    assert.equal(r.status, 200);
  } finally {
    H.wa.failSend = false;
  }
});
