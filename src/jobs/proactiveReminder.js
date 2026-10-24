/**
 * Nirman Mitra — Proactive reminder job (Render cron job, every 15 minutes)
 * Runs the same handler EventBridge invoked on Lambda, and fails the run when it reports an error.
 * On Postgres it also deletes expired rows, the work DynamoDB TTL did.
 */

import config from '../utils/config.js';
import { handler } from '../handlers/proactiveReminder.js';
import { pruneExpired, closePostgres } from '../utils/postgres.js';

const result = await handler({ source: 'render.cron', time: new Date().toISOString() });
console.log(result.body || result.error);

if (config.dbBackend === 'postgres') {
  try {
    console.log(`Pruned ${await pruneExpired()} expired row(s)`);
  } catch (err) {
    console.error('Expired-row prune failed:', err.message);
  }
  await closePostgres();
}

process.exit(result.statusCode === 200 ? 0 : 1);
