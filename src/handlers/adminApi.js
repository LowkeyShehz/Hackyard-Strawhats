/**
 * Nirman Mitra — Admin API Handler
 * Dashboard stats, review queue, worker search, certificate verification.
 * Admin dashboard API endpoints.
 */

import { randomUUID } from 'crypto';
import config, { apiResponse } from '../utils/config.js';
import { generatePresignedUrl, enrolledSelfieKey } from '../utils/s3.js';
import {
  getItem,
  putItem,
  queryItems,
  updateItem,
  deleteItem,
  scanTable,
  scanPage,
  getPendingReviews,
  getWorkerAttendanceLogs,
  incrementDaysLogged,
} from '../utils/dynamodb.js';
import {
  verifyAccessToken,
  requireRole,
  generateTokenPair,
  hashPassword,
  comparePassword,
  getRefreshToken,
  deleteRefreshToken,
  getAdminByEmail,
  normalizeEmail,
} from '../middleware/auth.js';
import { writeAudit, listAudit, credentialSubject, workerSubject } from '../services/audit.js';
import { sendTextMessage } from '../utils/whatsapp.js';
import { t, KN } from '../utils/i18n.js';
import {
  handleCompanyRoute,
  handleAdminCompanyRoute,
  parseSiteCompanyId,
  CompanyError,
} from './companyRoutes.js';

/** Client error with a safe, generic message */
class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const badRequest = (message = 'Invalid request') => new HttpError(400, message);

/** Admin-table item that marks the one-time bootstrap (seed) as used */
const SEED_LOCK_ID = '__seed_lock__';

/** Parse the JSON request body; malformed JSON or a non-object body is a 400 */
function parseBody(event) {
  let raw = event.body;
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw !== 'string') {
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
    throw badRequest('Invalid request body');
  }
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw badRequest('Invalid request body');
  }
  if (body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('Invalid request body');
  return body;
}

/** Throw a 400 unless value is undefined/null or a string */
function optionalString(value) {
  if (value !== undefined && value !== null && typeof value !== 'string') throw badRequest();
  return value ?? undefined;
}

/** Parse ?limit — an integer in 1..max, or the default when absent */
function parseLimit(params, defaultLimit, max = 100) {
  const raw = params?.limit;
  if (raw === undefined || raw === null || raw === '') return defaultLimit;
  if (!/^\d+$/.test(String(raw))) throw badRequest('Invalid limit');
  const n = parseInt(raw, 10);
  if (n < 1 || n > max) throw badRequest('Invalid limit');
  return n;
}

function encodeCursor(key) {
  return key ? Buffer.from(JSON.stringify(key), 'utf8').toString('base64url') : null;
}

function decodeCursor(cursor) {
  try {
    const key = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!key || typeof key !== 'object' || Array.isArray(key)) throw new Error('bad cursor');
    return key;
  } catch {
    throw badRequest('Invalid cursor');
  }
}

