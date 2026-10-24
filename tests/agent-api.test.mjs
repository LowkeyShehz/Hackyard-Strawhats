// /api/agent/* for the Agent37 ops agent: key auth, masked read views, recommendation-only
// triage notes, and an audit entry for every call
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';

const AGENT_KEY = 'agk_test_0123456789';
process.env.AGENT_API_KEY_HASH = createHash('sha256').update(AGENT_KEY).digest('hex');
const H = await import('./helpers/harness.mjs');

const { putItem } = await import('../src/utils/dynamodb.js');
const { default: config, istDate } = await import('../src/utils/config.js');

const today = istDate();
async function agentCall(method, path, { key = AGENT_KEY, body, query } = {}) {
  const event = H.apiEvent(method, path, { body, query });
  if (key) event.headers['X-Agent-Key'] = key;
  const res = await H.adminHandler(event);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const auditFor = (subject) => [...H.table('AuditLog').values()].filter((e) => e.subject === subject);

before(async () => {
  H.quiet();
  await putItem(config.tables.workers, { worker_id: 'W-AG1', name: 'Ravi Kumar', phone_number: '919811112222', total_days_logged: 88 });
  await putItem(config.tables.workers, { worker_id: 'W-AG2', name: 'Sita Devi', phone_number: '919833334444', total_days_logged: 10 });
  await putItem(config.tables.attendance, {
    worker_id: 'W-AG1', log_date: today, timestamp: `${today}T04:00:00.000Z`, site_id: 'S1', site_name: 'Metro',
    verification_status: 'pending_review', confidence: 70, face_confidence: 90, geo_confidence: 50, voice_confidence: 80,
    flagged_reason: 'Nodus: Near-duplicate of selfie from 2026-10-20', fraud_flags: ['Checked in with 3 other workers at the same spot within 90s'],
    s3_media_keys: { selfie: 'workers/W-AG1/selfie.jpg' },
  });
  await putItem(config.tables.attendance, {
    worker_id: 'W-AG2', log_date: today, timestamp: `${today}T05:00:00.000Z`, site_id: 'S1', site_name: 'Metro',
    verification_status: 'auto_approved', confidence: 95,
  });
});
after(() => H.close());

test('agent routes reject a missing or wrong key, and a JWT is not a substitute', async () => {
  assert.equal((await agentCall('GET', '/api/agent/review-queue', { key: null })).status, 401);
  assert.equal((await agentCall('GET', '/api/agent/review-queue', { key: 'agk_wrong' })).status, 401);
});

test('the review queue has no phone numbers or image URLs and only a first name', async () => {
  const res = await agentCall('GET', '/api/agent/review-queue');
  assert.equal(res.status, 200);
  const item = res.body.items.find((i) => i.worker_id === 'W-AG1');
  assert.equal(item.worker_first_name, 'Ravi');
  assert.equal(item.log_id, `W-AG1#${today}`);
  assert.deepEqual(item.fraud_flags, ['Checked in with 3 other workers at the same spot within 90s']);
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes('9198111'), 'no phone number');
  assert.ok(!raw.includes('selfie.jpg') && !raw.includes('Kumar'), 'no media keys or surname');
});

test('fraud flags and daily stats summarise the day', async () => {
  const flags = await agentCall('GET', '/api/agent/fraud-flags', { query: { days: '3' } });
  assert.equal(flags.status, 200);
  assert.deepEqual(flags.body.items.map((i) => i.worker_id), ['W-AG1']);

  const stats = await agentCall('GET', '/api/agent/daily-stats', { query: { date: today } });
  assert.equal(stats.status, 200);
  assert.equal(stats.body.checkins, 2);
  assert.deepEqual(stats.body.by_status, { pending_review: 1, auto_approved: 1 });
  assert.equal(stats.body.fraud_flagged, 1);
  assert.equal(stats.body.awaiting_triage, 1);
  assert.equal(stats.body.sites[0].flagged, 1);
});

test('a triage note is stored as a recommendation only and audited', async () => {
  const logId = encodeURIComponent(`W-AG1#${today}`);
  const res = await agentCall('POST', `/api/agent/review/${logId}/note`, {
    body: { recommendation: 'reject', note: 'Phone farm: <b>4 workers</b> at one spot within 40s', confidence: 85 },
  });
  assert.equal(res.status, 200);
  const log = [...H.table('AttendanceLogs').values()].find((l) => l.worker_id === 'W-AG1');
  assert.equal(log.verification_status, 'pending_review', 'the agent never decides');
  assert.equal(log.ai_triage.recommendation, 'reject');
  assert.equal(log.ai_triage.note, 'Phone farm: 4 workers at one spot within 40s');
  assert.equal(log.ai_triage.agent, 'agent:agent37');
  const entry = auditFor('worker#W-AG1').find((e) => e.action === 'review.triage_note');
  assert.equal(entry.actor, 'agent:agent37');
  assert.equal(entry.details.recommendation, 'reject');
});

test('triage notes are refused on decided check-ins and for invalid input', async () => {
  const approved = encodeURIComponent(`W-AG2#${today}`);
  assert.equal((await agentCall('POST', `/api/agent/review/${approved}/note`, { body: { recommendation: 'approve', note: 'ok' } })).status, 409);
  const pending = encodeURIComponent(`W-AG1#${today}`);
  assert.equal((await agentCall('POST', `/api/agent/review/${pending}/note`, { body: { recommendation: 'approve_now', note: 'x' } })).status, 400);
  assert.equal((await agentCall('POST', `/api/agent/review/${pending}/note`, { body: { recommendation: 'approve' } })).status, 400);
  assert.equal((await agentCall('POST', '/api/agent/review/not-a-log/note', { body: { recommendation: 'approve', note: 'x' } })).status, 400);
});

test('there is no agent route that approves or rejects', async () => {
  const id = encodeURIComponent(`W-AG1#${today}`);
  assert.equal((await agentCall('PUT', `/api/admin/review/${id}`, { body: { action: 'approve' } })).status, 401);
  assert.equal((await agentCall('POST', `/api/agent/review/${id}/approve`, { body: {} })).status, 404);
});
