import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/harness.mjs';

const { handler } = await import('../src/handlers/proactiveReminder.js');
const { putItem } = await import('../src/utils/dynamodb.js');
const { default: config, istDate } = await import('../src/utils/config.js');

before(() => H.quiet());
after(() => H.close());

const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

test('reminds active workers (as registration stores them) whose reminder time has passed', async () => {
  await putItem(config.tables.workers, {
    worker_id: 'RW1', phone_number: '919800005001', profile_status: 'active',
    next_reminder_time: past, last_checkin_date: '1970-01-01',
  });
  await putItem(config.tables.workers, {
    worker_id: 'RW2', phone_number: '919800005002', profile_status: 'active',
    next_reminder_time: past, last_checkin_date: istDate(),
  });
  const sentBefore = H.wa.sent.length;

  const res = await handler({ source: 'test' });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.totalProcessed, 2);
  assert.equal(body.sentCount, 1, 'the worker who already checked in today is skipped');

  const sent = H.wa.sent.slice(sentBefore);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '919800005001');
  assert.equal(sent[0].type, 'template');

  const reminded = [...H.table('Workers').values()].find((w) => w.worker_id === 'RW1');
  assert.ok(reminded.next_reminder_time > past, 'next reminder moves a day forward');
});
