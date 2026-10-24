// The local in-memory store (demo mode: not on Lambda, ENVIRONMENT=dev) must honour conditions
// the way DynamoDB does, so local demos behave like production under concurrent requests.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.AWS_LAMBDA_FUNCTION_NAME;
process.env.ENVIRONMENT = 'dev';

let db;
let putItemIfAbsent;

before(async () => {
  console.log = () => {};
  db = await import('../src/utils/dynamodb.js');
  ({ putItemIfAbsent } = await import('../src/services/conditionalWrite.js'));
});

const LOGS = 'NirmanMitra-AttendanceLogs-dev';

test('a conditional update succeeds once and then fails like DynamoDB', async () => {
  await db.putItem(LOGS, { worker_id: 'W1', log_date: '2026-09-01', verification_status: 'pending_review' });
  const approve = () => db.updateItem(
    LOGS,
    { worker_id: 'W1', log_date: '2026-09-01' },
    'SET verification_status = :status',
    { ':status': 'approved', ':pending': 'pending_review' },
    undefined,
    'verification_status = :pending',
  );
  const results = await Promise.allSettled([approve(), approve()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.equal(rejected.reason.name, 'ConditionalCheckFailedException');
});

test('concurrent putItemIfAbsent calls write exactly once', async () => {
  const item = (n) => ({ worker_id: 'W2', log_date: '2026-09-02', n });
  const key = { worker_id: 'W2', log_date: '2026-09-02' };
  const written = await Promise.all([1, 2, 3].map((n) => putItemIfAbsent(LOGS, item(n), key)));
  assert.equal(written.filter(Boolean).length, 1);
});

test('replaceIf lets a rejected log be replaced but not an approved one', async () => {
  const key = { worker_id: 'W3', log_date: '2026-09-03' };
  await db.putItem(LOGS, { ...key, verification_status: 'rejected' });
  const opts = { replaceIf: { attr: 'verification_status', value: 'rejected' } };
  assert.equal(await putItemIfAbsent(LOGS, { ...key, verification_status: 'approved' }, key, opts), true);
  assert.equal(await putItemIfAbsent(LOGS, { ...key, verification_status: 'approved' }, key, opts), false);
});
