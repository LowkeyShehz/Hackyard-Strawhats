/**
 * Nirman Mitra — Proactive reminder job (Render cron job, every 15 minutes)
 * Runs the same handler EventBridge invoked on Lambda, and fails the run when it reports an error.
 */

import { handler } from '../handlers/proactiveReminder.js';

const result = await handler({ source: 'render.cron', time: new Date().toISOString() });
console.log(result.body || result.error);
process.exit(result.statusCode === 200 ? 0 : 1);
