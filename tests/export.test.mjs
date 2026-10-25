// Adaption Visualize exports: admin-only CSVs with no personal data, audited
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/harness.mjs';

const { callApi } = H;
const { putItem } = await import('../src/utils/dynamodb.js');
const { default: config, istDate } = await import('../src/utils/config.js');
let token;

const today = istDate();
const raw = (path, opts) => H.adminHandler(H.apiEvent('GET', path, opts));

before(async () => {
  H.quiet();
  await callApi('POST', '/api/auth/seed', {
    body: { email: 'export@example.com', password: 'Str0ng-passw0rd!', name: 'Admin', seedSecret: 'test-seed-secret' },
  });
  token = (await callApi('POST', '/api/auth/login', { body: { email: 'export@example.com', password: 'Str0ng-passw0rd!' } })).body.accessToken;

  await putItem(config.tables.workers, { worker_id: 'EXW1', name: 'Ramesh Secret', phone_number: '919812345678', preferred_language: 'kn' });
  await putItem(config.tables.attendance, {
    worker_id: 'EXW1', log_date: today, timestamp: `${today}T04:00:00.000Z`, site_id: 'S1', site_name: 'Metro',
    verification_status: 'pending_review', confidence: 71, face_confidence: 90, geo_confidence: 95, voice_confidence: 40,
    is_off_hours: false, gps_cell: { lat: 12.9716, lng: 77.5946 },
    flagged_reason: 'Voice note not work-related | Nodus: Possible photo of a screen (recapture score 0.81)',
    fraud_flags: ['Checked in with 3 other workers at the same spot within 90s (EXW2, EXW3, EXW4)'],
  });
});
after(() => H.close());

test('the attendance export is a CSV with pseudonymous workers and no personal data', async () => {
  const res = await raw('/api/admin/export/attendance.csv', { token });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/csv/);
  assert.match(res.headers['Content-Disposition'], /nirman-mitra-attendance-since-/);

  const [header, ...rows] = res.body.trim().split('\n');
  assert.equal(header, 'date,weekday,hour_ist,site,worker,worker_language,status,confidence,face_confidence,geo_confidence,voice_confidence,off_hours,fraud_signal_count,fraud_patterns,reviewed');
  const row = rows.find((r) => r.startsWith(today));
  assert.ok(row, 'today\'s check-in is exported');
  assert.match(row, /,9,Metro,W-[0-9a-f]{8},kn,pending_review,71,90,95,40,no,2,phone_farm;screen_photo,no$/);

  for (const secret of ['EXW1', 'EXW2', 'Ramesh', '919812345678', '12.9716', '77.5946']) {
    assert.ok(!res.body.includes(secret), `${secret} must not be exported`);
  }
});

test('the fraud export has one row per pattern and source', async () => {
  const res = await raw('/api/admin/export/fraud.csv', { token, query: { days: '7' } });
  assert.equal(res.statusCode, 200);
  const rows = res.body.trim().split('\n').slice(1).filter((r) => r.startsWith(today));
  assert.deepEqual(rows.map((r) => r.split(',').slice(-2).join(',')).sort(), ['phone_farm,nightly_sweep', 'screen_photo,check_in']);
  assert.ok(!res.body.includes('EXW'), 'peer worker ids in flag text are not exported');
});

test('exports need an admin token, are audited, and unknown datasets are 404', async () => {
  assert.equal((await raw('/api/admin/export/attendance.csv')).statusCode, 401);
  assert.equal((await raw('/api/admin/export/workers.csv', { token })).statusCode, 404);
  const audits = [...H.table('AuditLog').values()].filter((e) => e.action === 'export.download');
  assert.ok(audits.length >= 2);
  assert.equal(audits[0].details.destination, 'adaption-visualize');
});
