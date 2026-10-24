// Postgres backend (DB_BACKEND=postgres): the data helpers keep DynamoDB semantics.
// Runs only when DATABASE_URL points at a disposable database (CI starts one); skipped otherwise.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';

const SKIP = !process.env.DATABASE_URL && 'set DATABASE_URL to run the Postgres tests';
const SUFFIX = 'pgtest';
Object.assign(process.env, {
  DB_BACKEND: 'postgres',
  WORKERS_TABLE: `NirmanMitra-Workers-${SUFFIX}`,
  ATTENDANCE_TABLE: `NirmanMitra-AttendanceLogs-${SUFFIX}`,
  SITES_TABLE: `NirmanMitra-Sites-${SUFFIX}`,
  CERTIFICATES_TABLE: `NirmanMitra-Certificates-${SUFFIX}`,
  DOCUMENTS_TABLE: `NirmanMitra-Documents-${SUFFIX}`,
  CONVERSATION_TABLE: `NirmanMitra-ConversationState-${SUFFIX}`,
  BEDROCK_CACHE_TABLE: `NirmanMitra-BedrockCache-${SUFFIX}`,
  ADMIN_USERS_TABLE: `NirmanMitra-AdminUsers-${SUFFIX}`,
  REFRESH_TOKENS_TABLE: `NirmanMitra-RefreshTokens-${SUFFIX}`,
  AUDIT_TABLE: `NirmanMitra-AuditLog-${SUFFIX}`,
});

// The harness supplies the WhatsApp fake and the hosted (non-demo) environment for the flow test
const H = await import('./helpers/harness.mjs');
const { default: config } = await import('../src/utils/config.js');
const db = await import('../src/utils/dynamodb.js');
const { putItemIfAbsent } = await import('../src/services/conditionalWrite.js');
const { pruneExpired, closePostgres } = await import('../src/utils/postgres.js');
const T = config.tables;

before(async () => {
  H.quiet();
  if (SKIP) return;
  await db.scanTable(T.workers); // creates the schema on first use
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('DELETE FROM items WHERE tbl LIKE $1', [`%-${SUFFIX}`]);
  await client.end();
});
after(async () => { H.close(); await closePostgres(); });

test('items round-trip with their types; undefined attributes are dropped', { skip: SKIP }, async () => {
  const item = { worker_id: 'P1', n: 3, ok: true, tags: ['a'], geo: { lat: 12.9 }, gone: undefined };
  await db.putItem(T.workers, item);
  assert.deepEqual(await db.getItem(T.workers, { worker_id: 'P1' }), { worker_id: 'P1', n: 3, ok: true, tags: ['a'], geo: { lat: 12.9 } });
  await db.deleteItem(T.workers, { worker_id: 'P1' });
  assert.equal(await db.getItem(T.workers, { worker_id: 'P1' }), null);
  await assert.rejects(db.putItem(T.attendance, { worker_id: 'P1' }), /missing key/);
});

test('conditional writes are atomic under concurrency', { skip: SKIP }, async () => {
  const key = { worker_id: 'P2', log_date: '2026-10-24' };
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => putItemIfAbsent(T.attendance, { ...key, n: i }, key)));
  assert.equal(results.filter(Boolean).length, 1, 'exactly one concurrent check-in is written');

  await db.updateItem(T.attendance, key, 'SET verification_status = :s', { ':s': 'rejected' });
  assert.equal(await putItemIfAbsent(T.attendance, { ...key, verification_status: 'pending_review' }, key, { replaceIf: { attr: 'verification_status', value: 'rejected' } }), true);

  await db.putItem(T.workers, { worker_id: 'P2', total_days_logged: 0 });
  await Promise.all(Array.from({ length: 10 }, () => db.incrementDaysLogged('P2')));
  assert.equal((await db.getItem(T.workers, { worker_id: 'P2' })).total_days_logged, 10, 'no lost increments');

  await assert.rejects(
    db.putItem(T.adminUsers, { admin_id: 'A1' }, 'attribute_not_exists(admin_id)').then(() => db.putItem(T.adminUsers, { admin_id: 'A1' }, 'attribute_not_exists(admin_id)')),
    { name: 'ConditionalCheckFailedException' },
  );
});

test('updates return the new item, create missing items and honour conditions', { skip: SKIP }, async () => {
  const updated = await db.updateItem(T.certificates, { worker_id: 'P3', certificate_id: 'C1' }, 'SET certificate_claim = :c', { ':c': 'x' });
  assert.deepEqual(updated, { worker_id: 'P3', certificate_id: 'C1', certificate_claim: 'x' });
  await assert.rejects(
    db.updateItem(T.certificates, { worker_id: 'P3', certificate_id: 'C1' }, 'SET certificate_claim = :c', { ':c': 'y' }, undefined, 'attribute_not_exists(certificate_claim)'),
    { name: 'ConditionalCheckFailedException' },
  );
  const removed = await db.updateItem(T.certificates, { worker_id: 'P3', certificate_id: 'C1' }, 'REMOVE certificate_claim', {});
  assert.equal('certificate_claim' in removed, false);
});

