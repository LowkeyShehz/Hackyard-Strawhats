// /api/helpline/progress for the ElevenLabs Mitra Helpline agent: secret header auth, lookup by
// caller number, only the caller's own progress, audited
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.HELPLINE_SECRET = 'helpline-secret-xyz';
const H = await import('./helpers/harness.mjs');

const { putItem } = await import('../src/utils/dynamodb.js');
const { default: config } = await import('../src/utils/config.js');

async function call(body, secret = 'helpline-secret-xyz') {
  const event = H.apiEvent('POST', '/api/helpline/progress', { body });
  if (secret) event.headers['X-Helpline-Secret'] = secret;
  const res = await H.adminHandler(event);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

before(async () => {
  H.quiet();
  await putItem(config.tables.workers, {
    worker_id: 'W-HL1', name: 'Manjunath Gowda', phone_number: '919845012345', total_days_logged: 2,
    preferred_language: 'kn', aadhaar_last4: '3450',
  });
  await putItem(config.tables.attendance, { worker_id: 'W-HL1', log_date: '2026-10-23', verification_status: 'auto_approved' });
  await putItem(config.tables.attendance, { worker_id: 'W-HL1', log_date: '2026-10-24', verification_status: 'pending_review' });
});
after(() => H.close());

test('requests without the helpline secret are rejected', async () => {
  assert.equal((await call({ caller_id: '+919845012345' }, null)).status, 401);
  assert.equal((await call({ caller_id: '+919845012345' }, 'wrong')).status, 401);
});

test('a registered caller hears their own progress, in their language, with no identifiers', async () => {
  const res = await call({ caller_id: '+91 98450 12345' });
  assert.equal(res.status, 200);
  assert.equal(res.body.first_name, 'Manjunath');
  assert.equal(res.body.preferred_language, 'kn');
  assert.equal(res.body.days_logged, 2);
  assert.equal(res.body.days_remaining, config.certificateThreshold - 2);
  assert.deepEqual(res.body.last_checkin, { date: '2026-10-24', status: 'pending_review' });
  assert.equal(res.body.days_waiting_for_review, 1);
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes('3450') && !raw.includes('9845012345') && !raw.includes('Gowda'));
  const audit = [...H.table('AuditLog').values()].find((e) => e.subject === 'worker#W-HL1' && e.action === 'helpline.progress');
  assert.equal(audit.actor, 'helpline:elevenlabs');
});

test('a 10-digit caller number is matched with the 91 prefix; unknown callers get registration help', async () => {
  assert.equal((await call({ caller_id: '9845012345' })).body.first_name, 'Manjunath');
  const unknown = await call({ caller_id: '+919000000000' });
  assert.equal(unknown.body.registered, false);
  assert.match(unknown.body.next_step, /Namaste/);
  assert.equal((await call({})).status, 400);
});