/** Mask a phone number for admin views: ****1234 */
function maskPhone(phone) {
  return phone ? `****${String(phone).slice(-4)}` : '';
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function jwtConfigured() {
  return !!(config.jwt.secret && config.jwt.refreshSecret);
}

export const handler = async (event) => {
  // REST API (v1) events carry `path`; HTTP API (v2) events carry `rawPath`. Trailing slashes are ignored.
  const path = (event.path || event.rawPath || '').replace(/\/+$/, '') || '/';
  const method = event.httpMethod || event.requestContext?.http?.method;

  console.log(`AdminAPI: ${method} ${path}`);

  try {
    // ── CORS preflight ─────────────────────────────────────
    if (method === 'OPTIONS') {
      return apiResponse(200, {});
    }

    // ── Auth routes (no token required) ────────────────────
    if (path.includes('/api/auth/login') && method === 'POST') {
      return await handleLogin(event);
    }

    if (path.includes('/api/auth/refresh') && method === 'POST') {
      return await handleRefresh(event);
    }

    if (path.includes('/api/auth/logout') && method === 'POST') {
      return await handleLogout(event);
    }

    if (path.includes('/api/auth/seed') && method === 'POST') {
      return await handleSeed(event);
    }

    // ── Public routes (no token required) ──────────────────
    if (path.includes('/api/certificate/') && path.endsWith('/verify')) {
      return await verifyCertificate(event, path);
    }

    // ── Protected routes — require valid JWT ───────────────
    const admin = verifyAccessToken(event);
    if (!admin) {
      return apiResponse(401, { error: 'Unauthorized — valid access token required' });
    }

    // Company accounts are visibility-only: they reach /api/company/* and nothing else
    if (admin.role === 'company') {
      const companyResponse = await handleCompanyRoute(admin, event, path, method);
      return companyResponse || apiResponse(403, { error: 'Forbidden — insufficient role' });
    }
    if (path.includes('/api/company/')) {
      return apiResponse(403, { error: 'Forbidden — company accounts only' });
    }

    // All /api/admin/* routes require admin or super_admin role
    if (path.includes('/api/admin/')) {
      if (!requireRole(admin, ['admin', 'super_admin'])) {
        return apiResponse(403, { error: 'Forbidden — insufficient role' });
      }
    }

    // Officer routes: welfare board officers (and admins) viewing and deciding on credentials
    if (path.includes('/api/officer/')) {
      if (!requireRole(admin, OFFICER_ROLES)) {
        return apiResponse(403, { error: 'Forbidden — insufficient role' });
      }
      if (path.endsWith('/api/officer/view') && method === 'POST') {
        return await recordOfficerView(event, admin);
      }
      if (path.endsWith('/api/officer/approve') && method === 'POST') {
        return await recordOfficerDecision(event, admin);
      }
      if (path.includes('/api/officer/credential/') && path.endsWith('/audit') && method === 'GET') {
        return await getCredentialAudit(path);
      }
      return apiResponse(404, { error: 'Route not found' });
    }

    // Route to appropriate handler
    if (path.includes('/api/admin/dashboard')) {
      return await getDashboardStats();
    }

    const companyAdminResponse = await handleAdminCompanyRoute(event, path, method);
    if (companyAdminResponse) return companyAdminResponse;

    if (path.endsWith('/api/admin/sites')) {
      if (method === 'GET') return await listSites();
      if (method === 'POST') return await upsertSite(event);
      return apiResponse(405, { error: 'Method not allowed' });
    }

    if (path.includes('/api/admin/workers') && !path.includes('/api/admin/worker/')) {
      return await listWorkers(event);
    }

    if (path.includes('/api/admin/review-queue')) {
      return await getReviewQueue(event);
    }

    if (path.includes('/api/admin/review/') && method === 'PUT') {
      return await handleReviewAction(event, path, admin);
    }

    if (path.includes('/api/admin/worker/')) {
      return await getWorkerProfile(event, path, admin);
    }

    if (path.includes('/api/worker/') && path.includes('/progress')) {
      if (!requireRole(admin, ['admin', 'super_admin'])) {
        return apiResponse(403, { error: 'Forbidden — insufficient role' });
      }
      return await getWorkerProgress(path);
    }

    if (path.includes('/api/admin/attendance-trends')) {
      return await getAttendanceTrends();
    }

    if (path.includes('/api/admin/confidence-stats')) {
      return await getConfidenceStats();
    }

    if (path.includes('/api/admin/site-breakdown')) {
      return await getSiteBreakdown();
    }

    return apiResponse(404, { error: 'Route not found' });
  } catch (err) {
    if (err instanceof HttpError || err instanceof CompanyError) {
      return apiResponse(err.statusCode, { error: err.message });
    }
    // Never echo internal error details to the client
    console.error('AdminAPI error:', err);
    return apiResponse(500, { error: 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────

async function handleLogin(event) {
  const body = parseBody(event);
  const email = optionalString(body.email);
  const password = optionalString(body.password);

  if (!email || !password) {
    return apiResponse(400, { error: 'Email and password are required' });
  }

  if (!jwtConfigured()) {
    console.error('AdminAPI: JWT_SECRET / JWT_REFRESH_SECRET not configured');
    return apiResponse(500, { error: 'Server misconfigured' });
  }

  const admin = await getAdminByEmail(email);
  // Always run a bcrypt compare (dummy hash when the email is unknown) so timing does not
  // reveal which emails have accounts
  const valid = await comparePassword(password, admin?.password_hash);
  if (!admin || !valid) {
    return apiResponse(401, { error: 'Invalid email or password' });
  }

  const { accessToken, refreshToken } = await generateTokenPair(admin);

  return apiResponse(200, {
    accessToken,
    refreshToken,
    admin: {
      admin_id: admin.admin_id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      ...(admin.company_id && { company_id: admin.company_id, company_name: admin.company_name || admin.name }),
    },
  });
}

// ─────────────────────────────────────────────────────────
// POST /api/auth/refresh
// ─────────────────────────────────────────────────────────

async function handleRefresh(event) {
  const body = parseBody(event);
  const refreshToken = optionalString(body.refreshToken);

  if (!refreshToken) {
    return apiResponse(400, { error: 'Refresh token is required' });
  }

  if (!jwtConfigured()) {
    console.error('AdminAPI: JWT_SECRET / JWT_REFRESH_SECRET not configured');
    return apiResponse(500, { error: 'Server misconfigured' });
  }

  const stored = await getRefreshToken(refreshToken);
  if (!stored) {
    return apiResponse(401, { error: 'Invalid or expired refresh token' });
  }

  // Check expiry
  if (new Date(stored.expires_at) < new Date()) {
    await deleteRefreshToken(refreshToken);
    return apiResponse(401, { error: 'Refresh token expired' });
  }

  // Look up admin
  const admin = await getItem(config.tables.adminUsers, { admin_id: stored.admin_id });
  if (!admin) {
    return apiResponse(401, { error: 'Admin not found' });
  }

  // Rotate: delete old, generate new
  await deleteRefreshToken(refreshToken);
  const tokens = await generateTokenPair(admin);

  return apiResponse(200, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });
}

// ─────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────

async function handleLogout(event) {
  const body = parseBody(event);
  const refreshToken = optionalString(body.refreshToken);

  if (refreshToken) {
    await deleteRefreshToken(refreshToken);
  }

  return apiResponse(200, { success: true });
}

// ─────────────────────────────────────────────────────────
// POST /api/auth/seed — One-time bootstrap of the first admin (requires ADMIN_SEED_SECRET)
// ─────────────────────────────────────────────────────────

async function handleSeed(event) {
  const seedSecret = process.env.ADMIN_SEED_SECRET || '';

  // Always require a configured, matching seed secret (every environment)
  const body = parseBody(event);
  const providedSecret = optionalString(body.seedSecret);
  if (!seedSecret || providedSecret !== seedSecret) {
    return apiResponse(403, { error: 'Seed endpoint is disabled' });
  }

  const email = normalizeEmail(optionalString(body.email));
  const password = optionalString(body.password);
  const name = optionalString(body.name)?.trim();
  if (!email || !password || !name) {
    return apiResponse(400, { error: 'Email, password, and name are required' });
  }

  // Bootstrap only: once any admin (or the seed lock) exists, the endpoint is closed for good
  const { items: existingAdmins } = await scanPage(config.tables.adminUsers, { Limit: 1 });
  if (existingAdmins.length > 0) {
    return apiResponse(403, { error: 'Seed endpoint is disabled' });
  }

  // Take the one-time seed lock; a concurrent seed loses the conditional write
  const now = new Date().toISOString();
  try {
    await putItem(
      config.tables.adminUsers,
      { admin_id: SEED_LOCK_ID, kind: 'seed_lock', created_at: now },
      'attribute_not_exists(admin_id)',
    );
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return apiResponse(403, { error: 'Seed endpoint is disabled' });
    }
    throw err;
  }

  const adminId = randomUUID();
  const adminItem = {
    admin_id: adminId,
    email,
    password_hash: await hashPassword(password),
    role: 'super_admin',
    name,
    permissions: {},
    created_at: now,
    updated_at: now,
  };

  try {
    await putItem(config.tables.adminUsers, adminItem, 'attribute_not_exists(admin_id)');
  } catch (err) {
    // Release the lock so the bootstrap can be retried
    await deleteItem(config.tables.adminUsers, { admin_id: SEED_LOCK_ID }).catch(() => {});
    throw err;
  }

  return apiResponse(201, {
    success: true,
    admin: { admin_id: adminId, email, name, role: 'super_admin' },
  });
}

// ─────────────────────────────────────────────────────────
// GET /api/admin/dashboard — Aggregate Stats
// ─────────────────────────────────────────────────────────

async function getDashboardStats() {
  // Full (paginated) scans of each table
  const [allWorkers, allLogs, allSites] = await Promise.all([
    scanTable(config.tables.workers),
    scanTable(config.tables.attendance),
    scanTable(config.tables.sites),
  ]);

  // Aggregate worker stats
  const activeWorkers = allWorkers.filter((w) => w.profile_status === 'active');
  const onboardingWorkers = allWorkers.filter((w) => w.profile_status === 'onboarding');
  const totalDaysLogged = activeWorkers.reduce((sum, w) => sum + (w.total_days_logged || 0), 0);

  // Attendance trends (last 7 days)
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const trends = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const count = allLogs.filter((l) => l.log_date === dateStr).length;
    trends.push({ day: dayNames[d.getDay()], date: dateStr, logs: count });
  }

  // Confidence distribution
  let autoApproved = 0;
  let pendingCount = 0;
  let rejectedCount = 0;
  for (const log of allLogs) {
    const status = log.verification_status;
    if (status === 'auto_approved' || status === 'approved') autoApproved++;
    else if (status === 'pending_review') pendingCount++;
    else if (status === 'rejected') rejectedCount++;
  }
  const total = autoApproved + pendingCount + rejectedCount || 1;
  const distribution = [
    { name: 'Auto-Approved (>=80%)', value: Math.round((autoApproved / total) * 100), color: '#22c55e' },
    { name: 'Pending Review (60-80%)', value: Math.round((pendingCount / total) * 100), color: '#f59e0b' },
    { name: 'Rejected (<60%)', value: Math.round((rejectedCount / total) * 100), color: '#ef4444' },
  ];

  // Site breakdown
  const siteNames = {};
  for (const site of allSites) {
    siteNames[site.site_id] = site.site_name || site.name || site.site_id;
  }
  const siteCounts = {};
  for (const log of allLogs) {
    const sid = log.site_id || 'unknown';
    const name = siteNames[sid] || sid;
    siteCounts[name] = (siteCounts[name] || 0) + 1;
  }
  const sites = Object.entries(siteCounts)
    .map(([name, count]) => ({ site: name, logs: count }))
    .sort((a, b) => b.logs - a.logs);

  return apiResponse(200, {
    totalWorkers: allWorkers.length,
    activeWorkers: activeWorkers.length,
    onboardingWorkers: onboardingWorkers.length,
    pendingReviews: pendingCount,
    totalDaysLogged,
    averageDaysPerWorker: activeWorkers.length > 0
      ? Math.round(totalDaysLogged / activeWorkers.length)
      : 0,
    certificateThreshold: config.certificateThreshold,
    trends,
    distribution,
    sites,
  });
}

// ─────────────────────────────────────────────────────────
// GET /api/admin/workers — List Workers
//   no ?limit/?cursor: every worker; with them: one page plus nextCursor
// ─────────────────────────────────────────────────────────

function workerSummary(w) {
  return {
    worker_id: w.worker_id,
    name: w.name,
    phone_number: maskPhone(w.phone_number),
    preferred_language: w.preferred_language,
    profile_status: w.profile_status,
    total_days_logged: w.total_days_logged || 0,
    aadhaar_verified: !!w.aadhaar_last4,
    selfie_verified: !!w.face_vector,
    bank_verified: !!w.bank_account_hash || !!w.registration_completed,
  };
}

async function listWorkers(event) {
  const params = event.queryStringParameters || {};
  const paged = (params.limit !== undefined && params.limit !== '') || !!params.cursor;

  if (!paged) {
    const allWorkers = await scanTable(config.tables.workers);
    return apiResponse(200, { workers: allWorkers.map(workerSummary), nextCursor: null });
  }

  const limit = parseLimit(params, 50);
  const { items, lastEvaluatedKey } = await scanPage(config.tables.workers, {
    Limit: limit,
    ...(params.cursor && { ExclusiveStartKey: decodeCursor(params.cursor) }),
  });
  return apiResponse(200, { workers: items.map(workerSummary), nextCursor: encodeCursor(lastEvaluatedKey) });
}

// ─────────────────────────────────────────────────────────
// GET /api/admin/review-queue — Pending Reviews
// ─────────────────────────────────────────────────────────

async function getReviewQueue(event) {
  const params = event.queryStringParameters || {};
  const limit = parseLimit(params, 20);

  const items = await getPendingReviews(limit);

  // Enrich with worker info
  const enriched = await Promise.all(
    items.map(async (item) => {
      const worker = await getItem(config.tables.workers, { worker_id: item.worker_id });
      
      let enrolled_image_url = null;
      let checkin_image_url = null;
      try {
        enrolled_image_url = await generatePresignedUrl(config.buckets.mediaRaw, enrolledSelfieKey(item.worker_id), 900);
        if (item.s3_media_keys && item.s3_media_keys.selfie) {
          checkin_image_url = await generatePresignedUrl(config.buckets.mediaRaw, item.s3_media_keys.selfie, 900);
        }
      } catch (err) {
        console.error('Failed to generate presigned URLs:', err);
      }

      return {
        ...item,
        log_id: `${item.worker_id}#${item.log_date}`,
        worker_name: worker?.name || 'Unknown',
        worker_phone: maskPhone(worker?.phone_number),
        enrolled_image_url,
        checkin_image_url
      };
    }),
  );

  return apiResponse(200, { items: enriched, count: enriched.length });
}

// ─────────────────────────────────────────────────────────
// PUT /api/admin/review/{logId} — Approve/Reject
//   logId = `${worker_id}#${log_date}` (URL-encoded: %23). For backward compatibility the
//   path may carry just the worker id, with body workerId (must equal it) and logDate.
// ─────────────────────────────────────────────────────────

const MAX_JUSTIFICATION_LENGTH = 1000;

/**
 * Strip HTML and script tags (including an unterminated trailing tag) from a string.
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/<[a-zA-Z!/?][\s\S]*$/, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, MAX_JUSTIFICATION_LENGTH);
}

/** Resolve { workerId, logDate } from the path id (authoritative) and the body */
function resolveLogKey(event, path, body) {
  const rawId = event.pathParameters?.logId ?? path.split('/').pop();
  const logId = safeDecode(rawId || '');
  const bodyWorkerId = optionalString(body.workerId);
  const bodyLogDate = optionalString(body.logDate);

  const sep = logId.lastIndexOf('#');
  if (sep > 0 && sep < logId.length - 1) {
    const workerId = logId.slice(0, sep);
    const logDate = logId.slice(sep + 1);
    if ((bodyWorkerId !== undefined && bodyWorkerId !== workerId)
      || (bodyLogDate !== undefined && bodyLogDate !== logDate)) {
      throw badRequest('workerId/logDate do not match the log id in the path');
    }
    return { workerId, logDate };
  }

  // Legacy form: /api/admin/review/{workerId} with the date in the body
  if (!logId || !bodyLogDate || bodyWorkerId !== logId) {
    throw badRequest('Missing or mismatched workerId/logDate');
  }
  return { workerId: logId, logDate: bodyLogDate };
}

/**
 * Tell the worker on WhatsApp how their flagged day was decided. Best effort: the decision is
 * already saved, so a send failure is logged and never fails the review.
 */
async function notifyReviewOutcome(workerId, logDate, action, reason, daysLogged) {
  try {
    const worker = await getItem(config.tables.workers, { worker_id: workerId });
    if (!worker?.phone_number) return;
    const language = worker.preferred_language || 'hi';
    const [, mm, dd] = String(logDate).split('-');
    const day = `${dd}/${mm}`;
    let text;
    if (action === 'approve') {
      const logged = daysLogged ?? worker.total_days_logged ?? 0;
      const remaining = Math.max(0, config.certificateThreshold - logged);
      text = t(language, {
        en: `Your attendance for ${day} was approved by the welfare officer. ${logged} days logged, ${remaining} remaining.`,
        hi: `${day} ki aapki attendance welfare officer ne approve kar di. ${logged} din log hue, ${remaining} din baaki.`,
        kn: KN.reviewApproved(day, logged, remaining),
      });
      if (remaining === 0) {
        text += t(language, {
          en: '\nYou are eligible for your certificate. Send "certificate" to get it.',
          hi: '\nAap certificate ke liye eligible hain. Paane ke liye "certificate" bhejiye.',
          kn: `\n${KN.reviewCertificateHint}`,
        });
      }
    } else {
      text = t(language, {
        en: `Your attendance for ${day} could not be approved.${reason ? ` Reason: ${reason}.` : ''} Please check in again with a selfie, location and voice note.`,
        hi: `${day} ki aapki attendance approve nahi ho saki.${reason ? ` Kaaran: ${reason}.` : ''} Kripya selfie, location aur voice note ke saath dobara check-in karein.`,
        kn: KN.reviewRejected(day, reason),
      });
    }
    await sendTextMessage(worker.phone_number, text);
  } catch (err) {
    console.warn('[AdminApi] Review outcome message not sent:', err.response?.status || err.message);
  }
}

async function handleReviewAction(event, path, admin) {
  const body = parseBody(event);
  const action = optionalString(body.action);
  const justification = optionalString(body.justification);

  if (!action || !['approve', 'reject'].includes(action)) {
    return apiResponse(400, { error: 'Invalid action. Must be "approve" or "reject".' });
  }

  const { workerId, logDate } = resolveLogKey(event, path, body);
  const logId = `${workerId}#${logDate}`;

  // Sanitize justification to strip HTML/script tags
  const sanitizedJustification = sanitizeString(justification || '');

  // Justification is required (after sanitising) for rejections
  if (action === 'reject' && sanitizedJustification.length === 0) {
    return apiResponse(400, { error: 'Justification is required when rejecting a review.' });
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  // Only logs still waiting in the review queue can be decided, so a day is never counted twice
  const log = await getItem(config.tables.attendance, { worker_id: workerId, log_date: logDate });
  if (!log) {
    return apiResponse(404, { error: 'Attendance log not found' });
  }
  if (log.verification_status !== 'pending_review') {
    return apiResponse(409, { error: `Attendance log already ${log.verification_status}` });
  }

  try {
    await updateItem(
      config.tables.attendance,
      { worker_id: workerId, log_date: logDate },
      'SET verification_status = :status, admin_action = :action, admin_justification = :just, reviewed_at = :ts, reviewed_by = :by',
      {
        ':status': newStatus,
        ':action': action,
        ':just': sanitizedJustification,
        ':ts': new Date().toISOString(),
        ':by': admin.admin_id,
        ':pending': 'pending_review',
      },
      undefined,
      'verification_status = :pending',
    );
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return apiResponse(409, { error: 'Attendance log was already reviewed' });
    }
    throw err;
  }

  // Increment days logged when admin approves (matches auto_approved behavior)
  let daysLogged = null;
  if (action === 'approve') {
    try {
      const updated = await incrementDaysLogged(workerId);
      daysLogged = updated?.total_days_logged ?? null;
    } catch (err) {
      console.error('[AdminApi] Failed to increment days logged:', err.message);
    }
  }

  await notifyReviewOutcome(workerId, logDate, action, sanitizedJustification, daysLogged);

  await writeAudit({
    actor: `admin:${admin.admin_id}`,
    action: 'attendance.decision',
    subject: workerSubject(workerId),
    outcome: action,
    details: { log_date: logDate, justification: sanitizedJustification || null },
  });

  return apiResponse(200, {
    success: true,
    logId,
    log_id: logId,
    action,
    newStatus,
  });
}

// ─────────────────────────────────────────────────────────
// GET /api/admin/worker/{id} — Worker Profile
// ─────────────────────────────────────────────────────────

async function getWorkerProfile(event, path, admin) {
  const workerId = safeDecode(event.pathParameters?.id ?? path.split('/').pop());

  const worker = await getItem(config.tables.workers, { worker_id: workerId });
  await writeAudit({
    actor: `admin:${admin.admin_id}`,
    action: 'worker.view',
    subject: workerSubject(workerId),
    outcome: worker ? 'ok' : 'not_found',
  });
  if (!worker) {
    return apiResponse(404, { error: 'Worker not found' });
  }

  // Get attendance history and documents
  const [logs, documents] = await Promise.all([
    getWorkerAttendanceLogs(workerId),
    queryItems(config.tables.documents, 'worker_id = :wid', { ':wid': workerId }),
  ]);

  // Explicit allow-list: no face vector / FaceId, no Aadhaar name or number, phone masked
  const safeWorker = {
    ...workerSummary(worker),
    aadhaar_last4: worker.aadhaar_last4 || null,
    registration_started: worker.registration_started || null,
    registration_completed: worker.registration_completed || null,
    admin_flag: worker.admin_flag || null,
    admin_flag_reason: worker.admin_flag_reason || null,
    consent_version: worker.consent_version || null,
    consent_at: worker.consent_at || null,
    created_at: worker.created_at || null,
    updated_at: worker.updated_at || null,
  };

  return apiResponse(200, {
    worker: safeWorker,
    attendanceLogs: logs,
    documents: documents.map((d) => ({
      document_id: d.document_id,
      document_type: d.document_type,
      ocr_confidence: d.ocr_confidence,
      created_at: d.created_at,
    })),
  });
}

// ─────────────────────────────────────────────────────────
// Officer: credential views and decisions (PRD FR-5, FR-7)
// The signature is verified in the officer's browser; these routes only record who looked
// at a credential and what they decided.
// ─────────────────────────────────────────────────────────

const OFFICER_ROLES = ['officer', 'admin', 'super_admin'];
const DECISIONS = ['approve', 'reject'];
const MAX_NOTE_LENGTH = 500;

/** A credential id (jti) is the certificate id: a UUID */
function parseJti(value) {
  const jti = optionalString(value);
  if (!jti || !/^[A-Za-z0-9-]{8,64}$/.test(jti)) {
    throw new HttpError(400, 'Invalid or missing jti');
  }
  return jti;
}

async function findCertificate(jti) {
  const items = await queryItems(
    config.tables.certificates,
    'certificate_id = :c',
    { ':c': jti },
    'CertificateIdIndex',
    { Limit: 1 },
  );
  return items[0] || null;
}

/** The recorded decision for a credential, if any (one per credential) */
async function getDecision(jti) {
  return getItem(config.tables.audit, { subject: credentialSubject(jti), entry_id: 'decision' });
}

// POST /api/officer/view { jti }
async function recordOfficerView(event, officer) {
  const body = parseBody(event);
  const jti = parseJti(body.jti);
  const certificate = await findCertificate(jti);

  await writeAudit({
    actor: `admin:${officer.admin_id}`,
    action: 'credential.view',
    subject: credentialSubject(jti),
    outcome: certificate ? 'ok' : 'not_found',
  });
  if (!certificate) {
    return apiResponse(404, { error: 'Credential not found' });
  }

  const decision = await getDecision(jti);
  return apiResponse(200, {
    recorded: true,
    decision: decision ? { decision: decision.decision, at: decision.at } : null,
  });
}

// POST /api/officer/approve { jti, decision: 'approve' | 'reject', note }
async function recordOfficerDecision(event, officer) {
  const body = parseBody(event);
  const jti = parseJti(body.jti);
  const decision = optionalString(body.decision);
  if (!DECISIONS.includes(decision)) {
    return apiResponse(400, { error: 'Invalid decision. Must be "approve" or "reject".' });
  }
  const note = sanitizeString(optionalString(body.note) || '').slice(0, MAX_NOTE_LENGTH);

  const certificate = await findCertificate(jti);
  if (!certificate) {
    return apiResponse(404, { error: 'Credential not found' });
  }

  // One decision per credential: an insert-only record, so a second decision fails
  const at = new Date().toISOString();
  try {
    await putItem(config.tables.audit, {
      subject: credentialSubject(jti),
      entry_id: 'decision',
      actor: `admin:${officer.admin_id}`,
      action: 'credential.decision',
      decision,
      note: note || null,
      worker_id: certificate.worker_id,
      at,
    }, 'attribute_not_exists(entry_id)');
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      const existing = await getDecision(jti);
      return apiResponse(409, {
        error: `This claim was already ${existing?.decision === 'approve' ? 'approved' : 'rejected'}.`,
        decision: existing ? { decision: existing.decision, at: existing.at } : null,
      });
    }
    throw err;
  }

  await writeAudit({
    actor: `admin:${officer.admin_id}`,
    action: 'credential.decision',
    subject: credentialSubject(jti),
    outcome: decision,
    details: { note: note || null },
  });

  return apiResponse(200, { success: true, jti, decision, at });
}

// GET /api/officer/credential/{jti}/audit — the credential's audit trail for the portal
async function getCredentialAudit(path) {
  const parts = path.split('/');
  const jti = parseJti(safeDecode(parts[parts.length - 2]));
  const entries = await listAudit(credentialSubject(jti));
  return apiResponse(200, {
    jti,
    entries: entries
      .filter((e) => e.entry_id !== 'decision')
      .map((e) => ({ at: e.at, actor: e.actor, action: e.action, outcome: e.outcome })),
  });
}

// ─────────────────────────────────────────────────────────
// GET /api/worker/{id}/progress — Worker Progress
// ─────────────────────────────────────────────────────────

async function getWorkerProgress(path) {
  const pathParts = path.split('/');
  // Path: /api/worker/{id}/progress — id is at index -2
  const workerId = safeDecode(pathParts[pathParts.length - 2]);

  const worker = await getItem(config.tables.workers, { worker_id: workerId });
  if (!worker) {
    return apiResponse(404, { error: 'Worker not found' });
  }

  const daysLogged = worker.total_days_logged || 0;
  const threshold = config.certificateThreshold;
  const daysRemaining = Math.max(0, threshold - daysLogged);

  return apiResponse(200, {
    workerId,
    name: worker.name,
    daysLogged,
    daysRemaining,
    threshold,
    progress: Math.round((daysLogged / threshold) * 100),
    profileStatus: worker.profile_status,
  });
}

// ─────────────────────────────────────────────────────────
// GET /api/certificate/{hash}/verify — Public QR Verification
// ─────────────────────────────────────────────────────────

async function verifyCertificate(event, path) {
  const match = path.match(/\/api\/certificate\/([^/]+)\/verify$/);
  const certId = safeDecode(event.pathParameters?.id ?? match?.[1] ?? '');
  if (!certId) {
    return apiResponse(404, { verified: false, message: 'Certificate not found or invalid hash' });
  }

  // Search by verification hash via GSI
  const certs = await queryItems(
    config.tables.certificates,
    'verification_hash = :hash',
    { ':hash': certId },
    'VerificationHashIndex',
    { Limit: 1 },
  );

  if (certs.length === 0) {
    return apiResponse(404, {
      verified: false,
      message: 'Certificate not found or invalid hash',
    });
  }

  const cert = certs[0];
  // Name as printed on the certificate; older certificates fall back to the live worker record
  let workerName = cert.worker_name;
  if (!workerName) {
    const worker = await getItem(config.tables.workers, { worker_id: cert.worker_id });
    workerName = worker?.name || 'Unknown';
  }

  // Return verification info WITHOUT PII beyond name and Aadhaar last 4
  return apiResponse(200, {
    verified: true,
    certificate: {
      worker_name: workerName,
      aadhaar_last4: cert.aadhaar_last4 || null,
      total_verified_days: cert.total_days,
      date_range: { from: cert.date_from, to: cert.date_to },
      sites_worked: cert.sites || [],
      issued_at: cert.created_at,
      bocw_reference: cert.bocw_reference,
    },
    // Never expose: full Aadhaar, bank account, phone number
  });
}

// ─────────────────────────────────────────────────────────
// /api/admin/sites — Geo-fenced work sites
//   Stored in the shape attendanceProcessor's geo check reads:
//   { site_id, site_name, geo_location: { latitude, longitude }, radius_meters,
//     is_active: 'true' | 'false' (string — ActiveSitesIndex hash key) }
// ─────────────────────────────────────────────────────────

const SITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function siteView(site) {
  return {
    site_id: site.site_id,
    name: site.site_name || site.name || site.site_id,
    latitude: site.geo_location?.latitude ?? null,
    longitude: site.geo_location?.longitude ?? null,
    radius_meters: site.radius_meters ?? null,
    is_active: site.is_active === 'true' || site.is_active === true,
    ...(site.company_id && { company_id: site.company_id }),
    created_at: site.created_at || null,
    updated_at: site.updated_at || null,
  };
}

function numberInRange(value, min, max, field) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw badRequest(`${field} must be a number between ${min} and ${max}`);
  }
  return n;
}