test('queries sort by range key; GSIs are sparse and type-exact', { skip: SKIP }, async () => {
  for (const d of ['2026-10-22', '2026-10-24', '2026-10-23']) {
    await db.putItem(T.attendance, { worker_id: 'P4', log_date: d, site_id: 'S1', verification_status: 'pending_review', timestamp: `${d}T09:00:00Z` });
  }
  assert.deepEqual((await db.getWorkerAttendanceLogs('P4')).map((l) => l.log_date), ['2026-10-22', '2026-10-23', '2026-10-24']);
  const newest = await db.queryItems(T.attendance, 'worker_id = :w', { ':w': 'P4' }, undefined, { ScanIndexForward: false, Limit: 1 });
  assert.equal(newest[0].log_date, '2026-10-24');
  assert.equal((await db.getPendingReviews(2))[0].timestamp, '2026-10-24T09:00:00Z', 'review queue is newest first');

  await db.putItem(T.workers, { worker_id: 'R1', phone_number: '919800000001', profile_status: 'active', next_reminder_time: '2026-10-24T10:00:00Z' });
  await db.putItem(T.workers, { worker_id: 'R2', profile_status: 'active', next_reminder_time: '2026-10-25T10:00:00Z' });
  await db.putItem(T.workers, { worker_id: 'R3', profile_status: 'active' });
  const due = await db.queryItems(T.workers, '#st = :a AND next_reminder_time <= :now', { ':a': 'active', ':now': '2026-10-24T12:00:00Z' }, 'ReminderIndex', { expressionAttributeNames: { '#st': 'profile_status' } });
  assert.deepEqual(due.map((w) => w.worker_id), ['R1'], 'R2 is not due and R3 is not in the sparse index');
  assert.equal((await db.getWorkerByPhone('919800000001')).worker_id, 'R1');

  await db.putItem(T.sites, { site_id: 'S-STR', is_active: 'true' });
  await db.putItem(T.sites, { site_id: 'S-BOOL', is_active: true });
  const active = await db.queryItems(T.sites, 'is_active = :a', { ':a': 'true' }, 'ActiveSitesIndex');
  assert.deepEqual(active.map((s) => s.site_id), ['S-STR']);
});

test('scanPage walks every item exactly once', { skip: SKIP }, async () => {
  for (let i = 0; i < 7; i++) await db.putItem(T.documents, { worker_id: `D${i}`, document_id: 'aadhaar' });
  const seen = [];
  let start;
  do {
    const page = await db.scanPage(T.documents, { Limit: 3, ...(start && { ExclusiveStartKey: start }) });
    seen.push(...page.items.map((d) => d.worker_id));
    start = page.lastEvaluatedKey;
  } while (start);
  assert.deepEqual(seen.sort(), ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
});

test('pruneExpired removes only expired rows of TTL tables', { skip: SKIP }, async () => {
  const now = Math.floor(Date.now() / 1000);
  await db.putItem(T.conversation, { worker_id: 'X1', session_id: 'X1', ttl: now - 10 });
  await db.putItem(T.conversation, { worker_id: 'X2', session_id: 'X2', ttl: now + 3600 });
  await db.putItem(T.workers, { worker_id: 'X3', ttl: now - 10 });
  assert.ok(await pruneExpired(now) >= 1);
  assert.equal(await db.getItem(T.conversation, { worker_id: 'X1', session_id: 'X1' }), null);
  assert.ok(await db.getItem(T.conversation, { worker_id: 'X2', session_id: 'X2' }));
  assert.ok(await db.getItem(T.workers, { worker_id: 'X3' }), 'tables without TTL are untouched');
});

test('the WhatsApp onboarding flow runs on Postgres', { skip: SKIP }, async () => {
  const phone = '919100000990';
  await H.send(phone, H.M.text('Namaste'));
  await H.agree(phone);
  await H.send(phone, H.M.text('Ram Kumar'));
  const worker = await db.getWorkerByPhone(phone);
  assert.ok(worker, 'the worker is registered in Postgres');
  assert.equal(worker.name, 'Ram Kumar');
  assert.ok(worker.consent_version, 'consent is recorded');

  // A redelivered webhook is de-duplicated through the Postgres conditional write
  const sentBefore = H.wa.sent.length;
  const raw = H.wrap(phone, H.M.text('Ram Kumar'));
  await H.handler(H.postEvent(raw));
  await H.handler(H.postEvent(raw));
  assert.ok(H.wa.sent.length - sentBefore <= 2, 'the duplicate delivery does not trigger a second reply');
});
