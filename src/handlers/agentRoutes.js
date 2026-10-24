/**
 * Nirman Mitra — Agent routes (/api/agent/*)
 * Machine access for the Agent37 "Welfare Ops Agent": it reads the review queue, Nodus fraud
 * flags and daily stats, and writes triage RECOMMENDATIONS onto pending check-ins. It can never
 * approve or reject a day or change a worker's count; officers make every decision.
 *
 * Auth: `X-Agent-Key: <key>`; the SHA-256 of the key must equal AGENT_API_KEY_HASH. Responses
 * carry no phone numbers, images or Aadhaar data, and every call is written to the audit log.
 */

import { createHash, timingSafeEqual } from 'crypto';
import config, { apiResponse, istDate } from '../utils/config.js';
import { getItem, getPendingReviews, scanTable, updateItem } from '../utils/dynamodb.js';
import { writeAudit, workerSubject } from '../services/audit.js';

const AGENT_ACTOR = 'agent:agent37';
const RECOMMENDATIONS = new Set(['approve', 'reject', 'needs_human']);
const MAX_NOTE_LENGTH = 500;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const NEAR_CERTIFICATE_DAYS = 5;

class AgentError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Constant-time check of the X-Agent-Key header against the configured hash */
export function verifyAgentKey(event) {
  const expected = config.agent.apiKeyHash;
  const key = event.headers?.['X-Agent-Key'] || event.headers?.['x-agent-key'] || '';
  if (!expected || !key) return false;
  const supplied = createHash('sha256').update(key).digest('hex');
  return supplied.length === expected.length
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected.toLowerCase()));
}

function parseJsonBody(event) {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(raw) || {};
  } catch {
    throw new AgentError(400, 'Request body must be valid JSON');
  }
}

function plainText(value, max) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, max);
}

/** The fields of a check-in the agent needs to triage it: no phone, images or documents */
function agentView(log, worker) {
  return {
    log_id: `${log.worker_id}#${log.log_date}`,
    worker_id: log.worker_id,
    worker_first_name: String(worker?.name || '').split(/\s+/)[0] || null,
    total_days_logged: worker?.total_days_logged || 0,
    log_date: log.log_date,
    timestamp: log.timestamp,
    site_id: log.site_id,
    site_name: log.site_name,
    verification_status: log.verification_status,
    confidence: log.confidence,
    face_confidence: log.face_confidence,
    geo_confidence: log.geo_confidence,
    voice_confidence: log.voice_confidence,
    voice_activity: log.voice_details?.activity || null,
    flagged_reason: log.flagged_reason || null,
    fraud_flags: log.fraud_flags || [],
    fraud_signals: log.fraud_signals || null,
    is_off_hours: Boolean(log.is_off_hours),
    ai_triage: log.ai_triage || null,
  };
}

async function audit(action, subject, details) {
  await writeAudit({ actor: AGENT_ACTOR, action, subject, details }).catch((err) => {
    console.warn('[Agent] Audit write failed:', err.message);
  });
}

// ─────────────────────────────────────────────────────────
// GET /api/agent/review-queue
// ─────────────────────────────────────────────────────────

async function reviewQueue(event) {
  const raw = event.queryStringParameters?.limit;
  const limit = Math.min(100, Math.max(1, parseInt(raw || '50', 10) || 50));
  const items = await getPendingReviews(limit);
  const enriched = await Promise.all(items.map(async (log) => (
    agentView(log, await getItem(config.tables.workers, { worker_id: log.worker_id }))
  )));
  await audit('agent.review_queue.read', 'agent#review-queue', { count: enriched.length });
  return apiResponse(200, { items: enriched, count: enriched.length });
}

// ─────────────────────────────────────────────────────────
// GET /api/agent/fraud-flags?days=7
// ─────────────────────────────────────────────────────────

async function fraudFlags(event) {
  const days = Math.min(31, Math.max(1, parseInt(event.queryStringParameters?.days || '7', 10) || 7));
  const since = istDate(Date.now() - (days - 1) * DAY_MS);
  const logs = (await scanTable(config.tables.attendance))
    .filter((l) => l.log_date >= since)
    .filter((l) => (l.fraud_flags || []).length > 0 || String(l.flagged_reason || '').includes('Nodus:'));
  logs.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const items = logs.map((l) => agentView(l, null));
  await audit('agent.fraud_flags.read', 'agent#fraud-flags', { days, count: items.length });
  return apiResponse(200, { since, items, count: items.length });
}

