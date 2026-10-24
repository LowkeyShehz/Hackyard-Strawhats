// Regressions for the Copilot review of PR #1, on the Lambda (DynamoDB) code path
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/harness.mjs';

const TABLE = 'NirmanMitra-ConversationState-dev';
let db;

before(async () => {
  H.quiet();
  db = await import('../src/utils/dynamodb.js');
});
after(() => H.close());

test('the canonical session row wins over a legacy UUID row that sorts higher', async () => {
  await db.putItem(TABLE, { worker_id: 'W-A', session_id: 'W-A', current_step: 'active' });
  await db.putItem(TABLE, { worker_id: 'W-A', session_id: 'ffffffff-legacy-uuid', current_step: 'awaiting_name' });
  const state = await db.getConversationState('W-A');
  assert.equal(state.session_id, 'W-A');
  assert.equal(state.current_step, 'active');
});

test('a legacy UUID row is moved onto the canonical key the first time it is read', async () => {
  await db.putItem(TABLE, { worker_id: 'W-B', session_id: '1234-legacy', current_step: 'awaiting_selfie' });
  const state = await db.getConversationState('W-B');
  assert.equal(state.session_id, 'W-B');
  assert.equal(state.current_step, 'awaiting_selfie');
  const rows = H.states('W-B');
  assert.deepEqual(rows.map((r) => r.session_id), ['W-B'], 'legacy row removed');
});