async function listSites() {
  const sites = await scanTable(config.tables.sites);
  return apiResponse(200, {
    sites: sites.map(siteView).sort((a, b) => String(a.name).localeCompare(String(b.name))),
  });
}

async function upsertSite(event) {
  const body = parseBody(event);

  const siteIdInput = optionalString(body.site_id);
  if (siteIdInput !== undefined && !SITE_ID_PATTERN.test(siteIdInput)) {
    throw badRequest('site_id may contain only letters, digits, "-" and "_" (max 64)');
  }
  const name = sanitizeString(optionalString(body.name) || '').slice(0, 120);
  if (!name) throw badRequest('name is required');
  const latitude = numberInRange(body.latitude, -90, 90, 'latitude');
  const longitude = numberInRange(body.longitude, -180, 180, 'longitude');
  const radius = numberInRange(body.radius_meters, 50, 5000, 'radius_meters');

  let isActive = true;
  if (body.is_active !== undefined && body.is_active !== null) {
    if (body.is_active === true || body.is_active === 'true') isActive = true;
    else if (body.is_active === false || body.is_active === 'false') isActive = false;
    else throw badRequest('is_active must be a boolean');
  }

  // Optional owning company (visibility only); '' or null removes it
  const companyId = parseSiteCompanyId(body.company_id);

  const siteId = siteIdInput || `SITE-${randomUUID()}`;
  const existing = siteIdInput ? await getItem(config.tables.sites, { site_id: siteId }) : null;
  const now = new Date().toISOString();

  const site = {
    ...(existing || {}),
    site_id: siteId,
    site_name: name,
    geo_location: { latitude, longitude },
    radius_meters: Math.round(radius),
    is_active: isActive ? 'true' : 'false',
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  delete site.name;
  if (companyId === null) delete site.company_id;
  else if (companyId !== undefined) site.company_id = companyId;

  await putItem(config.tables.sites, site);
  return apiResponse(existing ? 200 : 201, { site: siteView(site), created: !existing });
}

// ─────────────────────────────────────────────────────────
// GET /api/admin/attendance-trends — Last 7 Days
// ─────────────────────────────────────────────────────────

async function getAttendanceTrends() {
  const allLogs = await scanTable(config.tables.attendance);

  // Build last 7 days
  const days = [];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const count = allLogs.filter((l) => l.log_date === dateStr).length;
    days.push({ day: dayNames[d.getDay()], date: dateStr, logs: count });
  }

  return apiResponse(200, { trends: days });
}

