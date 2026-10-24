/**
 * Nirman Mitra — Helpline routes (/api/helpline/*)
 * Server tools for the ElevenLabs "Mitra Helpline" voice agent: a worker calls or sends a
 * WhatsApp voice message and asks "how many days do I have?" or "where is my certificate?".
 *
 * Auth: `X-Helpline-Secret` must equal HELPLINE_SECRET (set as a secret header on the ElevenLabs
 * tool). The worker is identified by the caller's number, which the tool fills from the
 * {{system__caller_id}} dynamic variable, so the LLM cannot look up someone else's number.
 * Answers carry only what the worker may hear about themselves; every lookup is audited.
 */

import { createHash, timingSafeEqual } from 'crypto';
import config, { apiResponse } from '../utils/config.js';
import { getWorkerByPhone, queryItems } from '../utils/dynamodb.js';
import { writeAudit, workerSubject } from '../services/audit.js';

const ACTOR = 'helpline:elevenlabs';

/** Constant-time comparison of the X-Helpline-Secret header */
function verifyHelplineSecret(event) {
  const expected = config.helpline.secret;
  const supplied = event.headers?.['X-Helpline-Secret'] || event.headers?.['x-helpline-secret'] || '';
  if (!expected || !supplied) return false;
  const digest = (v) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(raw) || {};
  } catch {
    return null;
  }
}

/** WhatsApp stores numbers as digits with the country code (919876543210) */
function normalizeCaller(callerId) {
  const digits = String(callerId || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

async function latestLogs(workerId, limit = 7) {
  return queryItems(
    config.tables.attendance,
    'worker_id = :w',
    { ':w': workerId },
    undefined,
    { Limit: limit, ScanIndexForward: false },
  );
}

// ─────────────────────────────────────────────────────────
// POST /api/helpline/progress  { caller_id }
// ─────────────────────────────────────────────────────────

async function progress(event) {
  const body = parseBody(event);
  if (!body) return apiResponse(400, { error: 'Request body must be valid JSON' });
  const phone = normalizeCaller(body.caller_id);
  if (phone.length < 11) return apiResponse(400, { error: 'caller_id is required' });

  const worker = await getWorkerByPhone(phone);
  if (!worker) {
    return apiResponse(200, {
      registered: false,
      next_step: 'Send "Namaste" to the Nirman Mitra WhatsApp number to register.',
    });
  }

  const threshold = config.certificateThreshold;
  const daysLogged = worker.total_days_logged || 0;
  const [logs, certificates] = await Promise.all([
    latestLogs(worker.worker_id),
    queryItems(config.tables.certificates, 'worker_id = :w', { ':w': worker.worker_id }),
  ]);
  const latestCert = certificates.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];

  await writeAudit({
    actor: ACTOR, action: 'helpline.progress', subject: workerSubject(worker.worker_id),
  }).catch((err) => console.warn('[Helpline] Audit write failed:', err.message));

  return apiResponse(200, {
    registered: true,
    first_name: String(worker.name || '').split(/\s+/)[0] || null,
    preferred_language: worker.preferred_language || 'hi',
    days_logged: daysLogged,
    certificate_threshold: threshold,
    days_remaining: Math.max(0, threshold - daysLogged),
    certificate_eligible: daysLogged >= threshold,
    last_checkin: logs[0] ? { date: logs[0].log_date, status: logs[0].verification_status } : null,
    days_waiting_for_review: logs.filter((l) => l.verification_status === 'pending_review').length,
    certificate: latestCert
      ? { issued_on: String(latestCert.created_at).slice(0, 10), total_days: latestCert.total_days }
      : null,
  });
}

/**
 * Handle an /api/helpline/* request.
 * @returns {Promise<object>} API response
 */
export async function handleHelplineRoute(event, path, method) {
  if (!verifyHelplineSecret(event)) {
    return apiResponse(401, { error: 'Unauthorized' });
  }
  if (path.endsWith('/api/helpline/progress') && method === 'POST') return progress(event);
  return apiResponse(404, { error: 'Route not found' });
}

export default { handleHelplineRoute };
