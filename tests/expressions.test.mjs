import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionHolds, applyUpdate, parseKeyCondition } from '../src/utils/expressions.js';

test('conditions used by conditional writes', () => {
  const log = { worker_id: 'W1', log_date: '2026-10-24', verification_status: 'rejected' };
  const replaceRejected = ['attribute_not_exists(worker_id) OR #replace_attr = :replace_value', { ':replace_value': 'rejected' }, { '#replace_attr': 'verification_status' }];

  assert.equal(conditionHolds(undefined, 'attribute_not_exists(admin_id)'), true, 'no item yet');
  assert.equal(conditionHolds({ admin_id: 'A' }, 'attribute_not_exists(admin_id)'), false);
  assert.equal(conditionHolds(undefined, ...replaceRejected), true);
  assert.equal(conditionHolds(log, ...replaceRejected), true, 'a rejected log may be replaced');
  assert.equal(conditionHolds({ ...log, verification_status: 'auto_approved' }, ...replaceRejected), false);
  assert.equal(conditionHolds(undefined, 'attribute_exists(worker_id)'), false);
});

test('comparison semantics follow DynamoDB', () => {
  const item = { n: 5, s: 'b', flag: 'true' };
  assert.equal(conditionHolds(item, 'n > :v', { ':v': 4 }), true);
  assert.equal(conditionHolds(item, 'n > :v', { ':v': '4' }), false, 'mixed types never compare');
  assert.equal(conditionHolds(item, 'missing <> :v', { ':v': 1 }), true);
  assert.equal(conditionHolds(item, 'missing = :v', { ':v': undefined }), false);
  assert.equal(conditionHolds(item, 'NOT (s = :a OR s = :b)', { ':a': 'a', ':b': 'c' }), true);
  assert.equal(conditionHolds(item, 'begins_with(s, :p)', { ':p': 'b' }), true);
  assert.equal(conditionHolds(item, 'n BETWEEN :lo AND :hi AND s = :s', { ':lo': 1, ':hi': 5, ':s': 'b' }), true);
});

test('unsupported or malformed expressions throw instead of passing', () => {
  assert.throws(() => conditionHolds({}, 'contains(tags, :t)', { ':t': 'x' }), /ValidationException/);
  assert.throws(() => conditionHolds({}, 'a = :missing', {}), /ExpressionAttributeValues missing :missing/);
  assert.throws(() => conditionHolds({}, '#a = :v', { ':v': 1 }, {}), /ExpressionAttributeNames missing #a/);
  assert.throws(() => applyUpdate({}, 'ADD n :v', { ':v': 1 }), /unsupported update clause/);
  assert.throws(() => applyUpdate({}, 'SET a.b = :v', { ':v': 1 }), /ValidationException/);
});

test('updates used by the handlers', () => {
  const worker = { worker_id: 'W1', name: 'Old', total_days_logged: 2, certificate_claim: 'C1' };

  const named = applyUpdate(worker, 'SET #n = :name, updated_at = :ts', { ':name': 'Ram', ':ts': 't1' }, { '#n': 'name' });
  assert.equal(named.name, 'Ram');
  assert.equal(named.updated_at, 't1');
  assert.equal(worker.name, 'Old', 'the input item is not modified');

  const inc = 'SET total_days_logged = if_not_exists(total_days_logged, :zero) + :inc';
  assert.equal(applyUpdate(worker, inc, { ':zero': 0, ':inc': 1 }).total_days_logged, 3);
  assert.equal(applyUpdate({ worker_id: 'W2' }, inc, { ':zero': 0, ':inc': 1 }).total_days_logged, 1);

  assert.equal('certificate_claim' in applyUpdate(worker, 'REMOVE certificate_claim'), false);
  assert.deepEqual(applyUpdate({ l: [1] }, 'SET l = list_append(l, :more)', { ':more': [2, 3] }).l, [1, 2, 3]);
  assert.equal(applyUpdate(undefined, 'SET a = :v', { ':v': 1 }).a, 1, 'an update creates a missing item');
});

test('key conditions give the hash value and a range predicate', () => {
  const { hashValue, matches } = parseKeyCondition(
    '#st = :active AND next_reminder_time <= :now', 'profile_status',
    { '#st': 'profile_status' }, { ':active': 'active', ':now': '2026-10-24T12:00:00Z' },
  );
  assert.equal(hashValue, 'active');
  assert.equal(matches({ profile_status: 'active', next_reminder_time: '2026-10-24T11:00:00Z' }), true);
  assert.equal(matches({ profile_status: 'active', next_reminder_time: '2026-10-25T11:00:00Z' }), false);

  assert.equal(parseKeyCondition('worker_id = :w', 'worker_id', undefined, { ':w': 'W1' }).hashValue, 'W1');
  assert.throws(() => parseKeyCondition('log_date = :d', 'worker_id', undefined, { ':d': 'x' }), /key condition/);
});