// ─────────────────────────────────────────────────────────
// GET /api/admin/confidence-stats — Verification Distribution
// ─────────────────────────────────────────────────────────

async function getConfidenceStats() {
  const allLogs = await scanTable(config.tables.attendance);

  let autoApproved = 0;
  let pendingReview = 0;
  let rejected = 0;

  for (const log of allLogs) {
    const status = log.verification_status;
    if (status === 'auto_approved' || status === 'approved') {
      autoApproved++;
    } else if (status === 'pending_review') {
      pendingReview++;
    } else if (status === 'rejected') {
      rejected++;
    }
  }

  const total = autoApproved + pendingReview + rejected || 1;

  return apiResponse(200, {
    distribution: [
      { name: 'Auto-Approved (>=80%)', value: Math.round((autoApproved / total) * 100), color: '#22c55e' },
      { name: 'Pending Review (60-80%)', value: Math.round((pendingReview / total) * 100), color: '#f59e0b' },
      { name: 'Rejected (<60%)', value: Math.round((rejected / total) * 100), color: '#ef4444' },
    ],
  });
}

// ─────────────────────────────────────────────────────────
// GET /api/admin/site-breakdown — Attendance by Site
// ─────────────────────────────────────────────────────────

async function getSiteBreakdown() {
  const [allLogs, allSites] = await Promise.all([
    scanTable(config.tables.attendance),
    scanTable(config.tables.sites),
  ]);

  // Build site name lookup
  const siteNames = {};
  for (const site of allSites) {
    siteNames[site.site_id] = site.site_name || site.name || site.site_id;
  }

  // Count logs per site
  const siteCounts = {};
  for (const log of allLogs) {
    const sid = log.site_id || 'unknown';
    const name = siteNames[sid] || sid;
    siteCounts[name] = (siteCounts[name] || 0) + 1;
  }

  const breakdown = Object.entries(siteCounts).map(([name, count]) => ({ site: name, logs: count }));
  breakdown.sort((a, b) => b.logs - a.logs);

  return apiResponse(200, { sites: breakdown });
}