// ─────────────────────────────────────────────────────────
// GET /api/agent/daily-stats?date=YYYY-MM-DD
// ─────────────────────────────────────────────────────────

async function dailyStats(event) {
  const date = event.queryStringParameters?.date || istDate();
  if (!DATE_PATTERN.test(date)) throw new AgentError(400, 'date must be YYYY-MM-DD');

  const [logs, workers] = await Promise.all([
    scanTable(config.tables.attendance),
    scanTable(config.tables.workers),
  ]);
  const today = logs.filter((l) => l.log_date === date);
  const byStatus = {};
  const bySite = {};
  for (const l of today) {
    byStatus[l.verification_status] = (byStatus[l.verification_status] || 0) + 1;
    const site = bySite[l.site_id] ||= { site_id: l.site_id, site_name: l.site_name, checkins: 0, flagged: 0 };
    site.checkins++;
    if (l.flagged_reason || (l.fraud_flags || []).length) site.flagged++;
  }
  const threshold = config.certificateThreshold;
  const nearCertificate = workers.filter((w) => {
    const remaining = threshold - (w.total_days_logged || 0);
    return remaining > 0 && remaining <= NEAR_CERTIFICATE_DAYS;
  }).length;

  await audit('agent.daily_stats.read', 'agent#daily-stats', { date });
  return apiResponse(200, {
    date,
    checkins: today.length,
    by_status: byStatus,
    fraud_flagged: today.filter((l) => (l.fraud_flags || []).length || String(l.flagged_reason || '').includes('Nodus:')).length,
    awaiting_triage: today.filter((l) => l.verification_status === 'pending_review' && !l.ai_triage).length,
    workers_total: workers.length,
    workers_near_certificate: nearCertificate,
    certificate_threshold: threshold,
    sites: Object.values(bySite),
  });
}

// ─────────────────────────────────────────────────────────
// POST /api/agent/review/{logId}/note
//   body { recommendation: approve|reject|needs_human, note, confidence (0-100) }
// ─────────────────────────────────────────────────────────

async function addTriageNote(event, path) {
  const match = path.match(/\/api\/agent\/review\/([^/]+)\/note$/);
  const logId = match ? decodeURIComponent(match[1]) : '';
  const [workerId, logDate] = logId.split('#');
  if (!workerId || !DATE_PATTERN.test(logDate || '')) {
    throw new AgentError(400, 'logId must be <worker_id>#<YYYY-MM-DD>');
  }

  const body = parseJsonBody(event);
  const recommendation = String(body.recommendation || '');
  if (!RECOMMENDATIONS.has(recommendation)) {
    throw new AgentError(400, 'recommendation must be approve, reject or needs_human');
  }
  const note = plainText(body.note, MAX_NOTE_LENGTH);
  if (!note) throw new AgentError(400, 'note is required');
  const confidence = Math.min(100, Math.max(0, Number(body.confidence) || 0));

  const triage = { recommendation, note, confidence, agent: AGENT_ACTOR, at: new Date().toISOString() };
  try {
    await updateItem(
      config.tables.attendance,
      { worker_id: workerId, log_date: logDate },
      'SET ai_triage = :t',
      { ':t': triage, ':pending': 'pending_review' },
      undefined,
      'verification_status = :pending',
    );
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      throw new AgentError(409, 'Check-in is not pending review');
    }
    throw err;
  }

  await audit('review.triage_note', workerSubject(workerId), { log_date: logDate, recommendation, confidence });
  return apiResponse(200, { log_id: logId, ai_triage: triage });
}

/**
 * Handle an /api/agent/* request.
 * @returns {Promise<object>} API response
 */
export async function handleAgentRoute(event, path, method) {
  if (!verifyAgentKey(event)) {
    return apiResponse(401, { error: 'Unauthorized — valid X-Agent-Key required' });
  }
  try {
    if (path.endsWith('/api/agent/review-queue') && method === 'GET') return await reviewQueue(event);
    if (path.endsWith('/api/agent/fraud-flags') && method === 'GET') return await fraudFlags(event);
    if (path.endsWith('/api/agent/daily-stats') && method === 'GET') return await dailyStats(event);
    if (/\/api\/agent\/review\/[^/]+\/note$/.test(path) && method === 'POST') return await addTriageNote(event, path);
    return apiResponse(404, { error: 'Route not found' });
  } catch (err) {
    if (err instanceof AgentError) return apiResponse(err.statusCode, { error: err.message });
    throw err;
  }
}

export default { handleAgentRoute, verifyAgentKey };
