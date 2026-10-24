// Company dashboard API: visibility only, scoped to the company's own sites.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import * as H from './helpers/harness.mjs';

const { callApi } = H;
const { putItem } = await import('../src/utils/dynamodb.js');
const { default: config, istDate } = await import('../src/utils/config.js');

let adminToken;
let companyToken;
let companyA;
let companyB;
const today = istDate();
const yesterday = istDate(Date.now() - 86400000);

async function csv(token, query) {
  const res = await H.adminHandler(H.apiEvent('GET', '/api/company/muster.csv', { token, query }));
  return { status: res.statusCode, headers: res.headers, body: res.body };
}

before(async () => {
  H.quiet();
  await callApi('POST', '/api/auth/seed', {
    body: { email: 'admin@example.com', password: 'Str0ng-passw0rd!', name: 'Admin', seedSecret: 'test-seed-secret' },
  });
  adminToken = (await callApi('POST', '/api/auth/login', { body: { email: 'admin@example.com', password: 'Str0ng-passw0rd!' } })).body.accessToken;

  companyA = (await callApi('POST', '/api/admin/companies', {
    token: adminToken, body: { name: 'Surathkal Builders', email: 'site@builders.example', password: 'builders-pass-123' },
  })).body.company;
  companyB = (await callApi('POST', '/api/admin/companies', {
    token: adminToken, body: { name: 'Other Infra', email: 'ops@other.example', password: 'other-pass-1234' },
  })).body.company;

  const site = (site_id, company_id) => callApi('POST', '/api/admin/sites', {
    token: adminToken,
    body: { site_id, name: site_id, latitude: 13.01, longitude: 74.79, radius_meters: 500, company_id },
  });
  await site('SITE-A', companyA.company_id);
  await site('SITE-B', companyB.company_id);

  await putItem(config.tables.workers, { worker_id: 'WA1', phone_number: '919800000001', name: 'Asha', total_days_logged: 3 });
  await putItem(config.tables.workers, { worker_id: 'WA2', phone_number: '919800000002', name: 'Basu', total_days_logged: 1 });
  await putItem(config.tables.workers, { worker_id: 'WB1', phone_number: '919800000003', name: 'Other', total_days_logged: 2 });
  const log = (worker_id, site_id, log_date, verification_status, flagged_reason = null) => putItem(config.tables.attendance, {
    worker_id, site_id, site_name: site_id, log_date, verification_status, flagged_reason,
    confidence: 80, timestamp: `${log_date}T04:00:00.000Z`,
  });
  await log('WA1', 'SITE-A', today, 'auto_approved');
  await log('WA2', 'SITE-A', yesterday, 'pending_review', 'GPS near boundary: 300m');
  await log('WB1', 'SITE-B', today, 'auto_approved');

  const login = await callApi('POST', '/api/auth/login', { body: { email: 'site@builders.example', password: 'builders-pass-123' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.admin.role, 'company');
  assert.equal(login.body.admin.company_id, companyA.company_id);
  companyToken = login.body.accessToken;
});
after(() => H.close());

test('the company access token carries its company', () => {
  const payload = jwt.decode(companyToken);
  assert.equal(payload.role, 'company');
  assert.equal(payload.company_id, companyA.company_id);
});

test('admins list companies with their sites; duplicate emails and weak passwords are refused', async () => {
  const list = await callApi('GET', '/api/admin/companies', { token: adminToken });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.companies.find((c) => c.company_id === companyA.company_id).site_ids, ['SITE-A']);
  assert.equal((await callApi('POST', '/api/admin/companies', {
    token: adminToken, body: { name: 'Dup', email: 'site@builders.example', password: 'another-pass-1' },
  })).status, 409);
  assert.equal((await callApi('POST', '/api/admin/companies', {
    token: adminToken, body: { name: 'Weak', email: 'weak@x.example', password: 'short' },
  })).status, 400);
});

test('overview covers only the company sites', async () => {
  const { status, body } = await callApi('GET', '/api/company/overview', { token: companyToken });
  assert.equal(status, 200);
  assert.deepEqual(body.sites.map((s) => s.site_id), ['SITE-A']);
  assert.equal(body.checkinsToday, 1);
  assert.equal(body.verifiedToday, 1);
  assert.equal(body.workersLast30Days, 2);
  assert.equal(body.flaggedLast7Days, 1);
  assert.equal(body.welfare.eligible, 1);
  assert.equal(body.trend.length, 7);
  assert.equal(body.trend[6].date, today);
});

test('roster shows the day at the company sites with masked phones', async () => {
  const { status, body } = await callApi('GET', '/api/company/roster', { token: companyToken, query: { date: today } });
  assert.equal(status, 200);
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].worker_name, 'Asha');
  assert.equal(body.rows[0].phone, '****0001');
  assert.equal(body.rows[0].status, 'auto_approved');
  assert.equal((await callApi('GET', '/api/company/roster', { token: companyToken, query: { date: 'yesterday' } })).status, 400);
});

test('flags list flagged check-ins at the company sites only', async () => {
  const { body } = await callApi('GET', '/api/company/flags', { token: companyToken, query: { days: '7' } });
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].worker_name, 'Basu');
  assert.match(body.rows[0].flag_reason, /GPS/);
});

test('muster roll is a CSV of the company workers, one column per day', async () => {
  const res = await csv(companyToken, { from: yesterday, to: today });
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /text\/csv/);
  assert.match(res.headers['Content-Disposition'], /attachment/);
  const [header, ...rows] = res.body.trim().split('\n');
  assert.equal(header, `Worker,Phone,Site,${yesterday},${today},Days present`);
  assert.equal(rows.length, 2);
  assert.ok(rows.includes(`Asha,****0001,SITE-A,-,P,1`));
  assert.ok(rows.includes(`Basu,****0002,SITE-A,R,-,0`));
  assert.ok(!res.body.includes('Other'));
  assert.equal((await csv(companyToken, { from: '2026-01-01', to: '2026-06-01' })).status, 400);
});

test('company accounts cannot reach admin or worker routes, or change anything', async () => {
  assert.equal((await callApi('GET', '/api/admin/dashboard', { token: companyToken })).status, 403);
  assert.equal((await callApi('GET', '/api/admin/sites', { token: companyToken })).status, 403);
  assert.equal((await callApi('PUT', `/api/admin/review/WA2`, {
    token: companyToken, body: { workerId: 'WA2', logDate: yesterday, action: 'approve' },
  })).status, 403);
  assert.equal((await callApi('GET', '/api/worker/WA1/progress', { token: companyToken })).status, 403);
  assert.equal((await callApi('POST', '/api/company/overview', { token: companyToken })).status, 405);
});

test('admin accounts do not use company routes; worker progress still works for admins', async () => {
  assert.equal((await callApi('GET', '/api/company/overview', { token: adminToken })).status, 403);
  assert.equal((await callApi('GET', '/api/worker/WA1/progress', { token: adminToken })).status, 200);
});
